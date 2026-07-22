import type { Artifact, Project } from "@/lib/domain/drive";
import type { UsageSnapshot } from "@/lib/ports/drive";
import type { AuditEvent } from "@/lib/repositories/control-plane";
import {
  PROJECT_TREE_CLAIM_ID,
  type DriveControlPlaneRepository,
  type ManagedArtifactRecord,
  type ProjectReservation,
  type ProjectReservationResult,
  type ProvisioningKind,
  type SourceCapacityOutcome,
  type SourceCapacityReservation,
  type SourceReservation,
  type StoredConnectedCredential,
  type StoredDriveCredential,
} from "@/lib/repositories/drive-control-plane";

type StoredProject = Readonly<{
  project: Project;
  idempotencyKeyHash: string;
  requestHash: string;
}>;

type StoredSourceCapacity = Readonly<{
  input: Omit<SourceCapacityReservation, "claimToken" | "now" | "softPercent" | "staleAfterSeconds">;
  observedSizeBytes: number;
  remainingBytes: number;
  released: boolean;
}>;

type ManagedArtifactMetadata = Readonly<{
  jobId: string | null;
  verifiedAt: string | null;
  createdAt: string;
}>;

export class FakeDriveControlPlaneRepository implements DriveControlPlaneRepository {
  readonly auditEvents: AuditEvent[] = [];
  private readonly nonces = new Map<string, number>();
  private readonly projects = new Map<string, StoredProject>();
  private readonly artifacts = new Map<string, Artifact>();
  private readonly managedArtifactMetadata = new Map<string, ManagedArtifactMetadata>();
  private readonly sourceCapacities = new Map<string, StoredSourceCapacity>();
  private readonly usage = new Map<"DRIVE" | "NEON", UsageSnapshot>();
  private readonly provisioningClaims = new Map<string, Readonly<{ token: string; expiresAt: number }>>();
  private credential: StoredDriveCredential | null = null;
  private nextProjectNumber = 1;

  constructor(
    private readonly now: () => Date = () => new Date("2026-07-19T00:00:00.000Z"),
    private readonly neonBytes = 0,
  ) {}

  private timestamp(): string {
    return this.now().toISOString();
  }

  private updateProject(projectId: string, update: Partial<Project>): Project {
    const stored = this.projects.get(projectId);
    if (!stored) throw new Error("Project unavailable");
    const project = structuredClone({ ...stored.project, ...update, updatedAt: this.timestamp() });
    this.projects.set(projectId, { ...stored, project });
    return structuredClone(project);
  }

  private storeManagedArtifactMetadata(
    artifactId: string,
    metadata: Readonly<{ jobId: string | null; verifiedAt: string | null }>,
  ): void {
    const existing = this.managedArtifactMetadata.get(artifactId);
    this.managedArtifactMetadata.set(artifactId, {
      ...metadata,
      createdAt: existing?.createdAt ?? this.timestamp(),
    });
  }

  async saveOAuthNonce(hash: string, expiresAt: Date): Promise<void> {
    for (const [key, expiry] of this.nonces) {
      if (expiry <= this.now().getTime()) this.nonces.delete(key);
    }
    if (this.nonces.has(hash)) throw new Error("OAuth nonce already exists");
    this.nonces.set(hash, expiresAt.getTime());
  }

  async consumeOAuthNonce(hash: string, now: Date): Promise<boolean> {
    const expiry = this.nonces.get(hash);
    this.nonces.delete(hash);
    for (const [key, value] of this.nonces) {
      if (value <= now.getTime()) this.nonces.delete(key);
    }
    return expiry !== undefined && expiry > now.getTime();
  }

  async getCredential(): Promise<StoredDriveCredential | null> {
    return this.credential === null ? null : structuredClone(this.credential);
  }

  async saveConnectedCredential(value: StoredConnectedCredential): Promise<void> {
    this.credential = structuredClone(value);
  }

