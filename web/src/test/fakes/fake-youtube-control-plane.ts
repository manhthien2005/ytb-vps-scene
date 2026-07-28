import type { EncryptedCredential } from "@/lib/security/credential-cipher";
import type {
  YouTubeChannelRecord,
  YouTubeControlPlaneRepository,
  YouTubeStatsRecord,
} from "@/lib/repositories/youtube-control-plane";

type AuditEntry = Readonly<{
  eventType: string;
  targetId?: string;
  payload: Record<string, unknown>;
}>;

/**
 * In-memory stand-in for the Neon YouTube repository.
 *
 * It reproduces the one behaviour of the real implementation that callers can be
 * wrong about: `saveConnectedChannel` keys its upsert on `channel_id`, so a row
 * that already exists keeps its original `id` and the caller's `id` is discarded.
 * The returned id is therefore the authoritative one.
 */
export class FakeYouTubeControlPlaneRepository implements YouTubeControlPlaneRepository {
  readonly auditEvents: AuditEntry[] = [];
  readonly savedChannels: Array<Readonly<{
    id: string;
    channelId: string;
    title: string;
    avatarUrl: string | null;
    publishedAt: string | null;
    envelope: EncryptedCredential;
  }>> = [];
  readonly statusCalls: Array<Readonly<{ id: string; status: string }>> = [];
  /** Simulates the race the returned upsert id exists for: a row is stored, but the
   * caller's lookup does not see it (a concurrent connect committed in between). */
  hideLookups = false;

  private readonly channels = new Map<string, YouTubeChannelRecord>();
  private readonly stats = new Map<string, YouTubeStatsRecord>();

  seed(channel: YouTubeChannelRecord): void {
    this.channels.set(channel.id, channel);
  }

  async listChannels(): Promise<readonly YouTubeChannelRecord[]> {
    return [...this.channels.values()];
  }

  async getChannel(id: string): Promise<YouTubeChannelRecord | null> {
    return this.channels.get(id) ?? null;
  }

  async getChannelByChannelId(channelId: string): Promise<YouTubeChannelRecord | null> {
    if (this.hideLookups) return null;
    for (const channel of this.channels.values()) {
      if (channel.channelId === channelId) return channel;
    }
    return null;
  }

  async saveConnectedChannel(input: Readonly<{
    id: string;
    channelId: string;
    title: string;
    avatarUrl: string | null;
    publishedAt: string | null;
    envelope: EncryptedCredential;
  }>): Promise<string> {
    this.savedChannels.push(structuredClone(input));
    let existing: YouTubeChannelRecord | null = null;
    for (const channel of this.channels.values()) {
      if (channel.channelId === input.channelId) existing = channel;
    }
    const id = existing?.id ?? input.id;
    this.channels.set(id, {
      id,
      channelId: input.channelId,
      title: input.title,
      avatarUrl: input.avatarUrl,
      publishedAt: input.publishedAt,
      status: "CONNECTED",
      envelope: input.envelope,
      titlePrompt: existing?.titlePrompt ?? null,
      descriptionPrompt: existing?.descriptionPrompt ?? null,
      descriptionTemplate: existing?.descriptionTemplate ?? null,
      defaultTags: existing?.defaultTags ?? [],
      thumbnailPromptTemplate: existing?.thumbnailPromptTemplate ?? null,
    });
    return id;
  }

  async setChannelStatus(
    id: string,
    status: "REAUTH_REQUIRED" | "DISCONNECTED",
  ): Promise<void> {
    this.statusCalls.push({ id, status });
    const channel = this.channels.get(id);
    if (!channel) throw new Error("Channel unavailable");
    this.channels.set(id, { ...channel, status, envelope: null });
  }

  async savePrompts(id: string, input: Readonly<{
    titlePrompt: string | null;
    descriptionPrompt: string | null;
    descriptionTemplate: string | null;
    defaultTags: readonly string[];
    thumbnailPromptTemplate: string | null;
  }>): Promise<boolean> {
    const channel = this.channels.get(id);
    if (!channel) return false;
    this.channels.set(id, { ...channel, ...input });
    return true;
  }

  async saveStats(id: string, stats: YouTubeStatsRecord): Promise<void> {
    if (!this.channels.has(id)) throw new Error("Channel unavailable");
    this.stats.set(id, structuredClone(stats));
  }

  async getStats(id: string): Promise<YouTubeStatsRecord | null> {
    const stats = this.stats.get(id);
    return stats === undefined ? null : structuredClone(stats);
  }

  async recordAudit(input: Readonly<{
    eventType: string;
    targetId?: string;
    payload: Record<string, unknown>;
  }>): Promise<void> {
    this.auditEvents.push(structuredClone(input));
  }
}
