import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UploadQueue } from "./upload-queue";
import type { UploadQueueItem } from "./use-upload-queue";

const MIB = 1024 * 1024;

function videoFile(name: string, size: number): File {
  const file = new File(["video"], name, { type: "video/mp4", lastModified: 1 });
  Object.defineProperty(file, "size", { configurable: true, value: size });
  return file;
}

const ACTIVE_ITEM: UploadQueueItem = {
  id: "active",
  file: videoFile("bangkok.mp4", 638 * MIB),
  mimeType: "video/mp4",
  title: "bangkok",
  projectId: "10000000-0000-4000-8000-000000000001",
  artifactId: "20000000-0000-4000-8000-000000000001",
  snapshot: {
    phase: "UPLOADING",
    committedBytes: 434 * MIB,
    totalBytes: 638 * MIB,
    bytesPerSecond: 17 * MIB,
    publicCode: null,
  },
  message: null,
  state: "ACTIVE",
};

const handlers = () => ({
  onPause: vi.fn(),
  onResume: vi.fn(async () => undefined),
  onCancel: vi.fn(async () => undefined),
  onRetry: vi.fn(async () => undefined),
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UploadQueue", () => {
  it("shows MB progress, percent, ETA, pause and permanent cancel", () => {
    const actions = handlers();
    render(<UploadQueue items={[ACTIVE_ITEM]} {...actions} />);

    expect(screen.getByText("434 MB / 638 MB")).toBeVisible();
    expect(screen.getByText("68%")).toBeVisible();
    expect(screen.getByText("Còn khoảng 12 giây")).toBeVisible();
    expect(screen.getByRole("button", { name: "Tạm dừng bangkok.mp4" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Tạm dừng bangkok.mp4" })).toHaveAttribute(
      "title",
      "Tạm dừng bangkok.mp4",
    );
    expect(screen.getByRole("button", { name: "Dừng và huỷ bangkok.mp4" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Dừng và huỷ bangkok.mp4" })).toHaveAttribute(
      "title",
      "Dừng và huỷ bangkok.mp4",
    );
  });

  it("shows resume for a paused item", () => {
    const actions = handlers();
    render(<UploadQueue items={[{ ...ACTIVE_ITEM, snapshot: { ...ACTIVE_ITEM.snapshot, phase: "PAUSED" } }]} {...actions} />);

    fireEvent.click(screen.getByRole("button", { name: "Tiếp tục bangkok.mp4" }));
    expect(actions.onResume).toHaveBeenCalledWith("active");
    expect(screen.queryByRole("button", { name: "Tạm dừng bangkok.mp4" })).not.toBeInTheDocument();
  });

  it("shows retry for a failed item without a finite ETA", () => {
    const actions = handlers();
    render(
      <UploadQueue
        items={[{
          ...ACTIVE_ITEM,
          state: "FAILED",
          snapshot: { ...ACTIVE_ITEM.snapshot, bytesPerSecond: Number.POSITIVE_INFINITY },
          message: "Mạng đang bận.",
        }]}
        {...actions}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Mạng đang bận.");
    expect(screen.queryByText(/Còn khoảng/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Thử lại bangkok.mp4" }));
    expect(actions.onRetry).toHaveBeenCalledWith("active");
  });

  it("lets a queued item be permanently cancelled without a progress confirmation", () => {
    const actions = handlers();
    const confirm = vi.spyOn(window, "confirm");
    render(
      <UploadQueue
        items={[{
          ...ACTIVE_ITEM,
          state: "QUEUED",
          projectId: null,
          artifactId: null,
          snapshot: {
            phase: "IDLE",
            committedBytes: 0,
            totalBytes: 638 * MIB,
            bytesPerSecond: 0,
            publicCode: null,
          },
        }]}
        {...actions}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Dừng và huỷ bangkok.mp4" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(actions.onCancel).toHaveBeenCalledWith("active");
  });

  it("confirms permanent cancellation after upload progress", () => {
    const actions = handlers();
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<UploadQueue items={[ACTIVE_ITEM]} {...actions} />);
    const cancel = screen.getByRole("button", { name: "Dừng và huỷ bangkok.mp4" });

    fireEvent.click(cancel);
    expect(actions.onCancel).not.toHaveBeenCalled();
    fireEvent.click(cancel);

    expect(confirm).toHaveBeenCalledWith("Dừng và huỷ vĩnh viễn bangkok.mp4?");
    expect(actions.onCancel).toHaveBeenCalledWith("active");
  });

  it("prevents repeated permanent cancellation while the request is pending", async () => {
    let resolveCancel: (() => void) | null = null;
    const actions = handlers();
    actions.onCancel.mockImplementation(() => new Promise<void>((resolve) => { resolveCancel = resolve; }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<UploadQueue items={[ACTIVE_ITEM]} {...actions} />);
    const cancel = screen.getByRole("button", { name: "Dừng và huỷ bangkok.mp4" });

    fireEvent.click(cancel);
    expect(cancel).toBeDisabled();
    fireEvent.click(cancel);
    expect(actions.onCancel).toHaveBeenCalledTimes(1);

    await act(async () => resolveCancel?.());
    await waitFor(() => expect(cancel).toBeEnabled());
  });

  it("never renders raw byte units", () => {
    const actions = handlers();
    const { container } = render(<UploadQueue items={[ACTIVE_ITEM]} {...actions} />);

    expect(container).not.toHaveTextContent(/byte/i);
    expect(container).not.toHaveTextContent(String(ACTIVE_ITEM.snapshot.committedBytes));
    expect(container).not.toHaveTextContent(String(ACTIVE_ITEM.snapshot.totalBytes));
  });
});
