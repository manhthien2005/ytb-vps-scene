# Video-first Upload Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Google Drive uploads and replace the manual project-first experience with one video-first upload flow while retaining the existing internal aggregate.

**Architecture:** Correct the Drive session-init request at the adapter boundary, reopen invalid artifacts in the upload application service, then adapt the existing React upload coordinator so it creates the internal project automatically from the filename. `DashboardShell` owns the current video list so upload completion immediately unlocks Review without a page reload.

**Tech Stack:** Next.js 16, React 19, TypeScript 5.8, Vitest, Testing Library, Google Drive v3 resumable uploads, Neon PostgreSQL.

## Global Constraints

- One internal project owns exactly one source video, scene settings, jobs, and outputs.
- Keep the Drive root limited to `YTB-VPS/input` and `YTB-VPS/output`.
- Keep output naming as `output/<video-name>/part-01-of-01.mp4`.
- Do not send video bytes through Vercel functions.
- Do not log OAuth tokens, resumable session URIs, Drive file IDs, passwords, or filenames.
- Preserve all existing database rows and API contracts; no destructive migration.
- Follow red-green-refactor for every production-code change.

---

### Task 1: Send a documented empty-body Drive session request

**Files:**
- Modify: `web/src/lib/adapters/google/drive-files.test.ts`
- Modify: `web/src/lib/adapters/google/drive-files.ts`

**Interfaces:**
- Consumes: `DriveFilesPort.createResumableUpdateSession(accessToken, { fileId, mimeType, sizeBytes })`.
- Produces: the same return type `{ sessionUri: string; expiresAt: string }`; only the provider request shape changes.

- [ ] **Step 1: Tighten the existing adapter test so it requires a truly absent body**

Replace the body assertion in the resumable-session test with:

```ts
expect(init.method).toBe("PATCH");
expect(init.body).toBeUndefined();
const request = new Request(url, init);
expect(request.headers.get("content-type")).toBeNull();
expect(request.headers.get("content-length")).toBe("0");
expect(request.headers.get("x-upload-content-length")).toBe("8388608");
expect(request.headers.get("x-upload-content-type")).toBe("video/mp4");
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm test -- src/lib/adapters/google/drive-files.test.ts
```

Expected: failure because `init.body` is `""` and Fetch synthesizes `Content-Type: text/plain;charset=UTF-8`.

- [ ] **Step 3: Remove the empty string body and add safe provider-stage telemetry**

Change the request to:

```ts
const response = await fetcher(url.toString(), {
  method: "PATCH",
  headers: {
    ...headers(accessToken),
    "content-length": "0",
    "x-upload-content-length": String(input.sizeBytes),
    "x-upload-content-type": input.mimeType,
  },
  signal: controller.signal,
});
```

Before throwing on a non-retryable provider response, emit only bounded diagnostic fields:

```ts
if (!response.ok) {
  console.warn("[drive-upload] session-init-rejected", {
    stage: "provider-response",
    status: response.status,
  });
  throw stableError("DRIVE_PROVIDER_REJECTED");
}
```

- [ ] **Step 4: Run the adapter suite and verify GREEN**

Run:

```powershell
npm test -- src/lib/adapters/google/drive-files.test.ts
```

Expected: all adapter tests pass and the constructed request has no content type.

- [ ] **Step 5: Commit the provider-boundary fix**

```powershell
git add web/src/lib/adapters/google/drive-files.ts web/src/lib/adapters/google/drive-files.test.ts
git commit -m "fix: initialize Drive uploads without metadata body"
```

---

### Task 2: Make an invalid source genuinely retryable

**Files:**
- Modify: `web/src/lib/application/uploads.test.ts`
- Modify: `web/src/lib/application/uploads.ts`

**Interfaces:**
- Consumes: existing `Artifact.status` values `INVALID` and `DELETED` plus repository reset behavior in `reserveSourceArtifact`.
- Produces: `createSession(...)` can rebuild a deterministic placeholder and return a new resumable session after either terminal state.

- [ ] **Step 1: Add a failing application test for an invalid artifact**

Add next to the cancelled-source replacement test:

