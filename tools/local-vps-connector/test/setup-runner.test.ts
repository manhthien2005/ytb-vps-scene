import { describe, expect, it, vi } from "vitest";
import { runSetup, type SetupTransport } from "../src/setup-runner.js";

const ssh = { user: "root", host: "n1.ckey.vn", port: 1210 } as const;

function collect<T>(source: AsyncIterable<T>) {
  return (async () => { const values: T[] = []; for await (const value of source) values.push(value); return values; })();
}

describe("runSetup", () => {
  it("emits sanitized ordered stages and can be rerun", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: "root secret output", stderr: "", code: 0 });
    const transport: SetupTransport = { connect: vi.fn().mockResolvedValue({ exec, close: vi.fn() }) };
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
    const transport: SetupTransport = { connect: vi.fn().mockResolvedValue({ exec, close: vi.fn() }) };
    const events = await collect(runSetup({ ssh, password: "secret", bootstrapCommand: "curl -fsSL https://raw.githubusercontent.com/acme/repo/abc/ops/native-v2/bootstrap-worker.sh | sudo bash -s -- 'https://app.example' 'token' 'https://github.com/acme/repo.git' 'abc'", transport }));
    expect(events.at(-1)).toMatchObject({ stage: "FAILED", percent: 100 });
    expect(events.map((event) => event.stage)).not.toContain("READY");
  });
});
