import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import type { DatabasePool } from "./job-service";

/**
 * PostgreSQL storage for web Qwen writing requests. It mirrors the provider-side QwenWebStore contract.
 * The table comes from the unapplied draft prisma/drafts/20261005000100_qwen_web_writing.sql; until it exists,
 * storageReady() is false and callers must refuse the request. There is no in-memory fallback.
 */
export type QwenWebStoredState = "reserved" | "submitted" | "completed" | "rejected" | "unknown";

export interface QwenWebStoredRecord<F = unknown> {
  id: string;
  workspaceId: string;
  projectId: string;
  actorId: string;
  idempotencyKey: string;
  inputHash: string;
  frozenInput: F;
  mode: "story" | "episode";
  episodeNo: 1 | 2 | 3 | null;
  requestedModel: string;
  state: QwenWebStoredState;
  executorId: string;
  leaseUntil: string;
  serverRequestId: string | null;
  errorCode: string | null;
  providerResult: "completed" | "unknown" | null;
  candidateJson: string | null;
  candidateExpiresAt: string | null;
  billingStatus: "unknown";
  createdAt: string;
  updatedAt: string;
}

export type QwenWebStoredFinish = Pick<QwenWebStoredRecord,
  "serverRequestId" | "errorCode" | "providerResult" | "candidateJson" | "candidateExpiresAt" | "updatedAt"> & {
  state: "completed" | "rejected" | "unknown";
};

export type QwenWebStoredReservation<F = unknown> =
  | { kind: "reserved" | "existing" | "conflict"; record: QwenWebStoredRecord<F> }
  | { kind: "blocked"; code: "QWEN_WEB_REQUEST_CAP" | "QWEN_WEB_CONCURRENCY_CAP" };

export const QWEN_WEB_TABLE = "qwen_writing_request";
export const QWEN_WEB_REQUIRED_COLUMNS = [
  "id", "workspace_id", "project_id", "actor_id", "idempotency_key", "input_hash", "frozen_input", "mode",
  "episode_no", "requested_model", "state", "executor_id", "lease_until", "server_request_id", "error_code",
  "provider_result", "candidate_json", "candidate_expires_at", "billing_status", "billing_amount", "created_at",
  "updated_at",
] as const;

const COLUMNS = QWEN_WEB_REQUIRED_COLUMNS.filter((column) => column !== "billing_amount").join(", ");

