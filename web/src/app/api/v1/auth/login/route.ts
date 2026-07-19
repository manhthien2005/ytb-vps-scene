import { createHmac } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { verifyAdminKey } from "@/lib/auth/admin-key";
import { ADMIN_COOKIE } from "@/lib/auth/current-admin";
import { issueSession } from "@/lib/auth/session";
import { parseServerEnv } from "@/lib/config/env";
import { createNeonControlPlaneRepository } from "@/lib/repositories/neon-control-plane";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const env = parseServerEnv(process.env);
  if (request.headers.get("origin") !== env.appOrigin) {
    return NextResponse.json({ code: "ORIGIN_REJECTED" }, { status: 403 });
  }

  const address = (
    request.headers.get("x-vercel-forwarded-for") ??
    request.headers.get("x-forwarded-for") ??
    "unknown"
  )
    .split(",")[0]!
    .trim();
  const loginKey = createHmac("sha256", env.sessionSecret).update(address).digest("hex");
  const repository = createNeonControlPlaneRepository(env.databaseUrl);
  const decision = await repository.consumeLoginAttempt(loginKey, new Date());
  if (!decision.allowed) {
    return NextResponse.json(
      { code: "RATE_LIMITED" },
      {
        status: 429,
        headers: { "retry-after": String(decision.retryAfterSeconds) },
      },
    );
  }

  const body = (await request.json().catch(() => null)) as { key?: unknown } | null;
  if (typeof body?.key !== "string" || !(await verifyAdminKey(body.key, env.adminKeyHash))) {
    return NextResponse.json({ code: "AUTH_REJECTED" }, { status: 401 });
  }

  await repository.clearLoginAttempts(loginKey);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(ADMIN_COOKIE, issueSession(env.sessionSecret), {
    httpOnly: true,
    secure: env.nodeEnv === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 12 * 60 * 60,
  });
  return response;
}
