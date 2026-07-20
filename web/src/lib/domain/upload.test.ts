import { describe, expect, it } from "vitest";
import { nextRetry, parseAcknowledgedRange, validateUploadIntent } from "./upload";

const TEN_GIB = 10 * 1024 ** 3;

describe("validateUploadIntent", () => {
  it.each([
    ["movie.mp4", "video/mp4"],
    ["movie.mov", "video/quicktime"],
    ["movie.mkv", "video/x-matroska"],
    ["movie.webm", "video/webm"],
  ] as const)("accepts %s", (fileName, mimeType) => {
    expect(validateUploadIntent({ fileName, mimeType, sizeBytes: 1, lastModified: 1 }, TEN_GIB))
      .toMatchObject({ normalizedExtension: fileName.split(".").pop() });
  });

  it("rejects a MIME/extension mismatch and exact oversize", () => {
    expect(() => validateUploadIntent(
      { fileName: "movie.mp4", mimeType: "video/webm", sizeBytes: TEN_GIB + 1, lastModified: 1 },
      TEN_GIB,
    )).toThrow("UPLOAD_TOO_LARGE");
  });

  it("trims the display name but rejects a mismatched extension", () => {
    expect(validateUploadIntent(
      { fileName: "  Movie.MP4  ", mimeType: "video/mp4", sizeBytes: 1, lastModified: 0 },
      TEN_GIB,
    )).toMatchObject({ fileName: "Movie.MP4", normalizedExtension: "mp4" });
    expect(() => validateUploadIntent(
      { fileName: "movie.mp4", mimeType: "video/webm", sizeBytes: 1, lastModified: 0 },
      TEN_GIB,
    )).toThrow("UPLOAD_TYPE_REJECTED");
  });

  it("normalizes and accepts a bounded Vietnamese display name", () => {
    const decomposed = "Phu\u0323 de\u0302̀ video.mp4";
    expect(validateUploadIntent(
      { fileName: decomposed, mimeType: "video/mp4", sizeBytes: 1, lastModified: 0 },
      TEN_GIB,
    )).toMatchObject({ fileName: decomposed.normalize("NFC"), normalizedExtension: "mp4" });
  });

  it.each([
    "../movie.mp4",
    "folder/movie.mp4",
    "folder\\movie.mp4",
    "movie\u0000.mp4",
    "movie\u202Emp4",
  ])("rejects unsafe display name %j", (fileName) => {
    expect(() => validateUploadIntent(
      { fileName, mimeType: "video/mp4", sizeBytes: 1, lastModified: 0 },
      TEN_GIB,
    )).toThrow("UPLOAD_TYPE_REJECTED");
  });

  it("requires safe positive sizes and a safe nonnegative last-modified value", () => {
    for (const input of [
      { fileName: "movie.mp4", mimeType: "video/mp4" as const, sizeBytes: 0, lastModified: 0 },
      { fileName: "movie.mp4", mimeType: "video/mp4" as const, sizeBytes: Number.MAX_SAFE_INTEGER + 1, lastModified: 0 },
      { fileName: "movie.mp4", mimeType: "video/mp4" as const, sizeBytes: 1, lastModified: -1 },
      { fileName: "movie.mp4", mimeType: "video/mp4" as const, sizeBytes: 1, lastModified: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(() => validateUploadIntent(input, TEN_GIB)).toThrow("INVALID_REQUEST");
    }
  });
});

describe("parseAcknowledgedRange", () => {
  it.each([
    [null, 0],
    ["bytes=0-42", 43],
    ["bytes=0-8388607", 8_388_608],
  ])("parses Drive Range %j", (range, expected) => {
    expect(parseAcknowledgedRange(range)).toBe(expected);
  });

  it.each(["bytes=0-01", "bytes=1-42", "bytes=0-42,43-84", "bytes=0-9007199254740991", ""])(
    "rejects malformed or unsafe range %j",
    (range) => expect(() => parseAcknowledgedRange(range)).toThrow("UPLOAD_REMOTE_MISMATCH"),
  );
});

describe("nextRetry", () => {
  it.each([
    [1, 0, { kind: "RETRY", delayMs: 1_000 }],
    [4, 0.996, { kind: "RETRY", delayMs: 8_249 }],
    [5, 0.5, { kind: "EXHAUSTED", delayMs: 0 }],
  ])("returns the bounded retry decision after failure %i", (failedAttempts, jitterUnit, expected) => {
    expect(nextRetry(failedAttempts, jitterUnit)).toEqual(expected);
  });

  it.each([
    [0, 0],
    [1.5, 0],
    [Number.MAX_SAFE_INTEGER + 1, 0],
    [1, -0.1],
    [1, 1],
    [1, Number.NaN],
  ])("rejects invalid retry inputs", (failedAttempts, jitterUnit) => {
    expect(() => nextRetry(failedAttempts, jitterUnit)).toThrow("INVALID_REQUEST");
  });
});
