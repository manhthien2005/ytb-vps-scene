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
  it("derives one valid artifact UUID from the job and output identity across replays", async () => {
    repository.getFencedExecution.mockResolvedValue({ projectId: "20000000-0000-4000-8000-000000000001", outputParentId: "drive-project-001" });
    repository.reserveOutput.mockResolvedValue("RESERVED");
    const jobId = "40000000-0000-4000-8000-000000000001";
    const request = { fencingToken: 1, sizeBytes: 1234, checksumSha256: "a".repeat(64) };
    const createSession = async (
      requestedJobId: string,
      requestedOutput: typeof request,
    ) => {
      const response = await POST(new Request(`https://app.example/api/v1/worker/jobs/${requestedJobId}/output-session`, {
        method: "POST",
        body: JSON.stringify(requestedOutput),
      }) as never, { params: Promise.resolve({ id: requestedJobId }) });
      expect(response.status).toBe(200);
      return response.json();
    };

    const first = await createSession(jobId, request);
    const replay = await createSession(jobId, request);
    expect(first.artifactId).toBe(replay.artifactId);
    expect(first.artifactId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(drive.files.ensureOutputFile.mock.calls.slice(0, 2).map(([, input]) => input.artifactId))
      .toEqual([first.artifactId, first.artifactId]);
    expect(drive.files.createResumableUpdateSession.mock.calls.slice(0, 2).map(([, input]) => input.fileId))
      .toEqual(["drive-output-001", "drive-output-001"]);
    expect(repository.reserveOutput.mock.calls.slice(0, 2).map(([input]) => input.artifactId))
      .toEqual([first.artifactId, first.artifactId]);

    const differentFence = await createSession(jobId, { ...request, fencingToken: 2 });
    requireWorkerSession.mockResolvedValueOnce({ id: "10000000-0000-4000-8000-000000000002" });
    const differentWorker = await createSession(jobId, request);
    expect([differentFence.artifactId, differentWorker.artifactId])
      .toEqual([first.artifactId, first.artifactId]);

    const differentJob = await createSession("40000000-0000-4000-8000-000000000002", request);
    const differentSize = await createSession(jobId, { ...request, sizeBytes: 1235 });
    const differentChecksum = await createSession(jobId, { ...request, checksumSha256: "b".repeat(64) });
    expect(new Set([first.artifactId, differentJob.artifactId, differentSize.artifactId, differentChecksum.artifactId]).size).toBe(4);
  });

  it("creates a fenced resumable output session without returning any refresh credential", async () => {
    repository.getFencedExecution.mockResolvedValue({ projectId: "20000000-0000-4000-8000-000000000001", outputParentId: "drive-project-001" });
    repository.reserveOutput.mockResolvedValue("RESERVED");
    const response = await POST(new Request("https://app.example/api/v1/worker/jobs/job-001/output-session", {
      method: "POST",
      body: JSON.stringify({ fencingToken: 1, sizeBytes: 1234, checksumSha256: "a".repeat(64) }),
    }) as never, { params: Promise.resolve({ id: "40000000-0000-4000-8000-000000000001" }) });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({
      artifactId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      driveFileId: "drive-output-001",
      sessionUri: "https://www.googleapis.com/upload/drive/v3/files/drive-output-001?upload_id=x",
      expiresAt: "2026-07-26T00:00:00.000Z",
    });
    expect(JSON.stringify(body)).not.toContain("refreshToken");
  });
});
