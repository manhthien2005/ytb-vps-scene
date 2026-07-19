# Drive Upload Metadata Finalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a production-proven private source-upload slice where video chunks travel directly from the browser to Google Drive and Vercel resolves an unreadable final upload response through exact server-side metadata verification.

**Architecture:** Extend the existing Next.js modular monolith and Neon metadata repository. The browser keeps the resumable session capability in IndexedDB and sends 8 MiB chunks directly to Drive; application services create sessions and finalize only from server-held artifact identity plus a fresh `files.get`. A revised production gate runs after the minimum project/upload/coordinator slice and before the remaining CP-2 dashboard work.

**Tech Stack:** Node.js 22.x, Next.js 16.2.10 App Router, React 19.2.0, TypeScript 5.8.3, Vitest 3.2.7, Zod 4.1.5, Neon PostgreSQL, Google Drive API v3, `fake-indexeddb` 6.2.5, Vercel Hobby.

## Global Constraints

- Request only `https://www.googleapis.com/auth/drive.file`.
- Video bytes must never enter a Vercel request, function, log, cache, or persistence layer.
- Google access/refresh tokens remain server-only; the browser receives only the resumable session URI.
- Store `sessionUri` only in IndexedDB `ytb-vps-upload-v1`; never store it in Neon, URLs, DOM, logs, audits, snapshots, or analytics.
- Upload chunks are 8,388,608 bytes except the final chunk; every non-final chunk is a multiple of 262,144 bytes.
- A single shared retry/renew/finalize counter stops at five failed attempts. Attempts one through four wait 1, 2, 4, and 8 seconds plus 0..249 ms jitter.
- `upload-complete` accepts only `{ artifactId }`, is capped at 1 KiB, requires admin plus exact Origin, and returns `Cache-Control: no-store`.
- `SOURCE_READY` requires exact server-side file ID, parent, name, MIME, size, trashed state, and appProperties evidence.
- Smaller observed size remains pending; conclusive ownership/identity mismatch fails closed.
- No new paid service, billing activation, persistent schema table, or persistent environment flag.
- Keep all live credentials, provider IDs, session URIs, uploaded media, and `.env*` files out of Git and evidence logs.

---

### Task 1: Checkpoint the proven live OAuth and Drive compatibility fixes

**Files:**
- Modify: `web/.gitignore`
- Modify: `web/src/app/api/v1/drive/callback/route.ts`
- Modify: `web/src/app/api/v1/drive/callback/route.test.ts`
- Modify: `web/src/lib/adapters/google/oauth.ts`
- Modify: `web/src/lib/adapters/google/oauth.test.ts`
- Modify: `web/src/lib/adapters/google/drive-files.ts`
- Modify: `web/src/lib/adapters/google/drive-files.test.ts`
- Modify: `web/src/lib/db/migrate-cli.ts`
- Create: `web/src/lib/db/migrate-cli.test.ts`

**Interfaces:**
- Consumes: the already-observed live Google callback containing RFC 9207 `iss`, Testing-mode token responses containing `refresh_token_expires_in`, and `drive.file` root-alias behavior.
- Produces: a committed clean baseline that accepts only the exact Google issuer, tolerates bounded refresh-token expiry metadata, creates the workspace through the `root` alias, and runs migrations under the package CommonJS runtime.

- [ ] **Step 1: Review the existing red-green diff and exclude unrelated files**

Run:

```powershell
git diff -- web/.gitignore web/src/app/api/v1/drive/callback web/src/lib/adapters/google/oauth* web/src/lib/adapters/google/drive-files* web/src/lib/db/migrate-cli*
git diff --check
```

Expected: only the four compatibility fixes and their regression tests appear; no credential value or temporary CORS probe code appears.

- [ ] **Step 2: Re-run the focused regression tests**

Run:

```powershell
cd web
npm test -- --run src/app/api/v1/drive/callback/route.test.ts src/lib/adapters/google/oauth.test.ts src/lib/adapters/google/drive-files.test.ts src/lib/db/migrate-cli.test.ts
```

Expected: all four files pass. The callback rejects a wrong/duplicate `iss`; token parsing accepts bounded `refresh_token_expires_in`; Drive never calls `GET /files/root`; the migration CLI reaches configuration validation instead of a top-level-await transform error.

- [ ] **Step 3: Verify the full baseline sequentially**

Run:

```powershell
cd web
npm test -- --maxWorkers=1
npm run typecheck
npm run lint
npm run build
```

Expected: 339 or more tests pass with zero failures; typecheck, lint, and production build exit 0.

- [ ] **Step 4: Commit only the compatibility checkpoint**

```powershell
git add web/.gitignore web/src/app/api/v1/drive/callback web/src/lib/adapters/google/oauth.ts web/src/lib/adapters/google/oauth.test.ts web/src/lib/adapters/google/drive-files.ts web/src/lib/adapters/google/drive-files.test.ts web/src/lib/db/migrate-cli.ts web/src/lib/db/migrate-cli.test.ts
git diff --cached --check
git commit -m "fix(web): support live Google Drive connection"
```

---

### Task 2: Provision projects idempotently behind strict routes

**Files:**
- Modify: `web/src/lib/repositories/drive-control-plane.ts`
- Modify: `web/src/lib/repositories/neon-drive-control-plane.ts`
- Modify: `web/src/lib/repositories/neon-drive-control-plane.test.ts`
- Modify: `web/src/test/fakes/fake-drive-control-plane.ts`
- Create: `web/src/lib/application/projects.ts`
- Create: `web/src/lib/application/projects.test.ts`
- Create: `web/src/app/api/v1/projects/route.ts`
- Create: `web/src/app/api/v1/projects/route.test.ts`

