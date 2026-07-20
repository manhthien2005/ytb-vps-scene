import { NextResponse, type NextRequest } from "next/server";
import { parseServerEnv } from "@/lib/config/env";
import { AppError, publicErrorBody } from "@/lib/domain/errors";
import { requireWorkerSession } from "@/lib/http/worker-auth";
import { createNeonWorkerControlPlaneRepository } from "@/lib/repositories/neon-worker-control-plane";
import { createJobQueueService } from "@/lib/application/job-queue";
import { createFreeTierHealthService } from "@/lib/application/free-tier-health";

export const runtime = "nodejs";
const HEADERS = { "cache-control": "no-store" } as const;

export async function POST(request: NextRequest) {
  try {
    const env = parseServerEnv(process.env);
    const repository = createNeonWorkerControlPlaneRepository(env.databaseUrl);
    const worker = await requireWorkerSession(request, repository, env.workerAuthKeyV1, new Date());
    const service = createJobQueueService({
      repository,
      health: createFreeTierHealthService({
        repository: repository as never,
        access: {} as never,
        files: {} as never,
        neonLimitBytes: env.neonStorageLimitBytes,
        softPercent: env.freeTierSoftPercent,
        staleAfterSeconds: env.quotaStaleAfterSeconds,
      }),
      pipelineBridgeVersion: env.workerPipelineBridgeVersion,
      generateId: () => crypto.randomUUID(),
    });
    const result = await service.claim(worker, new Date());
    return NextResponse.json(result, { headers: HEADERS });
  } catch (error) {
    if (error instanceof AppError) {
      if (error.status === 204) return new NextResponse(null, { status: 204, headers: HEADERS });
      return NextResponse.json(publicErrorBody(error), { status: error.status, headers: HEADERS });
    }
    return NextResponse.json({ code: "INTERNAL_ERROR" }, { status: 500, headers: HEADERS });
  }
}
