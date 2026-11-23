import { randomUUID } from "node:crypto";
import { closePostgresPool, createPostgresPool, PostgresSeriesWritingStore, PostgresWritingCandidateStore, runMigrations, settleCreatorQuotaHold, TextChainService } from "@ai-drama/database";
import { admitSeriesGrant, canonicalInputHash } from "@ai-drama/domain";
import { newSeries, newSeriesGrant, newWritingCandidate } from "@ai-drama/providers";
import { fixtureStoryPlan } from "@ai-drama/providers/title-writing-fixtures";
import { SERIES_FINAL_REVIEW_DIMENSIONS, SERIES_FINAL_REVIEW_SCHEMA, seriesConstraintsSchema, seriesScopeCalls, SHORT_SEQUEL_AI_SCHEMA, type ShortSequelAiInput, type WritingCandidateFinish } from "@ai-drama/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresMembershipStore } from "./membership-store";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for quota integration tests");

const pool = createPostgresPool({
  connectionString: databaseUrl,
  connectionTimeoutMs: 2_000,
  statementTimeoutMs: 10_000,
  queryTimeoutMs: 10_000,
});
const store = new PostgresMembershipStore(pool);
const workspaceId = randomUUID();

beforeAll(async () => {
  if (!await store.ready()) await runMigrations(pool);
  await pool.query("INSERT INTO workspace (id, name) VALUES ($1, '并发额度测试')", [workspaceId]);
});
afterAll(() => closePostgresPool(pool));

async function memberWithWritingQuota(units: number) {
  const accountId = randomUUID();
  await pool.query(
    `INSERT INTO creator_account (id, workspace_id, username, password_hash, status)
     VALUES ($1, $2, $3, 'fixture', 'ACTIVE')`, [accountId, workspaceId, accountId],
  );
  const plan = await store.savePlan(workspaceId, {
    code: accountId, name: "编剧测试", description: "", active: true, unitPriceAmount: null, unitPriceCurrency: null,
    features: [{ feature: "writing", enabled: true, includedUnits: units }],
  });
  await store.grant(workspaceId, {
    accountId, planId: plan.id, startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 60_000),
    reason: "并发测试", grantedBy: null,
  });
  return accountId;
}

async function settleUnsent(taskKey: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await settleCreatorQuotaHold(client, taskKey, "unsent");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

describe("PostgreSQL membership reservations", () => {
  it.each([1, 3])("charges one of %i units once for concurrent replays", async (units) => {
    const accountId = await memberWithWritingQuota(units);
    const results = await Promise.all(Array.from({ length: 8 }, () => store.reserve(workspaceId, {
      accountId, feature: "writing", idempotencyKey: "same-submission",
    })));
    const holds = results.flatMap((result) => result.ok && "holdId" in result ? [result] : []);
    expect(holds).toHaveLength(results.length);
    expect(new Set(holds.map((hold) => hold.holdId)).size).toBe(1);
    expect(holds.filter((hold) => !hold.replay)).toHaveLength(1);
    expect((await store.balances(workspaceId, accountId)).writing).toBe(units - 1);
    expect((await store.ledger(workspaceId, accountId)).filter((row) => row.kind === "debit")).toHaveLength(1);
  });

  it("charges exactly one of several competing tasks for the last unit", async () => {
    const accountId = await memberWithWritingQuota(1);
    const results = await Promise.all(Array.from({ length: 8 }, () => store.reserve(workspaceId, {
      accountId, feature: "writing", idempotencyKey: randomUUID(),
    })));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.code === "QUOTA_EXHAUSTED")).toHaveLength(7);
    expect((await store.balances(workspaceId, accountId)).writing).toBe(0);
    expect((await store.ledger(workspaceId, accountId)).filter((row) => row.kind === "debit")).toHaveLength(1);
  });

  it.each(["store release", "run receipt"])("records each debit and refund for repeated attempts via %s", async (source) => {
    const accountId = await memberWithWritingQuota(1);
    const taskKeys: string[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const hold = await store.reserve(workspaceId, { accountId, feature: "writing", idempotencyKey: "retry-unsent" });
      if (!hold.ok || !("holdId" in hold)) throw new Error("Expected a writing quota reservation");
      expect(hold.replay).toBe(false);
      const taskKey = randomUUID();
      taskKeys.push(taskKey);
      await store.bindTask(hold.holdId, taskKey);
      const release = () => source === "run receipt" ? settleUnsent(taskKey) : store.release(hold.holdId);
      await Promise.all([release(), release()]);
      expect((await store.balances(workspaceId, accountId)).writing).toBe(1);
    }
    const rows = await store.ledger(workspaceId, accountId);
    expect(rows.filter((row) => row.kind === "debit")).toHaveLength(3);
    const credits = rows.filter((row) => row.kind === "credit");
    expect(credits).toHaveLength(3);
    if (source === "run receipt") expect(new Set(credits.map((credit) => credit.taskKey))).toEqual(new Set(taskKeys));
  });
});

