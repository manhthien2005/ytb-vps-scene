# YTB VPS Control Plane

This directory is the short-request metadata control plane. It never accepts video bytes or runs the media pipeline.

## Local verification

1. Install Node.js 22.
2. Create a free Neon project, then copy `.env.example` to `.env.local` and replace its placeholder with the project's Neon HTTP-compatible connection string. The application runtime uses the Neon serverless HTTP driver, so an ordinary local TCP-only PostgreSQL URL is not supported here.
3. Run `npm ci`.
4. Run `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`.
5. Run `npm run db:migrate` against that same Neon database. The migration command uses a direct PostgreSQL client, while application requests use Neon HTTP; migration and PGlite tests are separate from the application runtime.
6. Run `npm run dev` and open `http://localhost:3000`.

Generate a production admin hash with `node scripts/hash-admin-key.mjs`. Enter the key through stdin; never place it in a command argument or commit it.

Phase 8 does not connect Google Drive or a GPU worker. Those buttons remain safe empty states until their owning phase.
