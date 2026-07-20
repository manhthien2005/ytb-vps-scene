import type { StoredUploadSession, UploadSessionStore } from "./upload-store";
import { AppError } from "../domain/errors";
import { nextRetry, parseAcknowledgedRange } from "../domain/upload";

function snapshotSession(record: StoredUploadSession): StoredUploadSession {
  return {
    projectId: record.projectId,
    artifactId: record.artifactId,
    sessionUri: record.sessionUri,
    fileIdentity: {
      displayName: record.fileIdentity.displayName,
      sizeBytes: record.fileIdentity.sizeBytes,
      mimeType: record.fileIdentity.mimeType,
      lastModified: record.fileIdentity.lastModified,
    },
    nextOffset: record.nextOffset,
    chunkBytes: record.chunkBytes,
    expiresAt: record.expiresAt,
  };
}

function validDriveSessionUri(value: string): boolean {
  if (value.length < 1 || value.length > 4_096 || !/^[\x20-\x7E]+$/.test(value)) return false;
  try {
    const uri = new URL(value);
    const query = [...uri.searchParams.entries()];
    const uploadIds = uri.searchParams.getAll("upload_id");
    return uri.protocol === "https:" &&
      uri.hostname === "www.googleapis.com" &&
      uri.port === "" &&
      uri.username === "" &&
      uri.password === "" &&
      uri.hash === "" &&
      /^\/upload\/drive\/v3\/files\/[^/]+$/.test(uri.pathname) &&
      query.length === 1 &&
      query[0]?.[0] === "upload_id" &&
      uploadIds.length === 1 &&
      uploadIds[0] !== undefined &&
      uploadIds[0].length >= 1 &&
      uploadIds[0].length <= 2_048 &&
      /^[\x20-\x7E]+$/.test(uploadIds[0]);
  } catch {
    return false;
  }
}

function validFutureExpiration(value: string, now: number): boolean {
  if (value.length !== 24) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString() === value &&
    parsed.getTime() > now;
}

function retryableControlPlaneError(error: unknown): boolean {
  return !(error instanceof AppError) ||
    error.code === "DRIVE_RATE_LIMITED" ||
    error.code === "DRIVE_TEMPORARILY_UNAVAILABLE";
}

export type UploadSnapshot = Readonly<{
  phase:
    | "IDLE"
    | "UPLOADING"
    | "PAUSED"
    | "PAUSED_ERROR"
    | "VERIFYING"
    | "PAUSED_VERIFYING"
    | "READY"
    | "CANCELLED";
  committedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  publicCode: string | null;
}>;

export interface UploadControlPlaneApi {
  renewSession(
    projectId: string,
    identity: StoredUploadSession["fileIdentity"],
  ): Promise<
    | Pick<StoredUploadSession, "artifactId" | "sessionUri" | "chunkBytes" | "expiresAt">
    | Readonly<{ artifactId: string; status: "SOURCE_READY"; actualSizeBytes: number }>
  >;
  complete(
    projectId: string,
    artifactId: string,
  ): Promise<
    | Readonly<{ status: "SOURCE_READY"; actualSizeBytes: number }>
    | Readonly<{ status: "UPLOAD_PENDING"; retryAfterMs: 1_000 }>
  >;
  cancel(projectId: string, artifactId: string): Promise<void>;
}

export type ResumableUploaderDependencies = Readonly<{
  fetcher: typeof fetch;
  store: UploadSessionStore;
  api: UploadControlPlaneApi;
  now: () => number;
  random: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}>;

export interface ResumableUploader {
  start(file: File, session: StoredUploadSession): Promise<void>;
  resume(file: File, session: StoredUploadSession): Promise<void>;
  pause(): void;
  cancel(): Promise<void>;
  subscribe(listener: (value: UploadSnapshot) => void): () => void;
  dispose(): void;
  snapshot(): UploadSnapshot;
}

