"use client";

import { useEffect, useState } from "react";
import type { WorkerViewModel } from "./dashboard-types";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type Clipboard = Readonly<{ writeText(value: string): Promise<void> }>;
const CONNECTOR_URL = "http://127.0.0.1:55871";

export function WorkerCard({
  workers,
  fetcher = fetch,
  clipboard,
  connectorFetcher = fetch,
}: {
  workers: readonly WorkerViewModel[];
  fetcher?: Fetcher;
  clipboard?: Clipboard;
  connectorFetcher?: Fetcher;
}) {
  const [command, setCommand] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [sshCommand, setSshCommand] = useState("ssh root@n1.ckey.vn -p 1210");
  const [password, setPassword] = useState("");
  const [setupStage, setSetupStage] = useState<string | null>(null);
  const [setupPercent, setSetupPercent] = useState(0);

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

  async function setupVps() {
    if (!sshCommand.trim() || !password) { setMessage("Nhập SSH command và mật khẩu VPS trước."); return; }
    setSetupStage("CONNECTING"); setSetupPercent(5); setMessage("Đang xin phiên setup an toàn…");
    const enrollment = await fetcher("/api/v1/workers/enrollment", { method: "POST", headers: { origin: window.location.origin } });
    if (!enrollment.ok) { setSetupStage("FAILED"); setMessage("Không tạo được phiên setup worker."); return; }
    const enrollmentBody = await enrollment.json() as { command?: string };
    if (typeof enrollmentBody.command !== "string") { setSetupStage("FAILED"); setMessage("Phiên setup worker không hợp lệ."); return; }
    const originNonce = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const connector = await connectorFetcher(`${CONNECTOR_URL}/setup`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: window.location.origin },
      body: JSON.stringify({ sshCommand, password, originNonce, bootstrapCommand: enrollmentBody.command }),
    }).catch(() => null);
    setPassword("");
    if (!connector?.ok) { setSetupStage("FAILED"); setMessage("Chưa kết nối được Local VPS Connector. Hãy mở connector trên máy này rồi thử lại."); return; }
    const job = await connector.json() as { jobId?: string };
    if (typeof job.jobId !== "string") { setSetupStage("FAILED"); setMessage("Connector trả về mã setup không hợp lệ."); return; }
    const events = await connectorFetcher(`${CONNECTOR_URL}/setup/${job.jobId}/events`, { headers: { accept: "text/event-stream", origin: window.location.origin } }).catch(() => null);
    if (!events?.ok) { setSetupStage("FAILED"); setMessage("Không đọc được tiến trình setup VPS."); return; }
    const text = await events.text();
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        const event = JSON.parse(line.slice(6)) as { stage?: string; percent?: number; message?: string };
        if (event.stage) setSetupStage(event.stage);
        if (typeof event.percent === "number") setSetupPercent(event.percent);
        if (event.message) setMessage(event.message);
      } catch { /* Ignore malformed progress lines. */ }
    }
  }

  return (
    <section className="workspace-card worker-card" aria-label="Gắn VPS">
      <div className="card-heading">
        <div><p className="eyebrow">Worker</p><h2>VPS render</h2></div>
        <span className="connection-badge">{workers.length > 0 ? `${workers.length} máy` : "Chưa gắn"}</span>
      </div>
      <p>Dán lệnh SSH từ CKEY. Mật khẩu chỉ đi tới Local VPS Connector trên máy anh, không gửi lên Vercel.</p>
      <div className="worker-setup-form">
        <label htmlFor="ssh-command">SSH command</label>
        <input id="ssh-command" value={sshCommand} onChange={(event) => setSshCommand(event.target.value)} autoComplete="off" spellCheck={false} />
        <label htmlFor="vps-password">Mật khẩu VPS</label>
        <input id="vps-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" />
        <button type="button" onClick={setupVps}>Kết nối và setup VPS</button>
        {setupStage && <p aria-live="polite">{setupStage} · {setupPercent}%</p>}
      </div>
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
