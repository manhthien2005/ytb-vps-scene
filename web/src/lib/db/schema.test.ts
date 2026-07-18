// @vitest-environment node
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

describe("control-plane schema v1", () => {
  it("migrates twice and rejects an invalid job state", async () => {
    const originalComSpec = process.env.ComSpec;
    const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
    if (process.platform === "win32" && existsSync(gitBash)) process.env.ComSpec = gitBash;
    try {
      const db = new PGlite();
      const sql = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
      await db.exec(sql);
      await db.exec(sql);
      const tables = await db.query<{ table_name: string }>(
        "select table_name from information_schema.tables where table_schema='public'",
      );
      expect(tables.rows.map((row) => row.table_name)).toContain("jobs");
      expect(tables.rows.map((row) => row.table_name)).toContain("auth_login_windows");
      await expect(db.exec("insert into jobs(id, project_name, state) values ('j1','Demo','WRONG')"))
        .rejects.toThrow();
      await db.close();
    } finally {
      if (originalComSpec === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = originalComSpec;
    }
  });
});
