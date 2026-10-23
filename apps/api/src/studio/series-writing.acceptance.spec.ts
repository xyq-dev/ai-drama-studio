/**
 * Isolated PostgreSQL acceptance of series writing: its guarded migration (20261023000100_series_writing), the PostgreSQL
 * store, the API service and the engine on real tables. Runs only against a new, empty, disposable database a person named
 * on purpose (title writing acceptance guard). NOT part of `test` or `integration`:
 *   pnpm --filter @ai-drama/api series-writing:acceptance
 * SERIES_WRITING_ACCEPTANCE_SCENARIO picks the starting schema: "testsite" (default: the base seven plus the guarded Claude,
 * candidate, DeepSeek candidate and automatic creation migrations, script breakdown NOT applied), "base" (the base seven)
 * or "breakdown" (the base seven plus the script breakdown). The model is the series double: no network, no paid call.
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { autoCreationNormalCalls, seriesBatchCount, seriesNormalCalls, seriesScopeCalls, type SeriesScope } from "@ai-drama/contracts";
import type { SeriesView } from "@ai-drama/domain";
import {
  AUTO_CREATION_MIGRATION,
  BASE_MIGRATIONS,
  CharacterReferenceStore,
  GUARDED_SINGLE_MIGRATIONS,
  JobPersistenceService,
  MediaAssetStore,
  PostgresAutoCreationStore,
  PostgresSeriesWritingStore,
  RuntimeStore,
  SCRIPT_BREAKDOWN_MIGRATION,
  SERIES_WRITING_MIGRATION,
  TextChainService,
  WRITING_CANDIDATE_DEEPSEEK_MIGRATION,
  WRITING_CANDIDATE_MIGRATION,
  WRITING_PROVIDER_MIGRATION,
  checkTitleWritingAcceptanceEnv,
  closePostgresPool,
  createPostgresPool,
  recentWritingCalls,
  runMigrations,
  verifyTitleWritingAcceptanceDatabase,
} from "@ai-drama/database";
import { AutoCreationEngine, SeriesWritingEngine, titleWritingProviderConfigs } from "@ai-drama/providers";
import { autoFixtureTransport, seriesFixtureTransport, type SeriesFixtureExchange, type SeriesFixturePlan } from "@ai-drama/providers/title-writing-fixtures";
import { AutoCreationService } from "./auto-creation.service";
import { SeriesWritingService } from "./series-writing.service";
import { StudioService } from "./studio.service";
import { writingWorkspaceIdle } from "./writing-activation";

const decision = checkTitleWritingAcceptanceEnv(process.env);
if (!decision.ok) throw new Error(`Series writing acceptance refused: ${decision.reason}`);
const scenario = process.env.SERIES_WRITING_ACCEPTANCE_SCENARIO === "base" ? "base"
  : process.env.SERIES_WRITING_ACCEPTANCE_SCENARIO === "breakdown" ? "breakdown" : "testsite";

const pool = createPostgresPool({ connectionString: decision.url, connectionTimeoutMs: 2_000, statementTimeoutMs: 10_000, queryTimeoutMs: 10_000 });
async function q<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> {
  return (await pool.query(sql, values) as { rows: T[] }).rows;
}
const textChain = new TextChainService(pool);
const store = new PostgresSeriesWritingStore(pool, textChain);
const runtime = new RuntimeStore(pool);
const TOKEN = "operator-token-0123456789-acceptance";
const providers = titleWritingProviderConfigs({ DEEPSEEK_API_KEY: `stub-deepseek-not-a-key-${randomUUID()}` });
const evidence: Record<string, unknown> = { scenario, paidCalls: 0 };
let workspaceId = "";
let poolClosed = false;
let plan: SeriesFixturePlan = {};
let failNext: string | null = null;
/** The next send of this stage is refused definitively (a 422: rejected, not uncertain). */
let rejectNext: string | null = null;
const seen: SeriesFixtureExchange[] = [];
const transport = seriesFixtureTransport({ seen, plan: () => plan, override: (stage) => {
  if (failNext && stage === failNext) {
    failNext = null;
    return { status: 500, body: "{}" };
  }
  if (rejectNext && stage === rejectNext) {
    rejectNext = null;
    return { status: 422, body: {} };
  }
  return undefined;
} });
const FIXED = new Date("2026-10-22T08:00:00.000Z");

function service(options: { maxCallsPerDay?: number; maxActiveRuns?: number; clock?: () => Date; store?: PostgresSeriesWritingStore } = {}) {
  const maxCallsPerDay = options.maxCallsPerDay ?? 1_000;
  const maxActiveRuns = options.maxActiveRuns ?? 5;
  const own = options.store ?? store;
  const engine = new SeriesWritingEngine({ workspaceId, store: own, providers, transport, maxCallsPerDay, maxActiveRuns, timeoutMs: 30_000,
    ...(options.clock ? { clock: options.clock } : {}) });
  const pending: Array<() => Promise<void>> = [];
  const svc = new SeriesWritingService({
    workspaceId, enabled: true, operatorToken: TOKEN, defaultProvider: "deepseek", providers, store: own, engine, projects: runtime, maxCallsPerDay, maxActiveRuns,
    research: { fetchEnabled: false, allowedHosts: [] }, schedule: (work) => { pending.push(work); }, ...(options.clock ? { clock: options.clock } : {}),
  });
  const settle = async () => { while (pending.length > 0) await pending.shift()!(); };
  return { svc, engine, settle, pending };
}

const ctx = (key: string) => ({ actorId: "server-owner", traceId: "acceptance", idempotencyKey: key });
const viewOf = (body: unknown) => (body as { series: SeriesView }).series;
const ledger = async () => (await q<{ name: string }>("SELECT name FROM schema_migration ORDER BY name")).map((row) => row.name);
const ALL = (n: number): SeriesScope => ({ plan: true, batchFrom: 1, batchTo: seriesBatchCount(n), final: true });

async function createSeries(svc: SeriesWritingService, episodeCount: number, key: string = randomUUID()): Promise<SeriesView> {
  const created = await svc.create({ title: `系列验收 ${key.slice(0, 6)}`, episodeCount, episodeSeconds: 60 }, TOKEN, ctx(key));
  expect(created.status).toBe(201);
  return viewOf(created.body);
}

async function grant(svc: SeriesWritingService, view: SeriesView, scope: SeriesScope, key: string = randomUUID(), resendAllowance = 0) {
  const normal = seriesScopeCalls(view.episodeCount, scope);
  return svc.grant(view.projectId, { scope, normalCalls: normal, resendAllowance, callBudget: normal + resendAllowance, providerKey: "deepseek",
    model: "deepseek-flash", basePlanRevisionId: view.plan?.revisionId ?? null }, TOKEN, ctx(key));
}

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

/** An approved story → script → scene → shot chain of one episode, written as the review chain leaves it (SQL, as the media store specs do). */
async function seedApprovedShot(mode: "short" | "series"): Promise<{ projectId: string; shotRevisionId: string; scriptRevisionId: string }> {
  const hash = "ab".repeat(32);
  const projectId = (await q<{ id: string }>(
    "INSERT INTO project (workspace_id, title, episode_count, target_episode_seconds, writing_mode) VALUES ($1, $2, 1, 60, $3) RETURNING id",
    [workspaceId, `媒体准入 ${mode}`, mode]))[0]!.id;
  const story = (await q<{ id: string }>(
    `INSERT INTO story_revision (workspace_id, project_id, revision_no, content_json, content_hash, created_by, review_status, reviewed_by, reviewed_at, reviewed_content_hash)
     VALUES ($1, $2, 1, '{}'::jsonb, $3, 'test', 'APPROVED', 'editor', now(), $3) RETURNING id`, [workspaceId, projectId, hash]))[0]!.id;
  await q("UPDATE project SET current_story_revision_id = $1, approved_story_revision_id = $1 WHERE id = $2", [story, projectId]);
  const episode = (await q<{ id: string }>("INSERT INTO episode (workspace_id, project_id, episode_no, title) VALUES ($1, $2, 1, '第 1 集') RETURNING id",
    [workspaceId, projectId]))[0]!.id;
  const script = (await q<{ id: string }>(
    `INSERT INTO script_revision (workspace_id, project_id, episode_id, revision_no, source_story_revision_id, content_json, content_hash, created_by,
       review_status, reviewed_by, reviewed_at, reviewed_content_hash)
     VALUES ($1, $2, $3, 1, $4, '{}'::jsonb, $5, 'test', 'APPROVED', 'editor', now(), $5) RETURNING id`, [workspaceId, projectId, episode, story, hash]))[0]!.id;
  await q("UPDATE episode SET current_script_revision_id = $1, approved_script_revision_id = $1 WHERE id = $2", [script, episode]);
  const scene = (await q<{ id: string }>("INSERT INTO scene (workspace_id, project_id, episode_id) VALUES ($1, $2, $3) RETURNING id", [workspaceId, projectId, episode]))[0]!.id;
  const sceneRevision = (await q<{ id: string }>(
    `INSERT INTO scene_revision (workspace_id, project_id, episode_id, scene_id, revision_no, source_script_revision_id, ordinal, heading, summary, content_hash,
       review_status, reviewed_by, reviewed_at, reviewed_content_hash, created_by)
     VALUES ($1, $2, $3, $4, 1, $5, 1, '内景 房间', '房间', $6, 'APPROVED', 'editor', now(), $6, 'test') RETURNING id`,
    [workspaceId, projectId, episode, scene, script, hash]))[0]!.id;
  await q("UPDATE scene SET current_revision_id = $1, approved_revision_id = $1 WHERE id = $2", [sceneRevision, scene]);
  const shot = (await q<{ id: string }>("INSERT INTO shot (workspace_id, project_id, episode_id, scene_id) VALUES ($1, $2, $3, $4) RETURNING id",
    [workspaceId, projectId, episode, scene]))[0]!.id;
  const shotRevisionId = (await q<{ id: string }>(
    `INSERT INTO shot_revision (workspace_id, project_id, scene_id, shot_id, revision_no, source_scene_revision_id, ordinal, shot_type, camera, action, dialogue,
       prompt_text, content_hash, review_status, reviewed_by, reviewed_at, reviewed_content_hash, created_by)
     VALUES ($1, $2, $3, $4, 1, $5, 1, '近景', '固定', '看向门口', '林夏：开门。', '门口；近景', $6, 'APPROVED', 'editor', now(), $6, 'test') RETURNING id`,
    [workspaceId, projectId, scene, shot, sceneRevision, hash]))[0]!.id;
  await q("UPDATE shot SET current_revision_id = $1, approved_revision_id = $1 WHERE id = $2", [shotRevisionId, shot]);
  return { projectId, shotRevisionId, scriptRevisionId: script };
}

