import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { SPEECH_BATCH_MAX_OPERATIONS, SPEECH_BATCH_MAX_SNAPSHOT_BYTES, SPEECH_BATCH_SCHEMA, SPEECH_BATCH_STORAGE_VERSION,
  speechBatchConfirmSchema, speechBatchPreflightSchema, speechVoiceSchema, type SpeechBatchClaim, type SpeechBatchConfirmation,
  type SpeechBatchDispatchRef, type SpeechBatchFrozen, type SpeechBatchFrozenOperation, type SpeechBatchInventory,
  type SpeechBatchPreflightRequest, type SpeechBatchView, type SpeechGenerationInput } from "@ai-drama/contracts";
import { assertSpeechBatchConfirmation, speechBatchBudgets, speechExactHash, speechLineInputHash } from "@ai-drama/domain";
import { PersistenceError, type DatabasePool, type JobPersistenceService } from "./job-service";
import { speechBatchInventoryInTransaction } from "./speech-store";

type Row = QueryResultRow & Record<string, unknown>;
export interface SpeechBatchContext { actorId: string; traceId: string; idempotencyKey: string }
export interface SpeechBatchPersistence {
  storageReady(): Promise<boolean>;
  inventory(workspaceId: string, projectId: string, episodeId: string): Promise<SpeechBatchInventory>;
  findPreflight(workspaceId: string, projectId: string, episodeId: string, key: string, requestHash: string): Promise<SpeechBatchView | null>;
  create(workspaceId: string, projectId: string, episodeId: string, request: SpeechBatchPreflightRequest, frozen: SpeechBatchFrozen, context: SpeechBatchContext): Promise<SpeechBatchView>;
  read(workspaceId: string, batchId: string): Promise<SpeechBatchView>;
  list(workspaceId: string, projectId: string, episodeId: string): Promise<{ items: SpeechBatchView[] }>;
  confirm(workspaceId: string, batchId: string, body: SpeechBatchConfirmation, context: SpeechBatchContext): Promise<SpeechBatchView>;
  cancel(workspaceId: string, batchId: string, context: SpeechBatchContext): Promise<SpeechBatchView>;
  claim(workspaceId: string, batchId: string, resume: boolean): Promise<SpeechBatchClaim | null>;
  recordAuthorization(workspaceId: string, ref: SpeechBatchDispatchRef, authorizationId: string): Promise<void>;
  failOperation(workspaceId: string, ref: SpeechBatchDispatchRef, code: string, unknown: boolean): Promise<void>;
  finish(workspaceId: string, batchId: string): Promise<SpeechBatchView>;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function fail(code: string, message: string): never { throw new PersistenceError(code, message); }
const parsed = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;
const iso = (value: unknown) => (value instanceof Date ? value : new Date(String(value))).toISOString();
function contextValid(context: SpeechBatchContext): void {
  if (!context.actorId || context.actorId.length > 200 || !/^[\x21-\x7e]{1,200}$/.test(context.idempotencyKey)) fail("VALIDATION_ERROR", "A bounded actor and permanent request key are required");
}
function validateFrozen(frozen: SpeechBatchFrozen, workspaceId: string, projectId: string, episodeId: string): void {
  if (!frozen || frozen.schema !== SPEECH_BATCH_SCHEMA || frozen.projectId !== projectId || frozen.episodeId !== episodeId
    || !/^[a-f0-9]{64}$/.test(frozen.sourceHash) || !Array.isArray(frozen.operations) || !frozen.operations.length
    || frozen.operations.length > SPEECH_BATCH_MAX_OPERATIONS || Buffer.byteLength(JSON.stringify(frozen), "utf8") > SPEECH_BATCH_MAX_SNAPSHOT_BYTES) fail("SPEECH_BATCH_LIMIT", "The frozen command must contain 1-100 operations and at most 2 MB");
  const sets = [new Set<string>(), new Set<string>(), new Set<string>(), new Set<string>()];
  for (const operation of frozen.operations) {
    const input = operation.input, quote = operation.quote;
    if (!UUID.test(operation.id) || !input || input.workspaceId !== workspaceId || input.projectId !== projectId
      || [input.shotRevisionId, input.planRevisionId, input.lineId, input.lineInputRevisionId].some((id) => !UUID.test(id))
      || input.displayText !== input.spokenText || !input.displayText || !Number.isFinite(input.speed)
      || !quote || !UUID.test(quote.quoteId) || input.inputHash !== quote.inputHash || !/^[a-f0-9]{64}$/.test(input.inputHash)
      || quote.providerConfigurationId !== input.voice.providerConfigurationId || quote.providerConfigurationVersion !== input.voice.providerConfigurationVersion
      || !/^[\x21-\x7e]{1,200}$/.test(operation.idempotencyKey) || !Number.isFinite(Date.parse(quote.expiresAt))) fail("SPEECH_BATCH_INVALID", "Frozen input, quote and permanent operation identity must agree");
    const { id, bindingId, contentHash, ...voice } = input.voice;
    if (!UUID.test(id) || !UUID.test(bindingId) || !speechVoiceSchema.safeParse(voice).success || speechExactHash(voice) !== contentHash
      || speechLineInputHash(input.shotRevisionId, { lineId: input.lineId, speakerBindingRevisionId: id, displayText: input.displayText, emotion: input.emotion, speed: input.speed }, input.voice) !== input.inputHash) fail("SPEECH_BATCH_INVALID", "Frozen voice input is not exact");
    [operation.id, input.lineInputRevisionId, quote.quoteId, operation.idempotencyKey].forEach((value, index) => {
      if (sets[index]!.has(value)) fail("SPEECH_BATCH_INVALID", "Duplicate operation, input, quote or permanent key"); sets[index]!.add(value);
    });
  }
  if (speechExactHash(frozen.budgets) !== speechExactHash(speechBatchBudgets(frozen.operations))
    || Date.parse(frozen.expiresAt) !== Math.min(...frozen.operations.map((operation) => Date.parse(operation.quote.expiresAt)))) fail("SPEECH_BATCH_INVALID", "Frozen budgets and expiry must match the exact operations");
}
async function lockProject(client: PoolClient, workspaceId: string, projectId: string): Promise<void> {
  if (!(await client.query("SELECT id FROM project WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL FOR UPDATE", [projectId, workspaceId])).rows[0]) fail("NOT_FOUND", "Project not found");
}
async function lockBatch(client: PoolClient, workspaceId: string, batchId: string): Promise<Row> {
  const initial = (await client.query<Row>("SELECT project_id FROM speech_batch_command WHERE id=$1 AND workspace_id=$2", [batchId, workspaceId])).rows[0];
  if (!initial) fail("NOT_FOUND", "Speech batch not found");
  await lockProject(client, workspaceId, String(initial.project_id));
  const row = (await client.query<Row>("SELECT * FROM speech_batch_command WHERE id=$1 AND workspace_id=$2 FOR UPDATE", [batchId, workspaceId])).rows[0];
  if (!row) fail("NOT_FOUND", "Speech batch not found"); return row;
}
function frozenOf(row: Row): SpeechBatchFrozen {
  const frozen = parsed<SpeechBatchFrozen>(row.frozen_json);
  validateFrozen(frozen, String(row.workspace_id), String(row.project_id), String(row.episode_id));
  if (speechExactHash(frozen) !== row.frozen_hash) fail("SPEECH_BATCH_STORAGE_CORRUPT", "Frozen batch hash differs"); return frozen;
}
async function readIn(client: PoolClient, workspaceId: string, batchId: string): Promise<SpeechBatchView> {
  const row = (await client.query<Row>("SELECT * FROM speech_batch_command WHERE id=$1 AND workspace_id=$2", [batchId, workspaceId])).rows[0];
  if (!row) fail("NOT_FOUND", "Speech batch not found");
  const frozen = frozenOf(row);
  const operations = await client.query<Row>(`SELECT o.*,j.state AS job_state,j.error_code AS job_error_code FROM speech_batch_operation o
    LEFT JOIN generation_job j ON j.id=o.job_id AND j.workspace_id=o.workspace_id AND j.project_id=o.project_id AND j.workflow_run_id=o.workflow_run_id
    WHERE o.batch_id=$1 AND o.workspace_id=$2 ORDER BY o.ordinal`, [batchId, workspaceId]);
  if (operations.rows.length !== frozen.operations.length || operations.rows.some((operation, index) => {
    const expected = frozen.operations[index]!;
    return operation.id !== expected.id || Number(operation.ordinal) !== index + 1 || operation.operation_hash !== speechExactHash(expected)
      || speechExactHash(parsed(operation.frozen_json)) !== operation.operation_hash || operation.quote_id !== expected.quote.quoteId
      || operation.idempotency_key !== expected.idempotencyKey || operation.shot_revision_id !== expected.input.shotRevisionId
      || operation.line_input_revision_id !== expected.input.lineInputRevisionId;
  })) fail("SPEECH_BATCH_STORAGE_CORRUPT", "Operation snapshots differ from the fixed batch");
  return { id: batchId, projectId: String(row.project_id), episodeId: String(row.episode_id), frozenHash: String(row.frozen_hash), frozen,
    state: row.state as SpeechBatchView["state"], confirmation: row.confirmation_json ? parsed<SpeechBatchConfirmation>(row.confirmation_json) : null,
    cancelRequested: row.cancel_requested === true, createdAt: iso(row.created_at), operations: operations.rows.map((operation, index) => {
      const value = frozen.operations[index]!;
      return { id: value.id, lineId: value.input.lineId, lineInputRevisionId: value.input.lineInputRevisionId, displayText: value.input.displayText,
        shotRevisionId: value.input.shotRevisionId, state: operation.state as SpeechBatchView["operations"][number]["state"], quote: value.quote,
        maximumAmount: value.quote.maximumAmount, authorizationId: operation.authorization_id ? String(operation.authorization_id) : null,
        jobId: operation.job_id ? String(operation.job_id) : null, workflowRunId: operation.workflow_run_id ? String(operation.workflow_run_id) : null,
        jobState: operation.job_state ? String(operation.job_state) : null,
        errorCode: operation.error_code ? String(operation.error_code) : operation.job_error_code ? String(operation.job_error_code) : null };
    }) };
}
async function currentInputs(client: PoolClient, batch: Row, operations: SpeechBatchFrozenOperation[]): Promise<void> {
  const { inventory, inputs } = await speechBatchInventoryInTransaction(client, String(batch.workspace_id), String(batch.project_id), String(batch.episode_id));
  if (inventory.sourceHash !== batch.source_hash) fail("SPEECH_BATCH_SOURCE_CHANGED", "Current episode sources differ from the fixed batch");
  for (const operation of operations) {
    const current = inputs.get(operation.input.lineInputRevisionId), line = inventory.lines.find((value) => value.lineInputRevisionId === operation.input.lineInputRevisionId);
    if (!current || speechExactHash(current) !== speechExactHash(operation.input)) fail("SPEECH_BATCH_SOURCE_CHANGED", "A frozen line changed");
    if (!line || !["missing", "uncertain"].includes(line.status)) fail("SPEECH_BATCH_LINE_AVAILABLE", "Audio or an active Job already exists for this line");
  }
}
async function fenced(client: PoolClient, workspaceId: string, ref: SpeechBatchDispatchRef): Promise<{ batch: Row; operation: Row }> {
  const batch = await lockBatch(client, workspaceId, ref.batchId);
  const operation = (await client.query<Row>("SELECT * FROM speech_batch_operation WHERE id=$1 AND batch_id=$2 AND workspace_id=$3 FOR UPDATE", [ref.operationId, ref.batchId, workspaceId])).rows[0];
  if (batch.cancel_requested === true || batch.state === "canceled") fail("SPEECH_BATCH_CANCELED", "The batch no longer permits creating Jobs");
  if (!operation) fail("NOT_FOUND", "Speech batch operation not found");
  if (!batch.confirmation_json || !["dispatching", "needs_attention"].includes(String(batch.state)) || operation.state !== "working"
    || operation.job_id || batch.dispatch_token !== ref.dispatchToken || operation.dispatch_token !== ref.dispatchToken) fail("SPEECH_BATCH_LEASE_LOST", "The dispatch fence is no longer current");
  const live = await client.query(`SELECT b.lease_until>clock_timestamp() AND o.lease_until>clock_timestamp() AS live
    FROM speech_batch_command b JOIN speech_batch_operation o ON o.batch_id=b.id AND o.workspace_id=b.workspace_id
    WHERE b.id=$1 AND o.id=$2 AND b.workspace_id=$3 AND b.dispatch_token=$4 AND o.dispatch_token=$4`, [ref.batchId, ref.operationId, workspaceId, ref.dispatchToken]);
  if (live.rows[0]?.live !== true) fail("SPEECH_BATCH_LEASE_LOST", "The dispatch lease expired while waiting for locks");
  return { batch, operation };
}

/** This is a command-receipt store, not another queue, provider sender or Job state machine. */
export class PostgresSpeechBatchStore implements SpeechBatchPersistence {
  private readonly leaseMs: number;
  constructor(private readonly pool: DatabasePool, private readonly jobs: JobPersistenceService, options: { leaseMs?: number } = {}) {
    this.leaseMs = Math.max(1000, Math.min(options.leaseMs ?? 60_000, 180_000));
  }
  private async connection<T>(work: (client: PoolClient) => Promise<T>): Promise<T> { const client = await this.pool.connect(); try { return await work(client); } finally { client.release(); } }
  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> { return this.connection(async (client) => { await client.query("BEGIN"); try { const value = await work(client); await client.query("COMMIT"); return value; } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } }); }
  async storageReady(): Promise<boolean> { return this.connection(async (client) => {
    const row = (await client.query(`SELECT obj_description(to_regclass('speech_batch_command'),'pg_class') AS command_version,
      obj_description(to_regclass('speech_batch_operation'),'pg_class') AS operation_version,
      (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgenabled IN ('O','A') AND tgname='speech_batch_identity_guard'
       AND tgrelid=ANY(ARRAY[to_regclass('speech_batch_command'),to_regclass('speech_batch_operation')])) AS guards`)).rows[0];
    return row?.command_version === SPEECH_BATCH_STORAGE_VERSION && row.operation_version === SPEECH_BATCH_STORAGE_VERSION && Number(row.guards) === 2;
  }); }
  async inventory(workspaceId: string, projectId: string, episodeId: string): Promise<SpeechBatchInventory> { return this.transaction(async (client) => (await speechBatchInventoryInTransaction(client, workspaceId, projectId, episodeId, true)).inventory); }
  async read(workspaceId: string, batchId: string): Promise<SpeechBatchView> { return this.connection((client) => readIn(client, workspaceId, batchId)); }
  async list(workspaceId: string, projectId: string, episodeId: string): Promise<{ items: SpeechBatchView[] }> { return this.connection(async (client) => {
    const found = await client.query("SELECT id FROM episode WHERE id=$1 AND workspace_id=$2 AND project_id=$3", [episodeId, workspaceId, projectId]);
    if (!found.rows[0]) fail("NOT_FOUND", "Episode not found");
    const rows = await client.query<Row>("SELECT id FROM speech_batch_command WHERE workspace_id=$1 AND project_id=$2 AND episode_id=$3 ORDER BY created_at DESC,id DESC LIMIT 20", [workspaceId, projectId, episodeId]);
    const items = []; for (const row of rows.rows) items.push(await readIn(client, workspaceId, String(row.id))); return { items };
  }); }
  async findPreflight(workspaceId: string, projectId: string, episodeId: string, key: string, requestHash: string): Promise<SpeechBatchView | null> { return this.connection(async (client) => {
    const row = (await client.query<Row>("SELECT id,request_hash FROM speech_batch_command WHERE workspace_id=$1 AND project_id=$2 AND episode_id=$3 AND idempotency_key=$4", [workspaceId, projectId, episodeId, key])).rows[0];
    if (!row) return null; if (row.request_hash !== requestHash) fail("IDEMPOTENCY_KEY_REUSED", "The preflight key belongs to another exact request"); return readIn(client, workspaceId, String(row.id));
  }); }
  private async write(workspaceId: string, route: string, body: unknown, context: SpeechBatchContext, work: (client: PoolClient) => Promise<SpeechBatchView>): Promise<SpeechBatchView> {
    contextValid(context);
    const result = await this.jobs.runIdempotent({ workspaceId, actorId: context.actorId, httpMethod: "POST", routeKey: route, key: context.idempotencyKey,
      requestHash: speechExactHash(body), expiresAt: new Date("9999-12-31T00:00:00Z") }, 200, work);
    return this.read(workspaceId, result.body.id);
  }
  async create(workspaceId: string, projectId: string, episodeId: string, request: SpeechBatchPreflightRequest, frozen: SpeechBatchFrozen, context: SpeechBatchContext): Promise<SpeechBatchView> {
    const checked = speechBatchPreflightSchema.safeParse(request); if (!checked.success) fail("SPEECH_BATCH_INVALID", "Invalid batch selection");
    return this.write(workspaceId, `/projects/${projectId}/episodes/${episodeId}/speech-batch-preflight`, request, context, async (client) => {
      await lockProject(client, workspaceId, projectId);
      const prior = (await client.query<Row>("SELECT id,request_hash,created_by FROM speech_batch_command WHERE workspace_id=$1 AND project_id=$2 AND episode_id=$3 AND idempotency_key=$4", [workspaceId, projectId, episodeId, context.idempotencyKey])).rows[0];
      if (prior) { if (prior.request_hash !== speechExactHash(request) || prior.created_by !== context.actorId) fail("IDEMPOTENCY_KEY_REUSED", "The preflight key belongs to another request"); return readIn(client, workspaceId, String(prior.id)); }
      validateFrozen(frozen, workspaceId, projectId, episodeId);
      if (request.sourceHash !== frozen.sourceHash || speechExactHash([...request.lineInputRevisionIds].sort()) !== speechExactHash(frozen.operations.map((value) => value.input.lineInputRevisionId).sort())) fail("SPEECH_BATCH_SOURCE_CHANGED", "Frozen operations differ from the selected source");
      const batchId = randomUUID(), frozenHash = speechExactHash(frozen);
      await currentInputs(client, { workspace_id: workspaceId, project_id: projectId, episode_id: episodeId, source_hash: frozen.sourceHash }, frozen.operations);
      if (Date.parse(frozen.expiresAt) <= Date.now()) fail("SPEECH_BATCH_QUOTE_EXPIRED", "The frozen quote has expired");
      await client.query(`INSERT INTO speech_batch_command(id,workspace_id,project_id,episode_id,created_by,idempotency_key,request_hash,source_hash,frozen_hash,frozen_json)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`, [batchId, workspaceId, projectId, episodeId, context.actorId, context.idempotencyKey, speechExactHash(request), frozen.sourceHash, frozenHash, JSON.stringify(frozen)]);
      for (const [index, operation] of frozen.operations.entries()) await client.query(`INSERT INTO speech_batch_operation(id,workspace_id,project_id,batch_id,ordinal,shot_revision_id,line_input_revision_id,quote_id,idempotency_key,operation_hash,frozen_json)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`, [operation.id, workspaceId, projectId, batchId, index + 1, operation.input.shotRevisionId, operation.input.lineInputRevisionId, operation.quote.quoteId, operation.idempotencyKey, speechExactHash(operation), JSON.stringify(operation)]);
      return readIn(client, workspaceId, batchId);
    });
  }
  async confirm(workspaceId: string, batchId: string, body: SpeechBatchConfirmation, context: SpeechBatchContext): Promise<SpeechBatchView> {
    const checked = speechBatchConfirmSchema.safeParse(body); if (!checked.success) fail("SPEECH_BATCH_CONFIRMATION_CHANGED", "Confirm the fixed command");
    return this.write(workspaceId, `/speech-batches/${batchId}/confirm`, body, context, async (client) => {
      const batch = await lockBatch(client, workspaceId, batchId), frozen = frozenOf(batch);
      if (batch.created_by !== context.actorId) fail("SPEECH_BATCH_CONFIRMATION_CHANGED", "Only the original actor may confirm this batch");
      assertSpeechBatchConfirmation(frozen.operations, String(batch.frozen_hash), body);
      if (batch.confirmation_json) { if (speechExactHash(parsed(batch.confirmation_json)) !== speechExactHash(body)) fail("SPEECH_BATCH_CONFIRMATION_CHANGED", "The confirmed command is immutable"); return readIn(client, workspaceId, batchId); }
      if (batch.cancel_requested === true) fail("SPEECH_BATCH_CANCELED", "The batch was canceled");
      if (Date.parse(frozen.expiresAt) <= Date.now()) fail("SPEECH_BATCH_QUOTE_EXPIRED", "The frozen quote has expired");
      await currentInputs(client, batch, frozen.operations);
      const active = await client.query("SELECT id FROM speech_batch_command WHERE workspace_id=$1 AND project_id=$2 AND episode_id=$3 AND id<>$4 AND state IN ('dispatching','needs_attention') AND NOT cancel_requested LIMIT 1", [workspaceId, batch.project_id, batch.episode_id, batchId]);
      if (active.rows[0]) fail("SPEECH_BATCH_ACTIVE_EXISTS", "Another confirmed batch is active for this episode");
      await client.query("UPDATE speech_batch_command SET state='dispatching',confirmation_json=$3::jsonb,confirmed_by=$4,confirmed_at=now(),row_version=row_version+1,updated_at=now() WHERE id=$1 AND workspace_id=$2", [batchId, workspaceId, JSON.stringify(body), context.actorId]);
      return readIn(client, workspaceId, batchId);
    });
  }
  async cancel(workspaceId: string, batchId: string, context: SpeechBatchContext): Promise<SpeechBatchView> { return this.write(workspaceId, `/speech-batches/${batchId}/cancel`, {}, context, async (client) => {
    const batch = await lockBatch(client, workspaceId, batchId); if (batch.created_by !== context.actorId) fail("SPEECH_BATCH_CONFIRMATION_CHANGED", "Only the original actor may cancel this batch");
    if (batch.state === "canceled" || batch.state === "dispatched") return readIn(client, workspaceId, batchId);
    await client.query("UPDATE speech_batch_operation SET state='canceled',dispatch_token=NULL,lease_until=NULL,row_version=row_version+1,updated_at=now() WHERE batch_id=$1 AND workspace_id=$2 AND job_id IS NULL AND state<>'canceled'", [batchId, workspaceId]);
    await client.query("UPDATE speech_batch_command SET state='canceled',cancel_requested=true,cancel_requested_at=now(),dispatch_token=NULL,lease_until=NULL,row_version=row_version+1,updated_at=now() WHERE id=$1 AND workspace_id=$2", [batchId, workspaceId]);
    return readIn(client, workspaceId, batchId);
  }); }
  async claim(workspaceId: string, batchId: string, resume: boolean): Promise<SpeechBatchClaim | null> { return this.transaction(async (client) => {
    const batch = await lockBatch(client, workspaceId, batchId);
    if (batch.cancel_requested === true || !["dispatching", "needs_attention"].includes(String(batch.state)) || batch.state === "needs_attention" && !resume) return null;
    const busy = await client.query("SELECT 1 FROM speech_batch_command WHERE id=$1 AND workspace_id=$2 AND lease_until>clock_timestamp()", [batchId, workspaceId]); if (busy.rows[0]) return null;
    const operation = (await client.query<Row>(`SELECT * FROM speech_batch_operation WHERE batch_id=$1 AND workspace_id=$2 AND job_id IS NULL
      AND (state='pending' OR ($3::boolean AND (state='unknown' OR (state='working' AND lease_until<=clock_timestamp())))) ORDER BY ordinal LIMIT 1 FOR UPDATE`, [batchId, workspaceId, resume])).rows[0];
    if (!operation) return null;
    const frozen = frozenOf(batch), value = frozen.operations.find((item) => item.id === operation.id);
    if (!value || operation.operation_hash !== speechExactHash(value)) fail("SPEECH_BATCH_STORAGE_CORRUPT", "The operation differs from its fixed snapshot");
    const token = randomUUID();
    await client.query("UPDATE speech_batch_operation SET state='working',dispatch_token=$3,lease_until=clock_timestamp()+($4::int*interval '1 millisecond'),error_code=NULL,row_version=row_version+1,updated_at=now() WHERE id=$1 AND workspace_id=$2", [value.id, workspaceId, token, this.leaseMs]);
    await client.query("UPDATE speech_batch_command SET state='dispatching',dispatch_token=$3,lease_until=clock_timestamp()+($4::int*interval '1 millisecond'),row_version=row_version+1,updated_at=now() WHERE id=$1 AND workspace_id=$2", [batchId, workspaceId, token, this.leaseMs]);
    return { ref: { batchId, operationId: value.id, dispatchToken: token }, operation: value, authorizationId: operation.authorization_id ? String(operation.authorization_id) : null };
  }); }
  async recordAuthorization(workspaceId: string, ref: SpeechBatchDispatchRef, authorizationId: string): Promise<void> { if (!UUID.test(authorizationId)) fail("SPEECH_BATCH_INVALID", "Invalid authorization identity"); await this.transaction(async (client) => {
    const { operation } = await fenced(client, workspaceId, ref);
    if (operation.authorization_id) { if (operation.authorization_id !== authorizationId) fail("SPEECH_BATCH_CONFIRMATION_CHANGED", "Authorization identity changed"); return; }
    await client.query("UPDATE speech_batch_operation SET authorization_id=$3,row_version=row_version+1,updated_at=now() WHERE id=$1 AND workspace_id=$2", [ref.operationId, workspaceId, authorizationId]);
  }); }
  async failOperation(workspaceId: string, ref: SpeechBatchDispatchRef, code: string, unknown: boolean): Promise<void> { await this.transaction(async (client) => {
    const batch = await lockBatch(client, workspaceId, ref.batchId);
    const operation = (await client.query<Row>("SELECT * FROM speech_batch_operation WHERE id=$1 AND batch_id=$2 AND workspace_id=$3 FOR UPDATE", [ref.operationId, ref.batchId, workspaceId])).rows[0];
    if (!operation || operation.job_id || batch.cancel_requested === true || batch.dispatch_token !== ref.dispatchToken || operation.dispatch_token !== ref.dispatchToken) return;
    const live = await client.query(`SELECT b.lease_until>clock_timestamp() AND o.lease_until>clock_timestamp() AS live
      FROM speech_batch_command b JOIN speech_batch_operation o ON o.batch_id=b.id AND o.workspace_id=b.workspace_id
      WHERE b.id=$1 AND o.id=$2 AND b.workspace_id=$3 AND b.dispatch_token=$4 AND o.dispatch_token=$4`, [ref.batchId, ref.operationId, workspaceId, ref.dispatchToken]);
    if (live.rows[0]?.live !== true) return;
    await client.query("UPDATE speech_batch_operation SET state=$3,error_code=$4,dispatch_token=NULL,lease_until=NULL,row_version=row_version+1,updated_at=now() WHERE id=$1 AND workspace_id=$2", [ref.operationId, workspaceId, unknown ? "unknown" : "blocked", /^[A-Z0-9_]{1,100}$/.test(code) ? code : "SPEECH_BATCH_REQUEST_UNKNOWN"]);
    await client.query("UPDATE speech_batch_command SET state='needs_attention',dispatch_token=NULL,lease_until=NULL,row_version=row_version+1,updated_at=now() WHERE id=$1 AND workspace_id=$2", [ref.batchId, workspaceId]);
  }); }
  async finish(workspaceId: string, batchId: string): Promise<SpeechBatchView> { return this.transaction(async (client) => {
    const batch = await lockBatch(client, workspaceId, batchId);
    if (["quoted", "canceled", "dispatched"].includes(String(batch.state))) return readIn(client, workspaceId, batchId);
    const live = await client.query(`SELECT 1 FROM speech_batch_operation o JOIN speech_batch_command b ON b.id=o.batch_id AND b.workspace_id=o.workspace_id
      WHERE b.id=$1 AND b.workspace_id=$2 AND o.state='working' AND o.dispatch_token=b.dispatch_token
        AND o.lease_until>clock_timestamp() AND b.lease_until>clock_timestamp() LIMIT 1`, [batchId, workspaceId]);
    if (live.rows[0]) return readIn(client, workspaceId, batchId);
    const unbound = await client.query("SELECT 1 FROM speech_batch_operation WHERE batch_id=$1 AND workspace_id=$2 AND state NOT IN ('job_created','canceled') LIMIT 1", [batchId, workspaceId]);
    const state = unbound.rows[0] ? "needs_attention" : "dispatched";
    if (batch.state !== state) await client.query("UPDATE speech_batch_command SET state=$3,row_version=row_version+1,updated_at=now() WHERE id=$1 AND workspace_id=$2", [batchId, workspaceId, state]);
    return readIn(client, workspaceId, batchId);
  }); }
}

