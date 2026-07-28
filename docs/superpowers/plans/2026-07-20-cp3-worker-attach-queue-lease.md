# CP-3 Worker Attach, Queue, and Lease Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the administrator generate one short-lived VPS install command, enroll one native worker, see its doctor/heartbeat state, queue source-ready projects, and protect every worker mutation with an expiring fenced lease.

**Architecture:** Extend the existing Next.js modular monolith and Neon repository with worker enrollment, session authentication, queue, and lease use cases. The Ubuntu worker uses Python 3.10 standard-library HTTPS polling and stores only its own bounded session secret locally; Vercel never opens SSH or waits on long work. CP-3 deliberately stops before media execution: a control-only worker can enroll and heartbeat, while claim is enabled only for a worker that reports the exact `pipelineBridgeVersion` expected by the control plane.

**Tech Stack:** Next.js 16.2.10; React 19.2; strict TypeScript 5.8; Zod 4.1; Neon/Postgres; PGlite; Vitest 3.2; Python 3.10 standard library; unittest; Ubuntu 22.04 systemd; GitHub source pinned by a 40-character commit.

## Global Constraints

- Preserve the approved design in `docs/superpowers/specs/2026-07-19-vercel-drive-vps-control-plane-design.md`.
- One administrator, one active worker, and one active heavyweight job only.
- Enrollment tokens are random 256-bit values, expire after 10 minutes, are stored only as HMAC-SHA-256 digests, and are consumed exactly once.
- Worker session secrets are random 256-bit values, expire within 24 hours, are stored only as HMAC-SHA-256 digests in Neon, and are written mode `0600` under a mode `0700` worker directory.
- Worker HTTPS authentication uses `Authorization: Bearer`; bearer values never enter logs, audits, URLs, React props, fixtures, or error text.
- Leases last 90 seconds; healthy workers heartbeat and renew every 30 seconds; every job mutation carries the current monotonically increasing fencing token.
- A worker that loses or cannot renew its lease must stop at the next safe boundary. A stale worker can never update progress, checkpoints, completion, or failure.
- Vercel never SSHes into the VPS, accepts video bytes, performs long polling, or waits on worker execution.
- Worker release installation is native, idempotent, non-Docker, and pinned to `WORKER_RELEASE_REPOSITORY` plus `WORKER_RELEASE_COMMIT`.
- `OPENAI_API_KEY`, `AZURE_OPENAI_API_KEY`, and `CODEX_API_KEY` remain forbidden.
- CP-3 does not claim media processing is complete. It produces the secure control channel required by the subsequent worker-bridge plan.
- Use red-green-refactor TDD. Each task ends in one single-purpose Conventional Commit.
- Never stage `.env`, `.superpowers`, `resources`, credentials, media, runtime state, or generated worker secret files.

---

## Locked file structure

```text
web/src/
  app/api/v1/projects/[id]/jobs/route.ts
  app/api/v1/workers/enrollment/route.ts
  app/api/v1/workers/[id]/revoke/route.ts
  app/api/v1/worker/enroll/route.ts
  app/api/v1/worker/heartbeat/route.ts
  app/api/v1/worker/claim/route.ts
  app/api/v1/worker/jobs/[id]/renew/route.ts
  app/api/v1/worker/jobs/[id]/progress/route.ts
  components/worker-card.tsx
  components/job-list.tsx
  lib/application/worker-control.ts
  lib/application/job-queue.ts
  lib/domain/worker.ts
  lib/http/worker-auth.ts
  lib/repositories/worker-control-plane.ts
  lib/repositories/neon-worker-control-plane.ts
  lib/security/worker-secret.ts
  lib/db/schema.sql
src/ytb_vps_v2/
  adapters/control_plane/http.py
  interfaces/worker.py
  interfaces/cli.py
ops/native-v2/
  bootstrap-worker.sh
  ytb-vps-worker.service
tests_v2/
  adapters/control_plane/test_http.py
  interfaces/test_worker.py
  test_worker_bootstrap.py
```

Each production file above owns one responsibility. Browser/admin routes never validate worker bearer credentials; worker routes never use the admin cookie.

### Task 1: Lock worker, enrollment, and lease domain contracts

