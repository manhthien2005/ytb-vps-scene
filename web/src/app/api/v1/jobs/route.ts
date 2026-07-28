import { NextRequest, NextResponse } from "next/server";
import { parseServerEnv } from "@/lib/config/env";
import type { JobSummary } from "@/lib/domain/control-plane";
import { AppError, publicErrorBody } from "@/lib/domain/errors";
import { requireAdmin } from "@/lib/http/requests";
import { createNeonControlPlaneRepository } from "@/lib/repositories/neon-control-plane";
import { redactSecrets } from "@/lib/security/redact";

export const runtime = "nodejs";
const RESPONSE_HEADERS = { "cache-control": "no-store" } as const;

function publicJob(job: JobSummary): JobSummary {
  return {
    id: job.id,
    projectName: job.projectName,
    state: job.state,
    progressPercent: job.progressPercent,
    updatedAt: job.updatedAt,
    settingsSnapshot: job.settingsSnapshot ?? null,
    sourceMetadata: job.sourceMetadata ?? null,
    outputParts: job.outputParts ?? [],
    activePhase: job.activePhase ?? null,
    phaseProgressPercent: job.phaseProgressPercent ?? null,
    latestMessage: job.latestMessage ?? null,
    etaSeconds: job.etaSeconds ?? null,
    startedAt: job.startedAt ?? null,
    completedAt: job.completedAt ?? null,
    cancelRequestedAt: job.cancelRequestedAt ?? null,
    errorCode: job.errorCode ?? null,
    errorMessage: job.errorMessage ?? null,
  };
}

function errorResponse(error: AppError): NextResponse {
  return NextResponse.json(publicErrorBody(error), {
    status: error.status,
    headers: RESPONSE_HEADERS,
  });
}

function unexpectedErrorResponse(error: unknown): NextResponse {
  console.error("[api] unhandled error", redactSecrets(error));
  return NextResponse.json(
    { code: "INTERNAL_ERROR" },
    { status: 500, headers: RESPONSE_HEADERS },
  );
}

export async function GET(request: NextRequest) {
  try {
    const env = parseServerEnv(process.env);
    await requireAdmin(request, env.sessionSecret);
    const jobs = await createNeonControlPlaneRepository(env.databaseUrl).listJobs();
    return NextResponse.json(
      { jobs: jobs.map(publicJob) },
      { headers: RESPONSE_HEADERS },
    );
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error);
    return unexpectedErrorResponse(error);
  }
}
