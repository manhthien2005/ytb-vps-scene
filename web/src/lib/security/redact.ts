import "server-only";

const REDACTED = "[REDACTED]";
const UNSERIALIZABLE = "[UNSERIALIZABLE]";
const MAX_DEPTH = 8;
const MAX_STRING_CHARACTERS = 512;
const SENSITIVE_KEY_PARTS = [
  "authorization",
  "cookie",
  "token",
  "code",
  "state",
  "sessionuri",
  "uploadid",
  "clientsecret",
  "encryptionkey",
] as const;
const SENSITIVE_EXACT_KEYS = new Set([
  "email",
  "emailaddress",
  "accountemail",
  "providerbody",
  "rawproviderbody",
  "providerresponse",
  "providerresponsebody",
  "responsebody",
]);
const SENSITIVE_VALUE_PATTERNS = [
  /bearer/i,
  /https:\/\/www\.googleapis\.com\/upload\//i,
  /upload[_-]?id["']?\s*[:=]/i,
  /(?:access|refresh|id)[_-]?token["']?\s*[:=]/i,
  /client[_-]?(?:secret|assertion)["']?\s*[:=]/i,
  /(?:oauth[_-]?token|code(?:[_-]?(?:verifier|challenge))?|state)["']?\s*[:=]/i,
  /[a-z0-9][a-z0-9._%+-]*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/i,
] as const;

function sensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return SENSITIVE_EXACT_KEYS.has(normalized) ||
    SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function redactString(value: string): string {
  if (SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value))) return REDACTED;
  return Array.from(value).slice(0, MAX_STRING_CHARACTERS).join("");
}

function redactValue(value: unknown, depth: number, ancestors: WeakSet<object>): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value !== "object" || depth >= MAX_DEPTH) return UNSERIALIZABLE;

  if (ancestors.has(value)) return UNSERIALIZABLE;
  ancestors.add(value);
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
      return UNSERIALIZABLE;
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      const copy = new Array<unknown>(value.length);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor) continue;
        copy[index] = "value" in descriptor
          ? redactValue(descriptor.value, depth + 1, ancestors)
          : UNSERIALIZABLE;
      }
      return copy;
    }

    const copy: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable) continue;
      let redacted: unknown;
      if (sensitiveKey(key)) {
        redacted = REDACTED;
      } else if ("value" in descriptor) {
        redacted = redactValue(descriptor.value, depth + 1, ancestors);
      } else {
        redacted = UNSERIALIZABLE;
      }
      Object.defineProperty(copy, key, {
        value: redacted,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return copy;
  } catch {
    return UNSERIALIZABLE;
  } finally {
    ancestors.delete(value);
  }
}

export function redactSecrets(value: unknown): unknown {
  return redactValue(value, 0, new WeakSet<object>());
}
