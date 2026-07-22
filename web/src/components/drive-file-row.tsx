"use client";

import { useState, type KeyboardEvent } from "react";
import type { DriveWorkspaceFile } from "./dashboard-types";
import {
  ChevronIcon,
  ClockIcon,
  DimensionsIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileVideoIcon,
  TimerIcon,
  TrashIcon,
} from "./drive-icons";

const NUMBER_FORMATTER = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 });
const DATE_FORMATTER = new Intl.DateTimeFormat("vi-VN", {
  dateStyle: "short",
  timeStyle: "short",
});
const DRIVE_LINK_HOSTS = new Set(["drive.google.com", "drive.usercontent.google.com"]);

export type DriveFileRowProps = Readonly<{
  file: DriveWorkspaceFile;
  onDelete: (artifactId: string) => void | Promise<void>;
  defaultExpanded?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}>;

export function formatDriveFileSize(sizeBytes: number): string {
  const gigabyte = 1_024 ** 3;
  const unit = sizeBytes >= gigabyte ? "GB" : "MB";
  const divisor = sizeBytes >= gigabyte ? gigabyte : 1_024 ** 2;
  return `${NUMBER_FORMATTER.format(sizeBytes / divisor)} ${unit}`;
}

export function formatDriveDuration(durationMillis: number | null): string {
  if (durationMillis === null) return "Chưa có";
  const totalSeconds = Math.floor(durationMillis / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

function formatUploadedAt(uploadedAt: string): string {
  const date = new Date(uploadedAt);
  return Number.isNaN(date.valueOf()) ? "Chưa xác định" : DATE_FORMATTER.format(date);
}

function formatResolution(file: DriveWorkspaceFile): string {
  return file.width === null || file.height === null
    ? "Chưa có"
    : `${file.width} × ${file.height}`;
}

function safeDriveUrl(value: string | null): string | null {
  if (value === null || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      DRIVE_LINK_HOSTS.has(url.hostname) &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === ""
      ? value
      : null;
  } catch {
    return null;
  }
}

function readinessLabel(readiness: DriveWorkspaceFile["readiness"]): string {
  if (readiness === "READY") return "Sẵn sàng xem";
  if (readiness === "PROCESSING") return "Drive đang xử lý";
  return "Chưa xác định";
}

export function DriveFileRow({
  file,
  onDelete,
  defaultExpanded = false,
  expanded,
  onExpandedChange,
}: DriveFileRowProps) {
  const [localExpanded, setLocalExpanded] = useState(defaultExpanded);
  const [deleteState, setDeleteState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const isExpanded = expanded ?? localExpanded;
  const viewUrl = file.readiness === "READY" ? safeDriveUrl(file.viewUrl) : null;
  const downloadUrl = safeDriveUrl(file.downloadUrl);

  function setExpanded(nextExpanded: boolean) {
    if (expanded === undefined) setLocalExpanded(nextExpanded);
    onExpandedChange?.(nextExpanded);
  }

  function toggleExpanded() {
    setExpanded(!isExpanded);
  }

  function handleToggleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if ((event.key === "Enter" || event.key === " ") && !event.repeat) {
      event.preventDefault();
      toggleExpanded();
    }
  }

  async function deleteFile() {
    if (!globalThis.confirm(`Xoá video "${file.name}"?`)) return;
    setDeleteState("pending");
    try {
      await onDelete(file.artifactId);
      setDeleteState("success");
    } catch {
      setDeleteState("error");
    }
  }

  const toggleLabel = `${isExpanded ? "Đóng" : "Mở"} thông tin ${file.name}`;
  return (
    <li className={`drive-file-row${isExpanded ? " drive-file-row-expanded" : ""}`}>
      <button
        aria-expanded={isExpanded}
        aria-label={toggleLabel}
        className="drive-file-toggle"
        onClick={toggleExpanded}
        onKeyDown={handleToggleKeyDown}
        style={{ minHeight: 44, minWidth: 0, width: "100%" }}
        title={toggleLabel}
        type="button"
      >
        <ChevronIcon aria-hidden direction={isExpanded ? "down" : "right"} size={18} />
        <FileVideoIcon aria-hidden className="drive-file-video-icon" size={20} />
        <span className="drive-file-name" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={file.name}>
          {file.name}
        </span>
        <span className="drive-file-size">{formatDriveFileSize(file.sizeBytes)}</span>
      </button>

      {isExpanded && (
        <div className="drive-file-details">
          <div className="drive-file-stats" aria-label={`Thông tin ${file.name}`}>
            <span className="drive-file-stat" title="Thời gian tải lên">
              <span aria-hidden data-testid="uploaded-stat-icon"><ClockIcon aria-hidden size={17} /></span>
              {formatUploadedAt(file.uploadedAt)}
            </span>
            <span className="drive-file-stat" title="Thời lượng">
              <span aria-hidden data-testid="duration-stat-icon"><TimerIcon aria-hidden size={17} /></span>
              {formatDriveDuration(file.durationMillis)}
            </span>
            <span className="drive-file-stat" title="Độ phân giải">
              <span aria-hidden data-testid="resolution-stat-icon"><DimensionsIcon aria-hidden size={17} /></span>
              {formatResolution(file)}
            </span>
          </div>

          <div className="drive-file-detail-footer">
            <span className={`drive-file-readiness drive-file-readiness-${file.readiness.toLowerCase()}`}>
              {readinessLabel(file.readiness)}
            </span>
            <div className="drive-file-actions" aria-label={`Thao tác ${file.name}`}>
              {viewUrl ? (
                <a
                  aria-label={`Xem trước ${file.name}`}
                  className="drive-file-action"
                  href={viewUrl}
                  rel="noopener noreferrer"
                  style={{ alignItems: "center", display: "inline-flex", justifyContent: "center", minHeight: 44, minWidth: 44 }}
                  target="_blank"
                  title={`Xem trước ${file.name}`}
                >
                  <ExternalLinkIcon aria-hidden size={18} />
                </a>
              ) : (
                <button aria-label={`Xem trước ${file.name}`} className="drive-file-action" disabled style={{ minHeight: 44, minWidth: 44 }} title={`Xem trước ${file.name}`} type="button">
                  <ExternalLinkIcon aria-hidden size={18} />
                </button>
              )}
              {downloadUrl ? (
                <a
                  aria-label={`Tải xuống ${file.name}`}
                  className="drive-file-action"
                  href={downloadUrl}
                  rel="noopener noreferrer"
                  style={{ alignItems: "center", display: "inline-flex", justifyContent: "center", minHeight: 44, minWidth: 44 }}
                  target="_blank"
                  title={`Tải xuống ${file.name}`}
                >
                  <DownloadIcon aria-hidden size={18} />
                </a>
              ) : (
                <button aria-label={`Tải xuống ${file.name}`} className="drive-file-action" disabled style={{ minHeight: 44, minWidth: 44 }} title={`Tải xuống ${file.name}`} type="button">
                  <DownloadIcon aria-hidden size={18} />
                </button>
              )}
              <button
                aria-busy={deleteState === "pending"}
                aria-label={`${deleteState === "pending" ? "Đang xoá" : "Xoá video"} ${file.name}`}
                className="drive-file-action drive-file-delete"
                disabled={deleteState === "pending"}
                onClick={deleteFile}
                style={{ minHeight: 44, minWidth: 44 }}
                title={`${deleteState === "pending" ? "Đang xoá" : "Xoá video"} ${file.name}`}
                type="button"
              >
                {deleteState === "pending" ? <TimerIcon aria-hidden size={18} /> : <TrashIcon aria-hidden size={18} />}
              </button>
            </div>
          </div>
          {deleteState === "success" && <p aria-live="polite" role="status">Đã xoá {file.name}.</p>}
          {deleteState === "error" && <p role="alert">Chưa thể xoá {file.name}. Vui lòng thử lại.</p>}
        </div>
      )}
    </li>
  );
}
