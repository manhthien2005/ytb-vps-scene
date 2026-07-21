import { beforeEach, describe, expect, it, vi, type Mocked } from "vitest";
import type { Artifact, Project, UploadIntentInput, VerifiedDriveFile } from "@/lib/domain/drive";
import { AppError } from "@/lib/domain/errors";
import type { DriveAccessProvider } from "@/lib/ports/drive";
import type { DriveControlPlaneRepository } from "@/lib/repositories/drive-control-plane";
import { FakeGoogleDriveFiles } from "@/test/fakes/fake-google-drive";
import type { FreeTierHealthService } from "./free-tier-health";
import { createUploadService } from "./uploads";

const NOW = new Date("2026-07-19T00:00:00.000Z");
const PROJECT_ID = "10000000-0000-4000-8000-000000000001";
const INPUT_FOLDER_ID = "drive-input-folder-001";
const SOURCE_FILE_ID = "drive-source-file-001";
const MAXIMUM_BYTES = 10_737_418_240;

const readyProject: Project = {
  id: PROJECT_ID,
  status: "READY",
  name: "Test 1",
  sourceStatus: "NO_SOURCE",
  driveProjectFolderId: "drive-project-folder-001",
  driveInputFolderId: INPUT_FOLDER_ID,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
};

const validIntent: UploadIntentInput = {
  fileName: "private-source.mp4",
  mimeType: "video/mp4",
  sizeBytes: 524_288,
  lastModified: 1_752_883_200_000,
};

const artifact: Artifact = {
  id: PROJECT_ID,
  projectId: PROJECT_ID,
  kind: "SOURCE",
  status: "UPLOADING",
  driveFileId: SOURCE_FILE_ID,
  driveParentId: INPUT_FOLDER_ID,
  displayName: validIntent.fileName,
  mimeType: validIntent.mimeType,
  expectedSizeBytes: validIntent.sizeBytes,
  actualSizeBytes: null,
};

function exactRemoteFile(sizeBytes = validIntent.sizeBytes): VerifiedDriveFile {
  return {
    id: SOURCE_FILE_ID,
    name: "private-source.mp4",
    mimeType: validIntent.mimeType,
    sizeBytes,
    parentIds: [INPUT_FOLDER_ID],
    trashed: false,
    appProperties: {
      ytbVpsProjectId: PROJECT_ID,
      ytbVpsArtifactId: PROJECT_ID,
      ytbVpsRole: "source",
      schema: "1",
    },
  };
}

function mismatchedRemoteFile(
  kind: "id" | "parent" | "name" | "mime" | "properties" | "trashed" | "larger-size",
): VerifiedDriveFile {
  const exact = exactRemoteFile();
  switch (kind) {
    case "id": return { ...exact, id: "wrong-drive-file" };
    case "parent": return { ...exact, parentIds: [INPUT_FOLDER_ID, "ambiguous-parent"] };
    case "name": return { ...exact, name: "khac-ten.mp4" };
    case "mime": return { ...exact, mimeType: "video/webm" };
    case "properties": return { ...exact, appProperties: { ...exact.appProperties, extra: "ambiguous" } };
    case "trashed": return { ...exact, trashed: true };
    case "larger-size": return { ...exact, sizeBytes: validIntent.sizeBytes + 1 };
  }
}

function repositoryDouble(): Mocked<DriveControlPlaneRepository> {
  return {
    saveOAuthNonce: vi.fn(),
    consumeOAuthNonce: vi.fn(),
    getCredential: vi.fn(),
    saveConnectedCredential: vi.fn(),
    setCredentialStatus: vi.fn(),
    hasDriveContent: vi.fn(),
    reserveProject: vi.fn(),
    getProject: vi.fn(),
    claimProvisioning: vi.fn(),
    renewProvisioning: vi.fn(),
    releaseProvisioning: vi.fn(),
    markProjectFailed: vi.fn(),
    completeProjectFolders: vi.fn(),
    listProjects: vi.fn(),
    reserveSourceCapacity: vi.fn(),
    observeSourceProgress: vi.fn(),
    reserveSourceArtifact: vi.fn(),
    getArtifact: vi.fn(),
    markArtifactUploading: vi.fn(),
    markSourceReady: vi.fn(),
    markSourceInvalid: vi.fn(),
    claimSourceDeletion: vi.fn(),
    markSourceDeleted: vi.fn(),
    getUsage: vi.fn(),
    saveUsage: vi.fn(),
    appManagedDriveBytes: vi.fn(),
    databaseUsedBytes: vi.fn(),
    recordAudit: vi.fn(),
  };
}

