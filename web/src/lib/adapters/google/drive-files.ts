import "server-only";

import { AppError, type PublicCode } from "@/lib/domain/errors";
import type { DriveVideoMetadata, UploadIntent, VerifiedDriveFile } from "@/lib/domain/drive";
import { parseDriveResumableSessionUri } from "@/lib/domain/resumable-session-uri";
import { isCanonicalUploadFileName } from "@/lib/domain/upload-filename";
import type { DriveFilesPort } from "@/lib/ports/drive";
import { outputPartFileName } from "@/lib/domain/output-part";
import { googleJson } from "./http";

export const FILE_FIELDS = "id,name,mimeType,size,parents,trashed,appProperties";
export const VERIFIED_FILE_FIELDS = `${FILE_FIELDS},sha256Checksum`;
export const VIDEO_METADATA_FIELDS = `${FILE_FIELDS},createdTime,modifiedTime,videoMediaMetadata(width,height,durationMillis),webViewLink,webContentLink`;
export const ABOUT_FIELDS = "storageQuota(limit,usage),user(permissionId,emailAddress)";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const DRIVE_RESPONSE_BYTES = 64 * 1_024;
const DRIVE_TIMEOUT_MS = 5_000;
const DRIVE_ATTEMPTS = 3;
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROOT_PROPERTIES = Object.freeze({ ytbVpsRole: "root", schema: "1" });
const INPUT_PROPERTIES = Object.freeze({ ytbVpsRole: "input", schema: "1" });
const OUTPUT_PROPERTIES = Object.freeze({ ytbVpsRole: "output", schema: "1" });

type GoogleDriveFilesOptions = Readonly<{
  fetcher?: typeof fetch;
  now?: () => Date;
}>;

type DriveFile = Readonly<{
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  parentIds: readonly string[];
  trashed: boolean;
  appProperties: Readonly<Record<string, string>>;
}>;

type VideoMediaMetadata = Readonly<{
  width: number | null;
  height: number | null;
  durationMillis: number | null;
}>;

type ExpectedDriveFile = Readonly<{
  name: string;
  mimeType: string;
  parentId: string;
  rootAliasParent?: boolean;
  appProperties: Readonly<Record<string, string>>;
  empty?: boolean;
}>;

function stableError(code: PublicCode, status = 502): AppError {
  return new AppError(code, status);
}

function remoteMismatch(): AppError {
  return new AppError("DRIVE_REMOTE_MISMATCH", 502);
}

function boundedAscii(value: unknown, minimum: number, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum &&
    /^[\x20-\x7E]+$/.test(value)
  );
}

function boundedHeaderToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 8_192 &&
    /^[\x21-\x7E]+$/.test(value)
  );
}

function boundedDriveId(value: unknown): value is string {
  return boundedAscii(value, 1, 256) && !value.includes(" ");
}

function boundedDriveName(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 255 && !/[\u0000-\u001F\u007F]/.test(value);
}

function browserOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 8 || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    const localHttp = url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
    if (
      value !== url.origin ||
      (url.protocol !== "https:" && !localHttp) ||
      url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== ""
    ) return null;
    return value;
  } catch {
    return null;
  }
}

function projectFolderName(projectName: string | undefined, projectId: string): string {
  if (projectName === undefined) return projectId;
  const normalized = projectName.trim().replace(/[\\/]+/g, " - ").replace(/\s+/g, " ").slice(0, 160);
  if (!boundedDriveName(normalized)) throw stableError("DRIVE_PROVIDER_REJECTED");
  return normalized;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).every((key) => keys.includes(key));
}

function parseDriveInteger(value: unknown, minimum: number): number | null {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return null;
  try {
    const parsed = BigInt(value);
    if (parsed < BigInt(minimum) || parsed > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(parsed);
  } catch {
    return null;
  }
}

function parseAppProperties(value: unknown): Readonly<Record<string, string>> | null {
  const record = objectRecord(value);
  if (!record || Object.keys(record).length < 1 || Object.keys(record).length > 16) return null;
  const properties: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (!boundedAscii(key, 1, 124) || !boundedAscii(item, 1, 256)) return null;
    properties[key] = item;
  }
  return properties;
}