```ts
it("creates a fresh placeholder after Drive rejected the prior session", async () => {
  repository.getArtifact.mockResolvedValue({ ...artifact, status: "INVALID" });
  files.sourceFileId = "replacement-source-file-001";

  await expect(service.createSession({ projectId: PROJECT_ID, intent: validIntent, now: NOW }))
    .resolves.toMatchObject({ artifactId: PROJECT_ID });

  expect(health.assertUploadAllowed).toHaveBeenCalledWith(validIntent.sizeBytes, NOW);
  expect(files.inspectFileCalls).toHaveLength(0);
  expect(files.ensureSourceFileCalls).toHaveLength(1);
  expect(repository.reserveSourceArtifact).toHaveBeenCalledWith(
    expect.objectContaining({
      artifactId: PROJECT_ID,
      driveFileId: "replacement-source-file-001",
    }),
    expect.any(String),
  );
  expect(files.resumableSessionCalls[0]?.input.fileId)
    .toBe("replacement-source-file-001");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm test -- src/lib/application/uploads.test.ts
```

Expected: `UPLOAD_REMOTE_MISMATCH` because `INVALID` is not currently replaceable.

- [ ] **Step 3: Generalize replacement to both terminal source states**

Replace `replaceDeleted` with:

```ts
const replaceTerminal = existing !== null &&
  existing.id === artifactId &&
  existing.projectId === projectId &&
  existing.kind === "SOURCE" &&
  (existing.status === "INVALID" || existing.status === "DELETED");
```

Use `replaceTerminal` in the mismatch guard, health admission, and placeholder-creation branch:

```ts
if (existing !== null && !replaceTerminal && !matchingLiveArtifact(
  existing,
  projectId,
  project.driveInputFolderId,
  intent,
)) {
  throw remoteMismatch();
}

await dependencies.health.assertUploadAllowed(
  existing === null || replaceTerminal ? intent.sizeBytes : 0,
  input.now,
);

if (existing === null || replaceTerminal) {
  if (!await dependencies.repository.renewProvisioning("SOURCE", artifactId, claimToken)) {
    throw new AppError("DRIVE_TEMPORARILY_UNAVAILABLE", 503);
  }
  const driveFileId = await dependencies.files.ensureSourceFile(accessToken, {
    ...intent,
    projectId,
    artifactId,
    parentId: project.driveInputFolderId,
  });
  selected = await dependencies.repository.reserveSourceArtifact({
    ...intent,
    artifactId,
    projectId,
    driveFileId,
    driveParentId: project.driveInputFolderId,
  }, claimToken);
  if (!matchingReservation(
    selected,
    projectId,
    driveFileId,
    project.driveInputFolderId,
    intent,
  )) {
    throw remoteMismatch();
  }
}
```

- [ ] **Step 4: Run upload service tests and verify GREEN**

Run:

```powershell
npm test -- src/lib/application/uploads.test.ts
```

Expected: the new `INVALID` test and the existing `DELETED` test both pass.

- [ ] **Step 5: Commit the retry fix**

```powershell
git add web/src/lib/application/uploads.ts web/src/lib/application/uploads.test.ts
git commit -m "fix: reopen failed Drive source uploads"
```

---

### Task 3: Derive a safe video title from a filename

**Files:**
- Modify: `web/src/lib/domain/upload-filename.test.ts`
- Modify: `web/src/lib/domain/upload-filename.ts`

**Interfaces:**
- Produces: `videoTitleFromFileName(value: unknown): string | null`, limited to 160 characters and based on the canonical upload filename.

- [ ] **Step 1: Add failing domain tests**

```ts
describe("videoTitleFromFileName", () => {
  it("keeps Vietnamese text and removes only the final video extension", () => {
    expect(videoTitleFromFileName("Phim thử nghiệm.part1.mp4"))
      .toBe("Phim thử nghiệm.part1");
  });

  it("rejects unsupported names and bounds the internal project name", () => {
    expect(videoTitleFromFileName("notes.txt")).toBeNull();
    expect(videoTitleFromFileName(`${"a".repeat(200)}.mp4`)).toHaveLength(160);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm test -- src/lib/domain/upload-filename.test.ts
```

Expected: import/function missing.

- [ ] **Step 3: Implement the minimal filename-to-title helper**

