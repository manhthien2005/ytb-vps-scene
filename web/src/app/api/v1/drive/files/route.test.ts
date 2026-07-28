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
vi.mock("@/lib/security/credential-cipher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/credential-cipher")>()),
  createCredentialCipher: () => ({ kind: "cipher" }),
}));

import { GET } from "./route";

const PROJECT_ID = "10000000-0000-4000-8000-000000000001";
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

function request() {
  return new NextRequest("http://localhost:3000/api/v1/drive/files");
}

const file = {
  artifactId: ARTIFACT_ID,
  name: "source.mp4",
  sizeBytes: 100,
  uploadedAt: "2026-07-21T10:00:00.000Z",
  durationMillis: 1_000,
  width: 1920,
  height: 1080,
  readiness: "READY",
  viewUrl: "https://drive.google.com/file/d/source/view",
  downloadUrl: "https://drive.usercontent.google.com/download?id=source",
};

describe("GET /api/v1/drive/files", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv();
    currentAdmin.mockResolvedValue(true);
    service.list.mockResolvedValue({ input: [file], output: [], processingCount: 0 });
  });

  it("requires an authenticated admin before listing files", async () => {
    currentAdmin.mockResolvedValue(false);

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ code: "AUTH_REQUIRED" });
    expect(service.list).not.toHaveBeenCalled();
  });

  it("returns exactly the sanitized workspace keys with no-store", async () => {
    service.list.mockResolvedValue({
      input: [{
        ...file,
        driveFileId: "private-drive-file-id",
        appProperties: { private: "value" },
        accessToken: "private-access-token",
      }],
      output: [{
        projectId: PROJECT_ID,
        name: "Phim A",
        files: [{ ...file, artifactId: `${ARTIFACT_ID.slice(0, -1)}2`, driveFileId: "private-output-id" }],
        driveProjectFolderId: "private-folder-id",
      }],
      processingCount: 0,
      credential: { accessToken: "private-access-token" },
    });

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      input: [file],
      output: [{
        projectId: PROJECT_ID,
        name: "Phim A",
        files: [{ ...file, artifactId: `${ARTIFACT_ID.slice(0, -1)}2` }],
      }],
      processingCount: 0,
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("driveFileId");
    expect(serialized).not.toContain("appProperties");
    expect(serialized).not.toContain("accessToken");
    expect(serialized).not.toContain("private-folder-id");
  });

  it("returns only stable public errors", async () => {
    service.list.mockRejectedValueOnce(Object.assign(
      new AppError("DRIVE_REAUTH_REQUIRED", 401),
      { providerBody: "private-provider-detail" },
    ));
    const stable = await GET(request());
    expect(stable.status).toBe(401);
    expect(stable.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await stable.json())).toBe('{"code":"DRIVE_REAUTH_REQUIRED"}');

    service.list.mockRejectedValueOnce(new Error("private-internal-detail"));
    const unexpected = await GET(request());
    expect(unexpected.status).toBe(500);
    expect(unexpected.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await unexpected.json())).toBe('{"code":"INTERNAL_ERROR"}');
  });

  it("contains invalid server configuration in the stable no-store envelope", async () => {
    process.env.SESSION_SECRET = "private-invalid-config-detail";

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await response.json())).toBe('{"code":"INTERNAL_ERROR"}');
    expect(service.list).not.toHaveBeenCalled();
  });
});
