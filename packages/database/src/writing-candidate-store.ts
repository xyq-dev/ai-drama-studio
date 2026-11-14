import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { Buffer } from "node:buffer";
import type {
  ScriptWorkbenchScript,
  ShortSequelAiAttempt,
  ShortSequelAiInput,
  TitleWritingProviderKey,
  TitleWritingUsageView,
  WritingCandidateCreation,
  WritingCandidateFinish,
  WritingCandidateFrozenInput,
  WritingCandidateMode,
  WritingCandidateOutput,
  WritingCandidateRecord,
  WritingCandidateState,
  WritingCandidateStore,
} from "@ai-drama/contracts";
import { SERIES_NEVER_SENT_ERROR_CODES, SHORT_SEQUEL_AI_SCHEMA } from "@ai-drama/contracts";
import { PersistenceError, type DatabasePool } from "./job-service";
import { WRITING_CANDIDATE_DEEPSEEK_MIGRATION, WRITING_CANDIDATE_MIGRATION } from "./migrations";
import { shortSequelAiStale, shortSequelContextIn } from "./short-sequel";

export { WRITING_CANDIDATE_MIGRATION };

/** Every column this store reads or writes. Until all exist (and the migration is recorded), storageReady() is false. */
export const WRITING_CANDIDATE_COLUMNS = [
  "id", "workspace_id", "project_id", "actor_id", "idempotency_key", "request_hash", "input_json", "mode", "episode_id",
  "episode_no", "source_revision_id", "if_match", "provider_key", "model", "state", "executor_id", "lease_until", "error_code",
  "provider_request_id", "response_model", "usage_json", "billing_status", "candidate_json", "confirmed_request_id",
  "created_at", "finished_at",
] as const;
const COLUMNS = WRITING_CANDIDATE_COLUMNS.join(", ");
const SEQUEL_ROW = `input_json->>'schema' = '${SHORT_SEQUEL_AI_SCHEMA}'`;
const REGULAR_ROW = `input_json->>'schema' IS DISTINCT FROM '${SHORT_SEQUEL_AI_SCHEMA}'`;
const OPEN_SEQUEL_STATE = `state IN ('reserved', 'submitted') AND ${SEQUEL_ROW}`;
const SHORT_SEQUEL_PAGE_SIZE = 11;
const SEQUEL_CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SEQUEL_CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;

type Row = QueryResultRow & Record<string, unknown>;

function decodeSequelCursor(raw: string | undefined, workspaceId: string, projectId: string, episodeId: string) {
  if (raw === undefined) return null;
  try {
    if (!/^[A-Za-z0-9_-]{1,512}$/u.test(raw)) throw new Error();
    const cursor = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown>;
    if (cursor.v !== 1 || cursor.workspaceId !== workspaceId || cursor.projectId !== projectId || cursor.episodeId !== episodeId
      || typeof cursor.at !== "string" || !SEQUEL_CURSOR_TIME.test(cursor.at)
      || typeof cursor.id !== "string" || !SEQUEL_CURSOR_ID.test(cursor.id)) throw new Error();
    if (new Date(cursor.at).toISOString().slice(0, 23) !== cursor.at.slice(0, 23)) throw new Error();
    return { at: cursor.at, id: cursor.id };
  } catch {
    throw new PersistenceError("VALIDATION_ERROR", "续写记录分页已失效，请重新加载。");
  }
}

function iso(value: unknown): string {
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}

function toRecord(row: Row): WritingCandidateRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    projectId: String(row.project_id),
    actorId: String(row.actor_id),
    idempotencyKey: String(row.idempotency_key),
    requestHash: String(row.request_hash),
    // Written only by create() after the service validated it.
    input: row.input_json as WritingCandidateFrozenInput,
    state: row.state as WritingCandidateState,
    executorId: (row.executor_id as string | null) ?? null,
    leaseUntil: row.lease_until === null || row.lease_until === undefined ? null : iso(row.lease_until),
    errorCode: (row.error_code as string | null) ?? null,
    providerRequestId: (row.provider_request_id as string | null) ?? null,
    responseModel: (row.response_model as string | null) ?? null,
    usage: row.usage_json as TitleWritingUsageView,
    // Written only after the answer passed the same checks as a pasted candidate.
    candidate: (row.candidate_json ?? null) as WritingCandidateOutput | null,
    confirmedRequestId: (row.confirmed_request_id as string | null) ?? null,
    createdAt: iso(row.created_at),
    finishedAt: row.finished_at === null || row.finished_at === undefined ? null : iso(row.finished_at),
  };
}

