import "server-only";

import { randomUUID } from "node:crypto";
import { DRIVE_FILE_SCOPE, type Artifact, type Project } from "@/lib/domain/drive";
import type { UsageSnapshot } from "@/lib/ports/drive";
import { createSql } from "@/lib/db/client";
import type { AuditEvent } from "./control-plane";
import type {
  DriveControlPlaneRepository,
  ProjectReservation,
  ProjectReservationResult,
  SourceReservation,
  StoredConnectedCredential,
  StoredDriveCredential,
} from "./drive-control-plane";

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROJECT_STATUSES = ["PROVISIONING", "READY", "FAILED"] as const;
const SOURCE_STATUSES = ["NO_SOURCE", "UPLOAD_PENDING", "SOURCE_READY", "UPLOAD_FAILED"] as const;
const ARTIFACT_KINDS = ["SOURCE", "CHECKPOINT", "OUTPUT"] as const;
const ARTIFACT_STATUSES = ["PENDING", "UPLOADING", "READY", "INVALID", "DELETED"] as const;
const CREDENTIAL_STATUSES = ["CONNECTED", "REAUTH_REQUIRED", "REVOKE_PENDING", "DISCONNECTED"] as const;
const USAGE_PROVIDERS = ["DRIVE", "NEON"] as const;
const USAGE_MODES = ["READ_WRITE", "READ_ONLY"] as const;

export type DriveControlPlaneSqlClient = Readonly<{
  query: (
    text: string,
    parameters?: unknown[],
  ) => Promise<Readonly<{ rows: Record<string, unknown>[] }>>;
}>;

function fail(kind: string): never {
  throw new Error(`Invalid ${kind} row returned by database`);
}

function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === "string" && values.some((candidate) => candidate === value);
}

function boundedText(value: unknown, minimum: number, maximum: number, trimmed = false): string | null {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) return null;
  if (trimmed && value.trim() !== value) return null;
  return value;
}

function nullableBoundedText(value: unknown, minimum: number, maximum: number): string | null | undefined {
  if (value === null) return null;
  return boundedText(value, minimum, maximum) ?? undefined;
}

function isoDate(value: unknown): string | null {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

function safeInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number | null {
  let numeric: number;
  if (typeof value === "bigint") {
    if (value < BigInt(minimum) || value > BigInt(maximum)) return null;
    numeric = Number(value);
  } else if (typeof value === "number") {
    numeric = value;
  } else if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
    numeric = Number(value);
  } else {
    return null;
  }
  return Number.isSafeInteger(numeric) && numeric >= minimum && numeric <= maximum ? numeric : null;
}

function bytes(value: unknown, expectedLength?: number): Buffer | null {
  let parsed: Buffer;
  if (value instanceof Uint8Array) {
    parsed = Buffer.from(value);
  } else if (typeof value === "string" && /^\\x(?:[0-9a-f]{2})*$/i.test(value)) {
    parsed = Buffer.from(value.slice(2), "hex");
  } else {
    return null;
  }
  return expectedLength === undefined || parsed.length === expectedLength ? parsed : null;
}

function canonicalBase64url(value: unknown, expectedLength?: number, allowEmpty = false): Buffer | null {
  if (
    typeof value !== "string" || (!allowEmpty && value.length === 0) ||
    (value.length > 0 && !/^[A-Za-z0-9_-]+$/.test(value))
  ) return null;
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) return null;
  return expectedLength === undefined || decoded.length === expectedLength ? decoded : null;
}

