import { DRIVE_FILE_SCOPE, type DriveVideoMetadata, type VerifiedDriveFile } from "@/lib/domain/drive";
import type { DriveFilesPort, DriveOAuthPort } from "@/lib/ports/drive";

export class FakeGoogleDriveOAuth implements DriveOAuthPort {
  exchangeResult: Readonly<{ refreshToken: string; grantedScopes: readonly string[] }> = {
    refreshToken: "fake-refresh-token",
    grantedScopes: [DRIVE_FILE_SCOPE],
  };
  accessToken = "fake-access-token";
  revokeResult: "REVOKED" | "RETRYABLE" = "REVOKED";
  exchangeError: unknown = null;
  refreshError: unknown = null;
  revokeError: unknown = null;
  readonly authorizationCalls: Array<Readonly<{ state: string; redirectUri: string }>> = [];
  readonly exchangeCalls: Array<Readonly<{ code: string; redirectUri: string; timeoutMs: number }>> = [];
  readonly refreshCalls: Array<Readonly<{ refreshToken: string; timeoutMs: number }>> = [];
  readonly revokeCalls: Array<Readonly<{ refreshToken: string; timeoutMs: number }>> = [];

  buildAuthorizationUrl(input: Readonly<{ state: string; redirectUri: string }>): string {
    this.authorizationCalls.push(structuredClone(input));
    const url = new URL("https://accounts.google.test/authorize");
    url.searchParams.set("state", input.state);
    url.searchParams.set("redirect_uri", input.redirectUri);
    return url.toString();
  }

  async exchangeCode(input: Readonly<{
    code: string;
    redirectUri: string;
    timeoutMs: number;
  }>): Promise<Readonly<{ refreshToken: string; grantedScopes: readonly string[] }>> {
    this.exchangeCalls.push(structuredClone(input));
    if (this.exchangeError !== null) throw this.exchangeError;
    return structuredClone(this.exchangeResult);
  }

  async refreshAccessToken(refreshToken: string, timeoutMs: number): Promise<string> {
    this.refreshCalls.push({ refreshToken, timeoutMs });
    if (this.refreshError !== null) throw this.refreshError;
    return this.accessToken;
  }

  async revokeRefreshToken(
    refreshToken: string,
    timeoutMs: number,
  ): Promise<"REVOKED" | "RETRYABLE"> {
    this.revokeCalls.push({ refreshToken, timeoutMs });
    if (this.revokeError !== null) throw this.revokeError;
    return this.revokeResult;
  }
}

export class FakeGoogleDriveFiles implements DriveFilesPort {
  account = {
    permissionId: "fake-permission-id",
    accountHint: "f***@example.test",
    usedBytes: 100,
    limitBytes: 1_000,
  };
  workspace = { rootFolderId: "fake-root-folder-001" };
  projectFolders = {
    projectFolderId: "fake-project-folder-001",
    inputFolderId: "fake-project-input-folder-001",
  };
  sourceFileId = "fake-source-file-001";
  outputFileId = "fake-output-file-001";
  resumableSession = {
    sessionUri: "https://www.googleapis.com/upload/drive/v3/files/fake-source-file-001?upload_id=fake",
    expiresAt: "2026-07-26T00:00:00.000Z",
  };
  file: VerifiedDriveFile = {
    id: "fake-source-file-001",
    name: "source.mp4",
    mimeType: "video/mp4",
    sizeBytes: 100,
    parentIds: ["fake-project-input-folder-001"],
    trashed: false,
    appProperties: { schema: "1" },
    sha256Checksum: null,
  };
  readonly videoMetadataByFileId = new Map<string, DriveVideoMetadata>();
  inspectAccountError: unknown = null;
  ensureWorkspaceError: unknown = null;
  resumableSessionError: unknown = null;
  inspectFileError: unknown = null;
  inspectVideoMetadataError: unknown = null;
  deleteFileError: unknown = null;
  readonly inspectAccountCalls: string[] = [];
  readonly ensureWorkspaceCalls: string[] = [];
  readonly ensureProjectFoldersCalls: Array<Readonly<{
    accessToken: string;
    projectId: string;
    projectName?: string;
  }>> = [];
  readonly ensureSourceFileCalls: Array<Readonly<{ accessToken: string; input: unknown }>> = [];
  readonly ensureOutputFileCalls: Array<Readonly<{ accessToken: string; input: unknown }>> = [];
  readonly resumableSessionCalls: Array<Readonly<{ accessToken: string; input: unknown }>> = [];
  readonly inspectFileCalls: Array<Readonly<{ accessToken: string; fileId: string }>> = [];
  readonly inspectVideoMetadataCalls: Array<Readonly<{ accessToken: string; fileId: string }>> = [];
  readonly deleteFileCalls: Array<Readonly<{ accessToken: string; fileId: string }>> = [];

  async inspectAccount(accessToken: string) {
    this.inspectAccountCalls.push(accessToken);
    if (this.inspectAccountError !== null) throw this.inspectAccountError;
    return structuredClone(this.account);
  }

  async ensureWorkspace(accessToken: string) {
    this.ensureWorkspaceCalls.push(accessToken);
    if (this.ensureWorkspaceError !== null) throw this.ensureWorkspaceError;
    return structuredClone(this.workspace);
  }

  async ensureProjectFolders(accessToken: string, projectId: string, projectName?: string) {
    this.ensureProjectFoldersCalls.push({
      accessToken,
      projectId,
      ...(projectName === undefined ? {} : { projectName }),
    });
    return structuredClone(this.projectFolders);
  }

  async ensureSourceFile(accessToken: string, input: Parameters<DriveFilesPort["ensureSourceFile"]>[1]) {
    this.ensureSourceFileCalls.push({ accessToken, input: structuredClone(input) });
    this.file = { ...this.file, name: input.fileName };
    return this.sourceFileId;
  }

  async ensureOutputFile(accessToken: string, input: Parameters<DriveFilesPort["ensureOutputFile"]>[1]) {
    this.ensureOutputFileCalls.push({ accessToken, input: structuredClone(input) });
    return this.outputFileId;
  }

  async createResumableUpdateSession(
    accessToken: string,
    input: Parameters<DriveFilesPort["createResumableUpdateSession"]>[1],
  ) {
    this.resumableSessionCalls.push({ accessToken, input: structuredClone(input) });
    if (this.resumableSessionError !== null) throw this.resumableSessionError;
    return structuredClone(this.resumableSession);
  }

  async inspectFile(accessToken: string, fileId: string) {
    this.inspectFileCalls.push({ accessToken, fileId });
    if (this.inspectFileError !== null) throw this.inspectFileError;
    return structuredClone(this.file);
  }

  async inspectVideoMetadata(accessToken: string, fileId: string) {
    this.inspectVideoMetadataCalls.push({ accessToken, fileId });
    if (this.inspectVideoMetadataError !== null) throw this.inspectVideoMetadataError;
    return structuredClone(this.videoMetadataByFileId.get(fileId) ?? {
      id: fileId,
      name: "source.mp4",
      mimeType: "video/mp4",
      sizeBytes: 100,
      parentIds: ["fake-project-input-folder-001"],
      createdTime: "2026-07-22T00:00:00.000Z",
      modifiedTime: "2026-07-22T00:00:00.000Z",
      width: null,
      height: null,
      durationMillis: null,
      webViewLink: null,
      webContentLink: null,
      appProperties: { schema: "1" },
    });
  }

  async deleteFile(accessToken: string, fileId: string) {
    this.deleteFileCalls.push({ accessToken, fileId });
    if (this.deleteFileError !== null) throw this.deleteFileError;
  }
}
