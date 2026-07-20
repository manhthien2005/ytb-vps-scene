# Workflow Drive VPS Review Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved four-step workflow so Drive has only `input/output`, VPS setup is handled by a local connector, preview stays local, and render output is grouped by film and part.

**Architecture:** Vercel remains the control plane for metadata, queue, worker heartbeat and render-plan persistence. Browser media preview uses a local `File` object; resumable media transfers go directly between browser/worker and Google Drive. A loopback-only Local VPS Connector receives the CKEY SSH string and password, performs idempotent SSH setup, and sends only sanitized progress plus the worker enrollment result to Vercel.

**Tech Stack:** Next.js 16, React 19, TypeScript, Vitest, Neon/Postgres, Google Drive REST API, Node.js 22 Local Connector, existing native worker/systemd runtime.

## Global Constraints

- Drive root must contain only `input` and `output`; project metadata remains in Neon.
- VPS password must never be sent to Vercel, persisted, or written to logs.
- No Docker runtime is required for the connector or worker setup.
- Preview must not proxy large video bytes through Vercel.
- Blur uses static normalized rectangles only; no motion tracking in this release.
- Output names use `output/<film-slug>/part-01-of-04.mp4` style and must be idempotent.
- Every implementation task follows RED → GREEN → REFACTOR and ends with a focused test command.

---

### Task 1: Repair resumable Drive upload and stale upload recovery

**Files:**
- Modify: `web/src/lib/adapters/google/drive-files.ts:511-563`
- Modify: `web/src/lib/application/uploads.ts:202-377`
- Modify: `web/src/components/project-upload.tsx:16-52`
- Test: `web/src/lib/adapters/google/drive-files.test.ts`
- Test: `web/src/lib/application/uploads.test.ts`
- Test: `web/src/components/project-upload.test.tsx`

**Interfaces:**
- `createResumableUpdateSession(accessToken, input)` continues to return `{sessionUri, expiresAt}` but sends an explicit empty request body with `Content-Length: 0`.
- `createSession()` maps provider rejection to a retryable artifact state and never leaves an expired `UPLOADING` reservation permanently blocking the same project.

- [ ] **Step 1: Write the failing adapter test**

```ts
it("initiates an update session with an explicit empty body length", async () => {
  const requests: RequestInit[] = [];
  const fetcher = async (_url: string, init: RequestInit) => {
    requests.push(init);
    return new Response(null, {
      status: 200,
      headers: { location: "https://www.googleapis.com/upload/drive/v3/files/f?upload_id=s" },
    });
  };
  await adapter({ fetcher }).createResumableUpdateSession("token", {
    fileId: "drive-file-001", mimeType: "video/mp4", sizeBytes: 1024,
  });
  expect(requests[0]?.method).toBe("PATCH");
  expect(requests[0]?.body).toBe("");
  expect(new Headers(requests[0]?.headers).get("content-length")).toBe("0");
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npm --prefix web test -- src/lib/adapters/google/drive-files.test.ts -t "explicit empty body length"`

Expected: FAIL because the current request has no explicit body/content length.

- [ ] **Step 3: Implement the minimal request contract**

Add `body: ""` and `"content-length": "0"` beside the existing upload headers. Keep the current retry/status mapping and do not expose Google response bodies.

- [ ] **Step 4: Add the stale artifact regression test**

Create a fake repository artifact in `UPLOADING` whose provisioning timestamp is older than the configured stale window; assert that `createSession()` returns a new resumable session instead of `UPLOAD_REMOTE_MISMATCH` and records one recovery audit event.

- [ ] **Step 5: Implement retryable recovery and UI messages**

Add `DRIVE_PROVIDER_REJECTED`, `DRIVE_TEMPORARILY_UNAVAILABLE`, and `UPLOAD_REMOTE_MISMATCH` messages to `VI_MESSAGES`. When session creation fails after a stale claim, mark the source artifact `INVALID`/retryable through the repository path already used by completion reconciliation.

- [ ] **Step 6: Run tests and commit**

