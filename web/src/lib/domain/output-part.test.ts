import { describe, expect, it } from "vitest";
import { outputPartFileName } from "./output-part";

describe("outputPartFileName", () => {
  it("formats stable lowercase part names", () => {
    expect(outputPartFileName(1, 4)).toBe("part-01-of-04.mp4");
    expect(outputPartFileName(12, 120)).toBe("part-012-of-120.mp4");
  });

  it.each([[0, 1], [2, 1], [1, 0], [1, 1000]])("rejects invalid part metadata", (part, total) => {
    expect(() => outputPartFileName(part, total)).toThrow();
  });
});
