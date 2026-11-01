import type { PoolClient, QueryResultRow } from "pg";
import {
  vimaxCandidateCreateSchema, vimaxCandidateTargetSchema, vimaxPlanningFrozenSchema, vimaxPlanningStartSchema, vimaxPlanningViewSchema,
  type VimaxCandidateTarget, type VimaxPlanningCreation, type VimaxPlanningFinish, type VimaxPlanningRecord,
  type VimaxPlanningReservation, type VimaxPlanningStore,
} from "@ai-drama/contracts";
import { freezeVimaxCandidate, freezeVimaxPlanning, hashVimaxPlanningFrozen, hashVimaxPlanningRequest, sameVimaxPlanningOutputInput } from "@ai-drama/domain";
import { PersistenceError, type DatabasePool } from "./job-service";
import { VimaxPreviewSourceStore } from "./vimax-preview-source";
import { recentWritingCalls, runningWritingRuns, writingCallLockKey } from "./writing-candidate-store";

type Row = QueryResultRow & Record<string, unknown>;
export const VIMAX_PLANNING_COLUMNS = ["id", "workspace_id", "project_id", "episode_id", "actor_id", "idempotency_key", "request_hash",
  "frozen_hash", "frozen_json", "source_script_revision_id", "scene_id", "baseline_scene_revision_id", "baseline_scene_row_version",
  "provider_key", "model", "state", "executor_id", "lease_until", "submitted_at", "error_code", "provider_request_id", "response_model",
  "usage_json", "billing_status", "output_json", "created_at", "finished_at"] as const;
