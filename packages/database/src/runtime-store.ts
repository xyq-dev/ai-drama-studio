import { createHash } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import type { DatabasePool } from "./job-service";
import { PersistenceError } from "./job-service";

export interface OutboxDispatchRow {
  id: string;
  workspaceId: string;
  jobId: string;
  dispatchSeq: number;
}

export interface ExpiredLeaseRow {
  workspaceId: string;
  jobId: string;
  attemptId: string;
  providerConfigurationId: string | null;
  providerRequestId: string | null;
  cancelRequested: boolean;
}

export interface ExecutionContext {
  jobId: string;
  workspaceId: string;
  workflowRunId: string;
  state: string;
  inputSnapshot: unknown;
  cancelRequested: boolean;
  providerConfigurationId: string | null;
  maxAttempts: number;
}

export interface ProjectRecord {
  id: string;
  workspaceId: string;
  title: string;
  premise: string;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface JobView {
  id: string;
  workspaceId: string;
  projectId: string;
  workflowRunId: string;
  kind: string;
  state: string;
  dispatchSeq: number;
  retryCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  attemptId: string | null;
  attemptNo: number | null;
  providerRequestId: string | null;
}

export interface WorkflowView {
  id: string;
  workspaceId: string;
  projectId: string;
  type: string;
  status: string;
  createdAt: string;
  jobs: JobView[];
}

export interface DomainEventView {
  eventId: string;
  eventType: string;
  occurredAt: string;
  traceId: string;
  data: unknown;
  retentionUntil: string | null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

function parseProjectCursor(cursor: string): [string, string] {
  const parts = cursor.split("|");
  if (parts.length !== 2) {
    throw new PersistenceError("VALIDATION_ERROR", "Project cursor is invalid");
  }
  const [createdAt, id] = parts;
  if (!createdAt || !id || !ISO_TIMESTAMP_PATTERN.test(createdAt) || !UUID_PATTERN.test(id)) {
    throw new PersistenceError("VALIDATION_ERROR", "Project cursor is invalid");
  }
  const parsed = Date.parse(createdAt);
  if (!Number.isFinite(parsed)) {
    throw new PersistenceError("VALIDATION_ERROR", "Project cursor is invalid");
  }
  return [createdAt, id];
}

export class RuntimeStore {
  constructor(private readonly pool: DatabasePool) {}

  async requireActiveWorkspace(workspaceId: string): Promise<string> {
    const client = await this.pool.connect();
    try {
      const existing = await client.query<{ id: string; status: string } & QueryResultRow>(
        `SELECT id, status FROM workspace WHERE id = $1`,
        [workspaceId],
      );
      const found = existing.rows[0];
      if (!found || found.status !== "ACTIVE") {
        throw new PersistenceError("WORKSPACE_NOT_ACTIVE", "Configured workspace is missing or inactive");
      }
      return found.id;
    } finally {
      client.release();
    }
  }

  async ensureMockProvider(workspaceId: string, maxAttempts = 3): Promise<string> {
    const client = await this.pool.connect();
    try {
      const created = await client.query<{ id: string } & QueryResultRow>(
        `INSERT INTO provider_configuration
          (workspace_id, provider_key, capability, default_timeout_ms, max_attempts)
         VALUES ($1, 'mock', 'mock.generate', 30000, $2)
         ON CONFLICT (workspace_id, provider_key, capability) DO NOTHING
         RETURNING id`,
        [workspaceId, maxAttempts],
      );
      const insertedId = created.rows[0]?.id;
      if (insertedId) return insertedId;

      const existing = await client.query<{ id: string } & QueryResultRow>(
        `SELECT id FROM provider_configuration
          WHERE workspace_id = $1 AND provider_key = 'mock' AND capability = 'mock.generate'`,
        [workspaceId],
      );
      const existingId = existing.rows[0]?.id;
      if (!existingId) throw new PersistenceError("PROVIDER_CONFIG_INVALID", "Mock provider configuration was not created");
      return existingId;
    } finally {
      client.release();
    }
  }

  async createProject(input: {
    workspaceId: string;
    title: string;
    premise: string;
  }): Promise<ProjectRecord> {
    const client = await this.pool.connect();
    try {
      return await insertProject(client, input);
    } finally {
      client.release();
    }
  }

