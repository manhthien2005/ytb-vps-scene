# YouTube Channels & Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a YouTube surface to the control plane that connects the operator's channels over read-only OAuth, shows each channel's headline stats and top 5 videos, and stores a per-channel prompt set for the metadata composer built in the follow-up plan.

**Architecture:** Reuses the existing Drive OAuth machinery by parameterising two modules that are currently hard-wired to Drive (`createGoogleOAuthAdapter`, `createCredentialCipher`). YouTube credentials live in a new multi-row `youtube_channels` table encrypted under a separate key. Channel stats come from two different Google APIs — Data API for lifetime counters, Analytics API for watch time — and are cached as a snapshot row so page loads never hit Google.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 5.8, Neon serverless Postgres, Zod 4, Vitest 3, pglite (migration tests). No new npm dependencies.

## Global Constraints

- **No new npm dependencies.** Google APIs are called with `fetch` through `lib/adapters/google/http.ts`, exactly as the Drive adapters do.
- **Read-only YouTube scopes only.** Exactly `https://www.googleapis.com/auth/youtube.readonly` and `https://www.googleapis.com/auth/yt-analytics.readonly`. Never request an upload or write scope in this plan.
- **Drive ciphertext compatibility is mandatory.** When parameterising `createCredentialCipher`, the Drive call site must keep producing AAD `ytb-vps:drive-refresh-token:v1:<id>:<scope>`. Changing that string destroys every stored Drive credential.
- **`googleJson` caps are hard:** `timeoutMs` ≤ 5000, `maxResponseBytes` ≤ 65536, `attempts` ≤ 3. Every YouTube list call MUST send a `fields` mask so a 50-item page stays under 64 KB.
- **Migrations are append-only and idempotent.** `schema.sql` is replayed in full on every deploy (`vercel.json` runs `npm run db:migrate` before `next build`). Guard v11 with `if not exists(select 1 from schema_migrations where version = 11)` and finish with the version insert.
- **Secrets never reach the client.** `YOUTUBE_TOKEN_KEY_V1` and refresh tokens stay in server-only modules (`import "server-only"`).
- **Subscriber counts are rounded by YouTube** to 3 significant figures. Every UI surface showing the number must label it as rounded.
- Repo commands run from `web/`: `npm test`, `npm run typecheck`, `npm run lint`.

---

## File Structure

**Create**

| Path | Responsibility |
|---|---|
| `web/src/lib/domain/youtube.ts` | Scope constants, channel-id validation, YouTube field limits. Pure, no I/O. |
| `web/src/lib/ports/youtube.ts` | `YouTubeDataPort`, `YouTubeAnalyticsPort` interfaces. |
| `web/src/lib/adapters/google/youtube-data.ts` | `channels.list`, `playlistItems.list`, `videos.list`. |
| `web/src/lib/adapters/google/youtube-analytics.ts` | Analytics `reports.query`. |
| `web/src/lib/repositories/youtube-control-plane.ts` | Repository interface for channels + stats. |
| `web/src/lib/repositories/neon-youtube-control-plane.ts` | Neon implementation. |
| `web/src/lib/application/youtube-connection.ts` | Begin/complete/disconnect a channel connection. |
| `web/src/lib/application/youtube-stats.ts` | Compose a stats snapshot from both APIs. |
| `web/src/lib/application/configured-youtube.ts` | Wire env → adapters, mirroring `configured-drive.ts`. |
| `web/src/app/api/v1/youtube/connect/route.ts` | Start OAuth. |
| `web/src/app/api/v1/youtube/callback/route.ts` | Finish OAuth, identify channel. |
| `web/src/app/api/v1/youtube/channels/route.ts` | List connected channels + snapshots. |
| `web/src/app/api/v1/youtube/channels/[id]/refresh/route.ts` | Pull a fresh snapshot. |
| `web/src/app/api/v1/youtube/channels/[id]/prompts/route.ts` | Save the channel prompt set. |
| `web/src/app/api/v1/youtube/channels/[id]/route.ts` | Disconnect (DELETE). |
| `web/src/components/youtube-channel-card.tsx` | One channel card. |
| `web/src/components/youtube-channel-prompts.tsx` | Prompt editor form. |
| `web/src/components/youtube-surface.tsx` | The surface: list + detail. |

**Modify**

| Path | Change |
|---|---|
| `web/src/lib/db/schema.sql` | Append migration v11. |
| `web/src/lib/security/credential-cipher.ts` | Parameterise domain + allowed scopes. |
| `web/src/lib/adapters/google/oauth.ts` | Parameterise scopes. |
| `web/src/lib/application/drive-connection.ts` | Pass Drive scope list to the adapter. |
| `web/src/app/api/v1/drive/connect/route.ts`, `callback/route.ts`, `disconnect/route.ts` | Pass Drive cipher domain + scopes. |
| `web/src/lib/config/env.ts` | Add `YOUTUBE_TOKEN_KEY_V1`. |
| `web/src/lib/domain/errors.ts` | Add YouTube public codes. |
| `web/src/components/dashboard-shell.tsx` | Add the `youtube` nav item and surface. |
| `web/.env.example`, `web/README.md` | Document the new variable and the production-status requirement. |

---

## Task 1: Migration v11 — YouTube tables

