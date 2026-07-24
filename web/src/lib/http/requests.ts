import { z } from "zod";
import { currentAdmin } from "@/lib/auth/current-admin";
import { AppError, type PublicCode } from "@/lib/domain/errors";

export class HttpError extends AppError {
  constructor(status: number, code: PublicCode) {
    super(code, status);
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
    let part: ReadableStreamReadResult<Uint8Array>;
    try {
      part = await reader.read();
    } catch {
      throw new HttpError(400, "INVALID_REQUEST");
    }
    if (part.done) break;
    size += part.value.byteLength;
    if (size > maxBytes) {
      try {
        void reader.cancel().catch(() => undefined);
      } catch {
        // Cancellation is best-effort; stream details must never escape.
      }
      throw new HttpError(413, "REQUEST_TOO_LARGE");
    }
    chunks.push(part.value);
  }
  try {
    return schema.parse(JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    ));
  } catch {
    throw new HttpError(400, "INVALID_REQUEST");
  }
}
