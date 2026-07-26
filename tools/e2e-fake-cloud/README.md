# Local end-to-end rig

Runs the **real** control plane, the **real** browser uploader and the **real**
Python worker against local stand-ins for the two managed services, so the whole
workflow — Drive upload → project → scene settings → job → render → output — can
be exercised without a Neon project or a Google OAuth client.

Nothing here is imported by production code.

| Piece | What it replaces |
|---|---|
| `server.mjs` | Neon (serverless HTTP `/sql` protocol over PGlite) and Google (OAuth token/revoke, Drive v3 metadata, media download, resumable upload) |
| `preload.cjs` | `NODE_OPTIONS=--require` shim that redirects the hard-coded `oauth2.googleapis.com`, `www.googleapis.com` and Neon `/sql` origins at `fetch` level |
| `env.mjs` | generates throwaway secrets once per state directory |
| `write-env-local.mjs` | installs those values into `web/.env.local` (with a backup) |
| `browser-role.ts` | drives `src/lib/browser/resumable-uploader.ts` — the production uploader — against the rig |

## Run it

```bash
node tools/e2e-fake-cloud/server.mjs &
node tools/e2e-fake-cloud/env.mjs
node tools/e2e-fake-cloud/write-env-local.mjs --port 3100 --commit $(git rev-parse HEAD)
cd web && NODE_OPTIONS="--require ../tools/e2e-fake-cloud/preload.cjs" npx next dev --port 3100
```

Sign in at <http://localhost:3100> with `ADMIN_KEY_PLAINTEXT` from
`$TMP/ytb-vps-e2e-cloud/env.json`, then:

```bash
cd web
npx tsx ../tools/e2e-fake-cloud/browser-role.ts connect
npx tsx ../tools/e2e-fake-cloud/browser-role.ts upload ../resources/videos/Test1.mp4
npx tsx ../tools/e2e-fake-cloud/browser-role.ts scene <projectId>
npx tsx ../tools/e2e-fake-cloud/browser-role.ts job <projectId>
```

`upload` also accepts `--pause-at <bytes>` and `--cancel-at <bytes>` to exercise
resume and cancellation.

Restore the original environment file with
`node tools/e2e-fake-cloud/write-env-local.mjs --restore`.

## Inspection and fault injection

- `GET /__control/files` — everything in the fake Drive, with sizes and digests
- `GET /__control/log` — recent provider requests
- `POST /__control/sql` — `{query, params}` against the rig database
- `POST /__control/fault` — `{faults:[{match, status, times, body}]}`, matched on
  the request path, consumed once per `times`

## Attaching a real VPS worker

The worker only talks to an `https` origin and downloads media from
`https://www.googleapis.com`, so a real VPS needs both names pointed back at this
rig. Reverse-forward the control plane and the rig onto the VPS
(`ssh -R 3200:127.0.0.1:3200 -R 4680:127.0.0.1:4680`), terminate TLS there with a
certificate for `cp.local` + `www.googleapis.com` from a CA you add to that host's
trust store, and map both names to `127.0.0.1` in its `/etc/hosts`. Run the
control plane the worker sees with `APP_ORIGIN=https://cp.local`; the browser can
keep using `http://localhost:3100` from a second instance sharing this rig.

Remove the hosts entries, the CA and the TLS terminator afterwards — while they
are in place that VPS cannot reach the real Google.

## Known fidelity gaps

- Chunk `PUT`s cannot be driven from a real browser: the session URI must be on
  `www.googleapis.com`, which the rig cannot serve to it. `browser-role.ts` runs
  the production uploader in Node instead; everything else in the page is real.
- The rig always publishes `sha256Checksum` immediately after a resumable upload
  finalizes. Real Drive is expected to do the same, but a source finalized while
  the digest is still absent stays unqueueable.
