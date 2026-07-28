import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseServerEnv } from "@/lib/config/env";
import { AppError, publicErrorBody } from "@/lib/domain/errors";
import { readStrictJson } from "@/lib/http/requests";
import { requireWorkerSession } from "@/lib/http/worker-auth";
import { createConfiguredDrive } from "@/lib/application/configured-drive";
import { createNeonDriveControlPlaneRepository } from "@/lib/repositories/neon-drive-control-plane";
import { createNeonWorkerControlPlaneRepository } from "@/lib/repositories/neon-worker-control-plane";
import { outputPartFileName } from "@/lib/domain/output-part";
import { redactSecrets } from "@/lib/security/redact";

export const runtime = "nodejs";
const HEADERS = { "cache-control": "no-store" } as const;
const schema = z.object({
  artifactId: z.string().uuid(),
  driveFileId: z.string().min(10).max(256).regex(/^\S+$/),
  fencingToken: z.number().int().positive(),
  partIndex: z.number().int().min(1).max(999),
  partCount: z.number().int().min(1).max(999),
  sizeBytes: z.number().int().safe().min(1).max(1_099_511_627_776),
}).strict().refine(
  (value) => value.partIndex <= value.partCount,
  { path: ["partIndex"], message: "partIndex must not exceed partCount" },
);
type Context = Readonly<{ params: Promise<Readonly<{ id: string }>> }>;

export async function POST(request: NextRequest, context: Context) {
  try {
    const env = parseServerEnv(process.env);
    const repository = createNeonWorkerControlPlaneRepository(env.databaseUrl);
    const worker = await requireWorkerSession(request, repository, env.workerAuthKeyV1, new Date());
    const body = await readStrictJson(request, schema, 2_048);
    const { id: jobId } = await context.params;
    const execution = await repository.getFencedExecution(worker.id, jobId, body.fencingToken, new Date());
    if (execution === null) {
      // A successful complete deletes the lease, so a worker retrying after a lost
      // HTTP response finds no lease here. completeOutput's lease-free first query
      // detects that exact case (artifact already READY with identical identity)
      // and returns REPLAY without further side effects.
      const replay = await repository.completeOutput({
        artifactId: body.artifactId,
        jobId,
        workerId: worker.id,
        fencingToken: body.fencingToken,
        driveFileId: body.driveFileId,
        partIndex: body.partIndex,
        partCount: body.partCount,
        sizeBytes: body.sizeBytes,
        now: new Date(),
      });
      if (replay === "REPLAY") return NextResponse.json({ status: "REPLAY" }, { headers: HEADERS });
      throw new AppError("LEASE_LOST", 409);
    }
    const driveRepository = createNeonDriveControlPlaneRepository(env.databaseUrl);
    const drive = createConfiguredDrive(env, driveRepository);
    const accessToken = await drive.access.getAccessToken();
    const file = await drive.files.inspectFile(accessToken, body.driveFileId);
    const expectedProperties = {
      ytbVpsProjectId: execution.projectId,
      ytbVpsArtifactId: body.artifactId,
      ytbVpsJobId: jobId,
      ytbVpsRole: "output",
      ytbVpsPartIndex: String(body.partIndex),
      ytbVpsPartCount: String(body.partCount),
      schema: "1",
    };
    const propertiesMatch = Object.keys(file.appProperties).sort().join("\u0000") === Object.keys(expectedProperties).sort().join("\u0000") &&
      Object.entries(expectedProperties).every(([key, value]) => file.appProperties[key] === value);
    if (
      file.id !== body.driveFileId ||
      file.name !== outputPartFileName(body.partIndex, body.partCount) ||
      file.mimeType !== "video/mp4" ||
      file.sizeBytes !== body.sizeBytes || file.trashed || file.parentIds.length !== 1 || file.parentIds[0] !== execution.outputParentId || !propertiesMatch
    ) throw new AppError("DRIVE_REMOTE_MISMATCH", 502);
    const outcome = await repository.completeOutput({
      artifactId: body.artifactId,
      jobId,
      workerId: worker.id,
      fencingToken: body.fencingToken,
      driveFileId: body.driveFileId,
      partIndex: body.partIndex,
      partCount: body.partCount,
      sizeBytes: body.sizeBytes,
      now: new Date(),
    });
    if (outcome === "LEASE_LOST") throw new AppError("LEASE_LOST", 409);
    return NextResponse.json({ status: outcome }, { headers: HEADERS });
  } catch (error) {
    if (error instanceof AppError) return NextResponse.json(publicErrorBody(error), { status: error.status, headers: HEADERS });
    console.error("[api] unhandled error", redactSecrets(error));
    return NextResponse.json({ code: "INTERNAL_ERROR" }, { status: 500, headers: HEADERS });
  }
}
