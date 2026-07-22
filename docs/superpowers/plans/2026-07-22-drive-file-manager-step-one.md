# Drive File Manager Step One Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the old Drive/upload cards in step 1 with the approved two-column Drive file manager, real video metadata/actions, and a compact controllable upload queue while removing superseded code.

**Architecture:** A server-only `DriveWorkspaceService` joins managed artifact records from Neon with bounded Google Drive metadata, then exposes a sanitized same-origin tree API and an idempotent delete API. The client is split into focused file-tree, file-row, dropzone, upload-queue, and workspace components; the existing resumable upload engine remains the byte-transfer boundary and browser uploads continue going directly to Drive.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 5.8, Zod 4, Vitest, Testing Library, Neon/PostgreSQL, Google Drive API v3, existing resumable upload and IndexedDB recovery modules.

## Global Constraints

- Do not proxy video or thumbnail bytes through Vercel.
- Do not add an icon dependency; use a small local SVG icon module with `currentColor`.
- Closed video rows show only icon, file name, and human-readable MB/GB size.
- Folder and video identity must differ by icon shape, semantics, and tree position, not color alone.
- Preview stays disabled until Drive returns width, height, duration, and a safe `webViewLink`.
- Delete only individual managed video artifacts; never delete a folder or an unmanaged Drive item.
- Queue controls must include pause, resume, permanent cancel, and retry with accessible names/tooltips.
- Preserve the existing direct-to-Drive resumable upload, recovery, sequential pumping, project creation, and Review-unlock behavior.
- Remove obsolete components, tests, and CSS after replacements are verified; do not leave dead compatibility wrappers.

---

## File Structure

### Create

- `web/src/lib/application/drive-workspace.ts` — join repository artifacts with Drive metadata and implement idempotent deletion.
- `web/src/lib/application/drive-workspace.test.ts` — application behavior and processing-state tests.
- `web/src/app/api/v1/drive/files/route.ts` — authenticated sanitized tree endpoint.
- `web/src/app/api/v1/drive/files/route.test.ts` — GET route/security tests.
- `web/src/app/api/v1/drive/files/[artifactId]/route.ts` — authenticated delete endpoint.
- `web/src/app/api/v1/drive/files/[artifactId]/route.test.ts` — delete route/security tests.
- `web/src/components/drive-icons.tsx` — local folder, file-video, Drive, upload, pause, play, download, trash, and chevron SVG icons.
- `web/src/components/drive-file-row.tsx` — compact closed/expanded file row and file actions.
- `web/src/components/drive-file-row.test.tsx` — row semantics, metadata, processing, preview, download, and delete tests.
- `web/src/components/drive-file-tree.tsx` — Input/Output folder tree, folder expansion, empty/error states.
- `web/src/components/drive-file-tree.test.tsx` — folder/file distinction and keyboard expansion tests.
- `web/src/components/video-dropzone.tsx` — button picker plus drag/drop boundary.
- `web/src/components/video-dropzone.test.tsx` — picker/drop behavior tests.
- `web/src/components/use-upload-queue.ts` — existing queue orchestration extracted from `ProjectUpload`.
- `web/src/components/upload-queue.tsx` — approved full-width compact queue presentation.
- `web/src/components/upload-queue.test.tsx` — units, percent, ETA, and controls tests.
- `web/src/components/drive-workspace.tsx` — Drive header, metadata refresh/polling, two trees, dropzone, and upload queue composition.
- `web/src/components/drive-workspace.test.tsx` — end-to-end component behavior for step 1.

### Modify

- `web/src/lib/domain/drive.ts` — add public workspace tree/readiness types.
- `web/src/lib/ports/drive.ts` — add bounded Drive metadata inspection contract.
- `web/src/lib/adapters/google/drive-files.ts` — request/parse media metadata and safe browser links.
- `web/src/lib/adapters/google/drive-files.test.ts` — adapter parsing and URL rejection cases.
- `web/src/lib/repositories/drive-control-plane.ts` — add managed artifact listing/deletion contracts.
- `web/src/lib/repositories/neon-drive-control-plane.ts` — implement artifact listing and generic safe deletion lifecycle.
- `web/src/lib/repositories/neon-drive-control-plane.test.ts` — SQL lifecycle coverage for source/output deletion.
- `web/src/test/fakes/fake-drive-control-plane.ts` — implement new repository methods.
- `web/src/test/fakes/fake-google-drive.ts` — implement metadata inspection.
- `web/src/components/dashboard-types.ts` — add workspace response view types or re-export domain types.
- `web/src/components/dashboard-shell.tsx` — replace old cards with `DriveWorkspace`.
- `web/src/components/dashboard-shell.test.tsx` — update step-1 expectations while preserving Review unlock.
- `web/src/app/globals.css` — add approved file-manager styles and responsive rules, remove obsolete selectors.
- `web/src/app/page.test.tsx` — assert sanitized server output without old copy.