function toSequelAttempt(row: Row): ShortSequelAiAttempt {
  return {
    id: String(row.id), workspaceId: String(row.workspace_id), projectId: String(row.project_id), actorId: String(row.actor_id),
    idempotencyKey: String(row.idempotency_key), requestHash: String(row.request_hash), input: row.input_json as ShortSequelAiInput,
    state: row.state as WritingCandidateState, errorCode: (row.error_code as string | null) ?? null,
    executorId: (row.executor_id as string | null) ?? null, leaseUntil: row.lease_until == null ? null : iso(row.lease_until),
    script: (row.candidate_json as ScriptWorkbenchScript | null) ?? null, usage: row.usage_json as TitleWritingUsageView,
    createdAt: iso(row.created_at), finishedAt: row.finished_at == null ? null : iso(row.finished_at),
  };
}

async function sequelTargetProblem(client: PoolClient, { workspaceId, projectId, input }: ShortSequelAiAttempt):
  Promise<"source_changed" | "body_exists" | null> {
  try {
    const context = await shortSequelContextIn(client, { workspaceId, projectId }, input.episodeNo);
    if (context.hasBody) return "body_exists";
    return shortSequelAiStale(input, context) ? "source_changed" : null;
  } catch (error) {
    if (error instanceof PersistenceError && (error.code === "NOT_FOUND" || error.code === "SOURCE_STALE")) return "source_changed";
    throw error;
  }
}

type ShortSequelCreation = { kind: "created" | "existing"; attempt: ShortSequelAiAttempt }
  | { kind: "advanced"; attempt: ShortSequelAiAttempt }
  | { kind: "conflict" | "active" | "source_changed" | "body_exists" | "needs_confirmation" | "daily_cap" | "active_cap" };

/**
 * Calls made in the rolling window by title writing, online candidates and automatic creation together: one daily cap
 * covers every paid text call of the workspace. A table may not exist yet (its migration not applied); it then counts zero.
 * Callers hold the workspace call lock (title_writing_call:<workspace>), so the count and their insert are atomic.
 */
export async function recentWritingCalls(client: PoolClient, workspaceId: string, sinceIso: string): Promise<number> {
  const present = await client.query<Row>(
    `SELECT to_regclass('title_writing_call') IS NOT NULL AS title, to_regclass('writing_candidate_request') IS NOT NULL AS candidate,
            to_regclass('auto_creation_call') IS NOT NULL AS auto, to_regclass('series_writing_call') IS NOT NULL AS series,
            to_regclass('vimax_planning_request') IS NOT NULL AS vimax`,
  );
  let total = 0;
  if (present.rows[0]?.title === true) {
    const titles = await client.query<Row>(
      "SELECT count(*)::int AS recent FROM title_writing_call WHERE workspace_id = $1 AND created_at >= $2", [workspaceId, sinceIso]);
    total += Number(titles.rows[0]?.recent ?? 0);
  }
  if (present.rows[0]?.candidate === true) {
    const candidates = await client.query<Row>(
      "SELECT count(*)::int AS recent FROM writing_candidate_request WHERE workspace_id = $1 AND created_at >= $2", [workspaceId, sinceIso]);
    total += Number(candidates.rows[0]?.recent ?? 0);
  }
  if (present.rows[0]?.auto === true) {
    const autos = await client.query<Row>(
      "SELECT count(*)::int AS recent FROM auto_creation_call WHERE workspace_id = $1 AND created_at >= $2", [workspaceId, sinceIso]);
    total += Number(autos.rows[0]?.recent ?? 0);
  }
  if (present.rows[0]?.series === true) {
    // A series call that was never sent (given back by recovery, or closed by a cancel before its send) counts nowhere.
    const series = await client.query<Row>(
      `SELECT count(*)::int AS recent FROM series_writing_call
        WHERE workspace_id = $1 AND created_at >= $2 AND NOT (state = 'rejected' AND error_code = ANY($3::text[]))`,
      [workspaceId, sinceIso, [...SERIES_NEVER_SENT_ERROR_CODES]]);
    total += Number(series.rows[0]?.recent ?? 0);
  }
  if (present.rows[0]?.vimax === true) {
    // Planning reserves a single call. Every reservation occupies the cap for 24 h, including canceled/unsent ones.
    // This conservative accounting is explicit in its API/UI; it is not a claim of actual sends or charges.
    const planning = await client.query<Row>(
      "SELECT count(*)::int AS recent FROM vimax_planning_request WHERE workspace_id = $1 AND created_at >= $2", [workspaceId, sinceIso]);
    total += Number(planning.rows[0]?.recent ?? 0);
  }
  return total;
}

