import type { JobSummary } from "@/lib/domain/control-plane";
import type { AuditEvent, ControlPlaneRepository, LoginAttemptDecision, RepositoryHealth } from "@/lib/repositories/control-plane";

export class FakeControlPlaneRepository implements ControlPlaneRepository {
  readonly auditEvents: AuditEvent[] = [];
  private readonly loginWindows = new Map<string, { startedAt: number; attempts: number }>();

  constructor(private readonly jobs: readonly JobSummary[] = []) {}

  async listJobs(): Promise<readonly JobSummary[]> {
    return [...this.jobs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async recordAudit(event: AuditEvent): Promise<void> {
    this.auditEvents.push(structuredClone(event));
  }

  async health(): Promise<RepositoryHealth> {
    return { ok: true, latencyMs: 0 };
  }

  async consumeLoginAttempt(keyHash: string, now: Date): Promise<LoginAttemptDecision> {
    const timestamp = now.getTime();
    const existing = this.loginWindows.get(keyHash);
    const window = !existing || timestamp - existing.startedAt >= 15 * 60 * 1000
      ? { startedAt: timestamp, attempts: 0 }
      : existing;
    window.attempts += 1;
    this.loginWindows.set(keyHash, window);
    return window.attempts <= 5
      ? { allowed: true, retryAfterSeconds: 0 }
      : { allowed: false, retryAfterSeconds: 900 };
  }

  async clearLoginAttempts(keyHash: string): Promise<void> {
    this.loginWindows.delete(keyHash);
  }
}
