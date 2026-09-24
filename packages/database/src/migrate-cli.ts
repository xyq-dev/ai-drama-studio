import { createPostgresPool } from "./index";
import { runMigrations } from "./migrations";
import type { MigrationClient } from "./migrations";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = createPostgresPool({
  connectionString: databaseUrl,
  connectionTimeoutMs: 5_000,
  statementTimeoutMs: 30_000,
  queryTimeoutMs: 30_000,
});

async function main(): Promise<void> {
  try {
    const result = await runMigrations(pool as MigrationClient);
    process.stdout.write(`Applied ${result.applied.length} migration(s).\n`);
  } finally {
    await pool.end();
  }
}

void main();
