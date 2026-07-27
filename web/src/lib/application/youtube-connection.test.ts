import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/domain/errors";
import {
  YOUTUBE_READONLY_SCOPE,
  YOUTUBE_SCOPES,
  YT_ANALYTICS_READONLY_SCOPE,
} from "@/lib/domain/youtube";
import type { YouTubeChannelRecord } from "@/lib/repositories/youtube-control-plane";
import {
  createCredentialCipher,
  YOUTUBE_CIPHER_PROFILE,
} from "@/lib/security/credential-cipher";
import { issueOAuthState } from "@/lib/security/oauth-state";
import { FakeDriveControlPlaneRepository } from "@/test/fakes/fake-drive-control-plane";
import { FakeYouTubeControlPlaneRepository } from "@/test/fakes/fake-youtube-control-plane";
import { FakeYouTubeData, FakeYouTubeOAuth } from "@/test/fakes/fake-youtube";
import {
  beginYouTubeConnection,
  completeYouTubeConnection,
  disconnectYouTubeChannel,
  youtubeAccessToken,
} from "./youtube-connection";

const NOW = new Date("2026-07-27T00:00:00.000Z");
const STATE_SECRET = "youtube-state-secret-".repeat(4);
const CALLBACK = "https://control.example/api/v1/youtube/callback";
const TOKEN_KEY = Buffer.alloc(32, 11).toString("base64url");
const NONCE = Buffer.alloc(32, 5);
const CHANNEL_UUID = "10000000-0000-4000-8000-000000000001";
const CHANNEL_ID = "UCabcdefghijklmnopqrstuv";
const REFRESH_TOKEN = "fake-youtube-refresh-token";

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function cipher() {
  return createCredentialCipher(TOKEN_KEY, YOUTUBE_CIPHER_PROFILE);
}

function dependencies() {
  return {
    repository: new FakeYouTubeControlPlaneRepository(),
    states: new FakeDriveControlPlaneRepository(() => NOW),
    oauth: new FakeYouTubeOAuth(),
    data: new FakeYouTubeData(),
    cipher: cipher(),
    randomUuid: () => CHANNEL_UUID,
  };
}

async function callbackState(states: FakeDriveControlPlaneRepository, now = NOW) {
  await states.saveOAuthNonce(sha256(NONCE), new Date(now.getTime() + 600_000));
  return issueOAuthState(STATE_SECRET, now, NONCE.toString("base64url"));
}

function connectedChannel(
  overrides: Partial<YouTubeChannelRecord> = {},
): YouTubeChannelRecord {
  return {
    id: CHANNEL_UUID,
    channelId: CHANNEL_ID,
    title: "Kênh thử",
    avatarUrl: null,
    publishedAt: null,
    status: "CONNECTED",
    envelope: cipher().encrypt(CHANNEL_UUID, YOUTUBE_READONLY_SCOPE, REFRESH_TOKEN),
    titlePrompt: null,
    descriptionPrompt: null,
    descriptionTemplate: null,
    defaultTags: [],
    thumbnailPromptTemplate: null,
    ...overrides,
  };
}

describe("beginYouTubeConnection", () => {
  it("stores only the nonce hash and audits without leaking the state token", async () => {
    const deps = dependencies();
    const random = vi.fn((size: number) => {
      expect(size).toBe(32);
      return NONCE;
    });

    const result = await beginYouTubeConnection({
      redirectUri: CALLBACK,
      stateSecret: STATE_SECRET,
      now: NOW,
    }, { ...deps, randomBytes: random });

    expect(random).toHaveBeenCalledOnce();
    expect(deps.oauth.authorizationCalls).toHaveLength(1);
    expect(result.authorizationUrl).toContain("state=");
    await expect(deps.states.consumeOAuthNonce(sha256(NONCE), NOW)).resolves.toBe(true);
    expect(deps.repository.auditEvents).toEqual([{
      eventType: "YOUTUBE_CONNECT_STARTED",
      payload: { status: "STARTED" },
    }]);
    const audit = JSON.stringify(deps.repository.auditEvents);
    expect(audit).not.toContain(NONCE.toString("base64url"));
    expect(audit).not.toContain(deps.oauth.authorizationCalls[0]!.state);
  });
});

