# CapCut BV074 v2 Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish and verify the existing BV074 port so preview and native rendering use the single legacy CapCut voice, old scene rows remain usable, deployment inputs are documented, and known blur behavior is evidenced.

**Architecture:** Keep BV074 as the only accepted output voice. Normalize the two legacy Edge voice identifiers only when reading persisted scene settings, while all newly serialized settings use `BV074_streaming`; keep the browser preview server-side through the authenticated Next.js route. Treat CapCut failure as an explicit failure because an Edge fallback would violate the one-voice requirement.

**Tech Stack:** Python 3.10-3.12/pytest, Next.js 16/TypeScript/Vitest, Node 22, local connector/Vitest, CapCut private TTS protocol, FFmpeg.

## Global Constraints

- Preserve all pre-existing user changes and do not commit without explicit approval.
- Never expose or add CapCut device credentials to Git.
- Accept only BV074 for new settings and synthesis.
- Do not add Edge TTS or browser SpeechSynthesis fallback.
- VPS CUDA 12.4 end-to-end validation remains an external acceptance gate.

---

### Task 1: Reproduce and live-check the TypeScript CapCut adapter

**Files:**
- Inspect: `web/src/lib/server/capcut-bv074-preview.ts`
- Test: `web/src/lib/server/capcut-bv074-preview.test.ts`

**Interfaces:**
- Consumes: `CAPCUT_DEVICE_JSON_V1` or `CAPCUT_DEVICE_PATH_V1`.
- Produces: `synthesizeCapCutBv074Preview(text: string, rate: number): Promise<Uint8Array>`.

- [ ] **Step 1: Reproduce the direct-run failure**

Run: `web/node_modules/.bin/tsx -e "import('./src/lib/server/capcut-bv074-preview.ts')"`

Expected: the exact module-resolution error is captured before changing code.

- [ ] **Step 2: Add adapter-level behavior tests**

Add tests which inject deterministic HTTP, DNS, clock, and delay boundaries and assert task creation, polling, BV074/resource ID, SSRF rejection, and downloaded bytes. The tests must import the real adapter rather than mocking it at the route boundary.

- [ ] **Step 3: Run the focused test and verify RED**

Run: `npm test -- src/lib/server/capcut-bv074-preview.test.ts`

Expected: FAIL because the current adapter has no injectable boundaries.

- [ ] **Step 4: Implement only the boundary injection required by the test**

Keep the exported production function unchanged and add a private/testable factory or optional dependency object. Preserve `import "server-only"` for the production server boundary; use the Next/Vitest resolver for automated validation and the real device file for the live call.

- [ ] **Step 5: Verify focused tests and perform a live request**

Run the focused Vitest file, then invoke the adapter with `device-021.json`, write the returned bytes outside the repository, and verify MP3 signature, non-trivial size, and media metadata.

Expected: focused tests pass and the live artifact is a decodable MP3.

### Task 2: Make persisted Edge-era scene rows backward compatible

**Files:**
- Modify: `web/src/lib/domain/scene-settings.ts`
- Test: `web/src/lib/domain/scene-settings.test.ts`
- Modify: `web/src/app/api/v1/projects/[id]/scene-settings/route.ts`
- Test: `web/src/app/api/v1/projects/[id]/scene-settings/route.test.ts`

**Interfaces:**
- Consumes: version-1 scene JSON containing `BV074_streaming`, `vi-VN-HoaiMyNeural`, or `vi-VN-NamMinhNeural`.
- Produces: `SceneSettings` whose voice is always `BV074_streaming`.

- [ ] **Step 1: Write failing compatibility tests**

Assert that both historical Edge identifiers parse to `BV074_streaming`, arbitrary identifiers still fail, and GET returns normalized settings.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- src/lib/domain/scene-settings.test.ts src/app/api/v1/projects/[id]/scene-settings/route.test.ts`

Expected: FAIL for historical rows and raw GET output.

- [ ] **Step 3: Implement read normalization**

Preprocess only the `voice` field for the two known legacy identifiers, then validate with the strict schema. Parse a non-null GET row before returning it; leave PUT strict after normalization and always return/store BV074.

- [ ] **Step 4: Verify GREEN**

Run the same focused command.

Expected: PASS with unknown voices still rejected.

### Task 3: Verify blur-section data flow

**Files:**
- Inspect: `web/src/components/scene-editor.tsx`
- Inspect: `src/ytb_vps_v2/application/media_job.py`
- Inspect: `src/ytb_vps_v2/adapters/native_media_job.py`
- Test: `tests_v2/application/test_media_job.py`

**Interfaces:**
- Consumes: normalized `sourceSubtitle` and `logo` rectangles.
- Produces: two source-pixel `BlurRegion` values passed into the native renderer.

- [ ] **Step 1: Trace both rectangles end to end**

Confirm UI save, API persistence, worker assignment, normalized-to-pixel conversion, and native pipeline consumption.

- [ ] **Step 2: Run the existing conversion test**

Run: `pytest tests_v2/application/test_media_job.py -q`

Expected: PASS; otherwise capture the first broken boundary and add a failing regression test before fixing.

- [ ] **Step 3: Report the investigation outcome**

State whether task #12 is implemented, partially implemented, or blocked, with exact file/behavior evidence. Do not invent UI or rendering changes without a reproduced gap.

### Task 4: Document production preview credentials

**Files:**
- Modify: `web/.env.example`
- Modify: `docs/00-TONG-QUAN.md` or the nearest deployment guide selected after inspection.

**Interfaces:**
- Consumes: one device JSON value or a server-local device path.
- Produces: documented Vercel/server configuration without checked-in secrets.

- [ ] **Step 1: Add safe placeholders**

Document `CAPCUT_DEVICE_JSON_V1` as raw JSON or base64 JSON for Vercel and `CAPCUT_DEVICE_PATH_V1` as the filesystem alternative for a persistent Node host.

- [ ] **Step 2: Add operational guidance**

Explain that Vercel should use the inline secret, never commit device files, and redeploy after changing the environment variable.

- [ ] **Step 3: Verify no credential material entered the diff**

Run a diff and secret-oriented scan over newly changed documentation/configuration.

Expected: placeholders only; no device IDs, install IDs, or trace IDs.

### Task 5: Full verification and review

**Files:**
- Review: every changed file from `git status --short`.

**Interfaces:**
- Consumes: Tasks 1-4 and the pre-existing BV074 port.
- Produces: evidence-backed readiness report with external blockers separated.

- [ ] **Step 1: Run all Python tests**

Run: `pytest`

Expected: zero failures.

- [ ] **Step 2: Run all web gates**

Run from `web/`: `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`.

Expected: zero failures/errors.

- [ ] **Step 3: Run all connector gates**

Run from `tools/local-vps-connector/`: `npm test` and `npm run typecheck`.

Expected: zero failures/errors.

- [ ] **Step 4: Review the complete diff**

Check correctness, secret handling, portability, SSRF defenses, timeout/error behavior, and test coverage. Fix only evidenced defects using RED-GREEN.

- [ ] **Step 5: Stop before commit**

Report results, recommend no Edge fallback because it changes voice identity, retain the CUDA 12.4 VPS end-to-end check as the sole external blocker, and wait for explicit commit approval.
