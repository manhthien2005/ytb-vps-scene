"use client";

import {
  createResumableUploader,
  type ResumableUploader,
  type ResumableUploaderDependencies,
} from "@/lib/browser/resumable-uploader";
import type { UploadSessionStore } from "@/lib/browser/upload-store";
import type { FreeTierHealthView, PublicProject } from "./dashboard-types";
import { UploadQueue } from "./upload-queue";
import {
  uploadMessageForCode,
  useUploadQueue,
} from "./use-upload-queue";
import { VideoDropzone } from "./video-dropzone";

export function ProjectUpload({
  health,
  projects,
  fetcher = globalThis.fetch,
  store,
  uploaderFactory = createResumableUploader,
  onProjectsChange = () => undefined,
  onSourceFile = () => undefined,
}: Readonly<{
  health: FreeTierHealthView;
  projects: readonly PublicProject[];
  fetcher?: typeof fetch;
  store?: UploadSessionStore;
  uploaderFactory?: (dependencies: ResumableUploaderDependencies) => ResumableUploader;
  onProjectsChange?: (projects: readonly PublicProject[]) => void;
  onSourceFile?: (projectId: string, file: File) => void;
}>) {
  const readOnlyReason = health.mode === "READ_ONLY"
    ? uploadMessageForCode(health.reasons[0] ?? "DRIVE_QUOTA_STALE")
    : health.driveConnection !== "CONNECTED" ? uploadMessageForCode("DRIVE_NOT_CONNECTED") : null;
  const workDisabled = readOnlyReason !== null;
  const queue = useUploadQueue({
    disabled: workDisabled,
    projects,
    fetcher,
    store,
    uploaderFactory,
    onProjectsChange,
    onSourceFile,
  });

  return (
    <section
      aria-labelledby="project-upload-title"
      className="workspace-card project-upload"
      data-upload-diagnostic={queue.diagnostic ?? undefined}
    >
      <div className="card-heading">
        <div><p className="eyebrow">Chuẩn bị video</p><h2 id="project-upload-title">Tải video lên Drive</h2></div>
        <span className={`mode-badge mode-${health.mode.toLowerCase()}`}>
          {health.mode === "READ_WRITE" ? "Sẵn sàng" : "Chỉ đọc"}
        </span>
      </div>

      {readOnlyReason !== null && <p className="warning-copy" id="work-disabled-reason">{readOnlyReason}</p>}
      <VideoDropzone disabled={workDisabled} onFiles={queue.enqueueFiles} />

      {queue.recoveries.length > 0 && (
        <p className="recovery-note">Có phiên tải dở. Hãy chọn lại đúng file để tiếp tục từ phần đã xác nhận.</p>
      )}

      <UploadQueue
        items={queue.items}
        onCancel={queue.cancel}
        onPause={queue.pause}
        onResume={queue.resume}
        onRetry={queue.retry}
      />
    </section>
  );
}
