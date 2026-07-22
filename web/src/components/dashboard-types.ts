import type { DriveConnectionStatus } from "@/lib/domain/drive";
import type { WorkerView } from "@/lib/domain/worker";

export type DriveConnectionView = Readonly<{
  status: DriveConnectionStatus;
  accountHint: string | null;
  rootReady: boolean;
}>;

export type UsageView = Readonly<{
  usedBytes: number;
  limitBytes: number;
  appManagedBytes: number;
  observedAt: string;
}>;

export type FreeTierHealthView = Readonly<{
  mode: "READ_WRITE" | "READ_ONLY";
  reasons: readonly string[];
  driveConnection: DriveConnectionStatus;
  drive: UsageView | null;
  neon: UsageView | null;
}>;

export type PublicProject = Readonly<{
  id: string;
  status: "PROVISIONING" | "READY" | "FAILED";
  name: string;
  sourceStatus: "NO_SOURCE" | "UPLOAD_PENDING" | "SOURCE_READY" | "UPLOAD_FAILED";
  createdAt: string;
  updatedAt: string;
}>;

export type WorkerViewModel = WorkerView;

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
