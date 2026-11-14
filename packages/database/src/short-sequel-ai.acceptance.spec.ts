import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTO_CREATION_EPISODE_SCHEMA, SHORT_SEQUEL_AI_SCHEMA, type ShortSequelAiAttempt } from "@ai-drama/contracts";
import { canonicalInputHash } from "@ai-drama/domain";
import { checkDisposableAcceptanceEnv, verifyDisposableAcceptanceDatabase } from "./disposable-acceptance-guard";
import { runMigrations } from "./migrations";
import { ShortSequelStore, shortSequelAiMaterials } from "./short-sequel";
import { PostgresWritingCandidateStore } from "./writing-candidate-store";

const databasePattern = /^ads_short_sequel_ai_acceptance_[a-z0-9_]+$/u;
if (process.env.SHORT_SEQUEL_AI_TEST_ALLOW_WRITES !== "true") throw new Error("Short sequel AI acceptance requires explicit disposable-write approval.");
const testDatabase = checkDisposableAcceptanceEnv({ databaseName: process.env.SHORT_SEQUEL_AI_TEST_DATABASE_NAME,
  url: process.env.SHORT_SEQUEL_AI_TEST_DATABASE_URL, businessDatabaseUrl: process.env.DATABASE_URL,
  namePattern: databasePattern, nameHint: databasePattern.source });
if (!testDatabase.ok) throw new Error(testDatabase.reason);
const { databaseName, url } = testDatabase;
const pool = new Pool({ connectionString: url, max: 4, statement_timeout: 15_000 });
const store = new PostgresWritingCandidateStore(pool);
const sequel = new ShortSequelStore(pool);
const hash = "a".repeat(64);
const usage = { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null } as const;

beforeAll(async () => {
  const verified = await verifyDisposableAcceptanceDatabase(pool, databaseName, databasePattern);
  if (!verified.ok) throw new Error(verified.reason);
  await runMigrations(pool);
});
afterAll(() => pool.end());

async function setup() {
  const workspaceId = (await pool.query("INSERT INTO workspace (name) VALUES ('acceptance') RETURNING id")).rows[0]!.id as string;
  const projectId = (await pool.query(`INSERT INTO project (workspace_id, title, episode_count, target_episode_seconds)
    VALUES ($1, '纸鹤星图', 1, 60) RETURNING id`, [workspaceId])).rows[0]!.id as string;
  const story = (await pool.query(`INSERT INTO story_revision (workspace_id,project_id,revision_no,content_json,content_hash,created_by)
    VALUES ($1,$2,1,'{}'::jsonb,$3,'fixture') RETURNING id`, [workspaceId, projectId, hash])).rows[0]!.id as string;
  const runId = randomUUID();
  await pool.query(`INSERT INTO auto_creation_run (id,workspace_id,project_id,actor_id,idempotency_key,input_hash,input_json,
    provider_key,model,state,call_cap,quality,story_save,story_revision_id,created_at,updated_at)
    VALUES ($1,$2,$3,'fixture','original',$4,$5,'openai','fixture-model','completed',1,'passed','saved',$6,now(),now())`,
  [runId, workspaceId, projectId, hash, JSON.stringify({ episodeCount: 1, episodeSeconds: 60, constraints: {} }), story]);
  const stages = [["bible", { characters: [], locations: [] }], ["episode:1", {
    schema: AUTO_CREATION_EPISODE_SCHEMA, episodeNo: 1, title: "纸鹤", scenes: [], handoffFacts: ["星图藏在纸鹤里。"],
  }], ["review:1", {}]] as const;
  for (const [ordinal, [key, value]] of stages.entries()) {
    await pool.query(`INSERT INTO auto_creation_stage (run_id,workspace_id,stage_key,ordinal,state,output_json,output_hash,script_save,updated_at)
      VALUES ($1,$2,$3,$4,'completed',$5,$6,$7,now())`, [runId, workspaceId, key, ordinal, JSON.stringify(value), hash,
      key.startsWith("episode:") ? "pending" : null]);
  }
  const { episodeId } = await sequel.confirm(workspaceId, projectId, 2, "fixture");
  const context = await sequel.context(workspaceId, projectId, 2);
  const source = { storyRevisionId: context.storyRevisionId, previousRevisionId: context.previousRevisionId,
    originalRunId: context.originalRunId, originalEpisodeHash: context.originalEpisodeHash, planConfirmation: context.planConfirmation,
    lockedPreviousRevisionId: context.lockedPreviousRevisionId, lockedOriginal: context.lockedOriginal };
  const at = new Date("2025-09-01T00:00:00.000Z");
  const leaseUntil = new Date(at.getTime() + 60_000).toISOString();
  const limits = { nowIso: at.toISOString(), sinceIso: new Date(at.getTime() - 86_400_000).toISOString(), maxCallsPerDay: 30,
    maxActiveRuns: 3, expectedAttemptId: null, confirmUncertainAttemptId: null };
  const fakeAttempt = (taskId: string = randomUUID()): ShortSequelAiAttempt => ({ id: randomUUID(), workspaceId, projectId,
    actorId: "fixture", idempotencyKey: randomUUID(), requestHash: hash, state: "reserved", errorCode: null, executorId: "fixture",
    leaseUntil, script: null, usage, createdAt: at.toISOString(), finishedAt: null,
    input: { schema: SHORT_SEQUEL_AI_SCHEMA, taskId, episodeId, episodeNo: 2, episodeCount: 2, targetEpisodeSeconds: 60,
      direction: "寻找印章", source, contextHash: canonicalInputHash(shortSequelAiMaterials(context, source)),
      providerKey: "openai", model: "fixture-model" },
  });
  return { workspaceId, projectId, episodeId, limits, fakeAttempt, leaseUntil };
}

