import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  YOUTUBE_DESCRIPTION_MAX_CHARS,
  YOUTUBE_TAGS_MAX_TOTAL_CHARS,
} from "@/lib/domain/youtube";

const { currentAdmin, savePrompts } = vi.hoisted(() => ({
  currentAdmin: vi.fn(),
  savePrompts: vi.fn(),
}));
vi.mock("@/lib/auth/current-admin", () => ({ currentAdmin }));
vi.mock("@/lib/repositories/neon-youtube-control-plane", () => ({
  createNeonYouTubeControlPlaneRepository: () => ({ savePrompts }),
}));

import { PUT } from "./route";

const CHANNEL_UID = "30000000-0000-4000-8000-000000000001";

function setEnv() {
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://test:test@localhost/test",
    ADMIN_KEY_HASH: "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    SESSION_SECRET: "s".repeat(64),
    APP_ORIGIN: "http://localhost:3000",
    GOOGLE_OAUTH_CLIENT_ID: "example-client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "example-client-secret",
    DRIVE_TOKEN_KEY_V1: "A".repeat(43),
    NEON_STORAGE_LIMIT_BYTES: "536870912",
    DRIVE_UPLOAD_MAX_BYTES: "10737418240",
    FREE_TIER_SOFT_PERCENT: "90",
    QUOTA_STALE_AFTER_SECONDS: "900",
  });
  delete process.env.OPENAI_API_KEY;
}

function prompts(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    titlePrompt: "Viết tiêu đề",
    descriptionPrompt: "Viết mô tả",
    descriptionTemplate: "Khuôn mô tả",
    defaultTags: ["một", "hai"],
    thumbnailPromptTemplate: "Khuôn thumbnail",
    ...overrides,
  });
}

function request(body: string, origin = "http://localhost:3000") {
  return new NextRequest(
    `http://localhost:3000/api/v1/youtube/channels/${CHANNEL_UID}/prompts`,
    { method: "PUT", headers: { origin, "content-type": "application/json" }, body },
  );
}

function context(id = CHANNEL_UID) {
  return { params: Promise.resolve({ id }) };
}

describe("PUT /api/v1/youtube/channels/[id]/prompts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv();
    currentAdmin.mockResolvedValue(true);
    savePrompts.mockResolvedValue(true);
  });

  it("authenticates before Origin, the id, or the body", async () => {
    currentAdmin.mockResolvedValue(false);
    const response = await PUT(request("not-json", "https://attacker.test"), context("nope"));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ code: "AUTH_REQUIRED" });
    expect(savePrompts).not.toHaveBeenCalled();
  });

  it("requires the exact Origin before writing", async () => {
    const response = await PUT(request(prompts(), "https://attacker.test"), context());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ code: "ORIGIN_REJECTED" });
    expect(savePrompts).not.toHaveBeenCalled();
  });

  it("saves every prompt field and reports success", async () => {
    const response = await PUT(request(prompts()), context());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ saved: true });
    expect(savePrompts).toHaveBeenCalledWith(CHANNEL_UID, {
      titlePrompt: "Viết tiêu đề",
      descriptionPrompt: "Viết mô tả",
      descriptionTemplate: "Khuôn mô tả",
      defaultTags: ["một", "hai"],
      thumbnailPromptTemplate: "Khuôn thumbnail",
    });
  });

  it("accepts an explicit null for every optional prompt", async () => {
    const response = await PUT(request(prompts({
      titlePrompt: null,
      descriptionPrompt: null,
      descriptionTemplate: null,
      defaultTags: [],
      thumbnailPromptTemplate: null,
    })), context());

    expect(response.status).toBe(200);
    expect(savePrompts).toHaveBeenCalledWith(CHANNEL_UID, {
      titlePrompt: null,
      descriptionPrompt: null,
      descriptionTemplate: null,
      defaultTags: [],
      thumbnailPromptTemplate: null,
    });
  });

  it("rejects a description template past the YouTube limit", async () => {
    const response = await PUT(request(prompts({
      descriptionTemplate: "x".repeat(YOUTUBE_DESCRIPTION_MAX_CHARS + 1),
    })), context());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "INVALID_REQUEST" });
    expect(savePrompts).not.toHaveBeenCalled();
  });

  it("accepts a description template exactly at the limit", async () => {
    const response = await PUT(request(prompts({
      descriptionTemplate: "x".repeat(YOUTUBE_DESCRIPTION_MAX_CHARS),
    })), context());

    expect(response.status).toBe(200);
    expect(savePrompts).toHaveBeenCalledOnce();
  });

  // Neither the per-tag cap nor the database expresses the total budget: these 10
  // tags are each well under 100 characters and still exceed 500 in aggregate.
  it("rejects tags that individually pass but exceed the total character budget", async () => {
    const response = await PUT(request(prompts({
      defaultTags: Array.from({ length: 10 }, () => "t".repeat(60)),
    })), context());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "INVALID_REQUEST" });
    expect(savePrompts).not.toHaveBeenCalled();
  });

  it("accepts tags totalling exactly the budget", async () => {
    const response = await PUT(request(prompts({
      defaultTags: Array.from({ length: 10 }, () => "t".repeat(YOUTUBE_TAGS_MAX_TOTAL_CHARS / 10)),
    })), context());

    expect(response.status).toBe(200);
    expect(savePrompts).toHaveBeenCalledOnce();
  });

  it.each([
    ["an unknown field", prompts({ extra: true })],
    ["an empty tag", prompts({ defaultTags: [""] })],
    ["more than fifty tags", prompts({ defaultTags: Array.from({ length: 51 }, () => "t") })],
    ["a single oversized tag", prompts({ defaultTags: ["t".repeat(101)] })],
    ["a non-string tag", prompts({ defaultTags: [5] })],
    ["a missing field", JSON.stringify({ titlePrompt: null })],
    ["malformed JSON", "{"],
  ])("rejects %s", async (_label, body) => {
    const response = await PUT(request(body), context());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "INVALID_REQUEST" });
    expect(savePrompts).not.toHaveBeenCalled();
  });

  it("rejects a body past the byte cap", async () => {
    const response = await PUT(request(prompts({
      titlePrompt: "x".repeat(40_000),
    })), context());

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ code: "REQUEST_TOO_LARGE" });
    expect(savePrompts).not.toHaveBeenCalled();
  });

  it("rejects a non-UUID channel id before reading the body", async () => {
    const response = await PUT(request(prompts()), context("not-a-uuid"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "INVALID_REQUEST" });
    expect(savePrompts).not.toHaveBeenCalled();
  });

  it("returns 404 when no row matched the id", async () => {
    savePrompts.mockResolvedValue(false);
    const response = await PUT(request(prompts()), context());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ code: "YOUTUBE_CHANNEL_NOT_FOUND" });
  });

  it("hides an unexpected failure behind INTERNAL_ERROR", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    savePrompts.mockRejectedValue(new Error("postgres://user:secret@host/db"));

    const response = await PUT(request(prompts()), context());
    expect(response.status).toBe(500);
    const body = JSON.stringify(await response.json());
    expect(body).toBe('{"code":"INTERNAL_ERROR"}');
    expect(body).not.toContain("secret");
    consoleError.mockRestore();
  });
});
