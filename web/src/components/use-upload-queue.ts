"use client";

import { useEffect, useRef, useState } from "react";
import {
  createResumableUploader,
  type ResumableUploader,
  type ResumableUploaderDependencies,
  type UploadControlPlaneApi,
  type UploadSnapshot,
} from "@/lib/browser/resumable-uploader";
import { createDriveUploadFetcher } from "@/lib/browser/drive-upload-fetcher";
import {
  createUploadSessionStore,
  type StoredUploadSession,
  type UploadSessionStore,
} from "@/lib/browser/upload-store";
import {
  canonicalUploadFileName,
  uploadMimeTypeForFileName,
  videoTitleFromFileName,
} from "@/lib/domain/upload-filename";
import type { PublicProject } from "./dashboard-types";

const VI_MESSAGES: Readonly<Record<string, string>> = {
  DRIVE_NOT_CONNECTED: "Hãy kết nối Google Drive trước.",
  DRIVE_REAUTH_REQUIRED: "Google Drive cần được kết nối lại.",
  DRIVE_ACCOUNT_MISMATCH: "Tài khoản Drive không khớp với dữ liệu hiện có.",
  DRIVE_PROVIDER_REJECTED: "Google Drive từ chối phiên tải lên; hệ thống đã mở lại để anh thử lại.",
  DRIVE_TEMPORARILY_UNAVAILABLE: "Google Drive đang bận hoặc tạm thời không phản hồi; tiến trình sẽ được giữ để thử lại.",
  UPLOAD_REMOTE_MISMATCH: "File nguồn trên Drive không khớp; hãy chọn lại video và thử lại.",
  DRIVE_QUOTA_STALE: "Chưa xác minh được dung lượng Google Drive.",
  DRIVE_STORAGE_HIGH: "Google Drive đã chạm ngưỡng an toàn 90%.",
  NEON_STORAGE_HIGH: "Cơ sở dữ liệu đã chạm ngưỡng an toàn 90%.",
  UPLOAD_SESSION_EXPIRED: "Phiên tải lên đã hết hạn; hệ thống sẽ tạo phiên mới.",
  UPLOAD_RETRY_EXHAUSTED: "Đường truyền chưa ổn định. Tiến trình đã được giữ để thử lại.",
  UPLOAD_TOO_LARGE: "Video vượt quá giới hạn 10 GiB.",
  UPLOAD_TYPE_REJECTED: "Chỉ nhận video MP4, MOV, MKV hoặc WEBM.",
  UPLOAD_LOCAL_CLEANUP_FAILED: "Chưa thể dọn phiên tải cục bộ. Hãy bấm Dừng và huỷ để thử lại.",
};

const EMPTY_SNAPSHOT: UploadSnapshot = {
  phase: "IDLE",
  committedBytes: 0,
  totalBytes: 0,
  bytesPerSecond: 0,
  publicCode: null,
};

export type UploadQueueItem = Readonly<{
  id: string;
  file: File;
  mimeType: string;
  title: string;
  projectId: string | null;
  artifactId: string | null;
  snapshot: UploadSnapshot;
  message: string | null;
  state: "QUEUED" | "ACTIVE" | "DONE" | "FAILED" | "CANCELLED";
}>;

