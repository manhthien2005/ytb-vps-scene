"use client";

import { useEffect, useState } from "react";
import type { WorkerViewModel } from "./dashboard-types";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type Clipboard = Readonly<{ writeText(value: string): Promise<void> }>;

export function WorkerCard({
  workers,
  fetcher = fetch,
  clipboard,
}: {
  workers: readonly WorkerViewModel[];
  fetcher?: Fetcher;
  clipboard?: Clipboard;
}) {
  const [command, setCommand] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => () => setCommand(null), []);

  async function createCommand() {
    const response = await fetcher("/api/v1/workers/enrollment", { method: "POST", headers: { origin: window.location.origin } });
    if (!response.ok) {
      setMessage("Không tạo được lệnh gắn VPS.");
      return;
    }
    const body = await response.json() as { command?: string; expiresAt?: string };
    if (typeof body.command !== "string" || typeof body.expiresAt !== "string") {
      setMessage("Phản hồi gắn VPS không hợp lệ.");
      return;
    }
    setCommand(body.command);
    setExpiresAt(body.expiresAt);
    setMessage("Lệnh chỉ hiển thị trong phiên này và sẽ tự hết hạn.");
  }

  async function copyCommand() {
    if (command === null) return;
    const target = clipboard ?? navigator.clipboard;
    await target.writeText(command);
    setMessage("Đã sao chép lệnh.");
  }

  async function revoke(workerId: string) {
    const response = await fetcher(`/api/v1/workers/${workerId}/revoke`, {
      method: "POST",
      headers: { origin: window.location.origin },
    });
    if (response.ok) {
      setCommand(null);
      setExpiresAt(null);
      setMessage("Đã thu hồi phiên VPS.");
    }
  }

  return (
    <section className="workspace-card worker-card" aria-label="Gắn VPS">
      <div className="card-heading">
        <div><p className="eyebrow">Worker</p><h2>VPS render</h2></div>
        <span className="connection-badge">{workers.length > 0 ? `${workers.length} máy` : "Chưa gắn"}</span>
      </div>
      <p>Gắn VPS bằng một lệnh dùng một lần. VPS tự gọi về web qua HTTPS; web không SSH vào máy.</p>
      <button type="button" onClick={createCommand}>Tạo lệnh gắn VPS</button>
      {command !== null && (
        <div className="worker-command" aria-live="polite">
          <p>Lệnh hết hạn: {expiresAt}</p>
          <code>{command}</code>
          <div className="button-row">
            <button type="button" className="button-secondary" onClick={copyCommand}>Sao chép lệnh</button>
            <button type="button" className="button-secondary" onClick={() => { setCommand(null); setExpiresAt(null); }}>Ẩn lệnh</button>
          </div>
        </div>
      )}
      {message !== null && <p aria-live="polite" className="field-note">{message}</p>}
      <ul className="worker-list">
        {workers.map((worker) => (
          <li key={worker.id}>
            <div>
              <strong>{worker.state === "READY" ? "Đã kết nối" : worker.state === "REVOKED" ? "Đã thu hồi" : "Đang kiểm tra"}</strong>
              <span>{worker.capabilities.pipelineBridgeVersion === "cp3-control-only" ? "Đã kết nối · đang chờ cài pipeline media" : `Bridge ${worker.capabilities.pipelineBridgeVersion}`}</span>
            </div>
            {worker.state !== "REVOKED" && <button type="button" className="button-danger" onClick={() => revoke(worker.id)}>Thu hồi</button>}
          </li>
        ))}
      </ul>
    </section>
  );
}
