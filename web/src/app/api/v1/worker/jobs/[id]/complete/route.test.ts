import { describe, expect, it, vi } from "vitest";

const { env, repository, drive, requireWorkerSession } = vi.hoisted(() => ({
  env: { databaseUrl: "postgresql://example.invalid/app", workerAuthKeyV1: "A".repeat(43) },
  repository: {
    getFencedExecution: vi.fn(),
    completeOutput: vi.fn(),
  },
  drive: {
    access: { getAccessToken: vi.fn().mockResolvedValue("access-token") },
    files: { inspectFile: vi.fn() },
  },
  requireWorkerSession: vi.fn().mockResolvedValue({ id: "10000000-0000-4000-8000-000000000001" }),
}));

vi.mock("@/lib/config/env", () => ({ parseServerEnv: () => env }));
vi.mock("@/lib/http/worker-auth", () => ({ requireWorkerSession }));
vi.mock("@/lib/repositories/neon-worker-control-plane", () => ({ createNeonWorkerControlPlaneRepository: () => repository }));
vi.mock("@/lib/repositories/neon-drive-control-plane", () => ({ createNeonDriveControlPlaneRepository: () => ({}) }));
vi.mock("@/lib/application/configured-drive", () => ({ createConfiguredDrive: () => drive }));

import { POST } from "./route";

describe("POST /api/v1/worker/jobs/[id]/complete", () => {
  it("rejects a remote output whose parent or appProperties do not match the claimed project", async () => {
    repository.getFencedExecution.mockResolvedValue({ projectId: "20000000-0000-4000-8000-000000000001", outputParentId: "drive-project-001" });
    drive.files.inspectFile.mockResolvedValue({ id: "drive-output-001", name: "part-01-of-01.mp4", mimeType: "video/mp4", sizeBytes: 1234, parentIds: ["wrong-parent"], trashed: false, appProperties: {} });
    const response = await POST(new Request("https://app.example/api/v1/worker/jobs/job-001/complete", {
      method: "POST",
      body: JSON.stringify({ artifactId: "50000000-0000-4000-8000-000000000001", driveFileId: "drive-output-001", fencingToken: 1, sizeBytes: 1234 }),
    }) as never, { params: Promise.resolve({ id: "40000000-0000-4000-8000-000000000001" }) });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ code: "DRIVE_REMOTE_MISMATCH" });
    expect(repository.completeOutput).not.toHaveBeenCalled();
  });
});
