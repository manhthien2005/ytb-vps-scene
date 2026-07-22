import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAPCUT_BV074_RESOURCE_ID,
  CAPCUT_BV074_VOICE,
  createCapCutBv074Preview,
  createPinnedHttpsDownloader,
} from "./capcut-bv074-preview";

const device = JSON.stringify({ device_id: "device", iid: "install", tdid: "trace" });

afterEach(() => {
  delete process.env.CAPCUT_DEVICE_JSON_V1;
});

describe("CapCut BV074 preview adapter", () => {
  it("loads as a server module with the fixed legacy voice identity", () => {
    expect(CAPCUT_BV074_VOICE).toBe("BV074_streaming");
    expect(CAPCUT_BV074_RESOURCE_ID).toBe("7102355709945188865");
  });

  it("loads through the standalone TypeScript runner under React Server conditions", () => {
    const result = spawnSync(process.execPath, [
      "--conditions=react-server",
      "--import",
      "tsx",
      "--eval",
      "import('./src/lib/server/capcut-bv074-preview.ts').then((module) => process.stdout.write((module.default ?? module).CAPCUT_BV074_VOICE))",
    ], { cwd: process.cwd(), encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("BV074_streaming");
  });

  it("creates, polls, and downloads BV074 through a DNS-pinned boundary", async () => {
    process.env.CAPCUT_DEVICE_JSON_V1 = device;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ret: "0", data: { tasks: [{ id: "task", token: "token" }] } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ret: "0", data: { tasks: [{ status: "succeed", payload: JSON.stringify({ audio: "https://v16m-default.tiktokcdn.com/audio.mp3" }) }] } }), { status: 200 }));
    const lookupImpl = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const downloadAudioImpl = vi.fn().mockResolvedValue(new Uint8Array(256).fill(7));
    const synthesize = createCapCutBv074Preview({ fetchImpl, lookupImpl, downloadAudioImpl, sleep: vi.fn() });

    const audio = await synthesize("xin chào", 1);

    expect(audio).toEqual(new Uint8Array(256).fill(7));
    expect(String(fetchImpl.mock.calls[0]![1]!.body)).toContain("BV074_streaming");
    expect(String(fetchImpl.mock.calls[0]![1]!.body)).toContain("7102355709945188865");
    expect(downloadAudioImpl).toHaveBeenCalledWith(
      new URL("https://v16m-default.tiktokcdn.com/audio.mp3"),
      { address: "93.184.216.34", family: 4 },
      expect.objectContaining({ maxBytes: 50 * 1024 * 1024 }),
    );
  });

  it("rejects non-public DNS results before downloading audio", async () => {
    process.env.CAPCUT_DEVICE_JSON_V1 = device;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ret: "0", data: { tasks: [{ id: "task", token: "token" }] } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ret: "0", data: { tasks: [{ status: "succeed", payload: JSON.stringify({ audio: "https://v16m-default.tiktokcdn.com/audio.mp3" }) }] } }), { status: 200 }));
    const downloadAudioImpl = vi.fn();
    const synthesize = createCapCutBv074Preview({
      fetchImpl,
      lookupImpl: vi.fn().mockResolvedValue([{ address: "224.0.0.1", family: 4 }]),
      downloadAudioImpl,
      sleep: vi.fn(),
    });

    await expect(synthesize("xin chào", 1)).rejects.toThrow("CAPCUT_AUDIO_HOST_PRIVATE");
    expect(downloadAudioImpl).not.toHaveBeenCalled();
  });

  it("aborts CapCut API calls at the configured deadline", async () => {
    process.env.CAPCUT_DEVICE_JSON_V1 = device;
    const fetchImpl = vi.fn((_url: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const synthesize = createCapCutBv074Preview({
      fetchImpl: fetchImpl as typeof fetch,
      lookupImpl: vi.fn(),
      downloadAudioImpl: vi.fn(),
      sleep: vi.fn(),
      requestTimeoutMs: 5,
    });

    await expect(synthesize("xin chào", 1)).rejects.toThrow("CAPCUT_REQUEST_FAILED");
  });

  it("enforces a wall-clock audio deadline even while bytes keep arriving", async () => {
    const response = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string> };
    response.statusCode = 200;
    response.headers = {};
    const request = new EventEmitter() as EventEmitter & {
      destroy(error: Error): void;
      end(): void;
    };
    let interval: ReturnType<typeof setInterval> | undefined;
    request.destroy = (error) => {
      if (interval) clearInterval(interval);
      response.destroy();
      queueMicrotask(() => request.emit("error", error));
    };
    request.end = () => undefined;
    const requestImpl = vi.fn((_url, _options, callback) => {
      queueMicrotask(() => {
        callback(response);
        interval = setInterval(() => response.write(Buffer.from([1])), 1);
      });
      return request;
    });
    const download = createPinnedHttpsDownloader(requestImpl as never);

    await expect(download(
      new URL("https://v16m-default.tiktokcdn.com/audio.mp3"),
      { address: "93.184.216.34", family: 4 },
      { timeoutMs: 10, maxBytes: 1024 },
    )).rejects.toThrow("CAPCUT_AUDIO_TIMEOUT");
  });
});
