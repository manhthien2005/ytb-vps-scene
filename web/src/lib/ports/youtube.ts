export type YouTubeChannelProfile = Readonly<{
  channelId: string; title: string; avatarUrl: string | null;
  publishedAt: string; subscriberCount: number | null;
  viewCount: number; videoCount: number; uploadsPlaylistId: string;
}>;

export type YouTubeVideoSummary = Readonly<{
  videoId: string; title: string; thumbnailUrl: string | null; viewCount: number;
}>;

export interface YouTubeDataPort {
  inspectMyChannel(accessToken: string): Promise<YouTubeChannelProfile>;
  listTopVideos(accessToken: string, uploadsPlaylistId: string, limit: number): Promise<readonly YouTubeVideoSummary[]>;
}

export type YouTubeWatchTime = Readonly<{ estimatedMinutesWatched: number }>;

export interface YouTubeAnalyticsPort {
  totalWatchTime(accessToken: string, input: Readonly<{
    startDate: string; endDate: string;
  }>): Promise<YouTubeWatchTime>;
}