### Delete after replacement passes

- `web/src/components/drive-card.tsx`
- `web/src/components/drive-card.test.tsx`
- `web/src/components/project-upload.tsx`
- `web/src/components/project-upload.test.tsx`

---

### Task 1: Managed Artifact Read/Delete Repository Contract

**Files:**
- Modify: `web/src/lib/repositories/drive-control-plane.ts`
- Modify: `web/src/lib/repositories/neon-drive-control-plane.ts`
- Modify: `web/src/lib/repositories/neon-drive-control-plane.test.ts`
- Modify: `web/src/test/fakes/fake-drive-control-plane.ts`

**Interfaces:**
- Produces: `ManagedArtifactRecord`, `listManagedArtifacts()`, `claimManagedArtifactDeletion()`, and `markManagedArtifactDeleted()`.
- Consumes: existing `Artifact`, `Project`, artifact status constraints, and source-project state transitions.

- [ ] **Step 1: Write failing repository tests for listing and source/output deletion**

Add focused tests that seed one ready source, one ready output, one deleted artifact, and assert only live video records return:

```ts
it("lists live source and output videos with project and verification metadata", async () => {
  const records = await repository.listManagedArtifacts();
  expect(records.map((record) => ({
    id: record.artifact.id,
    kind: record.artifact.kind,
    projectName: record.projectName,
    verifiedAt: record.verifiedAt,
  }))).toEqual([
    { id: SOURCE_ID, kind: "SOURCE", projectName: "Phim A", verifiedAt: NOW.toISOString() },
    { id: OUTPUT_ID, kind: "OUTPUT", projectName: "Phim A", verifiedAt: NOW.toISOString() },
  ]);
});

it("deletes a ready source and resets only its project source state", async () => {
  await expect(repository.claimManagedArtifactDeletion(SOURCE_ID)).resolves.toBe("CLAIMED");
  await expect(repository.markManagedArtifactDeleted(SOURCE_ID)).resolves.toBe("CHANGED");
  expect((await repository.getProject(PROJECT_ID))?.sourceStatus).toBe("NO_SOURCE");
});

it("deletes a ready output without changing project source state", async () => {
  await expect(repository.claimManagedArtifactDeletion(OUTPUT_ID)).resolves.toBe("CLAIMED");
  await expect(repository.markManagedArtifactDeleted(OUTPUT_ID)).resolves.toBe("CHANGED");
  expect((await repository.getProject(PROJECT_ID))?.sourceStatus).toBe("SOURCE_READY");
});
```

- [ ] **Step 2: Run repository tests and verify the contract is missing**

Run: `npm test -- --run src/lib/repositories/neon-drive-control-plane.test.ts`

Expected: FAIL because the three new repository methods do not exist.

- [ ] **Step 3: Add exact repository types and methods**

Add to `drive-control-plane.ts`:

```ts
export type ManagedArtifactRecord = Readonly<{
  artifact: Artifact;
  projectName: string;
  jobId: string | null;
  verifiedAt: string | null;
}>;

export type ManagedDeletionClaim = "CLAIMED" | "RECONCILE" | "DELETED" | "CONFLICT";

// DriveControlPlaneRepository additions
listManagedArtifacts(): Promise<readonly ManagedArtifactRecord[]>;
claimManagedArtifactDeletion(artifactId: string): Promise<ManagedDeletionClaim>;
markManagedArtifactDeleted(artifactId: string): Promise<"CHANGED" | "REPLAY">;
```

Implement `listManagedArtifacts()` with a join on `projects`, filtering `kind in ('SOURCE','OUTPUT')` and `status <> 'DELETED'`, ordered by project creation/name and artifact creation. Parse `verified_at` and nullable `job_id` strictly.