function parseDriveFile(value: unknown): DriveFile | null {
  const record = objectRecord(value);
  if (
    !record ||
    !hasOnlyKeys(record, ["id", "name", "mimeType", "size", "parents", "trashed", "appProperties"]) ||
    !boundedDriveId(record.id) ||
    !boundedDriveName(record.name) ||
    !boundedAscii(record.mimeType, 1, 127) ||
    !Array.isArray(record.parents) ||
    record.parents.length !== 1 ||
    !record.parents.every(boundedDriveId) ||
    typeof record.trashed !== "boolean"
  ) {
    return null;
  }
  const appProperties = parseAppProperties(record.appProperties);
  if (!appProperties) return null;
  const sizeBytes = record.size === undefined ? null : parseDriveInteger(record.size, 0);
  if (record.size !== undefined && sizeBytes === null) return null;
  if (record.mimeType !== FOLDER_MIME && sizeBytes === null) return null;
  return {
    id: record.id,
    name: record.name,
    mimeType: record.mimeType,
    sizeBytes,
    parentIds: [...record.parents],
    trashed: record.trashed,
    appProperties,
  };
}

function boundedDriveTimestamp(value: unknown): value is string {
  if (!boundedAscii(value, 20, 64)) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = match
    .slice(1)
    .map((part) => part === undefined ? undefined : Number(part));
  if (
    year === undefined || month === undefined || day === undefined || hour === undefined ||
    minute === undefined || second === undefined ||
    month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 ||
    (offsetHour !== undefined && (offsetHour > 23 || offsetMinute === undefined || offsetMinute > 59))
  ) {
    return false;
  }
  const daysInMonth = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day >= 1 && day <= daysInMonth;
}

function parseVideoMediaMetadata(value: unknown): VideoMediaMetadata | null {
  if (value === undefined) return { width: null, height: null, durationMillis: null };
  const record = objectRecord(value);
  // Drive commonly returns PARTIAL videoMediaMetadata (e.g. dimensions before the
  // duration is extracted, or duration-only for some codecs): each field is
  // independently nullable, and only present-but-invalid values or unknown keys
  // are a remote mismatch.
  if (!record || !hasOnlyKeys(record, ["width", "height", "durationMillis"])) return null;
  const dimension = (item: unknown): number | null | undefined => {
    if (item === undefined) return null;
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0) return undefined;
    return item;
  };
  const width = dimension(record.width);
  const height = dimension(record.height);
  const durationMillis = record.durationMillis === undefined
    ? null
    : parseDriveInteger(record.durationMillis, 0);
  if (width === undefined || height === undefined || (durationMillis === null && record.durationMillis !== undefined)) {
    return null;
  }
  return { width, height, durationMillis };
}

function parseDriveBrowserLink(value: unknown): string | null | undefined {
  if (value === undefined) return null;
  if (!boundedAscii(value, 8, 2_048)) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      (url.hostname !== "drive.google.com" && url.hostname !== "drive.usercontent.google.com") ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function parseDriveVideoMetadata(value: unknown): DriveVideoMetadata | null {
  const record = objectRecord(value);
  if (
    !record ||
    !hasOnlyKeys(record, [
      "id", "name", "mimeType", "size", "parents", "trashed", "appProperties",
      "createdTime", "modifiedTime", "videoMediaMetadata", "webViewLink", "webContentLink",
    ])
  ) {
    return null;
  }
  const file = parseDriveFile({
    id: record.id,
    name: record.name,
    mimeType: record.mimeType,
    size: record.size,
    parents: record.parents,
    trashed: record.trashed,
    appProperties: record.appProperties,
  });
  if (
    !file || file.sizeBytes === null ||
    !boundedDriveTimestamp(record.createdTime) || !boundedDriveTimestamp(record.modifiedTime)
  ) {
    return null;
  }
  const media = parseVideoMediaMetadata(record.videoMediaMetadata);
  const webViewLink = parseDriveBrowserLink(record.webViewLink);
  const webContentLink = parseDriveBrowserLink(record.webContentLink);
  if (!media || webViewLink === undefined || webContentLink === undefined) return null;
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    parentIds: file.parentIds,
    createdTime: record.createdTime,
    modifiedTime: record.modifiedTime,
    ...media,
    webViewLink,
    webContentLink,
    appProperties: file.appProperties,
  };
}