**Files:**
- Create: `web/src/lib/domain/worker.ts`
- Create: `web/src/lib/domain/worker.test.ts`
- Modify: `web/src/lib/domain/control-plane.ts`
- Modify: `web/src/lib/domain/control-plane.test.ts`
- Modify: `web/src/lib/domain/errors.ts`
- Modify: `web/src/lib/domain/errors.test.ts`
- Modify: `web/src/lib/config/env.ts`
- Modify: `web/src/lib/config/env.test.ts`
- Modify: `web/.env.example`

**Interfaces:**
- Consumes: existing `JobState`, `WorkerState`, `AppError`, and `parseServerEnv`.
- Produces: `WorkerCapabilities`, `WorkerDoctorReport`, `WorkerView`, `WorkerLease`, `parseWorkerCapabilities`, `parseWorkerDoctorReport`, and CP-3 environment fields.

- [ ] **Step 1: Write failing domain/config tests**

```ts
it("accepts the exact native RTX worker capability contract", () => {
  expect(parseWorkerCapabilities({
    protocolVersion: 1,
    pipelineBridgeVersion: "cp3-control-only",
    os: "ubuntu-22.04",
    arch: "x86_64",
    gpuName: "NVIDIA GeForce RTX 3060",
    vramMiB: 12288,
    cudaVersion: "12.4",
    nvenc: true,
  })).toMatchObject({ protocolVersion: 1, nvenc: true });
});

it.each([
  [{ protocolVersion: 2 }, "protocol"],
  [{ protocolVersion: 1, gpuName: "" }, "gpu"],
  [{ protocolVersion: 1, vramMiB: 0 }, "vram"],
])("rejects malformed worker capability evidence", (value) => {
  expect(() => parseWorkerCapabilities(value)).toThrow();
});

it("accepts only canonical worker security configuration", () => {
  const env = parseServerEnv({
    ...VALID_CP2_ENV,
    WORKER_AUTH_KEY_V1: "A".repeat(43),
    WORKER_RELEASE_REPOSITORY: "https://github.com/manhthien2005/ytb-vps-scene.git",
    WORKER_RELEASE_COMMIT: "a".repeat(40),
    WORKER_PIPELINE_BRIDGE_VERSION: "cp3-control-only",
  });
  expect(env.workerReleaseCommit).toHaveLength(40);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `cd web; npm test -- src/lib/domain/worker.test.ts src/lib/domain/control-plane.test.ts src/lib/domain/errors.test.ts src/lib/config/env.test.ts`

Expected: FAIL because the worker domain and CP-3 environment fields do not exist.

- [ ] **Step 3: Implement the closed domain types and parsers**

Create exact readonly types:

```ts
export type WorkerCapabilities = Readonly<{
  protocolVersion: 1;
  pipelineBridgeVersion: string;
  os: "ubuntu-22.04";
  arch: "x86_64";
  gpuName: string;
  vramMiB: number;
  cudaVersion: string;
  nvenc: boolean;
}>;

export type WorkerDoctorReport = Readonly<{
  status: "PASS" | "DEGRADED" | "FAIL";
  reasonCodes: readonly string[];
  observedAt: string;
}>;

export type WorkerView = Readonly<{
  id: string;
  state: WorkerState;
  accountLabel: string | null;
  capabilities: WorkerCapabilities;
  doctor: WorkerDoctorReport;
  lastHeartbeatAt: string;
  sessionExpiresAt: string;
}>;

