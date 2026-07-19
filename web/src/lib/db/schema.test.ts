// @vitest-environment node
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

describe("control-plane schema v1", () => {
  it("migrates twice and rejects an invalid job state", async () => {
    const db = new PGlite();
    try {
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
    } finally {
      await db.close();
    }
  });
});
