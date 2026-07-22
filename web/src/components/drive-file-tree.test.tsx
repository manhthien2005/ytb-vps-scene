import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DriveFileTree } from "./drive-file-tree";

const INPUT_FILE = {
  artifactId: "source-1",
  name: "source.mp4",
  sizeBytes: 10 * 1_024 ** 2,
  uploadedAt: "2026-07-22T08:30:00.000Z",
  durationMillis: 10_000,
  width: 1_920,
  height: 1_080,
  readiness: "READY" as const,
  viewUrl: "https://drive.google.com/file/d/source/view",
  downloadUrl: "https://drive.usercontent.google.com/download?id=source",
};

const OUTPUT_FILE = {
  ...INPUT_FILE,
  artifactId: "output-1",
  name: "part-01-of-02.mp4",
};

const VIEW = {
  input: [INPUT_FILE],
  output: [
    { projectId: "project-1", name: "Phim Hà Nội", files: [OUTPUT_FILE] },
    { projectId: "project-2", name: "Phim Huế", files: [] },
  ],
  processingCount: 0,
};

describe("DriveFileTree", () => {
  it("renders Input as a semantic folder list with direct video rows and the dropzone", () => {
    render(
      <DriveFileTree
        kind="input"
        view={VIEW}
        onDelete={vi.fn()}
        dropzone={<button type="button">Thêm video</button>}
      />,
    );
    const region = screen.getByRole("region", { name: "Input" });

    expect(within(region).getByRole("list")).toBeVisible();
    expect(within(region).getByRole("button", { name: "Thu gọn YTB-VPS/input" })).toHaveAttribute("aria-expanded", "true");
    expect(within(region).getByText("source.mp4")).toBeVisible();
    expect(within(region).getByRole("button", { name: "Thêm video" })).toBeVisible();
    expect(within(region).getByTestId("folder-icon")).toBeInTheDocument();
    expect(within(region).getByTestId("video-icon")).toBeInTheDocument();
  });

  it("renders Output project folders with independently expandable child video rows", () => {
    render(<DriveFileTree kind="output" view={VIEW} onDelete={vi.fn()} />);
    const region = screen.getByRole("region", { name: "Output" });
    const firstFolder = within(region).getByRole("button", { name: "Mở thư mục Phim Hà Nội" });
    const secondFolder = within(region).getByRole("button", { name: "Mở thư mục Phim Huế" });

    expect(firstFolder).toHaveAttribute("aria-expanded", "false");
    expect(secondFolder).toHaveAttribute("aria-expanded", "false");
    expect(within(region).queryByText("part-01-of-02.mp4")).not.toBeInTheDocument();

    fireEvent.click(firstFolder);

    expect(within(region).getByText("part-01-of-02.mp4")).toBeVisible();
    expect(within(region).getByRole("button", { name: "Đóng thư mục Phim Hà Nội" })).toHaveAttribute("aria-expanded", "true");
    expect(secondFolder).toHaveAttribute("aria-expanded", "false");
    expect(within(region).getAllByTestId("folder-icon").length).toBeGreaterThan(1);
    expect(within(region).getByTestId("video-icon")).toBeInTheDocument();
  });

  it("keeps empty and error states inside their own columns", () => {
    const { rerender } = render(
      <div>
        <DriveFileTree kind="input" view={{ ...VIEW, input: [] }} onDelete={vi.fn()} dropzone={<span>Dropzone</span>} />
        <DriveFileTree kind="output" view={{ ...VIEW, output: [] }} onDelete={vi.fn()} />
      </div>,
    );

    expect(within(screen.getByRole("region", { name: "Input" })).getByText("Chưa có video nguồn.")).toBeVisible();
    expect(within(screen.getByRole("region", { name: "Output" })).getByText("Chưa có video render.")).toBeVisible();

    rerender(
      <div>
        <DriveFileTree kind="input" view={VIEW} onDelete={vi.fn()} error="Không tải được Input." />
        <DriveFileTree kind="output" view={VIEW} onDelete={vi.fn()} />
      </div>,
    );

    expect(within(screen.getByRole("region", { name: "Input" })).getByRole("alert")).toHaveTextContent("Không tải được Input.");
    expect(within(screen.getByRole("region", { name: "Output" })).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps file expansion state independent by artifact ID", () => {
    render(<DriveFileTree kind="input" view={{ ...VIEW, input: [INPUT_FILE, { ...INPUT_FILE, artifactId: "source-2", name: "second.mp4" }] }} onDelete={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Mở thông tin source.mp4" }));

    expect(screen.getByRole("button", { name: "Đóng thông tin source.mp4" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Mở thông tin second.mp4" })).toHaveAttribute("aria-expanded", "false");
  });
});
