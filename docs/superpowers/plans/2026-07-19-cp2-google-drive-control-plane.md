# CP-2 Google Drive Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Add one secure administrator-owned Google Drive connection, private project storage, resumable browser-to-Drive source upload, and fail-closed Neon/Drive free-tier health to the Phase 8 control plane.

**Architecture:** Keep the existing Next.js modular monolith and Neon metadata database. Server-only adapters own OAuth, refresh-token encryption, Drive metadata calls, and resumable-session creation; video chunks travel directly from the authenticated browser to the Google session URI and never traverse Vercel. Pure domain/application modules sit behind explicit ports, and IndexedDB stores the only resumable-session copy.

**Tech Stack:** Node.js 22.x; Next.js 16.2.10 App Router; React 19.2; strict TypeScript 5.8; native fetch and node:crypto; Zod 4.1; Neon/Postgres; PGlite; Vitest 3.2; Testing Library; fake-indexeddb 6.2.5; Google OAuth 2.0 and Drive API v3; Vercel Hobby.

## Global Constraints

- Use only the Google scope https://www.googleapis.com/auth/drive.file; reject broader or additional granted scopes.
- Vercel handles metadata and short JSON only; it never receives, proxies, buffers, or persists video bytes.
- Refresh tokens use AES-256-GCM with a canonical 32-byte base64url key, 12-byte nonce, 16-byte tag, key version 1, and domain-separated AAD.
- Refresh/access tokens, OAuth code/state, session URI/upload ID, secrets, full email, and raw provider bodies never enter logs, audits, URLs, snapshots, or fixtures.
- The resumable session URI is a bearer capability stored only in IndexedDB and returned only by the upload-session response with Cache-Control: no-store and Referrer-Policy: no-referrer.
- Upload chunks are 8 MiB except the final chunk; the browser sets Content-Length and code sets only Content-Type and Content-Range.
- Production uses DRIVE_UPLOAD_MAX_BYTES=10737418240, NEON_STORAGE_LIMIT_BYTES=536870912, FREE_TIER_SOFT_PERCENT=90, and QUOTA_STALE_AFTER_SECONDS=900.
- Unknown, stale, malformed, contradictory, high-quota, mismatched-account, or mismatched-remote evidence fails closed.
- Source, checkpoint, and output files remain private; CP-2 creates no anyoneWithLink permission.
- Preview deployments receive no production Google or Neon credentials.
- No Google SDK, Supabase, Redis, paid queue, Vercel Blob, billing enablement, or paid fallback is introduced.
- The admin cookie becomes SameSite=Lax so the OAuth top-level callback can authenticate; it remains HttpOnly, Secure in production, path /, and bounded to 12 hours. Every mutation still requires exact Origin.
- New behavior uses red-green-refactor TDD. Each task ends with a single-purpose Conventional Commit.
- Existing Python 3.10 behavior and all Phase 8 web behavior remain passing.
- Never stage .env, .superpowers, resources, or media files.

---

## Delivery gates

1. Tasks 1-5 build only the minimum secure connection path needed for a real CORS proof.
2. Task 6 is a hard live gate: a Vercel-origin browser must upload two 256 KiB chunks, read the 308 Range header, finish, and clean up the probe. Stop and return to design if this fails.
3. Tasks 7-11 build project provisioning, production upload, health, and UI only after Gate 1 passes.
4. Task 12 runs the complete automated, security, deployment, and Test 1 acceptance gate.

## File structure locked by this plan

~~~text
web/src/
  app/api/v1/drive/connect/route.ts             OAuth start
  app/api/v1/drive/callback/route.ts            OAuth callback
  app/api/v1/drive/disconnect/route.ts          revoke/disconnect
  app/api/v1/projects/route.ts                  project creation
  app/api/v1/projects/[id]/upload-session/route.ts
  app/api/v1/projects/[id]/upload-complete/route.ts
  app/api/v1/projects/[id]/upload-cancel/route.ts
  app/api/v1/health/free-tier/route.ts           authenticated live health
  components/drive-card.tsx                     connection/quota states
  components/project-upload.tsx                 create/select/progress controls
  components/dashboard-shell.tsx                composed protected dashboard
  lib/application/drive-connection.ts           OAuth use cases
  lib/application/drive-access.ts               decrypt/refresh access token
  lib/application/projects.ts                   idempotent folder provisioning
  lib/application/uploads.ts                    source upload lifecycle
  lib/application/free-tier-health.ts           provider snapshot orchestration
  lib/adapters/google/http.ts                   bounded Google HTTP client
  lib/adapters/google/oauth.ts                  OAuth adapter
  lib/adapters/google/drive-files.ts             Drive files/quota adapter
  lib/browser/upload-store.ts                   IndexedDB session store
  lib/browser/resumable-uploader.ts              chunk coordinator
  lib/config/env.ts                             extended strict environment
  lib/domain/drive.ts                           connection/project/artifact types
  lib/domain/errors.ts                          stable public error vocabulary
  lib/domain/upload.ts                          identity/range/retry rules
  lib/domain/free-tier.ts                       projected quota decisions
  lib/http/requests.ts                          strict JSON/auth/origin helpers
  lib/security/credential-cipher.ts             AES-GCM token envelope
  lib/security/oauth-state.ts                   signed one-use state token
  lib/security/redact.ts                        recursive secret scrubbing
  lib/ports/drive.ts                            OAuth/files interfaces
  lib/repositories/drive-control-plane.ts       repository interface
  lib/repositories/neon-drive-control-plane.ts  Postgres implementation
  lib/db/schema.sql                             additive schema migration v2
  test/fakes/fake-drive-control-plane.ts        deterministic repository fake
  test/fakes/fake-google-drive.ts               deterministic provider fakes
web/.env.example                                names and safe markers only
.github/workflows/v2-ci.yml                     CP-2 test environment and gates
docs/rebuild/DEVELOPMENT.md                     operator setup
docs/rebuild/AUDIT-LOG.md                       observed evidence only
~~~

Each production file has one responsibility. Domain files import no Next.js, browser, database, Google adapter, filesystem, or Node crypto module. Application files depend only on ports/domain; routes compose concrete adapters.

### Task 1: Add OAuth-compatible session policy and strict CP-2 configuration

**Files:**
- Modify: web/src/lib/auth/current-admin.ts
- Modify: web/src/app/api/v1/auth/login/route.ts
- Modify: web/src/app/api/v1/auth/logout/route.ts
- Modify: web/src/app/api/v1/auth/login/route.test.ts
- Modify: web/src/lib/config/env.ts
- Modify: web/src/lib/config/env.test.ts
- Modify: web/.env.example
- Create: web/src/lib/http/requests.ts
- Create: web/src/lib/http/requests.test.ts

**Interfaces:**
- Consumes: currentAdmin(sessionSecret): Promise<boolean>, parseServerEnv(source).
- Produces: ServerEnv fields googleOAuthClientId, googleOAuthClientSecret, driveTokenKeyV1, neonStorageLimitBytes, driveUploadMaxBytes, freeTierSoftPercent, quotaStaleAfterSeconds; requireAdmin(request, secret); requireMutationOrigin(request, origin); readStrictJson(request, schema, maxBytes).

- [ ] **Step 1: Write the failing cookie/config/request tests**

Add these cases before implementation:

~~~ts
it("sets SameSite=Lax for the OAuth top-level callback", async () => {
  const response = await POST(validLoginRequest());
  expect(response.headers.get("set-cookie")).toContain("SameSite=lax");
});

it("accepts the exact CP-2 production limits", () => {
  const env = parseServerEnv(cp2Valid);
  expect(env.driveUploadMaxBytes).toBe(10_737_418_240);
  expect(env.freeTierSoftPercent).toBe(90);
});

it.each([
  ["DRIVE_TOKEN_KEY_V1", "not-canonical"],
  ["FREE_TIER_SOFT_PERCENT", "91"],
  ["QUOTA_STALE_AFTER_SECONDS", "901"],
])("rejects unsafe %s", (name, value) => {
  expect(() => parseServerEnv({ ...cp2Valid, [name]: value })).toThrow();
});

it("rejects an unauthenticated mutation before parsing its body", async () => {
  await expect(requireAdmin(request, "s".repeat(64))).rejects.toMatchObject({
    code: "AUTH_REQUIRED",
    status: 401,
  });
});
~~~

- [ ] **Step 2: Run the focused tests and verify red**

Run:

~~~powershell
cd web
npm test -- src/lib/config/env.test.ts src/lib/http/requests.test.ts src/app/api/v1/auth/login/route.test.ts
~~~

Expected: FAIL because the CP-2 fields/helpers do not exist and the cookie is still Strict.

- [ ] **Step 3: Implement canonical environment parsing**

Extend ServerEnv and map these exact schemas:

~~~ts
const cp2Schema = z.object({
  GOOGLE_OAUTH_CLIENT_ID: z.string().trim().min(1).max(512),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1).max(4096),
  DRIVE_TOKEN_KEY_V1: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  NEON_STORAGE_LIMIT_BYTES: z.coerce.number().int().positive().max(536_870_912),
  DRIVE_UPLOAD_MAX_BYTES: z.coerce.number().int().positive().max(10_737_418_240),
  FREE_TIER_SOFT_PERCENT: z.coerce.number().int().min(50).max(90),
  QUOTA_STALE_AFTER_SECONDS: z.coerce.number().int().min(60).max(900),
});

