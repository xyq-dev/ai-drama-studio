import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import type {
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
import type { DatabasePool } from "./job-service";
import { WRITING_CANDIDATE_MIGRATION } from "./migrations";

export { WRITING_CANDIDATE_MIGRATION };

/** Every column this store reads or writes. Until all exist (and the migration is recorded), storageReady() is false. */
export const WRITING_CANDIDATE_COLUMNS = [
  "id", "workspace_id", "project_id", "actor_id", "idempotency_key", "request_hash", "input_json", "mode", "episode_id",
  "episode_no", "source_revision_id", "if_match", "provider_key", "model", "state", "executor_id", "lease_until", "error_code",
  "provider_request_id", "response_model", "usage_json", "billing_status", "candidate_json", "confirmed_request_id",
  "created_at", "finished_at",
] as const;
const COLUMNS = WRITING_CANDIDATE_COLUMNS.join(", ");

type Row = QueryResultRow & Record<string, unknown>;

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

/**
 * Calls made in the rolling window by title writing and by online candidates together: one daily cap covers every
 * paid text call of the workspace. Either table may not exist yet (its migration not applied); it then counts zero.
 * Callers hold the workspace call lock (title_writing_call:<workspace>), so the count and their insert are atomic.
 */
export async function recentWritingCalls(client: PoolClient, workspaceId: string, sinceIso: string): Promise<number> {
  const present = await client.query<Row>(
    "SELECT to_regclass('title_writing_call') IS NOT NULL AS title, to_regclass('writing_candidate_request') IS NOT NULL AS candidate",
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
  return total;
}

/** The lock key every paid text call of a workspace is reserved under (title writing calls and online candidates). */
export function writingCallLockKey(workspaceId: string): string {
  return `title_writing_call:${workspaceId}`;
}

export class PostgresWritingCandidateStore implements WritingCandidateStore {
  // Once applied a migration stays applied, so only a positive answer is remembered.
  private readyConfirmed = false;

  constructor(private readonly pool: DatabasePool) {}

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
        return String(found.request_hash) === record.requestHash && String(found.project_id) === record.projectId
          ? { kind: "existing", record: toRecord(found) } : { kind: "conflict" };
      }
      const { input } = record;
      const invalid = await this.targetProblem(client, record.workspaceId, input);
      if (invalid) return { kind: "target_invalid", reason: invalid };
      const sameTarget = await client.query<Row>(
        `SELECT ${COLUMNS} FROM writing_candidate_request
          WHERE workspace_id = $1 AND project_id = $2 AND mode = $3 AND episode_id IS NOT DISTINCT FROM $4
          ORDER BY created_at DESC, id DESC LIMIT 20`,
        [record.workspaceId, record.projectId, input.mode, input.episodeId],
      );
      const open = sameTarget.rows.find((row) => row.state === "reserved" || row.state === "submitted");
      if (open) return { kind: "active", requestId: String(open.id) };
      const latest = sameTarget.rows[0];
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
      `SELECT ${COLUMNS} FROM writing_candidate_request WHERE workspace_id = $1 AND actor_id = $2 AND idempotency_key = $3`,
      [workspaceId, actorId, idempotencyKey]);
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async get(workspaceId: string, projectId: string, requestId: string): Promise<WritingCandidateRecord | null> {
    const result = await this.query(`SELECT ${COLUMNS} FROM writing_candidate_request WHERE id = $1 AND workspace_id = $2 AND project_id = $3`,
      [requestId, workspaceId, projectId]);
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async getById(workspaceId: string, requestId: string): Promise<WritingCandidateRecord | null> {
    const result = await this.query(`SELECT ${COLUMNS} FROM writing_candidate_request WHERE id = $1 AND workspace_id = $2`, [requestId, workspaceId]);
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async listForTarget(workspaceId: string, projectId: string, target: { mode: WritingCandidateMode; episodeId: string | null }, limit: number): Promise<WritingCandidateRecord[]> {
    const result = await this.query(
      `SELECT ${COLUMNS} FROM writing_candidate_request
        WHERE workspace_id = $1 AND project_id = $2 AND mode = $3 AND episode_id IS NOT DISTINCT FROM $4
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
    const result = await this.query(
      `UPDATE writing_candidate_request SET state = $4, error_code = $5, provider_request_id = $6, response_model = $7,
         usage_json = $8::jsonb, candidate_json = $9::jsonb, executor_id = NULL, lease_until = NULL, finished_at = $10
        WHERE id = $1 AND workspace_id = $2 AND executor_id = $3 AND state = 'submitted'`,
      [requestId, workspaceId, executorId, patch.state, patch.errorCode, patch.providerRequestId, patch.responseModel,
        JSON.stringify(patch.usage), patch.candidate === null ? null : JSON.stringify(patch.candidate), nowIso]);
    return result.rowCount === 1;
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