function parseProject(row: Record<string, unknown>): Project {
  const id = boundedText(row.id, 36, 36);
  const name = boundedText(row.name, 1, 160, true);
  const projectFolder = nullableBoundedText(row.drive_project_folder_id, 10, 256);
  const inputFolder = nullableBoundedText(row.drive_input_folder_id, 10, 256);
  const createdAt = isoDate(row.created_at);
  const updatedAt = isoDate(row.updated_at);
  if (
    !id || !UUID_PATTERN.test(id) || !name ||
    !isOneOf(row.status, PROJECT_STATUSES) || !isOneOf(row.source_status, SOURCE_STATUSES) ||
    projectFolder === undefined || inputFolder === undefined || !createdAt || !updatedAt ||
    (row.status === "READY" && (projectFolder === null || inputFolder === null))
  ) fail("project");
  return {
    id,
    status: row.status,
    name,
    sourceStatus: row.source_status,
    driveProjectFolderId: projectFolder,
    driveInputFolderId: inputFolder,
    createdAt,
    updatedAt,
  };
}

function parseArtifact(row: Record<string, unknown>): Artifact {
  const id = boundedText(row.id, 36, 36);
  const projectId = boundedText(row.project_id, 36, 36);
  const driveFileId = boundedText(row.drive_file_id, 10, 256);
  const driveParentId = boundedText(row.drive_parent_id, 10, 256);
  const displayName = boundedText(row.display_name, 1, 255, true);
  const mimeType = boundedText(row.mime_type, 1, 127, true);
  const expected = safeInteger(row.expected_size_bytes, 1, 1_099_511_627_776);
  const actual = row.actual_size_bytes === null ? null : safeInteger(row.actual_size_bytes);
  const createdAt = isoDate(row.created_at);
  const updatedAt = isoDate(row.updated_at);
  const verifiedAt = row.verified_at === null ? null : isoDate(row.verified_at);
  if (
    !id || !UUID_PATTERN.test(id) || !projectId || !UUID_PATTERN.test(projectId) ||
    !isOneOf(row.kind, ARTIFACT_KINDS) || !isOneOf(row.status, ARTIFACT_STATUSES) ||
    !driveFileId || !driveParentId || !displayName || !mimeType || expected === null ||
    (row.actual_size_bytes !== null && actual === null) || !createdAt || !updatedAt ||
    (row.verified_at !== null && verifiedAt === null) ||
    !(row.checksum_sha256 === null || (typeof row.checksum_sha256 === "string" && HASH_PATTERN.test(row.checksum_sha256)))
  ) fail("artifact");
  return {
    id,
    projectId,
    kind: row.kind,
    status: row.status,
    driveFileId,
    driveParentId,
    displayName,
    mimeType,
    expectedSizeBytes: expected,
    actualSizeBytes: actual,
  };
}

function parseCredential(row: Record<string, unknown>): StoredDriveCredential {
  if (!isOneOf(row.status, CREDENTIAL_STATUSES)) fail("credential");
  const accountHash = row.account_permission_id_hash === null
    ? null
    : typeof row.account_permission_id_hash === "string" && HASH_PATTERN.test(row.account_permission_id_hash)
      ? row.account_permission_id_hash
      : fail("credential");
  const accountHint = nullableBoundedText(row.account_hint, 1, 255);
  const rootFolderId = nullableBoundedText(row.root_folder_id, 10, 256);
  if (
    accountHint === undefined || rootFolderId === undefined ||
    (accountHint !== null && !accountHint.includes("*"))
  ) fail("credential");

  if (row.status === "REAUTH_REQUIRED" || row.status === "DISCONNECTED") {
    if (
      row.ciphertext !== null || row.nonce !== null || row.auth_tag !== null ||
      row.key_version !== null || row.scope !== null
    ) fail("credential");
    return {
      status: row.status,
      envelope: null,
      accountPermissionIdHash: accountHash,
      accountHint,
      rootFolderId,
    };
  }

  const ciphertext = bytes(row.ciphertext);
  const nonce = bytes(row.nonce, 12);
  const authTag = bytes(row.auth_tag, 16);
  if (
    !ciphertext || ciphertext.length > 4096 || !nonce || !authTag || row.key_version !== 1 ||
    row.scope !== DRIVE_FILE_SCOPE || accountHash === null || accountHint === null || rootFolderId === null
  ) fail("credential");
  return {
    status: row.status,
    envelope: {
      ciphertext: ciphertext.toString("base64url"),
      nonce: nonce.toString("base64url"),
      authTag: authTag.toString("base64url"),
      keyVersion: 1,
      scope: DRIVE_FILE_SCOPE,
    },
    accountPermissionIdHash: accountHash,
    accountHint,
    rootFolderId,
  };
}

