import "server-only";

import type { EncryptedCredential } from "@/lib/security/credential-cipher";
import { createSql } from "@/lib/db/client";
import {
  bytes,
  boundedText,
  canonicalBase64url,
  fail,
  isOneOf,
  isoDate,
  nullableBoundedText,
  safeInteger,
} from "./row-parsing";
import type {
  YouTubeChannelRecord,
  YouTubeControlPlaneRepository,
  YouTubeStatsRecord,
} from "./youtube-control-plane";

const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CHANNEL_STATUSES = ["CONNECTED", "REAUTH_REQUIRED", "DISCONNECTED"] as const;

export type YouTubeControlPlaneSqlClient = Readonly<{
  query: (
    text: string,
    parameters?: unknown[],
  ) => Promise<Readonly<{ rows: Record<string, unknown>[] }>>;
}>;

function parseDefaultTags(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string")) {
    fail("channel default tags");
  }
  return value as readonly string[];
}

function parseTopVideos(value: unknown): YouTubeStatsRecord["topVideos"] {
  if (!Array.isArray(value)) fail("stats top videos");
  return value.map((entry) => {
    if (
      typeof entry !== "object" || entry === null ||
      typeof (entry as Record<string, unknown>).videoId !== "string" ||
      typeof (entry as Record<string, unknown>).title !== "string" ||
      !((entry as Record<string, unknown>).thumbnailUrl === null || typeof (entry as Record<string, unknown>).thumbnailUrl === "string") ||
      typeof (entry as Record<string, unknown>).viewCount !== "number"
    ) fail("stats top video");
    const record = entry as { videoId: string; title: string; thumbnailUrl: string | null; viewCount: number };
    return {
      videoId: record.videoId,
      title: record.title,
      thumbnailUrl: record.thumbnailUrl,
      viewCount: record.viewCount,
    };
  });
}

function parseChannel(row: Record<string, unknown>): YouTubeChannelRecord {
  const id = boundedText(row.id, 36, 36);
  const channelId = boundedText(row.channel_id, 24, 24);
  const title = boundedText(row.title, 1, 160, true);
  const avatarUrl = nullableBoundedText(row.avatar_url, 1, 1024);
  const publishedAt = row.published_at === null ? null : isoDate(row.published_at);
  const titlePrompt = nullableBoundedText(row.title_prompt, 0, 4000);
  const descriptionPrompt = nullableBoundedText(row.description_prompt, 0, 4000);
  const descriptionTemplate = nullableBoundedText(row.description_template, 0, 5000);
  const thumbnailPromptTemplate = nullableBoundedText(row.thumbnail_prompt_template, 0, 4000);
  const defaultTags = parseDefaultTags(row.default_tags);
  if (
    !id || !UUID_PATTERN.test(id) || !channelId || !CHANNEL_ID_PATTERN.test(channelId) || !title ||
    !isOneOf(row.status, CHANNEL_STATUSES) || avatarUrl === undefined ||
    (row.published_at !== null && publishedAt === null) ||
    titlePrompt === undefined || descriptionPrompt === undefined ||
    descriptionTemplate === undefined || thumbnailPromptTemplate === undefined
  ) fail("channel");

  if (row.status === "REAUTH_REQUIRED" || row.status === "DISCONNECTED") {
    if (
      row.ciphertext !== null || row.nonce !== null || row.auth_tag !== null ||
      row.key_version !== null || row.scope !== null
    ) fail("channel");
    return {
      id,
      channelId,
      title,
      avatarUrl,
      publishedAt,
      status: row.status,
      envelope: null,
      titlePrompt,
      descriptionPrompt,
      descriptionTemplate,
      defaultTags,
      thumbnailPromptTemplate,
    };
  }

  const ciphertext = bytes(row.ciphertext);
  const nonce = bytes(row.nonce, 12);
  const authTag = bytes(row.auth_tag, 16);
  if (
    !ciphertext || ciphertext.length > 4096 || !nonce || !authTag || row.key_version !== 1 ||
    typeof row.scope !== "string" || row.scope.length === 0
  ) fail("channel");
  return {
    id,
    channelId,
    title,
    avatarUrl,
    publishedAt,
    status: row.status,
    envelope: {
      ciphertext: ciphertext.toString("base64url"),
      nonce: nonce.toString("base64url"),
      authTag: authTag.toString("base64url"),
      keyVersion: 1,
      scope: row.scope,
    },
    titlePrompt,
    descriptionPrompt,
    descriptionTemplate,
    defaultTags,
    thumbnailPromptTemplate,
  };
}

