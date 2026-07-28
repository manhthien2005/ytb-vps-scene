# V2 Development

V2 targets Python 3.10 in production and CI. The current Windows development
host may use Python 3.12 for fast local feedback because the package declares
support for Python `>=3.10,<3.13`.

## Install

From the repository root:

```powershell
python -m pip install --no-deps --no-build-isolation -e .
```

## Verify

```powershell
$env:PYTHONPATH = 'src'
python -m compileall -q src tests_v2
python -m unittest discover -s tests_v2 -t . -v
ytb-vps-v2 version
```

## Control-plane verification

From `web` with the required local environment variables set, run:

```powershell
npm test
npm run typecheck
npm run lint
npm run build
npm audit --audit-level=low
```

## Free production control plane

The supported production stack is Vercel Hobby + Neon Free + one private Google
Drive. No paid fallback is part of the design, and operators must never enable billing
for this workflow.

1. Create a Neon Free project. Put `DATABASE_URL` only in Vercel Production and
   run `npm run db:migrate` from `web`. Run it a second time to confirm the
   additive migration is idempotent. Production repeats the same command on
   every deploy through the build command in `web/vercel.json`; Vercel ships
   code but never schema, and a deploy whose migration was forgotten fails at
   the first authenticated page load, not at build time.
2. Create one Google Cloud project, enable Google Drive API, and create a Web
   application OAuth client. Request only
   `https://www.googleapis.com/auth/drive.file`; broader scopes are unsupported.
3. Register exactly `APP_ORIGIN/api/v1/drive/callback` as the authorized redirect
   URI. Set Google OAuth Production before final acceptance; Testing mode is not
   accepted as durable production evidence.
4. Generate `DRIVE_TOKEN_KEY_V1` locally from 32 random bytes:

   ```powershell
   node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url") + "\n")'
   ```

   Store only the output in Vercel Production. Never commit it or place it in a
   preview deployment.
5. Set the free-tier limits exactly: `NEON_STORAGE_LIMIT_BYTES=536870912`,
   `DRIVE_UPLOAD_MAX_BYTES=10737418240`, `FREE_TIER_SOFT_PERCENT=90`, and
   `QUOTA_STALE_AFTER_SECONDS=900`.
6. Deploy the approved control-plane branch to Vercel Production. Sign in,
   connect the intended Drive account, and confirm the `YTB-VPS` folder and all
   project folders remain private.

Preview deployments must not receive the Production Neon URL, Google OAuth
secret, Drive token key, or admin/session secrets. Video chunks go directly
from the browser to Google Drive; Vercel handles only bounded JSON metadata.

## Non-destructive rollback

Redeploy the previous known-good application commit. Leave the additive v2
tables unused and never drop them automatically. Rollback and Drive disconnect
must never delete Drive content. Any destructive cleanup requires a separate,
explicitly reviewed operation; it is not part of this runbook.

The public `ytb-vps` command remains legacy until the dedicated cutover commit.
Use only `ytb-vps-v2` for v2 development before cutover.
