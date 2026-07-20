import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseServerEnv } from "@/lib/config/env";
import { AppError, publicErrorBody } from "@/lib/domain/errors";
import { readStrictJson } from "@/lib/http/requests";
import { requireWorkerSession } from "@/lib/http/worker-auth";
import { createNeonWorkerControlPlaneRepository } from "@/lib/repositories/neon-worker-control-plane";
import { createJobQueueService } from "@/lib/application/job-queue";

export const runtime = "nodejs";
const HEADERS = { "cache-control": "no-store" } as const;
const schema = z.object({ fencingToken: z.number().int().positive() }).strict();
type Context = Readonly<{ params: Promise<Readonly<{ id: string }>> }>;

export async function POST(request: NextRequest, context: Context) {
  try {
    const env = parseServerEnv(process.env);
    const repository = createNeonWorkerControlPlaneRepository(env.databaseUrl);
    const worker = await requireWorkerSession(request, repository, env.workerAuthKeyV1, new Date());
    const body = await readStrictJson(request, schema, 2_048);
    const service = createJobQueueService({ repository, health: {} as never, pipelineBridgeVersion: env.workerPipelineBridgeVersion, generateId: crypto.randomUUID });
    const { id } = await context.params;
    return NextResponse.json(await service.renew(worker, { jobId: id, fencingToken: body.fencingToken }, new Date()), { headers: HEADERS });
  } catch (error) {
    if (error instanceof AppError) return NextResponse.json(publicErrorBody(error), { status: error.status, headers: HEADERS });
    return NextResponse.json({ code: "INTERNAL_ERROR" }, { status: 500, headers: HEADERS });
  }
}