beforeAll(async () => {
  const verified = await verifyTitleWritingAcceptanceDatabase({ query: async (sql, values) => ({ rows: await q(sql, values) }) }, decision.databaseName);
  if (!verified.ok) {
    poolClosed = true;
    await closePostgresPool(pool);
    throw new Error(`Series writing acceptance refused: ${verified.reason}`);
  }
  expect((await runMigrations(pool, undefined, { before: SCRIPT_BREAKDOWN_MIGRATION })).applied).toEqual([...BASE_MIGRATIONS]);
  if (scenario === "breakdown") {
    expect((await runMigrations(pool, undefined, { before: WRITING_PROVIDER_MIGRATION })).applied).toEqual([SCRIPT_BREAKDOWN_MIGRATION]);
  }
  if (scenario === "testsite") {
    for (const name of [WRITING_PROVIDER_MIGRATION, WRITING_CANDIDATE_MIGRATION, WRITING_CANDIDATE_DEEPSEEK_MIGRATION, AUTO_CREATION_MIGRATION]) {
      expect((await runMigrations(pool, undefined, { only: { name, requires: GUARDED_SINGLE_MIGRATIONS[name]! } })).applied).toEqual([name]);
    }
  }
  evidence.startingLedger = await ledger();
  workspaceId = (await q<{ id: string }>("INSERT INTO workspace (name) VALUES ('series-writing-acceptance') RETURNING id"))[0]!.id;
}, 60_000);

