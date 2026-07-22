import { describe, expect, it, vi } from "vitest";

const { env, requireWorkerSession, createJobQueueService, getAccessToken } = vi.hoisted(() => ({
  env: {
    databaseUrl: "postgresql://example.invalid/app",
    workerAuthKeyV1: "A".repeat(43),
    workerPipelineBridgeVersion: "cp4-media-v1",
  },
  requireWorkerSession: vi.fn().mockResolvedValue({ id: "10000000-0000-4000-8000-000000000001" }),
  createJobQueueService: vi.fn(),
  getAccessToken: vi.fn().mockResolvedValue("short-lived-drive-access-token"),
}));

vi.mock("@/lib/config/env", () => ({ parseServerEnv: () => env }));
vi.mock("@/lib/http/worker-auth", () => ({ requireWorkerSession }));
vi.mock("@/lib/repositories/neon-worker-control-plane", () => ({ createNeonWorkerControlPlaneRepository: () => ({}) }));
vi.mock("@/lib/repositories/neon-drive-control-plane", () => ({ createNeonDriveControlPlaneRepository: () => ({}) }));
vi.mock("@/lib/application/configured-health", () => ({ createConfiguredFreeTierHealthService: () => ({}) }));
vi.mock("@/lib/application/configured-drive", () => ({ createConfiguredDrive: () => ({ access: { getAccessToken } }) }));
vi.mock("@/lib/application/job-queue", () => ({ createJobQueueService }));

import { POST } from "./route";

describe("POST /api/v1/worker/claim", () => {
  it("returns one short-lived Drive access token only with a successful assignment", async () => {
    const assignment = {
      job: { id: "40000000-0000-4000-8000-000000000001", projectName: "Video test", state: "CLAIMED", progressPercent: 0, updatedAt: "2026-07-20T08:30:00.000Z" },
      lease: { jobId: "40000000-0000-4000-8000-000000000001", workerId: "10000000-0000-4000-8000-000000000001", fencingToken: 1, expiresAt: "2026-07-20T08:31:30.000Z" },
      execution: {
        projectId: "20000000-0000-4000-8000-000000000001",
        source: { driveFileId: "drive-source-001", fileName: "source.mp4", mimeType: "video/mp4", sizeBytes: 100 },
        outputParentId: "drive-project-001",
        sceneSettings: {
          sourceSubtitle: { x: 0.1, y: 0.7, width: 0.8, height: 0.2 },
          logo: { x: 0.8, y: 0.05, width: 0.15, height: 0.1 },
          voice: "BV074_streaming",
          rate: 1,
        },
      },
    };
    createJobQueueService.mockReturnValueOnce({ claim: vi.fn().mockResolvedValue(assignment) });

    const response = await POST(new Request("https://app.example/api/v1/worker/claim", { method: "POST" }) as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ...assignment, driveAccessToken: "short-lived-drive-access-token" });
    expect(JSON.stringify(body)).not.toMatch(/refreshToken|ciphertext|sessionUri/);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