describe("completeYouTubeConnection", () => {
  it("rejects a grant that is missing one of the two scopes", async () => {
    const deps = dependencies();
    const state = await callbackState(deps.states);
    deps.oauth.exchangeResult = {
      refreshToken: REFRESH_TOKEN,
      grantedScopes: [YOUTUBE_READONLY_SCOPE],
    };

    await expect(completeYouTubeConnection({
      state,
      code: "one-use-code",
      redirectUri: CALLBACK,
      stateSecret: STATE_SECRET,
      now: NOW,
    }, deps)).rejects.toMatchObject({ code: "OAUTH_SCOPE_REJECTED" });

    expect(deps.oauth.refreshCalls).toHaveLength(0);
    expect(deps.data.inspectCalls).toHaveLength(0);
    expect(deps.repository.savedChannels).toHaveLength(0);
  });

  it("rejects a grant that is wider than the two scopes", async () => {
    const deps = dependencies();
    const state = await callbackState(deps.states);
    deps.oauth.exchangeResult = {
      refreshToken: REFRESH_TOKEN,
      grantedScopes: [
        YOUTUBE_READONLY_SCOPE,
        YT_ANALYTICS_READONLY_SCOPE,
        "https://www.googleapis.com/auth/youtube.upload",
      ],
    };

    await expect(completeYouTubeConnection({
      state,
      code: "one-use-code",
      redirectUri: CALLBACK,
      stateSecret: STATE_SECRET,
      now: NOW,
    }, deps)).rejects.toMatchObject({ code: "OAUTH_SCOPE_REJECTED" });
    expect(deps.repository.savedChannels).toHaveLength(0);
  });

  it("rejects a replayed state before any provider work", async () => {
    const deps = dependencies();
    const state = await callbackState(deps.states);
    await deps.states.consumeOAuthNonce(sha256(NONCE), NOW);

    await expect(completeYouTubeConnection({
      state,
      code: "one-use-code",
      redirectUri: CALLBACK,
      stateSecret: STATE_SECRET,
      now: NOW,
    }, deps)).rejects.toMatchObject({ code: "OAUTH_STATE_REPLAYED" });

    expect(deps.oauth.exchangeCalls).toHaveLength(0);
    expect(deps.repository.savedChannels).toHaveLength(0);
  });

  it("rejects a missing refresh token before storing anything", async () => {
    const deps = dependencies();
    const state = await callbackState(deps.states);
    deps.oauth.exchangeResult = { refreshToken: "", grantedScopes: [...YOUTUBE_SCOPES] };

    await expect(completeYouTubeConnection({
      state,
      code: "one-use-code",
      redirectUri: CALLBACK,
      stateSecret: STATE_SECRET,
      now: NOW,
    }, deps)).rejects.toMatchObject({ code: "OAUTH_REFRESH_TOKEN_MISSING" });
    expect(deps.repository.savedChannels).toHaveLength(0);
  });

  it("stores the channel identified by channels.list mine=true, keyed to its own uuid", async () => {
    const deps = dependencies();
    const state = await callbackState(deps.states);

    const result = await completeYouTubeConnection({
      state,
      code: "one-use-code",
      redirectUri: CALLBACK,
      stateSecret: STATE_SECRET,
      now: NOW,
    }, deps);

    expect(result).toEqual({ id: CHANNEL_UUID, channelId: CHANNEL_ID, title: "Kênh thử" });
    expect(deps.data.inspectCalls).toEqual([deps.oauth.accessToken]);
    expect(deps.repository.savedChannels).toHaveLength(1);
    const saved = deps.repository.savedChannels[0]!;
    expect(saved).toMatchObject({
      id: CHANNEL_UUID,
      channelId: CHANNEL_ID,
      title: "Kênh thử",
      avatarUrl: "https://yt3.example/avatar.jpg",
      publishedAt: "2024-01-02T03:04:05Z",
    });

    // The envelope is bound to the row uuid, not to a shared constant: decrypting
    // it under any other id must fail, which is what keeps one channel's stored
    // token from being readable in another channel's context.
    expect(cipher().decrypt(CHANNEL_UUID, saved.envelope)).toBe(REFRESH_TOKEN);
    expect(() => cipher().decrypt("20000000-0000-4000-8000-000000000002", saved.envelope))
      .toThrow("CREDENTIAL_UNAVAILABLE");
  });

  it("audits the connection without recording the token or the raw channel id", async () => {
    const deps = dependencies();
    const state = await callbackState(deps.states);

    await completeYouTubeConnection({
      state,
      code: "one-use-code",
      redirectUri: CALLBACK,
      stateSecret: STATE_SECRET,
      now: NOW,
    }, deps);

    expect(deps.repository.auditEvents).toEqual([{
      eventType: "YOUTUBE_CONNECTED",
      targetId: CHANNEL_UUID,
      payload: { status: "CONNECTED", keyVersion: 1 },
    }]);
    const audit = JSON.stringify(deps.repository.auditEvents);
    expect(audit).not.toContain(REFRESH_TOKEN);
    expect(audit).not.toContain(CHANNEL_ID);
  });

  it("reconnecting the same channel reuses the existing row rather than duplicating", async () => {
    const deps = dependencies();
    deps.repository.seed(connectedChannel({ title: "Tên cũ" }));
    const state = await callbackState(deps.states);

    const result = await completeYouTubeConnection({
      state,
      code: "one-use-code",
      redirectUri: CALLBACK,
      stateSecret: STATE_SECRET,
      now: NOW,
    }, { ...deps, randomUuid: () => "20000000-0000-4000-8000-000000000002" });

    expect(result.id).toBe(CHANNEL_UUID);
    expect(deps.repository.savedChannels).toHaveLength(1);
    expect(deps.repository.savedChannels[0]!.id).toBe(CHANNEL_UUID);
    await expect(deps.repository.listChannels()).resolves.toHaveLength(1);
  });

  it("binds the envelope to the id the repository actually kept, not the one it was offered", async () => {
    const deps = dependencies();
    deps.repository.seed(connectedChannel());
    // The lookup misses (a concurrent connect committed after it ran), so the
    // use-case mints a fresh uuid — but the upsert still lands on the original
    // row. Only the returned id is authoritative, and the envelope must be
    // encrypted under it or the channel becomes permanently undecryptable.
    deps.repository.hideLookups = true;
    const state = await callbackState(deps.states);

    const result = await completeYouTubeConnection({
      state,
      code: "one-use-code",
      redirectUri: CALLBACK,
      stateSecret: STATE_SECRET,
      now: NOW,
    }, { ...deps, randomUuid: () => "20000000-0000-4000-8000-000000000002" });

    expect(result.id).toBe(CHANNEL_UUID);
    const stored = await deps.repository.getChannel(CHANNEL_UUID);
    expect(stored?.envelope).not.toBeNull();
    expect(cipher().decrypt(CHANNEL_UUID, stored!.envelope!)).toBe(REFRESH_TOKEN);
  });
});

