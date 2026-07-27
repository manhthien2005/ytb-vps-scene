import type { EncryptedCredential } from "@/lib/security/credential-cipher";

export type YouTubeChannelRecord = Readonly<{
  id: string;
  channelId: string;
  title: string;
  avatarUrl: string | null;
  publishedAt: string | null;
  status: "CONNECTED" | "REAUTH_REQUIRED" | "DISCONNECTED";
  envelope: EncryptedCredential | null;
  titlePrompt: string | null;
  descriptionPrompt: string | null;
  descriptionTemplate: string | null;
  defaultTags: readonly string[];
  thumbnailPromptTemplate: string | null;
}>;

export type YouTubeStatsRecord = Readonly<{
  subscriberCount: number | null;
  viewCount: number | null;
  videoCount: number | null;
  watchHours: number | null;
  topVideos: readonly Readonly<{
    videoId: string;
    title: string;
    thumbnailUrl: string | null;
    viewCount: number;
  }>[];
  observedAt: string;
}>;

export interface YouTubeControlPlaneRepository {
  listChannels(): Promise<readonly YouTubeChannelRecord[]>;
  getChannel(id: string): Promise<YouTubeChannelRecord | null>;
  getChannelByChannelId(channelId: string): Promise<YouTubeChannelRecord | null>;
  saveConnectedChannel(input: Readonly<{
    id: string;
    channelId: string;
    title: string;
    avatarUrl: string | null;
    publishedAt: string | null;
    envelope: EncryptedCredential;
  }>): Promise<void>;
  setChannelStatus(id: string, status: "REAUTH_REQUIRED" | "DISCONNECTED"): Promise<void>;
  savePrompts(id: string, input: Readonly<{
    titlePrompt: string | null;
    descriptionPrompt: string | null;
    descriptionTemplate: string | null;
    defaultTags: readonly string[];
    thumbnailPromptTemplate: string | null;
  }>): Promise<boolean>;
  saveStats(id: string, stats: YouTubeStatsRecord): Promise<void>;
  getStats(id: string): Promise<YouTubeStatsRecord | null>;
  recordAudit(input: Readonly<{
    eventType: string;
    targetId?: string;
    payload: Record<string, unknown>;
  }>): Promise<void>;
}