function decodeDriveKey(value: string): Uint8Array {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value) {
    throw new Error("DRIVE_TOKEN_KEY_V1 must encode exactly 32 bytes");
  }
  return bytes;
}
~~~

Parse only named fields rather than spreading process.env. Call decodeDriveKey during parsing but return the canonical string, never decoded bytes. Add safe markers to web/.env.example; do not add values that resemble live credentials.

- [ ] **Step 4: Implement shared request guards and Lax cookie attributes**

Create a typed HttpError and bounded streaming JSON reader:

~~~ts
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export async function readStrictJson<T>(
  request: Request,
  schema: z.ZodType<T>,
  maxBytes: number,
): Promise<T> {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "INVALID_REQUEST");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > maxBytes) throw new HttpError(413, "REQUEST_TOO_LARGE");
    chunks.push(part.value);
  }
  try {
    return schema.parse(JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))));
  } catch {
    throw new HttpError(400, "INVALID_REQUEST");
  }
}
~~~

requireMutationOrigin must compare the single Origin header exactly to appOrigin. requireAdmin delegates to currentAdmin and throws AUTH_REQUIRED. Change login and logout cookie sameSite to lax; preserve HttpOnly, production Secure, path /, and maxAge 43200.

- [ ] **Step 5: Verify and commit**

Run:

~~~powershell
cd web
npm test -- src/lib/config/env.test.ts src/lib/http/requests.test.ts src/app/api/v1/auth/login/route.test.ts src/app/api/v1/auth/logout/route.test.ts
npm run typecheck
~~~

Expected: focused tests PASS and typecheck exits 0.

Commit:

~~~powershell
git add web/.env.example web/src/lib/config web/src/lib/http web/src/lib/auth web/src/app/api/v1/auth
git commit -m "feat(web): prepare secure Drive configuration"
~~~

### Task 2: Define Drive, upload, and projected free-tier domain rules

**Files:**
- Create: web/src/lib/domain/drive.ts
- Create: web/src/lib/domain/drive.test.ts
- Create: web/src/lib/domain/errors.ts
- Create: web/src/lib/domain/errors.test.ts
- Modify: web/src/lib/http/requests.ts
- Modify: web/src/lib/http/requests.test.ts
- Create: web/src/lib/domain/upload.ts
- Create: web/src/lib/domain/upload.test.ts
- Modify: web/src/lib/domain/free-tier.ts
- Modify: web/src/lib/domain/free-tier.test.ts
- Create: web/src/lib/ports/drive.ts

**Interfaces:**
- Produces: PublicCode/AppError, DriveConnectionStatus, Project, Artifact, UploadIntent, VerifiedDriveFile, validateUploadIntent, parseAcknowledgedRange, nextRetry, assessProjectedUpload.
- Produces ports DriveOAuthPort and DriveFilesPort with the signatures below.

- [ ] **Step 1: Write failing domain boundary tests**

~~~ts
it.each([
  ["movie.mp4", "video/mp4"],
  ["movie.mov", "video/quicktime"],
  ["movie.mkv", "video/x-matroska"],
  ["movie.webm", "video/webm"],
])("accepts %s", (fileName, mimeType) => {
  expect(validateUploadIntent({ fileName, mimeType, sizeBytes: 1, lastModified: 1 }, TEN_GIB))
    .toMatchObject({ normalizedExtension: fileName.split(".").pop() });
});

it("rejects a MIME/extension mismatch and exact oversize", () => {
  expect(() => validateUploadIntent(
    { fileName: "movie.mp4", mimeType: "video/webm", sizeBytes: TEN_GIB + 1, lastModified: 1 },
    TEN_GIB,
  )).toThrow("UPLOAD_TOO_LARGE");
});

it.each([
  [null, 0],
  ["bytes=0-42", 43],
  ["bytes=0-8388607", 8_388_608],
])("parses Drive Range %j", (range, expected) => {
  expect(parseAcknowledgedRange(range)).toBe(expected);
});

it("fails projected Drive usage at exactly ninety percent", () => {
  expect(assessProjectedUpload({
    usedBytes: 800, limitBytes: 1000, incomingBytes: 100,
    observedAt: NOW, now: NOW, staleAfterSeconds: 900, softPercent: 90,
  }).mode).toBe("READ_ONLY");
});
~~~

- [ ] **Step 2: Run domain tests and verify red**

Run: cd web; npm test -- src/lib/domain/drive.test.ts src/lib/domain/upload.test.ts src/lib/domain/free-tier.test.ts

Expected: FAIL because the new domain exports do not exist.

- [ ] **Step 3: Implement exact immutable domain types**

~~~ts
export const DRIVE_CONNECTION_STATUSES = [
  "CONNECTED", "REAUTH_REQUIRED", "REVOKE_PENDING", "DISCONNECTED",
] as const;
export type DriveConnectionStatus = typeof DRIVE_CONNECTION_STATUSES[number];
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file" as const;