interface Row extends QueryResultRow {
  id: string;
  workspace_id: string;
  project_id: string;
  actor_id: string;
  idempotency_key: string;
  input_hash: string;
  frozen_input: unknown;
  mode: "story" | "episode";
  episode_no: number | null;
  requested_model: string;
  state: QwenWebStoredState;
  executor_id: string;
  lease_until: Date;
  server_request_id: string | null;
  error_code: string | null;
  provider_result: "completed" | "unknown" | null;
  candidate_json: string | null;
  candidate_expires_at: Date | null;
  billing_status: "unknown";
  created_at: Date;
  updated_at: Date;
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toRecord<F>(row: Row): QwenWebStoredRecord<F> {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    actorId: row.actor_id,
    idempotencyKey: row.idempotency_key,
    inputHash: row.input_hash,
    // The writer validated this input before reserving it; the column is only written by reserve().
    frozenInput: row.frozen_input as F,
    mode: row.mode,
    episodeNo: row.episode_no === null ? null : row.episode_no as 1 | 2 | 3,
    requestedModel: row.requested_model,
    state: row.state,
    executorId: row.executor_id,
    leaseUntil: iso(row.lease_until),
    serverRequestId: row.server_request_id,
    errorCode: row.error_code,
    providerResult: row.provider_result,
    candidateJson: row.candidate_json,
    candidateExpiresAt: row.candidate_expires_at === null ? null : iso(row.candidate_expires_at),
    billingStatus: "unknown",
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export class PostgresQwenWebStore<F = unknown> {
  constructor(private readonly pool: DatabasePool) {}

  /** True only when the draft table exists with every column this store reads or writes. */
  async storageReady(): Promise<boolean> {
    try {
      const result = await this.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = $1`,
        [QWEN_WEB_TABLE],
      );
      const present = new Set(result.rows.map((row) => String((row as { column_name: unknown }).column_name)));
      return QWEN_WEB_REQUIRED_COLUMNS.every((column) => present.has(column));
    } catch {
      return false;
    }
  }

  async reserve(
    record: QwenWebStoredRecord<F>,
    limits: { sinceIso: string; maxRequests: number; maxConcurrency: number },
  ): Promise<QwenWebStoredReservation<F>> {
    return this.transaction(async (client) => {
      // Serialize every reservation of one workspace: the key lookup, both caps and the insert are atomic.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${QWEN_WEB_TABLE}:${record.workspaceId}`]);
      const existing = await client.query<Row>(
        `SELECT ${COLUMNS} FROM ${QWEN_WEB_TABLE}
          WHERE workspace_id = $1 AND actor_id = $2 AND idempotency_key = $3`,
        [record.workspaceId, record.actorId, record.idempotencyKey],
      );
      const found = existing.rows[0];
      if (found) {
        return { kind: found.input_hash === record.inputHash ? "existing" : "conflict", record: toRecord<F>(found) };
      }
      const counts = await client.query<{ recent: number; open: number } & QueryResultRow>(
        `SELECT count(*) FILTER (WHERE created_at >= $2)::int AS recent,
                count(*) FILTER (WHERE state IN ('reserved', 'submitted'))::int AS open
           FROM ${QWEN_WEB_TABLE}
          WHERE workspace_id = $1`,
        [record.workspaceId, limits.sinceIso],
      );
      const recent = counts.rows[0]?.recent ?? 0;
      const open = counts.rows[0]?.open ?? 0;
      if (recent >= limits.maxRequests) return { kind: "blocked", code: "QWEN_WEB_REQUEST_CAP" };
      if (open >= limits.maxConcurrency) return { kind: "blocked", code: "QWEN_WEB_CONCURRENCY_CAP" };
      const inserted = await client.query<Row>(
        `INSERT INTO ${QWEN_WEB_TABLE}
          (id, workspace_id, project_id, actor_id, idempotency_key, input_hash, frozen_input, mode, episode_no,
           requested_model, state, executor_id, lease_until, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, 'reserved', $11, $12, $13, $13)
         RETURNING ${COLUMNS}`,
        [record.id, record.workspaceId, record.projectId, record.actorId, record.idempotencyKey, record.inputHash,
          JSON.stringify(record.frozenInput), record.mode, record.episodeNo, record.requestedModel,
          record.executorId, record.leaseUntil, record.createdAt],
      );
      return { kind: "reserved", record: toRecord<F>(inserted.rows[0]!) };
    });
  }

  async findByKey(workspaceId: string, actorId: string, key: string): Promise<QwenWebStoredRecord<F> | null> {
    const result = await this.query(
      `SELECT ${COLUMNS} FROM ${QWEN_WEB_TABLE} WHERE workspace_id = $1 AND actor_id = $2 AND idempotency_key = $3`,
      [workspaceId, actorId, key],
    );
    const row = result.rows[0] as Row | undefined;
    return row ? toRecord<F>(row) : null;
  }

  async findById(workspaceId: string, projectId: string, id: string): Promise<QwenWebStoredRecord<F> | null> {
    const result = await this.query(
      `SELECT ${COLUMNS} FROM ${QWEN_WEB_TABLE} WHERE id = $1 AND workspace_id = $2 AND project_id = $3`,
      [id, workspaceId, projectId],
    );
    const row = result.rows[0] as Row | undefined;
    return row ? toRecord<F>(row) : null;
  }

  async markSubmitted(id: string, executorId: string, updatedAt: string, leaseUntil: string): Promise<boolean> {
    const result = await this.query(
      `UPDATE ${QWEN_WEB_TABLE}
          SET state = 'submitted', updated_at = $3, lease_until = $4
        WHERE id = $1 AND executor_id = $2 AND state = 'reserved' AND lease_until > $3`,
      [id, executorId, updatedAt, leaseUntil],
    );
    return result.rowCount === 1;
  }

  async finish(id: string, executorId: string, patch: QwenWebStoredFinish): Promise<QwenWebStoredRecord<F>> {
    await this.query(
      `UPDATE ${QWEN_WEB_TABLE}
          SET state = $3, server_request_id = $4, error_code = $5, provider_result = $6,
              candidate_json = $7, candidate_expires_at = $8, updated_at = $9
        WHERE id = $1 AND executor_id = $2 AND state = 'submitted'`,
      [id, executorId, patch.state, patch.serverRequestId, patch.errorCode, patch.providerResult,
        patch.candidateJson, patch.candidateExpiresAt, patch.updatedAt],
    );
    const result = await this.query(`SELECT ${COLUMNS} FROM ${QWEN_WEB_TABLE} WHERE id = $1`, [id]);
    const row = result.rows[0] as Row | undefined;
    if (!row) throw new Error("qwen web record missing");
    return toRecord<F>(row);
  }

  async recoverExpired(nowIso: string): Promise<number> {
    return this.transaction(async (client) => {
      const neverSent = await client.query(
        `UPDATE ${QWEN_WEB_TABLE}
            SET state = 'rejected', error_code = 'executor_lost_before_send', provider_result = NULL, updated_at = $1
          WHERE state = 'reserved' AND lease_until <= $1`,
        [nowIso],
      );
      const maybeSent = await client.query(
        `UPDATE ${QWEN_WEB_TABLE}
            SET state = 'unknown', error_code = 'executor_lost', provider_result = 'unknown',
                candidate_json = NULL, candidate_expires_at = NULL, updated_at = $1
          WHERE state = 'submitted' AND lease_until <= $1`,
        [nowIso],
      );
      return (neverSent.rowCount ?? 0) + (maybeSent.rowCount ?? 0);
    });
  }

  async expireCandidates(nowIso: string): Promise<number> {
    const result = await this.query(
      `UPDATE ${QWEN_WEB_TABLE}
          SET candidate_json = NULL, updated_at = $1
        WHERE candidate_json IS NOT NULL AND candidate_expires_at <= $1`,
      [nowIso],
    );
    return result.rowCount ?? 0;
  }

  private async query(sql: string, values: unknown[]): Promise<QueryResult> {
    const client = await this.pool.connect();
    try {
      return await client.query(sql, values);
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
