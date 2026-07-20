# Drive Upload Metadata Finalization Design

Date: 2026-07-19
Status: approved by user in conversation on 2026-07-19
Parent specification: `docs/superpowers/specs/2026-07-19-cp2-google-drive-design.md`
Branch: `codex/cp2-google-drive`

## 1. Decision

Keep every video byte on the direct browser-to-Google-Drive path. When the
browser cannot observe the final resumable-upload response because of CORS or
a terminated connection, the Vercel control plane determines completion by
reading the app-owned Drive file's metadata. Vercel never receives a video
chunk, and the browser never receives a Google access token.

This addendum replaces only the failed final-response assumption in CP-2. All
other privacy, free-tier, OAuth, persistence, and resumability requirements in
the parent specification remain authoritative.

## 2. Evidence and root cause

The production-origin two-chunk probe established all of the following:

- The first 256 KiB `PUT` returned `308 Resume Incomplete`.
- Browser JavaScript read `Range: bytes=0-262143` exactly.
- The final 256 KiB reached Drive, and a server-side metadata read observed an
  exact size of 524288 bytes.
- The browser could not observe the final `200 OK`; its fetch terminated at the
  CORS boundary.
- The private probe file was deleted successfully.

Google documents that non-final resumable chunks use `308` plus `Range`, while
a complete upload returns `200` or `201`. The failure is therefore not a byte
transport failure. It is an observation failure at the browser boundary after
Drive has committed the final bytes.

## 3. Alternatives considered

### 3.1 Selected: metadata-only server finalization

The browser sends chunks directly to the resumable session URI. The existing
same-origin `upload-complete` endpoint loads the artifact identity from Neon,
refreshes the server-held Drive credential, reads exact Drive metadata, and
marks the source ready only after all immutable fields match.

Benefits:

- Preserves the zero-video-byte Vercel boundary.
- Preserves the narrow `drive.file` OAuth scope.
- Requires only small JSON and metadata requests.
- Uses ports, repository fields, and the completion endpoint already specified
  for CP-2.
- Resolves both readable final success and ambiguous final fetch failure with
  the same fail-closed verification path.

### 3.2 Rejected: proxy the final chunk or the whole video through Vercel

This would make the control plane a media transport, increase bandwidth and
function-duration pressure, duplicate upload logic, and violate the approved
architecture. It is not an acceptable fallback.

### 3.3 Rejected: give a Drive access token to the browser

This would expand a narrow upload capability into a broader bearer credential,
increase exposure through browser state and tooling, and violate the approved
secret boundary. It is not an acceptable fallback.

## 4. Boundaries and invariants

- `sessionUri` remains the browser's only Drive upload capability and is stored
  only in IndexedDB.
- Google refresh/access tokens remain server-only and encrypted at rest.
- `POST /api/v1/projects/:id/upload-complete` accepts only `artifactId`; it
  never accepts a Drive file ID, expected metadata, access token, session URI,
  byte offset, or file content from the browser.
- The endpoint body remains bounded to 1 KiB and requires the admin session and
  exact application Origin.
- Vercel requests Drive metadata only. No Vercel request body may contain a
  media chunk.
- Provider bodies, full account email, file ID, session URI, and credentials
  never enter logs, audits, response bodies, DOM, analytics, or error text.
- No new paid service, billing activation, schema table, or environment flag is
  introduced.

## 5. Completion verification contract

The application completion service receives `{ projectId, artifactId, now }`
from the trusted route and uses existing server-side dependencies:

- `DriveControlPlaneRepository.getArtifact(projectId, artifactId)`;
- `DriveAccessProvider.getAccessToken()`;
- `DriveFilesPort.inspectFile(accessToken, artifact.driveFileId)`;
- `DriveControlPlaneRepository.markSourceReady(...)`;
- `DriveControlPlaneRepository.markSourceInvalid(...)`;
- `DriveControlPlaneRepository.recordAudit(...)`.

Before `SOURCE_READY`, the service verifies all of these conditions against
the stored artifact, not browser input:

- artifact kind is `SOURCE`;
- artifact status is `PENDING`, `UPLOADING`, or already `READY`;
- Drive file ID equals the stored ID;
- Drive parent list contains exactly the stored input-folder ID;
- Drive name is `source.<normalized extension>` derived from the stored display
  name and MIME contract;
- Drive MIME type equals the stored MIME type;
- Drive size equals `expectedSizeBytes`;
- Drive reports `trashed=false`;
- Drive `appProperties` equal the expected project ID, artifact ID, role
  `source`, and schema version `1` with no ownership ambiguity.

The service produces one of three outcomes:

1. `SOURCE_READY`: exact evidence matched. Persist `READY`, actual size, and
   verification timestamp atomically with project `SOURCE_READY`; record one
   sanitized `UPLOAD_COMPLETED` audit. Repeated calls return the same ready
   result without duplicating the audit.
2. `UPLOAD_PENDING`: the file is still app-owned and otherwise exact, but its
   observed size is smaller than `expectedSizeBytes`. Do not mutate it to
   invalid, do not delete it, and do not record failure.
3. Stable failure: a larger size, wrong identity/parent/name/MIME/properties,
   trashed file, missing artifact, `INVALID`/`DELETED` artifact, or malformed
   provider evidence fails closed as `UPLOAD_REMOTE_MISMATCH`. An owned pending
   artifact with conclusive remote mismatch is marked invalid and records one
   sanitized `UPLOAD_FAILED` audit. A missing or already invalid/deleted
   artifact is not mutated. Retryable provider/rate-limit/reauthentication
   errors leave the artifact pending and preserve their existing stable public
   codes.

