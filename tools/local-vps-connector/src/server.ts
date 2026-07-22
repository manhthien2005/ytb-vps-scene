import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { Client } from "ssh2";
import { parseSshCommand, type SshTarget } from "./ssh-command.js";
import { runSetup as defaultRunSetup, type SetupEvent, type SetupInput, type SetupSession, type SetupTransport } from "./setup-runner.js";

type RunSetup = (input: SetupInput) => AsyncIterable<SetupEvent>;
type Job = { events: SetupEvent[]; listeners: Set<ServerResponse>; done: boolean };
type ConnectorOptions = Readonly<{ transport?: SetupTransport; runSetup?: RunSetup; allowedOrigin?: string }>;

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } as const;
const noncePattern = /^[A-Za-z0-9_-]{16,128}$/;

function responseJson(response: ServerResponse, status: number, body: unknown, origin?: string) {
  response.writeHead(status, { ...JSON_HEADERS, ...(origin ? { "access-control-allow-origin": origin } : {}) });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) {
    body += chunk.toString();
    if (body.length > 65_536) throw new Error("request too large");
  }
  return JSON.parse(body);
}

function validBody(value: unknown): value is { sshCommand: string; password: string; originNonce: string; bootstrapCommand: string } {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.sshCommand === "string" && item.sshCommand.length <= 255
    && typeof item.password === "string" && item.password.length > 0 && item.password.length <= 512
    && typeof item.originNonce === "string" && noncePattern.test(item.originNonce)
    && typeof item.bootstrapCommand === "string" && item.bootstrapCommand.length <= 2_048;
}

function sse(response: ServerResponse, event: SetupEvent) {
  response.write(`event: progress\ndata: ${JSON.stringify(event)}\n\n`);
}

export function createSsh2Transport(): SetupTransport {
  return {
    connect(target: SshTarget, password: string): Promise<SetupSession> {
      return new Promise((resolve, reject) => {
        const client = new Client();
        let settled = false;
        client.once("ready", () => {
          settled = true;
          resolve({
            exec(command) {
              return new Promise((commandResolve, commandReject) => {
                client.exec(command, (error, stream) => {
                  if (error) { commandReject(error); return; }
                  let stdout = "";
                  let stderr = "";
                  stream.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
                  stream.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
                  stream.once("close", (code: number | null) => commandResolve({ stdout, stderr, code: code ?? 1 }));
                });
              });
            },
            upload(localPath, remotePath) {
              return new Promise((uploadResolve, uploadReject) => {
                client.sftp((error, sftp) => {
                  if (error) { uploadReject(error); return; }
                  sftp.fastPut(localPath, remotePath, { mode: 0o600 }, (uploadError) => {
                    sftp.end();
                    if (uploadError) uploadReject(uploadError); else uploadResolve();
                  });
                });
              });
            },
            close: () => client.end(),
          });
        });
        client.once("error", (error) => { if (!settled) reject(error); });
        client.connect({ host: target.host, port: target.port, username: target.user, password, readyTimeout: 15_000 });
      });
    },
  };
}

export function createConnectorServer(options: ConnectorOptions = {}) {
  const transport = options.transport ?? createSsh2Transport();
  const execute = options.runSetup ?? defaultRunSetup;
  const allowedOrigin = options.allowedOrigin ?? process.env.YTB_VPS_APP_ORIGIN ?? "https://ytb-vps-scene.vercel.app";
  const jobs = new Map<string, Job>();

  async function startJob(jobId: string, target: SshTarget, password: string, bootstrapCommand: string) {
    const job = jobs.get(jobId);
    if (!job) return;
    try {
      for await (const event of execute({ ssh: target, password, bootstrapCommand, transport })) {
        job.events.push(event);
        for (const listener of job.listeners) sse(listener, event);
        if (event.stage === "READY" || event.stage === "FAILED") {
          job.done = true;
          for (const listener of job.listeners) listener.end();
          job.listeners.clear();
        }
      }
    } catch {
      const event: SetupEvent = { stage: "FAILED", percent: 100, message: "Không hoàn tất được setup VPS." };
      job.events.push(event);
      job.done = true;
      for (const listener of job.listeners) { sse(listener, event); listener.end(); }
      job.listeners.clear();
    } finally {
      password = "";
    }
  }

  const server = createServer(async (request, response) => {
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
    if (origin && origin !== allowedOrigin) { responseJson(response, 403, { code: "ORIGIN_NOT_ALLOWED" }); return; }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": allowedOrigin,
        "access-control-allow-methods": "POST,GET,OPTIONS",
        "access-control-allow-headers": "content-type",
        // Chrome Private Network Access: an HTTPS page reaching loopback preflights with
        // Access-Control-Request-Private-Network and requires this opt-in to proceed.
        "access-control-allow-private-network": "true",
      });
      response.end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/setup") {
      try {
        const body = await readBody(request);
        if (!validBody(body)) { responseJson(response, 400, { code: "INVALID_REQUEST" }, allowedOrigin); return; }
        const target = parseSshCommand(body.sshCommand);
        const jobId = randomUUID();
        jobs.set(jobId, { events: [], listeners: new Set(), done: false });
        responseJson(response, 202, { jobId }, allowedOrigin);
        void startJob(jobId, target, body.password, body.bootstrapCommand);
      } catch { responseJson(response, 400, { code: "INVALID_REQUEST" }, allowedOrigin); }
      return;
    }
    const match = /^\/setup\/([^/]+)\/events$/.exec(url.pathname);
    if (request.method === "GET" && match) {
      const job = jobs.get(match[1]);
      if (!job) { responseJson(response, 404, { code: "NOT_FOUND" }, allowedOrigin); return; }
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": allowedOrigin });
      for (const event of job.events) sse(response, event);
      if (job.done) response.end(); else job.listeners.add(response);
      request.once("close", () => job.listeners.delete(response));
      return;
    }
    responseJson(response, 404, { code: "NOT_FOUND" }, allowedOrigin);
  });

  return {
    server,
    listen(port = Number(process.env.YTB_VPS_CONNECTOR_PORT ?? 55871)) {
      return new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
      });
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const connector = createConnectorServer();
  void connector.listen().then(() => console.log("Local VPS Connector listening on 127.0.0.1"));
}
