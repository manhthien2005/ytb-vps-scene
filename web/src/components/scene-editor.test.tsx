import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SceneEditor } from "./scene-editor";

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
