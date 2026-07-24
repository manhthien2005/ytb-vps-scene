import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SceneEditor } from "./scene-editor";

const PROJECT_A = "10000000-0000-4000-8000-000000000001";
const PROJECT_B = "20000000-0000-4000-8000-000000000002";
const CUSTOM_SETTINGS = {
  version: 1 as const,
  sourceArtifactId: null,
  sourceSubtitle: { x: 0.1, y: 0.7, width: 0.8, height: 0.2 },
  logo: { x: 0.7, y: 0.1, width: 0.2, height: 0.2 },
  voice: "BV074_streaming" as const,
  rate: 1.2,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SceneEditor", () => {
  it("offers rectangle review and previews TTS through the CapCut endpoint", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(new Blob(["mp3"], { type: "audio/mpeg" }), { status: 200 }));
    const play = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "Audio", { configurable: true, value: class { src: string; constructor(src: string) { this.src = src; } play = play; } });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn().mockReturnValue("blob:tts-preview") });
    render(<SceneEditor projectId={null} fetcher={fetcher} />);
    expect(screen.getByText("Vùng phụ đề gốc")).toBeVisible();
    expect(screen.getByText("Vùng logo")).toBeVisible();
    expect(screen.queryByLabelText("Voice")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Nghe thử TTS" }));
    await waitFor(() => expect(play).toHaveBeenCalled());
    expect(fetcher).toHaveBeenCalledWith("/api/v1/tts-preview", expect.objectContaining({ method: "POST" }));
  });

  it("saves settings to the project control-plane endpoint", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ settings: null }), { status: 200 }));
    render(<SceneEditor projectId="10000000-0000-4000-8000-000000000001" fetcher={fetcher} />);
    fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình" }));
    expect(await screen.findByText("Đã lưu vùng blur và voice.")).toBeVisible();
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("scene-settings"), expect.objectContaining({ method: "PUT" }));
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
    const { rerender } = render(<SceneEditor projectId={PROJECT_A} fetcher={fetcher} />);
    await waitFor(() => expect(screen.getByRole("slider")).toHaveValue("1.2"));

    rerender(<SceneEditor projectId={PROJECT_B} fetcher={fetcher} />);

    expect(screen.getByRole("slider")).toHaveValue("1");
    fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      `/api/v1/projects/${PROJECT_B}/scene-settings`,
      expect.objectContaining({ method: "PUT" }),
    ));
    const saveCall = fetcher.mock.calls.find(([input, init]) => (
      String(input) === `/api/v1/projects/${PROJECT_B}/scene-settings` && init?.method === "PUT"
    ));
    expect(JSON.parse(String(saveCall?.[1]?.body))).toEqual({
      settings: {
        version: 1,
        sourceArtifactId: null,
        sourceSubtitle: { x: 0.05, y: 0.78, width: 0.9, height: 0.16 },
        logo: { x: 0.78, y: 0.04, width: 0.18, height: 0.16 },
        voice: "BV074_streaming",
        rate: 1,
      },
    });

    await act(async () => { resolveProjectB(jsonResponse({ settings: null })); });
    expect(screen.getByRole("slider")).toHaveValue("1");
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
    const { rerender } = render(<SceneEditor projectId={PROJECT_A} fetcher={fetcher} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    rerender(<SceneEditor projectId={PROJECT_B} fetcher={fetcher} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await act(async () => {
      resolveProjectB(jsonResponse({ settings: { ...CUSTOM_SETTINGS, rate: 1.1 } }));
    });
    expect(screen.getByRole("slider")).toHaveValue("1.1");

    await act(async () => {
      resolveProjectA(jsonResponse({ settings: { ...CUSTOM_SETTINGS, rate: 0.8 } }));
    });

    expect(screen.getByRole("slider")).toHaveValue("1.1");
  });

  it("previews a selected file locally with metadata preload", () => {
    const createObjectURL = vi.fn().mockReturnValue("blob:local-preview");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    render(<SceneEditor projectId={null} />);
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
