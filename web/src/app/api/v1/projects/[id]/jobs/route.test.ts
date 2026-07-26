import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/domain/errors";

const { currentAdmin, service } = vi.hoisted(() => ({
  currentAdmin: vi.fn(),
  service: { queueProject: vi.fn() },
}));
vi.mock("@/lib/auth/current-admin", () => ({ currentAdmin }));
vi.mock("@/lib/application/job-queue", () => ({ createJobQueueService: () => service }));
vi.mock("@/lib/application/configured-health", () => ({
  createConfiguredFreeTierHealthService: () => ({ kind: "health" }),
}));
vi.mock("@/lib/repositories/neon-worker-control-plane", () => ({
  createNeonWorkerControlPlaneRepository: () => ({ kind: "repository" }),
}));
vi.mock("@/lib/repositories/neon-drive-control-plane", () => ({
  createNeonDriveControlPlaneRepository: () => ({ kind: "driveRepository" }),
}));

import { POST } from "./route";

const PROJECT_ID = "10000000-0000-4000-8000-000000000001";
const IDEMPOTENCY_KEY = "queue-key-0123456789";
const JOB = {
  id: "20000000-0000-4000-8000-000000000001",
  projectName: "Video test",
  state: "QUEUED",
  progressPercent: 0,
  updatedAt: "2026-07-26T00:00:00.000Z",
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

function postRequest(input: Readonly<{ origin?: string; idempotencyKey?: string | null }> = {}) {
  const headers: Record<string, string> = {
    origin: input.origin ?? "http://localhost:3000",
  };
  if (input.idempotencyKey !== null) {
    headers["idempotency-key"] = input.idempotencyKey ?? IDEMPOTENCY_KEY;
  }
  return new NextRequest(`http://localhost:3000/api/v1/projects/${PROJECT_ID}/jobs`, {
    method: "POST",
    headers,
  });
}

describe("/api/v1/projects/[id]/jobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv();
    currentAdmin.mockResolvedValue(true);
    service.queueProject.mockResolvedValue(JOB);
  });

  it("contains invalid server configuration in the stable no-store envelope", async () => {
    process.env.SESSION_SECRET = "private-invalid-config-detail";

    const response = await POST(postRequest(), context());

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = JSON.stringify(await response.json());
    expect(body).toBe('{"code":"INTERNAL_ERROR"}');
    expect(body).not.toContain("private-invalid-config-detail");
    expect(service.queueProject).not.toHaveBeenCalled();
  });

  it("authenticates before Origin, path, or service", async () => {
    currentAdmin.mockResolvedValue(false);
    const response = await POST(
      postRequest({ origin: "https://attacker.test", idempotencyKey: null }),
      context("bad"),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ code: "AUTH_REQUIRED" });
    expect(service.queueProject).not.toHaveBeenCalled();
  });

  it("requires exact Origin before path or service", async () => {
    const response = await POST(
      postRequest({ origin: "https://attacker.test", idempotencyKey: null }),
      context("bad"),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ code: "ORIGIN_REJECTED" });
    expect(service.queueProject).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid path id", "bad", IDEMPOTENCY_KEY],
    ["missing idempotency key", PROJECT_ID, null],
    ["short idempotency key", PROJECT_ID, "short"],
    ["idempotency key with illegal characters", PROJECT_ID, "bad key with spaces!"],
    ["oversized idempotency key", PROJECT_ID, "k".repeat(129)],
  ])("rejects %s before service", async (_label, pathId, idempotencyKey) => {
    const response = await POST(postRequest({ idempotencyKey }), context(pathId));
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ code: "INVALID_REQUEST" });
    expect(service.queueProject).not.toHaveBeenCalled();
  });

  it("queues the project and returns the created job envelope", async () => {
    const response = await POST(postRequest(), context());

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ job: JOB });
    expect(service.queueProject).toHaveBeenCalledTimes(1);
    expect(service.queueProject).toHaveBeenCalledWith(
      PROJECT_ID,
      IDEMPOTENCY_KEY,
      expect.any(Date),
    );
  });

  it("returns only stable no-store error bodies", async () => {
    service.queueProject.mockRejectedValueOnce(Object.assign(
      new AppError("JOB_NOT_QUEUEABLE", 409),
      { detail: "private" },
    ));
    const stable = await POST(postRequest(), context());
    expect(stable.status).toBe(409);
    expect(stable.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await stable.json())).toBe('{"code":"JOB_NOT_QUEUEABLE"}');

    service.queueProject.mockRejectedValueOnce(new Error("private internal detail"));
    const unexpected = await POST(postRequest(), context());
    expect(unexpected.status).toBe(500);
    expect(unexpected.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await unexpected.json())).toBe('{"code":"INTERNAL_ERROR"}');
  });
});
