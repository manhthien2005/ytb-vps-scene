"use client";

import { useEffect, useRef, useState } from "react";
import {
  createResumableUploader,
  type ResumableUploader,
  type ResumableUploaderDependencies,
  type UploadControlPlaneApi,
  type UploadSnapshot,
} from "@/lib/browser/resumable-uploader";
import {
  createUploadSessionStore,
  type StoredUploadSession,
  type UploadSessionStore,
} from "@/lib/browser/upload-store";
import { createDriveUploadFetcher } from "@/lib/browser/drive-upload-fetcher";
import {
  canonicalUploadFileName,
  uploadMimeTypeForFileName,
  videoTitleFromFileName,
} from "@/lib/domain/upload-filename";
import type { FreeTierHealthView, PublicProject } from "./dashboard-types";

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

function stableMessage(code: string | null): string | null {
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

function itemPercent(item: UploadQueueItem): number {
  if (item.state === "DONE") return 100;
  return item.snapshot.totalBytes > 0
    ? Math.floor(item.snapshot.committedBytes * 100 / item.snapshot.totalBytes)
    : 0;
}

function itemStatusLabel(item: UploadQueueItem): string {
  if (item.state === "QUEUED") return "Chờ tải";
  if (item.state === "DONE") return "Đã lên Drive";
  if (item.state === "FAILED") return "Tải lỗi";
  if (item.state === "CANCELLED") return "Đã hủy";
  switch (item.snapshot.phase) {
    case "PAUSED": return "Tạm dừng";
    case "PAUSED_ERROR":
    case "PAUSED_VERIFYING": return "Chờ thử lại";
    case "VERIFYING": return "Đang xác minh";
    default: return "Đang tải";
  }
}

export function ProjectUpload({
  health,
  projects: initialProjects,
  fetcher = globalThis.fetch,
  store: providedStore,
  uploaderFactory = createResumableUploader,
  onProjectsChange = () => undefined,
  onSourceFile = () => undefined,
}: Readonly<{
  health: FreeTierHealthView;
  projects: readonly PublicProject[];
  fetcher?: typeof fetch;
  store?: UploadSessionStore;
  uploaderFactory?: (dependencies: ResumableUploaderDependencies) => ResumableUploader;
  onProjectsChange?: (projects: readonly PublicProject[]) => void;
  onSourceFile?: (projectId: string, file: File) => void;
}>) {
  const [store] = useState<UploadSessionStore | null>(() => (
    providedStore ?? (typeof indexedDB === "undefined" ? null : createUploadSessionStore())
  ));
  const [items, setItems] = useState<readonly UploadQueueItem[]>([]);
  const itemsRef = useRef<readonly UploadQueueItem[]>([]);
  const projectsRef = useRef([...initialProjects]);
  const [recoveries, setRecoveries] = useState<readonly StoredUploadSession[]>([]);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const uploadersRef = useRef(new Map<string, ResumableUploader>());
  const unsubscribesRef = useRef(new Map<string, () => void>());
  const pumpingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const readOnlyReason = health.mode === "READ_ONLY"
    ? stableMessage(health.reasons[0] ?? "DRIVE_QUOTA_STALE")
    : health.driveConnection !== "CONNECTED" ? stableMessage("DRIVE_NOT_CONNECTED") : null;
  const workDisabled = readOnlyReason !== null;
  const anyUploading = items.some((item) => item.state === "ACTIVE" && item.snapshot.phase === "UPLOADING");

  useEffect(() => {
    let active = true;
    store?.list().then((rows) => { if (active) setRecoveries(rows); }).catch(() => undefined);
    return () => { active = false; };
  }, [store]);

  useEffect(() => {
    if (!anyUploading) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyUploading]);

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
      patchItem(id, { snapshot: next, message: stableMessage(next.publicCode) });
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

  async function runItem(item: UploadQueueItem): Promise<void> {
    patchItem(item.id, { state: "ACTIVE", message: null });
    let projectId = item.projectId;
    try {
      const identity = fileIdentity(item.file, item.mimeType);
      if (identity === null || store === null) throw new Error("UPLOAD_TYPE_REJECTED");
      const recovery = matchingRecovery(recoveries, item.file, item.mimeType);
      if (recovery !== null) {
        projectId = recovery.projectId;
        patchItem(item.id, { projectId, artifactId: recovery.artifactId });
        setRecoveries((current) => current.filter((entry) => entry !== recovery));
        await attachUploader(item.id).resume(item.file, recovery);
      } else {
        const project = await ensureProject(item);
        projectId = project.id;
        patchItem(item.id, { projectId });
        if (project.status !== "READY") throw new Error("DRIVE_TEMPORARILY_UNAVAILABLE");
        const body = await jsonRequest(fetcher, `/api/v1/projects/${project.id}/upload-session`, {
          fileName: identity.displayName,
          mimeType: identity.mimeType,
          sizeBytes: identity.sizeBytes,
          lastModified: identity.lastModified,
        });
        if (body.status === "SOURCE_READY") {
          patchItem(item.id, {
            snapshot: { phase: "READY", committedBytes: item.file.size, totalBytes: item.file.size, bytesPerSecond: 0, publicCode: null },
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
        await store.put(record);
        patchItem(item.id, { artifactId: record.artifactId });
        await attachUploader(item.id).start(item.file, record);
      }
      settleItem(item.id, projectId);
    } catch (error) {
      if (settleItem(item.id, projectId)) return;
      const code = error instanceof Error ? error.message : null;
      if (projectId !== null && code === "DRIVE_PROVIDER_REJECTED") {
        updateProjectSource(projectId, "UPLOAD_FAILED");
      }
      const phase = currentItem(item.id)?.snapshot.phase;
      patchItem(item.id, {
        message: stableMessage(code),
        state: phase === "PAUSED_ERROR" || phase === "PAUSED_VERIFYING" ? "ACTIVE" : "FAILED",
      });
    }
  }

  function settleItem(id: string, projectId: string | null): boolean {
    const settled = currentItem(id);
    if (settled === null) return false;
    if (settled.snapshot.phase === "READY" && projectId !== null) {
      finalizeReady(id, projectId, settled.file);
      return true;
    }
    if (settled.snapshot.phase === "CANCELLED") {
      patchItem(id, { state: "CANCELLED" });
      return true;
    }
    return false;
  }

  async function pump(): Promise<void> {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    try {
      while (true) {
        const next = itemsRef.current.find((item) => item.state === "QUEUED");
        if (next === undefined) return;
        await runItem(next);
      }
    } finally {
      pumpingRef.current = false;
    }
  }

  function enqueueFiles(list: FileList | null): void {
    if (workDisabled || list === null || list.length === 0) return;
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
          id, file, mimeType: "", title: file.name, projectId: null, artifactId: null,
          snapshot: EMPTY_SNAPSHOT, message: stableMessage("UPLOAD_TYPE_REJECTED"), state: "FAILED",
        });
        continue;
      }
      additions.push({
        id, file, mimeType, title, projectId: null, artifactId: null,
        snapshot: EMPTY_SNAPSHOT, message: null, state: "QUEUED",
      });
    }
    if (additions.length === 0) return;
    publishItems([...itemsRef.current, ...additions]);
    if (inputRef.current !== null) inputRef.current.value = "";
    void pump();
  }

  async function resumeItem(id: string): Promise<void> {
    const item = currentItem(id);
    const uploader = uploadersRef.current.get(id);
    if (item === null || item.projectId === null || item.artifactId === null || store === null || uploader === undefined) return;
    const record = await store.get(item.projectId, item.artifactId);
    if (record === null) return;
    patchItem(id, { message: null });
    try {
      await uploader.resume(item.file, record);
      settleItem(id, item.projectId);
    } catch (error) {
      if (settleItem(id, item.projectId)) return;
      patchItem(id, { message: stableMessage(error instanceof Error ? error.message : null) });
    }
  }

  async function cancelItem(id: string): Promise<void> {
    const item = currentItem(id);
    if (item === null) return;
    if (item.state === "QUEUED") {
      patchItem(id, { state: "CANCELLED" });
      return;
    }
    try {
      await uploadersRef.current.get(id)?.cancel();
      patchItem(id, { state: "CANCELLED" });
    } catch (error) {
      if (settleItem(id, item.projectId)) return;
      patchItem(id, { message: stableMessage(error instanceof Error ? error.message : null) });
    }
  }

  const visibleItems = items.filter((item) => item.state !== "CANCELLED");

  return (
    <section className="workspace-card project-upload" aria-labelledby="project-upload-title" data-upload-diagnostic={diagnostic ?? undefined}>
      <div className="card-heading">
        <div><p className="eyebrow">Chuẩn bị video</p><h2 id="project-upload-title">Tải video lên Drive</h2></div>
        <span className={`mode-badge mode-${health.mode.toLowerCase()}`}>{health.mode === "READ_WRITE" ? "Sẵn sàng" : "Chỉ đọc"}</span>
      </div>

      {readOnlyReason && <p id="work-disabled-reason" className="warning-copy">{readOnlyReason}</p>}
      <div className="upload-controls">
          <label htmlFor="source-video">File video</label>
          <input ref={inputRef} id="source-video" type="file" multiple accept=".mp4,.mov,.mkv,.webm,video/mp4,video/quicktime,video/x-matroska,video/webm" onChange={(event) => enqueueFiles(event.target.files)} disabled={workDisabled} />
          <p className="field-note">MP4, MOV, MKV hoặc WEBM · tối đa 10 GiB · chọn được nhiều file, tải lần lượt</p>
      </div>

      {recoveries.length > 0 && <p className="recovery-note">Có phiên tải dở. Hãy chọn lại đúng file để tiếp tục từ phần đã xác nhận.</p>}

      {visibleItems.length > 0 && (
        <ul className="upload-queue" aria-label="Hàng đợi tải lên">
          {visibleItems.map((item) => {
            const percent = itemPercent(item);
            const paused = ["PAUSED", "PAUSED_ERROR", "PAUSED_VERIFYING"].includes(item.snapshot.phase);
            const cancellable = item.state === "QUEUED" ||
              (item.state === "ACTIVE" && item.artifactId !== null && !["READY", "CANCELLED"].includes(item.snapshot.phase));
            return (
              <li key={item.id} className={`upload-item upload-item-${item.state.toLowerCase()}`}>
                <div className="upload-item-heading">
                  <strong>{item.title}</strong>
                  <span>{itemStatusLabel(item)}</span>
                </div>
                <div className="upload-bar" role="progressbar" aria-label={`Tiến trình ${item.title}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
                  <div className="upload-bar-fill" style={{ width: `${percent}%` }} data-phase={item.snapshot.phase} />
                </div>
                <div className="upload-item-meta">
                  <span>{percent}%</span>
                  {item.snapshot.totalBytes > 0 && <span>{item.snapshot.committedBytes.toLocaleString("vi-VN")} / {item.snapshot.totalBytes.toLocaleString("vi-VN")} byte</span>}
                  {item.snapshot.bytesPerSecond > 0 && item.state === "ACTIVE" && <span>{item.snapshot.bytesPerSecond.toLocaleString("vi-VN")} byte/giây</span>}
                </div>
                <div className="button-row">
                  {item.state === "ACTIVE" && (item.snapshot.phase === "UPLOADING" || item.snapshot.phase === "VERIFYING") && (
                    <button type="button" className="button-secondary" onClick={() => uploadersRef.current.get(item.id)?.pause()}>Tạm dừng</button>
                  )}
                  {item.state === "ACTIVE" && paused && (
                    <button type="button" className="button-secondary" onClick={() => void resumeItem(item.id)}>Tiếp tục</button>
                  )}
                  {cancellable && (
                    <button type="button" className="button-danger" onClick={() => void cancelItem(item.id)}>Hủy</button>
                  )}
                </div>
                {item.message && <p role="alert">{item.message}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
