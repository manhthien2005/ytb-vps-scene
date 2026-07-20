import "server-only";

import { AppError, type PublicCode } from "@/lib/domain/errors";
import type { UploadIntent, VerifiedDriveFile } from "@/lib/domain/drive";
import { parseDriveResumableSessionUri } from "@/lib/domain/resumable-session-uri";
import { isCanonicalUploadFileName } from "@/lib/domain/upload-filename";
import type { DriveFilesPort } from "@/lib/ports/drive";
import { outputPartFileName } from "@/lib/domain/output-part";
import { googleJson } from "./http";

export const FILE_FIELDS = "id,name,mimeType,size,parents,trashed,appProperties";
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
    !Array.isArray(record.files) || record.files.length > 17 ||
    (record.nextPageToken !== undefined && !boundedAscii(record.nextPageToken, 1, 2_048)) ||
    record.nextPageToken !== undefined || record.files.length > 16
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
): Readonly<Record<string, string>> {
  return {
    ytbVpsProjectId: projectId,
    ytbVpsArtifactId: artifactId,
    ytbVpsJobId: jobId,
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
    throw stableError("DRIVE_PROVIDER_REJECTED");
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
  if (parsed === null) throw stableError("DRIVE_PROVIDER_REJECTED");
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
  ): Promise<T> {
    return googleJson(fetcher, url, {
      ...init,
      headers: { ...headers(accessToken), ...init.headers },
    }, {
      timeoutMs: DRIVE_TIMEOUT_MS,
      maxResponseBytes: DRIVE_RESPONSE_BYTES,
      attempts,
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
      return { projectFolderId: film.id, inputFolderId: input.id };
    },

    async ensureSourceFile(accessToken, input) {
      validateProjectId(input.projectId);
      validateProjectId(input.artifactId);
      if (!boundedDriveId(input.parentId) || !validUploadIntent(input)) {
        throw stableError("DRIVE_PROVIDER_REJECTED");
      }
      const source = await ensureExpected(accessToken, {
        name: `source.${input.normalizedExtension}`,
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
      const output = await ensureExpected(accessToken, {
        name: outputPartFileName(1, 1),
        mimeType: "video/mp4",
        parentId: input.parentId,
        appProperties: outputProperties(input.projectId, input.jobId, input.artifactId),
        empty: true,
      });
      return output.id;
    },

    async createResumableUpdateSession(accessToken, input) {
      if (
        !boundedDriveId(input.fileId) ||
        !boundedAscii(input.mimeType, 1, 127) ||
        Number.isSafeInteger(input.sizeBytes) === false ||
        input.sizeBytes < 1
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
            console.warn("[drive-upload] session-init-rejected", {
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
      const file = parseDriveFile(await driveJson(
        accessToken,
        driveUrl(`/files/${encodeURIComponent(fileId)}`, { fields: FILE_FIELDS }),
        { method: "GET" },
      ));
      if (!file || file.sizeBytes === null) throw remoteMismatch();
      return {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        parentIds: file.parentIds,
        trashed: file.trashed,
        appProperties: file.appProperties,
      };
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
