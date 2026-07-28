// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({
  createSql: () => ({ query }),
}));

import {
  createControlPlaneRepository,
  createNeonControlPlaneRepository,
} from "./neon-control-plane";

describe("NeonControlPlaneRepository", () => {
  beforeEach(() => query.mockReset());

  it.each(["WRONG", 42, null])("rejects an invalid database job state: %j", async (state) => {
    query.mockResolvedValue({
      rows: [{
        id: "job-1",
        project_name: "Demo",
        state,
        progress_percent: 5,
        updated_at: "2026-07-19T00:00:00Z",
      }],
    });
    const repo = createNeonControlPlaneRepository("postgresql://example.invalid/control-plane");

    await expect(repo.listJobs()).rejects.toThrow("Invalid job state returned by database");
  });

  it("keeps an active blocked row at the schema maximum without a constraint failure", async () => {
    const db = new PGlite();
    try {
      await db.exec(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
      const now = new Date("2026-07-19T08:00:00.000Z");
      const blockedUntil = new Date(now.getTime() + 15 * 60 * 1000);
      await db.query(
        `insert into auth_login_windows(key_hash, window_started, attempt_count, blocked_until)
         values ($1, $2, 1000, $3)`,
        ["a".repeat(64), now.toISOString(), blockedUntil.toISOString()],
      );
      const repo = createControlPlaneRepository({
        query: (text, parameters) => db.query(text, parameters),
      });

      await expect(repo.consumeLoginAttempt("a".repeat(64), now)).resolves.toEqual({
        allowed: false,
        retryAfterSeconds: 900,
      });
      const stored = await db.query<{ attempt_count: number }>(
        "select attempt_count from auth_login_windows where key_hash = $1",
        ["a".repeat(64)],
      );
      expect(stored.rows[0]?.attempt_count).toBe(1000);
    } finally {
      await db.close();
    }
  });

  it("does not renew an active block window and allows the advertised expiry", async () => {
    const db = new PGlite();
    try {
      await db.exec(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
      const keyHash = "b".repeat(64);
      const t0 = new Date("2026-07-19T09:00:00.000Z");
      await db.query(
        `insert into auth_login_windows(key_hash, window_started, attempt_count, blocked_until)
         values ($1, $2, 5, null)`,
        [keyHash, t0.toISOString()],
      );
      const repo = createControlPlaneRepository({
        query: (text, parameters) => db.query(text, parameters),
      });

      const sixthAttempt = new Date(t0.getTime() + 14 * 60 * 1000);
      await expect(repo.consumeLoginAttempt(keyHash, sixthAttempt)).resolves.toEqual({
        allowed: false,
        retryAfterSeconds: 900,
      });

      const duringBlock = new Date(t0.getTime() + 15 * 60 * 1000);
      await expect(repo.consumeLoginAttempt(keyHash, duringBlock)).resolves.toEqual({
        allowed: false,
        retryAfterSeconds: 840,
      });
      const blocked = await db.query<{
        window_started: string;
        attempt_count: number;
        blocked_until: string;
      }>(
        `select window_started, attempt_count, blocked_until
         from auth_login_windows where key_hash = $1`,
        [keyHash],
      );
      expect(new Date(blocked.rows[0]!.window_started).toISOString()).toBe(t0.toISOString());
      expect(blocked.rows[0]!.attempt_count).toBe(6);
      expect(new Date(blocked.rows[0]!.blocked_until).toISOString()).toBe(
        new Date(t0.getTime() + 29 * 60 * 1000).toISOString(),
      );

      const advertisedExpiry = new Date(t0.getTime() + 29 * 60 * 1000);
      await expect(repo.consumeLoginAttempt(keyHash, advertisedExpiry)).resolves.toEqual({
        allowed: true,
        retryAfterSeconds: 0,
      });
      const reset = await db.query<{
        window_started: string;
        attempt_count: number;
        blocked_until: string | null;
      }>(
        `select window_started, attempt_count, blocked_until
         from auth_login_windows where key_hash = $1`,
        [keyHash],
      );
      expect(new Date(reset.rows[0]!.window_started).toISOString()).toBe(advertisedExpiry.toISOString());
      expect(reset.rows[0]!.attempt_count).toBe(1);
      expect(reset.rows[0]!.blocked_until).toBeNull();
    } finally {
      await db.close();
    }
  });

  it("projects every OUTPUT Part in stable Part order", async () => {
    const db = new PGlite();
    try {
      await db.exec(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
      const projectId = "10000000-0000-4000-8000-000000000001";
      const jobId = "20000000-0000-4000-8000-000000000001";
      const partOneId = "30000000-0000-4000-8000-000000000001";
      const partTwoId = "30000000-0000-4000-8000-000000000002";
      await db.query(
        `insert into projects(
           id,status,name,source_status,creation_idempotency_key_hash,
           creation_request_hash,drive_project_folder_id,drive_input_folder_id
         ) values ($1,'READY','Demo','SOURCE_READY',$2,$3,$4,$5)`,
        [projectId, "a".repeat(64), "b".repeat(64), "drive-project-001", "drive-input-001"],
      );
      await db.query(
        `insert into jobs(id,project_id,project_name,state,progress_percent)
         values ($1,$2,'Demo','COMPLETED',100)`,
        [jobId, projectId],
      );
      for (const [id, partIndex, createdAt] of [
        [partTwoId, 2, "2026-07-19T12:00:00.000Z"],
        [partOneId, 1, "2026-07-19T12:01:00.000Z"],
      ] as const) {
        await db.query(
          `insert into artifacts(
             id,project_id,job_id,kind,status,drive_file_id,drive_parent_id,
             display_name,mime_type,expected_size_bytes,actual_size_bytes,
             checksum_sha256,part_index,part_count,created_at,verified_at
           ) values ($1,$2,$3,'OUTPUT','READY',$4,$5,$6,'video/mp4',100,100,$7,$8,2,$9,$9)`,
          [
            id,
            projectId,
            jobId,
            `drive-output-${partIndex}`,
            "drive-project-001",
            `part-0${partIndex}-of-02.mp4`,
            String(partIndex).repeat(64),
            partIndex,
            createdAt,
          ],
        );
      }
      const repository = createControlPlaneRepository({
        query: (text, parameters) => db.query(text, parameters),
      });

      const jobs = await repository.listJobs();
      expect(jobs[0]).toMatchObject({
        outputParts: [
          { artifactId: partOneId, partIndex: 1, partCount: 2 },
          { artifactId: partTwoId, partIndex: 2, partCount: 2 },
        ],
      });
      await expect(repository.getJobDetail(jobId)).resolves.toMatchObject({
        outputParts: [
          { artifactId: partOneId, displayName: "part-01-of-02.mp4", partIndex: 1, partCount: 2 },
          { artifactId: partTwoId, displayName: "part-02-of-02.mp4", partIndex: 2, partCount: 2 },
        ],
      });
    } finally {
      await db.close();
    }
  });
});
