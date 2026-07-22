import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { query, requireAdmin } = vi.hoisted(() => ({
  query: vi.fn(),
  requireAdmin: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db/client", () => ({ createSql: () => ({ query }) }));
vi.mock("@/lib/config/env", () => ({
  parseServerEnv: () => ({
    databaseUrl: "postgresql://test:test@localhost/test",
    sessionSecret: "s".repeat(64),
    appOrigin: "http://localhost:3000",
  }),
}));
vi.mock("@/lib/http/requests", async () => {
  const actual = await vi.importActual<typeof import("@/lib/http/requests")>("@/lib/http/requests");
  return { ...actual, requireAdmin };
});

import { GET } from "./route";

const PROJECT_ID = "10000000-0000-4000-8000-000000000001";
const rectangle = { x: 0.1, y: 0.2, width: 0.3, height: 0.15 };

describe("GET /api/v1/projects/[id]/scene-settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(process.env, {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://test:test@localhost/test",
      SESSION_SECRET: "s".repeat(64),
      APP_ORIGIN: "http://localhost:3000",
    });
  });

  it("returns persisted Edge-era rows normalized to the fixed BV074 voice", async () => {
    query.mockResolvedValue({ rows: [{ settings: {
      sourceSubtitle: rectangle,
      logo: rectangle,
      voice: "vi-VN-HoaiMyNeural",
      rate: 1,
    } }] });

    const response = await GET(
      new NextRequest(`http://localhost:3000/api/v1/projects/${PROJECT_ID}/scene-settings`),
      { params: Promise.resolve({ id: PROJECT_ID }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ settings: { voice: "BV074_streaming" } });
  });
});
