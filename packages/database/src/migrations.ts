import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface MigrationClient {
  query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

const MIGRATION_LOCK_ID = 1_943_726_321;

function defaultMigrationDirectory(): string {
  return join(__dirname, "..", "migrations");
}

export async function runMigrations(
  client: MigrationClient,
  directory = defaultMigrationDirectory(),
): Promise<MigrationResult> {
  const files = (await readdir(directory)).filter((name) => /^\d+_[a-z0-9_-]+\.sql$/.test(name)).sort();
  const result: MigrationResult = { applied: [], alreadyApplied: [] };

  await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migration (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

    const recorded = await client.query("SELECT name, checksum FROM schema_migration ORDER BY name");
    const checksums = new Map(recorded.rows.map((row) => [String(row.name), String(row.checksum)]));

    for (const name of files) {
      const sql = await readFile(join(directory, name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = checksums.get(name);
      if (existing) {
        if (existing !== checksum) throw new Error(`Applied migration checksum mismatch: ${name}`);
        result.alreadyApplied.push(name);
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migration (name, checksum) VALUES ($1, $2)", [name, checksum]);
        await client.query("COMMIT");
        result.applied.push(name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return result;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
  }
}
