import "server-only";

import { DRIVE_FILE_SCOPE } from "@/lib/domain/drive";
import { AppError, type PublicCode } from "@/lib/domain/errors";
import type { DriveOAuthPort } from "@/lib/ports/drive";
import { googleJson } from "./http";

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOCATION_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const OAUTH_RESPONSE_BYTES = 32 * 1_024;
const OAUTH_ATTEMPTS = 2;
const MAX_REFRESH_TOKEN_BYTES = 4_096;
const MAX_ACCESS_TOKEN_BYTES = 8_192;
const MAX_SCOPE_TEXT_BYTES = 2_048;
const MAX_SCOPES = 16;
const MAX_REFRESH_TOKEN_LIFETIME_SECONDS = 365 * 24 * 60 * 60;

type GoogleOAuthOptions = Readonly<{
  clientId: string;
  clientSecret: string;
  fetcher?: typeof fetch;
}>;

function oauthError(code: PublicCode, status = 502): AppError {
  return new AppError(code, status);
}

function boundedUtf8(value: unknown, minimum: number, maximum: number): value is string {
  if (typeof value !== "string") return false;
  const bytes = Buffer.byteLength(value, "utf8");
  return bytes >= minimum && bytes <= maximum;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function validTokenLifetime(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 86_400;
}

function parseScopes(value: unknown): readonly string[] | null {
  if (!boundedUtf8(value, 1, MAX_SCOPE_TEXT_BYTES) || value.trim() !== value || value.includes("  ")) {
    return null;
  }
  const scopes = value.split(" ");
  if (
    scopes.length === 0 ||
    scopes.length > MAX_SCOPES ||
    scopes.some((scope) => !boundedUtf8(scope, 1, 512)) ||
    new Set(scopes).size !== scopes.length
  ) {
    return null;
  }
  return scopes;
}

function validateRedirectUri(value: string): void {
  try {
    if (!boundedUtf8(value, 1, 2_048)) throw new Error();
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) {
      throw new Error();
    }
  } catch {
    throw oauthError("DRIVE_PROVIDER_REJECTED");
  }
}

function validateExchangeResponse(value: unknown): Readonly<{
  refreshToken: string;
  grantedScopes: readonly string[];
}> {
  const record = objectRecord(value);
  if (
    !record ||
    !hasOnlyKeys(record, [
      "access_token",
      "expires_in",
      "refresh_token",
      "refresh_token_expires_in",
      "scope",
      "token_type",
    ]) ||
    !boundedUtf8(record.access_token, 1, MAX_ACCESS_TOKEN_BYTES) ||
    !validTokenLifetime(record.expires_in) ||
    (record.refresh_token_expires_in !== undefined && (
      !Number.isSafeInteger(record.refresh_token_expires_in) ||
      (record.refresh_token_expires_in as number) < 1 ||
      (record.refresh_token_expires_in as number) > MAX_REFRESH_TOKEN_LIFETIME_SECONDS
    )) ||
    record.token_type !== "Bearer"
  ) {
    throw oauthError("DRIVE_PROVIDER_REJECTED");
  }
  if (!boundedUtf8(record.refresh_token, 1, MAX_REFRESH_TOKEN_BYTES)) {
    throw oauthError("OAUTH_REFRESH_TOKEN_MISSING", 400);
  }
  const grantedScopes = parseScopes(record.scope);
  if (!grantedScopes) throw oauthError("OAUTH_SCOPE_REJECTED", 400);
  return { refreshToken: record.refresh_token, grantedScopes };
}

