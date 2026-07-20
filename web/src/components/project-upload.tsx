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
import { canonicalUploadFileName } from "@/lib/domain/upload-filename";
import type { FreeTierHealthView, PublicProject } from "./dashboard-types";

const VI_MESSAGES: Readonly<Record<string, string>> = {
  DRIVE_NOT_CONNECTED: "Hãy kết nối Google Drive trước.",
  DRIVE_REAUTH_REQUIRED: "Google Drive cần được kết nối lại.",
  DRIVE_ACCOUNT_MISMATCH: "Tài khoản Drive không khớp với dữ liệu hiện có.",
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
}: Readonly<{
  health: FreeTierHealthView;
  projects: readonly PublicProject[];
  fetcher?: typeof fetch;
  store?: UploadSessionStore;
  uploaderFactory?: (dependencies: ResumableUploaderDependencies) => ResumableUploader;
}>) {
  const [store] = useState<UploadSessionStore | null>(() => (
    providedStore ?? (typeof indexedDB === "undefined" ? null : createUploadSessionStore())
  ));
  const [projects, setProjects] = useState([...initialProjects]);
  const [selectedProjectId, setSelectedProjectId] = useState(initialProjects[0]?.id ?? "");
  const [projectName, setProjectName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const [recoveries, setRecoveries] = useState<readonly StoredUploadSession[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const uploaderRef = useRef<ResumableUploader | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const readOnlyReason = health.mode === "READ_ONLY"
    ? stableMessage(health.reasons[0] ?? "DRIVE_QUOTA_STALE")
    : health.driveConnection !== "CONNECTED" ? stableMessage("DRIVE_NOT_CONNECTED") : null;
  const workDisabled = readOnlyReason !== null;
  const recovery = matchingRecovery(recoveries, selectedProjectId, file);

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

  function attachUploader(): ResumableUploader {
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
    });
    unsubscribeRef.current = uploader.subscribe(setSnapshot);
    uploaderRef.current = uploader;
    return uploader;
  }

  async function createProject() {
    if (workDisabled || projectName.trim() === "") return;
    setBusy(true);
    setMessage(null);
    try {
      const body = await jsonRequest(fetcher, "/api/v1/projects", { name: projectName.trim() }, {
        "idempotency-key": idempotencyKey(),
      });
      const project = body.project as PublicProject;
      setProjects((current) => [...current.filter((item) => item.id !== project.id), project]);
      setSelectedProjectId(project.id);
      setProjectName("");
    } catch (error) {
      setMessage(stableMessage(error instanceof Error ? error.message : null));
    } finally {
      setBusy(false);
    }
  }

  async function startUpload() {
    const canonicalName = canonicalUploadFileName(file?.name);
    if (workDisabled || file === null || canonicalName === null || selectedProjectId === "" || store === null) return;
    setBusy(true);
    setMessage(null);
    try {
      if (recovery !== null) {
        setArtifactId(recovery.artifactId);
        await attachUploader().resume(file, recovery);
        return;
      }
      const body = await jsonRequest(fetcher, `/api/v1/projects/${selectedProjectId}/upload-session`, {
        fileName: canonicalName,
        mimeType: file.type,
        sizeBytes: file.size,
        lastModified: file.lastModified,
      });
      if (body.status === "SOURCE_READY") {
        setSnapshot({ phase: "READY", committedBytes: file.size, totalBytes: file.size, bytesPerSecond: 0, publicCode: null });
        return;
      }
      if (
        typeof body.artifactId !== "string" || typeof body.sessionUri !== "string" ||
        body.chunkBytes !== 8_388_608 || typeof body.expiresAt !== "string"
      ) throw new Error("UPLOAD_REMOTE_MISMATCH");
      const record: StoredUploadSession = {
        projectId: selectedProjectId,
        artifactId: body.artifactId,
        sessionUri: body.sessionUri,
        fileIdentity: { displayName: canonicalName, sizeBytes: file.size, mimeType: file.type, lastModified: file.lastModified },
        nextOffset: 0,
        chunkBytes: 8_388_608,
        expiresAt: body.expiresAt,
      };
      await store.put(record);
      setArtifactId(record.artifactId);
      await attachUploader().start(file, record);
    } catch (error) {
      setMessage(stableMessage(error instanceof Error ? error.message : null));
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
  return (
    <section className="workspace-card project-upload" aria-labelledby="project-upload-title">
      <div className="card-heading">
        <div><p className="eyebrow">Chuẩn bị video</p><h2 id="project-upload-title">Dự án & tải lên</h2></div>
        <span className={`mode-badge mode-${health.mode.toLowerCase()}`}>{health.mode === "READ_WRITE" ? "Sẵn sàng" : "Chỉ đọc"}</span>
      </div>

      {readOnlyReason && <p id="work-disabled-reason" className="warning-copy">{readOnlyReason}</p>}
      <div className="project-create-row">
        <label htmlFor="project-name">Tên dự án</label>
        <input id="project-name" value={projectName} onChange={(event) => setProjectName(event.target.value)} maxLength={160} disabled={workDisabled || busy} />
        <button type="button" onClick={createProject} disabled={workDisabled || busy || projectName.trim() === ""} aria-describedby={workDisabled ? "work-disabled-reason" : undefined}>Tạo dự án</button>
      </div>

      {projects.length > 0 && (
        <div className="upload-controls">
          <label htmlFor="project-select">Dự án</label>
          <select id="project-select" value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)} disabled={busy}>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <label htmlFor="source-video">Video nguồn</label>
          <input id="source-video" type="file" accept=".mp4,.mov,.mkv,.webm,video/mp4,video/quicktime,video/x-matroska,video/webm" onChange={(event) => setFile(event.target.files?.[0] ?? null)} disabled={workDisabled || busy} />
          <p className="field-note">MP4, MOV, MKV hoặc WEBM · tối đa 10 GiB</p>
          <div className="button-row">
            <button type="button" onClick={startUpload} disabled={workDisabled || busy || file === null}>
              {recovery === null ? "Tải lên" : "Tiếp tục tải dở"}
            </button>
            {snapshot.phase === "UPLOADING" && <button type="button" className="button-secondary" onClick={() => uploaderRef.current?.pause()}>Tạm dừng</button>}
            {(snapshot.phase === "PAUSED" || snapshot.phase === "PAUSED_ERROR" || snapshot.phase === "PAUSED_VERIFYING") && <button type="button" className="button-secondary" onClick={resumeUpload}>Tiếp tục</button>}
            {artifactId && !["READY", "CANCELLED"].includes(snapshot.phase) && <button type="button" className="button-danger" onClick={cancelUpload}>Hủy tải lên</button>}
          </div>
        </div>
      )}

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