export type Project = Readonly<{
  id: string;
  status: "PROVISIONING" | "READY" | "FAILED";
  name: string;
  sourceStatus: "NO_SOURCE" | "UPLOAD_PENDING" | "SOURCE_READY" | "UPLOAD_FAILED";
  driveProjectFolderId: string | null;
  driveInputFolderId: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type Artifact = Readonly<{
  id: string;
  projectId: string;
  kind: "SOURCE" | "CHECKPOINT" | "OUTPUT";
  status: "PENDING" | "UPLOADING" | "READY" | "INVALID" | "DELETED";
  driveFileId: string;
  driveParentId: string;
  displayName: string;
  mimeType: string;
  expectedSizeBytes: number;
  actualSizeBytes: number | null;
}>;

export type UploadIntentInput = Readonly<{
  fileName: string;
  mimeType: "video/mp4" | "video/quicktime" | "video/x-matroska" | "video/webm";
  sizeBytes: number;
  lastModified: number;
}>;

export type UploadIntent = UploadIntentInput & Readonly<{
  normalizedExtension: "mp4" | "mov" | "mkv" | "webm";
}>;

export type VerifiedDriveFile = Readonly<{
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  parentIds: readonly string[];
  trashed: boolean;
  appProperties: Readonly<Record<string, string>>;
}>;
~~~

Create one stable error vocabulary used by application and routes:

~~~ts
export const PUBLIC_CODES = [
  "AUTH_REQUIRED", "ORIGIN_REJECTED", "INVALID_REQUEST", "REQUEST_TOO_LARGE",
  "DRIVE_NOT_CONNECTED", "DRIVE_REAUTH_REQUIRED", "DRIVE_ACCOUNT_MISMATCH",
  "IDEMPOTENCY_CONFLICT", "OAUTH_STATE_INVALID", "OAUTH_STATE_EXPIRED",
  "OAUTH_STATE_REPLAYED", "OAUTH_SCOPE_REJECTED", "OAUTH_REFRESH_TOKEN_MISSING",
  "DRIVE_QUOTA_STALE", "DRIVE_STORAGE_HIGH", "NEON_STORAGE_HIGH", "QUOTA_INVALID",
  "UPLOAD_TYPE_REJECTED", "UPLOAD_TOO_LARGE", "UPLOAD_SESSION_EXPIRED",
  "UPLOAD_REMOTE_MISMATCH", "UPLOAD_RETRY_EXHAUSTED", "DRIVE_RATE_LIMITED",
  "DRIVE_TEMPORARILY_UNAVAILABLE", "DRIVE_PROVIDER_REJECTED",
] as const;
export type PublicCode = typeof PUBLIC_CODES[number];
export class AppError extends Error {
  constructor(readonly code: PublicCode, readonly status: number) { super(code); }
}

export const DRIVE_AUDIT_EVENTS = [
  "DRIVE_CONNECT_STARTED", "DRIVE_CONNECTED", "DRIVE_REAUTH_REQUIRED",
  "DRIVE_DISCONNECTED", "PROJECT_CREATED", "UPLOAD_SESSION_CREATED",
  "UPLOAD_COMPLETED", "UPLOAD_CANCELLED", "UPLOAD_FAILED",
  "FREE_TIER_MODE_CHANGED",
] as const;
~~~

errors.test.ts asserts every code is unique and that JSON serialization exposes
only a stable code through the route mapper. Refactor HttpError to extend
AppError while preserving its Task 1 constructor order:

~~~ts
export class HttpError extends AppError {
  constructor(status: number, code: PublicCode) { super(code, status); }
}
~~~

validateUploadIntent must trim only display metadata, compare a lowercase final extension to the exact MIME map, require safe integer size 1..configured maximum, require nonnegative safe-integer lastModified, and return source plus source.normalizedExtension.

parseAcknowledgedRange accepts only null or /^bytes=0-(0|[1-9][0-9]*)$/, returns last+1 as a safe integer, and rejects every other format as UPLOAD_REMOTE_MISMATCH.

- [ ] **Step 4: Lock the provider ports**

~~~ts
export interface DriveOAuthPort {
  buildAuthorizationUrl(input: Readonly<{
    state: string; redirectUri: string;
  }>): string;
  exchangeCode(input: Readonly<{
    code: string; redirectUri: string; timeoutMs: number;
  }>): Promise<Readonly<{ refreshToken: string; grantedScopes: readonly string[] }>>;
  refreshAccessToken(refreshToken: string, timeoutMs: number): Promise<string>;
  revokeRefreshToken(refreshToken: string, timeoutMs: number): Promise<"REVOKED" | "RETRYABLE">;
}

export interface DriveAccessProvider {
  getAccessToken(): Promise<string>;
}

export interface DriveFilesPort {
  inspectAccount(accessToken: string): Promise<Readonly<{
    permissionId: string; accountHint: string; usedBytes: number; limitBytes: number;
  }>>;
  ensureWorkspace(accessToken: string): Promise<Readonly<{ rootFolderId: string }>>;
  ensureProjectFolders(accessToken: string, projectId: string): Promise<Readonly<{
    projectFolderId: string; inputFolderId: string;
  }>>;
  ensureSourceFile(accessToken: string, input: UploadIntent & Readonly<{
    projectId: string; artifactId: string; parentId: string;
  }>): Promise<string>;
  createResumableUpdateSession(accessToken: string, input: Readonly<{
    fileId: string; mimeType: string; sizeBytes: number;
  }>): Promise<Readonly<{ sessionUri: string; expiresAt: string }>>;
  inspectFile(accessToken: string, fileId: string): Promise<VerifiedDriveFile>;
  deleteFile(accessToken: string, fileId: string): Promise<void>;
}

export type UsageSnapshot = Readonly<{
  provider: "DRIVE" | "NEON";
  usedBytes: number;
  limitBytes: number;
  appManagedBytes: number;
  mode: "READ_WRITE" | "READ_ONLY";
  reasonCodes: readonly string[];
  observedAt: string;
}>;
~~~

- [ ] **Step 5: Verify and commit**

Run: cd web; npm test -- src/lib/domain; npm run typecheck

Expected: all domain tests PASS; no domain or port file imports next, node:crypto, database, or browser APIs.

Commit:

~~~powershell
git add web/src/lib/domain web/src/lib/ports
git commit -m "feat(web): define Drive control plane domain"
~~~

### Task 3: Encrypt credentials, sign OAuth state, and scrub secrets

**Files:**
- Create: web/src/lib/security/credential-cipher.ts
- Create: web/src/lib/security/credential-cipher.test.ts
- Create: web/src/lib/security/oauth-state.ts
- Create: web/src/lib/security/oauth-state.test.ts
- Create: web/src/lib/security/redact.ts
- Create: web/src/lib/security/redact.test.ts

**Interfaces:**
- Produces: CredentialCipher.encrypt(id, scope, plaintext), decrypt(id, envelope); issueOAuthState(secret, now, nonce); verifyOAuthState(secret, token, now); redactSecrets(value).

- [ ] **Step 1: Write the failing cryptographic and redaction tests**

~~~ts
it("round-trips only with matching credential id and scope", () => {
  const cipher = createCredentialCipher(KEY);
  const envelope = cipher.encrypt("1", DRIVE_FILE_SCOPE, "refresh-token");
  expect(cipher.decrypt("1", envelope)).toBe("refresh-token");
  expect(() => cipher.decrypt("2", envelope)).toThrow("CREDENTIAL_UNAVAILABLE");
});

it("rejects tampered ciphertext and a 4097-byte token", () => {
  expect(() => cipher.encrypt("1", DRIVE_FILE_SCOPE, "x".repeat(4097))).toThrow();
  expect(() => cipher.decrypt("1", tamperedEnvelope)).toThrow("CREDENTIAL_UNAVAILABLE");
});

it("rejects an expired or future-issued OAuth state", () => {
  const token = issueOAuthState(SECRET, NOW, NONCE);
  expect(() => verifyOAuthState(SECRET, token, plusMinutes(NOW, 11))).toThrow("OAUTH_STATE_EXPIRED");
  expect(() => verifyOAuthState(SECRET, token, minusMinutes(NOW, 1))).toThrow("OAUTH_STATE_INVALID");
});

it("recursively removes session URIs and token-like fields", () => {
  expect(redactSecrets({ authorization: "Bearer x", nested: { sessionUri: "https://upload" } }))
    .toEqual({ authorization: "[REDACTED]", nested: { sessionUri: "[REDACTED]" } });
});
~~~

- [ ] **Step 2: Run security tests and verify red**

Run: cd web; npm test -- src/lib/security

Expected: FAIL because the three modules do not exist.

- [ ] **Step 3: Implement the AES-GCM envelope**

~~~ts
export type EncryptedCredential = Readonly<{
  ciphertext: string;
  nonce: string;
  authTag: string;
  keyVersion: 1;
  scope: typeof DRIVE_FILE_SCOPE;
}>;

export interface CredentialCipher {
  encrypt(id: string, scope: typeof DRIVE_FILE_SCOPE, plaintext: string): EncryptedCredential;
  decrypt(id: string, envelope: EncryptedCredential): string;
}

function aad(id: string, scope: string): Buffer {
  return Buffer.from("ytb-vps:drive-refresh-token:v1:" + id + ":" + scope, "utf8");
}

export function createCredentialCipher(keyBase64url: string): CredentialCipher {
  const key = Buffer.from(keyBase64url, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== keyBase64url) throw new Error("INVALID_TOKEN_KEY");
  return {
    encrypt(id, scope, plaintext) {
      if (Buffer.byteLength(plaintext, "utf8") > 4096) throw new Error("TOKEN_TOO_LARGE");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
      cipher.setAAD(aad(id, scope));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return { ciphertext: ciphertext.toString("base64url"), nonce: nonce.toString("base64url"),
        authTag: cipher.getAuthTag().toString("base64url"), keyVersion: 1, scope };
    },
    decrypt(id, envelope) {
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64url"),
          { authTagLength: 16 });
        decipher.setAAD(aad(id, envelope.scope));
        decipher.setAuthTag(Buffer.from(envelope.authTag, "base64url"));
        return Buffer.concat([
          decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final(),
        ]).toString("utf8");
      } catch {
        throw new Error("CREDENTIAL_UNAVAILABLE");
      }
    },
  };
}
~~~

- [ ] **Step 4: Implement compact signed state and recursive redaction**

State payload is exactly { v: 1, nonce, iat, exp, returnPath: "/" }. Serialize canonical JSON to base64url, sign payload bytes with HMAC-SHA256 and timingSafeEqual, enforce 32-byte base64url nonce and exp-iat=600 seconds.

redactSecrets recursively copies arrays/objects to depth 8, replaces keys
matching authorization, cookie, token, code, state, sessionUri, uploadId,
clientSecret, encryptionKey, and redacts string values containing Bearer,
https://www.googleapis.com/upload/, upload_id=, or OAuth credential parameters.
Only non-sensitive remaining strings may be truncated to 512 characters.
Circular/unsupported values become "[UNSERIALIZABLE]".

- [ ] **Step 5: Verify and commit**

Run: cd web; npm test -- src/lib/security; npm run typecheck; npm run lint

Expected: tests PASS, typecheck/lint exit 0, and test output contains no sample token.

Commit:

~~~powershell
git add web/src/lib/security
git commit -m "feat(web): protect Drive OAuth credentials"
~~~

### Task 4: Add schema v2 and the Drive repository

**Files:**
- Modify: web/src/lib/db/schema.sql
- Modify: web/src/lib/db/schema.test.ts
- Create: web/src/lib/repositories/drive-control-plane.ts
- Create: web/src/lib/repositories/neon-drive-control-plane.ts
- Create: web/src/lib/repositories/neon-drive-control-plane.test.ts
- Create: web/src/test/fakes/fake-drive-control-plane.ts

**Interfaces:**
- Consumes: Project, Artifact, EncryptedCredential, AuditEvent.
- Produces: DriveControlPlaneRepository with atomic state consumption, singleton credential, idempotent project reservation, artifact lifecycle, usage snapshots, database size, and bounded audits.

- [ ] **Step 1: Write failing migration and repository tests**

Add PGlite tests that run schema.sql twice and then assert all of:

~~~ts
expect(tableNames).toEqual(expect.arrayContaining([
  "projects", "artifacts", "oauth_credentials", "oauth_states", "usage_guards",
]));
await expect(insertSecondLiveSource(db)).rejects.toThrow();
await expect(insertConnectedCredentialWithoutCipher(db)).rejects.toThrow();
await expect(insertReadyProjectWithoutFolders(db)).rejects.toThrow();
await expect(repo.consumeOAuthNonce(HASH, NOW)).resolves.toBe(true);
await expect(repo.consumeOAuthNonce(HASH, NOW)).resolves.toBe(false);
await expect(repo.reserveProject(KEY_HASH, REQUEST_HASH, "Demo")).resolves.toMatchObject({
  outcome: "CREATED",
});
await expect(repo.reserveProject(KEY_HASH, OTHER_HASH, "Changed")).resolves.toMatchObject({
  outcome: "CONFLICT",
});
~~~

- [ ] **Step 2: Run database tests and verify red**

Run: cd web; npm test -- src/lib/db/schema.test.ts src/lib/repositories/neon-drive-control-plane.test.ts

Expected: FAIL because schema v2 tables/repository do not exist.