function parseUsage(row: Record<string, unknown>): UsageSnapshot {
  const usedBytes = safeInteger(row.used_bytes);
  const limitBytes = safeInteger(row.limit_bytes, 1);
  const appManagedBytes = safeInteger(row.app_managed_bytes);
  const observedAt = isoDate(row.observed_at);
  const reasonCodes = row.reason_codes;
  if (
    !isOneOf(row.provider, USAGE_PROVIDERS) || !isOneOf(row.mode, USAGE_MODES) ||
    usedBytes === null || limitBytes === null || appManagedBytes === null || !observedAt ||
    !Array.isArray(reasonCodes) || reasonCodes.some((reason) => (
      typeof reason !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/.test(reason)
    ))
  ) fail("usage");
  return {
    provider: row.provider,
    usedBytes,
    limitBytes,
    appManagedBytes,
    mode: row.mode,
    reasonCodes: [...reasonCodes],
    observedAt,
  };
}

function artifactColumns(): string {
  return `id,project_id,kind,status,drive_file_id,drive_parent_id,display_name,mime_type,
    expected_size_bytes,actual_size_bytes,checksum_sha256,created_at,updated_at,verified_at`;
}

function projectColumns(): string {
  return `id,status,name,source_status,drive_project_folder_id,drive_input_folder_id,created_at,updated_at`;
}

function validDate(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Invalid date");
  return value.toISOString();
}

