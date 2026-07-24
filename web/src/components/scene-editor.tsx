"use client";

import { useEffect, useRef, useState } from "react";
import { parseSceneSettings, type SceneRectangle, type SceneSettings } from "@/lib/domain/scene-settings";

const DEFAULTS: SceneSettings = {
  version: 1,
  sourceArtifactId: null,
  sourceSubtitle: { x: 0.05, y: 0.78, width: 0.9, height: 0.16 },
  logo: { x: 0.78, y: 0.04, width: 0.18, height: 0.16 },
  voice: "BV074_streaming",
  rate: 1,
};

function rectangleStyle(rectangle: SceneRectangle): React.CSSProperties {
  return { left: `${rectangle.x * 100}%`, top: `${rectangle.y * 100}%`, width: `${rectangle.width * 100}%`, height: `${rectangle.height * 100}%` };
}

export function SceneEditor({ projectId, sourceFile = null, fetcher = fetch }: { projectId: string | null; sourceFile?: File | null; fetcher?: typeof fetch }) {
  const preview = useRef<HTMLDivElement>(null);
  const settingsLoadGeneration = useRef(0);
  const [settings, setSettings] = useState<SceneSettings>(DEFAULTS);
  const [settingsProjectId, setSettingsProjectId] = useState(projectId);
  const [kind, setKind] = useState<"sourceSubtitle" | "logo">("sourceSubtitle");
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [ttsText, setTtsText] = useState("Xin chào, đây là giọng đọc thử.");
  const [message, setMessage] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const previewUrl = videoUrl ?? sourceUrl;

  if (settingsProjectId !== projectId) {
    setSettingsProjectId(projectId);
    setSettings(DEFAULTS);
  }

  useEffect(() => {
    if (sourceFile === null || typeof URL.createObjectURL !== "function") return;
    const url = URL.createObjectURL(sourceFile);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- object URLs must be created in an effect so Strict Mode's setup/cleanup cycle recreates what it revokes
    setSourceUrl(url);
    return () => {
      if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
      setSourceUrl((current) => current === url ? null : current);
    };
  }, [sourceFile]);

  useEffect(() => {
    const generation = ++settingsLoadGeneration.current;
    const invalidate = () => {
      if (generation === settingsLoadGeneration.current) settingsLoadGeneration.current += 1;
    };
    if (projectId === null) return invalidate;
    fetcher(`/api/v1/projects/${projectId}/scene-settings`).then(async (response) => {
      if (!response.ok || generation !== settingsLoadGeneration.current) return;
      const body = await response.json() as { settings?: SceneSettings | null };
      if (generation !== settingsLoadGeneration.current) return;
      if (body.settings) {
        try { setSettings(parseSceneSettings(body.settings)); } catch { setSettings(DEFAULTS); }
      } else {
        setSettings(DEFAULTS);
      }
    }).catch(() => undefined);
    return invalidate;
  }, [fetcher, projectId]);

  useEffect(() => () => {
    if (videoUrl && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(videoUrl);
  }, [videoUrl]);

  useEffect(() => () => {
    if (audioUrl && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

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
  async function speak() {
    setMessage("Đang tạo file nghe thử BV074…");
    try {
      const response = await fetcher("/api/v1/tts-preview", {
        method: "POST",
        headers: { "content-type": "application/json", origin: window.location.origin },
        body: JSON.stringify({ text: ttsText, rate: settings.rate }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { code?: string } | null;
        throw new Error(body?.code ?? "TTS_PREVIEW_UNAVAILABLE");
      }
      const blob = await response.blob();
      if (audioUrl && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(audioUrl);
      const next = URL.createObjectURL(blob);
      setAudioUrl(next);
      const audio = new Audio(next);
      await audio.play();
      setMessage(`Đang nghe thử BV074.`);
    } catch {
      setMessage("Chưa tạo được nghe thử BV074.");
    }
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
        {previewUrl && <video src={previewUrl} controls muted playsInline preload="metadata" />}
        <span className="scene-rectangle scene-subtitle" style={rectangleStyle(settings.sourceSubtitle)} />
        <span className="scene-rectangle scene-logo" style={rectangleStyle(settings.logo)} />
      </div>
      <div className="scene-tts">
        <label htmlFor="tts-text">Nghe thử câu voice</label>
        <textarea id="tts-text" value={ttsText} onChange={(event) => setTtsText(event.target.value)} maxLength={500} />
        <p><strong>Voice:</strong> CapCut BV074 (giọng cũ v1)</p>
        <label htmlFor="tts-rate">Tốc độ: {settings.rate.toFixed(2)}x</label>
        <input id="tts-rate" type="range" min="0.8" max="1.2" step="0.05" value={settings.rate} onChange={(event) => setSettings((current) => ({ ...current, rate: Number(event.target.value) }))} />
        <div className="button-row"><button type="button" onClick={speak}>Nghe thử TTS</button><button type="button" className="button-secondary" disabled={projectId === null} onClick={save}>Lưu cấu hình</button></div>
      </div>
      {message && <p aria-live="polite">{message}</p>}
    </section>
  );
}