/** Every real-media consumption calls this, including calls without a speech/batch ref, preventing route bypass. */
export async function assertSpeechBatchDispatchInTransaction(client: PoolClient, ref: SpeechBatchDispatchRef | undefined,
  input: { speech?: SpeechGenerationInput; quoteId: string; budgetAuthorizationId: string; idempotencyKey: string; actorId: string }): Promise<void> {
  const ready = await client.query("SELECT to_regclass('speech_batch_operation') IS NOT NULL AS present");
  if (ready.rows[0]?.present !== true) { if (ref) fail("SPEECH_BATCH_STORAGE_UNAVAILABLE", "Batch storage is unavailable"); return; }
  const owned = (await client.query<Row>(`SELECT o.id,o.batch_id,b.workspace_id FROM speech_batch_operation o
    JOIN speech_batch_command b ON b.id=o.batch_id AND b.workspace_id=o.workspace_id WHERE o.quote_id=$1`, [input.quoteId])).rows[0];
  if (!owned && !ref) return;
  if (!owned || !ref || owned.id !== ref.operationId || owned.batch_id !== ref.batchId || !input.speech) fail("SPEECH_BATCH_CONFIRMATION_CHANGED", "A batch-owned quote requires its exact dispatch reference");
  const { batch, operation } = await fenced(client, String(owned.workspace_id), ref);
  const frozen = frozenOf(batch), value = frozen.operations.find((item) => item.id === ref.operationId);
  if (!value || batch.created_by !== input.actorId || operation.authorization_id !== input.budgetAuthorizationId || value.quote.quoteId !== input.quoteId
    || value.idempotencyKey !== input.idempotencyKey || operation.operation_hash !== speechExactHash(value) || speechExactHash(value.input) !== speechExactHash(input.speech)) fail("SPEECH_BATCH_CONFIRMATION_CHANGED", "The operation differs from its confirmed input, actor, quote, authorization or permanent key");
  assertSpeechBatchConfirmation(frozen.operations, String(batch.frozen_hash), parsed<SpeechBatchConfirmation>(batch.confirmation_json));
  if (Date.parse(value.quote.expiresAt) <= Date.now()) fail("SPEECH_BATCH_QUOTE_EXPIRED", "The operation quote has expired");
  await currentInputs(client, batch, [value]);
  // The inventory can wait behind other row locks; validate wall-clock fencing after all such reads as well.
  await fenced(client, String(owned.workspace_id), ref);
}

