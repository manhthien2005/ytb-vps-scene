"use client";

import { useEffect, useRef, useState } from "react";
import { parseSceneSettings, type SceneRectangle, type SceneSettings } from "@/lib/domain/scene-settings";

type SceneSettingsV2 = Extract<SceneSettings, Readonly<{ version: 2 }>>;
type BlurRegion = SceneSettingsV2["blur"]["regions"][number];
type QuotaMode = "READ_WRITE" | "READ_ONLY";

type SceneEditorProps = Readonly<{
  projectId: string | null;
  sourceFile?: File | null;
  fetcher?: typeof fetch;
  projectName?: string;
  sourceReady?: boolean;
  workerReady?: boolean;
  quotaMode?: QuotaMode;
}>;

type EditorState = Readonly<{
  settings: SceneSettingsV2;
  saved: boolean;
  saving: boolean;
  queueing: boolean;
  queued: boolean;
  loadWarning: string | null;
  message: string | null;
}>;

type QuotaProbe = Readonly<{
  fetcher: typeof fetch;
  mode: QuotaMode | null;
  warning: string | null;
}>;

const SUBTITLE_DEFAULT: SceneRectangle = { x: 0.05, y: 0.78, width: 0.9, height: 0.16 };
const LOGO_DEFAULT: SceneRectangle = { x: 0.78, y: 0.04, width: 0.18, height: 0.16 };

const DEFAULTS: SceneSettingsV2 = {
  version: 2,
  sourceArtifactId: null,
  split: { mode: "single" },
  blur: {
    mode: "manual",
    regions: [
      { kind: "sourceSubtitle", enabled: true, rectangle: SUBTITLE_DEFAULT },
      { kind: "logo", enabled: true, rectangle: LOGO_DEFAULT },
    ],
  },
  voice: "BV074_streaming",
  rate: 1,
  output: { format: "mp4" },
  preset: null,
  sourceSubtitle: SUBTITLE_DEFAULT,
  logo: LOGO_DEFAULT,
};

function initialEditorState(): EditorState {
  return {
    settings: DEFAULTS,
    saved: false,
    saving: false,
    queueing: false,
    queued: false,
    loadWarning: null,
    message: null,
  };
}

function rectangleStyle(rectangle: SceneRectangle): React.CSSProperties {
  return {
    left: `${rectangle.x * 100}%`,
    top: `${rectangle.y * 100}%`,
    width: `${rectangle.width * 100}%`,
    height: `${rectangle.height * 100}%`,
  };
}

function asVersionTwo(value: unknown): Readonly<{ settings: SceneSettingsV2; migrated: boolean }> {
  const parsed = parseSceneSettings(value);
  if (parsed.version === 2) return { settings: parsed, migrated: false };
  const migrated = parseSceneSettings({
    version: 2,
    sourceArtifactId: parsed.sourceArtifactId,
    split: { mode: "single" },
    blur: {
      mode: "manual",
      regions: [
        { kind: "sourceSubtitle", enabled: true, rectangle: parsed.sourceSubtitle },
        { kind: "logo", enabled: true, rectangle: parsed.logo },
      ],
    },
    voice: parsed.voice,
    rate: parsed.rate,
    output: { format: "mp4" },
    preset: null,
  });
  if (migrated.version !== 2) throw new Error("Unexpected migrated scene settings version");
  return { settings: migrated, migrated: true };
}

function validateVersionTwo(settings: SceneSettingsV2): SceneSettingsV2 {
  const parsed = parseSceneSettings(settings);
  if (parsed.version !== 2) throw new Error("Expected version 2 scene settings");
  return parsed;
}

function withRegions(settings: SceneSettingsV2, regions: readonly BlurRegion[]): SceneSettingsV2 {
  const sourceSubtitle = regions.find((region) => region.kind === "sourceSubtitle");
  const logo = regions.find((region) => region.kind === "logo");
  if (!sourceSubtitle || !logo) return settings;
  return {
    ...settings,
    blur: { ...settings.blur, regions: [...regions] },
    sourceSubtitle: sourceSubtitle.rectangle,
    logo: logo.rectangle,
  };
}