Implement claim as an atomic `READY|INVALID -> DELETING`, returning `RECONCILE` for an already-deleting item, `DELETED` for replay, and `CONFLICT` for unknown/folder/checkpoint/non-terminal upload state. Implement completion in one CTE: mark artifact `DELETED`, reset `projects.source_status='NO_SOURCE'` only when the changed artifact is `SOURCE`, release any upload reservation, and insert `DRIVE_FILE_DELETED` audit metadata without Drive IDs.

- [ ] **Step 4: Update the fake repository with stateful equivalents**

The fake must filter `SOURCE|OUTPUT`, preserve project names/verified times, and model the same four claim outcomes so application tests cannot bypass lifecycle behavior.

- [ ] **Step 5: Run repository and fake tests**

Run: `npm test -- --run src/lib/repositories/neon-drive-control-plane.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the repository slice**

```bash
git add web/src/lib/repositories/drive-control-plane.ts web/src/lib/repositories/neon-drive-control-plane.ts web/src/lib/repositories/neon-drive-control-plane.test.ts web/src/test/fakes/fake-drive-control-plane.ts
git commit -m "feat: add managed Drive artifact lifecycle"
```

---

### Task 2: Google Drive Video Metadata Boundary

**Files:**
- Modify: `web/src/lib/domain/drive.ts`
- Modify: `web/src/lib/ports/drive.ts`
- Modify: `web/src/lib/adapters/google/drive-files.ts`
- Modify: `web/src/lib/adapters/google/drive-files.test.ts`
- Modify: `web/src/test/fakes/fake-google-drive.ts`

**Interfaces:**
- Produces: `DriveVideoMetadata` and `DriveFilesPort.inspectVideoMetadata(accessToken, fileId)`.
- Consumes: existing authenticated `driveJson`, bounded Drive IDs, and application-owned `appProperties`.

- [ ] **Step 1: Add failing adapter tests for ready and processing files**

```ts
it("returns bounded video metadata and safe Drive browser links", async () => {
  fetcher.mockResolvedValueOnce(jsonResponse({
    id: "drive-video-001", name: "source.mp4", mimeType: "video/mp4", size: "864026624",
    parents: ["drive-parent-001"], trashed: false,
    appProperties: { schema: "1", ytbVpsRole: "source", ytbVpsArtifactId: ARTIFACT_ID },
    createdTime: "2026-07-22T07:30:00.000Z", modifiedTime: "2026-07-22T07:35:00.000Z",
    videoMediaMetadata: { width: 1920, height: 1080, durationMillis: "5076000" },
    webViewLink: "https://drive.google.com/file/d/drive-video-001/view",
    webContentLink: "https://drive.usercontent.google.com/download?id=drive-video-001",
  }));
  await expect(adapter.inspectVideoMetadata(TOKEN, "drive-video-001")).resolves.toMatchObject({
    sizeBytes: 864026624, width: 1920, height: 1080, durationMillis: 5076000,
  });
});

it("returns null media fields while Drive is processing", async () => {
  fetcher.mockResolvedValueOnce(jsonResponse({ ...BASE_FILE, videoMediaMetadata: undefined }));
  await expect(adapter.inspectVideoMetadata(TOKEN, "drive-video-001")).resolves.toMatchObject({
    width: null, height: null, durationMillis: null, webViewLink: null,
  });
});

it("rejects browser links outside the Google Drive allowlist", async () => {
  fetcher.mockResolvedValueOnce(jsonResponse({ ...READY_FILE, webViewLink: "https://evil.test/file" }));
  await expect(adapter.inspectVideoMetadata(TOKEN, "drive-video-001"))
    .rejects.toMatchObject({ code: "DRIVE_REMOTE_MISMATCH" });
});
```

- [ ] **Step 2: Run the adapter tests and verify failure**

Run: `npm test -- --run src/lib/adapters/google/drive-files.test.ts`

Expected: FAIL because `inspectVideoMetadata` and its fields are absent.

- [ ] **Step 3: Define the metadata type and port method**

```ts
export type DriveVideoMetadata = Readonly<{
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  parentIds: readonly string[];
  createdTime: string;
  modifiedTime: string;
  width: number | null;
  height: number | null;
  durationMillis: number | null;
  webViewLink: string | null;
  webContentLink: string | null;
  appProperties: Readonly<Record<string, string>>;
}>;

