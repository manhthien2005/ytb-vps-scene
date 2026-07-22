import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { runSetup, type SetupTransport } from "../src/setup-runner.js";

const ssh = { user: "root", host: "n1.ckey.vn", port: 1210 } as const;

function collect<T>(source: AsyncIterable<T>) {
  return (async () => { const values: T[] = []; for await (const value of source) values.push(value); return values; })();
}

describe("runSetup", () => {
  it("emits sanitized ordered stages and can be rerun", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "root secret output", stderr: "", code: 0 });
    const transport: SetupTransport = { connect: vi.fn().mockResolvedValue({ exec, upload: vi.fn(), close: vi.fn() }) };
    const input = { ssh, password: "M@nhthien2005", bootstrapCommand: "curl -fsSL https://raw.githubusercontent.com/acme/repo/abc/ops/native-v2/bootstrap-worker.sh | sudo bash -s -- 'https://app.example' 'token' 'https://github.com/acme/repo.git' 'abc'", transport };
    const first = await collect(runSetup(input));
    const second = await collect(runSetup(input));
    expect(first.map((event) => event.stage)).toEqual(["CONNECTING", "INSTALLING", "CONFIGURING", "VERIFYING", "READY"]);
    expect(second.at(-1)?.stage).toBe("READY");
    expect(JSON.stringify(first)).not.toContain("M@nhthien2005");
    expect(JSON.stringify(first)).not.toContain("secret output");
    expect(exec).toHaveBeenCalled();
  });

  it("stops at FAILED when a setup stage fails", async () => {
    const exec = vi.fn().mockResolvedValueOnce({ stdout: "", stderr: "package unavailable", code: 1 });
    const transport: SetupTransport = { connect: vi.fn().mockResolvedValue({ exec, upload: vi.fn(), close: vi.fn() }) };
    const events = await collect(runSetup({ ssh, password: "secret", bootstrapCommand: "curl -fsSL https://raw.githubusercontent.com/acme/repo/abc/ops/native-v2/bootstrap-worker.sh | sudo bash -s -- 'https://app.example' 'token' 'https://github.com/acme/repo.git' 'abc'", transport }));
    expect(events.at(-1)).toMatchObject({ stage: "FAILED", percent: 100 });
    expect(events.map((event) => event.stage)).not.toContain("READY");
  });

  it("uploads the CapCut pool outside shell commands and atomically replaces stale files", async () => {
    const root = mkdtempSync(join(tmpdir(), "capcut-devices-"));
    const first = join(root, "device-021.json");
    const second = join(root, "device-022.json");
    writeFileSync(first, '{"device_id":"secret-device-one","iid":"secret-install-one","tdid":"secret-trace-one"}');
    writeFileSync(second, '{"device_id":"secret-device-two","iid":"secret-install-two","tdid":"secret-trace-two"}');
    process.env.YTB_VPS_LOCAL_CAPCUT_DEVICES = root;
    try {
      const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 });
      const upload = vi.fn().mockResolvedValue(undefined);
      const transport: SetupTransport = { connect: vi.fn().mockResolvedValue({ exec, upload, close: vi.fn() }) };

      const events = await collect(runSetup({
        ssh,
        password: "secret",
        bootstrapCommand: "curl -fsSL https://raw.githubusercontent.com/acme/repo/abc/ops/native-v2/bootstrap-worker.sh | sudo bash -s -- 'https://app.example' 'token' 'https://github.com/acme/repo.git' 'abc'",
        transport,
      }));

      expect(events.at(-1)?.stage).toBe("READY");
      expect(upload).toHaveBeenNthCalledWith(1, first, "/var/lib/ytb-vps/secrets/capcut-devices.next/device-021.json");
      expect(upload).toHaveBeenNthCalledWith(2, second, "/var/lib/ytb-vps/secrets/capcut-devices.next/device-022.json");
      const commands = exec.mock.calls.map(([command]) => command).join("\n");
      expect(commands).toContain("mv /var/lib/ytb-vps/secrets/capcut-devices.next /var/lib/ytb-vps/secrets/capcut-devices");
      expect(commands).not.toContain("secret-device-one");
      expect(commands).not.toContain(Buffer.from("secret-device-one").toString("base64"));
    } finally {
      delete process.env.YTB_VPS_LOCAL_CAPCUT_DEVICES;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails setup when an explicitly configured CapCut pool is missing", async () => {
    process.env.YTB_VPS_LOCAL_CAPCUT_DEVICES = join(tmpdir(), "missing-capcut-pool-for-test");
    try {
      const exec = vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 });
      const transport: SetupTransport = { connect: vi.fn().mockResolvedValue({ exec, upload: vi.fn(), close: vi.fn() }) };
      const events = await collect(runSetup({
        ssh,
        password: "secret",
        bootstrapCommand: "curl -fsSL https://raw.githubusercontent.com/acme/repo/abc/ops/native-v2/bootstrap-worker.sh | sudo bash -s -- 'https://app.example' 'token' 'https://github.com/acme/repo.git' 'abc'",
        transport,
      }));
      expect(events.at(-1)?.stage).toBe("FAILED");
    } finally {
      delete process.env.YTB_VPS_LOCAL_CAPCUT_DEVICES;
    }
  });
});
