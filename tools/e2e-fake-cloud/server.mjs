// Local end-to-end rig: one process that stands in for the two managed services
// the control plane talks to, so the real Next.js app, the real browser uploader
// and the real Python worker can be exercised without touching Neon or Google.
//
//   POST /sql                     Neon serverless HTTP protocol, backed by PGlite
//   /oauth2/...                   Google OAuth token + revoke endpoints
//   /googleapis/...               Drive v3 metadata, media download, resumable upload
//   /__control/...                test-only inspection and fault injection
//
// Nothing here is imported by production code. The Next.js process reaches it
// through preload.cjs; the VPS worker reaches it through nginx + /etc/hosts.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { PGlite } = await import(
  pathToFileURL(join(import.meta.dirname, "../../web/node_modules/@electric-sql/pglite/dist/index.js")).href
);

const PORT = Number(process.env.FAKE_CLOUD_PORT ?? 4680);
const STATE_DIR = process.env.FAKE_CLOUD_STATE ?? join(tmpdir(), "ytb-vps-e2e-cloud");
const SCHEMA_PATH = join(import.meta.dirname, "../../web/src/lib/db/schema.sql");
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const ACCESS_TOKEN = "fake-access-token-e2e";
const REFRESH_TOKEN = "fake-refresh-token-e2e";
const AUTHORIZATION_CODE = "fake-authorization-code-e2e";
const DRIVE_LIMIT_BYTES = 16 * 1024 * 1024 * 1024;
// Identity parsers make PGlite emit the raw Postgres text encoding, which is what
// the Neon HTTP protocol carries and what the driver's own parsers expect.
const RAW_TEXT_PARSERS = Object.fromEntries(
  Array.from({ length: 5_000 }, (_, index) => [index, (value) => value]),
);

const blobDir = join(STATE_DIR, "blobs");
await mkdir(blobDir, { recursive: true });

const db = new PGlite(join(STATE_DIR, "pgdata"));
await db.exec(await readFile(SCHEMA_PATH, "utf8"));

/** @type {Map<string, any>} */
const files = new Map();
/** @type {Map<string, any>} */
const uploads = new Map();
/** @type {Array<{match: string, status: number, times: number, body?: string, headers?: Record<string,string>}>} */
let faults = [];
const log = [];
let sequence = 0;

function nextId(prefix) {
  sequence += 1;
  return `${prefix}-${String(sequence).padStart(6, "0")}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function record(entry) {
  log.push({ at: nowIso(), ...entry });
  if (log.length > 5_000) log.splice(0, 2_500);
}

function send(response, status, body, headers = {}) {
  const payload = body === undefined || body === null
    ? Buffer.alloc(0)
    : Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=UTF-8",
    "content-length": String(payload.byteLength),
    ...headers,
  });
  response.end(payload);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- fields filter

// Drive only returns the fields the caller asked for; the adapter rejects any
// unexpected key, so the rig has to honour the same contract.
function parseFieldSelector(text) {
  const selector = new Map();
  let index = 0;
  const readName = () => {
    let name = "";
    while (index < text.length && /[A-Za-z0-9_]/.test(text[index])) name += text[index++];
    return name;
  };
  const readGroup = (target) => {
    while (index < text.length) {
      while (index < text.length && (text[index] === "," || text[index] === " ")) index += 1;
      if (index >= text.length || text[index] === ")") break;
      const name = readName();
      if (!name) {
        index += 1;
        continue;
      }
      if (text[index] === "(") {
        index += 1;
        const nested = new Map();
        readGroup(nested);
        if (text[index] === ")") index += 1;
        target.set(name, nested);
      } else {
        target.set(name, null);
      }
    }
  };
  readGroup(selector);
  return selector;
}

function applySelector(value, selector) {
  if (!selector || selector.size === 0) return value;
  const result = {};
  for (const [key, nested] of selector) {
    if (!(key in value) || value[key] === undefined) continue;
    result[key] = nested === null ? value[key] : applySelector(value[key], nested);
  }
  return result;
}

// ---------------------------------------------------------------- drive model

function driveView(file) {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    ...(file.mimeType === FOLDER_MIME ? {} : { size: String(file.size ?? 0) }),
    parents: [file.parent],
    trashed: file.trashed,
    appProperties: file.appProperties,
    createdTime: file.createdTime,
    modifiedTime: file.modifiedTime,
    ...(file.mimeType === FOLDER_MIME ? {} : {
      videoMediaMetadata: {
        width: file.width ?? undefined,
        height: file.height ?? undefined,
        durationMillis: file.durationMillis === undefined ? undefined : String(file.durationMillis),
      },
      sha256Checksum: file.sha256 ?? undefined,
      md5Checksum: file.md5 ?? undefined,
    }),
    webViewLink: `https://drive.google.com/file/d/${file.id}/view`,
    webContentLink: `https://drive.usercontent.google.com/download?id=${file.id}`,
  };
}

