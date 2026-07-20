import { describe, expect, it, vi } from "vitest";
import type { WorkerView } from "@/lib/domain/worker";
import { readWorkerBearer, requireWorkerSession, type WorkerSessionRepository } from "./worker-auth";

const SECRET = Buffer.alloc(32, 7).toString("base64url");
const KEY = Buffer.alloc(32, 3).toString("base64url");
const NOW = new Date("2026-07-20T08:30:00.000Z");

const worker: WorkerView = {
  id: "018f6ae9-588a-72e3-b3b0-11ba9fea291b",
  state: "READY",
  accountLabel: null,
  capabilities: {
    protocolVersion: 1,
    pipelineBridgeVersion: "cp3-control-only",
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

function repository(result: WorkerView | null = worker): WorkerSessionRepository & {
  authenticateWorker: ReturnType<typeof vi.fn>;
} {
  return { authenticateWorker: vi.fn().mockResolvedValue(result) };
}

describe("worker HTTP authentication", () => {
  it("reads one exact bearer value", () => {
    const request = new Request("https://app.example/api/v1/worker/heartbeat", {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(readWorkerBearer(request)).toBe(SECRET);
  });

  it.each([null, "Basic abc", "Bearer", "Bearer a b", "bearer " + SECRET, "Bearer short"])(
    "rejects malformed Authorization before repository access",
    async (authorization) => {
      const repo = repository();
      const request = new Request("https://app.example/api/v1/worker/heartbeat", {
        headers: authorization === null ? {} : { authorization },
      });
      await expect(requireWorkerSession(request, repo, KEY, NOW))
        .rejects.toMatchObject({ code: "WORKER_AUTH_REQUIRED", status: 401 });
      expect(repo.authenticateWorker).not.toHaveBeenCalled();
    },
  );

  it("authenticates by digest and returns the sanitized worker", async () => {
    const repo = repository();
    const request = new Request("https://app.example/api/v1/worker/heartbeat", {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    await expect(requireWorkerSession(request, repo, KEY, NOW)).resolves.toEqual(worker);
    expect(repo.authenticateWorker).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{64}$/), NOW);
    expect(JSON.stringify(repo.authenticateWorker.mock.calls)).not.toContain(SECRET);
  });

  it("maps a missing or expired session without echoing the secret", async () => {
    const request = new Request("https://app.example/api/v1/worker/heartbeat", {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    const promise = requireWorkerSession(request, repository(null), KEY, NOW);
    await expect(promise).rejects.toMatchObject({ code: "WORKER_SESSION_EXPIRED", status: 401 });
    await expect(promise).rejects.not.toThrow(SECRET);
  });

  it("rejects a revoked worker", async () => {
    const request = new Request("https://app.example/api/v1/worker/heartbeat", {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    await expect(requireWorkerSession(request, repository({ ...worker, state: "REVOKED" }), KEY, NOW))
      .rejects.toMatchObject({ code: "WORKER_REVOKED", status: 401 });
  });
});
