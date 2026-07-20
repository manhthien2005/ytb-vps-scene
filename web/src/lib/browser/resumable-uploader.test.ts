import { describe, expect, it, vi } from "vitest";
import { AppError } from "../domain/errors";
import type { StoredUploadSession, UploadSessionStore } from "./upload-store";
import {
  createResumableUploader,
  type UploadControlPlaneApi,
} from "./resumable-uploader";

const PROJECT_ID = "a0000000-0000-4000-8000-000000000001";
const ARTIFACT_ID = "b0000000-0000-4000-8000-000000000002";
const SESSION_URI =
  "https://www.googleapis.com/upload/drive/v3/files/source-file?upload_id=synthetic-capability";
const RENEWED_SESSION_URI =
  "https://www.googleapis.com/upload/drive/v3/files/source-file?upload_id=renewed-synthetic-capability";
const ALTERNATE_SESSION_URI =
  "https://www.googleapis.com/upload/drive/v3/files/source-file?upload_id=alternate-synthetic-capability";
const ALTERNATE_ARTIFACT_ID = "c0000000-0000-4000-8000-000000000003";
const HOSTILE_SESSION_URI =
  "https://app.example/api/private-upload?capability=hostile-mutation-marker";
const EXPIRES_AT = "2026-07-26T00:00:00.000Z";
const RENEWED_EXPIRES_AT = "2026-07-27T00:00:00.000Z";
const NOW = Date.parse("2026-07-19T00:00:00.000Z");

function fileOfSize(size = 524_288): File {
  return new File([new Uint8Array(size)], "private-source.mp4", {
    type: "video/mp4",
    lastModified: 1_752_883_200_000,
  });
}

function sessionFor(file: File, overrides: Partial<StoredUploadSession> = {}): StoredUploadSession {
  return {
    projectId: PROJECT_ID,
    artifactId: ARTIFACT_ID,
    sessionUri: SESSION_URI,
    fileIdentity: {
      displayName: file.name,
      sizeBytes: file.size,
      mimeType: file.type,
      lastModified: file.lastModified,
    },
    nextOffset: 0,
    chunkBytes: 8_388_608,
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

class MemoryUploadSessionStore implements UploadSessionStore {
  readonly values = new Map<string, StoredUploadSession>();
  readonly puts: StoredUploadSession[] = [];

  async get(projectId: string, artifactId: string): Promise<StoredUploadSession | null> {
    return this.values.get(`${projectId}:${artifactId}`) ?? null;
  }

  async put(value: StoredUploadSession): Promise<void> {
    this.puts.push(value);
    this.values.set(`${value.projectId}:${value.artifactId}`, value);
  }

  async delete(projectId: string, artifactId: string): Promise<void> {
    this.values.delete(`${projectId}:${artifactId}`);
  }

  async list(): Promise<readonly StoredUploadSession[]> {
    return [...this.values.values()];
  }
}

function response(status: number, headers: HeadersInit = {}): Response {
  return new Response(null, { status, headers });
}

function hiddenResponse(): Response {
  return {
    status: 0,
    type: "opaque",
    headers: new Headers(),
  } as Response;
}

type CapturedRequest = Readonly<{
  url: string;
  method: string;
  headers: Headers;
  body: BodyInit | null;
  signal: AbortSignal | null;
}>;

type FetchOutcome = Response | Error | (() => Response | Promise<Response>);

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function queuedFetcher(...outcomes: FetchOutcome[]) {
  const requests: CapturedRequest[] = [];
  let repeated: FetchOutcome | undefined;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: input instanceof Request ? input.url : input.toString(),
      method: init?.method ?? (input instanceof Request ? input.method : "GET"),
      headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
      body: init?.body ?? null,
      signal: init?.signal ?? null,
    });
    const outcome = outcomes.shift() ?? repeated;
    if (outcome instanceof Error) throw outcome;
    if (!outcome) throw new Error("No queued fetch outcome");
    return typeof outcome === "function" ? outcome() : outcome;
  }) as unknown as typeof fetch;
  return {
    fetcher,
    requests,
    always(outcome: FetchOutcome) {
      repeated = outcome;
    },
  };
}

function controlPlaneApi(): UploadControlPlaneApi {
  return {
    renewSession: vi.fn(),
    complete: vi.fn(),
    cancel: vi.fn(),
  };
}

