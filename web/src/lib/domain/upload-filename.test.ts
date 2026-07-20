import { describe, expect, it } from "vitest";
import { canonicalUploadFileName, isCanonicalUploadFileName } from "./upload-filename";

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
});
