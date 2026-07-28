# YTB VPS Control Plane

This directory is the short-request metadata control plane. It never accepts video bytes or runs the media pipeline.

## Local verification

1. Install Node.js 22.
2. Create a free Neon project, then copy `.env.example` to `.env.local`. At minimum, replace `DATABASE_URL`, `ADMIN_KEY_HASH`, and `SESSION_SECRET`, then replace every remaining placeholder; the tracked values are deliberately unusable.
3. Set `DATABASE_URL` to the project's Neon HTTP-compatible PostgreSQL connection string. The application runtime uses the Neon serverless HTTP driver, so an ordinary local TCP-only PostgreSQL URL is not supported here.
4. Generate `ADMIN_KEY_HASH` by running `node scripts/hash-admin-key.mjs`. Type a private admin key only at the stdin prompt, then copy the emitted `scrypt$...` hash into `.env.local`; keep the plaintext admin key private and never commit it.
5. Generate `SESSION_SECRET` with `node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("base64url") + "\n")'`. This prints a random 64-character value. Copy each generated output into `.env.local`, never into a tracked file.
6. Create a Google Web application OAuth client for the exact callback `APP_ORIGIN/api/v1/drive/callback`. Enable Drive API, request only `https://www.googleapis.com/auth/drive.file`, and place the client ID/secret only in `.env.local` or Vercel Production.
7. Generate `DRIVE_TOKEN_KEY_V1` with `node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url") + "\n")'`. Store it only as a secret; changing it forces Drive reauthentication.
8. Keep the free-tier safety values exactly as shown in `.env.example`. Do not enable billing or configure a paid fallback.
9. Configure the BV074 preview credential. On Vercel, store one complete device JSON document in `CAPCUT_DEVICE_JSON_V1` as raw JSON or base64-encoded JSON; never commit that value or any `device-*.json` file. `CAPCUT_DEVICE_PATH_V1` is only an alternative for a persistent Node host with a private local file, and is not suitable for Vercel's ephemeral filesystem. If both are set, the inline value takes precedence. Redeploy after changing a Vercel environment variable.
10. Run `npm ci`.
11. Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and `npm audit --audit-level=low`.
12. Run `npm run db:migrate` twice against that same Neon database to verify the additive migration is idempotent. The migration command uses a direct PostgreSQL client, while application requests use Neon HTTP; migration and PGlite tests are separate from the application runtime. In production the same command also runs as the first half of the Vercel build command (`web/vercel.json`), because deploying code without the matching schema takes the dashboard down: it is the one place where `DATABASE_URL` is reachable when every production variable is marked sensitive.
13. Run `npm run dev` and open `http://localhost:3000`.

The control plane stores only metadata in Neon. Source video chunks travel directly from the signed-in browser to the private Google Drive resumable endpoint; Vercel never receives video bytes. GPU VPS attachment remains a safe empty state until its owning phase.

## Deployment

The production Vercel project is connected to the private `manhthien2005/ytb-vps-scene` repository with `web` as its root directory. Keep runtime secrets, including `CAPCUT_DEVICE_JSON_V1`, in Vercel Environment Variables; never commit `.env.local` or generated credentials. The preview route deliberately has no Edge TTS or browser voice fallback, so missing or rejected CapCut credentials surface as `TTS_PREVIEW_UNAVAILABLE` instead of silently changing the voice.
