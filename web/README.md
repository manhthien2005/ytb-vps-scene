# YTB VPS Control Plane

This directory is the short-request metadata control plane. It never accepts video bytes or runs the media pipeline.

## Local verification

1. Install Node.js 22.
2. Copy `.env.example` to `.env.local` and use local-only values.
3. Run `npm ci`.
4. Run `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`.
5. Run `npm run db:migrate` against the intended metadata database.
6. Run `npm run dev` and open `http://localhost:3000`.

Generate a production admin hash with `node scripts/hash-admin-key.mjs`. Enter the key through stdin; never place it in a command argument or commit it.

Phase 8 does not connect Google Drive or a GPU worker. Those buttons remain safe empty states until their owning phase.
