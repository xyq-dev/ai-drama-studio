/**
 * Script breakdown acceptance on real PostgreSQL. NOT part of `test` or `integration`: run only with
 * `pnpm --filter @ai-drama/database script-breakdown:acceptance` against a newly created, empty, disposable database that
 * a person named on purpose. It uses the title writing acceptance guard (title-writing-acceptance-guard.ts): the same
 * three variables, the same disposable name pattern, and the same empty-database check before any write. Refusal
 * happens before any connection. It never drops or truncates anything. No model is called: model answers are fixed
 * values written through the store's real call path.
 *
 * What it proves:
 * - before the migration the breakdown storage is not ready and title writing reads (latest run, key lookup) still work;
 * - the upgrade applies only the breakdown migration and keeps every existing row; a second deploy applies nothing;
 * - the new constraints: run shape, the breakdown step, the planned duration range and shot revision immutability;
 * - for works of 1, 3 and 6 episodes only the chosen episode gets scenes, from its own frozen script revision;
 * - replacing archives exactly the frozen scenes and shots (revisions kept) and marks their dependents STALE;
 * - a script saved before the result is stored keeps the result out (source_changed); a person's scene saved while the
 *   save waits for the project lock wins (conflict);
 * - shots are written only under approved scenes, with the planned duration, dialogue and character references, once;
 * - a newer script marks the breakdown's scenes and shots STALE while the run keeps its frozen source.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SCRIPT_BREAKDOWN_CALL_CAP,
  SCRIPT_BREAKDOWN_INPUT_SCHEMA,
  SCRIPT_BREAKDOWN_OUTPUT_SCHEMA,
  SCRIPT_BREAKDOWN_PROMPT_VERSION,
  TITLE_WRITING_INPUT_SCHEMA,
  TITLE_WRITING_PROMPT_VERSION,
  type ScriptBreakdownFrozenInput,
  type ScriptBreakdownOutput,
  type TitleCallRecord,
  type TitleRunRecord,
  type TitleWritingFrozenInput,
  isScriptBreakdownInput,
} from "@ai-drama/contracts";
import { canonicalInputHash } from "@ai-drama/domain";
import { runMigrations, type MigrationResult } from "./migrations";
import { insertProject } from "./runtime-store";
import { TextChainService } from "./text-chain";
import { checkTitleWritingAcceptanceEnv, verifyTitleWritingAcceptanceDatabase } from "./title-writing-acceptance-guard";
import { PostgresTitleWritingStore, SCRIPT_BREAKDOWN_MIGRATION } from "./title-writing-store";

const decision = checkTitleWritingAcceptanceEnv(process.env);
if (!decision.ok) throw new Error(`Script breakdown acceptance refused: ${decision.reason}`);

const poolOptions = { connectionString: decision.url, connectionTimeoutMillis: 5_000, statement_timeout: 15_000, query_timeout: 20_000 };
const pool = new Pool({ ...poolOptions, max: 8, application_name: "script-breakdown-acceptance-main" });
const chain = new TextChainService(pool);
const store = new PostgresTitleWritingStore(pool, chain);
const evidence: Record<string, unknown> = {};
const extraPools: Pool[] = [];

let released: MigrationResult;
let upgrade: MigrationResult;
let redeploy: MigrationResult;
let before: { ready: boolean; latestTitleRunId: string | null; keyLookupRunId: string | null };
let history: { ws: string; project: string; runId: string };
let rowsBefore: Record<string, { count: number; digest: string }>;
let rowsAfter: Record<string, { count: number; digest: string }>;

const now = () => new Date().toISOString();
const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const USAGE = { status: "present" as const, inputTokens: 10, outputTokens: 20, totalTokens: 30 };
const NEW_COLUMNS = ["run_kind", "episode_id", "source_script_revision_id", "breakdown_save", "planned_duration_ms"];

async function one(sql: string, values: unknown[]): Promise<string> {
  return (await pool.query<{ id: string }>(sql, values)).rows[0]!.id;
}

async function tx<T>(work: (client: PoolClient) => Promise<T>, own: Pool = pool): Promise<T> {
  const client = await own.connect();
  try {
    await client.query("BEGIN");
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function scriptOf(episodeNo: number, scenes: number): string {
  const lines = [`第 ${String(episodeNo)} 集`];
  for (let scene = 1; scene <= scenes; scene += 1) {
    lines.push(`场 ${String(scene)} 地点${String(episodeNo)}-${String(scene)} 夜`, `林夏在第 ${String(episodeNo)} 集第 ${String(scene)} 场停下。`,
      `林夏：第 ${String(episodeNo)} 集第 ${String(scene)} 句。`);
  }
  return lines.join("\n");
}

/** A model answer that follows scriptOf: two shots per scene, the second one speaking a line of the script. */
function outputOf(episodeNo: number, scenes: number, characterKey: string | null): ScriptBreakdownOutput {
  return {
    schema: SCRIPT_BREAKDOWN_OUTPUT_SCHEMA,
    episodeNo,
    scenes: Array.from({ length: scenes }, (_, index) => ({ key: `S${String(index + 1)}`, heading: `地点${String(episodeNo)}-${String(index + 1)}`,
      timeOfDay: "夜", description: `林夏在第 ${String(episodeNo)} 集第 ${String(index + 1)} 场停下。` })),
    shots: Array.from({ length: scenes }, (_, index) => [
      { key: `S${String(index + 1)}-1`, sceneKey: `S${String(index + 1)}`, shotType: "中景", camera: "缓慢推近", action: "林夏停下",
        dialogue: [], characterKeys: [], plannedSeconds: 3 },
      { key: `S${String(index + 1)}-2`, sceneKey: `S${String(index + 1)}`, shotType: "近景", camera: "固定机位", action: "林夏开口",
        dialogue: [{ speaker: "林夏", line: `第 ${String(episodeNo)} 集第 ${String(index + 1)} 句。` }],
        characterKeys: characterKey ? [characterKey] : [], plannedSeconds: 4 },
    ]).flat(),
  };
}

async function approveRevision(table: "story_revision" | "script_revision", ws: string, revisionId: string, version: number, episodeId?: string, projectId?: string) {
  const review = await chain.transitionReview({ table, workspaceId: ws, revisionId, expectedVersion: version, expectedReviewVersion: 1, to: "IN_REVIEW" });
  if (table === "story_revision") {
    await chain.approveStory({ workspaceId: ws, projectId: projectId!, revisionId, expectedVersion: review.rowVersion, expectedReviewVersion: 2, reviewedBy: "editor" });
  } else {
    await chain.approveScript({ workspaceId: ws, episodeId: episodeId!, revisionId, expectedVersion: review.rowVersion, expectedReviewVersion: 2, reviewedBy: "editor" });
  }
}

async function episodeRow(episodeId: string) {
  return (await pool.query<{ row_version: number; current_script_revision_id: string | null }>(
    "SELECT row_version, current_script_revision_id FROM episode WHERE id = $1", [episodeId])).rows[0]!;
}

/** Writes and approves a new script revision of the episode, as the script editor and its review do. */
async function writeScript(ws: string, project: string, storyId: string, episodeId: string, text: string): Promise<string> {
  const created = await chain.createScriptRevision({ workspaceId: ws, projectId: project, episodeId, sourceStoryRevisionId: storyId,
    content: { text }, createdBy: "editor", expectedVersion: (await episodeRow(episodeId)).row_version });
  await approveRevision("script_revision", ws, created.revisionId, created.rowVersion, episodeId);
  return created.revisionId;
}

/** A work with N planned episodes, an approved story and an approved script per episode (episode n has n scenes). */
async function work(episodeCount: number) {
  const ws = await one("INSERT INTO workspace (name) VALUES ($1) RETURNING id", [`breakdown-${String(episodeCount)}-${randomUUID().slice(0, 6)}`]);
  const project = await tx(async (client) => (await insertProject(client, { workspaceId: ws, title: `作品${String(episodeCount)}`, premise: "",
    plan: { episodeCount, targetEpisodeSeconds: 60 } })).id);
  const story = await chain.createStoryRevision({ workspaceId: ws, projectId: project, content: { text: "故事" }, createdBy: "editor", expectedVersion: 1 });
  await approveRevision("story_revision", ws, story.revisionId, story.rowVersion, undefined, project);
  const episodes = (await pool.query<{ id: string; episode_no: number }>(
    "SELECT id, episode_no FROM episode WHERE project_id = $1 ORDER BY episode_no", [project])).rows;
  for (const episode of episodes) await writeScript(ws, project, story.revisionId, episode.id, scriptOf(episode.episode_no, episode.episode_no));
  return { ws, project, storyId: story.revisionId, episodes: episodes.map((row) => ({ id: row.id, no: Number(row.episode_no) })) };
}

