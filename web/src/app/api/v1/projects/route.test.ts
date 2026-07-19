import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@/lib/domain/drive";
import { AppError } from "@/lib/domain/errors";

const { currentAdmin, service } = vi.hoisted(() => ({
  currentAdmin: vi.fn(),
  service: {
    createProject: vi.fn(),
    listProjects: vi.fn(),
  },
}));
vi.mock("@/lib/auth/current-admin", () => ({ currentAdmin }));
vi.mock("@/lib/application/projects", () => ({
  createProjectService: () => service,
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

import { GET, POST } from "./route";

const PROJECT: Project = {
  id: "10000000-0000-4000-8000-000000000001",
  status: "READY",
  name: "Test 1",
  sourceStatus: "NO_SOURCE",
  driveProjectFolderId: "drive-project-folder-001",
  driveInputFolderId: "drive-input-folder-001",
  createdAt: "2026-07-19T00:00:00.000Z",
  updatedAt: "2026-07-19T00:00:00.000Z",
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

function postRequest(input: Readonly<{
  origin?: string;
  body?: string;
  idempotencyKey?: string | null;
  contentLength?: string;
}> = {}) {
  const headers: Array<[string, string]> = [
    ["origin", input.origin ?? "http://localhost:3000"],
    ["content-type", "application/json"],
  ];
  if (input.idempotencyKey !== null) {
    headers.push(["idempotency-key", input.idempotencyKey ?? "0123456789abcdef"]);
  }
  if (input.contentLength !== undefined) headers.push(["content-length", input.contentLength]);
  return new NextRequest("http://localhost:3000/api/v1/projects", {
    method: "POST",
    headers,
    body: input.body ?? JSON.stringify({ name: "Test 1" }),
  });
}

describe("/api/v1/projects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv();
    currentAdmin.mockResolvedValue(true);
    service.createProject.mockResolvedValue({ outcome: "CREATED", project: PROJECT });
    service.listProjects.mockResolvedValue([PROJECT]);
  });

  it("authenticates POST before Origin, body, or project service", async () => {
    currentAdmin.mockResolvedValue(false);
    const response = await POST(postRequest({ origin: "https://attacker.test", body: "not-json" }));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ code: "AUTH_REQUIRED" });
    expect(service.createProject).not.toHaveBeenCalled();
  });

  it("requires the exact POST Origin before reading the body or calling the service", async () => {
    const response = await POST(postRequest({ origin: "https://attacker.test", body: "not-json" }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ code: "ORIGIN_REJECTED" });
    expect(service.createProject).not.toHaveBeenCalled();
  });

  it.each([
    [JSON.stringify({}), 400, "INVALID_REQUEST"],
    [JSON.stringify({ name: "" }), 400, "INVALID_REQUEST"],
    [JSON.stringify({ name: "x".repeat(161) }), 400, "INVALID_REQUEST"],
    [JSON.stringify({ name: "Test 1", extra: true }), 400, "INVALID_REQUEST"],
    ["x".repeat(1_025), 413, "REQUEST_TOO_LARGE"],
  ])("rejects invalid or streamed oversized body before project creation", async (body, status, code) => {
    const response = await POST(postRequest({ body, contentLength: body.length > 1_024 ? "1" : undefined }));

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ code });
    expect(service.createProject).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null],
    ["short", "too-short"],
    ["long", "x".repeat(129)],
    ["non-printable", "0123456789abcde\n"],
  ])("rejects a %s idempotency key", async (_description, key) => {
    const response = await POST(postRequest({ idempotencyKey: key }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "INVALID_REQUEST" });
    expect(service.createProject).not.toHaveBeenCalled();
  });

  it("accepts approved punctuation and rejects comma-bearing keys before the body", async () => {
    const safeKey = "project.key_01:retry-safe";
    const accepted = await POST(postRequest({ idempotencyKey: safeKey }));
    expect(accepted.status).toBe(201);
    expect(service.createProject).toHaveBeenCalledWith({
      idempotencyKey: safeKey,
      name: "Test 1",
    });
    service.createProject.mockClear();

    const rejected = await POST(postRequest({
      idempotencyKey: "0123456789abc,def",
      body: "x".repeat(1_025),
      contentLength: "1",
    }));
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toEqual({ code: "INVALID_REQUEST" });
    expect(service.createProject).not.toHaveBeenCalled();
  });

  it("rejects duplicate idempotency-key headers", async () => {
    const request = postRequest({
      body: "x".repeat(1_025),
      contentLength: "1",
    });
    request.headers.append("idempotency-key", "fedcba9876543210");

    const response = await POST(request);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "INVALID_REQUEST" });
    expect(service.createProject).not.toHaveBeenCalled();
  });

  it.each([
    ["CREATED", 201],
    ["REPLAYED", 200],
  ])("returns %s with the exact project domain response", async (outcome, status) => {
    service.createProject.mockResolvedValue({ outcome, project: PROJECT });
    const response = await POST(postRequest({ body: JSON.stringify({ name: "  Test 1  " }) }));

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ project: PROJECT });
    expect(service.createProject).toHaveBeenCalledWith({
      idempotencyKey: "0123456789abcdef",
      name: "Test 1",
    });
  });

  it("returns stable application errors without provider diagnostics", async () => {
    service.createProject.mockRejectedValue(new AppError("IDEMPOTENCY_CONFLICT", 409));

    const response = await POST(postRequest());
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("returns a stable no-store 500 for an unexpected POST service failure", async () => {
    const internal = new Error("private internal detail");
    internal.stack = "private internal stack";
    service.createProject.mockRejectedValue(internal);

    const response = await POST(postRequest());
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = JSON.stringify(await response.json());
    expect(body).toBe('{"code":"INTERNAL_ERROR"}');
    expect(body).not.toContain(internal.message);
    expect(body).not.toContain(internal.stack);
  });

  it("authenticates GET without requiring Origin and returns no-store domain projects", async () => {
    const response = await GET(new NextRequest("http://localhost:3000/api/v1/projects", {
      headers: { origin: "https://attacker.test" },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ projects: [PROJECT] });
    expect(service.listProjects).toHaveBeenCalledOnce();
  });

  it("returns a stable no-store 500 for an unexpected GET service failure", async () => {
    const internal = new Error("private internal detail");
    internal.stack = "private internal stack";
    service.listProjects.mockRejectedValue(internal);

    const response = await GET(new NextRequest("http://localhost:3000/api/v1/projects"));
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = JSON.stringify(await response.json());
    expect(body).toBe('{"code":"INTERNAL_ERROR"}');
    expect(body).not.toContain(internal.message);
    expect(body).not.toContain(internal.stack);
  });

  it("rejects unauthenticated GET before calling the service", async () => {
    currentAdmin.mockResolvedValue(false);
    const response = await GET(new NextRequest("http://localhost:3000/api/v1/projects"));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ code: "AUTH_REQUIRED" });
    expect(service.listProjects).not.toHaveBeenCalled();
  });
});
