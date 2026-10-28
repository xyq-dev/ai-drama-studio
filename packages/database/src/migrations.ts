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
  /** Guarded single-migration runs only: migrations found in the directory and left unapplied on purpose. */
  leftPending?: string[];
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

export interface MigrationOptions {
  /**
   * Apply only the migrations whose names sort before this one. Used by isolated acceptances to build the schema of an
   * earlier release and then upgrade it with a second, unrestricted run. The deploy command never sets it.
   */
  before?: string;
  /**
   * Apply exactly this one migration and nothing else, for a release that must not take other pending migrations
   * along (the default run applies every pending one). Same lock, transaction, checksum and ledger as a normal run.
   * Refused, before anything is applied, unless every migration in `requires` is recorded with its file's checksum
   * and every recorded migration still matches its file. Already recorded with the same checksum: nothing happens.
   */
  only?: { name: string; requires: readonly string[] };
}

/** The seven migrations every business database already has (through 20261011000100_episode_plan). */
export const BASE_MIGRATIONS = [
  "20260924000100_m1b_job_core",
  "20260925000100_m2a_text_chain",
  "20260928000100_script_dependency_scopes",
  "20260928000200_m3a_media_assets",
  "20260928000300_m3b_job_shot_lineage",
  "20261008000100_title_writing",
  "20261011000100_episode_plan",
] as const;

/**
 * Lets title_writing_run and title_writing_call store provider_key 'anthropic' (Claude). Independent of the script
 * breakdown migration: it can be applied alone on a database with the base migrations, with or without that one.
 */
export const WRITING_PROVIDER_MIGRATION = "20261016000100_writing_provider_anthropic";

/**
 * Creates writing_candidate_request, the online candidates of the workbench writing assistant. Independent of the script
 * breakdown and the provider migration: it can be applied alone on a database with the base migrations.
 */
export const WRITING_CANDIDATE_MIGRATION = "20261016000200_writing_candidate";

/**
 * Lets writing_candidate_request store provider_key 'deepseek'. Needs the candidate table; independent of the script
 * breakdown and the Claude provider migration. DeepSeek title runs need no migration.
 */
export const WRITING_CANDIDATE_DEEPSEEK_MIGRATION = "20261017000100_writing_candidate_deepseek";

/**
 * Creates the automatic creation tables (auto_creation_run, _stage, _call, _resume). Additive and independent of the
 * script breakdown, provider and candidate migrations: it can be applied alone on a database with the base migrations.
 */
export const AUTO_CREATION_MIGRATION = "20261019000100_auto_creation";

/**
 * Series writing: project.writing_mode, the series-only 7–60 episode range and the series_writing_ tables. Independent of
 * the script breakdown, provider, candidate and automatic creation migrations: it needs only the base migrations.
 */
export const SERIES_WRITING_MIGRATION = "20261023000100_series_writing";

/**
 * The only migrations a guarded single run may apply, each with the migrations it requires. Each is applied by its own
 * command; none of them takes the script breakdown (or anything else pending) along.
 */
export const GUARDED_SINGLE_MIGRATIONS: Readonly<Record<string, readonly string[]>> = {
  [WRITING_PROVIDER_MIGRATION]: BASE_MIGRATIONS,
  [WRITING_CANDIDATE_MIGRATION]: BASE_MIGRATIONS,
  [WRITING_CANDIDATE_DEEPSEEK_MIGRATION]: [...BASE_MIGRATIONS, WRITING_CANDIDATE_MIGRATION],
  [AUTO_CREATION_MIGRATION]: BASE_MIGRATIONS,
  [SERIES_WRITING_MIGRATION]: BASE_MIGRATIONS,
};

export async function runMigrations(
  pool: MigrationPool,
  directory = defaultMigrationDirectory(),
  options: MigrationOptions = {},
): Promise<MigrationResult> {
  const { before, only } = options;
  if (only && before !== undefined) throw new Error("A guarded single migration cannot be combined with before");
  const discovered = await discoverMigrations(directory);
  if (only) return runOnly(pool, discovered, only);
  const migrations = discovered
    .filter((migration) => before === undefined || migration.name.localeCompare(before) < 0);
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

async function checksumOf(migration: MigrationFile): Promise<string> {
  return createHash("sha256").update(await readFile(migration.path, "utf8")).digest("hex");
}

async function runOnly(pool: MigrationPool, discovered: MigrationFile[], only: { name: string; requires: readonly string[] }): Promise<MigrationResult> {
  const target = discovered.find((migration) => migration.name === only.name);
  if (!target) throw new Error(`Migration not found: ${only.name}`);
  const files = new Map(discovered.map((migration) => [migration.name, migration]));
  for (const name of only.requires) {
    if (!files.has(name)) throw new Error(`Required migration not found: ${name}`);
  }
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    locked = true;
    // A guarded run never creates the ledger: a database without one has none of the required migrations either.
    const ledger = await client.query("SELECT to_regclass('schema_migration') IS NOT NULL AS present");
    if (ledger.rows[0]?.present !== true) throw new Error("Migration ledger missing: required migrations are not applied");
    const recorded = await client.query("SELECT name, checksum FROM schema_migration ORDER BY name");
    const checksums = new Map(recorded.rows.map((row) => [String(row.name), String(row.checksum)]));
    // Every recorded migration must still be the file it was applied from, as in a normal run.
    for (const [name, checksum] of checksums) {
      const file = files.get(name);
      if (file && await checksumOf(file) !== checksum) throw new Error(`Applied migration checksum mismatch: ${name}`);
    }
    const missing = only.requires.filter((name) => !checksums.has(name));
    if (missing.length > 0) throw new Error(`Required migrations not applied: ${missing.join(", ")}`);
    const sql = await readFile(target.path, "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const leftPending = discovered.map((migration) => migration.name)
      .filter((name) => name !== target.name && !checksums.has(name));
    const existing = checksums.get(target.name);
    if (existing) {
      if (existing !== checksum) throw new Error(`Applied migration checksum mismatch: ${target.name}`);
      return { applied: [], alreadyApplied: [target.name], leftPending };
    }
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migration (name, checksum) VALUES ($1, $2)", [target.name, checksum]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    return { applied: [target.name], alreadyApplied: [], leftPending };
  } finally {
    try {
      if (locked) await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
    } finally {
      client.release();
    }
  }
}
