import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ResumableUploader,
  UploadSnapshot,
} from "@/lib/browser/resumable-uploader";
import type { UploadSessionStore } from "@/lib/browser/upload-store";
import { DriveWorkspace } from "./drive-workspace";
import type {
  DriveConnectionView,
  DriveWorkspaceView,
  FreeTierHealthView,
  PublicProject,
} from "./dashboard-types";

const CONNECTED: DriveConnectionView = {
  status: "CONNECTED",
  accountHint: "a***@example.test",
  rootReady: true,
};
const DISCONNECTED: DriveConnectionView = {
  status: "DISCONNECTED",
  accountHint: null,
  rootReady: false,
};
const HEALTHY: FreeTierHealthView = {
  mode: "READ_WRITE",
  reasons: [],
  driveConnection: "CONNECTED",
  drive: { usedBytes: 100, limitBytes: 1_000, appManagedBytes: 20, observedAt: "2026-07-19T00:00:00.000Z" },
  neon: { usedBytes: 10, limitBytes: 1_000, appManagedBytes: 0, observedAt: "2026-07-19T00:00:00.000Z" },
};
const EMPTY_VIEW: DriveWorkspaceView = { input: [], output: [], processingCount: 0 };
const PROCESSING_VIEW: DriveWorkspaceView = {
  input: [{
    artifactId: "20000000-0000-4000-8000-000000000001",
    name: "source.mp4",
    sizeBytes: 10 * 1_024 ** 2,
    uploadedAt: "2026-07-22T08:30:00.000Z",
    durationMillis: null,
    width: null,
    height: null,
    readiness: "PROCESSING",
    viewUrl: null,
    downloadUrl: "https://drive.usercontent.google.com/download?id=source",
  }],
  output: [],
  processingCount: 1,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function emptyStore(): UploadSessionStore {
  return {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
    list: async () => [],
  };
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("DriveWorkspace", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders the Drive header, Input and Output trees, and queue below both columns", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(EMPTY_VIEW));
    const { container } = render(
      <DriveWorkspace drive={CONNECTED} health={HEALTHY} projects={[]} fetcher={fetcher} store={emptyStore()} />,
    );

    expect(await screen.findByRole("heading", { name: "Drive" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Input" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Output" })).toBeVisible();
    const queue = screen.getByRole("region", { name: "Hàng đợi tải lên" });
    expect(queue).toHaveClass("drive-upload-queue");
    expect(container.querySelector(".drive-browser-grid")?.nextElementSibling).toBe(queue);
  });

  it("shows loading, preserves both columns on error, and retries manually", async () => {
    let rejectInitial!: (reason?: unknown) => void;
    const initial = new Promise<Response>((_resolve, reject) => { rejectInitial = reject; });
    const fetcher = vi.fn<typeof fetch>()
      .mockReturnValueOnce(initial)
      .mockResolvedValueOnce(jsonResponse(EMPTY_VIEW));
    render(<DriveWorkspace drive={CONNECTED} health={HEALTHY} projects={[]} fetcher={fetcher} store={emptyStore()} />);

    expect(screen.getAllByText("Đang tải file Drive…")).toHaveLength(2);
    expect(screen.queryByText("Chưa có video nguồn.")).not.toBeInTheDocument();
    expect(screen.queryByText("Chưa có video render.")).not.toBeInTheDocument();
    rejectInitial(new Error("offline"));
    expect(await screen.findAllByRole("alert")).toHaveLength(2);
    expect(screen.getAllByRole("alert")[0]).toHaveTextContent("Chưa thể tải danh sách file Drive.");
    expect(screen.getByRole("region", { name: "Input" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Output" })).toBeVisible();
    expect(screen.queryByText("Chưa có video nguồn.")).not.toBeInTheDocument();
    expect(screen.queryByText("Chưa có video render.")).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Input" })).getByRole("button", {
      name: "Thử tải lại danh sách Drive",
    })).toBeEnabled();
    expect(within(screen.getByRole("region", { name: "Output" })).getByRole("button", {
      name: "Thử tải lại danh sách Drive",
    })).toBeEnabled();

    fireEvent.click(within(screen.getByRole("region", { name: "Input" })).getByRole("button", {
      name: "Thử tải lại danh sách Drive",
    }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("rejects malformed nested workspace data before rendering file rows", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      input: [{ artifactId: "broken", name: "broken.mp4" }],
      output: [],
      processingCount: 0,
    }));
    render(<DriveWorkspace drive={CONNECTED} health={HEALTHY} projects={[]} fetcher={fetcher} store={emptyStore()} />);

    expect(await screen.findAllByRole("alert")).toHaveLength(2);
    expect(screen.queryByText("broken.mp4")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Thử tải lại danh sách Drive" })).toHaveLength(2);
  });

  it("keeps disconnected trees disabled and offers connect without fetching files", () => {
    const fetcher = vi.fn<typeof fetch>();
    render(
      <DriveWorkspace
        drive={DISCONNECTED}
        health={{ ...HEALTHY, driveConnection: "DISCONNECTED" }}
        projects={[]}
        fetcher={fetcher}
        store={emptyStore()}
      />,
    );

    expect(screen.getByText("Chưa kết nối")).toBeVisible();
    expect(screen.getByRole("button", { name: "Kết nối Google Drive" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Kéo thả hoặc chọn video" })).toBeDisabled();
    expect(screen.getByLabelText("Thêm video")).toBeDisabled();
    expect(screen.getByText("Kết nối Google Drive để xem và quản lý video.")).toBeVisible();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports a connect error and rejects an untrusted authorization URL", async () => {
    const navigate = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ authorizationUrl: "https://evil.test/oauth" }));
    render(
      <DriveWorkspace
        drive={DISCONNECTED}
        health={{ ...HEALTHY, driveConnection: "DISCONNECTED" }}
        projects={[]}
        fetcher={fetcher}
        navigate={navigate}
        store={emptyStore()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Kết nối Google Drive" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Chưa thể bắt đầu kết nối Google Drive.");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("rejects a Google authorization URL on a nonstandard port", async () => {
    const navigate = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      authorizationUrl: "https://accounts.google.com:444/o/oauth2/v2/auth?client_id=synthetic",
    }));
    render(
      <DriveWorkspace
        drive={DISCONNECTED}
        health={{ ...HEALTHY, driveConnection: "DISCONNECTED" }}
        projects={[]}
        fetcher={fetcher}
        navigate={navigate}
        store={emptyStore()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Kết nối Google Drive" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Chưa thể bắt đầu kết nối Google Drive.");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("disconnects from the Drive header", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input) === "/api/v1/drive/files") return jsonResponse(EMPTY_VIEW);
      if (String(input) === "/api/v1/drive/disconnect") return jsonResponse({ status: "DISCONNECTED" });
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    render(<DriveWorkspace drive={CONNECTED} health={HEALTHY} projects={[]} fetcher={fetcher} store={emptyStore()} />);
    await screen.findByText("Chưa có video nguồn.");

    fireEvent.click(screen.getByRole("button", { name: "Ngắt kết nối" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Đã gửi yêu cầu ngắt kết nối.");
    expect(screen.getByText("Chưa kết nối")).toBeVisible();
    expect(screen.getByRole("button", { name: "Kết nối Google Drive" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Kéo thả hoặc chọn video" })).toBeDisabled();
    expect(fetcher).toHaveBeenCalledWith("/api/v1/drive/disconnect", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
    }));
  });

  it("synchronizes the header when refreshed server props change connection status", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(EMPTY_VIEW));
    const { rerender } = render(
      <DriveWorkspace drive={CONNECTED} health={HEALTHY} projects={[]} fetcher={fetcher} store={emptyStore()} />,
    );
    await screen.findByText("Chưa có video nguồn.");

    rerender(
      <DriveWorkspace
        drive={{ status: "REAUTH_REQUIRED", accountHint: null, rootReady: false }}
        health={{ ...HEALTHY, driveConnection: "REAUTH_REQUIRED" }}
        projects={[]}
        fetcher={fetcher}
        store={emptyStore()}
      />,
    );

    expect(screen.getByText("Cần kết nối lại")).toBeVisible();
    expect(screen.getByRole("button", { name: "Kết nối lại Google Drive" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Ngắt kết nối" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Kéo thả hoặc chọn video" })).toBeDisabled();
  });

  it("refreshes processing files at bounded 5, 10, and 20 second intervals", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse(PROCESSING_VIEW));
    render(<DriveWorkspace drive={CONNECTED} health={HEALTHY} projects={[]} fetcher={fetcher} store={emptyStore()} />);
    await flushEffects();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(4_999); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetcher).toHaveBeenCalledTimes(2);

    await act(async () => { await vi.advanceTimersByTimeAsync(9_999); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetcher).toHaveBeenCalledTimes(3);

    await act(async () => { await vi.advanceTimersByTimeAsync(19_999); });
    expect(fetcher).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher).toHaveBeenLastCalledWith("/api/v1/drive/files", expect.objectContaining({
      cache: "no-store",
      credentials: "same-origin",
    }));
  });

  it("does not poll when no processing files remain", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(EMPTY_VIEW));
    render(<DriveWorkspace drive={CONNECTED} health={HEALTHY} projects={[]} fetcher={fetcher} store={emptyStore()} />);
    await flushEffects();

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("pauses processing polling while the document is hidden", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(PROCESSING_VIEW));
    render(<DriveWorkspace drive={CONNECTED} health={HEALTHY} projects={[]} fetcher={fetcher} store={emptyStore()} />);
    await flushEffects();
    expect(fetcher).toHaveBeenCalledTimes(1);

    visibility = "hidden";
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetcher).toHaveBeenCalledTimes(1);

    visibility = "visible";
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(4_999); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("refreshes the tree after a confirmed file deletion", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    let fileGets = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === "/api/v1/drive/files") {
        fileGets += 1;
        return jsonResponse(fileGets === 1 ? PROCESSING_VIEW : EMPTY_VIEW);
      }
      if (url === `/api/v1/drive/files/${PROCESSING_VIEW.input[0]?.artifactId}` && init?.method === "DELETE") {
        return jsonResponse({ deleted: true });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    render(<DriveWorkspace drive={CONNECTED} health={HEALTHY} projects={[]} fetcher={fetcher} store={emptyStore()} />);
    const input = await screen.findByRole("region", { name: "Input" });
    fireEvent.click(await within(input).findByRole("button", { name: "Mở thông tin source.mp4" }));

    fireEvent.click(within(input).getByRole("button", { name: "Xoá video source.mp4" }));

    await waitFor(() => expect(within(input).queryByText("source.mp4")).not.toBeInTheDocument());
    expect(fetcher).toHaveBeenCalledWith(
      `/api/v1/drive/files/${PROCESSING_VIEW.input[0]?.artifactId}`,
      expect.objectContaining({ method: "DELETE", credentials: "same-origin" }),
    );
    expect(fileGets).toBe(2);
    confirm.mockRestore();
  });

  it("does not let an older poll restore a file after a newer deletion refresh", async () => {
    vi.useFakeTimers();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let resolveStalePoll!: (response: Response) => void;
    const stalePoll = new Promise<Response>((resolve) => { resolveStalePoll = resolve; });
    let fileGets = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === "/api/v1/drive/files") {
        fileGets += 1;
        if (fileGets === 1) return jsonResponse(PROCESSING_VIEW);
        if (fileGets === 2) return await stalePoll;
        return jsonResponse(EMPTY_VIEW);
      }
      if (url === `/api/v1/drive/files/${PROCESSING_VIEW.input[0]?.artifactId}` && init?.method === "DELETE") {
        return jsonResponse({ deleted: true });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    render(<DriveWorkspace drive={CONNECTED} health={HEALTHY} projects={[]} fetcher={fetcher} store={emptyStore()} />);
    await flushEffects();
    const open = screen.getByRole("button", { name: "Mở thông tin source.mp4" });

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(fileGets).toBe(2);
    fireEvent.click(open);
    fireEvent.click(screen.getByRole("button", { name: "Xoá video source.mp4" }));
    await flushEffects();
    expect(fileGets).toBe(3);
    expect(screen.queryByText("source.mp4")).not.toBeInTheDocument();

    await act(async () => { resolveStalePoll(jsonResponse(PROCESSING_VIEW)); });

    expect(screen.queryByText("source.mp4")).not.toBeInTheDocument();
  });

  it("refreshes the tree and preserves source-ready callbacks after upload completion", async () => {
    const project: PublicProject = {
      id: "10000000-0000-4000-8000-000000000001",
      status: "READY",
      name: "Phim thử nghiệm",
      sourceStatus: "NO_SOURCE",
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
    };
    let fileGets = 0;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "/api/v1/drive/files") {
        fileGets += 1;
        return jsonResponse(EMPTY_VIEW);
      }
      if (url === "/api/v1/projects") return jsonResponse({ project }, 201);
      if (url === `/api/v1/projects/${project.id}/upload-session`) {
        return jsonResponse({
          artifactId: "20000000-0000-4000-8000-000000000002",
          sessionUri: "https://www.googleapis.com/upload/drive/v3/files/source?upload_id=synthetic-capability",
          chunkBytes: 8_388_608,
          expiresAt: "2026-07-26T00:00:00.000Z",
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    let listener: ((snapshot: UploadSnapshot) => void) | null = null;
    const idleSnapshot: UploadSnapshot = {
      phase: "IDLE",
      committedBytes: 0,
      totalBytes: 0,
      bytesPerSecond: 0,
      publicCode: null,
    };
    const uploader: ResumableUploader = {
      start: vi.fn(async (file) => listener?.({
        phase: "READY",
        committedBytes: file.size,
        totalBytes: file.size,
        bytesPerSecond: 0,
        publicCode: null,
      })),
      resume: vi.fn(),
      pause: vi.fn(),
      cancel: vi.fn(),
      subscribe: vi.fn((next) => { listener = next; return () => { listener = null; }; }),
      dispose: vi.fn(),
      snapshot: vi.fn(() => idleSnapshot),
    };
    const uploaderFactory = vi.fn(() => uploader);
    const onProjectsChange = vi.fn();
    const onSourceFile = vi.fn();
    render(
      <DriveWorkspace
        drive={CONNECTED}
        health={HEALTHY}
        projects={[]}
        fetcher={fetcher}
        store={emptyStore()}
        uploaderFactory={uploaderFactory}
        onProjectsChange={onProjectsChange}
        onSourceFile={onSourceFile}
      />,
    );
    await waitFor(() => expect(fileGets).toBe(1));
    const file = new File([new Uint8Array(100)], "Phim thử nghiệm.mp4", { type: "video/mp4", lastModified: 1 });

    fireEvent.change(screen.getByLabelText("Thêm video"), { target: { files: [file] } });

    await waitFor(() => expect(onSourceFile).toHaveBeenCalledWith(project.id, file));
    await waitFor(() => expect(fileGets).toBe(2));
    expect(onProjectsChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: project.id, sourceStatus: "SOURCE_READY" }),
    ]);
  });
});
