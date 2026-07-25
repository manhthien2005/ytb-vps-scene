import {
  assertJobTransition,
  JOB_STATES,
  WORKER_STATES,
  type JobSourceMetadata,
  type JobState,
  type JobSummary,
  type WorkerState,
} from "@/lib/domain/control-plane";
import { parseSceneSettings } from "@/lib/domain/scene-settings";
import { parseMediaExecutionDescriptor, parseWorkerCapabilities, parseWorkerDoctorReport, type WorkerView } from "@/lib/domain/worker";
import { createSql } from "@/lib/db/client";
import type {
  EnrollmentReservation,
  JobAssignment,
  JobProgress,
  QueueProjectJob,
  RenewLease,
  WorkerLease,
  WorkerControlPlaneRepository,
  WorkerEnrollment,
  WorkerEnrollmentResult,
  WorkerHeartbeat,
} from "./worker-control-plane";
import { outputPartFileName } from "@/lib/domain/output-part";

export type WorkerControlPlaneSqlClient = Readonly<{
  query: (text: string, parameters?: unknown[]) => Promise<Readonly<{ rows: Record<string, unknown>[] }>>;
}>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function asIso(value: unknown, label: string): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.valueOf())) throw new Error(`Invalid ${label} returned by database`);
  return date.toISOString();
}

function asJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Invalid ${label} returned by database`);
  }
}

function parseWorkerState(value: unknown): WorkerState {
  if (typeof value !== "string" || !WORKER_STATES.some((state) => state === value)) {
    throw new Error("Invalid worker state returned by database");
  }
  return value as WorkerState;
}

function parseJobState(value: unknown): JobState {
  if (typeof value !== "string" || !JOB_STATES.some((state) => state === value)) {
    throw new Error("Invalid job state returned by database");
  }
  return value as JobState;
}

function parseNullableBoundedString(value: unknown, label: string, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.trim() !== value || value.length < 1 || value.length > maxLength
      || value.includes("\n") || value.includes("\r")) {
    throw new Error(`Invalid ${label} returned by database`);
  }
  return value;
}

function parseJobSourceMetadata(value: unknown): JobSourceMetadata {
  const parsed = asJson(value, "job source metadata");
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid job source metadata returned by database");
  }
  const record = parsed as Record<string, unknown>;
  const artifactId = record.artifactId === null || record.artifactId === undefined
    ? null
    : String(record.artifactId);
  if (artifactId !== null && !UUID_PATTERN.test(artifactId)) {
    throw new Error("Invalid job source artifact id returned by database");
  }
  const displayName = parseNullableBoundedString(record.displayName, "job source display name", 255);
  const mimeType = parseNullableBoundedString(record.mimeType, "job source mime type", 127);
  const sizeBytes = record.sizeBytes === null || record.sizeBytes === undefined ? null : Number(record.sizeBytes);
  if (sizeBytes !== null && (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0)) {
    throw new Error("Invalid job source size returned by database");
  }
  const checksumSha256 = record.checksumSha256 === null || record.checksumSha256 === undefined
    ? null
    : String(record.checksumSha256);
  if (checksumSha256 !== null && !/^[0-9a-f]{64}$/.test(checksumSha256)) {
    throw new Error("Invalid job source checksum returned by database");
  }
  return Object.freeze({ artifactId, displayName, mimeType, sizeBytes, checksumSha256 });
}

function validateOptionalTelemetry(input: JobProgress): void {
  const validateString = (value: string | null | undefined, label: string, maxLength: number): void => {
    if (value === undefined || value === null) return;
    if (value.trim() !== value || value.length < 1 || value.length > maxLength
        || value.includes("\n") || value.includes("\r")) {
      throw new Error(`Invalid ${label}`);
    }
  };
  const validatePercent = (value: number | null | undefined, label: string): void => {
    if (value === undefined || value === null) return;
    if (!Number.isSafeInteger(value) || value < 0 || value > 100) throw new Error(`Invalid ${label}`);
  };
  const validateSeconds = (value: number | null | undefined, label: string, max = 31_536_000): void => {
    if (value === undefined || value === null) return;
    if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(`Invalid ${label}`);
  };
  const validatePart = (value: number | null | undefined, label: string): void => {
    if (value === undefined || value === null) return;
    if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) throw new Error(`Invalid ${label}`);
  };

  validateString(input.phase, "phase", 80);
  validatePercent(input.phaseProgressPercent, "phase progress");
  validateString(input.message, "progress message", 500);
  if (input.message !== undefined && input.message !== null
      && /(access[_ -]?token|refresh[_ -]?token|authorization|cookie|stack[_ -]?trace|traceback|worker[_ -]?secret|session[_ -]?secret|raw[_ -]?log|bearer\s+\S+)/i.test(input.message)) {
    throw new Error("Invalid progress message");
  }
  validateSeconds(input.etaSeconds, "ETA");
  validateSeconds(input.processedSeconds, "processed seconds");
  validateSeconds(input.totalSeconds, "total seconds");
  validatePart(input.currentPart, "current part");
  validatePart(input.totalParts, "total parts");
  if (input.errorCode !== undefined && input.errorCode !== null
      && !/^[A-Z][A-Z0-9_]{0,79}$/.test(input.errorCode)) {
    throw new Error("Invalid error code");
  }
}

function parseWorkerRow(row: Record<string, unknown>): WorkerView {
  const id = String(row.id);
  if (!UUID_PATTERN.test(id)) throw new Error("Invalid worker id returned by database");
  const accountLabel = row.account_label === null || row.account_label === undefined
    ? null
    : String(row.account_label);
  if (accountLabel !== null && (accountLabel.length < 1 || accountLabel.length > 80)) {
    throw new Error("Invalid worker account label returned by database");
  }
  return Object.freeze({
    id,
    state: parseWorkerState(row.state),
    accountLabel,
    capabilities: parseWorkerCapabilities(asJson(row.capabilities, "worker capabilities")),
    doctor: parseWorkerDoctorReport(asJson(row.doctor_report, "worker doctor report")),
    lastHeartbeatAt: asIso(row.heartbeat_at, "worker heartbeat"),
    sessionExpiresAt: asIso(row.session_expires_at, "worker session expiry"),
  });
}

function parseJobRow(row: Record<string, unknown>): JobSummary {
  const progressPercent = Number(row.progress_percent);
  if (!Number.isSafeInteger(progressPercent) || progressPercent < 0 || progressPercent > 100) {
    throw new Error("Invalid job progress returned by database");
  }
  const projectName = String(row.project_name);
  if (projectName.length < 1 || projectName.length > 160) {
    throw new Error("Invalid project name returned by database");
  }
  const summary: {
    id: string;
    projectName: string;
    state: JobState;
    progressPercent: number;
    updatedAt: string;
    [key: string]: unknown;
  } = {
    id: String(row.id),
    projectName,
    state: parseJobState(row.state),
    progressPercent,
    updatedAt: asIso(row.updated_at, "job update timestamp"),
  };
  if ("settings_snapshot" in row) {
    summary.settingsSnapshot = row.settings_snapshot === null || row.settings_snapshot === undefined
      ? null
      : parseSceneSettings(asJson(row.settings_snapshot, "job settings snapshot"));
  }
  if ("source_metadata" in row) {
    summary.sourceMetadata = row.source_metadata === null || row.source_metadata === undefined
      ? null
      : parseJobSourceMetadata(row.source_metadata);
  }
  if ("active_phase" in row) summary.activePhase = parseNullableBoundedString(row.active_phase, "job active phase", 80);
  if ("phase_progress_percent" in row) {
    const value = row.phase_progress_percent === null || row.phase_progress_percent === undefined
      ? null
      : Number(row.phase_progress_percent);
    if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > 100)) {
      throw new Error("Invalid job phase progress returned by database");
    }
    summary.phaseProgressPercent = value;
  }
  if ("latest_message" in row) summary.latestMessage = parseNullableBoundedString(row.latest_message, "job latest message", 500);
  if ("eta_seconds" in row) {
    const value = row.eta_seconds === null || row.eta_seconds === undefined ? null : Number(row.eta_seconds);
    if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > 31_536_000)) {
      throw new Error("Invalid job ETA returned by database");
    }
    summary.etaSeconds = value;
  }
  if ("started_at" in row) summary.startedAt = row.started_at === null || row.started_at === undefined ? null : asIso(row.started_at, "job start timestamp");
  if ("completed_at" in row) summary.completedAt = row.completed_at === null || row.completed_at === undefined ? null : asIso(row.completed_at, "job completion timestamp");
  if ("cancel_requested_at" in row) {
    summary.cancelRequestedAt = row.cancel_requested_at === null || row.cancel_requested_at === undefined
      ? null
      : asIso(row.cancel_requested_at, "job cancellation timestamp");
  }
  if ("error_code" in row) {
    const errorCode = parseNullableBoundedString(row.error_code, "job error code", 80);
    summary.errorCode = errorCode;
    if (errorCode !== null && !/^[A-Z][A-Z0-9_]{0,79}$/.test(errorCode)) {
      throw new Error("Invalid job error code returned by database");
    }
  }
  if ("error_message" in row) summary.errorMessage = parseNullableBoundedString(row.error_message, "job error message", 500);
  return Object.freeze(summary) as JobSummary;
}

function parseLeaseRow(row: Record<string, unknown>): WorkerLease {
  const fencingToken = Number(row.fencing_token);
  if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) {
    throw new Error("Invalid fencing token returned by database");
  }
  return Object.freeze({
    jobId: String(row.job_id),
    workerId: String(row.worker_id),
    fencingToken,
    expiresAt: asIso(row.expires_at, "lease expiry"),
    cancelRequested: row.cancel_requested === true || row.cancel_requested === "t",
  });
}

function parseExecutionRow(row: Record<string, unknown>) {
  return parseMediaExecutionDescriptor({
    projectId: row.project_id,
    source: {
      driveFileId: row.source_drive_file_id,
      fileName: row.source_file_name,
      mimeType: row.source_mime_type,
      sizeBytes: Number(row.source_size_bytes),
      sha256: row.source_sha256,
    },
    outputParentId: row.output_parent_id,
    sceneSettings: asJson(row.scene_settings, "scene settings"),
  });
}

const WORKER_COLUMNS = `id,state,account_label,capabilities,doctor_report,
  heartbeat_at,session_expires_at`;

export function createWorkerControlPlaneRepository(
  sql: WorkerControlPlaneSqlClient,
): WorkerControlPlaneRepository {
  return {
    async createEnrollment(input: EnrollmentReservation): Promise<void> {
      await sql.query(
        `insert into worker_enrollment_tokens(token_digest,expires_at,created_at)
         values ($1,$2,$3)`,
        [input.tokenDigest, input.expiresAt.toISOString(), input.now.toISOString()],
      );
    },

    async enrollWorker(input: WorkerEnrollment): Promise<WorkerEnrollmentResult | null> {
      const result = await sql.query(
        `with consumed as (
           update worker_enrollment_tokens
           set consumed_at=$2
           where token_digest=$1 and consumed_at is null and revoked_at is null and expires_at>$2
           returning token_digest
         ), enrolled as (
           insert into workers(
             id,session_digest,state,account_label,capabilities,doctor_report,
             session_expires_at,heartbeat_at,created_at,updated_at
           )
           select $3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$2,$2,$2 from consumed
           returning ${WORKER_COLUMNS}
         ) select * from enrolled`,
        [
          input.tokenDigest,
          input.now.toISOString(),
          input.workerId,
          input.sessionDigest,
          input.state,
          input.accountLabel,
          JSON.stringify(input.capabilities),
          JSON.stringify(input.doctor),
          input.sessionExpiresAt.toISOString(),
        ],
      );
      const row = result.rows[0];
      return row ? Object.freeze({ outcome: "ENROLLED" as const, worker: parseWorkerRow(row) }) : null;
    },

    async authenticateWorker(sessionDigest: string, now: Date): Promise<WorkerView | null> {
      const result = await sql.query(
        `select ${WORKER_COLUMNS} from workers
         where session_digest=$1 and session_expires_at>$2`,
        [sessionDigest, now.toISOString()],
      );
      return result.rows[0] ? parseWorkerRow(result.rows[0]) : null;
    },

    async heartbeatWorker(input: WorkerHeartbeat): Promise<WorkerView | null> {
      const result = await sql.query(
        `update workers set state=$2,capabilities=$3::jsonb,doctor_report=$4::jsonb,
           heartbeat_at=$5,updated_at=$5
         where id=$1 and revoked_at is null and session_expires_at>$5
         returning ${WORKER_COLUMNS}`,
        [input.workerId, input.state, JSON.stringify(input.capabilities), JSON.stringify(input.doctor), input.now.toISOString()],
      );
      return result.rows[0] ? parseWorkerRow(result.rows[0]) : null;
    },

    async listWorkers(now: Date): Promise<readonly WorkerView[]> {
      void now;
      const result = await sql.query(`select ${WORKER_COLUMNS} from workers order by updated_at desc limit 20`);
      return Object.freeze(result.rows.map(parseWorkerRow));
    },

    async revokeWorker(workerId: string, now: Date): Promise<boolean> {
      const result = await sql.query(
        `update workers set state='REVOKED',revoked_at=coalesce(revoked_at,$2),updated_at=$2
         where id=$1 returning id`,
        [workerId, now.toISOString()],
      );
      return result.rows.length > 0;
    },

    async queueProjectJob(input: QueueProjectJob): Promise<JobSummary | null> {
      const summaryColumns = `id,project_id,project_name,state,progress_percent,updated_at,
        settings_snapshot,source_metadata,active_phase,phase_progress_percent,latest_message,
        eta_seconds,started_at,completed_at,cancel_requested_at,error_code,error_message`;
      const existing = await sql.query(
        `select ${summaryColumns} from jobs where request_key_digest=$1`,
        [input.requestKeyDigest],
      );
      if (existing.rows[0]) {
        try {
          return parseJobRow(existing.rows[0]);
        } catch {
          return null;
        }
      }

      const candidate = await sql.query(
        `select p.name as project_name,
                s.settings as scene_settings,
                a.id as artifact_id,
                a.display_name as source_file_name,
                a.mime_type as source_mime_type,
                a.actual_size_bytes as source_size_bytes,
                a.checksum_sha256 as source_sha256
         from projects p
         join project_scene_settings s on s.project_id=p.id
         join artifacts a on a.project_id=p.id and a.kind='SOURCE' and a.status='READY'
         where p.id=$1 and p.status='READY' and p.source_status='SOURCE_READY'
           and a.actual_size_bytes is not null and a.checksum_sha256 is not null
         limit 1`,
        [input.projectId],
      );
      const candidateRow = candidate.rows[0];
      if (!candidateRow) return null;

      let settingsSnapshot: ReturnType<typeof parseSceneSettings>;
      let sourceMetadata: JobSourceMetadata;
      try {
        settingsSnapshot = parseSceneSettings(asJson(candidateRow.scene_settings, "scene settings"));
        sourceMetadata = parseJobSourceMetadata({
          artifactId: candidateRow.artifact_id,
          displayName: candidateRow.source_file_name,
          mimeType: candidateRow.source_mime_type,
          sizeBytes: Number(candidateRow.source_size_bytes),
          checksumSha256: candidateRow.source_sha256,
        });
      } catch {
        return null;
      }
      if (
        sourceMetadata.artifactId === null
        || sourceMetadata.displayName === null
        || sourceMetadata.mimeType === null
        || sourceMetadata.sizeBytes === null
        || sourceMetadata.checksumSha256 === null
      ) {
        return null;
      }

      const inserted = await sql.query(
        `insert into jobs(
           id,project_id,project_name,state,progress_percent,request_key_digest,
           settings_snapshot,source_metadata,created_at,updated_at
         )
         values ($1,$2,$3,'QUEUED',0,$4,$5::jsonb,$6::jsonb,$7,$7)
         on conflict(request_key_digest) do nothing
         returning ${summaryColumns}`,
        [
          input.jobId,
          input.projectId,
          candidateRow.project_name,
          input.requestKeyDigest,
          JSON.stringify(settingsSnapshot),
          JSON.stringify(sourceMetadata),
          input.now.toISOString(),
        ],
      );
      if (inserted.rows[0]) return parseJobRow(inserted.rows[0]);
      const raced = await sql.query(
        `select ${summaryColumns} from jobs where request_key_digest=$1`,
        [input.requestKeyDigest],
      );
      if (!raced.rows[0]) return null;
      try {
        return parseJobRow(raced.rows[0]);
      } catch {
        return null;
      }
    },

    async claimJob(workerId: string, now: Date, bridgeVersion: string): Promise<JobAssignment | null> {
      const result = await sql.query(
        `with eligible as materialized (
           select id from workers
           where id=$1 and state='READY' and revoked_at is null and session_expires_at>$2
             and capabilities->>'pipelineBridgeVersion'=$3
             and doctor_report->>'status'='PASS'
           for update
         ), candidate as materialized (
           select j.id
           from jobs j
           left join job_leases current_lease on current_lease.job_id=j.id
           left join project_scene_settings current_settings on current_settings.project_id=j.project_id
           where exists(select 1 from eligible)
             and not exists(select 1 from job_leases active_lease where active_lease.expires_at>$2)
             and (j.settings_snapshot is not null or current_settings.project_id is not null)
             and (
               j.state='QUEUED'
               or (current_lease.expires_at<=$2 and j.state in (
                 'CLAIMED','DOWNLOADING','OCR','TRANSLATE','TTS','RENDER','UPLOADING'
               ))
             )
           order by j.created_at asc
           for update of j skip locked
           limit 1
         ), leased as (
           insert into job_leases(job_id,worker_id,fencing_token,expires_at,created_at,updated_at)
           select id,$1,1,$2::timestamptz + interval '90 seconds',$2,$2 from candidate
           on conflict(job_id) do update set
             worker_id=excluded.worker_id,
             fencing_token=job_leases.fencing_token+1,
             expires_at=excluded.expires_at,
             updated_at=excluded.updated_at
           where job_leases.expires_at<=$2
           returning job_id,worker_id,fencing_token,expires_at
         ), closed as (
           update job_attempts a set ended_at=$2,outcome='LEASE_LOST'
           from leased l
           where a.job_id=l.job_id and a.ended_at is null and a.fencing_token<l.fencing_token
           returning a.id
        ), updated_job as (
           update jobs j set state='CLAIMED',active_stage='CLAIMED',progress_percent=0,
             active_phase='CLAIMED',
             phase_progress_percent=0,
             started_at=coalesce(j.started_at,$2),updated_at=$2
           from leased l where j.id=l.job_id
           returning j.id,j.project_id,j.project_name,j.state,j.progress_percent,j.updated_at,
             j.settings_snapshot,j.source_metadata,j.active_phase,j.phase_progress_percent,
             j.latest_message,j.eta_seconds,j.started_at,j.completed_at,j.cancel_requested_at,
             j.error_code,j.error_message
         ), busy as (
           update workers w set state='BUSY',updated_at=$2
           from leased l where w.id=l.worker_id
           returning w.id
         ), attempt as (
           insert into job_attempts(job_id,worker_id,fencing_token,started_at)
           select l.job_id,l.worker_id,l.fencing_token,$2 from leased l, busy
           returning id
         )
         select j.id,j.project_id,j.project_name,j.state,j.progress_percent,j.updated_at,
                j.settings_snapshot,j.source_metadata,j.active_phase,j.phase_progress_percent,
                j.latest_message,j.eta_seconds,j.started_at,j.completed_at,j.cancel_requested_at,
                j.error_code,j.error_message,
                l.job_id,l.worker_id,l.fencing_token,l.expires_at,
                a.drive_file_id as source_drive_file_id,
                a.display_name as source_file_name,
                a.mime_type as source_mime_type,
                a.actual_size_bytes as source_size_bytes,
                a.checksum_sha256 as source_sha256,
                p.drive_project_folder_id as output_parent_id,
                coalesce(j.settings_snapshot,s.settings) as scene_settings
         from updated_job j
         join leased l on l.job_id=j.id
         join projects p on p.id=j.project_id
         join artifacts a on a.project_id=p.id and a.kind='SOURCE' and a.status='READY'
         left join project_scene_settings s on s.project_id=p.id
         cross join attempt
         where j.settings_snapshot is not null or s.project_id is not null`,
        [workerId, now.toISOString(), bridgeVersion],
      );
      const row = result.rows[0];
      return row ? Object.freeze({
        job: parseJobRow(row),
        lease: parseLeaseRow(row),
        execution: parseExecutionRow(row),
      }) : null;
    },

    async renewLease(input: RenewLease): Promise<WorkerLease | null> {
      const result = await sql.query(
        `update job_leases l set expires_at=$4::timestamptz + interval '90 seconds',updated_at=$4
         from jobs j
         where l.job_id=$1 and l.job_id=j.id and l.worker_id=$2 and l.fencing_token=$3 and l.expires_at>$4
         returning l.job_id,l.worker_id,l.fencing_token,l.expires_at,
           (j.cancel_requested_at is not null or j.state='CANCEL_REQUESTED') as cancel_requested`,
        [input.jobId, input.workerId, input.fencingToken, input.now.toISOString()],
      );
      return result.rows[0] ? parseLeaseRow(result.rows[0]) : null;
    },

    async updateJobProgress(input: JobProgress): Promise<"UPDATED" | "LEASE_LOST"> {
      if (!JOB_STATES.includes(input.fromState) || !JOB_STATES.includes(input.state)) {
        throw new Error("Invalid job state");
      }
      assertJobTransition(input.fromState, input.state);
      if (!Number.isSafeInteger(input.progressPercent) || input.progressPercent < 0 || input.progressPercent > 100) {
        throw new Error("Invalid job progress");
      }
      validateOptionalTelemetry(input);

      const parameters: unknown[] = [
        input.jobId,
        input.workerId,
        input.fencingToken,
        input.fromState,
        input.state,
        input.progressPercent,
        input.now.toISOString(),
      ];
      const assignments = [
        "state=$5",
        "active_stage=$5",
        "progress_percent=$6",
        "updated_at=$7",
        "started_at=coalesce(j.started_at,$7)",
        "completed_at=case when $5 in ('COMPLETED','CANCELLED','FAILED_FINAL') then $7 else j.completed_at end",
      ];
      if (!("phase" in input)) assignments.push("active_phase=$5");
      if (!("phaseProgressPercent" in input)) assignments.push("phase_progress_percent=0");
      const addOptionalAssignment = (column: string, key: keyof JobProgress, cast: string): void => {
        if (!(key in input)) return;
        parameters.push(input[key] ?? null);
        assignments.push(`${column}=$${parameters.length}::${cast}`);
      };
      addOptionalAssignment("active_phase", "phase", "text");
      addOptionalAssignment("phase_progress_percent", "phaseProgressPercent", "integer");
      addOptionalAssignment("latest_message", "message", "text");
      addOptionalAssignment("eta_seconds", "etaSeconds", "integer");
      addOptionalAssignment("error_code", "errorCode", "text");

      const result = await sql.query(
        `with updated as (
           update jobs j set ${assignments.join(",")}
           from job_leases l
           where j.id=$1 and l.job_id=j.id and l.worker_id=$2 and l.fencing_token=$3
             and l.expires_at>$7 and j.state=$4 and j.progress_percent<=$6
           returning j.id,j.active_phase,j.latest_message
         ), history as (
           insert into job_progress_history(job_id,phase,progress_percent,message)
           select id,coalesce(active_phase,$5),$6,latest_message
           from updated
           returning id
         )
         select id from updated`,
        parameters,
      );
      return result.rows.length === 1 ? "UPDATED" : "LEASE_LOST";
    },

    async getFencedExecution(workerId, jobId, fencingToken, now) {
      const result = await sql.query(
        `select p.id as project_id,
                a.drive_file_id as source_drive_file_id,
                a.display_name as source_file_name,
                a.mime_type as source_mime_type,
                a.actual_size_bytes as source_size_bytes,
                a.checksum_sha256 as source_sha256,
                p.drive_project_folder_id as output_parent_id,
                coalesce(j.settings_snapshot,s.settings) as scene_settings
         from job_leases l
         join jobs j on j.id=l.job_id
         join projects p on p.id=j.project_id
         join artifacts a on a.project_id=p.id and a.kind='SOURCE' and a.status='READY'
         left join project_scene_settings s on s.project_id=p.id
         where l.job_id=$1 and l.worker_id=$2 and l.fencing_token=$3 and l.expires_at>$4
           and (j.settings_snapshot is not null or s.project_id is not null)`,
        [jobId, workerId, fencingToken, now.toISOString()],
      );
      return result.rows[0] ? parseExecutionRow(result.rows[0]) : null;
    },

    async reserveOutput(input) {
      const result = await sql.query(
        `with eligible as materialized (
           select j.project_id
           from job_leases l join jobs j on j.id=l.job_id
           where l.job_id=$2 and l.worker_id=$3 and l.fencing_token=$4 and l.expires_at>$9
         ), existing as materialized (
           select id from artifacts
           where job_id=$2 and kind='OUTPUT' and status<>'DELETED'
             and id=$1 and drive_file_id=$5 and drive_parent_id=$6
             and expected_size_bytes=$7 and checksum_sha256=$8
         ), inserted as (
           insert into artifacts(
             id,project_id,job_id,kind,status,drive_file_id,drive_parent_id,
             display_name,mime_type,expected_size_bytes,checksum_sha256,created_at,updated_at
           )
           select $1,e.project_id,$2,'OUTPUT','PENDING',$5,$6,
                  $10,'video/mp4',$7,$8,$9,$9
           from eligible e where not exists(select 1 from existing)
           on conflict do nothing returning id
         )
         select 'REPLAY' as outcome from existing
         union all select 'RESERVED' as outcome from inserted limit 1`,
        [
          input.artifactId,
          input.jobId,
          input.workerId,
          input.fencingToken,
          input.driveFileId,
          input.driveParentId,
          input.sizeBytes,
          input.checksumSha256,
          input.now.toISOString(),
          outputPartFileName(1, 1),
        ],
      );
      const outcome = result.rows[0]?.outcome;
      return outcome === "RESERVED" || outcome === "REPLAY" ? outcome : "LEASE_LOST";
    },

    async completeOutput(input) {
      const replay = await sql.query(
        `select id from artifacts
         where id=$1 and job_id=$2 and kind='OUTPUT' and status='READY'
           and drive_file_id=$3 and actual_size_bytes=$4`,
        [input.artifactId, input.jobId, input.driveFileId, input.sizeBytes],
      );
      if (replay.rows.length === 1) return "REPLAY";
      const result = await sql.query(
        `with eligible as materialized (
           select l.job_id,l.worker_id,l.fencing_token
           from job_leases l
           where l.job_id=$2 and l.worker_id=$3 and l.fencing_token=$4 and l.expires_at>$7
         ), artifact_done as (
           update artifacts a set status='READY',actual_size_bytes=$6,verified_at=$7,updated_at=$7
           from eligible e
           where a.id=$1 and a.job_id=e.job_id and a.kind='OUTPUT' and a.status='PENDING'
             and a.drive_file_id=$5 and a.expected_size_bytes=$6
           returning a.id
         ), job_done as (
           update jobs j set state='COMPLETED',active_stage=null,progress_percent=100,
             completed_at=$7,updated_at=$7
           from eligible e, artifact_done a where j.id=e.job_id returning j.id
         ), worker_ready as (
           update workers w set state='READY',updated_at=$7
           from eligible e, job_done j where w.id=e.worker_id returning w.id
         ), attempt_done as (
           update job_attempts a set ended_at=$7,outcome='COMPLETED'
           from eligible e, job_done j
           where a.job_id=e.job_id and a.worker_id=e.worker_id
             and a.fencing_token=e.fencing_token and a.ended_at is null returning a.id
         ), lease_deleted as (
           delete from job_leases l using eligible e, job_done j
           where l.job_id=e.job_id and l.worker_id=e.worker_id
             and l.fencing_token=e.fencing_token returning l.job_id
         ) select a.id from artifact_done a
           cross join worker_ready w cross join attempt_done t cross join lease_deleted l`,
        [
          input.artifactId,
          input.jobId,
          input.workerId,
          input.fencingToken,
          input.driveFileId,
          input.sizeBytes,
          input.now.toISOString(),
        ],
      );
      return result.rows.length === 1 ? "COMPLETED" : "LEASE_LOST";
    },

    async expireWorkersAndLeases(now: Date): Promise<void> {
      await sql.query(
        `with expired as materialized (
           select job_id,worker_id,fencing_token from job_leases where expires_at<=$1
         ), jobs_reset as (
           update jobs j set state='QUEUED',active_stage=null,updated_at=$1
           from expired e
           where j.id=e.job_id and j.state in (
             'CLAIMED','DOWNLOADING','OCR','TRANSLATE','TTS','RENDER','UPLOADING'
           ) returning j.id
         ), attempts_closed as (
           update job_attempts a set ended_at=$1,outcome='LEASE_LOST'
           from expired e
           where a.job_id=e.job_id and a.fencing_token=e.fencing_token and a.ended_at is null
           returning a.id
         )
         update workers set state='OFFLINE',updated_at=$1
         where state in ('SETTING_UP','READY','BUSY')
           and heartbeat_at<($1::timestamptz - interval '90 seconds')`,
        [now.toISOString()],
      );
    },
  };
}

export function createNeonWorkerControlPlaneRepository(databaseUrl: string): WorkerControlPlaneRepository {
  return createWorkerControlPlaneRepository(createSql(databaseUrl));
}
