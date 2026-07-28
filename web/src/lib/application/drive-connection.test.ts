import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DRIVE_FILE_SCOPE } from "@/lib/domain/drive";
import { AppError } from "@/lib/domain/errors";
import { createCredentialCipher, DRIVE_CIPHER_PROFILE } from "@/lib/security/credential-cipher";
import { issueOAuthState } from "@/lib/security/oauth-state";
import { FakeDriveControlPlaneRepository } from "@/test/fakes/fake-drive-control-plane";
import { FakeGoogleDriveFiles, FakeGoogleDriveOAuth } from "@/test/fakes/fake-google-drive";
import { createGoogleOAuthAdapter } from "@/lib/adapters/google/oauth";
import {
  beginDriveConnection,
  completeDriveConnection,
  consumeDriveConnectionState,
  disconnectDrive,
} from "./drive-connection";

const NOW = new Date("2026-07-19T00:00:00.000Z");
const STATE_SECRET = "state-secret-".repeat(8);
const CALLBACK = "https://control.example/api/v1/drive/callback";
const TOKEN_KEY = Buffer.alloc(32, 7).toString("base64url");
const NONCE = Buffer.alloc(32, 3);

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function callbackState(repository: FakeDriveControlPlaneRepository, now = NOW) {
  const nonce = NONCE.toString("base64url");
  await repository.saveOAuthNonce(sha256(NONCE), new Date(now.getTime() + 600_000));
  return issueOAuthState(STATE_SECRET, now, nonce);
}

function dependencies(repository = new FakeDriveControlPlaneRepository(() => NOW)) {
  return {
    repository,
    oauth: new FakeGoogleDriveOAuth(),
    files: new FakeGoogleDriveFiles(),
    cipher: createCredentialCipher(TOKEN_KEY, DRIVE_CIPHER_PROFILE),
  };
}

async function seedContent(repository: FakeDriveControlPlaneRepository) {
  await repository.reserveProject({
    idempotencyKeyHash: "a".repeat(64),
    requestHash: "b".repeat(64),
    name: "Existing",
  });
}

describe("beginDriveConnection", () => {
  it("generates exactly 32 random bytes, stores only their hash, and audits safely", async () => {
    const deps = dependencies();
    const random = vi.fn((size: number) => {
      expect(size).toBe(32);
      return NONCE;
    });

    const result = await beginDriveConnection({
      redirectUri: CALLBACK,
      stateSecret: STATE_SECRET,
      now: NOW,
    }, { ...deps, randomBytes: random });

    expect(random).toHaveBeenCalledOnce();
    expect(result).toEqual({ authorizationUrl: deps.oauth.buildAuthorizationUrl({
      state: deps.oauth.authorizationCalls[0]!.state,
      redirectUri: CALLBACK,
    }) });
    expect(deps.oauth.authorizationCalls).toHaveLength(2);
    await expect(deps.repository.consumeOAuthNonce(sha256(NONCE), NOW)).resolves.toBe(true);
    expect(deps.repository.auditEvents).toEqual([{
      eventType: "DRIVE_CONNECT_STARTED",
      actorClass: "admin",
      payload: { status: "STARTED" },
    }]);
    const audit = JSON.stringify(deps.repository.auditEvents);
    expect(audit).not.toContain(NONCE.toString("base64url"));
    expect(audit).not.toContain(deps.oauth.authorizationCalls[0]!.state);
  });
});

