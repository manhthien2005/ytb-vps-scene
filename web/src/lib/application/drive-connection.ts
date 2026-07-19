import "server-only";

import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { DRIVE_FILE_SCOPE } from "@/lib/domain/drive";
import { AppError } from "@/lib/domain/errors";
import type { DriveFilesPort, DriveOAuthPort } from "@/lib/ports/drive";
import type { DriveControlPlaneRepository } from "@/lib/repositories/drive-control-plane";
import type { CredentialCipher } from "@/lib/security/credential-cipher";
import { issueOAuthState, verifyOAuthState } from "@/lib/security/oauth-state";

const STATE_LIFETIME_MS = 10 * 60 * 1_000;
const PROVIDER_TIMEOUT_MS = 5_000;
const CREDENTIAL_ID = "1";

type ConnectionDependencies = Readonly<{
  repository: DriveControlPlaneRepository;
  oauth: DriveOAuthPort;
  files: DriveFilesPort;
  cipher: CredentialCipher;
}>;

type BeginDependencies = ConnectionDependencies & Readonly<{
  randomBytes?: (size: number) => Uint8Array;
}>;

type BeginDriveConnectionInput = Readonly<{
  redirectUri: string;
  stateSecret: string;
  now: Date;
}>;

type CompleteDriveConnectionInput = BeginDriveConnectionInput & Readonly<{
  state: string;
  code: string;
  softPercent: number;
}>;

type DisconnectDriveInput = Readonly<{ now: Date }>;

type ConsumeDriveConnectionStateInput = Readonly<{
  state: string;
  stateSecret: string;
  now: Date;
}>;

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validNow(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function providerRejected(): AppError {
  return new AppError("DRIVE_PROVIDER_REJECTED", 502);
}

async function providerCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw providerRejected();
  }
}

function validBoundedText(value: unknown, minimum: number, maximum: number): value is string {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") >= minimum &&
    Buffer.byteLength(value, "utf8") <= maximum
  );
}

async function recordReauthentication(repository: DriveControlPlaneRepository): Promise<void> {
  await repository.setCredentialStatus("REAUTH_REQUIRED");
  await repository.recordAudit({
    eventType: "DRIVE_REAUTH_REQUIRED",
    actorClass: "admin",
    payload: { reasonCode: "DRIVE_REAUTH_REQUIRED", status: "REAUTH_REQUIRED" },
  });
}

export async function beginDriveConnection(
  input: BeginDriveConnectionInput,
  dependencies: BeginDependencies,
): Promise<Readonly<{ authorizationUrl: string }>> {
  if (!validNow(input.now)) throw new AppError("OAUTH_STATE_INVALID", 400);
  const random = dependencies.randomBytes ?? nodeRandomBytes;
  const nonceBytes = random(32);
  if (!ArrayBuffer.isView(nonceBytes) || nonceBytes.byteLength !== 32) {
    throw new AppError("OAUTH_STATE_INVALID", 400);
  }
  const nonce = Buffer.from(nonceBytes).toString("base64url");
  const state = issueOAuthState(input.stateSecret, input.now, nonce);
  await dependencies.repository.saveOAuthNonce(
    hashBytes(nonceBytes),
    new Date(input.now.getTime() + STATE_LIFETIME_MS),
  );
  const authorizationUrl = dependencies.oauth.buildAuthorizationUrl({
    state,
    redirectUri: input.redirectUri,
  });
  await dependencies.repository.recordAudit({
    eventType: "DRIVE_CONNECT_STARTED",
    actorClass: "admin",
    payload: { status: "STARTED" },
  });
  return { authorizationUrl };
}

export async function consumeDriveConnectionState(
  input: ConsumeDriveConnectionStateInput,
  repository: DriveControlPlaneRepository,
): Promise<void> {
  if (!validNow(input.now)) throw new AppError("OAUTH_STATE_INVALID", 400);
  const state = verifyOAuthState(input.stateSecret, input.state, input.now);
  const nonceBytes = Buffer.from(state.nonce, "base64url");
  const consumed = await repository.consumeOAuthNonce(hashBytes(nonceBytes), input.now);
  if (!consumed) throw new AppError("OAUTH_STATE_REPLAYED", 400);
}

