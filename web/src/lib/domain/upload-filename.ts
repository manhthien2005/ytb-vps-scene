const UNSAFE_UNICODE = /[\p{Cc}\p{Cf}]/u;

export function canonicalUploadFileName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const canonical = value.trim().normalize("NFC");
  if (
    canonical.length < 1 ||
    canonical.length > 255 ||
    canonical === "." ||
    canonical === ".." ||
    canonical.includes("/") ||
    canonical.includes("\\") ||
    UNSAFE_UNICODE.test(canonical)
  ) {
    return null;
  }
  return canonical;
}

export function isCanonicalUploadFileName(value: unknown): value is string {
  return typeof value === "string" && canonicalUploadFileName(value) === value;
}
