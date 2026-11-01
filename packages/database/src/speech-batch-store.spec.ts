import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { SpeechBatchConfirmation, SpeechBatchFrozen, SpeechBatchFrozenOperation, SpeechGenerationInput, SpeechVoice } from "@ai-drama/contracts";
import { speechBatchBudgets, speechExactHash, speechLineInputHash } from "@ai-drama/domain";
import { speechBatchInventoryInTransaction } from "./speech-store";
import { PostgresSpeechBatchStore, assertSpeechBatchDispatchInTransaction, bindSpeechBatchJobInTransaction } from "./speech-batch-store";
import type { DatabasePool, JobPersistenceService } from "./job-service";

vi.mock("./speech-store", () => ({ speechBatchInventoryInTransaction: vi.fn() }));
const inventoryMock = vi.mocked(speechBatchInventoryInTransaction);
const id = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const WS = id("1"), PROJECT = id("2"), SHOT = id("3"), PLAN = id("4"), LINE = id("5"), INPUT = id("6"), BATCH = id("8"), OP = id("9"), TOKEN = id("a"), JOB = id("b"), WORKFLOW = id("c"), AUTH = id("d"), EPISODE = id("f");
const SOURCE_HASH = "e".repeat(64), context = { actorId: "owner", traceId: "unit", idempotencyKey: "permanent-command-key" };
const ref = { batchId: BATCH, operationId: OP, dispatchToken: TOKEN };
const baseVoice: SpeechVoice = { catalogVoiceId: "Cherry", name: "Cherry", providerConfigurationId: WS, providerConfigurationVersion: "v1", providerKey: "dashscope-media",
  model: "qwen3-tts-flash", modelVersion: "v1", voiceId: "Cherry", locale: "zh-CN", rightsRef: "preset-v1", capabilities: { emotions: ["neutral"], speedMin: 1, speedMax: 1 } };
const voice = { ...baseVoice, id: id("7"), bindingId: id("e"), contentHash: speechExactHash(baseVoice) };
const input: SpeechGenerationInput = { workspaceId: WS, projectId: PROJECT, shotRevisionId: SHOT, planRevisionId: PLAN, lineId: LINE, lineInputRevisionId: INPUT,
  inputHash: speechLineInputHash(SHOT, { lineId: LINE, speakerBindingRevisionId: voice.id, displayText: "你好。", emotion: "neutral", speed: 1 }, voice),
  displayText: "你好。", spokenText: "你好。", voice, emotion: "neutral", speed: 1 };
const operation: SpeechBatchFrozenOperation = { id: OP, input, idempotencyKey: "permanent-operation-key", quote: { quoteId: id("0"), inputHash: input.inputHash, currency: "CNY",
  estimatedAmount: "0.20", maximumAmount: "0.50", expiresAt: "2099-01-01T00:00:00Z", providerConfigurationId: WS, providerConfigurationVersion: "v1", priceVersion: "v1", uncertainJobIds: [] } };
const frozen: SpeechBatchFrozen = { schema: "voice.episode.batch.v1", projectId: PROJECT, episodeId: EPISODE, sourceHash: SOURCE_HASH, operations: [operation], budgets: speechBatchBudgets([operation]), expiresAt: operation.quote.expiresAt };
const request = { sourceHash: SOURCE_HASH, lineInputRevisionIds: [INPUT] };
const confirmation: SpeechBatchConfirmation = { frozenHash: speechExactHash(frozen), maximumJobs: 1, budgets: frozen.budgets.map(({ currency, maximumAmount }) => ({ currency, maximumAmount })), confirmPossibleCharges: true, confirmedUncertainJobIds: [] };

