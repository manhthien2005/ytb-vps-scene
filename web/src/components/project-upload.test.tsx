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
const FAILED_PROJECT: PublicProject = {
  ...PROJECT,
  name: "Video lỗi",
  sourceStatus: "UPLOAD_FAILED",
};
const HEALTHY: FreeTierHealthView = {
  mode: "READ_WRITE",
  reasons: [],
  driveConnection: "CONNECTED",
  drive: { usedBytes: 100, limitBytes: 1_000, appManagedBytes: 20, observedAt: "2026-07-19T00:00:00.000Z" },
  neon: { usedBytes: 10, limitBytes: 1_000, appManagedBytes: 0, observedAt: "2026-07-19T00:00:00.000Z" },
};

function memoryStore(initial: StoredUploadSession | null = null): UploadSessionStore {
  let value: StoredUploadSession | null = initial;
  return {
    get: async () => value,
    put: async (next) => { value = next; },
    delete: async () => { value = null; },
    list: async () => value === null ? [] : [value],
  };
}

describe("ProjectUpload", () => {
  it("disables new work when quota evidence is stale", () => {
    render(<ProjectUpload health={{ ...HEALTHY, mode: "READ_ONLY", reasons: ["DRIVE_QUOTA_STALE"] }} projects={[]} />);
    expect(screen.queryByRole("button", { name: "Tạo dự án" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tải video lên" })).toBeDisabled();
    expect(screen.getByText("Chưa xác minh được dung lượng Google Drive.")).toBeVisible();
  });

  it("creates the internal project automatically from the selected video", async () => {
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
      .mockResolvedValueOnce(new Response(JSON.stringify({ project: PROJECT }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        artifactId: PROJECT.id,
        sessionUri: "https://www.googleapis.com/upload/drive/v3/files/source?upload_id=synthetic-capability",
        chunkBytes: 8_388_608,
        expiresAt: "2026-07-26T00:00:00.000Z",
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const onProjectsChange = vi.fn();
    const uploaderFactory = vi.fn((_: ResumableUploaderDependencies) => uploader);
    render(<ProjectUpload health={HEALTHY} projects={[]} fetcher={fetcher} store={memoryStore()} uploaderFactory={uploaderFactory} onProjectsChange={onProjectsChange} />);
    const file = new File([new Uint8Array(100)], "Phim thử nghiệm.mp4", { type: "video/mp4", lastModified: 1 });

    expect(screen.queryByRole("button", { name: "Tạo dự án" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Video")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("File video"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Tải video lên" }));

    expect(await screen.findByText("50%")).toBeVisible();
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
    const dependencies = uploaderFactory.mock.calls[0]?.[0];
    expect(dependencies).toBeDefined();
    const consoleDiagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const diagnosticRegion = screen.getByRole("region", { name: "Video & tải lên" });
    act(() => dependencies?.onDiagnostic?.({ stage: "chunk-fetch", outcome: "rejected" }));
    const chunkCode = diagnosticRegion.getAttribute("data-upload-diagnostic");
    act(() => dependencies?.onDiagnostic?.({ stage: "query-fetch", outcome: "rejected" }));
    const queryFetchCode = diagnosticRegion.getAttribute("data-upload-diagnostic");
    act(() => dependencies?.onDiagnostic?.({ stage: "query-response", status: 308, rangeVisible: false }));
    const queryRangeCode = diagnosticRegion.getAttribute("data-upload-diagnostic");
    consoleDiagnostic.mockRestore();
    expect([chunkCode, queryFetchCode, queryRangeCode]).toEqual([
      "CHUNK_FETCH_REJECTED",
      "QUERY_FETCH_REJECTED",
      "QUERY_RANGE_HIDDEN",
    ]);
  });

  it("uploads through the coordinator and supports pause/resume controls", async () => {
    let listener: ((snapshot: UploadSnapshot) => void) | null = null;
    const snapshot: UploadSnapshot = { phase: "UPLOADING", committedBytes: 50, totalBytes: 100, bytesPerSecond: 25, publicCode: null };
    const uploader: ResumableUploader = {
      start: vi.fn(async () => { listener?.(snapshot); }),
      resume: vi.fn(async () => { listener?.(snapshot); }),
      pause: vi.fn(() => { listener?.({ ...snapshot, phase: "PAUSED" }); }),
      cancel: vi.fn(async () => { listener?.({ ...snapshot, phase: "CANCELLED" }); }),
      subscribe: vi.fn((next) => { listener = next; return () => { listener = null; }; }),
      dispose: vi.fn(),
      snapshot: vi.fn(() => snapshot),
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      artifactId: "20000000-0000-4000-8000-000000000002",
      sessionUri: "https://www.googleapis.com/upload/drive/v3/files/source?upload_id=synthetic-capability",
      chunkBytes: 8_388_608,
      expiresAt: "2026-07-26T00:00:00.000Z",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    render(<ProjectUpload health={HEALTHY} projects={[PROJECT]} fetcher={fetcher} store={memoryStore()} uploaderFactory={() => uploader} />);
    const file = new File([new Uint8Array(100)], "video.mp4", { type: "video/mp4", lastModified: 1 });

    fireEvent.change(screen.getByLabelText("Video"), { target: { value: PROJECT.id } });
    fireEvent.change(screen.getByLabelText("File video"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Tải video lên" }));
    expect(await screen.findByText("50%")).toBeVisible();
    expect(screen.getByRole("button", { name: "Tải video lên" })).toBeDisabled();
    expect(screen.getByLabelText("Video")).toBeDisabled();
    expect(screen.getByLabelText("File video")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Tạm dừng" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Tiếp tục" })).toBeEnabled());
  });

  it("retries a failed video without creating another internal project", async () => {
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
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      artifactId: FAILED_PROJECT.id,
      sessionUri: "https://www.googleapis.com/upload/drive/v3/files/source?upload_id=synthetic-capability",
      chunkBytes: 8_388_608,
      expiresAt: "2026-07-26T00:00:00.000Z",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    render(<ProjectUpload health={HEALTHY} projects={[FAILED_PROJECT]} fetcher={fetcher} store={memoryStore()} uploaderFactory={() => uploader} />);
    const file = new File([new Uint8Array(100)], "video.mp4", { type: "video/mp4", lastModified: 1 });

    fireEvent.change(screen.getByLabelText("Video"), { target: { value: FAILED_PROJECT.id } });
    fireEvent.change(screen.getByLabelText("File video"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Chọn lại file và thử lại" }));

    expect(await screen.findByText("50%")).toBeVisible();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      `/api/v1/projects/${FAILED_PROJECT.id}/upload-session`,
      expect.any(Object),
    );
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
    render(<ProjectUpload health={HEALTHY} projects={[PROJECT]} fetcher={fetcher} store={memoryStore(persisted)} uploaderFactory={() => uploader} />);
    const file = new File([new Uint8Array(100)], "video.mp4", { type: "video/mp4", lastModified: 1 });

    expect(await screen.findByText(/Có phiên tải dở/)).toBeVisible();
    fireEvent.change(screen.getByLabelText("Video"), { target: { value: PROJECT.id } });
    fireEvent.change(screen.getByLabelText("File video"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Tiếp tục tải dở" }));

    await waitFor(() => expect(uploader.resume).toHaveBeenCalledWith(file, persisted));
    expect(fetcher).not.toHaveBeenCalled();
  });
});

const EMPTY_SNAPSHOT: UploadSnapshot = {
  phase: "IDLE",
  committedBytes: 0,
  totalBytes: 0,
  bytesPerSecond: 0,
  publicCode: null,
};
