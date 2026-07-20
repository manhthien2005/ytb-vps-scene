import { createHmac } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { verifyAdminKey } from "@/lib/auth/admin-key";
import { ADMIN_COOKIE } from "@/lib/auth/current-admin";
import { issueSession } from "@/lib/auth/session";
import { parseServerEnv } from "@/lib/config/env";
import { createNeonControlPlaneRepository } from "@/lib/repositories/neon-control-plane";

export const runtime = "nodejs";
const MAX_LOGIN_BODY_BYTES = 2_048;
const MAX_ADMIN_KEY_CHARACTERS = 256;

type LoginBodyResult =
  | Readonly<{ kind: "valid"; key: string }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "too-large" }>;

async function readLoginBody(request: NextRequest): Promise<LoginBodyResult> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_LOGIN_BODY_BYTES) {
    return { kind: "too-large" };
  }

  if (!request.body) return { kind: "invalid" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_LOGIN_BODY_BYTES) {
        await reader.cancel();
        return { kind: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    return { kind: "invalid" };
  }

  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      !("key" in value) ||
      typeof value.key !== "string" ||
      value.key.length === 0 ||
      value.key.length > MAX_ADMIN_KEY_CHARACTERS
    ) {
      return { kind: "invalid" };
    }
    return { kind: "valid", key: value.key };
  } catch {
    return { kind: "invalid" };
  }
}

export async function POST(request: NextRequest) {
  const env = parseServerEnv(process.env);
  if (request.headers.get("origin") !== env.appOrigin) {
    return NextResponse.json({ code: "ORIGIN_REJECTED" }, { status: 403 });
  }

  const body = await readLoginBody(request);
  if (body.kind === "too-large") {
    return NextResponse.json({ code: "REQUEST_TOO_LARGE" }, { status: 413 });
  }
  if (body.kind === "invalid") {
    return NextResponse.json({ code: "INVALID_REQUEST" }, { status: 400 });
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

  if (!(await verifyAdminKey(body.key, env.adminKeyHash))) {
    return NextResponse.json({ code: "AUTH_REJECTED" }, { status: 401 });
  }

  await repository.clearLoginAttempts(loginKey);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(ADMIN_COOKIE, issueSession(env.sessionSecret), {
    httpOnly: true,
    secure: env.nodeEnv === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 12 * 60 * 60,
  });
  return response;
}
