import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import {
  TITLE_WRITING_CANCELED_BEFORE_SEND,
  autoRunSettledForGood,
  autoStageKind,
  currentUncertainCallIds,
  type AutoCallFinish,
  type AutoCallRecord,
  type AutoCallReservation,
  type AutoCreationQuality,
  type AutoCreationStore,
  type AutoResumePreparation,
  type AutoRunBundle,
  type AutoRunCreation,
  type AutoRunRecord,
  type AutoScriptPlacement,
  type AutoStageOutput,
  type AutoStageRecord,
  type TitleWritingProviderKey,
  type TitleWritingRunState,
  type TitleWritingStepKey,
  type TitleWritingUsageView,
} from "@ai-drama/contracts";
import type { DatabasePool } from "./job-service";
import { projectEpisodePlanIn } from "./episode-plan";
import { AUTO_CREATION_MIGRATION } from "./migrations";
import type { TextChainService } from "./text-chain";
import { recentWritingCalls, runningWritingRuns, writingCallLockKey } from "./writing-candidate-store";

export { AUTO_CREATION_MIGRATION };

/** Every column the store reads or writes. Until all exist and the migration is recorded, storageReady() is false. */
export const AUTO_CREATION_TABLES: Readonly<Record<string, readonly string[]>> = {
  auto_creation_run: ["id", "workspace_id", "project_id", "actor_id", "idempotency_key", "input_hash", "input_json", "provider_key", "model",
    "state", "error_code", "cancel_requested_at", "executor_id", "lease_until", "call_cap", "calls_used", "revision_rounds_used", "quality",
    "story_save", "story_revision_id", "created_at", "updated_at"],
  auto_creation_stage: ["run_id", "workspace_id", "stage_key", "ordinal", "state", "attempt_no", "error_code", "output_json", "output_hash",
    "depends_on_json", "script_save", "script_revision_id", "updated_at"],
  auto_creation_call: ["id", "run_id", "workspace_id", "stage_key", "attempt_no", "provider_key", "model", "request_hash", "state", "executor_id",
    "provider_request_id", "response_model", "usage_json", "billing_status", "error_code", "created_at", "finished_at"],
  auto_creation_resume: ["run_id", "workspace_id", "idempotency_key", "request_hash", "confirmed_call_ids", "created_at"],
};

const RUN_COLUMNS = AUTO_CREATION_TABLES.auto_creation_run!.join(", ");
const STAGE_COLUMNS = AUTO_CREATION_TABLES.auto_creation_stage!.join(", ");
const CALL_COLUMNS = AUTO_CREATION_TABLES.auto_creation_call!.filter((column) => column !== "billing_status").join(", ");

type Row = QueryResultRow & Record<string, unknown>;

function iso(value: unknown): string {
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function toRun(row: Row): AutoRunRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    projectId: String(row.project_id),
    actorId: String(row.actor_id),
    idempotencyKey: String(row.idempotency_key),
    inputHash: String(row.input_hash),
    // Written only by createRun after the service built and hashed it.
    input: row.input_json as AutoRunRecord["input"],
    state: row.state as TitleWritingRunState,
    errorCode: (row.error_code as string | null) ?? null,
    cancelRequestedAt: isoOrNull(row.cancel_requested_at),
    executorId: (row.executor_id as string | null) ?? null,
    leaseUntil: isoOrNull(row.lease_until),
    callCap: Number(row.call_cap),
    callsUsed: Number(row.calls_used),
    revisionRoundsUsed: Number(row.revision_rounds_used),
    quality: row.quality as AutoCreationQuality,
    storySave: row.story_save as AutoRunRecord["storySave"],
    storyRevisionId: (row.story_revision_id as string | null) ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toStage(row: Row): AutoStageRecord {
  return {
    runId: String(row.run_id),
    stageKey: String(row.stage_key),
    ordinal: Number(row.ordinal),
    state: row.state as AutoStageRecord["state"],
    attemptNo: Number(row.attempt_no),
    errorCode: (row.error_code as string | null) ?? null,
    // Written only after the output passed the domain checks.
    output: (row.output_json ?? null) as AutoStageOutput | null,
    outputHash: (row.output_hash as string | null) ?? null,
    dependsOn: (row.depends_on_json ?? null) as Record<string, string> | null,
    scriptSave: (row.script_save as AutoStageRecord["scriptSave"]) ?? null,
    scriptRevisionId: (row.script_revision_id as string | null) ?? null,
    updatedAt: iso(row.updated_at),
  };
}

function toCall(row: Row): AutoCallRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    workspaceId: String(row.workspace_id),
    stageKey: String(row.stage_key),
    attemptNo: Number(row.attempt_no),
    providerKey: row.provider_key as AutoCallRecord["providerKey"],
    model: String(row.model),
    requestHash: String(row.request_hash),
    state: row.state as AutoCallRecord["state"],
    executorId: String(row.executor_id),
    providerRequestId: (row.provider_request_id as string | null) ?? null,
    responseModel: (row.response_model as string | null) ?? null,
    usage: row.usage_json as TitleWritingUsageView,
    errorCode: (row.error_code as string | null) ?? null,
    createdAt: iso(row.created_at),
    finishedAt: isoOrNull(row.finished_at),
  };
}