function sameProperties(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index] && actual[key] === expected[key])
  );
}

function validateExpectedFile(
  value: unknown,
  expected: ExpectedDriveFile,
): DriveFile {
  const file = parseDriveFile(value);
  if (
    !file ||
    file.name !== expected.name ||
    file.mimeType !== expected.mimeType ||
    (!expected.rootAliasParent && file.parentIds[0] !== expected.parentId) ||
    file.trashed ||
    !sameProperties(file.appProperties, expected.appProperties) ||
    (expected.empty === true && file.sizeBytes !== 0)
  ) {
    throw remoteMismatch();
  }
  return file;
}

function parseList(value: unknown): readonly unknown[] {
  const record = objectRecord(value);
  if (
    !record || !hasOnlyKeys(record, ["files", "nextPageToken"]) ||
    // The invariant is simply: any pagination token (i.e. any 17th result) is a
    // remote mismatch — the earlier >17/boundedAscii clauses were dead weight.
    !Array.isArray(record.files) || record.files.length > 16 ||
    record.nextPageToken !== undefined
  ) {
    throw remoteMismatch();
  }
  return record.files;
}

function escapeQueryValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function queryFor(parentId: string, appProperties: Readonly<Record<string, string>>): string {
  const clauses = [
    "trashed = false",
    `'${escapeQueryValue(parentId)}' in parents`,
    ...Object.entries(appProperties).map(
      ([key, value]) => `appProperties has { key='${escapeQueryValue(key)}' and value='${escapeQueryValue(value)}' }`,
    ),
  ];
  return clauses.join(" and ");
}

function projectProperties(projectId: string, role: string): Readonly<Record<string, string>> {
  return { ytbVpsProjectId: projectId, ytbVpsRole: role, schema: "1" };
}

function sourceProperties(projectId: string, artifactId: string): Readonly<Record<string, string>> {
  return {
    ytbVpsProjectId: projectId,
    ytbVpsArtifactId: artifactId,
    ytbVpsRole: "source",
    schema: "1",
  };
}

function outputProperties(
  projectId: string,
  jobId: string,
  artifactId: string,
  partIndex: number,
  partCount: number,
): Readonly<Record<string, string>> {
  return {
    ytbVpsProjectId: projectId,
    ytbVpsArtifactId: artifactId,
    ytbVpsJobId: jobId,
    ytbVpsPartIndex: String(partIndex),
    ytbVpsPartCount: String(partCount),
    ytbVpsRole: "output",
    schema: "1",
  };
}