describe("short sequel AI transactions on disposable PostgreSQL", () => {
  it("refuses a stale tab's attempt consent after a newer attempt in the same task becomes unknown", async () => {
    const { workspaceId, projectId, episodeId, limits, fakeAttempt, leaseUntil } = await setup();
    const earlier = fakeAttempt();
    expect(await store.createShortSequel(earlier, limits)).toMatchObject({ kind: "created" });
    expect(await store.markShortSequelSubmitted(earlier, "fixture", limits.nowIso, leaseUntil)).toBe(true);
    expect(await store.recoverExpired(workspaceId, leaseUntil)).toBe(1);
    const later = fakeAttempt(earlier.input.taskId);
    expect(await store.createShortSequel(later, { ...limits, expectedAttemptId: earlier.id, confirmUncertainAttemptId: earlier.id }))
      .toMatchObject({ kind: "created" });
    expect(await store.markShortSequelSubmitted(later, "fixture", limits.nowIso, leaseUntil)).toBe(true);
    expect(await store.recoverExpired(workspaceId, leaseUntil)).toBe(1);
    expect(await store.createShortSequel(fakeAttempt(), { ...limits, confirmUncertainAttemptId: earlier.id })).toEqual({ kind: "needs_confirmation" });
    expect(await store.listShortSequels(workspaceId, projectId, episodeId)).toMatchObject({ attempts: [{ id: later.id, state: "unknown" }] });
    const regenerated = fakeAttempt();
    expect(await store.createShortSequel(regenerated, { ...limits, confirmUncertainAttemptId: later.id })).toMatchObject({ kind: "created" });
    const stored = await pool.query("SELECT confirmed_request_id FROM writing_candidate_request WHERE id = $1", [regenerated.id]);
    expect(stored.rows[0]?.confirmed_request_id).toBe(later.id);
  });

  it("pages all older drafts across same timestamp ties and shows only the newest attempt for each task", async () => {
    const { workspaceId, projectId, episodeId, fakeAttempt } = await setup();
    const at = "2025-09-01T00:00:00.000125Z";
    const rows = Array.from({ length: 25 }, () => fakeAttempt());
    const repeated = fakeAttempt(rows[0]!.input.taskId);
    const candidate = { title: "可回看的纸鹤草稿" };
    for (const row of [...rows, repeated]) {
      await pool.query(`INSERT INTO writing_candidate_request (id,workspace_id,project_id,actor_id,idempotency_key,request_hash,input_json,
        mode,episode_id,episode_no,if_match,provider_key,model,state,usage_json,candidate_json,created_at,finished_at)
        VALUES ($1,$2,$3,'fixture',$4,$5,$6,'episode',$7,2,1,'openai','fixture-model','completed',$8,$9,$10,$10)`,
      [row.id, workspaceId, projectId, row.idempotencyKey, hash, JSON.stringify(row.input), episodeId,
        JSON.stringify(usage), JSON.stringify(candidate), row === repeated ? "2025-09-01T00:00:00.000126Z" : at]);
    }
    const first = await store.listShortSequels(workspaceId, projectId, episodeId);
    expect(first.attempts).toHaveLength(11);
    expect(first.attempts[0]).toMatchObject({ id: repeated.id, script: candidate });
    expect(first.nextCursor).not.toBeNull();
    const second = await store.listShortSequels(workspaceId, projectId, episodeId, first.nextCursor!);
    const third = await store.listShortSequels(workspaceId, projectId, episodeId, second.nextCursor!);
    expect(second.attempts).toHaveLength(11);
    expect(third.attempts).toHaveLength(3);
    expect(third.nextCursor).toBeNull();
    const all = [...first.attempts, ...second.attempts, ...third.attempts];
    expect(new Set(all.map(row => row.input.taskId))).toEqual(new Set(rows.map(row => row.input.taskId)));
    expect(all.some(row => row.id === rows[0]!.id)).toBe(false);
    await expect(store.listShortSequels(workspaceId, projectId, randomUUID(), first.nextCursor!)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