describe("completeDriveConnection", () => {
  it("consumes state before provider work and rejects replay", async () => {
    const deps = dependencies();
    const state = await callbackState(deps.repository);
    await deps.repository.consumeOAuthNonce(sha256(NONCE), NOW);

    await expect(completeDriveConnection({
      state,
      code: "one-use-code",
      redirectUri: CALLBACK,
      stateSecret: STATE_SECRET,
      now: NOW,
      softPercent: 90,
    }, deps)).rejects.toMatchObject({ code: "OAUTH_STATE_REPLAYED" });
    expect(deps.oauth.exchangeCalls).toHaveLength(0);
  });

  it("rejects expired state before provider work", async () => {
    const deps = dependencies();
    const state = await callbackState(deps.repository);

    await expect(completeDriveConnection({
      state,
      code: "one-use-code",
      redirectUri: CALLBACK,
      stateSecret: STATE_SECRET,
      now: new Date(NOW.getTime() + 600_000),
      softPercent: 90,
    }, deps)).rejects.toMatchObject({ code: "OAUTH_STATE_EXPIRED" });
    expect(deps.oauth.exchangeCalls).toHaveLength(0);
  });

  it("rejects a broad scope before storing or creating a workspace", async () => {
    const deps = dependencies();
    const state = await callbackState(deps.repository);
    deps.oauth.exchangeResult = {
      refreshToken: "fake-refresh-token",
      grantedScopes: [DRIVE_FILE_SCOPE, "https://www.googleapis.com/auth/drive"],
    };

    await expect(completeDriveConnection({
      state,
      code: "one-use-code",
      redirectUri: CALLBACK,
      stateSecret: STATE_SECRET,
      now: NOW,
      softPercent: 90,
    }, deps)).rejects.toMatchObject({ code: "OAUTH_SCOPE_REJECTED" });
    await expect(deps.repository.getCredential()).resolves.toBeNull();
    expect(deps.oauth.refreshCalls).toHaveLength(0);
    expect(deps.files.ensureWorkspaceCalls).toHaveLength(0);
  });

  it("rejects a missing refresh token before any durable replacement", async () => {
    const deps = dependencies();
    const state = await callbackState(deps.repository);
    deps.oauth.exchangeResult = { refreshToken: "", grantedScopes: [DRIVE_FILE_SCOPE] };

    await expect(completeDriveConnection({
      state,
      code: "one-use-code",
      redirectUri: CALLBACK,
      stateSecret: STATE_SECRET,
      now: NOW,
      softPercent: 90,
    }, deps)).rejects.toMatchObject({ code: "OAUTH_REFRESH_TOKEN_MISSING" });
    await expect(deps.repository.getCredential()).resolves.toBeNull();
  });

  it("encrypts only after account/workspace validation and persists bounded quota/audit", async () => {
    const deps = dependencies();
    const state = await callbackState(deps.repository);

    await expect(completeDriveConnection({
      state,
      code: "one-use-code",
      redirectUri: CALLBACK,
      stateSecret: STATE_SECRET,
      now: NOW,
      softPercent: 90,
    }, deps)).resolves.toEqual({ status: "CONNECTED" });

    const credential = await deps.repository.getCredential();
    expect(credential).toMatchObject({
      status: "CONNECTED",
      accountHint: "f***@example.test",
      accountPermissionIdHash: sha256("fake-permission-id"),
      rootFolderId: "fake-root-folder-001",
      envelope: { scope: DRIVE_FILE_SCOPE, keyVersion: 1 },
    });
    if (!credential || credential.envelope === null) throw new Error("credential missing");
    expect(deps.cipher.decrypt("1", credential.envelope)).toBe("fake-refresh-token");
    await expect(deps.repository.getUsage("DRIVE")).resolves.toEqual({
      provider: "DRIVE",
      usedBytes: 100,
      limitBytes: 1_000,
      appManagedBytes: 0,
      mode: "READ_WRITE",
      reasonCodes: [],
      observedAt: NOW.toISOString(),
    });
    expect(deps.repository.auditEvents.at(-1)).toEqual({
      eventType: "DRIVE_CONNECTED",
      actorClass: "admin",
      payload: { keyVersion: 1, status: "CONNECTED" },
    });
    const persisted = JSON.stringify({ credential, audit: deps.repository.auditEvents });
    expect(persisted).not.toContain("fake-refresh-token");
    expect(persisted).not.toContain("fake-access-token");
    expect(persisted).not.toContain("fake-permission-id");
  });

  it("does not replace an existing workspace with a different Drive account", async () => {
    const deps = dependencies();
    await deps.repository.saveConnectedCredential({
      status: "CONNECTED",
      envelope: deps.cipher.encrypt("1", DRIVE_FILE_SCOPE, "old-refresh-token"),
      accountPermissionIdHash: sha256("original-permission-id"),
      accountHint: "o***@example.test",
      rootFolderId: "old-root-folder-001",
    });
    await seedContent(deps.repository);
    const before = await deps.repository.getCredential();
    const state = await callbackState(deps.repository);

    await expect(completeDriveConnection({
      state,
      code: "one-use-code",
      redirectUri: CALLBACK,
      stateSecret: STATE_SECRET,
      now: NOW,
      softPercent: 90,
    }, deps)).rejects.toMatchObject({ code: "DRIVE_ACCOUNT_MISMATCH" });
    await expect(deps.repository.getCredential()).resolves.toEqual(before);
    expect(deps.files.ensureWorkspaceCalls).toHaveLength(0);
  });

  it("does not replace an existing workspace when the same account resolves a different root", async () => {
    const deps = dependencies();
    await deps.repository.saveConnectedCredential({
      status: "CONNECTED",
      envelope: deps.cipher.encrypt("1", DRIVE_FILE_SCOPE, "old-refresh-token"),
      accountPermissionIdHash: sha256("fake-permission-id"),
      accountHint: "f***@example.test",
      rootFolderId: "old-root-folder-001",
    });
    await seedContent(deps.repository);
    const before = await deps.repository.getCredential();
    const state = await callbackState(deps.repository);

    await expect(completeDriveConnection({
      state,
      code: "one-use-code",
      redirectUri: CALLBACK,
      stateSecret: STATE_SECRET,
      now: NOW,
      softPercent: 90,
    }, deps)).rejects.toMatchObject({ code: "DRIVE_REMOTE_MISMATCH" });
    await expect(deps.repository.getCredential()).resolves.toEqual(before);
    expect(deps.files.ensureWorkspaceCalls).toHaveLength(1);
  });

  it("permits explicit account replacement only when no Drive content exists", async () => {
    const deps = dependencies();
    await deps.repository.saveConnectedCredential({
      status: "CONNECTED",
      envelope: deps.cipher.encrypt("1", DRIVE_FILE_SCOPE, "old-refresh-token"),
      accountPermissionIdHash: sha256("original-permission-id"),
      accountHint: "o***@example.test",
      rootFolderId: "old-root-folder-001",
    });
    const state = await callbackState(deps.repository);

    await expect(completeDriveConnection({
      state,
      code: "one-use-code",
      redirectUri: CALLBACK,
      stateSecret: STATE_SECRET,
      now: NOW,
      softPercent: 90,
    }, deps)).resolves.toEqual({ status: "CONNECTED" });
    await expect(deps.repository.getCredential()).resolves.toMatchObject({
      accountPermissionIdHash: sha256("fake-permission-id"),
      rootFolderId: "fake-root-folder-001",
    });
  });

  it("preserves a durable credential when workspace validation fails", async () => {
    const deps = dependencies();
    await deps.repository.saveConnectedCredential({
      status: "CONNECTED",
      envelope: deps.cipher.encrypt("1", DRIVE_FILE_SCOPE, "old-refresh-token"),
      accountPermissionIdHash: sha256("fake-permission-id"),
      accountHint: "f***@example.test",
      rootFolderId: "old-root-folder-001",
    });
    const before = await deps.repository.getCredential();
    deps.files.ensureWorkspaceError = new Error("DRIVE_REMOTE_MISMATCH");
    const state = await callbackState(deps.repository);

    await expect(completeDriveConnection({
      state,
      code: "one-use-code",
      redirectUri: CALLBACK,
      stateSecret: STATE_SECRET,
      now: NOW,
      softPercent: 90,
    }, deps)).rejects.toThrow("DRIVE_PROVIDER_REJECTED");
    await expect(deps.repository.getCredential()).resolves.toEqual(before);
  });
});

