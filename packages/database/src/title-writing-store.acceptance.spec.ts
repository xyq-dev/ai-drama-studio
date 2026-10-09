/**
 * Title writing store acceptance on real PostgreSQL. NOT part of `test` or `integration`: run only with
 * `pnpm --filter @ai-drama/database title-writing:acceptance` against a newly created, empty, disposable database that
 * a person named on purpose (see title-writing-acceptance-guard.ts). It migrates that database through the released
 * migrations only, checks that storage is refused and writes existing business data, then upgrades it through the
 * normal migration chain (which adds the title writing migration) and runs the chain again. The draft SQL is never
 * applied. It never drops or truncates anything; refusal happens before any connection.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EPISODE_DRAFT_SCHEMA,
  EPISODE_OUTLINE_SCHEMA,
  TITLE_CONCEPT_SCHEMA,
  TITLE_WRITING_CANCELED_BEFORE_SEND,
  type TitleCallFinish,
  type TitleCallRecord,
  type TitleResumeRequest,
  type TitleRunRecord,
  type TitleWritingStepKey,
} from "@ai-drama/contracts";
import { canonicalInputHash } from "@ai-drama/domain";
import { runMigrations, type MigrationResult } from "./migrations";
import { TextChainService } from "./text-chain";
import { checkTitleWritingAcceptanceEnv, verifyTitleWritingAcceptanceDatabase } from "./title-writing-acceptance-guard";
import { PostgresTitleWritingStore, TITLE_WRITING_MIGRATION } from "./title-writing-store";

// Refuse before any connection is opened.
const decision = checkTitleWritingAcceptanceEnv(process.env);
if (!decision.ok) throw new Error(`Title writing acceptance refused: ${decision.reason}`);

const acceptanceUrl = decision.url;
const pool = new Pool({ connectionString: acceptanceUrl, max: 8, application_name: "title-acceptance-main" });
const chain = new TextChainService(pool);
const store = new PostgresTitleWritingStore(pool, chain);
/** The migrations released before title writing, in order: the schema a server has before this release. */
const MIGRATIONS_BEFORE = ["20260924000100_m1b_job_core", "20260925000100_m2a_text_chain", "20260928000100_script_dependency_scopes",
  "20260928000200_m3a_media_assets", "20260928000300_m3b_job_shot_lineage"];

/**
 * Evidence of this run, written as JSON when TITLE_WRITING_ACCEPTANCE_EVIDENCE_DIR is set. It holds identities, counts,
 * outcomes and lock waits only: never the connection URL, a password, a token or a key.
 */
const evidence: Record<string, unknown> = {};
const extraPools: Pool[] = [];

/** A store on its own one-connection pool: a separate PostgreSQL session, named so lock waits can be attributed. */
function independent(name: string) {
  const own = new Pool({ connectionString: acceptanceUrl, max: 1, application_name: name });
  // A pooled connection whose session ends is reported here instead of ending the run; the failure-path tests end one.
  own.on("error", (error) => { ((evidence.poolErrors ??= []) as string[]).push(`${name}: ${error.message}`); });
  extraPools.push(own);
  const ownChain = new TextChainService(own);
  return { pool: own, chain: ownChain, store: new PostgresTitleWritingStore(own, ownChain) };
}

