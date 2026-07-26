import "server-only";
import {
  JOB_STATES,
  WORKER_STATES,
  isCancelableJobState,
  isTerminalJobState,
  type JobDetail,
  type JobPhaseTelemetry,
  type JobProgressEvent,
  type JobSourceMetadata,
  type JobState,
  type JobSummary,
  type WorkerState,
} from "@/lib/domain/control-plane";
import { parseSceneSettings, type SceneSettings } from "@/lib/domain/scene-settings";
import { createSql } from "@/lib/db/client";
import type {
  AuditEvent,
  ControlPlaneRepository,
  JobCancellationOutcome,
  JobDetailReadModel,
  LoginAttemptDecision,
  RepositoryHealth,
} from "./control-plane";

function isJobState(value: unknown): value is JobState {
  return typeof value === "string" && JOB_STATES.some((state) => state === value);
}

function parseJobState(value: unknown): JobState {
  if (!isJobState(value)) {
    throw new Error("Invalid job state returned by database");
  }
  return value;
}

function parseWorkerState(value: unknown): WorkerState {
  if (typeof value !== "string" || !WORKER_STATES.includes(value as WorkerState)) {
    throw new Error("Invalid worker state returned by database");
  }
  return value as WorkerState;
}

function parseJson(value: unknown, label: string): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Invalid ${label} returned by database`);
  }
}

function asIso(value: unknown, label: string): string {
  if (value === null || value === undefined) {
    throw new Error(`Invalid ${label} returned by database`);
  }
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.valueOf())) {
    throw new Error(`Invalid ${label} returned by database`);
  }
  return date.toISOString();
}

function nullableIso(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return asIso(value, label);
}

function boundedText(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== "string" || value.length < min || value.length > max || value.includes("\n")) {
    throw new Error(`Invalid ${label} returned by database`);
  }
  return value;
}

function nullableText(value: unknown, label: string, min: number, max: number): string | null {
  if (value === null || value === undefined) return null;
  return boundedText(value, label, min, max);
}

function nullableErrorMessage(value: unknown): string | null {
  const message = nullableText(value, "job error message", 1, 500);
  if (message === null) return null;
  return /stack\s*trace|^\s*(?:error|exception)\s*[:(]|\bat\s+\S+\s*\(/i.test(message)
    ? null
    : message;
}

function safeInteger(value: unknown, label: string, min?: number, max?: number): number {
  if (
    (typeof value !== "number" && typeof value !== "string" && typeof value !== "bigint")
    || value === ""
  ) {
    throw new Error(`Invalid ${label} returned by database`);
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed)
    || (min !== undefined && parsed < min)
    || (max !== undefined && parsed > max)
  ) {
    throw new Error(`Invalid ${label} returned by database`);
  }
  return parsed;
}

function nullableSafeInteger(
  value: unknown,
  label: string,
  min?: number,
  max?: number,
): number | null {
  if (value === null || value === undefined) return null;
  return safeInteger(value, label, min, max);
}

function parseSettingsSnapshot(value: unknown): SceneSettings | null {
  const parsed = parseJson(value, "job settings snapshot");
  if (parsed === null) return null;
  try {
    return Object.freeze(parseSceneSettings(parsed));
  } catch {
    throw new Error("Invalid job settings snapshot returned by database");
  }
}

function sourceMetadataFromValue(value: unknown): JobSourceMetadata | null {
  const parsed = parseJson(value, "job source metadata");
  if (parsed === null) return null;
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid job source metadata returned by database");
  }
  const object = parsed as Record<string, unknown>;
  const artifactId = nullableText(object.artifactId ?? object.artifact_id, "job source artifact id", 1, 256);
  const displayName = nullableText(object.displayName ?? object.display_name, "job source display name", 1, 255);
  const mimeType = nullableText(object.mimeType ?? object.mime_type, "job source mime type", 1, 127);
  const sizeBytes = nullableSafeInteger(
    object.sizeBytes ?? object.size_bytes,
    "job source size",
    0,
  );
  const checksumValue = object.checksumSha256 ?? object.checksum_sha256;
  const checksumSha256 = checksumValue === null || checksumValue === undefined
    ? null
    : typeof checksumValue === "string" && /^[0-9a-f]{64}$/.test(checksumValue)
      ? checksumValue
      : (() => {
        throw new Error("Invalid job source checksum returned by database");
      })();
  return Object.freeze({ artifactId, displayName, mimeType, sizeBytes, checksumSha256 });
}

function sourceMetadataFromColumns(
  row: Record<string, unknown>,
  prefix: "source" | "output",
): JobSourceMetadata | null {
  const artifactId = row[`${prefix}_artifact_id`];
  const displayName = row[`${prefix}_display_name`];
  const mimeType = row[`${prefix}_mime_type`];
  const sizeBytes = row[`${prefix}_size_bytes`];
  const checksumSha256 = row[`${prefix}_checksum_sha256`];
  if (
    artifactId === null || artifactId === undefined
    || displayName === null || displayName === undefined
    || mimeType === null || mimeType === undefined
  ) {
    return null;
  }
  return Object.freeze({
    artifactId: boundedText(String(artifactId), `${prefix} artifact id`, 1, 256),
    displayName: boundedText(String(displayName), `${prefix} display name`, 1, 255),
    mimeType: boundedText(String(mimeType), `${prefix} mime type`, 1, 127),
    sizeBytes: nullableSafeInteger(sizeBytes, `${prefix} size`, 0),
    checksumSha256: checksumSha256 === null || checksumSha256 === undefined
      ? null
      : typeof checksumSha256 === "string" && /^[0-9a-f]{64}$/.test(checksumSha256)
        ? checksumSha256
        : (() => {
          throw new Error(`Invalid ${prefix} checksum returned by database`);
        })(),
  });
}

function parseJobSummaryRow(row: Record<string, unknown>): JobSummary {
  const progressPercent = safeInteger(row.progress_percent, "job progress", 0, 100);
  const projectName = boundedText(row.project_name, "project name", 1, 160);
  const summary: JobSummary = Object.freeze({
    id: boundedText(row.id, "job id", 1, 256),
    projectName,
    // Optional expansion columns: emitted only when the query selected them, so
    // narrower selects (queue inserts, legacy rows) keep parsing unchanged.
    ...(row.project_id !== undefined
      ? { projectId: nullableText(row.project_id, "job project id", 1, 256) }
      : {}),
    ...("worker_id" in row
      ? {
        workerSummary: row.worker_id === null || row.worker_id === undefined
          ? null
          : Object.freeze({
            id: boundedText(String(row.worker_id), "worker id", 1, 256),
            state: parseWorkerState(row.worker_state),
            accountLabel: nullableText(row.worker_account_label, "worker account label", 1, 80),
          }),
      }
      : {}),
    ...("output_artifact_id" in row
      ? {
        outputMetadata: row.output_artifact_id === null || row.output_artifact_id === undefined
          ? null
          : Object.freeze({
            artifactId: boundedText(row.output_artifact_id, "output artifact id", 1, 256),
            sizeBytes: nullableSafeInteger(row.output_size_bytes, "output artifact size", 0, 1_099_511_627_776),
          }),
      }
      : {}),
    state: parseJobState(row.state),
    progressPercent,
    updatedAt: asIso(row.updated_at, "job update timestamp"),
    settingsSnapshot: parseSettingsSnapshot(row.settings_snapshot),
    sourceMetadata: sourceMetadataFromValue(row.source_metadata),
    activePhase: nullableText(row.active_phase, "job active phase", 1, 80),
    phaseProgressPercent: nullableSafeInteger(
      row.phase_progress_percent,
      "job phase progress",
      0,
      100,
    ),
    latestMessage: nullableText(row.latest_message, "job latest message", 1, 500),
    etaSeconds: nullableSafeInteger(row.eta_seconds, "job ETA", 0, 31_536_000),
    startedAt: nullableIso(row.started_at, "job start timestamp"),
    completedAt: nullableIso(row.completed_at, "job completion timestamp"),
    cancelRequestedAt: nullableIso(row.cancel_requested_at, "job cancellation timestamp"),
    errorCode: (() => {
      const code = nullableText(row.error_code, "job error code", 1, 80);
      if (code === null || /^[A-Z][A-Z0-9_]{0,79}$/.test(code)) return code;
      throw new Error("Invalid job error code returned by database");
    })(),
    errorMessage: nullableErrorMessage(row.error_message),
  });
  return summary;
}

function parseProgressHistory(value: unknown): readonly JobProgressEvent[] {
  const parsed = parseJson(value, "job progress history");
  if (parsed === null) return Object.freeze([]);
  if (!Array.isArray(parsed)) {
    throw new Error("Invalid job progress history returned by database");
  }
  return Object.freeze(parsed.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("Invalid job progress history returned by database");
    }
    const event = entry as Record<string, unknown>;
    return Object.freeze({
      id: boundedText(event.id, "job progress event id", 1, 80),
      phase: boundedText(event.phase, "job progress phase", 1, 80),
      progressPercent: safeInteger(event.progressPercent, "job progress history", 0, 100),
      message: nullableText(event.message, "job progress message", 1, 500),
      recordedAt: asIso(event.recordedAt, "job progress timestamp"),
    });
  }));
}

function parseAttemptOutcome(value: unknown): JobDetailReadModel["attemptSummary"]["latestOutcome"] {
  if (value === null || value === undefined) return null;
  if (value === "COMPLETED" || value === "FAILED" || value === "LEASE_LOST" || value === "CANCELLED") {
    return value;
  }
  throw new Error("Invalid job attempt outcome returned by database");
}

function parseJobDetailRow(row: Record<string, unknown>): JobDetailReadModel {
  const summary = parseJobSummaryRow(row);
  const createdAt = row.created_at === null || row.created_at === undefined
    ? summary.updatedAt
    : asIso(row.created_at, "job creation timestamp");
  const sourceMetadata = summary.sourceMetadata ?? sourceMetadataFromColumns(row, "source");
  const outputMetadata = sourceMetadataFromColumns(row, "output");
  const telemetry: JobPhaseTelemetry = Object.freeze({
    activePhase: summary.activePhase ?? null,
    phaseProgressPercent: summary.phaseProgressPercent ?? null,
    latestMessage: summary.latestMessage ?? null,
    etaSeconds: summary.etaSeconds ?? null,
    startedAt: summary.startedAt ?? null,
    completedAt: summary.completedAt ?? null,
    cancelRequestedAt: summary.cancelRequestedAt ?? null,
    errorCode: summary.errorCode ?? null,
    errorMessage: summary.errorMessage ?? null,
  });
  const workerId = row.worker_id;
  const workerSummary = workerId === null || workerId === undefined
    ? null
    : Object.freeze({
      id: boundedText(String(workerId), "worker id", 1, 256),
      state: parseWorkerState(row.worker_state),
      accountLabel: nullableText(row.worker_account_label, "worker account label", 1, 80),
    });
  const attemptCount = safeInteger(row.attempt_count ?? 0, "job attempt count", 0);
  const activeAttemptCount = safeInteger(row.active_attempt_count ?? 0, "active job attempt count", 0);
  const attemptSummary = Object.freeze({
    count: attemptCount,
    activeCount: activeAttemptCount,
    latestStartedAt: nullableIso(row.latest_attempt_started_at, "latest job attempt start timestamp"),
    latestEndedAt: nullableIso(row.latest_attempt_ended_at, "latest job attempt end timestamp"),
    latestOutcome: parseAttemptOutcome(row.latest_attempt_outcome),
  });
  const detail: JobDetail = Object.freeze({
    ...summary,
    settingsSnapshot: summary.settingsSnapshot ?? null,
    sourceMetadata,
    telemetry,
    progressHistory: parseProgressHistory(row.progress_history),
  });
  return Object.freeze({
    ...detail,
    createdAt,
    outputMetadata,
    workerSummary,
    attemptSummary,
    canCancel: isCancelableJobState(detail.state),
    canRetry: detail.state === "FAILED_RETRYABLE",
  });
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
        `select j.id,j.project_id,j.project_name,j.state,j.progress_percent,j.updated_at,
                j.settings_snapshot,j.source_metadata,j.active_phase,j.phase_progress_percent,
                j.latest_message,j.eta_seconds,j.started_at,j.completed_at,j.cancel_requested_at,
                j.error_code,j.error_message,
                out.id as output_artifact_id,
                out.actual_size_bytes as output_size_bytes,
                lease.worker_id,
                worker.state as worker_state,
                worker.account_label as worker_account_label
         from jobs j
         left join lateral (
           select a.id,a.actual_size_bytes
           from artifacts a
           where a.job_id=j.id and a.kind='OUTPUT' and a.status='READY'
           order by a.created_at desc,a.id desc
           limit 1
         ) out on true
         left join job_leases lease on lease.job_id=j.id
         left join workers worker on worker.id=lease.worker_id
         where j.state <> $1
         order by j.updated_at desc,j.id desc
         limit 100`,
        ["DELETED"],
      );
      return Object.freeze(result.rows.map(parseJobSummaryRow));
    },

    async getJobDetail(jobId: string): Promise<JobDetailReadModel | null> {
      const result = await sql.query(
        `select j.id,j.project_name,j.state,j.progress_percent,j.created_at,j.updated_at,
                j.settings_snapshot,j.source_metadata,j.active_phase,j.phase_progress_percent,
                j.latest_message,j.eta_seconds,j.started_at,j.completed_at,
                j.cancel_requested_at,j.error_code,j.error_message,
                src.id as source_artifact_id,
                src.display_name as source_display_name,
                src.mime_type as source_mime_type,
                src.actual_size_bytes as source_size_bytes,
                src.checksum_sha256 as source_checksum_sha256,
                out.id as output_artifact_id,
                out.display_name as output_display_name,
                out.mime_type as output_mime_type,
                out.actual_size_bytes as output_size_bytes,
                out.checksum_sha256 as output_checksum_sha256,
                lease.worker_id,
                worker.state as worker_state,
                worker.account_label as worker_account_label,
                attempts.attempt_count,
                attempts.active_attempt_count,
                attempts.latest_attempt_started_at,
                attempts.latest_attempt_ended_at,
                attempts.latest_attempt_outcome,
                coalesce(history.progress_history,'[]'::jsonb) as progress_history
         from jobs j
         left join lateral (
           select a.id,a.display_name,a.mime_type,a.actual_size_bytes,a.checksum_sha256
           from artifacts a
           where a.project_id=j.project_id and a.kind='SOURCE' and a.status <> 'DELETED'
           order by a.created_at desc,a.id desc
           limit 1
         ) src on true
         left join lateral (
           select a.id,a.display_name,a.mime_type,a.actual_size_bytes,a.checksum_sha256
           from artifacts a
           where a.job_id=j.id and a.kind='OUTPUT' and a.status <> 'DELETED'
           order by a.created_at desc,a.id desc
           limit 1
         ) out on true
         left join job_leases lease on lease.job_id=j.id
         left join workers worker on worker.id=lease.worker_id
         left join lateral (
           select count(*)::bigint as attempt_count,
                  count(*) filter (where a.ended_at is null)::bigint as active_attempt_count,
                  max(a.started_at) as latest_attempt_started_at,
                  max(a.ended_at) as latest_attempt_ended_at,
                  (array_agg(a.outcome order by coalesce(a.ended_at,a.started_at) desc nulls last))[1]
                    as latest_attempt_outcome
           from job_attempts a
           where a.job_id=j.id
         ) attempts on true
         left join lateral (
           select jsonb_agg(
                    jsonb_build_object(
                      'id',h.id::text,
                      'phase',h.phase,
                      'progressPercent',h.progress_percent,
                      'message',h.message,
                      'recordedAt',h.recorded_at
                    )
                    order by h.recorded_at desc,h.id desc
                  ) as progress_history
           from (
             select id,phase,progress_percent,message,recorded_at
             from job_progress_history
             where job_id=j.id
             order by recorded_at desc,id desc
             limit 100
           ) h
         ) history on true
         where j.id=$1`,
        [jobId],
      );
      const row = result.rows[0];
      return row ? parseJobDetailRow(row) : null;
    },

    async requestJobCancellation(jobId: string, now: Date): Promise<JobCancellationOutcome> {
      const existing = await sql.query(
        "select state from jobs where id=$1",
        [jobId],
      );
      const existingState = existing.rows[0]?.state;
      if (existingState === undefined) return "NOT_FOUND";
      const state = parseJobState(existingState);
      if (isTerminalJobState(state)) return "ALREADY_TERMINAL";
      if (!isCancelableJobState(state)) return "NOT_CANCELABLE";

      if (state === "QUEUED") {
        // A QUEUED job has no live lease, so no worker could ever finalize a
        // CANCEL_REQUESTED transition — cancel it terminally right here.
        const finalized = await sql.query(
          `with finalized as (
             update jobs
             set state='CANCELLED',
                 cancel_requested_at=coalesce(cancel_requested_at,$2),
                 completed_at=coalesce(completed_at,$2),
                 updated_at=$2
             where id=$1 and state='QUEUED'
             returning id
           ), attempts_closed as (
             update job_attempts a set ended_at=$2,outcome='CANCELLED'
             from finalized f where a.job_id=f.id and a.ended_at is null
             returning a.id
           )
           select id from finalized`,
          [jobId, now.toISOString()],
        );
        if (finalized.rows.length > 0) return "REQUESTED";
      } else {
        const updated = await sql.query(
          `update jobs
           set state='CANCEL_REQUESTED',
               cancel_requested_at=coalesce(cancel_requested_at,$2),
               updated_at=$2
           where id=$1 and state=$3
           returning id`,
          [jobId, now.toISOString(), state],
        );
        if (updated.rows.length > 0) return "REQUESTED";
      }

      const raced = await sql.query(
        "select state from jobs where id=$1",
        [jobId],
      );
      const racedState = raced.rows[0]?.state;
      if (racedState === undefined) return "NOT_FOUND";
      const parsedRacedState = parseJobState(racedState);
      return isTerminalJobState(parsedRacedState) ? "ALREADY_TERMINAL" : "NOT_CANCELABLE";
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
