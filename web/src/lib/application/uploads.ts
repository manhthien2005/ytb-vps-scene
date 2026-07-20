import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Artifact, UploadIntent, UploadIntentInput, VerifiedDriveFile } from "@/lib/domain/drive";
import { AppError } from "@/lib/domain/errors";
import { validateUploadIntent } from "@/lib/domain/upload";
import type { DriveAccessProvider, DriveFilesPort } from "@/lib/ports/drive";
import type { DriveControlPlaneRepository } from "@/lib/repositories/drive-control-plane";
import type { FreeTierHealthService } from "./free-tier-health";

const CHUNK_BYTES = 8_388_608 as const;
const uuid = z.string().uuid();

export type UploadSessionResult =
  | Readonly<{
      artifactId: string;
      sessionUri: string;
      chunkBytes: 8_388_608;
      expiresAt: string;
    }>
  | Readonly<{
      artifactId: string;
      status: "SOURCE_READY";
      actualSizeBytes: number;
    }>;

export type UploadCompletionResult =
  | Readonly<{ status: "SOURCE_READY"; actualSizeBytes: number }>
  | Readonly<{ status: "UPLOAD_PENDING"; retryAfterMs: 1_000 }>;

export interface UploadService {
  createSession(input: Readonly<{
    projectId: string;
    intent: UploadIntentInput;
    now: Date;
  }>): Promise<UploadSessionResult>;
  complete(input: Readonly<{
    projectId: string;
    artifactId: string;
    now: Date;
  }>): Promise<UploadCompletionResult>;
  cancel(input: Readonly<{
    projectId: string;
    artifactId: string;
    now: Date;
  }>): Promise<Readonly<{ status: "CANCELLED" }>>;
}

type UploadDependencies = Readonly<{
  repository: DriveControlPlaneRepository;
  access: DriveAccessProvider;
  files: DriveFilesPort;
  health: FreeTierHealthService;
  maximumBytes: number;
  softPercent: number;
  staleAfterSeconds: number;
}>;

function remoteMismatch(): AppError {
  return new AppError("UPLOAD_REMOTE_MISMATCH", 409);
}

function rejectCapacity(outcome: Awaited<ReturnType<DriveControlPlaneRepository["reserveSourceCapacity"]>>): never {
  if (outcome === "CONFLICT") throw remoteMismatch();
  if (outcome === "DRIVE_STORAGE_HIGH" || outcome === "NEON_STORAGE_HIGH") {
    throw new AppError(outcome, 409);
  }
  if (outcome === "DRIVE_TEMPORARILY_UNAVAILABLE") {
    throw new AppError(outcome, 503);
  }
  if (outcome === "DRIVE_QUOTA_STALE" || outcome === "QUOTA_INVALID") {
    throw new AppError(outcome, 503);
  }
  throw new AppError("QUOTA_INVALID", 503);
}

function expectedSourceProperties(projectId: string, artifactId: string) {
  return {
    ytbVpsProjectId: projectId,
    ytbVpsArtifactId: artifactId,
    ytbVpsRole: "source",
    schema: "1",
  } as const;
}

function sameProperties(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => (
      key === expectedKeys[index] && actual[key] === expected[key]
    ));
}

function expectedSourceName(displayName: string): string {
  return `source.${displayName.split(".").at(-1)?.toLowerCase() ?? ""}`;
}

function classifyEvidence(artifact: Artifact, remote: VerifiedDriveFile): "READY" | "PENDING" {
  const identityMatches = remote.id === artifact.driveFileId &&
    remote.parentIds.length === 1 && remote.parentIds[0] === artifact.driveParentId &&
    remote.name === expectedSourceName(artifact.displayName) &&
    remote.mimeType === artifact.mimeType &&
    remote.trashed === false &&
    sameProperties(
      remote.appProperties,
      expectedSourceProperties(artifact.projectId, artifact.id),
    );
  if (
    !identityMatches ||
    !Number.isSafeInteger(remote.sizeBytes) ||
    remote.sizeBytes < 0 ||
    remote.sizeBytes > artifact.expectedSizeBytes
  ) {
    throw remoteMismatch();
  }
  return remote.sizeBytes === artifact.expectedSizeBytes ? "READY" : "PENDING";
}

