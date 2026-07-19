import { describe, expect, it, vi } from "vitest";
import { DRIVE_FILE_SCOPE } from "@/lib/domain/drive";
import { createGoogleOAuthAdapter } from "./oauth";

const CLIENT_ID = "google-client-id.apps.googleusercontent.com";
const CLIENT_SECRET = "private-client-secret";
const CALLBACK = "https://control.example/api/v1/drive/callback";
const ACCESS_TOKEN = "bounded-access-token";
const REFRESH_TOKEN = "bounded-refresh-token";

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function exchangeResponse(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({
    access_token: ACCESS_TOKEN,
    expires_in: 3_599,
    refresh_token: REFRESH_TOKEN,
    scope: DRIVE_FILE_SCOPE,
    token_type: "Bearer",
    ...overrides,
  });
}

function adapter(fetcher: typeof fetch) {
  return createGoogleOAuthAdapter({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    fetcher,
  });
}

function postedForm(fetcher: ReturnType<typeof vi.fn<typeof fetch>>): URLSearchParams {
  const [url, init] = fetcher.mock.calls[0]!;
  expect(typeof url === "string" ? url : url.toString()).not.toContain(CLIENT_SECRET);
  expect(typeof url === "string" ? url : url.toString()).not.toContain(REFRESH_TOKEN);
  expect(init?.method).toBe("POST");
  expect(init?.body).toBeInstanceOf(URLSearchParams);
  return init!.body as URLSearchParams;
}

describe("createGoogleOAuthAdapter", () => {
  it("builds an exact non-incremental drive.file authorization URL", () => {
    const oauth = adapter(vi.fn<typeof fetch>());

    const url = new URL(oauth.buildAuthorizationUrl({ state: "signed-state", redirectUri: CALLBACK }));

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect([...url.searchParams.entries()]).toEqual([
      ["response_type", "code"],
      ["client_id", CLIENT_ID],
      ["redirect_uri", CALLBACK],
      ["scope", DRIVE_FILE_SCOPE],
      ["access_type", "offline"],
      ["prompt", "consent"],
      ["include_granted_scopes", "false"],
      ["state", "signed-state"],
    ]);
    expect(url.searchParams.has("client_secret")).toBe(false);
  });

  it("exchanges a code using a form body and returns no exchange access token", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(exchangeResponse());

    const result = await adapter(fetcher).exchangeCode({
      code: "one-use-secret-code",
      redirectUri: CALLBACK,
      timeoutMs: 5_000,
    });

    expect(result).toEqual({ refreshToken: REFRESH_TOKEN, grantedScopes: [DRIVE_FILE_SCOPE] });
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
    const form = postedForm(fetcher);
    expect(Object.fromEntries(form)).toEqual({
      code: "one-use-secret-code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: CALLBACK,
      grant_type: "authorization_code",
    });
    expect(String(fetcher.mock.calls[0]![0])).not.toContain("one-use-secret-code");
  });

  it("returns a bounded exact granted-scope set for application validation", async () => {
    const broadScope = "https://www.googleapis.com/auth/drive";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(exchangeResponse({
      scope: `${DRIVE_FILE_SCOPE} ${broadScope}`,
    }));

    await expect(adapter(fetcher).exchangeCode({
      code: "code",
      redirectUri: CALLBACK,
      timeoutMs: 5_000,
    })).resolves.toEqual({
      refreshToken: REFRESH_TOKEN,
      grantedScopes: [DRIVE_FILE_SCOPE, broadScope],
    });
  });

  it.each([
    [undefined],
    [""],
    ["x".repeat(4_097)],
  ])("rejects missing or oversized refresh_token %#", async (refreshToken) => {
    const response = exchangeResponse({ refresh_token: refreshToken });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(adapter(fetcher).exchangeCode({
      code: "code",
      redirectUri: CALLBACK,
      timeoutMs: 5_000,
    })).rejects.toThrow("OAUTH_REFRESH_TOKEN_MISSING");
  });

  it.each([
    [{ access_token: ACCESS_TOKEN, expires_in: 3_599, refresh_token: REFRESH_TOKEN, scope: DRIVE_FILE_SCOPE }],
    [{ access_token: ACCESS_TOKEN, expires_in: 3_599, refresh_token: REFRESH_TOKEN, scope: DRIVE_FILE_SCOPE, token_type: "bearer" }],
    [{ access_token: ACCESS_TOKEN, expires_in: 3_599, refresh_token: REFRESH_TOKEN, scope: DRIVE_FILE_SCOPE, token_type: "Bearer", unexpected: true }],
    [{ access_token: ACCESS_TOKEN, expires_in: 0, refresh_token: REFRESH_TOKEN, scope: DRIVE_FILE_SCOPE, token_type: "Bearer" }],
  ])("fails closed on malformed or unknown exchange data %#", async (body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body));

    await expect(adapter(fetcher).exchangeCode({
      code: "code",
      redirectUri: CALLBACK,
      timeoutMs: 5_000,
    })).rejects.toThrow("DRIVE_PROVIDER_REJECTED");
  });

  it.each([
    [""],
    [`${DRIVE_FILE_SCOPE} ${DRIVE_FILE_SCOPE}`],
    [Array.from({ length: 17 }, (_, index) => `scope-${index}`).join(" ")],
  ])("rejects malformed or contradictory granted scopes %#", async (scope) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(exchangeResponse({ scope }));

    await expect(adapter(fetcher).exchangeCode({
      code: "code",
      redirectUri: CALLBACK,
      timeoutMs: 5_000,
    })).rejects.toThrow("OAUTH_SCOPE_REJECTED");
  });

  it("refreshes through a form body and returns only the bounded access token", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      access_token: ACCESS_TOKEN,
      expires_in: 3_599,
      scope: DRIVE_FILE_SCOPE,
      token_type: "Bearer",
    }));

    await expect(adapter(fetcher).refreshAccessToken(REFRESH_TOKEN, 5_000))
      .resolves.toBe(ACCESS_TOKEN);
    expect(Object.fromEntries(postedForm(fetcher))).toEqual({
      refresh_token: REFRESH_TOKEN,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "refresh_token",
    });
  });

  it("maps invalid_grant during refresh to reauthentication without provider text", async () => {
    const providerText = "full email and provider diagnostic";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      error: "invalid_grant",
      error_description: providerText,
    }, { status: 400 }));

    const error = await adapter(fetcher).refreshAccessToken(REFRESH_TOKEN, 5_000)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "DRIVE_REAUTH_REQUIRED" });
    expect(JSON.stringify(error)).not.toContain(providerText);
  });

  it("revokes with a form body and accepts Google's empty success response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));

    await expect(adapter(fetcher).revokeRefreshToken(REFRESH_TOKEN, 5_000))
      .resolves.toBe("REVOKED");
    expect(Object.fromEntries(postedForm(fetcher))).toEqual({ token: REFRESH_TOKEN });
  });

  it.each([429, 503])("maps retryable revoke HTTP %i to RETRYABLE", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({}, { status }));

    await expect(adapter(fetcher).revokeRefreshToken(REFRESH_TOKEN, 5_000))
      .resolves.toBe("RETRYABLE");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("times out token exchange after two total attempts without exposing the code", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise<Response>(
      (_resolve, reject) => init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("provider mentions one-use-secret-code", "AbortError"));
      }),
    ));

    const error = await adapter(fetcher).exchangeCode({
      code: "one-use-secret-code",
      redirectUri: CALLBACK,
      timeoutMs: 5,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "DRIVE_TEMPORARILY_UNAVAILABLE" });
    expect(String(error)).not.toContain("one-use-secret-code");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
