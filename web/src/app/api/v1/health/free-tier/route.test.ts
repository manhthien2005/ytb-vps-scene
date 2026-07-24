import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { currentAdmin, createHealthService, service } = vi.hoisted(() => {
  const service = { getHealth: vi.fn() };
  return {
    currentAdmin: vi.fn(),
    createHealthService: vi.fn(() => service),
    service,
  };
});

vi.mock("@/lib/auth/current-admin", () => ({ currentAdmin }));
vi.mock("@/lib/application/free-tier-health", () => ({
  createFreeTierHealthService: createHealthService,
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

import { GET } from "./route";

const HEALTH = {
  mode: "READ_WRITE" as const,
  reasons: [] as const,
  driveConnection: "CONNECTED" as const,
  drive: {
    provider: "DRIVE" as const,
    usedBytes: 100,
    limitBytes: 1_000,
    appManagedBytes: 20,
    mode: "READ_WRITE" as const,
    reasonCodes: [] as const,
    observedAt: "2026-07-19T00:00:00.000Z",
  },
  neon: {
    provider: "NEON" as const,
    usedBytes: 10,
    limitBytes: 536_870_912,
    appManagedBytes: 0,
    mode: "READ_WRITE" as const,
    reasonCodes: [] as const,
    observedAt: "2026-07-19T00:00:00.000Z",
  },
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

describe("GET /api/v1/health/free-tier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv();
    currentAdmin.mockResolvedValue(true);
    service.getHealth.mockResolvedValue(HEALTH);
  });

  it("requires admin before reading private quota", async () => {
    currentAdmin.mockResolvedValue(false);
    const response = await GET(new NextRequest("http://localhost:3000/api/v1/health/free-tier"));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ code: "AUTH_REQUIRED" });
    expect(service.getHealth).not.toHaveBeenCalled();
  });

  it("contains invalid configuration before auth or health service construction", async () => {
    process.env.SESSION_SECRET = "private-invalid-config-detail";

    const response = await GET(new NextRequest("http://localhost:3000/api/v1/health/free-tier"));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await response.json())).toBe('{"code":"HEALTH_UNAVAILABLE"}');
    expect(currentAdmin).not.toHaveBeenCalled();
    expect(createHealthService).not.toHaveBeenCalled();
  });

  it("returns only the sanitized free-tier view", async () => {
    const response = await GET(new NextRequest("http://localhost:3000/api/v1/health/free-tier"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({
      mode: "READ_WRITE",
      reasons: [],
      driveConnection: "CONNECTED",
      drive: { usedBytes: 100, limitBytes: 1_000, appManagedBytes: 20, observedAt: HEALTH.drive.observedAt },
      neon: { usedBytes: 10, limitBytes: 536_870_912, appManagedBytes: 0, observedAt: HEALTH.neon.observedAt },
    });
    expect(JSON.stringify(body)).not.toMatch(/provider|reasonCodes|permission|email|folder|fileId|token/i);
  });

  it("returns a sanitized no-store 503 when health cannot answer", async () => {
    service.getHealth.mockRejectedValue(new Error("private database diagnostic"));
    const response = await GET(new NextRequest("http://localhost:3000/api/v1/health/free-tier"));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ code: "HEALTH_UNAVAILABLE" });
  });
});
