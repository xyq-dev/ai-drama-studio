/**
 * Isolated acceptance of the provider migration (20261016000100_writing_provider_anthropic). It runs only against a new,
 * empty, disposable database that a person named on purpose (title-writing-acceptance-guard.ts) and is never part of
 * `test` or `integration`.
 *
 * WRITING_PROVIDER_ACCEPTANCE_SCENARIO selects the starting schema:
 * - "base" (default): the seven base migrations a business database has today, without the script breakdown.
 * - "breakdown": the same plus the script breakdown migration.
 * Historical qwen, deepseek and openai runs and calls are written first. The guarded single-migration command then
 * applies the provider migration alone; nothing else is applied, history is unchanged, and the breakdown stays as it was.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TitleCallRecord, TitleRunRecord, TitleWritingStoredProviderKey } from "@ai-drama/contracts";
import {
  BASE_MIGRATIONS, WRITING_CANDIDATE_DEEPSEEK_MIGRATION, WRITING_CANDIDATE_MIGRATION, WRITING_PROVIDER_MIGRATION, runMigrations, type MigrationResult,
} from "./migrations";
import { TextChainService } from "./text-chain";
import { checkTitleWritingAcceptanceEnv, verifyTitleWritingAcceptanceDatabase } from "./title-writing-acceptance-guard";
import { PostgresTitleWritingStore, SCRIPT_BREAKDOWN_MIGRATION } from "./title-writing-store";

const decision = checkTitleWritingAcceptanceEnv(process.env);
if (!decision.ok) throw new Error(`Writing provider acceptance refused: ${decision.reason}`);
const scenario = process.env.WRITING_PROVIDER_ACCEPTANCE_SCENARIO === "breakdown" ? "breakdown" : "base";

const pool = new Pool({ connectionString: decision.url, max: 4, application_name: "provider-migration-acceptance" });
const store = new PostgresTitleWritingStore(pool, new TextChainService(pool));
const only = { name: WRITING_PROVIDER_MIGRATION, requires: BASE_MIGRATIONS };
/** Identities, counts and outcomes only: never the connection URL, a password, a token or a key. */
const evidence: Record<string, unknown> = { scenario };

const now = () => new Date().toISOString();
async function one(sql: string, values: unknown[]): Promise<string> {
  return (await pool.query<{ id: string }>(sql, values)).rows[0]!.id;
}
async function ledgerNames(): Promise<string[]> {
  return (await pool.query<{ name: string }>("SELECT name FROM schema_migration ORDER BY name")).rows.map((row) => row.name);
}
async function providerChecks(): Promise<string[]> {
  return (await pool.query<{ def: string }>(
    `SELECT conrelid::regclass::text || ': ' || pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid IN ('title_writing_run'::regclass, 'title_writing_call'::regclass) AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%provider_key%' ORDER BY 1`)).rows.map((row) => row.def);
}
async function count(sql: string): Promise<number> {
  return Number((await pool.query<{ n: number }>(sql)).rows[0]!.n);
}
/** Every stored run and call, in a fixed order, as stored. Equal snapshots mean nothing was rewritten or relabelled. */
async function history(): Promise<string> {
  const runs = await pool.query("SELECT id, provider_key, model, input_hash, input_json, state, error_code, calls_used FROM title_writing_run ORDER BY id");
  const calls = await pool.query("SELECT id, run_id, provider_key, model, request_hash, state, provider_request_id, usage_json, billing_status, error_code FROM title_writing_call ORDER BY id");
  return JSON.stringify({ runs: runs.rows, calls: calls.rows });
}

function titleRun(workspaceId: string, projectId: string, providerKey: TitleWritingStoredProviderKey, model: string): TitleRunRecord {
  const at = now();
  return {
    id: randomUUID(), workspaceId, projectId, actorId: "server-owner", idempotencyKey: randomUUID(), inputHash: randomUUID().replace(/-/g, "").padEnd(64, "0"),
    input: { schema: "ads.title-writing.input.v1", promptVersion: "ads.title-writing.prompt.v1", title: "剧名",
      settings: { episodeCount: 3, episodeSeconds: 90, style: "" }, providerKey, model },
    state: "running", errorCode: null, cancelRequestedAt: null, executorId: null, leaseUntil: null, callCap: 8, callsUsed: 0,
    storySave: "pending", storyRevisionId: null, createdAt: at, updatedAt: at,
  } as TitleRunRecord;
}

