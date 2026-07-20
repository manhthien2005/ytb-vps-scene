# Video-first upload and Google Drive recovery design

Date: 2026-07-20  
Status: Approved direction; awaiting written-spec confirmation

## Goal

Make the workflow match the operator's mental model: each uploaded video is one item to review and render. The database may keep the existing `project` aggregate internally, but the web UI must not require the operator to create or understand a project before uploading a video.

At the same time, fix the production failure that prevents Google Drive resumable upload sessions from being created and make a failed upload genuinely retryable.

## Confirmed failure

Production recorded `POST /api/v1/projects/:id/upload-session` returning HTTP 502 and changed the `Test1` source to `UPLOAD_FAILED`.

The Drive adapter initializes an empty-metadata resumable `PATCH` request with `body: ""`. The Fetch implementation turns that JavaScript string into a request with `Content-Type: text/plain;charset=UTF-8`. Google Drive documents that an initiation request without metadata must leave the body empty, and that `Content-Type: application/json` is required only when metadata is included. The adapter therefore sends a different request shape from the documented empty-body request.

There is also a recovery defect: after provider rejection the source artifact becomes `INVALID`, but `createSession` only permits automatic replacement for `DELETED`. A retry can therefore return `UPLOAD_REMOTE_MISMATCH` even when the operator selects the same video.

## User experience

### Upload area

- Rename the visible concept from **Dự án** to **Video**.
- Remove the separate project-name field, project creation button, and technical project selector from the primary flow.
- The operator selects a local video and presses **Tải video lên**.
- The display name and Drive output-folder name default to the filename without its extension. Vietnamese characters remain supported.
- The web app creates the internal project record automatically, then immediately requests and starts the resumable Drive upload.
- Existing database projects remain compatible and appear as video items; no destructive migration is required.
- A failed video shows a clear **Chọn lại file và thử lại** action. The operator must reselect the same local file because browsers cannot retain file access after a reload.

### Internal model

One internal project continues to own exactly one source video, its blur/TTS settings, render jobs, and output artifacts. This preserves the current security and concurrency invariants while hiding an implementation detail from the operator.

Multi-video film grouping is intentionally deferred. If needed later, a separate optional film group can contain multiple video items without changing the one-video aggregate.

### Output layout

The existing output contract remains:

```text
YTB-VPS/
  input/
  output/
    <video-name>/
      part-01-of-01.mp4
```

Future split renders may write `part-01-of-04.mp4` through `part-04-of-04.mp4` in the same folder.

## Drive upload correction

- Initiate the resumable `PATCH` without a request body and without an automatically generated text content type.
- Keep `Content-Length: 0`, `X-Upload-Content-Length`, and `X-Upload-Content-Type` as documented.
- Continue validating the returned session URI before exposing it to the browser.
- Treat both `INVALID` and `DELETED` source artifacts as replaceable when reserving the same internal source identity.
- Reuse the deterministic empty Drive source file when its parent, MIME type, application properties, and zero-byte state match; otherwise fail closed.
- Log only a safe diagnostic stage and Google HTTP status class on session-init rejection. Never log OAuth tokens, resumable session URIs, file IDs, passwords, or file names.

## Error handling

- `401`: ask the operator to reconnect Google Drive.
- `429` and `5xx`: preserve retry state and report that Drive is temporarily unavailable.
- Other provider `4xx`: mark the current attempt invalid, preserve the video item, and allow a clean retry.
- Local/network interruption during chunk upload: keep the existing IndexedDB recovery record and resume from Drive's acknowledged byte range.
- Identity mismatch: do not overwrite a different remote file; ask the operator to select the correct local video.

## Test strategy

1. Adapter test proves the Drive initialization request has no body and no `Content-Type` header while retaining the three upload-length/type headers.
2. Application test starts with an `INVALID` source and proves a new reservation/session can be created safely.
3. Component tests prove selecting a video automatically creates the internal record and starts upload without a manual project step.
4. Recovery tests prove an existing failed video can be retried with the same file and rejects a different file.
5. Existing upload, Drive, worker, scene-settings, and output naming suites must remain green.
6. Production verification must include a real small-video upload to Drive before claiming the issue fixed end to end.

## Out of scope

- Multiple source videos inside one internal project.
- Moving-logo tracking or moving blur regions.
- Rendering video bytes on Vercel.
- Changing the VPS worker pipeline or TTS provider.
