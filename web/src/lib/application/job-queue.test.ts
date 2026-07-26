import { describe, expect, it, vi } from "vitest";
import type { FreeTierHealthService } from "./free-tier-health";
import type { WorkerControlPlaneRepository } from "@/lib/repositories/worker-control-plane";
import type { WorkerView } from "@/lib/domain/worker";
import { createJobQueueService } from "./job-queue";

const NOW = new Date("2026-07-20T08:30:00.000Z");
const PROJECT_ID = "20000000-0000-4000-8000-000000000001";
const JOB = {
  id: "40000000-0000-4000-8000-000000000001",
  projectName: "Video test",
  state: "QUEUED" as const,
  progressPercent: 0,
  updatedAt: NOW.toISOString(),
};
const worker: WorkerView = {
  id: "10000000-0000-4000-8000-000000000001",
  state: "READY",
  accountLabel: null,
  capabilities: {
    protocolVersion: 1,
    pipelineBridgeVersion: "bridge-v1",
    os: "ubuntu-22.04",
    arch: "x86_64",
    gpuName: "NVIDIA GeForce RTX 3060",
    vramMiB: 12_288,
    cudaVersion: "12.4",
    nvenc: true,
  },
  doctor: { status: "PASS", reasonCodes: [], observedAt: NOW.toISOString() },
  lastHeartbeatAt: NOW.toISOString(),
  sessionExpiresAt: "2026-07-21T08:30:00.000Z",
};

function dependencies() {
  const repository = {
    queueProjectJob: vi.fn().mockResolvedValue(JOB),
    claimJob: vi.fn().mockResolvedValue(null),
    renewLease: vi.fn().mockResolvedValue({
      jobId: JOB.id,
      workerId: worker.id,
      fencingToken: 1,
      expiresAt: "2026-07-20T08:31:30.000Z",
      cancelRequested: false,
    }),
    updateJobProgress: vi.fn().mockResolvedValue("UPDATED"),
    // satisfies Partial<> keeps the implemented members' signatures checked even
    // though the double intentionally omits the rest of the interface.
  } satisfies Partial<WorkerControlPlaneRepository> as unknown as WorkerControlPlaneRepository;
  const health = {
    assertUploadAllowed: vi.fn().mockResolvedValue(undefined),
  } satisfies Partial<FreeTierHealthService> as unknown as FreeTierHealthService;
  return {
    repository,
    health,
    service: createJobQueueService({
      repository,
      health,
      pipelineBridgeVersion: "bridge-v1",
      generateId: () => JOB.id,
    }),
  };
}

