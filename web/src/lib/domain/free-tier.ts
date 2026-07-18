export type FreeTierSnapshot = Readonly<{
  neonBytes: number;
  neonLimitBytes: number;
  driveBytes: number;
  driveLimitBytes: number;
  stale: boolean;
}>;

export type FreeTierDecision = Readonly<{
  mode: "READ_WRITE" | "READ_ONLY";
  reasons: readonly string[];
}>;

export function assessFreeTier(value: FreeTierSnapshot): FreeTierDecision {
  const numbers = [value.neonBytes, value.neonLimitBytes, value.driveBytes, value.driveLimitBytes];
  if (
    numbers.some((item) => !Number.isFinite(item) || item < 0) ||
    value.neonLimitBytes === 0 ||
    value.driveLimitBytes === 0
  ) {
    return { mode: "READ_ONLY", reasons: ["QUOTA_INVALID"] };
  }

  const reasons: string[] = [];
  if (value.stale) reasons.push("QUOTA_STALE");
  if (value.neonBytes / value.neonLimitBytes >= 0.9) reasons.push("NEON_STORAGE_HIGH");
  if (value.driveBytes / value.driveLimitBytes >= 0.9) reasons.push("DRIVE_STORAGE_HIGH");

  return { mode: reasons.length === 0 ? "READ_WRITE" : "READ_ONLY", reasons };
}