beforeAll(async () => {
  const verified = await verifyTitleWritingAcceptanceDatabase(pool, decision.databaseName);
  if (!verified.ok) {
    await pool.end();
    throw new Error(`Title writing acceptance refused: ${verified.reason}`);
  }
  const identity = (await pool.query<{ name: string; version: string; tables: number }>(
    `SELECT current_database() AS name, current_setting('server_version') AS version,
            (SELECT count(*)::int FROM information_schema.tables
              WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg_toast%') AS tables`,
  )).rows[0]!;
  evidence.database = { name: identity.name, serverVersion: identity.version, tablesBeforeWrite: identity.tables };
  // The released schema first: every migration before the title writing one, as on a server before this release.
  released = await runMigrations(pool, undefined, { before: TITLE_WRITING_MIGRATION });
  storageBeforeUpgrade = await store.storageReady();
  existing = await seedExistingData();
  beforeUpgrade = await snapshotExisting();
  // Then the normal deploy path: the unrestricted chain, which applies only what is not recorded yet.
  upgrade = await runMigrations(pool);
  afterUpgrade = await snapshotExisting();
  redeploy = await runMigrations(pool);
  recorded = (await pool.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migration ORDER BY name")).rows;
  evidence.migration = { released: released.applied, storageReadyBeforeUpgrade: storageBeforeUpgrade, upgradeApplied: upgrade.applied,
    upgradeAlreadyApplied: upgrade.alreadyApplied, redeployApplied: redeploy.applied, recorded: recorded.map((row) => row.name),
    existingRows: beforeUpgrade.rows };
});

let released: MigrationResult;
let upgrade: MigrationResult;
let redeploy: MigrationResult;
let storageBeforeUpgrade: boolean;
let existing: Awaited<ReturnType<typeof seedExistingData>>;
let beforeUpgrade: Awaited<ReturnType<typeof snapshotExisting>>;
let afterUpgrade: Awaited<ReturnType<typeof snapshotExisting>>;
let recorded: Array<{ name: string; checksum: string }>;

/**
 * Existing business data of the released schema, written through the same paths the product uses where one exists:
 * a project with an approved story and a script version, a workflow run, a job, an attempt and a cost ledger row.
 */
async function seedExistingData() {
  const ws = await newWorkspace("before-title-writing");
  const project = await newProject(ws, "已有作品");
  const story = await saveHumanStory(ws, project, "上线前的故事");
  await approveCurrentStory(ws, project);
  const first = await episode(project, 1);
  const script = (await chain.createScriptRevision({ workspaceId: ws, projectId: project, episodeId: first.id, sourceStoryRevisionId: story,
    content: { text: "上线前的剧本" }, createdBy: "editor", expectedVersion: first.row_version })).revisionId;
  const provider = await one(`INSERT INTO provider_configuration (workspace_id, provider_key, capability, default_timeout_ms)
    VALUES ($1, 'mock-media', 'image.generate', 30000) RETURNING id`, [ws]);
  const workflow = await one(`INSERT INTO workflow_run (workspace_id, project_id, type, requested_by, input_snapshot)
    VALUES ($1, $2, 'MEDIA_IMAGE', 'before-title-writing', '{}'::jsonb) RETURNING id`, [ws, project]);
  const job = await one(`INSERT INTO generation_job (workspace_id, project_id, workflow_run_id, kind, input_hash, input_snapshot)
    VALUES ($1, $2, $3, 'MEDIA_IMAGE', $4, '{}'::jsonb) RETURNING id`, [ws, project, workflow, "ef".repeat(32)]);
  const attempt = await one(`INSERT INTO job_attempt (workspace_id, generation_job_id, attempt_no, provider_configuration_id,
    provider_request_id, provider_client_request_key, request_snapshot) VALUES ($1, $2, 1, $3, 'before|1', 'client-before', '{}'::jsonb) RETURNING id`,
  [ws, job, provider]);
  const ledger = await one(`INSERT INTO cost_ledger (workspace_id, project_id, generation_job_id, job_attempt_id, idempotency_key,
    provider_configuration_id, provider_request_id, currency, amount_decimal, kind, basis, provider, model)
    VALUES ($1, $2, $3, $4, 'cost:estimate', $5, 'before|1', 'USD', 0.10, 'ESTIMATED', 'LOCALLY_CALCULATED', 'mock-media', 'mock') RETURNING id`,
  [ws, project, job, attempt, provider]);
  return { ws, project, story, script, workflow, job, attempt, ledger };
}

/**
 * Every table that existed before the title writing migration: its row count and a digest of all rows in a fixed
 * order, plus its columns, constraints and indexes. Equal snapshots mean nothing was deleted, rewritten or altered.
 */
async function snapshotExisting() {
  const tables = (await pool.query<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
        AND table_name <> 'schema_migration' AND table_name NOT LIKE 'title_writing_%' ORDER BY 1`)).rows.map((row) => row.name);
  const rows: Record<string, { count: number; digest: string }> = {};
  for (const table of tables) {
    const result = (await pool.query<{ count: number; digest: string | null }>(
      `SELECT count(*)::int AS count, md5(string_agg(row_to_json(t)::text, '|' ORDER BY row_to_json(t)::text)) AS digest FROM ${table} t`)).rows[0]!;
    rows[table] = { count: result.count, digest: result.digest ?? "" };
  }
  const catalog = (await pool.query<{ item: string }>(
    `SELECT format('column %s.%s %s %s %s', table_name, column_name, data_type, is_nullable, coalesce(column_default, '')) AS item
       FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ANY($1)
     UNION ALL
     SELECT format('constraint %s %s', conrelid::regclass::text, pg_get_constraintdef(oid)) FROM pg_constraint
      WHERE connamespace = current_schema()::regnamespace AND conrelid::regclass::text = ANY($1)
     UNION ALL
     SELECT format('index %s', indexdef) FROM pg_indexes WHERE schemaname = current_schema() AND tablename = ANY($1)
     ORDER BY 1`, [tables])).rows.map((row) => row.item);
  return { tables, rows, catalog };
}

async function writeEvidence(): Promise<void> {
  const dir = process.env.TITLE_WRITING_ACCEPTANCE_EVIDENCE_DIR;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "title-writing-store-acceptance.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

afterAll(async () => {
  // Evidence first: closing a pool waits for its connections, and one that never comes back must not stop the evidence.
  await writeEvidence();
  const closing = await Promise.allSettled([...extraPools, pool].map((own) => bounded(own.end(), 10_000, "closing an acceptance pool")));
  const stuck = closing.filter((item) => item.status === "rejected").length;
  evidence.poolsClosed = { total: closing.length, stuck };
  await writeEvidence();
  if (stuck > 0) throw new Error(`${String(stuck)} acceptance pool(s) did not close`);
});

const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const now = () => new Date().toISOString();
/** A logical instant `ms` after `base`: lease tests pass time explicitly instead of waiting for the wall clock. */
const instant = (base: number, ms: number) => new Date(base + ms).toISOString();
const wide = { sinceIso: "2000-01-01T00:00:00.000Z", maxCallsPerDay: 1000 };
const USAGE_UNKNOWN = { status: "unknown" as const, inputTokens: null, outputTokens: null, totalTokens: null };

async function one(sql: string, values: unknown[]): Promise<string> {
  const result = await pool.query<{ id: string }>(sql, values);
  return result.rows[0]!.id;
}

const newWorkspace = (name: string) => one("INSERT INTO workspace (name) VALUES ($1) RETURNING id", [name]);
const newProject = (workspaceId: string, title: string) =>
  one("INSERT INTO project (workspace_id, title) VALUES ($1, $2) RETURNING id", [workspaceId, title]);

function run(workspaceId: string, projectId: string, key: string, hash = "ab".repeat(32)): TitleRunRecord {
  const at = now();
  return {
    id: randomUUID(), workspaceId, projectId, actorId: "server-owner", idempotencyKey: key, inputHash: hash,
    input: { schema: "ads.title-writing.input.v1", promptVersion: "ads.title-writing.prompt.v1", title: "剧名",
      settings: { episodeCount: 3, episodeSeconds: 90, style: "" }, providerKey: "qwen", model: "q-1" },
    state: "running", errorCode: null, cancelRequestedAt: null, executorId: null, leaseUntil: null, callCap: 8, callsUsed: 0,
    storySave: "pending", storyRevisionId: null, createdAt: at, updatedAt: at,
  };
}

function call(record: TitleRunRecord, executorId: string, stepKey: TitleWritingStepKey = "concept", attemptNo = 1): TitleCallRecord {
  return {
    id: randomUUID(), runId: record.id, workspaceId: record.workspaceId, stepKey, attemptNo, providerKey: "qwen", model: "q-1",
    requestHash: "cd".repeat(32), state: "reserved", executorId, providerRequestId: null, responseModel: null, usage: USAGE_UNKNOWN,
    errorCode: null, createdAt: now(), finishedAt: null,
  };
}

const CONCEPT = {
  schema: TITLE_CONCEPT_SCHEMA, genre: "悬疑", logline: "一句话", synopsis: "梗概", protagonistGoal: "目标", opposition: "阻力",
  coreConflict: "冲突", direction: "走向", characters: [{ name: "林夏", role: "主角", profile: "倔强" }, { name: "周岩", role: "刑警", profile: "冷淡" }],
  relationships: [{ name: "林夏与周岩", pressure: "互相怀疑" }],
};
const OUTLINE = { schema: EPISODE_OUTLINE_SCHEMA, episodes: ([1, 2, 3] as const).map((episodeNo) => ({ episodeNo, title: `集${String(episodeNo)}`,
  entryState: "a", goal: "b", action: "c", turn: "d", result: "e", handoff: "f" })) };
const EPISODE = (episodeNo: 1 | 2 | 3) => ({ schema: EPISODE_DRAFT_SCHEMA, episodeNo, title: `第 ${String(episodeNo)} 集`, screenplay: "剧本正文",
  scenes: [{ heading: "便利店 夜", action: "林夏看监控。", dialogue: "", sound: "" }], handoffFacts: [`第${String(episodeNo)}集事实`] });
const OUTPUTS: Array<[TitleWritingStepKey, TitleCallFinish["output"]]> = [
  ["concept", CONCEPT], ["outline", OUTLINE], ["episode:1", EPISODE(1)], ["episode:2", EPISODE(2)], ["episode:3", EPISODE(3)],
] as never;

function completed(output: TitleCallFinish["output"]): TitleCallFinish {
  return { state: "completed", errorCode: null, providerRequestId: "req", responseModel: "q-1",
    usage: { status: "present", inputTokens: 10, outputTokens: 20, totalTokens: 30 }, output, outputHash: canonicalInputHash(output) };
}

/** Drives a run through the real store lifecycle: every step reserved, submitted and finished with a valid output. */
async function completeRun(record: TitleRunRecord, executor = "exec"): Promise<void> {
  expect(await store.claimRun(record.workspaceId, record.id, executor, now(), later(60_000))).toBe(true);
  for (const [stepKey, output] of OUTPUTS) {
    const item = call(record, executor, stepKey);
    expect(await store.reserveCall(item, wide, now(), later(60_000))).toEqual({ kind: "reserved" });
    expect(await store.markCallSubmitted(record.workspaceId, item.id, executor, now(), later(60_000))).toBe("submitted");
    expect(await store.finishCall(record.workspaceId, item.id, executor, completed(output), now())).toBe(true);
  }
  expect(await store.saveStory(record.workspaceId, record.id, executor, "故事正文", "server-owner", now())).toBe("saved");
  expect(await store.finishRun(record.workspaceId, record.id, executor, "completed", null, now())).toBe(true);
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

async function saveHumanStory(workspaceId: string, projectId: string, text: string): Promise<string> {
  const version = (await pool.query<{ version: number }>("SELECT version FROM project WHERE id = $1", [projectId])).rows[0]!.version;
  return (await chain.createStoryRevision({ workspaceId, projectId, content: { text }, createdBy: "editor", expectedVersion: version })).revisionId;
}

async function episode(projectId: string, episodeNo: number) {
  return (await pool.query<{ id: string; row_version: number; current_script_revision_id: string | null }>(
    "SELECT id, row_version, current_script_revision_id FROM episode WHERE project_id = $1 AND episode_no = $2", [projectId, episodeNo])).rows[0]!;
}

const scriptCount = async (projectId: string) =>
  Number((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM script_revision WHERE project_id = $1", [projectId])).rows[0]!.n);

async function stopRunning(): Promise<void> {
  await pool.query("UPDATE title_writing_run SET state = 'failed', executor_id = NULL, lease_until = NULL WHERE state = 'running'");
}

function resumeRequest(runId: string, key: string, confirmed: string[]): TitleResumeRequest {
  return { resumeKey: key, requestHash: canonicalInputHash({ runId, confirmUncertainCallIds: [...confirmed].sort() }), confirmedCallIds: confirmed,
    maxActiveRuns: 5 };
}

describe("PostgresTitleWritingStore on the migrated tables", () => {
  let workspaceId: string;
  let projectId: string;
  let otherProjectId: string;

  beforeAll(async () => {
    workspaceId = await newWorkspace("title");
    projectId = await newProject(workspaceId, "a");
    otherProjectId = await newProject(workspaceId, "b");
  });

  it("is ready, replays the same key, refuses a different input and admits one running run per project", async () => {
    expect(await store.storageReady()).toBe(true);
    const first = run(workspaceId, projectId, "k1");
    expect((await store.createRun(first, { maxActiveRuns: 5 })).kind).toBe("created");
    expect((await store.createRun({ ...run(workspaceId, projectId, "k1"), inputHash: first.inputHash }, { maxActiveRuns: 5 })).kind).toBe("existing");
    expect((await store.createRun(run(workspaceId, projectId, "k1", "ef".repeat(32)), { maxActiveRuns: 5 })).kind).toBe("conflict");
    expect((await store.createRun(run(workspaceId, projectId, "k2"), { maxActiveRuns: 5 })).kind).toBe("active");
    const bundle = await store.getRun(workspaceId, projectId, first.id);
    expect(bundle?.steps.map((step) => step.stepKey)).toEqual(["concept", "outline", "episode:1", "episode:2", "episode:3"]);
  });

  it("admits one start when different projects race on the workspace cap", async () => {
    await stopRunning();
    const results = await Promise.all([run(workspaceId, projectId, "r1"), run(workspaceId, otherProjectId, "r2")]
      .map((item) => store.createRun(item, { maxActiveRuns: 1 })));
    expect(results.filter((result) => result.kind === "created")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "blocked")).toHaveLength(1);
  });

  it("fences calls to the owning executor and recovers a sent call as unknown", async () => {
    await stopRunning();
    const record = run(workspaceId, projectId, "fence");
    await store.createRun(record, { maxActiveRuns: 5 });
    const base = Date.now();
    const setupAt = instant(base, 0);
    const leaseUntil = instant(base, 60_000);
    const expired = instant(base, 120_000);
    expect(await store.claimRun(workspaceId, record.id, "a", setupAt, leaseUntil)).toBe(true);
    expect(await store.claimRun(workspaceId, record.id, "b", setupAt, leaseUntil)).toBe(false);
    const first = call(record, "a");
    expect(await store.reserveCall(first, wide, setupAt, leaseUntil)).toEqual({ kind: "reserved" });
    expect(await store.markCallSubmitted(workspaceId, first.id, "b", setupAt, leaseUntil)).toBe("lost");
    expect(await store.markCallSubmitted(workspaceId, first.id, "a", setupAt, leaseUntil)).toBe("submitted");
    expect(await store.recoverExpired(workspaceId, expired)).toBe(1);
    expect(await store.finishCall(workspaceId, first.id, "a", completed(CONCEPT as never), expired)).toBe(false);
    const bundle = (await store.getRunById(workspaceId, record.id))!;
    expect(bundle.run).toMatchObject({ state: "needs_attention", errorCode: "executor_lost", executorId: null });
    expect(bundle.calls[0]).toMatchObject({ state: "unknown", errorCode: "executor_lost", usage: USAGE_UNKNOWN });
    expect(bundle.steps[0]).toMatchObject({ state: "unknown" });
  });

  // One sequential refusal once the cap is reached. It does not show that concurrent reservations cannot both take the
  // last remaining call; that needs its own concurrent test.
  it("refuses a reservation once the workspace daily call cap is reached", async () => {
    await stopRunning();
    const record = run(workspaceId, projectId, "cap");
    await store.createRun(record, { maxActiveRuns: 5 });
    await store.claimRun(workspaceId, record.id, "a", now(), later(60_000));
    const used = Number((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM title_writing_call WHERE workspace_id = $1", [workspaceId])).rows[0]!.n);
    expect(await store.reserveCall(call(record, "a"), { ...wide, maxCallsPerDay: used }, now(), later(60_000)))
      .toEqual({ kind: "blocked", code: "TITLE_WRITING_DAILY_CAP" });
  });

  it("saves the story as a DRAFT revision once and reports a conflict when a story already exists", async () => {
    await stopRunning();
    const fresh = await newProject(workspaceId, "c");
    const record = run(workspaceId, fresh, "story");
    await store.createRun(record, { maxActiveRuns: 5 });
    await store.claimRun(workspaceId, record.id, "a", now(), later(60_000));
    expect(await store.saveStory(workspaceId, record.id, "a", "故事正文", "server-owner", now())).toBe("saved");
    expect(await store.saveStory(workspaceId, record.id, "a", "故事正文", "server-owner", now())).toBe("saved");
    const stories = await pool.query<{ review_status: string; content_json: unknown }>(
      "SELECT review_status, content_json FROM story_revision WHERE project_id = $1", [fresh]);
    expect(stories.rows).toEqual([{ review_status: "DRAFT", content_json: { text: "故事正文" } }]);
    await store.finishRun(workspaceId, record.id, "a", "needs_attention", null, now());
    const second = run(workspaceId, fresh, "story-2", "12".repeat(32));
    await store.createRun(second, { maxActiveRuns: 5 });
    await store.claimRun(workspaceId, second.id, "a", now(), later(60_000));
    expect(await store.saveStory(workspaceId, second.id, "a", "另一份", "server-owner", now())).toBe("conflict");
    expect((await pool.query("SELECT 1 FROM story_revision WHERE project_id = $1", [fresh])).rowCount).toBe(1);
  });
});

describe("R3: one workspace never touches another", () => {
  it("recovery, listing, claim, read, submit and finish of workspace A skip workspace B's runs", async () => {
    await stopRunning();
    const wa = await newWorkspace("ws-a");
    const wb = await newWorkspace("ws-b");
    const pb = await newProject(wb, "b");
    const pb2 = await newProject(wb, "b2");
    const sent = run(wb, pb, "sent");
    await store.createRun(sent, { maxActiveRuns: 5 });
    // Preparation runs on one logical instant with a lease far longer than any database round trip, so B's executor
    // cannot lose its own run before the call is submitted. Afterwards every check passes an instant past that lease.
    const base = Date.now();
    const setupAt = instant(base, 0);
    const leaseUntil = instant(base, 60_000);
    const expired = instant(base, 120_000);
    expect(await store.claimRun(wb, sent.id, "dead-b", setupAt, leaseUntil)).toBe(true);
    const bCall = call(sent, "dead-b");
    expect(await store.reserveCall(bCall, wide, setupAt, leaseUntil)).toEqual({ kind: "reserved" });
    expect(await store.markCallSubmitted(wb, bCall.id, "dead-b", setupAt, leaseUntil)).toBe("submitted");
    const idle = run(wb, pb2, "idle");
    await store.createRun(idle, { maxActiveRuns: 5 });
    const before = await pool.query("SELECT * FROM title_writing_run WHERE workspace_id = $1 ORDER BY id", [wb]);

    expect(await store.recoverExpired(wa, expired)).toBe(0);
    expect(await store.listClaimable(wa, expired, 50)).toEqual([]);
    expect(await store.claimRun(wa, idle.id, "exec-a", expired, instant(base, 180_000))).toBe(false);
    expect(await store.getRunById(wa, sent.id)).toBeNull();
    expect(await store.markCallSubmitted(wa, bCall.id, "dead-b", expired, instant(base, 180_000))).toBe("lost");
    expect(await store.finishCall(wa, bCall.id, "dead-b", completed(CONCEPT as never), expired)).toBe(false);
    expect(await store.finishRun(wa, sent.id, "dead-b", "failed", null, expired)).toBe(false);
    expect(await store.reserveCall({ ...call(idle, "exec-a"), workspaceId: wa }, wide, expired, instant(base, 180_000))).toEqual({ kind: "lost" });
    expect((await pool.query("SELECT * FROM title_writing_run WHERE workspace_id = $1 ORDER BY id", [wb])).rows).toEqual(before.rows);

    expect(await store.recoverExpired(wb, expired)).toBe(1);
    expect((await store.getRunById(wb, sent.id))!.run).toMatchObject({ state: "needs_attention", errorCode: "executor_lost" });
    expect(await store.listClaimable(wb, expired, 50)).toEqual([idle.id]);
  });
});

describe("R5: cancel against submission", () => {
  it("cancel committed first closes the reservation unsent; submission first keeps the sent call's outcome", async () => {
    await stopRunning();
    const ws = await newWorkspace("cancel");
    const first = run(ws, await newProject(ws, "c1"), "cancel-first");
    await store.createRun(first, { maxActiveRuns: 5 });
    await store.claimRun(ws, first.id, "a", now(), later(60_000));
    const reserved = call(first, "a");
    await store.reserveCall(reserved, wide, now(), later(60_000));
    await store.requestCancel(ws, first.projectId, first.id, now());
    expect(await store.markCallSubmitted(ws, reserved.id, "a", now(), later(60_000))).toBe("canceled");
    let bundle = (await store.getRunById(ws, first.id))!;
    expect(bundle.calls).toEqual([expect.objectContaining({ state: "rejected", errorCode: TITLE_WRITING_CANCELED_BEFORE_SEND, usage: USAGE_UNKNOWN })]);
    expect(bundle.steps[0]).toMatchObject({ state: "canceled" });
    expect((await pool.query("SELECT 1 FROM title_writing_call WHERE run_id = $1 AND state IN ('reserved', 'submitted')", [first.id])).rowCount).toBe(0);

    const second = run(ws, await newProject(ws, "c2"), "submit-first");
    await store.createRun(second, { maxActiveRuns: 5 });
    await store.claimRun(ws, second.id, "a", now(), later(60_000));
    const sent = call(second, "a");
    await store.reserveCall(sent, wide, now(), later(60_000));
    expect(await store.markCallSubmitted(ws, sent.id, "a", now(), later(60_000))).toBe("submitted");
    await store.requestCancel(ws, second.projectId, second.id, now());
    expect(await store.finishCall(ws, sent.id, "a", completed(CONCEPT as never), now())).toBe(true);
    bundle = (await store.getRunById(ws, second.id))!;
    expect(bundle.calls[0]).toMatchObject({ state: "completed", usage: { status: "present" } });
    expect(bundle.run.cancelRequestedAt).not.toBeNull();
  });

  it("racing cancel and submission always end in exactly one consistent state", async () => {
    await stopRunning();
    const ws = await newWorkspace("cancel-race");
    for (let index = 0; index < 10; index += 1) {
      const record = run(ws, await newProject(ws, `r${String(index)}`), `race-${String(index)}`);
      await store.createRun(record, { maxActiveRuns: 50 });
      await store.claimRun(ws, record.id, "a", now(), later(60_000));
      const item = call(record, "a");
      await store.reserveCall(item, wide, now(), later(60_000));
      const [submission] = await Promise.all([
        store.markCallSubmitted(ws, item.id, "a", now(), later(60_000)),
        store.requestCancel(ws, record.projectId, record.id, now()),
      ]);
      const state = (await pool.query<{ state: string }>("SELECT state FROM title_writing_call WHERE id = $1", [item.id])).rows[0]!.state;
      expect(submission === "submitted" ? state === "submitted" : submission === "canceled" && state === "rejected").toBe(true);
    }
  });
});

describe("R2: resume confirmation and idempotency", () => {
  it("binds the confirmation to the current uncertain call and applies one action once", async () => {
    await stopRunning();
    const ws = await newWorkspace("resume");
    const record = run(ws, await newProject(ws, "r"), "resume");
    await store.createRun(record, { maxActiveRuns: 5 });
    await store.claimRun(ws, record.id, "a", now(), later(60_000));
    const firstCall = call(record, "a");
    await store.reserveCall(firstCall, wide, now(), later(60_000));
    await store.markCallSubmitted(ws, firstCall.id, "a", now(), later(60_000));
    await store.finishCall(ws, firstCall.id, "a", { ...completed(null), state: "unknown", errorCode: "timeout", usage: USAGE_UNKNOWN, outputHash: null }, now());
    await store.finishRun(ws, record.id, "a", "needs_attention", "timeout", now());

    expect(await store.prepareResume(ws, record.projectId, record.id, resumeRequest(record.id, "k0", []), now())).toEqual({ kind: "needs_confirmation" });
    expect(await store.prepareResume(ws, record.projectId, record.id, resumeRequest(record.id, "k0", [randomUUID()]), now())).toEqual({ kind: "stale_confirmation" });
    const accepted = await Promise.all([1, 2, 3].map(() =>
      store.prepareResume(ws, record.projectId, record.id, resumeRequest(record.id, "k1", [firstCall.id]), now())));
    expect(accepted.map((item) => item.kind).sort()).toEqual(["ok", "replayed", "replayed"]);
    expect((await pool.query("SELECT 1 FROM title_writing_resume WHERE run_id = $1", [record.id])).rowCount).toBe(1);
    expect((await store.prepareResume(ws, record.projectId, record.id, resumeRequest(record.id, "k1", []), now())).kind).toBe("key_conflict");

    // Attempt 2 is uncertain too: the old confirmation does not cover it, under the old key or a new one.
    await store.claimRun(ws, record.id, "a", now(), later(60_000));
    const secondCall = call(record, "a", "concept", 2);
    expect(await store.reserveCall(secondCall, wide, now(), later(60_000))).toEqual({ kind: "reserved" });
    await store.markCallSubmitted(ws, secondCall.id, "a", now(), later(60_000));
    await store.finishCall(ws, secondCall.id, "a", { ...completed(null), state: "unknown", errorCode: "timeout", usage: USAGE_UNKNOWN, outputHash: null }, now());
    await store.finishRun(ws, record.id, "a", "needs_attention", "timeout", now());
    expect((await store.prepareResume(ws, record.projectId, record.id, resumeRequest(record.id, "k1", [firstCall.id]), now())).kind).toBe("replayed");
    expect((await store.getRunById(ws, record.id))!.run.state).toBe("needs_attention");
    expect((await store.prepareResume(ws, record.projectId, record.id, resumeRequest(record.id, "k2", [firstCall.id]), now())).kind).toBe("stale_confirmation");
    expect((await store.prepareResume(ws, record.projectId, record.id, resumeRequest(record.id, "k3", [secondCall.id]), now())).kind).toBe("ok");
    const calls = (await store.getRunById(ws, record.id))!.calls;
    expect(calls.map((item) => [item.state, item.usage.status])).toEqual([["unknown", "unknown"], ["unknown", "unknown"]]);
  });
});

describe("R7: scripts go into episodes only after the person approved this run's story", () => {
  it("refuses before approval, then writes all three once; a replay adds no version", async () => {
    await stopRunning();
    const ws = await newWorkspace("place");
    const project = await newProject(ws, "place");
    const record = run(ws, project, "place");
    await store.createRun(record, { maxActiveRuns: 5 });
    await completeRun(record);
    expect((await store.placeScripts(ws, project, record.id, { acceptStoryChanged: false }, "editor", now())).kind).toBe("story_not_approved");
    const approved = await approveCurrentStory(ws, project);
    expect((await store.getRunById(ws, record.id))!.run.storyRevisionId).toBe(approved);
    const placed = await store.placeScripts(ws, project, record.id, { acceptStoryChanged: false }, "editor", now());
    expect(placed.kind).toBe("ok");
    expect(placed.kind === "ok" && placed.bundle.steps.slice(2).map((step) => step.scriptSave)).toEqual(["saved", "saved", "saved"]);
    const scripts = await pool.query<{ source_story_revision_id: string; review_status: string }>(
      "SELECT source_story_revision_id, review_status FROM script_revision WHERE project_id = $1", [project]);
    expect(scripts.rows).toHaveLength(3);
    expect(scripts.rows.every((row) => row.source_story_revision_id === approved && row.review_status === "DRAFT")).toBe(true);
    expect((await store.placeScripts(ws, project, record.id, { acceptStoryChanged: false }, "editor", now())).kind).toBe("ok");
    expect(await scriptCount(project)).toBe(3);
  });

  it("an episode that already has a script is a conflict and is not overwritten; the others are written", async () => {
    await stopRunning();
    const ws = await newWorkspace("place-conflict");
    const project = await newProject(ws, "conflict");
    const record = run(ws, project, "conflict");
    await store.createRun(record, { maxActiveRuns: 5 });
    await completeRun(record);
    const approved = await approveCurrentStory(ws, project);
    const second = await episode(project, 2);
    const human = await chain.createScriptRevision({ workspaceId: ws, projectId: project, episodeId: second.id, sourceStoryRevisionId: approved,
      content: { text: "人工剧本" }, createdBy: "editor", expectedVersion: second.row_version });
    const placed = await store.placeScripts(ws, project, record.id, { acceptStoryChanged: false }, "editor", now());
    expect(placed.kind === "ok" && placed.bundle.steps.slice(2).map((step) => step.scriptSave)).toEqual(["saved", "conflict", "saved"]);
    expect((await episode(project, 2)).current_script_revision_id).toBe(human.revisionId);
    expect(await scriptCount(project)).toBe(3);
  });

  it("a story changed after the run is refused unless accepted; an unapproved current story is refused", async () => {
    await stopRunning();
    const ws = await newWorkspace("place-changed");
    const project = await newProject(ws, "changed");
    const record = run(ws, project, "changed");
    await store.createRun(record, { maxActiveRuns: 5 });
    await completeRun(record);
    await saveHumanStory(ws, project, "人工改过的故事");
    expect((await store.placeScripts(ws, project, record.id, { acceptStoryChanged: false }, "editor", now())).kind).toBe("story_not_approved");
    await approveCurrentStory(ws, project);
    expect((await store.placeScripts(ws, project, record.id, { acceptStoryChanged: false }, "editor", now())).kind).toBe("story_changed");
    expect(await scriptCount(project)).toBe(0);
    expect((await store.placeScripts(ws, project, record.id, { acceptStoryChanged: true }, "editor", now())).kind).toBe("ok");
    expect(await scriptCount(project)).toBe(3);
  });
});

// Five rounds of an unordered Promise.allSettled race. The scheduler decides the interleaving, so passing rounds do not
// prove the lock order excludes a deadlock; that needs a test that makes one side wait on the other's lock on purpose
// and records the wait (for example from pg_locks) before releasing it.
describe("R6: script import and a person's save on the same episode", () => {
  it("in these racing rounds, neither deadlocks nor overwrites the other", async () => {
    await stopRunning();
    const ws = await newWorkspace("lock-order");
    for (let index = 0; index < 5; index += 1) {
      const project = await newProject(ws, `lock-${String(index)}`);
      const record = run(ws, project, `lock-${String(index)}`);
      await store.createRun(record, { maxActiveRuns: 50 });
      await completeRun(record);
      const approved = await approveCurrentStory(ws, project);
      const target = await episode(project, 1);
      const [imported, saved] = await Promise.allSettled([
        store.placeScripts(ws, project, record.id, { acceptStoryChanged: false }, "editor", now()),
        chain.createScriptRevision({ workspaceId: ws, projectId: project, episodeId: target.id, sourceStoryRevisionId: approved,
          content: { text: "人工剧本" }, createdBy: "editor", expectedVersion: target.row_version }),
      ]);
      for (const outcome of [imported, saved]) {
        if (outcome.status === "rejected") expect((outcome.reason as { code?: string }).code).not.toBe("40P01");
      }
      expect(imported.status).toBe("fulfilled");
      const step = (await store.getRunById(ws, record.id))!.steps.find((item) => item.stepKey === "episode:1")!;
      const current = (await episode(project, 1)).current_script_revision_id;
      if (saved.status === "fulfilled") {
        // The person's save won the episode: either it came first (import sees a conflict) or it replaced the import.
        expect(current).toBe(saved.value.revisionId);
      } else {
        expect((saved.reason as { code?: string }).code).toBe("REVISION_CONFLICT");
        expect(step.scriptSave).toBe("saved");
        expect(current).toBe(step.scriptRevisionId);
      }
    }
  });
});

describe("formal migration on a database of the released schema", () => {
  it("refuses storage before the migration: the released schema has no title writing tables", () => {
    expect(released.applied).toEqual(MIGRATIONS_BEFORE);
    expect(storageBeforeUpgrade).toBe(false);
  });

  it("upgrades through the normal chain, applying only the title writing migration with its file's checksum", async () => {
    expect(upgrade.applied).toEqual([TITLE_WRITING_MIGRATION]);
    expect(upgrade.alreadyApplied).toEqual(MIGRATIONS_BEFORE);
    const sql = await readFile(join(__dirname, "..", "prisma", "migrations", TITLE_WRITING_MIGRATION, "migration.sql"), "utf8");
    expect(recorded.find((row) => row.name === TITLE_WRITING_MIGRATION)?.checksum).toBe(createHash("sha256").update(sql).digest("hex"));
    expect(recorded.map((row) => row.name)).toEqual([...MIGRATIONS_BEFORE, TITLE_WRITING_MIGRATION]);
    expect(await store.storageReady()).toBe(true);
  });

  it("leaves every existing table's rows, columns, constraints and indexes as they were", () => {
    expect(afterUpgrade.tables).toEqual(beforeUpgrade.tables);
    expect(afterUpgrade.rows).toEqual(beforeUpgrade.rows);
    expect(afterUpgrade.catalog).toEqual(beforeUpgrade.catalog);
    for (const table of ["project", "story_revision", "script_revision", "episode", "workflow_run", "generation_job", "job_attempt", "cost_ledger"]) {
      expect(beforeUpgrade.rows[table]?.count, table).toBeGreaterThan(0);
    }
  });

  it("keeps the existing project, versions, job and ledger readable by their ids after the upgrade", async () => {
    const read = async (sql: string, id: string) => (await pool.query(sql, [id])).rowCount;
    expect(await read("SELECT 1 FROM project WHERE id = $1 AND title = '已有作品'", existing.project)).toBe(1);
    expect(await read("SELECT 1 FROM story_revision WHERE id = $1 AND review_status = 'APPROVED'", existing.story)).toBe(1);
    expect(await read("SELECT 1 FROM script_revision WHERE id = $1", existing.script)).toBe(1);
    expect(await read("SELECT 1 FROM generation_job WHERE id = $1", existing.job)).toBe(1);
    expect(await read("SELECT 1 FROM cost_ledger WHERE id = $1 AND amount_decimal = 0.10", existing.ledger)).toBe(1);
  });

  it("does nothing when the deploy command runs again", async () => {
    expect(redeploy.applied).toEqual([]);
    expect(redeploy.alreadyApplied).toEqual([...MIGRATIONS_BEFORE, TITLE_WRITING_MIGRATION]);
    expect((await pool.query("SELECT 1 FROM schema_migration WHERE name = $1", [TITLE_WRITING_MIGRATION])).rowCount).toBe(1);
  });
});

describe("migrated schema on PostgreSQL", () => {
  it("creates the four tables with the declared keys, foreign keys, partial indexes and checks", async () => {
    const tables = (await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE 'title_writing_%'
        ORDER BY table_name`)).rows.map((row) => row.table_name);
    expect(tables).toEqual(["title_writing_call", "title_writing_resume", "title_writing_run", "title_writing_step"]);
    const constraints = (await pool.query<{ rel: string; type: string; def: string }>(
      `SELECT conrelid::regclass::text AS rel, contype::text AS type, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid::regclass::text LIKE 'title_writing_%' ORDER BY 1, 2, 3`)).rows;
    const keyed = constraints.filter((row) => row.type !== "c").map((row) => `${row.rel} ${row.def}`).sort();
    expect(keyed).toEqual([
      "title_writing_call FOREIGN KEY (run_id, step_key) REFERENCES title_writing_step(run_id, step_key) ON DELETE CASCADE",
      "title_writing_call PRIMARY KEY (id)",
      "title_writing_call UNIQUE (run_id, step_key, attempt_no)",
      "title_writing_resume FOREIGN KEY (run_id, workspace_id) REFERENCES title_writing_run(id, workspace_id) ON DELETE CASCADE",
      "title_writing_resume PRIMARY KEY (run_id, idempotency_key)",
      "title_writing_run FOREIGN KEY (project_id, workspace_id) REFERENCES project(id, workspace_id)",
      "title_writing_run FOREIGN KEY (story_revision_id, project_id, workspace_id) REFERENCES story_revision(id, project_id, workspace_id)",
      "title_writing_run PRIMARY KEY (id)",
      "title_writing_run UNIQUE (id, workspace_id)",
      "title_writing_run UNIQUE (workspace_id, actor_id, idempotency_key)",
      "title_writing_step FOREIGN KEY (run_id, workspace_id) REFERENCES title_writing_run(id, workspace_id) ON DELETE CASCADE",
      "title_writing_step FOREIGN KEY (script_revision_id) REFERENCES script_revision(id)",
      "title_writing_step PRIMARY KEY (run_id, step_key)",
      "title_writing_step UNIQUE (run_id, ordinal)",
    ].sort());
    const checks = constraints.filter((row) => row.type === "c");
    expect(checks.some((row) => row.rel === "title_writing_call" && row.def.includes("billing_status = 'unknown'"))).toBe(true);
    const indexes = (await pool.query<{ name: string; def: string }>(
      `SELECT indexname AS name, indexdef AS def FROM pg_indexes WHERE schemaname = current_schema() AND tablename LIKE 'title_writing_%'
          AND indexname IN ('title_writing_run_one_running_idx', 'title_writing_run_project_idx', 'title_writing_run_lease_idx',
                            'title_writing_call_recent_idx', 'title_writing_call_open_idx') ORDER BY 1`)).rows;
    expect(indexes.map((row) => row.name)).toEqual(["title_writing_call_open_idx", "title_writing_call_recent_idx",
      "title_writing_run_lease_idx", "title_writing_run_one_running_idx", "title_writing_run_project_idx"]);
    const oneRunning = indexes.find((row) => row.name === "title_writing_run_one_running_idx")!.def;
    expect(oneRunning).toMatch(/^CREATE UNIQUE INDEX .* WHERE \(state = 'running'::text\)$/);
    expect(await store.storageReady()).toBe(true);
    evidence.schema = { tables, keyed, checkConstraints: checks.length, indexes };
  });

  it("refuses a cost written as anything but unknown", async () => {
    await stopRunning();
    const ws = await newWorkspace("billing");
    const record = run(ws, await newProject(ws, "billing"), "billing");
    await store.createRun(record, { maxActiveRuns: 50 });
    await store.claimRun(ws, record.id, "a", now(), later(60_000));
    const item = call(record, "a");
    await store.reserveCall(item, wide, now(), later(60_000));
    await expect(pool.query("UPDATE title_writing_call SET billing_status = '0' WHERE id = $1", [item.id])).rejects.toMatchObject({ code: "23514" });
    expect((await pool.query<{ billing_status: string }>("SELECT billing_status FROM title_writing_call WHERE id = $1", [item.id])).rows[0]!.billing_status)
      .toBe("unknown");
  });
});

