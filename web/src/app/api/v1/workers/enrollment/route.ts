import { NextResponse, type NextRequest } from "next/server";
import { parseServerEnv } from "@/lib/config/env";
import { AppError, publicErrorBody } from "@/lib/domain/errors";
import { requireAdmin, requireMutationOrigin } from "@/lib/http/requests";
import { createNeonWorkerControlPlaneRepository } from "@/lib/repositories/neon-worker-control-plane";
import { createWorkerControlService } from "@/lib/application/worker-control";

export const runtime = "nodejs";
const HEADERS = { "cache-control": "no-store" } as const;

export async function POST(request: NextRequest) {
  try {
    const env = parseServerEnv(process.env);
    await requireAdmin(request, env.sessionSecret);
    requireMutationOrigin(request, env.appOrigin);
    const service = createWorkerControlService({
      repository: createNeonWorkerControlPlaneRepository(env.databaseUrl),
      authKey: env.workerAuthKeyV1,
      appOrigin: env.appOrigin,
      releaseRepository: env.workerReleaseRepository,
      releaseCommit: env.workerReleaseCommit,
      pipelineBridgeVersion: env.workerPipelineBridgeVersion,
    });
    return NextResponse.json(await service.createEnrollment(new Date()), { headers: HEADERS });
  } catch (error) {
    if (error instanceof AppError) return NextResponse.json(publicErrorBody(error), { status: error.status, headers: HEADERS });
    console.error("[api] unhandled error", error);
    return NextResponse.json({ code: "INTERNAL_ERROR" }, { status: 500, headers: HEADERS });
  }
}