- [ ] **Step 3: Append the exact additive migration**

Append idempotent CREATE TABLE/INDEX statements for the five tables from the approved spec. Enforce:

~~~sql
check (status in ('PROVISIONING','READY','FAILED'))
check (
  (status = 'READY' and drive_project_folder_id is not null and drive_input_folder_id is not null)
  or status <> 'READY'
)
check (creation_idempotency_key_hash ~ '^[0-9a-f]{64}$')
check (creation_request_hash ~ '^[0-9a-f]{64}$')
check (expected_size_bytes between 1 and 1099511627776)
check (checksum_sha256 is null or checksum_sha256 ~ '^[0-9a-f]{64}$')
check (
  (status in ('CONNECTED','REVOKE_PENDING') and ciphertext is not null and nonce is not null
   and auth_tag is not null and octet_length(nonce) = 12 and octet_length(auth_tag) = 16
   and key_version = 1 and scope = 'https://www.googleapis.com/auth/drive.file'
   and account_permission_id_hash ~ '^[0-9a-f]{64}$' and root_folder_id is not null)
  or
  (status in ('REAUTH_REQUIRED','DISCONNECTED') and ciphertext is null and nonce is null
   and auth_tag is null and key_version is null and scope is null)
)
~~~

Add the partial unique SOURCE index where kind='SOURCE' and status<>'DELETED',
bounded text/byte checks from the spec, usage reason_codes
pg_column_size<=2048, and insert schema_migrations version 2 on conflict do
nothing. saveOAuthNonce and consumeOAuthNonce prune expired/consumed rows in
the same transaction so the replay table remains bounded.

- [ ] **Step 4: Define and implement the repository contract**

~~~ts
export interface DriveControlPlaneRepository {
  saveOAuthNonce(hash: string, expiresAt: Date): Promise<void>;
  consumeOAuthNonce(hash: string, now: Date): Promise<boolean>;
  getCredential(): Promise<StoredDriveCredential | null>;
  saveConnectedCredential(value: StoredConnectedCredential): Promise<void>;
  setCredentialStatus(status: "REAUTH_REQUIRED" | "REVOKE_PENDING" | "DISCONNECTED"): Promise<void>;
  hasDriveContent(): Promise<boolean>;
  reserveProject(input: ProjectReservation): Promise<ProjectReservationResult>;
  completeProjectFolders(projectId: string, projectFolderId: string, inputFolderId: string): Promise<Project>;
  listProjects(): Promise<readonly Project[]>;
  reserveSourceArtifact(input: SourceReservation): Promise<Artifact>;
  getArtifact(projectId: string, artifactId: string): Promise<Artifact | null>;
  markArtifactUploading(artifactId: string): Promise<void>;
  markSourceReady(artifactId: string, actualSizeBytes: number, verifiedAt: Date): Promise<void>;
  markSourceInvalid(artifactId: string): Promise<void>;
  markSourceDeleted(artifactId: string): Promise<void>;
  getUsage(provider: "DRIVE" | "NEON"): Promise<UsageSnapshot | null>;
  saveUsage(snapshot: UsageSnapshot): Promise<void>;
  appManagedDriveBytes(): Promise<number>;
  databaseUsedBytes(): Promise<number>;
  recordAudit(event: AuditEvent): Promise<void>;
}
~~~

Define the referenced boundary values exactly:

~~~ts
export type StoredDriveCredential =
  | Readonly<{ status: "CONNECTED" | "REVOKE_PENDING"; envelope: EncryptedCredential;
      accountPermissionIdHash: string; accountHint: string; rootFolderId: string }>
  | Readonly<{ status: "REAUTH_REQUIRED" | "DISCONNECTED"; envelope: null;
      accountPermissionIdHash: string | null; accountHint: string | null; rootFolderId: string | null }>;
export type StoredConnectedCredential = Readonly<{
  status: "CONNECTED";
  envelope: EncryptedCredential;
  accountPermissionIdHash: string;
  accountHint: string;
  rootFolderId: string;
}>;

export type ProjectReservation = Readonly<{
  idempotencyKeyHash: string; requestHash: string; name: string;
}>;
export type ProjectReservationResult =
  | Readonly<{ outcome: "CREATED" | "RESUME" | "EXISTING"; project: Project }>
  | Readonly<{ outcome: "CONFLICT" }>;
export type SourceReservation = UploadIntent & Readonly<{
  artifactId: string; projectId: string; driveFileId: string; driveParentId: string;
}>;
~~~

All row parsers validate enum values, byte ranges, date validity, and nullability before returning domain types. Never select or return a resumable URI. Use SQL transactions/ON CONFLICT for nonce consumption, project reservation, and status updates.

- [ ] **Step 5: Verify and commit**

Run:

~~~powershell
cd web
npm test -- src/lib/db/schema.test.ts src/lib/repositories/neon-drive-control-plane.test.ts
npm run typecheck
~~~

Expected: schema applies twice, constraints and concurrency cases PASS, typecheck exits 0.

Commit:

~~~powershell
git add web/src/lib/db web/src/lib/repositories web/src/test/fakes/fake-drive-control-plane.ts
git commit -m "feat(web): persist private Drive metadata"
~~~

### Task 5: Implement bounded Google adapters and the Drive connection flow

**Files:**
- Create: web/src/lib/adapters/google/http.ts
- Create: web/src/lib/adapters/google/http.test.ts
- Create: web/src/lib/adapters/google/oauth.ts
- Create: web/src/lib/adapters/google/oauth.test.ts
- Create: web/src/lib/adapters/google/drive-files.ts
- Create: web/src/lib/adapters/google/drive-files.test.ts
- Create: web/src/lib/application/drive-connection.ts
- Create: web/src/lib/application/drive-connection.test.ts
- Create: web/src/lib/application/drive-access.ts
- Create: web/src/lib/application/drive-access.test.ts
- Create: web/src/app/api/v1/drive/connect/route.ts
- Create: web/src/app/api/v1/drive/connect/route.test.ts
- Create: web/src/app/api/v1/drive/callback/route.ts
- Create: web/src/app/api/v1/drive/callback/route.test.ts
- Create: web/src/app/api/v1/drive/disconnect/route.ts
- Create: web/src/app/api/v1/drive/disconnect/route.test.ts
- Create: web/src/test/fakes/fake-google-drive.ts

**Interfaces:**
- Consumes: DriveOAuthPort, DriveFilesPort, DriveControlPlaneRepository, CredentialCipher, OAuth state helpers.
- Produces: createGoogleOAuthAdapter, createGoogleDriveFilesAdapter, createDriveAccessProvider, beginDriveConnection, completeDriveConnection, disconnectDrive.

- [ ] **Step 1: Write failing adapter and application tests**

Use local fake fetch responses and assert:

~~~ts
it("builds an exact non-incremental drive.file authorization URL", () => {
  const url = new URL(oauth.buildAuthorizationUrl({ state: "signed", redirectUri: CALLBACK }));
  expect(url.searchParams.get("scope")).toBe(DRIVE_FILE_SCOPE);
  expect(url.searchParams.get("access_type")).toBe("offline");
  expect(url.searchParams.get("prompt")).toBe("consent");
  expect(url.searchParams.get("include_granted_scopes")).toBe("false");
});

it("times out token exchange and never includes a provider body in the error", async () => {
  await expect(oauth.exchangeCode({ code: "secret-code", redirectUri: CALLBACK, timeoutMs: 5 }))
    .rejects.toThrow("DRIVE_TEMPORARILY_UNAVAILABLE");
});

it("rejects a broad granted scope before storing the refresh token", async () => {
  providers.oauth.exchangeCode.mockResolvedValue({
    refreshToken: "secret", grantedScopes: [DRIVE_FILE_SCOPE, "https://www.googleapis.com/auth/drive"],
  });
  await expect(completeDriveConnection(input, providers)).rejects.toMatchObject({
    code: "OAUTH_SCOPE_REJECTED",
  });
  expect(repository.saveConnectedCredential).not.toHaveBeenCalled();
});

it("does not replace an existing workspace with a different Drive account", async () => {
  repository.hasDriveContent.mockResolvedValue(true);
  repository.getCredential.mockResolvedValue(existingCredential);
  providers.files.inspectAccount.mockResolvedValue(otherAccount);
  await expect(completeDriveConnection(input, providers)).rejects.toMatchObject({
    code: "DRIVE_ACCOUNT_MISMATCH",
  });
});
~~~

Route tests must additionally cover auth before provider work, exact Origin on connect/disconnect, duplicate callback query keys, denial, expired/replayed state, missing refresh token, revocation retry, same-origin redirects, no-store, and absence of code/state/token/provider text in bodies and logs.
connect and disconnect accept exactly {} with a 128-byte streaming cap.
connect returns only { authorizationUrl }; disconnect returns only sanitized
connection status. Both send Cache-Control: no-store.

- [ ] **Step 2: Run the focused tests and verify red**

Run:

~~~powershell
cd web
npm test -- src/lib/adapters/google src/lib/application/drive-connection.test.ts src/app/api/v1/drive
~~~

Expected: FAIL because adapters, service, and routes do not exist.

- [ ] **Step 3: Implement the bounded Google HTTP primitive**