describe("ResumableUploader", () => {
  it.each([200, 201])("finalizes after a readable final %i", async (status) => {
    const file = fileOfSize();
    const session = sessionFor(file);
    const store = new MemoryUploadSessionStore();
    const fetcher = queuedFetcher(response(status));
    const api = controlPlaneApi();
    vi.mocked(api.complete).mockResolvedValue({
      status: "SOURCE_READY",
      actualSizeBytes: file.size,
    });
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });

    await uploader.start(file, session);

    expect(api.complete).toHaveBeenCalledOnce();
    expect(await store.get(session.projectId, session.artifactId)).toBeNull();
    expect(uploader.snapshot().phase).toBe("READY");
  });

  it("uploads through the documented resumable query pair", async () => {
    const file = fileOfSize();
    const session = sessionFor(file, {
      sessionUri: "https://www.googleapis.com/upload/drive/v3/files/source-file?uploadType=resumable&upload_id=synthetic-capability",
    });
    const fetcher = queuedFetcher(response(201));
    const api = controlPlaneApi();
    vi.mocked(api.complete).mockResolvedValue({
      status: "SOURCE_READY",
      actualSizeBytes: file.size,
    });
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store: new MemoryUploadSessionStore(),
      api,
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });

    await uploader.start(file, session);

    expect(fetcher.requests.map((request) => request.url)).toEqual([session.sessionUri]);
  });

  it("treats a rejected final fetch as ambiguous and trusts server metadata", async () => {
    const file = fileOfSize();
    const session = sessionFor(file);
    const store = new MemoryUploadSessionStore();
    const fetcher = queuedFetcher(new TypeError("Failed to fetch"));
    const api = controlPlaneApi();
    vi.mocked(api.complete).mockResolvedValue({
      status: "SOURCE_READY",
      actualSizeBytes: file.size,
    });
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });

    await uploader.start(file, session);

    expect(api.complete).toHaveBeenCalledOnce();
    expect(fetcher.requests).toHaveLength(1);
    expect(await store.get(session.projectId, session.artifactId)).toBeNull();
    expect(uploader.snapshot().phase).toBe("READY");
  });

  it("treats a CORS-hidden final response as ambiguous metadata evidence", async () => {
    const file = fileOfSize();
    const session = sessionFor(file);
    const store = new MemoryUploadSessionStore();
    const fetcher = queuedFetcher(hiddenResponse());
    const api = controlPlaneApi();
    vi.mocked(api.complete).mockResolvedValue({
      status: "SOURCE_READY",
      actualSizeBytes: file.size,
    });
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });

    await uploader.start(file, session);

    expect(api.complete).toHaveBeenCalledOnce();
    expect(fetcher.requests).toHaveLength(1);
    expect(uploader.snapshot().phase).toBe("READY");
  });

  it("does not count sent final bytes as committed before server verification", async () => {
    const file = fileOfSize();
    const session = sessionFor(file);
    const api = controlPlaneApi();
    let resolveCompletion: ((value: {
      status: "SOURCE_READY";
      actualSizeBytes: number;
    }) => void) | undefined;
    vi.mocked(api.complete).mockReturnValue(new Promise((resolve) => {
      resolveCompletion = resolve;
    }));
    const uploader = createResumableUploader({
      fetcher: queuedFetcher(response(201)).fetcher,
      store: new MemoryUploadSessionStore(),
      api,
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });

    const upload = uploader.start(file, session);
    await vi.waitFor(() => expect(api.complete).toHaveBeenCalledOnce());

    expect(uploader.snapshot()).toMatchObject({
      phase: "VERIFYING",
      committedBytes: 0,
    });

    resolveCompletion?.({ status: "SOURCE_READY", actualSizeBytes: file.size });
    await upload;

    expect(uploader.snapshot()).toMatchObject({
      phase: "READY",
      committedBytes: file.size,
    });
  });

  it("retries a transient metadata finalization failure under the shared ceiling", async () => {
    const file = fileOfSize();
    const session = sessionFor(file);
    const fetcher = queuedFetcher(response(201));
    const api = controlPlaneApi();
    vi.mocked(api.complete)
      .mockRejectedValueOnce(new AppError("DRIVE_TEMPORARILY_UNAVAILABLE", 503))
      .mockResolvedValueOnce({ status: "SOURCE_READY", actualSizeBytes: file.size });
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>(async () => undefined);
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store: new MemoryUploadSessionStore(),
      api,
      now: () => NOW,
      random: () => 0,
      sleep,
    });

    await uploader.start(file, session);

    expect(api.complete).toHaveBeenCalledTimes(2);
    expect(fetcher.requests).toHaveLength(1);
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(uploader.snapshot().phase).toBe("READY");
  });

  it("uploads exact 8 MiB and final byte ranges", async () => {
    const file = fileOfSize(8_388_608 + 257);
    const session = sessionFor(file);
    const store = new MemoryUploadSessionStore();
    const fetcher = queuedFetcher(
      response(308, { Range: "bytes=0-8388607" }),
      response(201),
    );
    const api = controlPlaneApi();
    vi.mocked(api.complete).mockResolvedValue({
      status: "SOURCE_READY",
      actualSizeBytes: file.size,
    });
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });

    await uploader.start(file, session);

    expect(fetcher.requests.map((request) => request.headers.get("content-range"))).toEqual([
      `bytes 0-8388607/${file.size}`,
      `bytes 8388608-${file.size - 1}/${file.size}`,
    ]);
  });

  it("persists the readable 308 Range as the only committed offset", async () => {
    const file = fileOfSize(8_388_609);
    const session = sessionFor(file);
    const store = new MemoryUploadSessionStore();
    const fetcher = queuedFetcher(
      response(308, { Range: "bytes=0-8388607" }),
      response(201),
    );
    const api = controlPlaneApi();
    vi.mocked(api.complete).mockResolvedValue({
      status: "SOURCE_READY",
      actualSizeBytes: file.size,
    });
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });

    await uploader.start(file, session);

    expect(store.puts.map((value) => value.nextOffset)).toEqual([0, 8_388_608]);
  });

  it("counts repeated no-progress 308 acknowledgements toward the retry ceiling", async () => {
    const file = fileOfSize();
    const session = sessionFor(file);
    const store = new MemoryUploadSessionStore();
    const fetcher = queuedFetcher(
      ...Array.from({ length: 9 }, () => response(308)),
      response(201),
    );
    const api = controlPlaneApi();
    vi.mocked(api.complete).mockResolvedValue({
      status: "SOURCE_READY",
      actualSizeBytes: file.size,
    });
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>(async () => undefined);
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep,
    });

    await expect(uploader.start(file, session)).rejects.toMatchObject({
      code: "UPLOAD_RETRY_EXHAUSTED",
    });

    expect(fetcher.requests).toHaveLength(9);
    expect(sleep).toHaveBeenCalledTimes(4);
    expect(uploader.snapshot()).toMatchObject({
      phase: "PAUSED_ERROR",
      publicCode: "UPLOAD_RETRY_EXHAUSTED",
      committedBytes: 0,
    });
  });

  it("restores the retry budget after each advancing upload acknowledgement", async () => {
    const file = fileOfSize(16_777_217);
    const session = sessionFor(file);
    const store = new MemoryUploadSessionStore();
    const fetcher = queuedFetcher(
      response(429),
      response(429),
      response(308, { Range: "bytes=0-8388607" }),
      response(429),
      response(429),
      response(308, { Range: "bytes=0-16777215" }),
      response(429),
      response(201),
    );
    const api = controlPlaneApi();
    vi.mocked(api.complete).mockResolvedValue({
      status: "SOURCE_READY",
      actualSizeBytes: file.size,
    });
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>(async () => undefined);
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep,
    });

    await uploader.start(file, session);

    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      1_000,
      2_000,
      1_000,
      2_000,
      1_000,
    ]);
    expect(fetcher.requests).toHaveLength(8);
    expect(uploader.snapshot()).toMatchObject({
      phase: "READY",
      committedBytes: file.size,
    });
  });

  it("restores the retry budget after an advancing status-query acknowledgement", async () => {
    const file = fileOfSize(8_388_609);
    const session = sessionFor(file);
    const store = new MemoryUploadSessionStore();
    await store.put(session);
    const fetcher = queuedFetcher(
      response(429),
      response(429),
      response(429),
      response(429),
      response(308, { Range: "bytes=0-8388607" }),
      response(429),
      response(201),
    );
    const api = controlPlaneApi();
    vi.mocked(api.complete).mockResolvedValue({
      status: "SOURCE_READY",
      actualSizeBytes: file.size,
    });
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>(async () => undefined);
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep,
    });

    await uploader.resume(file, session);

    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      1_000,
      2_000,
      4_000,
      8_000,
      1_000,
    ]);
    expect(fetcher.requests.slice(0, 5).every((request) => (
      request.headers.get("content-range") === `*/${file.size}`
    ))).toBe(true);
    expect(fetcher.requests.slice(5).map((request) => request.headers.get("content-range")))
      .toEqual([
        `bytes 8388608-${file.size - 1}/${file.size}`,
        `bytes 8388608-${file.size - 1}/${file.size}`,
      ]);
    expect(uploader.snapshot().phase).toBe("READY");
  });

  it("sends chunk bodies directly without Authorization or Content-Length", async () => {
    const file = fileOfSize(8_388_609);
    const session = sessionFor(file);
    const fetcher = queuedFetcher(
      response(308, { Range: "bytes=0-8388607" }),
      response(201),
    );
    const api = controlPlaneApi();
    vi.mocked(api.complete).mockResolvedValue({
      status: "SOURCE_READY",
      actualSizeBytes: file.size,
    });
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store: new MemoryUploadSessionStore(),
      api,
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });

    await uploader.start(file, session);

    expect(fetcher.requests.map((request) => request.url)).toEqual([
      session.sessionUri,
      session.sessionUri,
    ]);
    expect(fetcher.requests.every((request) => request.method === "PUT")).toBe(true);
    expect(fetcher.requests.every((request) => !request.headers.has("authorization"))).toBe(true);
    expect(fetcher.requests.every((request) => !request.headers.has("content-length"))).toBe(true);
    expect(fetcher.requests.every((request) => request.headers.get("content-type") === file.type)).toBe(true);
    expect(fetcher.requests[0]!.body).toHaveProperty("size", 8_388_608);
    expect(fetcher.requests[1]!.body).toHaveProperty("size", 1);
  });

  it("resumes from readable Range when metadata is still pending", async () => {
    const file = fileOfSize();
    const session = sessionFor(file);
    const store = new MemoryUploadSessionStore();
    const fetcher = queuedFetcher(
      new TypeError("Failed to fetch"),
      response(308, { Range: "bytes=0-262143" }),
      response(201),
    );
    const api = controlPlaneApi();
    vi.mocked(api.complete)
      .mockResolvedValueOnce({ status: "UPLOAD_PENDING", retryAfterMs: 1_000 })
      .mockResolvedValueOnce({ status: "SOURCE_READY", actualSizeBytes: file.size });
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });

    await uploader.start(file, session);

    expect(fetcher.requests[1]!.headers.get("content-range")).toBe(`*/${file.size}`);
    expect(fetcher.requests[1]!.body).toBeNull();
    expect(fetcher.requests[2]!.headers.get("content-range"))
      .toBe(`bytes 262144-${file.size - 1}/${file.size}`);
    expect(store.puts.some((value) => value.nextOffset === 262_144)).toBe(true);
    expect(uploader.snapshot().phase).toBe("READY");
  });

  it("retains the capability in PAUSED_VERIFYING after five unresolved attempts", async () => {
    const file = fileOfSize();
    const session = sessionFor(file);
    const store = new MemoryUploadSessionStore();
    const fetcher = queuedFetcher();
    fetcher.always(new TypeError("Failed to fetch"));
    const api = controlPlaneApi();
    vi.mocked(api.complete).mockResolvedValue({
      status: "UPLOAD_PENDING",
      retryAfterMs: 1_000,
    });
    const sleep = vi.fn(async () => undefined);
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep,
    });

    await expect(uploader.start(file, session)).rejects.toMatchObject({
      code: "UPLOAD_RETRY_EXHAUSTED",
    });

    expect(sleep).toHaveBeenCalledTimes(4);
    expect(uploader.snapshot()).toMatchObject({
      phase: "PAUSED_VERIFYING",
      publicCode: "UPLOAD_RETRY_EXHAUSTED",
    });
    expect(await store.get(session.projectId, session.artifactId)).not.toBeNull();
  });

  it("resumes from zero when a status query returns a null Range", async () => {
    const file = fileOfSize();
    const session = sessionFor(file, { nextOffset: 262_144 });
    const store = new MemoryUploadSessionStore();
    await store.put(session);
    const fetcher = queuedFetcher(response(308), response(201));
    const api = controlPlaneApi();
    vi.mocked(api.complete).mockResolvedValue({
      status: "SOURCE_READY",
      actualSizeBytes: file.size,
    });
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });

    await uploader.resume(file, session);

    expect(fetcher.requests[0]!.headers.get("content-range")).toBe(`*/${file.size}`);
    expect(fetcher.requests[1]!.headers.get("content-range")).toBe(
      `bytes 0-${file.size - 1}/${file.size}`,
    );
    expect(store.puts.some((value) => value.nextOffset === 0)).toBe(true);
  });

  it("pauses with a stable error when Drive returns a malformed Range", async () => {
    const file = fileOfSize();
    const session = sessionFor(file, { nextOffset: 262_144 });
    const store = new MemoryUploadSessionStore();
    await store.put(session);
    const fetcher = queuedFetcher(response(308, { Range: "bytes=1-262143" }));
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api: controlPlaneApi(),
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });

    await expect(uploader.resume(file, session)).rejects.toMatchObject({
      code: "UPLOAD_REMOTE_MISMATCH",
    });

    expect(uploader.snapshot()).toMatchObject({
      phase: "PAUSED_ERROR",
      publicCode: "UPLOAD_REMOTE_MISMATCH",
    });
    expect(await store.get(session.projectId, session.artifactId)).toEqual(session);
  });

  it.each([
    ["network rejection", new TypeError("Failed to fetch")],
    ["readable 5xx", response(503)],
  ])("queries status after a non-final %s", async (_name, failedUpload) => {
    const file = fileOfSize(8_388_609);
    const session = sessionFor(file);
    const store = new MemoryUploadSessionStore();
    const fetcher = queuedFetcher(
      failedUpload,
      response(308, { Range: "bytes=0-8388607" }),
      response(201),
    );
    const api = controlPlaneApi();
    vi.mocked(api.complete).mockResolvedValue({
      status: "SOURCE_READY",
      actualSizeBytes: file.size,
    });
    const sleep = vi.fn(async () => undefined);
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep,
    });

    await uploader.start(file, session);

    expect(fetcher.requests.map((request) => request.headers.get("content-range"))).toEqual([
      `bytes 0-8388607/${file.size}`,
      `*/${file.size}`,
      `bytes 8388608-${file.size - 1}/${file.size}`,
    ]);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it.each([
    ["network rejection", new TypeError("Failed to fetch")],
    ["readable 5xx", response(502)],
  ])("retries a status query after a %s", async (_name, failedQuery) => {
    const file = fileOfSize();
    const session = sessionFor(file);
    const store = new MemoryUploadSessionStore();
    await store.put(session);
    const fetcher = queuedFetcher(failedQuery, response(308), response(201));
    const api = controlPlaneApi();
    vi.mocked(api.complete).mockResolvedValue({
      status: "SOURCE_READY",
      actualSizeBytes: file.size,
    });
    const sleep = vi.fn(async () => undefined);
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep,
    });

    await uploader.resume(file, session);

    expect(fetcher.requests.slice(0, 2).map((request) => request.headers.get("content-range")))
      .toEqual([`*/${file.size}`, `*/${file.size}`]);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it("delays and retries a rate-limited status query", async () => {
    const file = fileOfSize();
    const session = sessionFor(file);
    const store = new MemoryUploadSessionStore();
    await store.put(session);
    const fetcher = queuedFetcher(response(429), response(308), response(201));
    const api = controlPlaneApi();
    vi.mocked(api.complete).mockResolvedValue({
      status: "SOURCE_READY",
      actualSizeBytes: file.size,
    });
    const sleep = vi.fn(async () => undefined);
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0.996,
      sleep,
    });

    await uploader.resume(file, session);

    expect(sleep).toHaveBeenCalledWith(1_249);
    expect(fetcher.requests.slice(0, 2).map((request) => request.headers.get("content-range")))
      .toEqual([`*/${file.size}`, `*/${file.size}`]);
  });

  it("polls server verification after a CORS-hidden status response", async () => {
    const file = fileOfSize();
    const session = sessionFor(file);
    const store = new MemoryUploadSessionStore();
    const fetcher = queuedFetcher(new TypeError("Failed to fetch"), hiddenResponse());
    const api = controlPlaneApi();
    vi.mocked(api.complete)
      .mockResolvedValueOnce({ status: "UPLOAD_PENDING", retryAfterMs: 1_000 })
      .mockResolvedValueOnce({ status: "SOURCE_READY", actualSizeBytes: file.size });
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>(async () => undefined);
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep,
    });

    await uploader.start(file, session);

    expect(api.complete).toHaveBeenCalledTimes(2);
    expect(fetcher.requests).toHaveLength(2);
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([1_000, 2_000]);
    expect(uploader.snapshot().phase).toBe("READY");
  });

  it.each([200, 201])(
    "returns a readable %i status-query completion to server verification",
    async (status) => {
      const file = fileOfSize();
      const session = sessionFor(file);
      const store = new MemoryUploadSessionStore();
      await store.put(session);
      const fetcher = queuedFetcher(response(status));
      const api = controlPlaneApi();
      vi.mocked(api.complete).mockResolvedValue({
        status: "SOURCE_READY",
        actualSizeBytes: file.size,
      });
      const uploader = createResumableUploader({
        fetcher: fetcher.fetcher,
        store,
        api,
        now: () => NOW,
        random: () => 0,
        sleep: vi.fn(async () => undefined),
      });

      await uploader.resume(file, session);

      expect(api.complete).toHaveBeenCalledOnce();
      expect(fetcher.requests).toHaveLength(1);
      expect(uploader.snapshot().phase).toBe("READY");
    },
  );

  it.each([400, 403, 404])(
    "renews after a %i status-query response and restarts at byte zero",
    async (status) => {
      const file = fileOfSize();
      const session = sessionFor(file, { nextOffset: 262_144 });
      const store = new MemoryUploadSessionStore();
      await store.put(session);
      const fetcher = queuedFetcher(response(status), response(201));
      const api = controlPlaneApi();
      vi.mocked(api.renewSession).mockResolvedValue({
        artifactId: session.artifactId,
        sessionUri: RENEWED_SESSION_URI,
        chunkBytes: 8_388_608,
        expiresAt: RENEWED_EXPIRES_AT,
      });
      vi.mocked(api.complete).mockResolvedValue({
        status: "SOURCE_READY",
        actualSizeBytes: file.size,
      });
      const uploader = createResumableUploader({
        fetcher: fetcher.fetcher,
        store,
        api,
        now: () => NOW,
        random: () => 0,
        sleep: vi.fn(async () => undefined),
      });

      await uploader.resume(file, session);

      expect(api.renewSession).toHaveBeenCalledOnce();
      expect(fetcher.requests[1]).toMatchObject({
        url: RENEWED_SESSION_URI,
      });
      expect(fetcher.requests[1]!.headers.get("content-range")).toBe(
        `bytes 0-${file.size - 1}/${file.size}`,
      );
      expect(store.puts).toContainEqual({
        ...session,
        sessionUri: RENEWED_SESSION_URI,
        expiresAt: RENEWED_EXPIRES_AT,
        nextOffset: 0,
      });
    },
  );

  it("accepts terminal metadata from renewal without creating or using another capability", async () => {
    const file = fileOfSize();
    const session = sessionFor(file, { nextOffset: 262_144 });
    const store = new MemoryUploadSessionStore();
    await store.put(session);
    const fetcher = queuedFetcher(response(404));
    const api = controlPlaneApi();
    vi.mocked(api.renewSession).mockResolvedValue({
      artifactId: session.artifactId,
      status: "SOURCE_READY",
      actualSizeBytes: file.size,
    } as unknown as Awaited<ReturnType<UploadControlPlaneApi["renewSession"]>>);
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });

    await uploader.resume(file, session);

    expect(api.renewSession).toHaveBeenCalledOnce();
    expect(api.complete).not.toHaveBeenCalled();
    expect(fetcher.requests).toHaveLength(1);
    expect(await store.get(session.projectId, session.artifactId)).toBeNull();
    expect(uploader.snapshot()).toMatchObject({ phase: "READY", committedBytes: file.size });
  });

  it("delays a 429 retry with bounded jitter", async () => {
    const file = fileOfSize();
    const session = sessionFor(file);
    const fetcher = queuedFetcher(response(429), response(201));
    const api = controlPlaneApi();
    vi.mocked(api.complete).mockResolvedValue({
      status: "SOURCE_READY",
      actualSizeBytes: file.size,
    });
    const sleep = vi.fn(async () => undefined);
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store: new MemoryUploadSessionStore(),
      api,
      now: () => NOW,
      random: () => 0.996,
      sleep,
    });

    await uploader.start(file, session);

    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(1_249);
    expect(fetcher.requests.map((request) => request.headers.get("content-range"))).toEqual([
      `bytes 0-${file.size - 1}/${file.size}`,
      `bytes 0-${file.size - 1}/${file.size}`,
    ]);
  });

  it.each([400, 403, 404])(
    "replaces a %i session and resets the new capability to byte zero",
    async (status) => {
      const file = fileOfSize(8_388_609);
      const session = sessionFor(file, { nextOffset: 8_388_608 });
      const store = new MemoryUploadSessionStore();
      await store.put(session);
      const fetcher = queuedFetcher(
        response(status),
        response(308, { Range: "bytes=0-8388607" }),
        response(201),
      );
      const api = controlPlaneApi();
      vi.mocked(api.renewSession).mockResolvedValue({
        artifactId: session.artifactId,
        sessionUri: RENEWED_SESSION_URI,
        chunkBytes: 8_388_608,
        expiresAt: RENEWED_EXPIRES_AT,
      });
      vi.mocked(api.complete).mockResolvedValue({
        status: "SOURCE_READY",
        actualSizeBytes: file.size,
      });
      const uploader = createResumableUploader({
        fetcher: fetcher.fetcher,
        store,
        api,
        now: () => NOW,
        random: () => 0,
        sleep: vi.fn(async () => undefined),
      });

      await uploader.start(file, session);

      expect(api.renewSession).toHaveBeenCalledOnce();
      expect(fetcher.requests.map((request) => request.url)).toEqual([
        SESSION_URI,
        RENEWED_SESSION_URI,
        RENEWED_SESSION_URI,
      ]);
      expect(fetcher.requests[1]!.headers.get("content-range")).toBe(
        `bytes 0-8388607/${file.size}`,
      );
      expect(store.puts).toContainEqual({
        ...session,
        sessionUri: RENEWED_SESSION_URI,
        expiresAt: RENEWED_EXPIRES_AT,
        nextOffset: 0,
      });
    },
  );

  it("counts repeated renewals against the same five-failure ceiling", async () => {
    const file = fileOfSize();
    const session = sessionFor(file);
    const store = new MemoryUploadSessionStore();
    const fetcher = queuedFetcher(
      response(404),
      response(404),
      response(404),
      response(404),
      response(404),
    );
    const api = controlPlaneApi();
    vi.mocked(api.renewSession).mockResolvedValue({
      artifactId: session.artifactId,
      sessionUri: RENEWED_SESSION_URI,
      chunkBytes: 8_388_608,
      expiresAt: RENEWED_EXPIRES_AT,
    });
    const sleep = vi.fn(async () => undefined);
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep,
    });

    await expect(uploader.start(file, session)).rejects.toMatchObject({
      code: "UPLOAD_RETRY_EXHAUSTED",
    });

    expect(fetcher.requests).toHaveLength(5);
    expect(api.renewSession).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(4);
    expect(uploader.snapshot()).toMatchObject({
      phase: "PAUSED_ERROR",
      publicCode: "UPLOAD_RETRY_EXHAUSTED",
    });
    expect(await store.get(session.projectId, session.artifactId)).not.toBeNull();
  });

  it("counts a transient renewal API failure in the same retry sequence", async () => {
    const file = fileOfSize();
    const session = sessionFor(file);
    const store = new MemoryUploadSessionStore();
    const fetcher = queuedFetcher(response(404), response(201));
    const api = controlPlaneApi();
    vi.mocked(api.renewSession)
      .mockRejectedValueOnce(new AppError("DRIVE_TEMPORARILY_UNAVAILABLE", 503))
      .mockResolvedValueOnce({
        artifactId: session.artifactId,
        sessionUri: RENEWED_SESSION_URI,
        chunkBytes: 8_388_608,
        expiresAt: RENEWED_EXPIRES_AT,
      });
    vi.mocked(api.complete).mockResolvedValue({
      status: "SOURCE_READY",
      actualSizeBytes: file.size,
    });
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>(async () => undefined);
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep,
    });

    await uploader.start(file, session);

    expect(api.renewSession).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([1_000, 2_000]);
    expect(fetcher.requests[1]!.url).toBe(RENEWED_SESSION_URI);
  });

  it("renews a locally expired session before sending any bytes", async () => {
    const file = fileOfSize();
    const session = sessionFor(file, { expiresAt: new Date(NOW).toISOString() });
    const store = new MemoryUploadSessionStore();
    const fetcher = queuedFetcher(response(201));
    const api = controlPlaneApi();
    vi.mocked(api.renewSession).mockResolvedValue({
      artifactId: session.artifactId,
      sessionUri: RENEWED_SESSION_URI,
      chunkBytes: 8_388_608,
      expiresAt: RENEWED_EXPIRES_AT,
    });
    vi.mocked(api.complete).mockResolvedValue({
      status: "SOURCE_READY",
      actualSizeBytes: file.size,
    });
    const sleep = vi.fn(async () => undefined);
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep,
    });

    await uploader.start(file, session);

    expect(fetcher.requests.map((request) => request.url)).toEqual([RENEWED_SESSION_URI]);
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(store.puts).toContainEqual({
      ...session,
      sessionUri: RENEWED_SESSION_URI,
      expiresAt: RENEWED_EXPIRES_AT,
      nextOffset: 0,
    });
  });

  it("rejects a selected File whose identity does not match the stored record", async () => {
    const original = fileOfSize();
    const session = sessionFor(original);
    const selected = new File([new Uint8Array(original.size)], original.name, {
      type: original.type,
      lastModified: original.lastModified + 1,
    });
    const store = new MemoryUploadSessionStore();
    await store.put(session);
    const fetcher = queuedFetcher();
    const api = controlPlaneApi();
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });

    await expect(uploader.start(selected, session)).rejects.toMatchObject({
      code: "UPLOAD_REMOTE_MISMATCH",
    });

    expect(fetcher.requests).toHaveLength(0);
    expect(api.complete).not.toHaveBeenCalled();
    expect(api.renewSession).not.toHaveBeenCalled();
    expect(await store.get(session.projectId, session.artifactId)).toEqual(session);
    expect(uploader.snapshot()).toMatchObject({
      phase: "PAUSED_ERROR",
      publicCode: "UPLOAD_REMOTE_MISMATCH",
    });
  });

  it("never sends file bytes to a non-Drive session URI", async () => {
    const file = fileOfSize();
    const session = sessionFor(file, {
      sessionUri: "https://app.example/api/v1/projects/project/upload-complete",
    });
    const store = new MemoryUploadSessionStore();
    await store.put(session);
    const fetcher = queuedFetcher();
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api: controlPlaneApi(),
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });

    await expect(uploader.start(file, session)).rejects.toMatchObject({
      code: "UPLOAD_REMOTE_MISMATCH",
    });

    expect(fetcher.requests).toHaveLength(0);
    expect(await store.get(session.projectId, session.artifactId)).toEqual(session);
  });

  it.each([
    ["media", "start", false],
    ["status", "resume", true],
  ] as const)(
    "snapshots the accepted record before an awaited store write for a %s request",
    async (_requestKind, method, recovering) => {
      const file = fileOfSize();
      const session = sessionFor(file);
      const acceptedSession = {
        ...session,
        fileIdentity: { ...session.fileIdentity },
      };
      const store = new MemoryUploadSessionStore();
      const writeGate = deferred<void>();
      const originalPut = store.put.bind(store);
      vi.spyOn(store, "put").mockImplementation(async (record) => {
        await writeGate.promise;
        await originalPut(record);
      });
      const fetcher = recovering
        ? queuedFetcher(response(308), response(201))
        : queuedFetcher(response(201));
      const api = controlPlaneApi();
      vi.mocked(api.complete).mockResolvedValue({
        status: "SOURCE_READY",
        actualSizeBytes: file.size,
      });
      const uploader = createResumableUploader({
        fetcher: fetcher.fetcher,
        store,
        api,
        now: () => NOW,
        random: () => 0,
        sleep: vi.fn(async () => undefined),
      });

      const running = uploader[method](file, session);
      await vi.waitFor(() => expect(store.put).toHaveBeenCalledOnce());
      Object.assign(session, {
        projectId: "mutated-project",
        artifactId: "mutated-artifact",
        sessionUri: HOSTILE_SESSION_URI,
        nextOffset: 123,
        chunkBytes: 1,
        expiresAt: "1999-01-01T00:00:00.000Z",
      });
      Object.assign(session.fileIdentity, {
        displayName: "mutated-source.mp4",
        sizeBytes: 1,
        mimeType: "text/plain",
        lastModified: 1,
      });
      writeGate.resolve();
      await running;

      expect(fetcher.requests.length).toBeGreaterThan(0);
      expect(
        fetcher.requests.every((request) => request.url === acceptedSession.sessionUri),
      ).toBe(true);
      expect(store.puts.length).toBeGreaterThan(0);
      for (const persisted of store.puts) {
        expect(persisted).toEqual(acceptedSession);
      }
      expect(api.complete).toHaveBeenCalledWith(
        acceptedSession.projectId,
        acceptedSession.artifactId,
      );
      const exposed = JSON.stringify(uploader.snapshot());
      expect(exposed).not.toContain(HOSTILE_SESSION_URI);
      expect(exposed).not.toContain(acceptedSession.sessionUri);
      expect(exposed).not.toContain("upload_id");
    },
  );

  it.each([
    ["media", "start", false],
    ["status", "resume", true],
  ] as const)(
    "isolates a %s request from a persistence effect that mutates to another Drive destination",
    async (_requestKind, method, recovering) => {
      const file = fileOfSize();
      const session = sessionFor(file);
      const store = new MemoryUploadSessionStore();
      const originalPut = store.put.bind(store);
      vi.spyOn(store, "put").mockImplementation(async (record) => {
        await originalPut(record);
        (record as { sessionUri: string }).sessionUri = RENEWED_SESSION_URI;
      });
      const fetcher = recovering
        ? queuedFetcher(response(308), response(201))
        : queuedFetcher(response(201));
      const api = controlPlaneApi();
      vi.mocked(api.complete).mockResolvedValue({
        status: "SOURCE_READY",
        actualSizeBytes: file.size,
      });
      const uploader = createResumableUploader({
        fetcher: fetcher.fetcher,
        store,
        api,
        now: () => NOW,
        random: () => 0,
        sleep: vi.fn(async () => undefined),
      });

      await uploader[method](file, session);

      expect(fetcher.requests.length).toBeGreaterThan(0);
      expect(fetcher.requests.every((request) => request.url === SESSION_URI)).toBe(true);
      expect(JSON.stringify(uploader.snapshot())).not.toContain("upload_id");
    },
  );

  it("snapshots each valid renewal field once before validation and use", async () => {
    const file = fileOfSize();
    const session = sessionFor(file);
    const store = new MemoryUploadSessionStore();
    const fetcher = queuedFetcher(response(404), response(201));
    const api = controlPlaneApi();
    const reads = {
      artifactId: 0,
      sessionUri: 0,
      chunkBytes: 0,
      expiresAt: 0,
    };
    vi.mocked(api.renewSession).mockResolvedValue({
      get artifactId() {
        reads.artifactId += 1;
        return reads.artifactId === 1 ? session.artifactId : ALTERNATE_ARTIFACT_ID;
      },
      get sessionUri() {
        reads.sessionUri += 1;
        return reads.sessionUri === 1 ? RENEWED_SESSION_URI : ALTERNATE_SESSION_URI;
      },
      get chunkBytes() {
        reads.chunkBytes += 1;
        return reads.chunkBytes === 1 ? 8_388_608 : 16_777_216;
      },
      get expiresAt() {
        reads.expiresAt += 1;
        return reads.expiresAt === 1 ? RENEWED_EXPIRES_AT : "1999-01-01T00:00:00.000Z";
      },
    } as unknown as Awaited<ReturnType<UploadControlPlaneApi["renewSession"]>>);
    vi.mocked(api.complete).mockResolvedValue({
      status: "SOURCE_READY",
      actualSizeBytes: file.size,
    });
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });

    await uploader.start(file, session);

    expect(reads).toEqual({
      artifactId: 1,
      sessionUri: 1,
      chunkBytes: 1,
      expiresAt: 1,
    });
    expect(fetcher.requests.map((request) => request.url)).toEqual([
      SESSION_URI,
      RENEWED_SESSION_URI,
    ]);
    expect(store.puts[1]).toEqual({
      ...session,
      sessionUri: RENEWED_SESSION_URI,
      nextOffset: 0,
      chunkBytes: 8_388_608,
      expiresAt: RENEWED_EXPIRES_AT,
    });
    expect(store.puts.some((record) => (
      record.artifactId === ALTERNATE_ARTIFACT_ID ||
      record.sessionUri === ALTERNATE_SESSION_URI
    ))).toBe(false);
    expect(api.complete).toHaveBeenCalledWith(session.projectId, session.artifactId);
  });

  it("reads every renewal field once and fails closed on an invalid first value", async () => {
    const file = fileOfSize();
    const session = sessionFor(file);
    const store = new MemoryUploadSessionStore();
    const fetcher = queuedFetcher(response(404), response(201));
    const api = controlPlaneApi();
    const reads = {
      artifactId: 0,
      sessionUri: 0,
      chunkBytes: 0,
      expiresAt: 0,
    };
    vi.mocked(api.renewSession).mockResolvedValue({
      get artifactId() {
        reads.artifactId += 1;
        return reads.artifactId === 1 ? session.artifactId : ALTERNATE_ARTIFACT_ID;
      },
      get sessionUri() {
        reads.sessionUri += 1;
        return reads.sessionUri === 1 ? HOSTILE_SESSION_URI : ALTERNATE_SESSION_URI;
      },
      get chunkBytes() {
        reads.chunkBytes += 1;
        return reads.chunkBytes === 1 ? 8_388_608 : 16_777_216;
      },
      get expiresAt() {
        reads.expiresAt += 1;
        return reads.expiresAt === 1 ? RENEWED_EXPIRES_AT : "1999-01-01T00:00:00.000Z";
      },
    } as unknown as Awaited<ReturnType<UploadControlPlaneApi["renewSession"]>>);
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });

    await expect(uploader.start(file, session)).rejects.toMatchObject({
      code: "UPLOAD_REMOTE_MISMATCH",
    });

    expect(api.renewSession).toHaveBeenCalledOnce();
    expect(reads).toEqual({
      artifactId: 1,
      sessionUri: 1,
      chunkBytes: 1,
      expiresAt: 1,
    });
    expect(fetcher.requests).toHaveLength(1);
    expect(fetcher.requests[0]!.url).toBe(SESSION_URI);
    expect(store.puts).toEqual([session]);
    expect(JSON.stringify({ snapshot: uploader.snapshot(), store: store.puts })).not.toContain(
      ALTERNATE_SESSION_URI,
    );
  });

  it("isolates the accepted file identity from renewal API mutation", async () => {
    const file = fileOfSize();
    const session = sessionFor(file);
    const acceptedIdentity = { ...session.fileIdentity };
    const store = new MemoryUploadSessionStore();
    const fetcher = queuedFetcher(response(404), response(201));
    const api = controlPlaneApi();
    vi.mocked(api.renewSession).mockImplementation(async (_projectId, identity) => {
      Object.assign(identity, {
        displayName: "mutated-by-renewal.mp4",
        sizeBytes: 1,
        mimeType: "text/plain",
        lastModified: 1,
      });
      return {
        artifactId: session.artifactId,
        sessionUri: RENEWED_SESSION_URI,
        chunkBytes: 8_388_608,
        expiresAt: RENEWED_EXPIRES_AT,
      };
    });
    vi.mocked(api.complete).mockResolvedValue({
      status: "SOURCE_READY",
      actualSizeBytes: file.size,
    });
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });

    await uploader.start(file, session);

    expect(store.puts.length).toBeGreaterThan(1);
    for (const persisted of store.puts) {
      expect(persisted.fileIdentity).toEqual(acceptedIdentity);
    }
  });

  it.each([
    ["non-Drive URI", { sessionUri: "https://app.example/api/upload" }],
    ["different artifact", { artifactId: "c0000000-0000-4000-8000-000000000003" }],
  ])("rejects a renewed capability with a %s", async (_name, override) => {
    const file = fileOfSize();
    const session = sessionFor(file);
    const store = new MemoryUploadSessionStore();
    await store.put(session);
    const fetcher = queuedFetcher(response(404));
    const api = controlPlaneApi();
    vi.mocked(api.renewSession).mockResolvedValue({
      artifactId: session.artifactId,
      sessionUri: RENEWED_SESSION_URI,
      chunkBytes: 8_388_608,
      expiresAt: RENEWED_EXPIRES_AT,
      ...override,
    });
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });

    await expect(uploader.start(file, session)).rejects.toMatchObject({
      code: "UPLOAD_REMOTE_MISMATCH",
    });

    expect(fetcher.requests).toHaveLength(1);
    expect(await store.get(session.projectId, session.artifactId)).toEqual(session);
  });

  it("finalizes a reloaded total offset before sending any Drive request", async () => {
    const file = fileOfSize();
    const session = sessionFor(file, { nextOffset: file.size });
    const store = new MemoryUploadSessionStore();
    await store.put(session);
    const fetcher = queuedFetcher();
    const api = controlPlaneApi();
    vi.mocked(api.complete).mockResolvedValue({
      status: "SOURCE_READY",
      actualSizeBytes: file.size,
    });
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });

    await uploader.resume(file, session);

    expect(api.complete).toHaveBeenCalledOnce();
    expect(fetcher.requests).toHaveLength(0);
    expect(await store.get(session.projectId, session.artifactId)).toBeNull();
    expect(uploader.snapshot().phase).toBe("READY");
  });

  it("finalizes an expired total offset before attempting session renewal", async () => {
    const file = fileOfSize();
    const session = sessionFor(file, {
      nextOffset: file.size,
      expiresAt: new Date(NOW).toISOString(),
    });
    const store = new MemoryUploadSessionStore();
    await store.put(session);
    const fetcher = queuedFetcher();
    const api = controlPlaneApi();
    vi.mocked(api.complete).mockResolvedValue({
      status: "SOURCE_READY",
      actualSizeBytes: file.size,
    });
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });

    await uploader.resume(file, session);

    expect(api.complete).toHaveBeenCalledOnce();
    expect(api.renewSession).not.toHaveBeenCalled();
    expect(fetcher.requests).toHaveLength(0);
    expect(await store.get(session.projectId, session.artifactId)).toBeNull();
    expect(uploader.snapshot().phase).toBe("READY");
  });

  it("retains the session when completion metadata has the wrong size", async () => {
    const file = fileOfSize();
    const session = sessionFor(file);
    const store = new MemoryUploadSessionStore();
    const fetcher = queuedFetcher(response(201));
    const api = controlPlaneApi();
    vi.mocked(api.complete).mockResolvedValue({
      status: "SOURCE_READY",
      actualSizeBytes: file.size - 1,
    });
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });

    await expect(uploader.start(file, session)).rejects.toMatchObject({
      code: "UPLOAD_REMOTE_MISMATCH",
    });

    expect(await store.get(session.projectId, session.artifactId)).not.toBeNull();
    expect(uploader.snapshot()).toMatchObject({
      phase: "PAUSED_ERROR",
      publicCode: "UPLOAD_REMOTE_MISMATCH",
    });
  });

  it.each(["start", "resume"] as const)(
    "rejects an overlapping %s operation without issuing another request",
    async (method) => {
      const file = fileOfSize();
      const session = sessionFor(file);
      const firstResponse = deferred<Response>();
      const fetcher = queuedFetcher(() => firstResponse.promise, response(201));
      const api = controlPlaneApi();
      vi.mocked(api.complete).mockResolvedValue({
        status: "SOURCE_READY",
        actualSizeBytes: file.size,
      });
      const uploader = createResumableUploader({
        fetcher: fetcher.fetcher,
        store: new MemoryUploadSessionStore(),
        api,
        now: () => NOW,
        random: () => 0,
        sleep: vi.fn(async () => undefined),
      });

      const running = uploader.start(file, session);
      await vi.waitFor(() => expect(fetcher.requests).toHaveLength(1));
      const overlapResult = await uploader[method](file, session).then(
        () => null,
        (error: unknown) => error,
      );
      firstResponse.resolve(response(201));
      await running;

      expect(overlapResult).toMatchObject({ code: "INVALID_REQUEST" });
      expect(fetcher.requests).toHaveLength(1);
    },
  );

  it.each(["start", "resume"] as const)(
    "rejects %s after the uploader reaches READY",
    async (method) => {
      const file = fileOfSize();
      const session = sessionFor(file);
      const fetcher = queuedFetcher(response(201), response(201));
      const api = controlPlaneApi();
      vi.mocked(api.complete).mockResolvedValue({
        status: "SOURCE_READY",
        actualSizeBytes: file.size,
      });
      const uploader = createResumableUploader({
        fetcher: fetcher.fetcher,
        store: new MemoryUploadSessionStore(),
        api,
        now: () => NOW,
        random: () => 0,
        sleep: vi.fn(async () => undefined),
      });
      await uploader.start(file, session);

      await expect(uploader[method](file, session)).rejects.toMatchObject({
        code: "INVALID_REQUEST",
      });

      expect(fetcher.requests).toHaveLength(1);
      expect(uploader.snapshot().phase).toBe("READY");
    },
  );

  it("pauses after acknowledging the active chunk and before the next chunk", async () => {
    const file = fileOfSize(8_388_609);
    const session = sessionFor(file);
    const store = new MemoryUploadSessionStore();
    const fetcher = queuedFetcher(() => {
      uploader.pause();
      return response(308, { Range: "bytes=0-8388607" });
    });
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api: controlPlaneApi(),
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });

    await uploader.start(file, session);

    expect(fetcher.requests).toHaveLength(1);
    expect(uploader.snapshot()).toMatchObject({
      phase: "PAUSED",
      committedBytes: 8_388_608,
    });
    await expect(store.get(session.projectId, session.artifactId)).resolves
      .toMatchObject({ nextOffset: 8_388_608 });
  });

  it("retains the capability when the cancellation API fails", async () => {
    const file = fileOfSize(8_388_609);
    const session = sessionFor(file);
    const store = new MemoryUploadSessionStore();
    const api = controlPlaneApi();
    vi.mocked(api.cancel).mockRejectedValue(
      new AppError("DRIVE_TEMPORARILY_UNAVAILABLE", 503),
    );
    const fetcher = queuedFetcher(() => {
      uploader.pause();
      return response(308, { Range: "bytes=0-8388607" });
    });
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });
    await uploader.start(file, session);

    await expect(uploader.cancel()).rejects.toMatchObject({
      code: "DRIVE_TEMPORARILY_UNAVAILABLE",
    });

    expect(await store.get(session.projectId, session.artifactId)).not.toBeNull();
    expect(uploader.snapshot()).toMatchObject({
      phase: "PAUSED_ERROR",
      publicCode: "DRIVE_TEMPORARILY_UNAVAILABLE",
    });
  });

  it("deletes the capability only after confirmed cancellation", async () => {
    const file = fileOfSize(8_388_609);
    const session = sessionFor(file);
    const store = new MemoryUploadSessionStore();
    const api = controlPlaneApi();
    vi.mocked(api.cancel).mockResolvedValue(undefined);
    const fetcher = queuedFetcher(() => {
      uploader.pause();
      return response(308, { Range: "bytes=0-8388607" });
    });
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });
    await uploader.start(file, session);

    await uploader.cancel();

    expect(api.cancel).toHaveBeenCalledWith(session.projectId, session.artifactId);
    expect(await store.get(session.projectId, session.artifactId)).toBeNull();
    expect(uploader.snapshot().phase).toBe("CANCELLED");
  });

  it("rejects resume while confirmed cancellation is still in progress", async () => {
    const file = fileOfSize();
    const session = sessionFor(file);
    const store = new MemoryUploadSessionStore();
    const cancellationResponse = deferred<void>();
    const api = controlPlaneApi();
    vi.mocked(api.cancel).mockReturnValue(cancellationResponse.promise);
    vi.mocked(api.complete).mockResolvedValue({
      status: "SOURCE_READY",
      actualSizeBytes: file.size,
    });
    const fetcher = queuedFetcher(
      () => new Promise<Response>((_resolve, reject) => {
        fetcher.requests.at(-1)?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        }, { once: true });
      }),
      response(201),
    );
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });
    const running = uploader.start(file, session);
    await vi.waitFor(() => expect(fetcher.requests).toHaveLength(1));

    const cancellation = uploader.cancel();
    await vi.waitFor(() => expect(api.cancel).toHaveBeenCalledOnce());
    const resumeResult = await uploader.resume(file, session).then(
      () => null,
      (error: unknown) => error,
    );
    cancellationResponse.resolve();
    await cancellation;
    await running;

    expect(resumeResult).toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetcher.requests).toHaveLength(1);
    expect(await store.get(session.projectId, session.artifactId)).toBeNull();
    expect(uploader.snapshot().phase).toBe("CANCELLED");
  });

  it("deletes after an in-flight acknowledgement write during cancellation", async () => {
    const file = fileOfSize(8_388_609);
    const session = sessionFor(file);
    const store = new MemoryUploadSessionStore();
    const writeGate = deferred<void>();
    const originalPut = store.put.bind(store);
    let putCount = 0;
    vi.spyOn(store, "put").mockImplementation(async (record) => {
      putCount += 1;
      if (putCount === 2) await writeGate.promise;
      await originalPut(record);
    });
    const api = controlPlaneApi();
    vi.mocked(api.cancel).mockResolvedValue(undefined);
    const fetcher = queuedFetcher(response(308, { Range: "bytes=0-8388607" }));
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });
    const running = uploader.start(file, session);
    await vi.waitFor(() => expect(store.put).toHaveBeenCalledTimes(2));

    let cancellationSettled = false;
    const cancellation = uploader.cancel().finally(() => {
      cancellationSettled = true;
    });
    await vi.waitFor(() => expect(api.cancel).toHaveBeenCalledOnce());

    expect(cancellationSettled).toBe(false);
    writeGate.resolve();
    await cancellation;
    await running;

    expect(await store.get(session.projectId, session.artifactId)).toBeNull();
    expect(uploader.snapshot().phase).toBe("CANCELLED");
  });

  it("rejects cancellation after SOURCE_READY is claimed during store deletion", async () => {
    const file = fileOfSize();
    const session = sessionFor(file);
    const store = new MemoryUploadSessionStore();
    const deleteGate = deferred<void>();
    const originalDelete = store.delete.bind(store);
    vi.spyOn(store, "delete").mockImplementation(async (projectId, artifactId) => {
      await deleteGate.promise;
      await originalDelete(projectId, artifactId);
    });
    const api = controlPlaneApi();
    vi.mocked(api.complete).mockResolvedValue({
      status: "SOURCE_READY",
      actualSizeBytes: file.size,
    });
    vi.mocked(api.cancel).mockRejectedValue(
      new AppError("DRIVE_TEMPORARILY_UNAVAILABLE", 503),
    );
    const uploader = createResumableUploader({
      fetcher: queuedFetcher(response(201)).fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });
    const phases: string[] = [];
    uploader.subscribe((snapshot) => phases.push(snapshot.phase));

    const running = uploader.start(file, session);
    await vi.waitFor(() => expect(store.delete).toHaveBeenCalledOnce());
    const cancelResult = await uploader.cancel().then(
      () => null,
      (error: unknown) => error,
    );
    deleteGate.resolve();
    await running;

    expect(cancelResult).toMatchObject({ code: "INVALID_REQUEST" });
    expect(api.cancel).not.toHaveBeenCalled();
    expect(phases).not.toContain("PAUSED_ERROR");
    expect(phases.filter((phase) => phase === "READY" || phase === "CANCELLED"))
      .toEqual(["READY"]);
    expect(await store.get(session.projectId, session.artifactId)).toBeNull();
    expect(uploader.snapshot().phase).toBe("READY");
  });

  it("keeps READY when an earlier concurrent cancellation later rejects", async () => {
    const file = fileOfSize();
    const session = sessionFor(file);
    const store = new MemoryUploadSessionStore();
    const completionResponse = deferred<Readonly<{
      status: "SOURCE_READY";
      actualSizeBytes: number;
    }>>();
    const cancellationResponse = deferred<void>();
    const api = controlPlaneApi();
    vi.mocked(api.complete).mockReturnValue(completionResponse.promise);
    vi.mocked(api.cancel).mockReturnValue(cancellationResponse.promise);
    const deleteSpy = vi.spyOn(store, "delete");
    const uploader = createResumableUploader({
      fetcher: queuedFetcher(response(201)).fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });
    const phases: string[] = [];
    uploader.subscribe((snapshot) => phases.push(snapshot.phase));

    const running = uploader.start(file, session);
    await vi.waitFor(() => expect(api.complete).toHaveBeenCalledOnce());
    const cancellation = uploader.cancel().then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(api.cancel).toHaveBeenCalledOnce());
    completionResponse.resolve({ status: "SOURCE_READY", actualSizeBytes: file.size });
    await Promise.resolve();
    await Promise.resolve();
    cancellationResponse.reject(new AppError("DRIVE_TEMPORARILY_UNAVAILABLE", 503));

    const cancellationResult = await cancellation;
    await running;

    expect(cancellationResult).toBeNull();
    expect(deleteSpy).toHaveBeenCalledOnce();
    expect(phases).not.toContain("PAUSED_ERROR");
    expect(phases.filter((phase) => phase === "READY" || phase === "CANCELLED"))
      .toEqual(["READY"]);
    expect(await store.get(session.projectId, session.artifactId)).toBeNull();
    expect(uploader.snapshot().phase).toBe("READY");
  });

  it("keeps confirmed cancellation when stale SOURCE_READY arrives later", async () => {
    const file = fileOfSize();
    const session = sessionFor(file);
    const store = new MemoryUploadSessionStore();
    const completionResponse = deferred<Readonly<{
      status: "SOURCE_READY";
      actualSizeBytes: number;
    }>>();
    const api = controlPlaneApi();
    vi.mocked(api.complete).mockReturnValue(completionResponse.promise);
    vi.mocked(api.cancel).mockResolvedValue(undefined);
    const deleteSpy = vi.spyOn(store, "delete");
    const uploader = createResumableUploader({
      fetcher: queuedFetcher(response(201)).fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });
    const phases: string[] = [];
    uploader.subscribe((snapshot) => phases.push(snapshot.phase));

    const running = uploader.start(file, session);
    await vi.waitFor(() => expect(api.complete).toHaveBeenCalledOnce());
    await uploader.cancel();
    completionResponse.resolve({ status: "SOURCE_READY", actualSizeBytes: file.size });
    await running;

    expect(deleteSpy).toHaveBeenCalledOnce();
    expect(phases).not.toContain("READY");
    expect(phases.filter((phase) => phase === "READY" || phase === "CANCELLED"))
      .toEqual(["CANCELLED"]);
    expect(await store.get(session.projectId, session.artifactId)).toBeNull();
    expect(uploader.snapshot().phase).toBe("CANCELLED");
  });

  it("keeps READY terminal when capability cleanup rejects", async () => {
    const file = fileOfSize();
    const session = sessionFor(file);
    const store = new MemoryUploadSessionStore();
    vi.spyOn(store, "delete").mockRejectedValue(new Error("synthetic cleanup failure"));
    const api = controlPlaneApi();
    vi.mocked(api.complete).mockResolvedValue({
      status: "SOURCE_READY",
      actualSizeBytes: file.size,
    });
    const uploader = createResumableUploader({
      fetcher: queuedFetcher(response(201)).fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });

    await expect(uploader.start(file, session)).rejects.toMatchObject({
      code: "DRIVE_TEMPORARILY_UNAVAILABLE",
    });

    expect(uploader.snapshot().phase).toBe("READY");
    await expect(uploader.start(file, session)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });

  it("keeps confirmed cancellation terminal and reports capability cleanup rejection", async () => {
    const file = fileOfSize();
    const session = sessionFor(file);
    const store = new MemoryUploadSessionStore();
    vi.spyOn(store, "delete").mockRejectedValue(new Error("synthetic cleanup failure"));
    const uploadResponse = deferred<Response>();
    const fetcher = queuedFetcher(() => uploadResponse.promise);
    const api = controlPlaneApi();
    vi.mocked(api.cancel).mockResolvedValue(undefined);
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });
    const running = uploader.start(file, session);
    await vi.waitFor(() => expect(fetcher.requests).toHaveLength(1));

    await expect(uploader.cancel()).rejects.toMatchObject({
      code: "DRIVE_TEMPORARILY_UNAVAILABLE",
    });
    uploadResponse.resolve(response(201));
    await running;

    expect(uploader.snapshot().phase).toBe("CANCELLED");
    await expect(uploader.resume(file, session)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });

  it("notifies subscribers with sanitized snapshots and honors unsubscribe", async () => {
    const file = fileOfSize();
    const session = sessionFor(file);
    const fetcher = queuedFetcher(response(201), response(201));
    const api = controlPlaneApi();
    vi.mocked(api.complete).mockResolvedValue({
      status: "SOURCE_READY",
      actualSizeBytes: file.size,
    });
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store: new MemoryUploadSessionStore(),
      api,
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });
    const listener = vi.fn();
    const unsubscribe = uploader.subscribe(listener);

    await uploader.start(file, session);

    expect(listener.mock.calls.map(([snapshot]) => snapshot.phase)).toEqual([
      "UPLOADING",
      "VERIFYING",
      "READY",
    ]);
    expect(listener.mock.calls.every(([snapshot]) => !JSON.stringify(snapshot).includes("upload_id")))
      .toBe(true);

    unsubscribe();
    const callCount = listener.mock.calls.length;
    await expect(uploader.start(file, session)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(listener).toHaveBeenCalledTimes(callCount);
  });

  it("keeps session capabilities out of snapshots, errors, and console output", async () => {
    const file = fileOfSize();
    const session = sessionFor(file);
    const fetcher = queuedFetcher(new TypeError(`Failed for ${session.sessionUri}`));
    const api = controlPlaneApi();
    vi.mocked(api.complete).mockRejectedValue(new Error(`provider upload_id from ${session.sessionUri}`));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store: new MemoryUploadSessionStore(),
      api,
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });

    let caught: unknown;
    try {
      await uploader.start(file, session);
    } catch (error) {
      caught = error;
    }

    const exposed = JSON.stringify({
      snapshot: uploader.snapshot(),
      error: caught instanceof Error
        ? { name: caught.name, message: caught.message, code: "code" in caught ? caught.code : null }
        : caught,
    });
    expect(exposed).not.toContain(session.sessionUri);
    expect(exposed).not.toContain("upload_id");
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });

  it("aborts the active Drive request and clears listeners on disposal", async () => {
    const file = fileOfSize();
    const session = sessionFor(file);
    const store = new MemoryUploadSessionStore();
    const fetcher = queuedFetcher(() => new Promise<Response>((_resolve, reject) => {
      const signal = fetcher.requests.at(-1)?.signal;
      signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted", "AbortError"));
      }, { once: true });
    }));
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api: controlPlaneApi(),
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });
    const listener = vi.fn();
    uploader.subscribe(listener);

    const running = uploader.start(file, session);
    await vi.waitFor(() => expect(fetcher.requests).toHaveLength(1));
    const signal = fetcher.requests[0]!.signal;
    const listenerCalls = listener.mock.calls.length;
    uploader.dispose();
    await running;

    expect(signal?.aborted).toBe(true);
    expect(listener).toHaveBeenCalledTimes(listenerCalls);
    expect(await store.get(session.projectId, session.artifactId)).not.toBeNull();
  });

  it("stops a pending retry timer on disposal without another request", async () => {
    const file = fileOfSize();
    const session = sessionFor(file);
    const store = new MemoryUploadSessionStore();
    const fetcher = queuedFetcher(response(429));
    const sleep = vi.fn(() => new Promise<void>(() => undefined));
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api: controlPlaneApi(),
      now: () => NOW,
      random: () => 0,
      sleep,
    });
    let settled = false;
    const running = uploader.start(file, session).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledOnce());

    uploader.dispose();

    await vi.waitFor(() => expect(settled).toBe(true));
    await running;
    expect(fetcher.requests).toHaveLength(1);
    expect(await store.get(session.projectId, session.artifactId)).not.toBeNull();
  });

  it("aborts an active chunk before confirmed cancellation", async () => {
    const file = fileOfSize();
    const session = sessionFor(file);
    const store = new MemoryUploadSessionStore();
    const api = controlPlaneApi();
    vi.mocked(api.cancel).mockResolvedValue(undefined);
    const fetcher = queuedFetcher(() => new Promise<Response>((_resolve, reject) => {
      fetcher.requests.at(-1)?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted", "AbortError"));
      }, { once: true });
    }));
    const uploader = createResumableUploader({
      fetcher: fetcher.fetcher,
      store,
      api,
      now: () => NOW,
      random: () => 0,
      sleep: vi.fn(async () => undefined),
    });
    const running = uploader.start(file, session);
    await vi.waitFor(() => expect(fetcher.requests).toHaveLength(1));
    const signal = fetcher.requests[0]!.signal;

    await uploader.cancel();
    await running;

    expect(signal?.aborted).toBe(true);
    expect(api.complete).not.toHaveBeenCalled();
    expect(await store.get(session.projectId, session.artifactId)).toBeNull();
    expect(uploader.snapshot().phase).toBe("CANCELLED");
  });
});
