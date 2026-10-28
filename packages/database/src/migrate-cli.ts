import { createPostgresPool } from "./index";
import { GUARDED_SINGLE_MIGRATIONS, runMigrations, type MigrationOptions } from "./migrations";

/**
 * Without arguments every pending migration is applied. `--only <name>` applies exactly one guarded migration (see
 * GUARDED_SINGLE_MIGRATIONS) and leaves every other pending migration, for example the script breakdown, unapplied.
 */
export function parseMigrateArgs(argv: readonly string[]): MigrationOptions {
  const args = argv.filter((arg) => arg !== "--");
  if (args.length === 0) return {};
  if (args.length !== 2 || args[0] !== "--only") throw new Error("Usage: migrate [--only <migration>]");
  const name = args[1]!;
  const requires = GUARDED_SINGLE_MIGRATIONS[name];
  if (!requires) throw new Error(`Not a guarded single migration: ${name}`);
  return { only: { name, requires } };
}

async function main(): Promise<void> {
  const options = parseMigrateArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const pool = createPostgresPool({
    connectionString: databaseUrl,
    connectionTimeoutMs: 5_000,
    statementTimeoutMs: 30_000,
    queryTimeoutMs: 30_000,
  });
  try {
    const result = await runMigrations(pool, undefined, options);
    process.stdout.write(`Applied ${result.applied.length} migration(s).\n`);
    if (options.only) {
      // Names only; never the connection string.
      process.stdout.write(`${JSON.stringify({ applied: result.applied, alreadyApplied: result.alreadyApplied, leftPending: result.leftPending ?? [] })}\n`);
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Migration failed"}\n`);
    process.exitCode = 1;
  });
}