~~~ts
export async function googleJson<T>(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  options: Readonly<{ timeoutMs: number; maxResponseBytes: number; attempts: number }>,
): Promise<T> {
  let lastCode = "DRIVE_TEMPORARILY_UNAVAILABLE";
  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetcher(url, { ...init, signal: controller.signal });
      const body = new Uint8Array(await response.arrayBuffer());
      if (body.byteLength > options.maxResponseBytes) throw new Error("PROVIDER_RESPONSE_TOO_LARGE");
      if (response.ok) return JSON.parse(new TextDecoder().decode(body)) as T;
      if (response.status === 401) throw new Error("DRIVE_REAUTH_REQUIRED");
      if (response.status === 429 || response.status >= 500) {
        lastCode = response.status === 429 ? "DRIVE_RATE_LIMITED" : "DRIVE_TEMPORARILY_UNAVAILABLE";
        continue;
      }
      throw new Error("DRIVE_PROVIDER_REJECTED");
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastCode);
}
~~~

Use URLSearchParams for token/revoke bodies, Authorization only in headers, five-second timeout, at most two token attempts and three metadata attempts, response caps of 32 KiB for OAuth and 64 KiB for Drive. Errors contain stable codes only.

- [ ] **Step 4: Implement OAuth and Drive file adapters**

OAuth accepts only an exact token response shape, requires refresh_token length 1..4096, splits bounded scope text, and never returns access_token from exchange because completion immediately calls refreshAccessToken server-side.

Drive adapter uses fields projections and private appProperties:

~~~ts
const ROOT_PROPERTIES = { ytbVpsRole: "root", schema: "1" };
const projectProperties = (projectId: string, role: string) => ({
  ytbVpsProjectId: projectId,
  ytbVpsRole: role,
  schema: "1",
});

const FILE_FIELDS = "id,name,mimeType,size,parents,trashed,appProperties";
const ABOUT_FIELDS = "storageQuota(limit,usage),user(permissionId,emailAddress)";
~~~

ensure operations query by escaped appProperties plus expected parent, reuse exactly one match, create when zero, and fail DRIVE_REMOTE_MISMATCH when multiple. Mask email before returning accountHint. Resumable PATCH sends X-Upload-Content-Length and X-Upload-Content-Type, returns only a validated https://www.googleapis.com/ Location URI with seven-day local expiry. No permission endpoint is called.

- [ ] **Step 5: Implement connection use cases and routes**

beginDriveConnection generates 32 random bytes, stores sha256(nonce), issues signed state, audits DRIVE_CONNECT_STARTED, and returns the exact authorization URL.

completeDriveConnection executes the approved ten-step callback sequence, hashes permissionId, compares any existing account binding before replacement, encrypts refresh token, saves quota/root/credential, and audits DRIVE_CONNECTED.

disconnectDrive decrypts only when status permits. REVOKED clears fields to DISCONNECTED; retryable revocation retains the cipher as REVOKE_PENDING; invalid_grant/decrypt failure clears fields as REAUTH_REQUIRED.

createDriveAccessProvider.getAccessToken requires CONNECTED, decrypts the
envelope, refreshes through DriveOAuthPort, and returns the access token only
to the awaiting server-side application call. It maps invalid_grant or
decryption failure to REAUTH_REQUIRED and clears unusable encrypted fields.

Routes catch only HttpError/stable application errors and return:

~~~ts
return NextResponse.json(
  { code: error.code },
  { status: error.status, headers: { "cache-control": "no-store" } },
);
~~~

The callback permits one state and exactly one code or error plus bounded scope, authuser, prompt, error_description, and error_uri fields. It rejects unknown/duplicate fields and redirects only to new URL("/?drive=connected", env.appOrigin) or a stable drive_error code.

- [ ] **Step 6: Verify and commit**

Run:

~~~powershell
cd web
npm test -- src/lib/adapters/google src/lib/application/drive-connection.test.ts src/app/api/v1/drive
npm run typecheck
npm run lint
~~~

Expected: all connection tests PASS; typecheck/lint exit 0; a scan of test output contains no token, code, state, session URI, or raw provider body.

Commit:

~~~powershell
git add web/src/lib/adapters web/src/lib/application/drive-connection* web/src/app/api/v1/drive web/src/test/fakes/fake-google-drive.ts
git commit -m "feat(web): connect private Google Drive"
~~~

### Task 6: Pass the real two-chunk Drive CORS gate

**Files:**
- Create temporarily, then remove before commit: web/src/app/drive-cors-spike/page.tsx
- Create temporarily, then remove before commit: web/src/app/api/v1/drive/cors-spike-session/route.ts
- Create temporarily, then remove before commit: web/src/app/api/v1/drive/cors-spike-cleanup/route.ts
- Modify: docs/rebuild/AUDIT-LOG.md

**Interfaces:**
- Consumes: the production OAuth connection and Google adapter from Task 5.
- Produces: recorded proof that the exact Vercel origin can PUT Content-Range, read 308 Range, complete, and clean up without a browser access token.

- [ ] **Step 1: Add a temporary, admin-only, disabled-by-default probe**

The session route requires admin plus exact Origin and refuses unless DRIVE_CORS_SPIKE_ENABLED is exactly true. It creates one private 524288-byte application/octet-stream placeholder named cors-probe.bin under YTB-VPS, starts an update session, and returns { cleanupToken, sessionUri } with no-store/no-referrer. The signed, ten-minute cleanupToken binds the private file ID without rendering it; the cleanup route verifies the token and revalidates root ownership before deletion. The temporary page also exposes the Task 5 connect action when Drive is not yet connected.

The page contains no token and runs exactly:

~~~ts
const first = new Uint8Array(262_144);
const second = new Uint8Array(262_144);
const firstResponse = await fetch(sessionUri, {
  method: "PUT",
  headers: {
    "content-type": "application/octet-stream",
    "content-range": "bytes 0-262143/524288",
  },
  body: first,
});
if (firstResponse.status !== 308 || firstResponse.headers.get("range") !== "bytes=0-262143") {
  throw new Error("CORS_RANGE_GATE_FAILED");
}
const finalResponse = await fetch(sessionUri, {
  method: "PUT",
  headers: {
    "content-type": "application/octet-stream",
    "content-range": "bytes 262144-524287/524288",
  },
  body: second,
});
if (![200, 201].includes(finalResponse.status)) throw new Error("CORS_FINAL_GATE_FAILED");
~~~

The page displays only PASS/FAILED, response statuses, whether Range was readable, and cleanup status. It never renders the URI/file ID.

- [ ] **Step 2: Verify temporary probe tests and deploy only to production origin**

Add route/component tests for disabled flag, auth, Origin, no-store, hidden URI, exact two ranges, and cleanup ownership. Run focused tests, typecheck, lint, and build. Configure the flag only during the controlled production probe; do not give preview deployments credentials.

Expected: local gates PASS and the production deployment contains no credential value in output.

- [ ] **Step 3: Run the live browser gate**

Log in, connect the intended Google account, open /drive-cors-spike at the exact APP_ORIGIN, and run once.

Expected:

- First PUT is 308.
- JavaScript reads Range exactly bytes=0-262143.
- Final PUT is 200 or 201.
- Vercel function traffic contains only session/cleanup JSON; neither 256 KiB body reaches Vercel.
- The private probe file is deleted and no token/session URI appears in logs.

If any expectation fails, stop. Do not proceed to Task 7, proxy bytes through Vercel, or send an access token to the browser. Return to the approved design.

- [ ] **Step 4: Remove the complete probe surface and record evidence**

Delete all three temporary routes/page. Remove DRIVE_CORS_SPIKE_ENABLED from
Vercel. Append only timestamp, deployment URL hostname, statuses,
Range-readable=true, cleanup=PASS, and sanitized request-size evidence to
AUDIT-LOG.md. Do not record file ID, URI, account email, or screenshots
containing secrets.

- [ ] **Step 5: Verify removal and commit evidence**

Run:

~~~powershell
rg -n "cors-spike|DRIVE_CORS_SPIKE_ENABLED" web/src web/scripts
cd web
npm test
npm run typecheck
npm run lint
npm run build
~~~

Expected: rg returns no match; all gates PASS.

Commit:

~~~powershell
git add docs/rebuild/AUDIT-LOG.md
git commit -m "test(web): verify direct Drive upload CORS"
~~~

### Task 7: Provision projects idempotently

**Files:**
- Create: web/src/lib/application/projects.ts
- Create: web/src/lib/application/projects.test.ts
- Create: web/src/app/api/v1/projects/route.ts
- Create: web/src/app/api/v1/projects/route.test.ts

**Interfaces:**
- Consumes: DriveControlPlaneRepository.reserveProject/completeProjectFolders, DriveFilesPort.ensureProjectFolders, DriveAccessProvider.getAccessToken.
- Produces: createProject(input): Promise<Project>; GET project listing for the dashboard.

- [ ] **Step 1: Write failing crash-window/idempotency tests**

~~~ts
it("resumes one provisioning row and reuses appProperty folders", async () => {
  repository.reserveProject.mockResolvedValue({ outcome: "RESUME", project: provisioning });
  files.ensureProjectFolders.mockResolvedValue({ projectFolderId: "p-folder", inputFolderId: "i-folder" });
  await expect(service.createProject(request)).resolves.toMatchObject({ status: "READY" });
  expect(files.ensureProjectFolders).toHaveBeenCalledWith("access", provisioning.id);
});