describe("UploadService sessions", () => {
  let repository: Mocked<DriveControlPlaneRepository>;
  let access: Mocked<DriveAccessProvider>;
  let health: Mocked<FreeTierHealthService>;
  let files: FakeGoogleDriveFiles;
  let diagnostics: ReturnType<typeof vi.fn>;
  let service: ReturnType<typeof createUploadService>;

  beforeEach(() => {
    repository = repositoryDouble();
    repository.getProject.mockResolvedValue(readyProject);
    repository.getArtifact.mockResolvedValue(null);
    repository.claimProvisioning.mockResolvedValue(true);
    repository.renewProvisioning.mockResolvedValue(true);
    repository.releaseProvisioning.mockResolvedValue(undefined);
    repository.reserveSourceCapacity.mockResolvedValue("RESERVED");
    repository.observeSourceProgress.mockResolvedValue(validIntent.sizeBytes);
    repository.reserveSourceArtifact.mockImplementation(async (input) => ({
      ...artifact,
      status: "PENDING",
      driveFileId: input.driveFileId,
      driveParentId: input.driveParentId,
      displayName: input.fileName,
      mimeType: input.mimeType,
      expectedSizeBytes: input.sizeBytes,
    }));
    repository.claimSourceDeletion.mockResolvedValue("CLAIMED");
    repository.markSourceReady.mockResolvedValue("CHANGED");
    repository.markSourceInvalid.mockResolvedValue("CHANGED");
    repository.markSourceDeleted.mockResolvedValue("CHANGED");
    access = { getAccessToken: vi.fn().mockResolvedValue("access") };
    health = {
      getHealth: vi.fn(),
      assertUploadAllowed: vi.fn().mockResolvedValue(undefined),
    };
    files = new FakeGoogleDriveFiles();
    files.sourceFileId = SOURCE_FILE_ID;
    files.file = exactRemoteFile();
    diagnostics = vi.fn();
    service = createUploadService({
      repository,
      access,
      files,
      health,
      maximumBytes: MAXIMUM_BYTES,
      softPercent: 90,
      staleAfterSeconds: 900,
      browserOrigin: "https://ytb-vps-scene.vercel.app",
      onDiagnostic: diagnostics,
    });
  });

  it("returns the capability without persisting or auditing it", async () => {
    const result = await service.createSession({ projectId: PROJECT_ID, intent: validIntent, now: NOW });

    expect(result).toEqual({
      artifactId: PROJECT_ID,
      sessionUri: files.resumableSession.sessionUri,
      chunkBytes: 8_388_608,
      expiresAt: files.resumableSession.expiresAt,
    });
    if (!("sessionUri" in result)) throw new Error("expected upload capability");
    expect(JSON.stringify(Object.values(repository).map((method) => method.mock.calls)))
      .not.toContain(result.sessionUri);
    expect(JSON.stringify(repository.recordAudit.mock.calls)).not.toContain(result.sessionUri);
  });

  it("allows only one concurrent placeholder and session provisioner per source", async () => {
    let ownerToken: string | undefined;
    repository.claimProvisioning.mockImplementation(async (_kind, _resourceId, claimToken) => {
      ownerToken ??= claimToken;
      return claimToken === ownerToken;
    });
    repository.renewProvisioning.mockImplementation(async (_kind, _resourceId, claimToken) => (
      claimToken === ownerToken
    ));
    let releasePlaceholder!: () => void;
    const placeholderBlocked = new Promise<void>((resolve) => {
      releasePlaceholder = resolve;
    });
    const ensureSourceFile = files.ensureSourceFile.bind(files);
    vi.spyOn(files, "ensureSourceFile").mockImplementation(async (...args) => {
      const fileId = await ensureSourceFile(...args);
      await placeholderBlocked;
      return fileId;
    });

    const first = service.createSession({ projectId: PROJECT_ID, intent: validIntent, now: NOW });
    await vi.waitFor(() => expect(files.ensureSourceFileCalls).toHaveLength(1));
    const second = service.createSession({ projectId: PROJECT_ID, intent: validIntent, now: NOW });
    const settled = Promise.allSettled([first, second]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(files.ensureSourceFileCalls).toHaveLength(1);
    releasePlaceholder();
    const results = await settled;
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "fulfilled" }),
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ code: "DRIVE_TEMPORARILY_UNAVAILABLE", status: 503 }),
      }),
    ]));
    expect(files.resumableSessionCalls).toHaveLength(1);
  });

  it("uses the project UUID as the one-source artifact UUID", async () => {
    const result = await service.createSession({ projectId: PROJECT_ID, intent: validIntent, now: NOW });

    expect(result.artifactId).toBe(PROJECT_ID);
    expect(files.ensureSourceFileCalls[0]?.input).toMatchObject({
      projectId: PROJECT_ID,
      artifactId: PROJECT_ID,
      parentId: readyProject.driveInputFolderId,
      normalizedExtension: "mp4",
    });
    expect(repository.reserveSourceArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: PROJECT_ID,
        projectId: PROJECT_ID,
        driveFileId: SOURCE_FILE_ID,
        driveParentId: INPUT_FOLDER_ID,
      }),
      expect.any(String),
    );
  });

  it.each<readonly [string, Project | null]>([
    ["missing", null],
    ["not ready", { ...readyProject, status: "PROVISIONING" }],
    ["missing input folder", { ...readyProject, driveInputFolderId: null }],
  ])("rejects a %s project before access or Drive mutation", async (_label, project) => {
    repository.getProject.mockResolvedValue(project);

    await expect(service.createSession({ projectId: PROJECT_ID, intent: validIntent, now: NOW }))
      .rejects.toMatchObject({ code: "UPLOAD_REMOTE_MISMATCH", status: 409 });
    expect(access.getAccessToken).not.toHaveBeenCalled();
    expect(files.ensureSourceFileCalls).toHaveLength(0);
  });

  it("validates the UUID and configured 10 GiB cap before loading project state", async () => {
    await expect(service.createSession({
      projectId: "not-a-uuid",
      intent: validIntent,
      now: NOW,
    })).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
    await expect(service.createSession({
      projectId: PROJECT_ID,
      intent: { ...validIntent, sizeBytes: MAXIMUM_BYTES + 1 },
      now: NOW,
    })).rejects.toMatchObject({ code: "UPLOAD_TOO_LARGE", status: 413 });
    expect(repository.getProject).not.toHaveBeenCalled();
  });

  it("admits the configured 10 GiB boundary", async () => {
    const intent = { ...validIntent, sizeBytes: MAXIMUM_BYTES };
    await service.createSession({ projectId: PROJECT_ID, intent, now: NOW });

    expect(health.assertUploadAllowed).toHaveBeenCalledWith(MAXIMUM_BYTES, NOW);
    expect(repository.reserveSourceArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ sizeBytes: MAXIMUM_BYTES }),
      expect.any(String),
    );
  });

  it("denies free-tier admission before creating or reserving the Drive placeholder", async () => {
    health.assertUploadAllowed.mockRejectedValue(new AppError("DRIVE_STORAGE_HIGH", 409));

    await expect(service.createSession({ projectId: PROJECT_ID, intent: validIntent, now: NOW }))
      .rejects.toMatchObject({ code: "DRIVE_STORAGE_HIGH" });
    expect(files.ensureSourceFileCalls).toHaveLength(0);
    expect(repository.reserveSourceArtifact).not.toHaveBeenCalled();
    expect(repository.markArtifactUploading).not.toHaveBeenCalled();
  });

  it("does not start a session when the artifact reservation mismatches", async () => {
    repository.reserveSourceArtifact.mockRejectedValue(new Error("Artifact reservation mismatch"));

    await expect(service.createSession({ projectId: PROJECT_ID, intent: validIntent, now: NOW }))
      .rejects.toThrow("Artifact reservation mismatch");
    expect(repository.markArtifactUploading).not.toHaveBeenCalled();
    expect(files.resumableSessionCalls).toHaveLength(0);
    expect(repository.recordAudit).not.toHaveBeenCalled();
  });

  it("preserves pending metadata when session creation fails", async () => {
    files.resumableSessionError = new AppError("DRIVE_RATE_LIMITED", 429);

    await expect(service.createSession({ projectId: PROJECT_ID, intent: validIntent, now: NOW }))
      .rejects.toMatchObject({ code: "DRIVE_RATE_LIMITED" });
    expect(repository.reserveSourceArtifact).toHaveBeenCalledOnce();
    expect(repository.markArtifactUploading).toHaveBeenCalledWith(PROJECT_ID, expect.any(String));
    expect(repository.markSourceInvalid).not.toHaveBeenCalled();
    expect(repository.markSourceDeleted).not.toHaveBeenCalled();
    expect(repository.recordAudit).not.toHaveBeenCalled();
  });

  it("invalidates a source placeholder when Drive rejects session initiation", async () => {
    files.resumableSessionError = new AppError("DRIVE_PROVIDER_REJECTED", 502);

    await expect(service.createSession({ projectId: PROJECT_ID, intent: validIntent, now: NOW }))
      .rejects.toMatchObject({ code: "DRIVE_PROVIDER_REJECTED" });

    expect(repository.markSourceInvalid).toHaveBeenCalledWith(PROJECT_ID);
    expect(diagnostics).toHaveBeenCalledWith({
      stage: "create-resumable-session",
      code: "DRIVE_PROVIDER_REJECTED",
    });
  });

  it("does not expose a provider session created after its source claim is taken over", async () => {
    repository.renewProvisioning
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(service.createSession({ projectId: PROJECT_ID, intent: validIntent, now: NOW }))
      .rejects.toMatchObject({ code: "DRIVE_TEMPORARILY_UNAVAILABLE", status: 503 });

    expect(files.resumableSessionCalls).toHaveLength(1);
    expect(repository.recordAudit).not.toHaveBeenCalled();
    expect(JSON.stringify(repository.recordAudit.mock.calls))
      .not.toContain(files.resumableSession.sessionUri);
  });

  it.each([
    ["display name", { displayName: "changed.mp4" }],
    ["MIME type", { mimeType: "video/webm" }],
    ["expected size", { expectedSizeBytes: validIntent.sizeBytes + 1 }],
  ])("rejects an existing artifact with changed immutable %s", async (_label, change) => {
    repository.getArtifact.mockResolvedValue({ ...artifact, ...change, status: "PENDING" });

    await expect(service.createSession({ projectId: PROJECT_ID, intent: validIntent, now: NOW }))
      .rejects.toMatchObject({ code: "UPLOAD_REMOTE_MISMATCH" });
    expect(health.assertUploadAllowed).not.toHaveBeenCalled();
    expect(files.ensureSourceFileCalls).toHaveLength(0);
    expect(files.resumableSessionCalls).toHaveLength(0);
  });

  it("renews the stored pending file without requiring an empty placeholder", async () => {
    repository.getArtifact.mockResolvedValue({ ...artifact, status: "UPLOADING" });
    files.file = exactRemoteFile(262_144);

    await service.createSession({ projectId: PROJECT_ID, intent: validIntent, now: NOW });

    expect(files.ensureSourceFileCalls).toHaveLength(0);
    expect(files.inspectFileCalls).toEqual([{ accessToken: "access", fileId: artifact.driveFileId }]);
    expect(files.resumableSessionCalls).toEqual([{
      accessToken: "access",
      input: {
        fileId: artifact.driveFileId,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.expectedSizeBytes,
        origin: "https://ytb-vps-scene.vercel.app",
      },
    }]);
    expect(health.assertUploadAllowed).toHaveBeenCalledWith(0, NOW);
    expect(repository.reserveSourceArtifact).not.toHaveBeenCalled();
  });

  it("finalizes exact provider metadata during renewal without creating another session", async () => {
    repository.getArtifact.mockResolvedValue({ ...artifact, status: "UPLOADING" });
    files.file = exactRemoteFile();

    await expect(service.createSession({ projectId: PROJECT_ID, intent: validIntent, now: NOW }))
      .resolves.toEqual({
        artifactId: PROJECT_ID,
        status: "SOURCE_READY",
        actualSizeBytes: validIntent.sizeBytes,
      });

    expect(repository.observeSourceProgress).toHaveBeenCalledWith(
      PROJECT_ID,
      validIntent.sizeBytes,
      expect.any(String),
    );
    expect(repository.markSourceReady).toHaveBeenCalledWith(
      PROJECT_ID,
      validIntent.sizeBytes,
      NOW,
      expect.any(String),
    );
    expect(files.resumableSessionCalls).toHaveLength(0);
    expect(repository.recordAudit).not.toHaveBeenCalled();
  });

  it("replays terminal READY metadata when the prior renewal response was lost", async () => {
    repository.getArtifact.mockResolvedValue({
      ...artifact,
      status: "READY",
      actualSizeBytes: validIntent.sizeBytes,
    });

    await expect(service.createSession({ projectId: PROJECT_ID, intent: validIntent, now: NOW }))
      .resolves.toEqual({
        artifactId: PROJECT_ID,
        status: "SOURCE_READY",
        actualSizeBytes: validIntent.sizeBytes,
      });

    expect(health.assertUploadAllowed).not.toHaveBeenCalled();
    expect(access.getAccessToken).not.toHaveBeenCalled();
    expect(files.inspectFileCalls).toHaveLength(0);
    expect(repository.markSourceReady).not.toHaveBeenCalled();
  });

  it("creates a fresh placeholder after the prior source was cancelled", async () => {
    repository.getArtifact.mockResolvedValue({ ...artifact, status: "DELETED" });
    files.sourceFileId = "replacement-source-file-001";

    await expect(service.createSession({ projectId: PROJECT_ID, intent: validIntent, now: NOW }))
      .resolves.toMatchObject({ artifactId: PROJECT_ID });

    expect(health.assertUploadAllowed).toHaveBeenCalledWith(validIntent.sizeBytes, NOW);
    expect(files.inspectFileCalls).toHaveLength(0);
    expect(files.ensureSourceFileCalls).toHaveLength(1);
    expect(repository.reserveSourceArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: PROJECT_ID,
        driveFileId: "replacement-source-file-001",
      }),
      expect.any(String),
    );
    expect(files.resumableSessionCalls[0]?.input).toMatchObject({
      fileId: "replacement-source-file-001",
    });
  });

  it("creates a fresh placeholder after Drive rejected the prior session", async () => {
    repository.getArtifact.mockResolvedValue({ ...artifact, status: "INVALID" });
    files.sourceFileId = "replacement-source-file-001";

    await expect(service.createSession({ projectId: PROJECT_ID, intent: validIntent, now: NOW }))
      .resolves.toMatchObject({ artifactId: PROJECT_ID });

    expect(health.assertUploadAllowed).toHaveBeenCalledWith(validIntent.sizeBytes, NOW);
    expect(files.inspectFileCalls).toHaveLength(0);
    expect(files.ensureSourceFileCalls).toHaveLength(1);
    expect(repository.reserveSourceArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: PROJECT_ID,
        driveFileId: "replacement-source-file-001",
      }),
      expect.any(String),
    );
    expect(files.resumableSessionCalls[0]?.input).toMatchObject({
      fileId: "replacement-source-file-001",
    });
  });

  it("rejects conclusive remote mismatch when renewing the exact stored file", async () => {
    repository.getArtifact.mockResolvedValue({ ...artifact, status: "UPLOADING" });
    files.file = { ...exactRemoteFile(), parentIds: ["wrong-parent"] };

    await expect(service.createSession({ projectId: PROJECT_ID, intent: validIntent, now: NOW }))
      .rejects.toMatchObject({ code: "UPLOAD_REMOTE_MISMATCH" });
    expect(files.resumableSessionCalls).toHaveLength(0);
    expect(repository.markSourceInvalid).not.toHaveBeenCalled();
  });

  it("records a sanitized session audit containing only IDs, bytes, MIME, and status", async () => {
    await service.createSession({ projectId: PROJECT_ID, intent: validIntent, now: NOW });

    expect(repository.recordAudit).toHaveBeenCalledWith({
      eventType: "UPLOAD_SESSION_CREATED",
      targetId: PROJECT_ID,
      actorClass: "admin",
      payload: {
        projectId: PROJECT_ID,
        artifactId: PROJECT_ID,
        expectedSizeBytes: validIntent.sizeBytes,
        mimeType: validIntent.mimeType,
        status: "UPLOADING",
      },
    });
    const serialized = JSON.stringify(repository.recordAudit.mock.calls);
    expect(serialized).not.toContain(SOURCE_FILE_ID);
    expect(serialized).not.toContain(files.resumableSession.sessionUri);
  });

  it("marks ready only from exact fresh server metadata", async () => {
    repository.getArtifact.mockResolvedValue(artifact);
    files.file = exactRemoteFile();

    await expect(service.complete({ projectId: PROJECT_ID, artifactId: PROJECT_ID, now: NOW }))
      .resolves.toEqual({ status: "SOURCE_READY", actualSizeBytes: artifact.expectedSizeBytes });
    expect(access.getAccessToken).toHaveBeenCalledOnce();
    expect(files.inspectFileCalls).toEqual([{ accessToken: "access", fileId: SOURCE_FILE_ID }]);
    expect(repository.markSourceReady).toHaveBeenCalledWith(
      PROJECT_ID,
      artifact.expectedSizeBytes,
      NOW,
    );
    expect(repository.recordAudit).not.toHaveBeenCalled();
  });

  it("moves a crash-left PENDING artifact through UPLOADING before ready", async () => {
    repository.getArtifact.mockResolvedValue({ ...artifact, status: "PENDING" });
    files.file = exactRemoteFile();

    await service.complete({ projectId: PROJECT_ID, artifactId: PROJECT_ID, now: NOW });

    expect(repository.markArtifactUploading).toHaveBeenCalledWith(PROJECT_ID);
    expect(repository.markArtifactUploading.mock.invocationCallOrder[0])
      .toBeLessThan(repository.markSourceReady.mock.invocationCallOrder[0]!);
  });

  it("keeps a smaller app-owned file pending", async () => {
    repository.getArtifact.mockResolvedValue(artifact);
    files.file = exactRemoteFile(artifact.expectedSizeBytes - 1);

    await expect(service.complete({ projectId: PROJECT_ID, artifactId: PROJECT_ID, now: NOW }))
      .resolves.toEqual({ status: "UPLOAD_PENDING", retryAfterMs: 1_000 });
    expect(repository.markArtifactUploading).not.toHaveBeenCalled();
    expect(repository.markSourceReady).not.toHaveBeenCalled();
    expect(repository.markSourceInvalid).not.toHaveBeenCalled();
    expect(repository.recordAudit).not.toHaveBeenCalled();
  });

  it("accepts exact app properties independent of insertion order", async () => {
    repository.getArtifact.mockResolvedValue(artifact);
    files.file = {
      ...exactRemoteFile(),
      appProperties: {
        schema: "1",
        ytbVpsRole: "source",
        ytbVpsArtifactId: PROJECT_ID,
        ytbVpsProjectId: PROJECT_ID,
      },
    };

    await expect(service.complete({ projectId: PROJECT_ID, artifactId: PROJECT_ID, now: NOW }))
      .resolves.toMatchObject({ status: "SOURCE_READY" });
  });

  it.each(["id", "parent", "name", "mime", "properties", "trashed", "larger-size"] as const)(
    "fails closed on conclusive %s mismatch",
    async (kind) => {
      repository.getArtifact.mockResolvedValue(artifact);
      files.file = mismatchedRemoteFile(kind);

      await expect(service.complete({ projectId: PROJECT_ID, artifactId: PROJECT_ID, now: NOW }))
        .rejects.toMatchObject({ code: "UPLOAD_REMOTE_MISMATCH", status: 409 });
      expect(repository.markSourceReady).not.toHaveBeenCalled();
      expect(repository.markSourceInvalid).toHaveBeenCalledWith(PROJECT_ID);
      expect(repository.recordAudit).not.toHaveBeenCalled();
    },
  );

  it("returns an already-ready artifact without another provider call or audit", async () => {
    repository.getArtifact.mockResolvedValue({ ...artifact, status: "READY", actualSizeBytes: 100 });

    await expect(service.complete({ projectId: PROJECT_ID, artifactId: PROJECT_ID, now: NOW }))
      .resolves.toEqual({ status: "SOURCE_READY", actualSizeBytes: 100 });
    expect(access.getAccessToken).not.toHaveBeenCalled();
    expect(files.inspectFileCalls).toHaveLength(0);
    expect(repository.markSourceReady).not.toHaveBeenCalled();
    expect(repository.recordAudit).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null],
    ["invalid", { ...artifact, status: "INVALID" as const }],
    ["deleted", { ...artifact, status: "DELETED" as const }],
  ])("rejects a %s artifact without provider calls or mutation", async (_label, stored) => {
    repository.getArtifact.mockResolvedValue(stored);

    await expect(service.complete({ projectId: PROJECT_ID, artifactId: PROJECT_ID, now: NOW }))
      .rejects.toMatchObject({ code: "UPLOAD_REMOTE_MISMATCH" });
    expect(access.getAccessToken).not.toHaveBeenCalled();
    expect(repository.markArtifactUploading).not.toHaveBeenCalled();
    expect(repository.markSourceReady).not.toHaveBeenCalled();
    expect(repository.markSourceInvalid).not.toHaveBeenCalled();
    expect(repository.recordAudit).not.toHaveBeenCalled();
  });

  it("rejects malformed artifact identity without mutation", async () => {
    repository.getArtifact.mockResolvedValue({ ...artifact, projectId: "20000000-0000-4000-8000-000000000002" });

    await expect(service.complete({ projectId: PROJECT_ID, artifactId: PROJECT_ID, now: NOW }))
      .rejects.toMatchObject({ code: "UPLOAD_REMOTE_MISMATCH" });
    expect(access.getAccessToken).not.toHaveBeenCalled();
    expect(repository.markSourceInvalid).not.toHaveBeenCalled();
  });

  it.each([
    new AppError("DRIVE_RATE_LIMITED", 429),
    new AppError("DRIVE_TEMPORARILY_UNAVAILABLE", 503),
    new AppError("DRIVE_REAUTH_REQUIRED", 401),
  ])("preserves UPLOADING for retryable provider error $code", async (providerError) => {
    repository.getArtifact.mockResolvedValue(artifact);
    files.inspectFileError = providerError;

    await expect(service.complete({ projectId: PROJECT_ID, artifactId: PROJECT_ID, now: NOW }))
      .rejects.toBe(providerError);
    expect(repository.markArtifactUploading).not.toHaveBeenCalled();
    expect(repository.markSourceReady).not.toHaveBeenCalled();
    expect(repository.markSourceInvalid).not.toHaveBeenCalled();
    expect(repository.recordAudit).not.toHaveBeenCalled();
  });

  it("does not return or audit a provider file ID or provider body", async () => {
    repository.getArtifact.mockResolvedValue(artifact);
    const providerError = Object.assign(new AppError("DRIVE_RATE_LIMITED", 429), {
      providerBody: "private-provider-body",
    });
    files.inspectFileError = providerError;

    await expect(service.complete({ projectId: PROJECT_ID, artifactId: PROJECT_ID, now: NOW }))
      .rejects.toBe(providerError);
    const serialized = JSON.stringify(repository.recordAudit.mock.calls);
    expect(serialized).not.toContain(SOURCE_FILE_ID);
    expect(serialized).not.toContain(providerError.providerBody);
  });

  it("validates completion UUIDs before repository access", async () => {
    await expect(service.complete({ projectId: "bad", artifactId: PROJECT_ID, now: NOW }))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(service.complete({ projectId: PROJECT_ID, artifactId: "bad", now: NOW }))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(repository.getArtifact).not.toHaveBeenCalled();
  });

  it("deletes only a pending app-owned source after fresh remote validation", async () => {
    repository.getArtifact.mockResolvedValue({ ...artifact, status: "PENDING" });
    files.file = exactRemoteFile(262_144);

    await expect(service.cancel({ projectId: PROJECT_ID, artifactId: PROJECT_ID, now: NOW }))
      .resolves.toEqual({ status: "CANCELLED" });
    expect(files.inspectFileCalls).toEqual([{ accessToken: "access", fileId: SOURCE_FILE_ID }]);
    expect(files.deleteFileCalls).toEqual([{ accessToken: "access", fileId: SOURCE_FILE_ID }]);
    expect(repository.markSourceDeleted).toHaveBeenCalledWith(PROJECT_ID);
    expect(repository.recordAudit).not.toHaveBeenCalled();
  });

  it("cancels an exact owned source even when its current size is lower than a prior observation", async () => {
    repository.getArtifact.mockResolvedValue({ ...artifact, status: "PENDING" });
    repository.observeSourceProgress.mockRejectedValue(new Error("lower observation"));
    files.file = exactRemoteFile(0);

    await expect(service.cancel({ projectId: PROJECT_ID, artifactId: PROJECT_ID, now: NOW }))
      .resolves.toEqual({ status: "CANCELLED" });

    expect(repository.observeSourceProgress).not.toHaveBeenCalled();
    expect(repository.claimSourceDeletion).toHaveBeenCalledWith(PROJECT_ID);
    expect(files.deleteFileCalls).toHaveLength(1);
  });

  it("returns cancellation idempotently for DELETED without provider calls or another audit", async () => {
    repository.getArtifact.mockResolvedValue({ ...artifact, status: "DELETED" });

    await expect(service.cancel({ projectId: PROJECT_ID, artifactId: PROJECT_ID, now: NOW }))
      .resolves.toEqual({ status: "CANCELLED" });
    expect(access.getAccessToken).not.toHaveBeenCalled();
    expect(files.inspectFileCalls).toHaveLength(0);
    expect(files.deleteFileCalls).toHaveLength(0);
    expect(repository.markSourceDeleted).not.toHaveBeenCalled();
    expect(repository.recordAudit).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null],
    ["ready", { ...artifact, status: "READY" as const, actualSizeBytes: artifact.expectedSizeBytes }],
    ["invalid", { ...artifact, status: "INVALID" as const }],
  ])("rejects cancellation of a %s artifact without mutation", async (_label, stored) => {
    repository.getArtifact.mockResolvedValue(stored);

    await expect(service.cancel({ projectId: PROJECT_ID, artifactId: PROJECT_ID, now: NOW }))
      .rejects.toMatchObject({ code: "UPLOAD_REMOTE_MISMATCH" });
    expect(access.getAccessToken).not.toHaveBeenCalled();
    expect(files.deleteFileCalls).toHaveLength(0);
    expect(repository.markSourceDeleted).not.toHaveBeenCalled();
    expect(repository.recordAudit).not.toHaveBeenCalled();
  });

  it("rejects remote ownership mismatch during cancellation without deleting or invalidating", async () => {
    repository.getArtifact.mockResolvedValue(artifact);
    files.file = { ...exactRemoteFile(262_144), appProperties: { schema: "1" } };

    await expect(service.cancel({ projectId: PROJECT_ID, artifactId: PROJECT_ID, now: NOW }))
      .rejects.toMatchObject({ code: "UPLOAD_REMOTE_MISMATCH" });
    expect(files.deleteFileCalls).toHaveLength(0);
    expect(repository.markSourceInvalid).not.toHaveBeenCalled();
    expect(repository.markSourceDeleted).not.toHaveBeenCalled();
    expect(repository.recordAudit).not.toHaveBeenCalled();
  });

  it("does not delete when completion wins immediately before the deletion claim", async () => {
    repository.getArtifact.mockResolvedValue(artifact);
    repository.claimSourceDeletion.mockResolvedValue("CONFLICT");
    files.file = exactRemoteFile();

    await expect(service.cancel({ projectId: PROJECT_ID, artifactId: PROJECT_ID, now: NOW }))
      .rejects.toMatchObject({ code: "UPLOAD_REMOTE_MISMATCH" });
    expect(repository.claimSourceDeletion).toHaveBeenCalledWith(PROJECT_ID);
    expect(files.deleteFileCalls).toHaveLength(0);
    expect(repository.markSourceDeleted).not.toHaveBeenCalled();
    expect(repository.recordAudit).not.toHaveBeenCalled();
  });

  it("reconciles deletion after the remote delete succeeds but database finalization fails", async () => {
    repository.getArtifact
      .mockResolvedValueOnce(artifact)
      .mockResolvedValueOnce({ ...artifact, status: "DELETING" });
    repository.markSourceDeleted
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce("CHANGED");
    files.file = exactRemoteFile(262_144);

    await expect(service.cancel({ projectId: PROJECT_ID, artifactId: PROJECT_ID, now: NOW }))
      .rejects.toThrow("database unavailable");
    await expect(service.cancel({ projectId: PROJECT_ID, artifactId: PROJECT_ID, now: NOW }))
      .resolves.toEqual({ status: "CANCELLED" });

    expect(repository.claimSourceDeletion).toHaveBeenCalledOnce();
    expect(files.inspectFileCalls).toHaveLength(1);
    expect(files.deleteFileCalls).toHaveLength(2);
    expect(repository.markSourceDeleted).toHaveBeenCalledTimes(2);
    expect(repository.recordAudit).not.toHaveBeenCalled();
  });

  it("keeps the deletion claim reconcilable when the provider delete fails", async () => {
    repository.getArtifact.mockResolvedValue(artifact);
    const providerError = new AppError("DRIVE_TEMPORARILY_UNAVAILABLE", 503);
    files.deleteFileError = providerError;

    await expect(service.cancel({ projectId: PROJECT_ID, artifactId: PROJECT_ID, now: NOW }))
      .rejects.toBe(providerError);
    expect(repository.claimSourceDeletion).toHaveBeenCalledWith(PROJECT_ID);
    expect(repository.markSourceDeleted).not.toHaveBeenCalled();
    expect(repository.recordAudit).not.toHaveBeenCalled();
  });
});
