import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError, type PublicCode } from "@/lib/domain/errors";

const { completeYouTubeConnection, consumeYouTubeConnectionState, currentAdmin } = vi.hoisted(() => ({
  completeYouTubeConnection: vi.fn(),
  consumeYouTubeConnectionState: vi.fn(),
  currentAdmin: vi.fn(),
}));
vi.mock("@/lib/auth/current-admin", () => ({ currentAdmin }));
vi.mock("@/lib/application/youtube-connection", () => ({
  completeYouTubeConnection,
  consumeYouTubeConnectionState,
}));
vi.mock("@/lib/repositories/neon-youtube-control-plane", () => ({
  createNeonYouTubeControlPlaneRepository: () => ({ kind: "youtube-repository" }),
}));
vi.mock("@/lib/repositories/neon-drive-control-plane", () => ({
  createNeonDriveControlPlaneRepository: () => ({ kind: "states" }),
}));
vi.mock("@/lib/application/configured-youtube", () => ({
  createConfiguredYouTube: () => ({
    oauth: { kind: "oauth" },
    cipher: { kind: "cipher" },
    data: { kind: "data" },
    analytics: { kind: "analytics" },
  }),
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
  return new NextRequest(`http://localhost:3000/api/v1/youtube/callback?${query}`, {
    headers: origin ? { origin } : undefined,
  });
}

function expectRedirect(response: Response, path: string) {
  expect(response.status).toBe(307);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("location")).toBe(`http://localhost:3000${path}`);
}

describe("GET /api/v1/youtube/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv();
    currentAdmin.mockResolvedValue(true);
    consumeYouTubeConnectionState.mockResolvedValue(undefined);
    completeYouTubeConnection.mockResolvedValue({
      id: "30000000-0000-4000-8000-000000000001",
      channelId: "UCabcdefghijklmnopqrstuv",
      title: "Kênh mẫu",
    });
  });

  it("authenticates before parsing the query or touching providers", async () => {
    currentAdmin.mockResolvedValue(false);
    const response = await GET(request("state=a&state=b&unknown=secret"));

    expectRedirect(response, "/?youtube_error=AUTH_REQUIRED");
    expect(consumeYouTubeConnectionState).not.toHaveBeenCalled();
    expect(completeYouTubeConnection).not.toHaveBeenCalled();
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
    ["state=s&error=access_denied&scope=youtube.readonly"],
    ["state=s&error=access_denied&authuser=0"],
    ["state=s&error=access_denied&prompt=consent"],
    [`state=${"s".repeat(257)}&code=c`],
    [`state=s&code=${"c".repeat(4_097)}`],
    [`state=${encodeURIComponent("é".repeat(200))}&code=c`],
  ])("rejects duplicate, unknown, contradictory, missing, or oversized fields: %s", async (query) => {
    const response = await GET(request(query));

    expectRedirect(response, "/?youtube_error=INVALID_REQUEST");
    expect(consumeYouTubeConnectionState).not.toHaveBeenCalled();
    expect(completeYouTubeConnection).not.toHaveBeenCalled();
  });

  it.each([
    ["state=s&code=c&iss=https%3A%2F%2Fattacker.test"],
    ["state=s&code=c&iss=https%3A%2F%2Faccounts.google.com&iss=https%3A%2F%2Faccounts.google.com"],
  ])("rejects an unexpected or duplicate authorization issuer: %s", async (query) => {
    const response = await GET(request(query));

    expectRedirect(response, "/?youtube_error=INVALID_REQUEST");
    expect(completeYouTubeConnection).not.toHaveBeenCalled();
  });

  it("consumes denial state and reflects no provider input", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await GET(request(
      "state=signed-state&error=access_denied&error_description=private.owner%40example.com+provider+text",
      "https://attacker.test",
    ));

    expectRedirect(response, "/?youtube_error=YOUTUBE_PROVIDER_REJECTED");
    expect(consumeYouTubeConnectionState).toHaveBeenCalledWith({
      state: "signed-state",
      stateSecret: "s".repeat(64),
      now: expect.any(Date),
    }, { kind: "states" });
    expect(completeYouTubeConnection).not.toHaveBeenCalled();
    const location = response.headers.get("location")!;
    expect(location).not.toContain("private.owner");
    expect(location).not.toContain("access_denied");
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("accepts only bounded allowed optional fields and redirects success to the app origin", async () => {
    const response = await GET(request(
      "state=signed-state&code=one-use-code&scope=youtube.readonly&authuser=0&prompt=consent&iss=https%3A%2F%2Faccounts.google.com",
      "https://attacker.test",
    ));

    expectRedirect(response, "/?youtube=connected");
    expect(completeYouTubeConnection).toHaveBeenCalledWith({
      state: "signed-state",
      code: "one-use-code",
      redirectUri: "http://localhost:3000/api/v1/youtube/callback",
      stateSecret: "s".repeat(64),
      now: expect.any(Date),
    }, {
      repository: { kind: "youtube-repository" },
      states: { kind: "states" },
      oauth: { kind: "oauth" },
      data: { kind: "data" },
      cipher: { kind: "cipher" },
    });
  });

  it("hands the same states repository to both the denial and the exchange path", async () => {
    await GET(request("state=denied&error=access_denied"));
    await GET(request("state=signed-state&code=one-use-code"));

    expect(consumeYouTubeConnectionState.mock.calls[0]![1]).toEqual({ kind: "states" });
    expect(completeYouTubeConnection.mock.calls[0]![1]).toMatchObject({ states: { kind: "states" } });
  });

  it.each([
    ["OAUTH_STATE_EXPIRED", 400],
    ["OAUTH_STATE_REPLAYED", 400],
    ["OAUTH_REFRESH_TOKEN_MISSING", 400],
    ["OAUTH_SCOPE_REJECTED", 400],
    ["YOUTUBE_PROVIDER_REJECTED", 502],
  ] as Array<[PublicCode, number]>)(
    "redirects stable application failure %s without reflecting code/state/provider text",
    async (code, status) => {
      completeYouTubeConnection.mockRejectedValue(new AppError(code, status));
      const response = await GET(request("state=private-state&code=private-code"));

      expectRedirect(response, `/?youtube_error=${code}`);
      const location = response.headers.get("location")!;
      expect(location).not.toContain("private-state");
      expect(location).not.toContain("private-code");
    },
  );

  it("redirects a denial state failure rather than exchanging a code", async () => {
    consumeYouTubeConnectionState.mockRejectedValue(new AppError("OAUTH_STATE_REPLAYED", 400));
    const response = await GET(request("state=replayed&error=access_denied"));

    expectRedirect(response, "/?youtube_error=OAUTH_STATE_REPLAYED");
    expect(completeYouTubeConnection).not.toHaveBeenCalled();
  });

  it("degrades an unexpected failure to a provider-rejected redirect, not a 500 page", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    completeYouTubeConnection.mockRejectedValue(new Error("refresh_token=1//secret"));

    const response = await GET(request("state=signed-state&code=one-use-code"));
    expectRedirect(response, "/?youtube_error=YOUTUBE_PROVIDER_REJECTED");
    expect(response.headers.get("location")).not.toContain("secret");
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });
});