it("returns the existing ready project for the same key and body", async () => {
  repository.reserveProject.mockResolvedValue({ outcome: "EXISTING", project: ready });
  expect(await service.createProject(request)).toBe(ready);
  expect(files.ensureProjectFolders).not.toHaveBeenCalled();
});

it("rejects the same key with a changed body", async () => {
  repository.reserveProject.mockResolvedValue({ outcome: "CONFLICT" });
  await expect(service.createProject(request)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});
~~~

Route tests cover admin, Origin, exact body/name length, 1 KiB streaming cap, printable 16..128 Idempotency-Key, connection state, 201 created versus 200 replay, and sanitized errors.

- [ ] **Step 2: Run focused tests and verify red**

Run: cd web; npm test -- src/lib/application/projects.test.ts src/app/api/v1/projects/route.test.ts

Expected: FAIL because project service/route do not exist.

- [ ] **Step 3: Implement deterministic request hashing and provisioning**

Hash the raw idempotency key with SHA-256. Hash canonical UTF-8 JSON { name: trimmedName } separately. Reserve before Drive calls. For CREATED/RESUME call ensureProjectFolders with project ID appProperties, then atomically complete folder IDs. Mark FAILED only for non-retryable remote mismatch; leave PROVISIONING for retryable network/provider errors.

The route schemas are:

~~~ts
const createProjectBody = z.object({ name: z.string().trim().min(1).max(160) }).strict();
const idempotencyKey = z.string().min(16).max(128).regex(/^[\x20-\x7E]+$/);
~~~

- [ ] **Step 4: Verify and commit**

Run: cd web; npm test -- src/lib/application/projects.test.ts src/app/api/v1/projects/route.test.ts; npm run typecheck

Expected: tests PASS and no duplicate folder is created across a simulated crash/retry.

Commit:

~~~powershell
git add web/src/lib/application/projects* web/src/app/api/v1/projects
git commit -m "feat(web): provision Drive projects idempotently"
~~~

### Task 8: Implement the protected source-upload lifecycle

**Files:**
- Create: web/src/lib/application/uploads.ts
- Create: web/src/lib/application/uploads.test.ts
- Create: web/src/lib/application/free-tier-health.ts
- Create: web/src/lib/application/free-tier-health.test.ts
- Create: web/src/app/api/v1/projects/[id]/upload-session/route.ts
- Create: web/src/app/api/v1/projects/[id]/upload-session/route.test.ts
- Create: web/src/app/api/v1/projects/[id]/upload-complete/route.ts
- Create: web/src/app/api/v1/projects/[id]/upload-complete/route.test.ts
- Create: web/src/app/api/v1/projects/[id]/upload-cancel/route.ts
- Create: web/src/app/api/v1/projects/[id]/upload-cancel/route.test.ts

**Interfaces:**
- Consumes: validateUploadIntent, DriveAccessProvider, repository artifact/usage lifecycle, DriveFilesPort metadata/session/delete/quota.
- Produces: createFreeTierHealthService, createUploadSession, completeUpload, cancelUpload and three strict routes.

- [ ] **Step 1: Write failing upload lifecycle tests**

Cover these exact behaviors:

~~~ts
it("returns a session without passing it to repository or audit", async () => {
  const result = await service.createUploadSession(validIntent);
  expect(result).toMatchObject({ chunkBytes: 8_388_608 });
  expect(result.sessionUri).toMatch(/^https:\/\/www\.googleapis\.com\//);
  expect(JSON.stringify(repository.calls)).not.toContain(result.sessionUri);
});

it.each(["wrong-file", "wrong-parent", "wrong-size", "wrong-mime", "trashed"])(
  "refuses completion on %s evidence",
  async (kind) => {
    files.inspectFile.mockResolvedValue(remoteMismatch(kind));
    await expect(service.completeUpload(projectId, artifactId)).rejects.toMatchObject({
      code: "UPLOAD_REMOTE_MISMATCH",
    });
    expect(repository.markSourceReady).not.toHaveBeenCalled();
  },
);

it("deletes only a pending app-owned source after fresh remote validation", async () => {
  await service.cancelUpload(projectId, artifactId);
  expect(files.deleteFile).toHaveBeenCalledWith("access", artifact.driveFileId);
  expect(repository.markSourceDeleted).toHaveBeenCalledWith(artifactId);
});
~~~

Route tests cover exact path UUID, auth, Origin, strict body/max bytes, 10 GiB cap, current/projected 90-percent limits, stale evidence, one-source rule, response headers, idempotent completion/cancel, and no URI persistence/logging.

free-tier-health.test.ts first proves fresh Drive/Neon snapshots, exact
90-percent current/projected boundaries, 900-second freshness, invalid evidence,
provider fallback only to a still-fresh saved snapshot, and fail-closed missing
connection.

- [ ] **Step 2: Run focused tests and verify red**

Run: cd web; npm test -- src/lib/application/uploads.test.ts src/app/api/v1/projects

Expected: FAIL because upload service/routes do not exist.

- [ ] **Step 3: Implement upload-session creation**

The route accepts exactly:

~~~ts
const uploadIntentSchema = z.object({
  fileName: z.string().min(1).max(255),
  mimeType: z.enum(["video/mp4", "video/quicktime", "video/x-matroska", "video/webm"]),
  sizeBytes: z.number().int().positive(),
  lastModified: z.number().int().nonnegative(),
}).strict();
~~~

createFreeTierHealthService first reuses a complete saved snapshot no older
than quotaStaleAfterSeconds. When missing/stale, it obtains a server-only access
token, refreshes Drive about quota, queries pg_database_size and app-managed
artifact bytes, persists bounded snapshots, and exposes getHealth(now) plus
assertUploadAllowed(incomingBytes, now). Provider failure falls back only to
previous evidence that is still within the freshness window.

The upload service requires a READY project and
assertUploadAllowed(sizeBytes, now) success. Reserve/reuse one pending SOURCE
using the exact file identity. Because CP-2 permits exactly one SOURCE per
project, its artifact UUID is exactly the project UUID; this deterministic
identity closes the crash window after Drive placeholder creation. Ensure the
remote name source.<normalizedExtension> in the input folder using project/artifact
appProperties, reserve/reuse that same artifact row, mark UPLOADING, then
create a PATCH session. Return artifactId,
sessionUri, chunkBytes=8388608, expiresAt only. Set Cache-Control: no-store and
Referrer-Policy: no-referrer.

- [ ] **Step 4: Implement completion and cancellation proof**

completion/cancel bodies are exact { artifactId: UUID } with 1 KiB caps. Before READY, compare Drive id, only expected parent, exact MIME/size, non-trashed state, and appProperties project/artifact roles. Update artifact and project source status atomically, then audit bounded IDs/bytes/MIME only.

Cancel rejects READY, job-referenced, wrong-parent, wrong-appProperty, or unrelated files. A repeated cancel of an already DELETED artifact returns success without a second Drive delete.

- [ ] **Step 5: Verify and commit**

Run:

~~~powershell
cd web
npm test -- src/lib/application/uploads.test.ts src/lib/application/free-tier-health.test.ts src/app/api/v1/projects
npm run typecheck
npm run lint
~~~

Expected: upload lifecycle tests PASS; no test snapshot/body contains a session URI.

Commit:

~~~powershell
git add web/src/lib/application/uploads* web/src/lib/application/free-tier-health* web/src/app/api/v1/projects
git commit -m "feat(web): manage private source uploads"
~~~

### Task 9: Build the IndexedDB resumable upload coordinator

**Files:**
- Modify: web/package.json
- Modify: web/package-lock.json
- Create: web/src/lib/browser/upload-store.ts
- Create: web/src/lib/browser/upload-store.test.ts
- Create: web/src/lib/browser/resumable-uploader.ts
- Create: web/src/lib/browser/resumable-uploader.test.ts

**Interfaces:**
- Consumes: upload-session/complete/cancel JSON APIs and the selected browser File.
- Produces: UploadSessionStore and createResumableUploader with start, pause, resume, cancel, subscribe, and dispose.

- [ ] **Step 1: Add the pinned IndexedDB test dependency**

Run from web:

~~~powershell
npm install --save-dev --save-exact fake-indexeddb@6.2.5
~~~

Expected: package.json and package-lock.json contain exactly 6.2.5; npm ls fake-indexeddb exits 0.

- [ ] **Step 2: Write failing store/coordinator tests**

Use fake-indexeddb/auto and a deterministic fetch fake. Cover:

~~~ts
it("stores only the resumable capability and bounded file identity", async () => {
  await store.put(record);
  expect(await store.get(record.projectId, record.artifactId)).toEqual(record);
});

it("recovers from Drive's acknowledged offset after reload", async () => {
  fetcher.queue(response(308, { Range: "bytes=0-8388607" }));
  await uploader.resume(file, storedRecord);
  expect(fetcher.requests[0]?.headers.get("content-range")).toBe("*/16777216");
  expect(fetcher.requests[1]?.headers.get("content-range"))
    .toBe("bytes 8388608-16777215/16777216");
});

it("never attempts to set Content-Length", async () => {
  await uploader.start(file, session);
  expect(fetcher.requests.every((request) => !request.headers.has("content-length"))).toBe(true);
});

it.each([400, 403, 404])("replaces a %i session with one bounded renewal", async (status) => {
  api.renewSession.mockResolvedValue(renewedSession);
  fetcher.queue(response(status), response(201));
  await uploader.start(file, session);
  expect(api.renewSession).toHaveBeenCalledTimes(1);
});

it("pauses after five retry or renewal attempts", async () => {
  fetcher.always(response(503));
  await expect(uploader.start(file, session)).rejects.toMatchObject({
    code: "UPLOAD_RETRY_EXHAUSTED",
  });
  expect(uploader.snapshot().phase).toBe("PAUSED_ERROR");
});
~~~

Also test file-identity mismatch, null Range, malformed Range, 8 MiB and final chunk boundaries, network error status query, 429 jitter path, local/seven-day expiry, pause before next chunk, verified completion deletion, cancel retention on API failure, and disposal of timers/listeners.

- [ ] **Step 3: Run focused tests and verify red**

Run: cd web; npm test -- src/lib/browser

Expected: FAIL because store/coordinator do not exist.

- [ ] **Step 4: Implement the IndexedDB adapter**

~~~ts
export type StoredUploadSession = Readonly<{
  projectId: string;
  artifactId: string;
  sessionUri: string;
  fileIdentity: Readonly<{
    displayName: string; sizeBytes: number; mimeType: string; lastModified: number;
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
~~~

Open ytb-vps-upload-v1 version 1 with object store sessions keyed by projectId:artifactId. Validate every record on read; delete malformed/local-expired records. Do not add indexes containing sessionUri and do not mirror it to localStorage, URL, analytics, React DOM, or console.

- [ ] **Step 5: Implement the state machine**

~~~ts
export type UploadSnapshot = Readonly<{
  phase: "IDLE" | "UPLOADING" | "PAUSED" | "PAUSED_ERROR" | "COMPLETING" | "READY" | "CANCELLED";
  committedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  publicCode: string | null;
}>;

export interface ResumableUploader {
  start(file: File, session: StoredUploadSession): Promise<void>;
  resume(file: File, session: StoredUploadSession): Promise<void>;
  pause(): void;
  cancel(): Promise<void>;
  subscribe(listener: (value: UploadSnapshot) => void): () => void;
  snapshot(): UploadSnapshot;
  dispose(): void;
}
~~~

At recovery send empty PUT with Content-Range */total. Treat 308 Range as authoritative and persist only after acknowledgement. Send Blob slices with Content-Type and bytes start-end/total; never set Content-Length or Authorization. On network/5xx query status; on 429 bounded backoff; on any other 4xx/local expiry delete the old record and call renewSession. One shared attempt counter caps retry plus renewal at five. Completion calls control plane verification before deleting IndexedDB.

Use injected clock, random jitter, sleeper, fetcher, store, and API client so tests contain no real delay or network.

- [ ] **Step 6: Verify and commit**

Run:

~~~powershell
cd web
npm test -- src/lib/browser
npm run typecheck
npm run lint
~~~

Expected: store and coordinator tests PASS; typecheck/lint exit 0.

Commit:

~~~powershell
git add web/package.json web/package-lock.json web/src/lib/browser
git commit -m "feat(web): resume direct Drive uploads"
~~~

### Task 10: Add authenticated free-tier health orchestration

**Files:**
- Modify: web/src/lib/application/free-tier-health.ts
- Modify: web/src/lib/application/free-tier-health.test.ts
- Modify: web/src/app/api/v1/health/free-tier/route.ts
- Modify: web/src/app/api/v1/health/free-tier/route.test.ts

**Interfaces:**
- Consumes: databaseUsedBytes, Drive account quota, app artifact size sum, usage snapshots, assessFreeTier.
- Produces: getFreeTierHealth(now): Promise<FreeTierHealth> and authenticated GET /api/v1/health/free-tier.

- [ ] **Step 1: Write failing authenticated route and sanitized-view tests**

~~~ts
it("returns sanitized fresh provider usage to an admin", async () => {
  service.getHealth.mockResolvedValue({
    mode: "READ_WRITE",
    reasons: [],
    drive: { usedBytes: 100, limitBytes: 1000, appManagedBytes: 20, observedAt: NOW_ISO },
    neon: { usedBytes: 10, limitBytes: 536_870_912, appManagedBytes: 10, observedAt: NOW_ISO },
    driveConnection: "CONNECTED",
  });
  const response = await GET();
  await expect(response.json()).resolves.toEqual({
    mode: "READ_WRITE",
    reasons: [],
    drive: { usedBytes: 100, limitBytes: 1000, appManagedBytes: 20, observedAt: NOW_ISO },
    neon: { usedBytes: 10, limitBytes: 536_870_912, appManagedBytes: 10, observedAt: NOW_ISO },
    driveConnection: "CONNECTED",
  });
});

it("requires admin before reading private quota", async () => {
  const response = await GET();
  expect(response.status).toBe(401);
  expect(service.getHealth).not.toHaveBeenCalled();
});
~~~

Retain the Task 8 service tests as regressions for provider error, invalid
quota, and stale snapshot.

- [ ] **Step 2: Run focused tests and verify red**

Run: cd web; npm test -- src/lib/application/free-tier-health.test.ts src/app/api/v1/health/free-tier/route.test.ts

Expected: FAIL because the current health route is static and unauthenticated.

- [ ] **Step 3: Expose the existing snapshot orchestration as a bounded view**

Keep the Task 8 behavior: on a CONNECTED credential, refresh the access token,
fetch Drive quota, query pg_database_size and sum non-deleted artifact
actual/expected bytes, save both snapshots, then assess. If a provider call
fails, use a previously saved snapshot only while age<=900 seconds; otherwise
return READ_ONLY with DRIVE_QUOTA_STALE or the corresponding stable reason.
Missing/zero/negative/non-safe values are QUOTA_INVALID. Add only the JSON-safe
view boundary; never return permission ID, email, root/file IDs, token, or
provider body.

The response is:

~~~ts
export type UsageView = Readonly<{
  usedBytes: number;
  limitBytes: number;
  appManagedBytes: number;
  observedAt: string;
}>;

export type FreeTierHealth = Readonly<{
  mode: "READ_WRITE" | "READ_ONLY";
  reasons: readonly string[];
  driveConnection: DriveConnectionStatus;
  drive: UsageView | null;
  neon: UsageView | null;
}>;
~~~

- [ ] **Step 4: Implement the protected no-store route**

Authenticate before repository/provider calls. GET does not require Origin but requires the admin cookie. Return status 200 for READ_ONLY evidence states, 401 for no admin, and 503 only when the control-plane repository itself cannot answer a sanitized response.

- [ ] **Step 5: Verify and commit**

Run: cd web; npm test -- src/lib/application/free-tier-health.test.ts src/app/api/v1/health/free-tier/route.test.ts; npm run typecheck

Expected: health tests PASS and response JSON contains only the declared shape.

Commit:

~~~powershell
git add web/src/lib/application/free-tier-health* web/src/app/api/v1/health/free-tier
git commit -m "feat(web): report free tier Drive health"
~~~

### Task 11: Compose the Drive/project/upload dashboard

**Files:**
- Create: web/src/components/drive-card.tsx
- Create: web/src/components/drive-card.test.tsx
- Create: web/src/components/project-upload.tsx
- Create: web/src/components/project-upload.test.tsx
- Modify: web/src/components/dashboard-shell.tsx
- Modify: web/src/components/dashboard-shell.test.tsx
- Modify: web/src/app/page.tsx
- Modify: web/src/app/page.test.tsx
- Modify: web/src/app/globals.css

**Interfaces:**
- Consumes: sanitized DriveConnectionView, FreeTierHealth, Project[], and JSON endpoints from Tasks 5, 7-10.
- Produces: accessible Vietnamese connect/disconnect, project create, file selection, progress, pause/resume/cancel/reload recovery UI.

The server-to-client connection view is exactly:

~~~ts
export type DriveConnectionView = Readonly<{
  status: DriveConnectionStatus;
  accountHint: string | null;
  rootReady: boolean;
}>;
~~~

- [ ] **Step 1: Write failing component behavior tests**

~~~tsx
it("shows a connect action and no upload form while disconnected", () => {
  render(<DriveCard value={disconnected} />);
  expect(screen.getByRole("button", { name: "Kết nối Google Drive" })).toBeEnabled();
  expect(screen.queryByLabelText("Video nguồn")).not.toBeInTheDocument();
});

it("disables new work when quota evidence is stale", () => {
  render(<ProjectUpload health={readOnlyHealth("DRIVE_QUOTA_STALE")} projects={[]} />);
  expect(screen.getByRole("button", { name: "Tạo dự án" })).toBeDisabled();
  expect(screen.getByText("Chưa xác minh được dung lượng Google Drive.")).toBeVisible();
});

it("supports pause, reload recovery, resume and verified completion", async () => {
  render(<ProjectUpload health={healthy} projects={[project]} uploaderFactory={fakeFactory} />);
  fireEvent.change(screen.getByLabelText("Video nguồn"), { target: { files: [file] } });
  fireEvent.click(screen.getByRole("button", { name: "Tải lên" }));
  expect(await screen.findByText("50%")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Tạm dừng" }));
  expect(screen.getByRole("button", { name: "Tiếp tục" })).toBeEnabled();
});
~~~

Cover all Drive states: Chưa kết nối, Đã kết nối, Cần kết nối lại, Đang chờ ngắt kết nối, Chỉ đọc do quota. Cover accepted formats/10 GiB copy, bytes/percentage/throughput, cancel failure retention, active-chunk beforeunload only, no session URI/file ID/provider error rendering, and Chưa gắn GPU VPS after SOURCE_READY.

- [ ] **Step 2: Run component/page tests and verify red**

Run:

~~~powershell
cd web
npm test -- src/components/drive-card.test.tsx src/components/project-upload.test.tsx src/components/dashboard-shell.test.tsx src/app/page.test.tsx
~~~

Expected: FAIL because CP-2 components/props do not exist.

- [ ] **Step 3: Implement connection and project controls**

DriveCard POSTs {} to connect, assigns window.location.href only to same returned Google authorization URL after validation, and POSTs {} to disconnect with same-origin credentials. It displays masked account hint, provider/app bytes, snapshot time, and stable Vietnamese reason mapping.

ProjectUpload:

~~~ts
const VI_MESSAGES: Readonly<Record<string, string>> = {
  DRIVE_NOT_CONNECTED: "Hãy kết nối Google Drive trước.",
  DRIVE_REAUTH_REQUIRED: "Google Drive cần được kết nối lại.",
  DRIVE_ACCOUNT_MISMATCH: "Tài khoản Drive không khớp với dữ liệu hiện có.",
  DRIVE_QUOTA_STALE: "Chưa xác minh được dung lượng Google Drive.",
  DRIVE_STORAGE_HIGH: "Google Drive đã chạm ngưỡng an toàn 90%.",
  NEON_STORAGE_HIGH: "Cơ sở dữ liệu đã chạm ngưỡng an toàn 90%.",
  UPLOAD_SESSION_EXPIRED: "Phiên tải lên đã hết hạn; hệ thống sẽ tạo phiên mới.",
  UPLOAD_RETRY_EXHAUSTED: "Đường truyền chưa ổn định. Tiến trình đã được giữ để thử lại.",
};
~~~

Generate a random 128-bit base64url Idempotency-Key in the browser once per project form attempt. Never use the project name as the key. On reload, list IndexedDB sessions and ask the operator to reselect the exact matching File because browsers do not persist File access.

- [ ] **Step 4: Compose server data without leaking server objects**

HomePage authenticates, builds repositories/adapters server-side, fetches sanitized connection/health/projects, and passes JSON-safe views only. It never passes an adapter, credential, Drive ID, or session URI into React props. Keep dynamic=force-dynamic.

Append focused responsive styles using existing CSS tokens. Buttons must have visible focus, disabled explanations via aria-describedby, status updates via role=status/aria-live=polite, and mobile layout at 720px.

- [ ] **Step 5: Verify and commit**

Run:

~~~powershell
cd web
npm test -- src/components src/app/page.test.tsx
npm run typecheck
npm run lint
npm run build
~~~

Expected: component/page tests PASS; typecheck/lint/build exit 0; rendered output contains no protected identifiers.

Commit:

~~~powershell
git add web/src/components web/src/app/page.tsx web/src/app/page.test.tsx web/src/app/globals.css
git commit -m "feat(web): add direct Drive upload dashboard"
~~~

### Task 12: Harden CI, deploy the free stack, and complete Test 1 acceptance

**Files:**
- Modify: .github/workflows/v2-ci.yml
- Modify: web/README.md
- Modify: docs/rebuild/DEVELOPMENT.md
- Modify: docs/rebuild/00-MASTER-PLAN.md
- Modify: docs/rebuild/AUDIT-LOG.md

**Interfaces:**
- Consumes: every CP-2 route, migration, component, security rule, and operator secret name.
- Produces: reproducible automated gate plus live Vercel/Neon/Drive evidence with no credential or media committed.

- [ ] **Step 1: Extend CI with safe marker values and explicit checks**

Add CP-2 marker variables to the existing Node 22 job:

~~~yaml
      GOOGLE_OAUTH_CLIENT_ID: test-client.apps.googleusercontent.com
      GOOGLE_OAUTH_CLIENT_SECRET: test-only-not-a-live-secret
      DRIVE_TOKEN_KEY_V1: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
      NEON_STORAGE_LIMIT_BYTES: '536870912'
      DRIVE_UPLOAD_MAX_BYTES: '10737418240'
      FREE_TIER_SOFT_PERCENT: '90'
      QUOTA_STALE_AFTER_SECONDS: '900'
~~~

Keep npm ci, npm test, typecheck, lint, and build as separate steps. Add npm audit --audit-level=low. Do not alter the independent Python 3.10 job.

- [ ] **Step 2: Document exact free operator setup**

Document:

1. Create Neon Free, copy DATABASE_URL only into Vercel Production, run npm run db:migrate.
2. Create one Google Cloud project, enable Drive API, create Web application OAuth, request only drive.file.
3. Register exactly APP_ORIGIN/api/v1/drive/callback and publish the consent screen to Production.
4. Generate DRIVE_TOKEN_KEY_V1 locally from 32 random bytes and store only in Vercel Production.
5. Set the four numeric limits exactly; never enable billing or a paid fallback.
6. Deploy rebuild/v2 to Vercel Production, log in, connect Drive, and verify YTB-VPS is private.

Use secret-name placeholders only. State that Google Testing-mode refresh tokens are not final acceptance.
Add the rollback runbook: redeploy the previous application commit, leave the
additive v2 tables unused, never drop them automatically, and never delete
Drive content during rollback/disconnect. Any destructive cleanup remains a
separately reviewed future operation.

- [ ] **Step 3: Run the complete fresh local regression gate**

From repository root:

~~~powershell
$env:PYTHONPATH = 'src'
python -m compileall -q src tests_v2
python -m unittest discover -s tests_v2 -t . -v
Set-Location web
npm ci
npm test
npm run typecheck
npm run lint
npm run build
npm audit --audit-level=low
npm run db:migrate
npm run db:migrate
Set-Location ..
git diff --check
git status --short
~~~

Expected:

- Python exits 0 with zero failures/errors.
- Vitest exits 0 with zero failed tests.
- Typecheck, lint, production build, audit, and two migration runs exit 0.
- git diff --check is empty.
- status contains only intended CP-2 files plus the pre-existing untracked resources directory.

- [ ] **Step 4: Run secret, URI, media, and boundary scans**

~~~powershell
rg -n "sk-[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_-]{20,}|refresh_token.{0,20}[:=].+|upload_id=|sessionUri.{0,20}https://" web .github docs/rebuild
git ls-files | rg "(^|/)(\.env|\.superpowers|resources)(/|$)|\.(mp4|mov|mkv|webm)$"
rg -n "request\.arrayBuffer|request\.blob|request\.formData" web/src/app/api
~~~

Expected:

- First scan finds only deliberate redaction/test patterns with fake values, never a live value or URI.
- Tracked-file scan returns no match.
- Body-method scan returns no video-ingest route; JSON helpers only read bounded control-plane bodies.

- [ ] **Step 5: Complete live Test 1 acceptance**

On the production deployment:

1. Confirm Google OAuth is Production and granted scopes equal only drive.file.
2. Connect the intended Drive account and verify YTB-VPS/private project folders.
3. Create project Test 1 with a fresh idempotency key.
4. Select the existing video under resources/videos without staging it.
5. Start upload, observe progress, reload mid-upload, reselect the same File, resume from the acknowledged offset, and complete.
6. Verify Drive ID, parent, MIME, size, private permission, and READY/SOURCE_READY metadata.
7. Verify Vercel traffic contains no video body and logs/Neon/audit/Git contain no sensitive value.
8. Disconnect/reconnect the same account and verify the private file remains intact.
9. Attempt a different account only if a safe test account is available; expect DRIVE_ACCOUNT_MISMATCH without overwriting metadata.

If any check fails, do not call CP-2 complete and do not delete the source file. Capture only sanitized metadata evidence.

- [ ] **Step 6: Record observed evidence and run whole-branch review**

Append actual test counts, command PASS results, production hostname, OAuth mode/scope, CORS gate, Test 1 byte size/MIME, resume offset, privacy result, quota snapshots, and commit hashes to docs/rebuild/AUDIT-LOG.md. Never predict counts or hashes.

Invoke superpowers:requesting-code-review for the complete branch. Fix every Critical or Important finding using superpowers:receiving-code-review and systematic-debugging/TDD as applicable, then rerun Steps 3-5.

- [ ] **Step 7: Commit the CP-2 gate**

~~~powershell
git add .github/workflows/v2-ci.yml web/README.md docs/rebuild/DEVELOPMENT.md docs/rebuild/00-MASTER-PLAN.md docs/rebuild/AUDIT-LOG.md
git diff --cached --check
git diff --cached --name-only
git commit -m "ci: verify free Drive control plane"
~~~

Expected: staged names contain only the five intended files, and no resources/.env/media path. CP-2 is complete only after the final commit, whole-branch review, GitHub Node 22/Python 3.10 jobs, and all live checks pass.
