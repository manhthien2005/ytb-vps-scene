"use client";

import { useRef, useState, type DragEvent } from "react";
import { UploadIcon } from "./drive-icons";

const VIDEO_ACCEPT = ".mp4,.mov,.mkv,.webm,video/mp4,video/quicktime,video/x-matroska,video/webm";

export function VideoDropzone({
  disabled,
  onFiles,
}: Readonly<{
  disabled: boolean;
  onFiles: (files: readonly File[]) => void;
}>) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function submitFiles(files: FileList | readonly File[] | null): void {
    if (disabled || files === null || files.length === 0) return;
    onFiles(Array.from(files));
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>): void {
    event.preventDefault();
    setDragging(false);
    submitFiles(event.dataTransfer.files);
  }

  return (
    <div className={`video-dropzone${dragging ? " video-dropzone-dragging" : ""}`}>
      <button
        aria-label="Kéo thả hoặc chọn video"
        className="video-dropzone-target"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        onDragEnter={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
        type="button"
      >
        <UploadIcon aria-hidden size={20} />
        <span>Kéo thả hoặc chọn video</span>
      </button>
      <label hidden htmlFor="source-video">File video</label>
      <input
        ref={inputRef}
        accept={VIDEO_ACCEPT}
        aria-label="Thêm video"
        className="video-dropzone-input"
        disabled={disabled}
        hidden
        id="source-video"
        multiple
        onChange={(event) => {
          submitFiles(event.target.files);
          event.target.value = "";
        }}
        type="file"
      />
    </div>
  );
}