describe("JobQueueService", () => {
  it("queues only while free-tier health is writable and hashes a project-bound key", async () => {
    const { service, repository, health } = dependencies();
    await expect(service.queueProject(PROJECT_ID, "request-key-123456", NOW)).resolves.toEqual(JOB);
    expect(health.assertUploadAllowed).toHaveBeenCalledWith(0, NOW);
    expect(repository.queueProjectJob).toHaveBeenCalledWith(expect.objectContaining({
      projectId: PROJECT_ID,
      requestKeyDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
  });

  it("maps a non-ready project to JOB_NOT_QUEUEABLE", async () => {
    const { service, repository } = dependencies();
    vi.mocked(repository.queueProjectJob).mockResolvedValue(null);
    await expect(service.queueProject(PROJECT_ID, "request-key-123456", NOW))
      .rejects.toMatchObject({ code: "JOB_NOT_QUEUEABLE", status: 409 });
  });

  it("never lets a control-only release claim media work", async () => {
    const { repository, health } = dependencies();
    const service = createJobQueueService({
      repository,
      health,
      pipelineBridgeVersion: "cp3-control-only",
      generateId: () => JOB.id,
    });
    await expect(service.claim({
      ...worker,
      capabilities: { ...worker.capabilities, pipelineBridgeVersion: "cp3-control-only" },
    }, NOW)).rejects.toMatchObject({ code: "WORKER_INCOMPATIBLE", status: 409 });
    expect(repository.claimJob).not.toHaveBeenCalled();
  });

  it("rejects illegal transitions before writing progress", async () => {
    const { service, repository } = dependencies();
    await expect(service.progress(worker, {
      jobId: JOB.id,
      fencingToken: 1,
      fromState: "CLAIMED",
      state: "COMPLETED",
      progressPercent: 100,
    }, NOW)).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
    expect(repository.updateJobProgress).not.toHaveBeenCalled();
  });

  it.each([
    { label: "omitted telemetry", telemetry: {} },
    {
      label: "explicitly cleared telemetry",
      telemetry: {
        phase: null,
        phaseProgressPercent: null,
        message: null,
        etaSeconds: null,
        processedSeconds: null,
        totalSeconds: null,
        currentPart: null,
        totalParts: null,
        errorCode: null,
      },
    },
  ])("accepts existing progress payloads with $label", async ({ telemetry }) => {
    const { service, repository } = dependencies();
    await expect(service.progress(worker, {
      jobId: JOB.id,
      fencingToken: 1,
      fromState: "CLAIMED",
      state: "DOWNLOADING",
      progressPercent: 5,
      ...telemetry,
    }, NOW)).resolves.toBe("UPDATED");
    expect(repository.updateJobProgress).toHaveBeenCalledWith({
      jobId: JOB.id,
      workerId: worker.id,
      fencingToken: 1,
      fromState: "CLAIMED",
      state: "DOWNLOADING",
      progressPercent: 5,
      now: NOW,
      ...telemetry,
    });
  });

  it("passes bounded telemetry through to the repository", async () => {
    const { service, repository } = dependencies();
    const telemetry = {
      phase: "P".repeat(80),
      phaseProgressPercent: 100,
      message: "M".repeat(500),
      etaSeconds: 31_536_000,
      processedSeconds: 31_536_000,
      totalSeconds: 31_536_000,
      currentPart: 1_000_000,
      totalParts: 1_000_000,
      errorCode: `A${"1".repeat(79)}`,
    };
    await expect(service.progress(worker, {
      jobId: JOB.id,
      fencingToken: 1,
      fromState: "CLAIMED",
      state: "DOWNLOADING",
      progressPercent: 5,
      ...telemetry,
    }, NOW)).resolves.toBe("UPDATED");
    expect(repository.updateJobProgress).toHaveBeenCalledWith({
      jobId: JOB.id,
      workerId: worker.id,
      fencingToken: 1,
      fromState: "CLAIMED",
      state: "DOWNLOADING",
      progressPercent: 5,
      now: NOW,
      ...telemetry,
    });
  });

  it.each([
    { label: "empty phase", telemetry: { phase: "" } },
    { label: "untrimmed phase", telemetry: { phase: " OCR" } },
    { label: "multiline phase", telemetry: { phase: "OCR\nsegment" } },
    { label: "long phase", telemetry: { phase: "P".repeat(81) } },
    { label: "negative phase progress", telemetry: { phaseProgressPercent: -1 } },
    { label: "fractional phase progress", telemetry: { phaseProgressPercent: 0.5 } },
    { label: "large phase progress", telemetry: { phaseProgressPercent: 101 } },
    { label: "empty message", telemetry: { message: "" } },
    { label: "untrimmed message", telemetry: { message: " waiting" } },
    { label: "multiline message", telemetry: { message: "first\rsecond" } },
    { label: "long message", telemetry: { message: "M".repeat(501) } },
    { label: "secret-bearing message", telemetry: { message: "access token: abc123" } },
    { label: "stack trace message", telemetry: { message: "Traceback (most recent call last)" } },
    { label: "negative ETA", telemetry: { etaSeconds: -1 } },
    { label: "fractional ETA", telemetry: { etaSeconds: 0.5 } },
    { label: "large ETA", telemetry: { etaSeconds: 31_536_001 } },
    { label: "negative processed seconds", telemetry: { processedSeconds: -1 } },
    { label: "large processed seconds", telemetry: { processedSeconds: 31_536_001 } },
    { label: "negative total seconds", telemetry: { totalSeconds: -1 } },
    { label: "large total seconds", telemetry: { totalSeconds: 31_536_001 } },
    { label: "negative current part", telemetry: { currentPart: -1 } },
    { label: "large current part", telemetry: { currentPart: 1_000_001 } },
    { label: "negative total parts", telemetry: { totalParts: -1 } },
    { label: "large total parts", telemetry: { totalParts: 1_000_001 } },
    { label: "unsafe error code", telemetry: { errorCode: "worker-failed" } },
    { label: "long error code", telemetry: { errorCode: `A${"1".repeat(80)}` } },
  ])("rejects invalid optional telemetry before mutation: $label", async ({ telemetry }) => {
    const { service, repository } = dependencies();
    await expect(service.progress(worker, {
      jobId: JOB.id,
      fencingToken: 1,
      fromState: "CLAIMED",
      state: "DOWNLOADING",
      progressPercent: 5,
      ...telemetry,
    }, NOW)).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
    expect(repository.updateJobProgress).not.toHaveBeenCalled();
  });

  it("only accepts worker cancellation after a cancel request", async () => {
    const { service, repository } = dependencies();
    await expect(service.progress(worker, {
      jobId: JOB.id,
      fencingToken: 1,
      fromState: "RENDER",
      state: "CANCELLED",
      progressPercent: 75,
    }, NOW)).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
    expect(repository.updateJobProgress).not.toHaveBeenCalled();

    await expect(service.progress(worker, {
      jobId: JOB.id,
      fencingToken: 1,
      fromState: "CANCEL_REQUESTED",
      state: "CANCELLED",
      progressPercent: 75,
    }, NOW)).resolves.toBe("UPDATED");
  });

  it("returns the repository cancellation flag when renewing a lease", async () => {
    const { service, repository } = dependencies();
    vi.mocked(repository.renewLease).mockResolvedValue({
      jobId: JOB.id,
      workerId: worker.id,
      fencingToken: 1,
      expiresAt: "2026-07-20T08:31:30.000Z",
      cancelRequested: true,
    });
    await expect(service.renew(worker, {
      jobId: JOB.id,
      fencingToken: 1,
    }, NOW)).resolves.toMatchObject({ cancelRequested: true });
  });

  it("maps stale lease writes to LEASE_LOST", async () => {
    const { service, repository } = dependencies();
    vi.mocked(repository.updateJobProgress).mockResolvedValue("LEASE_LOST");
    await expect(service.progress(worker, {
      jobId: JOB.id,
      fencingToken: 1,
      fromState: "CLAIMED",
      state: "DOWNLOADING",
      progressPercent: 5,
    }, NOW)).rejects.toMatchObject({ code: "LEASE_LOST", status: 409 });
  });
});

async function progressRoute() {
  vi.resetModules();
  const progress = vi.fn().mockResolvedValue("UPDATED");
  const requireWorkerSession = vi.fn().mockResolvedValue(worker);
  vi.doMock("@/lib/config/env", () => ({
    parseServerEnv: () => ({
      databaseUrl: "postgresql://example.invalid/app",
      workerAuthKeyV1: "A".repeat(43),
      workerPipelineBridgeVersion: "bridge-v1",
    }),
  }));
  vi.doMock("@/lib/http/worker-auth", () => ({ requireWorkerSession }));
  vi.doMock("@/lib/repositories/neon-worker-control-plane", () => ({
    createNeonWorkerControlPlaneRepository: () => ({}),
  }));
  vi.doMock("@/lib/repositories/neon-drive-control-plane", () => ({
    createNeonDriveControlPlaneRepository: () => ({ kind: "driveRepository" }),
  }));
  vi.doMock("@/lib/application/configured-health", () => ({
    createConfiguredFreeTierHealthService: () => ({ kind: "health" }),
  }));
  vi.doMock("@/lib/application/job-queue", () => ({
    createJobQueueService: () => ({ progress }),
  }));
  const { POST } = await import("../../app/api/v1/worker/jobs/[id]/progress/route");
  return { POST, progress };
}

describe("POST /api/v1/worker/jobs/[id]/progress", () => {
  it.each([
    { label: "legacy", telemetry: {} },
    {
      label: "telemetry",
      telemetry: {
        phase: "Rendering",
        phaseProgressPercent: 25,
        message: "Rendering part 1",
        etaSeconds: 120,
        processedSeconds: 30,
        totalSeconds: 120,
        currentPart: 1,
        totalParts: 4,
        errorCode: null,
      },
    },
  ])("accepts a $label payload", async ({ telemetry }) => {
    const { POST, progress } = await progressRoute();
    const body = {
      fencingToken: 1,
      fromState: "TTS",
      state: "RENDER",
      progressPercent: 60,
      ...telemetry,
    };
    const response = await POST(new Request(`https://app.example/api/v1/worker/jobs/${JOB.id}/progress`, {
      method: "POST",
      body: JSON.stringify(body),
    }) as never, { params: Promise.resolve({ id: JOB.id }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "UPDATED" });
    expect(progress).toHaveBeenCalledWith(worker, { ...body, jobId: JOB.id }, expect.any(Date));
  });

  it.each([
    { label: "unknown field", telemetry: { rawLog: "worker output" } },
    { label: "untrimmed phase", telemetry: { phase: " Rendering" } },
    { label: "oversized message", telemetry: { message: "M".repeat(501) } },
    { label: "fractional phase progress", telemetry: { phaseProgressPercent: 0.5 } },
    { label: "oversized ETA", telemetry: { etaSeconds: 31_536_001 } },
    { label: "unsafe error code", telemetry: { errorCode: "worker-failed" } },
  ])("rejects malformed telemetry before service mutation: $label", async ({ telemetry }) => {
    const { POST, progress } = await progressRoute();
    const response = await POST(new Request(`https://app.example/api/v1/worker/jobs/${JOB.id}/progress`, {
      method: "POST",
      body: JSON.stringify({
        fencingToken: 1,
        fromState: "TTS",
        state: "RENDER",
        progressPercent: 60,
        ...telemetry,
      }),
    }) as never, { params: Promise.resolve({ id: JOB.id }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_REQUEST" });
    expect(progress).not.toHaveBeenCalled();
  });
});
