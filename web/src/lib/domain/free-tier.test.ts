import { describe, expect, it } from "vitest";
import { assessFreeTier, assessProjectedUpload } from "./free-tier";

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

describe("assessProjectedUpload", () => {
  const NOW = "2026-07-19T00:00:00.000Z";

  it("fails projected Drive usage at exactly ninety percent", () => {
    expect(assessProjectedUpload({
      usedBytes: 800, limitBytes: 1_000, incomingBytes: 100,
      observedAt: NOW, now: NOW, staleAfterSeconds: 900, softPercent: 90,
    })).toEqual({ mode: "READ_ONLY", reasons: ["DRIVE_STORAGE_HIGH"] });
  });

  it("fails closed for stale or invalid quota evidence", () => {
    expect(assessProjectedUpload({
      usedBytes: 1, limitBytes: 1_000, incomingBytes: 1,
      observedAt: "2026-07-18T23:44:59.999Z", now: NOW, staleAfterSeconds: 900, softPercent: 90,
    })).toEqual({ mode: "READ_ONLY", reasons: ["DRIVE_QUOTA_STALE"] });
    expect(assessProjectedUpload({
      usedBytes: 1, limitBytes: 0, incomingBytes: 1,
      observedAt: NOW, now: NOW, staleAfterSeconds: 900, softPercent: 90,
    })).toEqual({ mode: "READ_ONLY", reasons: ["QUOTA_INVALID"] });
  });

  it("rejects an impossible date that Date.parse would normalize", () => {
    expect(assessProjectedUpload({
      usedBytes: 1, limitBytes: 1_000, incomingBytes: 1,
      observedAt: "2026-02-30T00:00:00.000Z", now: "2026-03-02T00:00:00.000Z",
      staleAfterSeconds: 900, softPercent: 90,
    })).toEqual({ mode: "READ_ONLY", reasons: ["DRIVE_QUOTA_STALE"] });
  });

  it("fails closed for future timestamp evidence", () => {
    expect(assessProjectedUpload({
      usedBytes: 1, limitBytes: 1_000, incomingBytes: 1,
      observedAt: "2026-07-19T00:00:00.001Z", now: NOW,
      staleAfterSeconds: 900, softPercent: 90,
    })).toEqual({ mode: "READ_ONLY", reasons: ["DRIVE_QUOTA_STALE"] });
  });

  it("fails closed for contradictory and unsafe quota evidence", () => {
    expect(assessProjectedUpload({
      usedBytes: 1_001, limitBytes: 1_000, incomingBytes: 0,
      observedAt: NOW, now: NOW, staleAfterSeconds: 900, softPercent: 90,
    })).toEqual({ mode: "READ_ONLY", reasons: ["QUOTA_INVALID"] });
    expect(assessProjectedUpload({
      usedBytes: Number.MAX_SAFE_INTEGER - 1, limitBytes: Number.MAX_SAFE_INTEGER,
      incomingBytes: 2, observedAt: NOW, now: NOW, staleAfterSeconds: 900, softPercent: 90,
    })).toEqual({ mode: "READ_ONLY", reasons: ["QUOTA_INVALID"] });
  });

  it("accepts exactly the configured freshness boundary", () => {
    expect(assessProjectedUpload({
      usedBytes: 1, limitBytes: 1_000, incomingBytes: 1,
      observedAt: "2026-07-18T23:45:00.000Z", now: NOW,
      staleAfterSeconds: 900, softPercent: 90,
    })).toEqual({ mode: "READ_WRITE", reasons: [] });
  });

  it("rejects current usage at the threshold even without an incoming upload", () => {
    expect(assessProjectedUpload({
      usedBytes: 900, limitBytes: 1_000, incomingBytes: 0,
      observedAt: NOW, now: NOW, staleAfterSeconds: 900, softPercent: 90,
    })).toEqual({ mode: "READ_ONLY", reasons: ["DRIVE_STORAGE_HIGH"] });
  });
});
