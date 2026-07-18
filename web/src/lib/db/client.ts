import "server-only";
import { neon } from "@neondatabase/serverless";

export function createSql(databaseUrl: string) {
  return neon(databaseUrl, { fullResults: true });
}