describe("PostgreSQL writing quota receipts", () => {
  const candidates = new PostgresWritingCandidateStore(pool);
  const executor = "writing-receipt-fixture";

  async function reservedCandidate() {
    const accountId = await memberWithWritingQuota(1);
    const projectId = randomUUID();
    await pool.query("INSERT INTO project (id, workspace_id, title, episode_count, target_episode_seconds) VALUES ($1, $2, '候选额度测试', 1, 60)", [projectId, workspaceId]);
    const now = new Date();
    const request = newWritingCandidate({
      workspaceId, projectId, actorId: `creator:${accountId}`, idempotencyKey: randomUUID(),
      episodeCount: 1, episodeId: null, mode: "story", providerKey: "anthropic", model: "fixture",
      base: { sourceRevisionId: null, ifMatch: 1 }, request: {
        premise: "末班车", genre: "", audience: "", characters: "", mustKeep: "", mustNotChange: "", currentText: "",
      }, confirmedRequestId: null, executorId: executor, now, leaseMs: 60_000,
    });
    const hold = await store.reserve(workspaceId, {
      accountId, projectId, feature: "writing", operation: "writing-candidate", idempotencyKey: request.idempotencyKey,
    });
    if (!hold.ok || !("holdId" in hold)) throw new Error("Writing quota reservation missing");
    expect((await candidates.create(request, { sinceIso: now.toISOString(), maxCallsPerDay: 100 })).kind).toBe("created");
    await store.bindTask(hold.holdId, request.id);
    const quota = async () => ({
      status: (await pool.query<{ status: string }>("SELECT status FROM creator_quota_hold WHERE id = $1", [hold.holdId])).rows[0]?.status,
      balance: (await store.balances(workspaceId, accountId)).writing,
      refunds: (await store.ledger(workspaceId, accountId)).filter(row => row.kind === "credit" && row.taskKey === request.id).length,
    });
    const submit = () => candidates.markSubmitted(workspaceId, request.id, executor, request.createdAt, request.leaseUntil!);
    return { request, quota, submit };
  }

  it("rolls back the hold, debit and balance when the enclosing writing transaction rolls back", async () => {
    const accountId = await memberWithWritingQuota(1);
    const input = { accountId, feature: "writing" as const, idempotencyKey: randomUUID() };
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const hold = await store.reserve(workspaceId, input, client);
      expect(hold).toMatchObject({ ok: true, replay: false });
      const balance = await client.query("SELECT remaining_units::int AS remaining_units FROM creator_feature_balance WHERE account_id = $1 AND feature = 'writing'", [accountId]);
      expect(balance.rows[0]?.remaining_units).toBe(0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect((await store.balances(workspaceId, accountId)).writing).toBe(1);
    expect((await store.ledger(workspaceId, accountId)).filter(row => row.kind === "debit")).toHaveLength(0);
    expect(await store.reserve(workspaceId, input)).toMatchObject({ ok: true, replay: false });
  });

  it("releases only a reservation its current executor closes before sending", async () => {
    const { request, quota } = await reservedCandidate();
    const close = (owner: string) => candidates.closeUnsent(workspaceId, request.id, owner, "provider_unconfigured", request.createdAt);
    expect(await close("previous-executor")).toBe(false);
    expect(await quota()).toEqual({ status: "held", balance: 0, refunds: 0 });
    expect(await close(executor)).toBe(true);
    expect(await close(executor)).toBe(false);
    expect(await quota()).toEqual({ status: "released", balance: 1, refunds: 1 });
  });

  it.each(["completed", "unknown", "rejected"] as const)("settles a submitted %s candidate exactly once", async (state) => {
    const { request, submit, quota } = await reservedCandidate();
    const patch: WritingCandidateFinish = {
      state, errorCode: state === "unknown" ? "timeout" : state === "rejected" ? "auth" : null,
      candidate: state === "completed" ? { mode: "story", plan: fixtureStoryPlan("测试", 1) } : null,
      responseModel: null, providerRequestId: null, usage: request.usage,
    };
    const finish = (owner: string) => candidates.finish(workspaceId, request.id, owner, patch, request.createdAt);
    expect(await submit()).toBe(true);
    expect(await candidates.closeUnsent(workspaceId, request.id, executor, "provider_unconfigured", request.createdAt)).toBe(false);
    expect(await finish("previous-executor")).toBe(false);
    expect(await quota()).toEqual({ status: "held", balance: 0, refunds: 0 });
    expect(await finish(executor)).toBe(true);
    expect(await finish(executor)).toBe(false);
    expect(await quota()).toEqual({ status: state === "unknown" ? "unknown" : "committed", balance: 0, refunds: 0 });
  });

  it("refunds a reserved short sequel once if its project is archived before submission", async () => {
    const accountId = await memberWithWritingQuota(1);
    const projectId = randomUUID();
    const episodeId = randomUUID();
    const id = randomUUID();
    await pool.query("INSERT INTO project (id, workspace_id, title, episode_count, target_episode_seconds) VALUES ($1, $2, '续写', 2, 60)", [projectId, workspaceId]);
    await pool.query("INSERT INTO episode (id, project_id, workspace_id, episode_no, title) VALUES ($1, $2, $3, 2, '续集')", [episodeId, projectId, workspaceId]);
    const input: ShortSequelAiInput = {
      schema: SHORT_SEQUEL_AI_SCHEMA, taskId: randomUUID(), episodeId, episodeNo: 2, episodeCount: 2, targetEpisodeSeconds: 60,
      direction: "归还照片", source: { storyRevisionId: null, previousRevisionId: null, originalRunId: null, originalEpisodeHash: null },
      contextHash: "a".repeat(64), providerKey: "openai", model: "fixture",
    };
    const usage = { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null };
    await pool.query(`INSERT INTO writing_candidate_request
      (id, workspace_id, project_id, actor_id, idempotency_key, request_hash, input_json, mode, episode_id, episode_no, if_match,
       provider_key, model, state, executor_id, lease_until, usage_json, created_at)
      VALUES ($1,$2,$3,$4,$1::uuid::text,$5,$6,'episode',$7,2,1,'openai','fixture','reserved',$8,now() + interval '1 minute',$9,now())`,
    [id, workspaceId, projectId, `creator:${accountId}`, input.contextHash, JSON.stringify(input), episodeId, executor, JSON.stringify(usage)]);
    const hold = await store.reserve(workspaceId, { accountId, projectId, feature: "writing", operation: "short-sequel-ai", idempotencyKey: id, taskKey: id });
    expect(hold).toMatchObject({ ok: true, replay: false });
    const attempt = await candidates.getShortSequelAttempt(workspaceId, id);
    if (!attempt?.leaseUntil) throw new Error("Reserved short sequel missing");
    const submit = (owner: string) => candidates.markShortSequelSubmitted(attempt, owner, attempt.createdAt, attempt.leaseUntil!);

    await pool.query("UPDATE project SET status = 'ARCHIVED', archived_at = now() WHERE id = $1", [projectId]);
    expect(await submit("previous-executor")).toBe(false);
    expect((await store.balances(workspaceId, accountId)).writing).toBe(0);
    expect(await submit(executor)).toBe(false);
    expect(await submit(executor)).toBe(false);
    expect(await candidates.getShortSequelAttempt(workspaceId, id)).toMatchObject({ state: "rejected", errorCode: "source_changed" });
    expect((await store.balances(workspaceId, accountId)).writing).toBe(1);
    expect((await store.ledger(workspaceId, accountId)).filter(row => row.kind === "credit" && row.taskKey === id)).toHaveLength(1);
  });

  it("refunds expired reservations and keeps submitted requests unknown after recovery or late receipts", async () => {
    const reserved = await reservedCandidate();
    const submitted = await reservedCandidate();
    expect(await submitted.submit()).toBe(true);
    const expiredAt = new Date(Date.now() + 120_000).toISOString();
    expect(await candidates.recoverExpired(workspaceId, expiredAt)).toBe(2);
    expect(await candidates.recoverExpired(workspaceId, expiredAt)).toBe(0);
    for (const { request } of [reserved, submitted]) {
      expect(await candidates.closeUnsent(workspaceId, request.id, executor, "provider_unconfigured", expiredAt)).toBe(false);
    }
    expect(await reserved.quota()).toEqual({ status: "released", balance: 1, refunds: 1 });
    expect(await submitted.quota()).toEqual({ status: "unknown", balance: 0, refunds: 0 });
    expect(await candidates.getById(workspaceId, reserved.request.id)).toMatchObject({ state: "rejected", errorCode: "executor_lost_before_send" });
    expect(await candidates.getById(workspaceId, submitted.request.id)).toMatchObject({ state: "unknown", errorCode: "executor_lost" });
  });
});

describe("PostgreSQL series grant quota receipts", () => {
  const seriesStore = new PostgresSeriesWritingStore(pool, new TextChainService(pool));
  const executor = "series-receipt-fixture";

  async function reservedGrant() {
    const accountId = await memberWithWritingQuota(1);
    const actorId = `creator:${accountId}`;
    const now = new Date();
    const nowIso = now.toISOString();
    const lease = new Date(now.getTime() + 60_000).toISOString();
    const series = newSeries({
      workspaceId, projectId: randomUUID(), actorId, idempotencyKey: randomUUID(), title: "末班车", idea: "", constraints: seriesConstraintsSchema.parse({}),
      materials: [], referenceUrls: [], researchFetch: false, episodeCount: 3, episodeSeconds: 60, now,
    });
    expect((await seriesStore.createSeries(series, { title: series.title, premise: "" })).kind).toBe("created");
    const scope = { plan: true, batchFrom: 1, batchTo: 1, final: true };
    const normalCalls = seriesScopeCalls(3, scope);
    const grant = newSeriesGrant({
      series, actorId, idempotencyKey: randomUUID(), scope, normalCalls, callBudget: normalCalls, resendAllowance: 0,
      providerKey: "openai", model: "fixture", basePlanRevisionId: null, now,
      authorization: { mode: "series", proof: "operator_token", initiatedBy: actorId, executor: "series-writing-engine" },
    });
    const limits = { maxCallsPerDay: 1000, maxActiveRuns: 2, sinceIso: nowIso };
    const firstJob = randomUUID();
    const hold = await store.reserve(workspaceId, {
      accountId, projectId: series.projectId, feature: "writing", operation: "series-writing", idempotencyKey: grant.idempotencyKey,
    });
    if (!hold.ok || !("holdId" in hold)) throw new Error("Expected a series quota reservation");
    const created = await seriesStore.createGrant(grant, limits, snap => admitSeriesGrant(snap, grant, { jobId: firstJob, nowIso }));
    expect(created.kind).toBe("created");
    await store.bindTask(hold.holdId, firstJob);
    const quota = async () => ({
      status: (await pool.query("SELECT status FROM creator_quota_hold WHERE id = $1", [hold.holdId])).rows[0]?.status,
      balance: (await store.balances(workspaceId, accountId)).writing,
      refunds: (await store.ledger(workspaceId, accountId)).filter(row => row.kind === "credit" && row.taskKey === firstJob).length,
    });
    const cancel = () => seriesStore.requestCancel(workspaceId, series.projectId, grant.id, nowIso);
    return { series, grant, firstJob, nowIso, lease, limits, quota, cancel };
  }

  async function recordCall(jobId: string, stage: string, state: "completed" | "rejected" | "unknown", errorCode: string | null) {
    await pool.query(`INSERT INTO series_writing_call
      (id, run_id, grant_id, series_id, workspace_id, stage_key, attempt_no, provider_key, model, request_hash,
       state, executor_id, usage_json, error_code, created_at, finished_at)
      SELECT $2, id, grant_id, series_id, workspace_id, $3, 1, provider_key, model, input_hash, $4, $5, '{}'::jsonb, $6, now(), now()
        FROM series_writing_run WHERE id = $1`, [jobId, randomUUID(), stage, state, executor, errorCode]);
  }

  it.each([false, true])("refunds once on cancellation when a grant has only before-send rejections (%s)", async (rejected) => {
    const { firstJob, nowIso, lease, quota, cancel } = await reservedGrant();
    if (rejected) await recordCall(firstJob, "research", "rejected", "upstream_changed_before_send");
    expect(await seriesStore.claimJob(workspaceId, firstJob, executor, nowIso, lease)).toBe(true);
    expect((await cancel())?.state).toBe("running");
    expect(await seriesStore.finishJob(workspaceId, firstJob, executor, "canceled", null, nowIso)).toBe(true);
    expect((await cancel())?.state).toBe("canceled");
    expect(await seriesStore.finishJob(workspaceId, firstJob, executor, "canceled", null, nowIso)).toBe(false);
    expect(await quota()).toEqual({ status: "released", balance: 1, refunds: 1 });
  });

  it.each(["completed", "unknown"] as const)("settles the first job's reservation from a later job's %s call", async (state) => {
    const { firstJob, nowIso, lease, limits, quota, cancel } = await reservedGrant();
    // Persist the handoff before the final job: the quota receipt is still bound to the first job.
    await pool.query("UPDATE series_writing_run SET state = 'completed' WHERE id = $1", [firstJob]);
    const lastJob = randomUUID();
    await pool.query(`INSERT INTO series_writing_run
      (id, job_seq, series_id, grant_id, workspace_id, project_id, job_kind, input_hash, input_json, provider_key, model,
       state, call_cap, calls_used, created_at, updated_at)
      SELECT $2, job_seq + 1, series_id, grant_id, workspace_id, project_id, 'final', input_hash, input_json, provider_key, model,
             'running', 1, 1, created_at, updated_at FROM series_writing_run WHERE id = $1`, [firstJob, lastJob]);
    const review = state === "completed" ? {
      schema: SERIES_FINAL_REVIEW_SCHEMA, verdict: "pass", issues: [],
      dimensions: SERIES_FINAL_REVIEW_DIMENSIONS.map(key => ({ key, assessment: "符合要求", internalScore: 4 })),
    } : null;
    await pool.query(`INSERT INTO series_writing_stage
      (run_id, workspace_id, stage_key, ordinal, state, attempt_no, error_code, output_json, output_hash, updated_at)
      VALUES ($1, $2, 'final_review', 0, $3, 1, $4, $5, $6, now())`,
    [lastJob, workspaceId, state, review ? null : "timeout", review ? JSON.stringify(review) : null, review ? canonicalInputHash(review) : null]);
    await recordCall(lastJob, "final_review", state, state === "unknown" ? "timeout" : null);
    expect(await seriesStore.claimJob(workspaceId, lastJob, executor, nowIso, lease)).toBe(true);
    if (state === "completed") {
      const finish = () => seriesStore.completeJob(workspaceId, lastJob, executor, { kind: "final" }, limits, nowIso, lease, () => ({ kind: "done" }));
      expect(await finish()).toEqual({ kind: "grant_completed" });
      expect(await finish()).toEqual({ kind: "lost" });
    } else {
      expect(await seriesStore.finishJob(workspaceId, lastJob, executor, "needs_attention", "timeout", nowIso)).toBe(true);
      expect(await quota()).toEqual({ status: "held", balance: 0, refunds: 0 });
      expect((await cancel())?.state).toBe("canceled");
      expect((await cancel())?.state).toBe("canceled");
    }
    expect(await quota()).toEqual({ status: state === "unknown" ? "unknown" : "committed", balance: 0, refunds: 0 });
  });
});
