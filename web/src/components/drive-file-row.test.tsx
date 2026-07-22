import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DriveFileRow } from "./drive-file-row";

const READY_FILE = {
  artifactId: "artifact-ready",
  name: "abcd.mp4",
  sizeBytes: 824 * 1_024 ** 2,
  uploadedAt: "2026-07-22T08:30:00.000Z",
  durationMillis: 5_076_000,
  width: 1_920,
  height: 1_080,
  readiness: "READY" as const,
  viewUrl: "https://drive.google.com/file/d/drive-video-001/view",
  downloadUrl: "https://drive.usercontent.google.com/download?id=drive-video-001",
};

const PROCESSING_FILE = {
  ...READY_FILE,
  artifactId: "artifact-processing",
  durationMillis: null,
  width: null,
  height: null,
  readiness: "PROCESSING" as const,
  viewUrl: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DriveFileRow", () => {
  it("keeps a closed video row minimal", () => {
    render(<DriveFileRow file={READY_FILE} onDelete={vi.fn()} />);

    expect(screen.getByText("abcd.mp4")).toBeVisible();
    expect(screen.getByText("824 MB")).toBeVisible();
    expect(screen.queryByText("01:24:36")).not.toBeInTheDocument();
    expect(screen.queryByText("1920 × 1080")).not.toBeInTheDocument();
  });

  it("expands to three icon stats and enables safe preview and download links", () => {
    render(<DriveFileRow file={READY_FILE} onDelete={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Mở thông tin abcd.mp4" }));

    expect(screen.getByText("01:24:36")).toBeVisible();
    expect(screen.getByText("1920 × 1080")).toBeVisible();
    expect(screen.getByTestId("uploaded-stat-icon")).toBeInTheDocument();
    expect(screen.getByTestId("duration-stat-icon")).toBeInTheDocument();
    expect(screen.getByTestId("resolution-stat-icon")).toBeInTheDocument();
    expect(screen.getByText("Sẵn sàng xem")).toBeVisible();
    expect(screen.getByRole("link", { name: "Xem trước abcd.mp4" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "Xem trước abcd.mp4" })).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("link", { name: "Tải xuống abcd.mp4" })).toHaveAttribute("target", "_blank");
  });

  it("disables preview while Drive is processing", () => {
    render(<DriveFileRow file={PROCESSING_FILE} onDelete={vi.fn()} defaultExpanded />);

    expect(screen.getByRole("button", { name: "Xem trước abcd.mp4" })).toBeDisabled();
    expect(screen.getByText("Drive đang xử lý")).toBeVisible();
  });

  it("does not expose external navigation when a Drive URL is unsafe", () => {
    render(
      <DriveFileRow
        file={{
          ...READY_FILE,
          viewUrl: "https://evil.test/preview",
          downloadUrl: "javascript:alert(1)",
        }}
        onDelete={vi.fn()}
        defaultExpanded
      />,
    );

    expect(screen.queryByRole("link", { name: "Xem trước abcd.mp4" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Tải xuống abcd.mp4" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Xem trước abcd.mp4" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Tải xuống abcd.mp4" })).toBeDisabled();
  });

  it.each(["Enter", " "])("supports %s keyboard expansion", (key) => {
    render(<DriveFileRow file={READY_FILE} onDelete={vi.fn()} />);
    const toggle = screen.getByRole("button", { name: "Mở thông tin abcd.mp4" });

    fireEvent.keyDown(toggle, { key });

    expect(screen.getByText("01:24:36")).toBeVisible();
    expect(screen.getByRole("button", { name: "Đóng thông tin abcd.mp4" })).toHaveAttribute("aria-expanded", "true");
  });

  it("requires named confirmation and reports successful deletion", async () => {
    const confirm = vi.fn(() => true);
    const onDelete = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("confirm", confirm);
    render(<DriveFileRow file={READY_FILE} onDelete={onDelete} defaultExpanded />);

    fireEvent.click(screen.getByRole("button", { name: "Xoá video abcd.mp4" }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("abcd.mp4"));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("artifact-ready"));
    expect(await screen.findByRole("status")).toHaveTextContent("Đã xoá abcd.mp4");
  });

  it("does not delete when confirmation is declined", () => {
    const onDelete = vi.fn();
    vi.stubGlobal("confirm", vi.fn(() => false));
    render(<DriveFileRow file={READY_FILE} onDelete={onDelete} defaultExpanded />);

    fireEvent.click(screen.getByRole("button", { name: "Xoá video abcd.mp4" }));

    expect(onDelete).not.toHaveBeenCalled();
  });

  it("locks delete while pending and reports an inline failure", async () => {
    let rejectDelete: ((error: Error) => void) | undefined;
    const onDelete = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectDelete = reject;
    }));
    vi.stubGlobal("confirm", vi.fn(() => true));
    render(<DriveFileRow file={READY_FILE} onDelete={onDelete} defaultExpanded />);
    const deleteButton = screen.getByRole("button", { name: "Xoá video abcd.mp4" });

    fireEvent.click(deleteButton);
    expect(deleteButton).toBeDisabled();
    expect(deleteButton).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Đang xoá abcd.mp4" })).toBe(deleteButton);

    rejectDelete?.(new Error("network unavailable"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Chưa thể xoá abcd.mp4");
    expect(deleteButton).toBeEnabled();
  });
});
