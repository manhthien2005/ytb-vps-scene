// @vitest-environment node
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("local application runbook", () => {
  it("requires every private runtime value to be generated and substituted safely", async () => {
    const [example, readme] = await Promise.all([
      readFile(new URL("../../../.env.example", import.meta.url), "utf8"),
      readFile(new URL("../../../README.md", import.meta.url), "utf8"),
    ]);

    expect(example).toContain("DATABASE_URL=REPLACE_WITH_NEON_CONNECTION_STRING");
    expect(example).toContain("ADMIN_KEY_HASH=REPLACE_WITH_GENERATED_SCRYPT_HASH");
    expect(example).toContain("SESSION_SECRET=REPLACE_WITH_RANDOM_64_CHARACTER_SECRET");
    expect(example).not.toContain("scrypt$16384$8$1$");
    expect(example).not.toContain("127.0.0.1:5432");
    expect(readme).toContain("Neon HTTP");
    expect(readme).toContain("migration and PGlite tests");
    expect(readme).toContain("replace `DATABASE_URL`, `ADMIN_KEY_HASH`, and `SESSION_SECRET`");
    expect(readme).toContain("node scripts/hash-admin-key.mjs");
    expect(readme).toContain("randomBytes(48)");
    expect(readme).toContain('toString("base64url")');
    expect(readme.toLowerCase()).toContain("copy each generated output into `.env.local`");
    expect(readme).toContain("keep the plaintext admin key private");
  });
});
