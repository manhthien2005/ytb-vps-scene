import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseServerEnv } from "@/lib/config/env";
import { AppError, publicErrorBody } from "@/lib/domain/errors";
import { readStrictJson } from "@/lib/http/requests";
import { requireWorkerSession } from "@/lib/http/worker-auth";
import { createNeonWorkerControlPlaneRepository } from "@/lib/repositories/neon-worker-control-plane";
import { createWorkerControlService } from "@/lib/application/worker-control";

export const runtime = "nodejs";
const HEADERS = { "cache-control": "no-store" } as const;
const bodySchema = z.object({ capabilities: z.unknown(), doctor: z.unknown() }).strict();

export async function POST(request: NextRequest) {
  try {
    const env = parseServerEnv(process.env);
    const repository = createNeonWorkerControlPlaneRepository(env.databaseUrl);
    const worker = await requireWorkerSession(request, repository, env.workerAuthKeyV1, new Date());
    const body = await readStrictJson(request, bodySchema, 8_192);
    const service = createWorkerControlService({
      repository,
      authKey: env.workerAuthKeyV1,
      appOrigin: env.appOrigin,
      releaseRepository: env.workerReleaseRepository,
      releaseCommit: env.workerReleaseCommit,
      pipelineBridgeVersion: env.workerPipelineBridgeVersion,
    });
    const result = await service.heartbeat(worker.id, body, new Date());
    return NextResponse.json({ state: result.state, lastHeartbeatAt: result.lastHeartbeatAt }, { headers: HEADERS });
  } catch (error) {
    if (error instanceof AppError) return NextResponse.json(publicErrorBody(error), { status: error.status, headers: HEADERS });
    console.error("[api] unhandled error", error);
    return NextResponse.json({ code: "INTERNAL_ERROR" }, { status: 500, headers: HEADERS });
  }
}
