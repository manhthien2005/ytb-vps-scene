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
9. Run `npm ci`.
10. Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and `npm audit --audit-level=low`.
11. Run `npm run db:migrate` twice against that same Neon database to verify the additive migration is idempotent. The migration command uses a direct PostgreSQL client, while application requests use Neon HTTP; migration and PGlite tests are separate from the application runtime.
12. Run `npm run dev` and open `http://localhost:3000`.

The control plane stores only metadata in Neon. Source video chunks travel directly from the signed-in browser to the private Google Drive resumable endpoint; Vercel never receives video bytes. GPU VPS attachment remains a safe empty state until its owning phase.