describe("races between independent PostgreSQL sessions", () => {
  it("one executor wins a claim raced by six sessions", async () => {
    await stopRunning();
    const ws = await newWorkspace("claim-race");
    const record = run(ws, await newProject(ws, "claim"), "claim-race");
    await store.createRun(record, { maxActiveRuns: 50 });
    const sessions = [1, 2, 3, 4, 5, 6].map((index) => independent(`title-claim-${String(index)}`));
    const base = Date.now();
    const won = await Promise.all(sessions.map((session, index) =>
      session.store.claimRun(ws, record.id, `exec-${String(index)}`, instant(base, 0), instant(base, 60_000))));
    expect(won.filter(Boolean)).toHaveLength(1);
    const winner = `exec-${String(won.indexOf(true))}`;
    expect((await pool.query<{ executor_id: string }>("SELECT executor_id FROM title_writing_run WHERE id = $1", [record.id])).rows[0]!.executor_id)
      .toBe(winner);
    evidence.claimRace = { sessions: sessions.length, winners: won.filter(Boolean).length };
  });

  it("one key replayed by five sessions is one run; the same key with another input is refused", async () => {
    await stopRunning();
    const ws = await newWorkspace("key-race");
    const project = await newProject(ws, "key");
    const template = run(ws, project, "same-key");
    const sessions = [1, 2, 3, 4, 5].map((index) => independent(`title-key-${String(index)}`));
    const outcomes = await Promise.all(sessions.map((session) =>
      session.store.createRun({ ...template, id: randomUUID() }, { maxActiveRuns: 50 })));
    expect(outcomes.map((item) => item.kind).sort()).toEqual(["created", "existing", "existing", "existing", "existing"]);
    const ids = new Set(outcomes.map((item) => (item as { bundle: { run: { id: string } } }).bundle.run.id));
    expect(ids.size).toBe(1);
    expect((await pool.query("SELECT 1 FROM title_writing_run WHERE workspace_id = $1", [ws])).rowCount).toBe(1);
    expect((await pool.query("SELECT 1 FROM title_writing_call WHERE workspace_id = $1", [ws])).rowCount).toBe(0);
    expect((await store.createRun({ ...template, id: randomUUID(), inputHash: "ef".repeat(32) }, { maxActiveRuns: 50 })).kind).toBe("conflict");
    evidence.idempotencyRace = { sessions: sessions.length, outcomes: outcomes.map((item) => item.kind).sort(), runs: 1 };
  });

  it("six sessions starting six works never exceed a workspace cap of two running runs", async () => {
    await stopRunning();
    const ws = await newWorkspace("active-race");
    const records: TitleRunRecord[] = [];
    for (let index = 0; index < 6; index += 1) records.push(run(ws, await newProject(ws, `w${String(index)}`), `active-${String(index)}`));
    const sessions = records.map((_, index) => independent(`title-active-${String(index)}`));
    const outcomes = await Promise.all(records.map((record, index) => sessions[index]!.store.createRun(record, { maxActiveRuns: 2 })));
    expect(outcomes.filter((item) => item.kind === "created")).toHaveLength(2);
    expect(outcomes.filter((item) => item.kind === "blocked" && item.code === "TITLE_WRITING_ACTIVE_RUN_CAP")).toHaveLength(4);
    expect(Number((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM title_writing_run WHERE workspace_id = $1 AND state = 'running'", [ws]))
      .rows[0]!.n)).toBe(2);
    evidence.activeCapRace = { sessions: sessions.length, cap: 2, created: 2, blocked: 4 };
  });

  it("four sessions racing for the last daily call: exactly one reservation is persisted", async () => {
    await stopRunning();
    const ws = await newWorkspace("daily-last");
    const base = Date.now();
    const lease = instant(base, 60_000);
    const records: TitleRunRecord[] = [];
    for (let index = 0; index < 5; index += 1) {
      const record = run(ws, await newProject(ws, `d${String(index)}`), `daily-${String(index)}`);
      await store.createRun(record, { maxActiveRuns: 50 });
      expect(await store.claimRun(ws, record.id, `exec-${String(index)}`, instant(base, 0), lease)).toBe(true);
      records.push(record);
    }
    // Two calls are already used in this window; the cap leaves exactly one.
    for (const stepKey of ["concept", "outline"] as const) {
      expect(await store.reserveCall(call(records[0]!, "exec-0", stepKey), wide, instant(base, 0), lease)).toEqual({ kind: "reserved" });
    }
    const cap = { sinceIso: "2000-01-01T00:00:00.000Z", maxCallsPerDay: 3 };
    const contenders = records.slice(1);
    const sessions = contenders.map((_, index) => independent(`title-daily-${String(index)}`));
    const outcomes = await Promise.all(contenders.map((record, index) =>
      sessions[index]!.store.reserveCall(call(record, `exec-${String(index + 1)}`), cap, instant(base, 1), lease)));
    expect(outcomes.filter((item) => item.kind === "reserved")).toHaveLength(1);
    expect(outcomes.filter((item) => item.kind === "blocked" && item.code === "TITLE_WRITING_DAILY_CAP")).toHaveLength(3);
    const persisted = (await pool.query<{ run_id: string }>("SELECT run_id FROM title_writing_call WHERE workspace_id = $1", [ws])).rows;
    expect(persisted).toHaveLength(3);
    const winner = contenders[outcomes.findIndex((item) => item.kind === "reserved")]!;
    expect(persisted.filter((row) => row.run_id === winner.id)).toHaveLength(1);
    const used = (await pool.query<{ calls_used: number }>("SELECT calls_used FROM title_writing_run WHERE workspace_id = $1", [ws])).rows;
    expect(used.reduce((sum, row) => sum + row.calls_used, 0)).toBe(3);
    evidence.dailyCapLastSlot = { sessions: sessions.length, cap: 3, usedBefore: 2, reserved: 1, blocked: 3, persistedCalls: persisted.length };
  });
});

describe("lease recovery: never sent versus maybe sent", () => {
  it("a reserved call is released for a safe retry; a submitted one becomes unknown; the fenced executor can do neither later", async () => {
    await stopRunning();
    const ws = await newWorkspace("recover-split");
    const base = Date.now();
    const setupAt = instant(base, 0);
    const leaseUntil = instant(base, 60_000);
    const expired = instant(base, 120_000);
    const reservedRun = run(ws, await newProject(ws, "r"), "reserved-only");
    const sentRun = run(ws, await newProject(ws, "s"), "sent");
    for (const record of [reservedRun, sentRun]) {
      await store.createRun(record, { maxActiveRuns: 50 });
      expect(await store.claimRun(ws, record.id, "dead", setupAt, leaseUntil)).toBe(true);
    }
    const unsent = call(reservedRun, "dead");
    expect(await store.reserveCall(unsent, wide, setupAt, leaseUntil)).toEqual({ kind: "reserved" });
    const sent = call(sentRun, "dead");
    expect(await store.reserveCall(sent, wide, setupAt, leaseUntil)).toEqual({ kind: "reserved" });
    expect(await store.markCallSubmitted(ws, sent.id, "dead", setupAt, leaseUntil)).toBe("submitted");

    expect(await store.recoverExpired(ws, expired)).toBe(2);
    const released = (await store.getRunById(ws, reservedRun.id))!;
    expect(released.run).toMatchObject({ state: "running", executorId: null, leaseUntil: null });
    expect(released.steps[0]).toMatchObject({ state: "pending" });
    expect(released.calls).toEqual([expect.objectContaining({ state: "rejected", errorCode: "executor_lost_before_send", usage: USAGE_UNKNOWN })]);
    const uncertain = (await store.getRunById(ws, sentRun.id))!;
    expect(uncertain.run).toMatchObject({ state: "needs_attention", errorCode: "executor_lost" });
    expect(uncertain.steps[0]).toMatchObject({ state: "unknown" });
    expect(uncertain.calls).toEqual([expect.objectContaining({ state: "unknown", errorCode: "executor_lost", usage: USAGE_UNKNOWN })]);
    expect(await store.listClaimable(ws, expired, 50)).toEqual([reservedRun.id]);

    // The fenced executor comes back late: it can neither send the released reservation nor record the sent answer.
    expect(await store.markCallSubmitted(ws, unsent.id, "dead", expired, instant(base, 180_000))).toBe("lost");
    expect(await store.finishCall(ws, sent.id, "dead", completed(CONCEPT as never), expired)).toBe(false);
    expect((await store.getRunById(ws, sentRun.id))!.calls[0]).toMatchObject({ state: "unknown" });
    expect((await pool.query("SELECT 1 FROM title_writing_call WHERE workspace_id = $1", [ws])).rowCount).toBe(2);
    const billing = (await pool.query<{ billing_status: string }>("SELECT DISTINCT billing_status FROM title_writing_call WHERE workspace_id = $1", [ws])).rows;
    expect(billing).toEqual([{ billing_status: "unknown" }]);
    evidence.recoverySplit = { reserved: "rejected/executor_lost_before_send, step pending, claimable", submitted: "unknown/executor_lost, needs_attention",
      lateSubmit: "lost", lateFinish: false };
  });
});

interface LockWait { app: string; waitEventType: string | null; waitEvent: string | null; blockedBy: string[] }

/**
 * Waits until every named session is blocked, and returns what PostgreSQL reports for each: the wait event and the
 * sessions blocking it (pg_blocking_pids, mapped to application names). It polls for this condition and fails when the
 * waits do not appear; a fixed sleep never stands in for the evidence.
 */
async function waitUntilBlocked(apps: string[]): Promise<LockWait[]> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const rows = (await pool.query<{ app: string; wait_event_type: string | null; wait_event: string | null; blocked_by: string[] | null }>(
      `SELECT a.application_name AS app, a.wait_event_type, a.wait_event,
              (SELECT array_agg(b.application_name ORDER BY b.application_name) FROM pg_stat_activity b
                WHERE b.pid = ANY (pg_blocking_pids(a.pid))) AS blocked_by
         FROM pg_stat_activity a
        WHERE a.datname = current_database() AND a.application_name = ANY ($1::text[]) AND cardinality(pg_blocking_pids(a.pid)) > 0`,
      [apps])).rows;
    if (rows.length === apps.length) {
      return rows.map((row) => ({ app: row.app, waitEventType: row.wait_event_type, waitEvent: row.wait_event, blockedBy: row.blocked_by ?? [] }))
        .sort((left, right) => apps.indexOf(left.app) - apps.indexOf(right.app));
    }
    if (Date.now() > deadline) throw new Error(`Sessions did not block as arranged: ${JSON.stringify(rows)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Rejects when `work` has not settled within `ms`; the timer never outlives it. */
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

/** What the last holdingProjectLock cleanup did, for the failure-path assertions and the evidence. */
interface LockCleanup { endedBy: "commit" | "rollback" | "destroyed"; queuedSettled: boolean; problems: string[] }
let lastLockCleanup: LockCleanup | null = null;

/**
 * Holds the project row lock on a session of this test's own `holder` pool while `body` queues writers behind it, then
 * always ends that transaction and returns or destroys the connection, whatever `body` did. `release` commits the lock
 * on purpose; a body that fails before it gets a ROLLBACK, so the queued writers go on instead of waiting forever. When
 * the session cannot be ended cleanly it is destroyed (its own socket closed, which ends its transaction on the server);
 * no other session is touched. Every writer passed through `track` is settled, within a bound, before this returns, so
 * none is left as an unhandled rejection. A cleanup problem never replaces the body's own failure (it goes to the
 * evidence instead) and never passes as success when the body succeeded.
 */
async function holdingProjectLock<T>(holder: Pool, project: string,
  body: (release: () => Promise<void>, track: <P>(writer: Promise<P>) => Promise<P>) => Promise<T>): Promise<T> {
  const queued: Array<Promise<unknown>> = [];
  const track = <P>(writer: Promise<P>): Promise<P> => {
    queued.push(writer.then(() => undefined, () => undefined));
    return writer;
  };
  const cleanup: LockCleanup = { endedBy: "commit", queuedSettled: false, problems: [] };
  lastLockCleanup = cleanup;
  ((evidence.lockCleanups ??= []) as LockCleanup[]).push(cleanup);
  const client: PoolClient = await holder.connect();
  // A checked-out client that loses its server session emits "error"; without a listener that would end the run.
  client.on("error", (error: Error) => { cleanup.problems.push(`holder session: ${error.message}`); });
  let open = false;
  const release = async () => {
    if (!open) return;
    open = false;
    await client.query("COMMIT");
  };

  const finish = async () => {
    let destroy: Error | undefined;
    if (open) {
      open = false;
      cleanup.endedBy = "rollback";
      try {
        await bounded(client.query("ROLLBACK"), 5_000, "ROLLBACK of the lock holder");
      } catch (error) {
        cleanup.endedBy = "destroyed";
        destroy = error instanceof Error ? error : new Error(String(error));
        cleanup.problems.push(destroy.message);
      }
    }
    // A client released with an error is closed instead of returned to the pool.
    client.release(destroy);
    try {
      await bounded(Promise.all(queued), 15_000, "queued writers");
      cleanup.queuedSettled = true;
    } catch (error) {
      cleanup.problems.push(error instanceof Error ? error.message : String(error));
    }
  };

  let result: T;
  try {
    await client.query("BEGIN");
    open = true;
    await client.query("SELECT id FROM project WHERE id = $1 FOR UPDATE", [project]);
    result = await body(release, track);
  } catch (error) {
    // The body's own failure stays the failure; whatever cleanup meets is recorded in the evidence.
    await finish();
    throw error;
  }
  await finish();
  if (cleanup.problems.length > 0 || !cleanup.queuedSettled) {
    throw new Error(`lock holder cleanup failed: ${cleanup.problems.join("; ")}`);
  }
  return result;
}

describe("R6 with a deterministic interleaving: import and a person's save queued on one project lock", () => {
  async function arrange(label: string) {
    await stopRunning();
    const ws = await newWorkspace(`lock-${label}`);
    const project = await newProject(ws, `lock-${label}`);
    const record = run(ws, project, `lock-${label}`);
    await store.createRun(record, { maxActiveRuns: 50 });
    await completeRun(record);
    const approved = await approveCurrentStory(ws, project);
    // The test's own session holds the project row lock both writers take first, so their order is arranged, not raced.
    const holder = independent(`title-lock-holder-${label}`);
    const importer = independent(`title-import-${label}`);
    const person = independent(`title-person-${label}`);
    return { ws, project, record, approved, holder, importer, person, label };
  }

  type Arranged = Awaited<ReturnType<typeof arrange>>;

  function personSave(arranged: Arranged, expectedVersion: number, episodeId: string) {
    return arranged.person.chain.createScriptRevision({ workspaceId: arranged.ws, projectId: arranged.project, episodeId,
      sourceStoryRevisionId: arranged.approved, content: { text: "人工剧本" }, createdBy: "editor", expectedVersion });
  }

  function importScripts(arranged: Arranged) {
    return arranged.importer.store.placeScripts(arranged.ws, arranged.project, arranged.record.id, { acceptStoryChanged: false }, "editor", now());
  }

  /**
   * Sessions of this scenario still waiting on a lock, and whether its holder still has a transaction open. It polls
   * briefly, since a session that was just ended can stay visible for a moment, and returns what it last saw.
   */
  async function leftovers(arranged: Arranged) {
    const apps = [`title-lock-holder-${arranged.label}`, `title-import-${arranged.label}`, `title-person-${arranged.label}`];
    const deadline = Date.now() + 5_000;
    for (;;) {
      const rows = (await pool.query<{ app: string; state: string | null; blocked: boolean }>(
        `SELECT application_name AS app, state, cardinality(pg_blocking_pids(pid)) > 0 AS blocked
           FROM pg_stat_activity WHERE datname = current_database() AND application_name = ANY ($1::text[])`, [apps])).rows;
      const seen = {
        blocked: rows.filter((row) => row.blocked).map((row) => row.app),
        holderInTransaction: rows.some((row) => row.app === apps[0] && row.state !== null && row.state.startsWith("idle in transaction")),
      };
      if ((seen.blocked.length === 0 && !seen.holderInTransaction) || Date.now() > deadline) return seen;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it("import queued first: it writes all three; the person's save on the old version is refused, without deadlock", async () => {
    const arranged = await arrange("import-first");
    const target = await episode(arranged.project, 1);
    const { firstWait, waits, outcomes } = await holdingProjectLock(arranged.holder.pool, arranged.project, async (release, track) => {
      const imported = track(importScripts(arranged));
      const firstWait = await waitUntilBlocked([`title-import-${arranged.label}`]);
      const saved = track(personSave(arranged, target.row_version, target.id));
      const waits = await waitUntilBlocked([`title-import-${arranged.label}`, `title-person-${arranged.label}`]);
      expect(firstWait[0]!.blockedBy).toEqual([`title-lock-holder-${arranged.label}`]);
      expect(waits.every((row) => row.waitEventType === "Lock")).toBe(true);
      await release();
      return { firstWait, waits, outcomes: await Promise.allSettled([imported, saved]) };
    });
    const [importOutcome, saveOutcome] = outcomes;
    expect(importOutcome.status).toBe("fulfilled");
    const placed = (importOutcome as PromiseFulfilledResult<Awaited<ReturnType<typeof importScripts>>>).value;
    expect(placed.kind === "ok" && placed.bundle.steps.slice(2).map((step) => step.scriptSave)).toEqual(["saved", "saved", "saved"]);
    expect(saveOutcome.status).toBe("rejected");
    expect((saveOutcome as PromiseRejectedResult).reason).toMatchObject({ code: "REVISION_CONFLICT" });
    const step = placed.kind === "ok" ? placed.bundle.steps.find((item) => item.stepKey === "episode:1")! : null;
    expect((await episode(arranged.project, 1)).current_script_revision_id).toBe(step?.scriptRevisionId);
    expect(await scriptCount(arranged.project)).toBe(3);
    expect(lastLockCleanup).toMatchObject({ endedBy: "commit", queuedSettled: true, problems: [] });
    evidence.lockOrderImportFirst = { firstWait, waits, import: "ok: saved, saved, saved", personSave: "REVISION_CONFLICT", scripts: 3, deadlock: false };
  });

  it("person queued first: the save wins episode 1; the import reports that episode as a conflict and writes the others", async () => {
    const arranged = await arrange("person-first");
    const target = await episode(arranged.project, 1);
    const { firstWait, waits, outcomes } = await holdingProjectLock(arranged.holder.pool, arranged.project, async (release, track) => {
      const saved = track(personSave(arranged, target.row_version, target.id));
      const firstWait = await waitUntilBlocked([`title-person-${arranged.label}`]);
      const imported = track(importScripts(arranged));
      const waits = await waitUntilBlocked([`title-person-${arranged.label}`, `title-import-${arranged.label}`]);
      expect(firstWait[0]!.blockedBy).toEqual([`title-lock-holder-${arranged.label}`]);
      expect(waits.every((row) => row.waitEventType === "Lock")).toBe(true);
      await release();
      return { firstWait, waits, outcomes: await Promise.allSettled([saved, imported]) };
    });
    const [saveOutcome, importOutcome] = outcomes;
    expect(saveOutcome.status).toBe("fulfilled");
    expect(importOutcome.status).toBe("fulfilled");
    const human = (saveOutcome as PromiseFulfilledResult<Awaited<ReturnType<typeof personSave>>>).value;
    const placed = (importOutcome as PromiseFulfilledResult<Awaited<ReturnType<typeof importScripts>>>).value;
    expect(placed.kind === "ok" && placed.bundle.steps.slice(2).map((step) => step.scriptSave)).toEqual(["conflict", "saved", "saved"]);
    expect((await episode(arranged.project, 1)).current_script_revision_id).toBe(human.revisionId);
    expect(await scriptCount(arranged.project)).toBe(3);
    expect(lastLockCleanup).toMatchObject({ endedBy: "commit", queuedSettled: true, problems: [] });
    evidence.lockOrderPersonFirst = { firstWait, waits, personSave: "ok", import: "conflict, saved, saved", scripts: 3, deadlock: false };
  });

  // The failure paths below fail on purpose inside holdingProjectLock; each outer test asserts that failure exactly, so a
  // deliberate failure can never pass unnoticed and an unexpected one still fails the run.

  it("a failure before the lock is released rolls the holder back, settles the queued writers and keeps the original error", async () => {
    const arranged = await arrange("fail-before-release");
    const injected = new Error("injected failure before the lock was released");
    let imported: Promise<unknown> | undefined;
    const outcome = await holdingProjectLock(arranged.holder.pool, arranged.project, async (_release, track) => {
      imported = track(importScripts(arranged));
      await waitUntilBlocked([`title-import-${arranged.label}`]);
      throw injected;
    }).then(() => "passed", (error: unknown) => error);
    expect(outcome).toBe(injected);
    expect(lastLockCleanup).toMatchObject({ endedBy: "rollback", queuedSettled: true, problems: [] });
    // The queued import was not stranded: once the holder rolled back it ran and wrote the three scripts.
    const placed = await imported as Awaited<ReturnType<typeof importScripts>>;
    expect(placed.kind === "ok" && placed.bundle.steps.slice(2).map((step) => step.scriptSave)).toEqual(["saved", "saved", "saved"]);
    expect(await leftovers(arranged)).toEqual({ blocked: [], holderInTransaction: false });
    // The holder's connection went back to its pool and works.
    expect((await arranged.holder.pool.query<{ ok: number }>("SELECT 1 AS ok")).rows[0]!.ok).toBe(1);
    evidence.lockFailureBeforeRelease = { error: "original kept", endedBy: "rollback", queuedWriter: "settled: saved, saved, saved",
      blockedAfter: 0, holderInTransactionAfter: false };
  });

  it("a holder session that cannot be rolled back is destroyed; the body's own failure still comes first", async () => {
    const arranged = await arrange("holder-lost");
    const injected = new Error("injected failure after the holder session was lost");
    let imported: Promise<unknown> | undefined;
    const outcome = await holdingProjectLock(arranged.holder.pool, arranged.project, async (_release, track) => {
      imported = track(importScripts(arranged));
      await waitUntilBlocked([`title-import-${arranged.label}`]);
      // End only this scenario's own holder session, found by its name and the lock it holds on this test's project.
      await terminateOwnHolder(arranged.label);
      throw injected;
    }).then(() => "passed", (error: unknown) => error);
    expect(outcome).toBe(injected);
    expect(lastLockCleanup?.endedBy).toBe("destroyed");
    expect(lastLockCleanup?.queuedSettled).toBe(true);
    expect(lastLockCleanup?.problems.length).toBeGreaterThan(0);
    const placed = await imported as Awaited<ReturnType<typeof importScripts>>;
    expect(placed.kind).toBe("ok");
    expect(await leftovers(arranged)).toEqual({ blocked: [], holderInTransaction: false });
    evidence.lockHolderLost = { error: "original kept", endedBy: "destroyed", cleanupProblemRecorded: true, queuedWriter: "settled" };
  });

  it("a cleanup failure after a passing body fails the test instead of passing as success", async () => {
    const arranged = await arrange("cleanup-fails");
    const outcome = await holdingProjectLock(arranged.holder.pool, arranged.project, async () => {
      await terminateOwnHolder(arranged.label);
      return "body passed";
    }).then((value) => value, (error: unknown) => error);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/^lock holder cleanup failed: /);
    expect(lastLockCleanup?.endedBy).toBe("destroyed");
    expect(await leftovers(arranged)).toEqual({ blocked: [], holderInTransaction: false });
    evidence.lockCleanupFailure = { outcome: "test fails with the cleanup error", endedBy: "destroyed" };
  });
});

/** Terminates the one holder session of this scenario: named by this test and holding a lock in this database. */
async function terminateOwnHolder(label: string): Promise<void> {
  const ended = (await pool.query<{ ended: boolean }>(
    `SELECT pg_terminate_backend(a.pid) AS ended FROM pg_stat_activity a
      WHERE a.datname = current_database() AND a.application_name = $1 AND a.pid <> pg_backend_pid()
        AND EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = a.pid AND l.granted AND l.locktype = 'transactionid')`,
    [`title-lock-holder-${label}`])).rows;
  expect(ended).toEqual([{ ended: true }]);
}
