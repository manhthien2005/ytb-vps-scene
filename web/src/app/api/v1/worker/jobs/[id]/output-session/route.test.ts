import { describe, expect, it, vi } from "vitest";

const { env, repository, drive, requireWorkerSession } = vi.hoisted(() => ({
  env: { databaseUrl: "postgresql://example.invalid/app", workerAuthKeyV1: "A".repeat(43) },
  repository: {
    getFencedExecution: vi.fn(),
    reserveOutput: vi.fn(),
  },
  drive: {
    access: { getAccessToken: vi.fn().mockResolvedValue("access-token") },
    files: {
      ensureOutputFile: vi.fn().mockResolvedValue("drive-output-001"),
      createResumableUpdateSession: vi.fn().mockResolvedValue({ sessionUri: "https://www.googleapis.com/upload/drive/v3/files/drive-output-001?upload_id=x", expiresAt: "2026-07-26T00:00:00.000Z" }),
      deleteFile: vi.fn(),
    },
  },
  requireWorkerSession: vi.fn().mockResolvedValue({ id: "10000000-0000-4000-8000-000000000001" }),
}));

vi.mock("@/lib/config/env", () => ({ parseServerEnv: () => env }));
vi.mock("@/lib/http/worker-auth", () => ({ requireWorkerSession }));
vi.mock("@/lib/repositories/neon-worker-control-plane", () => ({ createNeonWorkerControlPlaneRepository: () => repository }));
vi.mock("@/lib/repositories/neon-drive-control-plane", () => ({ createNeonDriveControlPlaneRepository: () => ({}) }));
vi.mock("@/lib/application/configured-drive", () => ({ createConfiguredDrive: () => drive }));

import { POST } from "./route";

describe("POST /api/v1/worker/jobs/[id]/output-session", () => {
  it("creates a fenced resumable output session without returning any refresh credential", async () => {
    repository.getFencedExecution.mockResolvedValue({ projectId: "20000000-0000-4000-8000-000000000001", outputParentId: "drive-project-001" });
    repository.reserveOutput.mockResolvedValue("RESERVED");
    const response = await POST(new Request("https://app.example/api/v1/worker/jobs/job-001/output-session", {
      method: "POST",
      body: JSON.stringify({ fencingToken: 1, sizeBytes: 1234, checksumSha256: "a".repeat(64) }),
    }) as never, { params: Promise.resolve({ id: "40000000-0000-4000-8000-000000000001" }) });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ artifactId: expect.any(String), driveFileId: "drive-output-001", sessionUri: expect.stringContaining("https://www.googleapis.com/") });
    expect(JSON.stringify(body)).not.toContain("refreshToken");
  });
});
