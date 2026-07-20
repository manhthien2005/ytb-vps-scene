import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ResumableUploader, UploadSnapshot } from "@/lib/browser/resumable-uploader";
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
    expect(screen.getByRole("button", { name: "Tạo dự án" })).toBeDisabled();
    expect(screen.getByText("Chưa xác minh được dung lượng Google Drive.")).toBeVisible();
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

    fireEvent.change(screen.getByLabelText("Video nguồn"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Tải lên" }));
    expect(await screen.findByText("50%")).toBeVisible();
    expect(screen.getByRole("button", { name: "Tải lên" })).toBeDisabled();
    expect(screen.getByLabelText("Dự án")).toBeDisabled();
    expect(screen.getByLabelText("Video nguồn")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Tạm dừng" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Tiếp tục" })).toBeEnabled());
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
    fireEvent.change(screen.getByLabelText("Video nguồn"), { target: { files: [file] } });
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
