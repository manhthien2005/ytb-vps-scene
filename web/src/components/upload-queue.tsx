"use client";

import { useState } from "react";
import { PauseIcon, PlayIcon, TrashIcon } from "./drive-icons";
import type { UploadQueueItem } from "./use-upload-queue";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const NUMBER_FORMAT = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 });
const PAUSED_PHASES = new Set(["PAUSED", "PAUSED_ERROR", "PAUSED_VERIFYING"]);

function formatSize(bytes: number): string {
  const safeBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  const divisor = safeBytes >= GIB ? GIB : MIB;
  return `${NUMBER_FORMAT.format(safeBytes / divisor)} ${divisor === GIB ? "GB" : "MB"}`;
}

function progress(item: UploadQueueItem): Readonly<{
  committedBytes: number;
  percent: number;
  totalBytes: number;
}> {
  const totalBytes = item.snapshot.totalBytes > 0 ? item.snapshot.totalBytes : item.file.size;
  const committedBytes = Math.min(Math.max(item.snapshot.committedBytes, 0), totalBytes);
  const percent = item.state === "DONE"
    ? 100
    : totalBytes > 0 ? Math.floor(committedBytes * 100 / totalBytes) : 0;
  return { committedBytes, percent, totalBytes };
}

function statusLabel(item: UploadQueueItem): string {
  if (item.state === "QUEUED") return "Chờ tải";
  if (item.state === "DONE") return "Đã lên Drive";
  if (item.state === "FAILED") return "Tải lỗi";
  if (item.state === "CANCELLED") return "Đã huỷ";
  if (item.snapshot.phase === "CANCELLED") return "Chờ dọn dẹp";
  if (item.snapshot.phase === "PAUSED") return "Tạm dừng";
  if (item.snapshot.phase === "PAUSED_ERROR" || item.snapshot.phase === "PAUSED_VERIFYING") {
    return "Chờ thử lại";
  }
  if (item.snapshot.phase === "VERIFYING") return "Đang xác minh";
  return "Đang tải";
}

function etaLabel(item: UploadQueueItem, totalBytes: number, committedBytes: number): string | null {
  const remainingBytes = totalBytes - committedBytes;
  const seconds = remainingBytes / item.snapshot.bytesPerSecond;
  if (
    item.state !== "ACTIVE" ||
    item.snapshot.phase !== "UPLOADING" ||
    item.snapshot.bytesPerSecond <= 0 ||
    remainingBytes <= 0 ||
    !Number.isFinite(seconds)
  ) {
    return null;
  }

  if (seconds < 60) return `Còn khoảng ${Math.max(1, Math.ceil(seconds))} giây`;
  if (seconds < 3600) return `Còn khoảng ${Math.ceil(seconds / 60)} phút`;
  return `Còn khoảng ${NUMBER_FORMAT.format(Math.ceil(seconds / 360) / 10)} giờ`;
}

function QueueAction({
  kind,
  label,
  disabled = false,
  onClick,
}: Readonly<{
  kind: "pause" | "resume" | "cancel" | "retry";
  label: string;
  disabled?: boolean;
  onClick: () => void;
}>) {
  const Icon = kind === "pause" ? PauseIcon : kind === "cancel" ? TrashIcon : PlayIcon;
  return (
    <button
      aria-label={label}
      className={`drive-upload-action drive-upload-action-${kind}`}
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      <Icon aria-hidden size={18} />
    </button>
  );
}

export function UploadQueue({
  items,
  onPause,
  onResume,
  onCancel,
  onRetry,
}: Readonly<{
  items: readonly UploadQueueItem[];
  onPause: (id: string) => void;
  onResume: (id: string) => Promise<void> | void;
  onCancel: (id: string) => Promise<void> | void;
  onRetry: (id: string) => Promise<void> | void;
}>) {
  const [pendingActions, setPendingActions] = useState<ReadonlySet<string>>(() => new Set());
  const visibleItems = items.filter((item) => item.state !== "CANCELLED");
  if (visibleItems.length === 0) return null;

  async function runPendingAction(key: string, action: () => Promise<void> | void): Promise<void> {
    setPendingActions((current) => new Set(current).add(key));
    try {
      await action();
    } catch {
      // The queue controller owns user-facing error state.
    } finally {
      setPendingActions((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }

  return (
    <section aria-label="Hàng đợi tải lên" className="drive-upload-queue">
      <div className="drive-upload-queue-heading">
        <h3>Hàng đợi tải lên</h3>
        <span>{visibleItems.length} video</span>
      </div>
      <ul className="drive-upload-list">
        {visibleItems.map((item) => {
          const { committedBytes, percent, totalBytes } = progress(item);
          const eta = etaLabel(item, totalBytes, committedBytes);
          const paused = item.state === "ACTIVE" && PAUSED_PHASES.has(item.snapshot.phase);
          const pausable = item.state === "ACTIVE" && (
            item.snapshot.phase === "UPLOADING" || item.snapshot.phase === "VERIFYING"
          );
          const cancellable = item.state !== "DONE";
          const fileName = item.file.name;

          return (
            <li className={`drive-upload-item drive-upload-item-${item.state.toLowerCase()}`} key={item.id}>
              <div className="drive-upload-item-heading">
                <strong title={fileName}>{fileName}</strong>
                <span>{statusLabel(item)}</span>
              </div>
              <div
                aria-label={`Tiến trình ${item.title}`}
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={percent}
                className="upload-bar"
                role="progressbar"
              >
                <div className="upload-bar-fill" data-phase={item.snapshot.phase} style={{ width: `${percent}%` }} />
              </div>
              <div className="drive-upload-item-footer">
                <div className="drive-upload-item-meta">
                  <span>{percent}%</span>
                  <span>{formatSize(committedBytes)} / {formatSize(totalBytes)}</span>
                  {eta !== null && <span>{eta}</span>}
                </div>
                <div aria-label={`Thao tác ${fileName}`} className="drive-upload-actions">
                  {pausable && (
                    <QueueAction kind="pause" label={`Tạm dừng ${fileName}`} onClick={() => onPause(item.id)} />
                  )}
                  {paused && (
                    <QueueAction
                      disabled={pendingActions.has(`${item.id}:resume`)}
                      kind="resume"
                      label={`Tiếp tục ${fileName}`}
                      onClick={() => void runPendingAction(`${item.id}:resume`, () => onResume(item.id))}
                    />
                  )}
                  {item.state === "FAILED" && item.mimeType !== "" && (
                    <QueueAction
                      disabled={pendingActions.has(`${item.id}:retry`)}
                      kind="retry"
                      label={`Thử lại ${fileName}`}
                      onClick={() => void runPendingAction(`${item.id}:retry`, () => onRetry(item.id))}
                    />
                  )}
                  {cancellable && (
                    <QueueAction
                      disabled={pendingActions.has(`${item.id}:cancel`)}
                      kind="cancel"
                      label={`Dừng và huỷ ${fileName}`}
                      onClick={() => {
                        if (
                          committedBytes > 0 &&
                          !window.confirm(`Dừng và huỷ vĩnh viễn ${fileName}?`)
                        ) {
                          return;
                        }
                        void runPendingAction(`${item.id}:cancel`, () => onCancel(item.id));
                      }}
                    />
                  )}
                </div>
              </div>
              {item.message !== null && <p role="alert">{item.message}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