export type WorkerLease = Readonly<{
  jobId: string;
  workerId: string;
  fencingToken: number;
  expiresAt: string;
}>;
```

Use strict Zod objects with no passthrough fields, bounded strings, safe integers, canonical ISO timestamps, and reason codes matching `^[A-Z][A-Z0-9_]{0,79}$`.

- [ ] **Step 4: Extend configuration and public error vocabulary**

Add these exact production values to `ServerEnv` and `.env.example`:

```text
WORKER_AUTH_KEY_V1=<43-char-base64url-32-byte-key>
WORKER_RELEASE_REPOSITORY=https://github.com/manhthien2005/ytb-vps-scene.git
WORKER_RELEASE_COMMIT=<40-lowercase-hex-commit>
WORKER_PIPELINE_BRIDGE_VERSION=cp3-control-only
```

Add stable public codes: `WORKER_ENROLLMENT_INVALID`, `WORKER_AUTH_REQUIRED`, `WORKER_SESSION_EXPIRED`, `WORKER_REVOKED`, `WORKER_DOCTOR_FAILED`, `WORKER_INCOMPATIBLE`, `LEASE_LOST`, `NO_JOB_AVAILABLE`, and `JOB_NOT_QUEUEABLE`.

- [ ] **Step 5: Verify and commit**

Run: `cd web; npm test -- src/lib/domain/worker.test.ts src/lib/domain/control-plane.test.ts src/lib/domain/errors.test.ts src/lib/config/env.test.ts; npm run typecheck`

Expected: focused tests PASS and typecheck exits 0.

Commit:

```powershell
git add web/src/lib/domain web/src/lib/config web/.env.example
git commit -m "feat(web): define worker control contracts"
```

### Task 2: Add worker secret hashing and strict bearer authentication

**Files:**
- Create: `web/src/lib/security/worker-secret.ts`
- Create: `web/src/lib/security/worker-secret.test.ts`
- Create: `web/src/lib/http/worker-auth.ts`
- Create: `web/src/lib/http/worker-auth.test.ts`

**Interfaces:**
- Consumes: canonical `WORKER_AUTH_KEY_V1` and repository worker-session lookup.
- Produces: `generateBearerSecret()`, `digestBearerSecret(secret, key)`, `readWorkerBearer(request)`, and `requireWorkerSession(request, repository, key, now)`.

- [ ] **Step 1: Write failing secret/auth tests**

```ts
it("generates 256-bit base64url bearer values and stores only deterministic digests", () => {
  const secret = generateBearerSecret(() => Buffer.alloc(32, 7));
  expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(digestBearerSecret(secret, "A".repeat(43))).toMatch(/^[0-9a-f]{64}$/);
});

it.each([null, "Basic abc", "Bearer", "Bearer a b", "Bearer short"])(
  "rejects malformed Authorization without repository access",
  async (authorization) => {
    const request = new Request("https://app.example/api/v1/worker/heartbeat", {
      headers: authorization === null ? {} : { authorization },
    });
    await expect(requireWorkerSession(request, repository, KEY, NOW))
      .rejects.toMatchObject({ code: "WORKER_AUTH_REQUIRED", status: 401 });
    expect(repository.authenticateWorker).not.toHaveBeenCalled();
  },
);
```

- [ ] **Step 2: Run and verify RED**

Run: `cd web; npm test -- src/lib/security/worker-secret.test.ts src/lib/http/worker-auth.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement minimal constant-boundary helpers**

`readWorkerBearer` accepts exactly `Bearer <43-char-base64url>` and never includes the rejected value in an error. `digestBearerSecret` uses HMAC-SHA-256 with the decoded 32-byte key and domain prefix `ytb-vps-worker-secret-v1\0`.

```ts
export interface WorkerSessionRepository {
  authenticateWorker(sessionDigest: string, now: Date): Promise<WorkerView | null>;
}

export async function requireWorkerSession(
  request: Request,
  repository: WorkerSessionRepository,
  key: string,
  now: Date,
): Promise<WorkerView> {
  const digest = digestBearerSecret(readWorkerBearer(request), key);
  const worker = await repository.authenticateWorker(digest, now);
  if (worker === null) throw new AppError("WORKER_SESSION_EXPIRED", 401);
  if (worker.state === "REVOKED") throw new AppError("WORKER_REVOKED", 401);
  return worker;
}
```

- [ ] **Step 4: Verify and commit**

Run: `cd web; npm test -- src/lib/security/worker-secret.test.ts src/lib/http/worker-auth.test.ts; npm run typecheck`

Commit:

```powershell
git add web/src/lib/security/worker-secret* web/src/lib/http/worker-auth*
git commit -m "feat(web): authenticate ephemeral workers"
```

### Task 3: Install the atomic Neon enrollment, worker, queue, and lease schema

**Files:**
- Modify: `web/src/lib/db/schema.sql`
- Modify: `web/src/lib/db/schema.test.ts`
- Create: `web/src/lib/repositories/worker-control-plane.ts`
- Create: `web/src/lib/repositories/neon-worker-control-plane.ts`
- Create: `web/src/lib/repositories/neon-worker-control-plane.test.ts`
- Modify: `web/src/test/fakes/fake-control-plane.ts`

**Interfaces:**
- Consumes: Task 1 domain values and Task 2 secret digests.
- Produces: `WorkerControlPlaneRepository` with atomic enrollment, heartbeat, queue, claim, renew, progress, revoke, and expiry operations.

