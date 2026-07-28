import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { DRIVE_FILE_SCOPE } from "@/lib/domain/drive";
import { AppError } from "@/lib/domain/errors";
import { createCredentialCipher, DRIVE_CIPHER_PROFILE } from "@/lib/security/credential-cipher";
import { FakeDriveControlPlaneRepository } from "@/test/fakes/fake-drive-control-plane";
import { FakeGoogleDriveOAuth } from "@/test/fakes/fake-google-drive";
import { createDriveAccessProvider } from "./drive-access";

const TOKEN_KEY = Buffer.alloc(32, 9).toString("base64url");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function connected() {
  const repository = new FakeDriveControlPlaneRepository();
  const cipher = createCredentialCipher(TOKEN_KEY, DRIVE_CIPHER_PROFILE);
  const oauth = new FakeGoogleDriveOAuth();
  await repository.saveConnectedCredential({
    status: "CONNECTED",
    envelope: cipher.encrypt("1", DRIVE_FILE_SCOPE, "fake-refresh-token"),
    accountPermissionIdHash: sha256("fake-permission-id"),
    accountHint: "f***@example.test",
    rootFolderId: "fake-root-folder-001",
  });
  return { repository, cipher, oauth };
}

describe("createDriveAccessProvider", () => {
  it("decrypts and refreshes in memory without persisting the access token", async () => {
    const deps = await connected();
    const before = await deps.repository.getCredential();

    await expect(createDriveAccessProvider(deps).getAccessToken())
      .resolves.toBe("fake-access-token");
    expect(deps.oauth.refreshCalls).toEqual([{ refreshToken: "fake-refresh-token", timeoutMs: 5_000 }]);
    await expect(deps.repository.getCredential()).resolves.toEqual(before);
    expect(JSON.stringify(await deps.repository.getCredential())).not.toContain("fake-access-token");
  });

  it.each(["DISCONNECTED", "REVOKE_PENDING"] as const)(
    "refuses access while the connection is %s",
    async (status) => {
      const deps = await connected();
      await deps.repository.setCredentialStatus(status);

      await expect(createDriveAccessProvider(deps).getAccessToken())
        .rejects.toMatchObject({ code: "DRIVE_NOT_CONNECTED" });
      expect(deps.oauth.refreshCalls).toHaveLength(0);
    },
  );

  it("returns DRIVE_REAUTH_REQUIRED for an existing reauthentication state", async () => {
    const deps = await connected();
    await deps.repository.setCredentialStatus("REAUTH_REQUIRED");

    await expect(createDriveAccessProvider(deps).getAccessToken())
      .rejects.toMatchObject({ code: "DRIVE_REAUTH_REQUIRED" });
  });

  it.each(["decrypt", "invalid_grant"])(
    "marks REAUTH_REQUIRED and clears ciphertext after %s failure",
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
        deps.oauth.refreshError = new AppError("DRIVE_REAUTH_REQUIRED", 401);
      }

      await expect(createDriveAccessProvider(deps).getAccessToken())
        .rejects.toMatchObject({ code: "DRIVE_REAUTH_REQUIRED" });
      await expect(deps.repository.getCredential()).resolves.toMatchObject({
        status: "REAUTH_REQUIRED",
        envelope: null,
      });
      expect(deps.repository.auditEvents.at(-1)?.eventType).toBe("DRIVE_REAUTH_REQUIRED");
    },
  );

  it("preserves CONNECTED on a retryable provider failure", async () => {
    const deps = await connected();
    deps.oauth.refreshError = new AppError("DRIVE_TEMPORARILY_UNAVAILABLE", 503);

    await expect(createDriveAccessProvider(deps).getAccessToken())
      .rejects.toMatchObject({ code: "DRIVE_TEMPORARILY_UNAVAILABLE" });
    await expect(deps.repository.getCredential()).resolves.toMatchObject({ status: "CONNECTED" });
  });
});
