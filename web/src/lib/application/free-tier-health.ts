import "server-only";

import type { DriveConnectionStatus } from "@/lib/domain/drive";
import { AppError } from "@/lib/domain/errors";
import { assessProjectedUpload } from "@/lib/domain/free-tier";
import type { DriveAccessProvider, DriveFilesPort, UsageSnapshot } from "@/lib/ports/drive";
import type { DriveControlPlaneRepository } from "@/lib/repositories/drive-control-plane";

export type FreeTierHealthDependencies = Readonly<{
  repository: DriveControlPlaneRepository;
  access: DriveAccessProvider;
  files: DriveFilesPort;
  neonLimitBytes: number;
  softPercent: number;
  staleAfterSeconds: number;
}>;

export type FreeTierHealth = Readonly<{
  mode: "READ_WRITE" | "READ_ONLY";
  reasons: readonly string[];
  driveConnection: DriveConnectionStatus;
  drive: UsageSnapshot | null;
  neon: UsageSnapshot | null;
}>;

export interface FreeTierHealthService {
  getHealth(now: Date): Promise<FreeTierHealth>;
  assertUploadAllowed(incomingBytes: number, now: Date): Promise<void>;
}

type SnapshotResult = Readonly<{
  snapshot: UsageSnapshot | null;
  reason: string | null;
}>;