  async listProjects(workspaceId: string, limit: number, cursor?: string): Promise<{ items: ProjectRecord[]; nextCursor: string | null }> {
    const client = await this.pool.connect();
    try {
      const params: unknown[] = [workspaceId, limit + 1];
      let cursorSql = "";
      if (cursor) {
        const [createdAt, id] = parseProjectCursor(cursor);
        params.push(createdAt, id);
        cursorSql = `AND (created_at, id) < ($3::timestamptz, $4::uuid)`;
      }
      const result = await client.query<QueryResultRow>(
        `SELECT id, workspace_id, title, premise, status, version, created_at, updated_at
           FROM project
          WHERE workspace_id = $1 ${cursorSql}
          ORDER BY created_at DESC, id DESC
          LIMIT $2`,
        params,
      );
      const page = result.rows.slice(0, limit).map(mapProject);
      const last = page.at(-1);
      const nextCursor = result.rows.length > limit && last ? `${last.createdAt}|${last.id}` : null;
      return { items: page, nextCursor };
    } finally {
      client.release();
    }
  }

  async getProject(workspaceId: string, projectId: string): Promise<ProjectRecord> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<QueryResultRow>(
        `SELECT id, workspace_id, title, premise, status, version, created_at, updated_at
           FROM project WHERE id = $1 AND workspace_id = $2`,
        [projectId, workspaceId],
      );
      const row = result.rows[0];
      if (!row) throw new PersistenceError("NOT_FOUND", "Project not found");
      return mapProject(row);
    } finally {
      client.release();
    }
  }

  async listUndispatched(limit: number, now = new Date()): Promise<OutboxDispatchRow[]> {
    return this.queryOutbox(
      `SELECT id, workspace_id, job_id, dispatch_seq
         FROM dispatch_outbox
        WHERE dispatched_at IS NULL AND available_at <= $1
        ORDER BY available_at, dispatch_seq
        LIMIT $2`,
      [now, limit],
    );
  }

  async listOrphanQueued(graceMs: number, limit: number, now = new Date()): Promise<OutboxDispatchRow[]> {
    const cutoff = new Date(now.getTime() - graceMs);
    return this.queryOutbox(
      `SELECT o.id, o.workspace_id, o.job_id, o.dispatch_seq
         FROM dispatch_outbox o
         JOIN generation_job j ON j.id = o.job_id AND j.workspace_id = o.workspace_id
        WHERE j.state = 'QUEUED'
          AND j.dispatch_seq = o.dispatch_seq
          AND o.dispatched_at IS NOT NULL
          AND o.dispatched_at <= $1
          AND (j.next_run_at IS NULL OR j.next_run_at <= $3)
        ORDER BY o.dispatched_at
        LIMIT $2`,
      [cutoff, limit, now],
    );
  }