const fail = (code: string): never => { throw new PersistenceError(code, "Single-scene planning request was refused"); };
const iso = (value: unknown): string => value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
const unknownUsage = { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null };
const COLUMNS = VIMAX_PLANNING_COLUMNS.join(", ");
/** No application startup migration, network request, revision writer or background resend. */
export class PostgresVimaxPlanningStore implements VimaxPlanningStore {
  private readonly source: VimaxPreviewSourceStore;
  constructor(private readonly pool: DatabasePool) { this.source = new VimaxPreviewSourceStore(pool); }
  private async readyIn(client: PoolClient): Promise<boolean> {
    const result = await client.query<Row>(`SELECT obj_description(to_regclass('vimax_planning_request'), 'pg_class') AS version,
      (SELECT count(*)::int FROM information_schema.columns WHERE table_schema = current_schema()
        AND table_name = 'vimax_planning_request' AND column_name = ANY($1::text[])) AS columns,
      (SELECT count(*)::int FROM pg_trigger WHERE tgrelid = to_regclass('vimax_planning_request')
        AND tgname = 'vimax_planning_request_guard' AND NOT tgisinternal AND tgenabled IN ('O','A')) AS guards`, [[...VIMAX_PLANNING_COLUMNS]]);
    const row = result.rows[0];
    return row?.version === "ads.vimax-planning.storage.v1" && Number(row.columns) === VIMAX_PLANNING_COLUMNS.length && Number(row.guards) === 1;
  }
  async storageReady(): Promise<boolean> { const c = await this.pool.connect(); try { return await this.readyIn(c); } finally { c.release(); } }
  private async transaction<T>(write: boolean, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query(write ? "BEGIN" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try {
        if (!await this.readyIn(c)) fail("VIMAX_PLANNING_STORAGE_UNAVAILABLE");
        const value = await work(c); await c.query(write ? "COMMIT" : "ROLLBACK"); return value;
      } catch (e) { await c.query("ROLLBACK"); throw e; }
    } finally { c.release(); }
  }
  private record(row: Row): VimaxPlanningRecord {
    try {
      if (row.billing_status !== "unknown" || Buffer.byteLength(JSON.stringify(row.frozen_json), "utf8") > 1048576) fail("VIMAX_PLANNING_CORRUPT");
      const input = vimaxPlanningFrozenSchema.parse(row.frozen_json);
      if (hashVimaxPlanningFrozen(input) !== row.frozen_hash || hashVimaxPlanningRequest(String(row.project_id), String(row.episode_id), input.request) !== row.request_hash
        || input.source.projectId !== row.project_id || input.source.episodeId !== row.episode_id || input.source.scriptRevisionId !== row.source_script_revision_id
        || input.target.sceneId !== row.scene_id || input.target.sceneRevisionId !== row.baseline_scene_revision_id
        || input.target.rowVersion !== Number(row.baseline_scene_row_version) || input.providerKey !== row.provider_key || input.model !== row.model) fail("VIMAX_PLANNING_CORRUPT");
      const output = row.output_json === null || row.output_json === undefined ? null : vimaxCandidateCreateSchema.parse(row.output_json);
      if (output && (!sameVimaxPlanningOutputInput(input, output) || !freezeVimaxCandidate(input.source, input.target, output).ok)) fail("VIMAX_PLANNING_CORRUPT");
      const record: VimaxPlanningRecord = { id: String(row.id), workspaceId: String(row.workspace_id), projectId: String(row.project_id), episodeId: String(row.episode_id),
        actorId: String(row.actor_id), idempotencyKey: String(row.idempotency_key), requestHash: String(row.request_hash), frozenHash: String(row.frozen_hash), input,
        state: row.state as VimaxPlanningRecord["state"], executorId: row.executor_id as string | null, leaseUntil: row.lease_until == null ? null : iso(row.lease_until),
        submittedAt: row.submitted_at == null ? null : iso(row.submitted_at), errorCode: row.error_code as string | null,
        providerRequestId: row.provider_request_id as string | null, responseModel: row.response_model as string | null,
        usage: row.usage_json as VimaxPlanningRecord["usage"], output, createdAt: iso(row.created_at), finishedAt: row.finished_at == null ? null : iso(row.finished_at) };
      vimaxPlanningViewSchema.parse({ schema: "ads.vimax-planning.view.v1", requestId: record.id, projectId: record.projectId, episodeId: record.episodeId,
        requestKey: record.idempotencyKey, requestHash: record.requestHash, input, state: record.state, submittedAt: record.submittedAt, errorCode: record.errorCode,
        providerRequestId: record.providerRequestId, responseModel: record.responseModel, usage: record.usage, billing: "unknown", quotaAccounting: "reservation",
        output, createdAt: record.createdAt, finishedAt: record.finishedAt });
      if ((record.state === "reserved" || record.state === "submitted") !== (record.executorId !== null && record.leaseUntil !== null)
        || (record.state === "reserved" && record.submittedAt !== null)
        || (["submitted", "completed", "unknown"].includes(record.state) && record.submittedAt === null)) fail("VIMAX_PLANNING_CORRUPT");
      return record;
    } catch { return fail("VIMAX_PLANNING_CORRUPT"); }
  }
  private async locks(c: PoolClient, workspaceId: string): Promise<void> {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`title_writing_run:${workspaceId}`]);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [writingCallLockKey(workspaceId)]);
  }
  private async scope(c: PoolClient, workspaceId: string, projectId: string, episodeId: string): Promise<void> {
    if (!(await c.query("SELECT id FROM project WHERE id=$1 AND workspace_id=$2 FOR UPDATE", [projectId, workspaceId])).rows[0]) fail("NOT_FOUND");
    if (!(await c.query("SELECT id FROM episode WHERE id=$1 AND project_id=$2 AND workspace_id=$3 FOR UPDATE", [episodeId, projectId, workspaceId])).rows[0]) fail("NOT_FOUND");
  }
  /** The same authoritative source and target conditions as E2-B, within the caller's ordered transaction. */
  private async snapshot(c: PoolClient, r: Pick<VimaxPlanningReservation, "workspaceId" | "projectId" | "episodeId" | "request" | "providerKey" | "model">) {
    const source = await this.source.readInTransaction(c, r.workspaceId, r.projectId, r.episodeId);
    if (source.kind === "not_found") return { ok: false as const, code: "NOT_FOUND" };
    if (source.kind === "series_not_enabled") return { ok: false as const, code: "SERIES_MEDIA_NOT_ENABLED" };
    if (source.kind !== "ok") return { ok: false as const, code: "VIMAX_PLANNING_SOURCE_CHANGED" };
    if ((await c.query("SELECT 1 FROM stale_recalculation WHERE workspace_id=$1 AND project_id=$2 AND status IN ('PENDING','RUNNING') LIMIT 1", [r.workspaceId, r.projectId])).rows[0]) return { ok: false as const, code: "SOURCE_STALE" };
    // Do not lock the run row after taking the project lock: title-writing reservations use run → project.
    if ((await c.query("SELECT 1 FROM title_writing_run WHERE workspace_id=$1 AND project_id=$2 AND episode_id=$3 AND run_kind='script_breakdown' AND state='running' LIMIT 1",
      [r.workspaceId, r.projectId, r.episodeId])).rows[0]) return { ok: false as const, code: "VIMAX_PLANNING_ACTIVE_BREAKDOWN" };
    const target = await c.query<Row>(`SELECT s.id AS scene_id, s.row_version, s.archived_at, r.id AS scene_revision_id, r.source_script_revision_id,
      r.ordinal, r.heading, r.time_of_day, r.summary, r.location_revision_id, r.freshness_status,
      (SELECT count(*)::int FROM shot sh WHERE sh.scene_id=s.id AND sh.project_id=s.project_id AND sh.workspace_id=s.workspace_id AND sh.archived_at IS NULL) AS active_shot_count
      FROM scene s LEFT JOIN scene_revision r ON r.id=s.current_revision_id AND r.scene_id=s.id AND r.project_id=s.project_id AND r.workspace_id=s.workspace_id
      WHERE s.id=$1 AND s.workspace_id=$2 AND s.project_id=$3 AND s.episode_id=$4 FOR UPDATE OF s`, [r.request.target.sceneId, r.workspaceId, r.projectId, r.episodeId]);
    const t = target.rows[0];
    if (!t || t.archived_at !== null || t.freshness_status !== "CURRENT" || !t.scene_revision_id) return { ok: false as const, code: "VIMAX_PLANNING_TARGET_CHANGED" };
    if (Number(t.active_shot_count) > 0) return { ok: false as const, code: "VIMAX_PLANNING_HAS_SHOTS" };
    const value: VimaxCandidateTarget = vimaxCandidateTargetSchema.parse({ sceneId: t.scene_id, sceneRevisionId: t.scene_revision_id,
      rowVersion: Number(t.row_version), sourceScriptRevisionId: t.source_script_revision_id, ordinal: Number(t.ordinal), heading: t.heading,
      timeOfDay: t.time_of_day, summary: t.summary, locationRevisionId: t.location_revision_id });
    return freezeVimaxPlanning(source.source, value, r.request, r.providerKey, r.model);
  }
  async findByKey(workspaceId: string, actorId: string, key: string): Promise<VimaxPlanningRecord | null> {
    return this.transaction(false, async (c) => { const result = await c.query<Row>(`SELECT ${COLUMNS} FROM vimax_planning_request WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3`, [workspaceId, actorId, key]);
      return result.rows[0] ? this.record(result.rows[0]) : null; });
  }
  async create(r: VimaxPlanningReservation, limits: { sinceIso: string; maxCallsPerDay: number; maxActiveRuns: number }): Promise<VimaxPlanningCreation> {
    vimaxPlanningStartSchema.parse(r.request);
    if (hashVimaxPlanningRequest(r.projectId, r.episodeId, r.request) !== r.requestHash) fail("VALIDATION_ERROR");
    return this.transaction(true, async (c) => {
      await this.locks(c, r.workspaceId);
      const existing = await c.query<Row>(`SELECT ${COLUMNS} FROM vimax_planning_request WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3 FOR UPDATE`, [r.workspaceId, r.actorId, r.idempotencyKey]);
      if (existing.rows[0]) { const record = this.record(existing.rows[0]); return record.requestHash === r.requestHash && record.projectId === r.projectId && record.episodeId === r.episodeId ? { kind: "existing", record } : { kind: "conflict" }; }
      if (!Number.isInteger(limits.maxActiveRuns) || limits.maxActiveRuns < 1) fail("VALIDATION_ERROR");
      await this.scope(c, r.workspaceId, r.projectId, r.episodeId);
      const frozen = await this.snapshot(c, r);
      if (!frozen.ok) return { kind: "blocked", code: frozen.code };
      const prior = await c.query<Row>(`SELECT id, state, actor_id FROM vimax_planning_request WHERE workspace_id=$1 AND project_id=$2 AND episode_id=$3 AND scene_id=$4 ORDER BY (state IN ('reserved','submitted')) DESC, created_at DESC, id DESC LIMIT 1`, [r.workspaceId, r.projectId, r.episodeId, r.request.target.sceneId]);
      const open = prior.rows.find((row) => row.state === "reserved" || row.state === "submitted");
      if (open) return { kind: "active", requestId: String(open.id) };
      const latest = prior.rows[0];
      if (latest?.state === "unknown" && (r.request.confirmUncertainRequestId !== String(latest.id) || latest.actor_id !== r.actorId)) return { kind: "needs_confirmation", requestId: String(latest.id) };
      const titles = await c.query<Row>("SELECT id, project_id FROM title_writing_run WHERE workspace_id=$1 AND state='running'", [r.workspaceId]);
      const running = await runningWritingRuns(c, r.workspaceId);
      if (titles.rows.some((row) => String(row.project_id) === r.projectId) || running.some((row) => row.kind !== "vimax" && row.projectId === r.projectId)) {
        return { kind: "blocked", code: "VIMAX_PLANNING_PROJECT_ACTIVE" };
      }
      if (titles.rows.length + running.length >= limits.maxActiveRuns) return { kind: "blocked", code: "VIMAX_PLANNING_ACTIVE_CAP" };
      if (await recentWritingCalls(c, r.workspaceId, limits.sinceIso) >= limits.maxCallsPerDay) return { kind: "blocked", code: "VIMAX_PLANNING_DAILY_CAP" };
      const inserted = await c.query<Row>(`INSERT INTO vimax_planning_request (id,workspace_id,project_id,episode_id,actor_id,idempotency_key,request_hash,frozen_hash,frozen_json,
        source_script_revision_id,scene_id,baseline_scene_revision_id,baseline_scene_row_version,provider_key,model,state,executor_id,lease_until,usage_json,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,'reserved',$16,$17,$18::jsonb,$19) RETURNING ${COLUMNS}`,
      [r.id, r.workspaceId, r.projectId, r.episodeId, r.actorId, r.idempotencyKey, r.requestHash, frozen.frozenHash, JSON.stringify(frozen.input),
        frozen.input.source.scriptRevisionId, frozen.input.target.sceneId, frozen.input.target.sceneRevisionId, frozen.input.target.rowVersion, r.providerKey, r.model,
        r.executorId, r.leaseUntil, JSON.stringify(unknownUsage), r.createdAt]);
      return { kind: "created", record: this.record(inserted.rows[0]!) };
    });
  }
  async get(workspaceId: string, projectId: string, episodeId: string, actorId: string, requestId: string) {
    return this.transaction(false, async (c) => { const r = await c.query<Row>(`SELECT ${COLUMNS} FROM vimax_planning_request WHERE workspace_id=$1 AND project_id=$2 AND episode_id=$3 AND actor_id=$4 AND id=$5`, [workspaceId, projectId, episodeId, actorId, requestId]); return r.rows[0] ? this.record(r.rows[0]) : null; });
  }
  async getById(workspaceId: string, requestId: string) {
    return this.transaction(false, async (c) => { const r = await c.query<Row>(`SELECT ${COLUMNS} FROM vimax_planning_request WHERE workspace_id=$1 AND id=$2`, [workspaceId, requestId]); return r.rows[0] ? this.record(r.rows[0]) : null; });
  }
  async list(workspaceId: string, projectId: string, episodeId: string, actorId: string, limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) fail("VALIDATION_ERROR");
    return this.transaction(false, async (c) => { const r = await c.query<Row>(`SELECT ${COLUMNS} FROM vimax_planning_request WHERE workspace_id=$1 AND project_id=$2 AND episode_id=$3 AND actor_id=$4 ORDER BY created_at DESC,id DESC LIMIT $5`, [workspaceId, projectId, episodeId, actorId, limit]); return r.rows.map((row) => this.record(row)); });
  }
  async markSubmitted(workspaceId: string, requestId: string, executorId: string, nowIso: string, leaseUntil: string) {
    return this.transaction(true, async (c) => {
      await this.locks(c, workspaceId);
      const found = await c.query<Row>(`SELECT ${COLUMNS} FROM vimax_planning_request WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [workspaceId, requestId]);
      if (!found.rows[0]) return false;
      const r = this.record(found.rows[0]);
      if (r.state !== "reserved" || r.executorId !== executorId || !r.leaseUntil || r.leaseUntil <= nowIso) return false;
      await this.scope(c, workspaceId, r.projectId, r.episodeId);
      const frozen = await this.snapshot(c, { ...r, request: r.input.request, providerKey: r.input.providerKey, model: r.input.model });
      if (!frozen.ok || frozen.frozenHash !== r.frozenHash) {
        await c.query(`UPDATE vimax_planning_request SET state='rejected',error_code='source_changed_before_send',executor_id=NULL,lease_until=NULL,finished_at=$4 WHERE workspace_id=$1 AND id=$2 AND executor_id=$3 AND state='reserved'`, [workspaceId, requestId, executorId, nowIso]);
        return false;
      }
      const result = await c.query(`UPDATE vimax_planning_request SET state='submitted',submitted_at=$4,lease_until=$5 WHERE workspace_id=$1 AND id=$2 AND executor_id=$3 AND state='reserved' AND lease_until>$4 AND lease_until>clock_timestamp()`, [workspaceId, requestId, executorId, nowIso, leaseUntil]);
      return result.rowCount === 1;
    });
  }
  async closeUnsent(workspaceId: string, requestId: string, executorId: string, errorCode: string, nowIso: string) {
    if (!["invalid_input_before_send", "provider_unconfigured_before_send"].includes(errorCode)) fail("VALIDATION_ERROR");
    return this.transaction(true, async (c) => (await c.query(`UPDATE vimax_planning_request SET state='rejected',error_code=$4,executor_id=NULL,lease_until=NULL,finished_at=$5 WHERE workspace_id=$1 AND id=$2 AND executor_id=$3 AND state='reserved'`, [workspaceId, requestId, executorId, errorCode, nowIso])).rowCount === 1);
  }
  async finish(workspaceId: string, requestId: string, executorId: string, patch: VimaxPlanningFinish, nowIso: string) {
    return this.transaction(true, async (c) => {
      // No backwards locking: finish only takes this row and cannot create a new reservation.
      const found = await c.query<Row>(`SELECT ${COLUMNS} FROM vimax_planning_request WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [workspaceId, requestId]);
      if (!found.rows[0]) return false;
      const r = this.record(found.rows[0]);
      if (r.state !== "submitted" || r.executorId !== executorId) return false;
      if (patch.state === "completed") {
        if (!patch.output || !sameVimaxPlanningOutputInput(r.input, patch.output) || !freezeVimaxCandidate(r.input.source, r.input.target, patch.output).ok) fail("VALIDATION_ERROR");
      } else if (patch.output !== null) fail("VALIDATION_ERROR");
      const result = await c.query(`UPDATE vimax_planning_request SET state=$4,error_code=$5,provider_request_id=$6,response_model=$7,usage_json=$8::jsonb,
        output_json=$9::jsonb,executor_id=NULL,lease_until=NULL,finished_at=$10 WHERE workspace_id=$1 AND id=$2 AND executor_id=$3 AND state='submitted'`,
      [workspaceId, requestId, executorId, patch.state, patch.errorCode, patch.providerRequestId, patch.responseModel, JSON.stringify(patch.usage), patch.output === null ? null : JSON.stringify(patch.output), nowIso]);
      return result.rowCount === 1;
    });
  }
  async recoverExpired(workspaceId: string, nowIso: string) {
    return this.transaction(true, async (c) => (await c.query(`UPDATE vimax_planning_request SET state=CASE WHEN state='submitted' THEN 'unknown' ELSE 'rejected' END,
      error_code=CASE WHEN state='submitted' THEN 'executor_lost' ELSE 'executor_lost_before_send' END,executor_id=NULL,lease_until=NULL,finished_at=$2
      WHERE workspace_id=$1 AND state IN ('reserved','submitted') AND lease_until<=$2`, [workspaceId, nowIso])).rowCount ?? 0);
  }
  async cancel(workspaceId: string, projectId: string, episodeId: string, actorId: string, requestId: string, nowIso: string) {
    return this.transaction(true, async (c) => {
      await c.query(`UPDATE vimax_planning_request SET state='rejected',error_code='canceled_before_send',executor_id=NULL,lease_until=NULL,finished_at=$6
        WHERE workspace_id=$1 AND project_id=$2 AND episode_id=$3 AND actor_id=$4 AND id=$5 AND state='reserved'`, [workspaceId, projectId, episodeId, actorId, requestId, nowIso]);
      const r = await c.query<Row>(`SELECT ${COLUMNS} FROM vimax_planning_request WHERE workspace_id=$1 AND project_id=$2 AND episode_id=$3 AND actor_id=$4 AND id=$5`, [workspaceId, projectId, episodeId, actorId, requestId]);
      return r.rows[0] ? this.record(r.rows[0]) : null;
    });
  }
}
