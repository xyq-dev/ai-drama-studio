import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseMigrateArgs } from "./migrate-cli";
import {
  BASE_MIGRATIONS,
  GUARDED_SINGLE_MIGRATIONS,
  AUTO_CREATION_MIGRATION,
  WRITING_CANDIDATE_DEEPSEEK_MIGRATION,
  WRITING_CANDIDATE_MIGRATION,
  WRITING_PROVIDER_MIGRATION,
  runMigrations,
  type MigrationClient,
} from "./migrations";

const REAL_DIRECTORY = join(__dirname, "..", "prisma", "migrations");
const BREAKDOWN = "20261012000100_script_breakdown";
const CANDIDATE = WRITING_CANDIDATE_MIGRATION;
const DEEPSEEK = WRITING_CANDIDATE_DEEPSEEK_MIGRATION;
const AUTO = AUTO_CREATION_MIGRATION;

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A ledger double: the recorded rows and every statement the runner sent, in order. */
function ledger(initial: Array<{ name: string; checksum: string }>, options: { present?: boolean; failOn?: string } = {}) {
  const recorded = [...initial];
  const statements: string[] = [];
  const release = vi.fn();
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    statements.push(sql);
    if (options.failOn && sql === options.failOn) throw new Error("statement failed");
    if (sql.startsWith("SELECT to_regclass('schema_migration')")) return { rows: [{ present: options.present ?? true }] };
    if (sql.startsWith("SELECT name, checksum")) return { rows: recorded.map((row) => ({ ...row })) };
    if (sql.startsWith("INSERT INTO schema_migration")) recorded.push({ name: String(values?.[0]), checksum: String(values?.[1]) });
    return { rows: [] };
  }) as unknown as MigrationClient["query"];
  return { pool: { connect: vi.fn(async () => ({ query, release })) }, recorded, statements, release };
}

async function realLedger(names: readonly string[]) {
  return Promise.all(names.map(async (name) => ({ name, checksum: sha(await readFile(join(REAL_DIRECTORY, name, "migration.sql"), "utf8")) })));
}

const only = { name: WRITING_PROVIDER_MIGRATION, requires: BASE_MIGRATIONS };

