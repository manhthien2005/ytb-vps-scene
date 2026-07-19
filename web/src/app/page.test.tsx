import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { currentAdmin, createRepository, listJobs } = vi.hoisted(() => ({
  currentAdmin: vi.fn(),
  createRepository: vi.fn(),
  listJobs: vi.fn(),
}));
vi.mock("@/lib/auth/current-admin", () => ({ currentAdmin }));
vi.mock("@/lib/repositories/neon-control-plane", () => ({
  createNeonControlPlaneRepository: createRepository,
}));

import HomePage from "./page";

describe("HomePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(process.env, {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://test:test@localhost/test",
      ADMIN_KEY_HASH: "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      SESSION_SECRET: "s".repeat(64),
      APP_ORIGIN: "http://localhost:3000",
      GOOGLE_OAUTH_CLIENT_ID: "example-client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "example-client-secret",
      DRIVE_TOKEN_KEY_V1: "A".repeat(43),
      NEON_STORAGE_LIMIT_BYTES: "536870912",
      DRIVE_UPLOAD_MAX_BYTES: "10737418240",
      FREE_TIER_SOFT_PERCENT: "90",
      QUOTA_STALE_AFTER_SECONDS: "900",
    });
    delete process.env.OPENAI_API_KEY;
    currentAdmin.mockResolvedValue(false);
    createRepository.mockReturnValue({ listJobs });
  });

  it("does not instantiate or call the repository before authentication", async () => {
    render(await HomePage());
    expect(screen.getByRole("button", { name: "Mở bảng điều khiển" })).toBeInTheDocument();
    expect(createRepository).not.toHaveBeenCalled();
    expect(listJobs).not.toHaveBeenCalled();
  });
});
