import type { PoolClient, QueryResultRow } from "pg";

export class PersistenceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PersistenceError";
    this.code = code;
  }
}

export interface DatabasePool {
  connect(): Promise<PoolClient>;
}

export interface CreateWorkflowJobInput {
  workspaceId: string;
  projectId: string;
  type: string;
  requestedBy: string;
  kind: string;
  inputHash: string;
  inputSnapshot: unknown;
  isCritical?: boolean;
  progressWeight?: number;
  traceId: string;
}

export interface CreatedWorkflowJob {
  workflowRunId: string;
  jobId: string;
}

export interface QueueJobInput {
  workspaceId: string;
  jobId: string;
  traceId: string;
  availableAt?: Date;
}

export interface AcquiredJob {
  jobId: string;
  attemptId: string;
  attemptNo: number;
  dispatchSeq: number;
  workflowRunId: string;
}

export interface IdempotencyScope {
  workspaceId: string;
  actorId: string;
  httpMethod: string;
  routeKey: string;
  key: string;
  requestHash: string;
  expiresAt?: Date;
}

export interface ManualRetryInput {
  workspaceId: string;
  jobId: string;
  requestedBy: string;
  traceId: string;
  retryable: boolean;
}

export interface ProviderEventInput {
  workspaceId: string;
  providerConfigurationId: string;
  jobAttemptId: string;
  providerRequestId: string;
  source: "CALLBACK" | "POLL";
  normalizedEventKey: string;
  externalStatus: string;
  payloadRef?: string | null;
}

type JobState =
  | "PENDING"
  | "QUEUED"
  | "RUNNING"
  | "WAITING_EXTERNAL"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELED";

interface JobRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  project_id: string;
  workflow_run_id: string;
  kind: string;
  state: JobState;
  input_hash: string;
  input_snapshot: unknown;
  dispatch_seq: number;
  row_version: number;
  retry_count: number;
  is_critical: boolean;
  progress_weight: number;
  lease_until: Date | null;
}

interface IdempotencyRow extends QueryResultRow {
  request_hash: string;
  response_status: number | null;
  response_body: unknown | null;
}

interface WorkflowSourceRow extends QueryResultRow {
  type: string;
  input_snapshot: unknown;
}

const TERMINAL_STATES = new Set<JobState>(["SUCCEEDED", "FAILED", "CANCELED"]);

function requireRow<T>(row: T | undefined, code: string, message: string): T {
  if (!row) {
    throw new PersistenceError(code, message);
  }
  return row;
}

