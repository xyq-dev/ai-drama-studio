import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface MigrationClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

export interface MigrationPool {
  connect(): Promise<MigrationClient>;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

interface MigrationFile {
  name: string;
  path: string;
}

const MIGRATION_LOCK_ID = 1_943_726_321;

function defaultMigrationDirectory(): string {
  return join(__dirname, "..", "prisma", "migrations");
}

async function discoverMigrations(directory: string): Promise<MigrationFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const migrations: MigrationFile[] = [];

  for (const entry of entries) {
    if (entry.isDirectory() && /^\d+_[a-z0-9_-]+$/.test(entry.name)) {
      migrations.push({ name: entry.name, path: join(directory, entry.name, "migration.sql") });
      continue;
    }

    if (entry.isFile() && /^\d+_[a-z0-9_-]+\.sql$/.test(entry.name)) {
      migrations.push({ name: entry.name, path: join(directory, entry.name) });
    }
  }

  return migrations.sort((left, right) => left.name.localeCompare(right.name));
}

export async function runMigrations(
  pool: MigrationPool,
  directory = defaultMigrationDirectory(),
): Promise<MigrationResult> {
  const migrations = await discoverMigrations(directory);
  const result: MigrationResult = { applied: [], alreadyApplied: [] };
  const client = await pool.connect();
  let locked = false;

  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    locked = true;

    await client.query(`CREATE TABLE IF NOT EXISTS schema_migration (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

    const recorded = await client.query("SELECT name, checksum FROM schema_migration ORDER BY name");
    const checksums = new Map(recorded.rows.map((row) => [String(row.name), String(row.checksum)]));

    for (const migration of migrations) {
      const sql = await readFile(migration.path, "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = checksums.get(migration.name);

      if (existing) {
        if (existing !== checksum) {
          throw new Error(`Applied migration checksum mismatch: ${migration.name}`);
        }
        result.alreadyApplied.push(migration.name);
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migration (name, checksum) VALUES ($1, $2)", [
          migration.name,
          checksum,
        ]);
        await client.query("COMMIT");
        result.applied.push(migration.name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    return result;
  } finally {
    try {
      if (locked) {
        await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
      }
    } finally {
      client.release();
    }
  }
}
