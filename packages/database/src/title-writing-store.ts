import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import {
  SCRIPT_BREAKDOWN_INPUT_SCHEMA,
  SCRIPT_BREAKDOWN_STEP_KEY,
  TITLE_WRITING_CANCELED_BEFORE_SEND,
  TITLE_WRITING_RUN_KIND_DISABLED,
  settledSaveOutcome,
  currentUncertainCallIds,
  isScriptBreakdownInput,
  type ScriptBreakdownDetails,
  type ScriptBreakdownFrozenInput,
  type ScriptBreakdownOutput,
  type ScriptBreakdownPlacement,
  type ScriptBreakdownPlacementOutcome,
  type ScriptBreakdownSave,
  type ScriptBreakdownSceneView,
  type ScriptBreakdownSourceRead,
  type TitleRunInput,
  type TitleRunKind,
  titleWritingEpisodeCount,
  titleWritingStepKeysFor,
  type EpisodeDraftCandidate,
  type TitleWritingFrozenInput,
  type TitleWritingProviderKey,
  type TitleWritingRunState,
  type TitleWritingStepKey,
  type TitleCallFinish,
  type TitleCallRecord,
  type TitleCallReservation,
  type TitleCallSubmission,
  type TitleResumePreparation,
  type TitleResumeRequest,
  type TitleRunBundle,
  type TitleRunCreation,
  type TitleRunCreationLimits,
  type TitleRunRecord,
  type TitleScriptPlacement,
  type TitleStepRecord,
  type TitleWritingStore,
} from "@ai-drama/contracts";
import { breakdownDialogueText, breakdownShotPromptText, formatTitleEpisode, shotsOfScene } from "@ai-drama/domain";
import { projectEpisodePlanIn } from "./episode-plan";
import { WRITING_PROVIDER_MIGRATION } from "./migrations";
import { PersistenceError, type DatabasePool } from "./job-service";
import type { TextChainService } from "./text-chain";
import { recentWritingCalls, writingCallLockKey } from "./writing-candidate-store";

/**
 * The migration that creates the title writing tables (prisma/migrations/20261008000100_title_writing). It replaced the
 * draft of the same name in prisma/drafts. Acceptances migrate to just before it to see a database without the tables.
 */
export const TITLE_WRITING_MIGRATION = "20261008000100_title_writing";

/**
 * PostgreSQL storage for title-driven writing runs. The tables come from the migration TITLE_WRITING_MIGRATION; until
 * they exist (a database not yet migrated to it) storageReady() is false and callers refuse before any send. There is
 * no in-memory fallback in the runtime.
 */
export const TITLE_WRITING_TABLES = {
  title_writing_run: [
    "id", "workspace_id", "project_id", "actor_id", "idempotency_key", "input_hash", "input_json", "provider_key", "model",
    "state", "error_code", "cancel_requested_at", "executor_id", "lease_until", "call_cap", "calls_used", "story_save",
    "story_revision_id", "created_at", "updated_at",
  ],
  title_writing_step: [
    "run_id", "workspace_id", "step_key", "ordinal", "state", "attempt_no", "error_code", "output_json", "output_hash",
    "script_save", "script_revision_id", "updated_at",
  ],
  title_writing_call: [
    "id", "run_id", "workspace_id", "step_key", "attempt_no", "provider_key", "model", "request_hash", "state", "executor_id",
    "provider_request_id", "response_model", "usage_json", "billing_status", "error_code", "created_at", "finished_at",
  ],
  title_writing_resume: ["run_id", "workspace_id", "idempotency_key", "request_hash", "confirmed_call_ids", "created_at"],
} as const;

/**
 * The migration that lets a title writing run be a script breakdown run, adds shot_revision.planned_duration_ms and the
 * scene link table (prisma/migrations/20261012000100_script_breakdown). Title writing never needs it.
 */
export const SCRIPT_BREAKDOWN_MIGRATION = "20261012000100_script_breakdown";

/**
 * The migration that lets runs and calls store provider_key 'anthropic' (prisma/migrations/20261016000100_writing_provider_anthropic).
 * OpenAI runs never need it. Until it is recorded and both provider CHECKs allow 'anthropic', a Claude run is refused
 * before anything is written, reserved or sent.
 */
export { WRITING_PROVIDER_MIGRATION };

export const SCRIPT_BREAKDOWN_COLUMNS = {
  title_writing_run: ["run_kind", "episode_id", "source_script_revision_id", "breakdown_save"],
  shot_revision: ["planned_duration_ms"],
  script_breakdown_scene: [
    "run_id", "workspace_id", "project_id", "episode_id", "scene_key", "ordinal", "scene_id", "scene_revision_id", "shot_save",
    "placed_scene_revision_id", "created_at", "updated_at",
  ],
} as const;

/**
 * Run columns. breakdown_save is read through to_jsonb, so every title writing query works the same before the breakdown
 * migration (it is then null, as for every title run).
 */
const RUN_COLUMNS = `${TITLE_WRITING_TABLES.title_writing_run.join(", ")}, (to_jsonb(title_writing_run) ->> 'breakdown_save') AS breakdown_save`;
/** Title runs only: a breakdown run is never a project's latest title run. Works before the breakdown migration. */
const TITLE_RUNS_ONLY = `input_json ->> 'schema' IS DISTINCT FROM '${SCRIPT_BREAKDOWN_INPUT_SCHEMA}'`;
const STEP_COLUMNS = TITLE_WRITING_TABLES.title_writing_step.join(", ");
const CALL_COLUMNS = TITLE_WRITING_TABLES.title_writing_call.join(", ");

type Row = QueryResultRow & Record<string, unknown>;

function iso(value: unknown): string {
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function toRun(row: Row): TitleRunRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    projectId: String(row.project_id),
    actorId: String(row.actor_id),
    idempotencyKey: String(row.idempotency_key),
    inputHash: String(row.input_hash),
    // Written only by createRun after the service validated it.
    input: row.input_json as TitleRunInput,
    state: row.state as TitleWritingRunState,
    errorCode: (row.error_code as string | null) ?? null,
    cancelRequestedAt: isoOrNull(row.cancel_requested_at),
    executorId: (row.executor_id as string | null) ?? null,
    leaseUntil: isoOrNull(row.lease_until),
    callCap: Number(row.call_cap),
    callsUsed: Number(row.calls_used),
    storySave: row.story_save as TitleRunRecord["storySave"],
    storyRevisionId: (row.story_revision_id as string | null) ?? null,
    breakdownSave: (row.breakdown_save ?? null) as ScriptBreakdownSave | null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toStep(row: Row): TitleStepRecord {
  return {
    runId: String(row.run_id),
    stepKey: row.step_key as TitleWritingStepKey,
    ordinal: Number(row.ordinal),
    state: row.state as TitleStepRecord["state"],
    attemptNo: Number(row.attempt_no),
    errorCode: (row.error_code as string | null) ?? null,
    // Written only after the step output passed the shared schema validation.
    output: (row.output_json ?? null) as TitleStepRecord["output"],
    outputHash: (row.output_hash as string | null) ?? null,
    scriptSave: (row.script_save ?? null) as TitleStepRecord["scriptSave"],
    scriptRevisionId: (row.script_revision_id as string | null) ?? null,
    updatedAt: iso(row.updated_at),
  };
}

function toCall(row: Row): TitleCallRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    workspaceId: String(row.workspace_id),
    stepKey: row.step_key as TitleWritingStepKey,
    attemptNo: Number(row.attempt_no),
    providerKey: row.provider_key as TitleCallRecord["providerKey"],
    model: String(row.model),
    requestHash: String(row.request_hash),
    state: row.state as TitleCallRecord["state"],
    executorId: String(row.executor_id),
    providerRequestId: (row.provider_request_id as string | null) ?? null,
    responseModel: (row.response_model as string | null) ?? null,
    usage: row.usage_json as TitleCallRecord["usage"],
    errorCode: (row.error_code as string | null) ?? null,
    createdAt: iso(row.created_at),
    finishedAt: isoOrNull(row.finished_at),
  };
}


export class PostgresTitleWritingStore implements TitleWritingStore {
  // Once applied a migration stays applied, so only a positive answer is remembered.
  private breakdownReadyConfirmed = false;
  private anthropicReadyConfirmed = false;
  private deepseekReadyConfirmed = false;

  constructor(private readonly pool: DatabasePool, private readonly textChain: TextChainService) {}

  /** True only when all four draft tables exist with every column this store reads or writes. */
  async storageReady(): Promise<boolean> {
    try {
      const result = await this.query(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
        [Object.keys(TITLE_WRITING_TABLES)],
      );
      const present = new Set(result.rows.map((row) => `${String(row.table_name)}.${String(row.column_name)}`));
      return Object.entries(TITLE_WRITING_TABLES).every(([table, columns]) => columns.every((column) => present.has(`${table}.${column}`)));
    } catch {
      return false;
    }
  }

