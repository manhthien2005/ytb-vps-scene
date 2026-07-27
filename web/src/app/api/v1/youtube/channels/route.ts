import { NextRequest, NextResponse } from "next/server";
import { parseServerEnv } from "@/lib/config/env";
import { AppError, publicErrorBody } from "@/lib/domain/errors";
import { requireAdmin } from "@/lib/http/requests";
import { createNeonYouTubeControlPlaneRepository } from "@/lib/repositories/neon-youtube-control-plane";
import type {
  YouTubeChannelRecord,
  YouTubeStatsRecord,
} from "@/lib/repositories/youtube-control-plane";
import { redactSecrets } from "@/lib/security/redact";

export const runtime = "nodejs";
const RESPONSE_HEADERS = { "cache-control": "no-store" } as const;

type PublicChannel = Readonly<{
  id: string;
  channelId: string;
  title: string;
  avatarUrl: string | null;
  status: YouTubeChannelRecord["status"];
  stats: YouTubeStatsRecord | null;
}>;

function errorResponse(error: AppError): NextResponse {
  return NextResponse.json(publicErrorBody(error), {
    status: error.status,
    headers: RESPONSE_HEADERS,
  });
}

/**
 * Projects a stored channel onto the HTTP shape, field by field.
 *
 * `listChannels()` returns the full row, including `envelope` — the encrypted
 * refresh token. This is an allowlist rather than a `delete`/rest-spread on
 * purpose: a column added to the record later is then absent from the response
 * by default instead of leaking the moment the repository learns about it.
 */
function publicChannel(
  channel: YouTubeChannelRecord,
  stats: YouTubeStatsRecord | null,
): PublicChannel {
  return {
    id: channel.id,
    channelId: channel.channelId,
    title: channel.title,
    avatarUrl: channel.avatarUrl,
    status: channel.status,
    stats,
  };
}

export async function GET(request: NextRequest) {
  const env = parseServerEnv(process.env);
  try {
    await requireAdmin(request, env.sessionSecret);
    const repository = createNeonYouTubeControlPlaneRepository(env.databaseUrl);
    const channels = await repository.listChannels();
    const withStats = await Promise.all(channels.map(async (channel) => publicChannel(
      channel,
      await repository.getStats(channel.id),
    )));
    return NextResponse.json({ channels: withStats }, { headers: RESPONSE_HEADERS });
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error);
    console.error("[api] unhandled error", redactSecrets(error));
    return NextResponse.json(
      { code: "INTERNAL_ERROR" },
      { status: 500, headers: RESPONSE_HEADERS },
    );
  }
}
