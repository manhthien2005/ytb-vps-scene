import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  ResumableUploader,
  ResumableUploaderDependencies,
  UploadSnapshot,
} from "@/lib/browser/resumable-uploader";
import type { StoredUploadSession, UploadSessionStore } from "@/lib/browser/upload-store";
import { ProjectUpload } from "./project-upload";
import type { FreeTierHealthView, PublicProject } from "./dashboard-types";

const PROJECT: PublicProject = {
  id: "10000000-0000-4000-8000-000000000001",
  status: "READY",
  name: "Test 1",
  sourceStatus: "NO_SOURCE",
  createdAt: "2026-07-19T00:00:00.000Z",
  updatedAt: "2026-07-19T00:00:00.000Z",
};
const SECOND_PROJECT: PublicProject = {
  ...PROJECT,
  id: "10000000-0000-4000-8000-000000000002",
  name: "Test 2",
};
const HEALTHY: FreeTierHealthView = {
  mode: "READ_WRITE",
  reasons: [],
  driveConnection: "CONNECTED",
  drive: { usedBytes: 100, limitBytes: 1_000, appManagedBytes: 20, observedAt: "2026-07-19T00:00:00.000Z" },
  neon: { usedBytes: 10, limitBytes: 1_000, appManagedBytes: 0, observedAt: "2026-07-19T00:00:00.000Z" },
};
const EMPTY_SNAPSHOT: UploadSnapshot = {
  phase: "IDLE",
  committedBytes: 0,
  totalBytes: 0,
  bytesPerSecond: 0,
  publicCode: null,
};

function memoryStore(initial: readonly StoredUploadSession[] = []): UploadSessionStore {
  const rows = new Map(initial.map((row) => [`${row.projectId}:${row.artifactId}`, row]));
  return {
    get: async (projectId, artifactId) => rows.get(`${projectId}:${artifactId}`) ?? null,
    put: async (next) => { rows.set(`${next.projectId}:${next.artifactId}`, next); },
    delete: async (projectId, artifactId) => { rows.delete(`${projectId}:${artifactId}`); },
    list: async () => [...rows.values()],
  };
}

