import type { DriveConnectionStatus } from "@/lib/domain/drive";

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
