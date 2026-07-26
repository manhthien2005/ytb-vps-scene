import "server-only";

import { AppError } from "@/lib/domain/errors";
import { assertJobTransition } from "@/lib/domain/control-plane";
import type { WorkerView } from "@/lib/domain/worker";
import type { FreeTierHealthService } from "./free-tier-health";
import type { JobProgress, WorkerControlPlaneRepository } from "@/lib/repositories/worker-control-plane";
import { workerRequestKeyDigest } from "./worker-control";

export type JobQueueDependencies = Readonly<{
  repository: WorkerControlPlaneRepository;
  health: FreeTierHealthService;
  pipelineBridgeVersion: string;
  generateId: () => string;
}>;

type JobProgressInput = Omit<JobProgress, "workerId" | "now">;

function invalidRequest(): never {
  throw new AppError("INVALID_REQUEST", 400);
}

function validateOptionalTelemetry(input: JobProgressInput): void {
  const validateString = (value: unknown, maxLength: number): void => {
    if (value === undefined || value === null) return;
    if (
      typeof value !== "string"
      || value.trim() !== value
      || value.length < 1
      || value.length > maxLength
      || value.includes("\n")
      || value.includes("\r")
    ) invalidRequest();
  };
  const validateInteger = (value: unknown, max: number): void => {
    if (value === undefined || value === null) return;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
      invalidRequest();
    }
  };

  validateString(input.phase, 80);
  validateInteger(input.phaseProgressPercent, 100);
  validateString(input.message, 500);
  if (
    typeof input.message === "string"
    && /(access[_ -]?token|refresh[_ -]?token|authorization|cookie|stack[_ -]?trace|traceback|worker[_ -]?secret|session[_ -]?secret|raw[_ -]?log|bearer\s+\S+)/i.test(input.message)
  ) invalidRequest();
  validateInteger(input.etaSeconds, 31_536_000);
  validateInteger(input.processedSeconds, 31_536_000);
  validateInteger(input.totalSeconds, 31_536_000);
  validateInteger(input.currentPart, 1_000_000);
  validateInteger(input.totalParts, 1_000_000);
  if (
    input.errorCode !== undefined
    && input.errorCode !== null
    && (typeof input.errorCode !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/.test(input.errorCode))
  ) invalidRequest();
}

export function createJobQueueService(dependencies: JobQueueDependencies) {
  return {
    async queueProject(projectId: string, requestKey: string, now: Date) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(projectId) || requestKey.trim().length < 8) {
        throw new AppError("INVALID_REQUEST", 400);
      }
      await dependencies.health.assertUploadAllowed(0, now);
      const job = await dependencies.repository.queueProjectJob({
        jobId: dependencies.generateId(),
        projectId,
        requestKeyDigest: workerRequestKeyDigest(projectId, requestKey),
        now,
      });
      if (job === null) throw new AppError("JOB_NOT_QUEUEABLE", 409);
      return job;
    },

    async claim(worker: WorkerView, now: Date) {
      // Control-only deployments never hand out media jobs; otherwise the worker's
      // bridge must match exactly (which also rejects control-only workers).
      if (
        dependencies.pipelineBridgeVersion === "cp3-control-only" ||
        worker.capabilities.pipelineBridgeVersion !== dependencies.pipelineBridgeVersion
      ) throw new AppError("WORKER_INCOMPATIBLE", 409);
      const assignment = await dependencies.repository.claimJob(worker.id, now, dependencies.pipelineBridgeVersion);
      if (assignment === null) throw new AppError("NO_JOB_AVAILABLE", 204);
      return assignment;
    },

    async renew(worker: WorkerView, input: Readonly<{ jobId: string; fencingToken: number }>, now: Date) {
      const lease = await dependencies.repository.renewLease({ ...input, workerId: worker.id, now });
      if (lease === null) throw new AppError("LEASE_LOST", 409);
      return lease;
    },

    async progress(
      worker: WorkerView,
      input: JobProgressInput,
      now: Date,
    ) {
      if (!Number.isSafeInteger(input.progressPercent) || input.progressPercent < 0 || input.progressPercent > 100) {
        invalidRequest();
      }
      try {
        assertJobTransition(input.fromState, input.state);
      } catch {
        invalidRequest();
      }
      validateOptionalTelemetry(input);
      const outcome = await dependencies.repository.updateJobProgress({ ...input, workerId: worker.id, now });
      if (outcome === "LEASE_LOST") throw new AppError("LEASE_LOST", 409);
      return outcome;
    },
  };
}
