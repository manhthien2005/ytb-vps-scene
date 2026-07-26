import { describe, expect, it, vi } from "vitest";
import { createYouTubeDataAdapter } from "./youtube-data";

function jsonResponse(body: unknown): Response {
  const text = JSON.stringify(body);
  return new Response(text, {
    status: 200,
    headers: { "content-type": "application/json", "content-length": String(text.length) },
  });
}

describe("youtube data adapter", () => {
  it("maps a channel response and always sends a fields mask", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({
      items: [{
        id: "UCabcdefghijklmnopqrstuv",
        snippet: {
          title: "Kênh phim",
          publishedAt: "2024-01-02T03:04:05Z",
          thumbnails: { medium: { url: "https://yt3.example/avatar.jpg" } },
        },
        statistics: {
          viewCount: "1234567",
          subscriberCount: "123000",
          hiddenSubscriberCount: false,
          videoCount: "210",
        },
        contentDetails: { relatedPlaylists: { uploads: "UUabcdefghijklmnopqrstuv" } },
      }],
    }));

    const profile = await createYouTubeDataAdapter(fetcher).inspectMyChannel("token");

    expect(profile).toEqual({
      channelId: "UCabcdefghijklmnopqrstuv",
      title: "Kênh phim",
      avatarUrl: "https://yt3.example/avatar.jpg",
      publishedAt: "2024-01-02T03:04:05Z",
      subscriberCount: 123000,
      viewCount: 1234567,
      videoCount: 210,
      uploadsPlaylistId: "UUabcdefghijklmnopqrstuv",
    });

    const requested = new URL(String(fetcher.mock.calls[0]![0]));
    expect(requested.searchParams.get("mine")).toBe("true");
    expect(requested.searchParams.get("fields")).toBeTruthy();
  });

  it("reports a hidden subscriber count as null", async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      items: [{
        id: "UCabcdefghijklmnopqrstuv",
        snippet: { title: "K", publishedAt: "2024-01-02T03:04:05Z", thumbnails: {} },
        statistics: { viewCount: "1", hiddenSubscriberCount: true, videoCount: "1" },
        contentDetails: { relatedPlaylists: { uploads: "UUabcdefghijklmnopqrstuv" } },
      }],
    }));

    const profile = await createYouTubeDataAdapter(fetcher).inspectMyChannel("token");
    expect(profile.subscriberCount).toBeNull();
    expect(profile.avatarUrl).toBeNull();
  });

  it("rejects an empty channel list", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ items: [] }));
    await expect(createYouTubeDataAdapter(fetcher).inspectMyChannel("token"))
      .rejects.toMatchObject({ code: "YOUTUBE_CHANNEL_NOT_FOUND" });
  });

  it("returns the highest-view videos first and stops at the limit", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        items: [{ contentDetails: { videoId: "v1" } }, { contentDetails: { videoId: "v2" } }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        items: [
          { id: "v1", snippet: { title: "Thấp", thumbnails: { medium: { url: "https://t/1.jpg" } } }, statistics: { viewCount: "10" } },
          { id: "v2", snippet: { title: "Cao", thumbnails: { medium: { url: "https://t/2.jpg" } } }, statistics: { viewCount: "900" } },
        ],
      }));

    const videos = await createYouTubeDataAdapter(fetcher)
      .listTopVideos("token", "UUabcdefghijklmnopqrstuv", 1);

    expect(videos).toEqual([
      { videoId: "v2", title: "Cao", thumbnailUrl: "https://t/2.jpg", viewCount: 900 },
    ]);
  });
});
