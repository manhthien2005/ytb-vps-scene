import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({
  createSql: () => ({ query }),
}));

import { createNeonControlPlaneRepository } from "./neon-control-plane";

describe("NeonControlPlaneRepository", () => {
  beforeEach(() => query.mockReset());

  it.each(["WRONG", 42, null])("rejects an invalid database job state: %j", async (state) => {
    query.mockResolvedValue({
      rows: [{
        id: "job-1",
        project_name: "Demo",
        state,
        progress_percent: 5,
        updated_at: "2026-07-19T00:00:00Z",
      }],
    });
    const repo = createNeonControlPlaneRepository("postgresql://example.invalid/control-plane");

    await expect(repo.listJobs()).rejects.toThrow("Invalid job state returned by database");
  });
});
