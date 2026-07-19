import { describe, expect, it } from "vitest";
import { encodeAdminKey, verifyAdminKey } from "./admin-key";

describe("admin key", () => {
  it("verifies the matching key and rejects a different key", async () => {
    const encoded = await encodeAdminKey("correct horse", Buffer.alloc(16, 7));
    await expect(verifyAdminKey("correct horse", encoded)).resolves.toBe(true);
    await expect(verifyAdminKey("wrong horse", encoded)).resolves.toBe(false);
  });

  it("rejects malformed hashes without throwing secret details", async () => {
    await expect(verifyAdminKey("anything", "bad-format")).resolves.toBe(false);
  });

  it("rejects noncanonical hashes", async () => {
    const encoded = await encodeAdminKey("correct horse", Buffer.alloc(16, 7));

    await expect(verifyAdminKey("correct horse", `${encoded}$extra`)).resolves.toBe(false);
  });
});
