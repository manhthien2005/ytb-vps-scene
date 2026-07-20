# Local VPS Connector

The connector is a small loopback-only helper. It receives the CKEY SSH command and password from the browser, performs the idempotent native worker setup over SSH, and exposes only sanitized progress events.

## Start

From the repository root:

```powershell
npm --prefix tools/local-vps-connector install
npm --prefix tools/local-vps-connector start
```

It listens on `127.0.0.1:55871`. The VPS password is held only in memory while setup runs; it is never sent to Vercel, persisted, or included in progress events.

The helper expects Ubuntu 22.04 x86_64 and installs the native worker stack without Docker. Stop it when no VPS setup is needed.