function unescapeQueryValue(value) {
  return value.replaceAll("\\'", "'").replaceAll("\\\\", "\\");
}

function matchesQuery(file, query) {
  if (query.includes("trashed = false") && file.trashed) return false;
  const parent = /'((?:[^'\\]|\\.)*)' in parents/.exec(query);
  if (parent && file.parent !== unescapeQueryValue(parent[1])) return false;
  const properties = [...query.matchAll(/appProperties has \{ key='((?:[^'\\]|\\.)*)' and value='((?:[^'\\]|\\.)*)' \}/g)];
  for (const [, key, value] of properties) {
    if (file.appProperties[unescapeQueryValue(key)] !== unescapeQueryValue(value)) return false;
  }
  return true;
}

function totalUsedBytes() {
  let total = 0;
  for (const file of files.values()) if (!file.trashed) total += file.size ?? 0;
  return total;
}

// ---------------------------------------------------------------- neon /sql

function neonError(error) {
  return {
    message: String(error?.message ?? error),
    code: error?.code,
    severity: "ERROR",
  };
}

const BYTEA_TEXT = /^\\x(?:[0-9a-fA-F]{2})*$/;

function toBytea(value) {
  const hex = value.slice(2);
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function runSql(statement) {
  const parameters = statement.params ?? [];
  let result;
  try {
    result = await db.query(statement.query, parameters, {
      rowMode: "array",
      parsers: RAW_TEXT_PARSERS,
    });
  } catch (error) {
    // The Neon HTTP protocol carries bytea parameters in Postgres hex-text form,
    // which PGlite's client-side serializer refuses - it wants a Uint8Array. Only
    // retry when that is exactly what happened.
    const convertible = parameters.some((value) => typeof value === "string" && BYTEA_TEXT.test(value));
    if (!String(error?.message ?? "").includes("Invalid input for bytea type") || !convertible) throw error;
    result = await db.query(
      statement.query,
      parameters.map((value) => (typeof value === "string" && BYTEA_TEXT.test(value) ? toBytea(value) : value)),
      { rowMode: "array", parsers: RAW_TEXT_PARSERS },
    );
  }
  return {
    command: "SELECT",
    fields: result.fields.map((field) => ({
      name: field.name,
      dataTypeID: field.dataTypeID,
      tableID: 0,
      columnID: 0,
      dataTypeSize: -1,
      dataTypeModifier: -1,
      format: "text",
    })),
    rows: result.rows,
    rowCount: result.rows.length,
    rowAsArray: true,
  };
}

async function handleSql(request, response) {
  const body = JSON.parse((await readBody(request)).toString("utf8"));
  try {
    if (Array.isArray(body.queries)) {
      const results = [];
      // Neon runs a batch inside one transaction; PGlite is single-connection so a
      // sequential run inside an explicit transaction is equivalent here.
      await db.exec("begin");
      try {
        for (const statement of body.queries) results.push(await runSql(statement));
        await db.exec("commit");
      } catch (error) {
        await db.exec("rollback");
        throw error;
      }
      send(response, 200, { results });
      return;
    }
    send(response, 200, await runSql(body));
  } catch (error) {
    record({ kind: "sql-error", query: body.query, message: String(error?.message ?? error) });
    send(response, 400, neonError(error));
  }
}

// ---------------------------------------------------------------- oauth

async function handleOAuth(url, request, response) {
  const form = new URLSearchParams((await readBody(request)).toString("utf8"));
  if (url.pathname === "/oauth2/token") {
    const grant = form.get("grant_type");
    if (grant === "authorization_code") {
      if (form.get("code") !== AUTHORIZATION_CODE) {
        send(response, 400, { error: "invalid_grant" });
        return;
      }
      send(response, 200, {
        access_token: ACCESS_TOKEN,
        expires_in: 3_600,
        refresh_token: REFRESH_TOKEN,
        scope: DRIVE_SCOPE,
        token_type: "Bearer",
      });
      return;
    }
    if (grant === "refresh_token") {
      if (form.get("refresh_token") !== REFRESH_TOKEN) {
        send(response, 400, { error: "invalid_grant" });
        return;
      }
      // A refresh response must not carry refresh_token: the adapter rejects it.
      send(response, 200, {
        access_token: ACCESS_TOKEN,
        expires_in: 3_600,
        scope: DRIVE_SCOPE,
        token_type: "Bearer",
      });
      return;
    }
    send(response, 400, { error: "unsupported_grant_type" });
    return;
  }
  if (url.pathname === "/oauth2/revoke") {
    send(response, 200, {});
    return;
  }
  send(response, 404, { error: "not_found" });
}

// ---------------------------------------------------------------- drive v3

function requireBearer(request, response) {
  const header = request.headers.authorization ?? "";
  if (header !== `Bearer ${ACCESS_TOKEN}`) {
    send(response, 401, { error: { code: 401, message: "Invalid Credentials" } });
    return false;
  }
  return true;
}

async function handleDrive(url, request, response) {
  const path = url.pathname.replace(/^\/googleapis/, "");
  const selector = parseFieldSelector(url.searchParams.get("fields") ?? "");

  if (path === "/drive/v3/about") {
    if (!requireBearer(request, response)) return;
    const value = {
      storageQuota: { limit: String(DRIVE_LIMIT_BYTES), usage: String(totalUsedBytes()) },
      user: { permissionId: "fake-permission-id-e2e", emailAddress: "e2e-tester@example.test" },
    };
    send(response, 200, applySelector(value, selector));
    return;
  }

  if (path === "/drive/v3/files" && request.method === "GET") {
    if (!requireBearer(request, response)) return;
    const query = url.searchParams.get("q") ?? "";
    const matched = [...files.values()]
      .filter((file) => matchesQuery(file, query))
      .sort((left, right) => (left.id < right.id ? -1 : 1));
    const fileSelector = selector.get("files") ?? null;
    send(response, 200, { files: matched.map((file) => applySelector(driveView(file), fileSelector)) });
    return;
  }

  if (path === "/drive/v3/files" && request.method === "POST") {
    if (!requireBearer(request, response)) return;
    const body = JSON.parse((await readBody(request)).toString("utf8"));
    const file = {
      id: nextId(body.mimeType === FOLDER_MIME ? "fkdir" : "fkfile"),
      name: body.name,
      mimeType: body.mimeType,
      parent: body.parents?.[0] ?? "root",
      trashed: false,
      appProperties: body.appProperties ?? {},
      size: body.mimeType === FOLDER_MIME ? undefined : 0,
      createdTime: nowIso(),
      modifiedTime: nowIso(),
    };
    files.set(file.id, file);
    record({ kind: "drive-create", id: file.id, name: file.name, mimeType: file.mimeType });
    send(response, 200, applySelector(driveView(file), selector));
    return;
  }

  const fileMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
  if (fileMatch) {
    if (!requireBearer(request, response)) return;
    const file = files.get(decodeURIComponent(fileMatch[1]));
    if (!file) {
      send(response, 404, { error: { code: 404, message: "File not found" } });
      return;
    }
    if (request.method === "DELETE") {
      files.delete(file.id);
      await rm(join(blobDir, file.id), { force: true });
      record({ kind: "drive-delete", id: file.id });
      send(response, 204, null);
      return;
    }
    if (request.method === "GET" && url.searchParams.get("alt") === "media") {
      const blobPath = join(blobDir, file.id);
      try {
        const info = await stat(blobPath);
        response.writeHead(200, {
          "content-type": file.mimeType,
          "content-length": String(info.size),
        });
        createReadStream(blobPath).pipe(response);
      } catch {
        send(response, 404, { error: { code: 404, message: "Content not found" } });
      }
      return;
    }
    send(response, 200, applySelector(driveView(file), selector));
    return;
  }

  const uploadInit = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(path);
  if (uploadInit && request.method === "PATCH") {
    if (!requireBearer(request, response)) return;
    const fileId = decodeURIComponent(uploadInit[1]);
    const file = files.get(fileId);
    if (!file) {
      send(response, 404, { error: { code: 404, message: "File not found" } });
      return;
    }
    const declared = Number(request.headers["x-upload-content-length"] ?? "0");
    const uploadId = nextId("up").replaceAll("-", "");
    uploads.set(uploadId, { fileId, total: declared, offset: 0, path: join(blobDir, `${uploadId}.part`) });
    await writeFile(join(blobDir, `${uploadId}.part`), Buffer.alloc(0));
    record({ kind: "upload-session", uploadId, fileId, total: declared });
    send(response, 200, {}, {
      location: `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=resumable&upload_id=${uploadId}`,
    });
    return;
  }

  if (uploadInit && request.method === "PUT") {
    const uploadId = url.searchParams.get("upload_id");
    const session = uploadId === null ? undefined : uploads.get(uploadId);
    if (!session) {
      send(response, 404, { error: { code: 404, message: "Upload session not found" } });
      return;
    }
    const contentRange = String(request.headers["content-range"] ?? "");
    const query = /^(?:bytes\s+)?\*\/(\d+)$/.exec(contentRange);
    if (query) {
      // Status query: report what has been committed so far.
      await readBody(request);
      if (session.offset >= session.total) {
        send(response, 200, applySelector(driveView(files.get(session.fileId)), parseFieldSelector("")));
        return;
      }
      send(response, 308, null, session.offset === 0 ? {} : { range: `bytes=0-${session.offset - 1}` });
      return;
    }
    const ranged = /^bytes\s+(\d+)-(\d+)\/(\d+)$/.exec(contentRange);
    const payload = await readBody(request);
    let start = 0;
    let total = session.total;
    if (ranged) {
      start = Number(ranged[1]);
      total = Number(ranged[3]);
    } else if (contentRange === "") {
      // Single-request upload (the Python worker uses this shape).
      start = 0;
      total = payload.byteLength;
    } else {
      send(response, 400, { error: { code: 400, message: "Invalid Content-Range" } });
      return;
    }
    if (start !== session.offset) {
      send(response, 308, null, session.offset === 0 ? {} : { range: `bytes=0-${session.offset - 1}` });
      return;
    }
    const existing = await readFile(session.path);
    await writeFile(session.path, Buffer.concat([existing, payload]));
    session.offset = start + payload.byteLength;
    session.total = total;
    if (session.offset < session.total) {
      send(response, 308, null, { range: `bytes=0-${session.offset - 1}` });
      return;
    }
    const content = await readFile(session.path);
    const file = files.get(session.fileId);
    file.size = content.byteLength;
    file.sha256 = createHash("sha256").update(content).digest("hex");
    file.md5 = createHash("md5").update(content).digest("hex");
    file.modifiedTime = nowIso();
    await writeFile(join(blobDir, file.id), content);
    await rm(session.path, { force: true });
    uploads.delete(uploadId);
    record({ kind: "upload-complete", fileId: file.id, size: file.size, sha256: file.sha256 });
    send(response, 200, driveView(file));
    return;
  }

  send(response, 404, { error: { code: 404, message: "Not found" } });
}

// ---------------------------------------------------------------- control

async function handleControl(url, request, response) {
  if (url.pathname === "/__control/health") {
    send(response, 200, { ok: true, files: files.size, uploads: uploads.size });
    return;
  }
  if (url.pathname === "/__control/files") {
    send(response, 200, {
      files: [...files.values()].map((file) => ({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        parent: file.parent,
        size: file.size,
        sha256: file.sha256,
        appProperties: file.appProperties,
      })),
    });
    return;
  }
  if (url.pathname === "/__control/log") {
    send(response, 200, { log: log.slice(-200) });
    return;
  }
  if (url.pathname === "/__control/sql" && request.method === "POST") {
    const body = JSON.parse((await readBody(request)).toString("utf8"));
    try {
      const result = await db.query(body.query, body.params ?? []);
      send(response, 200, { rows: result.rows, fields: result.fields.map((f) => f.name) }, {});
    } catch (error) {
      send(response, 400, { message: String(error?.message ?? error) });
    }
    return;
  }
  if (url.pathname === "/__control/fault" && request.method === "POST") {
    const body = JSON.parse((await readBody(request)).toString("utf8"));
    faults = Array.isArray(body.faults) ? body.faults : [];
    send(response, 200, { faults });
    return;
  }
  send(response, 404, { error: "not_found" });
}

function takeFault(url) {
  const index = faults.findIndex((fault) => url.pathname.includes(fault.match) && fault.times > 0);
  if (index === -1) return null;
  const fault = faults[index];
  fault.times -= 1;
  return fault;
}

const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const started = Date.now();
  response.on("finish", () => {
    if (!url.pathname.startsWith("/__control")) {
      record({
        kind: "request",
        method: request.method,
        path: url.pathname,
        status: response.statusCode,
        ms: Date.now() - started,
      });
    }
  });
  (async () => {
    try {
      if (url.pathname.startsWith("/__control")) return await handleControl(url, request, response);
      const fault = takeFault(url);
      if (fault) {
        await readBody(request);
        record({ kind: "fault", path: url.pathname, status: fault.status });
        return send(response, fault.status, fault.body ?? { error: "injected" }, fault.headers ?? {});
      }
      if (url.pathname === "/sql") return await handleSql(request, response);
      if (url.pathname.startsWith("/oauth2/")) return await handleOAuth(url, request, response);
      if (url.pathname.startsWith("/googleapis/")) return await handleDrive(url, request, response);
      // The VPS reaches this process through nginx, which forwards the original
      // Google paths unprefixed.
      if (url.pathname.startsWith("/drive/") || url.pathname.startsWith("/upload/")) {
        return await handleDrive(new URL(`/googleapis${url.pathname}${url.search}`, "http://127.0.0.1"), request, response);
      }
      send(response, 404, { error: "not_found", path: url.pathname });
    } catch (error) {
      record({ kind: "server-error", path: url.pathname, message: String(error?.stack ?? error) });
      if (!response.headersSent) send(response, 500, { error: "internal", message: String(error?.message ?? error) });
    }
  })();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`fake-cloud listening on http://127.0.0.1:${PORT} (state ${STATE_DIR})`);
});
