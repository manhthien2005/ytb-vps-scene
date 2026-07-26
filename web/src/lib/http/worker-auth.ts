import { AppError } from "@/lib/domain/errors";
import type { WorkerView } from "@/lib/domain/worker";
import { digestBearerSecret } from "@/lib/security/worker-secret";

const AUTHORIZATION_PATTERN = /^Bearer ([A-Za-z0-9_-]{43})$/;

export interface WorkerSessionRepository {
  authenticateWorker(sessionDigest: string, now: Date): Promise<WorkerView | null>;
}

export function readWorkerBearer(request: Request): string {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(AUTHORIZATION_PATTERN);
  if (!match) throw new AppError("WORKER_AUTH_REQUIRED", 401);
  return match[1]!;
}

export async function requireWorkerSession(
  request: Request,
  repository: WorkerSessionRepository,
  key: string,
  now: Date,
): Promise<WorkerView> {
  let digest: string;
  try {
    digest = digestBearerSecret(readWorkerBearer(request), key);
  } catch (error) {
    if (error instanceof AppError) throw error;
    // A syntactically plausible but non-canonical bearer (43 chars whose last
    // character carries stray bits) is an authentication failure, not a 500.
    throw new AppError("WORKER_AUTH_REQUIRED", 401);
  }
  const worker = await repository.authenticateWorker(digest, now);
  if (worker === null) throw new AppError("WORKER_SESSION_EXPIRED", 401);
  if (worker.state === "REVOKED") throw new AppError("WORKER_REVOKED", 401);
  return worker;
}
