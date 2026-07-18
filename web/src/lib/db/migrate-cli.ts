import { migrate } from "./migrate";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl?.startsWith("postgresql://")) throw new Error("DATABASE_URL must be a PostgreSQL URL");
await migrate(databaseUrl);
process.stdout.write("Control-plane schema migration complete.\n");
