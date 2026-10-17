/**
 * Isolated PostgreSQL acceptance of AI automatic creation: its guarded migration (20261019000100_auto_creation), the
 * PostgreSQL store, the API service and the engine on real tables. Runs only against a new, empty, disposable database a
 * person named on purpose (title writing acceptance guard). NOT part of `test` or `integration`:
 *   pnpm --filter @ai-drama/api auto-creation:acceptance
 * AUTO_CREATION_ACCEPTANCE_SCENARIO picks the starting schema: "testsite" (default: the base seven plus the guarded Claude,
 * candidate and DeepSeek candidate migrations, script breakdown NOT applied), "base" (the base seven) or "breakdown" (the
 * base seven plus the script breakdown). The model is the automatic creation double: no network, no paid call.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  autoCreationNormalCalls,
  autoCreationWorstCalls,
  type AutoCreationRunView,
  type TitleRunRecord,
} from "@ai-drama/contracts";
import {
  AUTO_CREATION_MIGRATION,
  BASE_MIGRATIONS,
  GUARDED_SINGLE_MIGRATIONS,
  PostgresAutoCreationStore,
  PostgresTitleWritingStore,
  RuntimeStore,
  SCRIPT_BREAKDOWN_MIGRATION,
  TextChainService,
  WRITING_CANDIDATE_DEEPSEEK_MIGRATION,
  WRITING_CANDIDATE_MIGRATION,
  WRITING_PROVIDER_MIGRATION,
  checkTitleWritingAcceptanceEnv,
  closePostgresPool,
  createPostgresPool,
  runMigrations,
  verifyTitleWritingAcceptanceDatabase,
} from "@ai-drama/database";
import { AutoCreationEngine, titleWritingProviderConfigs } from "@ai-drama/providers";
import { autoFixtureTransport, type AutoFixtureExchange, type AutoFixturePlan } from "@ai-drama/providers/title-writing-fixtures";
import { AutoCreationService } from "./auto-creation.service";

const decision = checkTitleWritingAcceptanceEnv(process.env);
if (!decision.ok) throw new Error(`Auto creation acceptance refused: ${decision.reason}`);
const scenario = process.env.AUTO_CREATION_ACCEPTANCE_SCENARIO === "base" ? "base"
  : process.env.AUTO_CREATION_ACCEPTANCE_SCENARIO === "breakdown" ? "breakdown" : "testsite";

const pool = createPostgresPool({ connectionString: decision.url, connectionTimeoutMs: 2_000, statementTimeoutMs: 10_000, queryTimeoutMs: 10_000 });
async function q<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> {
  return (await pool.query(sql, values) as { rows: T[] }).rows;
}
const textChain = new TextChainService(pool);
const store = new PostgresAutoCreationStore(pool, textChain);
const titles = new PostgresTitleWritingStore(pool, textChain);
const runtime = new RuntimeStore(pool);
const TOKEN = "operator-token-0123456789-acceptance";
const providers = titleWritingProviderConfigs({ DEEPSEEK_API_KEY: `stub-deepseek-not-a-key-${randomUUID()}` });
const evidence: Record<string, unknown> = { scenario, paidCalls: 0 };
let workspaceId = "";
let poolClosed = false;
let plan: AutoFixturePlan = {};
let failNext: string | null = null;
const seen: AutoFixtureExchange[] = [];

const transport = autoFixtureTransport({ seen, plan: new Proxy({}, { get: (_target, key) => (plan as Record<string | symbol, unknown>)[key] }) as AutoFixturePlan,
  override: (stage) => {
    if (failNext && stage === failNext) {
      failNext = null;
      return "throw";
    }
    return undefined;
  } });

function service(options: { maxCallsPerDay?: number; maxActiveRuns?: number; hold?: Array<() => Promise<void>> } = {}) {
  const maxCallsPerDay = options.maxCallsPerDay ?? 500;
  const engine = new AutoCreationEngine({ workspaceId, store, providers, transport, maxCallsPerDay, timeoutMs: 30_000 });
  const pending = options.hold ?? [];
  const svc = new AutoCreationService({
    workspaceId, enabled: true, operatorToken: TOKEN, defaultProvider: "deepseek", providers, store, engine, projects: runtime,
    maxCallsPerDay, maxActiveRuns: options.maxActiveRuns ?? 5, research: { fetchEnabled: false, allowedHosts: [] },
    schedule: (work) => { pending.push(work); },
  });
  const settle = async () => { while (pending.length > 0) await pending.shift()!(); };
  return { svc, engine, settle, pending };
}

async function project(episodeCount: number, title = `自动创作验收 ${randomUUID().slice(0, 6)}`): Promise<string> {
  return (await q<{ id: string }>("INSERT INTO project (workspace_id, title, episode_count, target_episode_seconds) VALUES ($1, $2, $3, 60) RETURNING id",
    [workspaceId, title, episodeCount]))[0]!.id;
}

const ctx = (key: string) => ({ actorId: "server-owner", traceId: "acceptance", idempotencyKey: key });
const runOf = (body: unknown) => (body as { run: AutoCreationRunView }).run;
const ledger = async () => (await q<{ name: string }>("SELECT name FROM schema_migration ORDER BY name")).map((row) => row.name);

beforeAll(async () => {
  const verified = await verifyTitleWritingAcceptanceDatabase({ query: async (sql, values) => ({ rows: await q(sql, values) }) }, decision.databaseName);
  if (!verified.ok) {
    poolClosed = true;
    await closePostgresPool(pool);
    throw new Error(`Auto creation acceptance refused: ${verified.reason}`);
  }
  expect((await runMigrations(pool, undefined, { before: SCRIPT_BREAKDOWN_MIGRATION })).applied).toEqual([...BASE_MIGRATIONS]);
  if (scenario === "breakdown") {
    expect((await runMigrations(pool, undefined, { before: WRITING_PROVIDER_MIGRATION })).applied).toEqual([SCRIPT_BREAKDOWN_MIGRATION]);
  }
  if (scenario === "testsite") {
    for (const name of [WRITING_PROVIDER_MIGRATION, WRITING_CANDIDATE_MIGRATION, WRITING_CANDIDATE_DEEPSEEK_MIGRATION]) {
      expect((await runMigrations(pool, undefined, { only: { name, requires: GUARDED_SINGLE_MIGRATIONS[name]! } })).applied).toEqual([name]);
    }
  }
  evidence.startingLedger = await ledger();
  workspaceId = (await q<{ id: string }>("INSERT INTO workspace (name) VALUES ('auto-creation-acceptance') RETURNING id"))[0]!.id;
}, 60_000);

afterAll(async () => {
  evidence.stubSends = seen.length;
  evidence.stubStages = seen.map((item) => item.stage);
  evidence.everyEndpoint = [...new Set(seen.map((item) => item.url))];
  const dir = process.env.TITLE_WRITING_ACCEPTANCE_EVIDENCE_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `auto-creation-${scenario}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  }
  if (!poolClosed) await closePostgresPool(pool);
});

describe(`automatic creation on PostgreSQL (${scenario} schema)`, () => {
  it("before its migration nothing is ready, a start is refused with zero writes and zero sends", async () => {
    expect(await store.storageReady()).toBe(false);
    const { svc } = service();
    const id = await project(1);
    const refused = await svc.start(id, {}, TOKEN, ctx("before"));
    expect(refused.status).toBe(503);
    expect((await q("SELECT to_regclass('auto_creation_run') AS t"))[0]!.t).toBeNull();
    expect(seen).toHaveLength(0);
  });

  it("a failing migration rolls back completely and records nothing", async () => {
    await q("CREATE TABLE auto_creation_resume (blocker int)");
    const only = { name: AUTO_CREATION_MIGRATION, requires: GUARDED_SINGLE_MIGRATIONS[AUTO_CREATION_MIGRATION]! };
    await expect(runMigrations(pool, undefined, { only })).rejects.toThrow();
    expect(await ledger()).not.toContain(AUTO_CREATION_MIGRATION);
    expect((await q("SELECT to_regclass('auto_creation_run') AS t"))[0]!.t).toBeNull();
    await q("DROP TABLE auto_creation_resume");
  });

  it("the guarded command applies only this migration; the breakdown stays as it was; a rerun applies nothing", async () => {
    const titleBefore = JSON.stringify(await q("SELECT * FROM title_writing_run ORDER BY id"));
    const only = { name: AUTO_CREATION_MIGRATION, requires: GUARDED_SINGLE_MIGRATIONS[AUTO_CREATION_MIGRATION]! };
    const applied = await runMigrations(pool, undefined, { only });
    expect(applied.applied).toEqual([AUTO_CREATION_MIGRATION]);
    const expectedPending = scenario === "testsite" ? [SCRIPT_BREAKDOWN_MIGRATION]
      : scenario === "base" ? [SCRIPT_BREAKDOWN_MIGRATION, WRITING_PROVIDER_MIGRATION, WRITING_CANDIDATE_MIGRATION, WRITING_CANDIDATE_DEEPSEEK_MIGRATION]
        : [WRITING_PROVIDER_MIGRATION, WRITING_CANDIDATE_MIGRATION, WRITING_CANDIDATE_DEEPSEEK_MIGRATION];
    expect(applied.leftPending).toEqual(expectedPending);
    expect(await runMigrations(pool, undefined, { only })).toEqual({ applied: [], alreadyApplied: [AUTO_CREATION_MIGRATION], leftPending: expectedPending });
    expect((await ledger()).includes(SCRIPT_BREAKDOWN_MIGRATION)).toBe(scenario === "breakdown");
    expect(JSON.stringify(await q("SELECT * FROM title_writing_run ORDER BY id"))).toBe(titleBefore);
    expect(await store.storageReady()).toBe(true);
    // The stage key CHECK refuses anything outside the stage grammar.
    await expect(q("INSERT INTO auto_creation_stage (run_id, workspace_id, stage_key, ordinal, state, updated_at) VALUES ($1, $2, 'breakdown', 0, 'pending', now())",
      [randomUUID(), workspaceId])).rejects.toThrow();
    evidence.migration = { applied, ledger: await ledger() };
  });

  it("an empty idea completes one sixty-second episode, saves a machine DRAFT, and a replay writes and sends nothing", async () => {
    plan = {};
    const { svc, settle } = service();
    const id = await project(1);
    const before = seen.length;
    const started = await svc.start(id, {}, TOKEN, ctx("one"));
    expect(started.status).toBe(201);
    await settle();
    const run = runOf((await svc.get(id, runOf(started.body).runId)).body);
    expect(run).toMatchObject({ state: "completed", quality: "passed", providerKey: "deepseek", model: "deepseek-flash", callsUsed: autoCreationNormalCalls(1) });
    expect(seen.length - before).toBe(autoCreationNormalCalls(1));
    expect(seen.slice(before).every((item) => item.url === "https://api.deepseek.com/chat/completions")).toBe(true);
    const stories = await q<{ review_status: string; created_by: string; text: string }>(
      "SELECT review_status, created_by, content_json->>'text' AS text FROM story_revision WHERE project_id = $1", [id]);
    expect(stories).toHaveLength(1);
    expect(stories[0]).toMatchObject({ review_status: "DRAFT", created_by: `auto-creation:${run.runId}` });
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM auto_creation_call WHERE run_id = $1 AND billing_status = 'unknown'", [run.runId]))[0]!.n)
      .toBe(autoCreationNormalCalls(1));
    const replay = await svc.start(id, {}, TOKEN, ctx("one"));
    expect(replay.status).toBe(200);
    await settle();
    expect(seen.length - before).toBe(autoCreationNormalCalls(1));
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM auto_creation_run WHERE project_id = $1", [id]))[0]!.n).toBe(1);
    evidence.oneEpisode = { runId: run.runId, calls: run.callsUsed, stages: run.stages.map((stage) => stage.stageKey) };
  });

  it("three episodes with a verified issue: one targeted revision and a second review; six episodes: the maximum completes", async () => {
    plan = { review: { highIssueRounds: [1] } };
    const { svc, settle } = service();
    const three = await project(3);
    const started = await svc.start(three, {}, TOKEN, ctx("three"));
    await settle();
    const run = runOf((await svc.get(three, runOf(started.body).runId)).body);
    expect(run).toMatchObject({ state: "completed", quality: "passed", revisionRoundsUsed: 1, callsUsed: autoCreationNormalCalls(3) + 2 });
    expect(run.currentEpisodes["episode:1"]).toBe("revise:1:episode:1");
    plan = {};
    const six = await project(6);
    const sixStart = await svc.start(six, {}, TOKEN, ctx("six"));
    await settle();
    expect(runOf((await svc.get(six, runOf(sixStart.body).runId)).body)).toMatchObject({ state: "completed", callsUsed: autoCreationNormalCalls(6) });
  });

  it("still failing after two rounds: needs work, the open issue kept, never passed", async () => {
    plan = { review: { highIssueRounds: [1, 2, 3] } };
    const { svc, settle } = service();
    const id = await project(1);
    const started = await svc.start(id, {}, TOKEN, ctx("fail"));
    await settle();
    const run = runOf((await svc.get(id, runOf(started.body).runId)).body);
    expect(run).toMatchObject({ state: "completed", quality: "needs_work", errorCode: "revision_rounds_exhausted", callsUsed: autoCreationWorstCalls(1, 2) });
    expect((await q<{ quality: string }>("SELECT quality FROM auto_creation_run WHERE id = $1", [run.runId]))[0]!.quality).toBe("needs_work");
    plan = {};
  });

  it("the start quota counts every paid text call of the workspace; refused starts create no run", async () => {
    const used = (await q<{ n: number }>("SELECT count(*)::int AS n FROM auto_creation_call WHERE workspace_id = $1", [workspaceId]))[0]!.n;
    const { svc } = service({ maxCallsPerDay: used + 3 });
    const id = await project(1);
    const refused = await svc.start(id, {}, TOKEN, ctx("quota"));
    expect(refused.status).toBe(429);
    expect((refused.body as { error: { details: unknown } }).error.details).toEqual({ requiredCalls: 6, remainingCalls: 3 });
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM auto_creation_run WHERE project_id = $1", [id]))[0]!.n).toBe(0);
  });

  it("title writing and automatic creation share one concurrency cap and never run on the same work", async () => {
    const hold: Array<() => Promise<void>> = [];
    const { svc, settle } = service({ maxActiveRuns: 1, hold });
    const id = await project(1);
    const started = await svc.start(id, {}, TOKEN, ctx("held"));
    expect(started.status).toBe(201);
    const other = await project(1);
    expect((await svc.start(other, {}, TOKEN, ctx("second"))).body).toMatchObject({ error: { code: "AUTO_CREATION_ACTIVE_RUN_CAP" } });
    const at = new Date().toISOString();
    const titleRun = { id: randomUUID(), workspaceId, projectId: other, actorId: "server-owner", idempotencyKey: randomUUID(), inputHash: "ab".repeat(32),
      input: { schema: "ads.title-writing.input.v1", promptVersion: "ads.title-writing.prompt.v1", title: "并发", settings: { episodeCount: 3, episodeSeconds: 90, style: "" },
        providerKey: "openai", model: "o-1" },
      state: "running", errorCode: null, cancelRequestedAt: null, executorId: null, leaseUntil: null, callCap: 8, callsUsed: 0, storySave: "pending",
      storyRevisionId: null, createdAt: at, updatedAt: at } as TitleRunRecord;
    expect(await titles.createRun(titleRun, { maxActiveRuns: 1 })).toEqual({ kind: "blocked", code: "TITLE_WRITING_ACTIVE_RUN_CAP" });
    expect(await titles.createRun({ ...titleRun, projectId: id, id: randomUUID(), idempotencyKey: randomUUID() }, { maxActiveRuns: 5 }))
      .toEqual({ kind: "blocked", code: "TITLE_WRITING_ACTIVE_RUN_CAP" });
    await settle();
    expect(runOf((await svc.get(id, runOf(started.body).runId)).body).state).toBe("completed");
  });

  it("an uncertain call stops the run; maintenance never resends; a confirmed resume sends once and its replay nothing", async () => {
    plan = {};
    failNext = "outline";
    const { svc, settle, engine } = service();
    const id = await project(1);
    const started = await svc.start(id, {}, TOKEN, ctx("unknown"));
    await settle();
    const runId = runOf(started.body).runId;
    let run = runOf((await svc.get(id, runId)).body);
    expect(run).toMatchObject({ state: "needs_attention", errorCode: "disconnected" });
    const outlines = () => seen.filter((item) => item.stage === "outline").length;
    const sentBefore = outlines();
    await engine.maintain();
    expect(outlines()).toBe(sentBefore);
    expect((await svc.resume(id, runId, {}, TOKEN, ctx("r-0"))).body).toMatchObject({ error: { code: "AUTO_CREATION_NEEDS_CONFIRMATION" } });
    const uncertain = run.calls.filter((call) => call.state === "unknown").map((call) => call.callId);
    expect((await svc.resume(id, runId, { confirmUncertainCallIds: uncertain }, TOKEN, ctx("r-1"))).status).toBe(200);
    await settle();
    expect((await svc.resume(id, runId, { confirmUncertainCallIds: uncertain }, TOKEN, ctx("r-1"))).status).toBe(200);
    await settle();
    run = runOf((await svc.get(id, runId)).body);
    expect(run.state).toBe("completed");
    expect(outlines()).toBe(sentBefore + 1);
    expect(run.calls.filter((call) => call.stageKey === "outline").map((call) => call.state)).toEqual(["unknown", "completed"]);
  });

  it("a stopped run is not resumed while a title writing run is active on the same work", async () => {
    plan = {};
    failNext = "research";
    const { svc, settle } = service({ maxActiveRuns: 5 });
    const id = await project(1);
    const started = await svc.start(id, {}, TOKEN, ctx("overlap"));
    await settle();
    const runId = runOf(started.body).runId;
    expect(runOf((await svc.get(id, runId)).body).state).toBe("needs_attention");
    const at = new Date().toISOString();
    const titleRun = { id: randomUUID(), workspaceId, projectId: id, actorId: "server-owner", idempotencyKey: randomUUID(), inputHash: "cd".repeat(32),
      input: { schema: "ads.title-writing.input.v1", promptVersion: "ads.title-writing.prompt.v1", title: "重叠", settings: { episodeCount: 3, episodeSeconds: 90, style: "" },
        providerKey: "openai", model: "o-1" },
      state: "running", errorCode: null, cancelRequestedAt: null, executorId: null, leaseUntil: null, callCap: 8, callsUsed: 0, storySave: "pending",
      storyRevisionId: null, createdAt: at, updatedAt: at } as TitleRunRecord;
    expect((await titles.createRun(titleRun, { maxActiveRuns: 5 })).kind).toBe("created");
    const uncertain = runOf((await svc.get(id, runId)).body).calls.filter((call) => call.state === "unknown").map((call) => call.callId);
    const refused = await svc.resume(id, runId, { confirmUncertainCallIds: uncertain }, TOKEN, ctx("overlap-resume"));
    expect(refused.body).toMatchObject({ error: { code: "AUTO_CREATION_RUN_ACTIVE" } });
    await q("UPDATE title_writing_run SET state = 'canceled' WHERE id = $1", [titleRun.id]);
  });

  it("after a person approves the story, scripts are written once; a person's own script is kept", async () => {
    plan = {};
    const { svc, settle } = service();
    const id = await project(3);
    const started = await svc.start(id, {}, TOKEN, ctx("place"));
    await settle();
    const runId = runOf(started.body).runId;
    expect((await svc.placeScripts(id, runId, {}, ctx("p"))).body).toMatchObject({ error: { code: "AUTO_CREATION_STORY_NOT_APPROVED" } });
    // A person's review, through the text chain's own transitions: DRAFT → IN_REVIEW → APPROVED.
    const readStory = async () => (await q<{ id: string; review_version: number }>("SELECT id, review_version FROM story_revision WHERE project_id = $1", [id]))[0]!;
    const readVersion = async () => (await q<{ version: number }>("SELECT version FROM project WHERE id = $1", [id]))[0]!.version;
    let story = await readStory();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await textChain.transitionReviewInTransaction(client, { table: "story_revision", revisionId: story.id, workspaceId,
        expectedVersion: await readVersion(), expectedReviewVersion: story.review_version, to: "IN_REVIEW", reviewNote: null, traceId: "acceptance" });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    story = await readStory();
    await textChain.approveStory({ workspaceId, projectId: id, revisionId: story.id, expectedVersion: await readVersion(),
      expectedReviewVersion: story.review_version, reviewedBy: "acceptance-person" });
    const episode2 = (await q<{ id: string; row_version: number }>("SELECT id, row_version FROM episode WHERE project_id = $1 AND episode_no = 2", [id]))[0]!;
    await textChain.createScriptRevision({ workspaceId, projectId: id, episodeId: episode2.id, sourceStoryRevisionId: story.id,
      content: { text: "人工写的第二集" }, createdBy: "acceptance-person", expectedVersion: episode2.row_version });
    const placed = runOf((await svc.placeScripts(id, runId, {}, ctx("p"))).body);
    expect(placed.stages.filter((stage) => stage.kind === "episode").map((stage) => stage.scriptSave)).toEqual(["saved", "conflict", "saved"]);
    await svc.placeScripts(id, runId, {}, ctx("p"));
    const scripts = await q<{ episode_no: number; text: string; created_by: string }>(
      `SELECT e.episode_no, s.content_json->>'text' AS text, s.created_by FROM script_revision s JOIN episode e ON e.id = s.episode_id
        WHERE s.project_id = $1 ORDER BY e.episode_no, s.revision_no`, [id]);
    expect(scripts.map((row) => row.episode_no)).toEqual([1, 2, 3]);
    expect(scripts[1]!.text).toBe("人工写的第二集");
    expect((await q<{ review_status: string }>("SELECT review_status FROM script_revision WHERE project_id = $1", [id])).every((row) => row.review_status === "DRAFT")).toBe(true);
  });

  it("the script breakdown stays off and unchanged; no breakdown table appears unless it was already applied", async () => {
    expect((await q("SELECT to_regclass('script_breakdown_scene') AS t"))[0]!.t === null).toBe(scenario !== "breakdown");
    evidence.paidCalls = 0;
    evidence.breakdownApplied = (await ledger()).includes(SCRIPT_BREAKDOWN_MIGRATION);
  });
});