function matchingLiveArtifact(
  artifact: Artifact,
  projectId: string,
  inputFolderId: string,
  intent: UploadIntent,
): boolean {
  return artifact.id === projectId &&
    artifact.projectId === projectId &&
    artifact.kind === "SOURCE" &&
    (artifact.status === "PENDING" || artifact.status === "UPLOADING") &&
    artifact.driveParentId === inputFolderId &&
    artifact.displayName === intent.fileName &&
    artifact.mimeType === intent.mimeType &&
    artifact.expectedSizeBytes === intent.sizeBytes &&
    artifact.actualSizeBytes === null;
}

function matchingReservation(
  artifact: Artifact,
  projectId: string,
  fileId: string,
  inputFolderId: string,
  intent: UploadIntent,
): boolean {
  return matchingLiveArtifact(artifact, projectId, inputFolderId, intent) &&
    artifact.driveFileId === fileId;
}

function matchingReadyArtifact(
  artifact: Artifact,
  projectId: string,
  inputFolderId: string,
  intent: UploadIntent,
): boolean {
  return artifact.id === projectId &&
    artifact.projectId === projectId &&
    artifact.kind === "SOURCE" &&
    artifact.status === "READY" &&
    artifact.driveParentId === inputFolderId &&
    artifact.displayName === intent.fileName &&
    artifact.mimeType === intent.mimeType &&
    artifact.expectedSizeBytes === intent.sizeBytes &&
    artifact.actualSizeBytes === intent.sizeBytes;
}

function validateStoredArtifact(
  artifact: Artifact | null,
  projectId: string,
  artifactId: string,
): Artifact {
  if (
    artifact === null ||
    artifactId !== projectId ||
    artifact.id !== artifactId ||
    artifact.projectId !== projectId ||
    artifact.kind !== "SOURCE" ||
    !Number.isSafeInteger(artifact.expectedSizeBytes) ||
    artifact.expectedSizeBytes < 1
  ) {
    throw remoteMismatch();
  }
  return artifact;
}

function parseResourceIds(projectId: string, artifactId: string): Readonly<{
  projectId: string;
  artifactId: string;
}> {
  const parsedProjectId = uuid.safeParse(projectId);
  const parsedArtifactId = uuid.safeParse(artifactId);
  if (!parsedProjectId.success || !parsedArtifactId.success) {
    throw new AppError("INVALID_REQUEST", 400);
  }
  return { projectId: parsedProjectId.data, artifactId: parsedArtifactId.data };
}

function auditPayload(artifact: Artifact, status: "UPLOADING" | "READY" | "INVALID" | "DELETED") {
  return {
    projectId: artifact.projectId,
    artifactId: artifact.id,
    ...(status === "READY"
      ? { actualSizeBytes: artifact.expectedSizeBytes }
      : { expectedSizeBytes: artifact.expectedSizeBytes }),
    mimeType: artifact.mimeType,
    status,
  } as const;
}

