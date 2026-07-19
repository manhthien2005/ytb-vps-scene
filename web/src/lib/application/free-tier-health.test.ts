import { describe, expect, it, vi } from "vitest";
import { createFreeTierHealthService } from "./free-tier-health";
import { AppError } from "@/lib/domain/errors";
import { FakeGoogleDriveFiles } from "@/test/fakes/fake-google-drive";
import { FakeDriveControlPlaneRepository } from "@/test/fakes/fake-drive-control-plane";

const NOW = new Date("2026-07-19T00:00:00.000Z");

describe("FreeTierHealthService", () => {
  it("allows a projection strictly below 90 percent", async () => {
    const repository = new FakeDriveControlPlaneRepository(() => NOW, 100);
    const drive = new FakeGoogleDriveFiles();
    drive.account = { ...drive.account, usedBytes: 899, limitBytes: 1_000 };
    const service = createFreeTierHealthService({
      repository,
      access: { getAccessToken: async () => "access" },
      files: drive,
      neonLimitBytes: 1_000,
      softPercent: 90,
      staleAfterSeconds: 900,
    });

    await expect(service.assertUploadAllowed(0, NOW)).resolves.toBeUndefined();
  });

  it("rejects a projection exactly at 90 percent", async () => {
    const repository = new FakeDriveControlPlaneRepository(() => NOW, 100);
    const drive = new FakeGoogleDriveFiles();
    drive.account = { ...drive.account, usedBytes: 899, limitBytes: 1_000 };
    const service = createFreeTierHealthService({
      repository,
      access: { getAccessToken: async () => "access" },
      files: drive,
      neonLimitBytes: 1_000,
      softPercent: 90,
      staleAfterSeconds: 900,
    });

    await expect(service.assertUploadAllowed(1, NOW)).rejects.toMatchObject({
      code: "DRIVE_STORAGE_HIGH",
    });
  });

  it("fails closed when quota evidence is older than 900 seconds", async () => {
    const repository = new FakeDriveControlPlaneRepository(() => NOW, 100);
    await repository.saveUsage({
      provider: "DRIVE",
      usedBytes: 100,
      limitBytes: 1_000,
      appManagedBytes: 100,
      mode: "READ_WRITE",
      reasonCodes: [],
      observedAt: "2026-07-19T00:00:00.000Z",
    });
    const drive = new FakeGoogleDriveFiles();
    drive.inspectAccountError = new AppError("DRIVE_TEMPORARILY_UNAVAILABLE", 503);
    const service = createFreeTierHealthService({
      repository,
      access: { getAccessToken: async () => "access" },
      files: drive,
      neonLimitBytes: 1_000,
      softPercent: 90,
      staleAfterSeconds: 900,
    });

    await expect(service.assertUploadAllowed(1, new Date("2026-07-19T00:15:01.000Z")))
      .rejects.toMatchObject({ code: "DRIVE_QUOTA_STALE" });
  });

  it("uses provider fallback evidence only through the inclusive freshness boundary", async () => {
    const repository = new FakeDriveControlPlaneRepository(() => NOW, 100);
    await repository.saveUsage({
      provider: "DRIVE",
      usedBytes: 100,
      limitBytes: 1_000,
      appManagedBytes: 100,
      mode: "READ_WRITE",
      reasonCodes: [],
      observedAt: "2026-07-19T00:00:00.000Z",
    });
    const drive = new FakeGoogleDriveFiles();
    drive.inspectAccountError = new AppError("DRIVE_TEMPORARILY_UNAVAILABLE", 503);
    const service = createFreeTierHealthService({
      repository,
      access: { getAccessToken: async () => "access" },
      files: drive,
      neonLimitBytes: 1_000,
      softPercent: 90,
      staleAfterSeconds: 900,
    });

    await expect(service.assertUploadAllowed(1, new Date("2026-07-19T00:15:00.000Z")))
      .resolves.toBeUndefined();
  });

  it("rejects when Neon usage is exactly at 90 percent", async () => {
    const repository = new FakeDriveControlPlaneRepository(() => NOW, 900);
    const service = createFreeTierHealthService({
      repository,
      access: { getAccessToken: async () => "access" },
      files: new FakeGoogleDriveFiles(),
      neonLimitBytes: 1_000,
      softPercent: 90,
      staleAfterSeconds: 900,
    });

    await expect(service.assertUploadAllowed(0, NOW)).rejects.toMatchObject({
      code: "NEON_STORAGE_HIGH",
    });
  });

  it("fails closed on malformed or non-safe quota evidence", async () => {
    const repository = new FakeDriveControlPlaneRepository(() => NOW, 100);
    const drive = new FakeGoogleDriveFiles();
    drive.account = { ...drive.account, usedBytes: Number.MAX_SAFE_INTEGER + 1 };
    const service = createFreeTierHealthService({
      repository,
      access: { getAccessToken: async () => "access" },
      files: drive,
      neonLimitBytes: 1_000,
      softPercent: 90,
      staleAfterSeconds: 900,
    });

    await expect(service.assertUploadAllowed(0, NOW)).rejects.toMatchObject({
      code: "QUOTA_INVALID",
    });
  });

  it("does not replace malformed provider evidence with a saved snapshot", async () => {
    const repository = new FakeDriveControlPlaneRepository(() => NOW, 100);
    await repository.saveUsage({
      provider: "DRIVE",
      usedBytes: 100,
      limitBytes: 1_000,
      appManagedBytes: 100,
      mode: "READ_WRITE",
      reasonCodes: [],
      observedAt: NOW.toISOString(),
    });
    const drive = new FakeGoogleDriveFiles();
    drive.account = null as never;
    const service = createFreeTierHealthService({
      repository,
      access: { getAccessToken: async () => "access" },
      files: drive,
      neonLimitBytes: 1_000,
      softPercent: 90,
      staleAfterSeconds: 900,
    });

    await expect(service.assertUploadAllowed(0, NOW)).rejects.toMatchObject({
      code: "QUOTA_INVALID",
    });
  });

  it("does not replace fresh high Drive evidence when snapshot persistence fails", async () => {
    const repository = new FakeDriveControlPlaneRepository(() => NOW, 100);
    await repository.saveUsage({
      provider: "DRIVE",
      usedBytes: 100,
      limitBytes: 1_000,
      appManagedBytes: 100,
      mode: "READ_WRITE",
      reasonCodes: [],
      observedAt: NOW.toISOString(),
    });
    vi.spyOn(repository, "saveUsage").mockImplementation(async (snapshot) => {
      if (snapshot.provider === "DRIVE") throw new Error("write unavailable");
    });
    const drive = new FakeGoogleDriveFiles();
    drive.account = { ...drive.account, usedBytes: 900, limitBytes: 1_000 };
    const service = createFreeTierHealthService({
      repository,
      access: { getAccessToken: async () => "access" },
      files: drive,
      neonLimitBytes: 1_000,
      softPercent: 90,
      staleAfterSeconds: 900,
    });

    await expect(service.assertUploadAllowed(0, NOW)).rejects.toMatchObject({
      code: "DRIVE_STORAGE_HIGH",
    });
  });

  it.each([
    [new AppError("DRIVE_NOT_CONNECTED", 409), "DISCONNECTED", "DRIVE_NOT_CONNECTED"],
    [new AppError("DRIVE_REAUTH_REQUIRED", 401), "REAUTH_REQUIRED", "DRIVE_REAUTH_REQUIRED"],
  ] as const)("reports %s Drive access as read only", async (error, driveConnection, reason) => {
    const repository = new FakeDriveControlPlaneRepository(() => NOW, 100);
    const service = createFreeTierHealthService({
      repository,
      access: { getAccessToken: async () => { throw error; } },
      files: new FakeGoogleDriveFiles(),
      neonLimitBytes: 1_000,
      softPercent: 90,
      staleAfterSeconds: 900,
    });

    await expect(service.getHealth(NOW)).resolves.toMatchObject({
      mode: "READ_ONLY",
      reasons: [reason],
      driveConnection,
      drive: null,
    });
  });

  it("audits a free-tier mode change without account identity", async () => {
    const repository = new FakeDriveControlPlaneRepository(() => NOW, 900);
    await repository.saveUsage({
      provider: "NEON",
      usedBytes: 100,
      limitBytes: 1_000,
      appManagedBytes: 0,
      mode: "READ_WRITE",
      reasonCodes: [],
      observedAt: NOW.toISOString(),
    });
    const drive = new FakeGoogleDriveFiles();
    drive.account = { ...drive.account, accountHint: "identity@example.test", permissionId: "identity-id" };
    const service = createFreeTierHealthService({
      repository,
      access: { getAccessToken: async () => "access" },
      files: drive,
      neonLimitBytes: 1_000,
      softPercent: 90,
      staleAfterSeconds: 900,
    });

    await service.getHealth(NOW);

    expect(repository.auditEvents).toContainEqual(expect.objectContaining({
      eventType: "FREE_TIER_MODE_CHANGED",
      payload: { mode: "READ_ONLY", reasonCode: "NEON_STORAGE_HIGH" },
    }));
    expect(JSON.stringify(repository.auditEvents)).not.toContain("identity@example.test");
    expect(JSON.stringify(repository.auditEvents)).not.toContain("identity-id");
  });
});
