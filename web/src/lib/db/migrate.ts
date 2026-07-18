import { readFile } from "node:fs/promises";
import postgres from "postgres";

export async function migrate(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  const source = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
  try {
    await sql.begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(97420381)`;
      await transaction.unsafe(source);
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
