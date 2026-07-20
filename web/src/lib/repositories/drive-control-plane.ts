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

export type SourceCapacityReservation = Readonly<{
  artifactId: string;
  projectId: string;
  driveParentId: string;
  fileName: string;
  mimeType: UploadIntent["mimeType"];
  sizeBytes: number;
  claimToken: string;
  now: Date;
  softPercent: number;
  staleAfterSeconds: number;
}>;

export type SourceCapacityOutcome =
  | "RESERVED"
  | "EXISTING"
  | "CONFLICT"
  | "DRIVE_STORAGE_HIGH"
  | "NEON_STORAGE_HIGH"
  | "DRIVE_QUOTA_STALE"
  | "QUOTA_INVALID"
  | "DRIVE_TEMPORARILY_UNAVAILABLE";

export type ProvisioningKind = "PROJECT" | "SOURCE";
export const PROJECT_TREE_CLAIM_ID = "00000000-0000-4000-8000-000000000000" as const;

export interface DriveControlPlaneRepository {
  saveOAuthNonce(hash: string, expiresAt: Date): Promise<void>;
  consumeOAuthNonce(hash: string, now: Date): Promise<boolean>;
  getCredential(): Promise<StoredDriveCredential | null>;
  saveConnectedCredential(value: StoredConnectedCredential): Promise<void>;
  setCredentialStatus(status: "REAUTH_REQUIRED" | "REVOKE_PENDING" | "DISCONNECTED"): Promise<void>;
  hasDriveContent(): Promise<boolean>;
  reserveProject(input: ProjectReservation): Promise<ProjectReservationResult>;
  getProject(projectId: string): Promise<Project | null>;
  claimProvisioning(kind: ProvisioningKind, resourceId: string, claimToken: string): Promise<boolean>;
  renewProvisioning(kind: ProvisioningKind, resourceId: string, claimToken: string): Promise<boolean>;
  releaseProvisioning(kind: ProvisioningKind, resourceId: string, claimToken: string): Promise<void>;
  markProjectFailed(projectId: string, claimToken: string): Promise<void>;
  completeProjectFolders(
    projectId: string,
    projectFolderId: string,
    inputFolderId: string,
    claimToken: string,
  ): Promise<Project>;
  listProjects(): Promise<readonly Project[]>;
  reserveSourceCapacity(input: SourceCapacityReservation): Promise<SourceCapacityOutcome>;
  observeSourceProgress(artifactId: string, observedSizeBytes: number): Promise<number>;
  reserveSourceArtifact(input: SourceReservation, claimToken: string): Promise<Artifact>;
  getArtifact(projectId: string, artifactId: string): Promise<Artifact | null>;
  markArtifactUploading(artifactId: string): Promise<void>;
  markSourceReady(artifactId: string, actualSizeBytes: number, verifiedAt: Date): Promise<void>;
  markSourceInvalid(artifactId: string): Promise<void>;
  claimSourceDeletion(artifactId: string): Promise<"CLAIMED" | "RECONCILE" | "DELETED" | "CONFLICT">;
  markSourceDeleted(artifactId: string): Promise<boolean>;
  getUsage(provider: "DRIVE" | "NEON"): Promise<UsageSnapshot | null>;
  saveUsage(snapshot: UsageSnapshot): Promise<UsageSnapshot>;
  appManagedDriveBytes(): Promise<number>;
  databaseUsedBytes(): Promise<number>;
  recordAudit(event: AuditEvent): Promise<void>;
}
