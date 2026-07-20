"use client";

import { useState } from "react";
import type { DriveConnectionView, FreeTierHealthView } from "./dashboard-types";

const STATUS_LABELS = {
  CONNECTED: "Đã kết nối",
  DISCONNECTED: "Chưa kết nối",
  REAUTH_REQUIRED: "Cần kết nối lại",
  REVOKE_PENDING: "Đang chờ ngắt kết nối",
} as const;

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 ** 2) return `${(value / 1_024).toFixed(1)} KiB`;
  if (value < 1_024 ** 3) return `${(value / 1_024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1_024 ** 3).toFixed(2)} GiB`;
}

function validAuthorizationUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4_096) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "accounts.google.com" &&
      url.pathname === "/o/oauth2/v2/auth" &&
      url.username === "" && url.password === "" && url.hash === "";
  } catch {
    return false;
  }
}

export function DriveCard({
  value,
  health,
  fetcher = globalThis.fetch,
  navigate = (url) => window.location.assign(url),
}: Readonly<{
  value: DriveConnectionView;
  health: FreeTierHealthView;
  fetcher?: typeof fetch;
  navigate?: (url: string) => void;
}>) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function connect() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetcher("/api/v1/drive/connect", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body = await response.json() as { authorizationUrl?: unknown; code?: unknown };
      if (!response.ok || !validAuthorizationUrl(body.authorizationUrl)) throw new Error("CONNECT_FAILED");
      navigate(body.authorizationUrl);
    } catch {
      setMessage("Chưa thể bắt đầu kết nối Google Drive.");
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetcher("/api/v1/drive/disconnect", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error("DISCONNECT_FAILED");
      setMessage("Đã gửi yêu cầu ngắt kết nối. File riêng tư vẫn được giữ nguyên.");
    } catch {
      setMessage("Chưa thể ngắt kết nối Google Drive.");
    } finally {
      setBusy(false);
    }
  }

  const canDisconnect = value.status === "CONNECTED";
  const canConnect = value.status === "DISCONNECTED" || value.status === "REAUTH_REQUIRED";
  return (
    <section className="workspace-card drive-card" aria-labelledby="drive-title">
      <div className="card-heading">
        <div>
          <p className="eyebrow">Kho video riêng tư</p>
          <h2 id="drive-title">Google Drive</h2>
        </div>
        <span className={`connection-badge connection-${value.status.toLowerCase()}`}>
          {STATUS_LABELS[value.status]}
        </span>
      </div>

      {value.accountHint && <p className="account-hint">Tài khoản: <strong>{value.accountHint}</strong></p>}
      <p>{value.rootReady ? "Thư mục YTB-VPS đã sẵn sàng và riêng tư." : "Chưa có thư mục làm việc được xác minh."}</p>
      {value.rootReady && <div className="drive-folder-list" aria-label="Thư mục Drive được quản lý"><span>YTB-VPS / <strong>input</strong><small>Video nguồn tải lên</small></span><span>YTB-VPS / <strong>output</strong><small>Video render theo tên phim</small></span></div>}

      {health.drive && (
        <dl className="usage-grid">
          <div><dt>Đã dùng</dt><dd>{formatBytes(health.drive.usedBytes)}</dd></div>
          <div><dt>Giới hạn</dt><dd>{formatBytes(health.drive.limitBytes)}</dd></div>
          <div><dt>Dữ liệu dự án</dt><dd>{formatBytes(health.drive.appManagedBytes)}</dd></div>
        </dl>
      )}

      <div className="button-row">
        {canConnect && (
          <button type="button" onClick={connect} disabled={busy}>
            {value.status === "REAUTH_REQUIRED" ? "Kết nối lại Google Drive" : "Kết nối Google Drive"}
          </button>
        )}
        {canDisconnect && <button type="button" className="button-secondary" onClick={disconnect} disabled={busy}>Ngắt kết nối</button>}
        {value.status === "REVOKE_PENDING" && <button type="button" disabled>Đang xử lý ngắt kết nối</button>}
      </div>
      {message && <p role="status" aria-live="polite">{message}</p>}
    </section>
  );
}
