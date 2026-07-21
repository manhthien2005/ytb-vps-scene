const UNSAFE_UNICODE = /[\p{Cc}\p{Cf}]/u;
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "mkv", "webm"]);
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  webm: "video/webm",
};

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

export function videoTitleFromFileName(value: unknown): string | null {
  const canonical = canonicalUploadFileName(value);
  if (canonical === null) return null;
  const dot = canonical.lastIndexOf(".");
  if (dot < 1 || !VIDEO_EXTENSIONS.has(canonical.slice(dot + 1).toLowerCase())) return null;
  const title = canonical.slice(0, dot).trim().slice(0, 160);
  return title.length === 0 ? null : title;
}

export function uploadMimeTypeForFileName(value: unknown): string | null {
  const canonical = canonicalUploadFileName(value);
  if (canonical === null) return null;
  const dot = canonical.lastIndexOf(".");
  if (dot < 1) return null;
  return MIME_BY_EXTENSION[canonical.slice(dot + 1).toLowerCase()] ?? null;
}