Run: `npm --prefix web test -- src/lib/adapters/google/drive-files.test.ts src/lib/application/uploads.test.ts src/components/project-upload.test.tsx`

Expected: PASS. Commit: `git commit -m "fix: recover drive resumable uploads"`.

### Task 2: Move Drive folders to the approved `input/output` layout

**Files:**
- Modify: `web/src/lib/ports/drive.ts`
- Modify: `web/src/lib/adapters/google/drive-files.ts:451-509`
- Modify: `web/src/lib/repositories/drive-control-plane.ts`
- Modify: `web/src/lib/repositories/neon-drive-control-plane.ts`
- Modify: `web/src/lib/db/schema.sql`
- Modify: `web/src/components/drive-card.tsx`
- Modify: `web/src/components/dashboard-types.ts`
- Test: `web/src/lib/adapters/google/drive-files.test.ts`
- Test: `web/src/lib/repositories/neon-drive-control-plane.test.ts`
- Test: `web/src/components/drive-card.test.tsx`

**Interfaces:**
- `DriveFilesPort.ensureWorkspace()` returns `{rootFolderId, inputFolderId, outputFolderId}`.
- `DriveFilesPort.ensureProjectFolders()` returns `{inputFolderId, outputFolderId}` where `outputFolderId` is `YTB-VPS/output/<film-slug>` and no project UUID folder is created.
- `PublicProject` gains `filmSlug` and `driveOutputFolderId` without removing legacy IDs until migration completes.

- [ ] **Step 1: Add failing adapter tests for exact root children**

Assert that the fake Drive request sequence creates/finds `input` and `output` directly under `YTB-VPS`, never creates `projects`, and creates the film folder only below `output`.

- [ ] **Step 2: Run RED**

Run: `npm --prefix web test -- src/lib/adapters/google/drive-files.test.ts -t "input and output"`

Expected: FAIL because the adapter currently creates `projects/<uuid>/input`.

- [ ] **Step 3: Add the schema migration test first**

Assert that the schema exposes `drive_output_folder_id` and `film_slug`, both nullable for old rows and required when a project becomes `READY`.

- [ ] **Step 4: Implement migration and repository mapping**

Add migration v10 with `projects.film_slug` and `projects.drive_output_folder_id`, backfill `film_slug` from the existing name using `canonicalUploadFileName`-style normalization, and keep legacy folder columns readable. Update `createProject`, `getProject`, and project serialization to return the new fields.

- [ ] **Step 5: Implement the adapter layout**

Replace `ensureProjectFolders` with root-level `input/output` lookup plus a film folder under `output`. Preserve strict app properties and exactly-one-parent validation. Update source/output callers to use the returned folder IDs.

- [ ] **Step 6: Add DriveCard folder summaries**

Render only `input` and `output` root tiles, list film folders/part files under output, and keep quota/account status above them. Add empty, loading, and re-auth states.

- [ ] **Step 7: Run tests and commit**

Run: `npm --prefix web test -- src/lib/adapters/google/drive-files.test.ts src/lib/repositories/neon-drive-control-plane.test.ts src/components/drive-card.test.tsx src/lib/db/schema.test.ts`

Expected: PASS. Commit: `git commit -m "feat: organize drive into input and output"`.

### Task 3: Make local video preview lightweight and persist the render plan

**Files:**
- Modify: `web/src/components/scene-editor.tsx`
- Modify: `web/src/components/scene-editor.test.tsx`
- Modify: `web/src/lib/domain/scene-settings.ts`
- Modify: `web/src/app/api/v1/projects/[id]/scene-settings/route.ts`
- Modify: `web/src/app/globals.css`
- Test: `web/src/lib/domain/scene-settings.test.ts`

**Interfaces:**
- `SceneSettings` remains versioned and stores normalized rectangles, voice, rate and source artifact ID.
- `SceneEditor` accepts the selected local `File` and uses `<video preload="metadata" controls muted playsInline>` with a revoked object URL on replacement/unmount.

- [ ] **Step 1: Write failing domain tests**

Add tests that accept two valid normalized rectangles plus voice/rate, reject values outside `[0,1]`, and preserve `version`/`sourceArtifactId` in the parsed settings.