**Files:**
- Modify: `web/src/lib/db/schema.sql` (append at end, after the v10 block)
- Test: `web/src/lib/db/schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: tables `youtube_channels`, `youtube_channel_stats`; `artifacts.kind` widened to accept `'TRANSCRIPT'` and `'THUMB_CANDIDATE'` (used by the follow-up plan).

- [ ] **Step 1: Read the existing migration test to match its style**

Run: `cat web/src/lib/db/schema.test.ts`

Note how it boots pglite and applies `schema.sql`. Reuse that helper; do not invent a new one.

- [ ] **Step 2: Write the failing test**

Append to `web/src/lib/db/schema.test.ts`:

```ts
it("migration v11 creates youtube tables and widens artifact kinds", async () => {
  const db = await migratedDatabase();

  const version = await db.query<{ count: number }>(
    "select count(*)::int as count from schema_migrations where version = 11",
  );
  expect(version.rows[0]!.count).toBe(1);

  await db.exec(`
    insert into youtube_channels (id, channel_id, title, status, default_tags)
    values (
      '11111111-1111-4111-8111-111111111111',
      'UCabcdefghijklmnopqrstuv',
      'Kênh thử',
      'DISCONNECTED',
      '[]'::jsonb
    )
  `);

  await expect(db.exec(`
    insert into youtube_channels (id, channel_id, title, status, default_tags)
    values (
      '22222222-2222-4222-8222-222222222222',
      'UCabcdefghijklmnopqrstuv',
      'Trùng channel_id',
      'DISCONNECTED',
      '[]'::jsonb
    )
  `)).rejects.toThrow();

  await expect(db.exec(`
    insert into youtube_channels (id, channel_id, title, status, default_tags)
    values (
      '33333333-3333-4333-8333-333333333333',
      'UCzzzzzzzzzzzzzzzzzzzzzz',
      'Thiếu ciphertext',
      'CONNECTED',
      '[]'::jsonb
    )
  `)).rejects.toThrow();
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `cd web && npx vitest run src/lib/db/schema.test.ts -t "migration v11"`
Expected: FAIL — `relation "youtube_channels" does not exist`.

- [ ] **Step 4: Append migration v11 to `schema.sql`**

```sql
-- migration v11: YouTube channel connections, cached stats, and per-channel prompts
do $$
begin
  if not exists(select 1 from schema_migrations where version = 11) then
    alter table artifacts drop constraint if exists artifacts_kind_check;
    alter table artifacts add constraint artifacts_kind_check check (
      kind in ('SOURCE','CHECKPOINT','OUTPUT','TRANSCRIPT','THUMB_CANDIDATE')
    );
  end if;
end $$;

create table if not exists youtube_channels (
  id text primary key check (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  channel_id text not null unique check (channel_id ~ '^UC[A-Za-z0-9_-]{22}$'),
  title text not null check (title = btrim(title) and length(title) between 1 and 160),
  avatar_url text check (avatar_url is null or (length(avatar_url) between 1 and 1024 and avatar_url like 'https://%')),
  published_at timestamptz,
  status text not null check (status in ('CONNECTED','REAUTH_REQUIRED','DISCONNECTED')),
  ciphertext bytea check (ciphertext is null or octet_length(ciphertext) <= 4096),
  nonce bytea,
  auth_tag bytea,
  key_version smallint,
  scope text,
  title_prompt text check (title_prompt is null or length(title_prompt) <= 4000),
  description_prompt text check (description_prompt is null or length(description_prompt) <= 4000),
  description_template text check (description_template is null or length(description_template) <= 5000),
  default_tags jsonb not null default '[]'::jsonb check (
    jsonb_typeof(default_tags) = 'array' and pg_column_size(default_tags) <= 2048
  ),
  thumbnail_prompt_template text check (
    thumbnail_prompt_template is null or length(thumbnail_prompt_template) <= 4000
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (
      status = 'CONNECTED'
      and ciphertext is not null
      and nonce is not null
      and auth_tag is not null
      and octet_length(nonce) = 12
      and octet_length(auth_tag) = 16
      and key_version = 1
      and scope is not null
    )
    or
    (
      status in ('REAUTH_REQUIRED','DISCONNECTED')
      and ciphertext is null
      and nonce is null
      and auth_tag is null
      and key_version is null
      and scope is null
    )
  )
);

create table if not exists youtube_channel_stats (
  channel_id text primary key references youtube_channels(id),
  subscriber_count bigint check (subscriber_count is null or subscriber_count >= 0),
  view_count bigint check (view_count is null or view_count >= 0),
  video_count bigint check (video_count is null or video_count >= 0),
  watch_hours bigint check (watch_hours is null or watch_hours >= 0),
  top_videos jsonb not null default '[]'::jsonb check (
    jsonb_typeof(top_videos) = 'array' and pg_column_size(top_videos) <= 8192
  ),
  observed_at timestamptz not null,
  updated_at timestamptz not null default now()
);

insert into schema_migrations(version) values (11) on conflict (version) do nothing;
```

- [ ] **Step 5: Run the test again**

Run: `cd web && npx vitest run src/lib/db/schema.test.ts`
Expected: PASS, including the pre-existing "runs twice" idempotency test.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/db/schema.sql web/src/lib/db/schema.test.ts
git commit -m "feat(db): add youtube channel and stats tables"
```

---

## Task 2: Domain constants and limits

**Files:**
- Create: `web/src/lib/domain/youtube.ts`
- Test: `web/src/lib/domain/youtube.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `YOUTUBE_READONLY_SCOPE: string`, `YT_ANALYTICS_READONLY_SCOPE: string`
  - `YOUTUBE_SCOPES: readonly [string, string]`
  - `YOUTUBE_TITLE_MAX_CHARS = 100`, `YOUTUBE_DESCRIPTION_MAX_CHARS = 5000`, `YOUTUBE_TAGS_MAX_TOTAL_CHARS = 500`
  - `isChannelId(value: unknown): value is string`
  - `sameScopeSet(granted: readonly string[], expected: readonly string[]): boolean`

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/domain/youtube.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  isChannelId,
  sameScopeSet,
  YOUTUBE_SCOPES,
  YOUTUBE_TAGS_MAX_TOTAL_CHARS,
  YOUTUBE_TITLE_MAX_CHARS,
} from "./youtube";

describe("youtube domain", () => {
  it("pins the two read-only scopes", () => {
    expect(YOUTUBE_SCOPES).toEqual([
      "https://www.googleapis.com/auth/youtube.readonly",
      "https://www.googleapis.com/auth/yt-analytics.readonly",
    ]);
  });

  it("pins YouTube field limits", () => {
    expect(YOUTUBE_TITLE_MAX_CHARS).toBe(100);
    expect(YOUTUBE_TAGS_MAX_TOTAL_CHARS).toBe(500);
  });

  it("accepts canonical channel ids and rejects everything else", () => {
    expect(isChannelId("UCabcdefghijklmnopqrstuv")).toBe(true);
    expect(isChannelId("UCabc")).toBe(false);
    expect(isChannelId("XCabcdefghijklmnopqrstuv")).toBe(false);
    expect(isChannelId(42)).toBe(false);
  });

  it("compares scope sets ignoring order and rejecting extras", () => {
    expect(sameScopeSet(["b", "a"], ["a", "b"])).toBe(true);
    expect(sameScopeSet(["a"], ["a", "b"])).toBe(false);
    expect(sameScopeSet(["a", "b", "c"], ["a", "b"])).toBe(false);
    expect(sameScopeSet(["a", "a"], ["a", "b"])).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd web && npx vitest run src/lib/domain/youtube.test.ts`
Expected: FAIL — cannot resolve `./youtube`.

- [ ] **Step 3: Write the implementation**

Create `web/src/lib/domain/youtube.ts`:

```ts
export const YOUTUBE_READONLY_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
export const YT_ANALYTICS_READONLY_SCOPE = "https://www.googleapis.com/auth/yt-analytics.readonly";

export const YOUTUBE_SCOPES = [
  YOUTUBE_READONLY_SCOPE,
  YT_ANALYTICS_READONLY_SCOPE,
] as const;

export const YOUTUBE_TITLE_MAX_CHARS = 100;
export const YOUTUBE_DESCRIPTION_MAX_CHARS = 5_000;
export const YOUTUBE_TAGS_MAX_TOTAL_CHARS = 500;

const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;

export function isChannelId(value: unknown): value is string {
  return typeof value === "string" && CHANNEL_ID_PATTERN.test(value);
}

export function sameScopeSet(
  granted: readonly string[],
  expected: readonly string[],
): boolean {
  if (!Array.isArray(granted)) return false;
  const grantedSet = new Set(granted);
  if (grantedSet.size !== granted.length) return false;
  if (grantedSet.size !== expected.length) return false;
  return expected.every((scope) => grantedSet.has(scope));
}
```

- [ ] **Step 4: Run the test again**

Run: `cd web && npx vitest run src/lib/domain/youtube.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the YouTube public error codes**

In `web/src/lib/domain/errors.ts`, append to the `PUBLIC_CODES` array, before the closing `] as const;`:

```ts
  "YOUTUBE_NOT_CONNECTED", "YOUTUBE_REAUTH_REQUIRED", "YOUTUBE_CHANNEL_NOT_FOUND",
  "YOUTUBE_CHANNEL_ALREADY_CONNECTED", "YOUTUBE_PROVIDER_REJECTED",
  "YOUTUBE_RATE_LIMITED",
```

- [ ] **Step 6: Run the full suite and commit**

Run: `cd web && npm test && npm run typecheck`
Expected: PASS.

```bash
git add web/src/lib/domain/youtube.ts web/src/lib/domain/youtube.test.ts web/src/lib/domain/errors.ts
git commit -m "feat(domain): add youtube scopes, limits, and error codes"
```

---

## Task 3: Parameterise the credential cipher

The cipher is currently welded to Drive. This task makes it reusable **without changing what Drive produces**, so existing stored credentials keep decrypting.

**Files:**
- Modify: `web/src/lib/security/credential-cipher.ts`
- Modify: `web/src/lib/security/credential-cipher.test.ts`
- Modify: call sites — `web/src/lib/application/drive-connection.ts:191`, `web/src/lib/application/drive-connection.ts:235`, and every route that calls `createCredentialCipher(env.driveTokenKeyV1)`

**Interfaces:**
- Consumes: `YOUTUBE_SCOPES` from Task 2.
- Produces:
  ```ts
  export type CipherProfile = Readonly<{ domain: string; scopes: readonly string[] }>;
  export const DRIVE_CIPHER_PROFILE: CipherProfile;   // { domain: "drive-refresh-token", scopes: [DRIVE_FILE_SCOPE] }
  export const YOUTUBE_CIPHER_PROFILE: CipherProfile; // { domain: "youtube-refresh-token", scopes: YOUTUBE_SCOPES }
  export function createCredentialCipher(keyBase64url: string, profile: CipherProfile): CredentialCipher;
  export type EncryptedCredential = Readonly<{
    ciphertext: string; nonce: string; authTag: string; keyVersion: 1; scope: string;
  }>;
  export interface CredentialCipher {
    encrypt(id: string, scope: string, plaintext: string): EncryptedCredential;
    decrypt(id: string, envelope: EncryptedCredential): string;
  }
  ```

- [ ] **Step 1: Write the regression test that pins Drive AAD compatibility**

Append to `web/src/lib/security/credential-cipher.test.ts`:

```ts
it("keeps Drive envelopes decryptable after profiles were introduced", () => {
  const key = Buffer.alloc(32, 7).toString("base64url");
  const cipher = createCredentialCipher(key, DRIVE_CIPHER_PROFILE);
  const envelope = cipher.encrypt("1", DRIVE_FILE_SCOPE, "refresh-token-value");

  expect(envelope.scope).toBe(DRIVE_FILE_SCOPE);
  expect(cipher.decrypt("1", envelope)).toBe("refresh-token-value");
});

it("refuses a scope the profile does not allow", () => {
  const key = Buffer.alloc(32, 7).toString("base64url");
  const cipher = createCredentialCipher(key, DRIVE_CIPHER_PROFILE);
  expect(() => cipher.encrypt("1", YOUTUBE_SCOPES[0], "x")).toThrow();
});

it("cannot decrypt an envelope produced under a different profile", () => {
  const key = Buffer.alloc(32, 7).toString("base64url");
  const drive = createCredentialCipher(key, DRIVE_CIPHER_PROFILE);
  const youtube = createCredentialCipher(key, YOUTUBE_CIPHER_PROFILE);
  const envelope = youtube.encrypt("abc", YOUTUBE_SCOPES[0], "secret");

  expect(() => drive.decrypt("abc", envelope)).toThrow("CREDENTIAL_UNAVAILABLE");
});
```

Add the imports the new cases need at the top of the file:

```ts
import { DRIVE_FILE_SCOPE } from "@/lib/domain/drive";
import { YOUTUBE_SCOPES } from "@/lib/domain/youtube";
import {
  createCredentialCipher,
  DRIVE_CIPHER_PROFILE,
  YOUTUBE_CIPHER_PROFILE,
} from "./credential-cipher";
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd web && npx vitest run src/lib/security/credential-cipher.test.ts`
Expected: FAIL — `DRIVE_CIPHER_PROFILE` is not exported.

- [ ] **Step 3: Rewrite the cipher with a profile parameter**

Replace the Drive-specific pieces in `web/src/lib/security/credential-cipher.ts`. The AAD builder must keep the exact Drive string:

```ts
import { DRIVE_FILE_SCOPE } from "@/lib/domain/drive";
import { YOUTUBE_SCOPES } from "@/lib/domain/youtube";

export type CipherProfile = Readonly<{
  domain: string;
  scopes: readonly string[];
}>;

export const DRIVE_CIPHER_PROFILE: CipherProfile = Object.freeze({
  domain: "drive-refresh-token",
  scopes: [DRIVE_FILE_SCOPE] as const,
});

export const YOUTUBE_CIPHER_PROFILE: CipherProfile = Object.freeze({
  domain: "youtube-refresh-token",
  scopes: YOUTUBE_SCOPES,
});

export type EncryptedCredential = Readonly<{
  ciphertext: string;
  nonce: string;
  authTag: string;
  keyVersion: 1;
  scope: string;
}>;

export interface CredentialCipher {
  encrypt(id: string, scope: string, plaintext: string): EncryptedCredential;
  decrypt(id: string, envelope: EncryptedCredential): string;
}

// Unchanged for Drive: domain "drive-refresh-token" reproduces the original
// `ytb-vps:drive-refresh-token:v1:<id>:<scope>` byte-for-byte, so credentials
// stored before this refactor still decrypt.
function aad(domain: string, id: string, scope: string): Buffer {
  return Buffer.from(`ytb-vps:${domain}:v1:${id}:${scope}`, "utf8");
}
```

Then change the factory signature and the two scope checks:

```ts
export function createCredentialCipher(
  keyBase64url: string,
  profile: CipherProfile,
): CredentialCipher {
  let key: Buffer | null = null;
  try {
    key = decodeCanonicalBase64url(keyBase64url, KEY_BYTES);
  } catch {
    key = null;
  }
  if (!key) throw new Error("INVALID_TOKEN_KEY");
  if (
    typeof profile?.domain !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(profile.domain) ||
    !Array.isArray(profile.scopes) ||
    profile.scopes.length === 0
  ) {
    throw new Error("INVALID_CIPHER_PROFILE");
  }

  return {
    encrypt(id, scope, plaintext) {
      if (!profile.scopes.includes(scope) || typeof plaintext !== "string") throw unavailable();
      // ...unchanged body, but call aad(profile.domain, id, scope)
    },
    decrypt(id, envelope) {
      // ...unchanged, except:
      //   envelope.scope check becomes: !profile.scopes.includes(envelope.scope)
      //   setAAD becomes: decipher.setAAD(aad(profile.domain, id, envelope.scope))
    },
  };
}
```

Note the behaviour change inside `decrypt`: it previously hardcoded `DRIVE_FILE_SCOPE` in `setAAD`. It must now use `envelope.scope`, which is safe because `envelope.scope` is already validated against `profile.scopes` immediately above.

- [ ] **Step 4: Update every call site**

Find them: `cd web && grep -rn "createCredentialCipher(" src --include=*.ts --include=*.tsx`

Every existing call becomes `createCredentialCipher(env.driveTokenKeyV1, DRIVE_CIPHER_PROFILE)` with `DRIVE_CIPHER_PROFILE` added to the import from `@/lib/security/credential-cipher`.

- [ ] **Step 5: Run the whole suite**

Run: `cd web && npm test && npm run typecheck`
Expected: PASS — every pre-existing Drive OAuth test still green. If any Drive test fails, the AAD changed; fix it rather than updating the test.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/security/credential-cipher.ts web/src/lib/security/credential-cipher.test.ts web/src/lib/application/drive-connection.ts web/src/app/api/v1/drive
git commit -m "refactor(security): give the credential cipher a profile so YouTube can reuse it"
```

---

## Task 4: Parameterise OAuth scopes

**Files:**
- Modify: `web/src/lib/adapters/google/oauth.ts:140`, `web/src/lib/adapters/google/oauth.ts:181`
- Modify: `web/src/lib/adapters/google/oauth.test.ts`
- Modify: `web/src/lib/ports/drive.ts` (no signature change needed — the scopes are bound at construction)
- Modify: Drive call sites that call `createGoogleOAuthAdapter({...})`

**Interfaces:**
- Consumes: `sameScopeSet`, `YOUTUBE_SCOPES` from Task 2.
- Produces: `createGoogleOAuthAdapter(options: { clientId: string; clientSecret: string; scopes: readonly string[]; fetcher?: typeof fetch })` — `scopes` is now **required**.

- [ ] **Step 1: Write the failing test**

Append to `web/src/lib/adapters/google/oauth.test.ts`:

```ts
it("puts every configured scope into the authorization url", () => {
  const adapter = createGoogleOAuthAdapter({
    clientId: "cid",
    clientSecret: "secret",
    scopes: YOUTUBE_SCOPES,
  });
  const url = new URL(adapter.buildAuthorizationUrl({
    state: "state-value",
    redirectUri: "https://example.test/api/v1/youtube/callback",
  }));

  expect(url.searchParams.get("scope")).toBe(YOUTUBE_SCOPES.join(" "));
  expect(url.searchParams.get("access_type")).toBe("offline");
  expect(url.searchParams.get("include_granted_scopes")).toBe("false");
});

it("rejects a refresh response whose scope set does not match", async () => {
  const fetcher = stubJson({
    access_token: "token",
    expires_in: 3600,
    token_type: "Bearer",
    scope: YOUTUBE_SCOPES[0],
  });
  const adapter = createGoogleOAuthAdapter({
    clientId: "cid",
    clientSecret: "secret",
    scopes: YOUTUBE_SCOPES,
    fetcher,
  });

  await expect(adapter.refreshAccessToken("refresh", 5_000))
    .rejects.toMatchObject({ code: "OAUTH_SCOPE_REJECTED" });
});
```

Reuse whatever `stubJson`-style helper the existing tests in this file already define; do not add a second one.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd web && npx vitest run src/lib/adapters/google/oauth.test.ts`
Expected: FAIL — `scopes` is not a known property.

- [ ] **Step 3: Change the adapter**

In `web/src/lib/adapters/google/oauth.ts`:

```ts
type GoogleOAuthOptions = Readonly<{
  clientId: string;
  clientSecret: string;
  scopes: readonly string[];
  fetcher?: typeof fetch;
}>;
```

Validate in the factory, alongside the existing `clientId`/`clientSecret` checks:

```ts
if (
  !Array.isArray(options.scopes) ||
  options.scopes.length < 1 ||
  options.scopes.length > MAX_SCOPES ||
  options.scopes.some((scope) => !boundedUtf8(scope, 1, 512)) ||
  new Set(options.scopes).size !== options.scopes.length
) {
  throw oauthError("DRIVE_PROVIDER_REJECTED");
}
```

Line 181 becomes:

```ts
url.searchParams.set("scope", options.scopes.join(" "));
```

`validateRefreshResponse` moves inside the factory (or takes the scopes as an argument) so line 140 becomes:

```ts
if (record.scope !== undefined) {
  const scopes = parseScopes(record.scope);
  if (!scopes || !sameScopeSet(scopes, options.scopes)) {
    throw oauthError("OAUTH_SCOPE_REJECTED", 400);
  }
}
```

Import `sameScopeSet` from `@/lib/domain/youtube`.

- [ ] **Step 4: Update Drive call sites**

Find them: `cd web && grep -rn "createGoogleOAuthAdapter(" src --include=*.ts`

Each gains `scopes: [DRIVE_FILE_SCOPE],`. Behaviour is unchanged because a single-element set comparison is equivalent to the old `length !== 1 && [0] !== DRIVE_FILE_SCOPE` check.

- [ ] **Step 5: Run the suite**

Run: `cd web && npm test && npm run typecheck`
Expected: PASS, all pre-existing Drive OAuth tests included.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/adapters/google/oauth.ts web/src/lib/adapters/google/oauth.test.ts web/src/lib/application/drive-connection.ts web/src/app/api/v1/drive
git commit -m "refactor(oauth): make the granted scope set configurable"
```

---

## Task 5: Environment variable

**Files:**
- Modify: `web/src/lib/config/env.ts`
- Modify: `web/src/lib/config/env.test.ts`
- Modify: `web/.env.example`

**Interfaces:**
- Produces: `ServerEnv.youtubeTokenKeyV1: string`.

- [ ] **Step 1: Write the failing test**

Append to `web/src/lib/config/env.test.ts`, following the shape of the existing `DRIVE_TOKEN_KEY_V1` cases:

```ts
it("requires YOUTUBE_TOKEN_KEY_V1 to encode exactly 32 bytes", () => {
  expect(() => parseServerEnv({ ...validEnv(), YOUTUBE_TOKEN_KEY_V1: "short" })).toThrow();
  expect(parseServerEnv(validEnv()).youtubeTokenKeyV1).toBe(validEnv().YOUTUBE_TOKEN_KEY_V1);
});
```

Add `YOUTUBE_TOKEN_KEY_V1: "B".repeat(43)` to whatever `validEnv()` helper the file already uses.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd web && npx vitest run src/lib/config/env.test.ts`
Expected: FAIL — `.strict()` rejects the unknown key, or `youtubeTokenKeyV1` is undefined.

- [ ] **Step 3: Add it to the schema**

In `cp2Schema`, next to `DRIVE_TOKEN_KEY_V1`:

```ts
  YOUTUBE_TOKEN_KEY_V1: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
```

Add a decoder mirroring `decodeDriveKey`:

```ts
function decodeYoutubeKey(value: string): Uint8Array {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value) {
    throw new Error("YOUTUBE_TOKEN_KEY_V1 must encode exactly 32 bytes");
  }
  return bytes;
}
```

Wire it: pass `YOUTUBE_TOKEN_KEY_V1: source.YOUTUBE_TOKEN_KEY_V1` into `cp2Schema.parse`, call `decodeYoutubeKey(cp2.YOUTUBE_TOKEN_KEY_V1)` beside `decodeDriveKey`, add `youtubeTokenKeyV1: string` to `ServerEnv`, and return `youtubeTokenKeyV1: cp2.YOUTUBE_TOKEN_KEY_V1`.

- [ ] **Step 4: Document it**

Append to `web/.env.example`:

```
YOUTUBE_TOKEN_KEY_V1=REPLACE_WITH_BASE64URL_ENCODED_32_BYTE_KEY
```

- [ ] **Step 5: Run and commit**

Run: `cd web && npm test && npm run typecheck`

```bash
git add web/src/lib/config/env.ts web/src/lib/config/env.test.ts web/.env.example
git commit -m "feat(config): add YOUTUBE_TOKEN_KEY_V1"
```

---

## Task 6: YouTube Data API adapter

**Files:**
- Create: `web/src/lib/ports/youtube.ts`
- Create: `web/src/lib/adapters/google/youtube-data.ts`
- Test: `web/src/lib/adapters/google/youtube-data.test.ts`

**Interfaces:**
- Consumes: `googleJson` from `./http`, `isChannelId` from Task 2.
- Produces:
  ```ts
  export type YouTubeChannelProfile = Readonly<{
    channelId: string; title: string; avatarUrl: string | null;
    publishedAt: string; subscriberCount: number | null;
    viewCount: number; videoCount: number; uploadsPlaylistId: string;
  }>;
  export type YouTubeVideoSummary = Readonly<{
    videoId: string; title: string; thumbnailUrl: string | null; viewCount: number;
  }>;
  export interface YouTubeDataPort {
    inspectMyChannel(accessToken: string): Promise<YouTubeChannelProfile>;
    listTopVideos(accessToken: string, uploadsPlaylistId: string, limit: number): Promise<readonly YouTubeVideoSummary[]>;
  }
  ```
  `subscriberCount` is `null` when `hiddenSubscriberCount` is true.

- [ ] **Step 1: Write the port**

Create `web/src/lib/ports/youtube.ts` with the three types and two interfaces above, plus the analytics port used by Task 7:

```ts
export type YouTubeWatchTime = Readonly<{ estimatedMinutesWatched: number }>;

export interface YouTubeAnalyticsPort {
  totalWatchTime(accessToken: string, input: Readonly<{
    startDate: string; endDate: string;
  }>): Promise<YouTubeWatchTime>;
}
```

- [ ] **Step 2: Write the failing test**

Create `web/src/lib/adapters/google/youtube-data.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createYouTubeDataAdapter } from "./youtube-data";

function jsonResponse(body: unknown): Response {
  const text = JSON.stringify(body);
  return new Response(text, {
    status: 200,
    headers: { "content-type": "application/json", "content-length": String(text.length) },
  });
}

describe("youtube data adapter", () => {
  it("maps a channel response and always sends a fields mask", async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      items: [{
        id: "UCabcdefghijklmnopqrstuv",
        snippet: {
          title: "Kênh phim",
          publishedAt: "2024-01-02T03:04:05Z",
          thumbnails: { medium: { url: "https://yt3.example/avatar.jpg" } },
        },
        statistics: {
          viewCount: "1234567",
          subscriberCount: "123000",
          hiddenSubscriberCount: false,
          videoCount: "210",
        },
        contentDetails: { relatedPlaylists: { uploads: "UUabcdefghijklmnopqrstuv" } },
      }],
    }));

    const profile = await createYouTubeDataAdapter(fetcher).inspectMyChannel("token");

    expect(profile).toEqual({
      channelId: "UCabcdefghijklmnopqrstuv",
      title: "Kênh phim",
      avatarUrl: "https://yt3.example/avatar.jpg",
      publishedAt: "2024-01-02T03:04:05Z",
      subscriberCount: 123000,
      viewCount: 1234567,
      videoCount: 210,
      uploadsPlaylistId: "UUabcdefghijklmnopqrstuv",
    });

    const requested = new URL(String(fetcher.mock.calls[0]![0]));
    expect(requested.searchParams.get("mine")).toBe("true");
    expect(requested.searchParams.get("fields")).toBeTruthy();
  });

  it("reports a hidden subscriber count as null", async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      items: [{
        id: "UCabcdefghijklmnopqrstuv",
        snippet: { title: "K", publishedAt: "2024-01-02T03:04:05Z", thumbnails: {} },
        statistics: { viewCount: "1", hiddenSubscriberCount: true, videoCount: "1" },
        contentDetails: { relatedPlaylists: { uploads: "UUabcdefghijklmnopqrstuv" } },
      }],
    }));

    const profile = await createYouTubeDataAdapter(fetcher).inspectMyChannel("token");
    expect(profile.subscriberCount).toBeNull();
    expect(profile.avatarUrl).toBeNull();
  });

  it("rejects an empty channel list", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ items: [] }));
    await expect(createYouTubeDataAdapter(fetcher).inspectMyChannel("token"))
      .rejects.toMatchObject({ code: "YOUTUBE_CHANNEL_NOT_FOUND" });
  });

  it("returns the highest-view videos first and stops at the limit", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        items: [{ contentDetails: { videoId: "v1" } }, { contentDetails: { videoId: "v2" } }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        items: [
          { id: "v1", snippet: { title: "Thấp", thumbnails: { medium: { url: "https://t/1.jpg" } } }, statistics: { viewCount: "10" } },
          { id: "v2", snippet: { title: "Cao", thumbnails: { medium: { url: "https://t/2.jpg" } } }, statistics: { viewCount: "900" } },
        ],
      }));

    const videos = await createYouTubeDataAdapter(fetcher)
      .listTopVideos("token", "UUabcdefghijklmnopqrstuv", 1);

    expect(videos).toEqual([
      { videoId: "v2", title: "Cao", thumbnailUrl: "https://t/2.jpg", viewCount: 900 },
    ]);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `cd web && npx vitest run src/lib/adapters/google/youtube-data.test.ts`
Expected: FAIL — cannot resolve `./youtube-data`.

- [ ] **Step 4: Implement the adapter**

Create `web/src/lib/adapters/google/youtube-data.ts`. Key requirements:

- Base URL `https://www.googleapis.com/youtube/v3`
- `inspectMyChannel` calls `channels.list?part=snippet,statistics,contentDetails&mine=true&fields=items(id,snippet(title,publishedAt,thumbnails/medium/url),statistics(viewCount,subscriberCount,hiddenSubscriberCount,videoCount),contentDetails/relatedPlaylists/uploads)`
- `listTopVideos` pages `playlistItems.list?playlistId=…&part=contentDetails&maxResults=50&fields=items/contentDetails/videoId,nextPageToken`, then batches ids 50 at a time into `videos.list?part=snippet,statistics&fields=items(id,snippet(title,thumbnails/medium/url),statistics/viewCount)`, sorts by `viewCount` descending in memory, and slices to `limit`
- **Cap pagination at 20 pages (1000 videos)** so a huge channel cannot burn quota unbounded
- Every call goes through `googleJson(fetcher, url, { headers: { authorization: \`Bearer ${accessToken}\` } }, { timeoutMs: 5_000, maxResponseBytes: 64 * 1_024, attempts: 2 })`
- Counter strings are parsed with a helper that rejects anything not matching `/^\d{1,15}$/` and throws `new AppError("YOUTUBE_PROVIDER_REJECTED", 502)`
- An empty `items` array on `channels.list` throws `new AppError("YOUTUBE_CHANNEL_NOT_FOUND", 404)`
- `hiddenSubscriberCount === true` ⇒ `subscriberCount: null`; a missing `thumbnails.medium.url` ⇒ `avatarUrl: null`
- Validate `channelId` with `isChannelId` before returning; reject otherwise

- [ ] **Step 5: Run the test**

Run: `cd web && npx vitest run src/lib/adapters/google/youtube-data.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/ports/youtube.ts web/src/lib/adapters/google/youtube-data.ts web/src/lib/adapters/google/youtube-data.test.ts
git commit -m "feat(youtube): add the Data API adapter for channel profile and top videos"
```

---

## Task 7: YouTube Analytics API adapter

**Files:**
- Create: `web/src/lib/adapters/google/youtube-analytics.ts`
- Test: `web/src/lib/adapters/google/youtube-analytics.test.ts`

**Interfaces:**
- Consumes: `YouTubeAnalyticsPort`, `YouTubeWatchTime` from Task 6's port file.
- Produces: `createYouTubeAnalyticsAdapter(fetcher?: typeof fetch): YouTubeAnalyticsPort`.

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/adapters/google/youtube-analytics.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createYouTubeAnalyticsAdapter } from "./youtube-analytics";

function jsonResponse(body: unknown): Response {
  const text = JSON.stringify(body);
  return new Response(text, {
    status: 200,
    headers: { "content-type": "application/json", "content-length": String(text.length) },
  });
}

describe("youtube analytics adapter", () => {
  it("queries channel==MINE and reads the single metric cell", async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      columnHeaders: [{ name: "estimatedMinutesWatched" }],
      rows: [[987654]],
    }));

    const result = await createYouTubeAnalyticsAdapter(fetcher).totalWatchTime("token", {
      startDate: "2024-01-02",
      endDate: "2026-07-27",
    });

    expect(result).toEqual({ estimatedMinutesWatched: 987654 });

    const requested = new URL(String(fetcher.mock.calls[0]![0]));
    expect(requested.searchParams.get("ids")).toBe("channel==MINE");
    expect(requested.searchParams.get("metrics")).toBe("estimatedMinutesWatched");
    expect(requested.searchParams.get("startDate")).toBe("2024-01-02");
    expect(requested.searchParams.get("endDate")).toBe("2026-07-27");
  });

  it("treats an empty row set as zero rather than an error", async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      columnHeaders: [{ name: "estimatedMinutesWatched" }],
      rows: [],
    }));

    const result = await createYouTubeAnalyticsAdapter(fetcher).totalWatchTime("token", {
      startDate: "2024-01-02",
      endDate: "2026-07-27",
    });
    expect(result).toEqual({ estimatedMinutesWatched: 0 });
  });

  it("rejects a malformed date", async () => {
    const fetcher = vi.fn();
    await expect(createYouTubeAnalyticsAdapter(fetcher).totalWatchTime("token", {
      startDate: "02-01-2024",
      endDate: "2026-07-27",
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd web && npx vitest run src/lib/adapters/google/youtube-analytics.test.ts`
Expected: FAIL — cannot resolve `./youtube-analytics`.

- [ ] **Step 3: Implement the adapter**

Create `web/src/lib/adapters/google/youtube-analytics.ts`:

- Endpoint `https://youtubeanalytics.googleapis.com/v2/reports`
- Query: `ids=channel==MINE`, `metrics=estimatedMinutesWatched`, `startDate`, `endDate`
- Validate both dates against `/^\d{4}-\d{2}-\d{2}$/` **before** calling; throw `new AppError("INVALID_REQUEST", 400)` if either fails
- Go through `googleJson` with the same bounds as Task 6
- `rows` absent or empty ⇒ `{ estimatedMinutesWatched: 0 }` (a brand-new channel has no data)
- A present cell that is not a non-negative safe integer ⇒ `new AppError("YOUTUBE_PROVIDER_REJECTED", 502)`

- [ ] **Step 4: Run the test**

Run: `cd web && npx vitest run src/lib/adapters/google/youtube-analytics.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/adapters/google/youtube-analytics.ts web/src/lib/adapters/google/youtube-analytics.test.ts
git commit -m "feat(youtube): add the Analytics API adapter for total watch time"
```

---

## Task 8: Repository

**Files:**
- Create: `web/src/lib/repositories/youtube-control-plane.ts`
- Create: `web/src/lib/repositories/neon-youtube-control-plane.ts`
- Test: `web/src/lib/repositories/neon-youtube-control-plane.test.ts`

**Interfaces:**
- Consumes: `EncryptedCredential` (Task 3), migration v11 (Task 1).
- Produces:
  ```ts
  export type YouTubeChannelRecord = Readonly<{
    id: string; channelId: string; title: string; avatarUrl: string | null;
    publishedAt: string | null;
    status: "CONNECTED" | "REAUTH_REQUIRED" | "DISCONNECTED";
    envelope: EncryptedCredential | null;
    titlePrompt: string | null; descriptionPrompt: string | null;
    descriptionTemplate: string | null; defaultTags: readonly string[];
    thumbnailPromptTemplate: string | null;
  }>;
  export type YouTubeStatsRecord = Readonly<{
    subscriberCount: number | null; viewCount: number | null; videoCount: number | null;
    watchHours: number | null;
    topVideos: readonly Readonly<{ videoId: string; title: string; thumbnailUrl: string | null; viewCount: number }>[];
    observedAt: string;
  }>;
  export interface YouTubeControlPlaneRepository {
    listChannels(): Promise<readonly YouTubeChannelRecord[]>;
    getChannel(id: string): Promise<YouTubeChannelRecord | null>;
    getChannelByChannelId(channelId: string): Promise<YouTubeChannelRecord | null>;
    saveConnectedChannel(input: Readonly<{
      id: string; channelId: string; title: string; avatarUrl: string | null;
      publishedAt: string | null; envelope: EncryptedCredential;
    }>): Promise<void>;
    setChannelStatus(id: string, status: "REAUTH_REQUIRED" | "DISCONNECTED"): Promise<void>;
    savePrompts(id: string, input: Readonly<{
      titlePrompt: string | null; descriptionPrompt: string | null;
      descriptionTemplate: string | null; defaultTags: readonly string[];
      thumbnailPromptTemplate: string | null;
    }>): Promise<boolean>;
    saveStats(id: string, stats: YouTubeStatsRecord): Promise<void>;
    getStats(id: string): Promise<YouTubeStatsRecord | null>;
    recordAudit(input: Readonly<{ eventType: string; targetId?: string; payload: Record<string, unknown> }>): Promise<void>;
  }
  ```

- [ ] **Step 1: Read the existing Neon repository to copy its style**

Run: `cd web && sed -n '1,80p' src/lib/repositories/neon-drive-control-plane.ts`

Match how it obtains a client, how it maps `bytea` to base64url, and how it records audit rows.

- [ ] **Step 2: Write the failing test**

Create `web/src/lib/repositories/neon-youtube-control-plane.test.ts` mirroring the setup in `neon-drive-control-plane.test.ts` (pglite-backed). Cover:

```ts
it("round-trips a connected channel including its envelope", async () => { /* saveConnectedChannel then getChannel */ });
it("upserts on channel_id so reconnecting the same channel does not duplicate", async () => { /* save twice, listChannels has length 1 */ });
it("clears credential columns when status moves to DISCONNECTED", async () => { /* setChannelStatus then expect envelope null */ });
it("savePrompts returns false for an unknown channel", async () => { /* expect false */ });
it("saveStats replaces the previous snapshot", async () => { /* save twice, getStats reflects the second */ });
```

Write the bodies out in full using the interface above — no `// ...` in the committed test.

- [ ] **Step 3: Run it and confirm it fails**

Run: `cd web && npx vitest run src/lib/repositories/neon-youtube-control-plane.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the interface file, then the Neon implementation**

`saveConnectedChannel` upserts on `channel_id` (`on conflict (channel_id) do update`) and always sets `status='CONNECTED'` plus `updated_at=now()`. `setChannelStatus` nulls `ciphertext`, `nonce`, `auth_tag`, `key_version`, `scope` — the table CHECK enforces this, so a partial update fails loudly.

- [ ] **Step 5: Run the test**

Run: `cd web && npx vitest run src/lib/repositories/neon-youtube-control-plane.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/repositories/youtube-control-plane.ts web/src/lib/repositories/neon-youtube-control-plane.ts web/src/lib/repositories/neon-youtube-control-plane.test.ts
git commit -m "feat(youtube): add the channel and stats repository"
```

---

## Task 9: Connection use-cases

**Files:**
- Create: `web/src/lib/application/youtube-connection.ts`
- Create: `web/src/lib/application/configured-youtube.ts`
- Test: `web/src/lib/application/youtube-connection.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–8, plus `issueOAuthState`/`verifyOAuthState` from `@/lib/security/oauth-state` and the existing `saveOAuthNonce`/`consumeOAuthNonce` on the **Drive** repository (the `oauth_states` table is shared).
- Produces:
  ```ts
  export function beginYouTubeConnection(input: { redirectUri: string; stateSecret: string; now: Date }, deps): Promise<{ authorizationUrl: string }>;
  export function completeYouTubeConnection(input: { state: string; code: string; redirectUri: string; stateSecret: string; now: Date }, deps): Promise<{ channelId: string; title: string }>;
  export function disconnectYouTubeChannel(input: { id: string; now: Date }, deps): Promise<{ status: "DISCONNECTED" }>;
  export function youtubeAccessToken(channel: YouTubeChannelRecord, deps): Promise<string>;
  ```

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/application/youtube-connection.test.ts` with fake ports (follow `drive-connection.test.ts` for the fake style). Cover:

```ts
it("rejects a grant that is missing one of the two scopes", async () => {
  // oauth.exchangeCode resolves grantedScopes: [YOUTUBE_READONLY_SCOPE]
  // expect completeYouTubeConnection to reject with OAUTH_SCOPE_REJECTED
});

it("rejects a replayed state", async () => {
  // repository.consumeOAuthNonce resolves false
  // expect OAUTH_STATE_REPLAYED
});

it("stores the channel identified by channels.list mine=true", async () => {
  // expect saveConnectedChannel called with the adapter's channelId/title/avatarUrl
});

it("reconnecting the same channel updates rather than duplicating", async () => {
  // getChannelByChannelId resolves an existing row; expect saveConnectedChannel still called once, no throw
});

it("marks a channel REAUTH_REQUIRED when the refresh token no longer decrypts", async () => {
  // cipher.decrypt throws; expect youtubeAccessToken to reject YOUTUBE_REAUTH_REQUIRED
  //   and setChannelStatus("REAUTH_REQUIRED") to have been called
});

it("revokes the refresh token on disconnect before clearing the row", async () => {
  // expect oauth.revokeRefreshToken called, then setChannelStatus("DISCONNECTED")
});
```

Write each body out in full.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd web && npx vitest run src/lib/application/youtube-connection.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Mirror `drive-connection.ts` closely: `STATE_LIFETIME_MS = 10 * 60 * 1_000`, `PROVIDER_TIMEOUT_MS = 5_000`, the same `providerCall` wrapper, the same nonce hashing. Differences:

- scope check is `sameScopeSet(exchanged.grantedScopes, YOUTUBE_SCOPES)`
- the credential id passed to `cipher.encrypt`/`cipher.decrypt` is the row's **UUID `id`**, not the constant `"1"` — this is what binds an envelope to one channel
- the row UUID is generated with `crypto.randomUUID()` for a new channel and reused for an existing one (look it up with `getChannelByChannelId` first)
- audit events: `YOUTUBE_CONNECT_STARTED`, `YOUTUBE_CONNECTED`, `YOUTUBE_DISCONNECTED`, payloads carrying only `{ status, keyVersion }` — never a token or a raw channel id

`configured-youtube.ts` mirrors `configured-drive.ts`: build the OAuth adapter with `scopes: YOUTUBE_SCOPES`, the cipher with `YOUTUBE_CIPHER_PROFILE` and `env.youtubeTokenKeyV1`, plus the two YouTube adapters.

- [ ] **Step 4: Run the test**

Run: `cd web && npx vitest run src/lib/application/youtube-connection.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/application/youtube-connection.ts web/src/lib/application/configured-youtube.ts web/src/lib/application/youtube-connection.test.ts
git commit -m "feat(youtube): add connect, disconnect, and access-token use-cases"
```

---

## Task 10: Stats snapshot use-case

**Files:**
- Create: `web/src/lib/application/youtube-stats.ts`
- Test: `web/src/lib/application/youtube-stats.test.ts`

**Interfaces:**
- Consumes: `YouTubeDataPort`, `YouTubeAnalyticsPort`, `YouTubeControlPlaneRepository`, `youtubeAccessToken`.
- Produces: `refreshChannelStats(input: { id: string; now: Date }, deps): Promise<YouTubeStatsRecord>`.

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/application/youtube-stats.test.ts`:

```ts
it("converts analytics minutes to whole watch hours", async () => {
  // analytics returns 987654 minutes -> expect watchHours 16460 (floor)
});

it("queries analytics from the channel publish date to today", async () => {
  // profile.publishedAt "2024-01-02T03:04:05Z", now 2026-07-27
  // expect startDate "2024-01-02" and endDate "2026-07-27"
});

it("still writes a snapshot when analytics fails", async () => {
  // analytics.totalWatchTime rejects
  // expect saveStats called with watchHours: null and the Data API numbers intact
});

it("keeps at most five top videos", async () => {
  // listTopVideos called with limit 5
});
```

Write each body out in full with explicit fakes.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd web && npx vitest run src/lib/application/youtube-stats.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Order of operations: load channel → get access token → `inspectMyChannel` → `listTopVideos(uploadsPlaylistId, 5)` → `totalWatchTime` wrapped in try/catch so an Analytics failure degrades to `watchHours: null` instead of losing the whole snapshot → `saveStats` → `recordAudit("YOUTUBE_STATS_REFRESHED")`.

Watch hours: `Math.floor(estimatedMinutesWatched / 60)`.

Also refresh the stored `title` and `avatarUrl` from the profile — channel names and avatars change.

- [ ] **Step 4: Run the test**

Run: `cd web && npx vitest run src/lib/application/youtube-stats.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/application/youtube-stats.ts web/src/lib/application/youtube-stats.test.ts
git commit -m "feat(youtube): compose a channel stats snapshot from both APIs"
```

---

## Task 11: API routes

**Files:**
- Create: `web/src/app/api/v1/youtube/connect/route.ts` (+ `.test.ts`)
- Create: `web/src/app/api/v1/youtube/callback/route.ts` (+ `.test.ts`)
- Create: `web/src/app/api/v1/youtube/channels/route.ts` (+ `.test.ts`)
- Create: `web/src/app/api/v1/youtube/channels/[id]/route.ts` (+ `.test.ts`)
- Create: `web/src/app/api/v1/youtube/channels/[id]/refresh/route.ts` (+ `.test.ts`)
- Create: `web/src/app/api/v1/youtube/channels/[id]/prompts/route.ts` (+ `.test.ts`)

**Interfaces:**
- Consumes: Tasks 9 and 10.
- Produces: HTTP surface consumed by Task 12.
  - `POST /api/v1/youtube/connect` → `{ authorizationUrl }`
  - `GET /api/v1/youtube/callback` → 302 to `/?youtube=connected` or `/?youtube_error=<CODE>`
  - `GET /api/v1/youtube/channels` → `{ channels: [{ id, channelId, title, avatarUrl, status, stats }] }`
  - `DELETE /api/v1/youtube/channels/:id` → `{ status: "DISCONNECTED" }`
  - `POST /api/v1/youtube/channels/:id/refresh` → `{ stats }`
  - `PUT /api/v1/youtube/channels/:id/prompts` → `{ saved: true }`

- [ ] **Step 1: Read two existing routes to copy the shape exactly**

Run: `cd web && cat src/app/api/v1/drive/connect/route.ts src/app/api/v1/projects/[id]/scene-settings/route.ts`

Copy: `export const runtime = "nodejs"`, `const HEADERS = { "cache-control": "no-store" }`, `requireAdmin`, `readStrictJson` with a Zod `.strict()` schema and a byte cap, `AppError` → `publicErrorBody`, and the `redactSecrets` fallback.

- [ ] **Step 2: Write the failing tests**

For each route create the sibling `.test.ts` following the existing route tests. Minimum coverage per route:

- unauthenticated request → 401 `AUTH_REQUIRED`
- happy path → expected body/redirect
- for `prompts`: a body exceeding `YOUTUBE_DESCRIPTION_MAX_CHARS` → 400 `INVALID_REQUEST`; an unknown channel id → 404 `YOUTUBE_CHANNEL_NOT_FOUND`
- for `callback`: `error=access_denied` → redirect carrying `youtube_error`

- [ ] **Step 3: Run them and confirm they fail**

Run: `cd web && npx vitest run src/app/api/v1/youtube`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement the routes**

The prompts schema:

```ts
const promptsSchema = z.object({
  titlePrompt: z.string().max(4_000).nullable(),
  descriptionPrompt: z.string().max(4_000).nullable(),
  descriptionTemplate: z.string().max(YOUTUBE_DESCRIPTION_MAX_CHARS).nullable(),
  defaultTags: z.array(z.string().min(1).max(100)).max(50),
  thumbnailPromptTemplate: z.string().max(4_000).nullable(),
}).strict();
```

`readStrictJson(request, promptsSchema, 32_768)`.

`callback/route.ts` follows `drive/callback/route.ts` exactly, including `parseCallbackQuery` — copy that function into the YouTube route rather than exporting it from the Drive route, since the two flows are allowed to diverge. Redirect targets use `youtube=` / `youtube_error=`.

The refresh route calls `refreshChannelStats` and must declare `export const maxDuration = 30` — a full refresh makes up to 20 paginated calls plus an Analytics query.

- [ ] **Step 5: Run the tests**

Run: `cd web && npx vitest run src/app/api/v1/youtube && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/app/api/v1/youtube
git commit -m "feat(api): add the youtube channel routes"
```

---

## Task 12: The YouTube surface

**Files:**
- Create: `web/src/components/youtube-channel-card.tsx` (+ `.test.tsx`)
- Create: `web/src/components/youtube-channel-prompts.tsx` (+ `.test.tsx`)
- Create: `web/src/components/youtube-surface.tsx` (+ `.test.tsx`)
- Modify: `web/src/components/dashboard-shell.tsx`
- Modify: `web/src/components/dashboard-types.ts`

**Interfaces:**
- Consumes: the routes from Task 11.
- Produces: a `youtube` entry in `SurfaceId` and the sidebar.

- [ ] **Step 1: Write the failing component tests**

`youtube-channel-card.test.tsx`:

```tsx
it("labels the subscriber count as rounded", () => {
  render(<YouTubeChannelCard channel={connectedChannel()} onOpen={() => {}} onRefresh={() => {}} />);
  expect(screen.getByText(/làm tròn/i)).toBeInTheDocument();
});

it("shows a reconnect prompt when the channel needs reauthentication", () => {
  render(<YouTubeChannelCard channel={{ ...connectedChannel(), status: "REAUTH_REQUIRED" }} onOpen={() => {}} onRefresh={() => {}} />);
  expect(screen.getByRole("button", { name: /kết nối lại/i })).toBeInTheDocument();
});

it("renders a dash instead of a number when the channel hides its subscriber count", () => {
  render(<YouTubeChannelCard channel={{ ...connectedChannel(), stats: { ...stats(), subscriberCount: null } }} onOpen={() => {}} onRefresh={() => {}} />);
  expect(screen.getByTestId("subscriber-count")).toHaveTextContent("—");
});
```

`youtube-channel-prompts.test.tsx`:

```tsx
it("blocks saving a description template past the YouTube limit", async () => {
  const onSave = vi.fn();
  render(<YouTubeChannelPrompts channel={connectedChannel()} onSave={onSave} />);
  await userEvent.clear(screen.getByLabelText(/khuôn mô tả/i));
  await userEvent.paste(screen.getByLabelText(/khuôn mô tả/i), "x".repeat(5_001));
  await userEvent.click(screen.getByRole("button", { name: /lưu/i }));
  expect(onSave).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent(/5000/);
});

it("sends every prompt field on save", async () => { /* full assertion on the onSave payload */ });
```

`youtube-surface.test.tsx`:

```tsx
it("shows an empty state with a connect button when no channel is linked", () => { /* ... */ });
it("lists one card per connected channel", () => { /* ... */ });
it("shows the top five videos when a channel is opened", async () => { /* ... */ });
```

Write each body out in full.

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd web && npx vitest run src/components/youtube`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the components**

Follow the existing component conventions: Vietnamese UI copy, `className` strings drawn from `app/globals.css` (`surface-panel`, `micro-label`, `side-nav-item`), no inline styles, no new CSS framework.

`YouTubeChannelCard` shows avatar, title, subscriber count with the rounded label, total views, watch hours, video count, last-refreshed timestamp, plus **Làm mới** and **Ngắt kết nối** buttons.

`YouTubeChannelPrompts` renders five controls bound to the prompts schema and enforces `YOUTUBE_DESCRIPTION_MAX_CHARS` client-side before calling `onSave`.

`YouTubeSurface` owns fetching `/api/v1/youtube/channels`, the empty state, the list, and the opened-channel detail with the top 5 videos and the prompts tab.

- [ ] **Step 4: Wire the nav**

In `dashboard-types.ts` add `"youtube"` to `SurfaceId`. In `dashboard-shell.tsx`:
- add a `YouTubeIcon` component beside `JobsIcon`
- add `{ id: "youtube", label: "YouTube", Icon: YouTubeIcon }` to `WORKSPACE_ITEMS`
- add `youtube: "Workspace"` to `SURFACE_EYEBROW`
- render `{surface === "youtube" && <YouTubeSurface />}` alongside the other surface blocks

- [ ] **Step 5: Run everything**

Run: `cd web && npm test && npm run typecheck && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/components
git commit -m "feat(web): add the YouTube surface with channel cards and per-channel prompts"
```

---

## Task 13: Operator documentation

**Files:**
- Modify: `web/README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing code-facing.

- [ ] **Step 1: Write the setup section**

Add a "Kết nối kênh YouTube" section to `web/README.md` covering:

1. Enable **YouTube Data API v3** and **YouTube Analytics API** on the same Google Cloud project the Drive OAuth client already uses.
2. Add both read-only scopes to the OAuth consent screen: `youtube.readonly`, `yt-analytics.readonly`.
3. **Set the OAuth consent screen publishing status to "In production".** Quote the reason verbatim: a project with an external-user consent screen and a publishing status of "Testing" is issued a refresh token expiring in 7 days, so every channel would need reconnecting weekly. Google verification is not required — the unverified-app warning can be dismissed by the project owner.
4. Add `https://<origin>/api/v1/youtube/callback` as an authorised redirect URI.
5. Generate `YOUTUBE_TOKEN_KEY_V1`: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
6. Connect each channel separately — one authorisation per channel.

Add a "Giới hạn đã biết" subsection stating: subscriber counts are rounded down to 3 significant figures by YouTube; thumbnail impressions and click-through rate are not exposed by any API and remain Studio-only.

- [ ] **Step 2: Commit**

```bash
git add web/README.md
git commit -m "docs(web): document YouTube channel setup and its known limits"
```

---

## Self-Review Notes

Checked against `docs/superpowers/specs/2026-07-27-youtube-workbench-design.md`:

- Spec §3.1 scopes → Task 2. §3.2 multi-row table + separate key → Tasks 1, 3, 5. §3.3 adapter reuse → Tasks 3, 4. §3.4 production-status trap → Task 13.
- Spec §4.1/§4.2 surface → Task 12. §4.3 stats sourcing, `fields` masks, quota budget → Tasks 6, 7, 10.
- Spec §8 migration v11 → Task 1. §9 env → Task 5. §10 known limits → Tasks 12 (rounded label) and 13 (README).
- Spec §5, §6, §7 (worker artifacts, Gemini composer, Publish surface) are **out of scope here** — they are the follow-up plan. Task 1 widens `artifacts.kind` ahead of time so the follow-up plan needs no second migration for it.
- Type consistency: `YouTubeChannelRecord`, `YouTubeStatsRecord`, `YouTubeChannelProfile`, `YouTubeVideoSummary` are defined once (Tasks 6, 8) and referenced by the same names in Tasks 9–12. `createCredentialCipher` gains its second parameter in Task 3 before any YouTube caller exists.
