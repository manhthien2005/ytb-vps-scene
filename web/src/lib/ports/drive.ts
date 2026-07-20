import type { UploadIntent, VerifiedDriveFile } from "@/lib/domain/drive";

export interface DriveOAuthPort {
  buildAuthorizationUrl(input: Readonly<{
    state: string; redirectUri: string;
  }>): string;
  exchangeCode(input: Readonly<{
    code: string; redirectUri: string; timeoutMs: number;
  }>): Promise<Readonly<{ refreshToken: string; grantedScopes: readonly string[] }>>;
  refreshAccessToken(refreshToken: string, timeoutMs: number): Promise<string>;
  revokeRefreshToken(refreshToken: string, timeoutMs: number): Promise<"REVOKED" | "RETRYABLE">;
}

export interface DriveAccessProvider {
  getAccessToken(): Promise<string>;
}

export interface DriveFilesPort {
  inspectAccount(accessToken: string): Promise<Readonly<{
    permissionId: string; accountHint: string; usedBytes: number; limitBytes: number;
  }>>;
  ensureWorkspace(accessToken: string): Promise<Readonly<{ rootFolderId: string }>>;
  ensureProjectFolders(accessToken: string, projectId: string): Promise<Readonly<{
    projectFolderId: string; inputFolderId: string;
  }>>;
  ensureSourceFile(accessToken: string, input: UploadIntent & Readonly<{
    projectId: string; artifactId: string; parentId: string;
  }>): Promise<string>;
  ensureOutputFile(accessToken: string, input: Readonly<{
    projectId: string;
    jobId: string;
    artifactId: string;
    parentId: string;
  }>): Promise<string>;
  createResumableUpdateSession(accessToken: string, input: Readonly<{
    fileId: string; mimeType: string; sizeBytes: number;
  }>): Promise<Readonly<{ sessionUri: string; expiresAt: string }>>;
  inspectFile(accessToken: string, fileId: string): Promise<VerifiedDriveFile>;
  deleteFile(accessToken: string, fileId: string): Promise<void>;
}

export type UsageSnapshot = Readonly<{
  provider: "DRIVE" | "NEON";
  usedBytes: number;
  limitBytes: number;
  appManagedBytes: number;
  mode: "READ_WRITE" | "READ_ONLY";
  reasonCodes: readonly string[];
  observedAt: string;
}>;
