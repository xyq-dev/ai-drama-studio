/**
 * Episode plan acceptance on real PostgreSQL. NOT part of `test` or `integration`: run only with
 * `pnpm --filter @ai-drama/database episode-plan:acceptance` against a newly created, empty, disposable database that a
 * person named on purpose. It uses the title writing acceptance guard (title-writing-acceptance-guard.ts): the same
 * three variables, the same disposable name pattern, and the same empty-database check before any write. Refusal
 * happens before any connection. It never drops or truncates anything.
 *
 * What it proves:
 * - the released chain without the episode plan migration: plan storage is not ready, a project with a plan is refused
 *   before any write, and a six-episode run cannot be stored (no run, no step, no call);
 * - the upgrade applies only the episode plan migration; every existing row keeps its values (projects read as three
 *   episodes with no target), the v1 run keeps its input, hash, five steps and cap; a second deploy applies nothing;
 * - for N = 1, 3, 6: approval creates exactly episodes 1..N, a v2 run has N+2 steps and cap N+5, and placing its
 *   scripts writes N versions once, never overwriting an episode that already has a script;
 * - the start quota check reads without the call lock and refuses a new run with fewer than N+2 calls left, while a
 *   replay of an existing run still returns it; the last daily call raced by several sessions is reserved once.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EPISODE_DRAFT_SCHEMA,
  EPISODE_OUTLINE_SCHEMA_V2,
  TITLE_CONCEPT_SCHEMA,
  TITLE_WRITING_INPUT_SCHEMA,
  TITLE_WRITING_INPUT_SCHEMA_V2,
  TITLE_WRITING_PROMPT_VERSION,
  TITLE_WRITING_PROMPT_VERSION_V2,
  titleWritingCallCapFor,
  titleWritingRequiredCalls,
  titleWritingStepKeysFor,
  type TitleCallFinish,
  type TitleCallRecord,
  type TitleRunRecord,
  type TitleWritingFrozenInput,
  type TitleWritingStepKey,
} from "@ai-drama/contracts";
import { canonicalInputHash } from "@ai-drama/domain";
import { EPISODE_PLAN_MIGRATION, episodePlanReadyIn, projectEpisodePlanIn } from "./episode-plan";
import { runMigrations, type MigrationResult } from "./migrations";
import { MockTextService } from "./mock-text";
import { insertProject } from "./runtime-store";
import { TextChainService } from "./text-chain";
import { checkTitleWritingAcceptanceEnv, verifyTitleWritingAcceptanceDatabase } from "./title-writing-acceptance-guard";
import { PostgresTitleWritingStore, SCRIPT_BREAKDOWN_MIGRATION } from "./title-writing-store";

const decision = checkTitleWritingAcceptanceEnv(process.env);
if (!decision.ok) throw new Error(`Episode plan acceptance refused: ${decision.reason}`);

const acceptanceUrl = decision.url;
const poolOptions = { connectionString: acceptanceUrl, connectionTimeoutMillis: 5_000, statement_timeout: 15_000, query_timeout: 20_000 };
const pool = new Pool({ ...poolOptions, max: 8, application_name: "episode-plan-acceptance-main" });
const chain = new TextChainService(pool);
const store = new PostgresTitleWritingStore(pool, chain);
const evidence: Record<string, unknown> = {};
const extraPools: Pool[] = [];

let released: MigrationResult;
let upgrade: MigrationResult;
let redeploy: MigrationResult;
let beforeUpgrade: { readyBefore: boolean; planRefusal: string; v2StoreRefusal: string; runsAfterRefusal: number; callsAfterRefusal: number };
let history: Awaited<ReturnType<typeof seedHistory>>;
let rowsBefore: Record<string, { count: number; digest: string }>;
let rowsAfter: Record<string, { count: number; digest: string }>;

const now = () => new Date().toISOString();
const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const USAGE = { status: "present" as const, inputTokens: 10, outputTokens: 20, totalTokens: 30 };

async function one(sql: string, values: unknown[]): Promise<string> {
  return (await pool.query<{ id: string }>(sql, values)).rows[0]!.id;
}

const newWorkspace = (name: string) => one("INSERT INTO workspace (name) VALUES ($1) RETURNING id", [name]);

async function projectWith(workspaceId: string, title: string, plan?: { episodeCount: number; targetEpisodeSeconds: number }): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const created = await insertProject(client, { workspaceId, title, premise: "", ...(plan ? { plan } : {}) });
    await client.query("COMMIT");
    return created.id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function saveStory(workspaceId: string, projectId: string, text: string): Promise<string> {
  const version = (await pool.query<{ version: number }>("SELECT version FROM project WHERE id = $1", [projectId])).rows[0]!.version;
  return (await chain.createStoryRevision({ workspaceId, projectId, content: { text }, createdBy: "editor", expectedVersion: version })).revisionId;
}

async function approveCurrentStory(workspaceId: string, projectId: string): Promise<string> {
  const project = (await pool.query<{ version: number; current_story_revision_id: string }>(
    "SELECT version, current_story_revision_id FROM project WHERE id = $1", [projectId])).rows[0]!;
  const revisionId = project.current_story_revision_id;
  const reviewVersion = (await pool.query<{ review_version: number }>("SELECT review_version FROM story_revision WHERE id = $1", [revisionId])).rows[0]!.review_version;
  const review = await chain.transitionReview({ table: "story_revision", revisionId, workspaceId, expectedVersion: project.version,
    expectedReviewVersion: reviewVersion, to: "IN_REVIEW" });
  await chain.approveStory({ workspaceId, projectId, revisionId, expectedVersion: review.rowVersion, expectedReviewVersion: reviewVersion + 1,
    reviewedBy: "editor" });
  return revisionId;
}

async function episodes(projectId: string) {
  return (await pool.query<{ id: string; episode_no: number; row_version: number; current_script_revision_id: string | null }>(
    "SELECT id, episode_no, row_version, current_script_revision_id FROM episode WHERE project_id = $1 ORDER BY episode_no", [projectId])).rows;
}

function input(episodeCount: number | null): TitleWritingFrozenInput {
  return episodeCount === null
    ? { schema: TITLE_WRITING_INPUT_SCHEMA, promptVersion: TITLE_WRITING_PROMPT_VERSION, title: "旧任务",
      settings: { episodeCount: 3, episodeSeconds: 180, style: "" }, providerKey: "qwen", model: "q-1" }
    : { schema: TITLE_WRITING_INPUT_SCHEMA_V2, promptVersion: TITLE_WRITING_PROMPT_VERSION_V2, title: "新任务",
      settings: { episodeCount, episodeSeconds: 60, style: "" }, providerKey: "qwen", model: "q-1" };
}

function runRecord(workspaceId: string, projectId: string, key: string, frozen: TitleWritingFrozenInput): TitleRunRecord {
  const at = now();
  return {
    id: randomUUID(), workspaceId, projectId, actorId: "server-owner", idempotencyKey: key,
    inputHash: canonicalInputHash({ projectId, input: frozen }), input: frozen, state: "running", errorCode: null, cancelRequestedAt: null,
    executorId: null, leaseUntil: null, callCap: titleWritingCallCapFor(frozen), callsUsed: 0, storySave: "pending", storyRevisionId: null,
    createdAt: at, updatedAt: at,
  };
}

function callOf(record: TitleRunRecord, executorId: string, stepKey: TitleWritingStepKey, attemptNo = 1): TitleCallRecord {
  return {
    id: randomUUID(), runId: record.id, workspaceId: record.workspaceId, stepKey, attemptNo, providerKey: "qwen", model: "q-1",
    requestHash: "cd".repeat(32), state: "reserved", executorId, providerRequestId: null, responseModel: null,
    usage: { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null }, errorCode: null, createdAt: now(), finishedAt: null,
  };
}

const CONCEPT = { schema: TITLE_CONCEPT_SCHEMA, genre: "悬疑", logline: "一句话", synopsis: "梗概", protagonistGoal: "目标", opposition: "阻力",
  coreConflict: "冲突", direction: "走向", characters: [{ name: "林夏", role: "主角", profile: "倔强" }, { name: "周岩", role: "刑警", profile: "冷淡" }],
  relationships: [{ name: "林夏与周岩", pressure: "互相怀疑" }] };
const outlineOf = (count: number) => ({ schema: EPISODE_OUTLINE_SCHEMA_V2, episodes: Array.from({ length: count }, (_, index) => ({
  episodeNo: index + 1, title: `集${String(index + 1)}`, entryState: "a", goal: "b", action: "c", turn: "d", result: "e", handoff: "f" })) });
const episodeOf = (episodeNo: number) => ({ schema: EPISODE_DRAFT_SCHEMA, episodeNo, title: `第 ${String(episodeNo)} 集`, screenplay: "剧本正文",
  scenes: [{ heading: "便利店 夜", action: "林夏看监控。", dialogue: "", sound: "" }], handoffFacts: [`第${String(episodeNo)}集事实`] });

function completed(output: unknown): TitleCallFinish {
  return { state: "completed", errorCode: null, providerRequestId: "req", responseModel: "q-1", usage: USAGE,
    output: output as TitleCallFinish["output"], outputHash: canonicalInputHash(output) };
}

/** Every step of the run reserved, submitted and finished with a valid output, then the story saved: the store's real path. */
async function completeRun(record: TitleRunRecord, count: number): Promise<void> {
  const executor = `exec-${record.id.slice(0, 8)}`;
  const wide = { sinceIso: "2000-01-01T00:00:00.000Z", maxCallsPerDay: 1000 };
  expect(await store.claimRun(record.workspaceId, record.id, executor, now(), later(60_000))).toBe(true);
  for (const stepKey of titleWritingStepKeysFor(record.input as TitleWritingFrozenInput)) {
    const output = stepKey === "concept" ? CONCEPT : stepKey === "outline" ? outlineOf(count) : episodeOf(Number(stepKey.slice(-1)));
    const item = callOf(record, executor, stepKey);
    expect(await store.reserveCall(item, wide, now(), later(60_000))).toEqual({ kind: "reserved" });
    expect(await store.markCallSubmitted(record.workspaceId, item.id, executor, now(), later(60_000))).toBe("submitted");
    expect(await store.finishCall(record.workspaceId, item.id, executor, completed(output), now())).toBe(true);
  }
  expect(await store.saveStory(record.workspaceId, record.id, executor, "故事正文", "server-owner", now())).toBe("saved");
  expect(await store.finishRun(record.workspaceId, record.id, executor, "completed", null, now())).toBe(true);
}

