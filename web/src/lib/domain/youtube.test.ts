import { describe, expect, it } from "vitest";
import {
  isChannelId,
  sameScopeSet,
  YOUTUBE_SCOPES,
  YOUTUBE_TAGS_MAX_TOTAL_CHARS,
  YOUTUBE_TITLE_MAX_CHARS,
} from "./youtube";

describe("youtube domain", () => {
  it("pins the two read-only scopes", () => {
    expect(YOUTUBE_SCOPES).toEqual([
      "https://www.googleapis.com/auth/youtube.readonly",
      "https://www.googleapis.com/auth/yt-analytics.readonly",
    ]);
  });

  it("pins YouTube field limits", () => {
    expect(YOUTUBE_TITLE_MAX_CHARS).toBe(100);
    expect(YOUTUBE_TAGS_MAX_TOTAL_CHARS).toBe(500);
  });

  it("accepts canonical channel ids and rejects everything else", () => {
    expect(isChannelId("UCabcdefghijklmnopqrstuv")).toBe(true);
    expect(isChannelId("UCabc")).toBe(false);
    expect(isChannelId("XCabcdefghijklmnopqrstuv")).toBe(false);
    expect(isChannelId(42)).toBe(false);
  });

  it("compares scope sets ignoring order and rejecting extras", () => {
    expect(sameScopeSet(["b", "a"], ["a", "b"])).toBe(true);
    expect(sameScopeSet(["a"], ["a", "b"])).toBe(false);
    expect(sameScopeSet(["a", "b", "c"], ["a", "b"])).toBe(false);
    expect(sameScopeSet(["a", "a"], ["a", "b"])).toBe(false);
  });
});