// DriveFilesPort addition
inspectVideoMetadata(accessToken: string, fileId: string): Promise<DriveVideoMetadata>;
```

Extend the Drive fields request with `createdTime,modifiedTime,videoMediaMetadata(width,height,durationMillis),webViewLink,webContentLink`. Convert Drive int64 strings to safe integers, bound dimensions to positive integers, accept missing media metadata as processing, require HTTPS, and allow browser links only on `drive.google.com` and `drive.usercontent.google.com` without embedded credentials or fragments.

- [ ] **Step 4: Add a configurable metadata map to `FakeGoogleDriveFiles`**

The fake should return processing metadata by default and allow tests to seed ready metadata per file ID.

- [ ] **Step 5: Run adapter and dependent application tests**

Run: `npm test -- --run src/lib/adapters/google/drive-files.test.ts src/lib/application/uploads.test.ts src/lib/application/projects.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the metadata boundary**

```bash
git add web/src/lib/domain/drive.ts web/src/lib/ports/drive.ts web/src/lib/adapters/google/drive-files.ts web/src/lib/adapters/google/drive-files.test.ts web/src/test/fakes/fake-google-drive.ts
git commit -m "feat: inspect managed Drive video metadata"
```

---

### Task 3: Workspace Application Service and Authenticated APIs

**Files:**
- Create: `web/src/lib/application/drive-workspace.ts`
- Create: `web/src/lib/application/drive-workspace.test.ts`
- Create: `web/src/app/api/v1/drive/files/route.ts`
- Create: `web/src/app/api/v1/drive/files/route.test.ts`
- Create: `web/src/app/api/v1/drive/files/[artifactId]/route.ts`
- Create: `web/src/app/api/v1/drive/files/[artifactId]/route.test.ts`
- Modify: `web/src/lib/domain/errors.ts`

**Interfaces:**
- Consumes: Tasks 1–2 contracts plus `DriveAccessProvider`.
- Produces: `DriveWorkspaceView`, `createDriveWorkspaceService()`, `GET /api/v1/drive/files`, and `DELETE /api/v1/drive/files/:artifactId`.

- [ ] **Step 1: Write failing service tests for tree grouping/readiness/security matching**

```ts
it("groups sources under Input and outputs under project folders", async () => {
  const view = await service.list();
  expect(view.input.map((file) => file.name)).toEqual(["source.mp4"]);
  expect(view.output).toEqual([{ name: "Phim A", files: [expect.objectContaining({ name: "part-01-of-04.mp4" })] }]);
});

it.each([
  [{ width: null, height: null, durationMillis: null, webViewLink: null }, "PROCESSING"],
  [{ width: 1920, height: 1080, durationMillis: 1000, webViewLink: VIEW_URL }, "READY"],
])("classifies Drive readiness", async (metadata, readiness) => {
  files.setMetadata(FILE_ID, { ...BASE_METADATA, ...metadata });
  expect((await service.list()).input[0]?.readiness).toBe(readiness);
});

it("rejects a remote file whose artifact property does not match Neon", async () => {
  files.setMetadata(FILE_ID, { ...READY_METADATA, appProperties: { ytbVpsArtifactId: OTHER_ID } });
  expect((await service.list()).input).toEqual([]);
});
```

Add deletion tests for successful source/output deletion, remote 404 replay, claim conflict, and repository completion retry.

- [ ] **Step 2: Run service tests and verify failure**

Run: `npm test -- --run src/lib/application/drive-workspace.test.ts`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement sanitized view models and service**

```ts
export type DriveWorkspaceFile = Readonly<{
  artifactId: string;
  name: string;
  sizeBytes: number;
  uploadedAt: string;
  durationMillis: number | null;
  width: number | null;
  height: number | null;
  readiness: "PROCESSING" | "READY" | "UNKNOWN";
  viewUrl: string | null;
  downloadUrl: string | null;
}>;

export type DriveWorkspaceView = Readonly<{
  input: readonly DriveWorkspaceFile[];
  output: readonly Readonly<{ projectId: string; name: string; files: readonly DriveWorkspaceFile[] }>[];
  processingCount: number;
}>;
```

`list()` obtains one access token, lists managed records, inspects each Drive file with a small concurrency cap of four, verifies `ytbVpsArtifactId`, `ytbVpsProjectId`, `ytbVpsRole`, file name, MIME type, and size against Neon, and omits mismatches while recording only a stable diagnostic code. Use `verifiedAt ?? modifiedTime` for `uploadedAt`.

