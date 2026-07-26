"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { JobState, JobSummary } from "@/lib/domain/control-plane";
import { isCancelableJobState, isTerminalJobState } from "@/lib/domain/control-plane";
import type { JobDetailReadModel } from "@/lib/repositories/control-plane";
import type { PublicProject } from "./dashboard-types";

const POLL_MS = 15_000;
const BACKOFF_MS = 30_000;

type Props = Readonly<{
  jobs: readonly JobSummary[];
  projects: readonly PublicProject[];
  fetcher?: typeof fetch;
}>;

const STATE_LABELS: Partial<Record<JobState, string>> = {
  RENDER: "Đang render",
  DOWNLOADING: "Đang tải",
  TRANSLATE: "Đang dịch",
  TTS: "Đang tạo giọng",
  UPLOADING: "Đang tải lên",
  COMPLETED: "Hoàn tất",
  QUEUED: "Đang chờ",
  FAILED_FINAL: "Thất bại",
  FAILED_RETRYABLE: "Lỗi tạm thời",
  CANCEL_REQUESTED: "Đang hủy",
  CANCELLED: "Đã hủy",
  PAUSED_QUOTA: "Tạm dừng (quota)",
  PAUSED_NO_WORKER: "Tạm dừng (worker)",
  PAUSED_REVIEW: "Chờ duyệt",
  REVIEW_READY: "Sẵn sàng duyệt",
  OCR: "Đang OCR",
  CLAIMED: "Đã nhận",
  READY: "Sẵn sàng",
  DRAFT: "Nháp",
  DELETING: "Đang xóa",
  DELETED: "Đã xóa",
};

function sl(s: string): string {
  return STATE_LABELS[s as JobState] ?? s;
}

