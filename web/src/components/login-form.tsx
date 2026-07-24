"use client";

import Image from "next/image";
import { type FormEvent, type PointerEvent, useState } from "react";

type Fetcher = (input: string, init: RequestInit) => Promise<Readonly<{ ok: boolean }>>;
type LoginFormProps = Readonly<{ fetcher?: Fetcher; onSuccess?: () => void }>;

export function LoginForm({
  fetcher = (input, init) => fetch(input, init),
  onSuccess = () => window.location.reload(),
}: LoginFormProps) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Track the cursor as a CSS variable so the card sheen follows it without re-rendering.
  function trackPointer(event: PointerEvent<HTMLFormElement>): void {
    const rect = event.currentTarget.getBoundingClientRect();
    const style = event.currentTarget.style;
    style.setProperty("--mx", `${event.clientX - rect.left}px`);
    style.setProperty("--my", `${event.clientY - rect.top}px`);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const response = await fetcher("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: form.get("key") }),
    });
    setBusy(false);
    if (!response.ok) {
      setError("Admin key không đúng hoặc yêu cầu bị từ chối.");
      return;
    }
    onSuccess();
  }

  return (
    <form className="auth-card" onSubmit={submit} onPointerMove={trackPointer}>
      <div className="auth-brand">
        <span className="brand-mark" aria-hidden><Image alt="" height={42} priority src="/logo.svg" width={42} /></span>
        <div>
          <p className="micro-label">Truy cập riêng tư</p>
          <h1>Zeus MMO</h1>
        </div>
      </div>
      <p>Control plane cho video production và VPS render.</p>
      <label htmlFor="admin-key">Admin key</label>
      <input
        id="admin-key"
        name="key"
        type="password"
        autoComplete="current-password"
        required
      />
      {error && <p className="field-error" role="alert">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? "Đang mở" : "Mở bảng điều khiển"}</button>
    </form>
  );
}