`delete(artifactId)` claims the managed artifact, rejects `CONFLICT`, deletes the exact Drive file, treats provider 404 as already absent, then calls `markManagedArtifactDeleted`. A `RECONCILE` claim repeats the remote delete safely.

- [ ] **Step 4: Add authenticated GET and DELETE route tests**

Verify `AUTH_REQUIRED`, mutation-origin rejection, invalid UUID rejection, stable public error codes, `cache-control: no-store`, exact sanitized JSON keys, and absence of Drive IDs/app properties/access tokens.

- [ ] **Step 5: Implement route composition**

Use the same `parseServerEnv`, repository, OAuth, cipher, access-provider, and Drive adapter construction pattern as existing Drive routes. GET requires admin. DELETE requires admin plus `requireMutationOrigin` and a UUID path parameter. Add a stable `DRIVE_FILE_DELETE_CONFLICT` public error code with HTTP 409.

- [ ] **Step 6: Run service and route tests**

Run: `npm test -- --run src/lib/application/drive-workspace.test.ts src/app/api/v1/drive/files/route.test.ts src/app/api/v1/drive/files/\[artifactId\]/route.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the API slice**

```bash
git add web/src/lib/application/drive-workspace.ts web/src/lib/application/drive-workspace.test.ts web/src/app/api/v1/drive/files web/src/lib/domain/errors.ts
git commit -m "feat: expose Drive workspace file APIs"
```

---

### Task 4: File Icons, Rows, and Trees

**Files:**
- Create: `web/src/components/drive-icons.tsx`
- Create: `web/src/components/drive-file-row.tsx`
- Create: `web/src/components/drive-file-row.test.tsx`
- Create: `web/src/components/drive-file-tree.tsx`
- Create: `web/src/components/drive-file-tree.test.tsx`
- Modify: `web/src/components/dashboard-types.ts`

**Interfaces:**
- Consumes: `DriveWorkspaceFile` and `DriveWorkspaceView` from Task 3.
- Produces: `DriveFileRow` and `DriveFileTree` with `onDelete(artifactId)` and sanitized external navigation.

- [ ] **Step 1: Write failing row tests for the approved option-B layout**

```tsx
it("keeps a closed video row minimal", () => {
  render(<DriveFileRow file={READY_FILE} onDelete={vi.fn()} />);
  expect(screen.getByText("abcd.mp4")).toBeVisible();
  expect(screen.getByText("824 MB")).toBeVisible();
  expect(screen.queryByText("01:24:36")).not.toBeInTheDocument();
});

it("expands to three icon stats and enables preview only when ready", () => {
  render(<DriveFileRow file={READY_FILE} onDelete={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Mở thông tin abcd.mp4" }));
  expect(screen.getByText("01:24:36")).toBeVisible();
  expect(screen.getByText("1920 × 1080")).toBeVisible();
  expect(screen.getByRole("link", { name: "Xem trước abcd.mp4" })).toHaveAttribute("target", "_blank");
});

it("disables preview while Drive is processing", () => {
  render(<DriveFileRow file={PROCESSING_FILE} onDelete={vi.fn()} defaultExpanded />);
  expect(screen.getByRole("button", { name: "Xem trước abcd.mp4" })).toBeDisabled();
  expect(screen.getByText("Drive đang xử lý")).toBeVisible();
});
```

Add confirmation/success/failure tests for delete and keyboard Enter/Space expansion.

- [ ] **Step 2: Write failing tree tests for unmistakable folder/file semantics**

Assert folder controls have `aria-expanded`, folder icon test IDs/labels differ from video icons, Output folders contain child video rows, and empty/error states stay inside their own column.

- [ ] **Step 3: Run component tests and verify failure**

Run: `npm test -- --run src/components/drive-file-row.test.tsx src/components/drive-file-tree.test.tsx`

Expected: FAIL because the components do not exist.

- [ ] **Step 4: Implement the local SVG icon module**

Each icon accepts `{ size?: number; className?: string; "aria-hidden"?: boolean }`, uses a `24×24` viewBox, `currentColor`, and no embedded text. Include `DriveLogo` as the three-color exception. Interactive buttons provide their own visible tooltip/title and `aria-label`.

- [ ] **Step 5: Implement formatting and row behavior**

Use `Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 })` for MB/GB, `HH:MM:SS` for duration, and `Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short" })` for upload time. Closed markup must not render metadata nodes. Expanded option B renders three compact stats, text readiness, preview/download/trash actions, and an inline delete error.