/** A run of the given provider with one call that was sent and whose outcome stayed unknown (cost unknown). */
async function historicalRun(workspaceId: string, providerKey: TitleWritingStoredProviderKey, model: string) {
  const projectId = await one("INSERT INTO project (workspace_id, title) VALUES ($1, $2) RETURNING id", [workspaceId, `历史 ${providerKey}`]);
  const run = titleRun(workspaceId, projectId, providerKey, model);
  expect((await store.createRun(run, { maxActiveRuns: 10 })).kind).toBe("created");
  const lease = new Date(Date.now() + 60_000).toISOString();
  expect(await store.claimRun(workspaceId, run.id, "historical-executor", now(), lease)).toBe(true);
  const call: TitleCallRecord = { id: randomUUID(), runId: run.id, workspaceId, stepKey: "concept", attemptNo: 1, providerKey, model,
    requestHash: "cd".repeat(32), state: "reserved", executorId: "historical-executor", providerRequestId: null, responseModel: null,
    usage: { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null }, errorCode: null, createdAt: now(), finishedAt: null };
  expect((await store.reserveCall(call, { sinceIso: "2000-01-01T00:00:00Z", maxCallsPerDay: 100 }, now(), lease)).kind).toBe("reserved");
  expect(await store.markCallSubmitted(workspaceId, call.id, "historical-executor", now(), lease)).toBe("submitted");
  expect(await store.finishCall(workspaceId, call.id, "historical-executor", { state: "unknown", errorCode: "timeout", output: null, outputHash: null,
    providerRequestId: `req-${providerKey}`, responseModel: null, usage: call.usage }, now())).toBe(true);
  expect(await store.finishRun(workspaceId, run.id, "historical-executor", "needs_attention", "timeout", now())).toBe(true);
  return run;
}

let workspaceId: string;
let historyBefore: string;
let applied: MigrationResult;

beforeAll(async () => {
  const verified = await verifyTitleWritingAcceptanceDatabase(pool, decision.databaseName);
  if (!verified.ok) {
    await pool.end();
    throw new Error(`Writing provider acceptance refused: ${verified.reason}`);
  }
  const base = await runMigrations(pool, undefined, { before: SCRIPT_BREAKDOWN_MIGRATION });
  expect(base.applied).toEqual([...BASE_MIGRATIONS]);
  if (scenario === "breakdown") {
    expect((await runMigrations(pool, undefined, { before: WRITING_PROVIDER_MIGRATION })).applied).toEqual([SCRIPT_BREAKDOWN_MIGRATION]);
  }
  evidence.startingLedger = await ledgerNames();
  workspaceId = await one("INSERT INTO workspace (name) VALUES ($1) RETURNING id", ["provider-migration"]);
  for (const [key, model] of [["qwen", "qwen3.7-plus-2026-05-26"], ["deepseek", "deepseek-flash"], ["openai", "gpt-6-luna"]] as const) {
    await historicalRun(workspaceId, key, model);
  }
  historyBefore = await history();
});