export function createResumableUploader(
  dependencies: ResumableUploaderDependencies,
): ResumableUploader {
  let terminalOutcome: "READY" | "CANCELLED" | null = null;
  let value: UploadSnapshot = {
    phase: "IDLE",
    committedBytes: 0,
    totalBytes: 0,
    bytesPerSecond: 0,
    publicCode: null,
  };
  let pauseRequested = false;
  let currentRecord: StoredUploadSession | null = null;
  let activeController: AbortController | null = null;
  let activeStoreWrite: Promise<void> | null = null;
  let disposed = false;
  let cancelRequested = false;
  let runActive = false;
  let cancelInProgress = false;
  const listeners = new Set<(snapshot: UploadSnapshot) => void>();
  const waitInterruptors = new Set<() => void>();

  function publish(next: UploadSnapshot): void {
    if (terminalOutcome !== null && next.phase !== terminalOutcome) return;
    value = next;
    for (const listener of listeners) {
      try {
        listener(value);
      } catch {
        // A view listener cannot alter upload correctness or error handling.
      }
    }
  }

  async function driveFetch(input: string, init: RequestInit): Promise<Response> {
    if (!validDriveSessionUri(input)) throw new AppError("UPLOAD_REMOTE_MISMATCH", 409);
    if (disposed) throw new DOMException("The operation was aborted", "AbortError");
    const controller = new AbortController();
    activeController = controller;
    try {
      return await dependencies.fetcher(input, { ...init, signal: controller.signal });
    } finally {
      if (activeController === controller) activeController = null;
    }
  }

  function interruptWaiters(): void {
    for (const interrupt of [...waitInterruptors]) interrupt();
  }

  function waitForRetry(milliseconds: number): Promise<void> {
    if (disposed || pauseRequested) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const interrupt = () => {
        waitInterruptors.delete(interrupt);
        resolve();
      };
      waitInterruptors.add(interrupt);
      dependencies.sleep(milliseconds).then(
        () => {
          waitInterruptors.delete(interrupt);
          resolve();
        },
        (error: unknown) => {
          waitInterruptors.delete(interrupt);
          reject(error);
        },
      );
    });
  }

  async function persist(record: StoredUploadSession): Promise<void> {
    const write = dependencies.store.put(snapshotSession(record));
    activeStoreWrite = write;
    try {
      await write;
    } finally {
      if (activeStoreWrite === write) activeStoreWrite = null;
    }
  }

  async function run(
    file: File,
    initial: StoredUploadSession,
    recovering: boolean,
  ): Promise<void> {
    if (
      disposed ||
      runActive ||
      cancelInProgress ||
      terminalOutcome !== null
    ) {
      throw new AppError("INVALID_REQUEST", 400);
    }
    runActive = true;
    const initialRecord = snapshotSession(initial);
    pauseRequested = false;
    cancelRequested = false;
    publish({
      phase: "UPLOADING",
      committedBytes: initialRecord.nextOffset,
      totalBytes: file.size,
      bytesPerSecond: 0,
      publicCode: null,
    });
    let verifying = false;
    try {
      if (disposed) throw new AppError("INVALID_REQUEST", 400);
      if (
        file.name !== initialRecord.fileIdentity.displayName ||
        file.size !== initialRecord.fileIdentity.sizeBytes ||
        file.type !== initialRecord.fileIdentity.mimeType ||
        file.lastModified !== initialRecord.fileIdentity.lastModified ||
        !validDriveSessionUri(initialRecord.sessionUri)
      ) {
        throw new AppError("UPLOAD_REMOTE_MISMATCH", 409);
      }
      currentRecord = initialRecord;
      let record = initialRecord;
      let failedAttempts = 0;
      const locallyExpired = Date.parse(record.expiresAt) <= dependencies.now();
      let action: "UPLOAD" | "COMPLETE" | "QUERY" | "RENEW" = record.nextOffset === file.size
        ? "COMPLETE"
        : locallyExpired ? "RENEW" : recovering ? "QUERY" : "UPLOAD";
      verifying = action === "COMPLETE";

    async function recordFailure(): Promise<void> {
      failedAttempts += 1;
      const retry = nextRetry(failedAttempts, dependencies.random());
      if (retry.kind === "EXHAUSTED") {
        const code = "UPLOAD_RETRY_EXHAUSTED";
        publish({
          ...value,
          phase: verifying ? "PAUSED_VERIFYING" : "PAUSED_ERROR",
          publicCode: code,
        });
        throw new AppError(code, 503);
      }
      await waitForRetry(retry.delayMs);
    }

      if (locallyExpired && action === "RENEW") {
        await recordFailure();
      } else if (!locallyExpired) {
        await persist(initialRecord);
      }

      while (true) {
      if (cancelRequested) return;
      if (pauseRequested) {
        publish({
          ...value,
          phase: verifying ? "PAUSED_VERIFYING" : "PAUSED",
        });
        return;
      }
      if (action === "UPLOAD") {
        const endExclusive = Math.min(record.nextOffset + record.chunkBytes, file.size);
        const isFinalChunk = endExclusive === file.size;
        const headers = new Headers({
          "content-range": `bytes ${record.nextOffset}-${endExclusive - 1}/${file.size}`,
          "content-type": file.type,
        });
        let upload: Response | null = null;
        try {
          upload = await driveFetch(record.sessionUri, {
            method: "PUT",
            headers,
            body: file.slice(record.nextOffset, endExclusive, file.type),
          });
        } catch (error) {
          if (error instanceof AppError) throw error;
          if (disposed || cancelRequested) return;
          if (isFinalChunk) {
            // A rejected final request can mean Drive committed the bytes but
            // its CORS response was hidden. Server metadata is authoritative.
            verifying = true;
            action = "COMPLETE";
            continue;
          }
          await recordFailure();
          action = "QUERY";
          continue;
        }
        if (cancelRequested) return;
        if (upload?.status === 308) {
          const nextOffset = parseAcknowledgedRange(upload.headers.get("range"));
          if (nextOffset < record.nextOffset || nextOffset > endExclusive) {
            throw new AppError("UPLOAD_REMOTE_MISMATCH", 409);
          }
          if (nextOffset === record.nextOffset) {
            await recordFailure();
            action = "QUERY";
            continue;
          }
          record = { ...record, nextOffset };
          await persist(record);
          if (disposed || cancelRequested) return;
          failedAttempts = 0;
          currentRecord = record;
          publish({ ...value, committedBytes: nextOffset });
          action = nextOffset === file.size ? "COMPLETE" : "UPLOAD";
          verifying = action === "COMPLETE";
          continue;
        }
        if (upload !== null && upload.status >= 500) {
          await recordFailure();
          action = "QUERY";
          continue;
        }
        if (upload?.status === 429) {
          await recordFailure();
          action = "UPLOAD";
          continue;
        }
        if (upload !== null && upload.status >= 400 && upload.status < 500) {
          await recordFailure();
          action = "RENEW";
          continue;
        }
        const hiddenFinalResponse = upload?.status === 0 || upload?.type === "opaque";
        if (
          !isFinalChunk ||
          (
            upload !== null &&
            upload.status !== 200 &&
            upload.status !== 201 &&
            !hiddenFinalResponse
          )
        ) {
          throw new AppError("UPLOAD_REMOTE_MISMATCH", 409);
        }
        verifying = true;
        action = "COMPLETE";
        continue;
      }

      if (action === "RENEW") {
        let renewed: Awaited<ReturnType<UploadControlPlaneApi["renewSession"]>>;
        try {
          renewed = await dependencies.api.renewSession(
            record.projectId,
            { ...record.fileIdentity },
          );
        } catch (error) {
          if (disposed || cancelRequested) return;
          if (!retryableControlPlaneError(error)) throw error;
          await recordFailure();
          action = "RENEW";
          continue;
        }
        if (cancelRequested) return;
        if ("status" in renewed) {
          const terminal = Object.freeze({
            artifactId: renewed.artifactId,
            status: renewed.status,
            actualSizeBytes: renewed.actualSizeBytes,
          });
          if (
            terminal.artifactId !== record.artifactId ||
            terminal.status !== "SOURCE_READY" ||
            terminal.actualSizeBytes !== file.size
          ) {
            throw new AppError("UPLOAD_REMOTE_MISMATCH", 409);
          }
          if (terminalOutcome === "CANCELLED") return;
          terminalOutcome = "READY";
          currentRecord = null;
          publish({
            ...value,
            phase: "READY",
            committedBytes: terminal.actualSizeBytes,
            bytesPerSecond: 0,
          });
          await dependencies.store.delete(record.projectId, record.artifactId);
          return;
        }
        const renewedSnapshot = Object.freeze({
          artifactId: renewed.artifactId,
          sessionUri: renewed.sessionUri,
          chunkBytes: renewed.chunkBytes,
          expiresAt: renewed.expiresAt,
        });
        if (
          renewedSnapshot.artifactId !== record.artifactId ||
          renewedSnapshot.chunkBytes !== 8_388_608 ||
          !validDriveSessionUri(renewedSnapshot.sessionUri) ||
          !validFutureExpiration(renewedSnapshot.expiresAt, dependencies.now())
        ) {
          throw new AppError("UPLOAD_REMOTE_MISMATCH", 409);
        }
        record = {
          projectId: record.projectId,
          artifactId: renewedSnapshot.artifactId,
          sessionUri: renewedSnapshot.sessionUri,
          fileIdentity: record.fileIdentity,
          nextOffset: 0,
          chunkBytes: renewedSnapshot.chunkBytes,
          expiresAt: renewedSnapshot.expiresAt,
        };
        await persist(record);
        if (disposed || cancelRequested) return;
        currentRecord = record;
        publish({
          ...value,
          phase: "UPLOADING",
          committedBytes: 0,
          bytesPerSecond: 0,
        });
        verifying = false;
        action = "UPLOAD";
        continue;
      }

      if (action === "COMPLETE") {
        publish({ ...value, phase: "VERIFYING" });
        let completion: Awaited<ReturnType<UploadControlPlaneApi["complete"]>>;
        try {
          completion = await dependencies.api.complete(record.projectId, record.artifactId);
        } catch (error) {
          if (disposed || cancelRequested) return;
          if (!retryableControlPlaneError(error)) throw error;
          await recordFailure();
          action = "COMPLETE";
          continue;
        }
        if (completion.status === "SOURCE_READY") {
          if (completion.actualSizeBytes !== file.size) {
            throw new AppError("UPLOAD_REMOTE_MISMATCH", 409);
          }
          if (terminalOutcome === "CANCELLED") return;
          terminalOutcome = "READY";
          currentRecord = null;
          publish({
            ...value,
            phase: "READY",
            committedBytes: completion.actualSizeBytes,
          });
          await dependencies.store.delete(record.projectId, record.artifactId);
          return;
        }
        if (cancelRequested) return;
        await recordFailure();
        action = "QUERY";
        continue;
      }

      let query: Response;
      try {
        query = await driveFetch(record.sessionUri, {
          method: "PUT",
          headers: new Headers({ "content-range": `*/${file.size}` }),
        });
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (disposed || cancelRequested) return;
        await recordFailure();
        action = verifying ? "COMPLETE" : "QUERY";
        continue;
      }
      if (cancelRequested) return;
      if (query.status === 0 || query.type === "opaque") {
        await recordFailure();
        action = verifying ? "COMPLETE" : "QUERY";
        continue;
      }
      if (query.status === 429) {
        await recordFailure();
        action = "QUERY";
        continue;
      }
      if (query.status >= 500) {
        await recordFailure();
        action = "QUERY";
        continue;
      }
      if (query.status === 200 || query.status === 201) {
        verifying = true;
        action = "COMPLETE";
        continue;
      }
      if (query.status >= 400 && query.status < 500) {
        await recordFailure();
        action = "RENEW";
        continue;
      }
      if (query.status !== 308) throw new AppError("UPLOAD_REMOTE_MISMATCH", 409);
      const previousOffset = record.nextOffset;
      const nextOffset = parseAcknowledgedRange(query.headers.get("range"));
      if (nextOffset > file.size) throw new AppError("UPLOAD_REMOTE_MISMATCH", 409);
      record = { ...record, nextOffset };
      await persist(record);
      if (disposed || cancelRequested) return;
      if (nextOffset > previousOffset) failedAttempts = 0;
      currentRecord = record;
      action = nextOffset === file.size ? "COMPLETE" : "UPLOAD";
      verifying = action === "COMPLETE";
      publish({
        ...value,
        phase: verifying ? "VERIFYING" : "UPLOADING",
        committedBytes: nextOffset,
      });
      }
    } catch (error) {
      if ((disposed || cancelRequested) && terminalOutcome === null) return;
      const safeError = error instanceof AppError
        ? error
        : new AppError("DRIVE_TEMPORARILY_UNAVAILABLE", 503);
      if (value.phase !== "PAUSED_ERROR" && value.phase !== "PAUSED_VERIFYING") {
        publish({
          ...value,
          phase: "PAUSED_ERROR",
          publicCode: safeError.code,
        });
      }
      throw safeError;
    } finally {
      runActive = false;
    }
  }

  return {
    start(file, session) {
      return run(file, session, false);
    },

    resume(file, session) {
      return run(file, session, true);
    },

    pause() {
      if (value.phase === "UPLOADING" || value.phase === "VERIFYING") {
        pauseRequested = true;
        interruptWaiters();
      }
    },

    async cancel() {
      if (currentRecord === null || cancelInProgress || disposed || terminalOutcome !== null) {
        throw new AppError("INVALID_REQUEST", 400);
      }
      const record = currentRecord;
      cancelInProgress = true;
      pauseRequested = true;
      cancelRequested = true;
      interruptWaiters();
      activeController?.abort();
      let claimedCancellation = false;
      try {
        await dependencies.api.cancel(record.projectId, record.artifactId);
        if (terminalOutcome !== null) return;
        terminalOutcome = "CANCELLED";
        claimedCancellation = true;
        currentRecord = null;
        publish({
          ...value,
          phase: "CANCELLED",
          publicCode: null,
        });
        const pendingWrite = activeStoreWrite;
        if (pendingWrite !== null) await pendingWrite.catch(() => undefined);
        await dependencies.store.delete(record.projectId, record.artifactId);
      } catch (error) {
        if (terminalOutcome !== null && !claimedCancellation) return;
        const safeError = error instanceof AppError
          ? error
          : new AppError("DRIVE_TEMPORARILY_UNAVAILABLE", 503);
        if (!claimedCancellation) {
          publish({
            ...value,
            phase: "PAUSED_ERROR",
            publicCode: safeError.code,
          });
        }
        throw safeError;
      } finally {
        cancelInProgress = false;
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    dispose() {
      disposed = true;
      pauseRequested = true;
      listeners.clear();
      activeController?.abort();
      activeController = null;
      interruptWaiters();
    },

    snapshot() {
      return value;
    },
  };
}
