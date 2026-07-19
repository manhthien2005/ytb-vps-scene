import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

const { currentAdmin } = vi.hoisted(() => ({ currentAdmin: vi.fn() }));
vi.mock("@/lib/auth/current-admin", () => ({ currentAdmin }));

import { HttpError, readStrictJson, requireAdmin, requireMutationOrigin } from "./requests";

describe("request guards", () => {
  it("rejects an unauthenticated mutation before parsing its body", async () => {
    currentAdmin.mockResolvedValue(false);
    const request = new Request("https://example.test/api", {
      method: "POST",
      body: "not json",
    });

    await expect(requireAdmin(request, "s".repeat(64))).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      status: 401,
    });
  });

  it("rejects an origin other than the configured application origin", () => {
    const request = new Request("https://example.test/api", {
      method: "POST",
      headers: { origin: "https://attacker.test" },
    });

    let thrown: unknown;
    try {
      requireMutationOrigin(request, "https://example.test");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: "ORIGIN_REJECTED",
      status: 403,
    });
  });
});

describe("readStrictJson", () => {
  const schema = z.object({ name: z.string() }).strict();

  it("parses a schema-valid JSON body", async () => {
    const request = new Request("https://example.test/api", {
      method: "POST",
      body: JSON.stringify({ name: "Drive" }),
    });

    await expect(readStrictJson(request, schema, 64)).resolves.toEqual({ name: "Drive" });
  });

  it("rejects a body exceeding the byte limit", async () => {
    const request = new Request("https://example.test/api", { method: "POST", body: "x".repeat(65) });

    await expect(readStrictJson(request, schema, 64)).rejects.toMatchObject({
      code: "REQUEST_TOO_LARGE",
      status: 413,
    });
  });

  it("rejects malformed JSON", async () => {
    const request = new Request("https://example.test/api", { method: "POST", body: "{" });

    await expect(readStrictJson(request, schema, 64)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: 400,
    });
  });

  it("uses a typed HTTP error", () => {
    expect(new HttpError(400, "INVALID_REQUEST")).toBeInstanceOf(Error);
  });
});