/** Called atomically inside core Job creation, after the dispatch assertion and before the transaction commits. */
export async function bindSpeechBatchJobInTransaction(client: PoolClient, ref: SpeechBatchDispatchRef | undefined,
  input: { jobId: string; workflowRunId: string }): Promise<void> {
  if (!ref) return;
  const scope = (await client.query<Row>("SELECT workspace_id FROM speech_batch_command WHERE id=$1", [ref.batchId])).rows[0];
  if (!scope) fail("NOT_FOUND", "Speech batch not found");
  const workspaceId = String(scope.workspace_id), { batch, operation } = await fenced(client, workspaceId, ref);
  const frozen = frozenOf(batch), value = frozen.operations.find((item) => item.id === ref.operationId);
  if (!value || !operation.authorization_id) fail("SPEECH_BATCH_CONFIRMATION_CHANGED", "Operation has no confirmed authorization");
  const job = await client.query(`SELECT j.id FROM generation_job j JOIN workflow_run w ON w.id=j.workflow_run_id AND w.workspace_id=j.workspace_id
    WHERE j.id=$1 AND j.workflow_run_id=$2 AND j.workspace_id=$3 AND j.project_id=$4 AND j.source_shot_revision_id=$5 AND j.kind='MEDIA_TTS'
      AND w.requested_by=$6 AND j.input_snapshot->>'schema'='real-media.v1' AND j.input_snapshot->'speech'=$7::jsonb
      AND j.input_snapshot#>>'{budget,quoteId}'=$8 AND j.input_snapshot#>>'{budget,authorizationId}'=$9`,
  [input.jobId, input.workflowRunId, workspaceId, batch.project_id, value.input.shotRevisionId, batch.created_by, JSON.stringify(value.input), value.quote.quoteId, operation.authorization_id]);
  if (!job.rows[0]) fail("SPEECH_BATCH_CONFIRMATION_CHANGED", "The created Job does not belong to the exact frozen operation");
  await client.query("UPDATE speech_batch_operation SET state='job_created',job_id=$3,workflow_run_id=$4,dispatch_token=NULL,lease_until=NULL,error_code=NULL,row_version=row_version+1,updated_at=now() WHERE id=$1 AND workspace_id=$2", [ref.operationId, workspaceId, input.jobId, input.workflowRunId]);
  await client.query("UPDATE speech_batch_command SET dispatch_token=NULL,lease_until=NULL,row_version=row_version+1,updated_at=now() WHERE id=$1 AND workspace_id=$2", [ref.batchId, workspaceId]);
}
