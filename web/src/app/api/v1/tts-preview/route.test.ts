import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/domain/errors";

const { env, requireAdmin, requireMutationOrigin, synthesize } = vi.hoisted(() => ({
  env: {
    databaseUrl: "postgresql://example.invalid/app",
    sessionSecret: "s".repeat(64),
    appOrigin: "https://app.example",
  },
  requireAdmin: vi.fn().mockResolvedValue(undefined),
  requireMutationOrigin: vi.fn(),
  synthesize: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4])),
}));

vi.mock("@/lib/config/env", () => ({ parseServerEnv: () => env }));
vi.mock("@/lib/http/requests", async () => {
  const actual = await vi.importActual<typeof import("@/lib/http/requests")>("@/lib/http/requests");
  return { ...actual, requireAdmin, requireMutationOrigin };
});
vi.mock("@/lib/server/capcut-bv074-preview", () => ({ synthesizeCapCutBv074Preview: synthesize }));

import { POST } from "./route";

describe("POST /api/v1/tts-preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires admin before calling CapCut", async () => {
    requireAdmin.mockRejectedValueOnce(new AppError("AUTH_REQUIRED", 401));
    const response = await POST(new Request("https://app.example/api/v1/tts-preview", { method: "POST", body: JSON.stringify({ text: "xin chào", rate: 1 }) }) as never);
    expect(response.status).toBe(401);
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("returns CapCut BV074 audio without exposing device data", async () => {
    const response = await POST(new Request("https://app.example/api/v1/tts-preview", { method: "POST", body: JSON.stringify({ text: "xin chào", rate: 1 }) }) as never);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(synthesize).toHaveBeenCalledWith("xin chào", 1);
  });

  it("rejects client supplied voice and invalid text", async () => {
    const response = await POST(new Request("https://app.example/api/v1/tts-preview", { method: "POST", body: JSON.stringify({ text: "", rate: 1, voice: "vi-VN-HoaiMyNeural" }) }) as never);
    expect(response.status).toBe(400);
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("maps CapCut failures to one public error", async () => {
    synthesize.mockRejectedValueOnce(new Error("device_id secret"));
    const response = await POST(new Request("https://app.example/api/v1/tts-preview", { method: "POST", body: JSON.stringify({ text: "xin chào", rate: 1 }) }) as never);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "TTS_PREVIEW_UNAVAILABLE" });
  });
});