function regionLabel(region: BlurRegion, index: number): string {
  if (region.kind === "sourceSubtitle") return "Vùng phụ đề gốc";
  if (region.kind === "logo") return "Vùng logo";
  const customIndex = index - 1;
  return `Vùng tùy chỉnh ${customIndex}`;
}

function rounded(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return rounded(Math.max(minimum, Math.min(maximum, value)));
}

function updateRectangle(
  rectangle: SceneRectangle,
  key: keyof SceneRectangle,
  rawValue: number,
): SceneRectangle {
  if (!Number.isFinite(rawValue)) return rectangle;
  if (key === "x") return { ...rectangle, x: clamp(rawValue, 0, 1 - rectangle.width) };
  if (key === "y") return { ...rectangle, y: clamp(rawValue, 0, 1 - rectangle.height) };
  if (key === "width") return { ...rectangle, width: clamp(rawValue, 0.01, 1 - rectangle.x) };
  return { ...rectangle, height: clamp(rawValue, 0.01, 1 - rectangle.y) };
}

function settingsAreValid(settings: SceneSettingsV2): boolean {
  try {
    validateVersionTwo(settings);
    return true;
  } catch {
    return false;
  }
}

function ReadinessItem({
  label,
  value,
  tone,
}: Readonly<{ label: string; value: string; tone: "good" | "warn" | "danger" | "neutral" }>) {
  return (
    <div className={`readiness-card readiness-${tone}`}>
      <span>{label}</span>
      <strong><i className="rc-dot" aria-hidden />{value}</strong>
    </div>
  );
}

export function SceneEditor({
  ...props
}: SceneEditorProps) {
  return <SceneEditorProject key={props.projectId ?? "scene-editor-no-project"} {...props} />;
}

