import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DriveVideoMetadata } from "@/lib/domain/drive";
import { AppError } from "@/lib/domain/errors";
import type { DriveAccessProvider, DriveFilesPort } from "@/lib/ports/drive";
import type {
  DriveControlPlaneRepository,
  ManagedDeletionClaim,
  ManagedArtifactRecord,
} from "@/lib/repositories/drive-control-plane";
import { createDriveWorkspaceService } from "./drive-workspace";

const PROJECT_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_PROJECT_ID = "10000000-0000-4000-8000-000000000002";
const SOURCE_ID = "20000000-0000-4000-8000-000000000001";
const OUTPUT_ID = "20000000-0000-4000-8000-000000000002";
const OTHER_ID = "20000000-0000-4000-8000-000000000003";
const VIEW_URL = "https://drive.google.com/file/d/source/view";
const DOWNLOAD_URL = "https://drive.usercontent.google.com/download?id=source";
const VERIFIED_AT = "2026-07-21T10:00:00.000Z";
const MODIFIED_AT = "2026-07-21T11:00:00.000Z";

function record(input: Omit<Partial<ManagedArtifactRecord>, "artifact"> & {
  artifact?: Partial<ManagedArtifactRecord["artifact"]>;
} = {}): ManagedArtifactRecord {
  return {
    projectName: input.projectName ?? "Phim A",
    jobId: input.jobId ?? null,
    verifiedAt: input.verifiedAt === undefined ? VERIFIED_AT : input.verifiedAt,
    artifact: {
      id: input.artifact?.id ?? SOURCE_ID,
      projectId: input.artifact?.projectId ?? PROJECT_ID,
      kind: input.artifact?.kind ?? "SOURCE",
      status: input.artifact?.status ?? "READY",
      driveFileId: input.artifact?.driveFileId ?? "drive-source-file-001",
      driveParentId: input.artifact?.driveParentId ?? "drive-input-folder-001",
      displayName: input.artifact?.displayName ?? "source.mp4",
      mimeType: input.artifact?.mimeType ?? "video/mp4",
      expectedSizeBytes: input.artifact?.expectedSizeBytes ?? 100,
      actualSizeBytes: input.artifact?.actualSizeBytes === undefined
        ? 100
        : input.artifact.actualSizeBytes,
    },
  };
}

function metadata(item: ManagedArtifactRecord): DriveVideoMetadata {
  return {
    id: item.artifact.driveFileId,
    name: item.artifact.displayName,
    mimeType: item.artifact.mimeType,
    sizeBytes: item.artifact.actualSizeBytes ?? item.artifact.expectedSizeBytes,
    parentIds: [item.artifact.driveParentId],
    createdTime: "2026-07-20T09:00:00.000Z",
    modifiedTime: MODIFIED_AT,
    width: 1920,
    height: 1080,
    durationMillis: 1_000,
    webViewLink: VIEW_URL,
    webContentLink: DOWNLOAD_URL,
    appProperties: {
      schema: "1",
      ytbVpsArtifactId: item.artifact.id,
      ytbVpsProjectId: item.artifact.projectId,
      ytbVpsRole: item.artifact.kind.toLowerCase(),
    },
  };
}

