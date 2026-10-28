/**
 * Isolated acceptance of the online candidate migration (20261016000200_writing_candidate) and its PostgreSQL store. It
 * runs only against a new, empty, disposable database that a person named on purpose (title-writing-acceptance-guard.ts)
 * and is never part of `test` or `integration`. No model is called: the store is driven directly.
 *
 * WRITING_CANDIDATE_ACCEPTANCE_SCENARIO selects the starting schema:
 * - "base" (default): the seven base migrations a business database has today (no breakdown, no provider migration).
 * - "breakdown": the same plus the script breakdown migration.
 * The guarded single-migration command applies the candidate migration alone; nothing else is applied or enabled, and the
 * title writing history is unchanged. The store's rules (key, target, open request, unknown confirmation, the daily cap
 * shared with title writing calls, leases and recovery) are then checked on the real tables. Then the DeepSeek candidate
 * migration (20261017000100_writing_candidate_deepseek) is applied by its own guarded command: it refuses and rolls back
 * on an unexpected CHECK, widens the provider CHECK by deepseek only, keeps every stored request, and leaves the rest
 * pending.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TitleRunRecord, WritingCandidateFrozenInput, WritingCandidateRecord } from "@ai-drama/contracts";
import { AUTO_CREATION_MIGRATION,
  BASE_MIGRATIONS, GUARDED_SINGLE_MIGRATIONS, WRITING_CANDIDATE_DEEPSEEK_MIGRATION, WRITING_CANDIDATE_MIGRATION, WRITING_PROVIDER_MIGRATION,
  SERIES_WRITING_MIGRATION, runMigrations, type MigrationResult,
} from "./migrations";
import { TextChainService } from "./text-chain";
import { checkTitleWritingAcceptanceEnv, verifyTitleWritingAcceptanceDatabase } from "./title-writing-acceptance-guard";
import { PostgresTitleWritingStore, SCRIPT_BREAKDOWN_MIGRATION } from "./title-writing-store";
import { PostgresWritingCandidateStore } from "./writing-candidate-store";

const decision = checkTitleWritingAcceptanceEnv(process.env);
if (!decision.ok) throw new Error(`Writing candidate acceptance refused: ${decision.reason}`);
const scenario = process.env.WRITING_CANDIDATE_ACCEPTANCE_SCENARIO === "breakdown" ? "breakdown" : "base";

const pool = new Pool({ connectionString: decision.url, max: 6, application_name: "writing-candidate-acceptance" });
const store = new PostgresWritingCandidateStore(pool);
const titles = new PostgresTitleWritingStore(pool, new TextChainService(pool));
const only = { name: WRITING_CANDIDATE_MIGRATION, requires: BASE_MIGRATIONS };
const DEEPSEEK = WRITING_CANDIDATE_DEEPSEEK_MIGRATION;
const deepseekOnly = { name: DEEPSEEK, requires: GUARDED_SINGLE_MIGRATIONS[DEEPSEEK]! };
/** Identities, counts and outcomes only: never the connection URL, a password, a token or a key. */
const evidence: Record<string, unknown> = { scenario };

async function one(sql: string, values: unknown[]): Promise<string> {
  return (await pool.query<{ id: string }>(sql, values)).rows[0]!.id;
}
async function ledgerNames(): Promise<string[]> {
  return (await pool.query<{ name: string }>("SELECT name FROM schema_migration ORDER BY name")).rows.map((row) => row.name);
}
async function count(sql: string, values: unknown[] = []): Promise<number> {
  return Number((await pool.query<{ n: number }>(sql, values)).rows[0]!.n);
}
async function titleHistory(): Promise<string> {
  const runs = await pool.query("SELECT id, provider_key, model, input_hash, state FROM title_writing_run ORDER BY id");
  return JSON.stringify(runs.rows);
}
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

let workspaceId: string;
let projectId: string;
let sixEpisodeProject: string;
let episodeId: string;
let storyRevisionId: string;
let otherProjectStory: string;
let historyBefore: string;
let applied: MigrationResult;
let keys = 0;