async function withTransaction<T>(pool: DatabasePool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
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

async function loadJobForUpdate(client: PoolClient, workspaceId: string, jobId: string): Promise<JobRow> {
  const result = await client.query<JobRow>(
    `SELECT id, workspace_id, project_id, workflow_run_id, kind, state, input_hash,
            input_snapshot, dispatch_seq, row_version, retry_count, is_critical,
            progress_weight, lease_until
       FROM generation_job
      WHERE id = $1 AND workspace_id = $2
      FOR UPDATE`,
    [jobId, workspaceId],
  );
  return requireRow(result.rows[0], "JOB_NOT_FOUND", "Generation job not found");
}

async function appendDomainEvent(
  client: PoolClient,
  job: Pick<JobRow, "workspace_id" | "project_id" | "id">,
  eventType: string,
  traceId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO domain_event
      (workspace_id, project_id, aggregate_type, aggregate_id, event_type, payload_json, trace_id)
     VALUES ($1, $2, 'GenerationJob', $3, $4, $5::jsonb, $6)`,
    [job.workspace_id, job.project_id, job.id, eventType, JSON.stringify(payload), traceId],
  );
}

function deriveWorkflowStatus(rows: Array<{ state: JobState; is_critical: boolean }>): string {
  if (rows.length === 0 || rows.every((row) => row.state === "PENDING")) {
    return "PENDING";
  }
  if (rows.some((row) => !TERMINAL_STATES.has(row.state))) {
    return "RUNNING";
  }
  if (rows.some((row) => row.state === "CANCELED") && !rows.some((row) => row.state === "FAILED")) {
    return "CANCELED";
  }
  if (rows.some((row) => row.is_critical && row.state === "FAILED")) {
    return "FAILED";
  }
  if (rows.some((row) => row.state === "FAILED" || row.state === "CANCELED")) {
    return "PARTIAL_FAILED";
  }
  return "SUCCEEDED";
}

async function refreshWorkflowStatus(client: PoolClient, workflowRunId: string): Promise<void> {
  const jobs = await client.query<{ state: JobState; is_critical: boolean } & QueryResultRow>(
    "SELECT state, is_critical FROM generation_job WHERE workflow_run_id = $1 ORDER BY created_at, id",
    [workflowRunId],
  );
  const status = deriveWorkflowStatus(jobs.rows);
  const terminal = ["SUCCEEDED", "PARTIAL_FAILED", "FAILED", "CANCELED"].includes(status);
  await client.query(
    `UPDATE workflow_run
        SET status = $2,
            row_version = row_version + 1,
            updated_at = now(),
            completed_at = CASE WHEN $3::boolean THEN COALESCE(completed_at, now()) ELSE NULL END
      WHERE id = $1`,
    [workflowRunId, status, terminal],
  );
}

async function createWorkflowJobTx(
  client: PoolClient,
  input: CreateWorkflowJobInput,
): Promise<CreatedWorkflowJob> {
  const workflow = await client.query<{ id: string } & QueryResultRow>(
    `INSERT INTO workflow_run
      (workspace_id, project_id, type, requested_by, input_snapshot)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING id`,
    [input.workspaceId, input.projectId, input.type, input.requestedBy, JSON.stringify(input.inputSnapshot)],
  );
  const workflowRunId = requireRow(workflow.rows[0], "WORKFLOW_CREATE_FAILED", "Workflow run was not created").id;

  const job = await client.query<{ id: string } & QueryResultRow>(
    `INSERT INTO generation_job
      (workspace_id, project_id, workflow_run_id, kind, input_hash, input_snapshot, is_critical, progress_weight)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     RETURNING id`,
    [
      input.workspaceId,
      input.projectId,
      workflowRunId,
      input.kind,
      input.inputHash,
      JSON.stringify(input.inputSnapshot),
      input.isCritical ?? true,
      input.progressWeight ?? 1,
    ],
  );
  const jobId = requireRow(job.rows[0], "JOB_CREATE_FAILED", "Generation job was not created").id;

  await client.query(
    `INSERT INTO domain_event
      (workspace_id, project_id, aggregate_type, aggregate_id, event_type, payload_json, trace_id)
     VALUES ($1, $2, 'GenerationJob', $3, 'job.created', $4::jsonb, $5)`,
    [
      input.workspaceId,
      input.projectId,
      jobId,
      JSON.stringify({ jobId, workflowRunId, kind: input.kind, state: "PENDING" }),
      input.traceId,
    ],
  );

  return { workflowRunId, jobId };
}

async function queueJobTx(
  client: PoolClient,
  job: JobRow,
  traceId: string,
  availableAt: Date | null,
  retryIncrement: number,
): Promise<JobRow> {
  if (TERMINAL_STATES.has(job.state)) {
    throw new PersistenceError("JOB_TERMINAL", "Terminal jobs cannot be queued again");
  }
  if (!new Set<JobState>(["PENDING", "RUNNING", "WAITING_EXTERNAL"]).has(job.state)) {
    throw new PersistenceError("JOB_INVALID_TRANSITION", `Cannot queue job from ${job.state}`);
  }

  const result = await client.query<JobRow>(
    `UPDATE generation_job
        SET state = 'QUEUED',
            dispatch_seq = dispatch_seq + 1,
            row_version = row_version + 1,
            retry_count = retry_count + $5,
            next_run_at = $6,
            lease_owner = NULL,
            lease_until = NULL,
            updated_at = now()
      WHERE id = $1 AND workspace_id = $2 AND state = $3 AND row_version = $4
      RETURNING id, workspace_id, project_id, workflow_run_id, kind, state, input_hash,
                input_snapshot, dispatch_seq, row_version, retry_count, is_critical,
                progress_weight, lease_until`,
    [job.id, job.workspace_id, job.state, job.row_version, retryIncrement, availableAt],
  );
  const queued = requireRow(result.rows[0], "JOB_CONFLICT", "Job changed while it was being queued");

  await client.query(
    `INSERT INTO dispatch_outbox (workspace_id, job_id, dispatch_seq, available_at)
     VALUES ($1, $2, $3, COALESCE($4, now()))`,
    [queued.workspace_id, queued.id, queued.dispatch_seq, availableAt],
  );
  await appendDomainEvent(client, queued, "job.queued", traceId, {
    jobId: queued.id,
    workflowRunId: queued.workflow_run_id,
    kind: queued.kind,
    state: "QUEUED",
    dispatchSeq: queued.dispatch_seq,
  });
  await client.query(
    `UPDATE workflow_run
        SET status = 'RUNNING', row_version = row_version + 1, updated_at = now(), completed_at = NULL
      WHERE id = $1 AND status = 'PENDING'`,
    [queued.workflow_run_id],
  );
  return queued;
}

export class JobPersistenceService {
  constructor(private readonly pool: DatabasePool) {}

  async createWorkflowJob(input: CreateWorkflowJobInput): Promise<CreatedWorkflowJob> {
    return withTransaction(this.pool, (client) => createWorkflowJobTx(client, input));
  }

  async createWorkflowJobIdempotent(
    scope: IdempotencyScope,
    input: CreateWorkflowJobInput,
  ): Promise<{ replayed: boolean; status: number; body: CreatedWorkflowJob }> {
    return this.runIdempotent(scope, 202, (client) => createWorkflowJobTx(client, input));
  }

  async runIdempotent<T>(
    scope: IdempotencyScope,
    responseStatus: number,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<{ replayed: boolean; status: number; body: T }> {
    return withTransaction(this.pool, async (client) => {
      const expiresAt = scope.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000);
      const inserted = await client.query<{ id: string } & QueryResultRow>(
        `INSERT INTO idempotency_record
          (workspace_id, actor_id, http_method, route_key, idempotency_key, request_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (workspace_id, actor_id, http_method, route_key, idempotency_key) DO NOTHING
         RETURNING id`,
        [
          scope.workspaceId,
          scope.actorId,
          scope.httpMethod,
          scope.routeKey,
          scope.key,
          scope.requestHash,
          expiresAt,
        ],
      );

      const record = await client.query<IdempotencyRow>(
        `SELECT request_hash, response_status, response_body
           FROM idempotency_record
          WHERE workspace_id = $1 AND actor_id = $2 AND http_method = $3
            AND route_key = $4 AND idempotency_key = $5
          FOR UPDATE`,
        [scope.workspaceId, scope.actorId, scope.httpMethod, scope.routeKey, scope.key],
      );
      const row = requireRow(record.rows[0], "IDEMPOTENCY_RECORD_MISSING", "Idempotency reservation disappeared");

      if (row.request_hash !== scope.requestHash) {
        throw new PersistenceError("IDEMPOTENCY_KEY_REUSED", "Idempotency key was reused with a different request");
      }

      if (inserted.rowCount === 0) {
        if (row.response_status === null || row.response_body === null) {
          throw new PersistenceError("IDEMPOTENCY_IN_PROGRESS", "Idempotent request has not completed");
        }
        return { replayed: true, status: row.response_status, body: row.response_body as T };
      }

      const body = await operation(client);
      await client.query(
        `UPDATE idempotency_record
            SET response_status = $6, response_body = $7::jsonb
          WHERE workspace_id = $1 AND actor_id = $2 AND http_method = $3
            AND route_key = $4 AND idempotency_key = $5`,
        [
          scope.workspaceId,
          scope.actorId,
          scope.httpMethod,
          scope.routeKey,
          scope.key,
          responseStatus,
          JSON.stringify(body),
        ],
      );
      return { replayed: false, status: responseStatus, body };
    });
  }

  async queueJob(input: QueueJobInput): Promise<{ dispatchSeq: number }> {
    return withTransaction(this.pool, async (client) => {
      const job = await loadJobForUpdate(client, input.workspaceId, input.jobId);
      const queued = await queueJobTx(client, job, input.traceId, input.availableAt ?? null, 0);
      return { dispatchSeq: queued.dispatch_seq };
    });
  }

  async acquireQueuedJob(input: {
    workspaceId: string;
    jobId: string;
    dispatchSeq: number;
    leaseOwner: string;
    leaseMs: number;
    traceId: string;
    providerConfigurationId?: string | null;
  }): Promise<AcquiredJob | null> {
    return withTransaction(this.pool, async (client) => {
      const leaseUntil = new Date(Date.now() + input.leaseMs);
      const updated = await client.query<JobRow>(
        `UPDATE generation_job
            SET state = 'RUNNING', lease_owner = $4, lease_until = $5,
                row_version = row_version + 1, updated_at = now()
          WHERE id = $1 AND workspace_id = $2 AND state = 'QUEUED' AND dispatch_seq = $3
            AND (next_run_at IS NULL OR next_run_at <= now())
          RETURNING id, workspace_id, project_id, workflow_run_id, kind, state, input_hash,
                    input_snapshot, dispatch_seq, row_version, retry_count, is_critical,
                    progress_weight, lease_until`,
        [input.jobId, input.workspaceId, input.dispatchSeq, input.leaseOwner, leaseUntil],
      );
      const job = updated.rows[0];
      if (!job) {
        return null;
      }

      const nextAttempt = await client.query<{ attempt_no: number } & QueryResultRow>(
        `SELECT COALESCE(MAX(attempt_no), 0)::int + 1 AS attempt_no
           FROM job_attempt WHERE generation_job_id = $1`,
        [job.id],
      );
      const attemptNo = requireRow(nextAttempt.rows[0], "ATTEMPT_NUMBER_FAILED", "Could not allocate attempt number")
        .attempt_no;
      const clientRequestKey = `${job.id}:${attemptNo}`;
      const attempt = await client.query<{ id: string } & QueryResultRow>(
        `INSERT INTO job_attempt
          (workspace_id, generation_job_id, attempt_no, provider_configuration_id,
           provider_client_request_key, request_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         RETURNING id`,
        [
          job.workspace_id,
          job.id,
          attemptNo,
          input.providerConfigurationId ?? null,
          clientRequestKey,
          JSON.stringify(job.input_snapshot),
        ],
      );
      const attemptId = requireRow(attempt.rows[0], "ATTEMPT_CREATE_FAILED", "Job attempt was not created").id;
      await appendDomainEvent(client, job, "job.started", input.traceId, {
        jobId: job.id,
        attemptId,
        state: "RUNNING",
        dispatchSeq: job.dispatch_seq,
      });
      return {
        jobId: job.id,
        attemptId,
        attemptNo,
        dispatchSeq: job.dispatch_seq,
        workflowRunId: job.workflow_run_id,
      };
    });
  }

  async attachProviderRequest(input: {
    workspaceId: string;
    attemptId: string;
    providerConfigurationId: string;
    providerRequestId: string;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `UPDATE job_attempt
            SET provider_configuration_id = $3, provider_request_id = $4
          WHERE id = $1 AND workspace_id = $2 AND provider_request_id IS NULL`,
        [input.attemptId, input.workspaceId, input.providerConfigurationId, input.providerRequestId],
      );
      if (result.rowCount !== 1) {
        throw new PersistenceError("ATTEMPT_CONFLICT", "Provider request could not be attached to attempt");
      }
    } finally {
      client.release();
    }
  }

  async succeedJob(input: {
    workspaceId: string;
    jobId: string;
    traceId: string;
    responseSnapshot?: unknown;
  }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const job = await loadJobForUpdate(client, input.workspaceId, input.jobId);
      if (TERMINAL_STATES.has(job.state)) {
        throw new PersistenceError("JOB_TERMINAL", "Terminal jobs cannot reopen");
      }
      if (job.state !== "RUNNING" && job.state !== "WAITING_EXTERNAL") {
        throw new PersistenceError("JOB_INVALID_TRANSITION", `Cannot succeed job from ${job.state}`);
      }

      await client.query(
        `UPDATE job_attempt
            SET finished_at = COALESCE(finished_at, now()), response_snapshot = COALESCE($2::jsonb, response_snapshot)
          WHERE id = (
            SELECT id FROM job_attempt WHERE generation_job_id = $1 ORDER BY attempt_no DESC LIMIT 1
          )`,
        [job.id, input.responseSnapshot === undefined ? null : JSON.stringify(input.responseSnapshot)],
      );
      await client.query(
        `UPDATE generation_job
            SET state = 'SUCCEEDED', progress = 100, lease_owner = NULL, lease_until = NULL,
                row_version = row_version + 1, updated_at = now(), completed_at = now()
          WHERE id = $1 AND workspace_id = $2 AND row_version = $3`,
        [job.id, job.workspace_id, job.row_version],
      );
      await appendDomainEvent(client, job, "job.succeeded", input.traceId, {
        jobId: job.id,
        state: "SUCCEEDED",
      });
      await refreshWorkflowStatus(client, job.workflow_run_id);
    });
  }

  async failJob(input: {
    workspaceId: string;
    jobId: string;
    traceId: string;
    errorCode: string;
    errorMessage: string;
    retryable: boolean;
    maxAttempts?: number;
    nextRunAt?: Date;
  }): Promise<"requeued" | "failed"> {
    return withTransaction(this.pool, async (client) => {
      const job = await loadJobForUpdate(client, input.workspaceId, input.jobId);
      if (TERMINAL_STATES.has(job.state)) {
        throw new PersistenceError("JOB_TERMINAL", "Terminal jobs cannot reopen");
      }
      if (job.state !== "RUNNING" && job.state !== "WAITING_EXTERNAL") {
        throw new PersistenceError("JOB_INVALID_TRANSITION", `Cannot fail job from ${job.state}`);
      }

      await client.query(
        `UPDATE job_attempt
            SET finished_at = COALESCE(finished_at, now()), error_json = $2::jsonb
          WHERE id = (
            SELECT id FROM job_attempt WHERE generation_job_id = $1 ORDER BY attempt_no DESC LIMIT 1
          )`,
        [job.id, JSON.stringify({ code: input.errorCode, message: input.errorMessage })],
      );

      const attempts = await client.query<{ count: number } & QueryResultRow>(
        "SELECT COUNT(*)::int AS count FROM job_attempt WHERE generation_job_id = $1",
        [job.id],
      );
      const attemptCount = requireRow(attempts.rows[0], "ATTEMPT_COUNT_FAILED", "Could not count job attempts").count;
      const maxAttempts = input.maxAttempts ?? 3;

      if (input.retryable && attemptCount < maxAttempts) {
        await queueJobTx(client, job, input.traceId, input.nextRunAt ?? null, 1);
        return "requeued";
      }

      await client.query(
        `UPDATE generation_job
            SET state = 'FAILED', error_code = $4, error_message = $5,
                lease_owner = NULL, lease_until = NULL, row_version = row_version + 1,
                updated_at = now(), completed_at = now()
          WHERE id = $1 AND workspace_id = $2 AND row_version = $3`,
        [job.id, job.workspace_id, job.row_version, input.errorCode, input.errorMessage],
      );
      await appendDomainEvent(client, job, "job.failed", input.traceId, {
        jobId: job.id,
        state: "FAILED",
        error: { code: input.errorCode, message: input.errorMessage },
        retryable: input.retryable,
      });
      await refreshWorkflowStatus(client, job.workflow_run_id);
      return "failed";
    });
  }

  async cancelJob(input: { workspaceId: string; jobId: string; traceId: string }): Promise<JobState> {
    return withTransaction(this.pool, async (client) => {
      const job = await loadJobForUpdate(client, input.workspaceId, input.jobId);
      if (TERMINAL_STATES.has(job.state)) {
        throw new PersistenceError("JOB_TERMINAL", "Job is already terminal");
      }

      if (job.state === "PENDING" || job.state === "QUEUED") {
        await client.query(
          `UPDATE generation_job
              SET state = 'CANCELED', row_version = row_version + 1,
                  lease_owner = NULL, lease_until = NULL, updated_at = now(), completed_at = now()
            WHERE id = $1 AND workspace_id = $2 AND row_version = $3`,
          [job.id, job.workspace_id, job.row_version],
        );
        await appendDomainEvent(client, job, "job.canceled", input.traceId, {
          jobId: job.id,
          state: "CANCELED",
        });
        await refreshWorkflowStatus(client, job.workflow_run_id);
        return "CANCELED";
      }

      await client.query(
        `UPDATE generation_job
            SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
                row_version = row_version + 1, updated_at = now()
          WHERE id = $1 AND workspace_id = $2 AND row_version = $3`,
        [job.id, job.workspace_id, job.row_version],
      );
      await appendDomainEvent(client, job, "job.cancel_requested", input.traceId, {
        jobId: job.id,
        state: job.state,
      });
      return job.state;
    });
  }

  async confirmCancellation(input: { workspaceId: string; jobId: string; traceId: string }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const job = await loadJobForUpdate(client, input.workspaceId, input.jobId);
      if (TERMINAL_STATES.has(job.state)) {
        throw new PersistenceError("JOB_TERMINAL", "Job is already terminal");
      }
      if (job.state !== "RUNNING" && job.state !== "WAITING_EXTERNAL") {
        throw new PersistenceError("JOB_INVALID_TRANSITION", `Cannot confirm cancellation from ${job.state}`);
      }

      await client.query(
        `UPDATE job_attempt
            SET finished_at = COALESCE(finished_at, now()),
                error_json = COALESCE(error_json, '{"code":"CANCELED"}'::jsonb)
          WHERE id = (
            SELECT id FROM job_attempt WHERE generation_job_id = $1 ORDER BY attempt_no DESC LIMIT 1
          )`,
        [job.id],
      );
      await client.query(
        `UPDATE generation_job
            SET state = 'CANCELED', lease_owner = NULL, lease_until = NULL,
                row_version = row_version + 1, updated_at = now(), completed_at = now()
          WHERE id = $1 AND workspace_id = $2 AND row_version = $3`,
        [job.id, job.workspace_id, job.row_version],
      );
      await appendDomainEvent(client, job, "job.canceled", input.traceId, {
        jobId: job.id,
        state: "CANCELED",
      });
      await refreshWorkflowStatus(client, job.workflow_run_id);
    });
  }

  async recoverExpiredLease(input: {
    workspaceId: string;
    jobId: string;
    traceId: string;
    maxAttempts?: number;
  }): Promise<"requeued" | "failed" | null> {
    return withTransaction(this.pool, async (client) => {
      const job = await loadJobForUpdate(client, input.workspaceId, input.jobId);
      if (job.state !== "RUNNING" || job.lease_until === null || job.lease_until.getTime() > Date.now()) {
        return null;
      }

      await client.query(
        `UPDATE job_attempt
            SET finished_at = COALESCE(finished_at, now()),
                error_json = COALESCE(error_json, '{"code":"LEASE_EXPIRED"}'::jsonb)
          WHERE id = (
            SELECT id FROM job_attempt WHERE generation_job_id = $1 ORDER BY attempt_no DESC LIMIT 1
          )`,
        [job.id],
      );
      const attempts = await client.query<{ count: number } & QueryResultRow>(
        "SELECT COUNT(*)::int AS count FROM job_attempt WHERE generation_job_id = $1",
        [job.id],
      );
      const attemptCount = requireRow(attempts.rows[0], "ATTEMPT_COUNT_FAILED", "Could not count job attempts").count;
      const maxAttempts = input.maxAttempts ?? 3;

      if (attemptCount < maxAttempts) {
        await queueJobTx(client, job, input.traceId, null, 1);
        return "requeued";
      }

      await client.query(
        `UPDATE generation_job
            SET state = 'FAILED', error_code = 'LEASE_EXPIRED', error_message = 'Worker lease expired',
                lease_owner = NULL, lease_until = NULL, row_version = row_version + 1,
                updated_at = now(), completed_at = now()
          WHERE id = $1 AND workspace_id = $2 AND row_version = $3`,
        [job.id, job.workspace_id, job.row_version],
      );
      await appendDomainEvent(client, job, "job.failed", input.traceId, {
        jobId: job.id,
        state: "FAILED",
        error: { code: "LEASE_EXPIRED", message: "Worker lease expired" },
        retryable: true,
      });
      await refreshWorkflowStatus(client, job.workflow_run_id);
      return "failed";
    });
  }

  async manualRetry(input: ManualRetryInput): Promise<CreatedWorkflowJob & { dispatchSeq: number }> {
    if (!input.retryable) {
      throw new PersistenceError("JOB_NOT_RETRYABLE", "This terminal job is not retryable");
    }

    return withTransaction(this.pool, async (client) => {
      const oldJob = await loadJobForUpdate(client, input.workspaceId, input.jobId);
      if (oldJob.state !== "FAILED" && oldJob.state !== "CANCELED") {
        throw new PersistenceError("JOB_NOT_RETRYABLE", "Manual retry requires FAILED or CANCELED job");
      }
      const source = await client.query<WorkflowSourceRow>(
        "SELECT type, input_snapshot FROM workflow_run WHERE id = $1 AND workspace_id = $2",
        [oldJob.workflow_run_id, oldJob.workspace_id],
      );
      const oldWorkflow = requireRow(source.rows[0], "WORKFLOW_NOT_FOUND", "Source workflow run not found");
      const created = await createWorkflowJobTx(client, {
        workspaceId: oldJob.workspace_id,
        projectId: oldJob.project_id,
        type: oldWorkflow.type,
        requestedBy: input.requestedBy,
        kind: oldJob.kind,
        inputHash: oldJob.input_hash,
        inputSnapshot: oldJob.input_snapshot,
        isCritical: oldJob.is_critical,
        progressWeight: oldJob.progress_weight,
        traceId: input.traceId,
      });
      const newJob = await loadJobForUpdate(client, oldJob.workspace_id, created.jobId);
      const queued = await queueJobTx(client, newJob, input.traceId, null, 0);
      return { ...created, dispatchSeq: queued.dispatch_seq };
    });
  }

  async recordProviderEvent(input: ProviderEventInput): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `INSERT INTO provider_event
          (workspace_id, provider_configuration_id, job_attempt_id, provider_request_id,
           source, normalized_event_key, external_status, payload_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (provider_configuration_id, provider_request_id, normalized_event_key) DO NOTHING
         RETURNING id`,
        [
          input.workspaceId,
          input.providerConfigurationId,
          input.jobAttemptId,
          input.providerRequestId,
          input.source,
          input.normalizedEventKey,
          input.externalStatus,
          input.payloadRef ?? null,
        ],
      );
      return result.rowCount === 1;
    } finally {
      client.release();
    }
  }
}