describe("DriveWorkspaceService", () => {
  let records: ManagedArtifactRecord[];
  let repository: Pick<
    DriveControlPlaneRepository,
    "listManagedArtifacts" | "claimManagedArtifactDeletion" | "markManagedArtifactDeleted"
  >;
  let access: DriveAccessProvider;
  let files: Pick<DriveFilesPort, "inspectVideoMetadata" | "deleteFile">;
  let diagnostics: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    records = [
      record(),
      record({
        jobId: "30000000-0000-4000-8000-000000000001",
        artifact: {
          id: OUTPUT_ID,
          kind: "OUTPUT",
          driveFileId: "drive-output-file-001",
          driveParentId: "drive-project-folder-001",
          displayName: "part-01-of-04.mp4",
          expectedSizeBytes: 200,
          actualSizeBytes: 200,
        },
      }),
    ];
    repository = {
      listManagedArtifacts: vi.fn(async () => structuredClone(records)),
      claimManagedArtifactDeletion: vi.fn(async (): Promise<ManagedDeletionClaim> => "CLAIMED"),
      markManagedArtifactDeleted: vi.fn(async (): Promise<"CHANGED" | "REPLAY"> => "CHANGED"),
    };
    access = { getAccessToken: vi.fn(async () => "access-token-secret") };
    files = {
      inspectVideoMetadata: vi.fn(async (_token, fileId) => {
        const item = records.find((candidate) => candidate.artifact.driveFileId === fileId);
        if (!item) throw new Error("missing test metadata");
        return metadata(item);
      }),
      deleteFile: vi.fn(async () => undefined),
    };
    diagnostics = vi.fn();
  });

  function service() {
    return createDriveWorkspaceService({
      repository: repository as DriveControlPlaneRepository,
      access,
      files: files as DriveFilesPort,
      onDiagnostic: diagnostics,
    });
  }

  it("groups sources under Input and outputs under public project folders", async () => {
    const view = await service().list();

    expect(view.input.map((file) => file.name)).toEqual(["source.mp4"]);
    expect(view.output).toEqual([{
      projectId: PROJECT_ID,
      name: "Phim A",
      files: [expect.objectContaining({ name: "part-01-of-04.mp4" })],
    }]);
    expect(access.getAccessToken).toHaveBeenCalledOnce();
    expect(files.inspectVideoMetadata).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ width: null, height: null, durationMillis: null, webViewLink: null }, "PROCESSING"],
    [{ width: 1920, height: 1080, durationMillis: 1_000, webViewLink: VIEW_URL }, "READY"],
  ] as const)("classifies Drive readiness as %s", async (changes, readiness) => {
    files.inspectVideoMetadata = vi.fn(async () => ({ ...metadata(records[0]!), ...changes }));

    const file = (await service().list()).input[0];

    expect(file?.readiness).toBe(readiness);
  });

  it("uses verifiedAt before Drive modifiedTime and exposes only the sanitized file shape", async () => {
    records = [record()];
    const file = (await service().list()).input[0];

    expect(file).toEqual({
      artifactId: SOURCE_ID,
      name: "source.mp4",
      sizeBytes: 100,
      uploadedAt: VERIFIED_AT,
      durationMillis: 1_000,
      width: 1920,
      height: 1080,
      readiness: "READY",
      viewUrl: VIEW_URL,
      downloadUrl: DOWNLOAD_URL,
    });
    expect(JSON.stringify(file)).not.toContain("drive-source-file-001");
    expect(JSON.stringify(file)).not.toContain("access-token-secret");
    expect(JSON.stringify(file)).not.toContain("appProperties");
  });

  it("falls back to Drive modifiedTime when the artifact is not verified", async () => {
    records = [record({ verifiedAt: null })];

    expect((await service().list()).input[0]?.uploadedAt).toBe(MODIFIED_AT);
  });

  it.each([
    ["artifact property", (remote: DriveVideoMetadata) => ({
      ...remote,
      appProperties: { ...remote.appProperties, ytbVpsArtifactId: OTHER_ID },
    })],
    ["project property", (remote: DriveVideoMetadata) => ({
      ...remote,
      appProperties: { ...remote.appProperties, ytbVpsProjectId: OTHER_PROJECT_ID },
    })],
    ["role property", (remote: DriveVideoMetadata) => ({
      ...remote,
      appProperties: { ...remote.appProperties, ytbVpsRole: "output" },
    })],
    ["file name", (remote: DriveVideoMetadata) => ({ ...remote, name: "other.mp4" })],
    ["MIME type", (remote: DriveVideoMetadata) => ({ ...remote, mimeType: "video/webm" })],
    ["size", (remote: DriveVideoMetadata) => ({ ...remote, sizeBytes: 99 })],
    ["Drive ID", (remote: DriveVideoMetadata) => ({ ...remote, id: "other-drive-file" })],
  ] as const)("omits a remote file with a mismatched %s and records only a stable code", async (
    _label,
    mutate,
  ) => {
    records = [record()];
    files.inspectVideoMetadata = vi.fn(async () => mutate(metadata(records[0]!)));

    expect((await service().list()).input).toEqual([]);
    expect(diagnostics).toHaveBeenCalledWith({ code: "DRIVE_WORKSPACE_REMOTE_MISMATCH" });
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("drive-source-file-001");
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("access-token-secret");
  });

  it("retains a previously verified file as UNKNOWN when metadata inspection fails", async () => {
    records = [record()];
    files.inspectVideoMetadata = vi.fn(async () => {
      throw new Error("private provider diagnostic");
    });

    const file = (await service().list()).input[0];

    expect(file).toEqual({
      artifactId: SOURCE_ID,
      name: "source.mp4",
      sizeBytes: 100,
      uploadedAt: VERIFIED_AT,
      durationMillis: null,
      width: null,
      height: null,
      readiness: "UNKNOWN",
      viewUrl: null,
      downloadUrl: null,
    });
    expect(diagnostics).toHaveBeenCalledWith({ code: "DRIVE_WORKSPACE_INSPECTION_FAILED" });
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("private provider diagnostic");
  });

  it("omits metadata the Drive adapter identifies as a remote mismatch", async () => {
    records = [record()];
    files.inspectVideoMetadata = vi.fn(async () => {
      throw new AppError("DRIVE_REMOTE_MISMATCH", 502);
    });

    const view = await service().list();

    expect(view.input).toEqual([]);
    expect(diagnostics).toHaveBeenCalledWith({ code: "DRIVE_WORKSPACE_REMOTE_MISMATCH" });
    expect(diagnostics).not.toHaveBeenCalledWith({ code: "DRIVE_WORKSPACE_INSPECTION_FAILED" });
  });

  it("caps concurrent Drive metadata inspections at four", async () => {
    records = Array.from({ length: 9 }, (_, index) => record({
      artifact: {
        id: `20000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
        driveFileId: `drive-source-file-${index}`,
        displayName: `source-${index}.mp4`,
      },
    }));
    let active = 0;
    let maximum = 0;
    files.inspectVideoMetadata = vi.fn(async (_token, fileId) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return metadata(records.find((item) => item.artifact.driveFileId === fileId)!);
    });

    await service().list();

    expect(maximum).toBe(4);
  });

  it.each(["SOURCE", "OUTPUT"] as const)("deletes a claimed %s artifact", async (kind) => {
    records = [record({
      artifact: {
        id: kind === "SOURCE" ? SOURCE_ID : OUTPUT_ID,
        kind,
        driveFileId: kind === "SOURCE" ? "drive-source-file-001" : "drive-output-file-001",
      },
    })];
    const artifactId = records[0]!.artifact.id;

    await expect(service().delete(artifactId)).resolves.toEqual({ status: "DELETED" });
    expect(repository.claimManagedArtifactDeletion).toHaveBeenCalledWith(artifactId);
    expect(files.inspectVideoMetadata).toHaveBeenCalledWith(
      "access-token-secret",
      records[0]!.artifact.driveFileId,
    );
    expect(files.deleteFile).toHaveBeenCalledWith(
      "access-token-secret",
      records[0]!.artifact.driveFileId,
    );
    expect(repository.markManagedArtifactDeleted).toHaveBeenCalledWith(artifactId);
  });

  it.each([
    ["artifact property", (remote: DriveVideoMetadata) => ({
      ...remote,
      appProperties: { ...remote.appProperties, ytbVpsArtifactId: OTHER_ID },
    })],
    ["project property", (remote: DriveVideoMetadata) => ({
      ...remote,
      appProperties: { ...remote.appProperties, ytbVpsProjectId: OTHER_PROJECT_ID },
    })],
    ["role property", (remote: DriveVideoMetadata) => ({
      ...remote,
      appProperties: { ...remote.appProperties, ytbVpsRole: "output" },
    })],
    ["file name", (remote: DriveVideoMetadata) => ({ ...remote, name: "other.mp4" })],
    ["video MIME type", (remote: DriveVideoMetadata) => ({ ...remote, mimeType: "video/webm" })],
    ["authoritative size", (remote: DriveVideoMetadata) => ({ ...remote, sizeBytes: 99 })],
    ["Drive ID", (remote: DriveVideoMetadata) => ({ ...remote, id: "other-drive-file" })],
  ] as const)("fails closed before deletion for a mismatched %s", async (_label, mutate) => {
    records = [record()];
    files.inspectVideoMetadata = vi.fn(async () => mutate(metadata(records[0]!)));

    await expect(service().delete(SOURCE_ID)).rejects.toMatchObject({
      code: "DRIVE_REMOTE_MISMATCH",
      status: 502,
    });

    expect(files.deleteFile).not.toHaveBeenCalled();
    expect(repository.markManagedArtifactDeleted).not.toHaveBeenCalled();
  });

  it.each([
    ["folder", (remote: DriveVideoMetadata) => ({
      ...remote,
      mimeType: "application/vnd.google-apps.folder",
    })],
    ["unmanaged item", (remote: DriveVideoMetadata) => ({
      ...remote,
      appProperties: {},
    })],
  ] as const)("fails closed before deletion for a remote %s", async (_label, mutate) => {
    records = [record()];
    files.inspectVideoMetadata = vi.fn(async () => mutate(metadata(records[0]!)));

    await expect(service().delete(SOURCE_ID)).rejects.toMatchObject({
      code: "DRIVE_REMOTE_MISMATCH",
      status: 502,
    });

    expect(files.deleteFile).not.toHaveBeenCalled();
    expect(repository.markManagedArtifactDeleted).not.toHaveBeenCalled();
  });

  it("fails closed when the adapter rejects deletion metadata as a remote mismatch", async () => {
    records = [record()];
    files.inspectVideoMetadata = vi.fn(async () => {
      throw new AppError("DRIVE_REMOTE_MISMATCH", 502);
    });

    await expect(service().delete(SOURCE_ID)).rejects.toMatchObject({
      code: "DRIVE_REMOTE_MISMATCH",
      status: 502,
    });

    expect(files.deleteFile).not.toHaveBeenCalled();
    expect(repository.markManagedArtifactDeleted).not.toHaveBeenCalled();
  });

  it("treats a provider 404 as already absent and completes deletion", async () => {
    records = [record()];
    files.deleteFile = vi.fn(async () => {
      throw new AppError("DRIVE_PROVIDER_REJECTED", 404);
    });

    await expect(service().delete(SOURCE_ID)).resolves.toEqual({ status: "DELETED" });
    expect(repository.markManagedArtifactDeleted).toHaveBeenCalledWith(SOURCE_ID);
  });

  it("rejects a conflicting deletion claim without obtaining a token or touching Drive", async () => {
    repository.claimManagedArtifactDeletion = vi.fn(
      async (): Promise<ManagedDeletionClaim> => "CONFLICT",
    );

    await expect(service().delete(SOURCE_ID)).rejects.toMatchObject({
      code: "DRIVE_FILE_DELETE_CONFLICT",
      status: 409,
    });
    expect(access.getAccessToken).not.toHaveBeenCalled();
    expect(files.inspectVideoMetadata).not.toHaveBeenCalled();
    expect(files.deleteFile).not.toHaveBeenCalled();
    expect(repository.markManagedArtifactDeleted).not.toHaveBeenCalled();
  });

  it("replays remote deletion after repository completion fails", async () => {
    repository.markManagedArtifactDeleted = vi.fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce("CHANGED");
    repository.claimManagedArtifactDeletion = vi.fn<
      DriveControlPlaneRepository["claimManagedArtifactDeletion"]
    >()
      .mockResolvedValueOnce("CLAIMED")
      .mockResolvedValueOnce("RECONCILE");

    await expect(service().delete(SOURCE_ID)).rejects.toThrow("database unavailable");
    await expect(service().delete(SOURCE_ID)).resolves.toEqual({ status: "DELETED" });

    expect(files.inspectVideoMetadata).toHaveBeenCalledTimes(2);
    expect(files.deleteFile).toHaveBeenCalledTimes(2);
    expect(repository.markManagedArtifactDeleted).toHaveBeenCalledTimes(2);
  });

  it("returns a deletion replay without obtaining a token or touching Drive", async () => {
    repository.listManagedArtifacts = vi.fn(async () => []);
    repository.claimManagedArtifactDeletion = vi.fn(
      async (): Promise<ManagedDeletionClaim> => "DELETED",
    );

    await expect(service().delete(SOURCE_ID)).resolves.toEqual({ status: "DELETED" });
    expect(access.getAccessToken).not.toHaveBeenCalled();
    expect(files.inspectVideoMetadata).not.toHaveBeenCalled();
    expect(files.deleteFile).not.toHaveBeenCalled();
    expect(repository.markManagedArtifactDeleted).not.toHaveBeenCalled();
  });
});
