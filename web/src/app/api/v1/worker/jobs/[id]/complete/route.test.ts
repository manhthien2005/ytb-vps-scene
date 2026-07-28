import { beforeEach, describe, expect, it, vi } from "vitest";

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
  const jobId = "40000000-0000-4000-8000-000000000001";
  const workerId = "10000000-0000-4000-8000-000000000001";
  const execution = {
    projectId: "20000000-0000-4000-8000-000000000001",
    outputParentId: "drive-project-001",
  };
  const completion = {
    artifactId: "50000000-0000-4000-8000-000000000001",
    driveFileId: "drive-output-001",
    fencingToken: 1,
    partIndex: 2,
    partCount: 4,
    sizeBytes: 1234,
  };
  const remoteFile = {
    id: completion.driveFileId,
    name: "part-02-of-04.mp4",
    mimeType: "video/mp4",
    sizeBytes: completion.sizeBytes,
    parentIds: [execution.outputParentId],
    trashed: false,
    appProperties: {
      ytbVpsProjectId: execution.projectId,
      ytbVpsArtifactId: completion.artifactId,
      ytbVpsJobId: jobId,
      ytbVpsRole: "output",
      ytbVpsPartIndex: "2",
      ytbVpsPartCount: "4",
      schema: "1",
    },
  };

  beforeEach(() => {
    vi.resetAllMocks();
    requireWorkerSession.mockResolvedValue({ id: workerId });
    repository.getFencedExecution.mockResolvedValue(execution);
    repository.completeOutput.mockResolvedValue("PART_COMPLETED");
    drive.access.getAccessToken.mockResolvedValue("access-token");
    drive.files.inspectFile.mockResolvedValue(remoteFile);
  });

  async function complete(body: typeof completion = completion) {
    return POST(new Request(
      `https://app.example/api/v1/worker/jobs/${jobId}/complete`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ) as never, { params: Promise.resolve({ id: jobId }) });
  }

  it.each(["PART_COMPLETED", "COMPLETED", "REPLAY"] as const)(
    "verifies exact Part 2/4 Drive identity and propagates %s",
    async (outcome) => {
      repository.completeOutput.mockResolvedValue(outcome);
      const response = await complete();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: outcome });
      expect(repository.completeOutput).toHaveBeenCalledWith(
        expect.objectContaining({
          partIndex: 2,
          partCount: 4,
        }),
      );
    },
  );

  it("replays an exact READY completion after the final lease was released", async () => {
    repository.getFencedExecution.mockResolvedValue(null);
    repository.completeOutput.mockResolvedValue("REPLAY");
    const response = await complete();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "REPLAY" });
    expect(repository.completeOutput).toHaveBeenCalledWith(
      expect.objectContaining({ partIndex: 2, partCount: 4 }),
    );
    expect(drive.files.inspectFile).not.toHaveBeenCalled();
  });

  it.each([
    ["parent", { ...remoteFile, parentIds: ["wrong-parent"] }],
    ["name", { ...remoteFile, name: "part-01-of-04.mp4" }],
    ["Part properties", {
      ...remoteFile,
      appProperties: {
        ...remoteFile.appProperties,
        ytbVpsPartIndex: "1",
      },
    }],
  ])("rejects a remote output whose %s does not match", async (_field, mismatch) => {
    drive.files.inspectFile.mockResolvedValue(mismatch);
    const response = await complete();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ code: "DRIVE_REMOTE_MISMATCH" });
    expect(repository.completeOutput).not.toHaveBeenCalled();
  });

  it.each([
    { partIndex: 0, partCount: 4 },
    { partIndex: 2, partCount: 0 },
    { partIndex: 5, partCount: 4 },
    { partIndex: 2, partCount: 1_000 },
  ])("rejects invalid Part metadata %#", async (invalid) => {
    const response = await complete({ ...completion, ...invalid });
    expect(response.status).toBe(400);
    expect(drive.files.inspectFile).not.toHaveBeenCalled();
  });
});