  async providerStorageReady(providerKey: TitleWritingProviderKey): Promise<boolean> {
    if (!(await this.storageReady())) return false;
    if (providerKey === "deepseek") return this.deepseekStorageReady();
    if (providerKey !== "anthropic" || this.anthropicReadyConfirmed) return true;
    try {
      const table = await this.query("SELECT to_regclass('schema_migration') IS NOT NULL AS present", []);
      if (table.rows[0]?.present !== true) return false;
      const recorded = await this.query("SELECT 1 FROM schema_migration WHERE name = $1", [WRITING_PROVIDER_MIGRATION]);
      if (!recorded.rows[0]) return false;
      // The ledger alone is not trusted: both live CHECKs must name anthropic.
      const checks = await this.query(
        `SELECT count(*)::int AS allowed FROM pg_constraint
          WHERE conrelid IN (to_regclass('title_writing_run'), to_regclass('title_writing_call')) AND contype = 'c'
            AND pg_get_constraintdef(oid) LIKE '%provider_key%' AND pg_get_constraintdef(oid) LIKE '%''anthropic''%'`,
        [],
      );
      this.anthropicReadyConfirmed = Number(checks.rows[0]?.allowed) === 2;
      return this.anthropicReadyConfirmed;
    } catch {
      return false;
    }
  }

  /**
   * DeepSeek runs need no migration: the provider CHECKs have named deepseek since 20261008000100_title_writing and the
   * Claude migration kept it. The live CHECKs are still read, so a database changed by hand is refused, not written.
   */
  private async deepseekStorageReady(): Promise<boolean> {
    if (this.deepseekReadyConfirmed) return true;
    try {
      const checks = await this.query(
        `SELECT count(*)::int AS allowed FROM pg_constraint
          WHERE conrelid IN (to_regclass('title_writing_run'), to_regclass('title_writing_call')) AND contype = 'c'
            AND pg_get_constraintdef(oid) LIKE '%provider_key%' AND pg_get_constraintdef(oid) LIKE '%''deepseek''%'`,
        [],
      );
      this.deepseekReadyConfirmed = Number(checks.rows[0]?.allowed) === 2;
      return this.deepseekReadyConfirmed;
    } catch {
      return false;
    }
  }

  private async load(client: PoolClient | null, runRow: Row | undefined): Promise<TitleRunBundle | null> {
    if (!runRow) return null;
    const run = toRun(runRow);
    const run1 = client ? client.query.bind(client) : this.query.bind(this);
    const steps = await run1(`SELECT ${STEP_COLUMNS} FROM title_writing_step WHERE run_id = $1 ORDER BY ordinal`, [run.id]) as QueryResult<Row>;
    const calls = await run1(`SELECT ${CALL_COLUMNS} FROM title_writing_call WHERE run_id = $1 ORDER BY created_at, attempt_no`, [run.id]) as QueryResult<Row>;
    return { run, steps: steps.rows.map(toStep), calls: calls.rows.map(toCall) };
  }

  async createRun(run: TitleRunRecord, limits: TitleRunCreationLimits): Promise<TitleRunCreation> {
    return this.transaction(async (client) => {
      // Serializes starts of one workspace: key lookup, active checks and insert are atomic.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`title_writing_run:${run.workspaceId}`]);
      const existing = await client.query<Row>(
        `SELECT ${RUN_COLUMNS} FROM title_writing_run WHERE workspace_id = $1 AND actor_id = $2 AND idempotency_key = $3`,
        [run.workspaceId, run.actorId, run.idempotencyKey],
      );
      const found = existing.rows[0];
      if (found) {
        const bundle = (await this.load(client, found))!;
        return { kind: String(found.input_hash) === run.inputHash ? "existing" : "conflict", bundle };
      }
      const active = await client.query<Row>(
        `SELECT ${RUN_COLUMNS} FROM title_writing_run WHERE workspace_id = $1 AND state = 'running' ORDER BY created_at`,
        [run.workspaceId],
      );
      const sameProject = active.rows.find((row) => String(row.project_id) === run.projectId);
      if (sameProject) return { kind: "active", bundle: (await this.load(client, sameProject))! };
      // Running automatic creation runs share the concurrency cap, and a work one of them is writing takes no other run.
      const autoTable = await client.query<Row>("SELECT to_regclass('auto_creation_run') IS NOT NULL AS present");
      const autoRunning = autoTable.rows[0]?.present === true
        ? (await client.query<Row>("SELECT project_id FROM auto_creation_run WHERE workspace_id = $1 AND state = 'running'", [run.workspaceId])).rows
        : [];
      if (autoRunning.some((row) => String(row.project_id) === run.projectId)
        || active.rows.length + autoRunning.length >= limits.maxActiveRuns) return { kind: "blocked", code: "TITLE_WRITING_ACTIVE_RUN_CAP" };
      if (limits.quota) {
        // A start check only, after the key lookup so a replay is never refused by it. It reads the rolling 24-hour
        // count without the call lock (lock order stays run lock -> run row, as before) and reserves nothing: each
        // send still reserves its call atomically in reserveCall.
        const { sinceIso, maxCallsPerDay, requiredCalls } = limits.quota;
        // Online candidates share the daily cap with title writing calls.
        const remainingCalls = Math.max(0, maxCallsPerDay - await recentWritingCalls(client, run.workspaceId, sinceIso));
        if (remainingCalls < requiredCalls) return { kind: "blocked", code: "TITLE_WRITING_DAILY_QUOTA_LOW", requiredCalls, remainingCalls };
      }
      const breakdown = isScriptBreakdownInput(run.input) ? run.input : null;
      const inserted = breakdown
        ? await client.query<Row>(
          `INSERT INTO title_writing_run (id, workspace_id, project_id, actor_id, idempotency_key, input_hash, input_json, provider_key,
             model, state, call_cap, calls_used, story_save, created_at, updated_at, run_kind, episode_id, source_script_revision_id,
             breakdown_save)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 'running', $10, 0, 'pending', $11, $11, 'script_breakdown', $12, $13,
             'pending')
           RETURNING ${RUN_COLUMNS}`,
          [run.id, run.workspaceId, run.projectId, run.actorId, run.idempotencyKey, run.inputHash, JSON.stringify(run.input),
            run.input.providerKey, run.input.model, run.callCap, run.createdAt, breakdown.episodeId, breakdown.scriptRevisionId],
        )
        : await client.query<Row>(
          `INSERT INTO title_writing_run (id, workspace_id, project_id, actor_id, idempotency_key, input_hash, input_json, provider_key,
             model, state, call_cap, calls_used, story_save, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 'running', $10, 0, 'pending', $11, $11)
           RETURNING ${RUN_COLUMNS}`,
          [run.id, run.workspaceId, run.projectId, run.actorId, run.idempotencyKey, run.inputHash, JSON.stringify(run.input),
            run.input.providerKey, run.input.model, run.callCap, run.createdAt],
        );
      // The run's own steps: the original five for v1, concept, outline and episode:1..N for v2, the single breakdown
      // step for a script breakdown.
      const stepKeys: TitleWritingStepKey[] = breakdown ? [SCRIPT_BREAKDOWN_STEP_KEY] : titleWritingStepKeysFor(run.input as TitleWritingFrozenInput);
      for (const [ordinal, stepKey] of stepKeys.entries()) {
        await client.query(
          `INSERT INTO title_writing_step (run_id, workspace_id, step_key, ordinal, state, attempt_no, script_save, updated_at)
           VALUES ($1, $2, $3, $4, 'pending', 0, $5, $6)`,
          [run.id, run.workspaceId, stepKey, ordinal, stepKey.startsWith("episode:") ? "pending" : null, run.createdAt],
        );
      }
      return { kind: "created", bundle: (await this.load(client, inserted.rows[0]))! };
    });
  }

  async getRun(workspaceId: string, projectId: string, runId: string): Promise<TitleRunBundle | null> {
    const result = await this.query(
      `SELECT ${RUN_COLUMNS} FROM title_writing_run WHERE id = $1 AND workspace_id = $2 AND project_id = $3`,
      [runId, workspaceId, projectId],
    );
    return this.load(null, result.rows[0] as Row | undefined);
  }

  async getRunById(workspaceId: string, runId: string): Promise<TitleRunBundle | null> {
    const result = await this.query(`SELECT ${RUN_COLUMNS} FROM title_writing_run WHERE id = $1 AND workspace_id = $2`, [runId, workspaceId]);
    return this.load(null, result.rows[0] as Row | undefined);
  }