**Interfaces:**
- Consumes: `DriveControlPlaneRepository.reserveProject`, `DriveFilesPort.ensureProjectFolders`, `DriveAccessProvider.getAccessToken`.
- Produces: `getProject(id)`, `markProjectFailed(id)`, `createProjectService(dependencies)`, authenticated `GET /api/v1/projects`, and idempotent `POST /api/v1/projects`.

- [ ] **Step 1: Write failing repository and application tests**

Add the repository contract:

```ts
getProject(projectId: string): Promise<Project | null>;
markProjectFailed(projectId: string): Promise<void>;
```

Add application tests with the wished-for result type:

```ts
export type ProjectCreationResult = Readonly<{
  outcome: "CREATED" | "REPLAYED";
  project: Project;
}>;

it("resumes provisioning with the same deterministic folder identity", async () => {
  repository.reserveProject.mockResolvedValue({ outcome: "RESUME", project: provisioning });
  files.ensureProjectFolders.mockResolvedValue({
    projectFolderId: "project-folder-001",
    inputFolderId: "input-folder-001",
  });

  await expect(service.createProject({
    idempotencyKey: "0123456789abcdef",
    name: "Test 1",
  })).resolves.toMatchObject({ outcome: "REPLAYED", project: { status: "READY" } });
  expect(files.ensureProjectFolders).toHaveBeenCalledWith("access", provisioning.id);
});

it("returns a ready replay without calling Drive", async () => {
  repository.reserveProject.mockResolvedValue({ outcome: "EXISTING", project: ready });
  await expect(service.createProject(request)).resolves.toEqual({
    outcome: "REPLAYED",
    project: ready,
  });
  expect(files.ensureProjectFolders).not.toHaveBeenCalled();
});

it("marks only conclusive remote mismatch as failed", async () => {
  files.ensureProjectFolders.mockRejectedValue(new AppError("DRIVE_REMOTE_MISMATCH", 502));
  await expect(service.createProject(request)).rejects.toThrow("DRIVE_REMOTE_MISMATCH");
  expect(repository.markProjectFailed).toHaveBeenCalledWith(provisioning.id);
});
```

Repository tests prove `getProject` returns `null` for absence, validates every returned field, and `markProjectFailed` changes only `PROVISIONING` to `FAILED`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
cd web
npm test -- --run src/lib/application/projects.test.ts src/lib/repositories/neon-drive-control-plane.test.ts
```

Expected: FAIL because the new repository methods and project service do not exist.

- [ ] **Step 3: Implement deterministic reservation and provisioning**

Use exact input/output boundaries:

```ts
export type CreateProjectInput = Readonly<{
  idempotencyKey: string;
  name: string;
}>;

export interface ProjectService {
  createProject(input: CreateProjectInput): Promise<ProjectCreationResult>;
  listProjects(): Promise<readonly Project[]>;
}
```

Implementation order:

```ts
const name = input.name.trim();
const idempotencyKeyHash = sha256(input.idempotencyKey);
const requestHash = sha256(JSON.stringify({ name }));
const reservation = await repository.reserveProject({ idempotencyKeyHash, requestHash, name });
if (reservation.outcome === "CONFLICT") throw new AppError("IDEMPOTENCY_CONFLICT", 409);
if (reservation.outcome === "EXISTING") {
  return { outcome: "REPLAYED", project: reservation.project };
}
try {
  const accessToken = await access.getAccessToken();
  const folders = await files.ensureProjectFolders(accessToken, reservation.project.id);
  const project = await repository.completeProjectFolders(
    reservation.project.id,
    folders.projectFolderId,
    folders.inputFolderId,
  );
  await repository.recordAudit({
    eventType: "PROJECT_CREATED",
    targetId: project.id,
    actorClass: "admin",
    payload: { status: project.status },
  });
  return { outcome: reservation.outcome === "CREATED" ? "CREATED" : "REPLAYED", project };
} catch (error) {
  if (error instanceof AppError && error.code === "DRIVE_REMOTE_MISMATCH") {
    await repository.markProjectFailed(reservation.project.id);
  }
  throw error;
}
```

- [ ] **Step 4: Write failing route tests**

The route schemas and limits are exact:

```ts
const BODY_BYTES = 1_024;
const createProjectBody = z.object({ name: z.string().trim().min(1).max(160) }).strict();
const idempotencyKey = z.string().min(16).max(128).regex(/^[\x20-\x7E]+$/);
```

Tests prove: authentication precedes Origin/body/service; POST requires exact Origin; invalid/duplicate/missing idempotency key is rejected; streamed bodies above 1 KiB return 413; CREATED returns 201; REPLAYED returns 200; GET requires admin but no Origin; responses expose only project domain fields and are `no-store`.

- [ ] **Step 5: Run route tests and verify RED**

Run: `cd web; npm test -- --run src/app/api/v1/projects/route.test.ts`

Expected: FAIL because the route does not exist.

- [ ] **Step 6: Implement the strict project route and verify GREEN**

The response is exact:

```ts
return NextResponse.json(
  { project: result.project },
  { status: result.outcome === "CREATED" ? 201 : 200, headers: { "cache-control": "no-store" } },
);
```

Run:

```powershell
cd web
npm test -- --run src/lib/application/projects.test.ts src/lib/repositories/neon-drive-control-plane.test.ts src/app/api/v1/projects/route.test.ts
npm run typecheck
```

Expected: all focused tests pass and no simulated crash/retry creates a second Drive folder.

- [ ] **Step 7: Commit the project slice**

```powershell
git add web/src/lib/repositories/drive-control-plane.ts web/src/lib/repositories/neon-drive-control-plane.ts web/src/lib/repositories/neon-drive-control-plane.test.ts web/src/test/fakes/fake-drive-control-plane.ts web/src/lib/application/projects.ts web/src/lib/application/projects.test.ts web/src/app/api/v1/projects
git commit -m "feat(web): provision Drive projects idempotently"
```

---

### Task 3: Add fail-closed free-tier upload admission

**Files:**
- Create: `web/src/lib/application/free-tier-health.ts`
- Create: `web/src/lib/application/free-tier-health.test.ts`

**Interfaces:**
- Consumes: `assessProjectedUpload`, Drive account quota, Neon database bytes, app-managed artifact bytes, and saved usage snapshots.
- Produces: `FreeTierHealthService.assertUploadAllowed(incomingBytes, now)` and `getHealth(now)` for the later authenticated health route.

- [ ] **Step 1: Write failing freshness and 90-percent boundary tests**

```ts
export interface FreeTierHealthService {
  getHealth(now: Date): Promise<FreeTierHealth>;
  assertUploadAllowed(incomingBytes: number, now: Date): Promise<void>;
}