async function addCharacter(ws: string, project: string, scriptRevisionId: string, name: string) {
  const version = (await pool.query<{ version: number }>("SELECT version FROM project WHERE id = $1", [project])).rows[0]!.version;
  return tx((client) => chain.createTextEntityRevisionInTransaction(client, { kind: "character", workspaceId: ws, projectId: project, name,
    sourceScriptRevisionId: scriptRevisionId, content: { name }, createdBy: "editor", expectedVersion: version }));
}

/** What the API does at start: freeze the source through the store, then create the run. */
async function startBreakdown(ws: string, project: string, episodeId: string, key: string = randomUUID()): Promise<TitleRunRecord> {
  const record = await breakdownRecord(ws, project, episodeId, key);
  const created = await store.createRun(record, { maxActiveRuns: 10, quota: { sinceIso: "2000-01-01T00:00:00.000Z", maxCallsPerDay: 1000, requiredCalls: 1 } });
  expect(created.kind).toBe("created");
  return record;
}

/** The run record a breakdown start would create from the episode's current source (not yet created). */
async function breakdownRecord(ws: string, project: string, episodeId: string, key: string): Promise<TitleRunRecord> {
  const source = await store.breakdownSource(ws, project, episodeId);
  if (source.kind !== "ok") throw new Error(`source ${source.kind}`);
  const frozen: ScriptBreakdownFrozenInput = {
    schema: SCRIPT_BREAKDOWN_INPUT_SCHEMA, promptVersion: SCRIPT_BREAKDOWN_PROMPT_VERSION, episodeId, episodeNo: source.episodeNo,
    scriptRevisionId: source.scriptRevisionId, scriptRevisionNo: source.scriptRevisionNo, scriptContentHash: source.scriptContentHash,
    scriptText: (source.scriptContent as { text: string }).text, targetEpisodeSeconds: source.targetEpisodeSeconds,
    characters: source.characters.map((item, index) => ({ key: `C${String(index + 1)}`, ...item })),
    replace: { scenes: source.scenes, shots: source.shots }, providerKey: "qwen", model: "q-1",
  };
  const at = now();
  const record: TitleRunRecord = {
    id: randomUUID(), workspaceId: ws, projectId: project, actorId: "server-owner", idempotencyKey: key,
    inputHash: canonicalInputHash({ kind: "script_breakdown", projectId: project, request: { episodeId } }), input: frozen, state: "running",
    errorCode: null, cancelRequestedAt: null, executorId: null, leaseUntil: null, callCap: SCRIPT_BREAKDOWN_CALL_CAP, callsUsed: 0,
    storySave: "pending", storyRevisionId: null, breakdownSave: "pending", createdAt: at, updatedAt: at,
  };
  return record;
}

/** Claim, reserve, submit and finish the single breakdown call with this answer: the store's real call path. */
async function answer(record: TitleRunRecord, output: ScriptBreakdownOutput): Promise<string> {
  const executor = `exec-${record.id.slice(0, 8)}`;
  expect(await store.claimRun(record.workspaceId, record.id, executor, now(), later(60_000))).toBe(true);
  const call: TitleCallRecord = { id: randomUUID(), runId: record.id, workspaceId: record.workspaceId, stepKey: "breakdown", attemptNo: 1,
    providerKey: "qwen", model: "q-1", requestHash: "cd".repeat(32), state: "reserved", executorId: executor, providerRequestId: null,
    responseModel: null, usage: { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null }, errorCode: null, createdAt: now(), finishedAt: null };
  expect(await store.reserveCall(call, { sinceIso: "2000-01-01T00:00:00.000Z", maxCallsPerDay: 1000 }, now(), later(60_000))).toEqual({ kind: "reserved" });
  expect(await store.markCallSubmitted(record.workspaceId, call.id, executor, now(), later(60_000))).toBe("submitted");
  expect(await store.finishCall(record.workspaceId, call.id, executor, { state: "completed", errorCode: null, providerRequestId: "req",
    responseModel: "q-1", usage: USAGE, output, outputHash: canonicalInputHash(output) }, now())).toBe(true);
  return executor;
}

/** The single breakdown call is sent and rejected (an invalid answer); the run ends failed, resumable on request. */
async function failOnce(record: TitleRunRecord): Promise<void> {
  const executor = `exec-${record.id.slice(0, 8)}`;
  expect(await store.claimRun(record.workspaceId, record.id, executor, now(), later(60_000))).toBe(true);
  const call: TitleCallRecord = { id: randomUUID(), runId: record.id, workspaceId: record.workspaceId, stepKey: "breakdown", attemptNo: 1,
    providerKey: "qwen", model: "q-1", requestHash: "cd".repeat(32), state: "reserved", executorId: executor, providerRequestId: null,
    responseModel: null, usage: { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null }, errorCode: null, createdAt: now(), finishedAt: null };
  expect(await store.reserveCall(call, { sinceIso: "2000-01-01T00:00:00.000Z", maxCallsPerDay: 1000 }, now(), later(60_000))).toEqual({ kind: "reserved" });
  expect(await store.markCallSubmitted(record.workspaceId, call.id, executor, now(), later(60_000))).toBe("submitted");
  expect(await store.finishCall(record.workspaceId, call.id, executor, { state: "rejected", errorCode: "invalid_output", providerRequestId: "req",
    responseModel: "q-1", usage: USAGE, output: null, outputHash: null }, now())).toBe(true);
  expect(await store.finishRun(record.workspaceId, record.id, executor, "failed", "invalid_output", now())).toBe(true);
}

const resumeOf = (ws: string, project: string, runId: string, resumeKey: string = randomUUID()) =>
  store.prepareResume(ws, project, runId, { resumeKey, requestHash: "e".repeat(64), confirmedCallIds: [], maxActiveRuns: 10 }, now());