describe("consumeDriveConnectionState", () => {
  it("consumes a denial state once without any provider work", async () => {
    const deps = dependencies();
    const state = await callbackState(deps.repository);

    await expect(consumeDriveConnectionState({
      state,
      stateSecret: STATE_SECRET,
      now: NOW,
    }, deps.repository)).resolves.toBeUndefined();
    await expect(consumeDriveConnectionState({
      state,
      stateSecret: STATE_SECRET,
      now: NOW,
    }, deps.repository)).rejects.toMatchObject({ code: "OAUTH_STATE_REPLAYED" });
    expect(deps.oauth.exchangeCalls).toHaveLength(0);
  });
});

describe("disconnectDrive", () => {
  async function connected() {
    const deps = dependencies();
    await deps.repository.saveConnectedCredential({
      status: "CONNECTED",
      envelope: deps.cipher.encrypt("1", DRIVE_FILE_SCOPE, "fake-refresh-token"),
      accountPermissionIdHash: sha256("fake-permission-id"),
      accountHint: "f***@example.test",
      rootFolderId: "fake-root-folder-001",
    });
    return deps;
  }

  it("clears ciphertext after successful revocation without deleting Drive files", async () => {
    const deps = await connected();

    await expect(disconnectDrive({ now: NOW }, deps)).resolves.toEqual({ status: "DISCONNECTED" });
    await expect(deps.repository.getCredential()).resolves.toMatchObject({
      status: "DISCONNECTED",
      envelope: null,
    });
    expect(deps.oauth.revokeCalls).toEqual([{ refreshToken: "fake-refresh-token", timeoutMs: 5_000 }]);
    expect(deps.files.deleteFileCalls).toHaveLength(0);
    expect(deps.repository.auditEvents.at(-1)?.eventType).toBe("DRIVE_DISCONNECTED");
  });

  it("clears ciphertext when Google reports the refresh token is already invalid", async () => {
    const deps = await connected();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: "invalid_token",
      error_description: "private invalid-token provider diagnostic",
    }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }));
    const oauth = createGoogleOAuthAdapter({
      clientId: "google-client-id.apps.googleusercontent.com",
      clientSecret: "private-client-secret",
      scopes: [DRIVE_FILE_SCOPE],
      fetcher,
    });

    await expect(disconnectDrive({ now: NOW }, { ...deps, oauth }))
      .resolves.toEqual({ status: "DISCONNECTED" });
    await expect(deps.repository.getCredential()).resolves.toMatchObject({
      status: "DISCONNECTED",
      envelope: null,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("retains ciphertext only for retryable revocation", async () => {
    const deps = await connected();
    deps.oauth.revokeResult = "RETRYABLE";

    await expect(disconnectDrive({ now: NOW }, deps)).resolves.toEqual({ status: "REVOKE_PENDING" });
    await expect(deps.repository.getCredential()).resolves.toMatchObject({
      status: "REVOKE_PENDING",
      envelope: { scope: DRIVE_FILE_SCOPE },
    });
  });

  it.each(["decrypt", "invalid_grant"])(
    "clears unusable ciphertext and marks reauthentication on %s failure",
    async (failure) => {
      const deps = await connected();
      if (failure === "decrypt") {
        const credential = await deps.repository.getCredential();
        if (!credential || credential.envelope === null) throw new Error("credential missing");
        await deps.repository.saveConnectedCredential({
          ...credential,
          status: "CONNECTED",
          envelope: { ...credential.envelope, authTag: "A".repeat(22) },
        });
      } else {
        deps.oauth.revokeError = new AppError("DRIVE_REAUTH_REQUIRED", 401);
      }

      await expect(disconnectDrive({ now: NOW }, deps)).resolves.toEqual({ status: "REAUTH_REQUIRED" });
      await expect(deps.repository.getCredential()).resolves.toMatchObject({
        status: "REAUTH_REQUIRED",
        envelope: null,
      });
      expect(deps.repository.auditEvents.at(-1)?.eventType).toBe("DRIVE_REAUTH_REQUIRED");
    },
  );
});
