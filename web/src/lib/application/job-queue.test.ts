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
    }),
    updateJobProgress: vi.fn().mockResolvedValue("UPDATED"),
  } as unknown as WorkerControlPlaneRepository;
  const health = { assertUploadAllowed: vi.fn().mockResolvedValue(undefined) } as unknown as FreeTierHealthService;
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