- [ ] **Step 2: Run RED**

Run: `npm --prefix web test -- src/lib/domain/scene-settings.test.ts -t "versioned"`

Expected: FAIL because the current schema has no version/source artifact fields.

- [ ] **Step 3: Implement the versioned schema**

Add `version: z.literal(1)` and nullable/required `sourceArtifactId` according to existing project state; keep strict rectangle bounds and existing voice enum.

- [ ] **Step 4: Write the component regression test**

Render `SceneEditor` with a `File`, assert the video element has `preload="metadata"`, `muted`, and `playsInline`, and assert selecting a second file revokes the first object URL.

- [ ] **Step 5: Implement local preview and interaction polish**

Use one video element with an absolutely positioned overlay layer; do not copy the file into component state. Keep rectangle pointer coordinates normalized to the preview bounds and announce that preview is local-only. Disable save until a project and source artifact are selected.

- [ ] **Step 6: Run tests and commit**

Run: `npm --prefix web test -- src/lib/domain/scene-settings.test.ts src/components/scene-editor.test.tsx src/app/api/v1/projects/[id]/scene-settings/route.test.ts`

Expected: PASS. Commit: `git commit -m "feat: keep scene preview local and versioned"`.

### Task 4: Build the Local VPS Connector protocol and idempotent setup script

**Files:**
- Create: `tools/local-vps-connector/package.json`
- Create: `tools/local-vps-connector/src/server.ts`
- Create: `tools/local-vps-connector/src/ssh-command.ts`
- Create: `tools/local-vps-connector/src/setup-runner.ts`
- Create: `tools/local-vps-connector/test/ssh-command.test.ts`
- Create: `tools/local-vps-connector/test/setup-runner.test.ts`
- Modify: `web/src/app/api/v1/workers/enrollment/route.ts`
- Modify: `web/src/components/worker-card.tsx`
- Test: `web/src/components/worker-card.test.tsx`

**Interfaces:**
- `parseSshCommand(value: string): {user: string; host: string; port: number}` rejects shell metacharacters, missing host, invalid port, and extra command arguments.
- `runSetup(input): AsyncIterable<{stage; percent; message}>` receives parsed SSH details, password, enrollment command/token, and an injected SSH transport; it emits sanitized progress only.
- Loopback HTTP `POST /setup` accepts `{sshCommand,password,originNonce}` and returns a job ID; `GET /setup/:id/events` streams progress without ever echoing the password.

- [ ] **Step 1: Write parser tests**

Cover `ssh root@n1.ckey.vn -p 1210`, `root@n1.ckey.vn:1210` rejection, invalid ports, non-root users, and shell characters.

- [ ] **Step 2: Run RED**

Run: `npm --prefix tools/local-vps-connector test -- ssh-command.test.ts`

Expected: FAIL because the connector package and parser do not exist.

- [ ] **Step 3: Implement parser and injected setup runner**

Use `ssh2` as the transport dependency, never concatenate user input into a shell command, run each setup command as a fixed array, redact command output, and stop on a failed stage. The runner must be safe to execute twice.

- [ ] **Step 4: Add connector HTTP server tests**

Assert loopback-only binding, nonce/origin validation, no password in event payloads, and ordered stages `CONNECTING` through `READY`.

- [ ] **Step 5: Add the browser connector bridge**

Replace the copy-only WorkerCard flow with a form for SSH command/password, a “Mở Local Connector” action, progress events, GPU facts, READY/FAILED state, and a revoke action. If the helper is not running, show the exact local start instruction without exposing credentials.

- [ ] **Step 6: Run tests and commit**

Run: `npm --prefix tools/local-vps-connector test`; then `npm --prefix web test -- src/components/worker-card.test.tsx web/src/app/api/v1/workers/enrollment/route.test.ts`

Expected: PASS. Commit: `git commit -m "feat: add local vps setup connector"`.

### Task 5: Replace the card grid with the approved four-step workflow shell