- [ ] **Step 1: Write failing migration and repository tests**

Cover these behaviors with PGlite before editing SQL:

```ts
it("consumes one enrollment token exactly once under concurrency", async () => {
  const results = await Promise.all([
    repository.enrollWorker(input),
    repository.enrollWorker(input),
  ]);
  expect(results.filter((value) => value?.outcome === "ENROLLED")).toHaveLength(1);
});

it("increments the fencing token when an expired lease is reclaimed", async () => {
  const first = await repository.claimJob(workerA.id, NOW, "bridge-v1");
  const second = await repository.claimJob(workerB.id, AFTER_EXPIRY, "bridge-v1");
  expect(second?.lease.fencingToken).toBe(first!.lease.fencingToken + 1);
});

it("rejects progress from a stale lease owner", async () => {
  await expect(repository.updateJobProgress({
    workerId: workerA.id,
    jobId,
    fencingToken: 1,
    state: "OCR",
    progressPercent: 20,
    now: AFTER_TAKEOVER,
  })).resolves.toBe("LEASE_LOST");
});
```

- [ ] **Step 2: Run and verify RED**

Run: `cd web; npm test -- src/lib/db/schema.test.ts src/lib/repositories/neon-worker-control-plane.test.ts`

Expected: FAIL because schema version 7 and repository methods do not exist.

- [ ] **Step 3: Add migration v7**

Append transactional, idempotent SQL that creates:

```sql
create table if not exists worker_enrollment_tokens (
  token_digest text primary key check (token_digest ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (consumed_at is null or revoked_at is null)
);

create table if not exists workers (
  id text primary key check (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  session_digest text not null unique check (session_digest ~ '^[0-9a-f]{64}$'),
  state text not null check (state in ('SETTING_UP','DOCTOR_FAILED','READY','BUSY','OFFLINE','REVOKED')),
  account_label text check (account_label is null or length(account_label) between 1 and 80),
  capabilities jsonb not null check (pg_column_size(capabilities) <= 4096),
  doctor_report jsonb not null check (pg_column_size(doctor_report) <= 4096),
  session_expires_at timestamptz not null,
  heartbeat_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table jobs add column if not exists project_id text references projects(id);
alter table jobs add column if not exists active_stage text;
alter table jobs add column if not exists error_code text;
alter table jobs add column if not exists request_key_digest text unique;

create table if not exists job_leases (
  job_id text primary key references jobs(id),
  worker_id text not null references workers(id),
  fencing_token bigint not null check (fencing_token > 0),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists job_attempts (
  id bigint generated always as identity primary key,
  job_id text not null references jobs(id),
  worker_id text not null references workers(id),
  fencing_token bigint not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  outcome text,
  error_code text
);
```

Use a SQL function for claim/reclaim that locks one queue candidate with `for update skip locked`, validates worker state/bridge version, increments from the prior fencing token, creates one attempt, and returns the assignment in one transaction.

- [ ] **Step 4: Implement the repository contract**

```ts
export interface WorkerControlPlaneRepository extends WorkerSessionRepository {
  createEnrollment(input: EnrollmentReservation): Promise<void>;
  enrollWorker(input: WorkerEnrollment): Promise<WorkerEnrollmentResult | null>;
  heartbeatWorker(input: WorkerHeartbeat): Promise<WorkerView | null>;
  listWorkers(now: Date): Promise<readonly WorkerView[]>;
  revokeWorker(workerId: string, now: Date): Promise<boolean>;
  queueProjectJob(input: QueueProjectJob): Promise<JobSummary>;
  claimJob(workerId: string, now: Date, bridgeVersion: string): Promise<JobAssignment | null>;
  renewLease(input: RenewLease): Promise<WorkerLease | null>;
  updateJobProgress(input: JobProgress): Promise<"UPDATED" | "LEASE_LOST">;
  expireWorkersAndLeases(now: Date): Promise<void>;
}
```

All database rows are parsed fail-closed. JSON objects are validated through Task 1 parsers before returning.

- [ ] **Step 5: Verify and commit**

Run: `cd web; npm test -- src/lib/db/schema.test.ts src/lib/repositories/neon-worker-control-plane.test.ts; npm run typecheck`

Commit:

```powershell
git add web/src/lib/db web/src/lib/repositories web/src/test/fakes
git commit -m "feat(web): persist worker leases and queue"
```

