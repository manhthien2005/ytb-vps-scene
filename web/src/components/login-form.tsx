"use client";

import { type FormEvent, useState } from "react";

type Fetcher = (input: string, init: RequestInit) => Promise<Readonly<{ ok: boolean }>>;
type LoginFormProps = Readonly<{ fetcher?: Fetcher; onSuccess?: () => void }>;

export function LoginForm({
  fetcher = (input, init) => fetch(input, init),
  onSuccess = () => window.location.reload(),
}: LoginFormProps) {
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const response = await fetcher("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: form.get("key") }),
    });
    if (!response.ok) {
      setError("Admin key không đúng hoặc yêu cầu bị từ chối.");
      return;
    }
    onSuccess();
  }

  return (
    <form className="auth-card" onSubmit={submit}>
      <p className="eyebrow">Truy cập riêng tư</p>
      <h1>YTB VPS Studio</h1>
      <label htmlFor="admin-key">Admin key</label>
      <input
        id="admin-key"
        name="key"
        type="password"
        autoComplete="current-password"
        required
      />
      {error && <p role="alert">{error}</p>}
      <button type="submit">Mở bảng điều khiển</button>
    </form>
  );
}
