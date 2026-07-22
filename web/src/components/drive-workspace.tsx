"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createResumableUploader,
  type ResumableUploader,
  type ResumableUploaderDependencies,
} from "@/lib/browser/resumable-uploader";
import type { UploadSessionStore } from "@/lib/browser/upload-store";
import type {
  DriveConnectionView,
  DriveWorkspaceView,
  FreeTierHealthView,
  PublicProject,
} from "./dashboard-types";
import { DriveFileTree } from "./drive-file-tree";
import { DriveLogo } from "./drive-icons";
import { UploadQueue } from "./upload-queue";
import { uploadMessageForCode, useUploadQueue } from "./use-upload-queue";
import { VideoDropzone } from "./video-dropzone";

const EMPTY_VIEW: DriveWorkspaceView = { input: [], output: [], processingCount: 0 };
const POLL_DELAYS_MS = [5_000, 10_000, 20_000] as const;
const STATUS_LABELS = {
  CONNECTED: "Đã kết nối",
  DISCONNECTED: "Chưa kết nối",
  REAUTH_REQUIRED: "Cần kết nối lại",
  REVOKE_PENDING: "Đang chờ ngắt kết nối",
} as const;

function validAuthorizationUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4_096) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "accounts.google.com" &&
      url.pathname === "/o/oauth2/v2/auth" &&
      url.port === "" &&
      url.username === "" && url.password === "" && url.hash === "";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function isNullableSafeInteger(value: unknown, minimum: number): boolean {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= minimum);
}

function isNullableUrl(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length <= 2_048);
}

function isWorkspaceFile(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return isBoundedString(value.artifactId, 128) &&
    isBoundedString(value.name, 512) &&
    Number.isSafeInteger(value.sizeBytes) && (value.sizeBytes as number) >= 0 &&
    isBoundedString(value.uploadedAt, 64) && !Number.isNaN(Date.parse(value.uploadedAt)) &&
    isNullableSafeInteger(value.durationMillis, 0) &&
    isNullableSafeInteger(value.width, 1) &&
    isNullableSafeInteger(value.height, 1) &&
    (value.readiness === "PROCESSING" || value.readiness === "READY" || value.readiness === "UNKNOWN") &&
    isNullableUrl(value.viewUrl) &&
    isNullableUrl(value.downloadUrl);
}

function isWorkspaceView(value: unknown): value is DriveWorkspaceView {
  if (!isRecord(value) || !Array.isArray(value.input) || !Array.isArray(value.output)) return false;
  return value.input.every(isWorkspaceFile) &&
    value.output.every((group) => (
      isRecord(group) &&
      isBoundedString(group.projectId, 128) &&
      isBoundedString(group.name, 512) &&
      Array.isArray(group.files) && group.files.every(isWorkspaceFile)
    )) &&
    Number.isInteger(value.processingCount) &&
    (value.processingCount as number) >= 0;
}

function DriveWorkspaceHeader({
  drive,
  busy,
  onConnect,
  onDisconnect,
}: Readonly<{
  drive: DriveConnectionView;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}>) {
  const canConnect = drive.status === "DISCONNECTED" || drive.status === "REAUTH_REQUIRED";
  return (
    <header className="drive-workspace-header">
      <div className="drive-workspace-identity">
        <DriveLogo aria-hidden size={22} />
        <h2>Drive</h2>
        <span className={`connection-badge connection-${drive.status.toLowerCase()}`}>
          {STATUS_LABELS[drive.status]}
        </span>
        {drive.accountHint !== null && <span className="account-hint">{drive.accountHint}</span>}
      </div>
      <div className="drive-workspace-actions">
        {canConnect && (
          <button disabled={busy} onClick={onConnect} type="button">
            {drive.status === "REAUTH_REQUIRED" ? "Kết nối lại Google Drive" : "Kết nối Google Drive"}
          </button>
        )}
        {drive.status === "CONNECTED" && (
          <button className="button-secondary" disabled={busy} onClick={onDisconnect} type="button">
            Ngắt kết nối
          </button>
        )}
        {drive.status === "REVOKE_PENDING" && <button disabled type="button">Đang xử lý ngắt kết nối</button>}
      </div>
    </header>
  );
}

