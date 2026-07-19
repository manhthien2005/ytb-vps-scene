import { describe, expect, it } from "vitest";
import { DRIVE_CONNECTION_STATUSES, DRIVE_FILE_SCOPE } from "./drive";

describe("Drive domain constants", () => {
  it("exposes the exact connection lifecycle and least-privilege scope", () => {
    expect(DRIVE_CONNECTION_STATUSES).toEqual([
      "CONNECTED", "REAUTH_REQUIRED", "REVOKE_PENDING", "DISCONNECTED",
    ]);
    expect(DRIVE_FILE_SCOPE).toBe("https://www.googleapis.com/auth/drive.file");
  });
});
