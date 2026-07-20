// @vitest-environment node
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

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
      expect(migrations.rows.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
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
      ]));
      const migrations = await db.query<{ version: number }>(
        "select version from schema_migrations order by version",
      );
      expect(migrations.rows.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      await expect(db.exec("insert into jobs(id, project_name, state) values ('j1','Demo','WRONG')"))
        .rejects.toThrow();
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
});