/** What a resume or a refused resume left behind: run state, calls, resume records and step state. */
async function runTrace(runId: string) {
  const run = (await pool.query<{ state: string; calls_used: number; source_script_revision_id: string }>(
    "SELECT state, calls_used, source_script_revision_id FROM title_writing_run WHERE id = $1", [runId])).rows[0]!;
  const count = async (table: string) => Number((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE run_id = $1`, [runId])).rows[0]!.n);
  const step = (await pool.query<{ state: string }>("SELECT state FROM title_writing_step WHERE run_id = $1", [runId])).rows[0]!.state;
  return { state: run.state, callsUsed: Number(run.calls_used), source: run.source_script_revision_id, calls: await count("title_writing_call"),
    resumes: await count("title_writing_resume"), step };
}

/** Claims the run as the engine would and tries to reserve its next breakdown call. */
async function reserveBreakdown(record: TitleRunRecord) {
  const executor = `exec2-${record.id.slice(0, 8)}`;
  expect(await store.claimRun(record.workspaceId, record.id, executor, now(), later(60_000))).toBe(true);
  const call: TitleCallRecord = { id: randomUUID(), runId: record.id, workspaceId: record.workspaceId, stepKey: "breakdown", attemptNo: 2,
    providerKey: "qwen", model: "q-1", requestHash: "ce".repeat(32), state: "reserved", executorId: executor, providerRequestId: null,
    responseModel: null, usage: { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null }, errorCode: null, createdAt: now(), finishedAt: null };
  return store.reserveCall(call, { sinceIso: "2000-01-01T00:00:00.000Z", maxCallsPerDay: 1000 }, now(), later(60_000));
}

async function liveScenes(episodeId: string) {
  return (await pool.query<{ id: string; current_revision_id: string; row_version: number }>(
    "SELECT id, current_revision_id, row_version FROM scene WHERE episode_id = $1 AND archived_at IS NULL ORDER BY id", [episodeId])).rows;
}

async function approveScene(ws: string, project: string, episodeId: string, sceneId: string) {
  const scene = (await pool.query<{ row_version: number; current_revision_id: string }>("SELECT row_version, current_revision_id FROM scene WHERE id = $1", [sceneId])).rows[0]!;
  const review = await tx((client) => chain.reviewSceneShotInTransaction(client, { kind: "scene", workspaceId: ws, projectId: project, episodeId, sceneId,
    revisionId: scene.current_revision_id, expectedVersion: scene.row_version, expectedReviewVersion: 1, to: "IN_REVIEW", reviewedBy: "editor" }));
  await tx((client) => chain.reviewSceneShotInTransaction(client, { kind: "scene", workspaceId: ws, projectId: project, episodeId, sceneId,
    revisionId: scene.current_revision_id, expectedVersion: review.rowVersion, expectedReviewVersion: review.reviewVersion, to: "APPROVED", reviewedBy: "editor" }));
}

/** Rows of every table except the columns the migration adds: equal digests mean no existing value changed. */
async function rowDigests() {
  const tables = (await pool.query<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
        AND table_name <> 'schema_migration' ORDER BY 1`)).rows.map((row) => row.name);
  const strip = NEW_COLUMNS.map((column) => ` - '${column}'`).join("");
  const rows: Record<string, { count: number; digest: string }> = {};
  for (const table of tables) {
    const result = (await pool.query<{ count: number; digest: string | null }>(
      `SELECT count(*)::int AS count, md5(string_agg((to_jsonb(t)${strip})::text, '|' ORDER BY (to_jsonb(t)${strip})::text)) AS digest
         FROM ${table} t`)).rows[0]!;
    rows[table] = { count: result.count, digest: result.digest ?? "" };
  }
  return rows;
}

/** History of the released schema: a title run of a work whose episode 1 has a template scene and shot. */
async function seedHistory() {
  const ws = await one("INSERT INTO workspace (name) VALUES ('before-breakdown') RETURNING id", []);
  const project = await tx(async (client) => (await insertProject(client, { workspaceId: ws, title: "已有作品", premise: "" })).id);
  const frozen: TitleWritingFrozenInput = { schema: TITLE_WRITING_INPUT_SCHEMA, promptVersion: TITLE_WRITING_PROMPT_VERSION, title: "旧任务",
    settings: { episodeCount: 3, episodeSeconds: 90, style: "" }, providerKey: "qwen", model: "q-1" };
  const at = now();
  const run: TitleRunRecord = { id: randomUUID(), workspaceId: ws, projectId: project, actorId: "server-owner", idempotencyKey: "history",
    inputHash: canonicalInputHash({ projectId: project, input: frozen }), input: frozen, state: "running", errorCode: null, cancelRequestedAt: null,
    executorId: null, leaseUntil: null, callCap: 8, callsUsed: 0, storySave: "pending", storyRevisionId: null, createdAt: at, updatedAt: at };
  expect((await store.createRun(run, { maxActiveRuns: 5 })).kind).toBe("created");
  return { ws, project, runId: run.id };
}

async function writeEvidence(): Promise<void> {
  const dir = process.env.TITLE_WRITING_ACCEPTANCE_EVIDENCE_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "script-breakdown-acceptance.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }
}

beforeAll(async () => {
  const verified = await verifyTitleWritingAcceptanceDatabase(pool, decision.databaseName);
  if (!verified.ok) {
    await pool.end();
    throw new Error(`Script breakdown acceptance refused: ${verified.reason}`);
  }
  // The schema of the current release: every migration before the breakdown one, episode plan included.
  released = await runMigrations(pool, undefined, { before: SCRIPT_BREAKDOWN_MIGRATION });
  history = await seedHistory();
  before = {
    ready: await store.breakdownStorageReady(),
    latestTitleRunId: (await store.latestRun(history.ws, history.project))?.run.id ?? null,
    keyLookupRunId: (await store.findRunByKey(history.ws, "server-owner", "history"))?.run.id ?? null,
  };
  rowsBefore = await rowDigests();
  upgrade = await runMigrations(pool);
  rowsAfter = await rowDigests();
  redeploy = await runMigrations(pool);
  Object.assign(evidence, { released: released.applied, upgrade: upgrade.applied, redeploy: redeploy.applied, before });
});

afterAll(async () => {
  try {
    await writeEvidence();
  } finally {
    await Promise.allSettled([...extraPools, pool].map((own) => own.end()));
  }
});

