import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VideoDropzone } from "./video-dropzone";

const FILE = new File(["video"], "bangkok.mp4", {
  type: "video/mp4",
  lastModified: 1,
});

describe("VideoDropzone", () => {
  it("passes picker and dropped videos through the same enqueue callback", () => {
    const enqueue = vi.fn();
    render(<VideoDropzone disabled={false} onFiles={enqueue} />);

    fireEvent.change(screen.getByLabelText("Thêm video"), {
      target: { files: [FILE] },
    });
    fireEvent.drop(screen.getByRole("button", { name: "Kéo thả hoặc chọn video" }), {
      dataTransfer: { files: [FILE] },
    });

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[0]?.[0]).toEqual([FILE]);
    expect(enqueue.mock.calls[1]?.[0]).toEqual([FILE]);
  });

  it("keeps picker and drop disabled together", () => {
    const enqueue = vi.fn();
    render(<VideoDropzone disabled onFiles={enqueue} />);

    expect(screen.getByRole("button", { name: "Kéo thả hoặc chọn video" })).toBeDisabled();
    expect(screen.getByLabelText("Thêm video")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Thêm video"), {
      target: { files: [FILE] },
    });
    fireEvent.drop(screen.getByRole("button", { name: "Kéo thả hoặc chọn video" }), {
      dataTransfer: { files: [FILE] },
    });

    expect(enqueue).not.toHaveBeenCalled();
  });
});
