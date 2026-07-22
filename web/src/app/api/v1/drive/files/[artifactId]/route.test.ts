import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/domain/errors";

const { currentAdmin, service } = vi.hoisted(() => ({
  currentAdmin: vi.fn(),
  service: { list: vi.fn(), delete: vi.fn() },
}));
vi.mock("@/lib/auth/current-admin", () => ({ currentAdmin }));
vi.mock("@/lib/application/drive-workspace", () => ({
  createDriveWorkspaceService: () => service,
}));
vi.mock("@/lib/repositories/neon-drive-control-plane", () => ({
  createNeonDriveControlPlaneRepository: () => ({ kind: "repository" }),
}));
vi.mock("@/lib/application/drive-access", () => ({
  createDriveAccessProvider: () => ({ kind: "access" }),
}));
vi.mock("@/lib/adapters/google/oauth", () => ({
  createGoogleOAuthAdapter: () => ({ kind: "oauth" }),
}));
vi.mock("@/lib/adapters/google/drive-files", () => ({
  createGoogleDriveFilesAdapter: () => ({ kind: "files" }),
}));
vi.mock("@/lib/security/credential-cipher", () => ({
  createCredentialCipher: () => ({ kind: "cipher" }),
}));

import { DELETE } from "./route";

const ARTIFACT_ID = "20000000-0000-4000-8000-000000000001";

function setEnv() {
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://test:test@localhost/test",
    ADMIN_KEY_HASH: "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    SESSION_SECRET: "s".repeat(64),
    APP_ORIGIN: "http://localhost:3000",
    GOOGLE_OAUTH_CLIENT_ID: "example-client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "example-client-secret",
    DRIVE_TOKEN_KEY_V1: "A".repeat(43),
    NEON_STORAGE_LIMIT_BYTES: "536870912",
    DRIVE_UPLOAD_MAX_BYTES: "10737418240",
    FREE_TIER_SOFT_PERCENT: "90",
    QUOTA_STALE_AFTER_SECONDS: "900",
  });
  delete process.env.OPENAI_API_KEY;
}

function request(origin = "http://localhost:3000") {
  return new NextRequest(`http://localhost:3000/api/v1/drive/files/${ARTIFACT_ID}`, {
    method: "DELETE",
    headers: { origin },
  });
}

function context(artifactId = ARTIFACT_ID) {
  return { params: Promise.resolve({ artifactId }) };
}

describe("DELETE /api/v1/drive/files/[artifactId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv();
    currentAdmin.mockResolvedValue(true);
    service.delete.mockResolvedValue({ status: "DELETED" });
  });

  it("authenticates before Origin, path, or deletion", async () => {
    currentAdmin.mockResolvedValue(false);

    const response = await DELETE(request("https://attacker.test"), context("bad"));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ code: "AUTH_REQUIRED" });
    expect(service.delete).not.toHaveBeenCalled();
  });

  it("requires the exact mutation Origin before path parsing or deletion", async () => {
    const response = await DELETE(request("https://attacker.test"), context("bad"));

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ code: "ORIGIN_REJECTED" });
    expect(service.delete).not.toHaveBeenCalled();
  });

  it("rejects an invalid artifact UUID before deletion", async () => {
    const response = await DELETE(request(), context("not-a-uuid"));

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ code: "INVALID_REQUEST" });
    expect(service.delete).not.toHaveBeenCalled();
  });

  it("returns exactly the sanitized deletion status with no-store", async () => {
    service.delete.mockResolvedValue({
      status: "DELETED",
      driveFileId: "private-drive-file-id",
      accessToken: "private-access-token",
      appProperties: { private: "value" },
    });

    const response = await DELETE(request(), context());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await response.json())).toBe('{"status":"DELETED"}');
    expect(service.delete).toHaveBeenCalledWith(ARTIFACT_ID);
  });

  it("maps deletion conflicts to the stable public 409 code", async () => {
    service.delete.mockRejectedValue(new AppError("DRIVE_FILE_DELETE_CONFLICT", 409));

    const response = await DELETE(request(), context());

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await response.json())).toBe('{"code":"DRIVE_FILE_DELETE_CONFLICT"}');
  });

  it("returns only stable provider and unexpected error envelopes", async () => {
    service.delete.mockRejectedValueOnce(Object.assign(
      new AppError("DRIVE_TEMPORARILY_UNAVAILABLE", 503),
      { providerBody: "private-provider-detail" },
    ));
    const stable = await DELETE(request(), context());
    expect(stable.status).toBe(503);
    expect(JSON.stringify(await stable.json())).toBe('{"code":"DRIVE_TEMPORARILY_UNAVAILABLE"}');

    service.delete.mockRejectedValueOnce(new Error("private-internal-detail"));
    const unexpected = await DELETE(request(), context());
    expect(unexpected.status).toBe(500);
    expect(unexpected.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await unexpected.json())).toBe('{"code":"INTERNAL_ERROR"}');
  });

  it("contains invalid server configuration in the stable no-store envelope", async () => {
    process.env.SESSION_SECRET = "private-invalid-config-detail";

    const response = await DELETE(request(), context());

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await response.json())).toBe('{"code":"INTERNAL_ERROR"}');
    expect(service.delete).not.toHaveBeenCalled();
  });
});
