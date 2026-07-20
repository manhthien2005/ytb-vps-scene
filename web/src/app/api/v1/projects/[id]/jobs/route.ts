import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseServerEnv } from "@/lib/config/env";
import { AppError, publicErrorBody } from "@/lib/domain/errors";
import { HttpError, requireAdmin, requireMutationOrigin } from "@/lib/http/requests";
import { createNeonWorkerControlPlaneRepository } from "@/lib/repositories/neon-worker-control-plane";
import { createJobQueueService } from "@/lib/application/job-queue";
import { createNeonDriveControlPlaneRepository } from "@/lib/repositories/neon-drive-control-plane";
import { createConfiguredFreeTierHealthService } from "@/lib/application/configured-health";

export const runtime = "nodejs";
const HEADERS = { "cache-control": "no-store" } as const;
const uuid = z.string().uuid();
type Context = Readonly<{ params: Promise<Readonly<{ id: string }>> }>;

export async function POST(request: NextRequest, context: Context) {
  try {
    const env = parseServerEnv(process.env);
    await requireAdmin(request, env.sessionSecret);
    requireMutationOrigin(request, env.appOrigin);
    const id = (await context.params).id;
    if (!uuid.safeParse(id).success) throw new HttpError(400, "INVALID_REQUEST");
    const requestKey = request.headers.get("idempotency-key");
    if (requestKey === null) throw new HttpError(400, "INVALID_REQUEST");
    const repository = createNeonWorkerControlPlaneRepository(env.databaseUrl);
    const driveRepository = createNeonDriveControlPlaneRepository(env.databaseUrl);
    const service = createJobQueueService({
      repository,
      health: createConfiguredFreeTierHealthService(env, driveRepository),
      pipelineBridgeVersion: env.workerPipelineBridgeVersion,
      generateId: crypto.randomUUID,
    });
    const job = await service.queueProject(id, requestKey, new Date());
    return NextResponse.json({ job }, { status: 201, headers: HEADERS });
  } catch (error) {
    if (error instanceof AppError) return NextResponse.json(publicErrorBody(error), { status: error.status, headers: HEADERS });
    return NextResponse.json({ code: "INTERNAL_ERROR" }, { status: 500, headers: HEADERS });
  }
}
