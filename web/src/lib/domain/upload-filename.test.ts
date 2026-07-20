import { describe, expect, it } from "vitest";
import {
  canonicalUploadFileName,
  isCanonicalUploadFileName,
  videoTitleFromFileName,
} from "./upload-filename";

describe("upload filename boundary", () => {
  it("canonicalizes bounded Unicode display metadata", () => {
    const decomposed = "  Phu\u0323 de\u0302̀ video.mp4  ";
    expect(canonicalUploadFileName(decomposed)).toBe(decomposed.trim().normalize("NFC"));
    expect(isCanonicalUploadFileName("Phụ đề tiếng Việt.mp4")).toBe(true);
  });

  it.each(["../movie.mp4", "folder/movie.mp4", "folder\\movie.mp4", "movie\u0000.mp4", "movie\u202Emp4"])(
    "rejects unsafe metadata %j",
    (value) => expect(canonicalUploadFileName(value)).toBeNull(),
  );

  it("keeps Vietnamese text and removes only the final video extension", () => {
    expect(videoTitleFromFileName("Phim thử nghiệm.part1.mp4"))
      .toBe("Phim thử nghiệm.part1");
  });

  it("rejects unsupported names and bounds the internal project name", () => {
    expect(videoTitleFromFileName("notes.txt")).toBeNull();
    expect(videoTitleFromFileName(`${"a".repeat(200)}.mp4`)).toHaveLength(160);
  });
});
