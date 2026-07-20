import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError, type PublicCode } from "@/lib/domain/errors";

const { completeDriveConnection, consumeDriveConnectionState, currentAdmin } = vi.hoisted(() => ({
  completeDriveConnection: vi.fn(),
  consumeDriveConnectionState: vi.fn(),
  currentAdmin: vi.fn(),
}));
vi.mock("@/lib/auth/current-admin", () => ({ currentAdmin }));
vi.mock("@/lib/application/drive-connection", () => ({
  completeDriveConnection,
  consumeDriveConnectionState,
}));
vi.mock("@/lib/repositories/neon-drive-control-plane", () => ({
  createNeonDriveControlPlaneRepository: () => ({ kind: "repository" }),
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

function request(query: string, origin?: string) {
  return new NextRequest(`http://localhost:3000/api/v1/drive/callback?${query}`, {
    headers: origin ? { origin } : undefined,
  });
}

function expectRedirect(response: Response, path: string) {
  expect(response.status).toBe(307);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("location")).toBe(`http://localhost:3000${path}`);
}

describe("GET /api/v1/drive/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv();
    currentAdmin.mockResolvedValue(true);
    consumeDriveConnectionState.mockResolvedValue(undefined);
    completeDriveConnection.mockResolvedValue({ status: "CONNECTED" });
  });

  it("authenticates before parsing the query or touching providers", async () => {
    currentAdmin.mockResolvedValue(false);
    const response = await GET(request("state=a&state=b&unknown=secret"));

    expectRedirect(response, "/?drive_error=AUTH_REQUIRED");
    expect(consumeDriveConnectionState).not.toHaveBeenCalled();
    expect(completeDriveConnection).not.toHaveBeenCalled();
  });

  it.each([
    ["state=a&state=b&code=c"],
    ["state=s&code=a&code=b"],
    ["state=s&code=c&unknown=value"],
    ["state=s&code=c&error=access_denied"],
    ["state=s"],
    ["code=c"],
    ["state=s&code=c&scope=a&scope=b"],
    ["state=s&code=c&error_description=denied"],
    ["state=s&code=c&error_uri=https%3A%2F%2Fprovider.test%2Ferror"],
    ["state=s&error=access_denied&scope=drive.file"],
    ["state=s&error=access_denied&authuser=0"],
    ["state=s&error=access_denied&prompt=consent"],
    [`state=${"s".repeat(257)}&code=c`],
    [`state=s&code=${"c".repeat(4_097)}`],
    [`state=${encodeURIComponent("é".repeat(200))}&code=c`],
  ])("rejects duplicate, unknown, contradictory, missing, or oversized fields: %s", async (query) => {
    const response = await GET(request(query));

    expectRedirect(response, "/?drive_error=INVALID_REQUEST");
    expect(consumeDriveConnectionState).not.toHaveBeenCalled();
    expect(completeDriveConnection).not.toHaveBeenCalled();
  });

  it("consumes denial state and reflects no provider input", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await GET(request(
      "state=signed-state&error=access_denied&error_description=private.owner%40example.com+provider+text",
      "https://attacker.test",
    ));

    expectRedirect(response, "/?drive_error=DRIVE_PROVIDER_REJECTED");
    expect(consumeDriveConnectionState).toHaveBeenCalledWith({
      state: "signed-state",
      stateSecret: "s".repeat(64),
      now: expect.any(Date),
    }, { kind: "repository" });
    expect(completeDriveConnection).not.toHaveBeenCalled();
    expect(response.headers.get("location")).not.toContain("private.owner");
    expect(response.headers.get("location")).not.toContain("access_denied");
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("accepts only bounded allowed optional fields and redirects success to the app origin", async () => {
    const response = await GET(request(
      "state=signed-state&code=one-use-code&scope=drive.file&authuser=0&prompt=consent&iss=https%3A%2F%2Faccounts.google.com",
      "https://attacker.test",
    ));

    expectRedirect(response, "/?drive=connected");
    expect(completeDriveConnection).toHaveBeenCalledWith({
      state: "signed-state",
      code: "one-use-code",
      redirectUri: "http://localhost:3000/api/v1/drive/callback",
      stateSecret: "s".repeat(64),
      now: expect.any(Date),
      softPercent: 90,
    }, expect.objectContaining({
      repository: { kind: "repository" },
      oauth: { kind: "oauth" },
      files: { kind: "files" },
      cipher: { kind: "cipher" },
    }));
  });

  it.each([
    ["state=s&code=c&iss=https%3A%2F%2Fattacker.test"],
    ["state=s&code=c&iss=https%3A%2F%2Faccounts.google.com&iss=https%3A%2F%2Faccounts.google.com"],
  ])("rejects an unexpected or duplicate authorization issuer: %s", async (query) => {
    const response = await GET(request(query));

    expectRedirect(response, "/?drive_error=INVALID_REQUEST");
    expect(completeDriveConnection).not.toHaveBeenCalled();
  });

  it.each([
    ["OAUTH_STATE_EXPIRED", 400],
    ["OAUTH_STATE_REPLAYED", 400],
    ["OAUTH_REFRESH_TOKEN_MISSING", 400],
    ["OAUTH_SCOPE_REJECTED", 400],
    ["DRIVE_ACCOUNT_MISMATCH", 409],
  ] as Array<[PublicCode, number]>) (
    "redirects stable application failure %s without reflecting code/state/provider text",
    async (code, status) => {
      completeDriveConnection.mockRejectedValue(new AppError(code, status));
      const response = await GET(request("state=private-state&code=private-code"));

      expectRedirect(response, `/?drive_error=${code}`);
      const location = response.headers.get("location")!;
      expect(location).not.toContain("private-state");
      expect(location).not.toContain("private-code");
    },
  );

  it("redirects a denial state failure rather than exchanging a code", async () => {
    consumeDriveConnectionState.mockRejectedValue(new AppError("OAUTH_STATE_REPLAYED", 400));
    const response = await GET(request("state=replayed&error=access_denied"));

    expectRedirect(response, "/?drive_error=OAUTH_STATE_REPLAYED");
    expect(completeDriveConnection).not.toHaveBeenCalled();
  });
});