function sessionBody(artifactId: string) {
  return new Response(JSON.stringify({
    artifactId,
    sessionUri: "https://www.googleapis.com/upload/drive/v3/files/source?upload_id=synthetic-capability",
    chunkBytes: 8_388_608,
    expiresAt: "2026-07-26T00:00:00.000Z",
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function projectBody(project: PublicProject) {
  return new Response(JSON.stringify({ project }), {
    status: 201,
    headers: { "content-type": "application/json" },
  });
}

describe("ProjectUpload", () => {
  it("disables new work when quota evidence is stale", () => {
    render(<ProjectUpload health={{ ...HEALTHY, mode: "READ_ONLY", reasons: ["DRIVE_QUOTA_STALE"] }} projects={[]} />);
    expect(screen.getByLabelText("Thêm video")).toBeDisabled();
    expect(screen.getByText("Chưa xác minh được dung lượng Google Drive.")).toBeVisible();
  });

  it("auto-creates a project and uploads with a progress bar when a file is picked", async () => {
    let listener: ((snapshot: UploadSnapshot) => void) | null = null;
    const snapshot: UploadSnapshot = { phase: "UPLOADING", committedBytes: 50, totalBytes: 100, bytesPerSecond: 25, publicCode: null };
    const uploader: ResumableUploader = {
      start: vi.fn(async () => { listener?.(snapshot); }),
      resume: vi.fn(),
      pause: vi.fn(),
      cancel: vi.fn(),
      subscribe: vi.fn((next) => { listener = next; return () => { listener = null; }; }),
      dispose: vi.fn(),
      snapshot: vi.fn(() => snapshot),
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(projectBody(PROJECT))
      .mockResolvedValueOnce(sessionBody(PROJECT.id));
    const onProjectsChange = vi.fn();
    const uploaderFactory = vi.fn<(dependencies: ResumableUploaderDependencies) => ResumableUploader>(() => uploader);
    render(<ProjectUpload health={HEALTHY} projects={[]} fetcher={fetcher} store={memoryStore()} uploaderFactory={uploaderFactory} onProjectsChange={onProjectsChange} />);
    const file = new File([new Uint8Array(100)], "Phim thử nghiệm.mp4", { type: "video/mp4", lastModified: 1 });

    fireEvent.change(screen.getByLabelText("Thêm video"), { target: { files: [file] } });

    expect(await screen.findByText("50%")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "Tiến trình Phim thử nghiệm" })).toHaveAttribute("aria-valuenow", "50");
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "/api/v1/projects",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "Phim thử nghiệm" }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      `/api/v1/projects/${PROJECT.id}/upload-session`,
      expect.any(Object),
    );
    expect(onProjectsChange).toHaveBeenCalledWith([PROJECT]);
  });

  it("sends the extension-derived MIME type even when the browser reports none", async () => {
    const uploader: ResumableUploader = {
      start: vi.fn(async () => undefined),
      resume: vi.fn(),
      pause: vi.fn(),
      cancel: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
      dispose: vi.fn(),
      snapshot: vi.fn(() => EMPTY_SNAPSHOT),
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(projectBody(PROJECT))
      .mockResolvedValueOnce(sessionBody(PROJECT.id));
    render(<ProjectUpload health={HEALTHY} projects={[]} fetcher={fetcher} store={memoryStore()} uploaderFactory={() => uploader} />);
    const file = new File([new Uint8Array(100)], "phim.mkv", { type: "", lastModified: 1 });

    fireEvent.change(screen.getByLabelText("Thêm video"), { target: { files: [file] } });

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      `/api/v1/projects/${PROJECT.id}/upload-session`,
      expect.objectContaining({
        body: JSON.stringify({
          fileName: "phim.mkv",
          mimeType: "video/x-matroska",
          sizeBytes: 100,
          lastModified: 1,
        }),
      }),
    );
  });

  it("queues multiple files and uploads them sequentially", async () => {
    const listeners = new Map<ResumableUploader, (snapshot: UploadSnapshot) => void>();
    const started: string[] = [];
    function makeUploader(): ResumableUploader {
      const uploader: ResumableUploader = {
        start: vi.fn(async (file: File) => {
          started.push(file.name);
          listeners.get(uploader)?.({ phase: "READY", committedBytes: file.size, totalBytes: file.size, bytesPerSecond: 0, publicCode: null });
        }),
        resume: vi.fn(),
        pause: vi.fn(),
        cancel: vi.fn(),
        subscribe: vi.fn((next) => { listeners.set(uploader, next); return () => listeners.delete(uploader); }),
        dispose: vi.fn(),
        snapshot: vi.fn(() => EMPTY_SNAPSHOT),
      };
      return uploader;
    }
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(projectBody(PROJECT))
      .mockResolvedValueOnce(sessionBody(PROJECT.id))
      .mockResolvedValueOnce(projectBody(SECOND_PROJECT))
      .mockResolvedValueOnce(sessionBody(SECOND_PROJECT.id));
    const onSourceFile = vi.fn();
    render(<ProjectUpload health={HEALTHY} projects={[]} fetcher={fetcher} store={memoryStore()} uploaderFactory={makeUploader} onSourceFile={onSourceFile} />);
    const first = new File([new Uint8Array(100)], "Video một.mp4", { type: "video/mp4", lastModified: 1 });
    const second = new File([new Uint8Array(80)], "Video hai.mp4", { type: "video/mp4", lastModified: 2 });

    fireEvent.change(screen.getByLabelText("Thêm video"), { target: { files: [first, second] } });

    await waitFor(() => expect(screen.getAllByText("Đã lên Drive")).toHaveLength(2));
    expect(started).toEqual(["Video một.mp4", "Video hai.mp4"]);
    expect(screen.getByText("Video một.mp4")).toBeVisible();
    expect(screen.getByText("Video hai.mp4")).toBeVisible();
    expect(onSourceFile).toHaveBeenNthCalledWith(1, PROJECT.id, first);
    expect(onSourceFile).toHaveBeenNthCalledWith(2, SECOND_PROJECT.id, second);
    expect(screen.getByLabelText("Thêm video")).toBeEnabled();
  });

  it("marks unsupported files as failed without calling the server", async () => {
    const fetcher = vi.fn<typeof fetch>();
    render(<ProjectUpload health={HEALTHY} projects={[]} fetcher={fetcher} store={memoryStore()} />);
    const file = new File([new Uint8Array(10)], "tài liệu.pdf", { type: "application/pdf", lastModified: 1 });

    fireEvent.change(screen.getByLabelText("Thêm video"), { target: { files: [file] } });

    expect(await screen.findByText("Chỉ nhận video MP4, MOV, MKV hoặc WEBM.")).toBeVisible();
    expect(screen.getByText("Tải lỗi")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Thử lại tài liệu.pdf" })).not.toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("supports pause and resume on the active item", async () => {
    let listener: ((snapshot: UploadSnapshot) => void) | null = null;
    const snapshot: UploadSnapshot = { phase: "UPLOADING", committedBytes: 50, totalBytes: 100, bytesPerSecond: 25, publicCode: null };
    const uploader: ResumableUploader = {
      start: vi.fn(async () => { listener?.(snapshot); }),
      resume: vi.fn(async () => { listener?.(snapshot); }),
      pause: vi.fn(() => { listener?.({ ...snapshot, phase: "PAUSED" }); }),
      cancel: vi.fn(),
      subscribe: vi.fn((next) => { listener = next; return () => { listener = null; }; }),
      dispose: vi.fn(),
      snapshot: vi.fn(() => snapshot),
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(projectBody(PROJECT))
      .mockResolvedValueOnce(sessionBody(PROJECT.id));
    render(<ProjectUpload health={HEALTHY} projects={[]} fetcher={fetcher} store={memoryStore()} uploaderFactory={() => uploader} />);
    const file = new File([new Uint8Array(100)], "video.mp4", { type: "video/mp4", lastModified: 1 });

    fireEvent.change(screen.getByLabelText("Thêm video"), { target: { files: [file] } });

    expect(await screen.findByText("50%")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Tạm dừng video.mp4" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Tiếp tục video.mp4" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Tiếp tục video.mp4" }));
    await waitFor(() => expect(uploader.resume).toHaveBeenCalled());
  });

  it("resumes a matching persisted session without creating a second provider session", async () => {
    const persisted: StoredUploadSession = {
      projectId: PROJECT.id,
      artifactId: "20000000-0000-4000-8000-000000000002",
      sessionUri: "https://www.googleapis.com/upload/drive/v3/files/source?upload_id=synthetic-capability",
      fileIdentity: {
        displayName: "video.mp4",
        sizeBytes: 100,
        mimeType: "video/mp4",
        lastModified: 1,
      },
      nextOffset: 50,
      chunkBytes: 8_388_608,
      expiresAt: "2026-07-26T00:00:00.000Z",
    };
    let listener: ((snapshot: UploadSnapshot) => void) | null = null;
    const uploader: ResumableUploader = {
      start: vi.fn(),
      resume: vi.fn(async () => listener?.({
        phase: "UPLOADING",
        committedBytes: 50,
        totalBytes: 100,
        bytesPerSecond: 25,
        publicCode: null,
      })),
      pause: vi.fn(),
      cancel: vi.fn(),
      subscribe: vi.fn((next) => { listener = next; return () => { listener = null; }; }),
      dispose: vi.fn(),
      snapshot: vi.fn(() => EMPTY_SNAPSHOT),
    };
    const fetcher = vi.fn<typeof fetch>();
    render(<ProjectUpload health={HEALTHY} projects={[PROJECT]} fetcher={fetcher} store={memoryStore([persisted])} uploaderFactory={() => uploader} />);
    const file = new File([new Uint8Array(100)], "video.mp4", { type: "video/mp4", lastModified: 1 });

    expect(await screen.findByText(/Có phiên tải dở/)).toBeVisible();
    fireEvent.change(screen.getByLabelText("Thêm video"), { target: { files: [file] } });

    await waitFor(() => expect(uploader.resume).toHaveBeenCalledWith(file, persisted));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retries a failed item through the same sequential queue", async () => {
    let listener: ((snapshot: UploadSnapshot) => void) | null = null;
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
      snapshot: vi.fn(() => EMPTY_SNAPSHOT),
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "DRIVE_TEMPORARILY_UNAVAILABLE" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(projectBody(PROJECT))
      .mockResolvedValueOnce(sessionBody(PROJECT.id));
    render(<ProjectUpload health={HEALTHY} projects={[]} fetcher={fetcher} store={memoryStore()} uploaderFactory={() => uploader} />);
    const file = new File([new Uint8Array(100)], "video.mp4", { type: "video/mp4", lastModified: 1 });

    fireEvent.change(screen.getByLabelText("Thêm video"), { target: { files: [file] } });
    expect(await screen.findByText("Tải lỗi")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Thử lại video.mp4" }));

    await waitFor(() => expect(uploader.start).toHaveBeenCalled());
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(await screen.findByText("Đã lên Drive")).toBeVisible();
  });

  it("keeps an item visible until permanent cancellation succeeds", async () => {
    let listener: ((snapshot: UploadSnapshot) => void) | null = null;
    let resolveCancel: (() => void) | null = null;
    const snapshot: UploadSnapshot = {
      phase: "UPLOADING",
      committedBytes: 50,
      totalBytes: 100,
      bytesPerSecond: 25,
      publicCode: null,
    };
    const uploader: ResumableUploader = {
      start: vi.fn(async () => listener?.(snapshot)),
      resume: vi.fn(),
      pause: vi.fn(),
      cancel: vi.fn(() => new Promise<void>((resolve) => { resolveCancel = resolve; })),
      subscribe: vi.fn((next) => { listener = next; return () => { listener = null; }; }),
      dispose: vi.fn(),
      snapshot: vi.fn(() => snapshot),
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(projectBody(PROJECT))
      .mockResolvedValueOnce(sessionBody(PROJECT.id));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ProjectUpload health={HEALTHY} projects={[]} fetcher={fetcher} store={memoryStore()} uploaderFactory={() => uploader} />);
    const file = new File([new Uint8Array(100)], "video.mp4", { type: "video/mp4", lastModified: 1 });

    fireEvent.change(screen.getByLabelText("Thêm video"), { target: { files: [file] } });
    expect(await screen.findByText("50%")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Dừng và huỷ video.mp4" }));

    expect(uploader.cancel).toHaveBeenCalledTimes(1);
    expect(screen.getByText("video.mp4")).toBeVisible();
    await act(async () => resolveCancel?.());
    await waitFor(() => expect(screen.queryByText("video.mp4")).not.toBeInTheDocument());
    confirm.mockRestore();
  });

  it("exposes upload diagnostics on the section element", async () => {
    let dependencies: ResumableUploaderDependencies | null = null;
    const uploader: ResumableUploader = {
      start: vi.fn(async () => undefined),
      resume: vi.fn(),
      pause: vi.fn(),
      cancel: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
      dispose: vi.fn(),
      snapshot: vi.fn(() => EMPTY_SNAPSHOT),
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(projectBody(PROJECT))
      .mockResolvedValueOnce(sessionBody(PROJECT.id));
    render(<ProjectUpload health={HEALTHY} projects={[]} fetcher={fetcher} store={memoryStore()} uploaderFactory={(value) => { dependencies = value; return uploader; }} />);
    const file = new File([new Uint8Array(100)], "video.mp4", { type: "video/mp4", lastModified: 1 });

    fireEvent.change(screen.getByLabelText("Thêm video"), { target: { files: [file] } });
    await waitFor(() => expect(dependencies).not.toBeNull());

    const consoleDiagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const region = screen.getByRole("region", { name: "Tải video lên Drive" });
    act(() => dependencies?.onDiagnostic?.({ stage: "chunk-fetch", outcome: "rejected" }));
    const chunkCode = region.getAttribute("data-upload-diagnostic");
    act(() => dependencies?.onDiagnostic?.({ stage: "query-response", status: 308, rangeVisible: false }));
    const queryRangeCode = region.getAttribute("data-upload-diagnostic");
    consoleDiagnostic.mockRestore();
    expect([chunkCode, queryRangeCode]).toEqual(["CHUNK_FETCH_REJECTED", "QUERY_RANGE_HIDDEN"]);
  });
});