  async markDispatched(outboxId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `UPDATE dispatch_outbox
            SET dispatched_at = COALESCE(dispatched_at, now())
          WHERE id = $1`,
        [outboxId],
      );
    } finally {
      client.release();
    }
  }

  async recordDispatchFailure(outboxId: string, message: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `UPDATE dispatch_outbox
            SET dispatch_attempts = dispatch_attempts + 1, last_error = $2
          WHERE id = $1 AND dispatched_at IS NULL`,
        [outboxId, message.slice(0, 500)],
      );
    } finally {
      client.release();
    }
  }

  async listWaitingExternal(limit: number): Promise<ExpiredLeaseRow[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<QueryResultRow>(
        `SELECT j.workspace_id, j.id AS job_id, ja.id AS attempt_id,
                ja.provider_configuration_id, ja.provider_request_id, j.cancel_requested_at
           FROM generation_job j
           JOIN LATERAL (
             SELECT id, provider_configuration_id, provider_request_id
               FROM job_attempt
              WHERE generation_job_id = j.id
              ORDER BY attempt_no DESC
              LIMIT 1
           ) ja ON true
          WHERE j.state = 'WAITING_EXTERNAL'
            AND ja.provider_request_id IS NOT NULL
            AND (j.next_run_at IS NULL OR j.next_run_at <= now())
          ORDER BY j.updated_at
          LIMIT $1`,
        [limit],
      );
      return result.rows.map(mapLease);
    } finally {
      client.release();
    }
  }

  async listExpiredRunning(limit: number, now = new Date()): Promise<ExpiredLeaseRow[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<QueryResultRow>(
        `SELECT j.workspace_id, j.id AS job_id, ja.id AS attempt_id,
                ja.provider_configuration_id, ja.provider_request_id, j.cancel_requested_at
           FROM generation_job j
           JOIN LATERAL (
             SELECT id, provider_configuration_id, provider_request_id
               FROM job_attempt
              WHERE generation_job_id = j.id
              ORDER BY attempt_no DESC
              LIMIT 1
           ) ja ON true
          WHERE j.state = 'RUNNING' AND j.lease_until IS NOT NULL AND j.lease_until <= $1
          ORDER BY j.lease_until
          LIMIT $2`,
        [now, limit],
      );
      return result.rows.map(mapLease);
    } finally {
      client.release();
    }
  }

  async loadExecution(workspaceId: string, jobId: string): Promise<ExecutionContext | null> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<QueryResultRow>(
        `SELECT j.id, j.workspace_id, j.workflow_run_id, j.state, j.input_snapshot, j.cancel_requested_at,
                pc.id AS provider_configuration_id, pc.max_attempts
           FROM generation_job j
           LEFT JOIN provider_configuration pc
             ON pc.workspace_id = j.workspace_id AND pc.provider_key = 'mock' AND pc.capability = 'mock.generate'
          WHERE j.id = $1 AND j.workspace_id = $2`,
        [jobId, workspaceId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        jobId: String(row.id),
        workspaceId: String(row.workspace_id),
        workflowRunId: String(row.workflow_run_id),
        state: String(row.state),
        inputSnapshot: row.input_snapshot,
        cancelRequested: row.cancel_requested_at !== null,
        providerConfigurationId: row.provider_configuration_id ? String(row.provider_configuration_id) : null,
        maxAttempts: Number(row.max_attempts ?? 3),
      };
    } finally {
      client.release();
    }
  }

  async getJob(workspaceId: string, jobId: string): Promise<JobView> {
    const jobs = await this.queryJobs(
      `SELECT ${JOB_COLUMNS}
         FROM generation_job j
         LEFT JOIN LATERAL (
           SELECT id, attempt_no, provider_request_id
             FROM job_attempt WHERE generation_job_id = j.id
            ORDER BY attempt_no DESC LIMIT 1
         ) ja ON true
        WHERE j.id = $1 AND j.workspace_id = $2`,
      [jobId, workspaceId],
    );
    const job = jobs[0];
    if (!job) throw new PersistenceError("NOT_FOUND", "Generation job not found");
    return job;
  }

  async getWorkflow(workspaceId: string, workflowRunId: string): Promise<WorkflowView> {
    const client = await this.pool.connect();
    try {
      return await this.getWorkflowWithClient(client, workspaceId, workflowRunId);
    } finally {
      client.release();
    }
  }

  async listWorkflows(workspaceId: string, projectId: string): Promise<WorkflowView[]> {
    const client = await this.pool.connect();
    try {
      const runs = await client.query<QueryResultRow>(
        `SELECT id FROM workflow_run
          WHERE workspace_id = $1 AND project_id = $2
          ORDER BY created_at DESC, id DESC`,
        [workspaceId, projectId],
      );
      const views: WorkflowView[] = [];
      for (const run of runs.rows) {
        views.push(await this.getWorkflowWithClient(client, workspaceId, String(run.id)));
      }
      return views;
    } finally {
      client.release();
    }
  }

  private async getWorkflowWithClient(
    client: PoolClient,
    workspaceId: string,
    workflowRunId: string,
  ): Promise<WorkflowView> {
    const workflow = await client.query<QueryResultRow>(
      `SELECT id, workspace_id, project_id, type, status, created_at
         FROM workflow_run WHERE id = $1 AND workspace_id = $2`,
      [workflowRunId, workspaceId],
    );
    const row = workflow.rows[0];
    if (!row) throw new PersistenceError("NOT_FOUND", "Workflow run not found");
    const jobs = await this.queryJobs(
      `SELECT ${JOB_COLUMNS}
         FROM generation_job j
         LEFT JOIN LATERAL (
           SELECT id, attempt_no, provider_request_id
             FROM job_attempt WHERE generation_job_id = j.id
            ORDER BY attempt_no DESC LIMIT 1
         ) ja ON true
        WHERE j.workflow_run_id = $1 AND j.workspace_id = $2
        ORDER BY j.created_at, j.id`,
      [workflowRunId, workspaceId],
      client,
    );
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      projectId: String(row.project_id),
      type: String(row.type),
      status: String(row.status),
      createdAt: iso(row.created_at as Date),
      jobs,
    };
  }

  async assertCursor(workspaceId: string, lastEventId: string): Promise<void> {
    if (!/^\d+$/.test(lastEventId)) {
      throw new PersistenceError("VALIDATION_ERROR", "Last-Event-ID must be a numeric cursor");
    }
    const client = await this.pool.connect();
    try {
      const event = await client.query<QueryResultRow>(
        `SELECT retention_until FROM domain_event WHERE id = $1 AND workspace_id = $2`,
        [lastEventId, workspaceId],
      );
      const row = event.rows[0];
      if (!row) {
        const older = await client.query<QueryResultRow>(
          `SELECT 1 FROM domain_event WHERE workspace_id = $1 AND id > $2 LIMIT 1`,
          [workspaceId, lastEventId],
        );
        const any = await client.query<QueryResultRow>(
          `SELECT 1 FROM domain_event WHERE workspace_id = $1 LIMIT 1`,
          [workspaceId],
        );
        if (any.rows.length > 0 && older.rows.length === 0 && lastEventId !== "0") {
          throw new PersistenceError("EVENT_CURSOR_EXPIRED", "Event cursor is outside the retention window");
        }
        if (any.rows.length > 0 && older.rows.length > 0) {
          throw new PersistenceError("EVENT_CURSOR_EXPIRED", "Event cursor is outside the retention window");
        }
        return;
      }
      const retention = row.retention_until as Date | null;
      if (retention && retention.getTime() <= Date.now()) {
        throw new PersistenceError("EVENT_CURSOR_EXPIRED", "Event cursor is outside the retention window");
      }
    } finally {
      client.release();
    }
  }

  async listEventsAfter(workspaceId: string, lastEventId: string, limit: number): Promise<DomainEventView[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<QueryResultRow>(
        `SELECT id, event_type, occurred_at, trace_id, payload_json, retention_until
           FROM domain_event
          WHERE workspace_id = $1 AND id > $2
            AND (retention_until IS NULL OR retention_until > now())
          ORDER BY id
          LIMIT $3`,
        [workspaceId, lastEventId, limit],
      );
      return result.rows.map((row) => ({
        eventId: String(row.id),
        eventType: String(row.event_type),
        occurredAt: iso(row.occurred_at as Date),
        traceId: String(row.trace_id),
        data: row.payload_json,
        retentionUntil: row.retention_until ? iso(row.retention_until as Date) : null,
      }));
    } finally {
      client.release();
    }
  }

  private async queryOutbox(sql: string, params: unknown[]): Promise<OutboxDispatchRow[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<QueryResultRow>(sql, params);
      return result.rows.map((row) => ({
        id: String(row.id),
        workspaceId: String(row.workspace_id),
        jobId: String(row.job_id),
        dispatchSeq: Number(row.dispatch_seq),
      }));
    } finally {
      client.release();
    }
  }

  private async queryJobs(sql: string, params: unknown[], existing?: PoolClient): Promise<JobView[]> {
    const client = existing ?? (await this.pool.connect());
    try {
      const result = await client.query<QueryResultRow>(sql, params);
      return result.rows.map(mapJob);
    } finally {
      if (!existing) client.release();
    }
  }
}

