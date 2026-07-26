import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseServerEnv } from "@/lib/config/env";
import { AppError, publicErrorBody } from "@/lib/domain/errors";
import { readStrictJson } from "@/lib/http/requests";
import { requireWorkerSession } from "@/lib/http/worker-auth";
import { createConfiguredDrive } from "@/lib/application/configured-drive";
import { createNeonDriveControlPlaneRepository } from "@/lib/repositories/neon-drive-control-plane";
import { createNeonWorkerControlPlaneRepository } from "@/lib/repositories/neon-worker-control-plane";
import { redactSecrets } from "@/lib/security/redact";

export const runtime = "nodejs";
const HEADERS = { "cache-control": "no-store" } as const;
const UUID_V5_DNS_NAMESPACE = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");
const OUTPUT_ARTIFACT_ID_DOMAIN = "ytb-vps/output-artifact/v1";
const schema = z.object({
  fencingToken: z.number().int().positive(),
  sizeBytes: z.number().int().safe().min(1).max(1_099_511_627_776),
  checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
type Context = Readonly<{ params: Promise<Readonly<{ id: string }>> }>;

function deriveOutputArtifactId(jobId: string, sizeBytes: number, checksumSha256: string): string {
  const bytes = createHash("sha1")
    .update(UUID_V5_DNS_NAMESPACE)
    .update(OUTPUT_ARTIFACT_ID_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(JSON.stringify([jobId, sizeBytes, checksumSha256]), "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function POST(request: NextRequest, context: Context) {
  try {
    const env = parseServerEnv(process.env);
    const repository = createNeonWorkerControlPlaneRepository(env.databaseUrl);
    const worker = await requireWorkerSession(request, repository, env.workerAuthKeyV1, new Date());
    const body = await readStrictJson(request, schema, 2_048);
    const { id: jobId } = await context.params;
    const execution = await repository.getFencedExecution(worker.id, jobId, body.fencingToken, new Date());
    if (execution === null) throw new AppError("LEASE_LOST", 409);
    const driveRepository = createNeonDriveControlPlaneRepository(env.databaseUrl);
    const drive = createConfiguredDrive(env, driveRepository);
    const accessToken = await drive.access.getAccessToken();
    const artifactId = deriveOutputArtifactId(jobId, body.sizeBytes, body.checksumSha256);
    const driveFileId = await drive.files.ensureOutputFile(accessToken, {
      projectId: execution.projectId,
      jobId,
      artifactId,
      parentId: execution.outputParentId,
    });
    const session = await drive.files.createResumableUpdateSession(accessToken, {
      fileId: driveFileId,
      mimeType: "video/mp4",
      sizeBytes: body.sizeBytes,
    });
    const outcome = await repository.reserveOutput({
      artifactId,
      jobId,
      workerId: worker.id,
      fencingToken: body.fencingToken,
      driveFileId,
      driveParentId: execution.outputParentId,
      sizeBytes: body.sizeBytes,
      checksumSha256: body.checksumSha256,
      now: new Date(),
    });
    if (outcome === "LEASE_LOST") {
      // Never delete the Drive file here: artifactId derives only from
      // (jobId, sizeBytes, checksum), so the CURRENT lease holder resolves to the
      // same file via ensureOutputFile and may be uploading to it right now. An
      // unfenced delete by a stale worker would destroy the active attempt's output;
      // the file is reused (find-or-create) by any future attempt with this identity.
      throw new AppError("LEASE_LOST", 409);
    }
    return NextResponse.json({ artifactId, driveFileId, ...session }, { headers: HEADERS });
  } catch (error) {
    if (error instanceof AppError) return NextResponse.json(publicErrorBody(error), { status: error.status, headers: HEADERS });
    console.error("[api] unhandled error", redactSecrets(error));
    return NextResponse.json({ code: "INTERNAL_ERROR" }, { status: 500, headers: HEADERS });
  }
}
