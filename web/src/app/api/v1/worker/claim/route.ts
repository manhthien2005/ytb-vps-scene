import { NextResponse, type NextRequest } from "next/server";
import { parseServerEnv } from "@/lib/config/env";
import { AppError, publicErrorBody } from "@/lib/domain/errors";
import { requireWorkerSession } from "@/lib/http/worker-auth";
import { createNeonWorkerControlPlaneRepository } from "@/lib/repositories/neon-worker-control-plane";
import { createJobQueueService } from "@/lib/application/job-queue";
import { createNeonDriveControlPlaneRepository } from "@/lib/repositories/neon-drive-control-plane";
import { createConfiguredFreeTierHealthService } from "@/lib/application/configured-health";
import { createConfiguredDrive } from "@/lib/application/configured-drive";

export const runtime = "nodejs";
const HEADERS = { "cache-control": "no-store" } as const;

export async function POST(request: NextRequest) {
  try {
    const env = parseServerEnv(process.env);
    const repository = createNeonWorkerControlPlaneRepository(env.databaseUrl);
    const driveRepository = createNeonDriveControlPlaneRepository(env.databaseUrl);
    const worker = await requireWorkerSession(request, repository, env.workerAuthKeyV1, new Date());
    const service = createJobQueueService({
      repository,
      health: createConfiguredFreeTierHealthService(env, driveRepository),
      pipelineBridgeVersion: env.workerPipelineBridgeVersion,
      generateId: () => crypto.randomUUID(),
    });
    // Token first: a transient token failure must abort BEFORE the claim commits,
    // otherwise the job sits CLAIMED for the whole lease TTL with no worker knowing.
    // The access provider caches tokens, so empty claim polls stay cheap.
    const driveAccessToken = await createConfiguredDrive(env, driveRepository).access.getAccessToken();
    const result = await service.claim(worker, new Date());
    return NextResponse.json({ ...result, driveAccessToken }, { headers: HEADERS });
  } catch (error) {
    if (error instanceof AppError) {
      if (error.status === 204) return new NextResponse(null, { status: 204, headers: HEADERS });
      return NextResponse.json(publicErrorBody(error), { status: error.status, headers: HEADERS });
    }
    console.error("[api] unhandled error", error);
    return NextResponse.json({ code: "INTERNAL_ERROR" }, { status: 500, headers: HEADERS });
  }
}
