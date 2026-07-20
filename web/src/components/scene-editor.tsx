"use client";

import { useEffect, useRef, useState } from "react";
import type { SceneRectangle, SceneSettings } from "@/lib/domain/scene-settings";

const DEFAULTS: SceneSettings = {
  sourceSubtitle: { x: 0.05, y: 0.78, width: 0.9, height: 0.16 },
  logo: { x: 0.78, y: 0.04, width: 0.18, height: 0.16 },
  voice: "vi-VN-HoaiMyNeural",
  rate: 1,
};

function rectangleStyle(rectangle: SceneRectangle): React.CSSProperties {
  return { left: `${rectangle.x * 100}%`, top: `${rectangle.y * 100}%`, width: `${rectangle.width * 100}%`, height: `${rectangle.height * 100}%` };
}

export function SceneEditor({ projectId, fetcher = fetch }: { projectId: string | null; fetcher?: typeof fetch }) {
  const preview = useRef<HTMLDivElement>(null);
  const [settings, setSettings] = useState<SceneSettings>(DEFAULTS);
  const [kind, setKind] = useState<"sourceSubtitle" | "logo">("sourceSubtitle");
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [ttsText, setTtsText] = useState("Xin chào, đây là giọng đọc thử.");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (projectId === null) return;
    fetcher(`/api/v1/projects/${projectId}/scene-settings`).then(async (response) => {
      if (!response.ok) return;
      const body = await response.json() as { settings?: SceneSettings | null };
      if (body.settings) setSettings(body.settings);
    }).catch(() => undefined);
  }, [fetcher, projectId]);

  useEffect(() => () => { if (videoUrl) URL.revokeObjectURL(videoUrl); }, [videoUrl]);

  function point(event: React.PointerEvent) {
    const bounds = preview.current?.getBoundingClientRect();
    if (!bounds) return null;
    return { x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) };
  }
  function start(event: React.PointerEvent) { const value = point(event); if (value) { setDragStart(value); (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); } }
  function finish(event: React.PointerEvent) {
    if (!dragStart) return;
    const end = point(event); setDragStart(null); if (!end) return;
    const rectangle = { x: Math.min(dragStart.x, end.x), y: Math.min(dragStart.y, end.y), width: Math.abs(end.x - dragStart.x), height: Math.abs(end.y - dragStart.y) };
    if (rectangle.width < 0.01 || rectangle.height < 0.01) return;
    setSettings((current) => ({ ...current, [kind]: rectangle }));
  }
  async function save() {
    if (projectId === null) return;
    const response = await fetcher(`/api/v1/projects/${projectId}/scene-settings`, { method: "PUT", headers: { "content-type": "application/json", origin: window.location.origin }, body: JSON.stringify({ settings }) });
    setMessage(response.ok ? "Đã lưu vùng blur và voice." : "Chưa lưu được cấu hình.");
  }
  function speak() {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) { setMessage("Trình duyệt chưa hỗ trợ nghe thử voice."); return; }
    const utterance = new SpeechSynthesisUtterance(ttsText);
    utterance.lang = "vi-VN";
    utterance.rate = settings.rate;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    setMessage(`Đang nghe thử ${settings.voice}.`);
  }

  return (
    <section className="workspace-card scene-editor" aria-label="Blur và voice">
      <div className="card-heading"><div><p className="eyebrow">Review trước render</p><h2>Blur + voice TTS</h2></div><span className="mode-badge">{projectId ? "Đã chọn dự án" : "Chưa có nguồn"}</span></div>
      <p>Kéo trực tiếp trên khung preview để chọn hình chữ nhật. Vùng phụ đề sẽ dùng để che subtitle gốc; vùng logo chỉ blur.</p>
      <div className="scene-toolbar">
        <label><input type="radio" checked={kind === "sourceSubtitle"} onChange={() => setKind("sourceSubtitle")} /> Vùng phụ đề gốc</label>
        <label><input type="radio" checked={kind === "logo"} onChange={() => setKind("logo")} /> Vùng logo</label>
        <label htmlFor="scene-video">Video preview</label>
        <input id="scene-video" type="file" accept="video/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) setVideoUrl(URL.createObjectURL(file)); }} />
      </div>
      <div ref={preview} className="scene-preview" onPointerDown={start} onPointerUp={finish} role="application" aria-label="Kéo để chọn vùng blur">
        {videoUrl && <video src={videoUrl} controls muted playsInline />}
        <span className="scene-rectangle scene-subtitle" style={rectangleStyle(settings.sourceSubtitle)} />
        <span className="scene-rectangle scene-logo" style={rectangleStyle(settings.logo)} />
      </div>
      <div className="scene-tts">
        <label htmlFor="tts-text">Nghe thử câu voice</label>
        <textarea id="tts-text" value={ttsText} onChange={(event) => setTtsText(event.target.value)} maxLength={500} />
        <label htmlFor="tts-voice">Voice</label>
        <select id="tts-voice" value={settings.voice} onChange={(event) => setSettings((current) => ({ ...current, voice: event.target.value as SceneSettings["voice"] }))}>
          <option value="vi-VN-HoaiMyNeural">Hoài My · nữ</option><option value="vi-VN-NamMinhNeural">Nam Minh · nam</option>
        </select>
        <label htmlFor="tts-rate">Tốc độ: {settings.rate.toFixed(2)}x</label>
        <input id="tts-rate" type="range" min="0.8" max="1.2" step="0.05" value={settings.rate} onChange={(event) => setSettings((current) => ({ ...current, rate: Number(event.target.value) }))} />
        <div className="button-row"><button type="button" onClick={speak}>Nghe thử TTS</button><button type="button" className="button-secondary" disabled={projectId === null} onClick={save}>Lưu cấu hình</button></div>
      </div>
      {message && <p aria-live="polite">{message}</p>}
    </section>
  );
}