export async function completeDriveConnection(
  input: CompleteDriveConnectionInput,
  dependencies: ConnectionDependencies,
): Promise<Readonly<{ status: "CONNECTED" }>> {
  if (
    !validNow(input.now) ||
    !Number.isSafeInteger(input.softPercent) ||
    input.softPercent < 50 ||
    input.softPercent > 90
  ) {
    throw new AppError("INVALID_REQUEST", 400);
  }

  await consumeDriveConnectionState(input, dependencies.repository);

  const exchanged = await providerCall(() => dependencies.oauth.exchangeCode({
    code: input.code,
    redirectUri: input.redirectUri,
    timeoutMs: PROVIDER_TIMEOUT_MS,
  }));
  if (!validBoundedText(exchanged.refreshToken, 1, 4_096)) {
    throw new AppError("OAUTH_REFRESH_TOKEN_MISSING", 400);
  }
  if (
    !Array.isArray(exchanged.grantedScopes) ||
    exchanged.grantedScopes.length !== 1 ||
    exchanged.grantedScopes[0] !== DRIVE_FILE_SCOPE
  ) {
    throw new AppError("OAUTH_SCOPE_REJECTED", 400);
  }

  const accessToken = await providerCall(() => dependencies.oauth.refreshAccessToken(
    exchanged.refreshToken,
    PROVIDER_TIMEOUT_MS,
  ));
  if (!validBoundedText(accessToken, 1, 8_192)) throw providerRejected();
  const account = await providerCall(() => dependencies.files.inspectAccount(accessToken));
  if (
    !validBoundedText(account.permissionId, 1, 256) ||
    !validBoundedText(account.accountHint, 1, 255) ||
    !account.accountHint.includes("*") ||
    !Number.isSafeInteger(account.usedBytes) ||
    account.usedBytes < 0 ||
    !Number.isSafeInteger(account.limitBytes) ||
    account.limitBytes < 1 ||
    account.usedBytes > account.limitBytes
  ) {
    throw providerRejected();
  }
  const permissionHash = hashText(account.permissionId);
  const existing = await dependencies.repository.getCredential();
  if (
    await dependencies.repository.hasDriveContent() &&
    existing?.accountPermissionIdHash !== permissionHash
  ) {
    throw new AppError("DRIVE_ACCOUNT_MISMATCH", 409);
  }

  const workspace = await providerCall(() => dependencies.files.ensureWorkspace(accessToken));
  if (!validBoundedText(workspace.rootFolderId, 10, 256)) throw providerRejected();
  const appManagedBytes = await dependencies.repository.appManagedDriveBytes();
  if (!Number.isSafeInteger(appManagedBytes) || appManagedBytes < 0) throw providerRejected();

  const highStorage = (
    BigInt(account.usedBytes) * 100n >=
    BigInt(account.limitBytes) * BigInt(input.softPercent)
  );
  const envelope = dependencies.cipher.encrypt(
    CREDENTIAL_ID,
    DRIVE_FILE_SCOPE,
    exchanged.refreshToken,
  );
  await dependencies.repository.saveConnectedCredential({
    status: "CONNECTED",
    envelope,
    accountPermissionIdHash: permissionHash,
    accountHint: account.accountHint,
    rootFolderId: workspace.rootFolderId,
  });
  await dependencies.repository.saveUsage({
    provider: "DRIVE",
    usedBytes: account.usedBytes,
    limitBytes: account.limitBytes,
    appManagedBytes,
    mode: highStorage ? "READ_ONLY" : "READ_WRITE",
    reasonCodes: highStorage ? ["DRIVE_STORAGE_HIGH"] : [],
    observedAt: input.now.toISOString(),
  });
  await dependencies.repository.recordAudit({
    eventType: "DRIVE_CONNECTED",
    actorClass: "admin",
    payload: { keyVersion: envelope.keyVersion, status: "CONNECTED" },
  });
  return { status: "CONNECTED" };
}

export async function disconnectDrive(
  input: DisconnectDriveInput,
  dependencies: ConnectionDependencies,
): Promise<Readonly<{ status: "DISCONNECTED" | "REAUTH_REQUIRED" | "REVOKE_PENDING" }>> {
  if (!validNow(input.now)) throw new AppError("INVALID_REQUEST", 400);
  const credential = await dependencies.repository.getCredential();
  if (!credential || credential.status === "DISCONNECTED") return { status: "DISCONNECTED" };
  if (credential.status === "REAUTH_REQUIRED") return { status: "REAUTH_REQUIRED" };
  if (credential.envelope === null) {
    await recordReauthentication(dependencies.repository);
    return { status: "REAUTH_REQUIRED" };
  }

  let refreshToken: string;
  try {
    refreshToken = dependencies.cipher.decrypt(CREDENTIAL_ID, credential.envelope);
  } catch {
    await recordReauthentication(dependencies.repository);
    return { status: "REAUTH_REQUIRED" };
  }

  let outcome: "REVOKED" | "RETRYABLE";
  try {
    outcome = await dependencies.oauth.revokeRefreshToken(refreshToken, PROVIDER_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof AppError && error.code === "DRIVE_REAUTH_REQUIRED") {
      await recordReauthentication(dependencies.repository);
      return { status: "REAUTH_REQUIRED" };
    }
    if (error instanceof AppError) throw error;
    throw providerRejected();
  }

  if (outcome === "RETRYABLE") {
    await dependencies.repository.setCredentialStatus("REVOKE_PENDING");
    return { status: "REVOKE_PENDING" };
  }
  if (outcome !== "REVOKED") throw providerRejected();
  await dependencies.repository.setCredentialStatus("DISCONNECTED");
  await dependencies.repository.recordAudit({
    eventType: "DRIVE_DISCONNECTED",
    actorClass: "admin",
    payload: { status: "DISCONNECTED" },
  });
  return { status: "DISCONNECTED" };
}
