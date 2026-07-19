import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/domain/errors";

const { currentAdmin, service } = vi.hoisted(() => ({
  currentAdmin: vi.fn(),
  service: { createSession: vi.fn(), complete: vi.fn(), cancel: vi.fn() },
}));
vi.mock("@/lib/auth/current-admin", () => ({ currentAdmin }));
vi.mock("@/lib/application/uploads", () => ({ createUploadService: () => service }));
vi.mock("@/lib/application/free-tier-health", () => ({
  createFreeTierHealthService: () => ({ kind: "health" }),
}));
vi.mock("@/lib/repositories/neon-drive-control-plane", () => ({
  createNeonDriveControlPlaneRepository: () => ({ kind: "repository" }),
}));
vi.mock("@/lib/application/drive-access", () => ({
  createDriveAccessProvider: () => ({ kind: "access" }),
}));
vi.mock("@/lib/adapters/google/oauth", () => ({ createGoogleOAuthAdapter: () => ({ kind: "oauth" }) }));
vi.mock("@/lib/adapters/google/drive-files", () => ({ createGoogleDriveFilesAdapter: () => ({ kind: "files" }) }));
vi.mock("@/lib/security/credential-cipher", () => ({ createCredentialCipher: () => ({ kind: "cipher" }) }));

import { POST } from "./route";

const PROJECT_ID = "10000000-0000-4000-8000-000000000001";
const ARTIFACT_ID = PROJECT_ID;

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

function context(id = PROJECT_ID) {
  return { params: Promise.resolve({ id }) };
}

function postRequest(input: Readonly<{ origin?: string; body?: string; contentLength?: string }> = {}) {
  const headers: Record<string, string> = {
    origin: input.origin ?? "http://localhost:3000",
    "content-type": "application/json",
  };
  if (input.contentLength !== undefined) headers["content-length"] = input.contentLength;
  return new NextRequest(`http://localhost:3000/api/v1/projects/${PROJECT_ID}/upload-complete`, {
    method: "POST",
    headers,
    body: input.body ?? JSON.stringify({ artifactId: ARTIFACT_ID }),
  });
}

describe("/api/v1/projects/[id]/upload-complete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv();
    currentAdmin.mockResolvedValue(true);
    service.complete.mockResolvedValue({ status: "SOURCE_READY", actualSizeBytes: 524_288 });
  });

  it("contains invalid server configuration in the stable no-store envelope", async () => {
    process.env.SESSION_SECRET = "private-invalid-config-detail";

    const response = await POST(postRequest(), context());

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = JSON.stringify(await response.json());
    expect(body).toBe('{"code":"INTERNAL_ERROR"}');
    expect(body).not.toContain("private-invalid-config-detail");
    expect(service.complete).not.toHaveBeenCalled();
  });

  it("authenticates before Origin, path, body, or service", async () => {
    currentAdmin.mockResolvedValue(false);
    const response = await POST(
      postRequest({ origin: "https://attacker.test", body: "not-json" }),
      context("bad"),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ code: "AUTH_REQUIRED" });
    expect(service.complete).not.toHaveBeenCalled();
  });

  it("requires exact Origin before path, body, or service", async () => {
    const response = await POST(
      postRequest({ origin: "https://attacker.test", body: "not-json" }),
      context("bad"),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ code: "ORIGIN_REJECTED" });
    expect(service.complete).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid path", "bad", JSON.stringify({ artifactId: ARTIFACT_ID }), 400, "INVALID_REQUEST"],
    ["invalid artifact", PROJECT_ID, JSON.stringify({ artifactId: "bad" }), 400, "INVALID_REQUEST"],
    ["extra field", PROJECT_ID, JSON.stringify({ artifactId: ARTIFACT_ID, extra: true }), 400, "INVALID_REQUEST"],
    ["oversized stream", PROJECT_ID, "x".repeat(1_025), 413, "REQUEST_TOO_LARGE"],
  ])("rejects %s before service", async (_label, pathId, body, status, code) => {
    const response = await POST(
      postRequest({ body, contentLength: body.length > 1_024 ? "1" : undefined }),
      context(pathId),
    );
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ code });
    expect(service.complete).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: "SOURCE_READY", actualSizeBytes: 524_288 }, 200],
    [{ status: "UPLOAD_PENDING", retryAfterMs: 1_000 }, 202],
  ])("maps completion result %# to HTTP %s", async (result, status) => {
    service.complete.mockResolvedValue(result);
    const response = await POST(postRequest(), context());

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual(result);
    expect(service.complete).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      artifactId: ARTIFACT_ID,
      now: expect.any(Date),
    });
  });

  it.each([
    [{ status: "SOURCE_READY", actualSizeBytes: 524_288 }, 200],
    [{ status: "UPLOAD_PENDING", retryAfterMs: 1_000 }, 202],
  ])("projects only the documented completion DTO for HTTP %s", async (documented, status) => {
    service.complete.mockResolvedValue({
      ...documented,
      sessionUri: "sensitive-capability-sentinel",
      driveFileId: "sensitive-provider-id-sentinel",
      providerBody: "sensitive-provider-body-sentinel",
    });

    const response = await POST(postRequest(), context());

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual(documented);
  });

  it("rejects an unexpected runtime completion status with the stable envelope", async () => {
    service.complete.mockResolvedValue({
      status: "SENSITIVE_PROVIDER_STATUS_SENTINEL",
      retryAfterMs: 1_000,
      providerBody: "sensitive-provider-body-sentinel",
    });

    const response = await POST(postRequest(), context());

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = JSON.stringify(await response.json());
    expect(body).toBe('{"code":"INTERNAL_ERROR"}');
    expect(body).not.toContain("SENSITIVE_PROVIDER_STATUS_SENTINEL");
    expect(body).not.toContain("sensitive-provider-body-sentinel");
  });

  it("returns only stable no-store error bodies", async () => {
    service.complete.mockRejectedValueOnce(Object.assign(
      new AppError("UPLOAD_REMOTE_MISMATCH", 409),
      { providerBody: "private" },
    ));
    const stable = await POST(postRequest(), context());
    expect(stable.status).toBe(409);
    expect(stable.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await stable.json())).toBe('{"code":"UPLOAD_REMOTE_MISMATCH"}');

    service.complete.mockRejectedValueOnce(new Error("private internal detail"));
    const unexpected = await POST(postRequest(), context());
    expect(unexpected.status).toBe(500);
    expect(unexpected.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await unexpected.json())).toBe('{"code":"INTERNAL_ERROR"}');
  });
});
