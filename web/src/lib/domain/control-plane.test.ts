import { describe, expect, it } from "vitest";
import { assertJobTransition, isTerminalJobState } from "./control-plane";

describe("job transitions", () => {
  it.each([
    ["DRAFT", "READY"],
    ["READY", "QUEUED"],
    ["QUEUED", "CLAIMED"],
    ["OCR", "UPLOADING"],
    ["TRANSLATE", "REVIEW_READY"],
    ["REVIEW_READY", "PAUSED_REVIEW"],
    ["PAUSED_REVIEW", "TTS"],
    ["PAUSED_QUOTA", "TRANSLATE"],
    ["UPLOADING", "COMPLETED"],
    ["CANCEL_REQUESTED", "CANCELLED"],
  ] as const)("allows %s -> %s", (from, to) => {
    expect(() => assertJobTransition(from, to)).not.toThrow();
  });

  it("rejects skipping from queued directly to completed", () => {
    expect(() => assertJobTransition("QUEUED", "COMPLETED")).toThrow("Illegal job transition");
  });

  it.each([
    "CLAIMED", "DOWNLOADING", "OCR", "TRANSLATE", "REVIEW_READY",
    "PAUSED_REVIEW", "TTS", "RENDER", "UPLOADING",
  ] as const)("allows %s -> FAILED_FINAL for non-retryable data or configuration errors", (from) => {
    expect(() => assertJobTransition(from, "FAILED_FINAL")).not.toThrow();
  });

  it("allows retry exhaustion to become final", () => {
    expect(() => assertJobTransition("FAILED_RETRYABLE", "FAILED_FINAL")).not.toThrow();
  });

  it.each(["DRAFT", "READY", "QUEUED", "PAUSED_QUOTA", "COMPLETED"] as const)(
    "still rejects unrelated %s -> FAILED_FINAL transitions",
    (from) => expect(() => assertJobTransition(from, "FAILED_FINAL")).toThrow("Illegal job transition"),
  );

  it("treats completed, cancelled, failed-final and deleted as terminal", () => {
    expect(["COMPLETED", "CANCELLED", "FAILED_FINAL", "DELETED"].every(isTerminalJobState)).toBe(true);
  });
});