## 6. HTTP contract

`POST /api/v1/projects/:id/upload-complete`

Request:

```json
{"artifactId":"10000000-0000-4000-8000-000000000001"}
```

Ready response, HTTP 200:

```json
{"status":"SOURCE_READY","actualSizeBytes":524288}
```

Not-yet-verifiable response, HTTP 202:

```json
{"status":"UPLOAD_PENDING","retryAfterMs":1000}
```

The response contains no Drive ID, provider response, upload URI, credential,
or account identity. All failures use the existing stable error-body contract
`{"code":"..."}` and `Cache-Control: no-store`.

## 7. Browser coordinator behavior

### 7.1 Non-final chunks

Continue using readable `308` and exact `Range` as the authoritative committed
offset. A network failure follows the existing status-query path with at most
five failed attempts total. Attempts one through four wait 1, 2, 4, and 8
seconds plus 0..249 ms jitter; attempt five pauses without another request.

### 7.2 Final chunk

After sending the final chunk, call `upload-complete` in either case:

- the browser reads `200` or `201`; or
- the final fetch rejects or its response is hidden after the request began.

The browser never treats an unreadable final response as success by itself.

If `upload-complete` returns `SOURCE_READY`, delete the IndexedDB session and
show completion. If it returns `UPLOAD_PENDING`, query the existing resumable
session:

- readable `308`: parse `Range`, persist the acknowledged offset, and resume
  from the next byte;
- unreadable/terminated status response: poll `upload-complete` under the same
  five-attempt ceiling and 1/2/4/8-second-plus-jitter delays;
- expired `404`: replace the session for the same pending file; the replacement
  counts toward that same five-attempt ceiling;
- repeated unresolved results at the retry ceiling: enter
  `PAUSED_VERIFYING`, retain IndexedDB state, and offer a safe retry. Never
  restart from byte zero solely because the final response was unreadable.

On reload, a record whose next offset equals the file size attempts server
finalization before any new upload request.

## 8. Cost behavior

The media path remains browser-to-Drive. Vercel handles only small JSON calls
and Drive metadata reads; Neon stores only existing bounded metadata. This
design adds no paid product and is intended to remain within the configured
Vercel Hobby, Neon Free, and Google Drive/API free limits. Quota guards remain
fail-closed, so exceeding a declared free-tier limit disables new work instead
of enabling billing or silently upgrading.

## 9. Testing and live acceptance

### 9.1 Application and adapter tests

- Exact metadata produces `SOURCE_READY` and one completion audit.
- Repeated completion is idempotent.
- Smaller observed size produces `UPLOAD_PENDING` without state corruption.
- Larger size or any identity/ownership mismatch produces
  `UPLOAD_REMOTE_MISMATCH` and a sanitized failure transition.
- Retryable provider, rate-limit, and reauthentication errors preserve the
  pending artifact.
- No service result, audit, log, or browser fixture contains a provider file
  ID, session URI, token, full email, or raw provider body. Adapter and
  repository tests use synthetic non-secret IDs only where the interface
  requires identity evidence.

### 9.2 Route tests

- Authentication runs before Origin, body, repository, or provider work.
- Exact Origin and strict 1 KiB JSON parsing are required.
- Only UUID project/artifact IDs are accepted.
- HTTP 200 and 202 bodies match the exact contracts above.
- Every mutable/sensitive response is `no-store`.

### 9.3 Browser coordinator tests

- Readable final `200/201` calls server finalization.
- Rejected final fetch followed by `SOURCE_READY` completes without reupload.
- Pending metadata plus readable `308` resumes from exact `Range`.
- Pending metadata plus an unreadable status response retries metadata with the
  bounded schedule.
- Retry exhaustion enters `PAUSED_VERIFYING` and retains IndexedDB state.
- Reload at total size finalizes before sending bytes.
- Cancellation and session replacement retain their existing proof checks.

### 9.4 Revised production gate

Run the two-chunk 524288-byte private probe from the production origin. The
gate passes when:

- the first browser `PUT` returns `308` with readable exact `Range`;
- the final browser response may be readable or CORS-hidden;
- the metadata-only completion path observes the exact file identity,
  ownership, MIME type, and 524288-byte size;
- the server records ready only after that evidence;
- Vercel traffic contains no 256 KiB request body;
- cleanup succeeds and no sensitive value appears in logs or evidence.

The implementation sequence first adds project provisioning, the protected
upload-session/completion services, and the minimum two-chunk coordinator
needed to exercise this path. The revised gate then runs before the remaining
resume UI, free-tier dashboard composition, and full Test 1 acceptance work.
If the revised gate fails, those later surfaces remain blocked and the design
returns to review.

## 10. Rollback

Rollback restores the previous application deployment. No schema downgrade is
needed. Pending private Drive files and IndexedDB session records are retained;
rollback does not delete user content. The control plane remains fail-closed
until a compatible deployment resumes verification.

## 11. References

- Google Drive resumable upload protocol:
  <https://developers.google.com/workspace/drive/api/guides/manage-uploads>
- Google Drive `files.get` reference:
  <https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get>
- Parent CP-2 design:
  `docs/superpowers/specs/2026-07-19-cp2-google-drive-design.md`