describe("youtubeAccessToken", () => {
  it("exchanges the stored refresh token for an access token", async () => {
    const deps = dependencies();
    const channel = connectedChannel();
    deps.repository.seed(channel);

    await expect(youtubeAccessToken(channel, deps)).resolves.toBe(deps.oauth.accessToken);
    expect(deps.oauth.refreshCalls).toEqual([{
      refreshToken: REFRESH_TOKEN,
      timeoutMs: 5_000,
    }]);
    expect(deps.repository.statusCalls).toHaveLength(0);
  });

  it("rejects a channel that is not connected without touching the provider", async () => {
    const deps = dependencies();
    const channel = connectedChannel({ status: "DISCONNECTED", envelope: null });
    deps.repository.seed(channel);

    await expect(youtubeAccessToken(channel, deps))
      .rejects.toMatchObject({ code: "YOUTUBE_NOT_CONNECTED" });
    expect(deps.oauth.refreshCalls).toHaveLength(0);
  });

  it("marks a channel REAUTH_REQUIRED when the refresh token no longer decrypts", async () => {
    const deps = dependencies();
    // Encrypted under a different row id: the AAD no longer matches, exactly as it
    // would if the envelope were copied between channels or the key were rotated.
    const channel = connectedChannel({
      envelope: cipher().encrypt(
        "20000000-0000-4000-8000-000000000002",
        YOUTUBE_READONLY_SCOPE,
        REFRESH_TOKEN,
      ),
    });
    deps.repository.seed(channel);

    await expect(youtubeAccessToken(channel, deps))
      .rejects.toMatchObject({ code: "YOUTUBE_REAUTH_REQUIRED" });
    expect(deps.repository.statusCalls).toEqual([{
      id: CHANNEL_UUID,
      status: "REAUTH_REQUIRED",
    }]);
    expect(deps.oauth.refreshCalls).toHaveLength(0);
  });

  it("marks a channel REAUTH_REQUIRED when the provider rejects the stored grant", async () => {
    const deps = dependencies();
    const channel = connectedChannel();
    deps.repository.seed(channel);
    deps.oauth.refreshError = new AppError("OAUTH_SCOPE_REJECTED", 400);

    await expect(youtubeAccessToken(channel, deps))
      .rejects.toMatchObject({ code: "YOUTUBE_REAUTH_REQUIRED" });
    expect(deps.repository.statusCalls).toEqual([{
      id: CHANNEL_UUID,
      status: "REAUTH_REQUIRED",
    }]);
  });

  it("surfaces a provider outage as YOUTUBE_PROVIDER_REJECTED without demanding reauth", async () => {
    const deps = dependencies();
    const channel = connectedChannel();
    deps.repository.seed(channel);
    deps.oauth.refreshError = new Error("socket hang up");

    await expect(youtubeAccessToken(channel, deps))
      .rejects.toMatchObject({ code: "YOUTUBE_PROVIDER_REJECTED" });
    expect(deps.repository.statusCalls).toHaveLength(0);
  });
});

