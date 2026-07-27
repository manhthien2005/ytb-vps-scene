import "server-only";

import { createHash, randomBytes as nodeRandomBytes, randomUUID as nodeRandomUUID } from "node:crypto";
import { AppError } from "@/lib/domain/errors";
import {
  isChannelId,
  sameScopeSet,
  YOUTUBE_READONLY_SCOPE,
  YOUTUBE_SCOPES,
} from "@/lib/domain/youtube";
import type { DriveOAuthPort } from "@/lib/ports/drive";
import type { YouTubeDataPort } from "@/lib/ports/youtube";
import type { DriveControlPlaneRepository } from "@/lib/repositories/drive-control-plane";
import type {
  YouTubeChannelRecord,
  YouTubeControlPlaneRepository,
} from "@/lib/repositories/youtube-control-plane";
import type { CredentialCipher } from "@/lib/security/credential-cipher";
import { issueOAuthState, verifyOAuthState } from "@/lib/security/oauth-state";

const STATE_LIFETIME_MS = 10 * 60 * 1_000;
const PROVIDER_TIMEOUT_MS = 5_000;

type ConnectionDependencies = Readonly<{
  repository: YouTubeControlPlaneRepository;
  // The `oauth_states` table is shared with the Drive flow, so nonce storage comes
  // from that repository rather than being duplicated into the YouTube one.
  states: DriveControlPlaneRepository;
  oauth: DriveOAuthPort;
  data: YouTubeDataPort;
  cipher: CredentialCipher;
  randomUuid?: () => string;
}>;

type BeginDependencies = ConnectionDependencies & Readonly<{
  randomBytes?: (size: number) => Uint8Array;
}>;

type AccessDependencies = Readonly<{
  repository: YouTubeControlPlaneRepository;
  oauth: DriveOAuthPort;
  cipher: CredentialCipher;
}>;

type BeginYouTubeConnectionInput = Readonly<{
  redirectUri: string;
  stateSecret: string;
  now: Date;
}>;

type CompleteYouTubeConnectionInput = BeginYouTubeConnectionInput & Readonly<{
  state: string;
  code: string;
}>;

