import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createUploadSessionStore,
  type StoredUploadSession,
  type UploadSessionStore,
} from "./upload-store";

const PROJECT_ID = "a0000000-0000-4000-8000-000000000001";
const ARTIFACT_ID = "b0000000-0000-4000-8000-000000000002";
const DB_NAME = "ytb-vps-upload-v1";
const EXPIRES_AT = "2026-07-26T00:00:00.000Z";
const NOW = new Date("2026-07-19T00:00:00.000Z");

function record(overrides: Partial<StoredUploadSession> = {}): StoredUploadSession {
  return {
    projectId: PROJECT_ID,
    artifactId: ARTIFACT_ID,
    sessionUri: "https://www.googleapis.com/upload/drive/v3/files/source-file?upload_id=opaque-capability",
    fileIdentity: {
      displayName: "private-source.mp4",
      sizeBytes: 16_777_216,
      mimeType: "video/mp4",
      lastModified: 1_752_883_200_000,
    },
    nextOffset: 8_388_608,
    chunkBytes: 8_388_608,
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

describe("UploadSessionStore", () => {
  let factory: IDBFactory;
  let store: UploadSessionStore;

  beforeEach(() => {
    factory = new IDBFactory();
    store = createUploadSessionStore({ indexedDB: factory, now: () => NOW });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function rawPut(value: unknown): Promise<void> {
    const database = await openDatabase(factory);
    await request(database.transaction("sessions", "readwrite").objectStore("sessions").put(value));
    database.close();
  }

  async function rawRows(): Promise<readonly unknown[]> {
    const database = await openDatabase(factory);
    const rows = await request(database.transaction("sessions", "readonly").objectStore("sessions").getAll());
    database.close();
    return rows;
  }

  it("round-trips only the bounded capability record", async () => {
    const value = record();

    await store.put(value);

    await expect(store.get(value.projectId, value.artifactId)).resolves.toEqual(value);
    const stored = (await store.list())[0];
    expect(stored).toEqual(value);
    expect(Object.keys(stored!)).toEqual([
      "projectId", "artifactId", "sessionUri", "fileIdentity",
      "nextOffset", "chunkBytes", "expiresAt",
    ]);
    expect(Object.keys(stored!.fileIdentity)).toEqual([
      "displayName", "sizeBytes", "mimeType", "lastModified",
    ]);
  });

  it("uses the version-one internal key without an index over the capability", async () => {
    await store.put(record());
    const database = await openDatabase(factory);
    const objectStore = database.transaction("sessions", "readonly").objectStore("sessions");

    expect(database.name).toBe(DB_NAME);
    expect(database.version).toBe(1);
    expect(objectStore.keyPath).toBe("key");
    expect([...objectStore.indexNames]).toEqual([]);
    database.close();
  });

  it("does not access localStorage", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");

    await store.put(record());
    await store.get(PROJECT_ID, ARTIFACT_ID);
    await store.list();
    await store.delete(PROJECT_ID, ARTIFACT_ID);

    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });

  it.each([
    ["noncanonical project id", record({ projectId: PROJECT_ID.toUpperCase() })],
    ["noncanonical artifact id", record({ artifactId: ARTIFACT_ID.toUpperCase() })],
    ["untrusted URI", record({ sessionUri: "http://www.googleapis.com/upload/drive/v3/files/source?upload_id=opaque" })],
    ["duplicated upload id", record({ sessionUri: "https://www.googleapis.com/upload/drive/v3/files/source?upload_id=one&upload_id=two" })],
    ["credential-shaped access token query", record({ sessionUri: `${record().sessionUri}&access_token=synthetic-token` })],
    ["credential-shaped API key query", record({ sessionUri: `${record().sessionUri}&key=synthetic-key` })],
    ["arbitrary query", record({ sessionUri: `${record().sessionUri}&unexpected=synthetic` })],
    ["wrong chunk size", record({ chunkBytes: 1 as 8_388_608 })],
    ["offset beyond file", record({ nextOffset: 16_777_217 })],
    ["noncanonical expiration", record({ expiresAt: "2026-07-26T00:00:00Z" })],
    ["expired capability", record({ expiresAt: "2026-07-18T00:00:00.000Z" })],
    ["invalid file identity", record({ fileIdentity: { ...record().fileIdentity, sizeBytes: 0 } })],
  ])("rejects invalid writes: %s", async (_name, value) => {
    await expect(store.put(value)).rejects.toThrow("Invalid upload session record");
    await expect(store.get(PROJECT_ID, ARTIFACT_ID)).resolves.toBeNull();
  });

  it.each([
    ["malformed URI", record({ sessionUri: "https://evil.example/upload/drive/v3/files/source?upload_id=opaque" })],
    ["wrong chunk size", record({ chunkBytes: 1 as 8_388_608 })],
    ["offset beyond file", record({ nextOffset: 16_777_217 })],
    ["expired record", record({ expiresAt: "2026-07-18T00:00:00.000Z" })],
  ])("deletes malformed or expired record %#", async (_name, value) => {
    await rawPut({ key: `${value.projectId}:${value.artifactId}`, ...value });

    await expect(store.get(value.projectId, value.artifactId)).resolves.toBeNull();
    await expect(store.list()).resolves.toEqual([]);
  });

  it.each([
    ["credential-shaped access token query", "access_token=synthetic-token"],
    ["credential-shaped API key query", "key=synthetic-key"],
    ["arbitrary query", "unexpected=synthetic"],
  ])("deletes extra-query capability rows during get and list cleanup: %s", async (_name, extraQuery) => {
    const value = record({ sessionUri: `${record().sessionUri}&${extraQuery}` });
    await rawPut({ key: `${value.projectId}:${value.artifactId}`, ...value });

    await expect(store.get(value.projectId, value.artifactId)).resolves.toBeNull();
    await expect(store.list()).resolves.toEqual([]);
  });

  it("validates every list entry and deletes invalid rows before returning valid records", async () => {
    const valid = record();
    const expired = record({ artifactId: "30000000-0000-4000-8000-000000000003", expiresAt: "2026-07-18T00:00:00.000Z" });
    await rawPut({ key: `${valid.projectId}:${valid.artifactId}`, ...valid });
    await rawPut({ key: `${expired.projectId}:${expired.artifactId}`, ...expired });

    await expect(store.list()).resolves.toEqual([valid]);
    await expect(store.get(expired.projectId, expired.artifactId)).resolves.toBeNull();
  });

  it("deletes rows with a malformed internal key during listing", async () => {
    await rawPut({ key: 1, ...record() });

    await expect(store.list()).resolves.toEqual([]);
    await expect(rawRows()).resolves.toEqual([]);
  });

  it("rejects noncanonical lookup identifiers", async () => {
    await expect(store.get(PROJECT_ID.toUpperCase(), ARTIFACT_ID)).rejects.toThrow("Invalid upload session identifier");
    await expect(store.delete(PROJECT_ID, "not-a-uuid")).rejects.toThrow("Invalid upload session identifier");
  });
});

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = factory.open(DB_NAME, 1);
    opening.onupgradeneeded = () => {
      if (!opening.result.objectStoreNames.contains("sessions")) {
        opening.result.createObjectStore("sessions", { keyPath: "key" });
      }
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
  });
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}
