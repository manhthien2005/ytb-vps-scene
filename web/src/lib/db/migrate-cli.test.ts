import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("database migration CLI", () => {
  it("starts under the package's CommonJS runtime before validating configuration", () => {
    const result = spawnSync(
      process.execPath,
      [join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), "src/lib/db/migrate-cli.ts"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: "" },
      },
    );
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain("DATABASE_URL must be a PostgreSQL URL");
    expect(output).not.toContain("Top-level await is currently not supported");
  });
});