it("allows a projection strictly below 90 percent", async () => {
  drive.account = { ...drive.account, usedBytes: 899, limitBytes: 1_000 };
  await expect(service.assertUploadAllowed(0, NOW)).resolves.toBeUndefined();
});

it("rejects a projection exactly at 90 percent", async () => {
  drive.account = { ...drive.account, usedBytes: 899, limitBytes: 1_000 };
  await expect(service.assertUploadAllowed(1, NOW)).rejects.toMatchObject({
    code: "DRIVE_STORAGE_HIGH",
  });
});

it("fails closed when quota evidence is older than 900 seconds", async () => {
  repository.getUsage.mockResolvedValue(savedAt("2026-07-19T00:00:00.000Z"));
  drive.inspectAccountError = new AppError("DRIVE_TEMPORARILY_UNAVAILABLE", 503);
  await expect(service.assertUploadAllowed(1, new Date("2026-07-19T00:15:01.000Z")))
    .rejects.toMatchObject({ code: "DRIVE_QUOTA_STALE" });
});
```

Also cover malformed/non-safe quota values, Neon at exactly 90 percent, provider fallback only to a still-fresh snapshot, disconnected/reauth states, and audit/log output containing no account identity.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `cd web; npm test -- --run src/lib/application/free-tier-health.test.ts`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement bounded refresh, fallback, and admission**

Use these exact dependency and view types:

```ts
export type FreeTierHealthDependencies = Readonly<{
  repository: DriveControlPlaneRepository;
  access: DriveAccessProvider;
  files: DriveFilesPort;
  neonLimitBytes: number;
  softPercent: number;
  staleAfterSeconds: number;
}>;

export type FreeTierHealth = Readonly<{
  mode: "READ_WRITE" | "READ_ONLY";
  reasons: readonly string[];
  driveConnection: DriveConnectionStatus;
  drive: UsageSnapshot | null;
  neon: UsageSnapshot | null;
}>;
```

Refresh both snapshots from `inspectAccount`, `appManagedDriveBytes`, and `databaseUsedBytes`; persist bounded snapshots. On provider error, reuse only saved evidence whose `observedAt <= now` and age is at most `staleAfterSeconds * 1000`. Call `assessProjectedUpload` with Drive `usedBytes + incomingBytes`; map the first reason to its existing `AppError` and never enable billing.

- [ ] **Step 4: Verify GREEN and commit**

```powershell
cd web
npm test -- --run src/lib/application/free-tier-health.test.ts src/lib/domain/free-tier.test.ts
npm run typecheck
git add src/lib/application/free-tier-health.ts src/lib/application/free-tier-health.test.ts
git commit -m "feat(web): guard free tier uploads"
```

---

### Task 4: Implement source sessions and metadata-only completion

**Files:**
- Modify: `web/src/test/fakes/fake-google-drive.ts`
- Create: `web/src/lib/application/uploads.ts`
- Create: `web/src/lib/application/uploads.test.ts`
- Create: `web/src/app/api/v1/projects/[id]/upload-session/route.ts`
- Create: `web/src/app/api/v1/projects/[id]/upload-session/route.test.ts`
- Create: `web/src/app/api/v1/projects/[id]/upload-complete/route.ts`
- Create: `web/src/app/api/v1/projects/[id]/upload-complete/route.test.ts`
- Create: `web/src/app/api/v1/projects/[id]/upload-cancel/route.ts`
- Create: `web/src/app/api/v1/projects/[id]/upload-cancel/route.test.ts`

**Interfaces:**
- Consumes: project lookup, upload intent validation, free-tier admission, deterministic Drive placeholders, resumable session creation, `inspectFile`, and artifact lifecycle methods.
- Produces: `UploadService.createSession`, `complete`, and `cancel`; three protected routes; exact 200/202 finalization results.

- [ ] **Step 1: Write failing application tests for session secrecy**

```ts
export type UploadSessionResult = Readonly<{
  artifactId: string;
  sessionUri: string;
  chunkBytes: 8_388_608;
  expiresAt: string;
}>;

