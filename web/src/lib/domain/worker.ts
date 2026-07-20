import { z } from "zod";
import type { WorkerState } from "./control-plane";
import { parseSceneSettings, type SceneSettings } from "./scene-settings";

const bridgeVersion = z.string().min(1).max(80).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);

const capabilitiesSchema = z.object({
  protocolVersion: z.literal(1),
  pipelineBridgeVersion: bridgeVersion,
  os: z.literal("ubuntu-22.04"),
  arch: z.literal("x86_64"),
  gpuName: z.string().trim().min(1).max(160),
  vramMiB: z.number().int().safe().min(256).max(1_048_576),
  cudaVersion: z.string().regex(/^\d{1,3}\.\d{1,3}$/),
  nvenc: z.boolean(),
}).strict();

const canonicalTimestamp = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}, "Expected a canonical UTC timestamp");

const doctorReportSchema = z.object({
  status: z.enum(["PASS", "DEGRADED", "FAIL"]),
  reasonCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/)).max(32),
  observedAt: canonicalTimestamp,
}).strict();

export type WorkerCapabilities = Readonly<z.infer<typeof capabilitiesSchema>>;
export type WorkerDoctorReport = Readonly<{
  status: "PASS" | "DEGRADED" | "FAIL";
  reasonCodes: readonly string[];
  observedAt: string;
}>;

export type WorkerView = Readonly<{
  id: string;
  state: WorkerState;
  accountLabel: string | null;
  capabilities: WorkerCapabilities;
  doctor: WorkerDoctorReport;
  lastHeartbeatAt: string;
  sessionExpiresAt: string;
}>;

export type WorkerLease = Readonly<{
  jobId: string;
  workerId: string;
  fencingToken: number;
  expiresAt: string;
}>;

const mediaExecutionSchema = z.object({
  projectId: z.string().uuid(),
  source: z.object({
    driveFileId: z.string().min(10).max(256).regex(/^\S+$/),
    fileName: z.string().trim().min(1).max(255),
    mimeType: z.enum(["video/mp4", "video/quicktime", "video/x-matroska", "video/webm"]),
    sizeBytes: z.number().int().safe().min(1).max(1_099_511_627_776),
  }).strict(),
  outputParentId: z.string().min(10).max(256).regex(/^\S+$/),
  sceneSettings: z.unknown(),
}).strict();

export type MediaExecutionDescriptor = Readonly<{
  projectId: string;
  source: Readonly<{
    driveFileId: string;
    fileName: string;
    mimeType: "video/mp4" | "video/quicktime" | "video/x-matroska" | "video/webm";
    sizeBytes: number;
  }>;
  outputParentId: string;
  sceneSettings: SceneSettings;
}>;

export function parseWorkerCapabilities(value: unknown): WorkerCapabilities {
  return Object.freeze(capabilitiesSchema.parse(value));
}

export function parseWorkerDoctorReport(value: unknown): WorkerDoctorReport {
  const report = doctorReportSchema.parse(value);
  return Object.freeze({ ...report, reasonCodes: Object.freeze([...report.reasonCodes]) });
}

export function parseMediaExecutionDescriptor(value: unknown): MediaExecutionDescriptor {
  const descriptor = mediaExecutionSchema.parse(value);
  return Object.freeze({
    projectId: descriptor.projectId,
    source: Object.freeze({ ...descriptor.source }),
    outputParentId: descriptor.outputParentId,
    sceneSettings: Object.freeze(parseSceneSettings(descriptor.sceneSettings)),
  });
}