const JOB_COLUMNS = `j.id, j.workspace_id, j.project_id, j.workflow_run_id, j.kind, j.state,
  j.dispatch_seq, j.retry_count, j.error_code, j.error_message,
  ja.id AS attempt_id, ja.attempt_no, ja.provider_request_id`;

export async function insertProject(
  client: PoolClient,
  input: { workspaceId: string; title: string; premise: string },
): Promise<ProjectRecord> {
  const result = await client.query<QueryResultRow>(
    `INSERT INTO project (workspace_id, title, premise)
     VALUES ($1, $2, $3)
     RETURNING id, workspace_id, title, premise, status, version, created_at, updated_at`,
    [input.workspaceId, input.title, input.premise],
  );
  const row = result.rows[0];
  if (!row) throw new PersistenceError("PROJECT_CREATE_FAILED", "Project was not created");
  return mapProject(row);
}

function mapLease(row: QueryResultRow): ExpiredLeaseRow {
  return {
    workspaceId: String(row.workspace_id),
    jobId: String(row.job_id),
    attemptId: String(row.attempt_id),
    providerConfigurationId: row.provider_configuration_id ? String(row.provider_configuration_id) : null,
    providerRequestId: row.provider_request_id ? String(row.provider_request_id) : null,
    cancelRequested: row.cancel_requested_at !== null,
  };
}

function mapProject(row: QueryResultRow): ProjectRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    title: String(row.title),
    premise: String(row.premise),
    status: String(row.status),
    version: Number(row.version),
    createdAt: iso(row.created_at as Date),
    updatedAt: iso(row.updated_at as Date),
  };
}

function mapJob(row: QueryResultRow): JobView {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    projectId: String(row.project_id),
    workflowRunId: String(row.workflow_run_id),
    kind: String(row.kind),
    state: String(row.state),
    dispatchSeq: Number(row.dispatch_seq),
    retryCount: Number(row.retry_count),
    errorCode: row.error_code ? String(row.error_code) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    attemptId: row.attempt_id ? String(row.attempt_id) : null,
    attemptNo: row.attempt_no === null || row.attempt_no === undefined ? null : Number(row.attempt_no),
    providerRequestId: row.provider_request_id ? String(row.provider_request_id) : null,
  };
}

export function requestHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
