import { describe, expect, it, vi } from "vitest";
import type { WorkerControlPlaneRepository } from "@/lib/repositories/worker-control-plane";
import { createWorkerControlService } from "./worker-control";

const NOW = new Date("2026-07-20T08:30:00.000Z");
const TOKEN = Buffer.alloc(32, 7).toString("base64url");
const SESSION = Buffer.alloc(32, 8).toString("base64url");
const KEY = Buffer.alloc(32, 3).toString("base64url");
const capabilities = {
  protocolVersion: 1 as const,
  pipelineBridgeVersion: "cp3-control-only",
  os: "ubuntu-22.04" as const,
  arch: "x86_64" as const,
  gpuName: "NVIDIA GeForce RTX 3060",
  vramMiB: 12_288,
  cudaVersion: "12.4",
  nvenc: true,
};
const doctor = { status: "PASS" as const, reasonCodes: [], observedAt: NOW.toISOString() };

function repository(): WorkerControlPlaneRepository {
  return {
    createEnrollment: vi.fn().mockResolvedValue(undefined),
    enrollWorker: vi.fn().mockImplementation(async (input) => ({
      outcome: "ENROLLED",
      worker: {
        id: input.workerId,
        state: input.state,
        accountLabel: input.accountLabel,
        capabilities: input.capabilities,
        doctor: input.doctor,
        lastHeartbeatAt: input.now.toISOString(),
        sessionExpiresAt: input.sessionExpiresAt.toISOString(),
      },
    })),
    authenticateWorker: vi.fn(),
    heartbeatWorker: vi.fn(),
    listWorkers: vi.fn().mockResolvedValue([]),
    revokeWorker: vi.fn().mockResolvedValue(true),
    queueProjectJob: vi.fn(),
    claimJob: vi.fn(),
    renewLease: vi.fn(),
    updateJobProgress: vi.fn(),
    getFencedExecution: vi.fn(),
    reserveOutput: vi.fn(),
    completeOutput: vi.fn(),
    expireWorkersAndLeases: vi.fn(),
  };
}

function service(repo = repository(), secrets = [TOKEN, SESSION]) {
  let index = 0;
  return {
    repo,
    value: createWorkerControlService({
      repository: repo,
      authKey: KEY,
      appOrigin: "https://app.example",
      releaseRepository: "https://github.com/manhthien2005/ytb-vps-scene.git",
      releaseCommit: "a".repeat(40),
      pipelineBridgeVersion: "cp3-control-only",
      generateSecret: () => secrets[index++]!,
      generateId: () => "10000000-0000-4000-8000-000000000001",
    }),
  };
}

describe("WorkerControlService", () => {
  it("returns one expiring command without persisting plaintext enrollment material", async () => {
    const { repo, value } = service();
    const result = await value.createEnrollment(NOW);

    expect(result.command).toMatch(/^curl -fsSL https:\/\//);
    expect(result.command).toContain("bootstrap-worker.sh");
    expect(result.command).toContain(TOKEN);
    expect(result.expiresAt).toBe("2026-07-20T09:00:00.000Z");
    expect(result).not.toHaveProperty("token");
    expect(repo.createEnrollment).toHaveBeenCalledWith(expect.objectContaining({
      tokenDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
    expect(JSON.stringify(vi.mocked(repo.createEnrollment).mock.calls)).not.toContain(TOKEN);
  });

  it("consumes enrollment and returns the only plaintext worker session once", async () => {
    const { repo, value } = service(undefined, [SESSION]);
    const result = await value.enroll({ enrollmentToken: TOKEN, capabilities, doctor }, NOW);
    expect(result).toEqual({
      workerId: "10000000-0000-4000-8000-000000000001",
      sessionSecret: SESSION,
      sessionExpiresAt: "2026-07-21T08:30:00.000Z",
    });
    const call = vi.mocked(repo.enrollWorker).mock.calls[0]![0];
    expect(call.sessionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(call)).not.toContain(SESSION);
    expect(call.state).toBe("READY");
  });

  it("maps an invalid or replayed enrollment to one stable public error", async () => {
    const repo = repository();
    vi.mocked(repo.enrollWorker).mockResolvedValue(null);
    await expect(service(repo).value.enroll({ enrollmentToken: TOKEN, capabilities, doctor }, NOW))
      .rejects.toMatchObject({ code: "WORKER_ENROLLMENT_INVALID", status: 401 });
  });

  it("derives heartbeat state from doctor evidence and compatibility", async () => {
    const repo = repository();
    vi.mocked(repo.heartbeatWorker).mockResolvedValue({
      id: "10000000-0000-4000-8000-000000000001",
      state: "DOCTOR_FAILED",
      accountLabel: null,
      capabilities,
      doctor: { ...doctor, status: "FAIL", reasonCodes: ["CUDA_MISSING"] },
      lastHeartbeatAt: NOW.toISOString(),
      sessionExpiresAt: "2026-07-21T08:30:00.000Z",
    });
    await service(repo).value.heartbeat(
      "10000000-0000-4000-8000-000000000001",
      { capabilities, doctor: { ...doctor, status: "FAIL", reasonCodes: ["CUDA_MISSING"] } },
      NOW,
    );
    expect(repo.heartbeatWorker).toHaveBeenCalledWith(expect.objectContaining({ state: "DOCTOR_FAILED" }));
  });
});
