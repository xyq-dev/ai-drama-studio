/**
 * Title writing store acceptance on real PostgreSQL. NOT part of `test` or `integration`: run only with
 * `pnpm --filter @ai-drama/database title-writing:acceptance` against a newly created, empty, disposable database that
 * a person named on purpose (see title-writing-acceptance-guard.ts). It applies the migrations and the unapplied draft
 * SQL to that database and nothing else. It never drops or truncates anything; refusal happens before any connection.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
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
import { runMigrations } from "./migrations";
import { TextChainService } from "./text-chain";
import { checkTitleWritingAcceptanceEnv, verifyTitleWritingAcceptanceDatabase } from "./title-writing-acceptance-guard";
import { PostgresTitleWritingStore } from "./title-writing-store";

// Refuse before any connection is opened.
const decision = checkTitleWritingAcceptanceEnv(process.env);
if (!decision.ok) throw new Error(`Title writing acceptance refused: ${decision.reason}`);

const pool = new Pool({ connectionString: decision.url, max: 8 });
const chain = new TextChainService(pool);
const store = new PostgresTitleWritingStore(pool, chain);

beforeAll(async () => {
  const verified = await verifyTitleWritingAcceptanceDatabase(pool, decision.databaseName);
  if (!verified.ok) {
    await pool.end();
    throw new Error(`Title writing acceptance refused: ${verified.reason}`);
  }
  await runMigrations(pool);
  expect(await store.storageReady()).toBe(false);
  const draft = await readFile(join(__dirname, "..", "prisma", "drafts", "20261008000100_title_writing.sql"), "utf8");
  await pool.query(draft);
});

afterAll(async () => {
  await pool.end();
});

const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const now = () => new Date().toISOString();
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

describe("PostgresTitleWritingStore on the authorized draft tables", () => {
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
    expect(await store.claimRun(workspaceId, record.id, "a", now(), later(60_000))).toBe(true);
    expect(await store.claimRun(workspaceId, record.id, "b", now(), later(60_000))).toBe(false);
    const first = call(record, "a");
    expect(await store.reserveCall(first, wide, now(), later(60_000))).toEqual({ kind: "reserved" });
    expect(await store.markCallSubmitted(workspaceId, first.id, "b", now(), later(60_000))).toBe("lost");
    expect(await store.markCallSubmitted(workspaceId, first.id, "a", now(), later(1))).toBe("submitted");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await store.recoverExpired(workspaceId, now())).toBe(1);
    expect(await store.finishCall(workspaceId, first.id, "a", completed(CONCEPT as never), now())).toBe(false);
    const bundle = (await store.getRunById(workspaceId, record.id))!;
    expect(bundle.run).toMatchObject({ state: "needs_attention", errorCode: "executor_lost", executorId: null });
    expect(bundle.calls[0]).toMatchObject({ state: "unknown", errorCode: "executor_lost", usage: USAGE_UNKNOWN });
    expect(bundle.steps[0]).toMatchObject({ state: "unknown" });
  });

  it("enforces the workspace daily call cap atomically", async () => {
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
    expect(await store.claimRun(wb, sent.id, "dead-b", now(), later(1))).toBe(true);
    const bCall = call(sent, "dead-b");
    expect(await store.reserveCall(bCall, wide, now(), later(1))).toEqual({ kind: "reserved" });
    expect(await store.markCallSubmitted(wb, bCall.id, "dead-b", now(), later(1))).toBe("submitted");
    const idle = run(wb, pb2, "idle");
    await store.createRun(idle, { maxActiveRuns: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const before = await pool.query("SELECT * FROM title_writing_run WHERE workspace_id = $1 ORDER BY id", [wb]);

    expect(await store.recoverExpired(wa, now())).toBe(0);
    expect(await store.listClaimable(wa, now(), 50)).toEqual([]);
    expect(await store.claimRun(wa, idle.id, "exec-a", now(), later(60_000))).toBe(false);
    expect(await store.getRunById(wa, sent.id)).toBeNull();
    expect(await store.markCallSubmitted(wa, bCall.id, "dead-b", now(), later(60_000))).toBe("lost");
    expect(await store.finishCall(wa, bCall.id, "dead-b", completed(CONCEPT as never), now())).toBe(false);
    expect(await store.finishRun(wa, sent.id, "dead-b", "failed", null, now())).toBe(false);
    expect(await store.reserveCall({ ...call(idle, "exec-a"), workspaceId: wa }, wide, now(), later(60_000))).toEqual({ kind: "lost" });
    expect((await pool.query("SELECT * FROM title_writing_run WHERE workspace_id = $1 ORDER BY id", [wb])).rows).toEqual(before.rows);

    expect(await store.recoverExpired(wb, now())).toBe(1);
    expect((await store.getRunById(wb, sent.id))!.run).toMatchObject({ state: "needs_attention", errorCode: "executor_lost" });
    expect(await store.listClaimable(wb, now(), 50)).toEqual([idle.id]);
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

describe("R6: script import and a person's save on the same episode", () => {
  it("never deadlock and never overwrite each other", async () => {
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
