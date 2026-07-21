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
import {
  canonicalUploadFileName,
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
};

const EMPTY_SNAPSHOT: UploadSnapshot = {
  phase: "IDLE",
  committedBytes: 0,
  totalBytes: 0,
  bytesPerSecond: 0,
  publicCode: null,
};

function stableMessage(code: string | null): string | null {
  return code === null ? null : VI_MESSAGES[code] ?? "Tác vụ chưa thể hoàn tất. Anh có thể thử lại.";
}

function matchingRecovery(
  recoveries: readonly StoredUploadSession[],
  projectId: string,
  file: File | null,
): StoredUploadSession | null {
  if (file === null) return null;
  const displayName = canonicalUploadFileName(file.name);
  if (displayName === null) return null;
  return recoveries.find((record) => (
    record.projectId === projectId &&
    record.fileIdentity.displayName === displayName &&
    record.fileIdentity.sizeBytes === file.size &&
    record.fileIdentity.mimeType === file.type &&
    record.fileIdentity.lastModified === file.lastModified
  )) ?? null;
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

export function ProjectUpload({
  health,
  projects: initialProjects,
  fetcher = globalThis.fetch,
  store: providedStore,
  uploaderFactory = createResumableUploader,
  onProjectsChange = () => undefined,
}: Readonly<{
  health: FreeTierHealthView;
  projects: readonly PublicProject[];
  fetcher?: typeof fetch;
  store?: UploadSessionStore;
  uploaderFactory?: (dependencies: ResumableUploaderDependencies) => ResumableUploader;
  onProjectsChange?: (projects: readonly PublicProject[]) => void;
}>) {
  const [store] = useState<UploadSessionStore | null>(() => (
    providedStore ?? (typeof indexedDB === "undefined" ? null : createUploadSessionStore())
  ));
  const [projects, setProjects] = useState([...initialProjects]);
  const projectsRef = useRef([...initialProjects]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const [recoveries, setRecoveries] = useState<readonly StoredUploadSession[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const uploaderRef = useRef<ResumableUploader | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const readOnlyReason = health.mode === "READ_ONLY"
    ? stableMessage(health.reasons[0] ?? "DRIVE_QUOTA_STALE")
    : health.driveConnection !== "CONNECTED" ? stableMessage("DRIVE_NOT_CONNECTED") : null;
  const workDisabled = readOnlyReason !== null;
  const recovery = matchingRecovery(recoveries, selectedProjectId, file);
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const uploadActive = [
    "UPLOADING", "PAUSED", "PAUSED_ERROR", "VERIFYING", "PAUSED_VERIFYING",
  ].includes(snapshot.phase);
  const sourceReady = snapshot.phase === "READY" ||
    selectedProject?.sourceStatus === "SOURCE_READY";

  useEffect(() => {
    let active = true;
    store?.list().then((rows) => { if (active) setRecoveries(rows); }).catch(() => undefined);
    return () => { active = false; };
  }, [store]);

  useEffect(() => {
    if (snapshot.phase !== "UPLOADING") return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [snapshot.phase]);

  useEffect(() => () => {
    unsubscribeRef.current?.();
    uploaderRef.current?.dispose();
  }, []);

  function publishProjects(next: readonly PublicProject[]): void {
    const snapshot = [...next];
    projectsRef.current = snapshot;
    setProjects(snapshot);
    onProjectsChange(snapshot);
  }

  function updateProjectSource(projectId: string, sourceStatus: PublicProject["sourceStatus"]): void {
    publishProjects(projectsRef.current.map((project) => (
      project.id === projectId
        ? { ...project, sourceStatus, updatedAt: new Date().toISOString() }
        : project
    )));
  }

  function attachUploader(projectId: string): ResumableUploader {
    unsubscribeRef.current?.();
    uploaderRef.current?.dispose();
    if (store === null) throw new Error("INDEXEDDB_UNAVAILABLE");
    const uploader = uploaderFactory({
      fetcher,
      store,
      api: controlPlaneApi(fetcher),
      now: Date.now,
      random: Math.random,
      sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      onDiagnostic: (event) => {
        console.error("[drive-upload] browser", event);
        setDiagnostic(event.stage === "chunk-fetch"
          ? "CHUNK_FETCH_REJECTED"
          : event.rangeVisible ? "CHUNK_RANGE_VISIBLE" : "CHUNK_RANGE_HIDDEN");
      },
    });
    unsubscribeRef.current = uploader.subscribe((next) => {
      setSnapshot(next);
      if (next.phase === "READY") updateProjectSource(projectId, "SOURCE_READY");
    });
    uploaderRef.current = uploader;
    return uploader;
  }

  async function ensureVideoProject(selectedFile: File): Promise<PublicProject> {
    const existing = projectsRef.current.find((project) => project.id === selectedProjectId);
    if (existing !== undefined) return existing;
    const name = videoTitleFromFileName(selectedFile.name);
    if (name === null) throw new Error("INVALID_REQUEST");
    const body = await jsonRequest(fetcher, "/api/v1/projects", { name }, {
      "idempotency-key": idempotencyKey(),
    });
    const project = body.project as PublicProject;
    publishProjects([...projectsRef.current.filter((item) => item.id !== project.id), project]);
    setSelectedProjectId(project.id);
    return project;
  }

  async function startUpload() {
    const canonicalName = canonicalUploadFileName(file?.name);
    if (workDisabled || file === null || canonicalName === null || store === null) return;
    setBusy(true);
    setMessage(null);
    let activeProjectId = selectedProjectId;
    try {
      const project = await ensureVideoProject(file);
      activeProjectId = project.id;
      const activeRecovery = matchingRecovery(recoveries, project.id, file);
      if (activeRecovery !== null) {
        setArtifactId(activeRecovery.artifactId);
        await attachUploader(project.id).resume(file, activeRecovery);
        return;
      }
      const body = await jsonRequest(fetcher, `/api/v1/projects/${project.id}/upload-session`, {
        fileName: canonicalName,
        mimeType: file.type,
        sizeBytes: file.size,
        lastModified: file.lastModified,
      });
      if (body.status === "SOURCE_READY") {
        setSnapshot({ phase: "READY", committedBytes: file.size, totalBytes: file.size, bytesPerSecond: 0, publicCode: null });
        updateProjectSource(project.id, "SOURCE_READY");
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
        fileIdentity: { displayName: canonicalName, sizeBytes: file.size, mimeType: file.type, lastModified: file.lastModified },
        nextOffset: 0,
        chunkBytes: 8_388_608,
        expiresAt: body.expiresAt,
      };
      await store.put(record);
      setArtifactId(record.artifactId);
      await attachUploader(project.id).start(file, record);
    } catch (error) {
      const code = error instanceof Error ? error.message : null;
      if (activeProjectId !== "" && code === "DRIVE_PROVIDER_REJECTED") {
        updateProjectSource(activeProjectId, "UPLOAD_FAILED");
      }
      setMessage(stableMessage(code));
    } finally {
      setBusy(false);
    }
  }

  async function resumeUpload() {
    if (file === null || artifactId === null || store === null || uploaderRef.current === null) return;
    const record = await store.get(selectedProjectId, artifactId);
    if (record === null) return;
    await uploaderRef.current.resume(file, record).catch((error) => {
      setMessage(stableMessage(error instanceof Error ? error.message : null));
    });
  }

  async function cancelUpload() {
    await uploaderRef.current?.cancel().catch((error) => {
      setMessage(stableMessage(error instanceof Error ? error.message : null));
    });
  }

  const percent = snapshot.totalBytes > 0 ? Math.floor(snapshot.committedBytes * 100 / snapshot.totalBytes) : 0;
  const uploadLabel = recovery !== null
    ? "Tiếp tục tải dở"
    : selectedProject?.sourceStatus === "UPLOAD_FAILED"
      ? "Chọn lại file và thử lại"
      : "Tải video lên";
  return (
    <section className="workspace-card project-upload" aria-labelledby="project-upload-title" data-upload-diagnostic={diagnostic ?? undefined}>
      <div className="card-heading">
        <div><p className="eyebrow">Chuẩn bị video</p><h2 id="project-upload-title">Video & tải lên</h2></div>
        <span className={`mode-badge mode-${health.mode.toLowerCase()}`}>{health.mode === "READ_WRITE" ? "Sẵn sàng" : "Chỉ đọc"}</span>
      </div>

      {readOnlyReason && <p id="work-disabled-reason" className="warning-copy">{readOnlyReason}</p>}
      <div className="upload-controls">
          <label htmlFor="project-select">Video</label>
          <select id="project-select" value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)} disabled={busy || uploadActive}>
            <option value="">Tải video mới</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.sourceStatus === "SOURCE_READY" ? "Sẵn sàng" : project.sourceStatus === "UPLOAD_FAILED" ? "Tải lỗi" : project.sourceStatus === "UPLOAD_PENDING" ? "Đang tải" : "Chưa tải"}</option>)}
          </select>
          <label htmlFor="source-video">File video</label>
          <input id="source-video" type="file" accept=".mp4,.mov,.mkv,.webm,video/mp4,video/quicktime,video/x-matroska,video/webm" onChange={(event) => setFile(event.target.files?.[0] ?? null)} disabled={workDisabled || busy || uploadActive || sourceReady} />
          <p className="field-note">MP4, MOV, MKV hoặc WEBM · tối đa 10 GiB</p>
          <div className="button-row">
            <button type="button" onClick={startUpload} disabled={workDisabled || busy || uploadActive || sourceReady || file === null}>
              {uploadLabel}
            </button>
            {snapshot.phase === "UPLOADING" && <button type="button" className="button-secondary" onClick={() => uploaderRef.current?.pause()}>Tạm dừng</button>}
            {(snapshot.phase === "PAUSED" || snapshot.phase === "PAUSED_ERROR" || snapshot.phase === "PAUSED_VERIFYING") && <button type="button" className="button-secondary" onClick={resumeUpload}>Tiếp tục</button>}
            {artifactId && !["READY", "CANCELLED"].includes(snapshot.phase) && <button type="button" className="button-danger" onClick={cancelUpload}>Hủy tải lên</button>}
          </div>
      </div>

      {recoveries.length > 0 && snapshot.phase === "IDLE" && <p className="recovery-note">Có phiên tải dở. Hãy chọn lại đúng file để tiếp tục từ phần đã xác nhận.</p>}
      <div className="upload-progress" role="status" aria-live="polite">
        <strong>{percent}%</strong>
        <span>{snapshot.committedBytes.toLocaleString("vi-VN")} / {snapshot.totalBytes.toLocaleString("vi-VN")} byte</span>
        {snapshot.bytesPerSecond > 0 && <span>{snapshot.bytesPerSecond.toLocaleString("vi-VN")} byte/giây</span>}
        {snapshot.phase === "READY" && <span>Nguồn đã xác minh · Chưa gắn GPU VPS</span>}
      </div>
      {(message ?? stableMessage(snapshot.publicCode)) && <p role="alert">{message ?? stableMessage(snapshot.publicCode)}</p>}
    </section>
  );
}