describe("script breakdown on PostgreSQL", () => {
  it("before the migration: storage not ready, title writing reads unchanged", () => {
    expect(released.applied.at(-1)).toBe("20261011000100_episode_plan");
    expect(before).toEqual({ ready: false, latestTitleRunId: history.runId, keyLookupRunId: history.runId });
  });

  it("the upgrade applies only the breakdown migration and keeps every existing row; a redeploy applies nothing", async () => {
    expect(upgrade.applied).toEqual([SCRIPT_BREAKDOWN_MIGRATION]);
    expect(redeploy.applied).toEqual([]);
    // Every existing table keeps its rows exactly; the only difference is the new, empty scene link table.
    expect(rowsAfter).toEqual({ ...rowsBefore, script_breakdown_scene: { count: 0, digest: "" } });
    expect(rowsBefore.script_breakdown_scene).toBeUndefined();
    expect(await store.breakdownStorageReady()).toBe(true);
    const run = (await pool.query<{ run_kind: string; breakdown_save: string | null; episode_id: string | null }>(
      "SELECT run_kind, breakdown_save, episode_id FROM title_writing_run WHERE id = $1", [history.runId])).rows[0];
    expect(run).toEqual({ run_kind: "title", breakdown_save: null, episode_id: null });
    expect((await store.latestRun(history.ws, history.project))?.run.id).toBe(history.runId);
    evidence.rowsUnchanged = Object.keys(rowsBefore).length;
  });

  it("enforces the run shape, the breakdown step, the planned duration range and shot immutability", async () => {
    await expect(pool.query("UPDATE title_writing_run SET breakdown_save = 'pending' WHERE id = $1", [history.runId])).rejects.toThrow(/breakdown_shape/);
    await expect(pool.query("UPDATE title_writing_run SET run_kind = 'script_breakdown' WHERE id = $1", [history.runId])).rejects.toThrow(/breakdown_shape/);
    // An episode step renamed out of range breaks only the step key CHECK (its script_save rule still holds).
    await expect(pool.query("UPDATE title_writing_step SET step_key = 'episode:7' WHERE run_id = $1 AND step_key = 'episode:1'", [history.runId]))
      .rejects.toThrow(/step_key_check/);
    const { ws, project, episodes } = await work(1);
    const record = await startBreakdown(ws, project, episodes[0]!.id);
    const step = (await pool.query<{ step_key: string; script_save: string | null }>("SELECT step_key, script_save FROM title_writing_step WHERE run_id = $1", [record.id])).rows;
    expect(step).toEqual([{ step_key: "breakdown", script_save: null }]);
    await expect(pool.query("UPDATE title_writing_step SET script_save = 'pending' WHERE run_id = $1", [record.id])).rejects.toThrow(/script_save_scope/);
    await answer(record, outputOf(1, 1, null));
    expect(await store.saveBreakdown(ws, record.id, `exec-${record.id.slice(0, 8)}`, "server-owner", now())).toBe("saved");
    const scene = (await liveScenes(episodes[0]!.id))[0]!;
    await approveScene(ws, project, episodes[0]!.id, scene.id);
    const placed = await store.placeBreakdownShots(ws, project, episodes[0]!.id, record.id, { acceptSceneChanged: false }, "editor", now());
    expect(placed.kind === "ok" && placed.outcome.placed).toEqual(["S1"]);
    const shot = (await pool.query<{ id: string; planned_duration_ms: number }>(
      "SELECT r.id, r.planned_duration_ms FROM shot_revision r JOIN shot s ON s.current_revision_id = r.id WHERE s.scene_id = $1 ORDER BY r.ordinal", [scene.id])).rows;
    expect(shot.map((row) => row.planned_duration_ms)).toEqual([3000, 4000]);
    await expect(pool.query("UPDATE shot_revision SET planned_duration_ms = 5000 WHERE id = $1", [shot[0]!.id])).rejects.toThrow(/immutable/);
    await expect(pool.query("UPDATE shot_revision SET planned_duration_ms = NULL WHERE id = $1", [shot[0]!.id])).rejects.toThrow(/immutable/);
    await expect(pool.query("UPDATE shot_revision SET planned_duration_ms = 999 WHERE id = $1", [shot[0]!.id])).rejects.toThrow();
  });

  for (const count of [1, 3, 6]) {
    it(`a ${String(count)}-episode work: only the chosen episode gets scenes, from its own frozen script`, async () => {
      const { ws, project, episodes } = await work(count);
      const chosen = episodes.at(-1)!;
      const record = await startBreakdown(ws, project, chosen.id);
      const frozen = record.input as ScriptBreakdownFrozenInput;
      expect([frozen.episodeNo, frozen.scriptText]).toEqual([count, scriptOf(count, count)]);
      const executor = await answer(record, outputOf(count, count, null));
      expect(await store.saveBreakdown(ws, record.id, executor, "server-owner", now())).toBe("saved");
      expect(await store.finishRun(ws, record.id, executor, "completed", null, now())).toBe(true);
      const scenes = (await pool.query<{ episode_id: string; source_script_revision_id: string; ordinal: number; review_status: string; heading: string }>(
        `SELECT s.episode_id, r.source_script_revision_id, r.ordinal, r.review_status, r.heading FROM scene s
           JOIN scene_revision r ON r.id = s.current_revision_id WHERE s.project_id = $1 AND s.archived_at IS NULL ORDER BY r.ordinal`, [project])).rows;
      expect(scenes).toHaveLength(count);
      expect(scenes.every((row) => row.episode_id === chosen.id && row.source_script_revision_id === frozen.scriptRevisionId && row.review_status === "DRAFT")).toBe(true);
      expect(scenes.map((row) => row.ordinal)).toEqual(Array.from({ length: count }, (_, index) => index + 1));
      const links = (await pool.query<{ scene_key: string; shot_save: string }>("SELECT scene_key, shot_save FROM script_breakdown_scene WHERE run_id = $1 ORDER BY ordinal", [record.id])).rows;
      expect(links.map((row) => [row.scene_key, row.shot_save])).toEqual(Array.from({ length: count }, (_, index) => [`S${String(index + 1)}`, "pending"]));
      expect(Number((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM shot WHERE project_id = $1", [project])).rows[0]!.n)).toBe(0);
      expect((await store.latestBreakdown(ws, project, chosen.id))?.run.id).toBe(record.id);
      expect(await store.latestRun(ws, project)).toBeNull();
      ((evidence.episodeCounts ??= []) as number[]).push(count);
    });
  }

  it("replaces exactly the frozen scenes and shots: archived with revisions kept, and their dependents STALE", async () => {
    const { ws, project, episodes } = await work(2);
    const episode = episodes[0]!;
    const first = await startBreakdown(ws, project, episode.id);
    const executor = await answer(first, outputOf(1, 1, null));
    expect(await store.saveBreakdown(ws, first.id, executor, "server-owner", now())).toBe("saved");
    expect(await store.finishRun(ws, first.id, executor, "completed", null, now())).toBe(true);
    const old = (await liveScenes(episode.id))[0]!;
    await approveScene(ws, project, episode.id, old.id);
    await store.placeBreakdownShots(ws, project, episode.id, first.id, { acceptSceneChanged: false }, "editor", now());
    const oldShots = (await pool.query<{ id: string; current_revision_id: string }>("SELECT id, current_revision_id FROM shot WHERE scene_id = $1", [old.id])).rows;
    expect(oldShots).toHaveLength(2);
    const second = await startBreakdown(ws, project, episode.id);
    expect((second.input as ScriptBreakdownFrozenInput).replace.scenes.map((item) => item.sceneId)).toEqual([old.id]);
    const executor2 = await answer(second, outputOf(1, 1, null));
    expect(await store.saveBreakdown(ws, second.id, executor2, "server-owner", now())).toBe("saved");
    expect((await pool.query<{ archived: boolean }>("SELECT archived_at IS NOT NULL AS archived FROM scene WHERE id = $1", [old.id])).rows[0]!.archived).toBe(true);
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM shot WHERE scene_id = $1 AND archived_at IS NOT NULL", [old.id])).rows[0]!.n).toBe(2);
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM scene_revision WHERE scene_id = $1", [old.id])).rows[0]!.n).toBe(1);
    const freshness = (await pool.query<{ freshness_status: string }>("SELECT freshness_status FROM shot_revision WHERE id = ANY($1::uuid[])",
      [oldShots.map((row) => row.current_revision_id)])).rows.map((row) => row.freshness_status);
    expect(freshness).toEqual(["STALE", "STALE"]);
    const live = await liveScenes(episode.id);
    expect(live).toHaveLength(1);
    expect(live[0]!.id).not.toBe(old.id);
    expect(Number((await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM domain_event WHERE event_type = 'aggregate.archived' AND project_id = $1", [project])).rows[0]!.n)).toBe(3);
  });

  it("keeps the result out of the episode when a newer script was saved before it is stored (source_changed)", async () => {
    const { ws, project, storyId, episodes } = await work(1);
    const episode = episodes[0]!;
    const record = await startBreakdown(ws, project, episode.id);
    const executor = await answer(record, outputOf(1, 1, null));
    await writeScript(ws, project, storyId, episode.id, scriptOf(1, 3));
    expect(await store.saveBreakdown(ws, record.id, executor, "server-owner", now())).toBe("source_changed");
    expect(await liveScenes(episode.id)).toHaveLength(0);
    const saved = (await pool.query<{ breakdown_save: string }>("SELECT breakdown_save FROM title_writing_run WHERE id = $1", [record.id])).rows[0]!;
    expect(saved.breakdown_save).toBe("source_changed");
    // A second save of the same result changes nothing; it is not resumable.
    expect(await store.saveBreakdown(ws, record.id, executor, "server-owner", now())).toBe("source_changed");
    expect(await store.finishRun(ws, record.id, executor, "needs_attention", "breakdown_source_changed", now())).toBe(true);
    expect((await store.prepareResume(ws, project, record.id, { resumeKey: "r", requestHash: "e".repeat(64), confirmedCallIds: [], maxActiveRuns: 5 }, now())).kind)
      .toBe("not_resumable");
  });

  it("lets a person's scene saved while the save waits for the project lock win (conflict); nothing is overwritten", async () => {
    const { ws, project, episodes } = await work(1);
    const episode = episodes[0]!;
    const record = await startBreakdown(ws, project, episode.id);
    const executor = await answer(record, outputOf(1, 1, null));
    const holder = new Pool({ ...poolOptions, max: 1, application_name: "breakdown-person" });
    extraPools.push(holder);
    const person = await holder.connect();
    try {
      await person.query("BEGIN");
      await person.query("SELECT id FROM project WHERE id = $1 FOR UPDATE", [project]);
      const saving = store.saveBreakdown(ws, record.id, executor, "server-owner", now());
      // The save is now queued behind the person's project lock.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const version = (await episodeRow(episode.id)).row_version;
      const manual = await chain.createSceneRevisionInTransaction(person, { workspaceId: ws, projectId: project, episodeId: episode.id,
        sourceScriptRevisionId: (await episodeRow(episode.id)).current_script_revision_id!, ordinal: 1, heading: "人工场景", summary: "人工",
        createdBy: "editor", expectedVersion: version });
      await person.query("COMMIT");
      expect(await saving).toBe("conflict");
      expect((await liveScenes(episode.id)).map((row) => row.id)).toEqual([manual.entityId]);
    } finally {
      person.release();
    }
  });

  it("writes shots only under approved scenes, with plan, dialogue and character references, once; a changed scene needs confirmation", async () => {
    const { ws, project, episodes } = await work(1);
    const episode = episodes[0]!;
    const scriptId = (await episodeRow(episode.id)).current_script_revision_id!;
    const character = await addCharacter(ws, project, scriptId, "林夏");
    const record = await startBreakdown(ws, project, episode.id);
    expect((record.input as ScriptBreakdownFrozenInput).characters).toEqual([{ key: "C1", characterId: character.entityId, revisionId: character.revisionId, name: "林夏" }]);
    const output: ScriptBreakdownOutput = { ...outputOf(1, 1, "C1") };
    output.scenes.push({ key: "S2", heading: "补充", timeOfDay: "", description: "补充场" });
    output.shots.push({ key: "S2-1", sceneKey: "S2", shotType: "全景", camera: "远处", action: "林夏离开", dialogue: [], characterKeys: [], plannedSeconds: 5 });
    const executor = await answer(record, output);
    expect(await store.saveBreakdown(ws, record.id, executor, "server-owner", now())).toBe("saved");
    const place = (accept = false) => store.placeBreakdownShots(ws, project, episode.id, record.id, { acceptSceneChanged: accept }, "editor", now());
    const pending = await place();
    expect(pending.kind === "ok" && pending.outcome).toMatchObject({ placed: [], awaitingApproval: ["S1", "S2"] });
    const [s1, s2] = (await pool.query<{ scene_id: string }>("SELECT scene_id FROM script_breakdown_scene WHERE run_id = $1 ORDER BY ordinal", [record.id])).rows;
    await approveScene(ws, project, episode.id, s1!.scene_id);
    const placed = await place();
    expect(placed.kind === "ok" && placed.outcome).toMatchObject({ placed: ["S1"], awaitingApproval: ["S2"] });
    const shots = (await pool.query<{ id: string; ordinal: number; dialogue: string | null; planned_duration_ms: number; review_status: string }>(
      `SELECT r.id, r.ordinal, r.dialogue, r.planned_duration_ms, r.review_status FROM shot s JOIN shot_revision r ON r.id = s.current_revision_id
        WHERE s.scene_id = $1 ORDER BY r.ordinal`, [s1!.scene_id])).rows;
    expect(shots.map((row) => [row.ordinal, row.dialogue, row.planned_duration_ms, row.review_status])).toEqual([
      [1, null, 3000, "DRAFT"], [2, "林夏：第 1 集第 1 句。", 4000, "DRAFT"]]);
    const refs = (await pool.query<{ shot_revision_id: string; character_revision_id: string }>(
      "SELECT shot_revision_id, character_revision_id FROM shot_character_reference WHERE shot_revision_id = ANY($1::uuid[])", [shots.map((row) => row.id)])).rows;
    expect(refs).toEqual([{ shot_revision_id: shots[1]!.id, character_revision_id: character.revisionId }]);
    await place();
    expect(Number((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM shot WHERE scene_id = $1", [s1!.scene_id])).rows[0]!.n)).toBe(2);
    // S2 edited by a person, then approved: written only after the explicit confirmation, under the edited revision.
    const s2Row = (await pool.query<{ row_version: number }>("SELECT row_version FROM scene WHERE id = $1", [s2!.scene_id])).rows[0]!;
    const edited = await tx((client) => chain.createSceneRevisionInTransaction(client, { workspaceId: ws, projectId: project, episodeId: episode.id,
      sceneId: s2!.scene_id, sourceScriptRevisionId: scriptId, ordinal: 2, heading: "补充（改）", summary: "人工修改", createdBy: "editor", expectedVersion: s2Row.row_version }));
    await approveScene(ws, project, episode.id, s2!.scene_id);
    const changed = await place();
    expect(changed.kind === "ok" && changed.outcome.sceneChanged).toEqual(["S2"]);
    const accepted = await place(true);
    expect(accepted.kind === "ok" && accepted.outcome.placed).toEqual(["S2"]);
    expect((await pool.query<{ source_scene_revision_id: string }>(
      "SELECT r.source_scene_revision_id FROM shot s JOIN shot_revision r ON r.id = s.current_revision_id WHERE s.scene_id = $1", [s2!.scene_id])).rows)
      .toEqual([{ source_scene_revision_id: edited.revisionId }]);
    evidence.placement = { s1: 2, s2: 1, characterReferences: refs.length };
  });

  it("marks the breakdown's scenes and shots STALE when a newer script is saved; the run keeps its frozen source", async () => {
    const { ws, project, storyId, episodes } = await work(1);
    const episode = episodes[0]!;
    const record = await startBreakdown(ws, project, episode.id);
    const executor = await answer(record, outputOf(1, 1, null));
    expect(await store.saveBreakdown(ws, record.id, executor, "server-owner", now())).toBe("saved");
    const scene = (await liveScenes(episode.id))[0]!;
    await approveScene(ws, project, episode.id, scene.id);
    await store.placeBreakdownShots(ws, project, episode.id, record.id, { acceptSceneChanged: false }, "editor", now());
    const newer = await writeScript(ws, project, storyId, episode.id, `${scriptOf(1, 1)}\n林夏：新增的一句。`);
    const sceneFresh = (await pool.query<{ freshness_status: string }>("SELECT freshness_status FROM scene_revision WHERE id = $1", [scene.current_revision_id])).rows[0]!;
    expect(sceneFresh.freshness_status).toBe("STALE");
    const shotFresh = (await pool.query<{ freshness_status: string }>(
      "SELECT r.freshness_status FROM shot s JOIN shot_revision r ON r.id = s.current_revision_id WHERE s.scene_id = $1", [scene.id])).rows;
    expect(shotFresh.map((row) => row.freshness_status)).toEqual(["STALE", "STALE"]);
    const bundle = (await store.getRun(ws, project, record.id))!;
    const details = await store.breakdownDetails(ws, bundle.run);
    expect((bundle.run.input as ScriptBreakdownFrozenInput).scriptRevisionId).not.toBe(newer);
    expect(details.episodeScript).toMatchObject({ currentRevisionId: newer, approved: true });
    expect(details.scenes[0]!.current.freshnessStatus).toBe("STALE");
    const replay = await store.placeBreakdownShots(ws, project, episode.id, record.id, { acceptSceneChanged: false }, "editor", now());
    expect(replay.kind === "ok" && replay.outcome).toMatchObject({ placed: [], unavailable: [] });
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM shot_revision WHERE project_id = $1", [project])).rows[0]!.n).toBe(2);
  });

  it("refuses an old plan even when an edited scene is approved under the new script and the caller accepts scene changes", async () => {
    const { ws, project, storyId, episodes } = await work(1);
    const episode = episodes[0]!;
    const record = await startBreakdown(ws, project, episode.id);
    const executor = await answer(record, outputOf(1, 1, null));
    expect(await store.saveBreakdown(ws, record.id, executor, "server-owner", now())).toBe("saved");
    const scene = (await liveScenes(episode.id))[0]!;
    const newer = await writeScript(ws, project, storyId, episode.id, "完全不同的新剧本，不再包含原来的对白。");
    const version = (await pool.query<{ row_version: number }>("SELECT row_version FROM scene WHERE id = $1", [scene.id])).rows[0]!.row_version;
    await tx((client) => chain.createSceneRevisionInTransaction(client, {
      workspaceId: ws, projectId: project, episodeId: episode.id, sceneId: scene.id, sourceScriptRevisionId: newer,
      ordinal: 1, heading: "新剧本的场景", summary: "只属于新剧本", createdBy: "editor", expectedVersion: version,
    }));
    await approveScene(ws, project, episode.id, scene.id);

    const placed = await store.placeBreakdownShots(ws, project, episode.id, record.id, { acceptSceneChanged: true }, "editor", now());
    expect(placed).toEqual({ kind: "not_ready" });
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM shot WHERE scene_id = $1", [scene.id])).rows[0]!.n).toBe(0);
    expect((await pool.query<{ shot_save: string }>("SELECT shot_save FROM script_breakdown_scene WHERE run_id = $1", [record.id])).rows)
      .toEqual([{ shot_save: "pending" }]);
  });

  it("preserves a person's shot, places the other scene, and replays without duplicate revisions", async () => {
    const { ws, project, episodes } = await work(2);
    const episode = episodes[1]!;
    const record = await startBreakdown(ws, project, episode.id);
    const executor = await answer(record, outputOf(2, 2, null));
    expect(await store.saveBreakdown(ws, record.id, executor, "server-owner", now())).toBe("saved");
    const links = (await pool.query<{ scene_key: string; scene_id: string; scene_revision_id: string }>(
      "SELECT scene_key, scene_id, scene_revision_id FROM script_breakdown_scene WHERE run_id = $1 ORDER BY ordinal", [record.id])).rows;
    for (const link of links) await approveScene(ws, project, episode.id, link.scene_id);
    const first = links[0]!;
    const version = (await pool.query<{ row_version: number }>("SELECT row_version FROM scene WHERE id = $1", [first.scene_id])).rows[0]!.row_version;
    const manual = await tx((client) => chain.createShotScopedInTransaction(client, {
      workspaceId: ws, projectId: project, sceneId: first.scene_id, sourceSceneRevisionId: first.scene_revision_id,
      ordinal: 1, shotType: "全景", camera: "人工机位", action: "人工动作", dialogue: "人工保留的对白", promptText: "人工提示词",
      createdBy: "editor", expectedVersion: version,
    }));
    const place = () => store.placeBreakdownShots(ws, project, episode.id, record.id, { acceptSceneChanged: true }, "editor", now());
    const placed = await place();
    expect(placed.kind === "ok" && placed.outcome).toMatchObject({ placed: ["S2"], unavailable: ["S1"] });
    const shotRows = async () => (await pool.query<{ id: string; current_revision_id: string; action: string; dialogue: string | null }>(
      `SELECT s.id, s.current_revision_id, r.action, r.dialogue FROM shot s JOIN shot_revision r ON r.id = s.current_revision_id
        WHERE s.scene_id = ANY($1::uuid[]) ORDER BY s.id`, [links.map((link) => link.scene_id)])).rows;
    const saved = await shotRows();
    expect(saved).toHaveLength(3);
    expect(saved.find((row) => row.id === manual.entityId)).toEqual({ id: manual.entityId, current_revision_id: manual.revisionId,
      action: "人工动作", dialogue: "人工保留的对白" });
    const repeated = await place();
    expect(repeated.kind === "ok" && repeated.outcome).toMatchObject({ placed: [], unavailable: ["S1"] });
    expect(await shotRows()).toEqual(saved);
    expect((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM shot_revision WHERE project_id = $1", [project])).rows[0]!.n).toBe(3);
  });

  for (const change of ["replaced by a newer approved script", "left unapproved by a newer draft", "made STALE by a new story"] as const) {
    it(`refuses a resume once the frozen script was ${change}: nothing is resumed, reserved or sent`, async () => {
      const { ws, project, storyId, episodes } = await work(1);
      const episode = episodes[0]!;
      const record = await startBreakdown(ws, project, episode.id);
      const frozen = (record.input as ScriptBreakdownFrozenInput).scriptRevisionId;
      await failOnce(record);
      if (change === "replaced by a newer approved script") {
        await writeScript(ws, project, storyId, episode.id, scriptOf(1, 2));
      } else if (change === "left unapproved by a newer draft") {
        await chain.createScriptRevision({ workspaceId: ws, projectId: project, episodeId: episode.id, sourceStoryRevisionId: storyId,
          content: { text: scriptOf(1, 2) }, createdBy: "editor", expectedVersion: (await episodeRow(episode.id)).row_version });
      } else {
        const version = (await pool.query<{ version: number }>("SELECT version FROM project WHERE id = $1", [project])).rows[0]!.version;
        await chain.createStoryRevision({ workspaceId: ws, projectId: project, content: { text: "新故事" }, createdBy: "editor", expectedVersion: version });
        // The episode still points at the frozen revision; only its freshness changed.
        expect((await episodeRow(episode.id)).current_script_revision_id).toBe(frozen);
        expect((await pool.query<{ freshness_status: string }>("SELECT freshness_status FROM script_revision WHERE id = $1", [frozen])).rows[0]!.freshness_status)
          .toBe("STALE");
      }
      const before = await runTrace(record.id);
      expect(before).toMatchObject({ state: "failed", callsUsed: 1, calls: 1, resumes: 0, step: "rejected", source: frozen });
      expect(await resumeOf(ws, project, record.id)).toEqual({ kind: "source_changed" });
      expect(await runTrace(record.id)).toEqual(before);
      ((evidence.resumeRefused ??= []) as string[]).push(change);
    });
  }

  it("resumes against a current, approved script and reserves its next call", async () => {
    const { ws, project, episodes } = await work(1);
    const record = await startBreakdown(ws, project, episodes[0]!.id);
    await failOnce(record);
    expect((await resumeOf(ws, project, record.id)).kind).toBe("ok");
    expect(await runTrace(record.id)).toMatchObject({ state: "running", callsUsed: 1, calls: 1, resumes: 1, step: "pending" });
    expect(await reserveBreakdown(record)).toEqual({ kind: "reserved" });
    expect(await runTrace(record.id)).toMatchObject({ callsUsed: 2, calls: 2, step: "reserved" });
  });

  it("reserves no call when the script changed after the resume was accepted (the engine's send path)", async () => {
    const { ws, project, storyId, episodes } = await work(1);
    const episode = episodes[0]!;
    const record = await startBreakdown(ws, project, episode.id);
    await failOnce(record);
    expect((await resumeOf(ws, project, record.id)).kind).toBe("ok");
    await writeScript(ws, project, storyId, episode.id, scriptOf(1, 2));
    expect(await reserveBreakdown(record)).toEqual({ kind: "source_changed" });
    expect(await runTrace(record.id)).toMatchObject({ state: "running", callsUsed: 1, calls: 1, step: "pending" });
  });

  for (const path of ["resume", "reserve"] as const) {
    it(`a ${path} waiting behind a person's script save under the project lock sees the saved script and reserves nothing`, async () => {
      const { ws, project, storyId, episodes } = await work(1);
      const episode = episodes[0]!;
      const record = await startBreakdown(ws, project, episode.id);
      await failOnce(record);
      if (path === "reserve") expect((await resumeOf(ws, project, record.id)).kind).toBe("ok");
      const before = await runTrace(record.id);
      const holder = new Pool({ ...poolOptions, max: 1, application_name: `breakdown-${path}-person` });
      extraPools.push(holder);
      const person = await holder.connect();
      try {
        // The script editor's lock order: project, then episode. The person holds the project lock while saving.
        await person.query("BEGIN");
        await person.query("SELECT id FROM project WHERE id = $1 FOR UPDATE", [project]);
        const pending = path === "resume" ? resumeOf(ws, project, record.id) : reserveBreakdown(record);
        await new Promise((resolve) => setTimeout(resolve, 300));
        const waiting = (await pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'script-breakdown-acceptance-main' AND wait_event_type = 'Lock'")).rows[0]!.n;
        expect(Number(waiting)).toBeGreaterThanOrEqual(1);
        const created = await chain.createScriptRevisionInTransaction(person, { workspaceId: ws, projectId: project, episodeId: episode.id,
          sourceStoryRevisionId: storyId, content: { text: scriptOf(1, 2) }, createdBy: "editor", expectedVersion: (await episodeRow(episode.id)).row_version });
        await person.query("COMMIT");
        expect(created.revisionId).not.toBe((record.input as ScriptBreakdownFrozenInput).scriptRevisionId);
        expect(await pending).toEqual({ kind: "source_changed" });
      } finally {
        person.release();
      }
      expect(await runTrace(record.id)).toEqual(before);
      ((evidence.lockOrdered ??= []) as string[]).push(path);
    });
  }

  it("finds an accepted resume's receipt by its key without changing anything; an unknown key finds nothing", async () => {
    const { ws, project, episodes } = await work(1);
    const record = await startBreakdown(ws, project, episodes[0]!.id);
    await failOnce(record);
    expect(await store.findResume(ws, project, record.id, "never-used")).toBeNull();
    expect((await store.prepareResume(ws, project, record.id, { resumeKey: "accepted", requestHash: "a".repeat(64), confirmedCallIds: [], maxActiveRuns: 10 }, now())).kind)
      .toBe("ok");
    const before = await runTrace(record.id);
    expect(await store.findResume(ws, project, record.id, "accepted")).toEqual({ requestHash: "a".repeat(64) });
    // Scoped to the run's own work: another project id finds nothing.
    expect(await store.findResume(ws, randomUUID(), record.id, "accepted")).toBeNull();
    expect(await runTrace(record.id)).toEqual(before);
  });

  it("writes shots under an edited, approved scene with prompts built from that approved revision, once", async () => {
    const { ws, project, episodes } = await work(2);
    const episode = episodes[1]!;
    const scriptId = (await episodeRow(episode.id)).current_script_revision_id!;
    const record = await startBreakdown(ws, project, episode.id);
    const executor = await answer(record, outputOf(2, 2, null));
    expect(await store.saveBreakdown(ws, record.id, executor, "server-owner", now())).toBe("saved");
    const links = (await pool.query<{ scene_id: string }>("SELECT scene_id FROM script_breakdown_scene WHERE run_id = $1 ORDER BY ordinal", [record.id])).rows;
    const edit = async (sceneId: string, ordinal: number, heading: string, timeOfDay: string | null) => {
      const version = (await pool.query<{ row_version: number }>("SELECT row_version FROM scene WHERE id = $1", [sceneId])).rows[0]!.row_version;
      const edited = await tx((client) => chain.createSceneRevisionInTransaction(client, { workspaceId: ws, projectId: project, episodeId: episode.id,
        sceneId, sourceScriptRevisionId: scriptId, ordinal, heading, timeOfDay, summary: "人工修改地点与时段", createdBy: "editor", expectedVersion: version }));
      await approveScene(ws, project, episode.id, sceneId);
      return edited.revisionId;
    };
    const dock = await edit(links[0]!.scene_id, 1, "码头", "清晨");
    const warehouse = await edit(links[1]!.scene_id, 2, "旧仓库", null);
    const place = (accept: boolean) => store.placeBreakdownShots(ws, project, episode.id, record.id, { acceptSceneChanged: accept }, "editor", now());
    const refused = await place(false);
    expect(refused.kind === "ok" && refused.outcome).toMatchObject({ placed: [], sceneChanged: ["S1", "S2"] });
    const placed = await place(true);
    expect(placed.kind === "ok" && placed.outcome.placed).toEqual(["S1", "S2"]);
    const shots = async () => (await pool.query<{ scene_id: string; source_scene_revision_id: string; prompt_text: string; action: string; dialogue: string | null }>(
      `SELECT s.scene_id, r.source_scene_revision_id, r.prompt_text, r.action, r.dialogue FROM shot s JOIN shot_revision r ON r.id = s.current_revision_id
        WHERE s.scene_id = ANY($1::uuid[]) ORDER BY s.scene_id, r.ordinal`, [links.map((link) => link.scene_id)])).rows;
    const written = await shots();
    const of = (sceneId: string) => written.filter((row) => row.scene_id === sceneId);
    expect(of(links[0]!.scene_id).map((row) => row.source_scene_revision_id)).toEqual([dock, dock]);
    expect(of(links[0]!.scene_id).map((row) => row.prompt_text)).toEqual(["码头（清晨）；中景；缓慢推近；林夏停下", "码头（清晨）；近景；固定机位；林夏开口"]);
    expect(of(links[1]!.scene_id).map((row) => [row.source_scene_revision_id, row.prompt_text.split("；")[0]])).toEqual([[warehouse, "旧仓库"], [warehouse, "旧仓库"]]);
    // The plan's action and dialogue stay as proposed; only the scene fields follow the approved revision.
    expect(of(links[0]!.scene_id).map((row) => [row.action, row.dialogue])).toEqual([["林夏停下", null], ["林夏开口", "林夏：第 2 集第 1 句。"]]);
    expect(written.some((row) => row.prompt_text.includes("地点2-"))).toBe(false);
    const again = await place(true);
    expect(again.kind === "ok" && again.outcome.placed).toEqual([]);
    expect(await shots()).toEqual(written);
    evidence.editedScenePrompts = { scenes: 2, shots: written.length };
  });

  it("resumes a stopped run whose answer was stored but not saved without the provider, and saves it once", async () => {
    const { ws, project, episodes } = await work(1);
    const episode = episodes[0]!;
    const record = await startBreakdown(ws, project, episode.id);
    const executor = await answer(record, outputOf(1, 1, null));
    // The engine saw a cancel before saving: the run stops with a completed step and an unsaved answer.
    expect(await store.finishRun(ws, record.id, executor, "canceled", null, now())).toBe(true);
    const before = await runTrace(record.id);
    expect(before).toMatchObject({ state: "canceled", callsUsed: 1, calls: 1, resumes: 0, step: "completed" });
    const save = (key: string) => store.prepareResume(ws, project, record.id, { resumeKey: key, requestHash: "a".repeat(64), confirmedCallIds: [],
      maxActiveRuns: 10, providerReady: false }, now());
    expect((await save("save-1")).kind).toBe("ok");
    expect(await runTrace(record.id)).toMatchObject({ state: "running", callsUsed: 1, calls: 1, resumes: 1, step: "completed" });
    const saver = `saver-${record.id.slice(0, 8)}`;
    expect(await store.claimRun(ws, record.id, saver, now(), later(60_000))).toBe(true);
    expect(await store.saveBreakdown(ws, record.id, saver, "server-owner", now())).toBe("saved");
    expect(await store.saveBreakdown(ws, record.id, saver, "server-owner", now())).toBe("saved");
    expect(await store.finishRun(ws, record.id, saver, "completed", null, now())).toBe(true);
    expect(await liveScenes(episode.id)).toHaveLength(1);
    expect((await save("save-1")).kind).toBe("replayed");
    expect((await save("save-2")).kind).toBe("not_resumable");
    expect(await runTrace(record.id)).toMatchObject({ state: "completed", callsUsed: 1, calls: 1, resumes: 1 });
  });

  it("keeps the provider requirement for a run stopped before its first call was reserved (pending step)", async () => {
    const { ws, project, episodes } = await work(1);
    const record = await startBreakdown(ws, project, episodes[0]!.id);
    const executor = `stopped-${record.id.slice(0, 8)}`;
    expect(await store.claimRun(ws, record.id, executor, now(), later(60_000))).toBe(true);
    expect(await store.finishRun(ws, record.id, executor, "failed", "TITLE_WRITING_DAILY_CAP", now())).toBe(true);
    const before = await runTrace(record.id);
    expect(before).toMatchObject({ state: "failed", callsUsed: 0, calls: 0, resumes: 0, step: "pending" });
    const request = (providerReady: boolean) => ({ resumeKey: `pending-${String(providerReady)}`, requestHash: "a".repeat(64), confirmedCallIds: [],
      maxActiveRuns: 10, providerReady });
    expect(await store.prepareResume(ws, project, record.id, request(false), now())).toEqual({ kind: "provider_unconfigured" });
    expect(await runTrace(record.id)).toEqual(before);
    expect((await store.prepareResume(ws, project, record.id, request(true), now())).kind).toBe("ok");
    expect(await runTrace(record.id)).toMatchObject({ state: "running", callsUsed: 0, resumes: 1, step: "pending" });
  });

  it("keeps the provider requirement for a resume that sends again", async () => {
    const { ws, project, episodes } = await work(1);
    const record = await startBreakdown(ws, project, episodes[0]!.id);
    await failOnce(record);
    const before = await runTrace(record.id);
    expect(await store.prepareResume(ws, project, record.id, { resumeKey: "resend", requestHash: "a".repeat(64), confirmedCallIds: [],
      maxActiveRuns: 10, providerReady: false }, now())).toEqual({ kind: "provider_unconfigured" });
    expect(await runTrace(record.id)).toEqual(before);
  });

  it("references the speaking character from the written shot, and a new character revision makes that shot STALE", async () => {
    const { ws, project, episodes } = await work(1);
    const episode = episodes[0]!;
    const scriptId = (await episodeRow(episode.id)).current_script_revision_id!;
    const character = await addCharacter(ws, project, scriptId, "林夏");
    const record = await startBreakdown(ws, project, episode.id);
    const executor = await answer(record, outputOf(1, 1, "C1"));
    expect(await store.saveBreakdown(ws, record.id, executor, "server-owner", now())).toBe("saved");
    const scene = (await liveScenes(episode.id))[0]!;
    await approveScene(ws, project, episode.id, scene.id);
    const placed = await store.placeBreakdownShots(ws, project, episode.id, record.id, { acceptSceneChanged: false }, "editor", now());
    expect(placed.kind === "ok" && placed.outcome.placed).toEqual(["S1"]);
    const speaking = (await pool.query<{ id: string }>(
      `SELECT r.id FROM shot s JOIN shot_revision r ON r.id = s.current_revision_id WHERE s.scene_id = $1 AND r.dialogue IS NOT NULL`, [scene.id])).rows;
    expect(speaking).toHaveLength(1);
    expect((await pool.query("SELECT 1 FROM shot_character_reference WHERE shot_revision_id = $1 AND character_revision_id = $2",
      [speaking[0]!.id, character.revisionId])).rows).toHaveLength(1);
    const version = (await pool.query<{ row_version: number }>("SELECT row_version FROM character WHERE id = $1", [character.entityId])).rows[0]!.row_version;
    await tx((client) => chain.createTextEntityRevisionInTransaction(client, { kind: "character", workspaceId: ws, projectId: project, entityId: character.entityId,
      name: "林夏", sourceScriptRevisionId: scriptId, content: { name: "林夏", note: "改了设定" }, createdBy: "editor", expectedVersion: version }));
    expect((await pool.query<{ freshness_status: string }>("SELECT freshness_status FROM shot_revision WHERE id = $1", [speaking[0]!.id])).rows[0]!.freshness_status)
      .toBe("STALE");
    evidence.speakerReference = { references: 1, staleAfterCharacterRevision: true };
  });

  it("answers a start of either kind with the other kind's running run as active, and replays an existing key first", async () => {
    const { ws, project, episodes } = await work(1);
    const titleInput: TitleWritingFrozenInput = { schema: TITLE_WRITING_INPUT_SCHEMA, promptVersion: TITLE_WRITING_PROMPT_VERSION, title: "互斥",
      settings: { episodeCount: 3, episodeSeconds: 90, style: "" }, providerKey: "qwen", model: "q-1" };
    const at = now();
    const titleRun: TitleRunRecord = { id: randomUUID(), workspaceId: ws, projectId: project, actorId: "server-owner", idempotencyKey: "title-key",
      inputHash: canonicalInputHash({ projectId: project, input: titleInput }), input: titleInput, state: "running", errorCode: null, cancelRequestedAt: null,
      executorId: null, leaseUntil: null, callCap: 8, callsUsed: 0, storySave: "pending", storyRevisionId: null, createdAt: at, updatedAt: at };
    expect((await store.createRun(titleRun, { maxActiveRuns: 10 })).kind).toBe("created");
    // A breakdown start while the title run runs: the active run is the title run, and nothing is created.
    const blocked = await store.createRun(await breakdownRecord(ws, project, episodes[0]!.id, "breakdown-key"), { maxActiveRuns: 10 });
    expect(blocked.kind === "active" && [blocked.bundle.run.id, isScriptBreakdownInput(blocked.bundle.run.input)]).toEqual([titleRun.id, false]);
    const titleExecutor = "title-exec";
    expect(await store.claimRun(ws, titleRun.id, titleExecutor, now(), later(60_000))).toBe(true);
    expect(await store.finishRun(ws, titleRun.id, titleExecutor, "canceled", null, now())).toBe(true);
    // Then a breakdown runs: a new title start sees the breakdown as the active run, and the old title key still replays.
    const breakdown = await startBreakdown(ws, project, episodes[0]!.id);
    const busy = await store.createRun({ ...titleRun, id: randomUUID(), idempotencyKey: "title-key-2" }, { maxActiveRuns: 10 });
    expect(busy.kind === "active" && [busy.bundle.run.id, isScriptBreakdownInput(busy.bundle.run.input)]).toEqual([breakdown.id, true]);
    const replay = await store.createRun({ ...titleRun, id: randomUUID() }, { maxActiveRuns: 10 });
    expect([replay.kind, replay.kind !== "blocked" && replay.bundle.run.id]).toEqual(["existing", titleRun.id]);
    expect(Number((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM title_writing_run WHERE project_id = $1", [project])).rows[0]!.n)).toBe(2);
  });

  it("returns the same run for the same key and refuses the key for another request", async () => {
    const { ws, project, episodes } = await work(1);
    const record = await startBreakdown(ws, project, episodes[0]!.id, "same-key");
    const again = await store.createRun({ ...record, id: randomUUID() }, { maxActiveRuns: 10 });
    expect([again.kind, again.kind !== "blocked" && again.bundle.run.id]).toEqual(["existing", record.id]);
    const other = await store.createRun({ ...record, id: randomUUID(), inputHash: "f".repeat(64) }, { maxActiveRuns: 10 });
    expect(other.kind).toBe("conflict");
    expect((await store.findRunByKey(ws, "server-owner", "same-key"))?.run.id).toBe(record.id);
  });

  it("finds the newest saved breakdown of exactly this episode while newer runs failed or still run; never another scope or a title run", async () => {
    const { ws, project, episodes } = await work(2);
    const [episode, sibling] = episodes;
    const saved = async (scope = { ws, project, episodeId: episode!.id }) => (await store.latestSavedBreakdown(scope.ws, scope.project, scope.episodeId))?.run.id ?? null;
    expect(await saved()).toBeNull();
    const a = await startBreakdown(ws, project, episode!.id);
    const executorA = await answer(a, outputOf(1, 1, null));
    expect(await store.saveBreakdown(ws, a.id, executorA, "server-owner", now())).toBe("saved");
    expect(await store.finishRun(ws, a.id, executorA, "completed", null, now())).toBe(true);
    // B fails before saving, then C is still running: latest moves on, the saved one stays A.
    const b = await startBreakdown(ws, project, episode!.id);
    await failOnce(b);
    expect([(await store.latestBreakdown(ws, project, episode!.id))?.run.id, await saved()]).toEqual([b.id, a.id]);
    const c = await startBreakdown(ws, project, episode!.id);
    expect([(await store.latestBreakdown(ws, project, episode!.id))?.run.id, await saved()]).toEqual([c.id, a.id]);
    // Other scopes see nothing: the sibling episode, another work, another workspace.
    const other = await work(1);
    expect(await saved({ ws, project, episodeId: sibling!.id })).toBeNull();
    expect(await saved({ ws, project: other.project, episodeId: episode!.id })).toBeNull();
    expect(await saved({ ws: other.ws, project, episodeId: episode!.id })).toBeNull();
    // C saved: only now is it the saved one.
    const executorC = await answer(c, outputOf(1, 1, null));
    expect(await store.saveBreakdown(ws, c.id, executorC, "server-owner", now())).toBe("saved");
    expect(await store.finishRun(ws, c.id, executorC, "completed", null, now())).toBe(true);
    expect(await saved()).toBe(c.id);
    // A newer title run of the same work is never answered.
    const titleInput: TitleWritingFrozenInput = { schema: TITLE_WRITING_INPUT_SCHEMA, promptVersion: TITLE_WRITING_PROMPT_VERSION, title: "已保存",
      settings: { episodeCount: 2, episodeSeconds: 60, style: "" }, providerKey: "qwen", model: "q-1" };
    const at = now();
    const titleRun: TitleRunRecord = { id: randomUUID(), workspaceId: ws, projectId: project, actorId: "server-owner", idempotencyKey: `title-${randomUUID()}`,
      inputHash: canonicalInputHash({ projectId: project, input: titleInput }), input: titleInput, state: "running", errorCode: null, cancelRequestedAt: null,
      executorId: null, leaseUntil: null, callCap: 8, callsUsed: 0, storySave: "pending", storyRevisionId: null, createdAt: at, updatedAt: at };
    expect((await store.createRun(titleRun, { maxActiveRuns: 10 })).kind).toBe("created");
    expect(await saved()).toBe(c.id);
    evidence.latestSaved = { afterFailed: "earlier saved run", whileRunning: "earlier saved run", afterSave: "newer run", otherScopes: null, titleRun: "ignored" };
  });
});
