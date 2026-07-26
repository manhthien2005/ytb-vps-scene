import type { SceneSettings } from "./scene-settings";

export const JOB_STATES = [
  "DRAFT", "READY", "QUEUED", "CLAIMED", "DOWNLOADING", "OCR", "TRANSLATE",
  "REVIEW_READY", "PAUSED_REVIEW", "TTS", "RENDER", "UPLOADING", "COMPLETED", "PAUSED_QUOTA",
  "PAUSED_NO_WORKER", "FAILED_RETRYABLE", "FAILED_FINAL", "CANCEL_REQUESTED",
  "CANCELLED", "DELETING", "DELETED",
] as const;
export type JobState = (typeof JOB_STATES)[number];

export const WORKER_STATES = ["SETTING_UP", "DOCTOR_FAILED", "READY", "BUSY", "OFFLINE", "REVOKED"] as const;
export type WorkerState = (typeof WORKER_STATES)[number];

const next: Readonly<Record<JobState, readonly JobState[]>> = {
  DRAFT: ["READY", "DELETING"],
  READY: ["QUEUED", "DELETING"],
  QUEUED: ["CLAIMED", "CANCEL_REQUESTED", "PAUSED_NO_WORKER"],
  CLAIMED: ["DOWNLOADING", "PAUSED_NO_WORKER", "FAILED_RETRYABLE", "FAILED_FINAL", "CANCEL_REQUESTED"],
  DOWNLOADING: ["OCR", "PAUSED_NO_WORKER", "FAILED_RETRYABLE", "FAILED_FINAL", "CANCEL_REQUESTED"],
  OCR: ["TRANSLATE", "UPLOADING", "PAUSED_NO_WORKER", "FAILED_RETRYABLE", "FAILED_FINAL", "CANCEL_REQUESTED"],
  TRANSLATE: ["REVIEW_READY", "TTS", "PAUSED_QUOTA", "PAUSED_NO_WORKER", "FAILED_RETRYABLE", "FAILED_FINAL", "CANCEL_REQUESTED"],
  REVIEW_READY: ["PAUSED_REVIEW", "TTS", "FAILED_FINAL", "CANCEL_REQUESTED"],
  PAUSED_REVIEW: ["TTS", "FAILED_FINAL", "CANCEL_REQUESTED", "DELETING"],
  TTS: ["RENDER", "PAUSED_REVIEW", "PAUSED_NO_WORKER", "FAILED_RETRYABLE", "FAILED_FINAL", "CANCEL_REQUESTED"],
  RENDER: ["UPLOADING", "PAUSED_NO_WORKER", "FAILED_RETRYABLE", "FAILED_FINAL", "CANCEL_REQUESTED"],
  UPLOADING: ["COMPLETED", "PAUSED_NO_WORKER", "FAILED_RETRYABLE", "FAILED_FINAL", "CANCEL_REQUESTED"],
  COMPLETED: ["DELETING"],
  PAUSED_QUOTA: ["TRANSLATE", "CANCEL_REQUESTED", "DELETING"],
  PAUSED_NO_WORKER: ["QUEUED", "CANCEL_REQUESTED", "DELETING"],
  FAILED_RETRYABLE: ["QUEUED", "FAILED_FINAL", "CANCEL_REQUESTED", "DELETING"],
  FAILED_FINAL: ["DELETING"],
  CANCEL_REQUESTED: ["CANCELLED", "FAILED_RETRYABLE"],
  CANCELLED: ["DELETING"],
  DELETING: ["DELETED"],
  DELETED: [],
};

const terminal = new Set<JobState>(["COMPLETED", "CANCELLED", "FAILED_FINAL", "DELETED"]);

export type JobSourceMetadata = Readonly<{
  artifactId: string | null;
  displayName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  checksumSha256: string | null;
}>;

export type JobPhaseTelemetry = Readonly<{
  activePhase: string | null;
  phaseProgressPercent: number | null;
  latestMessage: string | null;
  etaSeconds: number | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelRequestedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}>;

export type JobProgressEvent = Readonly<{
  id: string;
  phase: string;
  progressPercent: number;
  message: string | null;
  recordedAt: string;
}>;

export type RenderSettingsPreset = Readonly<{
  id: string;
  name: string;
  settings: SceneSettings;
  createdAt: string;
  updatedAt: string;
}>;

export type JobSummary = Readonly<{
  id: string;
  projectName: string;
  state: JobState;
  progressPercent: number;
  updatedAt: string;
  /** Stable project linkage; prefer this over projectName (names are not unique). */
  projectId?: string | null;
  workerSummary?: Readonly<{ id: string; state: WorkerState; accountLabel: string | null }> | null;
  outputMetadata?: Readonly<{ artifactId: string | null; sizeBytes: number | null }> | null;
  settingsSnapshot?: SceneSettings | null;
  sourceMetadata?: JobSourceMetadata | null;
  activePhase?: string | null;
  phaseProgressPercent?: number | null;
  latestMessage?: string | null;
  etaSeconds?: number | null;
  startedAt?: string | null;
  completedAt?: string | null;
  cancelRequestedAt?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}>;

export type JobDetail = Readonly<JobSummary & {
  settingsSnapshot: SceneSettings | null;
  sourceMetadata: JobSourceMetadata | null;
  telemetry: JobPhaseTelemetry;
  progressHistory: readonly JobProgressEvent[];
}>;

export function assertJobTransition(from: JobState, to: JobState): void {
  if (!next[from].includes(to)) throw new Error(`Illegal job transition: ${from} -> ${to}`);
}

export function isTerminalJobState(state: string): state is JobState {
  return terminal.has(state as JobState);
}

export function isCancelableJobState(state: string): state is JobState {
  return next[state as JobState]?.includes("CANCEL_REQUESTED") ?? false;
}

const active = new Set<JobState>([
  "QUEUED", "CLAIMED", "DOWNLOADING", "OCR", "TRANSLATE", "TTS", "RENDER",
  "UPLOADING", "CANCEL_REQUESTED",
]);

/** States where the pipeline is genuinely executing or queued to execute. */
export function isActiveJobState(state: string): state is JobState {
  return active.has(state as JobState);
}
