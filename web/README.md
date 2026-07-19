# YTB VPS Control Plane

This directory is the short-request metadata control plane. It never accepts video bytes or runs the media pipeline.

## Local verification

1. Install Node.js 22.
2. Create a free Neon project, then copy `.env.example` to `.env.local`. Before running the application, replace `DATABASE_URL`, `ADMIN_KEY_HASH`, and `SESSION_SECRET`; the tracked values are deliberately unusable placeholders.
3. Set `DATABASE_URL` to the project's Neon HTTP-compatible PostgreSQL connection string. The application runtime uses the Neon serverless HTTP driver, so an ordinary local TCP-only PostgreSQL URL is not supported here.
4. Generate `ADMIN_KEY_HASH` by running `node scripts/hash-admin-key.mjs`. Type a private admin key only at the stdin prompt, then copy the emitted `scrypt$...` hash into `.env.local`; keep the plaintext admin key private and never commit it.
5. Generate `SESSION_SECRET` with `node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("base64url") + "\n")'`. This prints a random 64-character value. Copy each generated output into `.env.local`, never into a tracked file.
6. Run `npm ci`.
7. Run `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`.
8. Run `npm run db:migrate` against that same Neon database. The migration command uses a direct PostgreSQL client, while application requests use Neon HTTP; migration and PGlite tests are separate from the application runtime.
9. Run `npm run dev` and open `http://localhost:3000`.

Phase 8 does not connect Google Drive or a GPU worker. Those buttons remain safe empty states until their owning phase.