  async latestRun(workspaceId: string, projectId: string): Promise<TitleRunBundle | null> {
    const result = await this.query(
      `SELECT ${RUN_COLUMNS} FROM title_writing_run WHERE workspace_id = $1 AND project_id = $2 AND ${TITLE_RUNS_ONLY}
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [workspaceId, projectId],
    );
    return this.load(null, result.rows[0] as Row | undefined);
  }

  async claimRun(workspaceId: string, runId: string, executorId: string, nowIso: string, leaseUntil: string): Promise<boolean> {
    const result = await this.query(
      `UPDATE title_writing_run r SET executor_id = $2, lease_until = $4, updated_at = $3
        WHERE r.id = $1 AND r.workspace_id = $5 AND r.state = 'running'
          AND (r.executor_id IS NULL OR r.executor_id = $2 OR r.lease_until <= $3)
          AND (r.executor_id = $2 OR NOT EXISTS (
            SELECT 1 FROM title_writing_call c WHERE c.run_id = r.id AND c.state IN ('reserved', 'submitted')))`,
      [runId, executorId, nowIso, leaseUntil, workspaceId],
    );
    return result.rowCount === 1;
  }

  /** Locks the run row and returns it only when it belongs to this workspace and this executor holds a live lease. */
  private async ownedRun(client: PoolClient, workspaceId: string, runId: string, executorId: string, nowIso: string): Promise<TitleRunRecord | null> {
    const result = await client.query<Row>(
      `SELECT ${RUN_COLUMNS} FROM title_writing_run WHERE id = $1 AND workspace_id = $2 FOR UPDATE`, [runId, workspaceId]);
    const row = result.rows[0];
    if (!row) return null;
    const run = toRun(row);
    if (run.state !== "running" || run.executorId !== executorId || run.leaseUntil === null || run.leaseUntil <= nowIso) return null;
    return run;
  }

  async reserveCall(call: TitleCallRecord, limits: { sinceIso: string; maxCallsPerDay: number }, nowIso: string, leaseUntil: string): Promise<TitleCallReservation> {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [writingCallLockKey(call.workspaceId)]);
      const run = await this.ownedRun(client, call.workspaceId, call.runId, call.executorId, nowIso);
      if (!run) return { kind: "lost" };
      if (run.cancelRequestedAt !== null) return { kind: "canceled" };
      // Refuse a known source/save conflict before reserving a paid call. The project lock protects the script and
      // replacement scene/shot snapshot together, in the existing run -> project -> episode lock order.
      if (isScriptBreakdownInput(run.input)) {
        if (!await this.breakdownScriptCurrent(client, call.workspaceId, run.projectId, run.input)) return { kind: "source_changed" };
        if (!await this.breakdownSceneSetCurrent(client, call.workspaceId, run.projectId, run.input)) return { kind: "conflict" };
      }
      if (run.callsUsed >= run.callCap) return { kind: "blocked", code: "TITLE_WRITING_RUN_CAP" };
      // One rolling cap for every paid text call of the workspace: title writing calls and online candidates.
      if (await recentWritingCalls(client, call.workspaceId, limits.sinceIso) >= limits.maxCallsPerDay) return { kind: "blocked", code: "TITLE_WRITING_DAILY_CAP" };
      const step = await client.query(
        `UPDATE title_writing_step SET state = 'reserved', attempt_no = $3, error_code = NULL, updated_at = $4
          WHERE run_id = $1 AND step_key = $2 AND state = 'pending'`,
        [call.runId, call.stepKey, call.attemptNo, nowIso],
      );
      if (step.rowCount !== 1) return { kind: "lost" };
      await client.query(
        `INSERT INTO title_writing_call (id, run_id, workspace_id, step_key, attempt_no, provider_key, model, request_hash, state,
           executor_id, usage_json, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'reserved', $9, $10::jsonb, $11)`,
        [call.id, call.runId, call.workspaceId, call.stepKey, call.attemptNo, call.providerKey, call.model, call.requestHash,
          call.executorId, JSON.stringify(call.usage), call.createdAt],
      );
      await client.query(
        "UPDATE title_writing_run SET calls_used = calls_used + 1, lease_until = $2, updated_at = $3 WHERE id = $1",
        [call.runId, leaseUntil, nowIso],
      );
      return { kind: "reserved" };
    });
  }

  async markCallSubmitted(workspaceId: string, callId: string, executorId: string, nowIso: string, leaseUntil: string): Promise<TitleCallSubmission> {
    return this.transaction(async (client) => {
      const callRow = await client.query<Row>("SELECT run_id, step_key FROM title_writing_call WHERE id = $1 AND workspace_id = $2",
        [callId, workspaceId]);
      const found = callRow.rows[0];
      if (!found) return "lost";
      // The run row lock orders this against requestCancel: whichever commits first decides whether the call is sent.
      const run = await this.ownedRun(client, workspaceId, String(found.run_id), executorId, nowIso);
      if (!run) return "lost";
      if (run.cancelRequestedAt !== null) {
        const closed = await client.query(
          `UPDATE title_writing_call SET state = 'rejected', error_code = $3, finished_at = $4
            WHERE id = $1 AND executor_id = $2 AND state = 'reserved'`,
          [callId, executorId, TITLE_WRITING_CANCELED_BEFORE_SEND, nowIso],
        );
        if (closed.rowCount !== 1) return "lost";
        await client.query(
          "UPDATE title_writing_step SET state = 'canceled', error_code = NULL, updated_at = $3 WHERE run_id = $1 AND step_key = $2",
          [run.id, found.step_key, nowIso]);
        await client.query("UPDATE title_writing_run SET updated_at = $2 WHERE id = $1", [run.id, nowIso]);
        return "canceled";
      }
      const updated = await client.query(
        "UPDATE title_writing_call SET state = 'submitted' WHERE id = $1 AND executor_id = $2 AND state = 'reserved'",
        [callId, executorId],
      );
      if (updated.rowCount !== 1) return "lost";
      await client.query("UPDATE title_writing_step SET state = 'submitted', updated_at = $3 WHERE run_id = $1 AND step_key = $2",
        [run.id, found.step_key, nowIso]);
      await client.query("UPDATE title_writing_run SET lease_until = $2, updated_at = $3 WHERE id = $1", [run.id, leaseUntil, nowIso]);
      return "submitted";
    });
  }

  async finishCall(workspaceId: string, callId: string, executorId: string, patch: TitleCallFinish, nowIso: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const callRow = await client.query<Row>("SELECT run_id, step_key FROM title_writing_call WHERE id = $1 AND workspace_id = $2",
        [callId, workspaceId]);
      const found = callRow.rows[0];
      if (!found) return false;
      // The run lock orders this finish against recovery; an expired-but-unrecovered lease may still finish.
      const runRow = await client.query<Row>("SELECT executor_id FROM title_writing_run WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
        [found.run_id, workspaceId]);
      if (runRow.rows[0]?.executor_id !== executorId) return false;
      const updated = await client.query(
        `UPDATE title_writing_call SET state = $3, error_code = $4, provider_request_id = $5, response_model = $6,
           usage_json = $7::jsonb, finished_at = $8
          WHERE id = $1 AND executor_id = $2 AND state = 'submitted'`,
        [callId, executorId, patch.state, patch.errorCode, patch.providerRequestId, patch.responseModel, JSON.stringify(patch.usage), nowIso],
      );
      if (updated.rowCount !== 1) return false;
      await client.query(
        `UPDATE title_writing_step SET state = $3, error_code = $4, output_json = $5::jsonb, output_hash = $6, updated_at = $7
          WHERE run_id = $1 AND step_key = $2`,
        [found.run_id, found.step_key, patch.state, patch.errorCode, patch.output === null ? null : JSON.stringify(patch.output),
          patch.outputHash, nowIso],
      );
      await client.query("UPDATE title_writing_run SET updated_at = $2 WHERE id = $1", [found.run_id, nowIso]);
      return true;
    });
  }

  async saveStory(workspaceId: string, runId: string, executorId: string, storyText: string, actorId: string, nowIso: string): Promise<"saved" | "conflict" | "lost"> {
    return this.transaction(async (client) => {
      const run = await this.ownedRun(client, workspaceId, runId, executorId, nowIso);
      if (!run) return "lost";
      if (run.storySave === "saved") return "saved";
      const project = await client.query<Row>(
        "SELECT version, current_story_revision_id FROM project WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
        [run.projectId, run.workspaceId],
      );
      const projectRow = project.rows[0];
      if (!projectRow || projectRow.current_story_revision_id !== null) {
        await client.query("UPDATE title_writing_run SET story_save = 'conflict', updated_at = $2 WHERE id = $1", [runId, nowIso]);
        return "conflict";
      }
      // The same path as the story editor's save: a DRAFT revision under the project version, never reviewed here.
      const created = await this.textChain.createStoryRevisionInTransaction(client, {
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        content: { text: storyText },
        createdBy: actorId,
        expectedVersion: Number(projectRow.version),
        traceId: `title-writing:${runId}`,
      });
      await client.query(
        "UPDATE title_writing_run SET story_save = 'saved', story_revision_id = $2, updated_at = $3 WHERE id = $1",
        [runId, created.revisionId, nowIso],
      );
      await client.query(
        `UPDATE title_writing_step SET script_save = 'awaiting_story_approval', updated_at = $2
          WHERE run_id = $1 AND script_save = 'pending'`,
        [runId, nowIso],
      );
      return "saved";
    });
  }

  async finishRun(workspaceId: string, runId: string, executorId: string, state: Exclude<TitleWritingRunState, "running">, errorCode: string | null, nowIso: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const updated = await client.query(
        `UPDATE title_writing_run SET state = $3, error_code = $4, executor_id = NULL, lease_until = NULL, updated_at = $5
          WHERE id = $1 AND workspace_id = $6 AND state = 'running' AND executor_id = $2`,
        [runId, executorId, state, errorCode, nowIso, workspaceId],
      );
      if (updated.rowCount !== 1) return false;
      if (state === "canceled") {
        await client.query("UPDATE title_writing_step SET state = 'canceled', updated_at = $2 WHERE run_id = $1 AND state = 'pending'",
          [runId, nowIso]);
      }
      return true;
    });
  }

  async requestCancel(workspaceId: string, projectId: string, runId: string, nowIso: string): Promise<TitleRunBundle | null> {
    await this.query(
      `UPDATE title_writing_run SET cancel_requested_at = $4, updated_at = $4
        WHERE id = $1 AND workspace_id = $2 AND project_id = $3 AND state = 'running' AND cancel_requested_at IS NULL`,
      [runId, workspaceId, projectId, nowIso],
    );
    return this.getRun(workspaceId, projectId, runId);
  }

  async prepareResume(workspaceId: string, projectId: string, runId: string, request: TitleResumeRequest, nowIso: string): Promise<TitleResumePreparation> {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`title_writing_run:${workspaceId}`]);
      const result = await client.query<Row>(
        `SELECT ${RUN_COLUMNS} FROM title_writing_run WHERE id = $1 AND workspace_id = $2 AND project_id = $3 FOR UPDATE`,
        [runId, workspaceId, projectId],
      );
      const row = result.rows[0];
      if (!row) return { kind: "not_found" };
      const run = toRun(row);
      // The run row lock serializes concurrent requests of one resume action; the primary key is the backstop.
      const previous = await client.query<Row>(
        "SELECT request_hash FROM title_writing_resume WHERE run_id = $1 AND idempotency_key = $2", [runId, request.resumeKey]);
      if (previous.rows[0]) {
        return String(previous.rows[0].request_hash) === request.requestHash
          ? { kind: "replayed", bundle: (await this.load(client, row))! }
          : { kind: "key_conflict" };
      }
      if (run.state === "running") return { kind: "active" };
      if (run.state === "completed") return { kind: "not_resumable" };
      const running = await client.query<Row>(
        "SELECT project_id FROM title_writing_run WHERE workspace_id = $1 AND state = 'running'", [workspaceId]);
      if (running.rows.some((item) => String(item.project_id) === projectId)) return { kind: "active" };
      // Running automatic creation runs share the cap, and a work one of them is writing takes no other run.
      const autoTable = await client.query<Row>("SELECT to_regclass('auto_creation_run') IS NOT NULL AS present");
      const autoRunning = autoTable.rows[0]?.present === true
        ? (await client.query<Row>("SELECT project_id FROM auto_creation_run WHERE workspace_id = $1 AND state = 'running'", [workspaceId])).rows
        : [];
      if (autoRunning.some((item) => String(item.project_id) === projectId)) return { kind: "active" };
      if (running.rows.length + autoRunning.length >= request.maxActiveRuns) return { kind: "active_cap" };
      const steps = (await client.query<Row>(`SELECT ${STEP_COLUMNS} FROM title_writing_step WHERE run_id = $1`, [runId])).rows.map(toStep);
      const calls = (await client.query<Row>("SELECT id, step_key, attempt_no, state FROM title_writing_call WHERE run_id = $1", [runId])).rows
        .map((item) => ({ callId: String(item.id), stepKey: item.step_key as TitleWritingStepKey, attemptNo: Number(item.attempt_no),
          state: item.state as TitleCallRecord["state"] }));
      const uncertain = currentUncertainCallIds(steps, calls);
      const confirmed = [...request.confirmedCallIds].sort();
      if (uncertain.length > 0 && confirmed.length === 0) return { kind: "needs_confirmation" };
      if (uncertain.length !== confirmed.length || uncertain.some((id, index) => id !== confirmed[index])) {
        return { kind: "stale_confirmation" };
      }
      const redo = steps.filter((step) => step.state === "unknown" || step.state === "rejected" || step.state === "canceled");
      const savePending = isScriptBreakdownInput(run.input) ? run.breakdownSave === "pending" : run.storySave === "pending";
      if (redo.length === 0 && !savePending) return { kind: "not_resumable" };
      // A resume sends a call when it resets a step or a step was never reserved (pending, e.g. a quota race); only saving
      // a stored answer needs no provider.
      const sends = redo.length > 0 || steps.some((step) => step.state === "pending");
      if (sends && request.providerReady === false) return { kind: "provider_unconfigured" };
      // A known conflict cannot be repaired by resending the frozen prompt or saving a stored answer. Check under
      // run -> project -> episode locks before writing a receipt; already accepted receipts replay above these gates.
      if (isScriptBreakdownInput(run.input)) {
        if (!await this.breakdownScriptCurrent(client, workspaceId, projectId, run.input)) return { kind: "source_changed" };
        if (!await this.breakdownSceneSetCurrent(client, workspaceId, projectId, run.input)) return { kind: "conflict" };
      }
      await client.query(
        `INSERT INTO title_writing_resume (run_id, workspace_id, idempotency_key, request_hash, confirmed_call_ids, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [runId, workspaceId, request.resumeKey, request.requestHash, JSON.stringify(confirmed), nowIso],
      );
      await client.query(
        `UPDATE title_writing_step SET state = 'pending', updated_at = $2
          WHERE run_id = $1 AND state IN ('unknown', 'rejected', 'canceled')`,
        [runId, nowIso],
      );
      const updated = await client.query<Row>(
        `UPDATE title_writing_run SET state = 'running', error_code = NULL, cancel_requested_at = NULL, executor_id = NULL,
           lease_until = NULL, updated_at = $2 WHERE id = $1 RETURNING ${RUN_COLUMNS}`,
        [runId, nowIso],
      );
      return { kind: "ok", bundle: (await this.load(client, updated.rows[0]))! };
    });
  }

  async findResume(workspaceId: string, projectId: string, runId: string, resumeKey: string): Promise<{ requestHash: string } | null> {
    const result = await this.query(
      `SELECT resume.request_hash FROM title_writing_resume resume
         JOIN title_writing_run run ON run.id = resume.run_id AND run.workspace_id = resume.workspace_id
        WHERE resume.run_id = $1 AND resume.idempotency_key = $2 AND run.workspace_id = $3 AND run.project_id = $4`,
      [runId, resumeKey, workspaceId, projectId],
    );
    const row = result.rows[0];
    return row ? { requestHash: String(row.request_hash) } : null;
  }

  async recoverExpired(workspaceId: string, nowIso: string): Promise<number> {
    return this.transaction(async (client) => {
      const expired = await client.query<Row>(
        `SELECT id FROM title_writing_run
          WHERE workspace_id = $2 AND state = 'running' AND executor_id IS NOT NULL AND lease_until <= $1
          ORDER BY lease_until LIMIT 50 FOR UPDATE SKIP LOCKED`,
        [nowIso, workspaceId],
      );
      for (const row of expired.rows) {
        const runId = String(row.id);
        const neverSent = await client.query<Row>(
          `UPDATE title_writing_call SET state = 'rejected', error_code = 'executor_lost_before_send', finished_at = $2
            WHERE run_id = $1 AND state = 'reserved' RETURNING step_key`,
          [runId, nowIso],
        );
        for (const call of neverSent.rows) {
          await client.query("UPDATE title_writing_step SET state = 'pending', updated_at = $3 WHERE run_id = $1 AND step_key = $2",
            [runId, call.step_key, nowIso]);
        }
        const maybeSent = await client.query<Row>(
          `UPDATE title_writing_call SET state = 'unknown', error_code = 'executor_lost', finished_at = $2
            WHERE run_id = $1 AND state = 'submitted' RETURNING step_key`,
          [runId, nowIso],
        );
        for (const call of maybeSent.rows) {
          await client.query(
            `UPDATE title_writing_step SET state = 'unknown', error_code = 'executor_lost', updated_at = $3
              WHERE run_id = $1 AND step_key = $2`,
            [runId, call.step_key, nowIso],
          );
        }
        await client.query(
          maybeSent.rows.length > 0
            ? `UPDATE title_writing_run SET state = 'needs_attention', error_code = 'executor_lost', executor_id = NULL,
                 lease_until = NULL, updated_at = $2 WHERE id = $1`
            : "UPDATE title_writing_run SET executor_id = NULL, lease_until = NULL, updated_at = $2 WHERE id = $1",
          [runId, nowIso],
        );
      }
      return expired.rows.length;
    });
  }

  async retireDisabledRuns(workspaceId: string, nowIso: string, disabledKinds: readonly TitleRunKind[]): Promise<number> {
    if (disabledKinds.length === 0) return 0;
    return this.transaction(async (client) => {
      // Unheld runs only: a live lease is left to its executor. The kind comes from the frozen schema, never from the
      // optional run_kind column, so this works on the migration chain before the breakdown migration.
      const unheld = await client.query<Row>(
        `SELECT id, cancel_requested_at, story_save, input_json ->> 'schema' = $4 AS breakdown,
                (to_jsonb(title_writing_run) ->> 'breakdown_save') AS breakdown_save
           FROM title_writing_run
          WHERE workspace_id = $2 AND state = 'running' AND (executor_id IS NULL OR lease_until <= $1)
            AND (CASE WHEN input_json ->> 'schema' = $4 THEN 'script_breakdown' ELSE 'title' END) = ANY($3::text[])
          ORDER BY updated_at LIMIT 50 FOR UPDATE SKIP LOCKED`,
        [nowIso, workspaceId, disabledKinds, SCRIPT_BREAKDOWN_INPUT_SCHEMA],
      );
      for (const row of unheld.rows) {
        const runId = String(row.id);
        const neverSent = await client.query<Row>(
          `UPDATE title_writing_call SET state = 'rejected', error_code = 'executor_lost_before_send', finished_at = $2
            WHERE run_id = $1 AND state = 'reserved' RETURNING step_key`,
          [runId, nowIso],
        );
        for (const call of neverSent.rows) {
          await client.query("UPDATE title_writing_step SET state = 'pending', updated_at = $3 WHERE run_id = $1 AND step_key = $2",
            [runId, call.step_key, nowIso]);
        }
        const maybeSent = await client.query<Row>(
          `UPDATE title_writing_call SET state = 'unknown', error_code = 'executor_lost', finished_at = $2
            WHERE run_id = $1 AND state = 'submitted' RETURNING step_key`,
          [runId, nowIso],
        );
        for (const call of maybeSent.rows) {
          await client.query(
            `UPDATE title_writing_step SET state = 'unknown', error_code = 'executor_lost', updated_at = $3
              WHERE run_id = $1 AND step_key = $2`,
            [runId, call.step_key, nowIso],
          );
        }
        let state: Exclude<TitleWritingRunState, "running"> = "needs_attention";
        let errorCode: string | null = TITLE_WRITING_RUN_KIND_DISABLED;
        if (maybeSent.rows.length > 0) {
          errorCode = "executor_lost";
        } else if (row.cancel_requested_at !== null) {
          state = "canceled";
          errorCode = null;
          await client.query("UPDATE title_writing_step SET state = 'canceled', updated_at = $2 WHERE run_id = $1 AND state = 'pending'",
            [runId, nowIso]);
        } else {
          const open = await client.query<Row>(
            "SELECT count(*)::int AS open FROM title_writing_step WHERE run_id = $1 AND state <> 'completed'", [runId]);
          const settled = Number(open.rows[0]?.open ?? 1) === 0
            ? settledSaveOutcome(row.breakdown === true, row.breakdown === true ? row.breakdown_save : row.story_save)
            : null;
          if (settled) {
            // The executor settled the save and stopped before finishing the run: end it as the engine would, nothing is
            // sent or saved again.
            ({ state, errorCode } = settled);
          } else {
            const unknown = await client.query<Row>(
              "SELECT error_code FROM title_writing_step WHERE run_id = $1 AND state = 'unknown' ORDER BY ordinal LIMIT 1", [runId]);
            const found = unknown.rows[0];
            if (found) errorCode = found.error_code === null ? "uncertain_call" : String(found.error_code);
          }
        }
        await client.query(
          `UPDATE title_writing_run SET state = $2, error_code = $3, executor_id = NULL, lease_until = NULL, updated_at = $4
            WHERE id = $1`,
          [runId, state, errorCode, nowIso],
        );
      }
      return unheld.rows.length;
    });
  }

  async listClaimable(workspaceId: string, nowIso: string, limit: number, allowedRunKinds?: readonly TitleRunKind[]): Promise<string[]> {
    const result = await this.query(
      `SELECT id FROM title_writing_run
        WHERE workspace_id = $3 AND state = 'running' AND (executor_id IS NULL OR lease_until <= $1)
          AND (CASE WHEN input_json ->> 'schema' = $5 THEN 'script_breakdown' ELSE 'title' END) = ANY($4::text[])
        ORDER BY updated_at LIMIT $2`,
      // The frozen schema exists before the breakdown migration; never depend on its optional run_kind column here.
      [nowIso, limit, workspaceId, allowedRunKinds ?? ["title", "script_breakdown"], SCRIPT_BREAKDOWN_INPUT_SCHEMA],
    );
    return result.rows.map((row) => String(row.id));
  }

  async placeScripts(workspaceId: string, projectId: string, runId: string, options: { acceptStoryChanged: boolean }, actorId: string, nowIso: string): Promise<TitleScriptPlacement> {
    return this.transaction(async (client) => {
      const runResult = await client.query<Row>(
        `SELECT ${RUN_COLUMNS} FROM title_writing_run WHERE id = $1 AND workspace_id = $2 AND project_id = $3 FOR UPDATE`,
        [runId, workspaceId, projectId],
      );
      const runRow = runResult.rows[0];
      if (!runRow) return { kind: "not_found" };
      const run = toRun(runRow);
      if (isScriptBreakdownInput(run.input)) return { kind: "not_found" };
      const steps = (await client.query<Row>(
        `SELECT ${STEP_COLUMNS} FROM title_writing_step WHERE run_id = $1 AND script_save IS NOT NULL ORDER BY ordinal`, [runId],
      )).rows.map(toStep);
      if (run.state === "running" || steps.every((step) => step.state !== "completed")) return { kind: "not_ready" };
      // Lock order is project -> episode, the same as the script editor's save (lockAggregateForRevision), so this
      // import and a person's save on the same episode cannot deadlock. The project lock is taken before any episode
      // lock and the story is re-checked under it; story review and story saves also take this lock.
      const locked = await client.query("SELECT id FROM project WHERE id = $1 AND workspace_id = $2 FOR UPDATE", [projectId, workspaceId]);
      if (!locked.rows[0]) return { kind: "not_found" };
      const project = await client.query<Row>(
        `SELECT p.current_story_revision_id, p.approved_story_revision_id, sr.review_status, sr.freshness_status
           FROM project p LEFT JOIN story_revision sr ON sr.id = p.approved_story_revision_id
          WHERE p.id = $1 AND p.workspace_id = $2`,
        [projectId, workspaceId],
      );
      const projectRow = project.rows[0];
      const approved = projectRow?.approved_story_revision_id as string | null | undefined;
      if (!approved || projectRow?.current_story_revision_id !== approved || projectRow.review_status !== "APPROVED"
          || projectRow.freshness_status !== "CURRENT") {
        return { kind: "story_not_approved" };
      }
      if (approved !== run.storyRevisionId && !options.acceptStoryChanged) return { kind: "story_changed" };
      const episodes = await client.query<Row>(
        `SELECT id, episode_no, row_version, current_script_revision_id FROM episode
          WHERE project_id = $1 AND workspace_id = $2 ORDER BY episode_no FOR UPDATE`,
        [projectId, workspaceId],
      );
      // The project's plan and its episodes must be exactly this run's 1..N, or nothing is written.
      const count = titleWritingEpisodeCount(run.input as TitleWritingFrozenInput);
      const plan = await projectEpisodePlanIn(client, workspaceId, projectId);
      const numbers = episodes.rows.map((row) => Number(row.episode_no));
      if (plan.episodeCount !== count || numbers.length !== count || numbers.some((episodeNo, index) => episodeNo !== index + 1)) {
        return { kind: "plan_mismatch" };
      }
      for (const episode of episodes.rows) {
        const stepKey = `episode:${String(episode.episode_no)}` as TitleWritingStepKey;
        const step = steps.find((item) => item.stepKey === stepKey);
        if (!step || step.state !== "completed" || step.scriptSave === "saved" || !step.output) continue;
        if (episode.current_script_revision_id !== null) {
          await client.query("UPDATE title_writing_step SET script_save = 'conflict', updated_at = $3 WHERE run_id = $1 AND step_key = $2",
            [runId, stepKey, nowIso]);
          continue;
        }
        // The same path as the script editor's save: a DRAFT script revision from the approved story. The helper
        // re-checks, under the same locks, that the story is still the current, approved and CURRENT one.
        const created = await this.textChain.createScriptRevisionInTransaction(client, {
          workspaceId,
          projectId,
          episodeId: String(episode.id),
          sourceStoryRevisionId: approved,
          content: { text: formatTitleEpisode(step.output as EpisodeDraftCandidate, run.input as TitleWritingFrozenInput) },
          createdBy: actorId,
          expectedVersion: Number(episode.row_version),
          traceId: `title-writing:${runId}`,
        });
        await client.query(
          `UPDATE title_writing_step SET script_save = 'saved', script_revision_id = $3, updated_at = $4
            WHERE run_id = $1 AND step_key = $2`,
          [runId, stepKey, created.revisionId, nowIso],
        );
      }
      await client.query("UPDATE title_writing_run SET updated_at = $2 WHERE id = $1", [runId, nowIso]);
      return { kind: "ok", bundle: (await this.load(client, runRow))! };
    });
  }

  // --- Script breakdown (migration SCRIPT_BREAKDOWN_MIGRATION) ---

  /** True only when the breakdown migration is recorded and every column and table it adds exists. */
  async breakdownStorageReady(): Promise<boolean> {
    if (this.breakdownReadyConfirmed) return true;
    try {
      const table = await this.query("SELECT to_regclass('schema_migration') IS NOT NULL AS present", []);
      if (table.rows[0]?.present !== true) return false;
      const recorded = await this.query("SELECT 1 FROM schema_migration WHERE name = $1", [SCRIPT_BREAKDOWN_MIGRATION]);
      if (!recorded.rows[0]) return false;
      const result = await this.query(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
        [Object.keys(SCRIPT_BREAKDOWN_COLUMNS)],
      );
      const present = new Set(result.rows.map((row) => `${String(row.table_name)}.${String(row.column_name)}`));
      this.breakdownReadyConfirmed = (await this.storageReady()) && Object.entries(SCRIPT_BREAKDOWN_COLUMNS)
        .every(([name, columns]) => columns.every((column) => present.has(`${name}.${column}`)));
      return this.breakdownReadyConfirmed;
    } catch {
      return false;
    }
  }

  async findRunByKey(workspaceId: string, actorId: string, idempotencyKey: string): Promise<TitleRunBundle | null> {
    const result = await this.query(
      `SELECT ${RUN_COLUMNS} FROM title_writing_run WHERE workspace_id = $1 AND actor_id = $2 AND idempotency_key = $3`,
      [workspaceId, actorId, idempotencyKey],
    );
    return this.load(null, result.rows[0] as Row | undefined);
  }

  /** One consistent snapshot of what a breakdown start freezes. Reads only; nothing is locked or written. */
  async breakdownSource(workspaceId: string, projectId: string, episodeId: string): Promise<ScriptBreakdownSourceRead> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try {
        const episode = await client.query<Row>(
          `SELECT episode_no, current_script_revision_id, approved_script_revision_id FROM episode
            WHERE id = $1 AND project_id = $2 AND workspace_id = $3`,
          [episodeId, projectId, workspaceId],
        );
        const episodeRow = episode.rows[0];
        if (!episodeRow) return { kind: "not_found" };
        const currentId = episodeRow.current_script_revision_id as string | null;
        if (!currentId) return { kind: "script_missing" };
        const script = await client.query<Row>(
          `SELECT revision_no, content_json, content_hash, review_status, freshness_status FROM script_revision
            WHERE id = $1 AND episode_id = $2 AND workspace_id = $3`,
          [currentId, episodeId, workspaceId],
        );
        const scriptRow = script.rows[0];
        if (!scriptRow || episodeRow.approved_script_revision_id !== currentId || scriptRow.review_status !== "APPROVED"
          || scriptRow.freshness_status !== "CURRENT") return { kind: "script_review_required" };
        const plan = await projectEpisodePlanIn(client, workspaceId, projectId);
        // Only characters whose current revision is fresh can be referenced by a shot draft (provenance triggers).
        const characters = await client.query<Row>(
          `SELECT c.id, c.current_revision_id, c.name FROM character c
             JOIN character_revision r ON r.id = c.current_revision_id AND r.character_id = c.id AND r.workspace_id = c.workspace_id
            WHERE c.project_id = $1 AND c.workspace_id = $2 AND c.archived_at IS NULL AND r.freshness_status = 'CURRENT'
            ORDER BY c.created_at, c.id`,
          [projectId, workspaceId],
        );
        const scenes = await client.query<Row>(
          `SELECT id, row_version FROM scene WHERE episode_id = $1 AND project_id = $2 AND workspace_id = $3 AND archived_at IS NULL
            ORDER BY id`,
          [episodeId, projectId, workspaceId],
        );
        const shots = await client.query<Row>(
          `SELECT shot.id, shot.row_version FROM shot JOIN scene ON scene.id = shot.scene_id AND scene.workspace_id = shot.workspace_id
            WHERE scene.episode_id = $1 AND shot.project_id = $2 AND shot.workspace_id = $3
              AND scene.archived_at IS NULL AND shot.archived_at IS NULL
            ORDER BY shot.id`,
          [episodeId, projectId, workspaceId],
        );
        return {
          kind: "ok",
          episodeNo: Number(episodeRow.episode_no),
          scriptRevisionId: currentId,
          scriptRevisionNo: Number(scriptRow.revision_no),
          scriptContentHash: String(scriptRow.content_hash),
          scriptContent: scriptRow.content_json,
          targetEpisodeSeconds: plan.targetEpisodeSeconds,
          characters: characters.rows.map((row) => ({ characterId: String(row.id), revisionId: String(row.current_revision_id), name: String(row.name) })),
          scenes: scenes.rows.map((row) => ({ sceneId: String(row.id), rowVersion: Number(row.row_version) })),
          shots: shots.rows.map((row) => ({ shotId: String(row.id), rowVersion: Number(row.row_version) })),
        };
      } finally {
        await client.query("ROLLBACK");
      }
    } finally {
      client.release();
    }
  }

  async latestBreakdown(workspaceId: string, projectId: string, episodeId: string): Promise<TitleRunBundle | null> {
    const result = await this.query(
      `SELECT ${RUN_COLUMNS} FROM title_writing_run
        WHERE workspace_id = $1 AND project_id = $2 AND run_kind = 'script_breakdown' AND episode_id = $3
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [workspaceId, projectId, episodeId],
    );
    return this.load(null, result.rows[0] as Row | undefined);
  }

  async latestSavedBreakdown(workspaceId: string, projectId: string, episodeId: string): Promise<TitleRunBundle | null> {
    const result = await this.query(
      `SELECT ${RUN_COLUMNS} FROM title_writing_run
        WHERE workspace_id = $1 AND project_id = $2 AND run_kind = 'script_breakdown' AND episode_id = $3 AND breakdown_save = 'saved'
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [workspaceId, projectId, episodeId],
    );
    return this.load(null, result.rows[0] as Row | undefined);
  }

  async breakdownDetails(workspaceId: string, run: TitleRunRecord): Promise<ScriptBreakdownDetails> {
    if (!isScriptBreakdownInput(run.input) || run.workspaceId !== workspaceId) throw new Error("not a breakdown run of this workspace");
    const links = await this.query(
      `SELECT link.scene_key, link.ordinal, link.scene_id, link.scene_revision_id, link.shot_save, link.placed_scene_revision_id,
              scene.archived_at IS NOT NULL AS archived, scene.current_revision_id, scene.approved_revision_id,
              current_revision.review_status, current_revision.freshness_status
         FROM script_breakdown_scene link
         JOIN scene ON scene.id = link.scene_id AND scene.workspace_id = link.workspace_id
         LEFT JOIN scene_revision current_revision ON current_revision.id = scene.current_revision_id
        WHERE link.run_id = $1 AND link.workspace_id = $2
        ORDER BY link.ordinal`,
      [run.id, workspaceId],
    );
    const script = await this.query(
      `SELECT episode.current_script_revision_id, script.revision_no,
              (episode.approved_script_revision_id = script.id AND script.review_status = 'APPROVED'
                AND script.freshness_status = 'CURRENT') AS approved
         FROM episode LEFT JOIN script_revision script ON script.id = episode.current_script_revision_id
        WHERE episode.id = $1 AND episode.workspace_id = $2`,
      [run.input.episodeId, workspaceId],
    );
    const scriptRow = script.rows[0];
    return {
      scenes: links.rows.map((row): ScriptBreakdownSceneView => ({
        key: String(row.scene_key),
        ordinal: Number(row.ordinal),
        sceneId: String(row.scene_id),
        sceneRevisionId: String(row.scene_revision_id),
        shotSave: row.shot_save === "saved" ? "saved" : "pending",
        placedSceneRevisionId: (row.placed_scene_revision_id as string | null) ?? null,
        current: {
          archived: row.archived === true,
          currentRevisionId: (row.current_revision_id as string | null) ?? null,
          approvedRevisionId: (row.approved_revision_id as string | null) ?? null,
          reviewStatus: (row.review_status as string | null) ?? null,
          freshnessStatus: (row.freshness_status as string | null) ?? null,
        },
      })),
      episodeScript: {
        currentRevisionId: (scriptRow?.current_script_revision_id as string | null | undefined) ?? null,
        currentRevisionNo: scriptRow?.revision_no === null || scriptRow?.revision_no === undefined ? null : Number(scriptRow.revision_no),
        approved: scriptRow?.approved === true,
      },
    };
  }

  async saveBreakdown(workspaceId: string, runId: string, executorId: string, actorId: string, nowIso: string): Promise<ScriptBreakdownSave | "lost"> {
    return this.transaction(async (client) => {
      const run = await this.ownedRun(client, workspaceId, runId, executorId, nowIso);
      if (!run || !isScriptBreakdownInput(run.input)) return "lost";
      if ((run.breakdownSave ?? "pending") !== "pending") return run.breakdownSave!;
      const input = run.input;
      const step = await client.query<Row>(
        "SELECT state, output_json FROM title_writing_step WHERE run_id = $1 AND step_key = $2",
        [runId, SCRIPT_BREAKDOWN_STEP_KEY],
      );
      if (step.rows[0]?.state !== "completed" || !step.rows[0].output_json) return "lost";
      const output = step.rows[0].output_json as ScriptBreakdownOutput;
      const settle = async (save: ScriptBreakdownSave): Promise<ScriptBreakdownSave> => {
        await client.query("UPDATE title_writing_run SET breakdown_save = $2, updated_at = $3 WHERE id = $1", [runId, save, nowIso]);
        return save;
      };
      // Lock order run -> project -> episode, the same as saveStory and placeScripts, then the text chain's own order.
      const project = await client.query("SELECT id FROM project WHERE id = $1 AND workspace_id = $2 FOR UPDATE", [run.projectId, workspaceId]);
      if (!project.rows[0]) return settle("source_changed");
      await client.query("SAVEPOINT script_breakdown_save");
      try {
        const episode = await client.query<Row>(
          `SELECT e.current_script_revision_id, e.approved_script_revision_id, s.review_status, s.freshness_status
             FROM episode e LEFT JOIN script_revision s ON s.id = e.current_script_revision_id
            WHERE e.id = $1 AND e.project_id = $2 AND e.workspace_id = $3 FOR UPDATE OF e`,
          [input.episodeId, run.projectId, workspaceId],
        );
        const episodeRow = episode.rows[0];
        if (!episodeRow || episodeRow.current_script_revision_id !== input.scriptRevisionId
          || episodeRow.approved_script_revision_id !== input.scriptRevisionId || episodeRow.review_status !== "APPROVED"
          || episodeRow.freshness_status !== "CURRENT") {
          await client.query("ROLLBACK TO SAVEPOINT script_breakdown_save");
          return settle("source_changed");
        }
        const referenced = new Set(output.shots.flatMap((shot) => shot.characterKeys));
        const frozen = input.characters.filter((item) => referenced.has(item.key));
        if (!await this.charactersCurrent(client, workspaceId, run.projectId, frozen)) {
          await client.query("ROLLBACK TO SAVEPOINT script_breakdown_save");
          return settle("source_changed");
        }
        if (!await this.breakdownSceneSetCurrent(client, workspaceId, run.projectId, input)) {
          await client.query("ROLLBACK TO SAVEPOINT script_breakdown_save");
          return settle("conflict");
        }
        const traceId = `script-breakdown:${runId}`;
        await this.textChain.archiveSceneSetInTransaction(client, {
          workspaceId, projectId: run.projectId, episodeId: input.episodeId,
          scenes: input.replace.scenes, shots: input.replace.shots, traceId,
        });
        for (const [index, scene] of output.scenes.entries()) {
          const version = await client.query<Row>("SELECT row_version FROM episode WHERE id = $1 AND workspace_id = $2", [input.episodeId, workspaceId]);
          // The same path as the scene editor's save: a DRAFT scene revision from the current approved script.
          const created = await this.textChain.createSceneRevisionInTransaction(client, {
            workspaceId, projectId: run.projectId, episodeId: input.episodeId, sourceScriptRevisionId: input.scriptRevisionId,
            ordinal: index + 1, heading: scene.heading.trim(), timeOfDay: scene.timeOfDay.trim() || null, summary: scene.description.trim(),
            createdBy: actorId, expectedVersion: Number(version.rows[0]?.row_version), traceId,
          });
          await client.query(
            `INSERT INTO script_breakdown_scene (run_id, workspace_id, project_id, episode_id, scene_key, ordinal, scene_id,
               scene_revision_id, shot_save, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $9)`,
            [runId, workspaceId, run.projectId, input.episodeId, scene.key, index + 1, created.entityId, created.revisionId, nowIso],
          );
        }
        await client.query("RELEASE SAVEPOINT script_breakdown_save");
        return settle("saved");
      } catch (error) {
        // A source that moved under the save (a concurrent edit, pending propagation) keeps the result unwritten.
        if (!(error instanceof PersistenceError)) throw error;
        await client.query("ROLLBACK TO SAVEPOINT script_breakdown_save");
        return settle(error.code === "SCRIPT_REVIEW_REQUIRED" ? "source_changed" : "conflict");
      }
    });
  }

  async placeBreakdownShots(workspaceId: string, projectId: string, episodeId: string, runId: string, options: { acceptSceneChanged: boolean }, actorId: string, nowIso: string): Promise<ScriptBreakdownPlacement> {
    return this.transaction(async (client) => {
      // Serialize placement against starts/resumes before taking any run/project row locks. Looking up another run
      // below never locks it, so a saving worker holding that run and waiting for the project cannot deadlock us.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`title_writing_run:${workspaceId}`]);
      const runResult = await client.query<Row>(
        `SELECT ${RUN_COLUMNS} FROM title_writing_run WHERE id = $1 AND workspace_id = $2 AND project_id = $3 FOR UPDATE`,
        [runId, workspaceId, projectId],
      );
      const runRow = runResult.rows[0];
      if (!runRow) return { kind: "not_found" };
      const run = toRun(runRow);
      if (!isScriptBreakdownInput(run.input) || run.input.episodeId !== episodeId) return { kind: "not_found" };
      if (run.breakdownSave !== "saved") return { kind: "not_ready" };
      const input = run.input;
      const step = await client.query<Row>("SELECT output_json FROM title_writing_step WHERE run_id = $1 AND step_key = $2",
        [runId, SCRIPT_BREAKDOWN_STEP_KEY]);
      const output = step.rows[0]?.output_json as ScriptBreakdownOutput | undefined;
      if (!output) return { kind: "not_ready" };
      const locked = await client.query("SELECT id FROM project WHERE id = $1 AND workspace_id = $2 FOR UPDATE", [projectId, workspaceId]);
      if (!locked.rows[0]) return { kind: "not_found" };
      const outcome: ScriptBreakdownPlacementOutcome = { placed: [], awaitingApproval: [], sceneChanged: [], charactersChanged: [], unavailable: [] };
      const links = await client.query<Row>(
        `SELECT scene_key, scene_id, scene_revision_id FROM script_breakdown_scene
          WHERE run_id = $1 AND workspace_id = $2 AND shot_save = 'pending' ORDER BY ordinal`,
        [runId, workspaceId],
      );
      // A completed placement remains a no-op replay even if its source has since changed. The source gate below is
      // about creating new revisions, never about undoing the prior receipt.
      if (links.rows.length === 0) return { kind: "ok", bundle: (await this.load(client, runRow))!, outcome };
      const active = await client.query(
        `SELECT 1 FROM title_writing_run WHERE workspace_id = $1 AND project_id = $2 AND episode_id = $3
          AND run_kind = 'script_breakdown' AND state = 'running' AND id <> $4 LIMIT 1`,
        [workspaceId, projectId, episodeId, runId],
      );
      if (active.rows.length > 0) return { kind: "active" };
      // Confirm after taking the project lock: accepting an edited scene does not permit attaching an old plan to a
      // different script. The page disables this action for an obsolete source, but the API must enforce it too.
      const source = await client.query(
        `SELECT 1 FROM episode e JOIN script_revision script ON script.id = e.current_script_revision_id
            AND script.episode_id = e.id AND script.workspace_id = e.workspace_id AND script.project_id = e.project_id
          WHERE e.id = $1 AND e.workspace_id = $2 AND e.project_id = $3
            AND e.current_script_revision_id = $4 AND e.approved_script_revision_id = $4
            AND script.review_status = 'APPROVED' AND script.freshness_status = 'CURRENT'
          FOR SHARE OF e, script`,
        [episodeId, workspaceId, projectId, input.scriptRevisionId],
      );
      if (!source.rows[0]) return { kind: "not_ready" };
      const traceId = `script-breakdown:${runId}`;
      for (const link of links.rows) {
        const sceneKey = String(link.scene_key);
        const sceneId = String(link.scene_id);
        const scene = await client.query<Row>(
          `SELECT scene.archived_at IS NOT NULL AS archived, scene.current_revision_id, scene.approved_revision_id,
                  revision.review_status, revision.freshness_status, revision.source_script_revision_id, revision.heading, revision.time_of_day
             FROM scene LEFT JOIN scene_revision revision ON revision.id = scene.approved_revision_id
            WHERE scene.id = $1 AND scene.workspace_id = $2 AND scene.project_id = $3 AND scene.episode_id = $4 FOR UPDATE OF scene`,
          [sceneId, workspaceId, projectId, episodeId],
        );
        const sceneRow = scene.rows[0];
        if (!sceneRow || sceneRow.archived === true) { outcome.unavailable.push(sceneKey); continue; }
        const approvedId = sceneRow.approved_revision_id as string | null;
        if (!approvedId || sceneRow.current_revision_id !== approvedId || sceneRow.review_status !== "APPROVED") {
          outcome.awaitingApproval.push(sceneKey);
          continue;
        }
        if (sceneRow.freshness_status !== "CURRENT" || sceneRow.source_script_revision_id !== input.scriptRevisionId) {
          outcome.unavailable.push(sceneKey); continue;
        }
        if (approvedId !== String(link.scene_revision_id) && !options.acceptSceneChanged) { outcome.sceneChanged.push(sceneKey); continue; }
        // Scene creation and manual shot edits use this project lock as well. A person may have added shots since the
        // scene was generated: preserve those and let the other scenes proceed instead of hitting the ordinal trigger
        // (a raw PostgreSQL exception) and rolling back the entire placement.
        const existing = await client.query(
          `SELECT 1 FROM shot WHERE scene_id = $1 AND workspace_id = $2 AND project_id = $3 AND archived_at IS NULL LIMIT 1`,
          [sceneId, workspaceId, projectId],
        );
        if (existing.rows[0]) { outcome.unavailable.push(sceneKey); continue; }
        const planned = shotsOfScene(output, sceneKey);
        const references = planned.map((shot) => shot.characterKeys.map((key) => input.characters.find((item) => item.key === key)!));
        if (!await this.charactersCurrent(client, workspaceId, projectId, references.flat())) { outcome.charactersChanged.push(sceneKey); continue; }
        // The prompt's place and time come from the approved revision the shots will point to (an accepted edit
        // included), read under the scene lock above; the shot plan, action and dialogue stay as proposed.
        const approvedScene = { ...output.scenes.find((item) => item.key === sceneKey)!,
          heading: String(sceneRow.heading), timeOfDay: (sceneRow.time_of_day as string | null) ?? "" };
        await client.query("SAVEPOINT script_breakdown_shots");
        try {
          for (const [index, shot] of planned.entries()) {
            const version = await client.query<Row>("SELECT row_version FROM scene WHERE id = $1 AND workspace_id = $2", [sceneId, workspaceId]);
            // The same path as the shot editor's save; it re-checks that the scene revision is current and approved.
            const created = await this.textChain.createShotScopedInTransaction(client, {
              workspaceId, projectId, sceneId, sourceSceneRevisionId: approvedId, ordinal: index + 1,
              shotType: shot.shotType.trim(), camera: shot.camera.trim(), action: shot.action.trim(),
              dialogue: breakdownDialogueText(shot), durationHint: null, plannedDurationMs: shot.plannedSeconds * 1000,
              promptText: breakdownShotPromptText(approvedScene, shot), createdBy: actorId,
              expectedVersion: Number(version.rows[0]?.row_version), traceId,
            });
            await this.textChain.addShotCharacterReferencesInTransaction(client, {
              workspaceId, projectId, shotRevisionId: created.revisionId,
              characterRevisionIds: references[index]!.map((item) => item.revisionId), role: "appears",
            });
          }
          await client.query(
            `UPDATE script_breakdown_scene SET shot_save = 'saved', placed_scene_revision_id = $3, updated_at = $4
              WHERE run_id = $1 AND scene_key = $2`,
            [runId, sceneKey, approvedId, nowIso],
          );
          await client.query("RELEASE SAVEPOINT script_breakdown_shots");
          outcome.placed.push(sceneKey);
        } catch (error) {
          // Domain-level source or version conflicts leave this scene untouched; unexpected database errors propagate.
          if (!(error instanceof PersistenceError)) throw error;
          await client.query("ROLLBACK TO SAVEPOINT script_breakdown_shots");
          outcome.unavailable.push(sceneKey);
        }
      }
      await client.query("UPDATE title_writing_run SET updated_at = $2 WHERE id = $1", [runId, nowIso]);
      return { kind: "ok", bundle: (await this.load(client, runRow))!, outcome };
    });
  }

  /** True when each frozen character is not archived and its current revision is still the frozen, fresh one. */
  private async charactersCurrent(client: PoolClient, workspaceId: string, projectId: string,
    frozen: ReadonlyArray<{ characterId: string; revisionId: string }>): Promise<boolean> {
    if (frozen.length === 0) return true;
    const ids = [...new Set(frozen.map((item) => item.characterId))];
    const rows = await client.query<Row>(
      `SELECT c.id, c.current_revision_id, c.archived_at IS NOT NULL AS archived, r.freshness_status
         FROM character c LEFT JOIN character_revision r ON r.id = c.current_revision_id
        WHERE c.id = ANY($1::uuid[]) AND c.workspace_id = $2 AND c.project_id = $3
        FOR SHARE OF c`,
      [ids, workspaceId, projectId],
    );
    return frozen.every((item) => rows.rows.some((row) => String(row.id) === item.characterId && row.archived !== true
      && row.current_revision_id === item.revisionId && row.freshness_status === "CURRENT"));
  }

  /**
   * True when the frozen script is still the episode's current and approved revision, APPROVED and CURRENT. Takes the
   * project, episode and script share locks after the run lock (run -> project -> episode, as saveBreakdown and the
   * script editor), so a script save or review either commits before this check or waits until its transaction ends.
   */
  private async breakdownScriptCurrent(client: PoolClient, workspaceId: string, projectId: string,
    input: { episodeId: string; scriptRevisionId: string }): Promise<boolean> {
    const project = await client.query("SELECT id FROM project WHERE id = $1 AND workspace_id = $2 FOR SHARE", [projectId, workspaceId]);
    if (!project.rows[0]) return false;
    const current = await client.query<Row>(
      `SELECT e.id FROM episode e
         JOIN script_revision s ON s.id = e.current_script_revision_id AND s.episode_id = e.id AND s.workspace_id = e.workspace_id
        WHERE e.id = $1 AND e.project_id = $2 AND e.workspace_id = $3
          AND e.current_script_revision_id = $4 AND e.approved_script_revision_id = $4
          AND s.review_status = 'APPROVED' AND s.freshness_status = 'CURRENT'
        FOR SHARE OF e, s`,
      [input.episodeId, projectId, workspaceId, input.scriptRevisionId],
    );
    return current.rows.length === 1;
  }

  /** Same comparison at reservation, resume and save: edits, additions and archival all invalidate the snapshot. */
  private async breakdownSceneSetCurrent(client: PoolClient, workspaceId: string, projectId: string,
    input: ScriptBreakdownFrozenInput): Promise<boolean> {
    const current = await this.episodeSceneSet(client, workspaceId, projectId, input.episodeId);
    const same = (now: Array<{ id: string; rowVersion: number }>, expected: Array<{ id: string; rowVersion: number }>) =>
      now.length === expected.length && now.every((item) => expected.some((other) => other.id === item.id && other.rowVersion === item.rowVersion));
    return same(current.scenes, input.replace.scenes.map((item) => ({ id: item.sceneId, rowVersion: item.rowVersion })))
      && same(current.shots, input.replace.shots.map((item) => ({ id: item.shotId, rowVersion: item.rowVersion })));
  }

  private async episodeSceneSet(client: PoolClient, workspaceId: string, projectId: string, episodeId: string) {
    const scenes = await client.query<Row>(
      `SELECT id, row_version FROM scene WHERE episode_id = $1 AND project_id = $2 AND workspace_id = $3 AND archived_at IS NULL
        FOR UPDATE`,
      [episodeId, projectId, workspaceId],
    );
    const shots = await client.query<Row>(
      `SELECT shot.id, shot.row_version FROM shot JOIN scene ON scene.id = shot.scene_id AND scene.workspace_id = shot.workspace_id
        WHERE scene.episode_id = $1 AND shot.project_id = $2 AND shot.workspace_id = $3
          AND scene.archived_at IS NULL AND shot.archived_at IS NULL
        FOR UPDATE OF shot`,
      [episodeId, projectId, workspaceId],
    );
    return {
      scenes: scenes.rows.map((row) => ({ id: String(row.id), rowVersion: Number(row.row_version) })),
      shots: shots.rows.map((row) => ({ id: String(row.id), rowVersion: Number(row.row_version) })),
    };
  }

  private async query(sql: string, values: unknown[]): Promise<QueryResult<Row>> {
    const client = await this.pool.connect();
    try {
      return await client.query<Row>(sql, values);
    } finally {
      client.release();
    }
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      try {
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    } finally {
      client.release();
    }
  }
}