afterAll(async () => {
  evidence.stubSends = seen.length;
  evidence.everyEndpoint = [...new Set(seen.map((item) => item.url))];
  const dir = process.env.TITLE_WRITING_ACCEPTANCE_EVIDENCE_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `series-writing-${scenario}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  }
  if (!poolClosed) await closePostgresPool(pool);
});

describe(`series writing on PostgreSQL (${scenario} schema)`, () => {
  it("before its migration nothing is ready: a series is refused with zero writes and zero sends", async () => {
    expect(await store.storageReady()).toBe(false);
    const { svc } = service();
    const refused = await svc.create({ title: "迁移前", episodeCount: 60, episodeSeconds: 60 }, TOKEN, ctx("before"));
    expect(refused.status).toBe(503);
    expect((await q("SELECT to_regclass('series_writing_series') AS t"))[0]!.t).toBeNull();
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM project"))[0]!.n).toBe(0);
    expect(seen).toHaveLength(0);
  });

  it("a failing migration rolls back completely and records nothing", async () => {
    await q("CREATE TABLE series_writing_resume (blocker int)");
    const only = { name: SERIES_WRITING_MIGRATION, requires: GUARDED_SINGLE_MIGRATIONS[SERIES_WRITING_MIGRATION]! };
    await expect(runMigrations(pool, undefined, { only })).rejects.toThrow();
    expect(await ledger()).not.toContain(SERIES_WRITING_MIGRATION);
    expect((await q("SELECT to_regclass('series_writing_series') AS t"))[0]!.t).toBeNull();
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'project' AND column_name = 'writing_mode'"))[0]!.n).toBe(0);
    await q("DROP TABLE series_writing_resume");
  });

  it("the guarded command applies only this migration; existing works stay short dramas held to 1–6 episodes; a rerun applies nothing", async () => {
    const before = (await q<{ id: string }>("INSERT INTO project (workspace_id, title, episode_count, target_episode_seconds) VALUES ($1, '迁移前的短剧', 6, 60) RETURNING id",
      [workspaceId]))[0]!.id;
    const only = { name: SERIES_WRITING_MIGRATION, requires: GUARDED_SINGLE_MIGRATIONS[SERIES_WRITING_MIGRATION]! };
    const applied = await runMigrations(pool, undefined, { only });
    expect(applied.applied).toEqual([SERIES_WRITING_MIGRATION]);
    const expectedPending = scenario === "testsite" ? [SCRIPT_BREAKDOWN_MIGRATION]
      : scenario === "base" ? [SCRIPT_BREAKDOWN_MIGRATION, WRITING_PROVIDER_MIGRATION, WRITING_CANDIDATE_MIGRATION, WRITING_CANDIDATE_DEEPSEEK_MIGRATION, AUTO_CREATION_MIGRATION]
        : [WRITING_PROVIDER_MIGRATION, WRITING_CANDIDATE_MIGRATION, WRITING_CANDIDATE_DEEPSEEK_MIGRATION, AUTO_CREATION_MIGRATION];
    expect(applied.leftPending).toEqual(expectedPending);
    expect(await runMigrations(pool, undefined, { only })).toEqual({ applied: [], alreadyApplied: [SERIES_WRITING_MIGRATION], leftPending: expectedPending });
    expect((await ledger()).includes(SCRIPT_BREAKDOWN_MIGRATION)).toBe(scenario === "breakdown");
    expect(await store.storageReady()).toBe(true);
    expect((await q<{ writing_mode: string }>("SELECT writing_mode FROM project WHERE id = $1", [before]))[0]!.writing_mode).toBe("short");
    // A short-drama work still cannot have seven episodes; only a series work may have 7–60, never 61.
    await expect(q("UPDATE project SET episode_count = 7 WHERE id = $1", [before])).rejects.toThrow();
    await expect(q("INSERT INTO project (workspace_id, title, episode_count, target_episode_seconds, writing_mode) VALUES ($1, 'x', 61, 60, 'series')", [workspaceId])).rejects.toThrow();
    await expect(q("INSERT INTO project (workspace_id, title, episode_count, writing_mode) VALUES ($1, 'x', 30, 'series')", [workspaceId])).rejects.toThrow();
    await expect(q("INSERT INTO series_writing_stage (run_id, workspace_id, stage_key, ordinal, state, updated_at) VALUES ($1, $2, 'episode:61', 0, 'pending', now())",
      [randomUUID(), workspaceId])).rejects.toThrow();
    // A short-drama work still takes no seventh episode (the trigger keeps the replaced CHECK's rule); a series work may.
    await expect(q("INSERT INTO episode (workspace_id, project_id, episode_no, title) VALUES ($1, $2, 7, 'extra')", [workspaceId, before])).rejects.toThrow(/check/i);
    const seriesWork = (await q<{ id: string }>("INSERT INTO project (workspace_id, title, episode_count, target_episode_seconds, writing_mode) VALUES ($1, 's', 12, 60, 'series') RETURNING id",
      [workspaceId]))[0]!.id;
    await q("INSERT INTO episode (workspace_id, project_id, episode_no, title) VALUES ($1, $2, 12, 'twelve')", [workspaceId, seriesWork]);
    await expect(q("INSERT INTO episode (workspace_id, project_id, episode_no, title) VALUES ($1, $2, 13, 'past')", [workspaceId, seriesWork])).rejects.toThrow(/check/i);
    await q("DELETE FROM episode WHERE project_id = $1", [seriesWork]);
    await q("DELETE FROM project WHERE id = $1", [seriesWork]);
    await q("DELETE FROM project WHERE id = $1", [before]);
    evidence.migration = { applied, ledger: await ledger() };
  });

  it("a 60-episode series: plan, every batch, every batch review and the final review in exactly 96 calls; export is stable", async () => {
    plan = {};
    const { svc, settle } = service({ clock: () => FIXED });
    const view = await createSeries(svc, 60, "sixty");
    expect((await svc.create({ title: view.title, episodeCount: 60, episodeSeconds: 60 }, TOKEN, ctx("sixty"))).status).toBe(200);
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM series_writing_series WHERE project_id = $1", [view.projectId]))[0]!.n).toBe(1);
    expect((await q<{ episode_count: number; writing_mode: string }>("SELECT episode_count, writing_mode FROM project WHERE id = $1", [view.projectId]))[0])
      .toEqual({ episode_count: 60, writing_mode: "series" });
    const before = seen.length;
    const started = await grant(svc, view, ALL(60), "sixty-grant");
    expect(started.status).toBe(201);
    await settle();
    const done = viewOf((await svc.get(view.projectId)).body);
    expect(seen.length - before).toBe(seriesNormalCalls(60));
    expect(done).toMatchObject({ completion: "text_complete", written: 60 });
    expect(done.episodes.map((item) => item.episodeNo)).toEqual(Array.from({ length: 60 }, (_, index) => index + 1));
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM series_writing_call WHERE series_id = $1 AND billing_status = 'unknown'", [done.seriesId]))[0]!.n).toBe(96);
    // Multi-digit stage keys order by ordinal and are found by key.
    const keys = await q<{ stage_key: string }>(
      `SELECT s.stage_key FROM series_writing_stage s JOIN series_writing_run r ON r.id = s.run_id WHERE r.series_id = $1 AND s.stage_key LIKE 'episode:%'
        ORDER BY r.job_seq, s.ordinal`, [done.seriesId]);
    expect(keys.map((row) => row.stage_key)).toEqual(Array.from({ length: 60 }, (_, index) => `episode:${String(index + 1)}`));
    expect((await q("SELECT 1 FROM series_writing_stage WHERE stage_key = 'batch_review:20'"))).toHaveLength(1);
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM series_writing_run WHERE series_id = $1 AND call_cap > 60", [done.seriesId]))[0]!.n).toBe(0);
    const story = await q<{ review_status: string; created_by: string }>("SELECT review_status, created_by FROM story_revision WHERE project_id = $1", [view.projectId]);
    expect(story).toHaveLength(1);
    expect(story[0]!.review_status).toBe("DRAFT");
    expect(story[0]!.created_by).toMatch(/^series-writing:/);
    // Replaying the grant key writes, schedules and sends nothing.
    const replay = await grant(svc, view, ALL(60), "sixty-grant");
    expect(replay.status).toBe(200);
    await settle();
    expect(seen.length - before).toBe(96);
    const first = await svc.package(view.projectId, "json");
    const second = await svc.package(view.projectId, "json");
    expect(first.download!.text).toBe(second.download!.text);
    expect((await svc.package(view.projectId, "markdown")).download!.text).toContain("当前编剧交付包");
    evidence.sixty = { calls: done.budget.callsUsed, completion: done.completion, grants: done.grants.length };
  });

  it("plan + episodes 1–3 stops at 3/60 in 19 calls; episodes 4–6 follow from the ledger without re-planning", async () => {
    plan = {};
    const { svc, settle } = service();
    const view = await createSeries(svc, 60);
    const before = seen.length;
    expect((await grant(svc, view, { plan: true, batchFrom: 1, batchTo: 1, final: false })).status).toBe(201);
    await settle();
    let current = viewOf((await svc.get(view.projectId)).body);
    expect(seen.length - before).toBe(19);
    expect(current.completionLabel).toContain("已完成 3/60 集");
    const mid = seen.length;
    expect((await grant(svc, current, { plan: false, batchFrom: 2, batchTo: 2, final: false })).status).toBe(201);
    await settle();
    current = viewOf((await svc.get(view.projectId)).body);
    expect(seen.slice(mid).map((item) => item.stage)).toEqual(["episode:4", "episode:5", "episode:6", "batch_review:2"]);
    expect(current.written).toBe(6);
    const ledger2 = await q<{ content_json: { props: Array<{ id: string; holderId: string | null }> } }>(
      "SELECT content_json FROM series_writing_ledger_revision WHERE series_id = $1 AND batch_no = 2", [current.seriesId]);
    expect(ledger2[0]!.content_json.props.find((item) => item.id === "P1")!.holderId).toBe("C3");
  });

  it("people review, place, edit and confirm: the edit stops the next batch until the ledger and the review are confirmed, history kept", async () => {
    plan = {};
    const { svc, settle } = service();
    const view = await createSeries(svc, 9);
    await grant(svc, view, { plan: true, batchFrom: 1, batchTo: 2, final: false });
    await settle();
    expect((await svc.placeBatch(view.projectId, 1, {}, ctx("p"))).body).toMatchObject({ error: { code: "SERIES_STORY_NOT_APPROVED" } });
    const storyId = await approveCurrentStory(view.projectId);
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM episode WHERE project_id = $1", [view.projectId]))[0]!.n).toBe(9);
    const placed = await svc.placeBatch(view.projectId, 1, {}, ctx("p"));
    expect(placed.body).toMatchObject({ placed: 3, conflicts: [] });
    expect((await svc.placeBatch(view.projectId, 1, {}, ctx("p"))).body).toMatchObject({ placed: 0 });
    const scripts = await q<{ review_status: string; source_story_revision_id: string }>(
      "SELECT s.review_status, s.source_story_revision_id FROM script_revision s WHERE s.project_id = $1", [view.projectId]);
    expect(scripts).toHaveLength(3);
    expect(scripts.every((row) => row.review_status === "DRAFT" && row.source_story_revision_id === storyId)).toBe(true);
    // A person edits episode 2 in the script editor: a new revision; the placed one stays readable.
    const episode2 = (await q<{ id: string; row_version: number }>("SELECT id, row_version FROM episode WHERE project_id = $1 AND episode_no = 2", [view.projectId]))[0]!;
    await textChain.createScriptRevision({ workspaceId, projectId: view.projectId, episodeId: episode2.id, sourceStoryRevisionId: storyId,
      content: { text: "人工修改后的第 2 集" }, createdBy: "acceptance-person", expectedVersion: episode2.row_version });
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM script_revision WHERE episode_id = $1", [episode2.id]))[0]!.n).toBe(2);
    let current = viewOf((await svc.get(view.projectId)).body);
    expect(current.batches[0]!.ledger.status).toBe("pending_confirmation");
    expect(current.batches[1]!.ledger.status).toBe("stale");
    const sent = seen.length;
    const refused = await grant(svc, current, { plan: false, batchFrom: 3, batchTo: 3, final: false });
    expect(refused.body).toMatchObject({ error: { code: "SERIES_BLOCKED" } });
    expect(seen.length).toBe(sent);
    for (const batchNo of [1, 2]) {
      const batch = current.batches[batchNo - 1]!;
      const saved = await svc.saveLedger(view.projectId, { batchNo, baseLedgerRevisionId: batch.ledger.revision!.id, content: batch.ledger.revision!.content,
        summaries: current.episodes.slice((batchNo - 1) * 3, batchNo * 3).map((item) => ({ episodeNo: item.episodeNo, summary: "人工确认的概要" })),
        expectedBasis: batch.ledgerBasis }, ctx("l"));
      expect(saved.status).toBe(201);
      current = viewOf(saved.body);
    }
    expect(current.next.blockers).toEqual(["batch_review_stale:1"]);
    current = viewOf((await svc.decide(view.projectId, { target: "batch:1", note: "已人工复核第 2 集修改", expectedBasis: current.batches[0]!.decisionBasis }, ctx("d"))).body);
    expect(current.next.blockers).toEqual([]);
    expect(seen.length).toBe(sent);
    expect((await grant(svc, current, { plan: false, batchFrom: 3, batchTo: 3, final: false })).status).toBe(201);
    await settle();
    expect(seen.slice(sent).map((item) => item.stage)).toEqual(["episode:7", "episode:8", "episode:9", "batch_review:3"]);
    // The current package carries the person's text; the placed model version of episode 2 is not presented as current.
    const pack = JSON.parse((await svc.package(view.projectId, "json")).download!.text) as { episodes: Array<{ current: { source: string; text: string } }> };
    expect(pack.episodes[1]!.current).toMatchObject({ source: "workbench_manual_revision", text: "人工修改后的第 2 集" });
    expect(pack.episodes[0]!.current.source).toBe("model_version_in_workbench");
    // A person's plan revision: the earlier one stays and every ledger built on it needs confirming again.
    const withPlan = viewOf((await svc.get(view.projectId)).body);
    const content = structuredClone(withPlan.plan!.content);
    content.setting.logline = "人工改写后的一句话故事";
    const planBody = { basePlanRevisionId: withPlan.plan!.revisionId, baseStoryRevisionId: withPlan.story.current!.revisionId, content };
    expect((await svc.savePlan(view.projectId, planBody, ctx("plan"))).status).toBe(201);
    expect((await svc.savePlan(view.projectId, planBody, ctx("plan"))).body).toMatchObject({ error: { code: "SERIES_EDIT_CONFLICT" } });
    const after = viewOf((await svc.get(view.projectId)).body);
    expect(after.plan).toMatchObject({ revisionNo: 2, origin: "manual", status: "unreviewed" });
    expect(after.batches.every((item) => item.ledger.status === "stale")).toBe(true);
    expect(after.completion).toBe("partial");
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM series_writing_plan_revision WHERE series_id = $1", [after.seriesId]))[0]!.n).toBe(2);
  });

  it("an injected contradiction is a blocking finding; no pass is recorded and the next batch is not sent", async () => {
    plan = { propContradiction: 5 };
    const { svc, settle } = service();
    const view = await createSeries(svc, 9);
    await grant(svc, view, { plan: true, batchFrom: 1, batchTo: 3, final: false });
    await settle();
    plan = {};
    const current = viewOf((await svc.get(view.projectId)).body);
    expect(current.batches[1]!.review.status).toBe("needs_revision");
    expect(current.batches[1]!.review.output!.deterministic).toContainEqual(expect.objectContaining({ check: "prop_handoff", severity: "high", target: "episode:5" }));
    expect(current.written).toBe(6);
    expect(current.grants[0]).toMatchObject({ state: "stopped", stopReason: "batch_review_blocking" });
  });

  it("an unknown call stops the grant; nothing is resent without confirmation; the resend counts", async () => {
    plan = {};
    const { svc, settle } = service();
    const view = await createSeries(svc, 3);
    failNext = "episode:2";
    await grant(svc, view, { plan: true, batchFrom: 1, batchTo: 1, final: false }, randomUUID(), 1);
    await settle();
    let current = viewOf((await svc.get(view.projectId)).body);
    const stopped = current.grants[0]!;
    expect(stopped).toMatchObject({ state: "stopped", stopReason: "server_error" });
    expect(stopped.uncertainCallIds).toHaveLength(1);
    expect((await svc.resume(view.projectId, stopped.grantId, {}, TOKEN, ctx("r1"))).body).toMatchObject({ error: { code: "SERIES_NEEDS_CONFIRMATION" } });
    const resumed = await svc.resume(view.projectId, stopped.grantId, { confirmUncertainCallIds: stopped.uncertainCallIds }, TOKEN, ctx("r2"));
    expect(resumed.status).toBe(200);
    await settle();
    current = viewOf((await svc.get(view.projectId)).body);
    expect(current.written).toBe(3);
    expect(current.grants[0]).toMatchObject({ state: "completed", callsUsed: seriesScopeCalls(3, { plan: true, batchFrom: 1, batchTo: 1, final: false }) + 1 });
    expect((await svc.resume(view.projectId, stopped.grantId, { confirmUncertainCallIds: stopped.uncertainCallIds }, TOKEN, ctx("r2"))).status).toBe(200);
    await settle();
    expect(viewOf((await svc.get(view.projectId)).body).budget.callsUsed).toBe(current.budget.callsUsed);
  });

  it("series calls count in the shared daily cap and running jobs in the shared concurrency cap", async () => {
    plan = {};
    const { svc } = service({ maxActiveRuns: 1 });
    const a = await createSeries(svc, 6);
    const b = await createSeries(svc, 6);
    expect((await grant(svc, a, { plan: true, batchFrom: null, batchTo: null, final: false })).status).toBe(201);
    // A running series job holds a saved model configuration back, whichever optional tables exist (no automatic creation
    // table on the base and breakdown schemas).
    expect((await q<{ present: boolean }>("SELECT to_regclass('auto_creation_run') IS NOT NULL AS present"))[0]!.present).toBe(scenario === "testsite");
    expect(await writingWorkspaceIdle(pool, workspaceId)).toBe(false);
    // a's job is running (not driven yet): b may not start while the cap is used.
    expect((await grant(svc, b, { plan: true, batchFrom: null, batchTo: null, final: false })).body).toMatchObject({ error: { code: "SERIES_ACTIVE_RUN_CAP" } });
    const client = await pool.connect();
    try {
      const since = new Date(Date.now() - 86_400_000).toISOString();
      const total = await recentWritingCalls(client, workspaceId, since);
      const series = (await client.query("SELECT count(*)::int AS n FROM series_writing_call WHERE workspace_id = $1 AND created_at >= $2", [workspaceId, since])).rows[0] as { n: number };
      expect(total).toBeGreaterThanOrEqual(series.n);
      expect(series.n).toBeGreaterThan(0);
    } finally {
      client.release();
    }
    const { svc: tight } = service({ maxCallsPerDay: 1, maxActiveRuns: 1 });
    expect((await grant(tight, b, { plan: true, batchFrom: null, batchTo: null, final: false })).body).toMatchObject({ error: { code: "SERIES_ACTIVE_RUN_CAP" } });
    await q("UPDATE series_writing_run SET state = 'canceled' WHERE project_id = $1 AND state = 'running'", [a.projectId]);
    await q("UPDATE series_writing_grant SET state = 'canceled' WHERE project_id = $1", [a.projectId]);
    expect(await writingWorkspaceIdle(pool, workspaceId)).toBe(true);
    evidence.activationProbe = { scenario, autoTable: scenario === "testsite", seriesRunning: false, idleAfter: true };
    expect((await grant(tight, b, { plan: true, batchFrom: null, batchTo: null, final: false })).body).toMatchObject({ error: { code: "SERIES_DAILY_QUOTA_LOW" } });
  });

  it("1. a person's plan revision saves a new story DRAFT in the same transaction; reviewed and approved, the batch is placed from it", async () => {
    plan = {};
    const { svc, settle } = service();
    const view = await createSeries(svc, 6);
    await grant(svc, view, { plan: true, batchFrom: 1, batchTo: 1, final: false });
    await settle();
    const oldStory = await approveCurrentStory(view.projectId);
    const page = viewOf((await svc.get(view.projectId)).body);
    const content = structuredClone(page.plan!.content);
    content.setting.logline = "人工改写后的一句话故事";
    // Another page saved a story first: a conflict, nothing written.
    const other = (await q<{ version: number }>("SELECT version FROM project WHERE id = $1", [view.projectId]))[0]!.version;
    const raced = await textChain.createStoryRevision({ workspaceId, projectId: view.projectId, content: { text: "另一页面的故事" }, createdBy: "another-page", expectedVersion: other });
    const storiesBefore = (await q<{ n: number }>("SELECT count(*)::int AS n FROM story_revision WHERE project_id = $1", [view.projectId]))[0]!.n;
    expect((await svc.savePlan(view.projectId, { basePlanRevisionId: page.plan!.revisionId, baseStoryRevisionId: oldStory, content }, ctx("p1"))).body)
      .toMatchObject({ error: { code: "SERIES_STORY_CONFLICT" } });
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM story_revision WHERE project_id = $1", [view.projectId]))[0]!.n).toBe(storiesBefore);
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM series_writing_plan_revision WHERE series_id = $1", [view.seriesId]))[0]!.n).toBe(1);
    const saved = viewOf((await svc.savePlan(view.projectId, { basePlanRevisionId: page.plan!.revisionId, baseStoryRevisionId: raced.revisionId, content }, ctx("p2"))).body);
    expect(saved.plan).toMatchObject({ revisionNo: 2, origin: "manual", status: "unreviewed", storySave: "saved" });
    const story = (await q<{ id: string; review_status: string; created_by: string; content_json: { text: string } }>(
      "SELECT id, review_status, created_by, content_json FROM story_revision WHERE id = $1", [saved.plan!.storyRevisionId]))[0]!;
    expect(story).toMatchObject({ review_status: "DRAFT", created_by: "server-owner" });
    expect(story.content_json.text).toContain(saved.plan!.revisionId);
    expect((await q<{ current_story_revision_id: string }>("SELECT current_story_revision_id FROM project WHERE id = $1", [view.projectId]))[0]!.current_story_revision_id).toBe(story.id);
    expect(viewOf((await svc.decide(view.projectId, { target: "plan", note: "已复核人工规划", expectedBasis: saved.plan!.decisionBasis }, ctx("d"))).body).plan!.status).toBe("cleared");
    expect(await approveCurrentStory(view.projectId)).toBe(story.id);
    // The batch was written on plan revision 1: nothing is placed until its ledger and review are current again (round 3, 5).
    expect((await svc.placeBatch(view.projectId, 1, {}, ctx("place"))).body).toMatchObject({ error: { code: "SERIES_NOT_READY", details: { reason: "ledger_stale" } } });
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM script_revision WHERE project_id = $1", [view.projectId]))[0]!.n).toBe(0);
    let current = viewOf((await svc.get(view.projectId)).body);
    const batch = current.batches[0]!;
    current = viewOf((await svc.saveLedger(view.projectId, { batchNo: 1, baseLedgerRevisionId: batch.ledger.revision!.id, content: batch.ledger.revision!.content,
      summaries: current.episodes.slice(0, 3).map((item) => ({ episodeNo: item.episodeNo, summary: "人工确认的概要" })), expectedBasis: batch.ledgerBasis }, ctx("l"))).body);
    expect((await svc.decide(view.projectId, { target: "batch:1", note: "按新规划复核", expectedBasis: current.batches[0]!.decisionBasis }, ctx("db"))).status).toBe(201);
    expect((await svc.placeBatch(view.projectId, 1, {}, ctx("place"))).body).toMatchObject({ placed: 3, conflicts: [] });
    const scripts = await q<{ review_status: string; source_story_revision_id: string }>("SELECT review_status, source_story_revision_id FROM script_revision WHERE project_id = $1",
      [view.projectId]);
    expect(scripts).toHaveLength(3);
    expect(scripts.every((row) => row.review_status === "DRAFT" && row.source_story_revision_id === story.id)).toBe(true);
    // The earlier plan revision, the earlier stories and their review records stay.
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM series_writing_plan_revision WHERE series_id = $1", [view.seriesId]))[0]!.n).toBe(2);
    expect((await q<{ review_status: string }>("SELECT review_status FROM story_revision WHERE id = $1", [oldStory]))[0]!.review_status).toBe("APPROVED");
    evidence.manualPlanStory = { storyRevisionId: story.id, placed: 3 };
  });

  it("2. a later batch's review read the ledger before it: a changed ledger makes it stale until a person reviews it on the full basis", async () => {
    plan = {};
    const { svc, settle } = service();
    const view = await createSeries(svc, 9);
    await grant(svc, view, { plan: true, batchFrom: 1, batchTo: 2, final: false });
    await settle();
    const confirm = async (batchNo: number, change: boolean) => {
      const now = viewOf((await svc.get(view.projectId)).body);
      const batch = now.batches[batchNo - 1]!;
      const content = structuredClone(batch.ledger.revision!.content);
      if (change) content.props = content.props.map((item) => ({ ...item, state: "人工改过的状态" }));
      const saved = await svc.saveLedger(view.projectId, { batchNo, baseLedgerRevisionId: batch.ledger.revision!.id, content,
        summaries: now.episodes.slice(batch.first - 1, batch.last).map((item) => ({ episodeNo: item.episodeNo, summary: "人工确认的概要" })),
        expectedBasis: batch.ledgerBasis }, ctx("l"));
      expect(saved.status).toBe(201);
      return viewOf(saved.body);
    };
    await confirm(1, true);
    let current = await confirm(2, false);
    expect(current.batches[1]!.review.status).toBe("stale");
    expect(current.next.blockers).toEqual(["batch_review_stale:2"]);
    const sent = seen.length;
    expect((await grant(svc, current, { plan: false, batchFrom: 3, batchTo: 3, final: false })).body).toMatchObject({ error: { code: "SERIES_BLOCKED" } });
    current = viewOf((await svc.decide(view.projectId, { target: "batch:2", note: "已按新台账复核第 2 批", expectedBasis: current.batches[1]!.decisionBasis }, ctx("d"))).body);
    expect(current.batches[1]!.review.status).toBe("cleared");
    const basis = (await q<{ basis_json: Record<string, string> }>("SELECT basis_json FROM series_writing_decision WHERE series_id = $1 AND target = 'batch:2'", [view.seriesId]))[0]!.basis_json;
    expect(Object.keys(basis).sort()).toEqual(["baseLedger", "episode:4", "episode:5", "episode:6", "ledger", "plan", "story"]);
    expect(seen.length).toBe(sent);
    expect((await grant(svc, current, { plan: false, batchFrom: 3, batchTo: 3, final: false })).status).toBe(201);
    await settle();
    expect(seen.slice(sent).map((item) => item.stage)).toEqual(["episode:7", "episode:8", "episode:9", "batch_review:3"]);
  });

  it("3. a story saved in the workbench stops a running job before its next send, a resume and a new grant; the series goes on only after plan and story are bound again", async () => {
    plan = {};
    const { svc, settle } = service();
    const view = await createSeries(svc, 9);
    await grant(svc, view, { plan: true, batchFrom: 1, batchTo: 1, final: false });
    await settle();
    // A job of batches 2–3 is created (running), then the story is replaced before it sends anything.
    expect((await grant(svc, viewOf((await svc.get(view.projectId)).body), { plan: false, batchFrom: 2, batchTo: 3, final: false })).status).toBe(201);
    const version = (await q<{ version: number }>("SELECT version FROM project WHERE id = $1", [view.projectId]))[0]!.version;
    await textChain.createStoryRevision({ workspaceId, projectId: view.projectId, content: { text: "工作台人工另存的故事" }, createdBy: "acceptance-person", expectedVersion: version });
    const sent = seen.length;
    await settle();
    let current = viewOf((await svc.get(view.projectId)).body);
    expect(seen.length).toBe(sent);
    expect(current.story.status).toBe("changed");
    const stopped = current.grants.find((item) => item.scope.batchFrom === 2)!;
    expect(stopped).toMatchObject({ state: "stopped", stopReason: "upstream_story_changed" });
    expect((await svc.resume(view.projectId, stopped.grantId, {}, TOKEN, ctx(randomUUID()))).body)
      .toMatchObject({ error: { code: "SERIES_UPSTREAM_CHANGED" } });
    expect((await grant(svc, current, { plan: false, batchFrom: 2, batchTo: 2, final: false })).body).toMatchObject({ error: { code: "SERIES_BLOCKED" } });
    await settle();
    expect(seen.length).toBe(sent);
    // Bound again (the workbench story adopted): plan review, ledger confirmation and the batch review, then batch 2 is written.
    current = viewOf((await svc.savePlan(view.projectId, { basePlanRevisionId: current.plan!.revisionId, baseStoryRevisionId: current.story.current!.revisionId,
      story: "adopt_current", content: current.plan!.content }, ctx("adopt"))).body);
    expect(current.story.status).toBe("ok");
    current = viewOf((await svc.decide(view.projectId, { target: "plan", note: "采用工作台故事", expectedBasis: current.plan!.decisionBasis }, ctx("dp"))).body);
    const batch = current.batches[0]!;
    current = viewOf((await svc.saveLedger(view.projectId, { batchNo: 1, baseLedgerRevisionId: batch.ledger.revision!.id, content: batch.ledger.revision!.content,
      summaries: current.episodes.slice(0, 3).map((item) => ({ episodeNo: item.episodeNo, summary: "人工确认的概要" })), expectedBasis: batch.ledgerBasis }, ctx("l1"))).body);
    current = viewOf((await svc.decide(view.projectId, { target: "batch:1", note: "按采用的故事复核", expectedBasis: current.batches[0]!.decisionBasis }, ctx("d1"))).body);
    expect(current.next).toMatchObject({ batchNo: 2, blockers: [] });
    expect(seen.length).toBe(sent);
    expect((await grant(svc, current, { plan: false, batchFrom: 2, batchTo: 2, final: false })).status).toBe(201);
    await settle();
    expect(seen.slice(sent).map((item) => item.stage)).toEqual(["episode:4", "episode:5", "episode:6", "batch_review:2"]);
    const job = (await q<{ input_json: { storyRevisionId: string } }>("SELECT input_json FROM series_writing_run WHERE series_id = $1 ORDER BY job_seq DESC LIMIT 1", [view.seriesId]))[0]!;
    expect(job.input_json.storyRevisionId).toBe(current.story.current!.revisionId);
  });

  it("4. a review from a page that saw older versions is refused for the plan, a batch and the final review; nothing is recorded", async () => {
    plan = {};
    const { svc, settle } = service();
    const view = await createSeries(svc, 3);
    await grant(svc, view, { plan: true, batchFrom: 1, batchTo: 1, final: true });
    await settle();
    const pageA = viewOf((await svc.get(view.projectId)).body);
    const decisions = async () => (await q<{ n: number }>("SELECT count(*)::int AS n FROM series_writing_decision WHERE series_id = $1", [view.seriesId]))[0]!.n;
    // Page B changes the ledger of the only batch: the batch and the final review A saw are no longer current.
    const batch = pageA.batches[0]!;
    const content = structuredClone(batch.ledger.revision!.content);
    content.props = content.props.map((item) => ({ ...item, state: "B 页面改过" }));
    expect((await svc.saveLedger(view.projectId, { batchNo: 1, baseLedgerRevisionId: batch.ledger.revision!.id, content,
      summaries: pageA.episodes.map((item) => ({ episodeNo: item.episodeNo, summary: "B 页面确认" })), expectedBasis: batch.ledgerBasis }, ctx("lb"))).status).toBe(201);
    expect((await svc.decide(view.projectId, { target: "batch:1", note: "A 复核", expectedBasis: pageA.batches[0]!.decisionBasis }, ctx("a1"))).body)
      .toMatchObject({ error: { code: "SERIES_DECISION_STALE" } });
    expect((await svc.decide(view.projectId, { target: "final", note: "A 复核", expectedBasis: pageA.final.decisionBasis }, ctx("a2"))).body)
      .toMatchObject({ error: { code: "SERIES_DECISION_STALE" } });
    // Page B saves a plan revision: A's plan review is refused as well.
    const pageB = viewOf((await svc.get(view.projectId)).body);
    expect((await svc.savePlan(view.projectId, { basePlanRevisionId: pageB.plan!.revisionId, baseStoryRevisionId: pageB.story.current!.revisionId,
      content: pageB.plan!.content }, ctx("pb"))).status).toBe(201);
    expect((await svc.decide(view.projectId, { target: "plan", note: "A 复核", expectedBasis: pageA.plan!.decisionBasis }, ctx("a3"))).body)
      .toMatchObject({ error: { code: "SERIES_DECISION_STALE" } });
    expect(await decisions()).toBe(0);
    const latest = viewOf((await svc.get(view.projectId)).body);
    expect(latest.plan!.status).toBe("unreviewed");
    expect((await svc.decide(view.projectId, { target: "plan", note: "B 复核", expectedBasis: latest.plan!.decisionBasis }, ctx("b1"))).status).toBe(201);
    expect(await decisions()).toBe(1);
  });

  it("5. the current package carries the workbench's actual story text, its hash and review state, apart from the approved one", async () => {
    plan = {};
    const { svc, settle } = service();
    const view = await createSeries(svc, 3);
    await grant(svc, view, { plan: true, batchFrom: 1, batchTo: 1, final: false });
    await settle();
    const planStory = await approveCurrentStory(view.projectId);
    const version = (await q<{ version: number }>("SELECT version FROM project WHERE id = $1", [view.projectId]))[0]!.version;
    await textChain.createStoryRevision({ workspaceId, projectId: view.projectId, content: { text: "工作台人工修改后的故事正文" }, createdBy: "acceptance-person", expectedVersion: version });
    const pack = JSON.parse((await svc.package(view.projectId, "json")).download!.text) as { story: { binding: string;
      current: { text: string; reviewStatus: string; relationToPlan: string }; approved: { revisionId: string; relationToPlan: string } } };
    expect(pack.story.binding).toBe("changed");
    expect(pack.story.current).toMatchObject({ text: "工作台人工修改后的故事正文", reviewStatus: "DRAFT", relationToPlan: "not_plan_story" });
    expect(pack.story.approved).toMatchObject({ revisionId: planStory, relationToPlan: "plan_story" });
    const markdown = (await svc.package(view.projectId, "markdown")).download!.text;
    expect(markdown).toContain("工作台人工修改后的故事正文");
    expect(markdown).toContain("已批准故事");
  });

  it("6. a reservation lost before its send is given back: the batch finishes within its own budget and the daily count agrees", async () => {
    plan = {};
    let now = FIXED.getTime();
    const { svc, settle, engine } = service({ clock: () => new Date(now) });
    const view = await createSeries(svc, 3);
    await grant(svc, view, { plan: true, batchFrom: null, batchTo: null, final: false });
    await settle();
    expect((await grant(svc, viewOf((await svc.get(view.projectId)).body), { plan: false, batchFrom: 1, batchTo: 1, final: false })).status).toBe(201);
    const job = (await q<{ id: string; grant_id: string }>("SELECT id, grant_id FROM series_writing_run WHERE series_id = $1 AND job_kind = 'batch'", [view.seriesId]))[0]!;
    const nowIso = new Date(now).toISOString();
    const lease = new Date(now + 1_000).toISOString();
    expect(await store.claimJob(workspaceId, job.id, "dead", nowIso, lease)).toBe(true);
    const callId = randomUUID();
    expect(await store.reserveCall({ id: callId, runId: job.id, grantId: job.grant_id, seriesId: view.seriesId, workspaceId, stageKey: "episode:1", attemptNo: 1,
      providerKey: "deepseek", model: "deepseek-flash", requestHash: "0".repeat(64), state: "reserved", executorId: "dead", providerRequestId: null, responseModel: null,
      usage: { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null }, errorCode: null, createdAt: nowIso, finishedAt: null },
    { sinceIso: new Date(now - 86_400_000).toISOString(), maxCallsPerDay: 1_000 }, nowIso, lease)).toEqual({ kind: "reserved" });
    const daily = async () => {
      const client = await pool.connect();
      try {
        return await recentWritingCalls(client, workspaceId, new Date(now - 86_400_000).toISOString());
      } finally {
        client.release();
      }
    };
    const dailyReserved = await daily();
    now += 5_000;
    expect(await store.recoverExpired(workspaceId, new Date(now).toISOString())).toBe(1);
    expect(await store.recoverExpired(workspaceId, new Date(now).toISOString())).toBe(0);
    expect(await daily()).toBe(dailyReserved - 1);
    expect((await q<{ calls_used: number }>("SELECT calls_used FROM series_writing_grant WHERE id = $1", [job.grant_id]))[0]!.calls_used).toBe(0);
    expect(await store.markCallSubmitted(workspaceId, callId, "dead", new Date(now).toISOString(), new Date(now + 600_000).toISOString())).toBe("lost");
    const sent = seen.length;
    await engine.maintain();
    expect(seen.length - sent).toBe(4);
    const current = viewOf((await svc.get(view.projectId)).body);
    expect(current.grants.find((item) => item.grantId === job.grant_id)).toMatchObject({ state: "completed", callsUsed: 4, callBudget: 4 });
    expect((await q<{ state: string; error_code: string }>("SELECT state, error_code FROM series_writing_call WHERE id = $1", [callId]))[0])
      .toEqual({ state: "rejected", error_code: "executor_lost_before_send" });
    expect(await daily()).toBe(dailyReserved - 1 + 4);
    evidence.lostBeforeSend = { sends: seen.length - sent, callsUsed: 4 };
  });

  it("round 2, 1. a ledger editor opened before another page saved a script of the batch is refused; nothing is written; opened again it saves", async () => {
    plan = {};
    const { svc, settle } = service();
    const view = await createSeries(svc, 6);
    await grant(svc, view, { plan: true, batchFrom: 1, batchTo: 1, final: false });
    await settle();
    const storyId = await approveCurrentStory(view.projectId);
    expect((await svc.placeBatch(view.projectId, 1, {}, ctx("place"))).body).toMatchObject({ placed: 3 });
    const editScript = async (text: string) => {
      const episode = (await q<{ id: string; row_version: number }>("SELECT id, row_version FROM episode WHERE project_id = $1 AND episode_no = 2", [view.projectId]))[0]!;
      await textChain.createScriptRevision({ workspaceId, projectId: view.projectId, episodeId: episode.id, sourceStoryRevisionId: storyId,
        content: { text }, createdBy: "acceptance-person", expectedVersion: episode.row_version });
    };
    await editScript("A 页面看到的第 2 集");
    const pageA = viewOf((await svc.get(view.projectId)).body);
    await editScript("B 页面另存的第 2 集");
    const ledgers = async () => (await q<{ n: number }>("SELECT count(*)::int AS n FROM series_writing_ledger_revision WHERE series_id = $1", [view.seriesId]))[0]!.n;
    const before = await ledgers();
    const body = (opened: SeriesView) => ({ batchNo: 1, baseLedgerRevisionId: opened.batches[0]!.ledger.revision!.id, content: opened.batches[0]!.ledger.revision!.content,
      summaries: opened.episodes.slice(0, 3).map((item) => ({ episodeNo: item.episodeNo, summary: "A 页面写的概要" })), expectedBasis: opened.batches[0]!.ledgerBasis });
    expect((await svc.saveLedger(view.projectId, body(pageA), ctx("la"))).body).toMatchObject({ error: { code: "SERIES_LEDGER_STALE" } });
    expect(await ledgers()).toBe(before);
    const fresh = viewOf((await svc.get(view.projectId)).body);
    expect(fresh.batches[0]!.ledger.status).toBe("pending_confirmation");
    expect((await svc.saveLedger(view.projectId, body(fresh), ctx("lb"))).status).toBe(201);
    const saved = (await q<{ summaries_json: Array<{ episodeNo: number; versionHash: string }> }>(
      "SELECT summaries_json FROM series_writing_ledger_revision WHERE series_id = $1 ORDER BY batch_no, revision_no DESC LIMIT 1", [view.seriesId]))[0]!;
    expect(saved.summaries_json.find((item) => item.episodeNo === 2)!.versionHash).toBe(fresh.batches[0]!.ledgerBasis!["episode:2"]);
  });

  it("round 2, 2. a story saved after the series was text complete revokes the completion; the old final review is kept but no longer valid; no review bypasses it", async () => {
    plan = {};
    const { svc, settle } = service();
    const view = await createSeries(svc, 3);
    await grant(svc, view, { plan: true, batchFrom: 1, batchTo: 1, final: true });
    await settle();
    const done = viewOf((await svc.get(view.projectId)).body);
    expect(done.completion).toBe("text_complete");
    const finalOutput = async () => (await q<{ output_json: unknown; output_hash: string }>(
      "SELECT s.output_json, s.output_hash FROM series_writing_stage s JOIN series_writing_run r ON r.id = s.run_id WHERE r.series_id = $1 AND s.stage_key = 'final_review'",
      [view.seriesId]))[0]!;
    const kept = await finalOutput();
    const version = (await q<{ version: number }>("SELECT version FROM project WHERE id = $1", [view.projectId]))[0]!.version;
    await textChain.createStoryRevision({ workspaceId, projectId: view.projectId, content: { text: "工作台另存的新故事" }, createdBy: "acceptance-person", expectedVersion: version });
    const after = viewOf((await svc.get(view.projectId)).body);
    expect(after).toMatchObject({ completion: "partial", final: { status: "stale", previousPassed: true, decisionBasis: null } });
    expect(after.attention).toEqual(expect.arrayContaining(["story_changed"]));
    expect(await finalOutput()).toEqual(kept);
    expect((await svc.decide(view.projectId, { target: "final", note: "想直接复核", expectedBasis: done.final.decisionBasis }, ctx("df"))).status).toBe(409);
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM series_writing_decision WHERE series_id = $1", [view.seriesId]))[0]!.n).toBe(0);
    const pack = JSON.parse((await svc.package(view.projectId, "json")).download!.text) as { completion: { level: string; attention: string[] }; finalReview: { status: string } };
    expect(pack.completion.level).toBe("partial");
    expect(pack.completion.attention).toContain("story_changed");
    expect(pack.finalReview.status).toBe("stale");
    expect((await svc.package(view.projectId, "markdown")).download!.text).toContain("待办：story_changed");
  });

  it("a series work with an approved source chain is refused at every single-shot media entry and on retry, before anything is written; a short work is not", async () => {
    const studio = new StudioService(new JobPersistenceService(pool), runtime, textChain, workspaceId, undefined, new MediaAssetStore(pool), true,
      await mkdtemp(join(tmpdir(), "series-media-")), true, true);
    for (const capability of ["image.generate", "video.generate", "audio.tts", "subtitle.generate", "audio.music"]) {
      await q(`INSERT INTO provider_configuration (workspace_id, provider_key, capability, default_timeout_ms) VALUES ($1, 'mock-media', $2, 30000)
        ON CONFLICT (workspace_id, provider_key, capability) DO NOTHING`, [workspaceId, capability]);
    }
    const counts = async (projectId: string) => (await q<{ jobs: number; assets: number; attempts: number; workflows: number; keys: number }>(
      `SELECT (SELECT count(*)::int FROM generation_job WHERE project_id = $1) AS jobs, (SELECT count(*)::int FROM asset WHERE project_id = $1) AS assets,
              (SELECT count(*)::int FROM job_attempt a JOIN generation_job j ON j.id = a.generation_job_id WHERE j.project_id = $1) AS attempts,
              (SELECT count(*)::int FROM workflow_run WHERE project_id = $1) AS workflows,
              (SELECT count(*)::int FROM idempotency_record WHERE workspace_id = $2) AS keys`, [projectId, workspaceId]))[0]!;
    const entries = [
      (shot: string, key: string) => studio.generateShotImage(shot, {}, ctx(key)),
      (shot: string, key: string) => studio.generateShotVideo(shot, {}, ctx(key)),
      (shot: string, key: string) => studio.generateShotTts(shot, {}, ctx(key)),
      (shot: string, key: string) => studio.generateShotSubtitle(shot, {}, ctx(key)),
      (shot: string, key: string) => studio.generateShotMusic(shot, {}, ctx(key)),
    ];
    const seriesShot = await seedApprovedShot("series");
    const before = await counts(seriesShot.projectId);
    for (const [index, entry] of entries.entries()) {
      await expect(entry(seriesShot.shotRevisionId, `series-media-${String(index)}`)).rejects.toMatchObject({ code: "SERIES_MEDIA_NOT_ENABLED" });
    }
    expect(await counts(seriesShot.projectId)).toEqual(before);
    // The same entries on a short-drama work with the same chain queue their jobs as before.
    const shortShot = await seedApprovedShot("short");
    for (const [index, entry] of entries.entries()) {
      expect((await entry(shortShot.shotRevisionId, `short-media-${String(index)}`)).status).toBe(202);
    }
    // Retry reuses the generation gate: a canceled job of a work that is (now) a series work is refused, and retried once it is short again.
    const job = (await q<{ id: string }>("SELECT id FROM generation_job WHERE project_id = $1 AND kind = 'MEDIA_IMAGE'", [shortShot.projectId]))[0]!.id;
    await studio.cancelJob(job, ctx("short-media-cancel"));
    await q("UPDATE project SET writing_mode = 'series' WHERE id = $1", [shortShot.projectId]);
    const held = await counts(shortShot.projectId);
    await expect(studio.retryJob(job, ctx("series-media-retry"))).rejects.toMatchObject({ code: "SERIES_MEDIA_NOT_ENABLED" });
    expect(await counts(shortShot.projectId)).toEqual(held);
    await q("UPDATE project SET writing_mode = 'short' WHERE id = $1", [shortShot.projectId]);
    expect((await studio.retryJob(job, ctx("short-media-retry"))).status).toBe(202);
    evidence.mediaRefusal = { entries: entries.length, retry: true };
  });

  it("a character reference of a series work is refused at its generation entry, before anything is written; a short work is not; without the reference schema both stay unavailable", async () => {
    const references = new CharacterReferenceStore(pool);
    const studio = new StudioService(new JobPersistenceService(pool), runtime, textChain, workspaceId, undefined, new MediaAssetStore(pool), true,
      await mkdtemp(join(tmpdir(), "series-reference-")), false, false, false, null, false, false, references);
    await q(`INSERT INTO provider_configuration (workspace_id, provider_key, capability, default_timeout_ms) VALUES ($1, 'mock-media', 'image.generate', 30000)
      ON CONFLICT (workspace_id, provider_key, capability) DO NOTHING`, [workspaceId]);
    const character = async (mode: "short" | "series") => {
      const chain = await seedApprovedShot(mode);
      const characterId = (await q<{ id: string }>("INSERT INTO character (workspace_id, project_id, name) VALUES ($1, $2, '林夏') RETURNING id",
        [workspaceId, chain.projectId]))[0]!.id;
      const revision = (await q<{ id: string }>(
        `INSERT INTO character_revision (workspace_id, project_id, character_id, revision_no, content_json, content_hash, created_by)
         VALUES ($1, $2, $3, 1, '{}', $4, 'author') RETURNING id`, [workspaceId, chain.projectId, characterId, "cd".repeat(32)]))[0]!.id;
      await q("INSERT INTO character_revision_script_source (workspace_id, project_id, character_revision_id, script_revision_id) VALUES ($1, $2, $3, $4)",
        [workspaceId, chain.projectId, revision, chain.scriptRevisionId]);
      await q("UPDATE character SET current_revision_id = $1 WHERE id = $2", [revision, characterId]);
      return { projectId: chain.projectId, revision };
    };
    const counts = async (projectId: string) => (await q<{ jobs: number; assets: number; workflows: number }>(
      `SELECT (SELECT count(*)::int FROM generation_job WHERE project_id = $1) AS jobs, (SELECT count(*)::int FROM asset WHERE project_id = $1) AS assets,
              (SELECT count(*)::int FROM workflow_run WHERE project_id = $1) AS workflows`, [projectId]))[0]!;
    const series = await character("series");
    const short = await character("short");
    // The optional reference schema is not installed: both stay unavailable, as before.
    for (const item of [series, short]) {
      await expect(studio.generateCharacterReference(item.revision, {}, ctx(randomUUID()))).rejects.toMatchObject({ code: "CHARACTER_REFERENCE_STORAGE_UNAVAILABLE" });
    }
    // On this disposable database only: the reference draft schema the gate needs.
    await pool.query(await readFile(join(__dirname, "..", "..", "..", "..", "packages", "database", "prisma", "drafts", "20261005000200_character_reference_image.sql"), "utf8"));
    expect(await references.storageReady()).toBe(true);
    const before = await counts(series.projectId);
    await expect(studio.generateCharacterReference(series.revision, {}, ctx("series-reference"))).rejects.toMatchObject({ code: "SERIES_MEDIA_NOT_ENABLED" });
    expect(await counts(series.projectId)).toEqual(before);
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM idempotency_record WHERE idempotency_key = 'series-reference'"))[0]!.n).toBe(0);
    expect((await studio.generateCharacterReference(short.revision, {}, ctx("short-reference"))).status).toBe(202);
    expect((await counts(short.projectId)).jobs).toBe(1);
    evidence.referenceRefusal = { draftSchemaAppliedToDisposableDatabase: true };
  });

  it.runIf(scenario === "testsite")("the short-drama flow still runs 1, 3 and 6 episodes beside series writing, and refuses a series work", async () => {
    const autoStore = new PostgresAutoCreationStore(pool, textChain);
    const autoSeen: unknown[] = [];
    const engine = new AutoCreationEngine({ workspaceId, store: autoStore, providers, transport: autoFixtureTransport({ seen: autoSeen as never }), maxCallsPerDay: 1_000, timeoutMs: 30_000 });
    const pending: Array<() => Promise<void>> = [];
    const auto = new AutoCreationService({ workspaceId, enabled: true, operatorToken: TOKEN, defaultProvider: "deepseek", providers, store: autoStore, engine,
      projects: runtime, maxCallsPerDay: 1_000, maxActiveRuns: 5, research: { fetchEnabled: false, allowedHosts: [] }, schedule: (work) => { pending.push(work); } });
    for (const episodes of [1, 3, 6]) {
      const id = (await q<{ id: string }>("INSERT INTO project (workspace_id, title, episode_count, target_episode_seconds) VALUES ($1, $2, $3, 60) RETURNING id",
        [workspaceId, `短剧 ${String(episodes)} 集`, episodes]))[0]!.id;
      const started = await auto.start(id, {}, TOKEN, ctx(`auto-${String(episodes)}`));
      expect(started.status).toBe(201);
      while (pending.length > 0) await pending.shift()!();
      const run = (await auto.latest(id)).body as { run: { state: string; callsUsed: number } };
      expect(run.run).toMatchObject({ state: "completed", callsUsed: autoCreationNormalCalls(episodes) });
    }
    const { svc } = service();
    const view = await createSeries(svc, 12);
    expect((await auto.start(view.projectId, {}, TOKEN, ctx("auto-series"))).body).toMatchObject({ error: { code: "AUTO_CREATION_SERIES_PROJECT" } });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Round 3 (review of 3335045) on PostgreSQL: the same paths as series-writing.regressions.spec.ts, and the ledger basis
// check against workbench saves on two real connections.

/** A person's script save of one episode through the text chain's own path (project lock, then the episode row). */
async function personScript(projectId: string, storyId: string, episodeNo: number, text: string): Promise<string> {
  const episode = (await q<{ id: string; row_version: number }>("SELECT id, row_version FROM episode WHERE project_id = $1 AND episode_no = $2", [projectId, episodeNo]))[0]!;
  return (await textChain.createScriptRevision({ workspaceId, projectId, episodeId: episode.id, sourceStoryRevisionId: storyId, content: { text },
    createdBy: "acceptance-person", expectedVersion: episode.row_version })).revisionId;
}

const count = async (sql: string, values: unknown[]) => (await q<{ n: number }>(sql, values))[0]!.n;

/** Whether a backend of this database waits on a lock for a statement like the pattern (polled, no fixed sleep). */
async function lockWaiter(pattern: string): Promise<boolean> {
  return (await count(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`, [pattern])) > 0;
}

