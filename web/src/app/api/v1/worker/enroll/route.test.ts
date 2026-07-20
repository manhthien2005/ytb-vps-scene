import { describe, expect, it, vi } from "vitest";

const { env, createService, createRepository } = vi.hoisted(() => ({
  env: {
    databaseUrl: "postgresql://example.invalid/app",
    workerAuthKeyV1: "A".repeat(43),
    appOrigin: "https://app.example",
    workerReleaseRepository: "https://github.com/Vanvuong2005827/REUP-RENDER.git",
    workerReleaseCommit: "a".repeat(40),
    workerPipelineBridgeVersion: "cp3-control-only",
  },
  createService: vi.fn(),
  createRepository: vi.fn(() => ({})),
}));
vi.mock("@/lib/config/env", () => ({ parseServerEnv: () => env }));
vi.mock("@/lib/repositories/neon-worker-control-plane", () => ({ createNeonWorkerControlPlaneRepository: createRepository }));
vi.mock("@/lib/application/worker-control", () => ({ createWorkerControlService: createService }));

import { POST } from "./route";

describe("POST /api/v1/worker/enroll", () => {
  it("returns the ephemeral session only to the enrolling worker", async () => {
    const enroll = vi.fn().mockResolvedValue({
      workerId: "10000000-0000-4000-8000-000000000001",
      sessionSecret: "A".repeat(43),
      sessionExpiresAt: "2026-07-21T08:30:00.000Z",
    });
    createService.mockReturnValueOnce({ enroll });
    const request = new Request("https://app.example/api/v1/worker/enroll", {
      method: "POST",
      body: JSON.stringify({
        enrollmentToken: "A".repeat(43),
        capabilities: {
          protocolVersion: 1, pipelineBridgeVersion: "cp3-control-only", os: "ubuntu-22.04", arch: "x86_64",
          gpuName: "RTX", vramMiB: 12288, cudaVersion: "12.4", nvenc: true,
        },
        doctor: { status: "PASS", reasonCodes: [], observedAt: "2026-07-20T08:30:00.000Z" },
      }),
    });
    const response = await POST(request as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("sessionSecret", "A".repeat(43));
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
