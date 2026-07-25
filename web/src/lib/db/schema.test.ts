// @vitest-environment node
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { isCancelableJobState } from "../domain/control-plane";

describe("control-plane schema", () => {
  it("upgrades an existing v2 artifact constraint before DELETING is used", async () => {
    const db = new PGlite();
    try {
      const current = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
      const legacyV2 = current
        .split("-- migration v3")[0]!
        .replace(
          "'PENDING','UPLOADING','DELETING','READY','INVALID','DELETED'",
          "'PENDING','UPLOADING','READY','INVALID','DELETED'",
        );
      await db.exec(legacyV2);
      await db.exec(current);

      const projectId = "10000000-0000-4000-8000-000000000001";
      await db.query(
        `insert into projects(
           id,status,name,source_status,creation_idempotency_key_hash,creation_request_hash
         ) values ($1,'PROVISIONING','Demo','NO_SOURCE',$2,$3)`,
        [projectId, "a".repeat(64), "b".repeat(64)],
      );
      await db.query(
        `insert into artifacts(
           id,project_id,kind,status,drive_file_id,drive_parent_id,display_name,mime_type,expected_size_bytes
         ) values ($1,$2,'SOURCE','PENDING','drive-file-0001','drive-parent-01','source.mp4','video/mp4',100)`,
        ["20000000-0000-4000-8000-000000000001", projectId],
      );

      await db.exec("update artifacts set status='DELETING'");
      const artifact = await db.query<{ status: string }>("select status from artifacts");
      expect(artifact.rows).toEqual([{ status: "DELETING" }]);
      const migrations = await db.query<{ version: number }>(
        "select version from schema_migrations order by version",
      );
      expect(migrations.rows.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    } finally {
      await db.close();
    }
  });

  it("backfills remaining capacity when upgrading a pending v4 upload", async () => {
    const db = new PGlite();
    try {
      const current = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
      const legacyV4 = current.split("create table if not exists drive_upload_reservations")[0]!;
      await db.exec(legacyV4);
      const projectId = "10000000-0000-4000-8000-000000000001";
      const artifactId = "20000000-0000-4000-8000-000000000001";
      await db.query(
        `insert into projects(
           id,status,name,source_status,creation_idempotency_key_hash,creation_request_hash,
           drive_project_folder_id,drive_input_folder_id
         ) values ($1,'READY','Demo','UPLOAD_PENDING',$2,$3,'drive-project-001','drive-input-0001')`,
        [projectId, "a".repeat(64), "b".repeat(64)],
      );
      await db.query(
        `insert into artifacts(
           id,project_id,kind,status,drive_file_id,drive_parent_id,display_name,mime_type,expected_size_bytes
         ) values ($1,$2,'SOURCE','UPLOADING','drive-file-0001','drive-input-0001','source.mp4','video/mp4',100)`,
        [artifactId, projectId],
      );

      await db.exec(current);

      const reservations = await db.query<{
        artifact_id: string;
        observed_size_bytes: number;
        remaining_bytes: number;
        released_at: Date | null;
      }>(
        `select artifact_id,observed_size_bytes,remaining_bytes,released_at
         from drive_upload_reservations`,
      );
      expect(reservations.rows).toEqual([expect.objectContaining({
        artifact_id: artifactId,
        observed_size_bytes: 0,
        remaining_bytes: 100,
        released_at: null,
      })]);
    } finally {
      await db.close();
    }
  });

  it("migrates twice and installs all schema versions", async () => {
    const db = new PGlite();
    try {
      const sql = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
      await db.exec(sql);
      await db.exec(sql);
      const tables = await db.query<{ table_name: string }>(
        "select table_name from information_schema.tables where table_schema='public'",
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual(expect.arrayContaining([
        "jobs",
        "auth_login_windows",
        "projects",
        "artifacts",
        "oauth_credentials",
        "oauth_states",
        "usage_guards",
        "drive_provisioning_claims",
        "drive_upload_reservations",
        "worker_enrollment_tokens",
        "workers",
        "job_leases",
        "job_attempts",
        "project_scene_settings",
        "job_progress_history",
        "render_settings_presets",
      ]));
      const migrations = await db.query<{ version: number }>(
        "select version from schema_migrations order by version",
      );
      expect(migrations.rows.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      await expect(db.exec("insert into jobs(id, project_name, state) values ('j1','Demo','WRONG')"))
        .rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it("upgrades v9 jobs without changing legacy rows and exposes durable job detail storage", async () => {
    const db = new PGlite();
    try {
      const sql = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
      const legacyV9 = sql.split("-- migration v10")[0]!;
      await db.exec(legacyV9);
      await db.query(
        "insert into jobs(id,project_name,state) values ('legacy-job','Legacy','QUEUED')",
      );
      await db.query("update jobs set error_code='legacy unsafe value' where id='legacy-job'");

      await db.exec(sql);

      const job = await db.query<{
        settings_snapshot: unknown;
        source_metadata: unknown;
        active_phase: string | null;
        phase_progress_percent: number | null;
        latest_message: string | null;
        eta_seconds: number | null;
        started_at: Date | null;
        completed_at: Date | null;
        cancel_requested_at: Date | null;
        error_code: string | null;
        error_message: string | null;
      }>(
        `select settings_snapshot,source_metadata,active_phase,phase_progress_percent,
                latest_message,eta_seconds,started_at,completed_at,cancel_requested_at,
                error_code,error_message
         from jobs where id='legacy-job'`,
      );
      expect(job.rows).toEqual([{
        settings_snapshot: null,
        source_metadata: null,
        active_phase: null,
        phase_progress_percent: null,
        latest_message: null,
        eta_seconds: null,
        started_at: null,
        completed_at: null,
        cancel_requested_at: null,
        error_code: null,
        error_message: null,
      }]);
    } finally {
      await db.close();
    }
  });

  it("stores bounded snapshots, telemetry, progress history, and independent presets", async () => {
    const db = new PGlite();
    try {
      await db.exec(await readFile(new URL("./schema.sql", import.meta.url), "utf8"));
      const settings = {
        version: 1,
        sourceArtifactId: null,
        sourceSubtitle: { x: 0, y: 0.8, width: 0.9, height: 0.15 },
        logo: { x: 0.8, y: 0.05, width: 0.15, height: 0.12 },
        voice: "BV074_streaming",
        rate: 1,
      };
      const filenames = [
        "cookie-recipe.mp4",
        "authorization-explained.mp4",
        "raw-log-tutorial.mp4",
      ];
      const presetId = "30000000-0000-4000-8000-000000000001";
      await db.query(
        `insert into render_settings_presets(id,name,settings)
         values ($1,'Portrait',$2::jsonb)`,
        [presetId, JSON.stringify(settings)],
      );
      for (const [index, displayName] of filenames.entries()) {
        await db.query(
          `insert into jobs(
             id,project_name,state,settings_snapshot,source_metadata,active_phase,
             phase_progress_percent,latest_message,eta_seconds,started_at,
             completed_at,cancel_requested_at,error_code,error_message
           ) values (
             $1,'Demo','COMPLETED',$2::jsonb,$3::jsonb,'RENDER',42,
             'Encoding part 2',3600,now(),now(),now(),'ENCODE_TIMEOUT','Retrying safely'
           )`,
          [
            `detail-job-${index}`,
            JSON.stringify(settings),
            JSON.stringify({
              artifactId: "20000000-0000-4000-8000-000000000001",
              displayName,
              mimeType: "video/mp4",
              sizeBytes: 128,
              checksumSha256: "a".repeat(64),
            }),
          ],
        );
      }
      await db.query(
        `insert into job_progress_history(job_id,phase,progress_percent,message)
         values ('detail-job-0','RENDER',42,'Encoding part 2')`,
      );

      const before = await db.query<{ settings_snapshot: unknown }>(
        "select settings_snapshot from jobs where id='detail-job-0'",
      );
      await db.query(
        "update render_settings_presets set name='Portrait updated',settings=$2::jsonb where id=$1",
        [presetId, JSON.stringify({ ...settings, rate: 0.9 })],
      );
      const after = await db.query<{ settings_snapshot: unknown }>(
        "select settings_snapshot from jobs where id='detail-job-0'",
      );
      expect(after.rows[0]?.settings_snapshot).toEqual(before.rows[0]?.settings_snapshot);

      await expect(db.query(
        `insert into jobs(id,project_name,state,settings_snapshot)
         values ('bad-settings','Demo','QUEUED','[]'::jsonb)`,
      )).rejects.toThrow();
      await expect(db.query(
        `update jobs set settings_snapshot=$1::jsonb where id='detail-job-0'`,
        [JSON.stringify({ ...settings, rate: 0.9 })],
      )).rejects.toThrow("immutable");
      await expect(db.query(
        `update jobs set source_metadata='{}'::jsonb where id='detail-job-0'`,
      )).rejects.toThrow("immutable");
      await expect(db.query(
        `insert into jobs(id,project_name,state,phase_progress_percent)
         values ('bad-progress','Demo','QUEUED',101)`,
      )).rejects.toThrow();
      await expect(db.query(
        `insert into jobs(id,project_name,state,error_code)
         values ('bad-error','Demo','QUEUED','unsafe code')`,
      )).rejects.toThrow();
      await expect(db.query(
        `insert into jobs(id,project_name,state,source_metadata)
         values ('bad-source','Demo','QUEUED',$1::jsonb)`,
        [JSON.stringify({ accessToken: "never-store-this" })],
      )).rejects.toThrow();
      await expect(db.query(
        `insert into jobs(id,project_name,state,source_metadata)
         values ('bad-nested-source','Demo','QUEUED',$1::jsonb)`,
        [JSON.stringify({ nested: { authorization: "never-store-this" } })],
      )).rejects.toThrow();
      await expect(db.query(
        `insert into job_progress_history(job_id,phase,progress_percent,message)
         values ('detail-job-0','RENDER',42,$1)`,
        ["x".repeat(501)],
      )).rejects.toThrow();
      await expect(db.query(
        `insert into render_settings_presets(id,name,settings)
         values ('not-a-uuid','Portrait',$1::jsonb)`,
        [JSON.stringify(settings)],
      )).rejects.toThrow();
      await expect(db.query(
        `insert into render_settings_presets(id,name,settings)
         values ($1,$2,$3::jsonb)`,
        [presetId.replace("1", "2"), " ".repeat(1), JSON.stringify(settings)],
      )).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it("enforces project, artifact, credential, and usage invariants", async () => {
    const db = new PGlite();
    try {
      await db.exec(await readFile(new URL("./schema.sql", import.meta.url), "utf8"));
      const projectId = "10000000-0000-4000-8000-000000000001";
      await expect(db.query(
        `insert into projects(
           id,status,name,source_status,creation_idempotency_key_hash,creation_request_hash
         ) values ($1,'READY','Demo','NO_SOURCE',$2,$3)`,
        [projectId, "a".repeat(64), "b".repeat(64)],
      )).rejects.toThrow();

      await db.query(
        `insert into projects(
           id,status,name,source_status,creation_idempotency_key_hash,creation_request_hash
         ) values ($1,'PROVISIONING','Demo','NO_SOURCE',$2,$3)`,
        [projectId, "a".repeat(64), "b".repeat(64)],
      );
      await db.query(
        `insert into artifacts(
           id,project_id,kind,status,drive_file_id,drive_parent_id,display_name,mime_type,expected_size_bytes
         ) values ($1,$2,'SOURCE','PENDING','drive-file-0001','drive-parent-01','source.mp4','video/mp4',100)`,
        ["20000000-0000-4000-8000-000000000001", projectId],
      );
      await expect(db.query(
        `insert into artifacts(
           id,project_id,kind,status,drive_file_id,drive_parent_id,display_name,mime_type,expected_size_bytes
         ) values ($1,$2,'SOURCE','PENDING','drive-file-0002','drive-parent-01','other.mp4','video/mp4',100)`,
        ["20000000-0000-4000-8000-000000000002", projectId],
      )).rejects.toThrow();

      await expect(db.query(
        `insert into oauth_credentials(
           id,status,account_hint,account_permission_id_hash,root_folder_id
         ) values (1,'CONNECTED','a***@example.com',$1,'drive-root-001')`,
        ["c".repeat(64)],
      )).rejects.toThrow();

      await expect(db.query(
        `insert into usage_guards(
           provider,used_bytes,limit_bytes,app_managed_bytes,mode,reason_codes,observed_at
         ) values ('DRIVE',1,10,1,'READ_ONLY',$1::jsonb,now())`,
        [JSON.stringify(["x".repeat(2100)])],
      )).rejects.toThrow();
      await expect(db.query(
        `insert into usage_guards(
           provider,used_bytes,limit_bytes,app_managed_bytes,mode,reason_codes,observed_at
         ) values ('NEON',1,10,1,'READ_ONLY',$1::jsonb,now())`,
        [JSON.stringify(["unstable reason"])],
      )).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it.each([
    "QUEUED", "CLAIMED", "DOWNLOADING", "OCR", "TRANSLATE", "REVIEW_READY",
    "PAUSED_REVIEW", "TTS", "RENDER", "UPLOADING", "PAUSED_QUOTA",
    "PAUSED_NO_WORKER", "FAILED_RETRYABLE",
  ] as const)("marks %s as cancelable", (state) => {
    expect(isCancelableJobState(state)).toBe(true);
  });

  it.each([
    "DRAFT", "READY", "COMPLETED", "FAILED_FINAL", "CANCEL_REQUESTED",
    "CANCELLED", "DELETING", "DELETED", "NOT_A_JOB_STATE",
  ])("does not mark %s as cancelable", (state) => {
    expect(isCancelableJobState(state)).toBe(false);
  });
});