/**
 * Which comes first: a backend waiting on a lock for the pattern, or the promise settling. Polls until one happens, for
 * at most ten seconds; never sleeps a fixed time to guess the order.
 */
async function waitsOrSettles(pattern: string, work: Promise<unknown>): Promise<"waiting" | "settled"> {
  let settled = false;
  void work.then(() => { settled = true; }, () => { settled = true; });
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (await lockWaiter(pattern)) return "waiting";
    if (settled) return "settled";
    if (Date.now() > deadline) throw new Error(`neither a lock waiter (${pattern}) nor a settled call`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** A pool whose first statement matching the pattern stops, inside its transaction with every lock already held, until released. */
function pausedPool(pattern: RegExp) {
  let notify!: () => void;
  const reached = new Promise<void>((resolve) => { notify = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let armed = true;
  const wrapped = {
    connect: async () => {
      const client = await pool.connect();
      const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      (client as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = async (...args: unknown[]) => {
        const text = typeof args[0] === "string" ? args[0] : "";
        if (armed && pattern.test(text)) {
          armed = false;
          notify();
          await released;
        }
        return query(...args);
      };
      const original = client.release.bind(client);
      client.release = (...releaseArgs: Parameters<typeof original>) => {
        (client as unknown as { query: unknown }).query = query;
        client.release = original;
        return original(...releaseArgs);
      };
      return client;
    },
  };
  return { pool: wrapped, reached, release: () => release() };
}

const PROJECT_LOCK = "SELECT % FROM project WHERE id = $1 AND workspace_id = $2 FOR UPDATE%";

describe(`round 3 on PostgreSQL (${scenario} schema)`, () => {
  it("1. episode 3 refused with no resend left and written by a person: a new grant sends only episode 3 and the batch review; after the checks batch 2 follows", async () => {
    plan = {};
    const { svc, settle } = service();
    const view = await createSeries(svc, 6);
    rejectNext = "episode:3";
    await grant(svc, view, { plan: true, batchFrom: 1, batchTo: 1, final: false });
    await settle();
    let current = viewOf((await svc.get(view.projectId)).body);
    const old = current.grants[0]!;
    expect(old.state).toBe("stopped");
    expect((await svc.resume(view.projectId, old.grantId, {}, TOKEN, ctx(randomUUID()))).body).toMatchObject({ error: { code: "SERIES_BUDGET_EXHAUSTED" } });
    const storyId = await approveCurrentStory(view.projectId);
    const scriptId = await personScript(view.projectId, storyId, 3, "人工补写的第 3 集");
    current = viewOf((await svc.get(view.projectId)).body);
    expect(current.next.batchNo).toBe(1);
    const sent = seen.length;
    expect((await grant(svc, current, { plan: false, batchFrom: 1, batchTo: 1, final: false })).status).toBe(201);
    await settle();
    expect(seen.slice(sent).map((item) => item.stage)).toEqual(["episode:3", "batch_review:1"]);
    current = viewOf((await svc.get(view.projectId)).body);
    expect(current.episodes[2]!.version).toMatchObject({ kind: "script" });
    expect(current.next).toMatchObject({ batchNo: 2, blockers: ["ledger_pending_confirmation:1", "batch_review_stale:1"] });
    const batch = current.batches[0]!;
    current = viewOf((await svc.saveLedger(view.projectId, { batchNo: 1, baseLedgerRevisionId: batch.ledger.revision!.id, content: batch.ledger.revision!.content,
      summaries: current.episodes.slice(0, 3).map((item) => ({ episodeNo: item.episodeNo, summary: "人工确认的概要" })), expectedBasis: batch.ledgerBasis }, ctx("l"))).body);
    current = viewOf((await svc.decide(view.projectId, { target: "batch:1", note: "人工复核补写的第 3 集", expectedBasis: current.batches[0]!.decisionBasis }, ctx("d"))).body);
    expect(current.next).toEqual({ batchNo: 2, blockers: [] });
    const before2 = seen.length;
    expect((await grant(svc, current, { plan: false, batchFrom: 2, batchTo: 2, final: false })).status).toBe(201);
    await settle();
    expect(seen.slice(before2).map((item) => item.stage)).toEqual(["episode:4", "episode:5", "episode:6", "batch_review:2"]);
    expect((await q<{ current_script_revision_id: string }>("SELECT current_script_revision_id FROM episode WHERE project_id = $1 AND episode_no = 3", [view.projectId]))[0]!
      .current_script_revision_id).toBe(scriptId);
    expect((await q<{ state: string }>("SELECT state FROM series_writing_run WHERE series_id = $1 AND job_kind = 'batch' AND batch_no = 1 ORDER BY job_seq", [view.seriesId]))
      .map((row) => row.state)).toEqual(["partial", "completed"]);
  });

  it("2. a plan grant superseded by a later grant's plan is refused on resume: no send, no job, no second plan, the story binding stays", async () => {
    plan = {};
    const { svc, settle } = service();
    const view = await createSeries(svc, 6);
    rejectNext = "setting";
    await grant(svc, view, { plan: true, batchFrom: null, batchTo: null, final: false }, randomUUID(), 1);
    await settle();
    let current = viewOf((await svc.get(view.projectId)).body);
    const old = current.grants[0]!;
    expect((await grant(svc, current, { plan: true, batchFrom: null, batchTo: null, final: false }, randomUUID(), 1)).status).toBe(201);
    await settle();
    const sent = seen.length;
    const runs = await count("SELECT count(*)::int AS n FROM series_writing_run WHERE series_id = $1", [view.seriesId]);
    const resumed = await svc.resume(view.projectId, old.grantId, {}, TOKEN, ctx(randomUUID()));
    await settle();
    expect(resumed.body).toMatchObject({ error: { code: "SERIES_UPSTREAM_CHANGED", details: { reason: "upstream_plan_superseded" } } });
    expect(seen.length).toBe(sent);
    expect(await count("SELECT count(*)::int AS n FROM series_writing_run WHERE series_id = $1", [view.seriesId])).toBe(runs);
    expect(await count("SELECT count(*)::int AS n FROM series_writing_plan_revision WHERE series_id = $1", [view.seriesId])).toBe(1);
    expect(await count("SELECT count(*)::int AS n FROM series_writing_resume WHERE grant_id = $1", [old.grantId])).toBe(0);
    current = viewOf((await svc.get(view.projectId)).body);
    expect(current.story.status).toBe("ok");
    expect(current.grants.find((item) => item.grantId === old.grantId)).toMatchObject({ state: "stopped", callsUsed: old.callsUsed });
  });

  it("3. a new plan job that takes over sources, research and directions may send exactly the other 4 stages", async () => {
    plan = {};
    const { svc, settle } = service();
    const view = await createSeries(svc, 6);
    rejectNext = "setting";
    await grant(svc, view, { plan: true, batchFrom: null, batchTo: null, final: false });
    await settle();
    const sent = seen.length;
    expect((await grant(svc, viewOf((await svc.get(view.projectId)).body), { plan: true, batchFrom: null, batchTo: null, final: false })).status).toBe(201);
    await settle();
    expect(seen.slice(sent).map((item) => item.stage)).toEqual(["setting", "arc", "outline:1", "plan_review"]);
    const run = (await q<{ call_cap: number; calls_used: number; state: string }>(
      "SELECT call_cap, calls_used, state FROM series_writing_run WHERE series_id = $1 ORDER BY job_seq DESC LIMIT 1", [view.seriesId]))[0]!;
    expect(run).toEqual({ call_cap: 4, calls_used: 4, state: "completed" });
    expect(await count("SELECT count(*)::int AS n FROM series_writing_call WHERE series_id = $1 AND stage_key = 'sources'", [view.seriesId])).toBe(0);
  });

  it("4. placement records the episode a person's script holds as a conflict, writes the others once, and leaves nothing to do", async () => {
    plan = {};
    const { svc, settle } = service();
    const view = await createSeries(svc, 6);
    await grant(svc, view, { plan: true, batchFrom: 1, batchTo: 1, final: false });
    await settle();
    const storyId = await approveCurrentStory(view.projectId);
    const scriptId = await personScript(view.projectId, storyId, 2, "人工先写的第 2 集");
    let current = viewOf((await svc.get(view.projectId)).body);
    const batch = current.batches[0]!;
    current = viewOf((await svc.saveLedger(view.projectId, { batchNo: 1, baseLedgerRevisionId: batch.ledger.revision!.id, content: batch.ledger.revision!.content,
      summaries: current.episodes.slice(0, 3).map((item) => ({ episodeNo: item.episodeNo, summary: "人工确认的概要" })), expectedBasis: batch.ledgerBasis }, ctx("l"))).body);
    expect((await svc.decide(view.projectId, { target: "batch:1", note: "复核", expectedBasis: current.batches[0]!.decisionBasis }, ctx("d"))).status).toBe(201);
    const placed = await svc.placeBatch(view.projectId, 1, {}, ctx("p"));
    expect(placed.body).toMatchObject({ placed: 2, conflicts: [2] });
    expect(viewOf(placed.body).batches[0]).toMatchObject({ placed: 2, conflicts: 1, placement: "nothing_to_place" });
    expect((await svc.placeBatch(view.projectId, 1, {}, ctx("p"))).body).toMatchObject({ placed: 0, conflicts: [] });
    expect(await count("SELECT count(*)::int AS n FROM script_revision WHERE project_id = $1", [view.projectId])).toBe(3);
    expect((await q<{ current_script_revision_id: string }>("SELECT current_script_revision_id FROM episode WHERE project_id = $1 AND episode_no = 2", [view.projectId]))[0]!
      .current_script_revision_id).toBe(scriptId);
    expect((await q<{ script_save: string }>(
      "SELECT s.script_save FROM series_writing_stage s JOIN series_writing_run r ON r.id = s.run_id WHERE r.series_id = $1 AND s.stage_key = 'episode:2'", [view.seriesId]))
      .map((row) => row.script_save)).toEqual(["conflict"]);
  });

  it("5. after a manual plan renames a person, placement writes nothing until ledger and review are current, then uses the batch's own plan text", async () => {
    plan = {};
    const { svc, settle } = service();
    const view = await createSeries(svc, 6);
    await grant(svc, view, { plan: true, batchFrom: 1, batchTo: 1, final: false });
    await settle();
    await approveCurrentStory(view.projectId);
    let current = viewOf((await svc.get(view.projectId)).body);
    const content = structuredClone(current.plan!.content);
    content.setting.characters = content.setting.characters.map((item) => item.id === "C1" ? { ...item, name: "林大满" } : item);
    current = viewOf((await svc.savePlan(view.projectId, { basePlanRevisionId: current.plan!.revisionId, baseStoryRevisionId: current.story.current!.revisionId,
      story: "adopt_current", content }, ctx("plan"))).body);
    expect((await svc.placeBatch(view.projectId, 1, {}, ctx("p"))).body).toMatchObject({ error: { code: "SERIES_NOT_READY" } });
    expect(await count("SELECT count(*)::int AS n FROM script_revision WHERE project_id = $1", [view.projectId])).toBe(0);
    const batch = current.batches[0]!;
    current = viewOf((await svc.saveLedger(view.projectId, { batchNo: 1, baseLedgerRevisionId: batch.ledger.revision!.id, content: batch.ledger.revision!.content,
      summaries: current.episodes.slice(0, 3).map((item) => ({ episodeNo: item.episodeNo, summary: "人工确认的概要" })), expectedBasis: batch.ledgerBasis }, ctx("l"))).body);
    expect((await svc.decide(view.projectId, { target: "batch:1", note: "按新规划复核", expectedBasis: current.batches[0]!.decisionBasis }, ctx("d"))).status).toBe(201);
    expect((await svc.placeBatch(view.projectId, 1, {}, ctx("p"))).body).toMatchObject({ placed: 3 });
    const texts = (await q<{ content_json: { text: string } }>("SELECT content_json FROM script_revision WHERE project_id = $1", [view.projectId])).map((row) => row.content_json.text);
    expect(texts).toHaveLength(3);
    expect(texts.every((text) => text.includes("林小满") && !text.includes("林大满"))).toBe(true);
  });

  async function confirmableBatch() {
    plan = {};
    const { svc, settle } = service();
    const view = await createSeries(svc, 6);
    await grant(svc, view, { plan: true, batchFrom: 1, batchTo: 1, final: false });
    await settle();
    const storyId = await approveCurrentStory(view.projectId);
    expect((await svc.placeBatch(view.projectId, 1, {}, ctx("p"))).body).toMatchObject({ placed: 3 });
    await personScript(view.projectId, storyId, 2, "人工修改后的第 2 集");
    const opened = viewOf((await svc.get(view.projectId)).body);
    const batch = opened.batches[0]!;
    const body = { batchNo: 1, baseLedgerRevisionId: batch.ledger.revision!.id, content: batch.ledger.revision!.content,
      summaries: opened.episodes.slice(0, 3).map((item) => ({ episodeNo: item.episodeNo, summary: "人工确认的概要" })), expectedBasis: batch.ledgerBasis };
    const ledgers = () => count("SELECT count(*)::int AS n FROM series_writing_ledger_revision WHERE series_id = $1", [view.seriesId]);
    return { view, storyId, opened, body, ledgers };
  }

  it("8a. a workbench save holding its locks first: the ledger save waits for it, then refuses the obsolete basis; nothing is written", async () => {
    const { view, storyId, body, ledgers } = await confirmableBatch();
    const { svc } = service();
    const before = await ledgers();
    const episode = (await q<{ id: string; row_version: number }>("SELECT id, row_version FROM episode WHERE project_id = $1 AND episode_no = 2", [view.projectId]))[0]!;
    const workbench = await pool.connect();
    try {
      await workbench.query("BEGIN");
      await textChain.createScriptRevisionInTransaction(workbench, { workspaceId, projectId: view.projectId, episodeId: episode.id, sourceStoryRevisionId: storyId,
        content: { text: "工作台并发另存的第 2 集" }, createdBy: "acceptance-person", expectedVersion: episode.row_version });
      const saving = svc.saveLedger(view.projectId, body, ctx("ledger"));
      // The ledger save must wait for the workbench's project lock (not read past the uncommitted save and succeed).
      expect(await waitsOrSettles(PROJECT_LOCK, saving)).toBe("waiting");
      await workbench.query("COMMIT");
      expect((await saving).body).toMatchObject({ error: { code: "SERIES_LEDGER_STALE" } });
    } finally {
      await workbench.query("ROLLBACK").catch(() => undefined);
      workbench.release();
    }
    expect(await ledgers()).toBe(before);
    const after = viewOf((await svc.get(view.projectId)).body);
    expect(after.batches[0]!.ledger.status).toBe("pending_confirmation");
    expect(after.next.blockers).toContain("ledger_pending_confirmation:1");
  });

  it("8b. the ledger save holding its locks first: the workbench save waits; the ledger is saved on the basis it read; then the edit makes it pending as usual", async () => {
    const { view, storyId, opened, body, ledgers } = await confirmableBatch();
    const paused = pausedPool(/INSERT INTO series_writing_ledger_revision/);
    const { svc } = service({ store: new PostgresSeriesWritingStore(paused.pool as never, textChain) });
    const before = await ledgers();
    const saving = svc.saveLedger(view.projectId, body, ctx("ledger"));
    await paused.reached;
    const workbench = personScript(view.projectId, storyId, 2, "工作台并发另存的第 2 集");
    // The workbench save waits for the ledger save's project lock: it cannot change the basis under the check.
    const order = await waitsOrSettles(PROJECT_LOCK, workbench);
    paused.release();
    expect(order).toBe("waiting");
    expect((await saving).status).toBe(201);
    await workbench;
    expect(await ledgers()).toBe(before + 1);
    const saved = (await q<{ summaries_json: Array<{ episodeNo: number; versionHash: string }> }>(
      "SELECT summaries_json FROM series_writing_ledger_revision WHERE series_id = $1 AND batch_no = 1 ORDER BY revision_no DESC LIMIT 1", [view.seriesId]))[0]!;
    expect(saved.summaries_json.find((item) => item.episodeNo === 2)!.versionHash).toBe(opened.batches[0]!.ledgerBasis!["episode:2"]);
    const after = viewOf((await service().svc.get(view.projectId)).body);
    expect(after.batches[0]!.ledger.status).toBe("pending_confirmation");
    expect(after.batches[0]!.changedEpisodes).toEqual([2]);
  });
});
