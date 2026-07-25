import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SceneEditor } from "./scene-editor";

const PROJECT_A = "10000000-0000-4000-8000-000000000001";
const PROJECT_B = "20000000-0000-4000-8000-000000000002";
const SUBTITLE = { x: 0.05, y: 0.78, width: 0.9, height: 0.16 };
const LOGO = { x: 0.78, y: 0.04, width: 0.18, height: 0.16 };
const CUSTOM_SETTINGS = {
  version: 1 as const,
  sourceArtifactId: null,
  sourceSubtitle: { x: 0.1, y: 0.7, width: 0.8, height: 0.2 },
  logo: { x: 0.7, y: 0.1, width: 0.2, height: 0.2 },
  voice: "BV074_streaming" as const,
  rate: 1.2,
};
const V2_SETTINGS = {
  version: 2 as const,
  sourceArtifactId: null,
  split: { mode: "single" as const },
  blur: {
    mode: "manual" as const,
    regions: [
      { kind: "sourceSubtitle" as const, enabled: true, rectangle: SUBTITLE },
      { kind: "logo" as const, enabled: true, rectangle: LOGO },
    ],
  },
  voice: "BV074_streaming" as const,
  rate: 1,
  output: { format: "mp4" as const },
  preset: null,
  sourceSubtitle: SUBTITLE,
  logo: LOGO,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("SceneEditor", () => {
  it("keeps rectangle review usable and previews TTS through the CapCut endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input) === "/api/v1/tts-preview") {
        return new Response(new Blob(["mp3"], { type: "audio/mpeg" }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    const play = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "Audio", {
      configurable: true,
      value: class {
        src: string;
        constructor(src: string) { this.src = src; }
        play = play;
      },
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn().mockReturnValue("blob:tts-preview"),
    });

    render(<SceneEditor projectId={null} fetcher={fetcher} quotaMode="READ_ONLY" workerReady={false} />);

    expect(screen.getByText("Vùng phụ đề gốc")).toBeVisible();
    expect(screen.getByText("Vùng logo")).toBeVisible();
    expect(screen.getByLabelText("Voice")).toHaveValue("BV074_streaming");
    expect(screen.getByRole("application", { name: "Kéo để chọn vùng blur" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Nghe thử TTS" }));
    await waitFor(() => expect(play).toHaveBeenCalled());
    expect(fetcher).toHaveBeenCalledWith("/api/v1/tts-preview", expect.objectContaining({ method: "POST" }));
  });

  it("configures and saves the expanded v2 settings contract", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === "PUT") return jsonResponse({ settings: JSON.parse(String(init.body)).settings });
      if (String(input) === `/api/v1/projects/${PROJECT_A}/scene-settings`) return jsonResponse({ settings: null });
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    render(
      <SceneEditor
        projectId={PROJECT_A}
        projectName="Tập 12"
        fetcher={fetcher}
        quotaMode="READ_WRITE"
        workerReady
      />,
    );
    await screen.findByText("Chưa lưu");

    fireEvent.click(screen.getByLabelText("Chia theo thời lượng"));
    fireEvent.change(screen.getByLabelText("Số giây mỗi phần"), { target: { value: "600" } });
    fireEvent.change(screen.getByLabelText("Chế độ blur"), { target: { value: "auto" } });
    fireEvent.change(screen.getByLabelText("Tốc độ voice"), { target: { value: "1.1" } });
    fireEvent.change(screen.getByLabelText("Tên preset"), { target: { value: "TikTok 10 phút" } });

    expect(screen.getByLabelText("Định dạng đầu ra mặc định")).toHaveValue("mp4");
    expect(screen.getByRole("button", { name: "Lưu thành preset" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Áp dụng preset" })).toBeDisabled();
    expect(screen.getByText(/API preset chưa được triển khai/)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình" }));
    expect(await screen.findByText("Đã lưu cấu hình dự án.")).toBeVisible();

    const saveCall = fetcher.mock.calls.find(([, init]) => init?.method === "PUT");
    const payload = JSON.parse(String(saveCall?.[1]?.body));
    expect(payload).toMatchObject({
      settings: {
        version: 2,
        split: { mode: "fixedSeconds", secondsPerPart: 600 },
        blur: { mode: "auto" },
        voice: "BV074_streaming",
        rate: 1.1,
        output: { format: "mp4" },
        preset: { id: null, name: "TikTok 10 phút" },
      },
    });
  });

  it("blocks invalid split settings before the domain-validated save", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input) === `/api/v1/projects/${PROJECT_A}/scene-settings`) return jsonResponse({ settings: null });
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    render(<SceneEditor projectId={PROJECT_A} fetcher={fetcher} quotaMode="READ_WRITE" workerReady />);
    await screen.findByText("Chưa lưu");

    fireEvent.click(screen.getByLabelText("Chia theo thời lượng"));
    fireEvent.change(screen.getByLabelText("Số giây mỗi phần"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình" }));

    expect(await screen.findByText("Cấu hình chưa hợp lệ. Kiểm tra thời lượng chia, vùng blur và tên preset.")).toBeVisible();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
    expect(screen.getByRole("button", { name: "Xác nhận render" })).toBeDisabled();
  });

  it("keeps manual custom rectangles normalized before save", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === "PUT") return jsonResponse({ settings: JSON.parse(String(init.body)).settings });
      if (String(input) === `/api/v1/projects/${PROJECT_A}/scene-settings`) return jsonResponse({ settings: null });
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    render(<SceneEditor projectId={PROJECT_A} fetcher={fetcher} quotaMode="READ_WRITE" workerReady />);
    await screen.findByText("Chưa lưu");

    fireEvent.click(screen.getByRole("button", { name: "Thêm vùng tùy chỉnh" }));
    fireEvent.change(screen.getByLabelText("X vùng đang chọn"), { target: { value: "0.95" } });
    fireEvent.change(screen.getByLabelText("Chiều rộng vùng đang chọn"), { target: { value: "0.3" } });
    fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình" }));
    await screen.findByText("Đã lưu cấu hình dự án.");

    const saveCall = fetcher.mock.calls.find(([, init]) => init?.method === "PUT");
    const payload = JSON.parse(String(saveCall?.[1]?.body));
    expect(payload.settings.blur.regions[2]).toEqual({
      kind: "custom",
      enabled: true,
      rectangle: { x: 0.8, y: 0.35, width: 0.2, height: 0.2 },
    });
  });

  it("marks loaded settings dirty after edits and saved only after a successful save", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === "PUT") return jsonResponse({ settings: JSON.parse(String(init.body)).settings });
      if (String(input) === `/api/v1/projects/${PROJECT_A}/scene-settings`) return jsonResponse({ settings: V2_SETTINGS });
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    render(<SceneEditor projectId={PROJECT_A} fetcher={fetcher} quotaMode="READ_WRITE" workerReady />);

    await screen.findByText("Đã lưu");
    fireEvent.change(screen.getByLabelText("Tốc độ voice"), { target: { value: "1.1" } });
    expect(screen.getByText("Chưa lưu")).toBeVisible();
    expect(screen.getByRole("button", { name: "Xác nhận render" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình" }));
    await screen.findByText("Đã lưu cấu hình dự án.");
    expect(screen.getByText("Đã lưu")).toBeVisible();

    fireEvent.click(screen.getByLabelText("Chia theo thời lượng"));
    expect(screen.getByText("Chưa lưu")).toBeVisible();
  });

  it("does not mark newer edits saved when an older save finishes", async () => {
    let resolveSave!: (response: Response) => void;
    const saveResponse = new Promise<Response>((resolve) => { resolveSave = resolve; });
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === "PUT") return await saveResponse;
      if (String(input) === `/api/v1/projects/${PROJECT_A}/scene-settings`) {
        return jsonResponse({ settings: V2_SETTINGS });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    render(<SceneEditor projectId={PROJECT_A} fetcher={fetcher} quotaMode="READ_WRITE" workerReady />);
    await screen.findByText("Đã lưu");

    fireEvent.change(screen.getByLabelText("Tốc độ voice"), { target: { value: "1.1" } });
    fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình" }));
    fireEvent.change(screen.getByLabelText("Tốc độ voice"), { target: { value: "1.15" } });
    await act(async () => {
      resolveSave(jsonResponse({ settings: { ...V2_SETTINGS, rate: 1.1 } }));
    });

    expect(await screen.findByText("Đã lưu bản trước; thay đổi mới vẫn chưa được lưu.")).toBeVisible();
    expect(screen.getByLabelText("Tốc độ voice")).toHaveValue("1.15");
    expect(screen.getByText("Chưa lưu")).toBeVisible();
    expect(screen.getByRole("button", { name: "Xác nhận render" })).toBeDisabled();
  });

  it("keeps an edited draft unsaved when save fails", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === "PUT") return jsonResponse({ code: "INTERNAL_ERROR" }, 500);
      if (String(input) === `/api/v1/projects/${PROJECT_A}/scene-settings`) return jsonResponse({ settings: V2_SETTINGS });
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    render(<SceneEditor projectId={PROJECT_A} fetcher={fetcher} quotaMode="READ_WRITE" workerReady />);
    await screen.findByText("Đã lưu");

    fireEvent.change(screen.getByLabelText("Tốc độ voice"), { target: { value: "1.15" } });
    fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình" }));

    expect(await screen.findByText("Chưa lưu được cấu hình. Bản nháp vẫn còn; hãy thử lại.")).toBeVisible();
    expect(screen.getByLabelText("Tốc độ voice")).toHaveValue("1.15");
    expect(screen.getByText("Chưa lưu")).toBeVisible();
    expect(screen.getByRole("button", { name: "Xác nhận render" })).toBeDisabled();
  });

  it("shows a recoverable warning and safe unsaved defaults when load fails", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input) === `/api/v1/projects/${PROJECT_A}/scene-settings`) {
        return jsonResponse({ code: "INTERNAL_ERROR" }, 500);
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    render(<SceneEditor projectId={PROJECT_A} fetcher={fetcher} quotaMode="READ_ONLY" workerReady={false} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Không tải được cấu hình đã lưu. Đang dùng mặc định an toàn; hãy chỉnh và lưu lại.",
    );
    expect(screen.getByLabelText("Tốc độ voice")).toHaveValue("1");
    expect(screen.getByText("Chưa lưu")).toBeVisible();
  });

  it("loads quota readiness while preserving the existing caller shape and fails closed on unknown worker state", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === `/api/v1/projects/${PROJECT_A}/scene-settings`) {
        return jsonResponse({ settings: V2_SETTINGS });
      }
      if (url === "/api/v1/health/free-tier") {
        return jsonResponse({
          mode: "READ_WRITE",
          reasons: [],
          driveConnection: "CONNECTED",
          drive: null,
          neon: null,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<SceneEditor projectId={PROJECT_A} sourceFile={null} fetcher={fetcher} />);

    await waitFor(() => expect(screen.getByText("Đọc/ghi")).toBeVisible());
    expect(screen.getByText("Chưa xác minh worker VPS ở trạng thái READY.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Xác nhận render" })).toBeDisabled();
  });

  it("queues only after every final confirmation gate is ready", async () => {
    let resolveQueue!: (response: Response) => void;
    const queueResponse = new Promise<Response>((resolve) => { resolveQueue = resolve; });
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (init?.method === "PUT") return jsonResponse({ settings: JSON.parse(String(init.body)).settings });
      if (init?.method === "POST" && url === `/api/v1/projects/${PROJECT_A}/jobs`) return await queueResponse;
      if (url === `/api/v1/projects/${PROJECT_A}/scene-settings`) return jsonResponse({ settings: null });
      throw new Error(`Unexpected request: ${url}`);
    });
    const { rerender } = render(
      <SceneEditor
        projectId={PROJECT_A}
        projectName="Tập 12"
        fetcher={fetcher}
        quotaMode="READ_WRITE"
        sourceReady
        workerReady={false}
      />,
    );
    await screen.findByText("Chưa lưu");

    rerender(
      <SceneEditor
        projectId={PROJECT_A}
        projectName="Tập 12"
        fetcher={fetcher}
        quotaMode="READ_WRITE"
        sourceReady={false}
        workerReady
      />,
    );
    expect(screen.getByText("Video nguồn chưa sẵn sàng.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Xác nhận render" })).toBeDisabled();

    rerender(
      <SceneEditor
        projectId={PROJECT_A}
        projectName="Tập 12"
        fetcher={fetcher}
        quotaMode="READ_WRITE"
        sourceReady
        workerReady={false}
      />,
    );
    expect(screen.getByText("Worker VPS chưa sẵn sàng.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Xác nhận render" })).toBeDisabled();

    rerender(
      <SceneEditor
        projectId={PROJECT_A}
        projectName="Tập 12"
        fetcher={fetcher}
        quotaMode="READ_ONLY"
        sourceReady
        workerReady
      />,
    );
    expect(screen.getByText("Quota Drive đang ở chế độ chỉ đọc.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Xác nhận render" })).toBeDisabled();

    rerender(
      <SceneEditor
        projectId={PROJECT_A}
        projectName="Tập 12"
        fetcher={fetcher}
        quotaMode="READ_WRITE"
        sourceReady
        workerReady
      />,
    );
    expect(screen.getByText("Cấu hình có thay đổi chưa lưu.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình" }));
    await screen.findByText("Đã lưu cấu hình dự án.");

    const confirm = screen.getByRole("button", { name: "Xác nhận render" });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(fetcher.mock.calls.filter(([input, init]) => (
      String(input) === `/api/v1/projects/${PROJECT_A}/jobs` && init?.method === "POST"
    ))).toHaveLength(1));
    await act(async () => { resolveQueue(jsonResponse({ job: { id: "job-1" } }, 201)); });
    expect(await screen.findByText("Đã xếp job render vào hàng đợi.")).toBeVisible();
    expect(fetcher).toHaveBeenCalledWith(
      `/api/v1/projects/${PROJECT_A}/jobs`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "idempotency-key": expect.any(String) }),
      }),
    );
  });

  it("resets and saves defaults when the next project has no settings", async () => {
    let resolveProjectB!: (response: Response) => void;
    const projectBLoad = new Promise<Response>((resolve) => { resolveProjectB = resolve; });
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (init?.method === "PUT") return jsonResponse({ settings: JSON.parse(String(init.body)).settings });
      if (url === `/api/v1/projects/${PROJECT_A}/scene-settings`) return jsonResponse({ settings: CUSTOM_SETTINGS });
      if (url === `/api/v1/projects/${PROJECT_B}/scene-settings`) return await projectBLoad;
      throw new Error(`Unexpected request: ${url}`);
    });
    const { rerender } = render(
      <SceneEditor projectId={PROJECT_A} fetcher={fetcher} quotaMode="READ_WRITE" workerReady />,
    );
    await waitFor(() => expect(screen.getByLabelText("Tốc độ voice")).toHaveValue("1.2"));

    rerender(<SceneEditor projectId={PROJECT_B} fetcher={fetcher} quotaMode="READ_WRITE" workerReady />);

    expect(screen.getByLabelText("Tốc độ voice")).toHaveValue("1");
    fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      `/api/v1/projects/${PROJECT_B}/scene-settings`,
      expect.objectContaining({ method: "PUT" }),
    ));
    const saveCall = fetcher.mock.calls.find(([input, init]) => (
      String(input) === `/api/v1/projects/${PROJECT_B}/scene-settings` && init?.method === "PUT"
    ));
    expect(JSON.parse(String(saveCall?.[1]?.body))).toMatchObject({
      settings: {
        version: 2,
        split: { mode: "single" },
        blur: {
          mode: "manual",
          regions: [
            { kind: "sourceSubtitle", enabled: true, rectangle: SUBTITLE },
            { kind: "logo", enabled: true, rectangle: LOGO },
          ],
        },
        output: { format: "mp4" },
      },
    });

    fireEvent.change(screen.getByLabelText("Tốc độ voice"), { target: { value: "1.1" } });
    expect(screen.getByLabelText("Tốc độ voice")).toHaveValue("1.1");
    await act(async () => { resolveProjectB(jsonResponse({ settings: null })); });
    expect(screen.getByLabelText("Tốc độ voice")).toHaveValue("1");
  });

  it("ignores an older project response that resolves after the current project", async () => {
    let resolveProjectA!: (response: Response) => void;
    let resolveProjectB!: (response: Response) => void;
    const projectALoad = new Promise<Response>((resolve) => { resolveProjectA = resolve; });
    const projectBLoad = new Promise<Response>((resolve) => { resolveProjectB = resolve; });
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === `/api/v1/projects/${PROJECT_A}/scene-settings`) return await projectALoad;
      if (url === `/api/v1/projects/${PROJECT_B}/scene-settings`) return await projectBLoad;
      throw new Error(`Unexpected request: ${url}`);
    });
    const { rerender } = render(
      <SceneEditor projectId={PROJECT_A} fetcher={fetcher} quotaMode="READ_ONLY" workerReady={false} />,
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    rerender(<SceneEditor projectId={PROJECT_B} fetcher={fetcher} quotaMode="READ_ONLY" workerReady={false} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await act(async () => {
      resolveProjectB(jsonResponse({ settings: { ...CUSTOM_SETTINGS, rate: 1.1 } }));
    });
    expect(screen.getByLabelText("Tốc độ voice")).toHaveValue("1.1");

    await act(async () => {
      resolveProjectA(jsonResponse({ settings: { ...CUSTOM_SETTINGS, rate: 0.8 } }));
    });

    expect(screen.getByLabelText("Tốc độ voice")).toHaveValue("1.1");
  });

  it("previews a selected file locally with metadata preload", () => {
    const createObjectURL = vi.fn().mockReturnValue("blob:local-preview");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    render(<SceneEditor projectId={null} quotaMode="READ_ONLY" workerReady={false} />);
    const input = screen.getByLabelText("Video preview");
    const file = new File(["video"], "episode.mp4", { type: "video/mp4" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(createObjectURL).toHaveBeenCalledWith(file);
    const video = screen.getByRole("application").querySelector("video");
    expect(video).toHaveAttribute("src", "blob:local-preview");
    expect(video).toHaveAttribute("preload", "metadata");
    createObjectURL.mockRestore();
  });
});