function validNow(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function validQuotaValue(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function validDriveAccount(value: unknown): value is Readonly<{ usedBytes: number; limitBytes: number }> {
  return typeof value === "object" && value !== null &&
    "usedBytes" in value && "limitBytes" in value &&
    validQuotaValue(value.usedBytes) &&
    validQuotaValue(value.limitBytes, 1) &&
    value.usedBytes <= value.limitBytes;
}

function validSnapshot(snapshot: unknown, provider: UsageSnapshot["provider"]): snapshot is UsageSnapshot {
  if (typeof snapshot !== "object" || snapshot === null) return false;
  const value = snapshot as Partial<UsageSnapshot>;
  return value.provider === provider &&
    validQuotaValue(value.usedBytes) &&
    validQuotaValue(value.limitBytes, 1) &&
    value.usedBytes <= value.limitBytes &&
    validQuotaValue(value.appManagedBytes) &&
    (provider === "DRIVE" ? value.appManagedBytes <= value.usedBytes : value.appManagedBytes === 0) &&
    (value.mode === "READ_WRITE" || value.mode === "READ_ONLY") &&
    Array.isArray(value.reasonCodes) &&
    value.reasonCodes.every((reason) => typeof reason === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(reason)) &&
    typeof value.observedAt === "string";
}

function fallbackSnapshot(
  snapshot: UsageSnapshot | null,
  provider: UsageSnapshot["provider"],
  now: Date,
  staleAfterSeconds: number,
): SnapshotResult {
  if (!validSnapshot(snapshot, provider)) {
    return { snapshot: null, reason: snapshot === null ? "DRIVE_QUOTA_STALE" : "QUOTA_INVALID" };
  }
  const observedAt = Date.parse(snapshot.observedAt);
  if (
    !Number.isFinite(observedAt) ||
    new Date(observedAt).toISOString() !== snapshot.observedAt ||
    observedAt > now.getTime() ||
    now.getTime() - observedAt > staleAfterSeconds * 1_000
  ) return { snapshot: null, reason: "DRIVE_QUOTA_STALE" };
  return { snapshot, reason: null };
}

async function loadFallbackSnapshot(
  repository: DriveControlPlaneRepository,
  provider: UsageSnapshot["provider"],
  now: Date,
  staleAfterSeconds: number,
): Promise<SnapshotResult> {
  try {
    return fallbackSnapshot(await repository.getUsage(provider), provider, now, staleAfterSeconds);
  } catch {
    return { snapshot: null, reason: "QUOTA_INVALID" };
  }
}

function connectionFrom(error: unknown): DriveConnectionStatus {
  if (error instanceof AppError && error.code === "DRIVE_NOT_CONNECTED") return "DISCONNECTED";
  if (error instanceof AppError && error.code === "DRIVE_REAUTH_REQUIRED") return "REAUTH_REQUIRED";
  return "CONNECTED";
}

function connectionReason(error: unknown): string | null {
  if (error instanceof AppError && (
    error.code === "DRIVE_NOT_CONNECTED" || error.code === "DRIVE_REAUTH_REQUIRED"
  )) return error.code;
  return null;
}

function retryableInspectionError(error: unknown): boolean {
  return error instanceof AppError && (
    error.code === "DRIVE_RATE_LIMITED" || error.code === "DRIVE_TEMPORARILY_UNAVAILABLE"
  );
}

function decisionError(reason: string): AppError {
  if (reason === "DRIVE_STORAGE_HIGH" || reason === "NEON_STORAGE_HIGH") {
    return new AppError(reason, 409);
  }
  if (reason === "DRIVE_NOT_CONNECTED") return new AppError(reason, 409);
  if (reason === "DRIVE_REAUTH_REQUIRED") return new AppError(reason, 401);
  if (reason === "DRIVE_QUOTA_STALE" || reason === "QUOTA_INVALID") {
    return new AppError(reason, 503);
  }
  return new AppError("QUOTA_INVALID", 503);
}

function snapshotReasons(
  snapshot: UsageSnapshot | null,
  now: Date,
  dependencies: FreeTierHealthDependencies,
  provider: "DRIVE" | "NEON",
): readonly string[] {
  if (snapshot === null) return ["DRIVE_QUOTA_STALE"];
  const decision = assessProjectedUpload({
    usedBytes: snapshot.usedBytes,
    limitBytes: snapshot.limitBytes,
    incomingBytes: 0,
    observedAt: snapshot.observedAt,
    now: now.toISOString(),
    staleAfterSeconds: dependencies.staleAfterSeconds,
    softPercent: dependencies.softPercent,
  });
  return decision.reasons.map((reason) => (
    provider === "NEON" && reason === "DRIVE_STORAGE_HIGH" ? "NEON_STORAGE_HIGH" : reason
  ));
}

function uniqueReasons(reasons: readonly string[]): readonly string[] {
  return [...new Set(reasons)];
}

export function createFreeTierHealthService(
  dependencies: FreeTierHealthDependencies,
): FreeTierHealthService {
  async function refreshDrive(now: Date): Promise<Readonly<SnapshotResult & {
    driveConnection: DriveConnectionStatus;
  }>> {
    let accessToken: string;
    try {
      accessToken = await dependencies.access.getAccessToken();
    } catch (error) {
      const driveConnection = connectionFrom(error);
      const reason = connectionReason(error);
      if (reason !== null) return { snapshot: null, reason, driveConnection };
      return { snapshot: null, reason: "DRIVE_QUOTA_STALE", driveConnection };
    }

    let account: Awaited<ReturnType<DriveFilesPort["inspectAccount"]>>;
    try {
      account = await dependencies.files.inspectAccount(accessToken);
    } catch (error) {
      const driveConnection = connectionFrom(error);
      const reason = connectionReason(error);
      if (reason !== null) return { snapshot: null, reason, driveConnection };
      if (!retryableInspectionError(error)) {
        return { snapshot: null, reason: "QUOTA_INVALID", driveConnection };
      }
      return {
        ...await loadFallbackSnapshot(
          dependencies.repository,
          "DRIVE",
          now,
          dependencies.staleAfterSeconds,
        ),
        driveConnection: "CONNECTED",
      };
    }

    if (!validDriveAccount(account)) {
      return { snapshot: null, reason: "QUOTA_INVALID", driveConnection: "CONNECTED" };
    }
    let appManagedBytes: number;
    try {
      appManagedBytes = await dependencies.repository.appManagedDriveBytes();
    } catch {
      return { snapshot: null, reason: "QUOTA_INVALID", driveConnection: "CONNECTED" };
    }
    if (!validQuotaValue(appManagedBytes) || appManagedBytes > account.usedBytes) {
      return { snapshot: null, reason: "QUOTA_INVALID", driveConnection: "CONNECTED" };
    }
    const snapshot: UsageSnapshot = {
      provider: "DRIVE",
      usedBytes: account.usedBytes,
      limitBytes: account.limitBytes,
      appManagedBytes,
      mode: "READ_WRITE",
      reasonCodes: [],
      observedAt: now.toISOString(),
    };
    return { snapshot, reason: null, driveConnection: "CONNECTED" };
  }

  async function refreshNeon(now: Date): Promise<SnapshotResult> {
    try {
      const neonBytes = await dependencies.repository.databaseUsedBytes();
      if (
        !validQuotaValue(neonBytes) ||
        !validQuotaValue(dependencies.neonLimitBytes, 1) ||
        neonBytes > dependencies.neonLimitBytes
      ) {
        return { snapshot: null, reason: "QUOTA_INVALID" };
      }
      const snapshot: UsageSnapshot = {
        provider: "NEON",
        usedBytes: neonBytes,
        limitBytes: dependencies.neonLimitBytes,
        appManagedBytes: 0,
        mode: "READ_WRITE",
        reasonCodes: [],
        observedAt: now.toISOString(),
      };
      return { snapshot, reason: null };
    } catch {
      return { snapshot: null, reason: "QUOTA_INVALID" };
    }
  }

  async function getHealth(now: Date): Promise<FreeTierHealth> {
    if (
      !validNow(now) ||
      !validQuotaValue(dependencies.softPercent, 1) || dependencies.softPercent > 100 ||
      !validQuotaValue(dependencies.staleAfterSeconds)
    ) {
      return {
        mode: "READ_ONLY",
        reasons: ["QUOTA_INVALID"],
        driveConnection: "CONNECTED",
        drive: null,
        neon: null,
      };
    }

    let previousDrive: UsageSnapshot | null;
    let previousNeon: UsageSnapshot | null;
    try {
      [previousDrive, previousNeon] = await Promise.all([
        dependencies.repository.getUsage("DRIVE"),
        dependencies.repository.getUsage("NEON"),
      ]);
    } catch {
      return {
        mode: "READ_ONLY",
        reasons: ["QUOTA_INVALID"],
        driveConnection: "CONNECTED",
        drive: null,
        neon: null,
      };
    }
    const [driveResult, neonResult] = await Promise.all([refreshDrive(now), refreshNeon(now)]);
    const reasons = uniqueReasons([
      ...(driveResult.reason === null ? snapshotReasons(driveResult.snapshot, now, dependencies, "DRIVE") : [driveResult.reason]),
      ...(neonResult.reason === null ? snapshotReasons(neonResult.snapshot, now, dependencies, "NEON") : [neonResult.reason]),
    ]);
    const mode: FreeTierHealth["mode"] = reasons.length === 0 ? "READ_WRITE" : "READ_ONLY";
    const drive = driveResult.snapshot === null ? null : {
      ...driveResult.snapshot,
      mode,
      reasonCodes: reasons,
    };
    const neon = neonResult.snapshot === null ? null : {
      ...neonResult.snapshot,
      mode,
      reasonCodes: reasons,
    };
    const saved = await Promise.allSettled([
      ...(drive === null ? [] : [dependencies.repository.saveUsage(drive)]),
      ...(neon === null ? [] : [dependencies.repository.saveUsage(neon)]),
    ]);
    let retainedDrive = drive;
    let retainedNeon = neon;
    let savedIndex = 0;
    if (drive !== null) {
      const result = saved[savedIndex++];
      if (result?.status === "fulfilled" && validSnapshot(result.value, "DRIVE")) {
        retainedDrive = result.value;
      }
    }
    if (neon !== null) {
      const result = saved[savedIndex];
      if (result?.status === "fulfilled" && validSnapshot(result.value, "NEON")) {
        retainedNeon = result.value;
      }
    }
    const retainedReasons = retainedDrive !== null && retainedNeon !== null
      ? uniqueReasons([...retainedDrive.reasonCodes, ...retainedNeon.reasonCodes])
      : reasons;
    const retainedMode: FreeTierHealth["mode"] = (
      retainedDrive?.mode === "READ_ONLY" ||
      retainedNeon?.mode === "READ_ONLY" ||
      retainedReasons.length > 0
    ) ? "READ_ONLY" : "READ_WRITE";
    if ([previousDrive, previousNeon].some((snapshot) => snapshot !== null && snapshot.mode !== retainedMode)) {
      await dependencies.repository.recordAudit({
        eventType: "FREE_TIER_MODE_CHANGED",
        actorClass: "system",
        payload: { mode: retainedMode, reasonCode: retainedReasons[0] ?? null },
      }).catch(() => undefined);
    }
    return {
      mode: retainedMode,
      reasons: retainedReasons,
      driveConnection: driveResult.driveConnection,
      drive: retainedDrive,
      neon: retainedNeon,
    };
  }

  return {
    getHealth,

    async assertUploadAllowed(incomingBytes, now) {
      const health = await getHealth(now);
      if (health.mode === "READ_ONLY") throw decisionError(health.reasons[0] ?? "QUOTA_INVALID");
      const drive = health.drive;
      if (drive === null) throw decisionError("DRIVE_QUOTA_STALE");
      const decision = assessProjectedUpload({
        usedBytes: drive.usedBytes,
        limitBytes: drive.limitBytes,
        incomingBytes,
        observedAt: drive.observedAt,
        now: now.toISOString(),
        staleAfterSeconds: dependencies.staleAfterSeconds,
        softPercent: dependencies.softPercent,
      });
      if (decision.mode === "READ_ONLY") throw decisionError(decision.reasons[0] ?? "QUOTA_INVALID");
    },
  };
}