function headers(accessToken: string, json = false): HeadersInit {
  if (!boundedHeaderToken(accessToken)) throw stableError("DRIVE_REAUTH_REQUIRED", 401);
  return {
    authorization: `Bearer ${accessToken}`,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

function driveUrl(path: string, params: Readonly<Record<string, string>> = {}): string {
  const url = new URL(`${DRIVE_API}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function validateProjectId(value: string): void {
  if (!UUID_PATTERN.test(value)) throw stableError("DRIVE_PROVIDER_REJECTED");
}

function validUploadIntent(input: UploadIntent): boolean {
  const mimeByExtension: Readonly<Record<string, string>> = {
    mp4: "video/mp4",
    mov: "video/quicktime",
    mkv: "video/x-matroska",
    webm: "video/webm",
  };
  return (
    isCanonicalUploadFileName(input.fileName) &&
    mimeByExtension[input.normalizedExtension] === input.mimeType &&
    Number.isSafeInteger(input.sizeBytes) &&
    input.sizeBytes >= 1 &&
    Number.isSafeInteger(input.lastModified) &&
    input.lastModified >= 0
  );
}

async function readAndDiscardBounded(response: Response): Promise<void> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > DRIVE_RESPONSE_BYTES)) {
    try {
      await response.body?.cancel();
    } catch {
      // Cancellation is best-effort; provider details must never escape.
    }
    throw stableError("DRIVE_PROVIDER_REJECTED");
  }
  const reader = response.body?.getReader();
  if (!reader) return;
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) return;
      size += part.value.byteLength;
      if (size > DRIVE_RESPONSE_BYTES) {
        await reader.cancel();
        throw stableError("DRIVE_PROVIDER_REJECTED");
      }
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    try {
      await reader.cancel();
    } catch {
      // Cancellation is best-effort; provider details must never escape.
    }
    // Rethrow unwrapped so the caller's attempt loop treats mid-body transport
    // failures as retryable, mirroring readBoundedBytes in http.ts.
    throw error;
  }
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best-effort; deterministic status mapping takes priority.
  }
}

function validateSessionUri(value: string | null): string {
  const parsed = parseDriveResumableSessionUri(value);
  if (parsed === null) {
    let hostAllowed = false;
    let pathAllowed = false;
    let queryKeys: string[] = [];
    let uploadIdCount = 0;
    let uploadIdLength = 0;
    let uploadIdTokenSafe = false;
    try {
      const uri = new URL(value ?? "");
      const pathPrefix = "/upload/drive/v3/files/";
      hostAllowed = uri.protocol === "https:" &&
        uri.hostname === "www.googleapis.com" &&
        uri.port === "" && uri.username === "" && uri.password === "" && uri.hash === "";
      const fileSegment = uri.pathname.slice(pathPrefix.length);
      pathAllowed = uri.pathname.startsWith(pathPrefix) &&
        boundedAscii(fileSegment, 1, 512) && /^[A-Za-z0-9._~-]+$/.test(fileSegment);
      queryKeys = [...new Set([...uri.searchParams.keys()].slice(0, 8).map((key) => (
        /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) ? key : "[unsafe]"
      )))].sort();
      const uploadIds = uri.searchParams.getAll("upload_id");
      uploadIdCount = uploadIds.length;
      uploadIdLength = uploadIds[0]?.length ?? 0;
      uploadIdTokenSafe = uploadIds.length === 1 &&
        boundedAscii(uploadIds[0], 1, 2_048) &&
        /^[A-Za-z0-9._~-]+$/.test(uploadIds[0]);
    } catch {
      // The bounded structural summary remains false/empty for malformed URLs.
    }
    console.error("[drive-upload] session-location-rejected", {
      stage: "provider-location",
      hostAllowed,
      pathAllowed,
      queryKeys,
      uploadIdCount,
      uploadIdLength,
      uploadIdTokenSafe,
    });
    throw stableError("DRIVE_PROVIDER_REJECTED");
  }
  return parsed;
}

export function createGoogleDriveFilesAdapter(options: GoogleDriveFilesOptions = {}): DriveFilesPort {
  if (
    (options.fetcher !== undefined && typeof options.fetcher !== "function") ||
    (options.now !== undefined && typeof options.now !== "function")
  ) {
    throw stableError("DRIVE_PROVIDER_REJECTED");
  }
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? (() => new Date());

  async function driveJson<T>(
    accessToken: string,
    url: string,
    init: RequestInit = {},
    attempts = DRIVE_ATTEMPTS,
    notFoundCode?: "DRIVE_FILE_NOT_FOUND",
  ): Promise<T> {
    return googleJson(fetcher, url, {
      ...init,
      headers: { ...headers(accessToken), ...init.headers },
    }, {
      timeoutMs: DRIVE_TIMEOUT_MS,
      maxResponseBytes: DRIVE_RESPONSE_BYTES,
      attempts,
      ...(notFoundCode === undefined ? {} : { notFoundCode }),
    });
  }

  async function listExpected(
    accessToken: string,
    expected: ExpectedDriveFile,
  ): Promise<DriveFile | null> {
    const url = driveUrl("/files", {
      q: queryFor(expected.parentId, expected.appProperties),
      spaces: "drive",
      pageSize: "17",
      fields: `nextPageToken,files(${FILE_FIELDS})`,
    });
    const results = parseList(await driveJson(accessToken, url, { method: "GET" }));
    if (results.length === 0) return null;
    return results
      .map((result) => validateExpectedFile(result, expected))
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)[0]!;
  }

  async function createExpected(
    accessToken: string,
    expected: ExpectedDriveFile,
  ): Promise<DriveFile> {
    const value = await driveJson(
      accessToken,
      driveUrl("/files", { fields: FILE_FIELDS }),
      {
        method: "POST",
        headers: headers(accessToken, true),
        body: JSON.stringify({
          name: expected.name,
          mimeType: expected.mimeType,
          parents: [expected.parentId],
          appProperties: expected.appProperties,
        }),
      },
      1,
    );
    return validateExpectedFile(value, expected);
  }

  async function ensureExpected(
    accessToken: string,
    expected: ExpectedDriveFile,
  ): Promise<DriveFile> {
    const existing = await listExpected(accessToken, expected);
    if (existing) return existing;
    try {
      return await createExpected(accessToken, expected);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      const reconciled = await listExpected(accessToken, expected);
      if (reconciled) return reconciled;
      throw error;
    }
  }

  async function ensureRoot(accessToken: string): Promise<DriveFile> {
    return ensureExpected(accessToken, {
      name: "YTB-VPS",
      mimeType: FOLDER_MIME,
      parentId: "root",
      rootAliasParent: true,
      appProperties: ROOT_PROPERTIES,
    });
  }

  return {
    async inspectAccount(accessToken) {
      const value = await driveJson<unknown>(
        accessToken,
        driveUrl("/about", { fields: ABOUT_FIELDS }),
        { method: "GET" },
      );
      const record = objectRecord(value);
      if (!record || !hasExactKeys(record, ["storageQuota", "user"])) {
        throw stableError("DRIVE_PROVIDER_REJECTED");
      }
      const quota = objectRecord(record.storageQuota);
      const user = objectRecord(record.user);
      if (
        !quota ||
        !hasExactKeys(quota, ["limit", "usage"]) ||
        !user ||
        !hasExactKeys(user, ["emailAddress", "permissionId"]) ||
        !boundedDriveId(user.permissionId) ||
        !boundedAscii(user.emailAddress, 3, 254)
      ) {
        throw stableError("DRIVE_PROVIDER_REJECTED");
      }
      const limitBytes = parseDriveInteger(quota.limit, 1);
      const usedBytes = parseDriveInteger(quota.usage, 0);
      const parts = user.emailAddress.split("@");
      if (
        limitBytes === null ||
        usedBytes === null ||
        usedBytes > limitBytes ||
        parts.length !== 2 ||
        !parts[0] ||
        !parts[1]
      ) {
        throw stableError("DRIVE_PROVIDER_REJECTED");
      }
      return {
        permissionId: user.permissionId,
        accountHint: `${parts[0][0]}***@${parts[1]}`,
        usedBytes,
        limitBytes,
      };
    },

    async ensureWorkspace(accessToken) {
      const root = await ensureRoot(accessToken);
      return { rootFolderId: root.id };
    },

    async ensureProjectFolders(accessToken, projectId, projectName) {
      validateProjectId(projectId);
      const filmName = projectFolderName(projectName, projectId);
      const root = await ensureRoot(accessToken);
      const input = await ensureExpected(accessToken, {
        name: "input",
        mimeType: FOLDER_MIME,
        parentId: root.id,
        appProperties: INPUT_PROPERTIES,
      });
      const projectInput = await ensureExpected(accessToken, {
        name: filmName,
        mimeType: FOLDER_MIME,
        parentId: input.id,
        appProperties: projectProperties(projectId, "input"),
      });
      const output = await ensureExpected(accessToken, {
        name: "output",
        mimeType: FOLDER_MIME,
        parentId: root.id,
        appProperties: OUTPUT_PROPERTIES,
      });
      const film = await ensureExpected(accessToken, {
        name: filmName,
        mimeType: FOLDER_MIME,
        parentId: output.id,
        appProperties: projectProperties(projectId, "film"),
      });
      return { projectFolderId: film.id, inputFolderId: projectInput.id };
    },

    async ensureSourceFile(accessToken, input) {
      validateProjectId(input.projectId);
      validateProjectId(input.artifactId);
      if (!boundedDriveId(input.parentId) || !validUploadIntent(input)) {
        throw stableError("DRIVE_PROVIDER_REJECTED");
      }
      const source = await ensureExpected(accessToken, {
        name: input.fileName,
        mimeType: input.mimeType,
        parentId: input.parentId,
        appProperties: sourceProperties(input.projectId, input.artifactId),
        empty: true,
      });
      return source.id;
    },

    async ensureOutputFile(accessToken, input) {
      validateProjectId(input.projectId);
      validateProjectId(input.jobId);
      validateProjectId(input.artifactId);
      if (!boundedDriveId(input.parentId)) throw stableError("DRIVE_PROVIDER_REJECTED");
      let name: string;
      try {
        name = outputPartFileName(input.partIndex, input.partCount);
      } catch {
        throw stableError("DRIVE_PROVIDER_REJECTED");
      }
      const output = await ensureExpected(accessToken, {
        name,
        mimeType: "video/mp4",
        parentId: input.parentId,
        appProperties: outputProperties(
          input.projectId,
          input.jobId,
          input.artifactId,
          input.partIndex,
          input.partCount,
        ),
        empty: true,
      });
      return output.id;
    },

    async createResumableUpdateSession(accessToken, input) {
      const origin = input.origin === undefined ? null : browserOrigin(input.origin);
      if (
        !boundedDriveId(input.fileId) ||
        !boundedAscii(input.mimeType, 1, 127) ||
        Number.isSafeInteger(input.sizeBytes) === false ||
        input.sizeBytes < 1 ||
        (input.origin !== undefined && origin === null)
      ) {
        throw stableError("DRIVE_PROVIDER_REJECTED");
      }
      let lastCode: "DRIVE_RATE_LIMITED" | "DRIVE_TEMPORARILY_UNAVAILABLE" =
        "DRIVE_TEMPORARILY_UNAVAILABLE";
      for (let attempt = 0; attempt < DRIVE_ATTEMPTS; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DRIVE_TIMEOUT_MS);
        try {
          const url = new URL(`${DRIVE_UPLOAD_API}/files/${encodeURIComponent(input.fileId)}`);
          url.searchParams.set("uploadType", "resumable");
          const response = await fetcher(url.toString(), {
            method: "PATCH",
            headers: {
              ...headers(accessToken),
              "content-length": "0",
              ...(origin === null ? {} : { origin }),
              "x-upload-content-length": String(input.sizeBytes),
              "x-upload-content-type": input.mimeType,
            },
            signal: controller.signal,
          });
          if (response.status === 401) {
            await cancelResponse(response);
            throw stableError("DRIVE_REAUTH_REQUIRED", 401);
          }
          if (response.status === 429 || response.status >= 500) {
            lastCode = response.status === 429 ? "DRIVE_RATE_LIMITED" : "DRIVE_TEMPORARILY_UNAVAILABLE";
            await cancelResponse(response);
            continue;
          }
          await readAndDiscardBounded(response);
          if (!response.ok) {
            console.error("[drive-upload] session-init-rejected", {
              stage: "provider-response",
              status: response.status,
            });
            throw stableError("DRIVE_PROVIDER_REJECTED");
          }
          const sessionUri = validateSessionUri(response.headers.get("location"));
          const issuedAt = now();
          if (!Number.isFinite(issuedAt.getTime())) throw stableError("DRIVE_PROVIDER_REJECTED");
          return {
            sessionUri,
            expiresAt: new Date(issuedAt.getTime() + SESSION_LIFETIME_MS).toISOString(),
          };
        } catch (error) {
          if (error instanceof AppError) throw error;
          lastCode = "DRIVE_TEMPORARILY_UNAVAILABLE";
        } finally {
          clearTimeout(timer);
        }
      }
      throw stableError(lastCode, lastCode === "DRIVE_RATE_LIMITED" ? 429 : 503);
    },

    async inspectFile(accessToken, fileId): Promise<VerifiedDriveFile> {
      if (!boundedDriveId(fileId)) throw stableError("DRIVE_PROVIDER_REJECTED");
      const value = await driveJson<unknown>(
        accessToken,
        driveUrl(`/files/${encodeURIComponent(fileId)}`, { fields: VERIFIED_FILE_FIELDS }),
        { method: "GET" },
      );
      const record = objectRecord(value);
      if (!record) throw remoteMismatch();
      const { sha256Checksum, ...rest } = record;
      const file = parseDriveFile(rest);
      if (!file || file.sizeBytes === null) throw remoteMismatch();
      // Drive omits the digest until it has hashed the stored bytes, and never
      // supplies one for folders. Absent is normal; malformed is a mismatch.
      if (sha256Checksum !== undefined && !(typeof sha256Checksum === "string" && /^[0-9a-f]{64}$/.test(sha256Checksum))) {
        throw remoteMismatch();
      }
      return {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        parentIds: file.parentIds,
        trashed: file.trashed,
        appProperties: file.appProperties,
        sha256Checksum: sha256Checksum === undefined ? null : sha256Checksum as string,
      };
    },

    async inspectVideoMetadata(accessToken, fileId): Promise<DriveVideoMetadata> {
      if (!boundedDriveId(fileId)) throw stableError("DRIVE_PROVIDER_REJECTED");
      const metadata = parseDriveVideoMetadata(await driveJson(
        accessToken,
        driveUrl(`/files/${encodeURIComponent(fileId)}`, { fields: VIDEO_METADATA_FIELDS }),
        { method: "GET" },
        DRIVE_ATTEMPTS,
        "DRIVE_FILE_NOT_FOUND",
      ));
      if (!metadata) throw remoteMismatch();
      return metadata;
    },

    async deleteFile(accessToken, fileId) {
      if (!boundedDriveId(fileId)) throw stableError("DRIVE_PROVIDER_REJECTED");
      let lastCode: "DRIVE_RATE_LIMITED" | "DRIVE_TEMPORARILY_UNAVAILABLE" =
        "DRIVE_TEMPORARILY_UNAVAILABLE";
      for (let attempt = 0; attempt < DRIVE_ATTEMPTS; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DRIVE_TIMEOUT_MS);
        try {
          const response = await fetcher(
            driveUrl(`/files/${encodeURIComponent(fileId)}`),
            { method: "DELETE", headers: headers(accessToken), signal: controller.signal },
          );
          if (response.status === 401) {
            await cancelResponse(response);
            throw stableError("DRIVE_REAUTH_REQUIRED", 401);
          }
          if (response.status === 429 || response.status >= 500) {
            lastCode = response.status === 429 ? "DRIVE_RATE_LIMITED" : "DRIVE_TEMPORARILY_UNAVAILABLE";
            await cancelResponse(response);
            continue;
          }
          if (response.status === 404) {
            await cancelResponse(response);
            return;
          }
          await readAndDiscardBounded(response);
          if (!response.ok) throw stableError("DRIVE_PROVIDER_REJECTED");
          return;
        } catch (error) {
          if (error instanceof AppError) throw error;
          lastCode = "DRIVE_TEMPORARILY_UNAVAILABLE";
        } finally {
          clearTimeout(timer);
        }
      }
      throw stableError(lastCode, lastCode === "DRIVE_RATE_LIMITED" ? 429 : 503);
    },
  };
}
