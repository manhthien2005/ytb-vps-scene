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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
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

  it("stops provisioning when permanent cancel is requested during project creation", async () => {
    const pendingProject = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>().mockReturnValueOnce(pendingProject.promise);
    const uploaderFactory = vi.fn<(dependencies: ResumableUploaderDependencies) => ResumableUploader>();
    render(
      <ProjectUpload
        fetcher={fetcher}
        health={HEALTHY}
        projects={[]}
        store={memoryStore()}
        uploaderFactory={uploaderFactory}
      />,
    );
    const file = new File([new Uint8Array(100)], "cancel-project.mp4", {
      type: "video/mp4",
      lastModified: 1,
    });

    fireEvent.change(screen.getByLabelText("Thêm video"), { target: { files: [file] } });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Dừng và huỷ cancel-project.mp4" }));
    pendingProject.resolve(projectBody(PROJECT));

    await waitFor(() => expect(screen.queryByText("cancel-project.mp4")).not.toBeInTheDocument());
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(uploaderFactory).not.toHaveBeenCalled();
  });

  it("remotely cancels an artifact that materializes after provisioning cancel", async () => {
    const artifactId = "20000000-0000-4000-8000-000000000009";
    const pendingSession = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(projectBody(PROJECT))
      .mockReturnValueOnce(pendingSession.promise)
      .mockResolvedValueOnce(new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    const uploaderFactory = vi.fn<(dependencies: ResumableUploaderDependencies) => ResumableUploader>();
    render(
      <ProjectUpload
        fetcher={fetcher}
        health={HEALTHY}
        projects={[]}
        store={memoryStore()}
        uploaderFactory={uploaderFactory}
      />,
    );
    const file = new File([new Uint8Array(100)], "cancel-session.mp4", {
      type: "video/mp4",
      lastModified: 1,
    });

    fireEvent.change(screen.getByLabelText("Thêm video"), { target: { files: [file] } });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Dừng và huỷ cancel-session.mp4" }));
    pendingSession.resolve(sessionBody(artifactId));

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      `/api/v1/projects/${PROJECT.id}/upload-cancel`,
      expect.objectContaining({ body: JSON.stringify({ artifactId }), method: "POST" }),
    );
    await waitFor(() => expect(screen.queryByText("cancel-session.mp4")).not.toBeInTheDocument());
    expect(uploaderFactory).not.toHaveBeenCalled();
  });

  it("remotely cancels after a persisted upload capability finishes saving", async () => {
    const artifactId = "20000000-0000-4000-8000-000000000010";
    const pendingPut = deferred<void>();
    const baseStore = memoryStore();
    const store: UploadSessionStore = {
      ...baseStore,
      put: vi.fn(async () => pendingPut.promise),
      delete: vi.fn(baseStore.delete),
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(projectBody(PROJECT))
      .mockResolvedValueOnce(sessionBody(artifactId))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    const uploaderFactory = vi.fn<(dependencies: ResumableUploaderDependencies) => ResumableUploader>();
    render(
      <ProjectUpload
        fetcher={fetcher}
        health={HEALTHY}
        projects={[]}
        store={store}
        uploaderFactory={uploaderFactory}
      />,
    );
    const file = new File([new Uint8Array(100)], "cancel-save.mp4", {
      type: "video/mp4",
      lastModified: 1,
    });

    fireEvent.change(screen.getByLabelText("Thêm video"), { target: { files: [file] } });
    await waitFor(() => expect(store.put).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Dừng và huỷ cancel-save.mp4" }));
    pendingPut.resolve();

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      `/api/v1/projects/${PROJECT.id}/upload-cancel`,
      expect.objectContaining({ body: JSON.stringify({ artifactId }), method: "POST" }),
    );
    expect(store.delete).toHaveBeenCalledWith(PROJECT.id, artifactId);
    await waitFor(() => expect(screen.queryByText("cancel-save.mp4")).not.toBeInTheDocument());
    expect(uploaderFactory).not.toHaveBeenCalled();
  });

  it("remotely cancels a materialized artifact when capability persistence rejects", async () => {
    const artifactId = "20000000-0000-4000-8000-000000000013";
    const pendingPut = deferred<void>();
    const baseStore = memoryStore();
    const store: UploadSessionStore = {
      ...baseStore,
      put: vi.fn(() => pendingPut.promise),
      delete: vi.fn(baseStore.delete),
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(projectBody(PROJECT))
      .mockResolvedValueOnce(sessionBody(artifactId))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    const uploaderFactory = vi.fn<(dependencies: ResumableUploaderDependencies) => ResumableUploader>();
    render(
      <ProjectUpload
        fetcher={fetcher}
        health={HEALTHY}
        projects={[]}
        store={store}
        uploaderFactory={uploaderFactory}
      />,
    );
    const file = new File([new Uint8Array(100)], "cancel-rejected-save.mp4", {
      type: "video/mp4",
      lastModified: 1,
    });

    fireEvent.change(screen.getByLabelText("Thêm video"), { target: { files: [file] } });
    await waitFor(() => expect(store.put).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Dừng và huỷ cancel-rejected-save.mp4" }));
    pendingPut.reject(new Error("INDEXEDDB_PUT_FAILED"));

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      `/api/v1/projects/${PROJECT.id}/upload-cancel`,
      expect.objectContaining({ body: JSON.stringify({ artifactId }), method: "POST" }),
    );
    expect(store.delete).toHaveBeenCalledWith(PROJECT.id, artifactId);
    await waitFor(() => expect(screen.queryByText("cancel-rejected-save.mp4")).not.toBeInTheDocument());
    expect(uploaderFactory).not.toHaveBeenCalled();
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

  it("keeps a paused first upload ahead of a queued second upload until resume settles", async () => {
    const firstStart = deferred<void>();
    const firstResume = deferred<void>();
    let firstListener: ((snapshot: UploadSnapshot) => void) | null = null;
    let secondListener: ((snapshot: UploadSnapshot) => void) | null = null;
    const uploading: UploadSnapshot = {
      phase: "UPLOADING",
      committedBytes: 0,
      totalBytes: 100,
      bytesPerSecond: 25,
      publicCode: null,
    };
    const firstUploader: ResumableUploader = {
      start: vi.fn(async () => {
        firstListener?.(uploading);
        await firstStart.promise;
      }),
      resume: vi.fn(async (file) => {
        await firstResume.promise;
        firstListener?.({ ...uploading, phase: "READY", committedBytes: file.size, totalBytes: file.size });
      }),
      pause: vi.fn(() => {
        firstListener?.({ ...uploading, phase: "PAUSED" });
        firstStart.resolve();
      }),
      cancel: vi.fn(),
      subscribe: vi.fn((next) => { firstListener = next; return () => { firstListener = null; }; }),
      dispose: vi.fn(),
      snapshot: vi.fn(() => uploading),
    };
    const secondUploader: ResumableUploader = {
      start: vi.fn(async (file) => {
        secondListener?.({ ...uploading, phase: "READY", committedBytes: file.size, totalBytes: file.size });
      }),
      resume: vi.fn(),
      pause: vi.fn(),
      cancel: vi.fn(),
      subscribe: vi.fn((next) => { secondListener = next; return () => { secondListener = null; }; }),
      dispose: vi.fn(),
      snapshot: vi.fn(() => EMPTY_SNAPSHOT),
    };
    const uploaderFactory = vi.fn()
      .mockReturnValueOnce(firstUploader)
      .mockReturnValueOnce(secondUploader);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(projectBody(PROJECT))
      .mockResolvedValueOnce(sessionBody(PROJECT.id))
      .mockResolvedValueOnce(projectBody(SECOND_PROJECT))
      .mockResolvedValueOnce(sessionBody(SECOND_PROJECT.id));
    render(<ProjectUpload health={HEALTHY} projects={[]} fetcher={fetcher} store={memoryStore()} uploaderFactory={uploaderFactory} />);
    const first = new File([new Uint8Array(100)], "first.mp4", { type: "video/mp4", lastModified: 1 });
    const second = new File([new Uint8Array(80)], "second.mp4", { type: "video/mp4", lastModified: 2 });

    fireEvent.change(screen.getByLabelText("Thêm video"), { target: { files: [first, second] } });
    await waitFor(() => expect(firstUploader.start).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Tạm dừng first.mp4" }));
    await screen.findByRole("button", { name: "Tiếp tục first.mp4" });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });

    expect(secondUploader.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Tiếp tục first.mp4" }));
    await waitFor(() => expect(firstUploader.resume).toHaveBeenCalled());
    expect(secondUploader.start).not.toHaveBeenCalled();
    firstResume.resolve();

    await waitFor(() => expect(secondUploader.start).toHaveBeenCalledWith(second, expect.any(Object)));
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

  it("waits for persisted-session recovery before matching an immediately selected file", async () => {
    const persisted: StoredUploadSession = {
      projectId: PROJECT.id,
      artifactId: "20000000-0000-4000-8000-000000000011",
      sessionUri: "https://www.googleapis.com/upload/drive/v3/files/source?upload_id=recovery-gate",
      fileIdentity: {
        displayName: "instant.mp4",
        sizeBytes: 100,
        mimeType: "video/mp4",
        lastModified: 1,
      },
      nextOffset: 50,
      chunkBytes: 8_388_608,
      expiresAt: "2026-07-26T00:00:00.000Z",
    };
    const pendingList = deferred<readonly StoredUploadSession[]>();
    const baseStore = memoryStore([persisted]);
    const store: UploadSessionStore = { ...baseStore, list: vi.fn(() => pendingList.promise) };
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
    render(<ProjectUpload health={HEALTHY} projects={[PROJECT]} fetcher={fetcher} store={store} uploaderFactory={() => uploader} />);
    const file = new File([new Uint8Array(100)], "instant.mp4", { type: "video/mp4", lastModified: 1 });

    fireEvent.change(screen.getByLabelText("Thêm video"), { target: { files: [file] } });
    await act(async () => { await Promise.resolve(); });
    expect(fetcher).not.toHaveBeenCalled();
    expect(uploader.resume).not.toHaveBeenCalled();

    pendingList.resolve([persisted]);
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

  it("keeps a remotely cancelled item visible when local cleanup fails and retries cleanup", async () => {
    const artifactId = "20000000-0000-4000-8000-000000000012";
    const baseStore = memoryStore();
    const deleteCapability = vi.fn()
      .mockRejectedValueOnce(new Error("INDEXEDDB_DELETE_FAILED"))
      .mockResolvedValueOnce(undefined);
    const store: UploadSessionStore = { ...baseStore, delete: deleteCapability };
    const pendingStart = deferred<void>();
    let listener: ((snapshot: UploadSnapshot) => void) | null = null;
    const uploading: UploadSnapshot = {
      phase: "UPLOADING",
      committedBytes: 50,
      totalBytes: 100,
      bytesPerSecond: 25,
      publicCode: null,
    };
    const uploader: ResumableUploader = {
      start: vi.fn(async () => {
        listener?.(uploading);
        await pendingStart.promise;
      }),
      resume: vi.fn(),
      pause: vi.fn(),
      cancel: vi.fn(async () => {
        listener?.({ ...uploading, phase: "CANCELLED", bytesPerSecond: 0 });
        await store.delete(PROJECT.id, artifactId);
      }),
      subscribe: vi.fn((next) => { listener = next; return () => { listener = null; }; }),
      dispose: vi.fn(),
      snapshot: vi.fn(() => uploading),
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(projectBody(PROJECT))
      .mockResolvedValueOnce(sessionBody(artifactId));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ProjectUpload health={HEALTHY} projects={[]} fetcher={fetcher} store={store} uploaderFactory={() => uploader} />);
    const file = new File([new Uint8Array(100)], "cleanup.mp4", { type: "video/mp4", lastModified: 1 });

    fireEvent.change(screen.getByLabelText("Thêm video"), { target: { files: [file] } });
    expect(await screen.findByText("50%")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Dừng và huỷ cleanup.mp4" }));

    expect(await screen.findByText("Chưa thể dọn phiên tải cục bộ. Hãy bấm Dừng và huỷ để thử lại.")).toBeVisible();
    expect(screen.getByText("cleanup.mp4")).toBeVisible();
    pendingStart.resolve();
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("cleanup.mp4")).toBeVisible();
    expect(screen.getByText("Chưa thể dọn phiên tải cục bộ. Hãy bấm Dừng và huỷ để thử lại.")).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "Dừng và huỷ cleanup.mp4" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Dừng và huỷ cleanup.mp4" }));

    await waitFor(() => expect(screen.queryByText("cleanup.mp4")).not.toBeInTheDocument());
    expect(uploader.cancel).toHaveBeenCalledTimes(1);
    expect(deleteCapability).toHaveBeenCalledTimes(2);
    confirm.mockRestore();
  });

  it("retains queue ownership when upload settles before cancellation cleanup rejects", async () => {
    const artifactId = "20000000-0000-4000-8000-000000000014";
    const pendingStart = deferred<void>();
    const pendingDelete = deferred<void>();
    const baseStore = memoryStore();
    const deleteCapability = vi.fn()
      .mockReturnValueOnce(pendingDelete.promise)
      .mockResolvedValueOnce(undefined);
    const store: UploadSessionStore = { ...baseStore, delete: deleteCapability };
    const uploading: UploadSnapshot = {
      phase: "UPLOADING",
      committedBytes: 50,
      totalBytes: 100,
      bytesPerSecond: 25,
      publicCode: null,
    };
    let firstListener: ((snapshot: UploadSnapshot) => void) | null = null;
    let secondListener: ((snapshot: UploadSnapshot) => void) | null = null;
    const firstUploader: ResumableUploader = {
      start: vi.fn(async () => {
        firstListener?.(uploading);
        await pendingStart.promise;
      }),
      resume: vi.fn(),
      pause: vi.fn(),
      cancel: vi.fn(async () => {
        firstListener?.({ ...uploading, phase: "CANCELLED", bytesPerSecond: 0 });
        await store.delete(PROJECT.id, artifactId);
      }),
      subscribe: vi.fn((next) => { firstListener = next; return () => { firstListener = null; }; }),
      dispose: vi.fn(),
      snapshot: vi.fn(() => uploading),
    };
    const secondUploader: ResumableUploader = {
      start: vi.fn(async (file) => secondListener?.({
        phase: "READY",
        committedBytes: file.size,
        totalBytes: file.size,
        bytesPerSecond: 0,
        publicCode: null,
      })),
      resume: vi.fn(),
      pause: vi.fn(),
      cancel: vi.fn(),
      subscribe: vi.fn((next) => { secondListener = next; return () => { secondListener = null; }; }),
      dispose: vi.fn(),
      snapshot: vi.fn(() => EMPTY_SNAPSHOT),
    };
    const uploaderFactory = vi.fn()
      .mockReturnValueOnce(firstUploader)
      .mockReturnValueOnce(secondUploader);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(projectBody(PROJECT))
      .mockResolvedValueOnce(sessionBody(artifactId))
      .mockResolvedValueOnce(projectBody(SECOND_PROJECT))
      .mockResolvedValueOnce(sessionBody("20000000-0000-4000-8000-000000000015"));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ProjectUpload health={HEALTHY} projects={[]} fetcher={fetcher} store={store} uploaderFactory={uploaderFactory} />);
    const first = new File([new Uint8Array(100)], "cleanup-first.mp4", { type: "video/mp4", lastModified: 1 });
    const second = new File([new Uint8Array(80)], "cleanup-second.mp4", { type: "video/mp4", lastModified: 2 });

    fireEvent.change(screen.getByLabelText("Thêm video"), { target: { files: [first, second] } });
    expect(await screen.findByText("50%")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Dừng và huỷ cleanup-first.mp4" }));
    await waitFor(() => expect(deleteCapability).toHaveBeenCalledTimes(1));

    pendingStart.resolve();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    expect(screen.getByText("cleanup-first.mp4")).toBeVisible();
    expect(secondUploader.start).not.toHaveBeenCalled();

    pendingDelete.reject(new Error("INDEXEDDB_DELETE_FAILED"));
    expect(await screen.findByText("Chưa thể dọn phiên tải cục bộ. Hãy bấm Dừng và huỷ để thử lại.")).toBeVisible();
    expect(secondUploader.start).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Dừng và huỷ cleanup-first.mp4" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Dừng và huỷ cleanup-first.mp4" }));

    await waitFor(() => expect(screen.queryByText("cleanup-first.mp4")).not.toBeInTheDocument());
    await waitFor(() => expect(secondUploader.start).toHaveBeenCalledWith(second, expect.any(Object)));
    expect(firstUploader.cancel).toHaveBeenCalledTimes(1);
    expect(deleteCapability).toHaveBeenCalledTimes(2);
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
