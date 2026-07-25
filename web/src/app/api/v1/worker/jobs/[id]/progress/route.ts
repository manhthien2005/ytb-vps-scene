import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { JOB_STATES } from "@/lib/domain/control-plane";
import { parseServerEnv } from "@/lib/config/env";
import { AppError, publicErrorBody } from "@/lib/domain/errors";
import { readStrictJson } from "@/lib/http/requests";
import { requireWorkerSession } from "@/lib/http/worker-auth";
import { createNeonWorkerControlPlaneRepository } from "@/lib/repositories/neon-worker-control-plane";
import { createJobQueueService } from "@/lib/application/job-queue";

export const runtime = "nodejs";
const HEADERS = { "cache-control": "no-store" } as const;
const singleLine = (maxLength: number) => z.string()
  .min(1)
  .max(maxLength)
  .refine((value) => value.trim() === value && !value.includes("\n") && !value.includes("\r"));
const schema = z.object({
  fencingToken: z.number().int().positive(),
  fromState: z.enum(JOB_STATES),
  state: z.enum(JOB_STATES),
  progressPercent: z.number().int().min(0).max(100),
  phase: singleLine(80).nullable().optional(),
  phaseProgressPercent: z.number().int().min(0).max(100).nullable().optional(),
  message: singleLine(500).nullable().optional(),
  etaSeconds: z.number().int().min(0).max(31_536_000).nullable().optional(),
  processedSeconds: z.number().int().min(0).max(31_536_000).nullable().optional(),
  totalSeconds: z.number().int().min(0).max(31_536_000).nullable().optional(),
  currentPart: z.number().int().min(0).max(1_000_000).nullable().optional(),
  totalParts: z.number().int().min(0).max(1_000_000).nullable().optional(),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/).nullable().optional(),
}).strict();
type Context = Readonly<{ params: Promise<Readonly<{ id: string }>> }>;

export async function POST(request: NextRequest, context: Context) {
  try {
    const env = parseServerEnv(process.env);
    const repository = createNeonWorkerControlPlaneRepository(env.databaseUrl);
    const worker = await requireWorkerSession(request, repository, env.workerAuthKeyV1, new Date());
    const body = await readStrictJson(request, schema, 2_048);
    const service = createJobQueueService({ repository, health: {} as never, pipelineBridgeVersion: env.workerPipelineBridgeVersion, generateId: crypto.randomUUID });
    const { id } = await context.params;
    await service.progress(worker, { ...body, jobId: id }, new Date());
    return NextResponse.json({ status: "UPDATED" }, { headers: HEADERS });
  } catch (error) {
    if (error instanceof AppError) return NextResponse.json(publicErrorBody(error), { status: error.status, headers: HEADERS });
    return NextResponse.json({ code: "INTERNAL_ERROR" }, { status: 500, headers: HEADERS });
  }
}
