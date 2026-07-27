import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createConfiguredYouTube } from "@/lib/application/configured-youtube";
import { refreshChannelStats } from "@/lib/application/youtube-stats";
import { parseServerEnv } from "@/lib/config/env";
import { AppError, publicErrorBody } from "@/lib/domain/errors";
import { HttpError, requireAdmin, requireMutationOrigin } from "@/lib/http/requests";
import { createNeonYouTubeControlPlaneRepository } from "@/lib/repositories/neon-youtube-control-plane";
import { redactSecrets } from "@/lib/security/redact";

export const runtime = "nodejs";
// A full refresh makes up to 20 paginated Data API calls plus an Analytics query.
export const maxDuration = 30;
const RESPONSE_HEADERS = { "cache-control": "no-store" } as const;
const uuid = z.string().uuid();

type RouteContext = Readonly<{ params: Promise<Readonly<{ id: string }>> }>;

function errorResponse(error: AppError): NextResponse {
  return NextResponse.json(publicErrorBody(error), {
    status: error.status,
    headers: RESPONSE_HEADERS,
  });
}

function unexpectedErrorResponse(error: unknown): NextResponse {
  console.error("[api] unhandled error", redactSecrets(error));
  return NextResponse.json(
    { code: "INTERNAL_ERROR" },
    { status: 500, headers: RESPONSE_HEADERS },
  );
}

async function channelId(context: RouteContext): Promise<string> {
  const parsed = uuid.safeParse((await context.params).id);
  if (!parsed.success) throw new HttpError(400, "INVALID_REQUEST");
  return parsed.data;
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const env = parseServerEnv(process.env);
    await requireAdmin(request, env.sessionSecret);
    requireMutationOrigin(request, env.appOrigin);
    const id = await channelId(context);

    const youtube = createConfiguredYouTube(env);
    const stats = await refreshChannelStats({ id, now: new Date() }, {
      repository: createNeonYouTubeControlPlaneRepository(env.databaseUrl),
      oauth: youtube.oauth,
      cipher: youtube.cipher,
      data: youtube.data,
      analytics: youtube.analytics,
    });
    return NextResponse.json({ stats }, { headers: RESPONSE_HEADERS });
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error);
    return unexpectedErrorResponse(error);
  }
}
