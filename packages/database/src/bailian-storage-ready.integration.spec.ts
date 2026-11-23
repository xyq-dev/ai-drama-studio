import { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { TextChainService } from "./text-chain";
import { PostgresTitleWritingStore } from "./title-writing-store";

it("requires a current provider check allowing Bailian on each writing table", async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  // One private session, with temporary tables shadowing the permanent schema on this connection only.
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const store = new PostgresTitleWritingStore(pool, new TextChainService(pool));
  const columns = vi.spyOn(store, "storageReady").mockResolvedValue(true);
  try {
    await pool.query("CREATE TEMP TABLE title_writing_run (provider_key text CHECK (provider_key IN ('bailian','deepseek')))");
    await pool.query("CREATE TEMP TABLE title_writing_call (provider_key text)");
    expect(await store.bailianStorageReady()).toBe(false);
    await pool.query("ALTER TABLE pg_temp.title_writing_run ADD CONSTRAINT duplicate_run_check CHECK (provider_key IN ('bailian','deepseek'))");
    expect(await store.bailianStorageReady()).toBe(false);
    await pool.query("ALTER TABLE pg_temp.title_writing_run DROP CONSTRAINT duplicate_run_check");
    await pool.query("ALTER TABLE pg_temp.title_writing_call ADD CONSTRAINT call_provider CHECK (provider_key IN ('bailian','deepseek'))");
    expect(await store.bailianStorageReady()).toBe(true);
    await pool.query("ALTER TABLE pg_temp.title_writing_call ADD CONSTRAINT old_provider CHECK (provider_key IN ('qwen','deepseek'))");
    expect(await store.bailianStorageReady()).toBe(false);
    await pool.query("ALTER TABLE pg_temp.title_writing_call DROP CONSTRAINT old_provider");
    await pool.query("ALTER TABLE pg_temp.title_writing_call DROP CONSTRAINT call_provider");
    await pool.query("ALTER TABLE pg_temp.title_writing_call ADD CONSTRAINT denies_bailian CHECK (provider_key NOT IN ('bailian','openai'))");
    expect(await store.bailianStorageReady()).toBe(false);
    await pool.query("ALTER TABLE pg_temp.title_writing_call DROP CONSTRAINT denies_bailian");
    await pool.query("ALTER TABLE pg_temp.title_writing_call ADD CONSTRAINT complex_check CHECK (provider_key <> 'bailian' OR provider_key IS NULL)");
    expect(await store.bailianStorageReady()).toBe(false);
    await pool.query("ALTER TABLE pg_temp.title_writing_call DROP CONSTRAINT complex_check");
    await pool.query("ALTER TABLE pg_temp.title_writing_call ADD CONSTRAINT call_provider CHECK (provider_key IN ('bailian','deepseek'))");
    columns.mockResolvedValue(false);
    expect(await store.bailianStorageReady()).toBe(false);
  } finally {
    await pool.end();
  }
});