export function createDriveControlPlaneRepository(sql: DriveControlPlaneSqlClient): DriveControlPlaneRepository {
  return {
    async saveOAuthNonce(hash, expiresAt) {
      if (!HASH_PATTERN.test(hash)) throw new Error("Invalid OAuth nonce hash");
      await sql.query(
        `with pruned as (
           delete from oauth_states where consumed_at is not null or expires_at <= now() returning nonce_hash
         )
         insert into oauth_states(nonce_hash,expires_at) values ($1,$2)`,
        [hash, validDate(expiresAt)],
      );
    },

    async consumeOAuthNonce(hash, now) {
      if (!HASH_PATTERN.test(hash)) return false;
      const result = await sql.query(
        `with consumed as (
           delete from oauth_states
           where nonce_hash = $1 and consumed_at is null and expires_at > $2
           returning nonce_hash
         ), pruned as (
           delete from oauth_states where consumed_at is not null or expires_at <= $2 returning nonce_hash
         )
         select exists(select 1 from consumed) as consumed`,
        [hash, validDate(now)],
      );
      return result.rows[0]?.consumed === true;
    },

    async getCredential() {
      const result = await sql.query(
        `select status,ciphertext,nonce,auth_tag,key_version,scope,account_hint,
                account_permission_id_hash,root_folder_id
         from oauth_credentials where id = 1`,
      );
      return result.rows.length === 0 ? null : parseCredential(result.rows[0]!);
    },

    async saveConnectedCredential(value: StoredConnectedCredential) {
      const ciphertext = canonicalBase64url(value.envelope.ciphertext, undefined, true);
      const nonce = canonicalBase64url(value.envelope.nonce, 12);
      const authTag = canonicalBase64url(value.envelope.authTag, 16);
      if (
        !ciphertext || ciphertext.length > 4096 || !nonce || !authTag ||
        value.envelope.keyVersion !== 1 || value.envelope.scope !== DRIVE_FILE_SCOPE ||
        !HASH_PATTERN.test(value.accountPermissionIdHash) ||
        !boundedText(value.accountHint, 1, 255) || !value.accountHint.includes("*") ||
        !boundedText(value.rootFolderId, 10, 256)
      ) throw new Error("Invalid encrypted credential");
      await sql.query(
        `insert into oauth_credentials(
           id,status,ciphertext,nonce,auth_tag,key_version,scope,account_hint,
           account_permission_id_hash,root_folder_id,last_verified_at
         ) values (1,'CONNECTED',$1,$2,$3,$4,$5,$6,$7,$8,now())
         on conflict(id) do update set
           status='CONNECTED',ciphertext=excluded.ciphertext,nonce=excluded.nonce,
           auth_tag=excluded.auth_tag,key_version=excluded.key_version,scope=excluded.scope,
           account_hint=excluded.account_hint,
           account_permission_id_hash=excluded.account_permission_id_hash,
           root_folder_id=excluded.root_folder_id,last_verified_at=excluded.last_verified_at,
           updated_at=now()`,
        [
          ciphertext, nonce, authTag, value.envelope.keyVersion, value.envelope.scope,
          value.accountHint, value.accountPermissionIdHash, value.rootFolderId,
        ],
      );
    },

    async setCredentialStatus(status) {
      if (status === "REVOKE_PENDING") {
        const result = await sql.query(
          `update oauth_credentials set status='REVOKE_PENDING',updated_at=now()
           where id=1 and status in ('CONNECTED','REVOKE_PENDING') returning id`,
        );
        if (result.rows.length === 0) throw new Error("Credential unavailable");
        return;
      }
      await sql.query(
        `insert into oauth_credentials(id,status) values (1,$1)
         on conflict(id) do update set
           status=excluded.status,ciphertext=null,nonce=null,auth_tag=null,key_version=null,
           scope=null,updated_at=now()`,
        [status],
      );
    },

    async hasDriveContent() {
      const result = await sql.query(
        `select exists(select 1 from projects) or exists(select 1 from artifacts) as has_content`,
      );
      return result.rows[0]?.has_content === true;
    },

    async reserveProject(input: ProjectReservation): Promise<ProjectReservationResult> {
      const id = randomUUID();
      const inserted = await sql.query(
        `insert into projects(
           id,status,name,source_status,creation_idempotency_key_hash,creation_request_hash
         ) values ($1,'PROVISIONING',$2,'NO_SOURCE',$3,$4)
         on conflict(creation_idempotency_key_hash) do nothing
         returning ${projectColumns()}`,
        [id, input.name, input.idempotencyKeyHash, input.requestHash],
      );
      if (inserted.rows[0]) return { outcome: "CREATED", project: parseProject(inserted.rows[0]) };

      const existing = await sql.query(
        `select ${projectColumns()},creation_request_hash
         from projects where creation_idempotency_key_hash=$1`,
        [input.idempotencyKeyHash],
      );
      const row = existing.rows[0];
      if (!row) throw new Error("Project reservation unavailable");
      if (row.creation_request_hash !== input.requestHash) return { outcome: "CONFLICT" };
      const project = parseProject(row);
      return { outcome: project.status === "PROVISIONING" ? "RESUME" : "EXISTING", project };
    },

    async getProject(projectId) {
      const result = await sql.query(
        `select ${projectColumns()} from projects where id=$1`,
        [projectId],
      );
      return result.rows.length === 0 ? null : parseProject(result.rows[0]!);
    },

    async markProjectFailed(projectId) {
      await sql.query(
        `update projects set status='FAILED',updated_at=now()
         where id=$1 and status='PROVISIONING'`,
        [projectId],
      );
    },

    async completeProjectFolders(projectId, projectFolderId, inputFolderId) {
      const result = await sql.query(
        `update projects set
           status='READY',drive_project_folder_id=$2,drive_input_folder_id=$3,updated_at=now()
         where id=$1 and (
           status='PROVISIONING'
           or (status='READY' and drive_project_folder_id=$2 and drive_input_folder_id=$3)
         )
         returning ${projectColumns()}`,
        [projectId, projectFolderId, inputFolderId],
      );
      if (!result.rows[0]) throw new Error("Project cannot be completed");
      return parseProject(result.rows[0]);
    },

    async listProjects() {
      const result = await sql.query(`select ${projectColumns()} from projects order by created_at desc,id desc`);
      return result.rows.map(parseProject);
    },

    async reserveSourceArtifact(input: SourceReservation) {
      const reserved = await sql.query(
        `with reserved as (
           insert into artifacts(
             id,project_id,kind,status,drive_file_id,drive_parent_id,display_name,mime_type,expected_size_bytes
           )
           select $1,$2,'SOURCE','PENDING',$3,$4,$5,$6,$7
           from projects where id=$2 and status='READY'
           on conflict(id) do update set
             status=case when artifacts.status in ('INVALID','DELETED') then 'PENDING' else artifacts.status end,
             drive_file_id=case when artifacts.status in ('INVALID','DELETED') then excluded.drive_file_id else artifacts.drive_file_id end,
             drive_parent_id=case when artifacts.status in ('INVALID','DELETED') then excluded.drive_parent_id else artifacts.drive_parent_id end,
             display_name=case when artifacts.status in ('INVALID','DELETED') then excluded.display_name else artifacts.display_name end,
             mime_type=case when artifacts.status in ('INVALID','DELETED') then excluded.mime_type else artifacts.mime_type end,
             expected_size_bytes=case when artifacts.status in ('INVALID','DELETED') then excluded.expected_size_bytes else artifacts.expected_size_bytes end,
             actual_size_bytes=case when artifacts.status in ('INVALID','DELETED') then null else artifacts.actual_size_bytes end,
             checksum_sha256=case when artifacts.status in ('INVALID','DELETED') then null else artifacts.checksum_sha256 end,
             verified_at=case when artifacts.status in ('INVALID','DELETED') then null else artifacts.verified_at end,
             updated_at=case when artifacts.status in ('INVALID','DELETED') then now() else artifacts.updated_at end
           where artifacts.project_id=excluded.project_id
             and artifacts.kind='SOURCE'
             and (
               artifacts.status in ('INVALID','DELETED')
               or (
                 artifacts.drive_file_id=excluded.drive_file_id
                 and artifacts.drive_parent_id=excluded.drive_parent_id
                 and artifacts.display_name=excluded.display_name
                 and artifacts.mime_type=excluded.mime_type
                 and artifacts.expected_size_bytes=excluded.expected_size_bytes
               )
             )
           returning ${artifactColumns()}
         ), project_updated as (
           update projects set source_status='UPLOAD_PENDING',updated_at=now()
           where id=$2
             and source_status in ('NO_SOURCE','UPLOAD_PENDING','UPLOAD_FAILED')
             and exists(select 1 from reserved)
           returning id
         )
         select reserved.*, (select count(*) from project_updated) as project_updates from reserved`,
        [
          input.artifactId, input.projectId, input.driveFileId, input.driveParentId,
          input.fileName, input.mimeType, input.sizeBytes,
        ],
      );
      const row = reserved.rows[0];
      if (!row) throw new Error("Artifact reservation mismatch or project not ready");
      const artifact = parseArtifact(row);
      return artifact;
    },

    async getArtifact(projectId, artifactId) {
      const result = await sql.query(
        `select ${artifactColumns()} from artifacts where project_id=$1 and id=$2`,
        [projectId, artifactId],
      );
      return result.rows.length === 0 ? null : parseArtifact(result.rows[0]!);
    },

    async markArtifactUploading(artifactId) {
      const result = await sql.query(
        `update artifacts set status='UPLOADING',updated_at=now()
         where id=$1 and kind='SOURCE' and status in ('PENDING','UPLOADING') returning id`,
        [artifactId],
      );
      if (result.rows.length === 0) throw new Error("Artifact cannot start uploading");
    },

    async markSourceReady(artifactId, actualSizeBytes, verifiedAt) {
      if (!Number.isSafeInteger(actualSizeBytes) || actualSizeBytes < 0) throw new Error("Invalid artifact size");
      const result = await sql.query(
        `with changed as (
           update artifacts set status='READY',actual_size_bytes=$2,verified_at=$3,updated_at=now()
           where id=$1 and kind='SOURCE' and status in ('UPLOADING','READY') returning project_id
         )
         update projects set source_status='SOURCE_READY',updated_at=now()
         where id=(select project_id from changed) returning id`,
        [artifactId, actualSizeBytes, validDate(verifiedAt)],
      );
      if (result.rows.length === 0) throw new Error("Source cannot be marked ready");
    },

    async markSourceInvalid(artifactId) {
      const result = await sql.query(
        `with changed as (
           update artifacts set status='INVALID',updated_at=now()
           where id=$1 and kind='SOURCE' and status <> 'DELETED' returning project_id
         )
         update projects set source_status='UPLOAD_FAILED',updated_at=now()
         where id=(select project_id from changed) returning id`,
        [artifactId],
      );
      if (result.rows.length === 0) throw new Error("Source cannot be marked invalid");
    },

    async markSourceDeleted(artifactId) {
      const result = await sql.query(
        `with changed as (
           update artifacts set status='DELETED',updated_at=now()
           where id=$1 and kind='SOURCE' returning project_id
         )
         update projects set source_status='NO_SOURCE',updated_at=now()
         where id=(select project_id from changed) returning id`,
        [artifactId],
      );
      if (result.rows.length === 0) throw new Error("Source cannot be marked deleted");
    },

    async getUsage(provider) {
      const result = await sql.query(
        `select provider,used_bytes,limit_bytes,app_managed_bytes,mode,reason_codes,observed_at
         from usage_guards where provider=$1`,
        [provider],
      );
      return result.rows.length === 0 ? null : parseUsage(result.rows[0]!);
    },

    async saveUsage(snapshot) {
      await sql.query(
        `insert into usage_guards(
           provider,used_bytes,limit_bytes,app_managed_bytes,mode,reason_codes,observed_at
         ) values ($1,$2,$3,$4,$5,$6::jsonb,$7)
         on conflict(provider) do update set
           used_bytes=excluded.used_bytes,limit_bytes=excluded.limit_bytes,
           app_managed_bytes=excluded.app_managed_bytes,mode=excluded.mode,
           reason_codes=excluded.reason_codes,observed_at=excluded.observed_at,updated_at=now()`,
        [
          snapshot.provider, snapshot.usedBytes, snapshot.limitBytes, snapshot.appManagedBytes,
          snapshot.mode, JSON.stringify(snapshot.reasonCodes), snapshot.observedAt,
        ],
      );
    },

    async appManagedDriveBytes() {
      const result = await sql.query(
        `select coalesce(sum(coalesce(actual_size_bytes,expected_size_bytes)),0) as bytes
         from artifacts where status <> 'DELETED'`,
      );
      const value = safeInteger(result.rows[0]?.bytes);
      if (value === null) fail("Drive usage");
      return value;
    },

    async databaseUsedBytes() {
      const result = await sql.query("select pg_database_size(current_database()) as bytes");
      const value = safeInteger(result.rows[0]?.bytes);
      if (value === null) fail("database usage");
      return value;
    },

    async recordAudit(event: AuditEvent) {
      await sql.query(
        "insert into audit_events(event_type,target_id,actor_class,payload) values ($1,$2,$3,$4::jsonb)",
        [event.eventType, event.targetId ?? null, event.actorClass, JSON.stringify(event.payload)],
      );
    },
  };
}

export function createNeonDriveControlPlaneRepository(databaseUrl: string): DriveControlPlaneRepository {
  return createDriveControlPlaneRepository(createSql(databaseUrl));
}
