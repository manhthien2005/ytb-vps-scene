import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /api/v1/health/free-tier", () => {
  it("fails closed without Drive and disables caching", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      service: "ytb-vps-control-plane",
      mode: "READ_ONLY",
      reasons: ["DRIVE_NOT_CONNECTED"],
    });
  });
});
