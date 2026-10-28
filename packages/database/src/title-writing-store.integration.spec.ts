import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { TextChainService } from "./text-chain";
import { PostgresTitleWritingStore, TITLE_WRITING_MIGRATION } from "./title-writing-store";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for PostgreSQL integration tests");

/**
 * Read-only: this file only asks whether the title writing tables exist and never creates, drops, truncates or writes
 * anything. The shared integration database is rebuilt by other files in an order this file does not control, so it
 * checks the invariant instead of one state: storage is ready exactly when TITLE_WRITING_MIGRATION is recorded. The
 * refusal on a database without the migration, and the upgrade of one, are covered by title-writing-store.acceptance
 * .spec.ts and the API acceptances, each on its own new, disposable database.
 */
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const store = new PostgresTitleWritingStore(pool, new TextChainService(pool));

afterAll(async () => {
  await pool.end();
});

describe("PostgresTitleWritingStore on the shared integration database", () => {
  it("reports storage ready exactly when the title writing migration is recorded", async () => {
    expect(await store.storageReady()).toBe(await migrated(TITLE_WRITING_MIGRATION));
  });
});

/** Whether schema_migration exists and records `name`. Two read-only queries, so a missing table is not an error. */
async function migrated(name: string): Promise<boolean> {
  const table = await pool.query<{ present: boolean }>("SELECT to_regclass('schema_migration') IS NOT NULL AS present");
  if (!table.rows[0]?.present) return false;
  return ((await pool.query("SELECT 1 FROM schema_migration WHERE name = $1", [name])).rowCount ?? 0) === 1;
}