type Options = { batch?: Record<string, unknown>; operation?: Record<string, unknown>; ready?: boolean; live?: boolean[]; owned?: boolean; busy?: boolean; active?: boolean; validJob?: boolean; preflight?: boolean; liveWorking?: boolean };
function harness(options: Options = {}) {
  const batch: Record<string, unknown> = { id: BATCH, workspace_id: WS, project_id: PROJECT, episode_id: EPISODE, created_by: "owner", idempotency_key: context.idempotencyKey,
    request_hash: speechExactHash(request), source_hash: SOURCE_HASH, frozen_json: structuredClone(frozen), frozen_hash: speechExactHash(frozen), state: "dispatching", confirmation_json: structuredClone(confirmation), cancel_requested: false,
    dispatch_token: TOKEN, lease_until: new Date("2099-01-01T00:00:00Z"), row_version: 1, created_at: new Date("2026-11-01T00:00:00Z"), ...options.batch };
  const op: Record<string, unknown> = { id: OP, batch_id: BATCH, workspace_id: WS, project_id: PROJECT, ordinal: 1, shot_revision_id: SHOT, line_input_revision_id: INPUT,
    quote_id: operation.quote.quoteId, idempotency_key: operation.idempotencyKey, frozen_json: structuredClone(operation), operation_hash: speechExactHash(operation), state: "working",
    authorization_id: AUTH, job_id: null, workflow_run_id: null, error_code: null, dispatch_token: TOKEN, lease_until: new Date("2099-01-01T00:00:00Z"), row_version: 1, ...options.operation };
  const live = [...(options.live ?? [true])];
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    let rows: unknown[] = [];
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) rows = [];
    else if (sql.includes("AS command_version")) rows = [{ command_version: options.ready === false ? null : "ads.speech.batch.storage.v1", operation_version: "ads.speech.batch.storage.v1", guards: 2 }];
    else if (sql.includes("AS present")) rows = [{ present: options.ready !== false }];
    else if (sql.includes("WHERE o.quote_id=$1")) rows = options.owned === false ? [] : [{ id: OP, batch_id: BATCH, workspace_id: WS }];
    else if (sql.startsWith("SELECT project_id FROM speech_batch_command")) rows = [{ project_id: PROJECT }];
    else if (sql.startsWith("SELECT workspace_id FROM speech_batch_command")) rows = [{ workspace_id: WS }];
    else if (sql.startsWith("SELECT id FROM project")) rows = [{ id: PROJECT }];
    else if (sql.startsWith("SELECT id FROM episode")) rows = [{ id: EPISODE }];
    else if (sql.startsWith("SELECT id FROM speech_batch_command") && sql.includes("ORDER BY")) rows = [{ id: BATCH }];
    else if (sql.startsWith("SELECT * FROM speech_batch_command")) rows = [structuredClone(batch)];
    else if (sql.startsWith("SELECT * FROM speech_batch_operation WHERE id=")) rows = [structuredClone(op)];
    else if (sql.startsWith("SELECT o.*,j.state")) rows = [{ ...structuredClone(op), job_state: op.job_id ? "QUEUED" : null }];
    else if (sql.includes("AS live")) rows = [{ live: live.length > 1 ? live.shift() : live[0] }];
    else if (sql.includes("FROM generation_job j JOIN workflow_run")) rows = options.validJob === false ? [] : [{ id: JOB }];
    else if (sql.includes("SELECT id,request_hash")) rows = options.preflight ? [{ id: BATCH, request_hash: batch.request_hash, created_by: batch.created_by }] : [];
    else if (sql.includes("AND id<>$4")) rows = options.active ? [{ id: id("e") }] : [];
    else if (sql.startsWith("SELECT 1 FROM speech_batch_command")) rows = options.busy ? [{ id: BATCH }] : [];
    else if (sql.startsWith("SELECT * FROM speech_batch_operation WHERE batch_id=")) rows = op.state === "pending" || values[2] === true && ["working", "unknown"].includes(String(op.state)) ? [structuredClone(op)] : [];
    else if (sql.startsWith("SELECT 1 FROM speech_batch_operation o JOIN")) rows = options.liveWorking ? [{ id: OP }] : [];
    else if (sql.startsWith("SELECT 1 FROM speech_batch_operation")) rows = ["job_created", "canceled"].includes(String(op.state)) ? [] : [{ id: OP }];
    else if (sql.startsWith("UPDATE speech_batch_operation SET authorization_id")) op.authorization_id = values[2];
    else if (sql.startsWith("UPDATE speech_batch_operation SET state='job_created'")) Object.assign(op, { state: "job_created", job_id: values[2], workflow_run_id: values[3], dispatch_token: null, lease_until: null });
    else if (sql.startsWith("UPDATE speech_batch_operation SET state='working'")) Object.assign(op, { state: "working", dispatch_token: values[2] });
    else if (sql.startsWith("UPDATE speech_batch_operation SET state='canceled'")) { if (!op.job_id) Object.assign(op, { state: "canceled", dispatch_token: null, lease_until: null }); }
    else if (sql.startsWith("UPDATE speech_batch_operation SET state=$3")) Object.assign(op, { state: values[2], error_code: values[3], dispatch_token: null, lease_until: null });
    else if (sql.startsWith("UPDATE speech_batch_command SET state='canceled'")) Object.assign(batch, { state: "canceled", cancel_requested: true, dispatch_token: null });
    else if (sql.startsWith("UPDATE speech_batch_command SET state='dispatching',confirmation_json")) Object.assign(batch, { state: "dispatching", confirmation_json: JSON.parse(String(values[2])) });
    else if (sql.startsWith("UPDATE speech_batch_command SET state='dispatching',dispatch_token")) Object.assign(batch, { state: "dispatching", dispatch_token: values[2] });
    else if (sql.startsWith("UPDATE speech_batch_command SET state='needs_attention'")) Object.assign(batch, { state: "needs_attention", dispatch_token: null });
    else if (sql.startsWith("UPDATE speech_batch_command SET state=$3")) batch.state = values[2];
    else if (sql.startsWith("UPDATE speech_batch_command SET dispatch_token=NULL")) batch.dispatch_token = null;
    else throw new Error(`Unexpected fake query: ${sql}`);
    return { rows, rowCount: rows.length || 1 };
  });
  const release = vi.fn(), client = { query, release } as unknown as PoolClient;
  const jobs = { runIdempotent: vi.fn(async (_scope, _status, work: (client: PoolClient) => Promise<unknown>) => ({ body: await work(client) })) } as unknown as JobPersistenceService;
  return { batch, op, query, release, client, jobs, store: new PostgresSpeechBatchStore({ connect: async () => client } as DatabasePool, jobs) };
}
beforeEach(() => {
  vi.clearAllMocks();
  inventoryMock.mockResolvedValue({ inventory: { projectId: PROJECT, episodeId: EPISODE, sourceHash: SOURCE_HASH, operationLimit: 100, blockers: [],
    lines: [{ shotRevisionId: SHOT, planRevisionId: PLAN, lineId: LINE, lineInputRevisionId: INPUT, displayText: input.displayText, voiceName: voice.name, status: "missing", jobIds: [] }] }, inputs: new Map([[INPUT, input]]) });
});