/**
 * Running automatic creation, series, planning and short-sequel work of a workspace (each optional table probed on its own): they share the
 * concurrency cap with title writing runs, and a work one of them is writing takes no other run.
 */
export async function runningWritingRuns(client: PoolClient, workspaceId: string): Promise<Array<{ kind: "auto" | "series" | "vimax" | "short_sequel"; id: string; projectId: string }>> {
  const present = await client.query<Row>(
    "SELECT to_regclass('auto_creation_run') IS NOT NULL AS auto, to_regclass('series_writing_run') IS NOT NULL AS series, to_regclass('vimax_planning_request') IS NOT NULL AS vimax, to_regclass('writing_candidate_request') IS NOT NULL AS candidate");
  const runs: Array<{ kind: "auto" | "series" | "vimax" | "short_sequel"; id: string; projectId: string }> = [];
  if (present.rows[0]?.auto === true) {
    const autos = await client.query<Row>("SELECT id, project_id FROM auto_creation_run WHERE workspace_id = $1 AND state = 'running'", [workspaceId]);
    runs.push(...autos.rows.map((row) => ({ kind: "auto" as const, id: String(row.id), projectId: String(row.project_id) })));
  }
  if (present.rows[0]?.series === true) {
    const series = await client.query<Row>("SELECT id, project_id FROM series_writing_run WHERE workspace_id = $1 AND state = 'running'", [workspaceId]);
    runs.push(...series.rows.map((row) => ({ kind: "series" as const, id: String(row.id), projectId: String(row.project_id) })));
  }
  if (present.rows[0]?.vimax === true) {
    const planning = await client.query<Row>("SELECT id, project_id FROM vimax_planning_request WHERE workspace_id = $1 AND state IN ('reserved','submitted')", [workspaceId]);
    runs.push(...planning.rows.map((row) => ({ kind: "vimax" as const, id: String(row.id), projectId: String(row.project_id) })));
  }
  if (present.rows[0]?.candidate === true) {
    const sequels = await client.query<Row>(`SELECT id, project_id FROM writing_candidate_request
      WHERE workspace_id = $1 AND ${OPEN_SEQUEL_STATE}`, [workspaceId]);
    runs.push(...sequels.rows.map((row) => ({ kind: "short_sequel" as const, id: String(row.id), projectId: String(row.project_id) })));
  }
  return runs;
}

/** The lock key every paid text call of a workspace is reserved under (title writing calls and online candidates). */
export function writingCallLockKey(workspaceId: string): string {
  return `title_writing_call:${workspaceId}`;
}

export class PostgresWritingCandidateStore implements WritingCandidateStore {
  // Once applied a migration stays applied, so only a positive answer is remembered.
  private readyConfirmed = false;
  private deepseekConfirmed = false;

  constructor(private readonly pool: DatabasePool) {}

