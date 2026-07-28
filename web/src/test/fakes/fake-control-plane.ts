import {
  isCancelableJobState,
  isTerminalJobState,
  type JobSummary,
} from "@/lib/domain/control-plane";
import type {
  AuditEvent,
  ControlPlaneRepository,
  JobCancellationOutcome,
  JobDetailReadModel,
  LoginAttemptDecision,
  RepositoryHealth,
} from "@/lib/repositories/control-plane";

export class FakeControlPlaneRepository implements ControlPlaneRepository {
  readonly auditEvents: AuditEvent[] = [];
  private readonly loginWindows = new Map<string, { startedAt: number; attempts: number; blockedUntil?: number }>();
  private readonly jobsById: Map<string, JobSummary>;

  constructor(jobs: readonly JobSummary[] = []) {
    this.jobsById = new Map(jobs.map((job) => [job.id, structuredClone(job)]));
  }

  async listJobs(): Promise<readonly JobSummary[]> {
    return [...this.jobsById.values()]
      .filter((job) => job.state !== "DELETED")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 100);
  }

  async getJobDetail(jobId: string): Promise<JobDetailReadModel | null> {
    const job = this.jobsById.get(jobId);
    if (!job) return null;
    return Object.freeze({
      ...structuredClone(job),
      createdAt: job.updatedAt,
      settingsSnapshot: job.settingsSnapshot ?? null,
      sourceMetadata: job.sourceMetadata ?? null,
      telemetry: Object.freeze({
        activePhase: job.activePhase ?? null,
        phaseProgressPercent: job.phaseProgressPercent ?? null,
        latestMessage: job.latestMessage ?? null,
        etaSeconds: job.etaSeconds ?? null,
        startedAt: job.startedAt ?? null,
        completedAt: job.completedAt ?? null,
        cancelRequestedAt: job.cancelRequestedAt ?? null,
        errorCode: job.errorCode ?? null,
        errorMessage: job.errorMessage ?? null,
      }),
      progressHistory: Object.freeze([]),
      outputMetadata: null,
      outputParts: Object.freeze([]),
      workerSummary: null,
      attemptSummary: Object.freeze({
        count: 0,
        activeCount: 0,
        latestStartedAt: null,
        latestEndedAt: null,
        latestOutcome: null,
      }),
      canCancel: isCancelableJobState(job.state),
      canRetry: job.state === "FAILED_RETRYABLE",
    });
  }

  async requestJobCancellation(jobId: string, now: Date): Promise<JobCancellationOutcome> {
    const job = this.jobsById.get(jobId);
    if (!job) return "NOT_FOUND";
    if (isTerminalJobState(job.state)) return "ALREADY_TERMINAL";
    if (!isCancelableJobState(job.state)) return "NOT_CANCELABLE";
    const timestamp = now.toISOString();
    const updated: JobSummary = {
      ...job,
      state: "CANCEL_REQUESTED",
      cancelRequestedAt: job.cancelRequestedAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.jobsById.set(jobId, structuredClone(updated));
    return "REQUESTED";
  }

  async recordAudit(event: AuditEvent): Promise<void> {
    this.auditEvents.push(structuredClone(event));
  }

  async health(): Promise<RepositoryHealth> {
    return { ok: true, latencyMs: 0 };
  }

  async consumeLoginAttempt(keyHash: string, now: Date): Promise<LoginAttemptDecision> {
    // Mirrors neon-control-plane: the block lasts 15 minutes from the BLOCKING
    // attempt (not the window start), attempts stop counting while blocked, and
    // retryAfterSeconds reports the actual remaining time.
    const timestamp = now.getTime();
    const existing = this.loginWindows.get(keyHash);
    if (existing?.blockedUntil !== undefined && existing.blockedUntil > timestamp) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.blockedUntil - timestamp) / 1000)),
      };
    }
    const window = !existing || timestamp - existing.startedAt >= 15 * 60 * 1000
      ? { startedAt: timestamp, attempts: 0, blockedUntil: undefined as number | undefined }
      : existing;
    window.attempts += 1;
    if (window.attempts > 5) window.blockedUntil = timestamp + 15 * 60 * 1000;
    this.loginWindows.set(keyHash, window);
    return window.attempts <= 5
      ? { allowed: true, retryAfterSeconds: 0 }
      : { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((window.blockedUntil! - timestamp) / 1000)) };
  }

  async clearLoginAttempts(keyHash: string): Promise<void> {
    this.loginWindows.delete(keyHash);
  }
}