function validateRefreshResponse(value: unknown): string {
  const record = objectRecord(value);
  if (
    !record ||
    !hasOnlyKeys(record, [
      "access_token",
      "expires_in",
      "refresh_token_expires_in",
      "scope",
      "token_type",
    ]) ||
    !boundedUtf8(record.access_token, 1, MAX_ACCESS_TOKEN_BYTES) ||
    !validTokenLifetime(record.expires_in) ||
    (record.refresh_token_expires_in !== undefined && (
      !Number.isSafeInteger(record.refresh_token_expires_in) ||
      (record.refresh_token_expires_in as number) < 1 ||
      (record.refresh_token_expires_in as number) > MAX_REFRESH_TOKEN_LIFETIME_SECONDS
    )) ||
    record.token_type !== "Bearer"
  ) {
    throw oauthError("DRIVE_PROVIDER_REJECTED");
  }
  if (record.scope !== undefined) {
    const scopes = parseScopes(record.scope);
    if (!scopes || scopes.length !== 1 || scopes[0] !== DRIVE_FILE_SCOPE) {
      throw oauthError("OAUTH_SCOPE_REJECTED", 400);
    }
  }
  return record.access_token;
}

export function createGoogleOAuthAdapter(options: GoogleOAuthOptions): DriveOAuthPort {
  if (
    !boundedUtf8(options.clientId, 1, 512) ||
    !boundedUtf8(options.clientSecret, 1, MAX_REFRESH_TOKEN_BYTES) ||
    (options.fetcher !== undefined && typeof options.fetcher !== "function")
  ) {
    throw oauthError("DRIVE_PROVIDER_REJECTED");
  }
  const fetcher = options.fetcher ?? fetch;

  async function tokenRequest(
    form: URLSearchParams,
    timeoutMs: number,
  ): Promise<unknown> {
    return googleJson(fetcher, TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    }, {
      timeoutMs,
      maxResponseBytes: OAUTH_RESPONSE_BYTES,
      attempts: OAUTH_ATTEMPTS,
    });
  }

  return {
    buildAuthorizationUrl(input) {
      validateRedirectUri(input.redirectUri);
      if (!boundedUtf8(input.state, 1, 256)) throw oauthError("OAUTH_STATE_INVALID", 400);

      const url = new URL(AUTHORIZATION_ENDPOINT);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", options.clientId);
      url.searchParams.set("redirect_uri", input.redirectUri);
      url.searchParams.set("scope", DRIVE_FILE_SCOPE);
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
      url.searchParams.set("include_granted_scopes", "false");
      url.searchParams.set("state", input.state);
      return url.toString();
    },

    async exchangeCode(input) {
      validateRedirectUri(input.redirectUri);
      if (!boundedUtf8(input.code, 1, 4_096)) throw oauthError("DRIVE_PROVIDER_REJECTED");
      const form = new URLSearchParams({
        code: input.code,
        client_id: options.clientId,
        client_secret: options.clientSecret,
        redirect_uri: input.redirectUri,
        grant_type: "authorization_code",
      });
      return validateExchangeResponse(await tokenRequest(form, input.timeoutMs));
    },

    async refreshAccessToken(refreshToken, timeoutMs) {
      if (!boundedUtf8(refreshToken, 1, MAX_REFRESH_TOKEN_BYTES)) {
        throw oauthError("DRIVE_REAUTH_REQUIRED", 401);
      }
      const form = new URLSearchParams({
        refresh_token: refreshToken,
        client_id: options.clientId,
        client_secret: options.clientSecret,
        grant_type: "refresh_token",
      });
      return validateRefreshResponse(await tokenRequest(form, timeoutMs));
    },

    async revokeRefreshToken(refreshToken, timeoutMs) {
      if (!boundedUtf8(refreshToken, 1, MAX_REFRESH_TOKEN_BYTES)) {
        throw oauthError("DRIVE_REAUTH_REQUIRED", 401);
      }
      try {
        await googleJson(fetcher, REVOCATION_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: refreshToken }),
        }, {
          timeoutMs,
          maxResponseBytes: OAUTH_RESPONSE_BYTES,
          attempts: OAUTH_ATTEMPTS,
          acceptInvalidTokenAsRevoked: true,
        });
        return "REVOKED";
      } catch (error) {
        if (
          error instanceof AppError &&
          (error.code === "DRIVE_RATE_LIMITED" || error.code === "DRIVE_TEMPORARILY_UNAVAILABLE")
        ) {
          return "RETRYABLE";
        }
        throw error;
      }
    },
  };
}