- [ ] **Step 6: Implement the Input/Output trees**

Use semantic lists and buttons. Input renders direct files plus the dropzone slot. Output renders project folder buttons with `FolderIcon`, nested `DriveFileRow` children with `FileVideoIcon`, and independent expansion state keyed by project/file ID.

- [ ] **Step 7: Run row/tree tests**

Run: `npm test -- --run src/components/drive-file-row.test.tsx src/components/drive-file-tree.test.tsx`

Expected: PASS.

- [ ] **Step 8: Commit the file-browser components**

```bash
git add web/src/components/drive-icons.tsx web/src/components/drive-file-row.tsx web/src/components/drive-file-row.test.tsx web/src/components/drive-file-tree.tsx web/src/components/drive-file-tree.test.tsx web/src/components/dashboard-types.ts
git commit -m "feat: add compact Drive file trees"
```

---

### Task 5: Extract and Redesign the Upload Queue

**Files:**
- Create: `web/src/components/use-upload-queue.ts`
- Create: `web/src/components/video-dropzone.tsx`
- Create: `web/src/components/video-dropzone.test.tsx`
- Create: `web/src/components/upload-queue.tsx`
- Create: `web/src/components/upload-queue.test.tsx`
- Modify temporarily: `web/src/components/project-upload.tsx`
- Modify temporarily: `web/src/components/project-upload.test.tsx`

**Interfaces:**
- Consumes: existing `createResumableUploader`, upload session store, project/upload APIs, and upload filename validation.
- Produces: `useUploadQueue`, `VideoDropzone`, and `UploadQueue`; preserves callbacks `onProjectsChange` and `onSourceFile`.

- [ ] **Step 1: Write failing dropzone and queue presentation tests**

```tsx
it("passes picker and dropped videos through the same enqueue callback", () => {
  const enqueue = vi.fn();
  render(<VideoDropzone disabled={false} onFiles={enqueue} />);
  fireEvent.change(screen.getByLabelText("Thêm video"), { target: { files: [FILE] } });
  fireEvent.drop(screen.getByRole("button", { name: "Kéo thả hoặc chọn video" }), {
    dataTransfer: { files: [FILE] },
  });
  expect(enqueue).toHaveBeenCalledTimes(2);
});

it("shows MB progress, percent, ETA, pause and permanent cancel", () => {
  render(<UploadQueue items={[ACTIVE_ITEM]} onPause={pause} onResume={resume} onCancel={cancel} onRetry={retry} />);
  expect(screen.getByText("434 MB / 638 MB")).toBeVisible();
  expect(screen.getByText("68%")).toBeVisible();
  expect(screen.getByRole("button", { name: "Tạm dừng bangkok.mp4" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Dừng và huỷ bangkok.mp4" })).toBeEnabled();
});
```

Add paused/resume, failed/retry, queued/cancel, confirmation, and no-raw-byte assertions.

- [ ] **Step 2: Run new component tests and verify failure**

Run: `npm test -- --run src/components/video-dropzone.test.tsx src/components/upload-queue.test.tsx`

Expected: FAIL because the new components do not exist.

- [ ] **Step 3: Extract queue orchestration without changing behavior**

Move the non-rendering logic from `ProjectUpload` into `useUploadQueue`:

```ts
export type UploadQueueController = Readonly<{
  items: readonly UploadQueueItem[];
  recoveries: readonly StoredUploadSession[];
  diagnostic: string | null;
  enqueueFiles(files: FileList | readonly File[]): void;
  pause(id: string): void;
  resume(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
  retry(id: string): Promise<void>;
}>;
```

Keep sequential pumping, exact file recovery identity, automatic project creation, XHR uploader factory, uploader disposal, and callbacks unchanged. Permanent cancel calls the existing upload-cancel API when an artifact exists and removes the visible queue item only after success.

- [ ] **Step 4: Keep old behavior green through the extraction**

Temporarily adapt `ProjectUpload` to render the new dropzone/queue around the extracted controller. Run its existing tests before deleting it later.

Run: `npm test -- --run src/components/project-upload.test.tsx`