describe("speech batch command persistence (fake clients, no SQL execution)", () => {
  it("refuses absent draft readiness and propagates storage faults", async () => {
    const missing = harness({ ready: false }); expect(await missing.store.storageReady()).toBe(false); expect(missing.release).toHaveBeenCalledOnce();
    const broken = new PostgresSpeechBatchStore({ connect: async () => { throw new Error("storage unavailable"); } }, {} as JobPersistenceService);
    await expect(broken.storageReady()).rejects.toThrow("storage unavailable");
  });
  it("replays the fixed preflight receipt before reading current sources and rejects changed payload keys", async () => {
    const h = harness({ preflight: true, batch: { state: "canceled", cancel_requested: true } });
    expect((await h.store.findPreflight(WS, PROJECT, EPISODE, context.idempotencyKey, speechExactHash(request)))?.state).toBe("canceled");
    expect(inventoryMock).not.toHaveBeenCalled();
    await expect(h.store.findPreflight(WS, PROJECT, EPISODE, context.idempotencyKey, "f".repeat(64))).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });
  it("lists only the recent 20 receipts while retaining direct permanent reads", async () => {
    const h = harness();
    expect((await h.store.list(WS, PROJECT, EPISODE)).items[0]?.id).toBe(BATCH);
    expect(h.query.mock.calls.find(([sql]) => sql.includes("ORDER BY created_at DESC,id DESC"))?.[0]).toContain("LIMIT 20");
    expect((await h.store.read(WS, BATCH)).id).toBe(BATCH);
    expect(inventoryMock).not.toHaveBeenCalled();
  });
  it("reports the original Job's unknown result fact while preserving operation errors first", async () => {
    const h = harness({ operation: { state: "job_created", job_id: JOB, workflow_run_id: WORKFLOW,
      job_error_code: "REAL_MEDIA_SUBMISSION_UNKNOWN" } });
    expect((await h.store.read(WS, BATCH)).operations[0]).toMatchObject({ jobId: JOB, errorCode: "REAL_MEDIA_SUBMISSION_UNKNOWN" });
    h.op.error_code = "SPEECH_BATCH_REQUEST_UNKNOWN";
    expect((await h.store.read(WS, BATCH)).operations[0]?.errorCode).toBe("SPEECH_BATCH_REQUEST_UNKNOWN");
    expect(h.query.mock.calls.find(([sql]) => sql.startsWith("SELECT o.*,j.state"))?.[0]).toContain("j.error_code AS job_error_code");
  });
  it("checks current source hash and selected availability before inserting a new batch", async () => {
    const h = harness();
    const current = await inventoryMock(h.client, WS, PROJECT, EPISODE);
    inventoryMock.mockResolvedValueOnce({ ...current, inventory: { ...current.inventory, sourceHash: "f".repeat(64) } });
    await expect(h.store.create(WS, PROJECT, EPISODE, request, frozen, context)).rejects.toMatchObject({ code: "SPEECH_BATCH_SOURCE_CHANGED" });
    inventoryMock.mockResolvedValueOnce({ ...current, inventory: { ...current.inventory, lines: current.inventory.lines.map((line) => ({ ...line, status: "awaiting_selection" })) } });
    await expect(h.store.create(WS, PROJECT, EPISODE, request, frozen, context)).rejects.toMatchObject({ code: "SPEECH_BATCH_LINE_AVAILABLE" });
    expect(h.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
  });
  it("limits operation counts and frozen snapshot bytes without writing anything", async () => {
    const h = harness();
    await expect(h.store.create(WS, PROJECT, EPISODE, request, { ...frozen, operations: Array(101).fill(operation) }, context)).rejects.toMatchObject({ code: "SPEECH_BATCH_LIMIT" });
    await expect(h.store.create(WS, PROJECT, EPISODE, request, { ...frozen, operations: [{ ...operation, input: { ...input, displayText: "字".repeat(800_000) } }] }, context)).rejects.toMatchObject({ code: "SPEECH_BATCH_LIMIT" });
    expect(h.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
  });
  it("refuses corrupted operation JSON and duplicate aggregate confirmation currency totals", async () => {
    const h = harness({ operation: { frozen_json: { ...operation, idempotencyKey: "forged-key" } } });
    await expect(h.store.read(WS, BATCH)).rejects.toMatchObject({ code: "SPEECH_BATCH_STORAGE_CORRUPT" });
    const c = harness({ batch: { state: "quoted", confirmation_json: null } });
    await expect(c.store.confirm(WS, BATCH, { ...confirmation, budgets: [confirmation.budgets[0]!, confirmation.budgets[0]!] }, context)).rejects.toMatchObject({ code: "SPEECH_BATCH_BUDGET_CHANGED" });
    expect(c.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false);
  });
  it("replays identical confirmation without current source or expiry checks and blocks another active batch", async () => {
    const replay = harness(); expect((await replay.store.confirm(WS, BATCH, confirmation, context)).state).toBe("dispatching"); expect(inventoryMock).not.toHaveBeenCalled();
    const fresh = harness({ active: true, batch: { state: "quoted", confirmation_json: null } });
    await expect(fresh.store.confirm(WS, BATCH, confirmation, context)).rejects.toMatchObject({ code: "SPEECH_BATCH_ACTIVE_EXISTS" });
    expect(fresh.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false);
    expect(fresh.jobs.runIdempotent).toHaveBeenCalledWith(expect.objectContaining({ expiresAt: new Date("9999-12-31T00:00:00Z") }), 200, expect.any(Function));
  });
  it("never lets a batch-owned quote bypass dispatch checks through an ordinary single request", async () => {
    const absent = harness({ ready: false }); await expect(assertSpeechBatchDispatchInTransaction(absent.client, undefined, { quoteId: operation.quote.quoteId, budgetAuthorizationId: AUTH, idempotencyKey: operation.idempotencyKey, actorId: "owner" })).resolves.toBeUndefined();
    const owned = harness();
    await expect(assertSpeechBatchDispatchInTransaction(owned.client, undefined, { speech: input, quoteId: operation.quote.quoteId, budgetAuthorizationId: AUTH, idempotencyKey: operation.idempotencyKey, actorId: "owner" })).rejects.toMatchObject({ code: "SPEECH_BATCH_CONFIRMATION_CHANGED" });
    expect(owned.query.mock.calls.some(([sql]) => sql.includes("FOR UPDATE"))).toBe(false);
  });
  it("rechecks exact input, owner, authorization and both wall-clock fences before new Job creation", async () => {
    const body = { speech: input, quoteId: operation.quote.quoteId, budgetAuthorizationId: AUTH, idempotencyKey: operation.idempotencyKey, actorId: "owner" };
    const good = harness(); await expect(assertSpeechBatchDispatchInTransaction(good.client, ref, body)).resolves.toBeUndefined();
    expect(good.query.mock.calls.filter(([sql]) => sql.includes("AS live"))).toHaveLength(2);
    const expired = harness({ live: [true, false] }); await expect(assertSpeechBatchDispatchInTransaction(expired.client, ref, body)).rejects.toMatchObject({ code: "SPEECH_BATCH_LEASE_LOST" });
    const actor = harness(); await expect(assertSpeechBatchDispatchInTransaction(actor.client, ref, { ...body, actorId: "another-owner" })).rejects.toMatchObject({ code: "SPEECH_BATCH_CONFIRMATION_CHANGED" });
    const canceled = harness({ batch: { state: "canceled", cancel_requested: true } }); await expect(assertSpeechBatchDispatchInTransaction(canceled.client, ref, body)).rejects.toMatchObject({ code: "SPEECH_BATCH_CANCELED" });
  });
  it("binds only the exact existing core Job inside the caller transaction and never invents another task", async () => {
    const h = harness(); await bindSpeechBatchJobInTransaction(h.client, ref, { jobId: JOB, workflowRunId: WORKFLOW });
    expect(h.op).toMatchObject({ state: "job_created", job_id: JOB, workflow_run_id: WORKFLOW });
    expect(h.query.mock.calls.find(([sql]) => sql.includes("FROM generation_job j JOIN workflow_run"))?.[0]).toContain("j.input_snapshot->'speech'=$7::jsonb");
    expect(h.query.mock.calls.some(([sql]) => /^(INSERT|UPDATE) (generation_job|workflow_run|job_attempt)/.test(sql))).toBe(false);
    const invalid = harness({ validJob: false }); await expect(bindSpeechBatchJobInTransaction(invalid.client, ref, { jobId: JOB, workflowRunId: WORKFLOW })).rejects.toMatchObject({ code: "SPEECH_BATCH_CONFIRMATION_CHANGED" });
  });
  it("cancels only uncreated operations, keeping already-created Jobs and their budget facts", async () => {
    const h = harness({ operation: { state: "job_created", job_id: JOB, workflow_run_id: WORKFLOW, dispatch_token: null } });
    const view = await h.store.cancel(WS, BATCH, context);
    expect(view).toMatchObject({ state: "canceled", cancelRequested: true }); expect(view.operations[0]).toMatchObject({ state: "job_created", jobId: JOB, authorizationId: AUTH });
    expect(h.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE generation_job") || sql.includes("DELETE FROM"))).toBe(false);
  });
  it("keeps a concurrent owner's live working lease dispatching and makes expired/pending work need attention", async () => {
    const live = harness({ liveWorking: true }); expect((await live.store.finish(WS, BATCH)).state).toBe("dispatching");
    expect(live.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false);
    const expired = harness(); expect((await expired.store.finish(WS, BATCH)).state).toBe("needs_attention");
    const canceled = harness({ batch: { state: "canceled", cancel_requested: true } }); expect((await canceled.store.finish(WS, BATCH)).state).toBe("canceled");
  });
  it("claims only pending automatically, replays unknown only on resume, and never reclaims blocked operations", async () => {
    const pending = harness({ batch: { dispatch_token: null }, operation: { state: "pending", dispatch_token: null, authorization_id: null } });
    expect((await pending.store.claim(WS, BATCH, false))?.operation.idempotencyKey).toBe(operation.idempotencyKey);
    const unknown = harness({ batch: { state: "needs_attention", dispatch_token: null }, operation: { state: "unknown", dispatch_token: null } });
    expect(await unknown.store.claim(WS, BATCH, false)).toBeNull(); expect((await unknown.store.claim(WS, BATCH, true))?.authorizationId).toBe(AUTH);
    const blocked = harness({ batch: { state: "needs_attention", dispatch_token: null }, operation: { state: "blocked", dispatch_token: null } }); expect(await blocked.store.claim(WS, BATCH, true)).toBeNull();
  });
  it("rejects expired authorization writes and ignores stale failure callbacks without changing newer progress", async () => {
    const expired = harness({ live: [false] }); await expect(expired.store.recordAuthorization(WS, ref, AUTH)).rejects.toMatchObject({ code: "SPEECH_BATCH_LEASE_LOST" });
    await expired.store.failOperation(WS, ref, "TIMEOUT", true); expect(expired.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false);
    const newer = harness({ operation: { dispatch_token: id("b") } }); await newer.store.failOperation(WS, ref, "TIMEOUT", true);
    expect(newer.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false);
  });
});
