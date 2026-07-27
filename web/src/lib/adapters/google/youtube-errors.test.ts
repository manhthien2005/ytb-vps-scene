import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/domain/errors";
import { objectRecord, providerRejected, remapProviderError } from "./youtube-errors";

describe("youtube provider errors", () => {
  it("maps every DRIVE code googleJson can raise onto a YOUTUBE code", () => {
    const cases = [
      ["DRIVE_RATE_LIMITED", "YOUTUBE_RATE_LIMITED", 429],
      ["DRIVE_REAUTH_REQUIRED", "YOUTUBE_REAUTH_REQUIRED", 401],
      ["DRIVE_TEMPORARILY_UNAVAILABLE", "YOUTUBE_PROVIDER_REJECTED", 502],
      ["DRIVE_PROVIDER_REJECTED", "YOUTUBE_PROVIDER_REJECTED", 502],
    ] as const;

    for (const [input, expectedCode, expectedStatus] of cases) {
      try {
        remapProviderError(new AppError(input, 500));
        throw new Error(`remapProviderError did not throw for ${input}`);
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe(expectedCode);
        expect((error as AppError).status).toBe(expectedStatus);
      }
    }
  });

  it("never lets a DRIVE-prefixed code escape", () => {
    const driveCodes = [
      "DRIVE_RATE_LIMITED",
      "DRIVE_REAUTH_REQUIRED",
      "DRIVE_TEMPORARILY_UNAVAILABLE",
      "DRIVE_PROVIDER_REJECTED",
    ] as const;

    for (const code of driveCodes) {
      try {
        remapProviderError(new AppError(code, 500));
        throw new Error(`remapProviderError did not throw for ${code}`);
      } catch (error) {
        expect((error as AppError).code.startsWith("DRIVE_")).toBe(false);
      }
    }
  });

  it("rethrows an unrelated AppError unchanged", () => {
    const original = new AppError("INVALID_REQUEST", 400);
    expect(() => remapProviderError(original)).toThrow(original);
  });

  it("rethrows a non-AppError unchanged", () => {
    const original = new TypeError("network exploded");
    expect(() => remapProviderError(original)).toThrow(original);
  });

  it("builds a 502 provider-rejected error", () => {
    const error = providerRejected();
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("YOUTUBE_PROVIDER_REJECTED");
    expect(error.status).toBe(502);
  });

  it("recognises only plain objects as records", () => {
    expect(objectRecord({ a: 1 })).toEqual({ a: 1 });
    expect(objectRecord([])).toBeNull();
    expect(objectRecord(null)).toBeNull();
    expect(objectRecord("x")).toBeNull();
    expect(objectRecord(42)).toBeNull();
    expect(objectRecord(undefined)).toBeNull();
  });
});
