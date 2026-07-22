export const DRIVE_CONNECTION_STATUSES = [
  "CONNECTED", "REAUTH_REQUIRED", "REVOKE_PENDING", "DISCONNECTED",
] as const;

export type DriveConnectionStatus = (typeof DRIVE_CONNECTION_STATUSES)[number];

export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file" as const;

export type Project = Readonly<{
  id: string;
  status: "PROVISIONING" | "READY" | "FAILED";
  name: string;
  sourceStatus: "NO_SOURCE" | "UPLOAD_PENDING" | "SOURCE_READY" | "UPLOAD_FAILED";
  driveProjectFolderId: string | null;
  driveInputFolderId: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type Artifact = Readonly<{
  id: string;
  projectId: string;
  kind: "SOURCE" | "CHECKPOINT" | "OUTPUT";
  status: "PENDING" | "UPLOADING" | "DELETING" | "READY" | "INVALID" | "DELETED";
  driveFileId: string;
  driveParentId: string;
  displayName: string;
  mimeType: string;
  expectedSizeBytes: number;
  actualSizeBytes: number | null;
}>;

export type UploadIntentInput = Readonly<{
  fileName: string;
  mimeType: "video/mp4" | "video/quicktime" | "video/x-matroska" | "video/webm";
  sizeBytes: number;
  lastModified: number;
}>;

export type UploadIntent = UploadIntentInput & Readonly<{
  normalizedExtension: "mp4" | "mov" | "mkv" | "webm";
}>;

export type VerifiedDriveFile = Readonly<{
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  parentIds: readonly string[];
  trashed: boolean;
  appProperties: Readonly<Record<string, string>>;
}>;

export type DriveVideoMetadata = Readonly<{
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  parentIds: readonly string[];
  createdTime: string;
  modifiedTime: string;
  width: number | null;
  height: number | null;
  durationMillis: number | null;
  webViewLink: string | null;
  webContentLink: string | null;
  appProperties: Readonly<Record<string, string>>;
}>;