**Files:**
- Modify: `web/src/components/dashboard-shell.tsx`
- Modify: `web/src/components/dashboard-shell.test.tsx`
- Modify: `web/src/components/drive-card.tsx`
- Modify: `web/src/components/project-upload.tsx`
- Modify: `web/src/components/job-list.tsx`
- Modify: `web/src/app/globals.css`
- Modify: `web/src/app/page.tsx`

**Interfaces:**
- `DashboardShell` owns active step (`DRIVE | VPS | REVIEW | RENDER`) and derives completion from source status, worker state and saved scene settings.
- Existing cards remain independently testable but are rendered inside step panels; no API secret is placed in client props.

- [ ] **Step 1: Write failing shell tests**

Assert the initial screen shows the four-step stepper, Drive panel first, and disabled Review/Render navigation until source/VPS prerequisites are met. Assert the status summary answers source, VPS and output readiness.

- [ ] **Step 2: Run RED**

Run: `npm --prefix web test -- src/components/dashboard-shell.test.tsx -t "four step workflow"`

Expected: FAIL because the current shell renders three technical cards at once.

- [ ] **Step 3: Implement stepper and status summary**

Use semantic buttons/regions, keep a responsive two-column layout for desktop and one column on mobile, and preserve existing API fetch boundaries. Drive step shows only the two root folders and upload; VPS step shows connector; Review step shows scene editor; Render step shows job list/summary.

- [ ] **Step 4: Add output part summary**

Render film folder and verified part links, with empty/loading/error states and no raw Drive IDs.

- [ ] **Step 5: Run component/page tests and commit**

Run: `npm --prefix web test -- src/components/dashboard-shell.test.tsx src/components/drive-card.test.tsx src/components/project-upload.test.tsx src/components/job-list.test.tsx src/app/page.test.tsx`

Expected: PASS. Commit: `git commit -m "feat: present guided drive vps review workflow"`.

### Task 6: End-to-end verification, migration rehearsal and production handoff

**Files:**
- Modify: `web/src/lib/db/schema.test.ts`
- Modify: `web/src/lib/db/migrate-cli.test.ts`
- Create: `tools/local-vps-connector/README.md`
- Modify: `docs/superpowers/specs/2026-07-20-workflow-drive-vps-review-redesign.md` only if implementation details differ

- [ ] **Step 1: Run full web checks**

Run: `npm --prefix web run typecheck`; `npm --prefix web run lint`; `npm --prefix web test`; `npm --prefix web run build`.

Expected: all commands exit 0 with no unhandled warnings.

- [ ] **Step 2: Run connector checks**

Run: `npm --prefix tools/local-vps-connector test`; `npm --prefix tools/local-vps-connector run typecheck`.

Expected: all parser, nonce and setup-stage tests pass.

- [ ] **Step 3: Rehearse migration on a disposable Neon branch/database**

Apply schema v10, verify old project rows remain readable, verify new `input/output` IDs are populated, and verify no secret value appears in audit payloads.

- [ ] **Step 4: Verify the upload regression against a fake Google response**

Assert the initiation request contains `PATCH`, `Content-Length: 0`, and the upload headers; assert provider failure returns a stable public code and a retryable artifact state.

- [ ] **Step 5: Verify the browser workflow manually**

Check: login → Drive folders → local video preview → rectangle selection → TTS preview → Local Connector setup progress → READY → render plan → output film folder/parts.

- [ ] **Step 6: Commit verification docs and report handoff**

Commit: `git commit -m "test: verify workflow redesign handoff"`. Record commands/results, known limitations and the exact VPS connector launch command in `tools/local-vps-connector/README.md`.

## Self-review checklist

- Drive root, source path, output film folder and part naming are covered by Tasks 1–2.
- Upload provider rejection and stale `UPLOADING` recovery are covered by Task 1 and Task 6.
- Local-only preview, normalized rectangles and TTS are covered by Task 3.
- Password boundary, SSH parsing, progress stages, idempotent setup and worker enrollment are covered by Task 4.
- Workflow layout, prerequisites and output links are covered by Task 5.
- Migration, build, lint, tests and manual handoff are covered by Task 6.
- No task stores a VPS password, proxies media through Vercel, or introduces Docker.