Expected: PASS with no changed upload API calls or sequencing.

- [ ] **Step 5: Implement compact presentation and ETA rules**

ETA appears only when `bytesPerSecond > 0`, remaining bytes are positive, and the calculated value is finite. Use MB/GB display throughout. Every icon-only control has `title` and `aria-label`; pause and cancel are separate actions.

- [ ] **Step 6: Run new and legacy upload tests**

Run: `npm test -- --run src/components/video-dropzone.test.tsx src/components/upload-queue.test.tsx src/components/project-upload.test.tsx src/lib/browser/resumable-uploader.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the extraction and new presentation**

```bash
git add web/src/components/use-upload-queue.ts web/src/components/video-dropzone.tsx web/src/components/video-dropzone.test.tsx web/src/components/upload-queue.tsx web/src/components/upload-queue.test.tsx web/src/components/project-upload.tsx web/src/components/project-upload.test.tsx
git commit -m "refactor: extract controllable upload queue"
```

---

### Task 6: Compose the New Drive Workspace and Replace Step 1

**Files:**
- Create: `web/src/components/drive-workspace.tsx`
- Create: `web/src/components/drive-workspace.test.tsx`
- Modify: `web/src/components/dashboard-shell.tsx`
- Modify: `web/src/components/dashboard-shell.test.tsx`
- Modify: `web/src/app/page.test.tsx`

**Interfaces:**
- Consumes: Tasks 3–5 components/APIs and existing Drive connect/disconnect behavior.
- Produces: the complete approved step-1 workspace and refreshes the tree after upload/delete.

- [ ] **Step 1: Write failing workspace tests**

Cover:

```tsx
it("renders Drive header, Input and Output trees, and the queue below both columns", async () => {
  render(<DriveWorkspace drive={CONNECTED} health={HEALTHY} projects={[]} />);
  expect(await screen.findByRole("heading", { name: "Drive" })).toBeVisible();
  expect(screen.getByRole("region", { name: "Input" })).toBeVisible();
  expect(screen.getByRole("region", { name: "Output" })).toBeVisible();
  expect(screen.getByRole("region", { name: "Hàng đợi tải lên" }))
    .toHaveClass("drive-upload-queue");
});

it("refreshes processing files with bounded polling only while visible", async () => {
  vi.useFakeTimers();
  render(<DriveWorkspace drive={CONNECTED} health={HEALTHY} projects={[]} fetcher={fetcher} />);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(fetcher).toHaveBeenCalledWith("/api/v1/drive/files", expect.anything());
});
```

Also test connect error, disconnected disabled state, delete refresh, upload-complete refresh, no polling at zero processing files, and document-hidden polling pause.

- [ ] **Step 2: Run workspace tests and verify failure**

Run: `npm test -- --run src/components/drive-workspace.test.tsx`

Expected: FAIL because `DriveWorkspace` does not exist.

- [ ] **Step 3: Implement workspace orchestration**

Move connect/disconnect request logic out of `DriveCard`. Fetch the tree with same-origin credentials and `cache: "no-store"`. Poll processing items at 5s, then 10s, then 20s (cap), stop when none remain, and reset after upload/delete/manual retry. Do not poll while `document.visibilityState !== "visible"`.

Render order must be:

```tsx
<section className="drive-workspace">
  <DriveWorkspaceHeader />
  <div className="drive-browser-grid">
    <DriveFileTree kind="input" dropzone={<VideoDropzone />} />
    <DriveFileTree kind="output" />
  </div>
  <UploadQueue />
</section>
```

- [ ] **Step 4: Replace old cards in `DashboardShell`**

Replace the `.workspace-grid` containing `DriveCard` and `ProjectUpload` with one `DriveWorkspace`, passing `videoItems`, `setVideoItems`, and `handleSourceFile` so Review still unlocks immediately after source completion.

- [ ] **Step 5: Update dashboard/page tests**

Remove assertions for “Kho video riêng tư”, quota copy, and the native legacy file input label. Assert the new headings, folder/video semantics, new dropzone label, and preserved four-step readiness behavior.

- [ ] **Step 6: Run workspace and dashboard tests**

Run: `npm test -- --run src/components/drive-workspace.test.tsx src/components/dashboard-shell.test.tsx src/app/page.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit the integrated workspace**

