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
});
