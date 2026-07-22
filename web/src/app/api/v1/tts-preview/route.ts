import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseServerEnv } from "@/lib/config/env";
import { AppError, publicErrorBody } from "@/lib/domain/errors";
import { HttpError, readStrictJson, requireAdmin, requireMutationOrigin } from "@/lib/http/requests";
import { synthesizeCapCutBv074Preview } from "@/lib/server/capcut-bv074-preview";

export const runtime = "nodejs";
const HEADERS = { "cache-control": "no-store" } as const;
const bodySchema = z.object({ text: z.string().trim().min(1).max(500), rate: z.number().min(0.8).max(1.2) }).strict();

function errorResponse(error: unknown) {
  if (error instanceof AppError) return NextResponse.json(publicErrorBody(error), { status: error.status, headers: HEADERS });
  return NextResponse.json({ code: "TTS_PREVIEW_UNAVAILABLE" }, { status: 503, headers: HEADERS });
}

export async function POST(request: NextRequest) {
  try {
    const env = parseServerEnv(process.env);
    await requireAdmin(request, env.sessionSecret);
    requireMutationOrigin(request, env.appOrigin);
    const body = await readStrictJson(request, bodySchema, 2_048);
    const audio = await synthesizeCapCutBv074Preview(body.text, body.rate);
    return new NextResponse(audio, { status: 200, headers: { ...HEADERS, "content-type": "audio/mpeg" } });
  } catch (error) {
    if (error instanceof HttpError || error instanceof AppError) return errorResponse(error);
    return errorResponse(error);
  }
}