function formatEta(seconds: number): string {
  if (seconds <= 0) return "Còn dưới 1 giây";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  const parts: string[] = [];
  if (h > 0) parts.push(`${h} giờ`);
  if (m > 0) parts.push(`${m} phút`);
  if (s > 0 && h === 0) parts.push(`${s} giây`);
  return `Còn khoảng ${parts.join(" ")}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function firstLine(text: string | null | undefined): string | null {
  if (text == null) return null;
  const idx = text.indexOf("\n");
  return idx === -1 ? text : text.slice(0, idx);
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function JobList({ jobs, projects, fetcher = fetch }: Props) {
  const [displayJobs, setDisplayJobs] = useState<readonly JobSummary[]>(jobs);
  const [pollError, setPollError] = useState(false);
  const [queueingIds, setQueueingIds] = useState<ReadonlySet<string>>(new Set());
  const [queueMsg, setQueueMsg] = useState<string | null>(null);
  const [cancellingIds, setCancellingIds] = useState<ReadonlySet<string>>(new Set());
  const [detail, setDetail] = useState<Readonly<{ id: string; name: string }> | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailData, setDetailData] = useState<JobDetailReadModel | null>(null);
  const [detailError, setDetailError] = useState(false);
  const lastFocusRef = useRef<HTMLElement | null>(null);
  // Bumped on every openDetail/closeDetail so a slow response for a previously
  // opened job can never fill (or reopen) the sheet for a different job.
  const detailGenerationRef = useRef(0);
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  }, [fetcher]);

  // Polling — one 15s interval; after an error, skipped ticks stretch the gap to BACKOFF_MS
  const backoffTicksRef = useRef(0);

  useEffect(() => {
    const poll = async () => {
      if (document.visibilityState === "hidden") return;
      if (backoffTicksRef.current > 0) {
        backoffTicksRef.current -= 1;
        return;
      }
      try {
        const r = await fetcherRef.current("/api/v1/jobs", { cache: "no-store", credentials: "same-origin" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const d: { jobs: readonly JobSummary[] } = await r.json();
        if (!Array.isArray(d.jobs)) throw new Error("MALFORMED_JOBS_PAYLOAD");
        setDisplayJobs(d.jobs);
        setPollError(false);
      } catch {
        setPollError(true);
        backoffTicksRef.current = BACKOFF_MS / POLL_MS - 1;
      }
    };
    // Refresh immediately: the component is remounted on every surface switch and
    // would otherwise show the page-load SSR snapshot for up to 15s.
    void poll();
    const id = setInterval(() => { void poll(); }, POLL_MS);
    return () => clearInterval(id);
  }, []);

  const srProjects = projects.filter((p) => p.sourceStatus === "SOURCE_READY");

  function doRefresh() {
    fetcherRef.current("/api/v1/jobs", { cache: "no-store", credentials: "same-origin" })
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json() as Promise<{ jobs: readonly JobSummary[] }>;
      })
      .then((d) => {
        setDisplayJobs(d.jobs);
        setPollError(false);
        backoffTicksRef.current = 0;
      })
      .catch(() => setPollError(true));
  }

  function doQueue(pid: string) {
    if (queueingIds.has(pid)) return;
    setQueueingIds((s) => new Set(s).add(pid));
    setQueueMsg(null);
    fetcherRef.current(`/api/v1/projects/${pid}/jobs`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "idempotency-key": crypto.randomUUID(), origin: window.location.origin },
    })
      .then((r) => setQueueMsg(r.ok ? "Đã xếp job vào hàng đợi." : "Dự án chưa sẵn sàng để xếp job."))
      .catch(() => setQueueMsg("Chưa thể xếp job. Vui lòng thử lại."))
      .finally(() => setQueueingIds((s) => { const n = new Set(s); n.delete(pid); return n; }));
  }

  function doCancel(jid: string) {
    if (cancellingIds.has(jid)) return;
    const pn = displayJobs.find((j) => j.id === jid)?.projectName ?? "";
    if (!confirm(`Hủy job "${pn}"?`)) return;
    setCancellingIds((s) => new Set(s).add(jid));
    setQueueMsg(null);
    fetcherRef.current(`/api/v1/jobs/${jid}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "cancel" }),
    })
      .then((r) => r.json() as Promise<{ outcome: string }>)
      .then((d) => {
        if (d.outcome === "REQUESTED") return;
        setCancellingIds((s) => { const n = new Set(s); n.delete(jid); return n; });
        setQueueMsg("Chưa thể hủy job.");
      })
      .catch(() => {
        setCancellingIds((s) => { const n = new Set(s); n.delete(jid); return n; });
        setQueueMsg("Chưa thể hủy job.");
      });
  }

  function openDetail(jid: string, name: string) {
    lastFocusRef.current = document.activeElement as HTMLElement;
    const generation = ++detailGenerationRef.current;
    setDetail({ id: jid, name });
    setDetailData(null);
    setDetailError(false);
    setDetailLoading(true);
    setQueueMsg(null);
    fetcherRef.current(`/api/v1/jobs/${jid}`, { cache: "no-store", credentials: "same-origin" })
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json() as Promise<{ job: JobDetailReadModel }>; })
      .then((d) => {
        if (detailGenerationRef.current !== generation) return;
        setDetailData(d.job);
        setDetailError(false);
      })
      .catch(() => {
        if (detailGenerationRef.current !== generation) return;
        setDetailError(true);
      })
      .finally(() => {
        if (detailGenerationRef.current !== generation) return;
        setDetailLoading(false);
      });
  }

  const closeDetail = useCallback(() => {
    detailGenerationRef.current += 1;
    setDetail(null);
    setDetailData(null);
    setDetailError(false);
    setDetailLoading(false);
    if (lastFocusRef.current instanceof HTMLElement) lastFocusRef.current.focus();
  }, []);

  // Escape must close the sheet even when focus is outside the panel
  const detailOpen = detail !== null;
  useEffect(() => {
    if (!detailOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDetail();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [detailOpen, closeDetail]);

  return (
    <section aria-label="Danh sách job">
      {pollError && <div role="alert">Mất kết nối. Đang giữ danh sách gần nhất.</div>}
      {queueMsg !== null && <div role="alert">{queueMsg}</div>}

      {displayJobs.length === 0 && (
        <p>Chưa có video nguồn nào được cấu hình. Cần nạp video nguồn, thiết lập cài đặt và xác nhận render để bắt đầu.</p>
      )}

      <ul>
        {displayJobs.map((j) => {
          const term = isTerminalJobState(j.state);
          const canCancel = !term && isCancelableJobState(j.state);
          const cancelling = cancellingIds.has(j.id);
          const em = firstLine(j.errorMessage);
          const ph = j.activePhase != null
            ? `Pha: ${cap(j.activePhase)}${j.phaseProgressPercent != null ? ` (${j.phaseProgressPercent}%)` : ""}`
            : null;
          const workerLabel = j.workerSummary?.accountLabel ?? null;
          const outputReady = j.outputMetadata != null;
          return (
            <li key={j.id} aria-label={`Job ${j.projectName}`}>
              <div>
                <strong>{j.projectName}</strong>
                <span>{sl(j.state)}</span>
                {ph !== null && <span>{ph}</span>}
                <div
                  role="progressbar"
                  aria-label={`Tiến độ ${j.projectName}`}
                  aria-valuenow={j.progressPercent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div style={{ width: `${j.progressPercent}%` }} />
                </div>
                <span>{j.etaSeconds != null ? formatEta(j.etaSeconds) : "Chưa có ước tính thời gian"}</span>
                {workerLabel !== null && <span>Worker: {workerLabel}</span>}
                <span>Output: {outputReady ? "Đã sẵn sàng" : "Chưa sẵn sàng"}</span>
                <time dateTime={j.updatedAt}>Cập nhật {new Date(j.updatedAt).toLocaleString("vi-VN")}</time>
              </div>
              <div>
                {!term && !cancelling && canCancel && (
                  <button type="button" onClick={() => doCancel(j.id)}>Hủy job {j.projectName}</button>
                )}
                {!term && cancelling && <span>Đang hủy</span>}
                <button type="button" onClick={() => openDetail(j.id, j.projectName)}>Xem chi tiết {j.projectName}</button>
              </div>
              {(j.errorCode || em) && (
                <div role="alert">{j.errorCode}{em ? `: ${em}` : ""}</div>
              )}
            </li>
          );
        })}
      </ul>

      {srProjects.length > 0 && (
        <div>
          <p>Cần kiểm tra lại cài đặt trước khi render chính thức.</p>
          {srProjects.map((p) => (
            <button key={p.id} type="button" disabled={queueingIds.has(p.id)} onClick={() => doQueue(p.id)}>
              {queueingIds.has(p.id) ? "Đang xếp…" : `Xếp render ${p.name}`}
            </button>
          ))}
        </div>
      )}

      {detail !== null && (
        <dialog open aria-label={`Chi tiết job ${detail.name}`}>
          {detailLoading && <div>Đang tải…</div>}
          {detailError && (
            <div role="alert">
              Chưa thể tải chi tiết job.
              <button type="button" onClick={() => openDetail(detail.id, detail.name)}>Thử tải lại chi tiết</button>
            </div>
          )}
          {detailData !== null && (
            <>
              <div>
                <h3>{detailData.projectName}</h3>
                <button type="button" style={{ minHeight: 44, minWidth: 44 }} onClick={closeDetail}>Đóng chi tiết</button>
              </div>

              {detailData.settingsSnapshot && (
                <dl>
                  <dt>Cài đặt</dt>
                  {"split" in detailData.settingsSnapshot ? (
                    <>
                      <dd>Chia mỗi {detailData.settingsSnapshot.split.mode === "fixedSeconds" ? detailData.settingsSnapshot.split.secondsPerPart + " giây" : "không chia"}</dd>
                      <dd>Blur: {detailData.settingsSnapshot.blur.mode}</dd>
                      <dt>Giọng</dt>
                      <dd>{`${detailData.settingsSnapshot.voice} · ${detailData.settingsSnapshot.rate}x`}</dd>
                      <dd>Đầu ra: {detailData.settingsSnapshot.output.format}</dd>
                      {detailData.settingsSnapshot.preset != null && <dd>{detailData.settingsSnapshot.preset.name}</dd>}
                    </>
                  ) : (
                    <dd>{`${detailData.settingsSnapshot.voice} · ${detailData.settingsSnapshot.rate}x`}</dd>
                  )}
                </dl>
              )}

              <dl>
                {detailData.telemetry.latestMessage && (
                  <>
                    <dt>Thông báo</dt>
                    <dd>{detailData.telemetry.latestMessage}</dd>
                  </>
                )}
                {detailData.sourceMetadata && (
                  <>
                    <dt>Nguồn</dt>
                    <dd>{detailData.sourceMetadata.displayName} · {detailData.sourceMetadata.mimeType} · {detailData.sourceMetadata.sizeBytes != null ? formatBytes(detailData.sourceMetadata.sizeBytes) : "không rõ dung lượng"}</dd>
                  </>
                )}
                {detailData.outputMetadata && (
                  <>
                    <dt>Output</dt>
                    <dd>{detailData.outputMetadata.displayName} · {detailData.outputMetadata.mimeType} · {detailData.outputMetadata.sizeBytes != null ? formatBytes(detailData.outputMetadata.sizeBytes) : "không rõ dung lượng"}</dd>
                  </>
                )}
                {detailData.workerSummary && (
                  <>
                    <dt>Worker</dt>
                    <dd>{detailData.workerSummary.accountLabel} · {detailData.workerSummary.state}</dd>
                  </>
                )}
                <dt>Thử nghiệm</dt>
                <dd>{detailData.attemptSummary.count} lượt · {detailData.attemptSummary.activeCount} đang chạy</dd>
              </dl>

              <div>
                {!isTerminalJobState(detailData.state) && isCancelableJobState(detailData.state) && (
                  <button type="button" onClick={() => doCancel(detailData.id)}>Hủy job {detailData.projectName}</button>
                )}
                {!isTerminalJobState(detailData.state) && !isCancelableJobState(detailData.state) && <span>Không thể hủy</span>}
                {isTerminalJobState(detailData.state) && <span>Đã hoàn tất</span>}
              </div>
            </>
          )}
        </dialog>
      )}

      <button type="button" onClick={doRefresh}>Làm mới danh sách job</button>
    </section>
  );
}
