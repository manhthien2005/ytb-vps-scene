import { NextRequest, NextResponse } from "next/server";
import { ADMIN_COOKIE } from "@/lib/auth/current-admin";
import { parseServerEnv } from "@/lib/config/env";

export async function POST(request: NextRequest) {
  const env = parseServerEnv(process.env);
  if (request.headers.get("origin") !== env.appOrigin) {
    return NextResponse.json({ code: "ORIGIN_REJECTED" }, { status: 403 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(ADMIN_COOKIE, "", {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  return response;
}
