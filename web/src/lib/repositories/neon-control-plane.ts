import "server-only";
import { JOB_STATES, type JobState, type JobSummary } from "@/lib/domain/control-plane";
import { createSql } from "@/lib/db/client";
import type { AuditEvent, ControlPlaneRepository, LoginAttemptDecision, RepositoryHealth } from "./control-plane";

function isJobState(value: unknown): value is JobState {
  return typeof value === "string" && JOB_STATES.some((state) => state === value);
}

function parseJobState(value: unknown): JobState {
  if (!isJobState(value)) {
    throw new Error("Invalid job state returned by database");
  }
  return value;
}

export type ControlPlaneSqlClient = Readonly<{
  query: (
    text: string,
    parameters?: unknown[],
  ) => Promise<Readonly<{ rows: Record<string, unknown>[] }>>;
}>;

export function createControlPlaneRepository(sql: ControlPlaneSqlClient): ControlPlaneRepository {
  return {
    async listJobs(): Promise<readonly JobSummary[]> {
      const result = await sql.query(
        "select id, project_name, state, progress_percent, updated_at from jobs where state <> $1 order by updated_at desc limit 100",
        ["DELETED"],
      );
      return result.rows.map((row) => ({
        id: String(row.id),
        projectName: String(row.project_name),
        state: parseJobState(row.state),
        progressPercent: Number(row.progress_percent),
        updatedAt: new Date(String(row.updated_at)).toISOString(),
      }));
    },

    async recordAudit(event: AuditEvent): Promise<void> {
      await sql.query(
        "insert into audit_events(event_type,target_id,actor_class,payload) values ($1,$2,$3,$4::jsonb)",
        [event.eventType, event.targetId ?? null, event.actorClass, JSON.stringify(event.payload)],
      );
    },

    async health(): Promise<RepositoryHealth> {
      const start = performance.now();
      await sql.query("select 1 as ok");
      return { ok: true, latencyMs: Math.round(performance.now() - start) };
    },

    async consumeLoginAttempt(keyHash: string, now: Date): Promise<LoginAttemptDecision> {
      const result = await sql.query(
        `insert into auth_login_windows(key_hash,window_started,attempt_count,blocked_until)
         values ($1,$2,1,null)
         on conflict(key_hash) do update set
           window_started = case
             when auth_login_windows.blocked_until > excluded.window_started then auth_login_windows.window_started
             when auth_login_windows.window_started <= excluded.window_started - interval '15 minutes' then excluded.window_started
             else auth_login_windows.window_started end,
           attempt_count = case
             when auth_login_windows.blocked_until > excluded.window_started then auth_login_windows.attempt_count
             when auth_login_windows.window_started <= excluded.window_started - interval '15 minutes' then 1
             else least(auth_login_windows.attempt_count + 1, 1000) end,
           blocked_until = case
             when auth_login_windows.blocked_until > excluded.window_started then auth_login_windows.blocked_until
             when auth_login_windows.window_started <= excluded.window_started - interval '15 minutes' then null
             when auth_login_windows.attempt_count + 1 > 5 then excluded.window_started + interval '15 minutes'
             else null end
         returning blocked_until`,
        [keyHash, now.toISOString()],
      );
      const blocked = result.rows[0]?.blocked_until;
      if (!blocked) return { allowed: true, retryAfterSeconds: 0 };
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((new Date(String(blocked)).getTime() - now.getTime()) / 1000)),
      };
    },

    async clearLoginAttempts(keyHash: string): Promise<void> {
      await sql.query("delete from auth_login_windows where key_hash = $1", [keyHash]);
    },
  };
}

export function createNeonControlPlaneRepository(databaseUrl: string): ControlPlaneRepository {
  return createControlPlaneRepository(createSql(databaseUrl));
}