  async setCredentialStatus(status: "REAUTH_REQUIRED" | "REVOKE_PENDING" | "DISCONNECTED"): Promise<void> {
    if (status === "REVOKE_PENDING") {
      if (!this.credential || this.credential.envelope === null) throw new Error("Credential unavailable");
      this.credential = { ...structuredClone(this.credential), status };
      return;
    }
    this.credential = {
      status,
      envelope: null,
      accountPermissionIdHash: this.credential?.accountPermissionIdHash ?? null,
      accountHint: this.credential?.accountHint ?? null,
      rootFolderId: this.credential?.rootFolderId ?? null,
    };
  }

  async hasDriveContent(): Promise<boolean> {
    return this.projects.size > 0 || this.artifacts.size > 0;
  }

  async reserveProject(input: ProjectReservation): Promise<ProjectReservationResult> {
    const existing = [...this.projects.values()].find(
      (stored) => stored.idempotencyKeyHash === input.idempotencyKeyHash,
    );
    if (existing) {
      if (existing.requestHash !== input.requestHash) return { outcome: "CONFLICT" };
      return {
        outcome: existing.project.status === "PROVISIONING" ? "RESUME" : "EXISTING",
        project: structuredClone(existing.project),
      };
    }
    const suffix = String(this.nextProjectNumber++).padStart(12, "0");
    const timestamp = this.timestamp();
    const project: Project = {
      id: `00000000-0000-4000-8000-${suffix}`,
      status: "PROVISIONING",
      name: input.name,
      sourceStatus: "NO_SOURCE",
      driveProjectFolderId: null,
      driveInputFolderId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.projects.set(project.id, {
      project,
      idempotencyKeyHash: input.idempotencyKeyHash,
      requestHash: input.requestHash,
    });
    return { outcome: "CREATED", project: structuredClone(project) };
  }

  async getProject(projectId: string): Promise<Project | null> {
    const stored = this.projects.get(projectId);
    return stored ? structuredClone(stored.project) : null;
  }

  async claimProvisioning(
    kind: ProvisioningKind,
    resourceId: string,
    claimToken: string,
  ): Promise<boolean> {
    const key = `${kind}:${resourceId}`;
    const existing = this.provisioningClaims.get(key);
    if (existing && existing.token !== claimToken && existing.expiresAt > this.now().getTime()) return false;
    this.provisioningClaims.set(key, {
      token: claimToken,
      expiresAt: this.now().getTime() + 5 * 60 * 1_000,
    });
    return true;
  }

  async renewProvisioning(
    kind: ProvisioningKind,
    resourceId: string,
    claimToken: string,
  ): Promise<boolean> {
    const key = `${kind}:${resourceId}`;
    const existing = this.provisioningClaims.get(key);
    if (existing?.token !== claimToken || existing.expiresAt <= this.now().getTime()) return false;
    this.provisioningClaims.set(key, {
      token: claimToken,
      expiresAt: this.now().getTime() + 5 * 60 * 1_000,
    });
    return true;
  }

  async releaseProvisioning(
    kind: ProvisioningKind,
    resourceId: string,
    claimToken: string,
  ): Promise<void> {
    const key = `${kind}:${resourceId}`;
    if (this.provisioningClaims.get(key)?.token === claimToken) this.provisioningClaims.delete(key);
  }

  private ownsProvisioning(kind: ProvisioningKind, resourceId: string, claimToken: string): boolean {
    const claim = this.provisioningClaims.get(`${kind}:${resourceId}`);
    return claim?.token === claimToken && claim.expiresAt > this.now().getTime();
  }

  async markProjectFailed(projectId: string, claimToken: string): Promise<void> {
    if (
      this.ownsProvisioning("PROJECT", PROJECT_TREE_CLAIM_ID, claimToken) &&
      this.projects.get(projectId)?.project.status === "PROVISIONING"
    ) {
      this.updateProject(projectId, { status: "FAILED" });
    }
  }

  async completeProjectFolders(
    projectId: string,
    projectFolderId: string,
    inputFolderId: string,
    claimToken: string,
  ): Promise<Project> {
    const stored = this.projects.get(projectId);
    if (!this.ownsProvisioning("PROJECT", PROJECT_TREE_CLAIM_ID, claimToken) || !stored || (stored.project.status !== "PROVISIONING" && (
      stored.project.status !== "READY" ||
      stored.project.driveProjectFolderId !== projectFolderId ||
      stored.project.driveInputFolderId !== inputFolderId
    ))) throw new Error("Project cannot be completed");
    return this.updateProject(projectId, {
      status: "READY",
      driveProjectFolderId: projectFolderId,
      driveInputFolderId: inputFolderId,
    });
  }

  async listProjects(): Promise<readonly Project[]> {
    return [...this.projects.values()]
      .map((stored) => structuredClone(stored.project))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  }

  async listManagedArtifacts(): Promise<readonly ManagedArtifactRecord[]> {
    return [...this.artifacts.values()]
      .filter((artifact) => (artifact.kind === "SOURCE" || artifact.kind === "OUTPUT") && artifact.status !== "DELETED")
      .map((artifact) => {
        const project = this.projects.get(artifact.projectId)?.project;
        if (!project) throw new Error("Managed artifact project unavailable");
        const metadata = this.managedArtifactMetadata.get(artifact.id);
        if (!metadata) throw new Error("Managed artifact metadata unavailable");
        return {
          artifact: structuredClone(artifact),
          projectName: project.name,
          jobId: metadata.jobId,
          verifiedAt: metadata.verifiedAt,
        };
      })
      .sort((left, right) => {
        const leftProject = this.projects.get(left.artifact.projectId)!.project;
        const rightProject = this.projects.get(right.artifact.projectId)!.project;
        const leftMetadata = this.managedArtifactMetadata.get(left.artifact.id)!;
        const rightMetadata = this.managedArtifactMetadata.get(right.artifact.id)!;
        return leftProject.createdAt.localeCompare(rightProject.createdAt) ||
          left.projectName.localeCompare(right.projectName) ||
          leftMetadata.createdAt.localeCompare(rightMetadata.createdAt) ||
          left.artifact.id.localeCompare(right.artifact.id);
      });
  }

  seedManagedArtifact(record: ManagedArtifactRecord): void {
    const project = this.projects.get(record.artifact.projectId)?.project;
    if (!project || project.name !== record.projectName) throw new Error("Managed artifact project unavailable");
    this.artifacts.set(record.artifact.id, structuredClone(record.artifact));
    this.storeManagedArtifactMetadata(record.artifact.id, {
      jobId: record.jobId,
      verifiedAt: record.verifiedAt,
    });
  }

  async claimManagedArtifactDeletion(artifactId: string): Promise<"CLAIMED" | "RECONCILE" | "DELETED" | "CONFLICT"> {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact || (artifact.kind !== "SOURCE" && artifact.kind !== "OUTPUT")) return "CONFLICT";
    if (artifact.status === "DELETING") return "RECONCILE";
    if (artifact.status === "DELETED") return "DELETED";
    if (artifact.status !== "READY" && artifact.status !== "INVALID") return "CONFLICT";
    this.artifacts.set(artifactId, { ...artifact, status: "DELETING" });
    return "CLAIMED";
  }

