import type { Artifact, Project } from "@/lib/domain/drive";
import type { UsageSnapshot } from "@/lib/ports/drive";
import type { AuditEvent } from "@/lib/repositories/control-plane";
import type {
  DriveControlPlaneRepository,
  ProjectReservation,
  ProjectReservationResult,
  SourceReservation,
  StoredConnectedCredential,
  StoredDriveCredential,
} from "@/lib/repositories/drive-control-plane";

type StoredProject = Readonly<{
  project: Project;
  idempotencyKeyHash: string;
  requestHash: string;
}>;

export class FakeDriveControlPlaneRepository implements DriveControlPlaneRepository {
  readonly auditEvents: AuditEvent[] = [];
  private readonly nonces = new Map<string, number>();
  private readonly projects = new Map<string, StoredProject>();
  private readonly artifacts = new Map<string, Artifact>();
  private readonly usage = new Map<"DRIVE" | "NEON", UsageSnapshot>();
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

  async completeProjectFolders(projectId: string, projectFolderId: string, inputFolderId: string): Promise<Project> {
    const stored = this.projects.get(projectId);
    if (!stored || (stored.project.status !== "PROVISIONING" && (
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

  async reserveSourceArtifact(input: SourceReservation): Promise<Artifact> {
    const project = this.projects.get(input.projectId)?.project;
    if (!project || project.status !== "READY") throw new Error("Project not ready or source already reserved");
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

  async markSourceReady(artifactId: string, actualSizeBytes: number, verifiedAt: Date): Promise<void> {
    const artifact = this.artifacts.get(artifactId);
    if (
      !artifact || artifact.kind !== "SOURCE" || !["UPLOADING", "READY"].includes(artifact.status) ||
      !Number.isSafeInteger(actualSizeBytes) || actualSizeBytes < 0 ||
      !Number.isFinite(verifiedAt.getTime())
    ) throw new Error("Source cannot be marked ready");
    this.artifacts.set(artifactId, { ...artifact, status: "READY", actualSizeBytes });
    this.updateProject(artifact.projectId, { sourceStatus: "SOURCE_READY" });
  }

  async markSourceInvalid(artifactId: string): Promise<void> {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact || artifact.kind !== "SOURCE" || artifact.status === "DELETED") {
      throw new Error("Source cannot be marked invalid");
    }
    this.artifacts.set(artifactId, { ...artifact, status: "INVALID" });
    this.updateProject(artifact.projectId, { sourceStatus: "UPLOAD_FAILED" });
  }

  async markSourceDeleted(artifactId: string): Promise<void> {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact || artifact.kind !== "SOURCE") throw new Error("Source cannot be marked deleted");
    this.artifacts.set(artifactId, { ...artifact, status: "DELETED" });
    this.updateProject(artifact.projectId, { sourceStatus: "NO_SOURCE" });
  }

  async getUsage(provider: "DRIVE" | "NEON"): Promise<UsageSnapshot | null> {
    const snapshot = this.usage.get(provider);
    return snapshot ? structuredClone(snapshot) : null;
  }

  async saveUsage(snapshot: UsageSnapshot): Promise<void> {
    this.usage.set(snapshot.provider, structuredClone(snapshot));
  }

  async appManagedDriveBytes(): Promise<number> {
    return [...this.artifacts.values()]
      .filter((artifact) => artifact.status !== "DELETED")
      .reduce((total, artifact) => total + (artifact.actualSizeBytes ?? artifact.expectedSizeBytes), 0);
  }

  async databaseUsedBytes(): Promise<number> {
    return this.neonBytes;
  }

  async recordAudit(event: AuditEvent): Promise<void> {
    this.auditEvents.push(structuredClone(event));
  }
}
