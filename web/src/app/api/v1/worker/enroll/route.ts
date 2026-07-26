import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseServerEnv } from "@/lib/config/env";
import { AppError, publicErrorBody } from "@/lib/domain/errors";
import { readStrictJson } from "@/lib/http/requests";
import { createNeonWorkerControlPlaneRepository } from "@/lib/repositories/neon-worker-control-plane";
import { createWorkerControlService } from "@/lib/application/worker-control";
import { redactSecrets } from "@/lib/security/redact";

export const runtime = "nodejs";
const HEADERS = { "cache-control": "no-store" } as const;
const bodySchema = z.object({
  enrollmentToken: z.string().min(43).max(43),
  capabilities: z.unknown(),
  doctor: z.unknown(),
  accountLabel: z.string().trim().min(1).max(80).nullable().optional(),
}).strict();

export async function POST(request: NextRequest) {
  try {
    const env = parseServerEnv(process.env);
    const body = await readStrictJson(request, bodySchema, 4_096);
    const service = createWorkerControlService({
      repository: createNeonWorkerControlPlaneRepository(env.databaseUrl),
      authKey: env.workerAuthKeyV1,
      appOrigin: env.appOrigin,
      releaseRepository: env.workerReleaseRepository,
      releaseCommit: env.workerReleaseCommit,
      pipelineBridgeVersion: env.workerPipelineBridgeVersion,
    });
    return NextResponse.json(await service.enroll(body, new Date()), { headers: HEADERS });
  } catch (error) {
    if (error instanceof AppError) return NextResponse.json(publicErrorBody(error), { status: error.status, headers: HEADERS });
    console.error("[api] unhandled error", redactSecrets(error));
    return NextResponse.json({ code: "INTERNAL_ERROR" }, { status: 500, headers: HEADERS });
  }
}