describe("disconnectYouTubeChannel", () => {
  it("revokes the refresh token before clearing the row", async () => {
    const deps = dependencies();
    deps.repository.seed(connectedChannel());

    const result = await disconnectYouTubeChannel({ id: CHANNEL_UUID, now: NOW }, deps);

    expect(result).toEqual({ status: "DISCONNECTED" });
    expect(deps.oauth.revokeCalls).toEqual([{
      refreshToken: REFRESH_TOKEN,
      timeoutMs: 5_000,
    }]);
    expect(deps.repository.statusCalls).toEqual([{
      id: CHANNEL_UUID,
      status: "DISCONNECTED",
    }]);
    await expect(deps.repository.getChannel(CHANNEL_UUID))
      .resolves.toMatchObject({ status: "DISCONNECTED", envelope: null });
    expect(deps.repository.auditEvents).toEqual([{
      eventType: "YOUTUBE_DISCONNECTED",
      targetId: CHANNEL_UUID,
      payload: { status: "DISCONNECTED" },
    }]);
  });

  it("rejects an unknown channel", async () => {
    const deps = dependencies();
    await expect(disconnectYouTubeChannel({ id: CHANNEL_UUID, now: NOW }, deps))
      .rejects.toMatchObject({ code: "YOUTUBE_CHANNEL_NOT_FOUND" });
    expect(deps.oauth.revokeCalls).toHaveLength(0);
  });

  it("is idempotent for a channel that is already disconnected", async () => {
    const deps = dependencies();
    deps.repository.seed(connectedChannel({ status: "DISCONNECTED", envelope: null }));

    await expect(disconnectYouTubeChannel({ id: CHANNEL_UUID, now: NOW }, deps))
      .resolves.toEqual({ status: "DISCONNECTED" });
    expect(deps.oauth.revokeCalls).toHaveLength(0);
    expect(deps.repository.statusCalls).toHaveLength(0);
  });

  it("still clears the row when the stored token cannot be decrypted", async () => {
    const deps = dependencies();
    deps.repository.seed(connectedChannel({
      envelope: cipher().encrypt(
        "20000000-0000-4000-8000-000000000002",
        YOUTUBE_READONLY_SCOPE,
        REFRESH_TOKEN,
      ),
    }));

    // An undecryptable token can never be revoked, so refusing to disconnect would
    // strand the row as CONNECTED forever. Clear it and report the outcome honestly.
    await expect(disconnectYouTubeChannel({ id: CHANNEL_UUID, now: NOW }, deps))
      .resolves.toEqual({ status: "DISCONNECTED" });
    expect(deps.oauth.revokeCalls).toHaveLength(0);
    expect(deps.repository.statusCalls).toEqual([{
      id: CHANNEL_UUID,
      status: "DISCONNECTED",
    }]);
  });

  it("keeps the channel connected when revocation is retryable", async () => {
    const deps = dependencies();
    deps.repository.seed(connectedChannel());
    deps.oauth.revokeResult = "RETRYABLE";

    await expect(disconnectYouTubeChannel({ id: CHANNEL_UUID, now: NOW }, deps))
      .rejects.toMatchObject({ code: "YOUTUBE_PROVIDER_REJECTED" });
    expect(deps.repository.statusCalls).toHaveLength(0);
    await expect(deps.repository.getChannel(CHANNEL_UUID))
      .resolves.toMatchObject({ status: "CONNECTED" });
  });
});
