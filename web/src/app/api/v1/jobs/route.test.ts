import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobSummary } from "@/lib/domain/control-plane";

const { createRepository, currentAdmin, repository } = vi.hoisted(() => ({
  createRepository: vi.fn(),
  currentAdmin: vi.fn(),
  repository: {
    listJobs: vi.fn(),
  },
}));

vi.mock("@/lib/auth/current-admin", () => ({ currentAdmin }));
vi.mock("@/lib/repositories/neon-control-plane", () => ({
  createNeonControlPlaneRepository: createRepository,
}));

import { GET } from "./route";

const EXPANDED_JOB = {
  id: "job-expanded",
  projectName: "Expanded Project",
  state: "DOWNLOADING",
  progressPercent: 40,
  updatedAt: "2026-07-25T06:00:00.000Z",
  settingsSnapshot: null,
  sourceMetadata: {
    artifactId: "artifact-source",
    displayName: "source.mp4",
    mimeType: "video/mp4",
    sizeBytes: 1_024,
    checksumSha256: "a".repeat(64),
  },
  activePhase: "download",
  phaseProgressPercent: 67,
  latestMessage: "Downloading source",
  etaSeconds: 90,
  startedAt: "2026-07-25T05:55:00.000Z",
  completedAt: null,
  cancelRequestedAt: null,
  errorCode: null,
  errorMessage: null,
} satisfies JobSummary;

const LEGACY_JOB = {
  id: "job-legacy",
  projectName: "Legacy Project",
  state: "QUEUED",
  progressPercent: 25,
  updatedAt: "2026-07-25T05:00:00.000Z",
} satisfies JobSummary;

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
  return new NextRequest("http://localhost:3000/api/v1/jobs");
}

describe("GET /api/v1/jobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv();
    currentAdmin.mockResolvedValue(true);
    createRepository.mockReturnValue(repository);
    repository.listJobs.mockResolvedValue([]);
  });

  it("returns expanded summaries, safe legacy defaults, and no unexpected repository fields", async () => {
    repository.listJobs.mockResolvedValue([
      {
        ...EXPANDED_JOB,
        workerSecret: "private-worker-secret",
        driveToken: "private-drive-token",
        rawLogs: ["private raw log"],
      },
      LEGACY_JOB,
    ]);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      jobs: [
        {
          id: "job-expanded",
          projectName: "Expanded Project",
          state: "DOWNLOADING",
          progressPercent: 40,
          updatedAt: "2026-07-25T06:00:00.000Z",
          settingsSnapshot: null,
          sourceMetadata: {
            artifactId: "artifact-source",
            displayName: "source.mp4",
            mimeType: "video/mp4",
            sizeBytes: 1_024,
            checksumSha256: "a".repeat(64),
          },
          activePhase: "download",
          phaseProgressPercent: 67,
          latestMessage: "Downloading source",
          etaSeconds: 90,
          startedAt: "2026-07-25T05:55:00.000Z",
          completedAt: null,
          cancelRequestedAt: null,
          errorCode: null,
          errorMessage: null,
        },
        {
          id: "job-legacy",
          projectName: "Legacy Project",
          state: "QUEUED",
          progressPercent: 25,
          updatedAt: "2026-07-25T05:00:00.000Z",
          settingsSnapshot: null,
          sourceMetadata: null,
          activePhase: null,
          phaseProgressPercent: null,
          latestMessage: null,
          etaSeconds: null,
          startedAt: null,
          completedAt: null,
          cancelRequestedAt: null,
          errorCode: null,
          errorMessage: null,
        },
      ],
    });
    expect(repository.listJobs).toHaveBeenCalledOnce();
  });

  it("returns an empty no-store list when the repository has no jobs", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ jobs: [] });
  });

  it("requires an authenticated admin before creating or querying the repository", async () => {
    currentAdmin.mockResolvedValue(false);

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ code: "AUTH_REQUIRED" });
    expect(createRepository).not.toHaveBeenCalled();
    expect(repository.listJobs).not.toHaveBeenCalled();
  });

  it("returns only a stable no-store error when the repository fails", async () => {
    const internal = new Error("private repository detail");
    internal.stack = "private repository stack";
    repository.listJobs.mockRejectedValue(internal);

    const response = await GET(request());
    const body = JSON.stringify(await response.json());

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toBe('{"code":"INTERNAL_ERROR"}');
    expect(body).not.toContain(internal.message);
    expect(body).not.toContain(internal.stack);
  });
});