function input(mode: "story" | "episode", patch: Partial<WritingCandidateFrozenInput> = {}): WritingCandidateFrozenInput {
  return {
    schema: "ads.writing-candidate.input.v1", promptVersion: "ads.writing.prompt.v1", projectId, mode,
    episodeId: mode === "episode" ? episodeId : null, episodeNo: mode === "episode" ? 2 : null, providerKey: "anthropic", model: "claude-opus-5-5",
    base: { sourceRevisionId: mode === "story" ? storyRevisionId : null, ifMatch: 1 },
    request: mode === "story"
      ? { premise: "夜班", genre: "", audience: "", characters: "", mustKeep: "", mustNotChange: "", currentText: "故事" }
      : { episodeNo: 2, premise: "夜班", genre: "", audience: "", characters: "", confirmedStory: "故事", currentText: "", revisionRequest: "",
        mustKeep: "", mustKeepDialogue: "", mustKeepEnding: "" },
    ...patch,
  };
}

function record(frozen: WritingCandidateFrozenInput, options: { key?: string; executorId?: string; leaseMs?: number; confirmed?: string | null } = {}): WritingCandidateRecord {
  const now = new Date();
  keys += 1;
  return {
    id: randomUUID(), workspaceId, projectId: frozen.projectId, actorId: "server-owner", idempotencyKey: options.key ?? `key-${String(keys)}`,
    requestHash: sha(JSON.stringify(frozen)), input: frozen, state: "reserved", executorId: options.executorId ?? "exec-a",
    leaseUntil: new Date(now.getTime() + (options.leaseMs ?? 240_000)).toISOString(), errorCode: null, providerRequestId: null, responseModel: null,
    usage: { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null }, candidate: null,
    confirmedRequestId: options.confirmed ?? null, createdAt: now.toISOString(), finishedAt: null,
  };
}
const LIMITS = { sinceIso: "2000-01-01T00:00:00Z", maxCallsPerDay: 1_000 };

beforeAll(async () => {
  const verified = await verifyTitleWritingAcceptanceDatabase(pool, decision.databaseName);
  if (!verified.ok) {
    await pool.end();
    throw new Error(`Writing candidate acceptance refused: ${verified.reason}`);
  }
  expect((await runMigrations(pool, undefined, { before: SCRIPT_BREAKDOWN_MIGRATION })).applied).toEqual([...BASE_MIGRATIONS]);
  if (scenario === "breakdown") {
    expect((await runMigrations(pool, undefined, { before: WRITING_PROVIDER_MIGRATION })).applied).toEqual([SCRIPT_BREAKDOWN_MIGRATION]);
  }
  evidence.startingLedger = await ledgerNames();
  workspaceId = await one("INSERT INTO workspace (name) VALUES ($1) RETURNING id", ["writing-candidate"]);
  projectId = await one("INSERT INTO project (workspace_id, title) VALUES ($1, $2) RETURNING id", [workspaceId, "夜班"]);
  sixEpisodeProject = await one("INSERT INTO project (workspace_id, title, episode_count, target_episode_seconds) VALUES ($1, $2, 6, 60) RETURNING id",
    [workspaceId, "六集"]);
  const other = await one("INSERT INTO project (workspace_id, title) VALUES ($1, $2) RETURNING id", [workspaceId, "另一部"]);
  storyRevisionId = await one(`INSERT INTO story_revision (workspace_id, project_id, revision_no, content_json, content_hash, created_by)
    VALUES ($1, $2, 1, '{"text":"故事"}', $3, 'acceptance') RETURNING id`, [workspaceId, projectId, sha("story")]);
  otherProjectStory = await one(`INSERT INTO story_revision (workspace_id, project_id, revision_no, content_json, content_hash, created_by)
    VALUES ($1, $2, 1, '{"text":"别的故事"}', $3, 'acceptance') RETURNING id`, [workspaceId, other, sha("other")]);
  for (const episodeNo of [1, 2, 3]) {
    const id = await one("INSERT INTO episode (workspace_id, project_id, episode_no, title) VALUES ($1, $2, $3, $4) RETURNING id",
      [workspaceId, projectId, episodeNo, `第 ${String(episodeNo)} 集`]);
    if (episodeNo === 2) episodeId = id;
  }
  // A title writing run of the base schema, so its history can be compared after the migration.
  const at = new Date().toISOString();
  const run = { id: randomUUID(), workspaceId, projectId: other, actorId: "server-owner", idempotencyKey: randomUUID(), inputHash: "ab".repeat(32),
    input: { schema: "ads.title-writing.input.v1", promptVersion: "ads.title-writing.prompt.v1", title: "历史", settings: { episodeCount: 3, episodeSeconds: 90, style: "" },
      providerKey: "openai", model: "gpt-6-luna" },
    state: "running", errorCode: null, cancelRequestedAt: null, executorId: null, leaseUntil: null, callCap: 8, callsUsed: 0, storySave: "pending",
    storyRevisionId: null, createdAt: at, updatedAt: at } as TitleRunRecord;
  expect((await titles.createRun(run, { maxActiveRuns: 10 })).kind).toBe("created");
  historyBefore = await titleHistory();
});

