import { describe, expect, it } from "vitest";
import { assessFreeTier } from "./free-tier";

describe("assessFreeTier", () => {
  it("allows mutations below all soft limits", () => {
    expect(
      assessFreeTier({
        neonBytes: 100,
        neonLimitBytes: 1_000,
        driveBytes: 200,
        driveLimitBytes: 2_000,
        stale: false,
      }),
    ).toEqual({ mode: "READ_WRITE", reasons: [] });
  });

  it("fails closed when quota evidence is stale", () => {
    expect(
      assessFreeTier({
        neonBytes: 100,
        neonLimitBytes: 1_000,
        driveBytes: 200,
        driveLimitBytes: 2_000,
        stale: true,
      }).mode,
    ).toBe("READ_ONLY");
  });

  it("fails closed at ninety percent of either storage limit", () => {
    expect(
      assessFreeTier({
        neonBytes: 900,
        neonLimitBytes: 1_000,
        driveBytes: 200,
        driveLimitBytes: 2_000,
        stale: false,
      }).mode,
    ).toBe("READ_ONLY");
  });

  it("reports Drive storage high at exactly ninety percent", () => {
    expect(
      assessFreeTier({
        neonBytes: 100,
        neonLimitBytes: 1_000,
        driveBytes: 1_800,
        driveLimitBytes: 2_000,
        stale: false,
      }),
    ).toEqual({ mode: "READ_ONLY", reasons: ["DRIVE_STORAGE_HIGH"] });
  });
});
