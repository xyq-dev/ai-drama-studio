import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import {
  TITLE_WRITING_CANCELED_BEFORE_SEND,
  currentUncertainCallIds,
  type EpisodeDraftCandidate,
  type TitleWritingFrozenInput,
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
  type TitleRunRecord,
  type TitleScriptPlacement,
  type TitleStepRecord,
  type TitleWritingStore,
} from "@ai-drama/contracts";
import { formatTitleEpisode } from "@ai-drama/domain";
import type { DatabasePool } from "./job-service";
import type { TextChainService } from "./text-chain";

/**
 * PostgreSQL storage for title-driven writing runs. The tables come from the unapplied draft
 * prisma/drafts/20261008000100_title_writing.sql; until they exist storageReady() is false and callers refuse before any
 * send. There is no in-memory fallback in the runtime.
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

const RUN_COLUMNS = TITLE_WRITING_TABLES.title_writing_run.join(", ");
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
    input: row.input_json as TitleWritingFrozenInput,
    state: row.state as TitleWritingRunState,
    errorCode: (row.error_code as string | null) ?? null,
    cancelRequestedAt: isoOrNull(row.cancel_requested_at),
    executorId: (row.executor_id as string | null) ?? null,
    leaseUntil: isoOrNull(row.lease_until),
    callCap: Number(row.call_cap),
    callsUsed: Number(row.calls_used),
    storySave: row.story_save as TitleRunRecord["storySave"],
    storyRevisionId: (row.story_revision_id as string | null) ?? null,
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

const EPISODE_STEPS: Record<number, TitleWritingStepKey> = { 1: "episode:1", 2: "episode:2", 3: "episode:3" };

export class PostgresTitleWritingStore implements TitleWritingStore {
  constructor(private readonly pool: DatabasePool, private readonly textChain: TextChainService) {}

  /** True only when all three draft tables exist with every column this store reads or writes. */
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

  private async load(client: PoolClient | null, runRow: Row | undefined): Promise<TitleRunBundle | null> {
    if (!runRow) return null;
    const run = toRun(runRow);
    const run1 = client ? client.query.bind(client) : this.query.bind(this);
    const steps = await run1(`SELECT ${STEP_COLUMNS} FROM title_writing_step WHERE run_id = $1 ORDER BY ordinal`, [run.id]) as QueryResult<Row>;
    const calls = await run1(`SELECT ${CALL_COLUMNS} FROM title_writing_call WHERE run_id = $1 ORDER BY created_at, attempt_no`, [run.id]) as QueryResult<Row>;
    return { run, steps: steps.rows.map(toStep), calls: calls.rows.map(toCall) };
  }

  async createRun(run: TitleRunRecord, limits: { maxActiveRuns: number }): Promise<TitleRunCreation> {
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
      if (active.rows.length >= limits.maxActiveRuns) return { kind: "blocked", code: "TITLE_WRITING_ACTIVE_RUN_CAP" };
      const inserted = await client.query<Row>(
        `INSERT INTO title_writing_run (id, workspace_id, project_id, actor_id, idempotency_key, input_hash, input_json, provider_key,
           model, state, call_cap, calls_used, story_save, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 'running', $10, 0, 'pending', $11, $11)
         RETURNING ${RUN_COLUMNS}`,
        [run.id, run.workspaceId, run.projectId, run.actorId, run.idempotencyKey, run.inputHash, JSON.stringify(run.input),
          run.input.providerKey, run.input.model, run.callCap, run.createdAt],
      );
      const keys = ["concept", "outline", "episode:1", "episode:2", "episode:3"] as const;
      for (const [ordinal, stepKey] of keys.entries()) {
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
      `SELECT ${RUN_COLUMNS} FROM title_writing_run WHERE workspace_id = $1 AND project_id = $2
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
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`title_writing_call:${call.workspaceId}`]);
      const run = await this.ownedRun(client, call.workspaceId, call.runId, call.executorId, nowIso);
      if (!run) return { kind: "lost" };
      if (run.cancelRequestedAt !== null) return { kind: "canceled" };
      if (run.callsUsed >= run.callCap) return { kind: "blocked", code: "TITLE_WRITING_RUN_CAP" };
      const recent = await client.query<Row>(
        "SELECT count(*)::int AS recent FROM title_writing_call WHERE workspace_id = $1 AND created_at >= $2",
        [call.workspaceId, limits.sinceIso],
      );
      if (Number(recent.rows[0]?.recent ?? 0) >= limits.maxCallsPerDay) return { kind: "blocked", code: "TITLE_WRITING_DAILY_CAP" };
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
      if (running.rows.length >= request.maxActiveRuns) return { kind: "active_cap" };
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
      if (redo.length === 0 && run.storySave !== "pending") return { kind: "not_resumable" };
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

  async listClaimable(workspaceId: string, nowIso: string, limit: number): Promise<string[]> {
    const result = await this.query(
      `SELECT id FROM title_writing_run
        WHERE workspace_id = $3 AND state = 'running' AND (executor_id IS NULL OR lease_until <= $1)
        ORDER BY updated_at LIMIT $2`,
      [nowIso, limit, workspaceId],
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
      for (const episode of episodes.rows) {
        const stepKey = EPISODE_STEPS[Number(episode.episode_no)];
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
          content: { text: formatTitleEpisode(step.output as EpisodeDraftCandidate) },
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