/** Rows of every table except the new project columns: equal digests mean no existing value changed. */
async function rowDigests() {
  const tables = (await pool.query<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
        AND table_name <> 'schema_migration' ORDER BY 1`)).rows.map((row) => row.name);
  const rows: Record<string, { count: number; digest: string }> = {};
  for (const table of tables) {
    const result = (await pool.query<{ count: number; digest: string | null }>(
      `SELECT count(*)::int AS count,
              md5(string_agg((to_jsonb(t) - 'episode_count' - 'target_episode_seconds')::text, '|'
                ORDER BY (to_jsonb(t) - 'episode_count' - 'target_episode_seconds')::text)) AS digest
         FROM ${table} t`)).rows[0]!;
    rows[table] = { count: result.count, digest: result.digest ?? "" };
  }
  return rows;
}

/** History of the released schema: a three-episode project with an approved story and a completed v1 run (180 s). */
async function seedHistory() {
  const ws = await newWorkspace("before-episode-plan");
  const project = await projectWith(ws, "已有三集作品");
  const record = runRecord(ws, project, "history-v1", input(null));
  expect((await store.createRun(record, { maxActiveRuns: 5 })).kind).toBe("created");
  // The v1 run is completed with a v1 outline through the same store path.
  const executor = "history-exec";
  const wide = { sinceIso: "2000-01-01T00:00:00.000Z", maxCallsPerDay: 1000 };
  expect(await store.claimRun(ws, record.id, executor, now(), later(60_000))).toBe(true);
  for (const stepKey of ["concept", "outline", "episode:1", "episode:2", "episode:3"] as const) {
    const output = stepKey === "concept" ? CONCEPT : stepKey === "outline"
      ? { ...outlineOf(3), schema: "ads.writing.episode-outline.v1" } : episodeOf(Number(stepKey.slice(-1)));
    const item = callOf(record, executor, stepKey);
    expect(await store.reserveCall(item, wide, now(), later(60_000))).toEqual({ kind: "reserved" });
    expect(await store.markCallSubmitted(ws, item.id, executor, now(), later(60_000))).toBe("submitted");
    expect(await store.finishCall(ws, item.id, executor, completed(output), now())).toBe(true);
  }
  expect(await store.saveStory(ws, record.id, executor, "旧故事", "server-owner", now())).toBe("saved");
  expect(await store.finishRun(ws, record.id, executor, "completed", null, now())).toBe(true);
  await approveCurrentStory(ws, project);
  const episodeIds = (await episodes(project)).map((row) => [row.episode_no, row.id] as const);
  return { ws, project, run: record, episodeIds };
}

function independent(name: string) {
  const own = new Pool({ ...poolOptions, max: 1, application_name: name });
  own.on("error", (error) => { ((evidence.poolErrors ??= []) as string[]).push(`${name}: ${error.message}`); });
  extraPools.push(own);
  const ownChain = new TextChainService(own);
  return { pool: own, store: new PostgresTitleWritingStore(own, ownChain) };
}

/** Vitest's test timeout does not cancel PostgreSQL queries: this bound returns control to our transaction cleanup. */
async function bounded<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not finish within ${String(ms)} ms`)), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

