import { isDriveResumableSessionUri } from "../domain/resumable-session-uri";
import { isCanonicalUploadFileName, uploadMimeTypeForFileName } from "../domain/upload-filename";

const DATABASE_NAME = "ytb-vps-upload-v1";
const DATABASE_VERSION = 1;
const OBJECT_STORE = "sessions";
const CHUNK_BYTES = 8_388_608;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type StoredUploadSession = Readonly<{
  projectId: string;
  artifactId: string;
  sessionUri: string;
  fileIdentity: Readonly<{
    displayName: string;
    sizeBytes: number;
    mimeType: string;
    lastModified: number;
  }>;
  nextOffset: number;
  chunkBytes: 8_388_608;
  expiresAt: string;
}>;

export interface UploadSessionStore {
  get(projectId: string, artifactId: string): Promise<StoredUploadSession | null>;
  put(value: StoredUploadSession): Promise<void>;
  delete(projectId: string, artifactId: string): Promise<void>;
  list(): Promise<readonly StoredUploadSession[]>;
}

type UploadSessionStoreOptions = Readonly<{
  indexedDB?: IDBFactory;
  now?: () => Date;
}>;

type StoredRow = StoredUploadSession & Readonly<{ key: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function safeIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function validFileIdentity(value: unknown): value is StoredUploadSession["fileIdentity"] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["displayName", "sizeBytes", "mimeType", "lastModified"]) ||
    !isCanonicalUploadFileName(value.displayName) ||
    !safeIntegerInRange(value.sizeBytes, 1, Number.MAX_SAFE_INTEGER) ||
    !safeIntegerInRange(value.lastModified, 0, Number.MAX_SAFE_INTEGER)
  ) {
    return false;
  }

  // Single source of truth for the extension/MIME contract lives in the domain;
  // a local copy here silently deleted users' sessions whenever the two drifted.
  const expectedMime = uploadMimeTypeForFileName(value.displayName);
  return expectedMime !== null && expectedMime === value.mimeType;
}

function validExpiration(value: unknown, now: Date): value is string {
  if (typeof value !== "string" || value.length !== 24) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value && parsed.getTime() > now.getTime();
}

function sessionKey(projectId: string, artifactId: string): string {
  return `${projectId}:${artifactId}`;
}

function validIdentifiers(projectId: unknown, artifactId: unknown): boolean {
  return canonicalUuid(projectId) && canonicalUuid(artifactId);
}

function parseStoredRow(value: unknown, now: Date): StoredUploadSession | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "key", "projectId", "artifactId", "sessionUri", "fileIdentity", "nextOffset", "chunkBytes", "expiresAt",
    ]) ||
    !canonicalUuid(value.projectId) ||
    !canonicalUuid(value.artifactId) ||
    value.key !== sessionKey(value.projectId, value.artifactId) ||
    !isDriveResumableSessionUri(value.sessionUri) ||
    !validFileIdentity(value.fileIdentity) ||
    !safeIntegerInRange(value.nextOffset, 0, value.fileIdentity.sizeBytes) ||
    value.chunkBytes !== CHUNK_BYTES ||
    !validExpiration(value.expiresAt, now)
  ) {
    return null;
  }

  return {
    projectId: value.projectId,
    artifactId: value.artifactId,
    sessionUri: value.sessionUri,
    fileIdentity: {
      displayName: value.fileIdentity.displayName,
      sizeBytes: value.fileIdentity.sizeBytes,
      mimeType: value.fileIdentity.mimeType,
      lastModified: value.fileIdentity.lastModified,
    },
    nextOffset: value.nextOffset,
    chunkBytes: CHUNK_BYTES,
    expiresAt: value.expiresAt,
  };
}

function validUploadSession(value: unknown, now: Date): value is StoredUploadSession {
  if (!isRecord(value) || !hasExactKeys(value, [
    "projectId", "artifactId", "sessionUri", "fileIdentity", "nextOffset", "chunkBytes", "expiresAt",
  ])) {
    return false;
  }
  return parseStoredRow({ key: sessionKey(value.projectId as string, value.artifactId as string), ...value }, now) !== null;
}

function request<T>(requestValue: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    requestValue.onsuccess = () => resolve(requestValue.result);
    requestValue.onerror = () => reject(requestValue.error ?? new Error("IndexedDB request failed"));
  });
}

function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = factory.open(DATABASE_NAME, DATABASE_VERSION);
    opening.onupgradeneeded = () => {
      if (!opening.result.objectStoreNames.contains(OBJECT_STORE)) {
        opening.result.createObjectStore(OBJECT_STORE, { keyPath: "key" });
      }
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error ?? new Error("Unable to open upload session storage"));
  });
}

export function createUploadSessionStore(options: UploadSessionStoreOptions = {}): UploadSessionStore {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  const now = options.now ?? (() => new Date());

  if (!factory || typeof factory.open !== "function" || typeof now !== "function") {
    throw new Error("IndexedDB upload session storage is unavailable");
  }

  async function database(): Promise<IDBDatabase> {
    return openDatabase(factory);
  }

  return {
    async get(projectId, artifactId) {
      if (!validIdentifiers(projectId, artifactId)) throw new Error("Invalid upload session identifier");
      const connection = await database();
      try {
        const transaction = connection.transaction(OBJECT_STORE, "readwrite");
        const objectStore = transaction.objectStore(OBJECT_STORE);
        const key = sessionKey(projectId, artifactId);
        const row = await request(objectStore.get(key));
        const parsed = row === undefined ? null : parseStoredRow(row, now());
        if (row !== undefined && parsed === null) objectStore.delete(key);
        await complete(transaction);
        return parsed;
      } finally {
        connection.close();
      }
    },

    async put(value) {
      if (!validUploadSession(value, now())) throw new Error("Invalid upload session record");
      const connection = await database();
      try {
        const transaction = connection.transaction(OBJECT_STORE, "readwrite");
        const row: StoredRow = { key: sessionKey(value.projectId, value.artifactId), ...value };
        transaction.objectStore(OBJECT_STORE).put(row);
        await complete(transaction);
      } finally {
        connection.close();
      }
    },

    async delete(projectId, artifactId) {
      if (!validIdentifiers(projectId, artifactId)) throw new Error("Invalid upload session identifier");
      const connection = await database();
      try {
        const transaction = connection.transaction(OBJECT_STORE, "readwrite");
        transaction.objectStore(OBJECT_STORE).delete(sessionKey(projectId, artifactId));
        await complete(transaction);
      } finally {
        connection.close();
      }
    },

    async list() {
      const connection = await database();
      try {
        const transaction = connection.transaction(OBJECT_STORE, "readwrite");
        const objectStore = transaction.objectStore(OBJECT_STORE);
        const rows = await request(objectStore.getAll());
        const values: StoredUploadSession[] = [];
        for (const row of rows) {
          const parsed = parseStoredRow(row, now());
          if (parsed === null) {
            if (isRecord(row) && "key" in row) objectStore.delete(row.key as IDBValidKey);
            continue;
          }
          values.push(parsed);
        }
        await complete(transaction);
        return values;
      } finally {
        connection.close();
      }
    },
  };
}