export function createUploadService(dependencies: UploadDependencies): UploadService {
  return {
    async createSession(input) {
      const parsedProjectId = uuid.safeParse(input.projectId);
      if (!parsedProjectId.success) throw new AppError("INVALID_REQUEST", 400);
      const intent = validateUploadIntent(input.intent, dependencies.maximumBytes);
      const projectId = parsedProjectId.data;
      const project = await dependencies.repository.getProject(projectId);
      if (
        project === null ||
        project.id !== projectId ||
        project.status !== "READY" ||
        project.driveInputFolderId === null
      ) {
        throw remoteMismatch();
      }

      const artifactId = projectId;
      const claimToken = randomUUID();
      if (!await dependencies.repository.claimProvisioning("SOURCE", artifactId, claimToken)) {
        throw new AppError("DRIVE_TEMPORARILY_UNAVAILABLE", 503);
      }
      try {
        const existing = await dependencies.repository.getArtifact(projectId, artifactId);
        if (existing !== null && matchingReadyArtifact(
          existing,
          projectId,
          project.driveInputFolderId,
          intent,
        )) {
          return {
            artifactId,
            status: "SOURCE_READY",
            actualSizeBytes: intent.sizeBytes,
          };
        }
        let selected: Artifact;
        const replaceDeleted = existing !== null &&
          existing.id === artifactId &&
          existing.projectId === projectId &&
          existing.kind === "SOURCE" &&
          existing.status === "DELETED";

        if (existing !== null && !replaceDeleted && !matchingLiveArtifact(
          existing,
          projectId,
          project.driveInputFolderId,
          intent,
        )) {
          throw remoteMismatch();
        }

        await dependencies.health.assertUploadAllowed(
          existing === null || replaceDeleted ? intent.sizeBytes : 0,
          input.now,
        );
        const capacity = await dependencies.repository.reserveSourceCapacity({
          artifactId,
          projectId,
          driveParentId: project.driveInputFolderId,
          fileName: intent.fileName,
          mimeType: intent.mimeType,
          sizeBytes: intent.sizeBytes,
          claimToken,
          now: input.now,
          softPercent: dependencies.softPercent,
          staleAfterSeconds: dependencies.staleAfterSeconds,
        });
        if (capacity !== "RESERVED" && capacity !== "EXISTING") rejectCapacity(capacity);
        const accessToken = await dependencies.access.getAccessToken();

        if (existing === null || replaceDeleted) {
          if (!await dependencies.repository.renewProvisioning("SOURCE", artifactId, claimToken)) {
            throw new AppError("DRIVE_TEMPORARILY_UNAVAILABLE", 503);
          }
          const driveFileId = await dependencies.files.ensureSourceFile(accessToken, {
            ...intent,
            projectId,
            artifactId,
            parentId: project.driveInputFolderId,
          });
          selected = await dependencies.repository.reserveSourceArtifact({
            ...intent,
            artifactId,
            projectId,
            driveFileId,
            driveParentId: project.driveInputFolderId,
          }, claimToken);
          if (!matchingReservation(
            selected,
            projectId,
            driveFileId,
            project.driveInputFolderId,
            intent,
          )) {
            throw remoteMismatch();
          }
        } else {
          const remote = await dependencies.files.inspectFile(accessToken, existing.driveFileId);
          const evidence = classifyEvidence(existing, remote);
          if (!await dependencies.repository.renewProvisioning("SOURCE", artifactId, claimToken)) {
            throw new AppError("DRIVE_TEMPORARILY_UNAVAILABLE", 503);
          }
          await dependencies.repository.observeSourceProgress(existing.id, remote.sizeBytes);
          if (evidence === "READY") {
            if (existing.status === "PENDING") {
              await dependencies.repository.markArtifactUploading(existing.id);
            }
            await dependencies.repository.markSourceReady(
              existing.id,
              existing.expectedSizeBytes,
              input.now,
            );
            await dependencies.repository.recordAudit({
              eventType: "UPLOAD_COMPLETED",
              targetId: existing.id,
              actorClass: "admin",
              payload: auditPayload(existing, "READY"),
            });
            return {
              artifactId: existing.id,
              status: "SOURCE_READY",
              actualSizeBytes: existing.expectedSizeBytes,
            };
          }
          selected = existing;
        }

        if (!await dependencies.repository.renewProvisioning("SOURCE", artifactId, claimToken)) {
          throw new AppError("DRIVE_TEMPORARILY_UNAVAILABLE", 503);
        }

        await dependencies.repository.markArtifactUploading(artifactId);
        const session = await dependencies.files.createResumableUpdateSession(accessToken, {
          fileId: selected.driveFileId,
          mimeType: selected.mimeType,
          sizeBytes: selected.expectedSizeBytes,
        });
        await dependencies.repository.recordAudit({
          eventType: "UPLOAD_SESSION_CREATED",
          targetId: artifactId,
          actorClass: "admin",
          payload: {
            projectId,
            artifactId,
            expectedSizeBytes: selected.expectedSizeBytes,
            mimeType: selected.mimeType,
            status: "UPLOADING",
          },
        });
        return {
          artifactId,
          sessionUri: session.sessionUri,
          chunkBytes: CHUNK_BYTES,
          expiresAt: session.expiresAt,
        };
      } finally {
        await dependencies.repository.releaseProvisioning("SOURCE", artifactId, claimToken)
          .catch(() => undefined);
      }
    },

    async complete(input) {
      const ids = parseResourceIds(input.projectId, input.artifactId);
      const artifact = validateStoredArtifact(
        await dependencies.repository.getArtifact(ids.projectId, ids.artifactId),
        ids.projectId,
        ids.artifactId,
      );
      if (artifact.status === "READY") {
        if (
          artifact.actualSizeBytes === null ||
          !Number.isSafeInteger(artifact.actualSizeBytes) ||
          artifact.actualSizeBytes < 0
        ) {
          throw remoteMismatch();
        }
        return { status: "SOURCE_READY", actualSizeBytes: artifact.actualSizeBytes };
      }
      if (
        (artifact.status !== "PENDING" && artifact.status !== "UPLOADING") ||
        artifact.actualSizeBytes !== null
      ) {
        throw remoteMismatch();
      }

      const accessToken = await dependencies.access.getAccessToken();
      const remote = await dependencies.files.inspectFile(accessToken, artifact.driveFileId);
      let evidence: "READY" | "PENDING";
      try {
        evidence = classifyEvidence(artifact, remote);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "UPLOAD_REMOTE_MISMATCH") throw error;
        await dependencies.repository.markSourceInvalid(artifact.id);
        await dependencies.repository.recordAudit({
          eventType: "UPLOAD_FAILED",
          targetId: artifact.id,
          actorClass: "admin",
          payload: auditPayload(artifact, "INVALID"),
        });
        throw error;
      }
      await dependencies.repository.observeSourceProgress(artifact.id, remote.sizeBytes);
      if (evidence === "PENDING") return { status: "UPLOAD_PENDING", retryAfterMs: 1_000 };

      if (artifact.status === "PENDING") {
        await dependencies.repository.markArtifactUploading(artifact.id);
      }
      await dependencies.repository.markSourceReady(
        artifact.id,
        artifact.expectedSizeBytes,
        input.now,
      );
      await dependencies.repository.recordAudit({
        eventType: "UPLOAD_COMPLETED",
        targetId: artifact.id,
        actorClass: "admin",
        payload: auditPayload(artifact, "READY"),
      });
      return { status: "SOURCE_READY", actualSizeBytes: artifact.expectedSizeBytes };
    },

    async cancel(input) {
      const ids = parseResourceIds(input.projectId, input.artifactId);
      const artifact = validateStoredArtifact(
        await dependencies.repository.getArtifact(ids.projectId, ids.artifactId),
        ids.projectId,
        ids.artifactId,
      );
      if (artifact.status === "DELETED") return { status: "CANCELLED" };
      if (artifact.status !== "DELETING" && (
        (artifact.status !== "PENDING" && artifact.status !== "UPLOADING") ||
        artifact.actualSizeBytes !== null
      )) {
        throw remoteMismatch();
      }

      const accessToken = await dependencies.access.getAccessToken();
      if (artifact.status !== "DELETING") {
        const remote = await dependencies.files.inspectFile(accessToken, artifact.driveFileId);
        classifyEvidence(artifact, remote);
        const claim = await dependencies.repository.claimSourceDeletion(artifact.id);
        if (claim === "CONFLICT") throw remoteMismatch();
        if (claim === "DELETED") return { status: "CANCELLED" };
      }
      await dependencies.files.deleteFile(accessToken, artifact.driveFileId);
      const changed = await dependencies.repository.markSourceDeleted(artifact.id);
      if (changed) {
        await dependencies.repository.recordAudit({
          eventType: "UPLOAD_CANCELLED",
          targetId: artifact.id,
          actorClass: "admin",
          payload: auditPayload(artifact, "DELETED"),
        });
      }
      return { status: "CANCELLED" };
    },
  };
}
