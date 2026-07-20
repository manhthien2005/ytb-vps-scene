import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { AppError } from "@/lib/domain/errors";
import { parseWorkerCapabilities, parseWorkerDoctorReport, type WorkerCapabilities, type WorkerDoctorReport, type WorkerView } from "@/lib/domain/worker";
import { digestBearerSecret, generateBearerSecret } from "@/lib/security/worker-secret";
import type { WorkerControlPlaneRepository } from "@/lib/repositories/worker-control-plane";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type WorkerControlDependencies = Readonly<{
  repository: WorkerControlPlaneRepository;
  authKey: string;
  appOrigin: string;
  releaseRepository: string;
  releaseCommit: string;
  pipelineBridgeVersion: string;
  generateSecret?: () => string;
  generateId?: () => string;
}>;

export type EnrollmentCommand = Readonly<{ command: string; expiresAt: string }>;
export type WorkerSession = Readonly<{
  workerId: string;
  sessionSecret: string;
  sessionExpiresAt: string;
}>;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function rawBootstrapUrl(repository: string, commit: string): string {
  const url = new URL(repository);
  return `https://raw.githubusercontent.com${url.pathname.slice(0, -4)}/${commit}/ops/native-v2/bootstrap-worker.sh`;
}

function stateFor(capabilities: WorkerCapabilities, doctor: WorkerDoctorReport, expectedBridge: string): "SETTING_UP" | "DOCTOR_FAILED" | "READY" {
  if (doctor.status === "FAIL") return "DOCTOR_FAILED";
  if (doctor.status !== "PASS" || capabilities.pipelineBridgeVersion !== expectedBridge) return "SETTING_UP";
  return "READY";
}

export function createWorkerControlService(dependencies: WorkerControlDependencies) {
  const makeSecret = dependencies.generateSecret ?? (() => generateBearerSecret());
  const makeId = dependencies.generateId ?? (() => randomUUID());

  return {
    async createEnrollment(now: Date): Promise<EnrollmentCommand> {
      const token = makeSecret();
      const expiresAt = new Date(now.getTime() + 10 * 60_000);
      await dependencies.repository.createEnrollment({
        tokenDigest: digestBearerSecret(token, dependencies.authKey),
        expiresAt,
        now,
      });
      const command = [
        `curl -fsSL ${rawBootstrapUrl(dependencies.releaseRepository, dependencies.releaseCommit)}`,
        "| sudo bash -s --",
        quoteShell(dependencies.appOrigin),
        quoteShell(token),
        quoteShell(dependencies.releaseRepository),
        quoteShell(dependencies.releaseCommit),
      ].join(" ");
      return Object.freeze({ command, expiresAt: expiresAt.toISOString() });
    },

    async enroll(input: Readonly<{
      enrollmentToken: string;
      capabilities: unknown;
      doctor: unknown;
      accountLabel?: string | null;
    }>, now: Date): Promise<WorkerSession> {
      if (!TOKEN_PATTERN.test(input.enrollmentToken)) throw new AppError("WORKER_ENROLLMENT_INVALID", 401);
      let capabilities: WorkerCapabilities;
      let doctor: WorkerDoctorReport;
      try {
        capabilities = parseWorkerCapabilities(input.capabilities);
        doctor = parseWorkerDoctorReport(input.doctor);
      } catch {
        throw new AppError("WORKER_ENROLLMENT_INVALID", 400);
      }
      const sessionSecret = makeSecret();
      const sessionExpiresAt = new Date(now.getTime() + 24 * 60 * 60_000);
      const result = await dependencies.repository.enrollWorker({
        tokenDigest: digestBearerSecret(input.enrollmentToken, dependencies.authKey),
        workerId: makeId(),
        sessionDigest: digestBearerSecret(sessionSecret, dependencies.authKey),
        sessionExpiresAt,
        accountLabel: input.accountLabel ?? null,
        capabilities,
        doctor,
        state: stateFor(capabilities, doctor, dependencies.pipelineBridgeVersion),
        now,
      });
      if (result === null) throw new AppError("WORKER_ENROLLMENT_INVALID", 401);
      return Object.freeze({
        workerId: result.worker.id,
        sessionSecret,
        sessionExpiresAt: result.worker.sessionExpiresAt,
      });
    },

    async heartbeat(workerId: string, input: Readonly<{ capabilities: unknown; doctor: unknown }>, now: Date): Promise<WorkerView> {
      let capabilities: WorkerCapabilities;
      let doctor: WorkerDoctorReport;
      try {
        capabilities = parseWorkerCapabilities(input.capabilities);
        doctor = parseWorkerDoctorReport(input.doctor);
      } catch {
        throw new AppError("INVALID_REQUEST", 400);
      }
      const worker = await dependencies.repository.heartbeatWorker({
        workerId,
        capabilities,
        doctor,
        state: stateFor(capabilities, doctor, dependencies.pipelineBridgeVersion),
        now,
      });
      if (worker === null) throw new AppError("WORKER_SESSION_EXPIRED", 401);
      return worker;
    },

    list: (now: Date) => dependencies.repository.listWorkers(now),

    async revoke(workerId: string, now: Date): Promise<void> {
      await dependencies.repository.revokeWorker(workerId, now);
    },
  };
}

export function workerRequestKeyDigest(projectId: string, requestKey: string): string {
  return sha256(`ytb-vps-project-job-v1\0${projectId}\0${requestKey}`);
}