afterAll(async () => {
  const dir = process.env.TITLE_WRITING_ACCEPTANCE_EVIDENCE_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `writing-provider-migration-${scenario}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  }
  await pool.end();
});

describe(`provider migration on the ${scenario} schema`, () => {
  it("before it, a Claude run is refused by the database and reported not ready; nothing is written", async () => {
    expect(await store.providerStorageReady("openai")).toBe(true);
    expect(await store.providerStorageReady("anthropic")).toBe(false);
    const runs = await count("SELECT count(*)::int AS n FROM title_writing_run");
    const projectId = await one("INSERT INTO project (workspace_id, title) VALUES ($1, $2) RETURNING id", [workspaceId, "迁移前的 Claude"]);
    await expect(store.createRun(titleRun(workspaceId, projectId, "anthropic", "claude-opus-5-5"), { maxActiveRuns: 10 })).rejects.toThrow();
    expect(await count("SELECT count(*)::int AS n FROM title_writing_run")).toBe(runs);
    evidence.checksBefore = await providerChecks();
  });

  it("a failure inside the migration rolls everything back and records nothing", async () => {
    // A second CHECK of the same definition makes the migration refuse after it already dropped the run table's CHECK.
    await pool.query("ALTER TABLE title_writing_call ADD CONSTRAINT acceptance_duplicate_provider_check CHECK (provider_key IN ('qwen', 'openai', 'deepseek'))");
    await expect(runMigrations(pool, undefined, { only })).rejects.toThrow("expected exactly one provider_key CHECK on title_writing_call");
    expect(await ledgerNames()).toEqual(evidence.startingLedger);
    expect(await providerChecks()).toContain("title_writing_run: CHECK ((provider_key = ANY (ARRAY['qwen'::text, 'openai'::text, 'deepseek'::text])))");
    expect(await store.providerStorageReady("anthropic")).toBe(false);
    await pool.query("ALTER TABLE title_writing_call DROP CONSTRAINT acceptance_duplicate_provider_check");
    evidence.rollback = "refused and rolled back";
  });

  it("the guarded command applies the provider migration alone; the breakdown is not applied or enabled by it", async () => {
    applied = await runMigrations(pool, undefined, { only });
    expect(applied.applied).toEqual([WRITING_PROVIDER_MIGRATION]);
    // The independent candidate migration stays pending too: the guarded command applies exactly one migration.
    expect(applied.leftPending).toEqual(scenario === "base" ? [SCRIPT_BREAKDOWN_MIGRATION, WRITING_CANDIDATE_MIGRATION, WRITING_CANDIDATE_DEEPSEEK_MIGRATION]
      : [WRITING_CANDIDATE_MIGRATION, WRITING_CANDIDATE_DEEPSEEK_MIGRATION]);
    const ledger = await ledgerNames();
    expect(ledger).toEqual(scenario === "base" ? [...BASE_MIGRATIONS, WRITING_PROVIDER_MIGRATION]
      : [...BASE_MIGRATIONS, SCRIPT_BREAKDOWN_MIGRATION, WRITING_PROVIDER_MIGRATION]);
    const breakdownColumn = await count(`SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'title_writing_run' AND column_name = 'run_kind'`);
    expect(breakdownColumn).toBe(scenario === "base" ? 0 : 1);
    expect(await store.breakdownStorageReady()).toBe(scenario === "breakdown");
    expect(await providerChecks()).toEqual([
      "title_writing_call: CHECK ((provider_key = ANY (ARRAY['qwen'::text, 'openai'::text, 'deepseek'::text, 'anthropic'::text])))",
      "title_writing_run: CHECK ((provider_key = ANY (ARRAY['qwen'::text, 'openai'::text, 'deepseek'::text, 'anthropic'::text])))",
    ]);
    evidence.applied = applied;
    evidence.ledgerAfter = ledger;
  });

  it("history is exactly as it was: providers, models, hashes, call identities and unknown cost", async () => {
    expect(await history()).toBe(historyBefore);
    const rows = (await pool.query<{ provider_key: string; billing_status: string; state: string }>(
      "SELECT provider_key, billing_status, state FROM title_writing_call ORDER BY provider_key")).rows;
    expect(rows).toEqual([
      { provider_key: "deepseek", billing_status: "unknown", state: "unknown" },
      { provider_key: "openai", billing_status: "unknown", state: "unknown" },
      { provider_key: "qwen", billing_status: "unknown", state: "unknown" },
    ]);
  });

  it("after it, a Claude run and call are stored; any other provider value is still refused", async () => {
    expect(await store.providerStorageReady("anthropic")).toBe(true);
    // DeepSeek title runs need no migration: both CHECKs have named deepseek since the first title writing migration.
    expect(await store.providerStorageReady("deepseek")).toBe(true);
    const projectId = await one("INSERT INTO project (workspace_id, title) VALUES ($1, $2) RETURNING id", [workspaceId, "迁移后的 Claude"]);
    const run = titleRun(workspaceId, projectId, "anthropic", "claude-opus-5-5");
    expect((await store.createRun(run, { maxActiveRuns: 10 })).kind).toBe("created");
    const lease = new Date(Date.now() + 60_000).toISOString();
    expect(await store.claimRun(workspaceId, run.id, "claude-executor", now(), lease)).toBe(true);
    const reserved = await store.reserveCall({ id: randomUUID(), runId: run.id, workspaceId, stepKey: "concept", attemptNo: 1, providerKey: "anthropic",
      model: "claude-opus-5-5", requestHash: "ef".repeat(32), state: "reserved", executorId: "claude-executor", providerRequestId: null, responseModel: null,
      usage: { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null }, errorCode: null, createdAt: now(), finishedAt: null },
    { sinceIso: "2000-01-01T00:00:00Z", maxCallsPerDay: 100 }, now(), lease);
    expect(reserved.kind).toBe("reserved");
    const read = (await store.getRun(workspaceId, projectId, run.id))!;
    expect(read.run.input.providerKey).toBe("anthropic");
    expect(read.calls.map((call) => call.providerKey)).toEqual(["anthropic"]);
    const other = await one("INSERT INTO project (workspace_id, title) VALUES ($1, $2) RETURNING id", [workspaceId, "未知供应商"]);
    await expect(store.createRun(titleRun(workspaceId, other, "gemini" as TitleWritingStoredProviderKey, "x"), { maxActiveRuns: 10 })).rejects.toThrow();
  });

  it("running it again changes nothing", async () => {
    const again = await runMigrations(pool, undefined, { only });
    expect(again).toEqual({ applied: [], alreadyApplied: [WRITING_PROVIDER_MIGRATION], leftPending: applied.leftPending });
    evidence.secondRun = again;
  });

  it("a later default migrate takes the remaining migrations without repeating this one, and Claude runs stay readable", async () => {
    const later = await runMigrations(pool);
    expect(later.applied).toEqual(scenario === "base" ? [SCRIPT_BREAKDOWN_MIGRATION, WRITING_CANDIDATE_MIGRATION, WRITING_CANDIDATE_DEEPSEEK_MIGRATION]
      : [WRITING_CANDIDATE_MIGRATION, WRITING_CANDIDATE_DEEPSEEK_MIGRATION]);
    expect(later.alreadyApplied).toContain(WRITING_PROVIDER_MIGRATION);
    expect(await store.breakdownStorageReady()).toBe(true);
    expect(await store.providerStorageReady("anthropic")).toBe(true);
    expect(await count("SELECT count(*)::int AS n FROM title_writing_run WHERE provider_key = 'anthropic'")).toBe(1);
    evidence.laterDefaultRun = later;
  });
});
