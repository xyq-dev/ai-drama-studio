import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { TextChainService } from "./text-chain";
import { PostgresTitleWritingStore } from "./title-writing-store";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for PostgreSQL integration tests");

/**
 * Read-only: this file only asks whether the title writing tables exist and never creates, drops, truncates or writes
 * anything. The store's behaviour on the draft tables is covered by title-writing-store.acceptance.spec.ts, which runs
 * only through its own guarded command on a new, empty, disposable database.
 */
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const store = new PostgresTitleWritingStore(pool, new TextChainService(pool));

afterAll(async () => {
  await pool.end();
});

describe("PostgresTitleWritingStore without the draft tables", () => {
  it("reports storage unavailable: the applied migrations do not contain the title writing draft", async () => {
    expect(await store.storageReady()).toBe(false);
  });
});