```bash
git add web/src/components/drive-workspace.tsx web/src/components/drive-workspace.test.tsx web/src/components/dashboard-shell.tsx web/src/components/dashboard-shell.test.tsx web/src/app/page.test.tsx
git commit -m "feat: replace step one with Drive file manager"
```

---

### Task 7: Apply Approved Styling and Delete Superseded Code

**Files:**
- Modify: `web/src/app/globals.css`
- Delete: `web/src/components/drive-card.tsx`
- Delete: `web/src/components/drive-card.test.tsx`
- Delete: `web/src/components/project-upload.tsx`
- Delete: `web/src/components/project-upload.test.tsx`
- Verify: all files under `web/src`

**Interfaces:**
- Consumes: final component class names from Tasks 4–6.
- Produces: approved desktop/mobile visual layout with no dead legacy UI code.

- [ ] **Step 1: Add a temporary failing regression assertion for obsolete copy/code**

In the dashboard test, assert the rendered document omits old content:

```ts
expect(screen.queryByText("Kho video riêng tư")).not.toBeInTheDocument();
expect(screen.queryByText("Dữ liệu dự án")).not.toBeInTheDocument();
expect(screen.queryByRole("heading", { name: "Tải video lên Drive" })).not.toBeInTheDocument();
```

- [ ] **Step 2: Implement the approved visual system in CSS**

Add focused `drive-workspace`, `drive-browser-grid`, `drive-tree-*`, `drive-file-*`, `video-dropzone`, and `drive-upload-queue` rules matching the mockup: two equal columns, compact 41–48px rows, yellow folder/currentColor video icons with distinct silhouettes, compact option-B stat wrap, full-width queue, clear focus rings, and text status alongside color.

At `max-width: 720px`, stack the tree columns, wrap stat cells, keep action buttons at least 40×40 CSS pixels, and prevent horizontal overflow.

- [ ] **Step 3: Remove obsolete CSS selectors rather than overriding them**

Delete rules used only by the old UI, including `.drive-card`, `.drive-folder-list`, `.usage-grid`, `.project-upload`, `.upload-controls`, `.upload-item*`, and their obsolete mobile overrides. Keep shared button and progress primitives only if a live component still references them; verify with `rg` before deletion.

- [ ] **Step 4: Delete superseded components and tests**

Delete `drive-card.*` and `project-upload.*` after confirming no imports remain. The extracted hook and new components are the only supported code path; do not leave re-export shims.

- [ ] **Step 5: Prove there are no dead references or old copy**

Run:

```bash
rg -n "DriveCard|ProjectUpload|Kho video riêng tư|Tải video lên Drive|drive-folder-list|usage-grid|upload-controls" web/src
```

Expected: no matches, except an intentional negative assertion in a test if retained.

- [ ] **Step 6: Run complete verification**

Run: `npm test`

Expected: all Vitest suites pass.

Run: `npm run typecheck`

Expected: exit 0 with no TypeScript errors.

Run: `npm run lint`

Expected: exit 0 with no ESLint errors.

Run: `npm run build`

Expected: Next.js production build succeeds and lists the new Drive file routes.

- [ ] **Step 7: Review the final diff for accidental user-file changes**

Run: `git status --short` and `git diff --check`.

Expected: only planned `web/` changes plus the implementation plan are present; pre-existing untracked `.agents/`, `.claude/`, `CLAUDE.md`, `resources/`, `skills-lock.json`, and unrelated plan files remain untouched.

- [ ] **Step 8: Commit cleanup and styling**

```bash
git add web/src/app/globals.css web/src/components web/src/app web/src/lib
git commit -m "refactor: remove legacy Drive step UI"
```

---

## Final Review Checklist

- The tree API never returns OAuth tokens, raw app properties, Drive parent IDs, or internal folder IDs.
- A source/output item must match both Neon and Drive ownership metadata before display or delete.
- Upload, download, and preview video bytes never pass through Vercel.
- Folder and video elements use distinct SVGs and semantic roles.
- Preview readiness requires width, height, duration, and safe view link; processing is not mislabeled as upload failure.
- Delete is idempotent, confirmed in UI, source-aware in project state, and refuses folders/unmanaged files.
- Queue pause and permanent cancel are separate, visible, keyboard-accessible controls.
- The old Drive card, project upload wrapper, their tests, old copy, and unused CSS are deleted.
- Review unlock and upload recovery remain covered by regression tests.
