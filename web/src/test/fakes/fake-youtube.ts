import { YOUTUBE_SCOPES } from "@/lib/domain/youtube";
import type { DriveOAuthPort } from "@/lib/ports/drive";
import type {
  YouTubeAnalyticsPort,
  YouTubeChannelProfile,
  YouTubeDataPort,
  YouTubeVideoSummary,
  YouTubeWatchTime,
} from "@/lib/ports/youtube";

/** Same wire shape as the Drive OAuth fake, but granting the YouTube scope pair. */
export class FakeYouTubeOAuth implements DriveOAuthPort {
  exchangeResult: Readonly<{ refreshToken: string; grantedScopes: readonly string[] }> = {
    refreshToken: "fake-youtube-refresh-token",
    grantedScopes: [...YOUTUBE_SCOPES],
  };
  accessToken = "fake-youtube-access-token";
  revokeResult: "REVOKED" | "RETRYABLE" = "REVOKED";
  exchangeError: unknown = null;
  refreshError: unknown = null;
  revokeError: unknown = null;
  readonly authorizationCalls: Array<Readonly<{ state: string; redirectUri: string }>> = [];
  readonly exchangeCalls: Array<Readonly<{ code: string; redirectUri: string; timeoutMs: number }>> = [];
  readonly refreshCalls: Array<Readonly<{ refreshToken: string; timeoutMs: number }>> = [];
  readonly revokeCalls: Array<Readonly<{ refreshToken: string; timeoutMs: number }>> = [];

  buildAuthorizationUrl(input: Readonly<{ state: string; redirectUri: string }>): string {
    this.authorizationCalls.push(structuredClone(input));
    const url = new URL("https://accounts.google.test/authorize");
    url.searchParams.set("state", input.state);
    url.searchParams.set("redirect_uri", input.redirectUri);
    return url.toString();
  }

  async exchangeCode(input: Readonly<{
    code: string;
    redirectUri: string;
    timeoutMs: number;
  }>): Promise<Readonly<{ refreshToken: string; grantedScopes: readonly string[] }>> {
    this.exchangeCalls.push(structuredClone(input));
    if (this.exchangeError !== null) throw this.exchangeError;
    return structuredClone(this.exchangeResult);
  }

  async refreshAccessToken(refreshToken: string, timeoutMs: number): Promise<string> {
    this.refreshCalls.push({ refreshToken, timeoutMs });
    if (this.refreshError !== null) throw this.refreshError;
    return this.accessToken;
  }

  async revokeRefreshToken(
    refreshToken: string,
    timeoutMs: number,
  ): Promise<"REVOKED" | "RETRYABLE"> {
    this.revokeCalls.push({ refreshToken, timeoutMs });
    if (this.revokeError !== null) throw this.revokeError;
    return this.revokeResult;
  }
}

export class FakeYouTubeData implements YouTubeDataPort {
  profile: YouTubeChannelProfile = {
    channelId: "UCabcdefghijklmnopqrstuv",
    title: "Kênh thử",
    avatarUrl: "https://yt3.example/avatar.jpg",
    publishedAt: "2024-01-02T03:04:05Z",
    subscriberCount: 123_000,
    viewCount: 1_234_567,
    videoCount: 210,
    uploadsPlaylistId: "UUabcdefghijklmnopqrstuv",
  };
  topVideos: readonly YouTubeVideoSummary[] = [];
  inspectError: unknown = null;
  topVideosError: unknown = null;
  readonly inspectCalls: string[] = [];
  readonly topVideosCalls: Array<Readonly<{
    accessToken: string;
    uploadsPlaylistId: string;
    limit: number;
  }>> = [];

  async inspectMyChannel(accessToken: string): Promise<YouTubeChannelProfile> {
    this.inspectCalls.push(accessToken);
    if (this.inspectError !== null) throw this.inspectError;
    return structuredClone(this.profile);
  }

  async listTopVideos(
    accessToken: string,
    uploadsPlaylistId: string,
    limit: number,
  ): Promise<readonly YouTubeVideoSummary[]> {
    this.topVideosCalls.push({ accessToken, uploadsPlaylistId, limit });
    if (this.topVideosError !== null) throw this.topVideosError;
    return structuredClone(this.topVideos);
  }
}

export class FakeYouTubeAnalytics implements YouTubeAnalyticsPort {
  watchTime: YouTubeWatchTime = { estimatedMinutesWatched: 0 };
  watchTimeError: unknown = null;
  readonly watchTimeCalls: Array<Readonly<{
    accessToken: string;
    startDate: string;
    endDate: string;
  }>> = [];

  async totalWatchTime(
    accessToken: string,
    input: Readonly<{ startDate: string; endDate: string }>,
  ): Promise<YouTubeWatchTime> {
    this.watchTimeCalls.push({ accessToken, ...input });
    if (this.watchTimeError !== null) throw this.watchTimeError;
    return structuredClone(this.watchTime);
  }
}