function parseStats(row: Record<string, unknown>): YouTubeStatsRecord {
  const subscriberCount = row.subscriber_count === null ? null : safeInteger(row.subscriber_count);
  const viewCount = row.view_count === null ? null : safeInteger(row.view_count);
  const videoCount = row.video_count === null ? null : safeInteger(row.video_count);
  const watchHours = row.watch_hours === null ? null : safeInteger(row.watch_hours);
  const observedAt = isoDate(row.observed_at);
  if (
    (row.subscriber_count !== null && subscriberCount === null) ||
    (row.view_count !== null && viewCount === null) ||
    (row.video_count !== null && videoCount === null) ||
    (row.watch_hours !== null && watchHours === null) ||
    !observedAt
  ) fail("stats");
  return {
    subscriberCount,
    viewCount,
    videoCount,
    watchHours,
    topVideos: parseTopVideos(row.top_videos),
    observedAt,
  };
}

function channelColumns(): string {
  return `id,channel_id,title,avatar_url,published_at,status,ciphertext,nonce,auth_tag,key_version,scope,
    title_prompt,description_prompt,description_template,default_tags,thumbnail_prompt_template`;
}

export function createYouTubeControlPlaneRepository(
  sql: YouTubeControlPlaneSqlClient,
): YouTubeControlPlaneRepository {
  return {
    async listChannels() {
      const result = await sql.query(
        `select ${channelColumns()} from youtube_channels order by created_at,id`,
      );
      return result.rows.map(parseChannel);
    },

    async getChannel(id) {
      const result = await sql.query(
        `select ${channelColumns()} from youtube_channels where id=$1`,
        [id],
      );
      return result.rows.length === 0 ? null : parseChannel(result.rows[0]!);
    },

    async getChannelByChannelId(channelId) {
      const result = await sql.query(
        `select ${channelColumns()} from youtube_channels where channel_id=$1`,
        [channelId],
      );
      return result.rows.length === 0 ? null : parseChannel(result.rows[0]!);
    },

    async saveConnectedChannel(input) {
      const ciphertext = canonicalBase64url(input.envelope.ciphertext, undefined, true);
      const nonce = canonicalBase64url(input.envelope.nonce, 12);
      const authTag = canonicalBase64url(input.envelope.authTag, 16);
      const avatarUrl = input.avatarUrl === null
        ? null
        : boundedText(input.avatarUrl, 1, 1024) && input.avatarUrl.startsWith("https://")
          ? input.avatarUrl
          : null;
      const publishedAt = input.publishedAt === null ? null : isoDate(input.publishedAt);
      if (
        !ciphertext || ciphertext.length > 4096 || !nonce || !authTag ||
        input.envelope.keyVersion !== 1 || typeof input.envelope.scope !== "string" ||
        input.envelope.scope.length === 0 ||
        !UUID_PATTERN.test(input.id) || !CHANNEL_ID_PATTERN.test(input.channelId) ||
        !boundedText(input.title, 1, 160, true) ||
        (input.avatarUrl !== null && avatarUrl === null) ||
        (input.publishedAt !== null && publishedAt === null)
      ) throw new Error("Invalid encrypted credential");
      const result = await sql.query(
        `insert into youtube_channels(
           id,channel_id,title,avatar_url,published_at,status,ciphertext,nonce,auth_tag,key_version,scope
         ) values ($1,$2,$3,$4,$5,'CONNECTED',$6,$7,$8,$9,$10)
         on conflict(channel_id) do update set
           title=excluded.title,avatar_url=excluded.avatar_url,published_at=excluded.published_at,
           status='CONNECTED',ciphertext=excluded.ciphertext,nonce=excluded.nonce,
           auth_tag=excluded.auth_tag,key_version=excluded.key_version,scope=excluded.scope,
           updated_at=now()
         returning id`,
        [
          input.id, input.channelId, input.title, avatarUrl, publishedAt,
          ciphertext, nonce, authTag, input.envelope.keyVersion, input.envelope.scope,
        ],
      );
      const wonId = result.rows[0]?.id;
      if (typeof wonId !== "string" || !UUID_PATTERN.test(wonId)) fail("saved channel id");
      return wonId;
    },

    async setChannelStatus(id, status) {
      const result = await sql.query(
        `update youtube_channels set
           status=$2,ciphertext=null,nonce=null,auth_tag=null,key_version=null,scope=null,updated_at=now()
         where id=$1
         returning id`,
        [id, status],
      );
      if (result.rows.length === 0) throw new Error("Channel unavailable");
    },

    async savePrompts(id, input) {
      const result = await sql.query(
        `update youtube_channels set
           title_prompt=$2,description_prompt=$3,description_template=$4,
           default_tags=$5::jsonb,thumbnail_prompt_template=$6,updated_at=now()
         where id=$1
         returning id`,
        [
          id, input.titlePrompt, input.descriptionPrompt, input.descriptionTemplate,
          JSON.stringify(input.defaultTags), input.thumbnailPromptTemplate,
        ],
      );
      return result.rows.length === 1;
    },

    async saveStats(id, stats) {
      const subscriberCount = stats.subscriberCount === null ? null : safeInteger(stats.subscriberCount);
      const viewCount = stats.viewCount === null ? null : safeInteger(stats.viewCount);
      const videoCount = stats.videoCount === null ? null : safeInteger(stats.videoCount);
      const watchHours = stats.watchHours === null ? null : safeInteger(stats.watchHours);
      const observedAt = isoDate(stats.observedAt);
      if (
        (stats.subscriberCount !== null && subscriberCount === null) ||
        (stats.viewCount !== null && viewCount === null) ||
        (stats.videoCount !== null && videoCount === null) ||
        (stats.watchHours !== null && watchHours === null) ||
        !observedAt
      ) throw new Error("Invalid stats snapshot");
      await sql.query(
        `insert into youtube_channel_stats(
           channel_id,subscriber_count,view_count,video_count,watch_hours,top_videos,observed_at
         ) values ($1,$2,$3,$4,$5,$6::jsonb,$7)
         on conflict(channel_id) do update set
           subscriber_count=excluded.subscriber_count,view_count=excluded.view_count,
           video_count=excluded.video_count,watch_hours=excluded.watch_hours,
           top_videos=excluded.top_videos,observed_at=excluded.observed_at,updated_at=now()`,
        [
          id, subscriberCount, viewCount, videoCount, watchHours,
          JSON.stringify(stats.topVideos), observedAt,
        ],
      );
    },

    async getStats(id) {
      const result = await sql.query(
        `select subscriber_count,view_count,video_count,watch_hours,top_videos,observed_at
         from youtube_channel_stats where channel_id=$1`,
        [id],
      );
      return result.rows.length === 0 ? null : parseStats(result.rows[0]!);
    },

    async recordAudit(input) {
      await sql.query(
        "insert into audit_events(event_type,target_id,actor_class,payload) values ($1,$2,'admin',$3::jsonb)",
        [input.eventType, input.targetId ?? null, JSON.stringify(input.payload)],
      );
    },
  };
}

export function createNeonYouTubeControlPlaneRepository(
  databaseUrl: string,
): YouTubeControlPlaneRepository {
  return createYouTubeControlPlaneRepository(createSql(databaseUrl));
}
