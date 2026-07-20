import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SceneEditor } from "./scene-editor";

describe("SceneEditor", () => {
  it("offers rectangle review and a TTS preview without requiring a VPS", () => {
    const synth = { cancel: vi.fn(), speak: vi.fn() };
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: synth });
    Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, value: class { text: string; lang = ""; rate = 1; constructor(text: string) { this.text = text; } } });
    const speak = synth.speak;
    render(<SceneEditor projectId={null} />);
    expect(screen.getByText("Vùng phụ đề gốc")).toBeVisible();
    expect(screen.getByText("Vùng logo")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Nghe thử TTS" }));
    expect(speak).toHaveBeenCalled();
  });

  it("saves settings to the project control-plane endpoint", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ settings: null }), { status: 200 }));
    render(<SceneEditor projectId="10000000-0000-4000-8000-000000000001" fetcher={fetcher} />);
    fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình" }));
    expect(await screen.findByText("Đã lưu vùng blur và voice.")).toBeVisible();
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("scene-settings"), expect.objectContaining({ method: "PUT" }));
  });
});