afterAll(async () => {
  const dir = process.env.TITLE_WRITING_ACCEPTANCE_EVIDENCE_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `writing-candidate-${scenario}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  }
  await pool.end();
});

describe(`online candidate migration and store on the ${scenario} schema`, () => {
  it("before it, the store reports not ready and nothing can be written", async () => {
    expect(await store.storageReady()).toBe(false);
    expect(await count("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'writing_candidate_request'")).toBe(0);
  });

  it("a failure inside the migration rolls everything back and records nothing", async () => {
    await pool.query("CREATE TABLE writing_candidate_request (id uuid)");
    await expect(runMigrations(pool, undefined, { only })).rejects.toThrow();
    expect(await ledgerNames()).toEqual(evidence.startingLedger);
    await pool.query("DROP TABLE writing_candidate_request");
    evidence.rollback = "refused and rolled back";
  });

  it("the guarded command applies it alone; the breakdown and the provider migration are not applied or enabled by it", async () => {
    applied = await runMigrations(pool, undefined, { only });
    expect(applied.applied).toEqual([WRITING_CANDIDATE_MIGRATION]);
    expect(applied.leftPending).toEqual(scenario === "base" ? [SCRIPT_BREAKDOWN_MIGRATION, WRITING_PROVIDER_MIGRATION, DEEPSEEK, AUTO_CREATION_MIGRATION, SERIES_WRITING_MIGRATION]
      : [WRITING_PROVIDER_MIGRATION, DEEPSEEK, AUTO_CREATION_MIGRATION, SERIES_WRITING_MIGRATION]);
    expect(await ledgerNames()).toEqual([...(evidence.startingLedger as string[]), WRITING_CANDIDATE_MIGRATION].sort());
    expect(await titles.breakdownStorageReady()).toBe(scenario === "breakdown");
    expect(await titles.providerStorageReady("anthropic")).toBe(false);
    expect(await store.storageReady()).toBe(true);
    expect(await titleHistory()).toBe(historyBefore);
    evidence.applied = applied;
  });

  it("stores a request once per key; the same key with another input is a conflict", async () => {
    const first = record(input("story"), { key: "same-key" });
    const created = await store.create(first, LIMITS);
    expect(created).toMatchObject({ kind: "created", record: { id: first.id, state: "reserved", executorId: "exec-a" } });
    expect(await store.create({ ...record(input("story"), { key: "same-key" }), requestHash: first.requestHash }, LIMITS))
      .toMatchObject({ kind: "existing", record: { id: first.id } });
    expect(await store.create(record(input("story", { model: "claude-sonnet-5-5" }), { key: "same-key" }), LIMITS)).toEqual({ kind: "conflict" });
    expect(await store.findByKey(workspaceId, "server-owner", "same-key")).toMatchObject({ id: first.id });
    // One open request per target, enforced by the store and by the unique index.
    expect(await store.create(record(input("story")), LIMITS)).toEqual({ kind: "active", requestId: first.id });
    await expect(pool.query(`INSERT INTO writing_candidate_request (id, workspace_id, project_id, actor_id, idempotency_key, request_hash, input_json,
      mode, if_match, provider_key, model, state, executor_id, lease_until, usage_json, created_at)
      VALUES ($1, $2, $3, 'x', 'raw', $4, '{}', 'story', 1, 'anthropic', 'm', 'reserved', 'e', now(), '{}', now())`,
    [randomUUID(), workspaceId, projectId, "0".repeat(64)])).rejects.toThrow();
    // Finish it: submitted by its executor, then completed with a candidate.
    expect(await store.markSubmitted(workspaceId, first.id, "exec-b", new Date().toISOString(), new Date(Date.now() + 60_000).toISOString())).toBe(false);
    expect(await store.markSubmitted(workspaceId, first.id, "exec-a", new Date().toISOString(), new Date(Date.now() + 60_000).toISOString())).toBe(true);
    const plan = { schema: "ads.writing.story-plan.v1", logline: "替身样例" };
    expect(await store.finish(workspaceId, first.id, "exec-a", { state: "completed", errorCode: null, providerRequestId: "req_1", responseModel: "claude-opus-5-5",
      usage: { status: "present", inputTokens: 1, outputTokens: 2, totalTokens: 3 }, candidate: { mode: "story", plan: plan as never } }, new Date().toISOString())).toBe(true);
    expect(await store.get(workspaceId, projectId, first.id)).toMatchObject({ state: "completed", executorId: null, leaseUntil: null,
      providerRequestId: "req_1", candidate: { mode: "story", plan } });
    // Late or second finishes change nothing.
    expect(await store.finish(workspaceId, first.id, "exec-a", { state: "unknown", errorCode: "timeout", providerRequestId: null, responseModel: null,
      usage: { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null }, candidate: null }, new Date().toISOString())).toBe(false);
    evidence.storyRequest = "created, replayed by key, conflict on another input, one open per target, completed once";
  });

  it("checks the target and its base revision in the same transaction", async () => {
    expect(await store.create(record(input("episode", { episodeNo: 3, request: { ...input("episode").request, episodeNo: 3 } as never })), LIMITS))
      .toEqual({ kind: "target_invalid", reason: "episode" });
    expect(await store.create(record(input("episode", { episodeId: randomUUID() })), LIMITS)).toEqual({ kind: "target_invalid", reason: "episode" });
    expect(await store.create(record(input("story", { base: { sourceRevisionId: otherProjectStory, ifMatch: 1 } })), LIMITS))
      .toEqual({ kind: "target_invalid", reason: "base_revision" });
    expect(await store.create(record(input("story", { projectId: sixEpisodeProject, base: { sourceRevisionId: null, ifMatch: 1 } })), LIMITS))
      .toEqual({ kind: "target_invalid", reason: "episode_plan" });
  });

  it("an unknown result must be confirmed, recovery never resends, and the daily cap is shared with title writing calls", async () => {
    const lost = record(input("episode"), { leaseMs: 1 });
    expect((await store.create(lost, LIMITS)).kind).toBe("created");
    // The executor reserved it, then died: its lease expires. Before sending, recovery closes it as never sent.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await store.markSubmitted(workspaceId, lost.id, "exec-a", new Date().toISOString(), new Date(Date.now() + 60_000).toISOString())).toBe(false);
    expect(await store.recoverExpired(workspaceId, new Date().toISOString())).toBe(1);
    expect(await store.getById(workspaceId, lost.id)).toMatchObject({ state: "rejected", errorCode: "executor_lost_before_send" });
    const sent = record(input("episode"));
    expect((await store.create(sent, LIMITS)).kind).toBe("created");
    expect(await store.markSubmitted(workspaceId, sent.id, "exec-a", new Date().toISOString(), new Date(Date.now() - 1).toISOString())).toBe(true);
    expect(await store.recoverExpired(workspaceId, new Date().toISOString())).toBe(1);
    expect(await store.getById(workspaceId, sent.id)).toMatchObject({ state: "unknown", errorCode: "executor_lost" });
    expect(await count("SELECT count(*)::int AS n FROM writing_candidate_request WHERE id = $1 AND billing_status = 'unknown'", [sent.id])).toBe(1);
    expect(await store.create(record(input("episode")), LIMITS)).toEqual({ kind: "needs_confirmation", requestId: sent.id });
    const used = await count("SELECT count(*)::int AS n FROM writing_candidate_request WHERE workspace_id = $1", [workspaceId]);
    // The title writing call table, when it exists, counts toward the same cap.
    expect(await store.create(record(input("episode"), { confirmed: sent.id }), { sinceIso: "2000-01-01T00:00:00Z", maxCallsPerDay: used }))
      .toEqual({ kind: "blocked", code: "WRITING_CANDIDATE_DAILY_CAP" });
    const confirmed = record(input("episode"), { confirmed: sent.id });
    expect(await store.create(confirmed, LIMITS)).toMatchObject({ kind: "created", record: { confirmedRequestId: sent.id } });
    expect((await store.listForTarget(workspaceId, projectId, { mode: "episode", episodeId }, 10)).map((item) => item.id).slice(0, 3))
      .toEqual([confirmed.id, sent.id, lost.id]);
    evidence.recovery = { neverSent: "rejected/executor_lost_before_send", maybeSent: "unknown/executor_lost", newRequestNeedsConfirmation: true };
  });

  it("refuses a retired provider and a non-unknown cost at the database", async () => {
    await expect(store.create(record(input("story", { providerKey: "qwen" as never, base: { sourceRevisionId: null, ifMatch: 1 } })), LIMITS)).rejects.toThrow();
    await expect(pool.query("UPDATE writing_candidate_request SET billing_status = 'paid' WHERE workspace_id = $1", [workspaceId])).rejects.toThrow();
  });

  it("the DeepSeek candidate migration: zero writes on an unexpected CHECK, then only the provider CHECK widens, every row kept", async () => {
    expect(await store.providerStorageReady("deepseek")).toBe(false);
    expect(await store.providerStorageReady("anthropic")).toBe(true);
    const deepseekInput = () => input("story", { providerKey: "deepseek", model: "deepseek-flash" });
    await expect(store.create(record(deepseekInput()), LIMITS)).rejects.toThrow();
    const rowsBefore = JSON.stringify((await pool.query("SELECT * FROM writing_candidate_request ORDER BY id")).rows);
    const ledgerBefore = await ledgerNames();
    const providerChecks = async () => (await pool.query<{ name: string; def: string }>(`SELECT conname AS name, pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE conrelid = 'writing_candidate_request'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%provider_key%'
      ORDER BY conname`)).rows;
    const released = await providerChecks();
    expect(released.map((row) => row.def)).toEqual(["CHECK ((provider_key = ANY (ARRAY['openai'::text, 'anthropic'::text])))"]);
    // A second CHECK on provider_key (a copy, or any other rule on it): the migration stops, rolls back, records nothing.
    for (const extra of ["CHECK (provider_key IN ('openai', 'anthropic'))", "CHECK (provider_key <> 'qwen')"]) {
      await pool.query(`ALTER TABLE writing_candidate_request ADD CONSTRAINT acceptance_extra_provider_check ${extra}`);
      await expect(runMigrations(pool, undefined, { only: deepseekOnly })).rejects.toThrow("expected exactly one provider_key CHECK");
      expect(await ledgerNames()).toEqual(ledgerBefore);
      expect((await providerChecks()).length).toBe(2);
      await pool.query("ALTER TABLE writing_candidate_request DROP CONSTRAINT acceptance_extra_provider_check");
    }
    // A single CHECK that limits provider_key together with another column: dropping it would lose the other limit, so
    // the migration stops instead, and the compound CHECK is still in place afterwards.
    await pool.query(`ALTER TABLE writing_candidate_request DROP CONSTRAINT ${released[0]!.name}`);
    await pool.query(`ALTER TABLE writing_candidate_request ADD CONSTRAINT acceptance_compound_check
      CHECK (provider_key IN ('openai', 'anthropic') AND length(model) <= 128)`);
    await expect(runMigrations(pool, undefined, { only: deepseekOnly })).rejects.toThrow("unexpected provider_key CHECK");
    expect(await ledgerNames()).toEqual(ledgerBefore);
    expect((await providerChecks()).map((row) => row.name)).toEqual(["acceptance_compound_check"]);
    // The released baseline again (its definition, under the generated-style name), which migrates.
    await pool.query("ALTER TABLE writing_candidate_request DROP CONSTRAINT acceptance_compound_check");
    await pool.query(`ALTER TABLE writing_candidate_request ADD CONSTRAINT ${released[0]!.name} CHECK (provider_key IN ('openai', 'anthropic'))`);
    expect(await providerChecks()).toEqual(released);
    const deepseekApplied = await runMigrations(pool, undefined, { only: deepseekOnly });
    expect(deepseekApplied).toEqual({ applied: [DEEPSEEK], alreadyApplied: [],
      leftPending: scenario === "base" ? [SCRIPT_BREAKDOWN_MIGRATION, WRITING_PROVIDER_MIGRATION, AUTO_CREATION_MIGRATION, SERIES_WRITING_MIGRATION]
        : [WRITING_PROVIDER_MIGRATION, AUTO_CREATION_MIGRATION, SERIES_WRITING_MIGRATION] });
    expect(await ledgerNames()).toEqual([...ledgerBefore, DEEPSEEK].sort());
    expect(JSON.stringify((await pool.query("SELECT * FROM writing_candidate_request ORDER BY id")).rows)).toBe(rowsBefore);
    expect(await titleHistory()).toBe(historyBefore);
    expect(await titles.providerStorageReady("anthropic")).toBe(false);
    expect(await titles.breakdownStorageReady()).toBe(scenario === "breakdown");
    const checks = await pool.query<{ def: string }>(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'writing_candidate_request'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%provider_key%'`);
    expect(checks.rows).toHaveLength(1);
    expect(checks.rows[0]!.def).toMatch(/'openai'.*'anthropic'.*'deepseek'/);
    expect(await store.providerStorageReady("deepseek")).toBe(true);
    const stored = record(deepseekInput());
    expect(await store.create(stored, LIMITS)).toMatchObject({ kind: "created", record: { id: stored.id, input: { providerKey: "deepseek", model: "deepseek-flash" } } });
    expect(await store.markSubmitted(workspaceId, stored.id, "exec-a", new Date().toISOString(), new Date(Date.now() + 60_000).toISOString())).toBe(true);
    expect(await store.finish(workspaceId, stored.id, "exec-a", { state: "rejected", errorCode: "quota", providerRequestId: "ds-1", responseModel: null,
      usage: { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null }, candidate: null }, new Date().toISOString())).toBe(true);
    // The retired qwen stays refused at the database; DeepSeek is the only value added.
    await expect(store.create(record(input("story", { providerKey: "qwen" as never })), LIMITS)).rejects.toThrow();
    const again = await runMigrations(pool, undefined, { only: deepseekOnly });
    expect(again).toEqual({ applied: [], alreadyApplied: [DEEPSEEK], leftPending: deepseekApplied.leftPending });
    evidence.deepseek = { refusedOnUnexpectedCheck: true, applied: deepseekApplied, secondRun: again, rowsKept: true };
  });

  it("running it again changes nothing, and a later default migrate takes the rest without repeating it", async () => {
    const pending = applied.leftPending!.filter((name) => name !== DEEPSEEK);
    const again = await runMigrations(pool, undefined, { only });
    expect(again).toEqual({ applied: [], alreadyApplied: [WRITING_CANDIDATE_MIGRATION], leftPending: pending });
    const later = await runMigrations(pool);
    expect(later.applied).toEqual(pending);
    expect(later.alreadyApplied).toContain(WRITING_CANDIDATE_MIGRATION);
    expect(await store.storageReady()).toBe(true);
    expect(await titles.providerStorageReady("anthropic")).toBe(true);
    evidence.secondRun = again;
    evidence.laterDefaultRun = later;
  });
});