  async markManagedArtifactDeleted(artifactId: string): Promise<"CHANGED" | "REPLAY"> {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact || (artifact.kind !== "SOURCE" && artifact.kind !== "OUTPUT")) {
      throw new Error("Managed artifact cannot be marked deleted");
    }
    if (artifact.status === "DELETED") return "REPLAY";
    if (artifact.status !== "DELETING") throw new Error("Managed artifact cannot be marked deleted");
    this.artifacts.set(artifactId, { ...artifact, status: "DELETED" });
    this.releaseSourceCapacity(artifactId);
    if (artifact.kind === "SOURCE") this.updateProject(artifact.projectId, { sourceStatus: "NO_SOURCE" });
    this.auditEvents.push({
      eventType: "DRIVE_FILE_DELETED",
      targetId: artifact.id,
      actorClass: "admin",
      payload: {
        projectId: artifact.projectId,
        artifactId: artifact.id,
        kind: artifact.kind,
        status: "DELETED",
      },
    });
    return "CHANGED";
  }

  async reserveSourceCapacity(input: SourceCapacityReservation): Promise<SourceCapacityOutcome> {
    const quota = this.usage.get("DRIVE");
    if (!quota) return "DRIVE_QUOTA_STALE";
    const observedAt = Date.parse(quota.observedAt);
    if (
      !Number.isFinite(observedAt) || observedAt > input.now.getTime() ||
      input.now.getTime() - observedAt > input.staleAfterSeconds * 1_000
    ) return "DRIVE_QUOTA_STALE";
    if (quota.usedBytes > quota.limitBytes || quota.appManagedBytes > quota.usedBytes) return "QUOTA_INVALID";
    if (quota.mode !== "READ_WRITE") {
      const reason = quota.reasonCodes[0];
      return reason === "DRIVE_STORAGE_HIGH" || reason === "NEON_STORAGE_HIGH" ||
        reason === "DRIVE_QUOTA_STALE" || reason === "QUOTA_INVALID"
        ? reason
        : "QUOTA_INVALID";
    }
    if (!this.ownsProvisioning("SOURCE", input.artifactId, input.claimToken)) {
      return "DRIVE_TEMPORARILY_UNAVAILABLE";
    }
    const project = this.projects.get(input.projectId)?.project;
    if (
      !project || project.status !== "READY" || project.driveInputFolderId !== input.driveParentId
    ) return "CONFLICT";
    const existing = this.sourceCapacities.get(input.artifactId);
    const artifact = this.artifacts.get(input.artifactId);
    let replacedRemaining = 0;
    if (existing && !existing.released) {
      const exact = existing.input.artifactId === input.artifactId &&
        existing.input.projectId === input.projectId &&
        existing.input.driveParentId === input.driveParentId &&
        existing.input.fileName === input.fileName &&
        existing.input.mimeType === input.mimeType &&
        existing.input.sizeBytes === input.sizeBytes;
      if (exact && (!artifact || artifact.status === "PENDING" || artifact.status === "UPLOADING")) {
        return "EXISTING";
      }
      if (artifact) return "CONFLICT";
      replacedRemaining = existing.remainingBytes;
    }
    if (artifact && artifact.status !== "INVALID" && artifact.status !== "DELETED") return "CONFLICT";
    const remaining = [...this.sourceCapacities.values()]
      .filter((capacity) => !capacity.released)
      .reduce((sum, capacity) => sum + capacity.remainingBytes, 0) - replacedRemaining;
    if ((quota.usedBytes + remaining + input.sizeBytes) * 100 >= quota.limitBytes * input.softPercent) {
      return "DRIVE_STORAGE_HIGH";
    }
    this.sourceCapacities.set(input.artifactId, {
      input: {
        artifactId: input.artifactId,
        projectId: input.projectId,
        driveParentId: input.driveParentId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
      },
      observedSizeBytes: 0,
      remainingBytes: input.sizeBytes,
      released: false,
    });
    return "RESERVED";
  }

  async observeSourceProgress(artifactId: string, observedSizeBytes: number): Promise<number> {
    const capacity = this.sourceCapacities.get(artifactId);
    if (
      !capacity || capacity.released || !Number.isSafeInteger(observedSizeBytes) ||
      observedSizeBytes < 0 || observedSizeBytes > capacity.input.sizeBytes
    ) throw new Error("Source progress cannot be observed");
    const remainingBytes = capacity.input.sizeBytes - observedSizeBytes;
    this.sourceCapacities.set(artifactId, { ...capacity, observedSizeBytes, remainingBytes });
    return remainingBytes;
  }

  private releaseSourceCapacity(artifactId: string, complete = false): void {
    const capacity = this.sourceCapacities.get(artifactId);
    if (!capacity || capacity.released) return;
    this.sourceCapacities.set(artifactId, {
      ...capacity,
      observedSizeBytes: complete ? capacity.input.sizeBytes : capacity.observedSizeBytes,
      remainingBytes: 0,
      released: true,
    });
  }

  async reserveSourceArtifact(input: SourceReservation, claimToken: string): Promise<Artifact> {
    const project = this.projects.get(input.projectId)?.project;
    if (
      !this.ownsProvisioning("SOURCE", input.artifactId, claimToken) ||
      !project || project.status !== "READY"
    ) throw new Error("Artifact provisioning claim lost or reservation mismatch");
    const existing = this.artifacts.get(input.artifactId);
    if (existing) {
      if (existing.projectId === input.projectId && existing.kind === "SOURCE" && ["INVALID", "DELETED"].includes(existing.status)) {
        const competingLiveSource = [...this.artifacts.values()].some(
          (artifact) => artifact.id !== input.artifactId && artifact.projectId === input.projectId &&
            artifact.kind === "SOURCE" && artifact.status !== "DELETED",
        );
        if (competingLiveSource) throw new Error("Project not ready or source already reserved");
        const replacement: Artifact = {
          id: input.artifactId,
          projectId: input.projectId,
          kind: "SOURCE",
          status: "PENDING",
          driveFileId: input.driveFileId,
          driveParentId: input.driveParentId,
          displayName: input.fileName,
          mimeType: input.mimeType,
          expectedSizeBytes: input.sizeBytes,
          actualSizeBytes: null,
        };
        this.artifacts.set(replacement.id, replacement);
        this.storeManagedArtifactMetadata(replacement.id, { jobId: null, verifiedAt: null });
        this.updateProject(input.projectId, { sourceStatus: "UPLOAD_PENDING" });
        return structuredClone(replacement);
      }
      if (
        existing.projectId !== input.projectId || existing.kind !== "SOURCE" ||
        existing.driveFileId !== input.driveFileId || existing.driveParentId !== input.driveParentId ||
        existing.displayName !== input.fileName || existing.mimeType !== input.mimeType ||
        existing.expectedSizeBytes !== input.sizeBytes
      ) throw new Error("Artifact reservation mismatch");
      return structuredClone(existing);
    }
    const liveSource = [...this.artifacts.values()].some(
      (artifact) => artifact.projectId === input.projectId && artifact.kind === "SOURCE" && artifact.status !== "DELETED",
    );
    if (liveSource) throw new Error("Project not ready or source already reserved");
    const artifact: Artifact = {
      id: input.artifactId,
      projectId: input.projectId,
      kind: "SOURCE",
      status: "PENDING",
      driveFileId: input.driveFileId,
      driveParentId: input.driveParentId,
      displayName: input.fileName,
      mimeType: input.mimeType,
      expectedSizeBytes: input.sizeBytes,
      actualSizeBytes: null,
    };
    this.artifacts.set(artifact.id, artifact);
    this.storeManagedArtifactMetadata(artifact.id, { jobId: null, verifiedAt: null });
    this.updateProject(input.projectId, { sourceStatus: "UPLOAD_PENDING" });
    return structuredClone(artifact);
  }

  async getArtifact(projectId: string, artifactId: string): Promise<Artifact | null> {
    const artifact = this.artifacts.get(artifactId);
    return artifact?.projectId === projectId ? structuredClone(artifact) : null;
  }

  async markArtifactUploading(artifactId: string): Promise<void> {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact || artifact.kind !== "SOURCE" || !["PENDING", "UPLOADING"].includes(artifact.status)) {
      throw new Error("Artifact cannot start uploading");
    }
    this.artifacts.set(artifactId, { ...artifact, status: "UPLOADING" });
  }

  async markSourceReady(
    artifactId: string,
    actualSizeBytes: number,
    verifiedAt: Date,
  ): Promise<"CHANGED" | "REPLAY"> {
    const artifact = this.artifacts.get(artifactId);
    if (
      artifact?.kind === "SOURCE" && artifact.status === "READY" &&
      artifact.actualSizeBytes === actualSizeBytes
    ) return "REPLAY";
    if (
      !artifact || artifact.kind !== "SOURCE" || artifact.status !== "UPLOADING" ||
      !Number.isSafeInteger(actualSizeBytes) || actualSizeBytes < 0 ||
      !Number.isFinite(verifiedAt.getTime())
    ) throw new Error("Source cannot be marked ready");
    this.artifacts.set(artifactId, { ...artifact, status: "READY", actualSizeBytes });
    this.storeManagedArtifactMetadata(artifactId, { jobId: null, verifiedAt: verifiedAt.toISOString() });
    this.releaseSourceCapacity(artifactId, true);
    this.updateProject(artifact.projectId, { sourceStatus: "SOURCE_READY" });
    this.auditEvents.push({
      eventType: "UPLOAD_COMPLETED",
      targetId: artifact.id,
      actorClass: "admin",
      payload: {
        projectId: artifact.projectId,
        artifactId: artifact.id,
        actualSizeBytes,
        mimeType: artifact.mimeType,
        status: "READY",
      },
    });
    return "CHANGED";
  }

  async markSourceInvalid(artifactId: string): Promise<"CHANGED" | "REPLAY"> {
    const artifact = this.artifacts.get(artifactId);
    if (artifact?.kind === "SOURCE" && artifact.status === "INVALID") return "REPLAY";
    if (!artifact || artifact.kind !== "SOURCE" || !["PENDING", "UPLOADING"].includes(artifact.status)) {
      throw new Error("Source cannot be marked invalid");
    }
    this.artifacts.set(artifactId, { ...artifact, status: "INVALID" });
    this.releaseSourceCapacity(artifactId);
    this.updateProject(artifact.projectId, { sourceStatus: "UPLOAD_FAILED" });
    this.auditEvents.push({
      eventType: "UPLOAD_FAILED",
      targetId: artifact.id,
      actorClass: "admin",
      payload: {
        projectId: artifact.projectId,
        artifactId: artifact.id,
        expectedSizeBytes: artifact.expectedSizeBytes,
        mimeType: artifact.mimeType,
        status: "INVALID",
      },
    });
    return "CHANGED";
  }

  async claimSourceDeletion(
    artifactId: string,
  ): Promise<"CLAIMED" | "RECONCILE" | "DELETED" | "CONFLICT"> {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact || artifact.kind !== "SOURCE") return "CONFLICT";
    if (artifact.status === "DELETING") return "RECONCILE";
    if (artifact.status === "DELETED") return "DELETED";
    if (artifact.status !== "PENDING" && artifact.status !== "UPLOADING") return "CONFLICT";
    this.artifacts.set(artifactId, { ...artifact, status: "DELETING" });
    const capacity = this.sourceCapacities.get(artifactId);
    if (capacity && !capacity.released) {
      this.sourceCapacities.set(artifactId, {
        ...capacity,
        observedSizeBytes: 0,
        remainingBytes: capacity.input.sizeBytes,
      });
    }
    return "CLAIMED";
  }

  async markSourceDeleted(artifactId: string): Promise<"CHANGED" | "REPLAY"> {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact || artifact.kind !== "SOURCE") throw new Error("Source cannot be marked deleted");
    if (artifact.status === "DELETED") return "REPLAY";
    if (artifact.status !== "DELETING") throw new Error("Source cannot be marked deleted");
    this.artifacts.set(artifactId, { ...artifact, status: "DELETED" });
    this.releaseSourceCapacity(artifactId);
    this.updateProject(artifact.projectId, { sourceStatus: "NO_SOURCE" });
    this.auditEvents.push({
      eventType: "UPLOAD_CANCELLED",
      targetId: artifact.id,
      actorClass: "admin",
      payload: {
        projectId: artifact.projectId,
        artifactId: artifact.id,
        expectedSizeBytes: artifact.expectedSizeBytes,
        mimeType: artifact.mimeType,
        status: "DELETED",
      },
    });
    return "CHANGED";
  }

  async getUsage(provider: "DRIVE" | "NEON"): Promise<UsageSnapshot | null> {
    const snapshot = this.usage.get(provider);
    return snapshot ? structuredClone(snapshot) : null;
  }

  async saveUsage(snapshot: UsageSnapshot): Promise<UsageSnapshot> {
    const current = this.usage.get(snapshot.provider);
    const retained = current === undefined || snapshot.observedAt > current.observedAt
      ? structuredClone(snapshot)
      : current;
    this.usage.set(snapshot.provider, structuredClone(retained));
    return structuredClone(retained);
  }

  async appManagedDriveBytes(): Promise<number> {
    return [...this.artifacts.values()]
      .filter((artifact) => artifact.status !== "DELETED")
      .reduce((total, artifact) => total + (
        artifact.status === "READY"
          ? artifact.actualSizeBytes ?? 0
          : this.sourceCapacities.get(artifact.id)?.observedSizeBytes ?? 0
      ), 0);
  }

  async databaseUsedBytes(): Promise<number> {
    return this.neonBytes;
  }

  async recordAudit(event: AuditEvent): Promise<void> {
    this.auditEvents.push(structuredClone(event));
  }
}
