import { NextRequest, NextResponse } from "next/server";
import { createGoogleDriveFilesAdapter } from "@/lib/adapters/google/drive-files";
import { createGoogleOAuthAdapter } from "@/lib/adapters/google/oauth";
import {
  completeDriveConnection,
  consumeDriveConnectionState,
} from "@/lib/application/drive-connection";
import { parseServerEnv, type ServerEnv } from "@/lib/config/env";
import { AppError, type PublicCode } from "@/lib/domain/errors";
import { HttpError, requireAdmin } from "@/lib/http/requests";
import { createNeonDriveControlPlaneRepository } from "@/lib/repositories/neon-drive-control-plane";
import { createCredentialCipher, DRIVE_CIPHER_PROFILE } from "@/lib/security/credential-cipher";
import { redactSecrets } from "@/lib/security/redact";

export const runtime = "nodejs";

const ALLOWED_FIELDS = new Set([
  "state",
  "code",
  "error",
  "scope",
  "authuser",
  "prompt",
  "iss",
  "error_description",
  "error_uri",
]);

const FIELD_LIMITS: Readonly<Record<string, number>> = {
  state: 256,
  code: 4_096,
  error: 128,
  scope: 2_048,
  authuser: 32,
  prompt: 64,
  iss: 128,
  error_description: 1_024,
  error_uri: 2_048,
};

type CallbackQuery =
  | Readonly<{ kind: "code"; state: string; code: string }>
  | Readonly<{ kind: "denial"; state: string }>;

function parseCallbackQuery(params: URLSearchParams): CallbackQuery {
  for (const key of params.keys()) {
    if (!ALLOWED_FIELDS.has(key)) throw new HttpError(400, "INVALID_REQUEST");
  }
  for (const key of ALLOWED_FIELDS) {
    const values = params.getAll(key);
    if (values.length > 1) throw new HttpError(400, "INVALID_REQUEST");
    if (values.length === 1) {
      const value = values[0]!;
      const byteLength = new TextEncoder().encode(value).byteLength;
      if (byteLength < 1 || byteLength > FIELD_LIMITS[key]!) {
        throw new HttpError(400, "INVALID_REQUEST");
      }
    }
  }

  const state = params.get("state");
  const code = params.get("code");
  const providerError = params.get("error");
  const issuer = params.get("iss");
  if (!state || (code === null) === (providerError === null)) {
    throw new HttpError(400, "INVALID_REQUEST");
  }
  if (issuer !== null && issuer !== "https://accounts.google.com") {
    throw new HttpError(400, "INVALID_REQUEST");
  }
  const successOnly = ["scope", "authuser", "prompt"];
  const errorOnly = ["error_description", "error_uri"];
  if (
    (code !== null && errorOnly.some((key) => params.has(key))) ||
    (providerError !== null && successOnly.some((key) => params.has(key)))
  ) {
    throw new HttpError(400, "INVALID_REQUEST");
  }
  return code === null ? { kind: "denial", state } : { kind: "code", state, code };
}

function redirect(env: ServerEnv, path: string): NextResponse {
  const response = NextResponse.redirect(new URL(path, env.appOrigin));
  response.headers.set("cache-control", "no-store");
  return response;
}

function errorRedirect(env: ServerEnv, code: PublicCode): NextResponse {
  return redirect(env, `/?drive_error=${code}`);
}

export async function GET(request: NextRequest) {
  const env = parseServerEnv(process.env);
  try {
    await requireAdmin(request, env.sessionSecret);
    const query = parseCallbackQuery(request.nextUrl.searchParams);
    const repository = createNeonDriveControlPlaneRepository(env.databaseUrl);
    const now = new Date();

    if (query.kind === "denial") {
      await consumeDriveConnectionState({
        state: query.state,
        stateSecret: env.sessionSecret,
        now,
      }, repository);
      return errorRedirect(env, "DRIVE_PROVIDER_REJECTED");
    }

    await completeDriveConnection({
      state: query.state,
      code: query.code,
      redirectUri: `${env.appOrigin}/api/v1/drive/callback`,
      stateSecret: env.sessionSecret,
      now,
      softPercent: env.freeTierSoftPercent,
    }, {
      repository,
      oauth: createGoogleOAuthAdapter({
        clientId: env.googleOAuthClientId,
        clientSecret: env.googleOAuthClientSecret,
      }),
      files: createGoogleDriveFilesAdapter(),
      cipher: createCredentialCipher(env.driveTokenKeyV1, DRIVE_CIPHER_PROFILE),
    });
    return redirect(env, "/?drive=connected");
  } catch (error) {
    if (error instanceof AppError) return errorRedirect(env, error.code);
    // Browser-facing OAuth flow: land the admin back in the UI instead of a raw 500 page.
    console.error("[api] unhandled error", redactSecrets(error));
    return errorRedirect(env, "DRIVE_PROVIDER_REJECTED");
  }
}
