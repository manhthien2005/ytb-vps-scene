import { z } from "zod";
import { currentAdmin } from "@/lib/auth/current-admin";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export async function requireAdmin(request: Request, secret: string): Promise<void> {
  void request;
  if (!(await currentAdmin(secret))) {
    throw new HttpError(401, "AUTH_REQUIRED");
  }
}

export function requireMutationOrigin(request: Request, appOrigin: string): void {
  if (request.headers.get("origin") !== appOrigin) {
    throw new HttpError(403, "ORIGIN_REJECTED");
  }
}

export async function readStrictJson<T>(
  request: Request,
  schema: z.ZodType<T>,
  maxBytes: number,
): Promise<T> {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "INVALID_REQUEST");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > maxBytes) throw new HttpError(413, "REQUEST_TOO_LARGE");
    chunks.push(part.value);
  }
  try {
    return schema.parse(JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))));
  } catch {
    throw new HttpError(400, "INVALID_REQUEST");
  }
}