interface CallLockCleanup { endedBy: "rollback" | "destroyed"; queuedSettled: boolean; problems: string[] }

/**
 * Always release the held lock, settle tracked queries, and preserve the original failure. The worst-case budget is
 * connection 5s + BEGIN 2s + lock 2s + body 5s + rollback 3s + queued queries 10s = 27s, below the suite's 30s timeout.
 */
async function holdingCallLock<T>(holder: Pool, workspaceId: string, cleanup: CallLockCleanup,
  body: (track: <P>(work: Promise<P>) => Promise<P>, destroy: () => void) => Promise<T>): Promise<T> {
  const queued: Array<Promise<void>> = [];
  const track = <P>(work: Promise<P>): Promise<P> => {
    // Attach the rejection handler immediately, even when the body fails before it awaits this query.
    queued.push(work.then(() => undefined, () => undefined));
    return work;
  };
  ((evidence.callLockCleanups ??= []) as CallLockCleanup[]).push(cleanup);
  const client = await holder.connect();
  let released = false;
  let bodyFailed = false;
  let originalError: unknown;
  let result: T | undefined;
  const destroy = () => {
    if (released) return;
    released = true;
    cleanup.endedBy = "destroyed";
    client.release(new Error("destroying this acceptance's lock holder"));
  };
  const sessionError = (error: Error) => { cleanup.problems.push(`holder session: ${error.message}`); };
  client.on("error", sessionError);
  try {
    await bounded(client.query("BEGIN"), 2_000, "BEGIN of the call lock holder");
    await bounded(client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`title_writing_call:${workspaceId}`]),
      2_000, "acquiring the call lock");
    result = await bounded(body(track, destroy), 5_000, "call lock body");
  } catch (error) {
    bodyFailed = true;
    originalError = error;
  } finally {
    if (!released) {
      try {
        await bounded(client.query("ROLLBACK"), 3_000, "ROLLBACK of the call lock holder");
        released = true;
        client.release();
      } catch (error) {
        cleanup.problems.push(error instanceof Error ? error.message : String(error));
        destroy();
      }
    }
    try {
      await bounded(Promise.all(queued), 10_000, "queued call lock queries");
      cleanup.queuedSettled = true;
    } catch (error) {
      cleanup.problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (bodyFailed) throw originalError;
  if (cleanup.problems.length > 0) throw new Error(`Call lock cleanup failed: ${cleanup.problems.join("; ")}`);
  return result as T;
}

/** Confirm a real waiter before injecting a failure; elapsed time alone is not evidence of lock contention. */
async function waitForCallLockWaiter(applicationName: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const waiting = await pool.query(
      `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND application_name = $1
        AND wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0`, [applicationName]);
    if (waiting.rows.length === 1) return;
    if (Date.now() >= deadline) throw new Error("The deliberate call lock waiter did not block");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeAll(async () => {
  const verified = await verifyTitleWritingAcceptanceDatabase(pool, decision.databaseName);
  if (!verified.ok) {
    await pool.end();
    throw new Error(`Episode plan acceptance refused: ${verified.reason}`);
  }
  // The schema a server has today: every migration before the episode plan one, title writing included.
  released = await runMigrations(pool, undefined, { before: EPISODE_PLAN_MIGRATION });
  history = await seedHistory();
  const client = await pool.connect();
  let readyBefore: boolean;
  try {
    readyBefore = await episodePlanReadyIn(client);
  } finally {
    client.release();
  }
  const ws = history.ws;
  const planRefusal = await projectWith(ws, "带集数的作品", { episodeCount: 6, targetEpisodeSeconds: 90 }).then(() => "created", (error: { code?: string }) => error.code ?? "error");
  // A v2 run of six episodes cannot be stored on the old constraints: the insert fails as a whole, nothing is left.
  const legacyProject = await projectWith(ws, "迁移前的新作品");
  const v2StoreRefusal = await store.createRun(runRecord(ws, legacyProject, "v2-before", input(6)), { maxActiveRuns: 5 })
    .then((result) => result.kind, (error: { code?: string }) => error.code ?? "error");
  const runsAfterRefusal = Number((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM title_writing_run WHERE project_id = $1", [legacyProject])).rows[0]!.n);
  const callsAfterRefusal = Number((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM title_writing_call c JOIN title_writing_run r ON r.id = c.run_id WHERE r.project_id = $1", [legacyProject])).rows[0]!.n);
  beforeUpgrade = { readyBefore, planRefusal, v2StoreRefusal, runsAfterRefusal, callsAfterRefusal };
  rowsBefore = await rowDigests();
  // The episode plan release: the chain up to the next release (script breakdown), which has its own acceptance.
  upgrade = await runMigrations(pool, undefined, { before: SCRIPT_BREAKDOWN_MIGRATION });
  rowsAfter = await rowDigests();
  redeploy = await runMigrations(pool, undefined, { before: SCRIPT_BREAKDOWN_MIGRATION });
  evidence.migration = { released: released.applied, upgradeApplied: upgrade.applied, redeployApplied: redeploy.applied, beforeUpgrade };
});

async function writeEvidence(): Promise<void> {
  const dir = process.env.TITLE_WRITING_ACCEPTANCE_EVIDENCE_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "episode-plan-acceptance.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }
}

afterAll(async () => {
  // Write before closing pools, and still close them if writing evidence itself fails.
  let evidenceError: unknown;
  try {
    await bounded(writeEvidence(), 5_000, "writing episode plan evidence before cleanup");
  } catch (error) {
    evidenceError = error;
  }
  const closing = await Promise.allSettled([...extraPools, pool].map((own) => bounded(own.end(), 10_000, "closing an episode plan pool")));
  const stuck = closing.filter((item) => item.status === "rejected").length;
  evidence.poolsClosed = { total: closing.length, stuck };
  try {
    await bounded(writeEvidence(), 5_000, "writing episode plan evidence after cleanup");
  } catch (error) {
    evidenceError ??= error;
  }
  if (evidenceError) throw evidenceError;
  if (stuck > 0) throw new Error(`${String(stuck)} episode plan acceptance pool(s) did not close`);
});

describe("before the episode plan migration", () => {
  it("plan storage is not ready, a project with a plan is not created and a six-episode run is not stored", () => {
    expect(released.applied.at(-1)).toBe("20261008000100_title_writing");
    expect(beforeUpgrade.readyBefore).toBe(false);
    expect(beforeUpgrade.planRefusal).toBe("EPISODE_PLAN_UNAVAILABLE");
    expect(beforeUpgrade.v2StoreRefusal).toBe("23514");
    expect([beforeUpgrade.runsAfterRefusal, beforeUpgrade.callsAfterRefusal]).toEqual([0, 0]);
  });
});

describe("the upgrade", () => {
  it("applies only the episode plan migration, and nothing when deployed again", () => {
    expect(upgrade.applied).toEqual([EPISODE_PLAN_MIGRATION]);
    expect(redeploy.applied).toEqual([]);
  });

  it("keeps every existing value; existing projects read as three episodes with no target", async () => {
    expect(rowsAfter).toEqual(rowsBefore);
    const plan = (await pool.query<{ episode_count: number; target_episode_seconds: number | null }>(
      "SELECT episode_count, target_episode_seconds FROM project WHERE id = $1", [history.project])).rows[0]!;
    expect(plan).toEqual({ episode_count: 3, target_episode_seconds: null });
    expect((await episodes(history.project)).map((row) => [row.episode_no, row.id])).toEqual(history.episodeIds);
  });

  it("keeps the v1 run's input, hash, five steps and cap of eight", async () => {
    const bundle = (await store.getRun(history.ws, history.project, history.run.id))!;
    expect(bundle.run.input).toEqual(history.run.input);
    expect(bundle.run.inputHash).toBe(history.run.inputHash);
    expect(bundle.run.callCap).toBe(8);
    expect(bundle.steps.map((step) => step.stepKey)).toEqual(["concept", "outline", "episode:1", "episode:2", "episode:3"]);
    expect(bundle.calls).toHaveLength(5);
  });

  it("widens exactly the episode and step ranges", async () => {
    const ws = history.ws;
    const project = await projectWith(ws, "约束检查");
    const id = randomUUID();
    await expect(pool.query("INSERT INTO episode (id, workspace_id, project_id, episode_no, title) VALUES ($1, $2, $3, 7, 'x')", [id, ws, project]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("UPDATE project SET target_episode_seconds = 120, episode_count = 3 WHERE id = $1", [project])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("UPDATE project SET episode_count = 4 WHERE id = $1", [project])).rejects.toMatchObject({ code: "23514" });
  });
});

describe("works with an episode plan of N = 1, 3, 6", () => {
  it.each([1, 3, 6])("N=%i: approval creates exactly 1..N, the run has N+2 steps, and N scripts are written once", async (count) => {
    const ws = await newWorkspace(`plan-${String(count)}`);
    const project = await projectWith(ws, `作品${String(count)}`, { episodeCount: count, targetEpisodeSeconds: 60 });
    const client = await pool.connect();
    try {
      expect(await projectEpisodePlanIn(client, ws, project)).toEqual({ episodeCount: count, targetEpisodeSeconds: 60 });
    } finally {
      client.release();
    }
    const record = runRecord(ws, project, `run-${String(count)}`, input(count));
    const created = await store.createRun(record, { maxActiveRuns: 5,
      quota: { sinceIso: "2000-01-01T00:00:00.000Z", maxCallsPerDay: 1000, requiredCalls: titleWritingRequiredCalls(count) } });
    expect(created.kind).toBe("created");
    if (created.kind !== "created") return;
    expect(created.bundle.steps.map((step) => [step.stepKey, step.ordinal])).toEqual(titleWritingStepKeysFor(record.input as TitleWritingFrozenInput).map((key, index) => [key, index]));
    expect(created.bundle.run.callCap).toBe(count + 5);
    await completeRun(record, count);
    expect((await store.placeScripts(ws, project, record.id, { acceptStoryChanged: false }, "owner", now())).kind).toBe("story_not_approved");
    await approveCurrentStory(ws, project);
    const made = await episodes(project);
    expect(made.map((row) => row.episode_no)).toEqual(Array.from({ length: count }, (_, index) => index + 1));
    const placed = await store.placeScripts(ws, project, record.id, { acceptStoryChanged: false }, "owner", now());
    expect(placed.kind).toBe("ok");
    const scripts = async () => Number((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM script_revision WHERE project_id = $1", [project])).rows[0]!.n);
    expect(await scripts()).toBe(count);
    await store.placeScripts(ws, project, record.id, { acceptStoryChanged: false }, "owner", now());
    expect(await scripts()).toBe(count);
    // The Mock scene chain covers the same N episodes once their scripts are approved.
    const mock = new MockTextService(pool);
    await expect(mock.loadSources(ws, project)).rejects.toMatchObject({ code: "SCRIPT_REVIEW_REQUIRED" });
    // Approving the story again keeps the same episodes and ids.
    await saveStory(ws, project, "改过的故事");
    await approveCurrentStory(ws, project);
    expect((await episodes(project)).map((row) => row.id)).toEqual(made.map((row) => row.id));
  });

  it("an episode with a script keeps it: placement reports a conflict there and writes the rest", async () => {
    const ws = await newWorkspace("plan-conflict");
    const project = await projectWith(ws, "冲突作品", { episodeCount: 4, targetEpisodeSeconds: 90 });
    const record = runRecord(ws, project, "run-conflict", input(4));
    expect((await store.createRun(record, { maxActiveRuns: 5 })).kind).toBe("created");
    await completeRun(record, 4);
    const story = await approveCurrentStory(ws, project);
    const fourth = (await episodes(project))[3]!;
    const human = (await chain.createScriptRevision({ workspaceId: ws, projectId: project, episodeId: fourth.id, sourceStoryRevisionId: story,
      content: { text: "人写的第四集" }, createdBy: "editor", expectedVersion: fourth.row_version })).revisionId;
    const placed = await store.placeScripts(ws, project, record.id, { acceptStoryChanged: false }, "owner", now());
    expect(placed.kind === "ok" ? placed.bundle.steps.map((step) => step.scriptSave) : placed.kind)
      .toEqual([null, null, "saved", "saved", "saved", "conflict"]);
    expect((await episodes(project))[3]!.current_script_revision_id).toBe(human);
  });

  it("a run whose N differs from the project's episodes writes nothing", async () => {
    const ws = await newWorkspace("plan-mismatch");
    const project = await projectWith(ws, "三集作品");
    const record = runRecord(ws, project, "run-mismatch", input(4));
    expect((await store.createRun(record, { maxActiveRuns: 5 })).kind).toBe("created");
    await completeRun(record, 4);
    await approveCurrentStory(ws, project);
    expect((await store.placeScripts(ws, project, record.id, { acceptStoryChanged: false }, "owner", now())).kind).toBe("plan_mismatch");
    expect(Number((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM script_revision WHERE project_id = $1", [project])).rows[0]!.n)).toBe(0);
  });
});

describe("start quota and concurrency", () => {
  it("fewer than N+2 calls left creates no run and no step; a replay of an existing run is still returned", async () => {
    const ws = await newWorkspace("quota");
    const project = await projectWith(ws, "额度作品", { episodeCount: 6, targetEpisodeSeconds: 90 });
    const quota = (maxCallsPerDay: number) => ({ sinceIso: new Date(Date.now() - 86_400_000).toISOString(), maxCallsPerDay, requiredCalls: 8 });
    const record = runRecord(ws, project, "quota-key", input(6));
    expect((await store.createRun(record, { maxActiveRuns: 5, quota: quota(1000) })).kind).toBe("created");
    await completeRun(record, 6);
    const other = await projectWith(ws, "第二部", { episodeCount: 6, targetEpisodeSeconds: 90 });
    const refused = await store.createRun(runRecord(ws, other, "quota-new", input(6)), { maxActiveRuns: 5, quota: quota(15) });
    expect(refused).toEqual({ kind: "blocked", code: "TITLE_WRITING_DAILY_QUOTA_LOW", requiredCalls: 8, remainingCalls: 7 });
    expect(Number((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM title_writing_run WHERE project_id = $1", [other])).rows[0]!.n)).toBe(0);
    expect((await store.createRun({ ...record, id: randomUUID() }, { maxActiveRuns: 5, quota: quota(8) })).kind).toBe("existing");
  });

  it("the quota check does not wait for the call lock held by a reservation in progress", async () => {
    const ws = await newWorkspace("lock-order");
    const project = await projectWith(ws, "锁顺序", { episodeCount: 2, targetEpisodeSeconds: 60 });
    const holder = independent("episode-plan-call-lock-holder");
    const cleanup: CallLockCleanup = { endedBy: "rollback", queuedSettled: false, problems: [] };
    await holdingCallLock(holder.pool, ws, cleanup, async (track) => {
      const started = Date.now();
      const result = await track(store.createRun(runRecord(ws, project, "lock-order", input(2)), { maxActiveRuns: 5,
        quota: { sinceIso: "2000-01-01T00:00:00.000Z", maxCallsPerDay: 1000, requiredCalls: 4 } }));
      expect(result.kind).toBe("created");
      expect(Date.now() - started).toBeLessThan(5_000);
      evidence.lockOrder = { createRunWhileCallLockHeldMs: Date.now() - started };
    });
    expect(cleanup).toEqual({ endedBy: "rollback", queuedSettled: true, problems: [] });
  });

  it.each(["body_failure", "wait_timeout", "holder_lost"] as const)("cleans the real lock waiter after %s without replacing the original failure", async (failure) => {
    const ws = await newWorkspace(`lock-cleanup-${failure}`);
    const holder = independent(`episode-plan-holder-${failure}`);
    const waiterName = `episode-plan-waiter-${failure}`;
    const waiter = independent(waiterName);
    const cleanup: CallLockCleanup = { endedBy: "rollback", queuedSettled: false, problems: [] };
    const original = new Error(`deliberate ${failure}`);
    let expected: unknown = original;
    let waiterFinished = false;
    const attempt = holdingCallLock(holder.pool, ws, cleanup, async (track, destroy) => {
      const queued = track(waiter.pool.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`title_writing_call:${ws}`])
        .then(() => { waiterFinished = true; }));
      await waitForCallLockWaiter(waiterName);
      if (failure === "wait_timeout") {
        try {
          await bounded(queued, 100, "deliberate blocked query");
        } catch (error) {
          expected = error;
          throw error;
        }
        throw new Error("The deliberately blocked query unexpectedly completed");
      }
      if (failure === "holder_lost") destroy();
      throw original;
    });
    // Handle rejection before doing any other asynchronous work; these are intentionally failing inner operations.
    const outcome = await attempt.then(() => ({ error: null }), (error: unknown) => ({ error }));
    expect(outcome.error).toBe(expected);
    if (failure === "wait_timeout") expect(String(outcome.error)).toContain("deliberate blocked query did not finish");
    expect(waiterFinished).toBe(true);
    expect(cleanup).toEqual({ endedBy: failure === "holder_lost" ? "destroyed" : "rollback", queuedSettled: true, problems: [] });
  });

  it("five sessions replaying one start key make one run with N+2 steps", async () => {
    const ws = await newWorkspace("replay-race");
    const project = await projectWith(ws, "重放", { episodeCount: 5, targetEpisodeSeconds: 60 });
    const frozen = input(5);
    const results = await Promise.all(Array.from({ length: 5 }, (_, index) => independent(`episode-plan-replay-${String(index)}`).store
      .createRun({ ...runRecord(ws, project, "same-key", frozen), id: randomUUID() }, { maxActiveRuns: 5,
        quota: { sinceIso: "2000-01-01T00:00:00.000Z", maxCallsPerDay: 1000, requiredCalls: 7 } })));
    expect(results.map((result) => result.kind).sort()).toEqual(["created", "existing", "existing", "existing", "existing"]);
    const steps = Number((await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM title_writing_step s JOIN title_writing_run r ON r.id = s.run_id WHERE r.project_id = $1", [project])).rows[0]!.n);
    expect(steps).toBe(7);
  });

  it("four sessions racing for the last call of the day: exactly one reservation of a v2 step is persisted", async () => {
    const ws = await newWorkspace("last-call");
    const records = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
      const project = await projectWith(ws, `最后一次${String(index)}`, { episodeCount: 6, targetEpisodeSeconds: 90 });
      const record = runRecord(ws, project, `last-${String(index)}`, input(6));
      expect((await store.createRun(record, { maxActiveRuns: 10 })).kind).toBe("created");
      expect(await store.claimRun(ws, record.id, `exec-${String(index)}`, now(), later(60_000))).toBe(true);
      return record;
    }));
    const limits = { sinceIso: new Date(Date.now() - 86_400_000).toISOString(), maxCallsPerDay: 1 };
    const outcomes = await Promise.all(records.map((record, index) => independent(`episode-plan-last-${String(index)}`).store
      .reserveCall(callOf(record, `exec-${String(index)}`, "concept"), limits, now(), later(60_000))));
    expect(outcomes.filter((outcome) => outcome.kind === "reserved")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === "blocked")).toHaveLength(3);
    expect(Number((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM title_writing_call WHERE workspace_id = $1", [ws])).rows[0]!.n)).toBe(1);
  });
});