describe("the provider migration", () => {
  it("sorts after every migration it requires and after the script breakdown, and requires exactly the seven base ones", async () => {
    const names = (await readdir(REAL_DIRECTORY, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    expect(names.slice(0, 7)).toEqual([...BASE_MIGRATIONS]);
    expect(names).toEqual([...BASE_MIGRATIONS, BREAKDOWN, WRITING_PROVIDER_MIGRATION, CANDIDATE, DEEPSEEK, AUTO]);
    expect(GUARDED_SINGLE_MIGRATIONS).toEqual({ [WRITING_PROVIDER_MIGRATION]: BASE_MIGRATIONS, [CANDIDATE]: BASE_MIGRATIONS,
      [DEEPSEEK]: [...BASE_MIGRATIONS, CANDIDATE], [AUTO]: BASE_MIGRATIONS });
    expect(BASE_MIGRATIONS).not.toContain(BREAKDOWN);
  });

  it("only widens the two provider_key CHECKs, keeps the retired values and does not touch the breakdown schema", async () => {
    const sql = await readFile(join(REAL_DIRECTORY, WRITING_PROVIDER_MIGRATION, "migration.sql"), "utf8");
    const statements = sql.split("\n").filter((line) => !line.startsWith("--")).join("\n");
    expect(statements).toContain("CHECK (provider_key IN ('qwen', 'openai', 'deepseek', 'anthropic'))");
    expect(statements.match(/ADD CONSTRAINT/g)).toHaveLength(2);
    expect(statements).toContain("title_writing_run_provider_key_check");
    expect(statements).toContain("title_writing_call_provider_key_check");
    for (const forbidden of ["run_kind", "breakdown", "UPDATE ", "DELETE ", "INSERT ", "DROP TABLE", "TRUNCATE", "schema_migration", "NOT VALID"]) {
      expect(statements).not.toContain(forbidden);
    }
    // Not a free-form provider value.
    expect(statements).not.toMatch(/provider_key\s*(~|LIKE|IS NOT NULL)/);
  });
});

describe("the candidate migration", () => {
  it("only creates its own table and indexes; it writes no row and touches no existing table, the breakdown or the provider CHECKs", async () => {
    const sql = await readFile(join(REAL_DIRECTORY, CANDIDATE, "migration.sql"), "utf8");
    const statements = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
    const created = [...statements.matchAll(/^CREATE (?:UNIQUE )?(TABLE|INDEX) (\w+)(?: ON (\w+))?/gm)].map((match) => [match[1], match[2], match[3]]);
    expect(created.filter(([kind]) => kind === "TABLE").map(([, name]) => name)).toEqual(["writing_candidate_request"]);
    expect(created.every(([, name, on]) => name!.startsWith("writing_candidate_request") && (on === undefined || on === "writing_candidate_request"))).toBe(true);
    for (const forbidden of ["ALTER TABLE", "UPDATE ", "DELETE ", "INSERT ", "DROP ", "TRUNCATE", "schema_migration", "run_kind", "title_writing"]) {
      expect(statements).not.toContain(forbidden);
    }
    // New requests only name the active providers; cost is never an amount.
    expect(statements).toContain("CHECK (provider_key IN ('openai', 'anthropic'))");
    expect(statements).toContain("CHECK (billing_status = 'unknown')");
    expect(statements).not.toMatch(/amount\w*\s+(numeric|decimal)/i);
    expect(statements).toContain("UNIQUE (workspace_id, actor_id, idempotency_key)");
    expect(statements).toContain("WHERE state IN ('reserved', 'submitted')");
  });
});

describe("guarded single migration", () => {
  it("on a base-seven database applies only the provider migration and leaves the breakdown pending", async () => {
    const db = ledger(await realLedger(BASE_MIGRATIONS));
    const result = await runMigrations(db.pool, REAL_DIRECTORY, { only });
    expect(result).toEqual({ applied: [WRITING_PROVIDER_MIGRATION], alreadyApplied: [], leftPending: [BREAKDOWN, CANDIDATE, DEEPSEEK, AUTO] });
    expect(db.recorded.map((row) => row.name)).toEqual([...BASE_MIGRATIONS, WRITING_PROVIDER_MIGRATION]);
    const providerSql = await readFile(join(REAL_DIRECTORY, WRITING_PROVIDER_MIGRATION, "migration.sql"), "utf8");
    const breakdownSql = await readFile(join(REAL_DIRECTORY, BREAKDOWN, "migration.sql"), "utf8");
    expect(db.statements).toContain(providerSql);
    expect(db.statements).not.toContain(breakdownSql);
    // Same lock, one transaction, the ledger never created by a guarded run.
    expect(db.statements[0]).toBe("SELECT pg_advisory_lock($1)");
    expect(db.statements.filter((sql) => sql === "BEGIN")).toHaveLength(1);
    expect(db.statements.filter((sql) => sql === "COMMIT")).toHaveLength(1);
    expect(db.statements.some((sql) => sql.startsWith("CREATE TABLE"))).toBe(false);
    expect(db.statements.at(-1)).toBe("SELECT pg_advisory_unlock($1)");
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("on a database that already has the breakdown applies the same migration and nothing else", async () => {
    const db = ledger(await realLedger([...BASE_MIGRATIONS, BREAKDOWN]));
    expect(await runMigrations(db.pool, REAL_DIRECTORY, { only })).toEqual({ applied: [WRITING_PROVIDER_MIGRATION], alreadyApplied: [], leftPending: [CANDIDATE, DEEPSEEK, AUTO] });
  });

  it("is idempotent: a second run applies nothing", async () => {
    const db = ledger(await realLedger(BASE_MIGRATIONS));
    await runMigrations(db.pool, REAL_DIRECTORY, { only });
    const statementsAfterFirst = db.statements.length;
    expect(await runMigrations(db.pool, REAL_DIRECTORY, { only })).toEqual({ applied: [], alreadyApplied: [WRITING_PROVIDER_MIGRATION], leftPending: [BREAKDOWN, CANDIDATE, DEEPSEEK, AUTO] });
    expect(db.statements.slice(statementsAfterFirst).some((sql) => sql === "BEGIN")).toBe(false);
  });

  it("a later default run still applies the breakdown after it, and nothing twice", async () => {
    const db = ledger(await realLedger(BASE_MIGRATIONS));
    await runMigrations(db.pool, REAL_DIRECTORY, { only });
    expect(await runMigrations(db.pool, REAL_DIRECTORY)).toEqual({ applied: [BREAKDOWN, CANDIDATE, DEEPSEEK, AUTO], alreadyApplied: [...BASE_MIGRATIONS, WRITING_PROVIDER_MIGRATION] });
  });

  it("the candidate migration is its own guarded run: alone on a base-seven database, then the provider one, the breakdown never", async () => {
    const candidate = { name: CANDIDATE, requires: BASE_MIGRATIONS };
    const db = ledger(await realLedger(BASE_MIGRATIONS));
    expect(await runMigrations(db.pool, REAL_DIRECTORY, { only: candidate })).toEqual({ applied: [CANDIDATE], alreadyApplied: [], leftPending: [BREAKDOWN, WRITING_PROVIDER_MIGRATION, DEEPSEEK, AUTO] });
    expect(await runMigrations(db.pool, REAL_DIRECTORY, { only })).toEqual({ applied: [WRITING_PROVIDER_MIGRATION], alreadyApplied: [], leftPending: [BREAKDOWN, DEEPSEEK, AUTO] });
    expect(await runMigrations(db.pool, REAL_DIRECTORY, { only: candidate })).toEqual({ applied: [], alreadyApplied: [CANDIDATE], leftPending: [BREAKDOWN, DEEPSEEK, AUTO] });
    expect(db.recorded.map((row) => row.name)).toEqual([...BASE_MIGRATIONS, CANDIDATE, WRITING_PROVIDER_MIGRATION]);
    const breakdownSql = await readFile(join(REAL_DIRECTORY, BREAKDOWN, "migration.sql"), "utf8");
    expect(db.statements).not.toContain(breakdownSql);
  });

  it("refuses, before any statement of the migration, when a base migration is missing or the ledger is absent", async () => {
    const missing = ledger(await realLedger(BASE_MIGRATIONS.slice(0, 6)));
    await expect(runMigrations(missing.pool, REAL_DIRECTORY, { only })).rejects.toThrow("Required migrations not applied: 20261011000100_episode_plan");
    expect(missing.statements).not.toContain("BEGIN");
    expect(missing.release).toHaveBeenCalledOnce();
    const none = ledger([], { present: false });
    await expect(runMigrations(none.pool, REAL_DIRECTORY, { only })).rejects.toThrow("Migration ledger missing");
    expect(none.statements).not.toContain("BEGIN");
  });

  it("refuses when any recorded migration no longer matches its file", async () => {
    const rows = await realLedger(BASE_MIGRATIONS);
    rows[5] = { ...rows[5]!, checksum: "0".repeat(64) };
    const db = ledger(rows);
    await expect(runMigrations(db.pool, REAL_DIRECTORY, { only })).rejects.toThrow("checksum mismatch: 20261008000100_title_writing");
    expect(db.statements).not.toContain("BEGIN");
  });

  it("refuses when the provider migration was recorded with another checksum", async () => {
    const db = ledger([...await realLedger(BASE_MIGRATIONS), { name: WRITING_PROVIDER_MIGRATION, checksum: "f".repeat(64) }]);
    await expect(runMigrations(db.pool, REAL_DIRECTORY, { only })).rejects.toThrow(`checksum mismatch: ${WRITING_PROVIDER_MIGRATION}`);
  });

  it("rolls back and records nothing when the migration fails", async () => {
    const providerSql = await readFile(join(REAL_DIRECTORY, WRITING_PROVIDER_MIGRATION, "migration.sql"), "utf8");
    const db = ledger(await realLedger(BASE_MIGRATIONS), { failOn: providerSql });
    await expect(runMigrations(db.pool, REAL_DIRECTORY, { only })).rejects.toThrow("statement failed");
    expect(db.statements).toContain("ROLLBACK");
    expect(db.statements).not.toContain("COMMIT");
    expect(db.recorded.map((row) => row.name)).toEqual([...BASE_MIGRATIONS]);
    expect(db.statements.at(-1)).toBe("SELECT pg_advisory_unlock($1)");
  });

  it("cannot be combined with before, and a name outside the directory is refused", async () => {
    const db = ledger([]);
    await expect(runMigrations(db.pool, REAL_DIRECTORY, { only, before: BREAKDOWN })).rejects.toThrow("cannot be combined");
    const directory = await mkdtemp(join(tmpdir(), "ai-drama-only-"));
    await mkdir(join(directory, "0001_first"));
    await writeFile(join(directory, "0001_first", "migration.sql"), "SELECT 1;\n");
    await expect(runMigrations(db.pool, directory, { only })).rejects.toThrow("Migration not found");
    expect(db.statements).toEqual([]);
  });
});

describe("migrate command arguments", () => {
  it("defaults to every pending migration and accepts --only for the guarded provider migration only", () => {
    expect(parseMigrateArgs([])).toEqual({});
    expect(parseMigrateArgs(["--", "--only", WRITING_PROVIDER_MIGRATION])).toEqual({ only });
    expect(parseMigrateArgs(["--only", CANDIDATE])).toEqual({ only: { name: CANDIDATE, requires: BASE_MIGRATIONS } });
    expect(() => parseMigrateArgs(["--only", BREAKDOWN])).toThrow("Not a guarded single migration");
    expect(() => parseMigrateArgs(["--only"])).toThrow("Usage");
    expect(() => parseMigrateArgs(["--all"])).toThrow("Usage");
  });
});

describe("the DeepSeek candidate migration", () => {
  const deepseekOnly = { name: DEEPSEEK, requires: GUARDED_SINGLE_MIGRATIONS[DEEPSEEK]! };

  it("only widens the candidate provider_key CHECK by deepseek: no row, no other table, no free-form value", async () => {
    const sql = await readFile(join(REAL_DIRECTORY, DEEPSEEK, "migration.sql"), "utf8");
    const statements = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
    expect(statements).toContain("CHECK (provider_key IN ('openai', 'anthropic', 'deepseek'))");
    expect(statements.match(/ADD CONSTRAINT/g)).toHaveLength(1);
    expect(statements).toContain("writing_candidate_request_provider_key_check");
    expect(statements.match(/ALTER TABLE (\w+)/g)?.every((match) => match.endsWith("writing_candidate_request"))).toBe(true);
    for (const forbidden of ["title_writing", "run_kind", "breakdown", "UPDATE ", "DELETE ", "INSERT ", "DROP TABLE", "TRUNCATE", "schema_migration",
      "NOT VALID", "qwen", "CREATE "]) {
      expect(statements).not.toContain(forbidden);
    }
    expect(statements).not.toMatch(/provider_key\s*(~|LIKE|IS NOT NULL)/);
    // It stops unless the table has exactly one CHECK on provider_key and that CHECK is exactly the released one: a
    // compound or further CHECK is never dropped (found by definition, not by a generated name).
    expect(statements).toContain("RAISE EXCEPTION 'expected exactly one provider_key CHECK");
    expect(statements).toContain("RAISE EXCEPTION 'unexpected provider_key CHECK");
    expect(statements).toContain("CHECK ((provider_key = ANY (ARRAY[''openai''::text, ''anthropic''::text])))");
    expect(statements.match(/DROP CONSTRAINT/g)).toHaveLength(1);
  });

  it("on the test-site combination (base seven, Claude, candidates; breakdown not applied) applies only itself and leaves the breakdown pending", async () => {
    const db = ledger(await realLedger([...BASE_MIGRATIONS, WRITING_PROVIDER_MIGRATION, CANDIDATE]));
    expect(await runMigrations(db.pool, REAL_DIRECTORY, { only: deepseekOnly })).toEqual({ applied: [DEEPSEEK], alreadyApplied: [], leftPending: [BREAKDOWN, AUTO] });
    expect(db.recorded.map((row) => row.name)).toEqual([...BASE_MIGRATIONS, WRITING_PROVIDER_MIGRATION, CANDIDATE, DEEPSEEK]);
    const breakdownSql = await readFile(join(REAL_DIRECTORY, BREAKDOWN, "migration.sql"), "utf8");
    expect(db.statements).not.toContain(breakdownSql);
    expect(db.statements.filter((sql) => sql === "BEGIN")).toHaveLength(1);
    expect(db.statements.filter((sql) => sql === "COMMIT")).toHaveLength(1);
    // A second run is a no-op: nothing is applied or recorded twice.
    const before = db.statements.length;
    expect(await runMigrations(db.pool, REAL_DIRECTORY, { only: deepseekOnly })).toEqual({ applied: [], alreadyApplied: [DEEPSEEK], leftPending: [BREAKDOWN, AUTO] });
    expect(db.statements.slice(before)).not.toContain("BEGIN");
    expect(db.recorded.filter((row) => row.name === DEEPSEEK)).toHaveLength(1);
  });

  it("refuses with zero writes while the candidate table migration is missing", async () => {
    const db = ledger(await realLedger([...BASE_MIGRATIONS, WRITING_PROVIDER_MIGRATION]));
    await expect(runMigrations(db.pool, REAL_DIRECTORY, { only: deepseekOnly })).rejects.toThrow(`Required migrations not applied: ${CANDIDATE}`);
    expect(db.statements).not.toContain("BEGIN");
    expect(db.recorded.map((row) => row.name)).toEqual([...BASE_MIGRATIONS, WRITING_PROVIDER_MIGRATION]);
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("rolls back and records nothing when its statement fails", async () => {
    const sql = await readFile(join(REAL_DIRECTORY, DEEPSEEK, "migration.sql"), "utf8");
    const db = ledger(await realLedger([...BASE_MIGRATIONS, CANDIDATE]), { failOn: sql });
    await expect(runMigrations(db.pool, REAL_DIRECTORY, { only: deepseekOnly })).rejects.toThrow("statement failed");
    expect(db.statements).toContain("ROLLBACK");
    expect(db.statements).not.toContain("COMMIT");
    expect(db.recorded.some((row) => row.name === DEEPSEEK)).toBe(false);
  });

  it("the migrate command accepts it as its own guarded run with exactly its requirements", () => {
    expect(parseMigrateArgs(["--only", DEEPSEEK])).toEqual({ only: { name: DEEPSEEK, requires: [...BASE_MIGRATIONS, CANDIDATE] } });
  });
});