```ts
export function videoTitleFromFileName(value: unknown): string | null {
  const canonical = canonicalUploadFileName(value);
  if (canonical === null) return null;
  const dot = canonical.lastIndexOf(".");
  const title = canonical.slice(0, dot).trim().slice(0, 160);
  return title.length === 0 ? null : title;
}
```

- [ ] **Step 4: Run the domain suite and verify GREEN**

Run:

```powershell
npm test -- src/lib/domain/upload-filename.test.ts
```

Expected: all filename tests pass.

- [ ] **Step 5: Commit the helper**

```powershell
git add web/src/lib/domain/upload-filename.ts web/src/lib/domain/upload-filename.test.ts
git commit -m "feat: derive internal video titles from filenames"
```

---

### Task 4: Replace manual project creation with the video-first coordinator

**Files:**
- Modify: `web/src/components/project-upload.test.tsx`
- Modify: `web/src/components/project-upload.tsx`
- Modify: `web/src/components/dashboard-shell.test.tsx`
- Modify: `web/src/components/dashboard-shell.tsx`

**Interfaces:**
- `ProjectUpload` keeps `health`, `projects`, `fetcher`, `store`, and `uploaderFactory`.
- `ProjectUpload` adds optional `onProjectsChange?: (projects: readonly PublicProject[]) => void`.
- `DashboardShell` passes its stateful video list to `ProjectUpload`, `SceneEditor`, and `JobList`.

- [ ] **Step 1: Replace the project-first component expectations with video-first expectations**

Add or update component tests to prove:

```ts
expect(screen.queryByRole("button", { name: "Tạo dự án" })).not.toBeInTheDocument();
expect(screen.getByLabelText("Video")).toHaveValue("");

fireEvent.change(screen.getByLabelText("File video"), { target: { files: [file] } });
fireEvent.click(screen.getByRole("button", { name: "Tải video lên" }));

await waitFor(() => expect(fetcher).toHaveBeenNthCalledWith(
  1,
  "/api/v1/projects",
  expect.objectContaining({
    method: "POST",
    body: JSON.stringify({ name: "Phim thử nghiệm" }),
  }),
));
expect(fetcher).toHaveBeenNthCalledWith(
  2,
  `/api/v1/projects/${PROJECT.id}/upload-session`,
  expect.any(Object),
);
```

Add a failed-video case whose combobox selects `PROJECT.id`, whose button reads `Chọn lại file và thử lại`, and whose first request is the existing project's `/upload-session` route rather than `/api/v1/projects`.

Update the quota test to assert `Tải video lên` is disabled instead of looking for `Tạo dự án`.

- [ ] **Step 2: Run the component tests and verify RED**

Run:

```powershell
npm test -- src/components/project-upload.test.tsx src/components/dashboard-shell.test.tsx
```

Expected: failures because the manual project controls still exist and dashboard state is not updated.

- [ ] **Step 3: Implement automatic internal project creation**

Use an empty selected ID as the new-video sentinel and remove `projectName` plus `createProject`. Add:

```ts
const [selectedProjectId, setSelectedProjectId] = useState("");
const selectedProject = projects.find((item) => item.id === selectedProjectId) ?? null;

function publishProjects(next: readonly PublicProject[]) {
  setProjects([...next]);
  onProjectsChange(next);
}

async function ensureVideoProject(file: File): Promise<PublicProject> {
  if (selectedProject !== null) return selectedProject;
  const name = videoTitleFromFileName(file.name);
  if (name === null) throw new Error("INVALID_REQUEST");
  const body = await jsonRequest(fetcher, "/api/v1/projects", { name }, {
    "idempotency-key": idempotencyKey(),
  });
  const project = body.project as PublicProject;
  publishProjects([...projects.filter((item) => item.id !== project.id), project]);
  setSelectedProjectId(project.id);
  return project;
}
```

Have `startUpload` call `ensureVideoProject(file)` and use the returned ID in the session/recovery coordinator:

