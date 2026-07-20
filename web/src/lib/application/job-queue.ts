import "server-only";

import { AppError } from "@/lib/domain/errors";
import { assertJobTransition } from "@/lib/domain/control-plane";
import type { WorkerView } from "@/lib/domain/worker";
import type { FreeTierHealthService } from "./free-tier-health";
import type { WorkerControlPlaneRepository } from "@/lib/repositories/worker-control-plane";
import { workerRequestKeyDigest } from "./worker-control";

export type JobQueueDependencies = Readonly<{
  repository: WorkerControlPlaneRepository;
  health: FreeTierHealthService;
  pipelineBridgeVersion: string;
  generateId: () => string;
}>;

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
      if (
        dependencies.pipelineBridgeVersion === "cp3-control-only" ||
        worker.capabilities.pipelineBridgeVersion === "cp3-control-only" ||
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
      input: Readonly<{ jobId: string; fencingToken: number; fromState: Parameters<typeof assertJobTransition>[0]; state: Parameters<typeof assertJobTransition>[1]; progressPercent: number }>,
      now: Date,
    ) {
      if (!Number.isSafeInteger(input.progressPercent) || input.progressPercent < 0 || input.progressPercent > 100) {
        throw new AppError("INVALID_REQUEST", 400);
      }
      try {
        assertJobTransition(input.fromState, input.state);
      } catch {
        throw new AppError("INVALID_REQUEST", 400);
      }
      const outcome = await dependencies.repository.updateJobProgress({ ...input, workerId: worker.id, now });
      if (outcome === "LEASE_LOST") throw new AppError("LEASE_LOST", 409);
      return outcome;
    },
  };
}