export type UploadQueueController = Readonly<{
  items: readonly UploadQueueItem[];
  recoveries: readonly StoredUploadSession[];
  diagnostic: string | null;
  enqueueFiles(files: FileList | readonly File[]): void;
  pause(id: string): void;
  resume(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
  retry(id: string): Promise<void>;
}>;

type UseUploadQueueOptions = Readonly<{
  disabled: boolean;
  projects: readonly PublicProject[];
  fetcher?: typeof fetch;
  store?: UploadSessionStore;
  uploaderFactory?: (dependencies: ResumableUploaderDependencies) => ResumableUploader;
  onProjectsChange?: (projects: readonly PublicProject[]) => void;
  onSourceFile?: (projectId: string, file: File) => void;
}>;

type PendingCancellation = Readonly<{
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}>;

export function uploadMessageForCode(code: string | null): string | null {
  return code === null ? null : VI_MESSAGES[code] ?? "Tác vụ chưa thể hoàn tất. Anh có thể thử lại.";
}

function fileIdentity(file: File, mimeType: string): StoredUploadSession["fileIdentity"] | null {
  const displayName = canonicalUploadFileName(file.name);
  if (displayName === null) return null;
  return { displayName, sizeBytes: file.size, mimeType, lastModified: file.lastModified };
}

function matchingRecovery(
  recoveries: readonly StoredUploadSession[],
  file: File,
  mimeType: string,
): StoredUploadSession | null {
  const identity = fileIdentity(file, mimeType);
  if (identity === null) return null;
  const matches = recoveries.filter((record) => (
    record.fileIdentity.displayName === identity.displayName &&
    record.fileIdentity.sizeBytes === identity.sizeBytes &&
    record.fileIdentity.mimeType === identity.mimeType &&
    record.fileIdentity.lastModified === identity.lastModified
  ));
  return matches.length === 1 ? matches[0]! : null;
}

function idempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function jsonRequest(fetcher: typeof fetch, url: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetcher(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const value = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof value.code === "string" ? value.code : "INTERNAL_ERROR");
  return value;
}

function controlPlaneApi(fetcher: typeof fetch): UploadControlPlaneApi {
  return {
    async renewSession(projectId, identity) {
      return await jsonRequest(fetcher, `/api/v1/projects/${projectId}/upload-session`, {
        fileName: identity.displayName,
        mimeType: identity.mimeType,
        sizeBytes: identity.sizeBytes,
        lastModified: identity.lastModified,
      }) as Awaited<ReturnType<UploadControlPlaneApi["renewSession"]>>;
    },
    async complete(projectId, artifactId) {
      return await jsonRequest(fetcher, `/api/v1/projects/${projectId}/upload-complete`, { artifactId }) as Awaited<ReturnType<UploadControlPlaneApi["complete"]>>;
    },
    async cancel(projectId, artifactId) {
      await jsonRequest(fetcher, `/api/v1/projects/${projectId}/upload-cancel`, { artifactId });
    },
  };
}

export function useUploadQueue({
  disabled,
  projects: initialProjects,
  fetcher = globalThis.fetch,
  store: providedStore,
  uploaderFactory = createResumableUploader,
  onProjectsChange = () => undefined,
  onSourceFile = () => undefined,
}: UseUploadQueueOptions): UploadQueueController {
  const [store] = useState<UploadSessionStore | null>(() => (
    providedStore ?? (typeof indexedDB === "undefined" ? null : createUploadSessionStore())
  ));
  const [items, setItems] = useState<readonly UploadQueueItem[]>([]);
  const itemsRef = useRef<readonly UploadQueueItem[]>([]);
  const projectsRef = useRef([...initialProjects]);
  const [recoveries, setRecoveries] = useState<readonly StoredUploadSession[]>([]);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const uploadersRef = useRef(new Map<string, ResumableUploader>());
  const unsubscribesRef = useRef(new Map<string, () => void>());
  const pumpingRef = useRef(false);
  const recoveriesRef = useRef<readonly StoredUploadSession[]>([]);
  const pendingCancellationsRef = useRef(new Map<string, PendingCancellation>());
  const cleanupRequiredRef = useRef(new Set<string>());

  const anyUploading = items.some((item) => item.state === "ACTIVE" && item.snapshot.phase === "UPLOADING");

  useEffect(() => {
    let active = true;
    const loadRecoveries = async () => {
      try {
        const rows = store === null ? [] : await store.list();
        if (!active) return;
        recoveriesRef.current = rows;
        setRecoveries(rows);
      } catch {
        if (!active) return;
        recoveriesRef.current = [];
        setRecoveries([]);
      } finally {
        if (active) {
          setRecoveryReady(true);
        }
      }
    };
    void loadRecoveries();
    return () => { active = false; };
  }, [store]);

  useEffect(() => {
    if (!anyUploading) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyUploading]);

  useEffect(() => {
    if (recoveryReady) void pump();
  });

  useEffect(() => () => {
    for (const unsubscribe of unsubscribesRef.current.values()) unsubscribe();
    for (const uploader of uploadersRef.current.values()) uploader.dispose();
  }, []);

  function publishItems(next: readonly UploadQueueItem[]): void {
    itemsRef.current = next;
    setItems(next);
  }

  function patchItem(id: string, patch: Partial<UploadQueueItem>): void {
    publishItems(itemsRef.current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  function currentItem(id: string): UploadQueueItem | null {
    return itemsRef.current.find((item) => item.id === id) ?? null;
  }

  function requestPendingCancellation(id: string): Promise<void> {
    const existing = pendingCancellationsRef.current.get(id);
    if (existing !== undefined) return existing.promise;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    pendingCancellationsRef.current.set(id, { promise, resolve, reject });
    return promise;
  }

  function finishPendingCancellation(id: string): void {
    const pending = pendingCancellationsRef.current.get(id);
    cleanupRequiredRef.current.delete(id);
    patchItem(id, { state: "CANCELLED", message: null });
    pendingCancellationsRef.current.delete(id);
    pending?.resolve();
  }

  async function settleProvisioningCancellation(
    id: string,
    projectId: string,
    artifactId: string | null,
  ): Promise<void> {
    const pending = pendingCancellationsRef.current.get(id);
    if (pending === undefined) return;
    let remoteCancelled = false;
    try {
      if (artifactId !== null) {
        patchItem(id, { projectId, artifactId });
        await controlPlaneApi(fetcher).cancel(projectId, artifactId);
        remoteCancelled = true;
        await store?.delete(projectId, artifactId);
      }
      finishPendingCancellation(id);
    } catch (error) {
      pendingCancellationsRef.current.delete(id);
      if (remoteCancelled) cleanupRequiredRef.current.add(id);
      const snapshot = currentItem(id)?.snapshot ?? EMPTY_SNAPSHOT;
      patchItem(id, {
        projectId,
        artifactId,
        ...(remoteCancelled ? {
          snapshot: { ...snapshot, phase: "CANCELLED" as const, publicCode: null },
        } : {}),
        state: remoteCancelled ? "ACTIVE" : "FAILED",
        message: uploadMessageForCode(
          remoteCancelled ? "UPLOAD_LOCAL_CLEANUP_FAILED" : error instanceof Error ? error.message : null,
        ),
      });
      pending.reject(error);
    }
  }

  function publishProjects(next: readonly PublicProject[]): void {
    projectsRef.current = [...next];
    onProjectsChange(projectsRef.current);
  }

  function updateProjectSource(projectId: string, sourceStatus: PublicProject["sourceStatus"]): void {
    publishProjects(projectsRef.current.map((project) => (
      project.id === projectId
        ? { ...project, sourceStatus, updatedAt: new Date().toISOString() }
        : project
    )));
  }

  function attachUploader(id: string): ResumableUploader {
    if (store === null) throw new Error("INDEXEDDB_UNAVAILABLE");
    unsubscribesRef.current.get(id)?.();
    uploadersRef.current.get(id)?.dispose();
    const uploader = uploaderFactory({
      fetcher: createDriveUploadFetcher(),
      store,
      api: controlPlaneApi(fetcher),
      now: Date.now,
      random: Math.random,
      sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      onDiagnostic: (event) => {
        console.error("[drive-upload] browser", event);
        if (event.stage === "chunk-fetch") {
          setDiagnostic("CHUNK_FETCH_REJECTED");
        } else if (event.stage === "query-fetch") {
          setDiagnostic("QUERY_FETCH_REJECTED");
        } else if (event.stage === "chunk-response") {
          setDiagnostic(event.rangeVisible ? "CHUNK_RANGE_VISIBLE" : "CHUNK_RANGE_HIDDEN");
        } else {
          setDiagnostic(event.rangeVisible ? "QUERY_RANGE_VISIBLE" : "QUERY_RANGE_HIDDEN");
        }
      },
    });
    unsubscribesRef.current.set(id, uploader.subscribe((next) => {
      patchItem(id, { snapshot: next, message: uploadMessageForCode(next.publicCode) });
    }));
    uploadersRef.current.set(id, uploader);
    return uploader;
  }

  async function ensureProject(item: UploadQueueItem): Promise<PublicProject> {
    if (item.projectId !== null) {
      const existing = projectsRef.current.find((project) => project.id === item.projectId);
      if (existing !== undefined) return existing;
    }
    const body = await jsonRequest(fetcher, "/api/v1/projects", { name: item.title }, {
      "idempotency-key": idempotencyKey(),
    });
    const project = body.project as PublicProject;
    publishProjects([...projectsRef.current.filter((entry) => entry.id !== project.id), project]);
    return project;
  }

  function finalizeReady(id: string, projectId: string, file: File): void {
    patchItem(id, { state: "DONE" });
    updateProjectSource(projectId, "SOURCE_READY");
    onSourceFile(projectId, file);
  }

  function settleItem(id: string, projectId: string | null): boolean {
    const settled = currentItem(id);
    if (settled === null) return false;
    if (settled.snapshot.phase === "READY" && projectId !== null) {
      finalizeReady(id, projectId, settled.file);
      return true;
    }
    if (settled.snapshot.phase === "CANCELLED") {
      if (cleanupRequiredRef.current.has(id)) return true;
      patchItem(id, { state: "CANCELLED" });
      return true;
    }
    return false;
  }

  async function runItem(item: UploadQueueItem): Promise<void> {
    patchItem(item.id, { state: "ACTIVE", message: null });
    let projectId = item.projectId;
    try {
      const identity = fileIdentity(item.file, item.mimeType);
      if (identity === null || store === null) throw new Error("UPLOAD_TYPE_REJECTED");
      const recovery = matchingRecovery(recoveriesRef.current, item.file, item.mimeType);
      if (recovery !== null) {
        projectId = recovery.projectId;
        patchItem(item.id, { projectId, artifactId: recovery.artifactId });
        const nextRecoveries = recoveriesRef.current.filter((entry) => entry !== recovery);
        recoveriesRef.current = nextRecoveries;
        setRecoveries(nextRecoveries);
        await attachUploader(item.id).resume(item.file, recovery);
      } else {
        const project = await ensureProject(item);
        projectId = project.id;
        patchItem(item.id, { projectId });
        if (pendingCancellationsRef.current.has(item.id)) {
          await settleProvisioningCancellation(item.id, project.id, null);
          return;
        }
        if (project.status !== "READY") throw new Error("DRIVE_TEMPORARILY_UNAVAILABLE");
        const body = await jsonRequest(fetcher, `/api/v1/projects/${project.id}/upload-session`, {
          fileName: identity.displayName,
          mimeType: identity.mimeType,
          sizeBytes: identity.sizeBytes,
          lastModified: identity.lastModified,
        });
        if (pendingCancellationsRef.current.has(item.id)) {
          await settleProvisioningCancellation(
            item.id,
            project.id,
            typeof body.artifactId === "string" ? body.artifactId : null,
          );
          return;
        }
        if (body.status === "SOURCE_READY") {
          patchItem(item.id, {
            snapshot: {
              phase: "READY",
              committedBytes: item.file.size,
              totalBytes: item.file.size,
              bytesPerSecond: 0,
              publicCode: null,
            },
          });
          finalizeReady(item.id, project.id, item.file);
          return;
        }
        if (
          typeof body.artifactId !== "string" || typeof body.sessionUri !== "string" ||
          body.chunkBytes !== 8_388_608 || typeof body.expiresAt !== "string"
        ) throw new Error("UPLOAD_REMOTE_MISMATCH");
        const record: StoredUploadSession = {
          projectId: project.id,
          artifactId: body.artifactId,
          sessionUri: body.sessionUri,
          fileIdentity: identity,
          nextOffset: 0,
          chunkBytes: 8_388_608,
          expiresAt: body.expiresAt,
        };
        patchItem(item.id, { artifactId: record.artifactId });
        await store.put(record);
        if (pendingCancellationsRef.current.has(item.id)) {
          await settleProvisioningCancellation(item.id, project.id, record.artifactId);
          return;
        }
        await attachUploader(item.id).start(item.file, record);
      }
      settleItem(item.id, projectId);
    } catch (error) {
      if (pendingCancellationsRef.current.has(item.id)) {
        const artifactId = currentItem(item.id)?.artifactId ?? null;
        if (projectId !== null) {
          await settleProvisioningCancellation(item.id, projectId, artifactId);
        } else {
          finishPendingCancellation(item.id);
        }
        return;
      }
      if (settleItem(item.id, projectId)) return;
      const code = error instanceof Error ? error.message : null;
      if (projectId !== null && code === "DRIVE_PROVIDER_REJECTED") {
        updateProjectSource(projectId, "UPLOAD_FAILED");
      }
      const phase = currentItem(item.id)?.snapshot.phase;
      patchItem(item.id, {
        message: uploadMessageForCode(code),
        state: phase === "PAUSED_ERROR" || phase === "PAUSED_VERIFYING" ? "ACTIVE" : "FAILED",
      });
    }
  }

  async function pump(): Promise<void> {
    if (
      pumpingRef.current || !recoveryReady ||
      itemsRef.current.some((item) => item.state === "ACTIVE")
    ) return;
    pumpingRef.current = true;
    try {
      while (true) {
        const next = itemsRef.current.find((item) => item.state === "QUEUED");
        if (next === undefined) return;
        await runItem(next);
        if (currentItem(next.id)?.state === "ACTIVE") return;
      }
    } finally {
      pumpingRef.current = false;
    }
  }

  function enqueueFiles(list: FileList | readonly File[]): void {
    if (disabled || list.length === 0) return;
    const additions: UploadQueueItem[] = [];
    for (const file of Array.from(list)) {
      const alreadyQueued = itemsRef.current.some((item) => (
        !["FAILED", "CANCELLED"].includes(item.state) &&
        item.file.name === file.name &&
        item.file.size === file.size &&
        item.file.lastModified === file.lastModified
      ));
      if (alreadyQueued) continue;
      const mimeType = uploadMimeTypeForFileName(file.name);
      const title = videoTitleFromFileName(file.name);
      const id = idempotencyKey();
      if (mimeType === null || title === null) {
        additions.push({
          id,
          file,
          mimeType: "",
          title: file.name,
          projectId: null,
          artifactId: null,
          snapshot: EMPTY_SNAPSHOT,
          message: uploadMessageForCode("UPLOAD_TYPE_REJECTED"),
          state: "FAILED",
        });
        continue;
      }
      additions.push({
        id,
        file,
        mimeType,
        title,
        projectId: null,
        artifactId: null,
        snapshot: EMPTY_SNAPSHOT,
        message: null,
        state: "QUEUED",
      });
    }
    if (additions.length === 0) return;
    publishItems([...itemsRef.current, ...additions]);
    void pump();
  }

  function pause(id: string): void {
    uploadersRef.current.get(id)?.pause();
  }

  async function resume(id: string): Promise<void> {
    const item = currentItem(id);
    const uploader = uploadersRef.current.get(id);
    if (
      item === null || item.projectId === null || item.artifactId === null ||
      store === null || uploader === undefined
    ) return;
    const record = await store.get(item.projectId, item.artifactId);
    if (record === null) return;
    patchItem(id, { message: null });
    try {
      await uploader.resume(item.file, record);
      settleItem(id, item.projectId);
    } catch (error) {
      if (settleItem(id, item.projectId)) {
        await pump();
        return;
      }
      patchItem(id, { message: uploadMessageForCode(error instanceof Error ? error.message : null) });
    }
    if (currentItem(id)?.state !== "ACTIVE") await pump();
  }

  async function cancel(id: string): Promise<void> {
    const item = currentItem(id);
    if (item === null) return;
    if (item.state === "QUEUED") {
      patchItem(id, { state: "CANCELLED" });
      return;
    }
    if (item.artifactId === null || item.projectId === null) {
      if (item.state === "ACTIVE") {
        await requestPendingCancellation(id);
        return;
      }
      patchItem(id, { state: "CANCELLED" });
      await pump();
      return;
    }
    if (
      item.state === "ACTIVE" && item.snapshot.phase !== "CANCELLED" &&
      uploadersRef.current.get(id) === undefined
    ) {
      await requestPendingCancellation(id);
      return;
    }
    try {
      const uploader = uploadersRef.current.get(id);
      if (item.snapshot.phase === "CANCELLED") {
        await store?.delete(item.projectId, item.artifactId);
      } else if (uploader !== undefined) {
        await uploader.cancel();
      } else {
        await controlPlaneApi(fetcher).cancel(item.projectId, item.artifactId);
        await store?.delete(item.projectId, item.artifactId);
      }
      cleanupRequiredRef.current.delete(id);
      patchItem(id, { state: "CANCELLED", message: null });
    } catch (error) {
      if (currentItem(id)?.snapshot.phase === "CANCELLED") {
        cleanupRequiredRef.current.add(id);
        patchItem(id, {
          state: "ACTIVE",
          message: uploadMessageForCode("UPLOAD_LOCAL_CLEANUP_FAILED"),
        });
        return;
      }
      if (settleItem(id, item.projectId)) return;
      patchItem(id, { message: uploadMessageForCode(error instanceof Error ? error.message : null) });
      return;
    }
    await pump();
  }

  async function retry(id: string): Promise<void> {
    const item = currentItem(id);
    if (item === null || item.state !== "FAILED" || item.mimeType === "") return;
    patchItem(id, { state: "QUEUED", message: null });
    await pump();
  }

  return {
    items,
    recoveries,
    diagnostic,
    enqueueFiles,
    pause,
    resume,
    cancel,
    retry,
  };
}
