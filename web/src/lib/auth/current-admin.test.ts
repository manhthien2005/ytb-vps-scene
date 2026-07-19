import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueSession } from "./session";

const { cookies } = vi.hoisted(() => ({ cookies: vi.fn() }));
vi.mock("next/headers", () => ({ cookies }));

import { ADMIN_COOKIE, currentAdmin } from "./current-admin";

describe("currentAdmin", () => {
  const secret = "s".repeat(64);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function provideCookie(value?: string) {
    cookies.mockResolvedValue({
      get: (name: string) => (name === ADMIN_COOKIE && value ? { value } : undefined),
    });
  }

  it("accepts a valid unexpired session from the Next cookies adapter", async () => {
    provideCookie(issueSession(secret));
    await expect(currentAdmin(secret)).resolves.toBe(true);
  });

  it.each([undefined, "invalid.session"]) (
    "rejects a missing or invalid session token: %s",
    async (token) => {
      provideCookie(token);
      await expect(currentAdmin(secret)).resolves.toBe(false);
    },
  );
});
