import { describe, expect, it, vi } from "vitest";
import { createYouTubeAnalyticsAdapter } from "./youtube-analytics";

function jsonResponse(body: unknown): Response {
  const text = JSON.stringify(body);
  return new Response(text, {
    status: 200,
    headers: { "content-type": "application/json", "content-length": String(text.length) },
  });
}

describe("youtube analytics adapter", () => {
  it("queries channel==MINE and reads the single metric cell", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({
      columnHeaders: [{ name: "estimatedMinutesWatched" }],
      rows: [[987654]],
    }));

    const result = await createYouTubeAnalyticsAdapter(fetcher).totalWatchTime("token", {
      startDate: "2024-01-02",
      endDate: "2026-07-27",
    });

    expect(result).toEqual({ estimatedMinutesWatched: 987654 });

    const requested = new URL(String(fetcher.mock.calls[0]![0]));
    expect(requested.searchParams.get("ids")).toBe("channel==MINE");
    expect(requested.searchParams.get("metrics")).toBe("estimatedMinutesWatched");
    expect(requested.searchParams.get("startDate")).toBe("2024-01-02");
    expect(requested.searchParams.get("endDate")).toBe("2026-07-27");
  });

  it("treats an empty row set as zero rather than an error", async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      columnHeaders: [{ name: "estimatedMinutesWatched" }],
      rows: [],
    }));

    const result = await createYouTubeAnalyticsAdapter(fetcher).totalWatchTime("token", {
      startDate: "2024-01-02",
      endDate: "2026-07-27",
    });
    expect(result).toEqual({ estimatedMinutesWatched: 0 });
  });

  it("rejects a malformed date", async () => {
    const fetcher = vi.fn();
    await expect(createYouTubeAnalyticsAdapter(fetcher).totalWatchTime("token", {
      startDate: "02-01-2024",
      endDate: "2026-07-27",
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
