export type FreeTierDecision = Readonly<{
  mode: "READ_WRITE" | "READ_ONLY";
  reasons: readonly string[];
}>;

export type ProjectedUpload = Readonly<{
  usedBytes: number;
  limitBytes: number;
  incomingBytes: number;
  observedAt: string;
  now: string;
  staleAfterSeconds: number;
  softPercent: number;
}>;

function parseCanonicalUtcTimestamp(value: string): number | null {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString() === value ? milliseconds : null;
}

export function assessProjectedUpload(value: ProjectedUpload): FreeTierDecision {
  const numbers = [value.usedBytes, value.limitBytes, value.incomingBytes];
  if (
    numbers.some((item) => !Number.isSafeInteger(item) || item < 0) ||
    value.limitBytes === 0 ||
    value.usedBytes > value.limitBytes ||
    !Number.isSafeInteger(value.staleAfterSeconds) || value.staleAfterSeconds < 0 ||
    !Number.isSafeInteger(value.softPercent) || value.softPercent < 1 || value.softPercent > 100
  ) {
    return { mode: "READ_ONLY", reasons: ["QUOTA_INVALID"] };
  }

  const observedAt = parseCanonicalUtcTimestamp(value.observedAt);
  const now = parseCanonicalUtcTimestamp(value.now);
  if (observedAt === null || now === null || observedAt > now || now - observedAt > value.staleAfterSeconds * 1_000) {
    return { mode: "READ_ONLY", reasons: ["DRIVE_QUOTA_STALE"] };
  }

  const projectedBytes = value.usedBytes + value.incomingBytes;
  if (!Number.isSafeInteger(projectedBytes)) {
    return { mode: "READ_ONLY", reasons: ["QUOTA_INVALID"] };
  }
  if (BigInt(projectedBytes) * 100n >= BigInt(value.limitBytes) * BigInt(value.softPercent)) {
    return { mode: "READ_ONLY", reasons: ["DRIVE_STORAGE_HIGH"] };
  }

  return { mode: "READ_WRITE", reasons: [] };
}