it("returns the capability without persisting or auditing it", async () => {
  const result = await service.createSession({ projectId, intent: validIntent, now: NOW });
  expect(result.chunkBytes).toBe(8_388_608);
  expect(result.sessionUri).toMatch(/^https:\/\/www\.googleapis\.com\/upload\//);
  expect(JSON.stringify(repository.calls)).not.toContain(result.sessionUri);
  expect(JSON.stringify(repository.audits)).not.toContain(result.sessionUri);
});

it("uses the project UUID as the one-source artifact UUID", async () => {
  const result = await service.createSession({ projectId, intent: validIntent, now: NOW });
  expect(result.artifactId).toBe(projectId);
  expect(files.ensureSourceFileCalls[0]?.input).toMatchObject({
    projectId,
    artifactId: projectId,
    parentId: readyProject.driveInputFolderId,
  });
});
```

Cover READY project requirement, exact file identity reuse, 10 GiB configured cap, free-tier denial before Drive mutation, reservation mismatch, session creation failure preserving pending metadata, and audit payload containing only IDs/bytes/MIME/status.

Add a renewal regression that begins with an existing matching UPLOADING
artifact and nonzero remote evidence:

```ts
it("renews the stored pending file without requiring an empty placeholder", async () => {
  repository.getArtifact.mockResolvedValue({ ...artifact, status: "UPLOADING" });
  files.file = { ...exactRemoteFile(), sizeBytes: 262_144 };
  await service.createSession({ projectId, intent: validIntent, now: NOW });
  expect(files.ensureSourceFile).not.toHaveBeenCalled();
  expect(files.createResumableUpdateSession).toHaveBeenCalledWith("access", {
    fileId: artifact.driveFileId,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.expectedSizeBytes,
  });
  expect(health.assertUploadAllowed).toHaveBeenCalledWith(0, NOW);
});
```

- [ ] **Step 2: Run the session tests and verify RED**

Run: `cd web; npm test -- --run src/lib/application/uploads.test.ts`

Expected: FAIL because `uploads.ts` does not exist.

- [ ] **Step 3: Implement session creation**

```ts
export interface UploadService {
  createSession(input: Readonly<{
    projectId: string;
    intent: UploadIntentInput;
    now: Date;
  }>): Promise<UploadSessionResult>;
  complete(input: Readonly<{
    projectId: string;
    artifactId: string;
    now: Date;
  }>): Promise<UploadCompletionResult>;
  cancel(input: Readonly<{
    projectId: string;
    artifactId: string;
    now: Date;
  }>): Promise<Readonly<{ status: "CANCELLED" }>>;
}
```

Execute in this order: validate UUID and intent; load READY project with input
folder; use `artifactId = projectId`; load any existing artifact; get a server
access token. For no existing artifact, call `assertUploadAllowed(sizeBytes)`,
ensure the empty `source.<extension>` with exact appProperties, reserve the
artifact, and mark it UPLOADING. For a matching PENDING/UPLOADING artifact,
require the same immutable display name/MIME/expected size, call
`assertUploadAllowed(0)`, freshly inspect exact ID/parent/name/MIME/properties
with remote size no larger than expected, and do not call `ensureSourceFile`.
Then create the PATCH resumable session on the stored file ID, record
`UPLOAD_SESSION_CREATED` without the URI, and return only the declared result.
This branch is mandatory because a partially transferred file is not an empty
placeholder. A replacement session restarts at offset zero.

- [ ] **Step 4: Write failing metadata finalization tests**

```ts
export type UploadCompletionResult =
  | Readonly<{ status: "SOURCE_READY"; actualSizeBytes: number }>
  | Readonly<{ status: "UPLOAD_PENDING"; retryAfterMs: 1_000 }>;

it("marks ready only from exact server metadata", async () => {
  files.file = exactRemoteFile();
  await expect(service.complete({ projectId, artifactId, now: NOW })).resolves.toEqual({
    status: "SOURCE_READY",
    actualSizeBytes: artifact.expectedSizeBytes,
  });
  expect(repository.markSourceReady).toHaveBeenCalledWith(
    artifactId,
    artifact.expectedSizeBytes,
    NOW,
  );
  expect(repository.audits.filter((event) => event.eventType === "UPLOAD_COMPLETED"))
    .toHaveLength(1);
});

it("keeps a smaller app-owned file pending", async () => {
  files.file = { ...exactRemoteFile(), sizeBytes: artifact.expectedSizeBytes - 1 };
  await expect(service.complete({ projectId, artifactId, now: NOW })).resolves.toEqual({
    status: "UPLOAD_PENDING",
    retryAfterMs: 1_000,
  });
  expect(repository.markSourceReady).not.toHaveBeenCalled();
  expect(repository.markSourceInvalid).not.toHaveBeenCalled();
});

it.each(["id", "parent", "name", "mime", "properties", "trashed", "larger-size"])(
  "fails closed on conclusive %s mismatch",
  async (kind) => {
    files.file = mismatchedRemoteFile(kind);
    await expect(service.complete({ projectId, artifactId, now: NOW }))
      .rejects.toMatchObject({ code: "UPLOAD_REMOTE_MISMATCH" });
    expect(repository.markSourceInvalid).toHaveBeenCalledWith(artifactId);
  },
);

it("returns an already-ready artifact without another provider call or audit", async () => {
  repository.getArtifact.mockResolvedValue({ ...artifact, status: "READY", actualSizeBytes: 100 });
  await expect(service.complete({ projectId, artifactId, now: NOW })).resolves.toEqual({
    status: "SOURCE_READY",
    actualSizeBytes: 100,
  });
  expect(files.inspectFile).not.toHaveBeenCalled();
  expect(repository.recordAudit).not.toHaveBeenCalled();
});
```

Also prove missing/INVALID/DELETED artifacts fail without mutation, retryable provider/429/reauth errors preserve UPLOADING, and no returned/audited value contains a provider file ID or provider body.

- [ ] **Step 5: Run finalization tests and verify RED**

Run: `cd web; npm test -- --run src/lib/application/uploads.test.ts`

Expected: new completion tests fail because the result classifier is absent.

- [ ] **Step 6: Implement the exact evidence classifier and cancellation**

Use a pure helper before mutations:

```ts
function expectedSourceProperties(projectId: string, artifactId: string) {
  return {
    ytbVpsProjectId: projectId,
    ytbVpsArtifactId: artifactId,
    ytbVpsRole: "source",
    schema: "1",
  } as const;
}

function classifyEvidence(artifact: Artifact, remote: VerifiedDriveFile): "READY" | "PENDING" {
  const expectedName = `source.${artifact.displayName.split(".").at(-1)!.toLowerCase()}`;
  const identityMatches = remote.id === artifact.driveFileId &&
    remote.parentIds.length === 1 && remote.parentIds[0] === artifact.driveParentId &&
    remote.name === expectedName && remote.mimeType === artifact.mimeType &&
    remote.trashed === false &&
    JSON.stringify(remote.appProperties) === JSON.stringify(
      expectedSourceProperties(artifact.projectId, artifact.id),
    );
  if (!identityMatches || remote.sizeBytes > artifact.expectedSizeBytes) {
    throw new AppError("UPLOAD_REMOTE_MISMATCH", 409);
  }
  return remote.sizeBytes === artifact.expectedSizeBytes ? "READY" : "PENDING";
}
```

Do not rely on object insertion order in production: implement exact key/value comparison. Catch only conclusive `UPLOAD_REMOTE_MISMATCH` to mark an owned pending artifact invalid and audit once; rethrow provider errors unchanged. Cancellation returns idempotently for DELETED, rejects READY/INVALID, freshly revalidates exact identity/ownership, deletes remotely, marks DELETED, and records one sanitized `UPLOAD_CANCELLED` audit.

- [ ] **Step 7: Write failing strict route tests**

All three routes use:

```ts
const BODY_BYTES = 1_024;
const uuid = z.string().uuid();
const completionBody = z.object({ artifactId: uuid }).strict();
```

Tests prove authentication before Origin/body/service, exact Origin, UUID path and artifact IDs, streamed body caps, no-store on every response, no-referrer on session response, exact session JSON, completion HTTP 200/202, cancellation idempotency, and stable error bodies only.

- [ ] **Step 8: Run route tests and verify RED**

Run:

```powershell
cd web
npm test -- --run src/app/api/v1/projects/[id]/upload-session/route.test.ts src/app/api/v1/projects/[id]/upload-complete/route.test.ts src/app/api/v1/projects/[id]/upload-cancel/route.test.ts
```

Expected: FAIL because the routes do not exist.

- [ ] **Step 9: Implement routes, verify GREEN, and commit**

Completion mapping is exact:

```ts
const result = await service.complete({ projectId, artifactId: body.artifactId, now: new Date() });
return NextResponse.json(result, {
  status: result.status === "SOURCE_READY" ? 200 : 202,
  headers: { "cache-control": "no-store" },
});
```

Run:

```powershell
cd web
npm test -- --run src/lib/application/uploads.test.ts src/lib/application/free-tier-health.test.ts src/app/api/v1/projects
npm run typecheck
npm run lint
git add src/test/fakes/fake-google-drive.ts src/lib/application/uploads.ts src/lib/application/uploads.test.ts src/app/api/v1/projects
git commit -m "feat(web): finalize direct Drive uploads by metadata"
```

---

### Task 5: Persist resumable capabilities only in IndexedDB

**Files:**
- Modify: `web/package.json`
- Modify: `web/package-lock.json`
- Create: `web/src/lib/browser/upload-store.ts`
- Create: `web/src/lib/browser/upload-store.test.ts`

**Interfaces:**
- Consumes: bounded session response and browser file identity.
- Produces: `UploadSessionStore` over `ytb-vps-upload-v1` version 1.

- [ ] **Step 1: Add the exact test dependency**

Run: `cd web; npm install --save-dev --save-exact fake-indexeddb@6.2.5; npm ls fake-indexeddb`

Expected: package and lockfile contain exactly `6.2.5`; dependency listing exits 0.

- [ ] **Step 2: Write failing storage-boundary tests**

```ts
export type StoredUploadSession = Readonly<{
  projectId: string;
  artifactId: string;
  sessionUri: string;
  fileIdentity: Readonly<{
    displayName: string;
    sizeBytes: number;
    mimeType: string;
    lastModified: number;
  }>;
  nextOffset: number;
  chunkBytes: 8_388_608;
  expiresAt: string;
}>;

export interface UploadSessionStore {
  get(projectId: string, artifactId: string): Promise<StoredUploadSession | null>;
  put(value: StoredUploadSession): Promise<void>;
  delete(projectId: string, artifactId: string): Promise<void>;
  list(): Promise<readonly StoredUploadSession[]>;
}

it("round-trips only the bounded capability record", async () => {
  await store.put(record);
  await expect(store.get(record.projectId, record.artifactId)).resolves.toEqual(record);
  expect(Object.keys((await store.list())[0]!)).toEqual([
    "projectId", "artifactId", "sessionUri", "fileIdentity",
    "nextOffset", "chunkBytes", "expiresAt",
  ]);
});

it.each([malformedUri, wrongChunkSize, offsetBeyondFile, expiredRecord])(
  "deletes malformed or expired record %#",
  async (value) => {
    await rawPut(value);
    await expect(store.get(value.projectId, value.artifactId)).resolves.toBeNull();
  },
);
```

Also assert no index contains `sessionUri`, no localStorage access occurs, IDs are canonical UUIDs, session URI is exact HTTPS `www.googleapis.com/upload/drive/v3/files/...` with one bounded `upload_id`, and dates are canonical/non-expired.

- [ ] **Step 3: Run tests and verify RED**

Run: `cd web; npm test -- --run src/lib/browser/upload-store.test.ts`

Expected: FAIL because the store module does not exist.

- [ ] **Step 4: Implement version-1 storage and verify GREEN**

Open database `ytb-vps-upload-v1`, object store `sessions`, keyPath `key`, where `key` is `${projectId}:${artifactId}`. Strip the internal key before returning. Validate every write and every read; delete invalid/expired rows in the same operation. Never create an index over URI or upload ID.

Run:

```powershell
cd web
npm test -- --run src/lib/browser/upload-store.test.ts
npm run typecheck
git add package.json package-lock.json src/lib/browser/upload-store.ts src/lib/browser/upload-store.test.ts
git commit -m "feat(web): persist resumable upload capability"
```

---

### Task 6: Build the ambiguous-final resumable coordinator

**Files:**
- Create: `web/src/lib/browser/resumable-uploader.ts`
- Create: `web/src/lib/browser/resumable-uploader.test.ts`

**Interfaces:**
- Consumes: a selected `File`, `StoredUploadSession`, `UploadSessionStore`, direct Drive fetch, and small same-origin session/complete/cancel APIs.
- Produces: `ResumableUploader` with upload/resume/pause/cancel/finalize state and `PAUSED_VERIFYING` recovery.

- [ ] **Step 1: Write failing chunk and finalization tests**

```ts
export type UploadSnapshot = Readonly<{
  phase: "IDLE" | "UPLOADING" | "PAUSED" | "PAUSED_ERROR" |
    "VERIFYING" | "PAUSED_VERIFYING" | "READY" | "CANCELLED";
  committedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  publicCode: string | null;
}>;

export interface UploadControlPlaneApi {
  renewSession(projectId: string, identity: StoredUploadSession["fileIdentity"]):
    Promise<Pick<StoredUploadSession, "artifactId" | "sessionUri" | "chunkBytes" | "expiresAt">>;
  complete(projectId: string, artifactId: string): Promise<
    | Readonly<{ status: "SOURCE_READY"; actualSizeBytes: number }>
    | Readonly<{ status: "UPLOAD_PENDING"; retryAfterMs: 1_000 }>
  >;
  cancel(projectId: string, artifactId: string): Promise<void>;
}
```

Core tests:

```ts
it("finalizes after a readable final 201", async () => {
  fetcher.queue(response(201));
  api.complete.mockResolvedValue({ status: "SOURCE_READY", actualSizeBytes: file.size });
  await uploader.start(file, session);
  expect(api.complete).toHaveBeenCalledOnce();
  expect(await store.get(session.projectId, session.artifactId)).toBeNull();
  expect(uploader.snapshot().phase).toBe("READY");
});

it("treats a rejected final fetch as ambiguous and trusts server metadata", async () => {
  fetcher.queue(new TypeError("Failed to fetch"));
  api.complete.mockResolvedValue({ status: "SOURCE_READY", actualSizeBytes: file.size });
  await uploader.start(file, session);
  expect(api.complete).toHaveBeenCalledOnce();
  expect(fetcher.requests).toHaveLength(1);
  expect(uploader.snapshot().phase).toBe("READY");
});

it("resumes from readable Range when metadata is still pending", async () => {
  fetcher.queue(new TypeError("Failed to fetch"), response(308, { Range: "bytes=0-262143" }), response(201));
  api.complete
    .mockResolvedValueOnce({ status: "UPLOAD_PENDING", retryAfterMs: 1_000 })
    .mockResolvedValueOnce({ status: "SOURCE_READY", actualSizeBytes: file.size });
  await uploader.start(file, session);
  expect(fetcher.requests[1]!.headers.get("content-range")).toBe(`*/${file.size}`);
  expect(fetcher.requests[2]!.headers.get("content-range"))
    .toBe(`bytes 262144-${file.size - 1}/${file.size}`);
});

it("retains the capability in PAUSED_VERIFYING after five unresolved attempts", async () => {
  fetcher.always(new TypeError("Failed to fetch"));
  api.complete.mockResolvedValue({ status: "UPLOAD_PENDING", retryAfterMs: 1_000 });
  await expect(uploader.start(file, session)).rejects.toMatchObject({
    code: "UPLOAD_RETRY_EXHAUSTED",
  });
  expect(uploader.snapshot().phase).toBe("PAUSED_VERIFYING");
  expect(await store.get(session.projectId, session.artifactId)).not.toBeNull();
});
```

Also cover exact 8 MiB/final ranges, readable 308 offset persistence, null/malformed Range, no `Content-Length` or `Authorization`, network/5xx query, 429 delay, 400/403/404 renewal counted in the same ceiling, pause before next chunk, file-identity mismatch, reload at `nextOffset === total` finalizing before bytes, cancel retention on API failure, timer/listener disposal, and no URI in snapshots/errors.

For every renewed session, assert that the stored `sessionUri` and `expiresAt`
are replaced and `nextOffset` resets to `0`; a new Drive resumable session never
inherits an offset acknowledged by an expired session.

- [ ] **Step 2: Run coordinator tests and verify RED**

Run: `cd web; npm test -- --run src/lib/browser/resumable-uploader.test.ts`

Expected: FAIL because the coordinator module does not exist.

- [ ] **Step 3: Implement the state machine**

Inject all effects:

```ts
export type ResumableUploaderDependencies = Readonly<{
  fetcher: typeof fetch;
  store: UploadSessionStore;
  api: UploadControlPlaneApi;
  now: () => number;
  random: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}>;
```

Algorithm:

```ts
// Recovery or pending verification
if (record.nextOffset === file.size) {
  const completion = await api.complete(record.projectId, record.artifactId);
  if (completion.status === "SOURCE_READY") return finishReady();
}

// Non-final acknowledgement
if (response.status === 308) {
  const nextOffset = parseAcknowledgedRange(response.headers.get("range"));
  await store.put({ ...record, nextOffset });
  continue;
}

// Final response is either readable success or an ambiguous fetch rejection.
if (isFinalChunk && (response?.status === 200 || response?.status === 201 || fetchRejected)) {
  transition("VERIFYING");
  const completion = await api.complete(record.projectId, record.artifactId);
  if (completion.status === "SOURCE_READY") return finishReady();
  await querySessionOrRetryMetadata();
}
```

Use `parseAcknowledgedRange` and `nextRetry`; never infer committed bytes from bytes sent. Delete IndexedDB only after `SOURCE_READY` or confirmed cancellation.

- [ ] **Step 4: Verify GREEN and commit**

```powershell
cd web
npm test -- --run src/lib/browser/upload-store.test.ts src/lib/browser/resumable-uploader.test.ts
npm run typecheck
npm run lint
git add src/lib/browser/resumable-uploader.ts src/lib/browser/resumable-uploader.test.ts
git commit -m "feat(web): recover ambiguous Drive completion"
```

---

### Task 7: Pass the revised production metadata-finalization gate

**Files:**
- Create temporarily, then delete: `web/src/app/api/v1/projects/[id]/metadata-gate-cleanup/route.ts`
- Create temporarily, then delete: `web/src/app/api/v1/projects/[id]/metadata-gate-cleanup/route.test.ts`
- Modify temporarily, then restore: `web/src/lib/config/env.ts`
- Modify temporarily, then restore: `web/src/lib/config/env.test.ts`
- Modify: `docs/rebuild/AUDIT-LOG.md`

**Interfaces:**
- Consumes: production OAuth connection, project/session/completion APIs, direct Drive upload, and the exact metadata classifier.
- Produces: sanitized evidence that a CORS-hidden final response becomes `SOURCE_READY` without video bytes crossing Vercel, followed by complete probe cleanup.

- [ ] **Step 1: Write failing temporary cleanup-route tests**

The temporary route exists only while `DRIVE_METADATA_GATE_ENABLED` is exactly `true`. Tests prove disabled 404, admin-before-Origin/body, UUID path/body, exact remote ownership revalidation, deletion, `markSourceDeleted`, no-store, and no file ID/session URI/provider body in output or logs.

```ts
const cleanupBody = z.object({ artifactId: z.string().uuid() }).strict();
if (!env.driveMetadataGateEnabled) {
  return new NextResponse(null, { status: 404, headers: { "cache-control": "no-store" } });
}
```

- [ ] **Step 2: Run temporary route tests and verify RED**

Run: `cd web; npm test -- --run src/app/api/v1/projects/[id]/metadata-gate-cleanup/route.test.ts`

Expected: FAIL because the temporary route and flag do not exist.

- [ ] **Step 3: Implement the minimum temporary cleanup surface**

Authenticate and validate before constructing dependencies. Load the artifact from the trusted repository, require SOURCE plus READY/PENDING/UPLOADING, refresh the server access token, inspect exact ID/parent/name/MIME/properties, delete remotely, mark source DELETED, and return only `{ status: "DELETED" }`. Never accept a Drive file ID from the request.

- [ ] **Step 4: Verify locally and deploy the controlled gate**

Before changing Production, record the current clean production deployment URL
and current Git commit in private operator notes. If any gate expectation
fails, remove the temporary flag and files, redeploy that clean commit, and
leave all pending Drive/IndexedDB content intact; no schema downgrade or remote
content deletion is part of rollback.

Run:

```powershell
cd web
npm test -- --run src/app/api/v1/projects/[id]/metadata-gate-cleanup/route.test.ts
npm run typecheck
npm run lint
npm run build
npx --yes vercel@latest env add DRIVE_METADATA_GATE_ENABLED production
npx --yes vercel@latest --prod --yes
```

Set the temporary value to `true`. Expected: deployment is READY and the cleanup route is unavailable unless authenticated and exact-origin.

- [ ] **Step 5: Run the browser-origin two-chunk gate without exposing capabilities**

From the authenticated production app origin, execute browser code that:

```ts
const file = new File([new Uint8Array(524_288)], "metadata-gate.mp4", {
  type: "video/mp4",
  lastModified: Date.now(),
});
const projectResponse = await fetch("/api/v1/projects", {
  method: "POST",
  headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
  body: JSON.stringify({ name: "Metadata gate" }),
});
const { project } = await projectResponse.json();
const sessionResponse = await fetch(`/api/v1/projects/${project.id}/upload-session`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    fileName: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    lastModified: file.lastModified,
  }),
});
const { artifactId, sessionUri } = await sessionResponse.json();
const first = await fetch(sessionUri, {
  method: "PUT",
  headers: { "content-type": file.type, "content-range": "bytes 0-262143/524288" },
  body: file.slice(0, 262_144),
});
if (first.status !== 308 || first.headers.get("range") !== "bytes=0-262143") throw new Error("RANGE_GATE");
let finalReadableStatus: number | null = null;
try {
  finalReadableStatus = (await fetch(sessionUri, {
    method: "PUT",
    headers: { "content-type": file.type, "content-range": "bytes 262144-524287/524288" },
    body: file.slice(262_144),
  })).status;
} catch {
  finalReadableStatus = null;
}
let completionStatus = 0;
for (let attempt = 1; attempt <= 5; attempt += 1) {
  const completion = await fetch(`/api/v1/projects/${project.id}/upload-complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ artifactId }),
  });
  completionStatus = completion.status;
  if (completionStatus === 200) break;
  if (completionStatus !== 202 || attempt === 5) throw new Error("METADATA_FINALIZE_GATE");
  await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** (attempt - 1)));
}
const cleanup = await fetch(`/api/v1/projects/${project.id}/metadata-gate-cleanup`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ artifactId }),
});
if (cleanup.status !== 200) throw new Error("CLEANUP_GATE");
return {
  firstStatus: first.status,
  rangeReadable: true,
  finalReadableStatus,
  completionStatus,
  cleanupStatus: cleanup.status,
};
```

Do not print or return `project.id`, `artifactId`, `sessionUri`, response bodies, account data, or provider headers. Inspect Vercel request sizes and confirm neither 262,144-byte body reached a function.

- [ ] **Step 6: Remove every temporary surface before recording success**

Delete the temporary route/test and env parser fields with `apply_patch`. Remove the Production flag:

```powershell
cd web
npx --yes vercel@latest env rm DRIVE_METADATA_GATE_ENABLED production --yes
rg -n "metadata-gate|DRIVE_METADATA_GATE_ENABLED" src scripts
```

Expected: `rg` returns no match.

- [ ] **Step 7: Re-run all gates and deploy the clean build**

```powershell
cd web
npm test -- --maxWorkers=1
npm run typecheck
npm run lint
npm run build
npx --yes vercel@latest --prod --yes
```

Expected: all tests pass; production route list contains no metadata-gate route; production root returns 200; temporary route returns 404; temporary env flag is absent.

- [ ] **Step 8: Record sanitized evidence and commit it**

Append only timestamp, production hostname, first status, Range-readable boolean, final-readable status or `CORS_HIDDEN`, completion status 200, exact verified size 524288, cleanup status 200, and Vercel-media-body absence to `docs/rebuild/AUDIT-LOG.md`.

```powershell
git add docs/rebuild/AUDIT-LOG.md
git diff --cached --check
git commit -m "test(web): verify metadata-only Drive finalization"
```

---

### Task 8: Whole-slice verification and handoff to remaining CP-2 work

**Files:**
- Modify only if evidence requires correction: `docs/rebuild/AUDIT-LOG.md`

**Interfaces:**
- Consumes: committed Tasks 1-7 and the approved design.
- Produces: a reviewed, secret-clean checkpoint ready for the parent CP-2 plan's authenticated health route and dashboard tasks.

- [ ] **Step 1: Run the complete local regression matrix**

```powershell
cd web
npm test -- --maxWorkers=1
npm run typecheck
npm run lint
npm run build
npm audit --audit-level=low
```

Expected: zero test failures, zero type/lint/build failures, and zero audit vulnerabilities.

- [ ] **Step 2: Run secret and tracked-path scans**

```powershell
cd ..
rg -n "sk-[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_-]{20,}|refresh_token.{0,20}[:=].+|upload_id=|sessionUri.{0,20}https://|M@nhthien2005" web .github docs/rebuild
git ls-files | rg "(^|/)(\.env|resources|\.vercel)(/|$)"
git diff --check
```

Expected: no live secret/capability match and no forbidden tracked path. Synthetic test strings remain visibly non-secret and bounded.

- [ ] **Step 3: Review requirements line by line**

Confirm:

```text
[ ] No video body traversed Vercel.
[ ] No access token reached the browser.
[ ] Final CORS ambiguity resolved only through server metadata.
[ ] Smaller remote size remained pending.
[ ] Conclusive mismatch failed closed.
[ ] Retry ceiling and PAUSED_VERIFYING preserved IndexedDB.
[ ] Temporary route and flag were removed.
[ ] Production clean deployment returned 200/404 as expected.
```

- [ ] **Step 4: Request code review before continuing**

Invoke `superpowers:requesting-code-review` against the commits produced by this plan. Address only verified Critical/Important findings, rerun the full matrix, then continue with Task 10 (`authenticated free-tier health orchestration`) and Task 11 (`Drive/project/upload dashboard`) in `docs/superpowers/plans/2026-07-19-cp2-google-drive-control-plane.md`.
