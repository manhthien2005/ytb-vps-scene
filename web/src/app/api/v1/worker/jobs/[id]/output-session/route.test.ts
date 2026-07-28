import { beforeEach, describe, expect, it, vi } from "vitest";

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
  const jobId = "40000000-0000-4000-8000-000000000001";
  const workerId = "10000000-0000-4000-8000-000000000001";
  const execution = {
    projectId: "20000000-0000-4000-8000-000000000001",
    outputParentId: "drive-project-001",
  };
  const output = {
    fencingToken: 1,
    partIndex: 1,
    partCount: 2,
    sizeBytes: 1234,
    checksumSha256: "a".repeat(64),
  };

  beforeEach(() => {
    vi.resetAllMocks();
    requireWorkerSession.mockResolvedValue({ id: workerId });
    repository.getFencedExecution.mockResolvedValue(execution);
    repository.reserveOutput.mockResolvedValue("RESERVED");
    drive.access.getAccessToken.mockResolvedValue("access-token");
    drive.files.ensureOutputFile.mockResolvedValue("drive-output-001");
    drive.files.createResumableUpdateSession.mockResolvedValue({
      sessionUri: "https://www.googleapis.com/upload/drive/v3/files/drive-output-001?upload_id=x",
      expiresAt: "2026-07-26T00:00:00.000Z",
    });
  });

  async function createSession(
    requestedJobId = jobId,
    requestedOutput: typeof output = output,
  ) {
    return POST(new Request(
      `https://app.example/api/v1/worker/jobs/${requestedJobId}/output-session`,
      {
        method: "POST",
        body: JSON.stringify(requestedOutput),
      },
    ) as never, { params: Promise.resolve({ id: requestedJobId }) });
  }

  it("derives a deterministic v2 artifact UUID from the exact Part identity", async () => {
    repository.getFencedExecution.mockResolvedValue({ projectId: "20000000-0000-4000-8000-000000000001", outputParentId: "drive-project-001" });
    repository.reserveOutput.mockResolvedValue("RESERVED");
    const first = await (await createSession()).json();
    const replay = await (await createSession()).json();
    const secondPart = await (await createSession(jobId, {
      ...output,
      partIndex: 2,
    })).json();

    expect(first.artifactId).toBe(replay.artifactId);
    expect(first.artifactId).toBe("81c8cdf8-dc42-548b-9054-a3a30f68bc9d");
    expect(secondPart.artifactId).not.toBe(first.artifactId);
    expect(first.artifactId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(drive.files.ensureOutputFile).toHaveBeenLastCalledWith(
      "access-token",
      expect.objectContaining({ partIndex: 2, partCount: 2 }),
    );
    expect(repository.reserveOutput).toHaveBeenLastCalledWith(
      expect.objectContaining({ partIndex: 2, partCount: 2 }),
    );
  });

  it.each(["RESERVED", "PENDING_REPLAY"] as const)(
    "returns a fresh resumable session for %s",
    async (outcome) => {
      repository.reserveOutput.mockResolvedValue(outcome);
      const response = await createSession();
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body).toEqual({
        status: "UPLOAD",
        artifactId: expect.any(String),
        driveFileId: "drive-output-001",
        sessionUri: "https://www.googleapis.com/upload/drive/v3/files/drive-output-001?upload_id=x",
        expiresAt: "2026-07-26T00:00:00.000Z",
      });
      expect(JSON.stringify(body)).not.toContain("refreshToken");
    },
  );

  it("returns READY without creating a resumable session for an exact READY replay", async () => {
    repository.reserveOutput.mockResolvedValue("READY_REPLAY");
    const response = await createSession();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: "READY",
      artifactId: expect.any(String),
      driveFileId: "drive-output-001",
    });
    expect(drive.files.createResumableUpdateSession).not.toHaveBeenCalled();
  });

  it.each([
    { partIndex: 0, partCount: 2 },
    { partIndex: 1, partCount: 0 },
    { partIndex: 3, partCount: 2 },
    { partIndex: 1, partCount: 1_000 },
  ])("rejects invalid Part metadata %#", async (invalid) => {
    const response = await createSession(jobId, { ...output, ...invalid });
    expect(response.status).toBe(400);
    expect(drive.files.ensureOutputFile).not.toHaveBeenCalled();
  });
});