### Task 4: Implement application services for enrollment and fenced jobs

**Files:**
- Create: `web/src/lib/application/worker-control.ts`
- Create: `web/src/lib/application/worker-control.test.ts`
- Create: `web/src/lib/application/job-queue.ts`
- Create: `web/src/lib/application/job-queue.test.ts`

**Interfaces:**
- Consumes: `WorkerControlPlaneRepository`, free-tier health, secret helpers, and strict domain parsers.
- Produces: `WorkerControlService` and `JobQueueService` for both admin and worker routes.

- [ ] **Step 1: Write failing use-case tests**

```ts
it("returns a one-time command without persisting plaintext enrollment material", async () => {
  const expectedToken = Buffer.alloc(32, 7).toString("base64url");
  const result = await service.createEnrollment(NOW);
  expect(result.command).toContain("bootstrap-worker.sh");
  expect(result.command).not.toContain("Authorization");
  expect(repository.createEnrollment).toHaveBeenCalledWith(expect.objectContaining({
    tokenDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
  }));
  expect(result).not.toHaveProperty("token");
  expect(JSON.stringify(repository.createEnrollment.mock.calls)).not.toContain(expectedToken);
});

it("queues only a source-ready project while free-tier health is writable", async () => {
  await expect(queue.queueProject(PROJECT_ID, KEY, NOW)).resolves.toMatchObject({ state: "QUEUED" });
  expect(health.assertUploadAllowed).toHaveBeenCalledWith(0, NOW);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `cd web; npm test -- src/lib/application/worker-control.test.ts src/lib/application/job-queue.test.ts`

- [ ] **Step 3: Implement enrollment and heartbeat orchestration**

`createEnrollment` generates a token, stores only its digest with `expiresAt = now + 10 minutes`, and returns a shell-quoted command containing only the public app origin, public repository, pinned commit, and one-time token. `enroll` consumes it and returns `{ workerId, sessionSecret, sessionExpiresAt }` once. `heartbeat` validates strict capabilities/doctor evidence and moves the worker to `READY`, `SETTING_UP`, or `DOCTOR_FAILED`; it never trusts a client-supplied `BUSY` state.

- [ ] **Step 4: Implement queue/claim/renew/progress orchestration**

`queueProject` requires a source-ready project, fail-closed health, and a random idempotency key digest. `claim` refuses `DOCTOR_FAILED`, incompatible bridge versions, expired/revoked sessions, or control-only workers. `progress` calls `assertJobTransition`, allows nondecreasing progress only, and maps any repository fence loss to `AppError("LEASE_LOST", 409)`.

- [ ] **Step 5: Verify and commit**

Run: `cd web; npm test -- src/lib/application/worker-control.test.ts src/lib/application/job-queue.test.ts; npm run typecheck`

Commit:

```powershell
git add web/src/lib/application/worker-control* web/src/lib/application/job-queue*
git commit -m "feat(web): orchestrate worker enrollment and leases"
```

### Task 5: Expose bounded admin and worker APIs

**Files:**
- Create route and test pairs under the exact API paths listed in the locked file structure.

**Interfaces:**
- Consumes: Task 4 services, `requireAdmin`, `requireMutationOrigin`, `readStrictJson`, and `requireWorkerSession`.
- Produces: short JSON-only admin/worker HTTP contracts with `Cache-Control: no-store`.

- [ ] **Step 1: Write failing admin route tests**

Test that enrollment requires admin then exact Origin before parsing; the response includes one command and expiration but never a token field. Test project-job creation idempotency and rejection while source is not ready. Test revoke is replay-safe and never deletes Drive content.

```ts
expect(await POST(unauthenticated)).toMatchObject({ status: 401 });
const enrollmentBody = await enrollmentResponse.json();
expect(enrollmentBody.command).toMatch(/^curl -fsSL https:\/\//);
expect(JSON.stringify(enrollmentBody)).not.toContain("sessionSecret");
```

- [ ] **Step 2: Write failing worker route tests**

Test enroll body <= 4096 bytes, heartbeat body <= 8192 bytes, job progress body <= 2048 bytes, malformed bearer rejection before body parsing, session expiry, revoke, incompatible claim, lease renewal, and stale progress fencing.

- [ ] **Step 3: Run and verify RED**

Run: `cd web; npm test -- src/app/api/v1/workers src/app/api/v1/worker src/app/api/v1/projects/[id]/jobs/route.test.ts`

Expected: FAIL because routes do not exist.

- [ ] **Step 4: Implement route composition**

Admin routes use the admin cookie and exact Origin. Worker routes use only bearer auth. Every route catches `AppError`, returns only `{ code }`, applies `no-store`, and never returns repository rows. `POST /worker/claim` returns `204` when no job is available rather than an error body.

- [ ] **Step 5: Verify and commit**

Run: `cd web; npm test -- src/app/api/v1/workers src/app/api/v1/worker src/app/api/v1/projects/[id]/jobs/route.test.ts; npm run typecheck`

Commit:

```powershell
git add web/src/app/api/v1/workers web/src/app/api/v1/worker web/src/app/api/v1/projects
git commit -m "feat(web): expose worker control API"
```

### Task 6: Build the native Python control-plane client and worker loop

**Files:**
- Create: `src/ytb_vps_v2/adapters/control_plane/__init__.py`
- Create: `src/ytb_vps_v2/adapters/control_plane/http.py`
- Create: `src/ytb_vps_v2/interfaces/worker.py`
- Create: `tests_v2/adapters/control_plane/__init__.py`
- Create: `tests_v2/adapters/control_plane/test_http.py`
- Create: `tests_v2/interfaces/test_worker.py`
- Modify: `src/ytb_vps_v2/interfaces/cli.py`
- Modify: `tests_v2/test_cli.py`

**Interfaces:**
- Consumes: CP-3 worker HTTP endpoints.
- Produces: `ControlPlaneClient`, `WorkerCredentialStore`, `WorkerLoop`, and CLI commands `worker-enroll`, `worker-run`, `worker-status`, and `worker-detach`.

- [ ] **Step 1: Write failing HTTP boundary tests**

```python
def test_bearer_is_header_only_and_errors_never_echo_it(self) -> None:
    client = ControlPlaneClient("https://app.example", "synthetic-secret", transport=self.transport)
    self.transport.response = HttpResponse(401, b'{"code":"WORKER_SESSION_EXPIRED"}', {})
    with self.assertRaisesRegex(ControlPlaneError, "WORKER_SESSION_EXPIRED") as caught:
        client.heartbeat(self.evidence)
    self.assertNotIn("synthetic-secret", str(caught.exception))
    self.assertEqual(self.transport.last_headers["Authorization"], "Bearer synthetic-secret")
```

Cover HTTPS-only origins, no redirects to a different origin, 8 KiB response limit, JSON duplicate-key rejection, bounded timeouts, 429/5xx retry classification, and no proxy/environment credential forwarding.

- [ ] **Step 2: Write failing credential/loop tests**

Test atomic credential writes, directory `0700`, file `0600`, corrupted credential fail-closed, 30-second heartbeats, bounded no-job backoff, clean SIGTERM, and control-only behavior that never calls claim.

- [ ] **Step 3: Run and verify RED**

Run: `python -m unittest tests_v2.adapters.control_plane.test_http tests_v2.interfaces.test_worker tests_v2.test_cli -v`

- [ ] **Step 4: Implement the stdlib client and credential store**

Use `urllib.request` with an injected transport in tests, argument/data separation, explicit `Content-Type: application/json`, `Authorization` only for authenticated calls, a 15-second request timeout, bounded response reading, and closed JSON object parsing. Store this exact JSON shape atomically:

```json
{"schemaVersion":1,"origin":"https://app.example","workerId":"uuid","sessionSecret":"43-char-base64url","sessionExpiresAt":"canonical-iso"}
```

- [ ] **Step 5: Implement the control-only loop and CLI**

`worker-enroll` accepts origin and one-time token, submits strict local evidence, and writes the returned credential. `worker-run` sends doctor/heartbeat every 30 seconds. While `pipelineBridgeVersion == "cp3-control-only"`, it must not call claim. `worker-detach` attempts revoke/logout hooks, then removes only the credential root after anchored path validation.

- [ ] **Step 6: Verify and commit**

Run: `python -m unittest tests_v2.adapters.control_plane.test_http tests_v2.interfaces.test_worker tests_v2.test_cli -v; python -m compileall -q src tests_v2`

Commit:

```powershell
git add src/ytb_vps_v2/adapters/control_plane src/ytb_vps_v2/interfaces tests_v2
git commit -m "feat(v2): add native worker control client"
```

### Task 7: Add idempotent Ubuntu bootstrap and systemd service

**Files:**
- Create: `ops/native-v2/bootstrap-worker.sh`
- Create: `ops/native-v2/ytb-vps-worker.service`
- Create: `tests_v2/test_worker_bootstrap.py`
- Modify: `docs/rebuild/DEVELOPMENT.md`

**Interfaces:**
- Consumes: public repository URL, pinned commit, app origin, and one-time enrollment token.
- Produces: `/opt/ytb-vps/releases/<commit>`, `/opt/ytb-vps/current`, `/var/lib/ytb-vps`, `/etc/ytb-vps`, and an enabled least-privilege `ytb-vps-worker` service.

- [ ] **Step 1: Write failing bootstrap contract tests**

Assert the script uses `set -euo pipefail`, rejects non-Ubuntu-22.04/non-x86_64, validates a 40-lowercase-hex commit and HTTPS GitHub repository, checks out detached at the exact commit, installs a Python 3.10 venv, never uses Docker, never uses `curl | shell` internally, creates the service user without login, applies `0700/0600`, uses argument arrays/quoted variables, and switches `current` only after enrollment/status succeeds.

- [ ] **Step 2: Run and verify RED**

Run: `python -m unittest tests_v2.test_worker_bootstrap -v`

- [ ] **Step 3: Implement bootstrap and service**

The script accepts exactly four positional arguments: app origin, enrollment token, repository URL, and commit. It installs only `ca-certificates`, `git`, `python3.10`, and `python3.10-venv` in CP-3; CUDA/OCR/FFmpeg/Codex doctor dependencies remain owned by the later native media-worker release. The systemd unit uses `User=ytb-vps`, `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=strict`, writable `/var/lib/ytb-vps`, and restart backoff.

- [ ] **Step 4: Verify and commit**

Run: `python -m unittest tests_v2.test_worker_bootstrap -v; python -m compileall -q src tests_v2`

Commit:

```powershell
git add ops/native-v2/bootstrap-worker.sh ops/native-v2/ytb-vps-worker.service tests_v2/test_worker_bootstrap.py docs/rebuild/DEVELOPMENT.md
git commit -m "feat(ops): bootstrap the native control worker"
```

### Task 8: Replace the disabled VPS control with a safe attach dashboard

**Files:**
- Create: `web/src/components/worker-card.tsx`
- Create: `web/src/components/worker-card.test.tsx`
- Create: `web/src/components/job-list.tsx`
- Create: `web/src/components/job-list.test.tsx`
- Modify: `web/src/components/dashboard-types.ts`
- Modify: `web/src/components/dashboard-shell.tsx`
- Modify: `web/src/components/dashboard-shell.test.tsx`
- Modify: `web/src/app/page.tsx`
- Modify: `web/src/app/page.test.tsx`
- Modify: `web/src/app/globals.css`

**Interfaces:**
- Consumes: sanitized `WorkerView[]`, `JobSummary[]`, and admin APIs.
- Produces: Vietnamese attach/copy/revoke/queue status UI with no bearer or enrollment token rendered separately.

- [ ] **Step 1: Write failing component tests**

```tsx
it("creates one expiring install command and copies it without exposing a token field", async () => {
  render(<WorkerCard workers={[]} fetcher={fetcher} clipboard={clipboard} />);
  fireEvent.click(screen.getByRole("button", { name: "Tạo lệnh gắn VPS" }));
  expect(await screen.findByText(/Lệnh hết hạn/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Sao chép lệnh" }));
  expect(clipboard).toHaveBeenCalledWith(expect.stringMatching(/^curl -fsSL https:\/\//));
  expect(document.body.textContent).not.toContain("sessionSecret");
});

it("shows control-only setup honestly and does not call it render-ready", () => {
  render(<WorkerCard workers={[CONTROL_ONLY_WORKER]} />);
  expect(screen.getByText("Đã kết nối · đang chờ cài pipeline media")).toBeVisible();
  expect(screen.queryByText("Sẵn sàng render")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run and verify RED**

Run: `cd web; npm test -- src/components/worker-card.test.tsx src/components/job-list.test.tsx src/components/dashboard-shell.test.tsx src/app/page.test.tsx`

- [ ] **Step 3: Implement sanitized server composition and client controls**

`HomePage` authenticates before constructing repositories, expires stale workers/leases, and passes only `WorkerView` plus `JobSummary`. `WorkerCard` creates a command only on click, keeps it in component memory, clears it after expiry/revoke/unmount, supports clipboard injection, and never persists the command. `JobList` maps states to actionable Vietnamese copy and allows queue only for source-ready projects.

- [ ] **Step 4: Add responsive/accessibility styles**

Use the existing dashboard tokens. The command uses a horizontally scrollable `<code>` block with an explicit copy button; status changes use `aria-live=polite`; destructive revoke requires a confirmation click; disabled queue actions use `aria-describedby`.

- [ ] **Step 5: Verify and commit**

Run: `cd web; npm test -- src/components src/app/page.test.tsx; npm run typecheck; npm run lint; npm run build`

Commit:

```powershell
git add web/src/components web/src/app/page.tsx web/src/app/page.test.tsx web/src/app/globals.css
git commit -m "feat(web): add one-command VPS attachment"
```

### Task 9: Run CP-3 integration, security, and rollout gates

**Files:**
- Modify: `.github/workflows/v2-ci.yml`
- Modify: `web/README.md`
- Modify: `docs/rebuild/DEVELOPMENT.md`
- Modify: `docs/rebuild/00-MASTER-PLAN.md`
- Modify: `docs/rebuild/AUDIT-LOG.md`
- Modify: `tests_v2/test_ci_contract.py`

**Interfaces:**
- Consumes: every CP-3 route, repository, Python client, bootstrap asset, and UI.
- Produces: a reproducible local/CI gate and an honest handoff to the media-worker bridge.

- [ ] **Step 1: Extend CI contract tests first**

Require synthetic `WORKER_AUTH_KEY_V1`, repository, commit, and bridge marker values in the Node job. Require separate Python bootstrap/client tests and retain `npm audit --audit-level=low`.

- [ ] **Step 2: Run the fresh local gate**

```powershell
$env:PYTHONPATH='src'
python -m compileall -q src tests_v2
python -m unittest discover -s tests_v2 -t . -q
Set-Location web
npm ci
npm test
npm run typecheck
npm run lint
npm run build
npm audit --audit-level=low
Set-Location ..
git diff --check
```

Expected: zero failures/errors, production build exit 0, audit reports zero vulnerabilities, and diff check is empty.

- [ ] **Step 3: Run boundary scans**

```powershell
rg -n "Authorization.{0,30}Bearer [A-Za-z0-9_-]{20,}|sessionSecret.{0,30}[A-Za-z0-9_-]{20,}|enrollmentToken.{0,30}[A-Za-z0-9_-]{20,}" web src tests_v2 ops docs/rebuild
git ls-files | rg "(^|/)(\.env|\.superpowers|resources)(/|$)|\.(mp4|mov|mkv|webm)$"
rg -n "request\.arrayBuffer|request\.blob|request\.formData" web/src/app/api
```

Expected: only deliberately synthetic test markers or field names; no live-looking bearer; no tracked secret/media path; no video-ingest body method.

- [ ] **Step 4: Run a disposable local protocol acceptance**

Against a test database and local Next.js server: create enrollment as admin, enroll one fake native client, prove second redemption fails, heartbeat PASS evidence, queue a source-ready synthetic project, prove a control-only worker cannot claim, enable the exact test bridge version, claim once, expire lease, reclaim with a higher fence, and prove the stale progress request returns `LEASE_LOST`.

- [ ] **Step 5: Record observed evidence and commit**

Append exact counts and results to `docs/rebuild/AUDIT-LOG.md`. State explicitly that CP-3 proves the secure control channel but not OCR/TTS/render. Then commit:

```powershell
git add .github/workflows/v2-ci.yml web/README.md docs/rebuild/DEVELOPMENT.md docs/rebuild/00-MASTER-PLAN.md docs/rebuild/AUDIT-LOG.md tests_v2/test_ci_contract.py
git diff --cached --check
git commit -m "ci: verify worker control channel"
```

## CP-3 completion boundary

CP-3 is complete only when the full local gate, disposable protocol acceptance, secret/media scans, and CI contract pass. Production deployment may then expose a real one-command control-only worker attachment. The next plan must bridge claimed jobs into v2 Drive checkpoint/state orchestration before the dashboard can label a VPS `Sẵn sàng render`.
