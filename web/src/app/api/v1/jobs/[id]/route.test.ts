import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  JobCancellationOutcome,
  JobDetailReadModel,
} from "@/lib/repositories/control-plane";

const { currentAdmin, repository } = vi.hoisted(() => ({
  currentAdmin: vi.fn(),
  repository: {
    getJobDetail: vi.fn(),
    requestJobCancellation: vi.fn(),
  },
}));

vi.mock("@/lib/auth/current-admin", () => ({ currentAdmin }));
vi.mock("@/lib/repositories/neon-control-plane", () => ({
  createNeonControlPlaneRepository: () => repository,
}));

import { GET, POST } from "./route";

const JOB_ID = "10000000-0000-4000-8000-000000000001";
const SOURCE_ID = "30000000-0000-4000-8000-000000000001";
const OUTPUT_ID = "30000000-0000-4000-8000-000000000002";
const WORKER_ID = "40000000-0000-4000-8000-000000000001";
const JOB: JobDetailReadModel = {
  id: JOB_ID,
  projectName: "Vietnamese demo",
  state: "RENDER",
  progressPercent: 72,
  createdAt: "2026-07-25T01:00:00.000Z",
  updatedAt: "2026-07-25T01:15:00.000Z",
  settingsSnapshot: {
    version: 1,
    sourceArtifactId: SOURCE_ID,
    sourceSubtitle: { x: 0.1, y: 0.7, width: 0.8, height: 0.2 },
    logo: { x: 0.8, y: 0.05, width: 0.1, height: 0.1 },
    voice: "BV074_streaming",
    rate: 1,
  },
  sourceMetadata: {
    artifactId: SOURCE_ID,
    displayName: "source.mp4",
    mimeType: "video/mp4",
    sizeBytes: 1_024,
    checksumSha256: "a".repeat(64),
  },
  telemetry: {
    activePhase: "render",
    phaseProgressPercent: 72,
    latestMessage: "Rendering frames",
    etaSeconds: 45,
    startedAt: "2026-07-25T01:05:00.000Z",
    completedAt: null,
    cancelRequestedAt: null,
    errorCode: null,
    errorMessage: null,
  },
  progressHistory: [{
    id: "50000000-0000-4000-8000-000000000001",
    phase: "render",
    progressPercent: 72,
    message: "Rendering frames",
    recordedAt: "2026-07-25T01:15:00.000Z",
  }],
  outputMetadata: {
    artifactId: OUTPUT_ID,
    displayName: "output.mp4",
    mimeType: "video/mp4",
    sizeBytes: 512,
    checksumSha256: "b".repeat(64),
  },
  workerSummary: {
    id: WORKER_ID,
    state: "BUSY",
    accountLabel: "render-node-1",
  },
  attemptSummary: {
    count: 2,
    activeCount: 1,
    latestStartedAt: "2026-07-25T01:05:00.000Z",
    latestEndedAt: null,
    latestOutcome: "LEASE_LOST",
  },
  canCancel: true,
  canRetry: false,
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

function context(id = JOB_ID) {
  return { params: Promise.resolve({ id }) };
}

function getRequest() {
  return new NextRequest(`http://localhost:3000/api/v1/jobs/${JOB_ID}`, {
    headers: { origin: "https://read-origin-is-ignored.example" },
  });
}

function postRequest(input: Readonly<{
  origin?: string | null;
  body?: string;
  contentLength?: string;
}> = {}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (input.origin !== null) {
    headers.origin = input.origin ?? "http://localhost:3000";
  }
  if (input.contentLength !== undefined) headers["content-length"] = input.contentLength;
  return new NextRequest(`http://localhost:3000/api/v1/jobs/${JOB_ID}`, {
    method: "POST",
    headers,
    body: input.body ?? JSON.stringify({ action: "cancel" }),
  });
}

describe("/api/v1/jobs/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv();
    currentAdmin.mockResolvedValue(true);
    repository.getJobDetail.mockResolvedValue(JOB);
    repository.requestJobCancellation.mockResolvedValue("REQUESTED");
  });

  it("authenticates GET and returns the complete redacted read model unchanged", async () => {
    const response = await GET(getRequest(), context());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ job: JOB });
    expect(repository.getJobDetail).toHaveBeenCalledWith(JOB_ID);
  });

  it("authenticates GET before validating the path or reading job data", async () => {
    currentAdmin.mockResolvedValue(false);

    const response = await GET(getRequest(), context("malformed"));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ code: "AUTH_REQUIRED" });
    expect(repository.getJobDetail).not.toHaveBeenCalled();
  });

  it("returns safe client errors for a malformed or missing GET job", async () => {
    const malformed = await GET(getRequest(), context("malformed"));
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("cache-control")).toBe("no-store");
    await expect(malformed.json()).resolves.toEqual({ code: "INVALID_REQUEST" });
    expect(repository.getJobDetail).not.toHaveBeenCalled();

    repository.getJobDetail.mockResolvedValueOnce(null);
    const missing = await GET(getRequest(), context());
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    await expect(missing.json()).resolves.toEqual({ code: "NOT_FOUND" });
  });

  it("authenticates POST before Origin, path, body, or cancellation", async () => {
    currentAdmin.mockResolvedValue(false);

    const response = await POST(
      postRequest({ origin: "https://attacker.example", body: "not-json" }),
      context("malformed"),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ code: "AUTH_REQUIRED" });
    expect(repository.requestJobCancellation).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null],
    ["cross-site", "https://attacker.example"],
  ])("requires the exact POST Origin when it is %s", async (_label, origin) => {
    const response = await POST(
      postRequest({ origin, body: "not-json" }),
      context("malformed"),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ code: "ORIGIN_REJECTED" });
    expect(repository.requestJobCancellation).not.toHaveBeenCalled();
  });

  it("rejects a malformed POST job id before reading the body or cancelling", async () => {
    const response = await POST(postRequest({ body: "not-json" }), context("malformed"));

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ code: "INVALID_REQUEST" });
    expect(repository.requestJobCancellation).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid action", JSON.stringify({ action: "retry" }), 400, "INVALID_REQUEST"],
    ["missing action", JSON.stringify({}), 400, "INVALID_REQUEST"],
    ["extra field", JSON.stringify({ action: "cancel", force: true }), 400, "INVALID_REQUEST"],
    ["empty body", "", 400, "INVALID_REQUEST"],
    ["malformed JSON", "not-json", 400, "INVALID_REQUEST"],
    ["oversized stream", "x".repeat(129), 413, "REQUEST_TOO_LARGE"],
  ])("rejects %s before cancellation", async (_label, body, status, code) => {
    const response = await POST(
      postRequest({ body, contentLength: body.length > 128 ? "1" : undefined }),
      context(),
    );

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ code });
    expect(repository.requestJobCancellation).not.toHaveBeenCalled();
  });

  it("returns explicit normal outcomes for a requested and repeated cancellation", async () => {
    repository.requestJobCancellation
      .mockResolvedValueOnce("REQUESTED")
      .mockResolvedValueOnce("ALREADY_TERMINAL");

    const requested = await POST(postRequest(), context());
    const repeated = await POST(postRequest(), context());

    expect(requested.status).toBe(200);
    expect(requested.headers.get("cache-control")).toBe("no-store");
    await expect(requested.json()).resolves.toEqual({ outcome: "REQUESTED" });
    expect(repeated.status).toBe(200);
    expect(repeated.headers.get("cache-control")).toBe("no-store");
    await expect(repeated.json()).resolves.toEqual({ outcome: "ALREADY_TERMINAL" });
    expect(repository.requestJobCancellation).toHaveBeenCalledTimes(2);
    expect(repository.requestJobCancellation).toHaveBeenLastCalledWith(
      JOB_ID,
      expect.any(Date),
    );
    const now = repository.requestJobCancellation.mock.calls.at(-1)?.[1] as Date;
    expect(Number.isFinite(now.getTime())).toBe(true);
  });

  it.each<JobCancellationOutcome>(["ALREADY_TERMINAL", "NOT_CANCELABLE"])(
    "treats %s as a normal cancellation result",
    async (outcome) => {
      repository.requestJobCancellation.mockResolvedValueOnce(outcome);

      const response = await POST(postRequest(), context());

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({ outcome });
    },
  );

  it("maps a missing cancellation target to an explicit no-store 404 outcome", async () => {
    repository.requestJobCancellation.mockResolvedValueOnce("NOT_FOUND");

    const response = await POST(postRequest(), context());

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ outcome: "NOT_FOUND" });
  });

  it("contains invalid configuration and repository failures in stable error envelopes", async () => {
    process.env.SESSION_SECRET = "private-invalid-config";
    const invalidConfig = await GET(getRequest(), context());
    expect(invalidConfig.status).toBe(500);
    expect(invalidConfig.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await invalidConfig.json())).toBe('{"code":"INTERNAL_ERROR"}');
    expect(repository.getJobDetail).not.toHaveBeenCalled();

    setEnv();
    repository.getJobDetail.mockRejectedValueOnce(new Error("private GET diagnostics"));
    const failedGet = await GET(getRequest(), context());
    expect(failedGet.status).toBe(500);
    expect(failedGet.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await failedGet.json())).toBe('{"code":"INTERNAL_ERROR"}');

    repository.requestJobCancellation.mockRejectedValueOnce(new Error("private POST diagnostics"));
    const failedPost = await POST(postRequest(), context());
    expect(failedPost.status).toBe(500);
    expect(failedPost.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await failedPost.json())).toBe('{"code":"INTERNAL_ERROR"}');
  });
});