/** The lock every run start of a workspace (title writing and automatic creation) is serialized under. */
function runLockKey(workspaceId: string): string {
  return `title_writing_run:${workspaceId}`;
}

/**
 * PostgreSQL storage of automatic creation runs (migration 20261019000100_auto_creation). Lock order, as in title
 * writing: workspace run lock → run row → project → episode for starts, resumes and placement; workspace call lock → run
 * row for reservations. Every query names the workspace.
 */
export class PostgresAutoCreationStore implements AutoCreationStore {
  private readyConfirmed = false;

  constructor(private readonly pool: DatabasePool, private readonly textChain: TextChainService) {}

  async storageReady(): Promise<boolean> {
    if (this.readyConfirmed) return true;
    try {
      const ledger = await this.query("SELECT to_regclass('schema_migration') IS NOT NULL AS present", []);
      if (ledger.rows[0]?.present !== true) return false;
      const recorded = await this.query("SELECT 1 FROM schema_migration WHERE name = $1", [AUTO_CREATION_MIGRATION]);
      if (!recorded.rows[0]) return false;
      const result = await this.query(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`, [Object.keys(AUTO_CREATION_TABLES)]);
      const present = new Set(result.rows.map((row) => `${String(row.table_name)}.${String(row.column_name)}`));
      this.readyConfirmed = Object.entries(AUTO_CREATION_TABLES).every(([table, columns]) => columns.every((column) => present.has(`${table}.${column}`)));
      return this.readyConfirmed;
    } catch {
      return false;
    }
  }

  /** The new tables' provider CHECKs name all three active providers from the start. */
  async providerStorageReady(_providerKey: TitleWritingProviderKey): Promise<boolean> {
    return this.storageReady();
  }

  private async load(client: PoolClient | null, row: Row | undefined): Promise<AutoRunBundle | null> {
    if (!row) return null;
    const run = toRun(row);
    const query = client ? client.query.bind(client) : this.query.bind(this);
    const stages = await query(`SELECT ${STAGE_COLUMNS} FROM auto_creation_stage WHERE run_id = $1 ORDER BY ordinal`, [run.id]) as QueryResult<Row>;
    const calls = await query(`SELECT ${CALL_COLUMNS} FROM auto_creation_call WHERE run_id = $1 ORDER BY created_at, attempt_no`, [run.id]) as QueryResult<Row>;
    return { run, stages: stages.rows.map(toStage), calls: calls.rows.map(toCall) };
  }

  async findRunByKey(workspaceId: string, actorId: string, idempotencyKey: string): Promise<AutoRunBundle | null> {
    const result = await this.query(
      `SELECT ${RUN_COLUMNS} FROM auto_creation_run WHERE workspace_id = $1 AND actor_id = $2 AND idempotency_key = $3`,
      [workspaceId, actorId, idempotencyKey]);
    return this.load(null, result.rows[0] as Row | undefined);
  }

  async createRun(run: AutoRunRecord, stageKeys: readonly string[], limits: { maxActiveRuns: number; sinceIso: string; maxCallsPerDay: number; requiredCalls: number }): Promise<AutoRunCreation> {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [runLockKey(run.workspaceId)]);
      const existing = await client.query<Row>(
        `SELECT ${RUN_COLUMNS} FROM auto_creation_run WHERE workspace_id = $1 AND actor_id = $2 AND idempotency_key = $3`,
        [run.workspaceId, run.actorId, run.idempotencyKey]);
      const found = existing.rows[0];
      if (found) {
        const same = String(found.input_hash) === run.inputHash && String(found.project_id) === run.projectId;
        return { kind: same ? "existing" : "conflict", bundle: (await this.load(client, found))! };
      }
      const titles = await client.query<Row>("SELECT to_regclass('title_writing_run') IS NOT NULL AS present");
      const titleRunning = titles.rows[0]?.present === true
        ? (await client.query<Row>("SELECT id, project_id FROM title_writing_run WHERE workspace_id = $1 AND state = 'running'", [run.workspaceId])).rows
        : [];
      const autoRunning = (await runningWritingRuns(client, run.workspaceId)).map((item) => ({ id: item.id, project_id: item.projectId, kind: item.kind }));
      const sameAuto = autoRunning.find((row) => String(row.project_id) === run.projectId);
      if (sameAuto) return { kind: "active", runKind: "auto", runId: String(sameAuto.id) };
      const sameTitle = titleRunning.find((row) => String(row.project_id) === run.projectId);
      if (sameTitle) return { kind: "active", runKind: "title", runId: String(sameTitle.id) };
      // A run writes only into a work with no story yet and no earlier automatic run.
      const project = await client.query<Row>(
        `SELECT p.current_story_revision_id, EXISTS (SELECT 1 FROM auto_creation_run a WHERE a.project_id = p.id) AS has_run
           FROM project p WHERE p.id = $1 AND p.workspace_id = $2 FOR UPDATE`, [run.projectId, run.workspaceId]);
      const projectRow = project.rows[0];
      if (!projectRow || projectRow.current_story_revision_id !== null || projectRow.has_run === true) return { kind: "project_not_empty" };
      // One concurrency cap for title writing and automatic creation runs.
      if (autoRunning.length + titleRunning.length >= limits.maxActiveRuns) return { kind: "blocked", code: "AUTO_CREATION_ACTIVE_RUN_CAP" };
      // A start check only: the normal calls must still fit the shared rolling cap. Each send still reserves atomically.
      const remainingCalls = Math.max(0, limits.maxCallsPerDay - await recentWritingCalls(client, run.workspaceId, limits.sinceIso));
      if (remainingCalls < limits.requiredCalls) {
        return { kind: "blocked", code: "AUTO_CREATION_DAILY_QUOTA_LOW", requiredCalls: limits.requiredCalls, remainingCalls };
      }
      const inserted = await client.query<Row>(
        `INSERT INTO auto_creation_run (id, workspace_id, project_id, actor_id, idempotency_key, input_hash, input_json, provider_key, model,
           state, call_cap, calls_used, revision_rounds_used, quality, story_save, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 'running', $10, 0, 0, 'pending', 'pending', $11, $11)
         RETURNING ${RUN_COLUMNS}`,
        [run.id, run.workspaceId, run.projectId, run.actorId, run.idempotencyKey, run.inputHash, JSON.stringify(run.input),
          run.input.providerKey, run.input.model, run.callCap, run.createdAt]);
      for (const [ordinal, stageKey] of stageKeys.entries()) {
        await client.query(
          `INSERT INTO auto_creation_stage (run_id, workspace_id, stage_key, ordinal, state, attempt_no, script_save, updated_at)
           VALUES ($1, $2, $3, $4, 'pending', 0, $5, $6)`,
          [run.id, run.workspaceId, stageKey, ordinal, autoStageKind(stageKey) === "episode" ? "pending" : null, run.createdAt]);
      }
      return { kind: "created", bundle: (await this.load(client, inserted.rows[0]))! };
    });
  }

  async getRun(workspaceId: string, projectId: string, runId: string): Promise<AutoRunBundle | null> {
    const result = await this.query(`SELECT ${RUN_COLUMNS} FROM auto_creation_run WHERE id = $1 AND workspace_id = $2 AND project_id = $3`,
      [runId, workspaceId, projectId]);
    return this.load(null, result.rows[0] as Row | undefined);
  }

  async getRunById(workspaceId: string, runId: string): Promise<AutoRunBundle | null> {
    const result = await this.query(`SELECT ${RUN_COLUMNS} FROM auto_creation_run WHERE id = $1 AND workspace_id = $2`, [runId, workspaceId]);
    return this.load(null, result.rows[0] as Row | undefined);
  }

  async latestRun(workspaceId: string, projectId: string): Promise<AutoRunBundle | null> {
    const result = await this.query(
      `SELECT ${RUN_COLUMNS} FROM auto_creation_run WHERE workspace_id = $1 AND project_id = $2 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [workspaceId, projectId]);
    return this.load(null, result.rows[0] as Row | undefined);
  }

  async claimRun(workspaceId: string, runId: string, executorId: string, nowIso: string, leaseUntil: string): Promise<boolean> {
    const result = await this.query(
      `UPDATE auto_creation_run r SET executor_id = $2, lease_until = $4, updated_at = $3
        WHERE r.id = $1 AND r.workspace_id = $5 AND r.state = 'running'
          AND (r.executor_id IS NULL OR r.executor_id = $2 OR r.lease_until <= $3)
          AND (r.executor_id = $2 OR NOT EXISTS (
            SELECT 1 FROM auto_creation_call c WHERE c.run_id = r.id AND c.state IN ('reserved', 'submitted')))`,
      [runId, executorId, nowIso, leaseUntil, workspaceId]);
    return result.rowCount === 1;
  }

  private async ownedRun(client: PoolClient, workspaceId: string, runId: string, executorId: string, nowIso: string): Promise<AutoRunRecord | null> {
    const result = await client.query<Row>(`SELECT ${RUN_COLUMNS} FROM auto_creation_run WHERE id = $1 AND workspace_id = $2 FOR UPDATE`, [runId, workspaceId]);
    const row = result.rows[0];
    if (!row) return null;
    const run = toRun(row);
    if (run.state !== "running" || run.executorId !== executorId || run.leaseUntil === null || run.leaseUntil <= nowIso) return null;
    return run;
  }

  async completeLocalStage(workspaceId: string, runId: string, executorId: string, stageKey: string, output: AutoStageOutput, outputHash: string, nowIso: string): Promise<boolean> {
    return this.transaction(async (client) => {
      if (!await this.ownedRun(client, workspaceId, runId, executorId, nowIso)) return false;
      const updated = await client.query(
        `UPDATE auto_creation_stage SET state = 'completed', output_json = $3::jsonb, output_hash = $4, depends_on_json = '{}'::jsonb, updated_at = $5
          WHERE run_id = $1 AND stage_key = $2 AND state = 'pending'`,
        [runId, stageKey, JSON.stringify(output), outputHash, nowIso]);
      if (updated.rowCount !== 1) return false;
      await client.query("UPDATE auto_creation_run SET updated_at = $2 WHERE id = $1", [runId, nowIso]);
      return true;
    });
  }

  async appendRound(workspaceId: string, runId: string, executorId: string, stageKeys: readonly string[], round: number, nowIso: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const run = await this.ownedRun(client, workspaceId, runId, executorId, nowIso);
      if (!run || run.revisionRoundsUsed !== round - 1) return false;
      const open = await client.query<Row>(
        "SELECT count(*) FILTER (WHERE state <> 'completed')::int AS open, max(ordinal)::int AS last FROM auto_creation_stage WHERE run_id = $1", [runId]);
      if (Number(open.rows[0]?.open ?? 1) !== 0) return false;
      let ordinal = Number(open.rows[0]?.last ?? 0) + 1;
      for (const stageKey of stageKeys) {
        await client.query(
          `INSERT INTO auto_creation_stage (run_id, workspace_id, stage_key, ordinal, state, attempt_no, updated_at)
           VALUES ($1, $2, $3, $4, 'pending', 0, $5)`, [runId, workspaceId, stageKey, ordinal, nowIso]);
        ordinal += 1;
      }
      await client.query("UPDATE auto_creation_run SET revision_rounds_used = $2, updated_at = $3 WHERE id = $1", [runId, round, nowIso]);
      return true;
    });
  }

  async reserveCall(call: AutoCallRecord, limits: { sinceIso: string; maxCallsPerDay: number }, nowIso: string, leaseUntil: string): Promise<AutoCallReservation> {
    return this.transaction(async (client) => {
      // The same lock as every paid text call of the workspace: the shared count and this insert are atomic.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [writingCallLockKey(call.workspaceId)]);
      const run = await this.ownedRun(client, call.workspaceId, call.runId, call.executorId, nowIso);
      if (!run) return { kind: "lost" };
      if (run.cancelRequestedAt !== null) return { kind: "canceled" };
      if (run.callsUsed >= run.callCap) return { kind: "blocked", code: "AUTO_CREATION_RUN_CAP" };
      if (await recentWritingCalls(client, call.workspaceId, limits.sinceIso) >= limits.maxCallsPerDay) return { kind: "blocked", code: "AUTO_CREATION_DAILY_CAP" };
      const stage = await client.query(
        `UPDATE auto_creation_stage SET state = 'reserved', attempt_no = $3, error_code = NULL, updated_at = $4
          WHERE run_id = $1 AND stage_key = $2 AND state = 'pending'`, [call.runId, call.stageKey, call.attemptNo, nowIso]);
      if (stage.rowCount !== 1) return { kind: "lost" };
      await client.query(
        `INSERT INTO auto_creation_call (id, run_id, workspace_id, stage_key, attempt_no, provider_key, model, request_hash, state, executor_id,
           usage_json, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'reserved', $9, $10::jsonb, $11)`,
        [call.id, call.runId, call.workspaceId, call.stageKey, call.attemptNo, call.providerKey, call.model, call.requestHash, call.executorId,
          JSON.stringify(call.usage), call.createdAt]);
      await client.query("UPDATE auto_creation_run SET calls_used = calls_used + 1, lease_until = $2, updated_at = $3 WHERE id = $1",
        [call.runId, leaseUntil, nowIso]);
      return { kind: "reserved" };
    });
  }

  async markCallSubmitted(workspaceId: string, callId: string, executorId: string, nowIso: string, leaseUntil: string): Promise<"submitted" | "canceled" | "lost"> {
    return this.transaction(async (client) => {
      const found = (await client.query<Row>("SELECT run_id, stage_key FROM auto_creation_call WHERE id = $1 AND workspace_id = $2", [callId, workspaceId])).rows[0];
      if (!found) return "lost";
      // The run row lock orders this against requestCancel.
      const run = await this.ownedRun(client, workspaceId, String(found.run_id), executorId, nowIso);
      if (!run) return "lost";
      if (run.cancelRequestedAt !== null) {
        const closed = await client.query(
          "UPDATE auto_creation_call SET state = 'rejected', error_code = $3, finished_at = $4 WHERE id = $1 AND executor_id = $2 AND state = 'reserved'",
          [callId, executorId, TITLE_WRITING_CANCELED_BEFORE_SEND, nowIso]);
        if (closed.rowCount !== 1) return "lost";
        await client.query("UPDATE auto_creation_stage SET state = 'canceled', error_code = NULL, updated_at = $3 WHERE run_id = $1 AND stage_key = $2",
          [run.id, found.stage_key, nowIso]);
        await client.query("UPDATE auto_creation_run SET updated_at = $2 WHERE id = $1", [run.id, nowIso]);
        return "canceled";
      }
      const updated = await client.query("UPDATE auto_creation_call SET state = 'submitted' WHERE id = $1 AND executor_id = $2 AND state = 'reserved'",
        [callId, executorId]);
      if (updated.rowCount !== 1) return "lost";
      await client.query("UPDATE auto_creation_stage SET state = 'submitted', updated_at = $3 WHERE run_id = $1 AND stage_key = $2", [run.id, found.stage_key, nowIso]);
      await client.query("UPDATE auto_creation_run SET lease_until = $2, updated_at = $3 WHERE id = $1", [run.id, leaseUntil, nowIso]);
      return "submitted";
    });
  }

  async finishCall(workspaceId: string, callId: string, executorId: string, patch: AutoCallFinish, nowIso: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const found = (await client.query<Row>("SELECT run_id, stage_key FROM auto_creation_call WHERE id = $1 AND workspace_id = $2", [callId, workspaceId])).rows[0];
      if (!found) return false;
      const runRow = await client.query<Row>("SELECT executor_id FROM auto_creation_run WHERE id = $1 AND workspace_id = $2 FOR UPDATE", [found.run_id, workspaceId]);
      if (runRow.rows[0]?.executor_id !== executorId) return false;
      const updated = await client.query(
        `UPDATE auto_creation_call SET state = $3, error_code = $4, provider_request_id = $5, response_model = $6, usage_json = $7::jsonb, finished_at = $8
          WHERE id = $1 AND executor_id = $2 AND state = 'submitted'`,
        [callId, executorId, patch.state, patch.errorCode, patch.providerRequestId, patch.responseModel, JSON.stringify(patch.usage), nowIso]);
      if (updated.rowCount !== 1) return false;
      await client.query(
        `UPDATE auto_creation_stage SET state = $3, error_code = $4, output_json = $5::jsonb, output_hash = $6, depends_on_json = $7::jsonb, updated_at = $8
          WHERE run_id = $1 AND stage_key = $2`,
        [found.run_id, found.stage_key, patch.state, patch.errorCode, patch.output === null ? null : JSON.stringify(patch.output), patch.outputHash,
          patch.dependsOn === null ? null : JSON.stringify(patch.dependsOn), nowIso]);
      await client.query("UPDATE auto_creation_run SET updated_at = $2 WHERE id = $1", [found.run_id, nowIso]);
      return true;
    });
  }

  async saveStory(workspaceId: string, runId: string, executorId: string, storyText: string, quality: Exclude<AutoCreationQuality, "pending">, nowIso: string): Promise<"saved" | "conflict" | "lost"> {
    return this.transaction(async (client) => {
      const run = await this.ownedRun(client, workspaceId, runId, executorId, nowIso);
      if (!run) return "lost";
      if (run.storySave === "saved") return "saved";
      const project = await client.query<Row>("SELECT version, current_story_revision_id FROM project WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
        [run.projectId, run.workspaceId]);
      const projectRow = project.rows[0];
      if (!projectRow || projectRow.current_story_revision_id !== null) {
        await client.query("UPDATE auto_creation_run SET story_save = 'conflict', quality = $3, updated_at = $2 WHERE id = $1", [runId, nowIso, quality]);
        return "conflict";
      }
      // The story editor's own save path: a DRAFT revision, never reviewed here. The author is the machine run, never a person.
      const created = await this.textChain.createStoryRevisionInTransaction(client, {
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        content: { text: storyText },
        createdBy: `auto-creation:${runId}`,
        expectedVersion: Number(projectRow.version),
        traceId: `auto-creation:${runId}`,
      });
      await client.query("UPDATE auto_creation_run SET story_save = 'saved', story_revision_id = $2, quality = $4, updated_at = $3 WHERE id = $1",
        [runId, created.revisionId, nowIso, quality]);
      return "saved";
    });
  }

  async finishRun(workspaceId: string, runId: string, executorId: string, state: Exclude<TitleWritingRunState, "running">, errorCode: string | null, nowIso: string, quality?: Exclude<AutoCreationQuality, "pending">): Promise<boolean> {
    return this.transaction(async (client) => {
      const updated = await client.query(
        `UPDATE auto_creation_run SET state = $3, error_code = $4, executor_id = NULL, lease_until = NULL, updated_at = $5,
             quality = COALESCE($7, quality)
          WHERE id = $1 AND workspace_id = $6 AND state = 'running' AND executor_id = $2`,
        [runId, executorId, state, errorCode, nowIso, workspaceId, quality ?? null]);
      if (updated.rowCount !== 1) return false;
      if (state === "canceled") {
        await client.query("UPDATE auto_creation_stage SET state = 'canceled', updated_at = $2 WHERE run_id = $1 AND state = 'pending'", [runId, nowIso]);
      }
      return true;
    });
  }

  async requestCancel(workspaceId: string, projectId: string, runId: string, nowIso: string): Promise<AutoRunBundle | null> {
    await this.query(
      `UPDATE auto_creation_run SET cancel_requested_at = $4, updated_at = $4
        WHERE id = $1 AND workspace_id = $2 AND project_id = $3 AND state = 'running' AND cancel_requested_at IS NULL`,
      [runId, workspaceId, projectId, nowIso]);
    return this.getRun(workspaceId, projectId, runId);
  }

  async prepareResume(workspaceId: string, projectId: string, runId: string, request: { resumeKey: string; requestHash: string; confirmedCallIds: readonly string[]; maxActiveRuns: number; providerReady: boolean; blocked: boolean }, nowIso: string): Promise<AutoResumePreparation> {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [runLockKey(workspaceId)]);
      const row = (await client.query<Row>(`SELECT ${RUN_COLUMNS} FROM auto_creation_run WHERE id = $1 AND workspace_id = $2 AND project_id = $3 FOR UPDATE`,
        [runId, workspaceId, projectId])).rows[0];
      if (!row) return { kind: "not_found" };
      const run = toRun(row);
      const previous = await client.query<Row>("SELECT request_hash FROM auto_creation_resume WHERE run_id = $1 AND idempotency_key = $2", [runId, request.resumeKey]);
      if (previous.rows[0]) {
        return String(previous.rows[0].request_hash) === request.requestHash ? { kind: "replayed", bundle: (await this.load(client, row))! } : { kind: "key_conflict" };
      }
      if (run.state === "running") return { kind: "active" };
      if (run.state === "completed") return { kind: "not_resumable" };
      const titles = await client.query<Row>("SELECT to_regclass('title_writing_run') IS NOT NULL AS present");
      const titleProjects = titles.rows[0]?.present === true
        ? (await client.query<Row>("SELECT project_id FROM title_writing_run WHERE workspace_id = $1 AND state = 'running'", [workspaceId])).rows
          .map((item) => String(item.project_id))
        : [];
      // Never alongside a title writing run on the same work (the start paths refuse the same overlap).
      if (titleProjects.includes(projectId)) return { kind: "active" };
      const titleRunning = titleProjects.length;
      // Automatic creation runs and series jobs share the cap; a work a series job is writing takes no automatic run.
      const others = await runningWritingRuns(client, workspaceId);
      if (others.some((item) => item.kind === "series" && item.projectId === projectId)) return { kind: "active" };
      const autoRunning = others.length;
      if (titleRunning + autoRunning >= request.maxActiveRuns) return { kind: "active_cap" };
      const stages = (await client.query<Row>(`SELECT ${STAGE_COLUMNS} FROM auto_creation_stage WHERE run_id = $1`, [runId])).rows.map(toStage);
      const calls = (await client.query<Row>("SELECT id, stage_key, attempt_no, state FROM auto_creation_call WHERE run_id = $1", [runId])).rows
        .map((item) => ({ callId: String(item.id), stepKey: String(item.stage_key) as TitleWritingStepKey, attemptNo: Number(item.attempt_no), state: item.state as AutoCallRecord["state"] }));
      const uncertain = currentUncertainCallIds(stages.map((stage) => ({ stepKey: stage.stageKey as TitleWritingStepKey, state: stage.state, attemptNo: stage.attemptNo })), calls);
      const confirmed = [...request.confirmedCallIds].sort();
      if (uncertain.length > 0 && confirmed.length === 0) return { kind: "needs_confirmation" };
      if (uncertain.length !== confirmed.length || uncertain.some((id, index) => id !== confirmed[index])) return { kind: "stale_confirmation" };
      const redo = stages.filter((stage) => stage.state === "unknown" || stage.state === "rejected" || stage.state === "canceled");
      // Nothing to redo and nothing a second save could change (a story too large to save stays too large): final.
      if (redo.length === 0 && (run.storySave !== "pending" || autoRunSettledForGood(run, stages))) return { kind: "not_resumable" };
      if (request.blocked) return { kind: "blocked" };
      const sends = redo.some((stage) => stage.stageKey !== "sources") || stages.some((stage) => stage.state === "pending" && stage.stageKey !== "sources");
      if (sends && !request.providerReady) return { kind: "provider_unconfigured" };
      // The run's frozen call budget is spent: resetting a stage could only stop again before the send.
      if (sends && run.callsUsed >= run.callCap) return { kind: "budget_exhausted" };
      await client.query(
        `INSERT INTO auto_creation_resume (run_id, workspace_id, idempotency_key, request_hash, confirmed_call_ids, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`, [runId, workspaceId, request.resumeKey, request.requestHash, JSON.stringify(confirmed), nowIso]);
      await client.query("UPDATE auto_creation_stage SET state = 'pending', updated_at = $2 WHERE run_id = $1 AND state IN ('unknown', 'rejected', 'canceled')",
        [runId, nowIso]);
      const updated = await client.query<Row>(
        `UPDATE auto_creation_run SET state = 'running', error_code = NULL, cancel_requested_at = NULL, executor_id = NULL, lease_until = NULL, updated_at = $2
          WHERE id = $1 RETURNING ${RUN_COLUMNS}`, [runId, nowIso]);
      return { kind: "ok", bundle: (await this.load(client, updated.rows[0]))! };
    });
  }

  async recoverExpired(workspaceId: string, nowIso: string): Promise<number> {
    return this.transaction(async (client) => {
      const expired = await client.query<Row>(
        `SELECT id FROM auto_creation_run WHERE workspace_id = $2 AND state = 'running' AND executor_id IS NOT NULL AND lease_until <= $1
          ORDER BY lease_until LIMIT 50 FOR UPDATE SKIP LOCKED`, [nowIso, workspaceId]);
      for (const row of expired.rows) {
        const runId = String(row.id);
        const neverSent = await client.query<Row>(
          `UPDATE auto_creation_call SET state = 'rejected', error_code = 'executor_lost_before_send', finished_at = $2
            WHERE run_id = $1 AND state = 'reserved' RETURNING stage_key`, [runId, nowIso]);
        for (const call of neverSent.rows) {
          await client.query("UPDATE auto_creation_stage SET state = 'pending', updated_at = $3 WHERE run_id = $1 AND stage_key = $2", [runId, call.stage_key, nowIso]);
        }
        const maybeSent = await client.query<Row>(
          `UPDATE auto_creation_call SET state = 'unknown', error_code = 'executor_lost', finished_at = $2
            WHERE run_id = $1 AND state = 'submitted' RETURNING stage_key`, [runId, nowIso]);
        for (const call of maybeSent.rows) {
          await client.query("UPDATE auto_creation_stage SET state = 'unknown', error_code = 'executor_lost', updated_at = $3 WHERE run_id = $1 AND stage_key = $2",
            [runId, call.stage_key, nowIso]);
        }
        await client.query(maybeSent.rows.length > 0
          ? "UPDATE auto_creation_run SET state = 'needs_attention', error_code = 'executor_lost', executor_id = NULL, lease_until = NULL, updated_at = $2 WHERE id = $1"
          : "UPDATE auto_creation_run SET executor_id = NULL, lease_until = NULL, updated_at = $2 WHERE id = $1", [runId, nowIso]);
      }
      return expired.rows.length;
    });
  }

  async listClaimable(workspaceId: string, nowIso: string, limit: number): Promise<string[]> {
    const result = await this.query(
      `SELECT id FROM auto_creation_run WHERE workspace_id = $3 AND state = 'running' AND (executor_id IS NULL OR lease_until <= $1)
        ORDER BY updated_at LIMIT $2`, [nowIso, limit, workspaceId]);
    return result.rows.map((row) => String(row.id));
  }

  async placeScripts(workspaceId: string, projectId: string, runId: string, scripts: ReadonlyArray<{ episodeNo: number; stageKey: string; text: string }>, options: { acceptStoryChanged: boolean }, actorId: string, nowIso: string): Promise<AutoScriptPlacement> {
    return this.transaction(async (client) => {
      const runRow = (await client.query<Row>(`SELECT ${RUN_COLUMNS} FROM auto_creation_run WHERE id = $1 AND workspace_id = $2 AND project_id = $3 FOR UPDATE`,
        [runId, workspaceId, projectId])).rows[0];
      if (!runRow) return { kind: "not_found" };
      const run = toRun(runRow);
      if (run.state === "running" || scripts.length !== run.input.episodeCount) return { kind: "not_ready" };
      // Only a complete package (every stage, the final review included) is ever placed.
      const unfinished = await client.query<Row>(
        `SELECT count(*) FILTER (WHERE state <> 'completed')::int AS open, count(*) FILTER (WHERE stage_key LIKE 'review:%')::int AS reviews
           FROM auto_creation_stage WHERE run_id = $1`, [runId]);
      if (Number(unfinished.rows[0]?.open ?? 1) !== 0 || Number(unfinished.rows[0]?.reviews ?? 0) === 0) return { kind: "not_ready" };
      // The run's own story must have been saved into this work; accepting a later edit never stands in for that story.
      if (run.storySave !== "saved" || run.storyRevisionId === null) return { kind: "story_not_saved" };
      const own = await client.query("SELECT 1 FROM story_revision WHERE id = $1 AND project_id = $2 AND workspace_id = $3", [run.storyRevisionId, projectId, workspaceId]);
      if (!own.rows[0]) return { kind: "story_not_saved" };
      // Project → episode, the order of the script editor's save.
      const locked = await client.query("SELECT id FROM project WHERE id = $1 AND workspace_id = $2 FOR UPDATE", [projectId, workspaceId]);
      if (!locked.rows[0]) return { kind: "not_found" };
      const project = (await client.query<Row>(
        `SELECT p.current_story_revision_id, p.approved_story_revision_id, sr.review_status, sr.freshness_status
           FROM project p LEFT JOIN story_revision sr ON sr.id = p.approved_story_revision_id WHERE p.id = $1 AND p.workspace_id = $2`,
        [projectId, workspaceId])).rows[0];
      const approved = project?.approved_story_revision_id as string | null | undefined;
      if (!approved || project?.current_story_revision_id !== approved || project.review_status !== "APPROVED" || project.freshness_status !== "CURRENT") {
        return { kind: "story_not_approved" };
      }
      if (approved !== run.storyRevisionId && !options.acceptStoryChanged) return { kind: "story_changed" };
      const episodes = await client.query<Row>(
        "SELECT id, episode_no, row_version, current_script_revision_id FROM episode WHERE project_id = $1 AND workspace_id = $2 ORDER BY episode_no FOR UPDATE",
        [projectId, workspaceId]);
      const plan = await projectEpisodePlanIn(client, workspaceId, projectId);
      const numbers = episodes.rows.map((row) => Number(row.episode_no));
      if (plan.episodeCount !== run.input.episodeCount || numbers.length !== run.input.episodeCount || numbers.some((episodeNo, index) => episodeNo !== index + 1)) {
        return { kind: "plan_mismatch" };
      }
      const stages = (await client.query<Row>(`SELECT ${STAGE_COLUMNS} FROM auto_creation_stage WHERE run_id = $1 AND script_save IS NOT NULL`, [runId])).rows.map(toStage);
      for (const episode of episodes.rows) {
        const stageKey = `episode:${String(episode.episode_no)}`;
        const stage = stages.find((item) => item.stageKey === stageKey);
        const script = scripts.find((item) => item.episodeNo === Number(episode.episode_no));
        if (!stage || !script || stage.scriptSave === "saved") continue;
        if (episode.current_script_revision_id !== null) {
          await client.query("UPDATE auto_creation_stage SET script_save = 'conflict', updated_at = $3 WHERE run_id = $1 AND stage_key = $2", [runId, stageKey, nowIso]);
          continue;
        }
        const created = await this.textChain.createScriptRevisionInTransaction(client, {
          workspaceId, projectId, episodeId: String(episode.id), sourceStoryRevisionId: approved, content: { text: script.text },
          createdBy: actorId, expectedVersion: Number(episode.row_version), traceId: `auto-creation:${runId}`,
        });
        await client.query("UPDATE auto_creation_stage SET script_save = 'saved', script_revision_id = $3, updated_at = $4 WHERE run_id = $1 AND stage_key = $2",
          [runId, stageKey, created.revisionId, nowIso]);
      }
      await client.query("UPDATE auto_creation_run SET updated_at = $2 WHERE id = $1", [runId, nowIso]);
      return { kind: "ok", bundle: (await this.load(client, runRow))! };
    });
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
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