export function DriveWorkspace({
  drive,
  health,
  projects,
  fetcher = globalThis.fetch,
  navigate = (url) => window.location.assign(url),
  store,
  uploaderFactory = createResumableUploader,
  onProjectsChange = () => undefined,
  onSourceFile = () => undefined,
}: Readonly<{
  drive: DriveConnectionView;
  health: FreeTierHealthView;
  projects: readonly PublicProject[];
  fetcher?: typeof fetch;
  navigate?: (url: string) => void;
  store?: UploadSessionStore;
  uploaderFactory?: (dependencies: ResumableUploaderDependencies) => ResumableUploader;
  onProjectsChange?: (projects: readonly PublicProject[]) => void;
  onSourceFile?: (projectId: string, file: File) => void;
}>) {
  const [connectionStatus, setConnectionStatus] = useState(drive.status);
  const [previousDriveStatus, setPreviousDriveStatus] = useState(drive.status);
  if (previousDriveStatus !== drive.status) {
    setPreviousDriveStatus(drive.status);
    setConnectionStatus(drive.status);
  }
  const currentDrive: DriveConnectionView = connectionStatus === drive.status ? drive : {
    status: connectionStatus,
    accountHint: null,
    rootReady: false,
  };
  const canBrowse = currentDrive.status === "CONNECTED" && currentDrive.rootReady;
  const readOnlyReason = health.mode === "READ_ONLY"
    ? uploadMessageForCode(health.reasons[0] ?? "DRIVE_QUOTA_STALE")
    : currentDrive.status !== "CONNECTED" ? uploadMessageForCode(
      currentDrive.status === "REAUTH_REQUIRED" ? "DRIVE_REAUTH_REQUIRED" : "DRIVE_NOT_CONNECTED",
    ) : !currentDrive.rootReady ? "Chưa có thư mục Drive được xác minh." : null;
  const workDisabled = readOnlyReason !== null;
  const [view, setView] = useState<DriveWorkspaceView | null>(null);
  const [loading, setLoading] = useState(canBrowse);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState<Readonly<{ kind: "error" | "status"; text: string }> | null>(null);
  const [pollAttempt, setPollAttempt] = useState(0);
  const requestGeneration = useRef(0);
  const [documentVisible, setDocumentVisible] = useState(() => (
    typeof document === "undefined" || document.visibilityState === "visible"
  ));
  const connectionContext = JSON.stringify([
    currentDrive.status,
    currentDrive.rootReady,
    currentDrive.accountHint,
  ]);
  const [workspaceContext, setWorkspaceContext] = useState(connectionContext);
  if (workspaceContext !== connectionContext) {
    setWorkspaceContext(connectionContext);
    setView(null);
    setLoading(canBrowse);
    setTreeError(null);
    setPollAttempt(0);
  }

  useEffect(() => {
    requestGeneration.current += 1;
  }, [connectionContext]);

  const refreshTree = useCallback(async (resetPolling: boolean, showLoading = false): Promise<boolean> => {
    if (!canBrowse) return false;
    const generation = ++requestGeneration.current;
    if (resetPolling) setPollAttempt(0);
    if (showLoading) setLoading(true);
    setTreeError(null);
    try {
      const response = await fetcher("/api/v1/drive/files", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error("DRIVE_WORKSPACE_FETCH_FAILED");
      const body: unknown = await response.json();
      if (!isWorkspaceView(body)) throw new Error("DRIVE_WORKSPACE_RESPONSE_INVALID");
      if (generation !== requestGeneration.current) return true;
      setView(body);
      if (!resetPolling) setPollAttempt((current) => current + 1);
      return true;
    } catch {
      if (generation !== requestGeneration.current) return true;
      setTreeError("Chưa thể tải danh sách file Drive.");
      return false;
    } finally {
      if (showLoading && generation === requestGeneration.current) setLoading(false);
    }
  }, [canBrowse, fetcher]);

  useEffect(() => {
    let cancelled = false;
    if (canBrowse) {
      queueMicrotask(() => {
        if (!cancelled) void refreshTree(true, true);
      });
    }
    return () => { cancelled = true; };
  }, [canBrowse, refreshTree]);

  useEffect(() => {
    const handleVisibilityChange = () => setDocumentVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  useEffect(() => {
    if (!canBrowse || !documentVisible || treeError !== null || (view?.processingCount ?? 0) === 0) return;
    const delay = POLL_DELAYS_MS[Math.min(pollAttempt, POLL_DELAYS_MS.length - 1)]!;
    const timer = window.setTimeout(() => { void refreshTree(false); }, delay);
    return () => window.clearTimeout(timer);
  }, [canBrowse, documentVisible, pollAttempt, refreshTree, treeError, view]);

  const queue = useUploadQueue({
    disabled: workDisabled,
    projects,
    fetcher,
    store,
    uploaderFactory,
    onProjectsChange,
    onSourceFile: (projectId, file) => {
      onSourceFile(projectId, file);
      void refreshTree(true);
    },
  });

  async function connect(): Promise<void> {
    setConnectionBusy(true);
    setConnectionMessage(null);
    try {
      const response = await fetcher("/api/v1/drive/connect", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body = await response.json() as { authorizationUrl?: unknown };
      if (!response.ok || !validAuthorizationUrl(body.authorizationUrl)) throw new Error("CONNECT_FAILED");
      navigate(body.authorizationUrl);
    } catch {
      setConnectionMessage({ kind: "error", text: "Chưa thể bắt đầu kết nối Google Drive." });
      setConnectionBusy(false);
    }
  }

  async function disconnect(): Promise<void> {
    setConnectionBusy(true);
    setConnectionMessage(null);
    try {
      const response = await fetcher("/api/v1/drive/disconnect", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error("DISCONNECT_FAILED");
      const body = await response.json() as { status?: unknown };
      if (
        body.status !== "DISCONNECTED" &&
        body.status !== "REAUTH_REQUIRED" &&
        body.status !== "REVOKE_PENDING"
      ) throw new Error("DISCONNECT_RESPONSE_INVALID");
      requestGeneration.current += 1;
      setConnectionStatus(body.status);
      setConnectionMessage({ kind: "status", text: "Đã gửi yêu cầu ngắt kết nối. File riêng tư vẫn được giữ nguyên." });
    } catch {
      setConnectionMessage({ kind: "error", text: "Chưa thể ngắt kết nối Google Drive." });
    } finally {
      setConnectionBusy(false);
    }
  }

  async function deleteFile(artifactId: string): Promise<void> {
    const response = await fetcher(`/api/v1/drive/files/${encodeURIComponent(artifactId)}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error("DRIVE_FILE_DELETE_FAILED");
    if (!(await refreshTree(true))) throw new Error("DRIVE_WORKSPACE_REFRESH_FAILED");
  }

  const currentView = canBrowse ? view ?? EMPTY_VIEW : EMPTY_VIEW;
  return (
    <section className="drive-workspace" data-upload-diagnostic={queue.diagnostic ?? undefined}>
      <DriveWorkspaceHeader
        busy={connectionBusy}
        drive={currentDrive}
        onConnect={() => { void connect(); }}
        onDisconnect={() => { void disconnect(); }}
      />
      {connectionMessage !== null && (
        <p aria-live="polite" role={connectionMessage.kind === "error" ? "alert" : "status"}>{connectionMessage.text}</p>
      )}
      {readOnlyReason !== null && <p className="warning-copy">{currentDrive.status === "DISCONNECTED" ? "Kết nối Google Drive để xem và quản lý video." : readOnlyReason}</p>}
      <div aria-disabled={workDisabled} className="drive-browser-grid">
        <DriveFileTree
          dropzone={<VideoDropzone disabled={workDisabled} onFiles={queue.enqueueFiles} />}
          error={canBrowse ? treeError : null}
          kind="input"
          loading={canBrowse && loading && view === null}
          onDelete={deleteFile}
          onRetry={treeError === null ? undefined : () => { void refreshTree(true, true); }}
          view={currentView}
        />
        <DriveFileTree
          error={canBrowse ? treeError : null}
          kind="output"
          loading={canBrowse && loading && view === null}
          onDelete={deleteFile}
          onRetry={treeError === null ? undefined : () => { void refreshTree(true, true); }}
          view={currentView}
        />
      </div>
      {queue.recoveries.length > 0 && (
        <p className="recovery-note">Có phiên tải dở. Hãy chọn lại đúng file để tiếp tục từ phần đã xác nhận.</p>
      )}
      {queue.items.length === 0 ? (
        <section aria-label="Hàng đợi tải lên" className="drive-upload-queue">
          <h3>Hàng đợi tải lên</h3>
          <span>0 video</span>
        </section>
      ) : (
        <UploadQueue
          items={queue.items}
          onCancel={queue.cancel}
          onPause={queue.pause}
          onResume={queue.resume}
          onRetry={queue.retry}
        />
      )}
    </section>
  );
}
