import type { Artifact, Project, UploadIntent } from "@/lib/domain/drive";
import type { UsageSnapshot } from "@/lib/ports/drive";
import type { EncryptedCredential } from "@/lib/security/credential-cipher";
import type { AuditEvent } from "./control-plane";

export type StoredDriveCredential =
  | Readonly<{
      status: "CONNECTED" | "REVOKE_PENDING";
      envelope: EncryptedCredential;
      accountPermissionIdHash: string;
      accountHint: string;
      rootFolderId: string;
    }>
  | Readonly<{
      status: "REAUTH_REQUIRED" | "DISCONNECTED";
      envelope: null;
      accountPermissionIdHash: string | null;
      accountHint: string | null;
      rootFolderId: string | null;
    }>;

export type StoredConnectedCredential = Readonly<{
  status: "CONNECTED";
  envelope: EncryptedCredential;
  accountPermissionIdHash: string;
  accountHint: string;
  rootFolderId: string;
}>;

export type ProjectReservation = Readonly<{
  idempotencyKeyHash: string;
  requestHash: string;
  name: string;
}>;

export type ProjectReservationResult =
  | Readonly<{ outcome: "CREATED" | "RESUME" | "EXISTING"; project: Project }>
  | Readonly<{ outcome: "CONFLICT" }>;

export type SourceReservation = UploadIntent & Readonly<{
  artifactId: string;
  projectId: string;
  driveFileId: string;
  driveParentId: string;
}>;

export interface DriveControlPlaneRepository {
  saveOAuthNonce(hash: string, expiresAt: Date): Promise<void>;
  consumeOAuthNonce(hash: string, now: Date): Promise<boolean>;
  getCredential(): Promise<StoredDriveCredential | null>;
  saveConnectedCredential(value: StoredConnectedCredential): Promise<void>;
  setCredentialStatus(status: "REAUTH_REQUIRED" | "REVOKE_PENDING" | "DISCONNECTED"): Promise<void>;
  hasDriveContent(): Promise<boolean>;
  reserveProject(input: ProjectReservation): Promise<ProjectReservationResult>;
  getProject(projectId: string): Promise<Project | null>;
  markProjectFailed(projectId: string): Promise<void>;
  completeProjectFolders(projectId: string, projectFolderId: string, inputFolderId: string): Promise<Project>;
  listProjects(): Promise<readonly Project[]>;
  reserveSourceArtifact(input: SourceReservation): Promise<Artifact>;
  getArtifact(projectId: string, artifactId: string): Promise<Artifact | null>;
  markArtifactUploading(artifactId: string): Promise<void>;
  markSourceReady(artifactId: string, actualSizeBytes: number, verifiedAt: Date): Promise<void>;
  markSourceInvalid(artifactId: string): Promise<void>;
  markSourceDeleted(artifactId: string): Promise<void>;
  getUsage(provider: "DRIVE" | "NEON"): Promise<UsageSnapshot | null>;
  saveUsage(snapshot: UsageSnapshot): Promise<void>;
  appManagedDriveBytes(): Promise<number>;
  databaseUsedBytes(): Promise<number>;
  recordAudit(event: AuditEvent): Promise<void>;
}
