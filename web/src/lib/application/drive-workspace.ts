import "server-only";

import { AppError } from "@/lib/domain/errors";
import type { DriveVideoMetadata } from "@/lib/domain/drive";
import type { DriveAccessProvider, DriveFilesPort } from "@/lib/ports/drive";
import type {
  DriveControlPlaneRepository,
  ManagedArtifactRecord,
} from "@/lib/repositories/drive-control-plane";

const INSPECTION_CONCURRENCY = 4;

export type DriveWorkspaceFile = Readonly<{
  artifactId: string;
  name: string;
  sizeBytes: number;
  uploadedAt: string;
  durationMillis: number | null;
  width: number | null;
  height: number | null;
  readiness: "PROCESSING" | "READY" | "UNKNOWN";
  viewUrl: string | null;
  downloadUrl: string | null;
}>;

export type DriveWorkspaceView = Readonly<{
  input: readonly DriveWorkspaceFile[];
  output: readonly Readonly<{
    projectId: string;
    name: string;
    files: readonly DriveWorkspaceFile[];
  }>[];
  processingCount: number;
}>;

export interface DriveWorkspaceService {
  list(): Promise<DriveWorkspaceView>;
  delete(artifactId: string): Promise<Readonly<{ status: "DELETED" }>>;
}

type Diagnostic = Readonly<{
  code: "DRIVE_WORKSPACE_REMOTE_MISMATCH" | "DRIVE_WORKSPACE_INSPECTION_FAILED";
}>;

type DriveWorkspaceDependencies = Readonly<{
  repository: DriveControlPlaneRepository;
  access: DriveAccessProvider;
  files: DriveFilesPort;
  onDiagnostic?: (diagnostic: Diagnostic) => void;
}>;

function expectedSize(record: ManagedArtifactRecord): number {
  return record.artifact.actualSizeBytes ?? record.artifact.expectedSizeBytes;
}

function matchesManagedRecord(
  record: ManagedArtifactRecord,
  metadata: DriveVideoMetadata,
): boolean {
  const artifact = record.artifact;
  return metadata.id === artifact.driveFileId &&
    metadata.name === artifact.displayName &&
    metadata.mimeType === artifact.mimeType &&
    metadata.sizeBytes === expectedSize(record) &&
    metadata.appProperties.ytbVpsArtifactId === artifact.id &&
    metadata.appProperties.ytbVpsProjectId === artifact.projectId &&
    metadata.appProperties.ytbVpsRole === artifact.kind.toLowerCase();
}

function readiness(metadata: DriveVideoMetadata): DriveWorkspaceFile["readiness"] {
  return metadata.width !== null &&
    metadata.height !== null &&
    metadata.durationMillis !== null &&
    metadata.webViewLink !== null
    ? "READY"
    : "PROCESSING";
}

function publicFile(
  record: ManagedArtifactRecord,
  metadata: DriveVideoMetadata,
): DriveWorkspaceFile {
  return {
    artifactId: record.artifact.id,
    name: record.artifact.displayName,
    sizeBytes: expectedSize(record),
    uploadedAt: record.verifiedAt ?? metadata.modifiedTime,
    durationMillis: metadata.durationMillis,
    width: metadata.width,
    height: metadata.height,
    readiness: readiness(metadata),
    viewUrl: metadata.webViewLink,
    downloadUrl: metadata.webContentLink,
  };
}

function unknownFile(record: ManagedArtifactRecord): DriveWorkspaceFile | null {
  if (record.verifiedAt === null) return null;
  return {
    artifactId: record.artifact.id,
    name: record.artifact.displayName,
    sizeBytes: expectedSize(record),
    uploadedAt: record.verifiedAt,
    durationMillis: null,
    width: null,
    height: null,
    readiness: "UNKNOWN",
    viewUrl: null,
    downloadUrl: null,
  };
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  limit: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(values[index]!);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(limit, values.length) },
    () => worker(),
  ));
  return results;
}

export function createDriveWorkspaceService(
  dependencies: DriveWorkspaceDependencies,
): DriveWorkspaceService {
  const diagnose = (code: Diagnostic["code"]): void => {
    dependencies.onDiagnostic?.({ code });
  };

  return {
    async list() {
      const accessToken = await dependencies.access.getAccessToken();
      const records = await dependencies.repository.listManagedArtifacts();
      const inspected = await mapConcurrent(records, INSPECTION_CONCURRENCY, async (record) => {
        try {
          const metadata = await dependencies.files.inspectVideoMetadata(
            accessToken,
            record.artifact.driveFileId,
          );
          if (!matchesManagedRecord(record, metadata)) {
            diagnose("DRIVE_WORKSPACE_REMOTE_MISMATCH");
            return null;
          }
          return { record, file: publicFile(record, metadata) };
        } catch (error) {
          if (error instanceof AppError && error.code === "DRIVE_REMOTE_MISMATCH") {
            diagnose("DRIVE_WORKSPACE_REMOTE_MISMATCH");
            return null;
          }
          diagnose("DRIVE_WORKSPACE_INSPECTION_FAILED");
          const file = unknownFile(record);
          return file === null ? null : { record, file };
        }
      });

      const input: DriveWorkspaceFile[] = [];
      const outputByProject = new Map<string, {
        projectId: string;
        name: string;
        files: DriveWorkspaceFile[];
      }>();
      let processingCount = 0;
      for (const item of inspected) {
        if (item === null) continue;
        if (item.file.readiness === "PROCESSING") processingCount += 1;
        if (item.record.artifact.kind === "SOURCE") {
          input.push(item.file);
          continue;
        }
        const projectId = item.record.artifact.projectId;
        const group = outputByProject.get(projectId) ?? {
          projectId,
          name: item.record.projectName,
          files: [],
        };
        group.files.push(item.file);
        outputByProject.set(projectId, group);
      }

      return {
        input,
        output: [...outputByProject.values()],
        processingCount,
      };
    },

    async delete(artifactId) {
      const records = await dependencies.repository.listManagedArtifacts();
      const record = records.find((item) => item.artifact.id === artifactId);
      const claim = await dependencies.repository.claimManagedArtifactDeletion(artifactId);
      if (claim === "CONFLICT") {
        throw new AppError("DRIVE_FILE_DELETE_CONFLICT", 409);
      }
      if (claim === "DELETED") return { status: "DELETED" };
      if (!record) throw new AppError("DRIVE_FILE_DELETE_CONFLICT", 409);

      const accessToken = await dependencies.access.getAccessToken();
      try {
        await dependencies.files.deleteFile(accessToken, record.artifact.driveFileId);
      } catch (error) {
        if (!(error instanceof AppError) || error.status !== 404) throw error;
      }
      await dependencies.repository.markManagedArtifactDeleted(artifactId);
      return { status: "DELETED" };
    },
  };
}
