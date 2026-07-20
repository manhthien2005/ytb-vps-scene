import { describe, expect, it, vi } from "vitest";
import { createConnectorServer } from "../src/server.js";
import type { SetupEvent, SetupTransport } from "../src/setup-runner.js";

const events: SetupEvent[] = [
  { stage: "CONNECTING", percent: 10, message: "Đang kết nối VPS…" },
  { stage: "READY", percent: 100, message: "VPS đã sẵn sàng để render." },
];

describe("local connector server", () => {
  it("binds to loopback and never returns the password in progress events", async () => {
    const transport: SetupTransport = { connect: vi.fn() };
    const runSetup = async function* (): AsyncIterable<SetupEvent> { yield* events; };
    const connector = createConnectorServer({ transport, runSetup, allowedOrigin: "https://ytb-vps-scene.vercel.app" });
    await connector.listen(0);
    const address = connector.server.address();
    expect(address && typeof address === "object" ? address.address : "").toBe("127.0.0.1");
    const response = await fetch(`http://127.0.0.1:${address && typeof address === "object" ? address.port : 0}/setup`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://ytb-vps-scene.vercel.app" },
      body: JSON.stringify({ sshCommand: "ssh root@n1.ckey.vn -p 1210", password: "M@nhthien2005", originNonce: "nonce-1234567890123456", bootstrapCommand: "curl -fsSL https://raw.githubusercontent.com/acme/repo/abc/ops/native-v2/bootstrap-worker.sh | sudo bash -s -- 'https://app.example' 'token' 'https://github.com/acme/repo.git' 'abc'" }),
    });
    expect(response.status).toBe(202);
    const job = await response.json() as { jobId: string };
    const stream = await fetch(`http://127.0.0.1:${address && typeof address === "object" ? address.port : 0}/setup/${job.jobId}/events`);
    const body = await stream.text();
    expect(body).toContain("READY");
    expect(body).not.toContain("M@nhthien2005");
    await connector.close();
  });
});
