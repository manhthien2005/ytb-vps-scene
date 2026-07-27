// Shared row-parsing primitives used by the Neon repository implementations.
// Moved verbatim out of neon-drive-control-plane.ts (Task 8 review, Finding 1)
// to stop two copies of the same security-relevant parsing logic — canonical
// base64url validation and byte-length checks — from drifting apart. This is
// a pure move: behavior must stay byte-identical to the pre-move copies.

export function fail(kind: string): never {
  throw new Error(`Invalid ${kind} row returned by database`);
}

export function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === "string" && values.some((candidate) => candidate === value);
}

export function boundedText(value: unknown, minimum: number, maximum: number, trimmed = false): string | null {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) return null;
  if (trimmed && value.trim() !== value) return null;
  return value;
}

export function nullableBoundedText(value: unknown, minimum: number, maximum: number): string | null | undefined {
  if (value === null) return null;
  return boundedText(value, minimum, maximum) ?? undefined;
}

export function isoDate(value: unknown): string | null {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

export function safeInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number | null {
  let numeric: number;
  if (typeof value === "bigint") {
    if (value < BigInt(minimum) || value > BigInt(maximum)) return null;
    numeric = Number(value);
  } else if (typeof value === "number") {
    numeric = value;
  } else if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
    numeric = Number(value);
  } else {
    return null;
  }
  return Number.isSafeInteger(numeric) && numeric >= minimum && numeric <= maximum ? numeric : null;
}

export function bytes(value: unknown, expectedLength?: number): Buffer | null {
  let parsed: Buffer;
  if (value instanceof Uint8Array) {
    parsed = Buffer.from(value);
  } else if (typeof value === "string" && /^\\x(?:[0-9a-f]{2})*$/i.test(value)) {
    parsed = Buffer.from(value.slice(2), "hex");
  } else {
    return null;
  }
  return expectedLength === undefined || parsed.length === expectedLength ? parsed : null;
}

export function canonicalBase64url(value: unknown, expectedLength?: number, allowEmpty = false): Buffer | null {
  if (
    typeof value !== "string" || (!allowEmpty && value.length === 0) ||
    (value.length > 0 && !/^[A-Za-z0-9_-]+$/.test(value))
  ) return null;
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) return null;
  return expectedLength === undefined || decoded.length === expectedLength ? decoded : null;
}
