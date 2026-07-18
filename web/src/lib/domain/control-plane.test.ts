import { describe, expect, it } from "vitest";
import { assertJobTransition, isTerminalJobState } from "./control-plane";

describe("job transitions", () => {
  it.each([
    ["DRAFT", "READY"],
    ["READY", "QUEUED"],
    ["QUEUED", "CLAIMED"],
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

  it("treats completed, cancelled, failed-final and deleted as terminal", () => {
    expect(["COMPLETED", "CANCELLED", "FAILED_FINAL", "DELETED"].every(isTerminalJobState)).toBe(true);
  });
});
