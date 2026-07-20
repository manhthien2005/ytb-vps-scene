import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/domain/errors";

const { currentAdmin, service } = vi.hoisted(() => ({
  currentAdmin: vi.fn(),
  service: {
    createSession: vi.fn(),
    complete: vi.fn(),
    cancel: vi.fn(),
  },
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
vi.mock("@/lib/adapters/google/oauth", () => ({
  createGoogleOAuthAdapter: () => ({ kind: "oauth" }),
}));
vi.mock("@/lib/adapters/google/drive-files", () => ({
  createGoogleDriveFilesAdapter: () => ({ kind: "files" }),
}));
vi.mock("@/lib/security/credential-cipher", () => ({
  createCredentialCipher: () => ({ kind: "cipher" }),
}));

import { POST } from "./route";

const PROJECT_ID = "10000000-0000-4000-8000-000000000001";
const VALID_BODY = {
  fileName: "private-source.mp4",
  mimeType: "video/mp4",
  sizeBytes: 524_288,
  lastModified: 1_752_883_200_000,
};
const SESSION = {
  artifactId: PROJECT_ID,
  sessionUri: "https://www.googleapis.com/upload/drive/v3/files/synthetic?upload_id=synthetic",
  chunkBytes: 8_388_608,
  expiresAt: "2026-07-26T00:00:00.000Z",
};

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

function postRequest(input: Readonly<{
  origin?: string;
  body?: string;
  contentLength?: string;
}> = {}) {
  const headers: Record<string, string> = {
    origin: input.origin ?? "http://localhost:3000",
    "content-type": "application/json",
  };
  if (input.contentLength !== undefined) headers["content-length"] = input.contentLength;
  return new NextRequest(`http://localhost:3000/api/v1/projects/${PROJECT_ID}/upload-session`, {
    method: "POST",
    headers,
    body: input.body ?? JSON.stringify(VALID_BODY),
  });
}

function expectSessionSecurityHeaders(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
}

describe("/api/v1/projects/[id]/upload-session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv();
    currentAdmin.mockResolvedValue(true);
    service.createSession.mockResolvedValue(SESSION);
  });

  it("contains invalid server configuration in the secured stable envelope", async () => {
    process.env.SESSION_SECRET = "private-invalid-config-detail";

    const response = await POST(postRequest(), context());

    expect(response.status).toBe(500);
    expectSessionSecurityHeaders(response);
    const body = JSON.stringify(await response.json());
    expect(body).toBe('{"code":"INTERNAL_ERROR"}');
    expect(body).not.toContain("private-invalid-config-detail");
    expect(service.createSession).not.toHaveBeenCalled();
  });

  it("authenticates before Origin, path, body, or service", async () => {
    currentAdmin.mockResolvedValue(false);
    const response = await POST(
      postRequest({ origin: "https://attacker.test", body: "not-json" }),
      context("not-a-uuid"),
    );

    expect(response.status).toBe(401);
    expectSessionSecurityHeaders(response);
    await expect(response.json()).resolves.toEqual({ code: "AUTH_REQUIRED" });
    expect(service.createSession).not.toHaveBeenCalled();
  });

  it("requires the exact Origin before path, body, or service", async () => {
    const response = await POST(
      postRequest({ origin: "https://attacker.test", body: "not-json" }),
      context("not-a-uuid"),
    );

    expect(response.status).toBe(403);
    expectSessionSecurityHeaders(response);
    await expect(response.json()).resolves.toEqual({ code: "ORIGIN_REJECTED" });
    expect(service.createSession).not.toHaveBeenCalled();
  });

  it("rejects a non-UUID project path before reading the body", async () => {
    const response = await POST(postRequest({ body: "not-json" }), context("not-a-uuid"));

    expect(response.status).toBe(400);
    expectSessionSecurityHeaders(response);
    await expect(response.json()).resolves.toEqual({ code: "INVALID_REQUEST" });
    expect(service.createSession).not.toHaveBeenCalled();
  });

  it.each([
    [JSON.stringify({}), 400, "INVALID_REQUEST"],
    [JSON.stringify({ ...VALID_BODY, mimeType: "application/octet-stream" }), 400, "INVALID_REQUEST"],
    [JSON.stringify({ ...VALID_BODY, extra: true }), 400, "INVALID_REQUEST"],
    ["x".repeat(1_025), 413, "REQUEST_TOO_LARGE"],
  ])("rejects an invalid or streamed oversized body", async (body, status, code) => {
    const response = await POST(
      postRequest({ body, contentLength: body.length > 1_024 ? "1" : undefined }),
      context(),
    );

    expect(response.status).toBe(status);
    expectSessionSecurityHeaders(response);
    await expect(response.json()).resolves.toEqual({ code });
    expect(service.createSession).not.toHaveBeenCalled();
  });

  it("returns only the exact session capability with no-store and no-referrer", async () => {
    service.createSession.mockResolvedValue({ ...SESSION, ignoredProviderField: "private" });
    const response = await POST(postRequest(), context());

    expect(response.status).toBe(200);
    expectSessionSecurityHeaders(response);
    await expect(response.json()).resolves.toEqual(SESSION);
    expect(service.createSession).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      intent: VALID_BODY,
      now: expect.any(Date),
    });
  });

  it("returns terminal metadata when renewal finds an already-complete source", async () => {
    service.createSession.mockResolvedValue({
      artifactId: PROJECT_ID,
      status: "SOURCE_READY",
      actualSizeBytes: VALID_BODY.sizeBytes,
      ignoredProviderField: "private",
    });

    const response = await POST(postRequest(), context());

    expect(response.status).toBe(200);
    expectSessionSecurityHeaders(response);
    await expect(response.json()).resolves.toEqual({
      artifactId: PROJECT_ID,
      status: "SOURCE_READY",
      actualSizeBytes: VALID_BODY.sizeBytes,
    });
  });

  it("returns stable application errors without private provider detail", async () => {
    const error = Object.assign(new AppError("DRIVE_RATE_LIMITED", 429), {
      providerBody: "private-provider-detail",
    });
    service.createSession.mockRejectedValue(error);

    const response = await POST(postRequest(), context());
    expect(response.status).toBe(429);
    expectSessionSecurityHeaders(response);
    expect(JSON.stringify(await response.json())).toBe('{"code":"DRIVE_RATE_LIMITED"}');
  });

  it("returns a stable secured 500 for an unexpected failure", async () => {
    service.createSession.mockRejectedValue(new Error("private internal detail"));

    const response = await POST(postRequest(), context());
    expect(response.status).toBe(500);
    expectSessionSecurityHeaders(response);
    expect(JSON.stringify(await response.json())).toBe('{"code":"INTERNAL_ERROR"}');
  });
});
