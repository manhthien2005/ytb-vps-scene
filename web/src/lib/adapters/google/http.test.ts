import { describe, expect, it, vi } from "vitest";
import { googleJson } from "./http";

const options = {
  timeoutMs: 5_000,
  maxResponseBytes: 32 * 1_024,
  attempts: 2,
} as const;

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

describe("googleJson", () => {
  it("returns a bounded JSON response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true }));

    await expect(googleJson(fetcher, "https://oauth2.googleapis.com/token", {}, options))
      .resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("accepts an empty successful response for the Google revocation endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));

    await expect(googleJson(fetcher, "https://oauth2.googleapis.com/revoke", {}, options))
      .resolves.toBeNull();
  });

  it.each([
    [{ ...options, timeoutMs: 0 }],
    [{ ...options, timeoutMs: 5_001 }],
    [{ ...options, maxResponseBytes: 0 }],
    [{ ...options, maxResponseBytes: 65_537 }],
    [{ ...options, attempts: 0 }],
    [{ ...options, attempts: 4 }],
  ])("rejects unsafe provider options %#", async (unsafe) => {
    const fetcher = vi.fn<typeof fetch>();

    await expect(googleJson(fetcher, "https://www.googleapis.com/drive/v3/about", {}, unsafe))
      .rejects.toThrow("DRIVE_PROVIDER_REJECTED");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects an oversized Content-Length without reading the body", async () => {
    let pulled = false;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled = true;
        controller.enqueue(new Uint8Array([123]));
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    const response = new Response(body, { headers: { "content-length": "32769" } });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(googleJson(fetcher, "https://oauth2.googleapis.com/token", {}, options))
      .rejects.toThrow("DRIVE_PROVIDER_REJECTED");
    expect(pulled).toBe(false);
    expect(cancelled).toBe(true);
  });

  it("cancels a streamed response as soon as it crosses the byte cap", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(20_000));
        controller.enqueue(new Uint8Array(20_000));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));

    await expect(googleJson(fetcher, "https://oauth2.googleapis.com/token", {}, options))
      .rejects.toThrow("DRIVE_PROVIDER_REJECTED");
    expect(cancelled).toBe(true);
  });

  it("maps invalid_grant without exposing the provider body", async () => {
    const secretText = "provider says secret-token was revoked";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(
      { error: "invalid_grant", error_description: secretText },
      { status: 400 },
    ));

    const error = await googleJson(fetcher, "https://oauth2.googleapis.com/token", {}, options)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message: "DRIVE_REAUTH_REQUIRED", code: "DRIVE_REAUTH_REQUIRED" });
    expect(JSON.stringify(error)).not.toContain(secretText);
  });

  it.each([
    [401, "DRIVE_REAUTH_REQUIRED"],
    [400, "DRIVE_PROVIDER_REJECTED"],
  ])("maps HTTP %i to %s", async (status, code) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(
      { error: "provider-text-must-not-escape" },
      { status },
    ));

    await expect(googleJson(fetcher, "https://oauth2.googleapis.com/token", {}, options))
      .rejects.toThrow(code);
  });

  it.each([
    [429, "DRIVE_RATE_LIMITED"],
    [503, "DRIVE_TEMPORARILY_UNAVAILABLE"],
  ])("retries HTTP %i only to the configured attempt ceiling", async (status, code) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, { status }));

    await expect(googleJson(fetcher, "https://www.googleapis.com/drive/v3/about", {}, options))
      .rejects.toThrow(code);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("times out each attempt and returns only a stable code", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise<Response>(
      (_resolve, reject) => init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("secret provider timeout text", "AbortError"));
      }),
    ));

    await expect(googleJson(
      fetcher,
      "https://oauth2.googleapis.com/token",
      {},
      { ...options, timeoutMs: 5 },
    )).rejects.toThrow("DRIVE_TEMPORARILY_UNAVAILABLE");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["not-json"],
    ["{\"unterminated\":"],
  ])("fails closed on malformed JSON %#", async (body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200 }));

    await expect(googleJson(fetcher, "https://www.googleapis.com/drive/v3/about", {}, options))
      .rejects.toThrow("DRIVE_PROVIDER_REJECTED");
  });
});
