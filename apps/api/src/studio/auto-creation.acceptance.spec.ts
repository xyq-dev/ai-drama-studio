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
  type AutoCreationFrozenInput,
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
import { AutoCreationEngine, hashAutoCreationInput, titleWritingProviderConfigs } from "@ai-drama/providers";
import {
  AUTO_FIXTURE_UNPLACED, autoFixtureTransport, fixtureAutoResearchV1, fixtureAutoResearchV2, type AutoFixtureExchange, type AutoFixturePlan,
} from "@ai-drama/providers/title-writing-fixtures";
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

function service(options: { maxCallsPerDay?: number; maxActiveRuns?: number; hold?: Array<() => Promise<void>>; engineStore?: PostgresAutoCreationStore } = {}) {
  const maxCallsPerDay = options.maxCallsPerDay ?? 500;
  const engine = new AutoCreationEngine({ workspaceId, store: options.engineStore ?? store, providers, transport, maxCallsPerDay, timeoutMs: 30_000 });
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

  it("the failed test-site shape (1 episode, 60 s, no rounds, budget 6, empty idea) completes every stage, saves a DRAFT and exports", async () => {
    plan = {};
    const { svc, settle } = service();
    const id = await project(1);
    const before = seen.length;
    const started = await svc.start(id, { revisionRounds: 0, callBudget: 6 }, TOKEN, ctx("zero-rounds"));
    expect(started.status).toBe(201);
    await settle();
    const run = runOf((await svc.get(id, runOf(started.body).runId)).body);
    expect(run).toMatchObject({ state: "completed", quality: "passed", callsUsed: 6, callCap: 6, revisionRoundsUsed: 0, storySave: "saved", packageStatus: "ready" });
    expect(seen.slice(before).map((item) => item.stage)).toEqual(["research", "directions", "bible", "outline", "episode:1", "review:1"]);
    expect((await q<{ review_status: string }>("SELECT review_status FROM story_revision WHERE project_id = $1", [id]))).toEqual([{ review_status: "DRAFT" }]);
    const markdown = await svc.package(id, run.runId, "markdown");
    expect(markdown.status).toBe(200);
    expect(markdown.download?.text).toContain("资料有限策划模式");
    expect(markdown.download?.text).toContain("AI 自动创作草稿");
    expect((await svc.package(id, run.runId, "json")).status).toBe(200);
    evidence.zeroRounds = { runId: run.runId, calls: run.callsUsed, callCap: run.callCap };
  });

  // v2 is what the deployed baseline (cf1ef29) freezes; v1 came before it. Neither is rehashed under v3.
  it.each(["v1", "v2", "v4"] as const)("a run stored by the %s code: its own key and request replay 200 with nothing written or sent; other content or work is 409", async (version) => {
    plan = {};
    const { svc, settle, pending } = service();
    const id = await project(1);
    const request = { revisionRounds: 0, callBudget: 6 };
    const key = `stored-${version}`;
    const started = await svc.start(id, request, TOKEN, ctx(key));
    await settle();
    const runId = runOf(started.body).runId;
    // The row as that code wrote it: its versions in the frozen input and the hash computed over that input.
    const [row] = await q<{ input_json: AutoCreationFrozenInput }>("SELECT input_json FROM auto_creation_run WHERE id = $1", [runId]);
    const v1 = { ...row!.input_json, promptVersion: `ads.auto-creation.prompt.${version}`, checksVersion: `ads.auto-creation.checks.${version}` } as AutoCreationFrozenInput;
    await q("UPDATE auto_creation_run SET input_json = $2, input_hash = $3 WHERE id = $1", [runId, JSON.stringify(v1), hashAutoCreationInput(id, v1)]);
    const rows = async () => JSON.stringify({
      run: await q("SELECT * FROM auto_creation_run WHERE id = $1", [runId]),
      stages: await q("SELECT * FROM auto_creation_stage WHERE run_id = $1 ORDER BY ordinal", [runId]),
      calls: await q("SELECT * FROM auto_creation_call WHERE run_id = $1 ORDER BY created_at, id", [runId]),
      runs: await q("SELECT id FROM auto_creation_run WHERE project_id = $1", [id]),
      stories: await q("SELECT id FROM story_revision WHERE project_id = $1", [id]),
    });
    const before = await rows();
    const sent = seen.length;
    const replay = await svc.start(id, request, TOKEN, ctx(key));
    expect(replay.status).toBe(200);
    expect(runOf(replay.body).runId).toBe(runId);
    expect(pending).toHaveLength(0);
    for (const changed of [{ ...request, idea: "别的想法" }, { ...request, revisionRounds: 1 }, {}]) {
      const refused = await svc.start(id, changed, TOKEN, ctx(key));
      expect([refused.status, (refused.body as { error?: { code?: string } }).error?.code]).toEqual([409, "IDEMPOTENCY_KEY_REUSED"]);
    }
    // The same key on another work is not this run.
    const elsewhere = await svc.start(await project(1), request, TOKEN, ctx(key));
    expect([elsewhere.status, (elsewhere.body as { error?: { code?: string } }).error?.code]).toEqual([409, "IDEMPOTENCY_KEY_REUSED"]);
    await settle();
    expect(seen.length).toBe(sent);
    expect(await rows()).toBe(before);
    expect((await q<{ input_hash: string }>("SELECT input_hash FROM auto_creation_run WHERE id = $1", [runId]))[0]!.input_hash).toBe(hashAutoCreationInput(id, v1));
    evidence[`${version}Replay`] = { runId, status: replay.status, newCalls: seen.length - sent };
  });

  it("a research answer the checks refuse: one call, nothing after it, the rule and field stored, no answer text kept", async () => {
    plan = { fabricatedNumber: true };
    const { svc, settle } = service();
    const id = await project(1);
    const before = seen.length;
    const started = await svc.start(id, { revisionRounds: 0, callBudget: 6 }, TOKEN, ctx("refused-research"));
    await settle();
    const run = runOf((await svc.get(id, runOf(started.body).runId)).body);
    expect(run).toMatchObject({ state: "failed", errorCode: "unsourced_number", callsUsed: 1 });
    expect(seen.length - before).toBe(1);
    const stages = await q<{ stage_key: string; state: string; error_code: string | null; output_json: unknown }>(
      "SELECT stage_key, state, error_code, output_json FROM auto_creation_stage WHERE run_id = $1 AND stage_key = 'research'", [run.runId]);
    const code = "unsourced_number@hypotheses[0].statement:percent+market_statistic+proportion";
    expect(stages).toEqual([{ stage_key: "research", state: "rejected", error_code: code, output_json: null }]);
    const calls = await q<{ error_code: string }>("SELECT error_code FROM auto_creation_call WHERE run_id = $1", [run.runId]);
    expect(calls).toEqual([{ error_code: code }]);
    // The refused answer is in no table of the run.
    const stored = await q<{ text: string }>(
      `SELECT concat_ws(' ', (SELECT string_agg(row_to_json(s)::text, ' ') FROM auto_creation_stage s WHERE s.run_id = $1),
        (SELECT string_agg(row_to_json(c)::text, ' ') FROM auto_creation_call c WHERE c.run_id = $1),
        (SELECT row_to_json(r)::text FROM auto_creation_run r WHERE r.id = $1)) AS text`, [run.runId]);
    expect(stored[0]!.text).not.toContain("70%");
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM story_revision WHERE project_id = $1", [id]))[0]!.n).toBe(0);
    plan = {};
    evidence.refusedResearch = { runId: run.runId, stageError: stages[0]!.error_code };
  });

  it("checks v3: the test-site shape with story and plan quantities in its research completes, saves a DRAFT, exports and reads back", async () => {
    plan = { creativeQuantities: true };
    const { svc, settle } = service();
    const id = await project(1);
    const before = seen.length;
    const started = await svc.start(id, { revisionRounds: 0, callBudget: 6 }, TOKEN, ctx("creative"));
    expect(started.status).toBe(201);
    await settle();
    const runId = runOf(started.body).runId;
    const run = runOf((await svc.get(id, runId)).body);
    expect(run).toMatchObject({ state: "completed", quality: "passed", callsUsed: 6, callCap: 6, storySave: "saved", packageStatus: "ready", errorCode: null,
      providerKey: "deepseek", model: "deepseek-flash", researchMode: "limited" });
    expect(seen.slice(before).map((item) => item.stage)).toEqual(["research", "directions", "bible", "outline", "episode:1", "review:1"]);
    expect(seen.slice(before)[0]!.user).toContain("提示版本：ads.auto-creation.prompt.v5");
    expect((await q<{ input_json: AutoCreationFrozenInput }>("SELECT input_json FROM auto_creation_run WHERE id = $1", [runId]))[0]!.input_json)
      .toMatchObject({ promptVersion: "ads.auto-creation.prompt.v5", checksVersion: "ads.auto-creation.checks.v5" });
    // The stored research is the accepted answer as sent: its quantities are there word for word.
    const research = (await q<{ output_json: { hypotheses: Array<{ statement: string; howToVerify: string }> } }>(
      "SELECT output_json FROM auto_creation_stage WHERE run_id = $1 AND stage_key = 'research'", [runId]))[0]!.output_json;
    expect(research.hypotheses.map((item) => item.statement).join("")).toContain("两个互不信任的人");
    expect(research.hypotheses.map((item) => item.howToVerify).join("")).toContain("观察七天");
    // Research v2 on: the quoted method has no count; this work's two reversals and three riders are its own design.
    const structure = (await q<{ output_json: { schema: string; contentStructure: unknown[] } }>(
      "SELECT output_json FROM auto_creation_stage WHERE run_id = $1 AND stage_key = 'research'", [runId]))[0]!.output_json;
    expect(structure.schema).toBe("ads.auto-creation.research.v3");
    expect(structure.contentStructure).toEqual([
      { reference: { sourceId: "S-KB-CRAFT", quote: "关键结果来自主角的选择和行动" },
        application: { pattern: "模型替身样例：计划用两次反转推动主角主动选择。", why: "这是本作品的创作设计。" } },
      { reference: null, application: { pattern: "模型替身样例：三名骑手被迫合作，三天内找出真相。", why: "自主创作设计，没有对应的方法资料。" } },
    ]);
    expect((await q<{ review_status: string }>("SELECT review_status FROM story_revision WHERE project_id = $1", [id]))).toEqual([{ review_status: "DRAFT" }]);
    const markdown = (await svc.package(id, runId, "markdown")).download!.text;
    expect(markdown).toContain("  - 参考方法原文：S-KB-CRAFT「关键结果来自主角的选择和行动」");
    expect(markdown).toContain("  - 本剧应用设计：模型替身样例：计划用两次反转推动主角主动选择。：这是本作品的创作设计。");
    expect(markdown).toContain("  - 参考方法原文：无（自主创作设计）");
    expect(markdown).toContain("资料有限：没有可读取的近期市场资料");
    expect(markdown).toContain("验证计划：计划上线后观察七天");
    expect(markdown).toContain("不是平台真实用户画像");
    expect(markdown).not.toMatch(/市场验证(已)?完成|已完成市场验证/u);
    const json = JSON.parse((await svc.package(id, runId, "json")).download!.text) as { research: { analysis: { hypotheses: unknown[]; contentStructure: unknown[] } } };
    expect(json.research.analysis.hypotheses).toHaveLength(2);
    expect(json.research.analysis.contentStructure).toEqual(structure.contentStructure);
    // Read again as a reload would: the same run, nothing sent.
    const sent = seen.length;
    expect(runOf((await svc.latest(id)).body)).toMatchObject({ runId, state: "completed", callsUsed: 6 });
    expect(seen.length).toBe(sent);
    plan = {};
    evidence.creativeQuantities = { runId, calls: run.callsUsed, stages: seen.slice(before).map((item) => item.stage) };
  });

  it("checks v3: a share hidden in a verification plan is refused at research alone, named by field, rule and meaning", async () => {
    plan = { hiddenStatistic: true };
    const { svc, settle } = service();
    const id = await project(1);
    const before = seen.length;
    const started = await svc.start(id, { revisionRounds: 0, callBudget: 6 }, TOKEN, ctx("hidden-statistic"));
    await settle();
    const runId = runOf(started.body).runId;
    expect(runOf((await svc.get(id, runId)).body)).toMatchObject({ state: "failed", errorCode: "unsourced_number", callsUsed: 1 });
    expect(seen.slice(before).map((item) => item.stage)).toEqual(["research"]);
    const code = "unsourced_number@hypotheses[0].howToVerify:percent+market_statistic+proportion";
    expect(await q("SELECT stage_key, state, error_code, output_json FROM auto_creation_stage WHERE run_id = $1 AND state <> 'pending' AND stage_key <> 'sources'", [runId]))
      .toEqual([{ stage_key: "research", state: "rejected", error_code: code, output_json: null }]);
    expect(await q("SELECT error_code FROM auto_creation_call WHERE run_id = $1", [runId])).toEqual([{ error_code: code }]);
    expect(JSON.stringify(await q("SELECT * FROM auto_creation_stage WHERE run_id = $1", [runId]))).not.toContain("六成");
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM story_revision WHERE project_id = $1", [id]))[0]!.n).toBe(0);
    plan = {};
    evidence.hiddenStatistic = { runId, stageError: code };
  });

  it("checks v3: a v2 run refused at research resumes under the current checks; its frozen input and hash stay; a stale confirmation writes nothing", async () => {
    plan = { hiddenStatistic: true };
    const { svc, settle } = service();
    const id = await project(1);
    // Budget 8: the hard cap of one episode with no rounds (6 normal calls + 2 confirmed resends).
    const started = await svc.start(id, { revisionRounds: 0, callBudget: 8 }, TOKEN, ctx("v2-refused"));
    await settle();
    const runId = runOf(started.body).runId;
    const [row] = await q<{ input_json: AutoCreationFrozenInput }>("SELECT input_json FROM auto_creation_run WHERE id = $1", [runId]);
    const v2 = { ...row!.input_json, promptVersion: "ads.auto-creation.prompt.v2", checksVersion: "ads.auto-creation.checks.v2" } as AutoCreationFrozenInput;
    // As the deployed code stored the real refusal: the v2 versions, and the v2 diagnosis on the stage and its call.
    const v2Code = "unsourced_number@hypotheses[0].statement:chinese_numeral";
    await q("UPDATE auto_creation_run SET input_json = $2, input_hash = $3 WHERE id = $1", [runId, JSON.stringify(v2), hashAutoCreationInput(id, v2)]);
    await q("UPDATE auto_creation_stage SET error_code = $2 WHERE run_id = $1 AND stage_key = 'research'", [runId, v2Code]);
    await q("UPDATE auto_creation_call SET error_code = $2 WHERE run_id = $1", [runId, v2Code]);
    const state = async () => JSON.stringify({
      run: await q("SELECT state, error_code, calls_used, updated_at, input_hash FROM auto_creation_run WHERE id = $1", [runId]),
      stages: await q("SELECT stage_key, state, attempt_no, error_code, updated_at FROM auto_creation_stage WHERE run_id = $1 ORDER BY ordinal", [runId]),
      calls: await q("SELECT id, state, error_code FROM auto_creation_call WHERE run_id = $1 ORDER BY created_at, id", [runId]),
      resumes: await q("SELECT idempotency_key FROM auto_creation_resume WHERE run_id = $1", [runId]),
    });
    const before = await state();
    const sent = seen.length;
    // A confirmation of a call that is not uncertain is refused before any write.
    const stale = await svc.resume(id, runId, { confirmUncertainCallIds: [randomUUID()] }, TOKEN, ctx("v2-stale"));
    expect(stale.status).toBeGreaterThanOrEqual(400);
    await settle();
    expect(await state()).toBe(before);
    expect(seen.length).toBe(sent);
    plan = { creativeQuantities: true };
    expect((await svc.resume(id, runId, {}, TOKEN, ctx("v2-resume"))).status).toBe(200);
    await settle();
    expect(seen.slice(sent).map((item) => item.stage)).toEqual(["research", "directions", "bible", "outline", "episode:1", "review:1"]);
    expect(seen.slice(sent)[0]!.user).toContain("提示版本：ads.auto-creation.prompt.v5");
    const run = runOf((await svc.get(id, runId)).body);
    expect(run).toMatchObject({ state: "completed", quality: "passed", callsUsed: 7, callCap: 8, storySave: "saved" });
    expect(run.calls.filter((call) => call.stageKey === "research").map((call) => [call.state, call.errorCode]))
      .toEqual([["rejected", v2Code], ["completed", null]]);
    const after = (await q<{ input_json: AutoCreationFrozenInput; input_hash: string }>("SELECT input_json, input_hash FROM auto_creation_run WHERE id = $1", [runId]))[0]!;
    expect(after.input_json).toMatchObject({ promptVersion: "ads.auto-creation.prompt.v2", checksVersion: "ads.auto-creation.checks.v2" });
    expect(after.input_hash).toBe(hashAutoCreationInput(id, v2));
    // The resume key replays to the run and sends nothing.
    expect((await svc.resume(id, runId, {}, TOKEN, ctx("v2-resume"))).status).toBe(200);
    await settle();
    expect(seen.length).toBe(sent + 6);
    plan = {};
    evidence.v2RefusedResume = { runId, calls: run.callsUsed };
  });

  it.each([
    ["forgedQuote", "evidence_not_in_source@contentStructure[0].reference.quote", "反转次数以两次为最佳"],
    ["structureStatistic", "unsourced_number@contentStructure[0].application.pattern:percent+market_statistic+proportion", "约三成"],
  ] as const)("research v2: a %s structure is refused at research alone; nothing dropped, nothing stored, nothing after it sent", async (flag, code, text) => {
    plan = { [flag]: true };
    const { svc, settle } = service();
    const id = await project(1);
    const before = seen.length;
    const started = await svc.start(id, { revisionRounds: 0, callBudget: 6 }, TOKEN, ctx(`structure-${flag}`));
    await settle();
    const runId = runOf(started.body).runId;
    expect(runOf((await svc.get(id, runId)).body)).toMatchObject({ state: "failed", callsUsed: 1 });
    expect(seen.slice(before).map((item) => item.stage)).toEqual(["research"]);
    expect(await q("SELECT stage_key, state, error_code, output_json FROM auto_creation_stage WHERE run_id = $1 AND state <> 'pending' AND stage_key <> 'sources'", [runId]))
      .toEqual([{ stage_key: "research", state: "rejected", error_code: code, output_json: null }]);
    expect(await q("SELECT error_code FROM auto_creation_call WHERE run_id = $1", [runId])).toEqual([{ error_code: code }]);
    expect(JSON.stringify(await q("SELECT * FROM auto_creation_stage WHERE run_id = $1", [runId]))).not.toContain(text);
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM story_revision WHERE project_id = $1", [id]))[0]!.n).toBe(0);
    plan = {};
    (evidence.structureRefused ??= {} as Record<string, unknown>);
    (evidence.structureRefused as Record<string, unknown>)[flag] = { runId, stageError: code };
  });

  it.each([
    ["v1", "v3", fixtureAutoResearchV1()],
    ["v2", "v4", fixtureAutoResearchV2()],
  ] as const)("research %s history: a completed run of prompt %s reads, exports and replays unchanged; nothing is rewritten or sent", async (shape, version, stored) => {
    plan = {};
    const { svc, settle, pending } = service();
    const id = await project(1);
    const request = { revisionRounds: 0, callBudget: 6 };
    const started = await svc.start(id, request, TOKEN, ctx(`${shape}-research-history`));
    await settle();
    const runId = runOf(started.body).runId;
    // As that code stored it: its versions and hash, and research in its own shape.
    const [row] = await q<{ input_json: AutoCreationFrozenInput }>("SELECT input_json FROM auto_creation_run WHERE id = $1", [runId]);
    const old = { ...row!.input_json, promptVersion: `ads.auto-creation.prompt.${version}`, checksVersion: `ads.auto-creation.checks.${version}` } as AutoCreationFrozenInput;
    await q("UPDATE auto_creation_run SET input_json = $2, input_hash = $3 WHERE id = $1", [runId, JSON.stringify(old), hashAutoCreationInput(id, old)]);
    await q("UPDATE auto_creation_stage SET output_json = $2 WHERE run_id = $1 AND stage_key = 'research'", [runId, JSON.stringify(stored)]);
    const rows = async () => JSON.stringify({
      run: await q("SELECT * FROM auto_creation_run WHERE id = $1", [runId]),
      stages: await q("SELECT * FROM auto_creation_stage WHERE run_id = $1 ORDER BY ordinal", [runId]),
      calls: await q("SELECT * FROM auto_creation_call WHERE run_id = $1 ORDER BY created_at, id", [runId]),
      stories: await q("SELECT id FROM story_revision WHERE project_id = $1", [id]),
    });
    const before = await rows();
    const sent = seen.length;
    const view = runOf((await svc.get(id, runId)).body);
    expect(view.stages.find((stage) => stage.stageKey === "research")!.output).toEqual(stored);
    const markdown = (await svc.package(id, runId, "markdown")).download!.text;
    if (shape === "v1") {
      expect(markdown).toContain("- 结构 1（历史版本，未区分参考原文与本剧应用）：主角主动选择推动结果：知识库要求关键结果来自主角的行动。（S-KB-CRAFT）");
      expect(markdown).not.toContain("参考方法原文：");
    } else {
      expect(markdown).toContain("  - 参考方法原文：S-KB-CRAFT「关键结果来自主角的选择和行动」");
    }
    // The model's own limits and constraints of that version, shown as history; no server record is made up for it.
    expect(markdown).toContain("**局限**（AI 填写，历史版本）：官方入口页面没有读到正文，受众判断都是假设。");
    expect(markdown).toContain("**采用的约束**（AI 复述，历史版本）：单集、约一分钟");
    expect(markdown).not.toContain("**用户设定与资料记录**");
    const json = JSON.parse((await svc.package(id, runId, "json")).download!.text) as { research: { analysis: unknown } };
    expect(json.research.analysis).toEqual(stored);
    const replay = await svc.start(id, request, TOKEN, ctx(`${shape}-research-history`));
    expect([replay.status, runOf(replay.body).runId]).toEqual([200, runId]);
    expect(pending).toHaveLength(0);
    await settle();
    expect(seen.length).toBe(sent);
    expect(await rows()).toBe(before);
    evidence[`${shape}ResearchHistory`] = { runId, replay: replay.status, newCalls: seen.length - sent };
  });

  it("checks v5: numbers the checks cannot place stay with unverified notices; 1 episode, 60 s, 0 rounds, budget 6 completes, exports and reads back", async () => {
    plan = { unplacedQuantities: true };
    const { svc, settle } = service();
    const id = await project(1);
    const before = seen.length;
    const started = await svc.start(id, { revisionRounds: 0, callBudget: 6, constraints: { maxCharacters: 3 } }, TOKEN, ctx("unplaced"));
    expect(started.status).toBe(201);
    await settle();
    const runId = runOf(started.body).runId;
    const run = runOf((await svc.get(id, runId)).body);
    expect(run).toMatchObject({ state: "completed", quality: "passed", callsUsed: 6, callCap: 6, storySave: "saved", packageStatus: "ready", errorCode: null,
      researchMode: "limited" });
    expect(seen.slice(before).map((item) => item.stage)).toEqual(["research", "directions", "bible", "outline", "episode:1", "review:1"]);
    const outputs = Object.fromEntries((await q<{ stage_key: string; output_json: Record<string, unknown> }>(
      "SELECT stage_key, output_json FROM auto_creation_stage WHERE run_id = $1 AND stage_key IN ('research', 'directions')", [runId]))
      .map((row) => [row.stage_key, row.output_json]));
    const research = outputs.research as { schema: string; opportunities: string[]; unverified: Array<{ field: string; token: string }>; serverRecord: Record<string, unknown> };
    expect(research.schema).toBe("ads.auto-creation.research.v3");
    expect(research.opportunities).toContain(AUTO_FIXTURE_UNPLACED.money);
    expect(research.unverified.map((item) => [item.field, item.token])).toEqual([["contentStructure[2].application.pattern", "三块"], ["opportunities[1]", "五十元"]]);
    expect(research).not.toHaveProperty("appliedConstraints");
    expect(research.serverRecord).toMatchObject({ origin: "server_record", settings: { origin: "user_setting" }, material: { origin: "source_snapshot", researchMode: "limited" },
      executedWith: { promptVersion: "ads.auto-creation.prompt.v5", checksVersion: "ads.auto-creation.checks.v5" } });
    expect((outputs.directions as { unverified: Array<{ field: string }> }).unverified.map((item) => item.field)).toEqual(["candidates[0].differentiation"]);
    // Later prompts carry the notices as unverified.
    expect(seen.slice(before)[1]!.user).toContain("机会 2中的「五十元」：程序未能判定数字含义，未核实");
    expect(seen.slice(before)[2]!.user).toContain("<<<选定方向的未核实提示（只属于创作设计，不是事实）");
    expect((await q<{ review_status: string }>("SELECT review_status FROM story_revision WHERE project_id = $1", [id]))).toEqual([{ review_status: "DRAFT" }]);
    const markdown = (await svc.package(id, runId, "markdown")).download!.text;
    expect(markdown).toContain("**用户设定与资料记录**（来自用户设定和服务端记录，不是 AI 调研结论）");
    expect(markdown).toContain("- 用户设定｜出场人物上限：最多 3 人");
    expect(markdown).toContain("- 机会 2中的「五十元」：程序未能判定数字含义，未核实");
    expect(markdown).toContain("- 未核实提示：方向 D1 的差异点中的「三块」");
    expect(markdown).toContain("资料有限：没有可读取的近期市场资料");
    expect(markdown.replaceAll("或已验证的市场结论", "")).not.toMatch(/已验证|已核实|市场验证(已)?完成/u);
    const json = (await svc.package(id, runId, "json")).download!.text;
    expect((JSON.parse(json) as { research: { analysis: unknown } }).research.analysis).toEqual(research);
    // Read again as a reload would: the same run and the same exports, nothing sent.
    const sent = seen.length;
    expect(runOf((await svc.latest(id)).body)).toMatchObject({ runId, state: "completed", callsUsed: 6 });
    expect((await svc.package(id, runId, "markdown")).download!.text).toBe(markdown);
    // Only the export time differs between two downloads.
    const undated = (text: string) => text.replace(/"generatedAt": ?"[^"]+"/u, "");
    expect(undated((await svc.package(id, runId, "json")).download!.text)).toBe(undated(json));
    expect(seen.length).toBe(sent);
    plan = {};
    evidence.unplacedQuantities = { runId, calls: run.callsUsed, notices: research.unverified.length, stages: seen.slice(before).map((item) => item.stage) };
  });

  it.each([
    ["statisticAfterUnplaced", "unsourced_number@opportunities[1]:percent+market_statistic+proportion", "七成"],
    ["serverFieldsInAnswer", "invalid_output@limitations:unrecognized_keys", "官方入口页面没有读到正文"],
  ] as const)("checks v5: %s is refused at research alone; one send, nothing stored, nothing after it", async (flag, code, text) => {
    plan = { [flag]: true };
    const { svc, settle } = service();
    const id = await project(1);
    const before = seen.length;
    const started = await svc.start(id, { revisionRounds: 0, callBudget: 6 }, TOKEN, ctx(`v5-${flag}`));
    await settle();
    const runId = runOf(started.body).runId;
    expect(runOf((await svc.get(id, runId)).body)).toMatchObject({ state: "failed", callsUsed: 1 });
    expect(seen.slice(before).map((item) => item.stage)).toEqual(["research"]);
    expect(await q("SELECT stage_key, state, error_code, output_json FROM auto_creation_stage WHERE run_id = $1 AND state <> 'pending' AND stage_key <> 'sources'", [runId]))
      .toEqual([{ stage_key: "research", state: "rejected", error_code: code, output_json: null }]);
    expect(await q("SELECT error_code FROM auto_creation_call WHERE run_id = $1", [runId])).toEqual([{ error_code: code }]);
    const all = JSON.stringify([await q("SELECT * FROM auto_creation_stage WHERE run_id = $1", [runId]), await q("SELECT * FROM auto_creation_call WHERE run_id = $1", [runId]),
      await q("SELECT * FROM auto_creation_run WHERE id = $1", [runId])]);
    expect(all).not.toContain(text);
    expect(all).not.toContain("五十元");
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM story_revision WHERE project_id = $1", [id]))[0]!.n).toBe(0);
    // Maintenance resends nothing.
    await service().engine.maintain();
    expect(seen.length - before).toBe(1);
    plan = {};
    (evidence.v5Refused ??= {} as Record<string, unknown>);
    (evidence.v5Refused as Record<string, unknown>)[flag] = { runId, stageError: code };
  });

  it("the online refusal's shape: a v4 run refused at research stays stopped until a person resumes it; then research v3 completes and the frozen v4 stays", async () => {
    plan = { serverFieldsInAnswer: true };
    const { svc, settle } = service();
    const id = await project(1);
    const started = await svc.start(id, { revisionRounds: 0, callBudget: 8 }, TOKEN, ctx("v4-refused"));
    await settle();
    const runId = runOf(started.body).runId;
    // As the deployed v4 code stored it: its versions and hash, and its refusal (the online code shape; the answer text was never kept).
    const [row] = await q<{ input_json: AutoCreationFrozenInput }>("SELECT input_json FROM auto_creation_run WHERE id = $1", [runId]);
    const v4 = { ...row!.input_json, promptVersion: "ads.auto-creation.prompt.v4", checksVersion: "ads.auto-creation.checks.v4" } as AutoCreationFrozenInput;
    const v4Code = "unsourced_number@appliedConstraints[1]:chinese_numeral+unclassified+no_role";
    await q("UPDATE auto_creation_run SET input_json = $2, input_hash = $3 WHERE id = $1", [runId, JSON.stringify(v4), hashAutoCreationInput(id, v4)]);
    await q("UPDATE auto_creation_stage SET error_code = $2 WHERE run_id = $1 AND stage_key = 'research'", [runId, v4Code]);
    await q("UPDATE auto_creation_call SET error_code = $2 WHERE run_id = $1", [runId, v4Code]);
    plan = { unplacedQuantities: true };
    const sent = seen.length;
    // Never rerun by itself: maintenance and a read send nothing.
    await service().engine.maintain();
    await svc.get(id, runId);
    expect(seen.length).toBe(sent);
    expect(runOf((await svc.get(id, runId)).body)).toMatchObject({ state: "failed", callsUsed: 1 });
    expect((await svc.resume(id, runId, {}, TOKEN, ctx("v4-resume"))).status).toBe(200);
    await settle();
    expect(seen.slice(sent).map((item) => item.stage)).toEqual(["research", "directions", "bible", "outline", "episode:1", "review:1"]);
    expect(seen.slice(sent)[0]!.user).toContain("提示版本：ads.auto-creation.prompt.v5");
    const run = runOf((await svc.get(id, runId)).body);
    expect(run).toMatchObject({ state: "completed", callsUsed: 7, callCap: 8, storySave: "saved", promptVersion: "ads.auto-creation.prompt.v4" });
    expect(run.calls.filter((call) => call.stageKey === "research").map((call) => [call.state, call.errorCode])).toEqual([["rejected", v4Code], ["completed", null]]);
    expect(run.stages.find((stage) => stage.stageKey === "research")!.output).toMatchObject({ schema: "ads.auto-creation.research.v3",
      serverRecord: { executedWith: { promptVersion: "ads.auto-creation.prompt.v5", checksVersion: "ads.auto-creation.checks.v5" } } });
    const after = (await q<{ input_json: AutoCreationFrozenInput; input_hash: string }>("SELECT input_json, input_hash FROM auto_creation_run WHERE id = $1", [runId]))[0]!;
    expect(after.input_json).toEqual(v4);
    expect(after.input_hash).toBe(hashAutoCreationInput(id, v4));
    plan = {};
    evidence.v4RefusedResume = { runId, calls: run.callsUsed };
  });

  it("research v1 history: a v3 run stopped after its v1 research resumes without resending research; later prompts read it as history", async () => {
    plan = {};
    failNext = "directions";
    const { svc, settle } = service();
    const id = await project(1);
    // Budget 8: one episode, no rounds, plus the confirmed resend of the uncertain directions call.
    const started = await svc.start(id, { revisionRounds: 0, callBudget: 8 }, TOKEN, ctx("v1-research-resume"));
    await settle();
    const runId = runOf(started.body).runId;
    expect(runOf((await svc.get(id, runId)).body).state).toBe("needs_attention");
    const [row] = await q<{ input_json: AutoCreationFrozenInput }>("SELECT input_json FROM auto_creation_run WHERE id = $1", [runId]);
    const v3 = { ...row!.input_json, promptVersion: "ads.auto-creation.prompt.v3", checksVersion: "ads.auto-creation.checks.v3" } as AutoCreationFrozenInput;
    await q("UPDATE auto_creation_run SET input_json = $2, input_hash = $3 WHERE id = $1", [runId, JSON.stringify(v3), hashAutoCreationInput(id, v3)]);
    await q("UPDATE auto_creation_stage SET output_json = $2 WHERE run_id = $1 AND stage_key = 'research'", [runId, JSON.stringify(fixtureAutoResearchV1())]);
    const sent = seen.length;
    const uncertain = runOf((await svc.get(id, runId)).body).calls.filter((call) => call.state === "unknown").map((call) => call.callId);
    expect(uncertain).toHaveLength(1);
    expect((await svc.resume(id, runId, { confirmUncertainCallIds: uncertain }, TOKEN, ctx("v1-research-resume-1"))).status).toBe(200);
    await settle();
    expect(seen.slice(sent).map((item) => item.stage)).toEqual(["directions", "bible", "outline", "episode:1", "review:1"]);
    expect(seen.slice(sent)[0]!.user).toContain("\"历史版本\":{\"pattern\":\"主角主动选择推动结果\"");
    expect(seen.slice(sent)[0]!.user).not.toContain("参考方法原文\":");
    const run = runOf((await svc.get(id, runId)).body);
    expect(run).toMatchObject({ state: "completed", storySave: "saved", callsUsed: 7, callCap: 8 });
    expect(run.calls.filter((call) => call.stageKey === "research")).toHaveLength(1);
    const after = (await q<{ input_json: AutoCreationFrozenInput; input_hash: string }>("SELECT input_json, input_hash FROM auto_creation_run WHERE id = $1", [runId]))[0]!;
    expect(after.input_json).toEqual(v3);
    expect(after.input_hash).toBe(hashAutoCreationInput(id, v3));
    expect((await q<{ output_json: unknown }>("SELECT output_json FROM auto_creation_stage WHERE run_id = $1 AND stage_key = 'research'", [runId]))[0]!.output_json)
      .toEqual(fixtureAutoResearchV1());
    expect((await q<{ review_status: string }>("SELECT review_status FROM story_revision WHERE project_id = $1", [id]))).toEqual([{ review_status: "DRAFT" }]);
    evidence.v1ResearchResume = { runId, calls: run.callsUsed, resent: seen.slice(sent).map((item) => item.stage) };
  });

  it("three episodes with a verified issue: one targeted revision and a second review; six episodes: the maximum completes", async () => {
    plan = { review: { highIssueRounds: [1] }, creativeQuantities: true };
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

  it("a stopped title run is not resumed while an automatic run is writing the same work", async () => {
    const hold: Array<() => Promise<void>> = [];
    const { svc, settle } = service({ maxActiveRuns: 5, hold });
    const id = await project(1);
    // A title run on this work that stopped before any story existed.
    const at = new Date().toISOString();
    const titleRun = { id: randomUUID(), workspaceId, projectId: id, actorId: "server-owner", idempotencyKey: randomUUID(), inputHash: "ef".repeat(32),
      input: { schema: "ads.title-writing.input.v1", promptVersion: "ads.title-writing.prompt.v1", title: "先停", settings: { episodeCount: 3, episodeSeconds: 90, style: "" },
        providerKey: "openai", model: "o-1" },
      state: "running", errorCode: null, cancelRequestedAt: null, executorId: null, leaseUntil: null, callCap: 8, callsUsed: 0, storySave: "pending",
      storyRevisionId: null, createdAt: at, updatedAt: at } as TitleRunRecord;
    expect((await titles.createRun(titleRun, { maxActiveRuns: 5 })).kind).toBe("created");
    await q("UPDATE title_writing_run SET state = 'canceled' WHERE id = $1", [titleRun.id]);
    const started = await svc.start(id, {}, TOKEN, ctx("auto-over-title"));
    expect(started.status).toBe(201);
    const resumed = await titles.prepareResume(workspaceId, id, titleRun.id, { resumeKey: randomUUID(), requestHash: "ab".repeat(32), confirmedCallIds: [],
      maxActiveRuns: 5, providerReady: true }, new Date().toISOString());
    expect(resumed.kind).toBe("active");
    await settle();
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

  /** A person's review through the text chain's own transitions: DRAFT → IN_REVIEW → APPROVED of the current story. */
  async function approveCurrentStory(projectId: string): Promise<string> {
    const readStory = async () => (await q<{ id: string; review_version: number }>(
      "SELECT sr.id, sr.review_version FROM story_revision sr JOIN project p ON p.current_story_revision_id = sr.id WHERE p.id = $1", [projectId]))[0]!;
    const readVersion = async () => (await q<{ version: number }>("SELECT version FROM project WHERE id = $1", [projectId]))[0]!.version;
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
    await textChain.approveStory({ workspaceId, projectId, revisionId: story.id, expectedVersion: await readVersion(),
      expectedReviewVersion: story.review_version, reviewedBy: "acceptance-person" });
    return story.id;
  }

  /** Every stage completed, the save lost once, then the run ended the way the engine ends it (finishRun under its lease). */
  async function endedBeforeSave(state: "needs_attention" | "canceled", errorCode: string | null) {
    plan = {};
    const lostSave = Object.create(store, { saveStory: { value: async () => "lost" as const } }) as PostgresAutoCreationStore;
    const { svc, engine, settle } = service({ engineStore: lostSave });
    const id = await project(1);
    const runId = runOf((await svc.start(id, {}, TOKEN, ctx(`ended-${randomUUID()}`))).body).runId;
    await settle();
    expect(await store.finishRun(workspaceId, runId, engine.executorId, state, errorCode, new Date().toISOString(), state === "canceled" ? undefined : "passed")).toBe(true);
    const row = (await q<{ story_save: string; story_revision_id: string | null }>("SELECT story_save, story_revision_id FROM auto_creation_run WHERE id = $1", [runId]))[0]!;
    expect(row).toEqual({ story_save: "pending", story_revision_id: null });
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM auto_creation_stage WHERE run_id = $1 AND state <> 'completed'", [runId]))[0]!.n).toBe(0);
    return { id, runId };
  }

  const snapshot = async (runId: string) => JSON.stringify({
    run: await q("SELECT state, error_code, story_save, calls_used, updated_at FROM auto_creation_run WHERE id = $1", [runId]),
    stages: await q("SELECT stage_key, state, attempt_no, script_save, updated_at FROM auto_creation_stage WHERE run_id = $1 ORDER BY stage_key", [runId]),
    resumes: await q("SELECT idempotency_key FROM auto_creation_resume WHERE run_id = $1", [runId]),
  });

  it("a story too large to save is final: resumes are refused with no record or reset, and no script lands on another approved story", async () => {
    const { id, runId } = await endedBeforeSave("needs_attention", "story_too_large");
    const { svc } = service();
    const sendsBefore = seen.length;
    const before = await snapshot(runId);
    for (const key of ["final-1", "final-2"]) {
      const resumed = await svc.resume(id, runId, {}, TOKEN, ctx(key));
      expect(resumed.status).toBe(409);
      expect(resumed.body).toMatchObject({ error: { code: "AUTO_CREATION_NOT_RESUMABLE" } });
    }
    expect(await snapshot(runId)).toBe(before);
    // A person writes and approves their own story; the run's scripts still never attach to it, accepted or not.
    const version = (await q<{ version: number }>("SELECT version FROM project WHERE id = $1", [id]))[0]!.version;
    await textChain.createStoryRevision({ workspaceId, projectId: id, content: { text: "人工写的故事" }, createdBy: "acceptance-person", expectedVersion: version });
    await approveCurrentStory(id);
    for (const acceptStoryChanged of [false, true]) {
      expect((await svc.placeScripts(id, runId, { acceptStoryChanged }, ctx("p"))).body).toMatchObject({ error: { code: "AUTO_CREATION_STORY_NOT_SAVED" } });
    }
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM script_revision WHERE project_id = $1", [id]))[0]!.n).toBe(0);
    expect(await snapshot(runId)).toBe(before);
    expect((await svc.package(id, runId, "json")).status).toBe(200);
    expect(seen.length).toBe(sendsBefore);
  });

  it("a run stopped after its last stage but before the save resumes into the save alone, with no send", async () => {
    const { id, runId } = await endedBeforeSave("canceled", null);
    const { svc, settle } = service();
    const sendsBefore = seen.length;
    expect((await svc.resume(id, runId, {}, TOKEN, ctx("save-only"))).status).toBe(200);
    await settle();
    expect((await q("SELECT state, story_save FROM auto_creation_run WHERE id = $1", [runId]))[0]).toEqual({ state: "completed", story_save: "saved" });
    expect(seen.length).toBe(sendsBefore);
  });

  /** A run left as the old prompt left it: every stage up to the episodes completed, the review never sent, stopped at prompt_too_large. */
  async function stoppedBeforeReview(episodeCount: number) {
    plan = {};
    const stopAtReview = Object.create(store, { reserveCall: { value: async (...args: Parameters<PostgresAutoCreationStore["reserveCall"]>) => {
      const [call, , nowIso] = args;
      if (call.stageKey !== "review:1") return store.reserveCall(...args);
      expect(await store.finishRun(workspaceId, call.runId, call.executorId, "needs_attention", "prompt_too_large", nowIso)).toBe(true);
      return { kind: "lost" as const };
    } } }) as PostgresAutoCreationStore;
    const { svc, settle } = service({ engineStore: stopAtReview });
    const id = await project(episodeCount);
    const runId = runOf((await svc.start(id, {}, TOKEN, ctx(`before-review-${randomUUID()}`))).body).runId;
    await settle();
    expect((await q("SELECT state, error_code, calls_used FROM auto_creation_run WHERE id = $1", [runId]))[0])
      .toEqual({ state: "needs_attention", error_code: "prompt_too_large", calls_used: episodeCount + 4 });
    return { id, runId };
  }

  it("a stopped run whose next request cannot be built is refused with no record, no reset and no send", async () => {
    const { id, runId } = await stoppedBeforeReview(2);
    // Saved episodes larger than any review prompt can carry (a run stored before the review input budget).
    await q("UPDATE auto_creation_stage SET output_json = jsonb_set(output_json, '{scenes,0,action}', to_jsonb(repeat('长', 45000))) WHERE run_id = $1 AND stage_key = 'episode:1'", [runId]);
    const { svc, settle } = service();
    expect(runOf((await svc.get(id, runId)).body).resumeBlock).toBe("prompt_too_large");
    const sendsBefore = seen.length;
    const before = await snapshot(runId);
    for (const key of ["blocked-1", "blocked-1", "blocked-2"]) {
      const resumed = await svc.resume(id, runId, {}, TOKEN, ctx(key));
      expect(resumed.status).toBe(409);
      expect(resumed.body).toMatchObject({ error: { code: "AUTO_CREATION_PROMPT_TOO_LARGE" } });
    }
    await settle();
    expect(await snapshot(runId)).toBe(before);
    expect(seen.length).toBe(sendsBefore);
  });

  it("a run the old prompt stopped before its review now continues into the review alone, reusing its saved stages", async () => {
    const { id, runId } = await stoppedBeforeReview(2);
    const { svc, settle } = service();
    const sendsBefore = seen.length;
    expect(runOf((await svc.get(id, runId)).body).resumeBlock).toBeNull();
    expect((await svc.resume(id, runId, {}, TOKEN, ctx("after-budget"))).status).toBe(200);
    await settle();
    expect(seen.slice(sendsBefore).map((item) => item.stage)).toEqual(["review:1"]);
    expect((await q("SELECT state, story_save, calls_used FROM auto_creation_run WHERE id = $1", [runId]))[0])
      .toEqual({ state: "completed", story_save: "saved", calls_used: 7 });
  });

  it("a story conflict keeps the person's story and never places the run's scripts on it", async () => {
    plan = {};
    const hold: Array<() => Promise<void>> = [];
    const { svc, settle } = service({ hold });
    const id = await project(1);
    const runId = runOf((await svc.start(id, {}, TOKEN, ctx("conflict"))).body).runId;
    // The person saves a story while the run is still waiting to work.
    const version = (await q<{ version: number }>("SELECT version FROM project WHERE id = $1", [id]))[0]!.version;
    await textChain.createStoryRevision({ workspaceId, projectId: id, content: { text: "人工写的故事" }, createdBy: "acceptance-person", expectedVersion: version });
    await settle();
    expect((await q("SELECT state, error_code, story_save FROM auto_creation_run WHERE id = $1", [runId]))[0])
      .toEqual({ state: "needs_attention", error_code: "story_conflict", story_save: "conflict" });
    await approveCurrentStory(id);
    expect((await svc.placeScripts(id, runId, { acceptStoryChanged: true }, ctx("p"))).body).toMatchObject({ error: { code: "AUTO_CREATION_STORY_NOT_SAVED" } });
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM script_revision WHERE project_id = $1", [id]))[0]!.n).toBe(0);
  });

  it("the script breakdown stays off and unchanged; no breakdown table appears unless it was already applied", async () => {
    expect((await q("SELECT to_regclass('script_breakdown_scene') AS t"))[0]!.t === null).toBe(scenario !== "breakdown");
    evidence.paidCalls = 0;
    evidence.breakdownApplied = (await ledger()).includes(SCRIPT_BREAKDOWN_MIGRATION);
  });
});
