import { describe, expect, it } from "vitest";
import { AppError, publicErrorBody, PUBLIC_CODES } from "./errors";

describe("public application errors", () => {
  it("defines one unique stable code for each public error", () => {
    expect(new Set(PUBLIC_CODES).size).toBe(PUBLIC_CODES.length);
  });

  it("exposes only the stable code through a route response mapper", () => {
    const error = new AppError("DRIVE_PROVIDER_REJECTED", 502);
    const routeBody = publicErrorBody(error);

    expect(JSON.stringify(routeBody)).toBe('{"code":"DRIVE_PROVIDER_REJECTED"}');
    expect(routeBody).not.toHaveProperty("message");
    expect(routeBody).not.toHaveProperty("stack");
    expect(routeBody).not.toHaveProperty("status");
  });
});
