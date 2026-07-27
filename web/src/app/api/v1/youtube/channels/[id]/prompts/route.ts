import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { parseServerEnv } from "@/lib/config/env";
import { AppError, publicErrorBody } from "@/lib/domain/errors";
import {
  YOUTUBE_DESCRIPTION_MAX_CHARS,
  YOUTUBE_TAGS_MAX_TOTAL_CHARS,
} from "@/lib/domain/youtube";
import { HttpError, readStrictJson, requireAdmin, requireMutationOrigin } from "@/lib/http/requests";
import { createNeonYouTubeControlPlaneRepository } from "@/lib/repositories/neon-youtube-control-plane";
import { redactSecrets } from "@/lib/security/redact";

export const runtime = "nodejs";
const BODY_BYTES = 32_768;
const RESPONSE_HEADERS = { "cache-control": "no-store" } as const;
const uuid = z.string().uuid();

// The tag budget is a YouTube-side limit on the SUM of every tag's length, which
// neither the Zod per-tag cap nor the database CHECK constraints can express: 50
// tags of 100 characters each satisfy both and still blow a 500-character budget.
const promptsSchema = z.object({
  titlePrompt: z.string().max(4_000).nullable(),
  descriptionPrompt: z.string().max(4_000).nullable(),
  descriptionTemplate: z.string().max(YOUTUBE_DESCRIPTION_MAX_CHARS).nullable(),
  defaultTags: z.array(z.string().min(1).max(100)).max(50).refine(
    (tags) => tags.reduce((total, tag) => total + tag.length, 0) <= YOUTUBE_TAGS_MAX_TOTAL_CHARS,
    { message: `defaultTags must total at most ${YOUTUBE_TAGS_MAX_TOTAL_CHARS} characters` },
  ),
  thumbnailPromptTemplate: z.string().max(4_000).nullable(),
}).strict();

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

export async function PUT(request: NextRequest, context: RouteContext) {
  try {
    const env = parseServerEnv(process.env);
    await requireAdmin(request, env.sessionSecret);
    requireMutationOrigin(request, env.appOrigin);
    const id = await channelId(context);
    const body = await readStrictJson(request, promptsSchema, BODY_BYTES);

    const repository = createNeonYouTubeControlPlaneRepository(env.databaseUrl);
    const saved = await repository.savePrompts(id, {
      titlePrompt: body.titlePrompt,
      descriptionPrompt: body.descriptionPrompt,
      descriptionTemplate: body.descriptionTemplate,
      defaultTags: body.defaultTags,
      thumbnailPromptTemplate: body.thumbnailPromptTemplate,
    });
    // savePrompts updates by id and reports whether a row matched, so a false here
    // is an unknown channel rather than a failed write.
    if (!saved) throw new AppError("YOUTUBE_CHANNEL_NOT_FOUND", 404);
    return NextResponse.json({ saved: true }, { headers: RESPONSE_HEADERS });
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error);
    return unexpectedErrorResponse(error);
  }
}
