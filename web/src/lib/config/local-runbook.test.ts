// @vitest-environment node
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("local application runbook", () => {
  it("requires a Neon HTTP connection and distinguishes runtime from migration/test databases", async () => {
    const [example, readme] = await Promise.all([
      readFile(new URL("../../../.env.example", import.meta.url), "utf8"),
      readFile(new URL("../../../README.md", import.meta.url), "utf8"),
    ]);

    expect(example).toContain(".neon.tech");
    expect(example).not.toContain("127.0.0.1:5432");
    expect(readme).toContain("Neon HTTP");
    expect(readme).toContain("migration and PGlite tests");
  });
});
