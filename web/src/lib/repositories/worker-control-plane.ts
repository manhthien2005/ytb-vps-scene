import type { JobState, JobSummary } from "@/lib/domain/control-plane";
import type { WorkerCapabilities, WorkerDoctorReport, WorkerLease, WorkerView } from "@/lib/domain/worker";
import type { WorkerSessionRepository } from "@/lib/http/worker-auth";

export type EnrollmentReservation = Readonly<{
  tokenDigest: string;
  expiresAt: Date;
  now: Date;
}>;

export type WorkerEnrollment = Readonly<{
  tokenDigest: string;
  workerId: string;
  sessionDigest: string;
  sessionExpiresAt: Date;
  accountLabel: string | null;
  capabilities: WorkerCapabilities;
  doctor: WorkerDoctorReport;
  state: "SETTING_UP" | "DOCTOR_FAILED" | "READY";
  now: Date;
}>;

export type WorkerEnrollmentResult = Readonly<{ outcome: "ENROLLED"; worker: WorkerView }>;

export type WorkerHeartbeat = Readonly<{
  workerId: string;
  capabilities: WorkerCapabilities;
  doctor: WorkerDoctorReport;
  state: "SETTING_UP" | "DOCTOR_FAILED" | "READY";
  now: Date;
}>;

export type QueueProjectJob = Readonly<{
  jobId: string;
  projectId: string;
  requestKeyDigest: string;
  now: Date;
}>;

export type JobAssignment = Readonly<{ job: JobSummary; lease: WorkerLease }>;

export type RenewLease = Readonly<{
  workerId: string;
  jobId: string;
  fencingToken: number;
  now: Date;
}>;

export type JobProgress = Readonly<{
  workerId: string;
  jobId: string;
  fencingToken: number;
  fromState: JobState;
  state: JobState;
  progressPercent: number;
  now: Date;
}>;

export interface WorkerControlPlaneRepository extends WorkerSessionRepository {
  createEnrollment(input: EnrollmentReservation): Promise<void>;
  enrollWorker(input: WorkerEnrollment): Promise<WorkerEnrollmentResult | null>;
  heartbeatWorker(input: WorkerHeartbeat): Promise<WorkerView | null>;
  listWorkers(now: Date): Promise<readonly WorkerView[]>;
  revokeWorker(workerId: string, now: Date): Promise<boolean>;
  queueProjectJob(input: QueueProjectJob): Promise<JobSummary | null>;
  claimJob(workerId: string, now: Date, bridgeVersion: string): Promise<JobAssignment | null>;
  renewLease(input: RenewLease): Promise<WorkerLease | null>;
  updateJobProgress(input: JobProgress): Promise<"UPDATED" | "LEASE_LOST">;
  expireWorkersAndLeases(now: Date): Promise<void>;
}
