import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/domain/errors";

const { env, requireAdmin, requireMutationOrigin, createService, createRepository } = vi.hoisted(() => ({
  env: {
    databaseUrl: "postgresql://example.invalid/app",
    sessionSecret: "s".repeat(64),
    appOrigin: "https://app.example",
    workerAuthKeyV1: "A".repeat(43),
    workerReleaseRepository: "https://github.com/manhthien2005/ytb-vps-scene.git",
    workerReleaseCommit: "a".repeat(40),
    workerPipelineBridgeVersion: "cp3-control-only",
  },
  requireAdmin: vi.fn().mockResolvedValue(undefined),
  requireMutationOrigin: vi.fn(),
  createService: vi.fn(),
  createRepository: vi.fn(() => ({})),
}));

vi.mock("@/lib/config/env", () => ({ parseServerEnv: () => env }));
vi.mock("@/lib/http/requests", () => ({
  requireAdmin,
  requireMutationOrigin,
  readStrictJson: vi.fn(),
}));
vi.mock("@/lib/repositories/neon-worker-control-plane", () => ({
  createNeonWorkerControlPlaneRepository: createRepository,
}));
vi.mock("@/lib/application/worker-control", () => ({
  createWorkerControlService: createService,
}));

import { POST } from "./route";

describe("POST /api/v1/workers/enrollment", () => {
  it("requires admin before exposing a command", async () => {
    requireAdmin.mockRejectedValueOnce(new AppError("AUTH_REQUIRED", 401));
    const response = await POST(new Request("https://app.example/api/v1/workers/enrollment", { method: "POST" }) as never);
    expect(response.status).toBe(401);
    expect(createService).not.toHaveBeenCalled();
  });

  it("returns only one expiring command", async () => {
    const createEnrollment = vi.fn().mockResolvedValue({
      command: "curl -fsSL https://raw.githubusercontent.com/example/repo/commit/ops/native-v2/bootstrap-worker.sh | sudo bash",
      expiresAt: "2026-07-20T08:40:00.000Z",
    });
    createService.mockReturnValueOnce({ createEnrollment });
    const response = await POST(new Request("https://app.example/api/v1/workers/enrollment", { method: "POST" }) as never);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({ command: expect.any(String), expiresAt: expect.any(String) });
    expect(JSON.stringify(body)).not.toContain("sessionSecret");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
