import type {
  JobDetail,
  JobOutputPartMetadata,
  JobSourceMetadata,
  JobSummary,
  WorkerState,
} from "@/lib/domain/control-plane";

export type RepositoryHealth = Readonly<{ ok: boolean; latencyMs: number }>;
export type LoginAttemptDecision = Readonly<{ allowed: boolean; retryAfterSeconds: number }>;
export type JobCancellationOutcome =
  | "REQUESTED"
  | "ALREADY_TERMINAL"
  | "NOT_FOUND"
  | "NOT_CANCELABLE";

export type JobDetailReadModel = Readonly<JobDetail & {
  createdAt: string;
  outputMetadata: JobSourceMetadata | null;
  outputParts: readonly JobOutputPartMetadata[];
  workerSummary: Readonly<{
    id: string;
    state: WorkerState;
    accountLabel: string | null;
  }> | null;
  attemptSummary: Readonly<{
    count: number;
    activeCount: number;
    latestStartedAt: string | null;
    latestEndedAt: string | null;
    latestOutcome: "COMPLETED" | "FAILED" | "LEASE_LOST" | "CANCELLED" | null;
  }>;
  canCancel: boolean;
  canRetry: boolean;
}>;

export type AuditEvent = Readonly<{
  eventType: string;
  targetId?: string;
  actorClass: "admin" | "worker" | "cron" | "system";
  payload: Readonly<Record<string, string | number | boolean | null>>;
}>;

export interface ControlPlaneRepository {
  listJobs(): Promise<readonly JobSummary[]>;
  getJobDetail(jobId: string): Promise<JobDetailReadModel | null>;
  requestJobCancellation(jobId: string, now: Date): Promise<JobCancellationOutcome>;
  recordAudit(event: AuditEvent): Promise<void>;
  health(): Promise<RepositoryHealth>;
  consumeLoginAttempt(keyHash: string, now: Date): Promise<LoginAttemptDecision>;
  clearLoginAttempts(keyHash: string): Promise<void>;
}