type DisconnectYouTubeChannelInput = Readonly<{ id: string; now: Date }>;

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function validNow(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function providerRejected(): AppError {
  return new AppError("YOUTUBE_PROVIDER_REJECTED", 502);
}

function reauthenticationRequired(): AppError {
  return new AppError("YOUTUBE_REAUTH_REQUIRED", 401);
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

function validGoogleAccessToken(token: unknown): token is string {
  return (
    typeof token === "string" &&
    token.length >= 1 &&
    token.length <= 8_192 &&
    /^[\x21-\x7E]+$/.test(token)
  );
}

async function markReauthentication(
  repository: YouTubeControlPlaneRepository,
  id: string,
): Promise<void> {
  await repository.setChannelStatus(id, "REAUTH_REQUIRED");
  await repository.recordAudit({
    eventType: "YOUTUBE_REAUTH_REQUIRED",
    targetId: id,
    payload: { reasonCode: "YOUTUBE_REAUTH_REQUIRED", status: "REAUTH_REQUIRED" },
  });
}

export async function beginYouTubeConnection(
  input: BeginYouTubeConnectionInput,
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
  await dependencies.states.saveOAuthNonce(
    hashBytes(nonceBytes),
    new Date(input.now.getTime() + STATE_LIFETIME_MS),
  );
  const authorizationUrl = dependencies.oauth.buildAuthorizationUrl({
    state,
    redirectUri: input.redirectUri,
  });
  await dependencies.repository.recordAudit({
    eventType: "YOUTUBE_CONNECT_STARTED",
    payload: { status: "STARTED" },
  });
  return { authorizationUrl };
}

export async function consumeYouTubeConnectionState(
  input: Readonly<{ state: string; stateSecret: string; now: Date }>,
  states: DriveControlPlaneRepository,
): Promise<void> {
  if (!validNow(input.now)) throw new AppError("OAUTH_STATE_INVALID", 400);
  const state = verifyOAuthState(input.stateSecret, input.state, input.now);
  const nonceBytes = Buffer.from(state.nonce, "base64url");
  const consumed = await states.consumeOAuthNonce(hashBytes(nonceBytes), input.now);
  if (!consumed) throw new AppError("OAUTH_STATE_REPLAYED", 400);
}

export async function completeYouTubeConnection(
  input: CompleteYouTubeConnectionInput,
  dependencies: ConnectionDependencies,
): Promise<Readonly<{ id: string; channelId: string; title: string }>> {
  if (!validNow(input.now)) throw new AppError("INVALID_REQUEST", 400);

  await consumeYouTubeConnectionState(input, dependencies.states);

  const exchanged = await providerCall(() => dependencies.oauth.exchangeCode({
    code: input.code,
    redirectUri: input.redirectUri,
    timeoutMs: PROVIDER_TIMEOUT_MS,
  }));
  if (!validBoundedText(exchanged.refreshToken, 1, 4_096)) {
    throw new AppError("OAUTH_REFRESH_TOKEN_MISSING", 400);
  }
  // Order-insensitive set equality: the grant must be neither narrower nor wider
  // than the two read-only scopes. A wider grant is the dangerous direction — it
  // would mean this app holds a write capability it never asked for.
  if (!sameScopeSet(exchanged.grantedScopes, YOUTUBE_SCOPES)) {
    throw new AppError("OAUTH_SCOPE_REJECTED", 400);
  }

  const accessToken = await providerCall(() => dependencies.oauth.refreshAccessToken(
    exchanged.refreshToken,
    PROVIDER_TIMEOUT_MS,
  ));
  if (!validGoogleAccessToken(accessToken)) throw providerRejected();

  const profile = await providerCall(() => dependencies.data.inspectMyChannel(accessToken));
  if (
    !isChannelId(profile.channelId) ||
    !validBoundedText(profile.title, 1, 160) ||
    profile.title.trim() !== profile.title
  ) {
    throw providerRejected();
  }

  const existing = await dependencies.repository.getChannelByChannelId(profile.channelId);
  const candidateId = existing?.id ?? (dependencies.randomUuid ?? nodeRandomUUID)();

  // Two writes, deliberately. The upsert keys on channel_id, so the id that ends up
  // authoritative may not be the one offered — a concurrent connect can win the row
  // between the lookup and the insert. The envelope's AAD binds it to a specific id,
  // so it is encrypted only after the repository reports which id it actually kept;
  // encrypting under a guess would leave the channel permanently undecryptable.
  const savedId = await dependencies.repository.saveConnectedChannel({
    id: candidateId,
    channelId: profile.channelId,
    title: profile.title,
    avatarUrl: profile.avatarUrl,
    publishedAt: profile.publishedAt,
    envelope: dependencies.cipher.encrypt(
      candidateId,
      YOUTUBE_READONLY_SCOPE,
      exchanged.refreshToken,
    ),
  });
  if (savedId !== candidateId) {
    await dependencies.repository.saveConnectedChannel({
      id: savedId,
      channelId: profile.channelId,
      title: profile.title,
      avatarUrl: profile.avatarUrl,
      publishedAt: profile.publishedAt,
      envelope: dependencies.cipher.encrypt(
        savedId,
        YOUTUBE_READONLY_SCOPE,
        exchanged.refreshToken,
      ),
    });
  }

  await dependencies.repository.recordAudit({
    eventType: "YOUTUBE_CONNECTED",
    targetId: savedId,
    payload: { status: "CONNECTED", keyVersion: 1 },
  });
  return { id: savedId, channelId: profile.channelId, title: profile.title };
}

/**
 * Turns a stored channel credential into a live access token.
 *
 * Takes the record rather than an id so callers that already loaded the channel do
 * not pay for a second read. A credential that cannot be decrypted or that the
 * provider refuses is demoted to REAUTH_REQUIRED, which is what surfaces the
 * reconnect prompt in the UI instead of a silent, permanently failing refresh.
 */
export async function youtubeAccessToken(
  channel: YouTubeChannelRecord,
  dependencies: AccessDependencies,
): Promise<string> {
  if (channel.status === "REAUTH_REQUIRED") throw reauthenticationRequired();
  if (channel.status !== "CONNECTED" || channel.envelope === null) {
    throw new AppError("YOUTUBE_NOT_CONNECTED", 409);
  }

  let refreshToken: string;
  try {
    refreshToken = dependencies.cipher.decrypt(channel.id, channel.envelope);
  } catch {
    await markReauthentication(dependencies.repository, channel.id);
    throw reauthenticationRequired();
  }

  try {
    const accessToken = await dependencies.oauth.refreshAccessToken(
      refreshToken,
      PROVIDER_TIMEOUT_MS,
    );
    if (!validGoogleAccessToken(accessToken)) throw providerRejected();
    return accessToken;
  } catch (error) {
    // A rejected grant is a reconnect, not an outage: the stored refresh token is
    // either revoked or no longer covers the scope set this app requests.
    if (
      error instanceof AppError &&
      (error.code === "DRIVE_REAUTH_REQUIRED" ||
        error.code === "YOUTUBE_REAUTH_REQUIRED" ||
        error.code === "OAUTH_SCOPE_REJECTED")
    ) {
      await markReauthentication(dependencies.repository, channel.id);
      throw reauthenticationRequired();
    }
    if (error instanceof AppError) throw error;
    throw providerRejected();
  }
}

export async function disconnectYouTubeChannel(
  input: DisconnectYouTubeChannelInput,
  dependencies: ConnectionDependencies,
): Promise<Readonly<{ status: "DISCONNECTED" }>> {
  if (!validNow(input.now)) throw new AppError("INVALID_REQUEST", 400);
  const channel = await dependencies.repository.getChannel(input.id);
  if (!channel) throw new AppError("YOUTUBE_CHANNEL_NOT_FOUND", 404);
  if (channel.status === "DISCONNECTED") return { status: "DISCONNECTED" };

  let refreshToken: string | null = null;
  if (channel.envelope !== null) {
    try {
      refreshToken = dependencies.cipher.decrypt(channel.id, channel.envelope);
    } catch {
      // An undecryptable token can never be revoked. Refusing to disconnect would
      // strand the row as CONNECTED forever, so clear it locally instead.
      refreshToken = null;
    }
  }

  if (refreshToken !== null) {
    const revocable = refreshToken;
    const outcome = await providerCall(() => dependencies.oauth.revokeRefreshToken(
      revocable,
      PROVIDER_TIMEOUT_MS,
    ));
    // RETRYABLE means Google may still honour the grant. Clearing the row now would
    // destroy the only copy of the token, leaving a live grant nothing can revoke.
    if (outcome !== "REVOKED") throw providerRejected();
  }

  await dependencies.repository.setChannelStatus(input.id, "DISCONNECTED");
  await dependencies.repository.recordAudit({
    eventType: "YOUTUBE_DISCONNECTED",
    targetId: input.id,
    payload: { status: "DISCONNECTED" },
  });
  return { status: "DISCONNECTED" };
}