  /**
   * openai and anthropic once storageReady(); deepseek only after 20261017000100_writing_candidate_deepseek is recorded
   * and the live provider_key CHECK names deepseek (the ledger alone is not trusted).
   */
  async providerStorageReady(providerKey: TitleWritingProviderKey): Promise<boolean> {
    if (!(await this.storageReady())) return false;
    if (providerKey !== "deepseek" || this.deepseekConfirmed) return true;
    try {
      const recorded = await this.query("SELECT 1 FROM schema_migration WHERE name = $1", [WRITING_CANDIDATE_DEEPSEEK_MIGRATION]);
      if (!recorded.rows[0]) return false;
      const checks = await this.query(
        `SELECT count(*)::int AS allowed FROM pg_constraint
          WHERE conrelid = to_regclass('writing_candidate_request') AND contype = 'c'
            AND pg_get_constraintdef(oid) LIKE '%provider_key%' AND pg_get_constraintdef(oid) LIKE '%''deepseek''%'`, []);
      this.deepseekConfirmed = Number(checks.rows[0]?.allowed) === 1;
      return this.deepseekConfirmed;
    } catch {
      return false;
    }
  }

  async storageReady(): Promise<boolean> {
    if (this.readyConfirmed) return true;
    try {
      const ledger = await this.query("SELECT to_regclass('schema_migration') IS NOT NULL AS present", []);
      if (ledger.rows[0]?.present !== true) return false;
      const recorded = await this.query("SELECT 1 FROM schema_migration WHERE name = $1", [WRITING_CANDIDATE_MIGRATION]);
      if (!recorded.rows[0]) return false;
      const columns = await this.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'writing_candidate_request'`, []);
      const present = new Set(columns.rows.map((row) => String(row.column_name)));
      this.readyConfirmed = WRITING_CANDIDATE_COLUMNS.every((column) => present.has(column));
      return this.readyConfirmed;
    } catch {
      return false;
    }
  }

  async create(record: WritingCandidateRecord, limits: { sinceIso: string; maxCallsPerDay: number }): Promise<WritingCandidateCreation> {
    return this.transaction(async (client) => {
      // The same lock as a title writing call reservation: key lookup, target checks, the shared cap and the insert are
      // atomic against every other paid text call of the workspace.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [writingCallLockKey(record.workspaceId)]);
      const existing = await client.query<Row>(
        `SELECT ${COLUMNS} FROM writing_candidate_request WHERE workspace_id = $1 AND actor_id = $2 AND idempotency_key = $3`,
        [record.workspaceId, record.actorId, record.idempotencyKey],
      );
      const found = existing.rows[0];
      if (found) {
        return (found.input_json as { schema?: string }).schema !== SHORT_SEQUEL_AI_SCHEMA
          && String(found.request_hash) === record.requestHash && String(found.project_id) === record.projectId
          ? { kind: "existing", record: toRecord(found) } : { kind: "conflict" };
      }
      const { input } = record;
      const invalid = await this.targetProblem(client, record.workspaceId, input);
      if (invalid) return { kind: "target_invalid", reason: invalid };
      const params = [record.workspaceId, record.projectId, input.mode, input.episodeId];
      const recentTarget = `SELECT ${COLUMNS} FROM writing_candidate_request
        WHERE workspace_id = $1 AND project_id = $2 AND mode = $3 AND episode_id IS NOT DISTINCT FROM $4`;
      const open = (await client.query<Row>(`${recentTarget} AND state IN ('reserved','submitted') LIMIT 1`, params)).rows[0];
      if (open) return { kind: "active", requestId: String(open.id) };
      const latest = (await client.query<Row>(`${recentTarget} AND ${REGULAR_ROW} ORDER BY created_at DESC, id DESC LIMIT 1`, params)).rows[0];
      if (latest && latest.state === "unknown" && record.confirmedRequestId !== String(latest.id)) {
        return { kind: "needs_confirmation", requestId: String(latest.id) };
      }
      if (await recentWritingCalls(client, record.workspaceId, limits.sinceIso) >= limits.maxCallsPerDay) {
        return { kind: "blocked", code: "WRITING_CANDIDATE_DAILY_CAP" };
      }
      const inserted = await client.query<Row>(
        `INSERT INTO writing_candidate_request (id, workspace_id, project_id, actor_id, idempotency_key, request_hash, input_json,
           mode, episode_id, episode_no, source_revision_id, if_match, provider_key, model, state, executor_id, lease_until,
           usage_json, confirmed_request_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, 'reserved', $15, $16, $17::jsonb, $18, $19)
         RETURNING ${COLUMNS}`,
        [record.id, record.workspaceId, record.projectId, record.actorId, record.idempotencyKey, record.requestHash,
          JSON.stringify(input), input.mode, input.episodeId, input.episodeNo, input.base.sourceRevisionId, input.base.ifMatch,
          input.providerKey, input.model, record.executorId, record.leaseUntil, JSON.stringify(record.usage),
          record.confirmedRequestId, record.createdAt],
      );
      return { kind: "created", record: toRecord(inserted.rows[0]!) };
    });
  }

  /** The story of a three-episode work, or one episode of this work with its own number; the base revision is the target's. */
  private async targetProblem(client: PoolClient, workspaceId: string, input: WritingCandidateFrozenInput):
    Promise<"episode" | "base_revision" | "episode_plan" | null> {
    const source = input.base.sourceRevisionId;
    if (input.mode === "story") {
      const project = await client.query<Row>(
        "SELECT COALESCE((to_jsonb(project) ->> 'episode_count')::int, 3) AS episodes FROM project WHERE id = $1 AND workspace_id = $2",
        [input.projectId, workspaceId]);
      if (Number(project.rows[0]?.episodes) !== 3) return "episode_plan";
      if (source === null) return null;
      const revision = await client.query("SELECT 1 FROM story_revision WHERE id = $1 AND project_id = $2 AND workspace_id = $3",
        [source, input.projectId, workspaceId]);
      return revision.rows[0] ? null : "base_revision";
    }
    const episode = await client.query<Row>("SELECT episode_no FROM episode WHERE id = $1 AND project_id = $2 AND workspace_id = $3",
      [input.episodeId, input.projectId, workspaceId]);
    if (!episode.rows[0] || Number(episode.rows[0].episode_no) !== input.episodeNo) return "episode";
    if (source === null) return null;
    const revision = await client.query("SELECT 1 FROM script_revision WHERE id = $1 AND episode_id = $2 AND workspace_id = $3",
      [source, input.episodeId, workspaceId]);
    return revision.rows[0] ? null : "base_revision";
  }

  async findByKey(workspaceId: string, actorId: string, idempotencyKey: string): Promise<WritingCandidateRecord | null> {
    const result = await this.query(
      `SELECT ${COLUMNS} FROM writing_candidate_request WHERE workspace_id = $1 AND actor_id = $2 AND idempotency_key = $3 AND ${REGULAR_ROW}`,
      [workspaceId, actorId, idempotencyKey]);
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async get(workspaceId: string, projectId: string, requestId: string): Promise<WritingCandidateRecord | null> {
    const result = await this.query(`SELECT ${COLUMNS} FROM writing_candidate_request WHERE id = $1 AND workspace_id = $2 AND project_id = $3 AND ${REGULAR_ROW}`,
      [requestId, workspaceId, projectId]);
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async getById(workspaceId: string, requestId: string): Promise<WritingCandidateRecord | null> {
    const result = await this.query(`SELECT ${COLUMNS} FROM writing_candidate_request WHERE id = $1 AND workspace_id = $2 AND ${REGULAR_ROW}`, [requestId, workspaceId]);
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async listForTarget(workspaceId: string, projectId: string, target: { mode: WritingCandidateMode; episodeId: string | null }, limit: number): Promise<WritingCandidateRecord[]> {
    const result = await this.query(
      `SELECT ${COLUMNS} FROM writing_candidate_request
        WHERE workspace_id = $1 AND project_id = $2 AND mode = $3 AND episode_id IS NOT DISTINCT FROM $4 AND ${REGULAR_ROW}
        ORDER BY created_at DESC, id DESC LIMIT $5`,
      [workspaceId, projectId, target.mode, target.episodeId, limit]);
    return result.rows.map(toRecord);
  }

  async markSubmitted(workspaceId: string, requestId: string, executorId: string, nowIso: string, leaseUntil: string): Promise<boolean> {
    const result = await this.query(
      `UPDATE writing_candidate_request SET state = 'submitted', lease_until = $5
        WHERE id = $1 AND workspace_id = $2 AND executor_id = $3 AND state = 'reserved' AND lease_until > $4`,
      [requestId, workspaceId, executorId, nowIso, leaseUntil]);
    return result.rowCount === 1;
  }

  async closeUnsent(workspaceId: string, requestId: string, executorId: string, errorCode: string, nowIso: string): Promise<boolean> {
    const result = await this.query(
      `UPDATE writing_candidate_request SET state = 'rejected', error_code = $4, executor_id = NULL, lease_until = NULL, finished_at = $5
        WHERE id = $1 AND workspace_id = $2 AND executor_id = $3 AND state = 'reserved'`,
      [requestId, workspaceId, executorId, errorCode, nowIso]);
    return result.rowCount === 1;
  }

  /** Conditional on the executor and the submitted state: a late executor after recovery changes nothing. */
  async finish(workspaceId: string, requestId: string, executorId: string, patch: WritingCandidateFinish, nowIso: string): Promise<boolean> {
    return this.finishRecord(workspaceId, requestId, executorId, patch, nowIso);
  }

  async finishShortSequel(workspaceId: string, requestId: string, executorId: string,
    patch: Omit<WritingCandidateFinish, "candidate"> & { candidate: ScriptWorkbenchScript | null }, nowIso: string): Promise<boolean> {
    return this.finishRecord(workspaceId, requestId, executorId, patch, nowIso);
  }

  private async finishRecord(workspaceId: string, requestId: string, executorId: string,
    patch: Omit<WritingCandidateFinish, "candidate"> & { candidate: unknown }, nowIso: string): Promise<boolean> {
    const result = await this.query(
      `UPDATE writing_candidate_request SET state = $4, error_code = $5, provider_request_id = $6, response_model = $7,
         usage_json = $8::jsonb, candidate_json = $9::jsonb, executor_id = NULL, lease_until = NULL, finished_at = $10
        WHERE id = $1 AND workspace_id = $2 AND executor_id = $3 AND state = 'submitted'`,
      [requestId, workspaceId, executorId, patch.state, patch.errorCode, patch.providerRequestId, patch.responseModel,
        JSON.stringify(patch.usage), patch.candidate === null ? null : JSON.stringify(patch.candidate), nowIso]);
    return result.rowCount === 1;
  }

  async createShortSequel(attempt: ShortSequelAiAttempt, options: {
    nowIso: string; sinceIso: string; maxCallsPerDay: number; maxActiveRuns: number;
    expectedAttemptId: string | null; confirmUncertainAttemptId: string | null;
  }): Promise<ShortSequelCreation> {
    return this.transaction(async client => {
      const { workspaceId, projectId, input } = attempt;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`title_writing_run:${workspaceId}`]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [writingCallLockKey(workspaceId)]);
      const found = (await client.query<Row>(`SELECT ${COLUMNS} FROM writing_candidate_request
        WHERE workspace_id = $1 AND actor_id = $2 AND idempotency_key = $3`, [workspaceId, attempt.actorId, attempt.idempotencyKey])).rows[0];
      if (found) {
        return (found.input_json as { schema?: string }).schema === SHORT_SEQUEL_AI_SCHEMA
          && found.project_id === projectId && found.request_hash === attempt.requestHash
          ? { kind: "existing", attempt: toSequelAttempt(found) } : { kind: "conflict" };
      }
      const target = (await client.query<Row>(`SELECT e.current_script_revision_id, e.row_version,
          (to_jsonb(p)->>'episode_count')::int AS episode_count
        FROM project p JOIN episode e ON e.project_id = p.id AND e.workspace_id = p.workspace_id
        WHERE p.id = $1 AND p.workspace_id = $2 AND p.archived_at IS NULL AND p.status = 'ACTIVE'
          AND e.id = $3 AND e.episode_no = $4 FOR UPDATE OF p`,
      [projectId, workspaceId, input.episodeId, input.episodeNo])).rows[0];
      if (!target || Number(target.episode_count) !== input.episodeCount) return { kind: "source_changed" };
      if (target.current_script_revision_id !== null) return { kind: "body_exists" };
      const problem = await sequelTargetProblem(client, attempt);
      if (problem) return { kind: problem };
      const latest = (await client.query<Row>(`SELECT ${COLUMNS} FROM writing_candidate_request
        WHERE workspace_id = $1 AND project_id = $2 AND mode = 'episode' AND episode_id = $3 AND ${SEQUEL_ROW}
        ORDER BY created_at DESC, id DESC LIMIT 1`, [workspaceId, projectId, input.episodeId])).rows[0];
      if (options.expectedAttemptId && latest?.id !== options.expectedAttemptId) {
        return latest && (latest.input_json as ShortSequelAiInput).taskId === input.taskId
          ? { kind: "advanced", attempt: toSequelAttempt(latest) } : { kind: "source_changed" };
      }
      const uncertainId = latest?.state === "unknown" ? String(latest.id) : null;
      if (uncertainId !== options.confirmUncertainAttemptId) {
        return { kind: "needs_confirmation" };
      }
      const titles = (await client.query<Row>("SELECT to_regclass('title_writing_run') IS NOT NULL AS present")).rows[0]?.present === true
        ? (await client.query<Row>("SELECT project_id FROM title_writing_run WHERE workspace_id = $1 AND state = 'running'", [workspaceId])).rows : [];
      const running = await runningWritingRuns(client, workspaceId);
      const openCandidate = (await client.query<Row>(`SELECT 1 FROM writing_candidate_request
        WHERE workspace_id = $1 AND project_id = $2 AND mode = 'episode' AND episode_id = $3 AND state IN ('reserved','submitted')`,
      [workspaceId, projectId, input.episodeId])).rows[0];
      if (openCandidate || running.some(run => run.projectId === projectId) || titles.some(run => run.project_id === projectId)) {
        return { kind: "active" };
      }
      if (running.length + titles.length >= options.maxActiveRuns) return { kind: "active_cap" };
      if (await recentWritingCalls(client, workspaceId, options.sinceIso) >= options.maxCallsPerDay) return { kind: "daily_cap" };
      // Each send is separately recorded against the shared paid-call quota. Resuming preserves input.taskId.
      const row = (await client.query<Row>(`INSERT INTO writing_candidate_request
        (id, workspace_id, project_id, actor_id, idempotency_key, request_hash, input_json, mode, episode_id,
          episode_no, if_match, provider_key, model, state, executor_id, lease_until, usage_json, confirmed_request_id, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'episode',$8,$9,$10,$11,$12,'reserved',$13,$14,$15::jsonb,
          $16,GREATEST($17::timestamptz, $18::timestamptz + interval '1 millisecond')) RETURNING ${COLUMNS}`,
      [attempt.id, workspaceId, projectId, attempt.actorId, attempt.idempotencyKey, attempt.requestHash, JSON.stringify(input),
        input.episodeId, input.episodeNo, target.row_version, input.providerKey, input.model, attempt.executorId, attempt.leaseUntil,
        JSON.stringify(attempt.usage), uncertainId, options.nowIso, latest?.created_at ?? null])).rows[0]!;
      return { kind: "created", attempt: toSequelAttempt(row) };
    });
  }

  async findShortSequelByKey(workspaceId: string, actorId: string, key: string): Promise<ShortSequelAiAttempt | null> {
    const row = (await this.query(`SELECT ${COLUMNS} FROM writing_candidate_request
      WHERE workspace_id = $1 AND actor_id = $2 AND idempotency_key = $3 AND ${SEQUEL_ROW}`, [workspaceId, actorId, key])).rows[0];
    return row ? toSequelAttempt(row) : null;
  }

  async getShortSequelAttempt(workspaceId: string, attemptId: string): Promise<ShortSequelAiAttempt | null> {
    const row = (await this.query(`SELECT ${COLUMNS} FROM writing_candidate_request WHERE workspace_id = $1 AND id = $2 AND ${SEQUEL_ROW}`,
      [workspaceId, attemptId])).rows[0];
    return row ? toSequelAttempt(row) : null;
  }

  async markShortSequelSubmitted(attempt: ShortSequelAiAttempt, executorId: string, nowIso: string, leaseUntil: string): Promise<boolean> {
    return this.transaction(async client => {
      const { workspaceId, projectId, id } = attempt;
      const project = await client.query(`SELECT 1 FROM project WHERE id = $1 AND workspace_id = $2
        AND archived_at IS NULL AND status = 'ACTIVE' FOR UPDATE`, [projectId, workspaceId]);
      const problem = project.rowCount === 1 ? await sequelTargetProblem(client, attempt) : "source_changed";
      if (problem) {
        await client.query(`UPDATE writing_candidate_request SET state = 'rejected', error_code = $4,
            executor_id = NULL, lease_until = NULL, finished_at = $5
          WHERE id = $1 AND workspace_id = $2 AND executor_id = $3 AND state = 'reserved' AND ${SEQUEL_ROW}`,
        [id, workspaceId, executorId, problem, nowIso]);
        return false;
      }
      const result = await client.query(`UPDATE writing_candidate_request SET state = 'submitted', lease_until = $5
        WHERE id = $1 AND workspace_id = $2 AND executor_id = $3 AND state = 'reserved' AND lease_until > $4 AND ${SEQUEL_ROW}`,
      [id, workspaceId, executorId, nowIso, leaseUntil]);
      return result.rowCount === 1;
    });
  }

  async listShortSequels(workspaceId: string, projectId: string, episodeId: string, cursor?: string): Promise<{
    attempts: ShortSequelAiAttempt[]; nextCursor: string | null;
  }> {
    const after = decodeSequelCursor(cursor, workspaceId, projectId, episodeId);
    const result = await this.query(`SELECT tasks.*, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS exact_created_at FROM (
        SELECT DISTINCT ON (input_json->>'taskId') ${COLUMNS} FROM writing_candidate_request
        WHERE workspace_id = $1 AND project_id = $2 AND mode = 'episode' AND episode_id = $3 AND ${SEQUEL_ROW}
        ORDER BY input_json->>'taskId', created_at DESC, id DESC
      ) AS tasks WHERE $4::timestamptz IS NULL OR (created_at, id) < ($4::timestamptz, $5::uuid)
      ORDER BY created_at DESC, id DESC LIMIT $6`, [workspaceId, projectId, episodeId, after?.at ?? null, after?.id ?? null, SHORT_SEQUEL_PAGE_SIZE + 1]);
    const rows = result.rows.slice(0, SHORT_SEQUEL_PAGE_SIZE);
    const tail = rows.at(-1);
    const nextCursor = result.rows.length > SHORT_SEQUEL_PAGE_SIZE && tail
      ? Buffer.from(JSON.stringify({ v: 1, workspaceId, projectId, episodeId, at: tail.exact_created_at, id: tail.id })).toString("base64url") : null;
    return { attempts: rows.map(toSequelAttempt), nextCursor };
  }

  /** Only expired leases. A request that was never sent is closed; one that may have been sent becomes unknown. */
  async recoverExpired(workspaceId: string, nowIso: string): Promise<number> {
    const result = await this.query(
      `UPDATE writing_candidate_request
          SET state = CASE WHEN state = 'submitted' THEN 'unknown' ELSE 'rejected' END,
              error_code = CASE WHEN state = 'submitted' THEN 'executor_lost' ELSE 'executor_lost_before_send' END,
              executor_id = NULL, lease_until = NULL, finished_at = $2
        WHERE workspace_id = $1 AND state IN ('reserved', 'submitted') AND lease_until <= $2`,
      [workspaceId, nowIso]);
    return result.rowCount ?? 0;
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
