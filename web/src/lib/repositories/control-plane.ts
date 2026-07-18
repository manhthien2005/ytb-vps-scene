import type { JobSummary } from "@/lib/domain/control-plane";

export type RepositoryHealth = Readonly<{ ok: boolean; latencyMs: number }>;
export type LoginAttemptDecision = Readonly<{ allowed: boolean; retryAfterSeconds: number }>;
export type AuditEvent = Readonly<{
  eventType: string;
  targetId?: string;
  actorClass: "admin" | "worker" | "cron" | "system";
  payload: Readonly<Record<string, string | number | boolean | null>>;
}>;

export interface ControlPlaneRepository {
  listJobs(): Promise<readonly JobSummary[]>;
  recordAudit(event: AuditEvent): Promise<void>;
  health(): Promise<RepositoryHealth>;
  consumeLoginAttempt(keyHash: string, now: Date): Promise<LoginAttemptDecision>;
  clearLoginAttempts(keyHash: string): Promise<void>;
}
