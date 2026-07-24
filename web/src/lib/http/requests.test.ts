import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

const { currentAdmin } = vi.hoisted(() => ({ currentAdmin: vi.fn() }));
vi.mock("@/lib/auth/current-admin", () => ({ currentAdmin }));

import { HttpError, readStrictJson, requireAdmin, requireMutationOrigin } from "./requests";
import { AppError } from "@/lib/domain/errors";

function requestWithStream(body: ReadableStream<Uint8Array>): Request {
  return new Request("https://example.test/api", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

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

  it("rejects malformed UTF-8 even when replacement decoding would produce valid JSON", async () => {
    const request = new Request("https://example.test/api", {
      method: "POST",
      body: new Uint8Array([
        0x7b, 0x22, 0x6e, 0x61, 0x6d, 0x65, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d,
      ]),
    });

    await expect(readStrictJson(request, schema, 64)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: 400,
    });
  });

  it("normalizes a request stream read rejection even when its reason is an HTTP error", async () => {
    const request = requestWithStream(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new HttpError(413, "REQUEST_TOO_LARGE"));
      },
    }));

    await expect(readStrictJson(request, schema, 64)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: 400,
    });
  });

  it("rejects a body exceeding the byte limit", async () => {
    const request = new Request("https://example.test/api", { method: "POST", body: "x".repeat(65) });

    await expect(readStrictJson(request, schema, 64)).rejects.toMatchObject({
      code: "REQUEST_TOO_LARGE",
      status: 413,
    });
  });

  it("best-effort cancels an oversized stream without replacing the size error", async () => {
    let cancellationAttempts = 0;
    const request = requestWithStream(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65));
      },
      cancel() {
        cancellationAttempts += 1;
        throw new Error("private cancellation failure");
      },
    }));

    await expect(readStrictJson(request, schema, 64)).rejects.toMatchObject({
      code: "REQUEST_TOO_LARGE",
      status: 413,
    });
    expect(cancellationAttempts).toBe(1);
  });

  it("does not wait for oversized stream cancellation to settle", async () => {
    let cancellationAttempts = 0;
    const request = requestWithStream(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65));
      },
      cancel() {
        cancellationAttempts += 1;
        return new Promise<void>(() => undefined);
      },
    }));
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const outcome = await Promise.race([
      readStrictJson(request, schema, 64).then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<{ kind: "pending" }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: "pending" }), 50);
      }),
    ]);
    if (timeout !== undefined) clearTimeout(timeout);

    expect(outcome).toMatchObject({
      kind: "rejected",
      error: {
        code: "REQUEST_TOO_LARGE",
        status: 413,
      },
    });
    expect(cancellationAttempts).toBe(1);
  });

  it("rejects malformed JSON", async () => {
    const request = new Request("https://example.test/api", { method: "POST", body: "{" });

    await expect(readStrictJson(request, schema, 64)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: 400,
    });
  });

  it("uses a typed HTTP error", () => {
    expect(new HttpError(400, "INVALID_REQUEST")).toBeInstanceOf(AppError);
  });
});