function SceneEditorProject({
  projectId,
  sourceFile = null,
  fetcher = fetch,
  projectName,
  sourceReady = projectId !== null,
  workerReady,
  quotaMode,
}: SceneEditorProps) {
  const preview = useRef<HTMLDivElement>(null);
  const settingsLoadGeneration = useRef(0);
  const saveGeneration = useRef(0);
  const revision = useRef(0);
  const queueingGuard = useRef(false);
  const [editor, setEditor] = useState<EditorState>(initialEditorState);
  const [selectedRegionIndex, setSelectedRegionIndex] = useState(0);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [ttsText, setTtsText] = useState("Xin chào, đây là giọng đọc thử.");
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [quotaProbe, setQuotaProbe] = useState<QuotaProbe>(() => ({
    fetcher,
    mode: null,
    warning: null,
  }));

  const settings = editor.settings;
  const selectedIndex = Math.min(selectedRegionIndex, settings.blur.regions.length - 1);
  const selectedRegion = settings.blur.regions[selectedIndex]!;
  const previewUrl = videoUrl ?? sourceUrl;
  const detectedQuotaMode = quotaProbe.fetcher === fetcher ? quotaProbe.mode : null;
  const quotaWarning = quotaProbe.fetcher === fetcher ? quotaProbe.warning : null;
  const resolvedQuotaMode = quotaMode ?? detectedQuotaMode;
  const projectLabel = projectName?.trim()
    || sourceFile?.name
    || (projectId === null ? "Chưa chọn dự án" : `Dự án ${projectId}`);
  const validSettings = settingsAreValid(settings);

  const blockers: string[] = [];
  if (projectId === null) blockers.push("Chưa chọn dự án để render.");
  if (!sourceReady) blockers.push("Video nguồn chưa sẵn sàng.");
  if (!validSettings) blockers.push("Cấu hình chưa hợp lệ.");
  if (!editor.saved) blockers.push("Cấu hình có thay đổi chưa lưu.");
  if (workerReady === false) blockers.push("Worker VPS chưa sẵn sàng.");
  if (workerReady === undefined) blockers.push("Chưa xác minh worker VPS ở trạng thái READY.");
  if (resolvedQuotaMode === "READ_ONLY") blockers.push("Quota Drive đang ở chế độ chỉ đọc.");
  if (resolvedQuotaMode === null) blockers.push("Chưa xác minh quota Drive cho phép đọc/ghi.");
  const canRender = blockers.length === 0 && !editor.queueing && !editor.queued;

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
    const url = `/api/v1/projects/${encodeURIComponent(projectId)}/scene-settings`;
    fetcher(url).then(async (response) => {
      if (generation !== settingsLoadGeneration.current) return;
      if (!response.ok) throw new Error("Scene settings request failed");
      const body = await response.json() as { settings?: unknown };
      if (generation !== settingsLoadGeneration.current) return;
      if (body.settings === null || body.settings === undefined) {
        revision.current += 1;
        setEditor((current) => ({
          ...current,
          settings: DEFAULTS,
          saved: false,
          loadWarning: null,
        }));
        setSelectedRegionIndex(0);
        return;
      }
      const loaded = asVersionTwo(body.settings);
      revision.current += 1;
      setEditor((current) => ({
        ...current,
        settings: loaded.settings,
        saved: !loaded.migrated,
        loadWarning: loaded.migrated
          ? "Cấu hình cũ đã được nâng cấp an toàn. Hãy lưu lại trước khi render."
          : null,
      }));
      setSelectedRegionIndex(0);
    }).catch(() => {
      if (generation !== settingsLoadGeneration.current) return;
      revision.current += 1;
      setEditor((current) => ({
        ...current,
        settings: DEFAULTS,
        saved: false,
        loadWarning: "Không tải được cấu hình đã lưu. Đang dùng mặc định an toàn; hãy chỉnh và lưu lại.",
      }));
      setSelectedRegionIndex(0);
    });
    return invalidate;
  }, [fetcher, projectId]);

  useEffect(() => {
    if (quotaMode !== undefined) return;
    let active = true;
    fetcher("/api/v1/health/free-tier").then(async (response) => {
      if (!response.ok) throw new Error("Quota health request failed");
      const body = await response.json() as { mode?: unknown };
      if (!active) return;
      if (body.mode !== "READ_WRITE" && body.mode !== "READ_ONLY") {
        throw new Error("Malformed quota health response");
      }
      setQuotaProbe({ fetcher, mode: body.mode, warning: null });
    }).catch(() => {
      if (!active) return;
      setQuotaProbe({
        fetcher,
        mode: null,
        warning: "Không kiểm tra được quota Drive. Hãy tải lại trang hoặc thử lại sau.",
      });
    });
    return () => { active = false; };
  }, [fetcher, quotaMode]);

  useEffect(() => () => {
    if (videoUrl && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(videoUrl);
  }, [videoUrl]);

  useEffect(() => () => {
    if (audioUrl && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

  function setMessage(message: string | null): void {
    setEditor((current) => ({ ...current, message }));
  }

  function editSettings(update: (current: SceneSettingsV2) => SceneSettingsV2): void {
    revision.current += 1;
    setEditor((current) => ({
      ...current,
      settings: update(current.settings),
      saved: false,
      queued: false,
      message: null,
    }));
  }

  function updateRegion(index: number, update: (region: BlurRegion) => BlurRegion): void {
    editSettings((current) => {
      const regions = current.blur.regions.map((region, regionIndex) => (
        regionIndex === index ? update(region) : region
      ));
      return withRegions(current, regions);
    });
  }

  function point(event: React.PointerEvent): Readonly<{ x: number; y: number }> | null {
    const bounds = preview.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;
    return {
      x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1),
      y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1),
    };
  }

  function start(event: React.PointerEvent): void {
    const value = point(event);
    if (!value) return;
    setDragStart(value);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function finish(event: React.PointerEvent): void {
    if (!dragStart) return;
    const end = point(event);
    setDragStart(null);
    if (!end) return;
    const rectangle = {
      x: Math.min(dragStart.x, end.x),
      y: Math.min(dragStart.y, end.y),
      width: Math.abs(end.x - dragStart.x),
      height: Math.abs(end.y - dragStart.y),
    };
    if (rectangle.width < 0.01 || rectangle.height < 0.01) {
      setMessage("Vùng blur quá nhỏ. Hãy kéo một vùng rộng và cao ít nhất 1% khung hình.");
      return;
    }
    updateRegion(selectedIndex, (region) => ({ ...region, rectangle }));
  }

  function addCustomRegion(): void {
    if (settings.blur.regions.length >= 8) {
      setMessage("Chỉ có thể lưu tối đa 8 vùng blur.");
      return;
    }
    const nextIndex = settings.blur.regions.length;
    editSettings((current) => withRegions(current, [
      ...current.blur.regions,
      {
        kind: "custom",
        enabled: true,
        rectangle: { x: 0.35, y: 0.35, width: 0.2, height: 0.2 },
      },
    ]));
    setSelectedRegionIndex(nextIndex);
  }

  function removeCustomRegion(index: number): void {
    if (settings.blur.regions[index]?.kind !== "custom") return;
    editSettings((current) => withRegions(
      current,
      current.blur.regions.filter((_, regionIndex) => regionIndex !== index),
    ));
    setSelectedRegionIndex((current) => Math.max(0, Math.min(current, settings.blur.regions.length - 2)));
  }

  async function save(): Promise<void> {
    if (projectId === null || editor.saving) return;
    let parsed: SceneSettingsV2;
    try {
      parsed = validateVersionTwo(settings);
    } catch {
      setMessage("Cấu hình chưa hợp lệ. Kiểm tra thời lượng chia, vùng blur và tên preset.");
      return;
    }

    const projectAtStart = projectId;
    const revisionAtStart = revision.current;
    const generation = ++saveGeneration.current;
    setEditor((current) => ({
      ...current,
      saving: true,
      message: null,
    }));
    try {
      const response = await fetcher(
        `/api/v1/projects/${encodeURIComponent(projectAtStart)}/scene-settings`,
        {
          method: "PUT",
          headers: { "content-type": "application/json", origin: window.location.origin },
          body: JSON.stringify({ settings: parsed }),
        },
      );
      if (generation !== saveGeneration.current) return;
      if (!response.ok) {
        setEditor((current) => ({
          ...current,
          saving: false,
          message: "Chưa lưu được cấu hình. Bản nháp vẫn còn; hãy thử lại.",
        }));
        return;
      }
      const unchanged = revision.current === revisionAtStart;
      setEditor((current) => ({
        ...current,
        settings: unchanged ? parsed : current.settings,
        saved: unchanged,
        saving: false,
        loadWarning: unchanged ? null : current.loadWarning,
        message: unchanged
          ? "Đã lưu cấu hình dự án."
          : "Đã lưu bản trước; thay đổi mới vẫn chưa được lưu.",
      }));
    } catch {
      if (generation !== saveGeneration.current) return;
      setEditor((current) => ({
        ...current,
        saving: false,
        message: "Chưa lưu được cấu hình. Bản nháp vẫn còn; hãy thử lại.",
      }));
    }
  }

  async function speak(): Promise<void> {
    if (!ttsText.trim()) {
      setMessage("Nhập câu cần nghe thử trước khi tạo voice.");
      return;
    }
    setMessage("Đang tạo file nghe thử BV074…");
    try {
      const response = await fetcher("/api/v1/tts-preview", {
        method: "POST",
        headers: { "content-type": "application/json", origin: window.location.origin },
        body: JSON.stringify({ text: ttsText, rate: settings.rate }),
      });
      if (!response.ok) throw new Error("TTS preview unavailable");
      const blob = await response.blob();
      const next = URL.createObjectURL(blob);
      setAudioUrl(next);
      const audio = new Audio(next);
      await audio.play();
      setMessage("Đang nghe thử BV074.");
    } catch {
      setMessage("Chưa tạo được nghe thử BV074. Hãy kiểm tra kết nối rồi thử lại.");
    }
  }

  async function confirmRender(): Promise<void> {
    if (!canRender || projectId === null || queueingGuard.current) return;
    queueingGuard.current = true;
    const projectAtStart = projectId;
    setEditor((current) => ({
      ...current,
      queueing: true,
      message: null,
    }));
    try {
      const response = await fetcher(`/api/v1/projects/${encodeURIComponent(projectAtStart)}/jobs`, {
        method: "POST",
        headers: {
          "idempotency-key": crypto.randomUUID(),
          origin: window.location.origin,
        },
      });
      setEditor((current) => ({
        ...current,
        queueing: false,
        queued: response.ok,
        message: response.ok
          ? "Đã xếp job render vào hàng đợi."
          : "Chưa thể xếp job. Kiểm tra lại nguồn, worker và quota rồi thử lại.",
      }));
    } catch {
      setEditor((current) => ({
        ...current,
        queueing: false,
        message: "Kết nối bị gián đoạn; chưa xếp job. Hãy thử lại.",
      }));
    } finally {
      queueingGuard.current = false;
    }
  }

  return (
    <section className="workspace-card scene-editor" aria-label="Blur và voice">
      <div className="card-heading">
        <div>
          <p className="eyebrow">Review trước render</p>
          <h2>Thiết lập video</h2>
        </div>
        <span className="mode-badge">{sourceReady ? "Nguồn sẵn sàng" : "Nguồn chưa sẵn sàng"}</span>
      </div>

      <p><strong>{projectLabel}</strong></p>
      <div className="readiness-grid" aria-label="Điều kiện render">
        <ReadinessItem
          label="Video nguồn"
          value={sourceReady ? "Sẵn sàng" : "Chưa sẵn sàng"}
          tone={sourceReady ? "good" : "warn"}
        />
        <ReadinessItem
          label="Worker VPS"
          value={workerReady ? "Sẵn sàng" : workerReady === false ? "Chưa sẵn sàng" : "Chưa xác minh"}
          tone={workerReady ? "good" : "warn"}
        />
        <ReadinessItem
          label="Quota Drive"
          value={resolvedQuotaMode === "READ_WRITE" ? "Đọc/ghi" : resolvedQuotaMode === "READ_ONLY" ? "Chỉ đọc" : "Chưa xác minh"}
          tone={resolvedQuotaMode === "READ_WRITE" ? "good" : resolvedQuotaMode === "READ_ONLY" ? "danger" : "warn"}
        />
        <ReadinessItem
          label="Cấu hình"
          value={editor.saved ? "Đã lưu" : "Chưa lưu"}
          tone={editor.saved ? "good" : "warn"}
        />
      </div>

      {editor.loadWarning && <p role="alert" className="field-note">{editor.loadWarning}</p>}
      {quotaWarning && <p role="alert" className="field-note">{quotaWarning}</p>}

      <fieldset className="scene-tts">
        <legend>Chia video</legend>
        <label>
          <input
            type="radio"
            name="scene-split"
            checked={settings.split.mode === "single"}
            onChange={() => editSettings((current) => ({ ...current, split: { mode: "single" } }))}
          />
          {" "}Giữ nguyên một video
        </label>
        <label>
          <input
            type="radio"
            name="scene-split"
            aria-label="Chia theo thời lượng"
            checked={settings.split.mode === "fixedSeconds"}
            onChange={() => editSettings((current) => ({
              ...current,
              split: { mode: "fixedSeconds", secondsPerPart: 900 },
            }))}
          />
          {" "}Chia theo thời lượng
        </label>
        {settings.split.mode === "fixedSeconds" && (
          <>
            <label htmlFor="scene-split-seconds">Số giây mỗi phần</label>
            <input
              id="scene-split-seconds"
              type="number"
              inputMode="numeric"
              min={1}
              max={86_400}
              step={1}
              value={settings.split.secondsPerPart}
              onChange={(event) => editSettings((current) => ({
                ...current,
                split: { mode: "fixedSeconds", secondsPerPart: Number(event.target.value) },
              }))}
            />
            <p className="field-note">Từ 1 đến 86.400 giây cho mỗi phần.</p>
          </>
        )}
      </fieldset>

      <div className="scene-tts">
        <label htmlFor="scene-blur-mode">Chế độ blur</label>
        <select
          id="scene-blur-mode"
          value={settings.blur.mode}
          onChange={(event) => editSettings((current) => ({
            ...current,
            blur: { ...current.blur, mode: event.target.value as "manual" | "auto" },
          }))}
        >
          <option value="manual">Thủ công</option>
          <option value="auto">Tự động, dùng vùng dự phòng</option>
        </select>
        {settings.blur.mode === "auto" && (
          <p className="field-note">
            Backend tự nhận diện chưa khả dụng; các vùng thủ công bên dưới là phương án dự phòng bắt buộc.
          </p>
        )}
      </div>

      <fieldset className="scene-tts">
        <legend>Vùng blur thủ công</legend>
        {settings.blur.regions.map((region, index) => {
          const label = regionLabel(region, index);
          return (
            <div className="button-row" key={`${region.kind}-${index}`}>
              <label>
                <input
                  type="radio"
                  name="blur-region"
                  checked={selectedIndex === index}
                  onChange={() => setSelectedRegionIndex(index)}
                />
                {" "}{label}
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={region.enabled}
                  onChange={(event) => updateRegion(index, (current) => ({
                    ...current,
                    enabled: event.target.checked,
                  }))}
                />
                {" "}Bật blur
              </label>
              {region.kind === "custom" && (
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => removeCustomRegion(index)}
                >
                  Xóa {label.toLocaleLowerCase("vi-VN")}
                </button>
              )}
            </div>
          );
        })}
        <button
          type="button"
          className="button-secondary"
          disabled={settings.blur.regions.length >= 8}
          onClick={addCustomRegion}
        >
          Thêm vùng tùy chỉnh
        </button>

        <div className="scene-toolbar">
          {([
            ["x", "X"],
            ["y", "Y"],
            ["width", "Chiều rộng"],
            ["height", "Chiều cao"],
          ] as const).map(([key, label]) => (
            <label key={key}>
              {label} vùng đang chọn
              <input
                aria-label={`${label} vùng đang chọn`}
                type="number"
                inputMode="decimal"
                min={key === "width" || key === "height" ? 0.01 : 0}
                max={1}
                step={0.01}
                value={selectedRegion.rectangle[key]}
                onChange={(event) => updateRegion(selectedIndex, (region) => ({
                  ...region,
                  rectangle: updateRectangle(region.rectangle, key, Number(event.target.value)),
                }))}
              />
            </label>
          ))}
        </div>
      </fieldset>

      <div className="scene-toolbar">
        <label htmlFor="scene-video">Video preview</label>
        <input
          id="scene-video"
          type="file"
          accept="video/*"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file && typeof URL.createObjectURL === "function") setVideoUrl(URL.createObjectURL(file));
          }}
        />
      </div>
      <p className="field-note">
        Kéo trên preview hoặc nhập tọa độ chuẩn hóa từ 0 đến 1. Vùng quá nhỏ và vùng vượt khung sẽ không được lưu.
      </p>
      <div
        ref={preview}
        className="scene-preview"
        onPointerDown={start}
        onPointerUp={finish}
        onPointerCancel={() => setDragStart(null)}
        role="application"
        aria-label="Kéo để chọn vùng blur"
      >
        {previewUrl && <video src={previewUrl} controls muted playsInline preload="metadata" />}
        {settings.blur.regions.map((region, index) => (
          <span
            aria-hidden
            className={`scene-rectangle${region.kind === "logo" ? " scene-logo" : " scene-subtitle"}`}
            key={`${region.kind}-${index}`}
            style={{
              ...rectangleStyle(region.rectangle),
              opacity: region.enabled ? 1 : 0.45,
              outline: selectedIndex === index ? "2px solid currentColor" : undefined,
            }}
          />
        ))}
      </div>

      <div className="scene-tts">
        <label htmlFor="scene-voice">Voice</label>
        <select
          id="scene-voice"
          value={settings.voice}
          onChange={(event) => editSettings((current) => ({
            ...current,
            voice: event.target.value as "BV074_streaming",
          }))}
        >
          <option value="BV074_streaming">CapCut BV074 streaming</option>
        </select>
        <label htmlFor="tts-rate">Tốc độ voice: {settings.rate.toFixed(2)}x</label>
        <input
          id="tts-rate"
          aria-label="Tốc độ voice"
          type="range"
          min="0.8"
          max="1.2"
          step="0.05"
          value={settings.rate}
          onChange={(event) => editSettings((current) => ({
            ...current,
            rate: Number(event.target.value),
          }))}
        />
        <label htmlFor="tts-text">Nghe thử câu voice</label>
        <textarea
          id="tts-text"
          value={ttsText}
          onChange={(event) => setTtsText(event.target.value)}
          maxLength={500}
        />
        <button type="button" className="button-secondary" onClick={speak}>Nghe thử TTS</button>
      </div>

      <div className="scene-tts">
        <label htmlFor="scene-output">Định dạng đầu ra mặc định</label>
        <select
          id="scene-output"
          value={settings.output.format}
          onChange={() => editSettings((current) => ({ ...current, output: { format: "mp4" } }))}
        >
          <option value="mp4">MP4</option>
        </select>
      </div>

      <fieldset className="scene-tts">
        <legend>Preset</legend>
        <label htmlFor="scene-preset-name">Tên preset</label>
        <input
          id="scene-preset-name"
          maxLength={100}
          value={settings.preset?.name ?? ""}
          onChange={(event) => {
            const name = event.target.value;
            editSettings((current) => {
              const id = current.preset?.id ?? null;
              return {
                ...current,
                preset: name.length > 0 ? { id, name } : id === null ? null : { id, name: null },
              };
            });
          }}
        />
        <p className="field-note" id="preset-api-status">
          Chưa khả dụng: API preset chưa được triển khai. Tên preset vẫn được lưu trong cấu hình dự án.
        </p>
        <div className="button-row">
          <button type="button" disabled aria-describedby="preset-api-status">Lưu thành preset</button>
          <button type="button" className="button-secondary" disabled aria-describedby="preset-api-status">
            Áp dụng preset
          </button>
        </div>
      </fieldset>

      <div className="button-row">
        <button
          type="button"
          className="button-secondary"
          disabled={projectId === null || editor.saving}
          onClick={save}
        >
          {editor.saving ? "Đang lưu…" : "Lưu cấu hình"}
        </button>
        <button
          type="button"
          disabled={!canRender}
          aria-describedby={blockers.length > 0 ? "render-blockers" : undefined}
          onClick={confirmRender}
        >
          {editor.queueing ? "Đang xếp hàng…" : editor.queued ? "Đã xác nhận render" : "Xác nhận render"}
        </button>
      </div>

      {blockers.length > 0 && (
        <div id="render-blockers" className="field-note" aria-live="polite">
          <strong>Chưa thể render:</strong>
          <ul>{blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
        </div>
      )}
      {editor.message && <p aria-live="polite">{editor.message}</p>}
    </section>
  );
}
