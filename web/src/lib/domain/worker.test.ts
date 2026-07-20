import { describe, expect, it } from "vitest";
import { parseWorkerCapabilities, parseWorkerDoctorReport } from "./worker";

const capabilities = {
  protocolVersion: 1,
  pipelineBridgeVersion: "cp3-control-only",
  os: "ubuntu-22.04",
  arch: "x86_64",
  gpuName: "NVIDIA GeForce RTX 3060",
  vramMiB: 12_288,
  cudaVersion: "12.4",
  nvenc: true,
};

describe("worker domain", () => {
  it("accepts the exact native RTX worker capability contract", () => {
    expect(parseWorkerCapabilities(capabilities)).toEqual(capabilities);
  });

  it.each([
    [{ ...capabilities, protocolVersion: 2 }],
    [{ ...capabilities, gpuName: "" }],
    [{ ...capabilities, vramMiB: 0 }],
    [{ ...capabilities, extra: "not-allowed" }],
  ])("rejects malformed worker capability evidence", (value) => {
    expect(() => parseWorkerCapabilities(value)).toThrow();
  });

  it("accepts a bounded canonical doctor report", () => {
    const report = {
      status: "PASS",
      reasonCodes: ["CUDA_AVAILABLE", "NVENC_AVAILABLE"],
      observedAt: "2026-07-20T08:30:00.000Z",
    };
    expect(parseWorkerDoctorReport(report)).toEqual(report);
  });

  it.each([
    [{ status: "UNKNOWN", reasonCodes: [], observedAt: "2026-07-20T08:30:00.000Z" }],
    [{ status: "FAIL", reasonCodes: ["lowercase"], observedAt: "2026-07-20T08:30:00.000Z" }],
    [{ status: "FAIL", reasonCodes: [], observedAt: "not-a-date" }],
    [{ status: "PASS", reasonCodes: [], observedAt: "2026-07-20T08:30:00.000Z", secret: "x" }],
  ])("rejects malformed doctor evidence", (value) => {
    expect(() => parseWorkerDoctorReport(value)).toThrow();
  });
});