```ts
const project = await ensureVideoProject(file);
const recovery = matchingRecovery(recoveries, project.id, file);
if (recovery !== null) {
  setArtifactId(recovery.artifactId);
  await attachUploader(project.id).resume(file, recovery);
  return;
}
const body = await jsonRequest(fetcher, `/api/v1/projects/${project.id}/upload-session`, {
  fileName: canonicalName,
  mimeType: file.type,
  sizeBytes: file.size,
  lastModified: file.lastModified,
});
```

When the uploader publishes `READY`, update that video's local `sourceStatus` to `SOURCE_READY`; on a provider rejection update it to `UPLOAD_FAILED`.

- [ ] **Step 4: Render video terminology and retry state**

Replace the project controls with:

```tsx
<label htmlFor="video-select">Video</label>
<select id="video-select" value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)}>
  <option value="">Tải video mới</option>
  {projects.map((project) => (
    <option key={project.id} value={project.id}>
      {project.name} · {videoStatus(project.sourceStatus)}
    </option>
  ))}
</select>

<label htmlFor="source-video">File video</label>
<input
  id="source-video"
  type="file"
  accept=".mp4,.mov,.mkv,.webm,video/mp4,video/quicktime,video/x-matroska,video/webm"
  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
  disabled={workDisabled || busy || uploadActive || sourceReady}
/>
<button
  type="button"
  onClick={startUpload}
  disabled={workDisabled || busy || uploadActive || sourceReady || file === null}
>
  {selectedProject?.sourceStatus === "UPLOAD_FAILED"
    ? "Chọn lại file và thử lại"
    : "Tải video lên"}
</button>
```

Keep pause, resume, cancel, progress, and IndexedDB recovery behavior unchanged.

- [ ] **Step 5: Lift the live video list into `DashboardShell`**

```ts
const [videoItems, setVideoItems] = useState([...projects]);
const sourceReady = videoItems.some((video) => video.sourceStatus === "SOURCE_READY");
const sourceProject = videoItems.find((video) => video.sourceStatus === "SOURCE_READY");
```

Pass `videoItems` and `setVideoItems` to `ProjectUpload`; use `videoItems` for the stepper, `SceneEditor`, and `JobList`. This lets upload completion unlock Review without reloading.

- [ ] **Step 6: Run focused component tests and verify GREEN**

Run:

```powershell
npm test -- src/components/project-upload.test.tsx src/components/dashboard-shell.test.tsx
```

Expected: automatic creation, failed-video retry, upload controls, and dashboard readiness tests all pass.

- [ ] **Step 7: Commit the video-first UI**

```powershell
git add web/src/components/project-upload.tsx web/src/components/project-upload.test.tsx web/src/components/dashboard-shell.tsx web/src/components/dashboard-shell.test.tsx
git commit -m "feat: make uploads video-first"
```

---

### Task 5: Verify, publish, and exercise production

**Files:**
- No production files unless verification exposes a defect.

**Interfaces:**
- Consumes: all prior task commits.
- Produces: deployed production build and a verified real Drive upload.

- [ ] **Step 1: Run complete local verification**

```powershell
npm test
npm run typecheck
npm run build
```

Run in `web/`. Expected: zero failed tests, TypeScript exit 0, Next production build exit 0.

- [ ] **Step 2: Confirm worktree scope**

```powershell
git status --short
git diff --check
```

Expected: only the operator-owned `resources/` directory remains untracked; no whitespace errors.

- [ ] **Step 3: Push the approved branch to personal `main` and deploy production**

```powershell
git push personal HEAD:main
npx vercel deploy --prod --yes --scope tiensithien2005-gmailcoms-projects --project web
```

Run the deployment from the repository root so Vercel applies the configured `web` root directory.

- [ ] **Step 4: Verify production authentication and the video-first UI**

Confirm the production login returns HTTP 200, then verify the dashboard exposes `Video`, `Tải video mới`, `File video`, and no `Tạo dự án` control.

- [ ] **Step 5: Perform the real upload proof**

Use `resources/videos/Test1.mp4`. Verify:

1. internal video item creation succeeds;
2. Drive session creation returns HTTP 200;
3. progress advances above zero;
4. completion changes the source to `SOURCE_READY`;
5. the file exists under `YTB-VPS/input`;
6. Review becomes available without reloading.

If production verification fails, capture the safe diagnostic stage/status and return to systematic debugging before another code change.
