import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseServerEnv } from "@/lib/config/env";
import { AppError, publicErrorBody } from "@/lib/domain/errors";
import { readStrictJson } from "@/lib/http/requests";
import { requireWorkerSession } from "@/lib/http/worker-auth";
import { createConfiguredDrive } from "@/lib/application/configured-drive";
import { createNeonDriveControlPlaneRepository } from "@/lib/repositories/neon-drive-control-plane";
import { createNeonWorkerControlPlaneRepository } from "@/lib/repositories/neon-worker-control-plane";

export const runtime = "nodejs";
const HEADERS = { "cache-control": "no-store" } as const;
const schema = z.object({
  artifactId: z.string().uuid(),
  driveFileId: z.string().min(10).max(256).regex(/^\S+$/),
  fencingToken: z.number().int().positive(),
  sizeBytes: z.number().int().safe().min(1).max(1_099_511_627_776),
}).strict();
type Context = Readonly<{ params: Promise<Readonly<{ id: string }>> }>;

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
    const file = await drive.files.inspectFile(accessToken, body.driveFileId);
    const expectedProperties = {
      ytbVpsProjectId: execution.projectId,
      ytbVpsArtifactId: body.artifactId,
      ytbVpsJobId: jobId,
      ytbVpsRole: "output",
      schema: "1",
    };
    const propertiesMatch = Object.entries(expectedProperties).every(([key, value]) => file.appProperties[key] === value);
    if (
      file.id !== body.driveFileId || file.name !== "Part_01_of_01.mp4" || file.mimeType !== "video/mp4" ||
      file.sizeBytes !== body.sizeBytes || file.trashed || !file.parentIds.includes(execution.outputParentId) || !propertiesMatch
    ) throw new AppError("DRIVE_REMOTE_MISMATCH", 502);
    const outcome = await repository.completeOutput({
      artifactId: body.artifactId,
      jobId,
      workerId: worker.id,
      fencingToken: body.fencingToken,
      driveFileId: body.driveFileId,
      sizeBytes: body.sizeBytes,
      now: new Date(),
    });
    if (outcome === "LEASE_LOST") throw new AppError("LEASE_LOST", 409);
    return NextResponse.json({ status: outcome }, { headers: HEADERS });
  } catch (error) {
    if (error instanceof AppError) return NextResponse.json(publicErrorBody(error), { status: error.status, headers: HEADERS });
    return NextResponse.json({ code: "INTERNAL_ERROR" }, { status: 500, headers: HEADERS });
  }
}
