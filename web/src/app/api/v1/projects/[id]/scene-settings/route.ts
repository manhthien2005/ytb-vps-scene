import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseServerEnv } from "@/lib/config/env";
import { parseSceneSettings } from "@/lib/domain/scene-settings";
import { AppError, publicErrorBody } from "@/lib/domain/errors";
import { HttpError, readStrictJson, requireAdmin, requireMutationOrigin } from "@/lib/http/requests";
import { createSql } from "@/lib/db/client";
import { redactSecrets } from "@/lib/security/redact";

export const runtime = "nodejs";
const HEADERS = { "cache-control": "no-store" } as const;
const uuid = z.string().uuid();
type Context = Readonly<{ params: Promise<Readonly<{ id: string }>> }>;

function errorResponse(error: unknown) {
  if (error instanceof AppError) return NextResponse.json(publicErrorBody(error), { status: error.status, headers: HEADERS });
  console.error("[api] unhandled error", redactSecrets(error));
  return NextResponse.json({ code: "INTERNAL_ERROR" }, { status: 500, headers: HEADERS });
}

async function projectId(context: Context): Promise<string> {
  const value = (await context.params).id;
  if (!uuid.safeParse(value).success) throw new HttpError(400, "INVALID_REQUEST");
  return value;
}

export async function GET(request: NextRequest, context: Context) {
  try {
    const env = parseServerEnv(process.env);
    await requireAdmin(request, env.sessionSecret);
    const id = await projectId(context);
    const sql = createSql(env.databaseUrl);
    const result = await sql.query("select settings from project_scene_settings where project_id=$1", [id]);
    const row = result.rows[0] as { settings?: unknown } | undefined;
    const settings = row?.settings === undefined ? null : parseSceneSettings(row.settings);
    return NextResponse.json({ settings }, { headers: HEADERS });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: NextRequest, context: Context) {
  try {
    const env = parseServerEnv(process.env);
    await requireAdmin(request, env.sessionSecret);
    requireMutationOrigin(request, env.appOrigin);
    const id = await projectId(context);
    const body = await readStrictJson(request, z.object({ settings: z.unknown() }).strict(), 4_096);
    let settings: ReturnType<typeof parseSceneSettings>;
    try {
      settings = parseSceneSettings(body.settings);
    } catch {
      throw new HttpError(400, "INVALID_REQUEST");
    }
    const sql = createSql(env.databaseUrl);
    try {
      await sql.query(
        `insert into project_scene_settings(project_id,settings,updated_at) values ($1,$2::jsonb,now())
         on conflict(project_id) do update set settings=excluded.settings,updated_at=excluded.updated_at`,
        [id, JSON.stringify(settings)],
      );
    } catch (error) {
      // Foreign-key violation: the project row no longer exists (stale tab, deleted project).
      if ((error as { code?: unknown }).code === "23503") throw new HttpError(404, "INVALID_REQUEST");
      throw error;
    }
    return NextResponse.json({ settings }, { headers: HEADERS });
  } catch (error) {
    return errorResponse(error);
  }
}
