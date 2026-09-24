import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool, type QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JobPersistenceService, PersistenceError } from "./job-service";
import { runMigrations } from "./migrations";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
}

const pool = new Pool({ connectionString: databaseUrl, max: 8 });
const service = new JobPersistenceService(pool);

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function seedWorkspaceProject(label = "primary"): Promise<{ workspaceId: string; projectId: string }> {
  const workspace = await pool.query<{ id: string } & QueryResultRow>(
    "INSERT INTO workspace (name) VALUES ($1) RETURNING id",
    [`workspace-${label}`],
  );
  const workspaceId = workspace.rows[0]?.id;
  if (!workspaceId) throw new Error("workspace insert failed");

  const project = await pool.query<{ id: string } & QueryResultRow>(
    "INSERT INTO project (workspace_id, title) VALUES ($1, $2) RETURNING id",
    [workspaceId, `project-${label}`],
  );
  const projectId = project.rows[0]?.id;
  if (!projectId) throw new Error("project insert failed");
  return { workspaceId, projectId };
}

async function createJob(
  workspaceId: string,
  projectId: string,
  label: string,
): Promise<{ workflowRunId: string; jobId: string }> {
  return service.createWorkflowJob({
    workspaceId,
    projectId,
    type: "MOCK_GENERATION",
    requestedBy: "integration-test",
    kind: "MOCK",
    inputHash: hash(label),
    inputSnapshot: { label },
    traceId: `trace-${label}`,
  });
}

async function waitForWorkflowLockWaiters(minimum: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const waiting = await pool.query<{ count: number } & QueryResultRow>(
      `SELECT COUNT(*)::int AS count
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query ILIKE '%workflow_run%'`,
    );
    if ((waiting.rows[0]?.count ?? 0) >= minimum) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for workflow lock contention");
}

beforeAll(async () => {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await runMigrations(pool);
});

beforeEach(async () => {
  await pool.query(`
    TRUNCATE TABLE
      provider_event,
      cost_ledger,
      dispatch_outbox,
      job_attempt,
      generation_job_dependency,
      generation_job,
      domain_event,
      idempotency_record,
      workflow_run,
      provider_configuration,
      project,
      workspace
    RESTART IDENTITY CASCADE
  `);
});

afterAll(async () => {
  await pool.end();
});

describe("M1-B PostgreSQL integration", () => {
  it("executes ordered migrations on one PostgreSQL session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-drama-live-migrations-"));
    const first = join(directory, "9001_session_probe");
    const second = join(directory, "9002_session_probe_use");
    await mkdir(first);
    await mkdir(second);
    await writeFile(
      join(first, "migration.sql"),
      "CREATE TEMP TABLE migration_session_probe (value int); INSERT INTO migration_session_probe VALUES (1);\n",
    );
    await writeFile(
      join(second, "migration.sql"),
      "INSERT INTO migration_session_probe VALUES (2);\n",
    );

    const result = await runMigrations(pool, directory);
    expect(result.applied).toEqual(["9001_session_probe", "9002_session_probe_use"]);
  });

  it("rolls back job state, outbox, and event together on a transaction failure", async () => {
    const { workspaceId, projectId } = await seedWorkspaceProject("rollback");
    const { jobId } = await createJob(workspaceId, projectId, "rollback");

    await pool.query(`
      CREATE OR REPLACE FUNCTION reject_queued_event_for_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'job.queued' THEN
          RAISE EXCEPTION 'forced domain event failure';
        END IF;
        RETURN NEW;
      END $$;
    `);
    await pool.query(`
      CREATE TRIGGER reject_queued_event_for_test
      BEFORE INSERT ON domain_event
      FOR EACH ROW EXECUTE FUNCTION reject_queued_event_for_test()
    `);

    try {
      await expect(service.queueJob({ workspaceId, jobId, traceId: "trace-rollback" })).rejects.toThrow(
        "forced domain event failure",
      );
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS reject_queued_event_for_test ON domain_event");
      await pool.query("DROP FUNCTION IF EXISTS reject_queued_event_for_test()");
    }

    const job = await pool.query<{ state: string; dispatch_seq: number } & QueryResultRow>(
      "SELECT state, dispatch_seq FROM generation_job WHERE id = $1",
      [jobId],
    );
    expect(job.rows[0]).toMatchObject({ state: "PENDING", dispatch_seq: 0 });
    const outbox = await pool.query<{ count: number } & QueryResultRow>(
      "SELECT COUNT(*)::int AS count FROM dispatch_outbox WHERE job_id = $1",
      [jobId],
    );
    expect(outbox.rows[0]?.count).toBe(0);
  });

  it("ignores stale and duplicate dispatches and creates a new attempt on automatic retry", async () => {
    const { workspaceId, projectId } = await seedWorkspaceProject("dispatch");
    const { jobId } = await createJob(workspaceId, projectId, "dispatch");
    const firstQueue = await service.queueJob({ workspaceId, jobId, traceId: "trace-queue-1" });
    expect(firstQueue.dispatchSeq).toBe(1);

    await expect(
      service.acquireQueuedJob({
        workspaceId,
        jobId,
        dispatchSeq: 0,
        leaseOwner: "stale-worker",
        leaseMs: 30_000,
        traceId: "trace-stale",
      }),
    ).resolves.toBeNull();

    const firstAttempt = await service.acquireQueuedJob({
      workspaceId,
      jobId,
      dispatchSeq: 1,
      leaseOwner: "worker-1",
      leaseMs: 30_000,
      traceId: "trace-start-1",
    });
    expect(firstAttempt?.attemptNo).toBe(1);
    if (!firstAttempt) throw new Error("first attempt not acquired");

    await expect(
      service.acquireQueuedJob({
        workspaceId,
        jobId,
        dispatchSeq: 1,
        leaseOwner: "duplicate-worker",
        leaseMs: 30_000,
        traceId: "trace-duplicate",
      }),
    ).resolves.toBeNull();

    await expect(
      service.failJob({
        workspaceId,
        jobId,
        traceId: "trace-retry",
        errorCode: "PROVIDER_5XX",
        errorMessage: "temporary",
        retryable: true,
        attemptId: firstAttempt.attemptId,
      }),
    ).resolves.toBe("requeued");

    const job = await pool.query<{ state: string; dispatch_seq: number; retry_count: number } & QueryResultRow>(
      "SELECT state, dispatch_seq, retry_count FROM generation_job WHERE id = $1",
      [jobId],
    );
    expect(job.rows[0]).toMatchObject({ state: "QUEUED", dispatch_seq: 2, retry_count: 1 });

    await expect(
      service.acquireQueuedJob({
        workspaceId,
        jobId,
        dispatchSeq: 1,
        leaseOwner: "old-message",
        leaseMs: 30_000,
        traceId: "trace-old",
      }),
    ).resolves.toBeNull();

    const secondAttempt = await service.acquireQueuedJob({
      workspaceId,
      jobId,
      dispatchSeq: 2,
      leaseOwner: "worker-2",
      leaseMs: 30_000,
      traceId: "trace-start-2",
    });
    expect(secondAttempt?.jobId).toBe(jobId);
    expect(secondAttempt?.attemptNo).toBe(2);
  });

  it("prevents lease conflicts and recovers an expired lease through a new dispatch generation", async () => {
    const { workspaceId, projectId } = await seedWorkspaceProject("lease");
    const { jobId } = await createJob(workspaceId, projectId, "lease");
    await service.queueJob({ workspaceId, jobId, traceId: "trace-lease-queue" });
    await service.acquireQueuedJob({
      workspaceId,
      jobId,
      dispatchSeq: 1,
      leaseOwner: "worker-a",
      leaseMs: 60_000,
      traceId: "trace-lease-a",
    });

    await expect(
      service.acquireQueuedJob({
        workspaceId,
        jobId,
        dispatchSeq: 1,
        leaseOwner: "worker-b",
        leaseMs: 60_000,
        traceId: "trace-lease-b",
      }),
    ).resolves.toBeNull();

    await pool.query("UPDATE generation_job SET lease_until = now() - interval '1 second' WHERE id = $1", [jobId]);
    await expect(service.recoverExpiredLease({ workspaceId, jobId, traceId: "trace-recover" })).resolves.toBe(
      "requeued",
    );

    const recovered = await pool.query<{ state: string; dispatch_seq: number; retry_count: number } & QueryResultRow>(
      "SELECT state, dispatch_seq, retry_count FROM generation_job WHERE id = $1",
      [jobId],
    );
    expect(recovered.rows[0]).toMatchObject({ state: "QUEUED", dispatch_seq: 2, retry_count: 1 });
  });

  it("keeps a requested cancellation terminal when a late success arrives", async () => {
    const { workspaceId, projectId } = await seedWorkspaceProject("cancel-success-race");
    const { jobId } = await createJob(workspaceId, projectId, "cancel-success-race");
    await service.queueJob({ workspaceId, jobId, traceId: "trace-cancel-race-q" });
    const attempt = await service.acquireQueuedJob({
      workspaceId,
      jobId,
      dispatchSeq: 1,
      leaseOwner: "cancel-race-worker",
      leaseMs: 30_000,
      traceId: "trace-cancel-race-a",
    });
    if (!attempt) throw new Error("cancel race attempt not acquired");

    await expect(
      service.cancelJob({ workspaceId, jobId, traceId: "trace-cancel-race-request" }),
    ).resolves.toBe("RUNNING");
    await service.succeedJob({
      workspaceId,
      jobId,
      attemptId: attempt.attemptId,
      traceId: "trace-cancel-race-late-success",
      responseSnapshot: { late: true },
    });

    const job = await pool.query<{ state: string } & QueryResultRow>(
      "SELECT state FROM generation_job WHERE id = $1",
      [jobId],
    );
    expect(job.rows[0]?.state).toBe("CANCELED");
    const events = await pool.query<{ event_type: string } & QueryResultRow>(
      "SELECT event_type FROM domain_event WHERE aggregate_id = $1 ORDER BY id",
      [jobId],
    );
    expect(events.rows.map((row) => row.event_type)).toContain("job.cancel_requested");
    expect(events.rows.map((row) => row.event_type)).toContain("job.canceled");
    expect(events.rows.map((row) => row.event_type)).not.toContain("job.succeeded");
  });

  it("serializes workflow derivation across concurrent sibling completions", async () => {
    const { workspaceId, projectId } = await seedWorkspaceProject("workflow-concurrency");
    const first = await createJob(workspaceId, projectId, "workflow-concurrency-1");
    const secondInsert = await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO generation_job
        (workspace_id, project_id, workflow_run_id, kind, input_hash, input_snapshot)
       VALUES ($1, $2, $3, 'MOCK', $4, $5::jsonb)
       RETURNING id`,
      [
        workspaceId,
        projectId,
        first.workflowRunId,
        hash("workflow-concurrency-2"),
        JSON.stringify({ label: "workflow-concurrency-2" }),
      ],
    );
    const secondJobId = secondInsert.rows[0]?.id;
    if (!secondJobId) throw new Error("second sibling job insert failed");

    await service.queueJob({ workspaceId, jobId: first.jobId, traceId: "trace-concurrent-q1" });
    await service.queueJob({ workspaceId, jobId: secondJobId, traceId: "trace-concurrent-q2" });
    const firstAttempt = await service.acquireQueuedJob({
      workspaceId,
      jobId: first.jobId,
      dispatchSeq: 1,
      leaseOwner: "concurrent-worker-1",
      leaseMs: 30_000,
      traceId: "trace-concurrent-a1",
    });
    const secondAttempt = await service.acquireQueuedJob({
      workspaceId,
      jobId: secondJobId,
      dispatchSeq: 1,
      leaseOwner: "concurrent-worker-2",
      leaseMs: 30_000,
      traceId: "trace-concurrent-a2",
    });
    if (!firstAttempt || !secondAttempt) throw new Error("concurrent attempts not acquired");

    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM workflow_run WHERE id = $1 FOR UPDATE", [first.workflowRunId]);
    const firstCompletion = service.succeedJob({
      workspaceId,
      jobId: first.jobId,
      attemptId: firstAttempt.attemptId,
      traceId: "trace-concurrent-s1",
    });
    const secondCompletion = service.succeedJob({
      workspaceId,
      jobId: secondJobId,
      attemptId: secondAttempt.attemptId,
      traceId: "trace-concurrent-s2",
    });
    try {
      await waitForWorkflowLockWaiters(2);
    } finally {
      await blocker.query("COMMIT");
      blocker.release();
    }
    await Promise.all([firstCompletion, secondCompletion]);

    const workflow = await pool.query<{ status: string } & QueryResultRow>(
      "SELECT status FROM workflow_run WHERE id = $1",
      [first.workflowRunId],
    );
    expect(workflow.rows[0]?.status).toBe("SUCCEEDED");
  });

  it("rejects terminal updates from superseded attempts", async () => {
    const { workspaceId, projectId } = await seedWorkspaceProject("superseded-attempt");
    const { jobId } = await createJob(workspaceId, projectId, "superseded-attempt");
    await service.queueJob({ workspaceId, jobId, traceId: "trace-superseded-q1" });
    const firstAttempt = await service.acquireQueuedJob({
      workspaceId,
      jobId,
      dispatchSeq: 1,
      leaseOwner: "superseded-worker-1",
      leaseMs: 30_000,
      traceId: "trace-superseded-a1",
    });
    if (!firstAttempt) throw new Error("first superseded attempt not acquired");

    await pool.query("UPDATE generation_job SET lease_until = now() - interval '1 second' WHERE id = $1", [jobId]);
    await expect(service.recoverExpiredLease({ workspaceId, jobId, traceId: "trace-superseded-recover" })).resolves.toBe(
      "requeued",
    );
    const secondAttempt = await service.acquireQueuedJob({
      workspaceId,
      jobId,
      dispatchSeq: 2,
      leaseOwner: "superseded-worker-2",
      leaseMs: 30_000,
      traceId: "trace-superseded-a2",
    });
    if (!secondAttempt) throw new Error("second superseded attempt not acquired");

    await expect(
      service.succeedJob({
        workspaceId,
        jobId,
        attemptId: firstAttempt.attemptId,
        traceId: "trace-stale-success",
      }),
    ).rejects.toMatchObject({ code: "ATTEMPT_SUPERSEDED" });
    await expect(
      service.failJob({
        workspaceId,
        jobId,
        attemptId: firstAttempt.attemptId,
        traceId: "trace-stale-failure",
        errorCode: "STALE_WORKER",
        errorMessage: "stale result",
        retryable: true,
      }),
    ).rejects.toMatchObject({ code: "ATTEMPT_SUPERSEDED" });

    const current = await pool.query<{ state: string } & QueryResultRow>(
      "SELECT state FROM generation_job WHERE id = $1",
      [jobId],
    );
    expect(current.rows[0]?.state).toBe("RUNNING");
  });

  it("reconciles persisted provider requests before expired-lease redispatch", async () => {
    const { workspaceId, projectId } = await seedWorkspaceProject("provider-recovery");
    const provider = await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO provider_configuration
        (workspace_id, provider_key, capability, default_timeout_ms)
       VALUES ($1, 'mock-recovery', 'text', 30000)
       RETURNING id`,
      [workspaceId],
    );
    const providerConfigurationId = provider.rows[0]?.id;
    if (!providerConfigurationId) throw new Error("provider recovery config insert failed");

    const { jobId } = await createJob(workspaceId, projectId, "provider-recovery");
    await service.queueJob({ workspaceId, jobId, traceId: "trace-provider-recovery-q" });
    const attempt = await service.acquireQueuedJob({
      workspaceId,
      jobId,
      dispatchSeq: 1,
      leaseOwner: "provider-recovery-worker",
      leaseMs: 30_000,
      traceId: "trace-provider-recovery-a",
      providerConfigurationId,
    });
    if (!attempt) throw new Error("provider recovery attempt not acquired");
    await service.attachProviderRequest({
      workspaceId,
      attemptId: attempt.attemptId,
      providerConfigurationId,
      providerRequestId: "provider-request-active",
    });
    await pool.query("UPDATE generation_job SET lease_until = now() - interval '1 second' WHERE id = $1", [jobId]);

    const inspections: Array<{ providerConfigurationId: string; providerRequestId: string }> = [];
    const activeInspector = new JobPersistenceService(pool, {
      inspect: async (input) => {
        inspections.push(input);
        return "ACTIVE";
      },
    });
    await expect(
      activeInspector.recoverExpiredLease({ workspaceId, jobId, traceId: "trace-provider-recovery-active" }),
    ).resolves.toBe("deferred");
    expect(inspections).toEqual([{ providerConfigurationId, providerRequestId: "provider-request-active" }]);

    const deferred = await pool.query<{ state: string; dispatch_seq: number } & QueryResultRow>(
      "SELECT state, dispatch_seq FROM generation_job WHERE id = $1",
      [jobId],
    );
    expect(deferred.rows[0]).toMatchObject({ state: "RUNNING", dispatch_seq: 1 });

    const failedInspector = new JobPersistenceService(pool, {
      inspect: async () => "FAILED",
    });
    await expect(
      failedInspector.recoverExpiredLease({ workspaceId, jobId, traceId: "trace-provider-recovery-failed" }),
    ).resolves.toBe("requeued");
    const recovered = await pool.query<{ state: string; dispatch_seq: number } & QueryResultRow>(
      "SELECT state, dispatch_seq FROM generation_job WHERE id = $1",
      [jobId],
    );
    expect(recovered.rows[0]).toMatchObject({ state: "QUEUED", dispatch_seq: 2 });
  });

  it("enforces persisted provider retry ceilings for failures and lease recovery", async () => {
    const { workspaceId, projectId } = await seedWorkspaceProject("retry-ceiling");
    const provider = await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO provider_configuration
        (workspace_id, provider_key, capability, default_timeout_ms, max_attempts)
       VALUES ($1, 'mock-ceiling', 'text', 30000, 1)
       RETURNING id`,
      [workspaceId],
    );
    const providerConfigurationId = provider.rows[0]?.id;
    if (!providerConfigurationId) throw new Error("retry ceiling config insert failed");

    const failureJob = await createJob(workspaceId, projectId, "retry-ceiling-failure");
    await service.queueJob({ workspaceId, jobId: failureJob.jobId, traceId: "trace-ceiling-failure-q" });
    const failureAttempt = await service.acquireQueuedJob({
      workspaceId,
      jobId: failureJob.jobId,
      dispatchSeq: 1,
      leaseOwner: "ceiling-failure-worker",
      leaseMs: 30_000,
      traceId: "trace-ceiling-failure-a",
      providerConfigurationId,
    });
    if (!failureAttempt) throw new Error("retry ceiling failure attempt not acquired");
    await expect(
      service.failJob({
        workspaceId,
        jobId: failureJob.jobId,
        attemptId: failureAttempt.attemptId,
        traceId: "trace-ceiling-failure",
        errorCode: "RETRYABLE",
        errorMessage: "must respect persisted ceiling",
        retryable: true,
      }),
    ).resolves.toBe("failed");

    const recoveryJob = await createJob(workspaceId, projectId, "retry-ceiling-recovery");
    await service.queueJob({ workspaceId, jobId: recoveryJob.jobId, traceId: "trace-ceiling-recovery-q" });
    await service.acquireQueuedJob({
      workspaceId,
      jobId: recoveryJob.jobId,
      dispatchSeq: 1,
      leaseOwner: "ceiling-recovery-worker",
      leaseMs: 30_000,
      traceId: "trace-ceiling-recovery-a",
      providerConfigurationId,
    });
    await pool.query("UPDATE generation_job SET lease_until = now() - interval '1 second' WHERE id = $1", [
      recoveryJob.jobId,
    ]);
    await expect(
      service.recoverExpiredLease({
        workspaceId,
        jobId: recoveryJob.jobId,
        traceId: "trace-ceiling-recovery",
      }),
    ).resolves.toBe("failed");

    const jobs = await pool.query<{ id: string; state: string; dispatch_seq: number; retry_count: number } & QueryResultRow>(
      `SELECT id, state, dispatch_seq, retry_count
         FROM generation_job
        WHERE id = ANY($1::uuid[])`,
      [[failureJob.jobId, recoveryJob.jobId]],
    );
    for (const row of jobs.rows) {
      expect(row).toMatchObject({ state: "FAILED", dispatch_seq: 1, retry_count: 0 });
    }
  });

  it("keeps terminal jobs immutable", async () => {
    const { workspaceId, projectId } = await seedWorkspaceProject("terminal");
    const { jobId } = await createJob(workspaceId, projectId, "terminal");
    await service.queueJob({ workspaceId, jobId, traceId: "trace-terminal-queue" });
    const terminalAttempt = await service.acquireQueuedJob({
      workspaceId,
      jobId,
      dispatchSeq: 1,
      leaseOwner: "worker-terminal",
      leaseMs: 30_000,
      traceId: "trace-terminal-start",
    });
    if (!terminalAttempt) throw new Error("terminal attempt not acquired");
    await service.succeedJob({
      workspaceId,
      jobId,
      attemptId: terminalAttempt.attemptId,
      traceId: "trace-terminal-success",
    });

    await expect(service.queueJob({ workspaceId, jobId, traceId: "trace-reopen" })).rejects.toMatchObject({
      code: "JOB_TERMINAL",
    });
    await expect(service.cancelJob({ workspaceId, jobId, traceId: "trace-cancel-terminal" })).rejects.toMatchObject({
      code: "JOB_TERMINAL",
    });
  });

  it("creates a new workflow and job for a manual retry without mutating the terminal source", async () => {
    const { workspaceId, projectId } = await seedWorkspaceProject("manual-retry");
    const original = await createJob(workspaceId, projectId, "manual-retry");
    await service.queueJob({ workspaceId, jobId: original.jobId, traceId: "trace-manual-queue" });
    const manualAttempt = await service.acquireQueuedJob({
      workspaceId,
      jobId: original.jobId,
      dispatchSeq: 1,
      leaseOwner: "worker-manual",
      leaseMs: 30_000,
      traceId: "trace-manual-start",
    });
    if (!manualAttempt) throw new Error("manual retry source attempt not acquired");
    await service.failJob({
      workspaceId,
      jobId: original.jobId,
      traceId: "trace-manual-fail",
      errorCode: "PERMANENT_FOR_ATTEMPT",
      errorMessage: "manual retry required",
      retryable: false,
      attemptId: manualAttempt.attemptId,
    });

    const retried = await service.manualRetry({
      workspaceId,
      jobId: original.jobId,
      requestedBy: "integration-test",
      traceId: "trace-manual-retry",
      retryable: true,
    });
    expect(retried.jobId).not.toBe(original.jobId);
    expect(retried.workflowRunId).not.toBe(original.workflowRunId);
    expect(retried.dispatchSeq).toBe(1);

    const states = await pool.query<{ id: string; state: string } & QueryResultRow>(
      "SELECT id, state FROM generation_job WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[original.jobId, retried.jobId]],
    );
    const byId = new Map(states.rows.map((row) => [row.id, row.state]));
    expect(byId.get(original.jobId)).toBe("FAILED");
    expect(byId.get(retried.jobId)).toBe("QUEUED");
  });

  it("replays identical idempotent requests, rejects key reuse, and rolls back business writes with reservations", async () => {
    const { workspaceId, projectId } = await seedWorkspaceProject("idempotency");
    const scope = {
      workspaceId,
      actorId: "owner",
      httpMethod: "POST",
      routeKey: "/mock-jobs",
      key: "key-1",
      requestHash: hash("request-1"),
    };
    const input = {
      workspaceId,
      projectId,
      type: "MOCK_GENERATION",
      requestedBy: "owner",
      kind: "MOCK",
      inputHash: hash("job-input"),
      inputSnapshot: { prompt: "hello" },
      traceId: "trace-idempotency",
    };

    const first = await service.createWorkflowJobIdempotent(scope, input);
    const replay = await service.createWorkflowJobIdempotent(scope, input);
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.body).toEqual(first.body);

    await expect(
      service.createWorkflowJobIdempotent({ ...scope, requestHash: hash("different-request") }, input),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });

    const rollbackScope = { ...scope, key: "key-rollback", requestHash: hash("rollback-request") };
    await expect(
      service.runIdempotent(rollbackScope, 201, async (client) => {
        await client.query("INSERT INTO project (workspace_id, title) VALUES ($1, 'must-rollback')", [workspaceId]);
        throw new PersistenceError("FORCED_FAILURE", "force rollback");
      }),
    ).rejects.toMatchObject({ code: "FORCED_FAILURE" });

    const leaked = await pool.query<{ count: number } & QueryResultRow>(
      "SELECT COUNT(*)::int AS count FROM project WHERE workspace_id = $1 AND title = 'must-rollback'",
      [workspaceId],
    );
    expect(leaked.rows[0]?.count).toBe(0);
    const reservation = await pool.query<{ count: number } & QueryResultRow>(
      "SELECT COUNT(*)::int AS count FROM idempotency_record WHERE workspace_id = $1 AND idempotency_key = 'key-rollback'",
      [workspaceId],
    );
    expect(reservation.rows[0]?.count).toBe(0);

    const expiredScope = {
      ...scope,
      key: "key-expired",
      requestHash: hash("expired-request-1"),
      expiresAt: new Date(Date.now() - 1_000),
    };
    const expiredFirst = await service.createWorkflowJobIdempotent(expiredScope, input);
    const expiredSecond = await service.createWorkflowJobIdempotent(
      { ...expiredScope, requestHash: hash("expired-request-2"), expiresAt: new Date(Date.now() + 60_000) },
      input,
    );
    expect(expiredFirst.replayed).toBe(false);
    expect(expiredSecond.replayed).toBe(false);
    expect(expiredSecond.body.jobId).not.toBe(expiredFirst.body.jobId);
  });

  it("deduplicates provider events and binds each event to the exact attempt/request lineage", async () => {
    const { workspaceId, projectId } = await seedWorkspaceProject("provider-event");
    const provider = await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO provider_configuration
        (workspace_id, provider_key, capability, default_timeout_ms)
       VALUES ($1, 'mock', 'text', 30000) RETURNING id`,
      [workspaceId],
    );
    const providerConfigurationId = provider.rows[0]?.id;
    if (!providerConfigurationId) throw new Error("provider config insert failed");

    const first = await createJob(workspaceId, projectId, "provider-1");
    await service.queueJob({ workspaceId, jobId: first.jobId, traceId: "trace-provider-q1" });
    const firstAttempt = await service.acquireQueuedJob({
      workspaceId,
      jobId: first.jobId,
      dispatchSeq: 1,
      leaseOwner: "provider-worker-1",
      leaseMs: 30_000,
      traceId: "trace-provider-a1",
      providerConfigurationId,
    });
    if (!firstAttempt) throw new Error("first attempt not acquired");
    await service.attachProviderRequest({
      workspaceId,
      attemptId: firstAttempt.attemptId,
      providerConfigurationId,
      providerRequestId: "request-1",
    });

    const event = {
      workspaceId,
      providerConfigurationId,
      jobAttemptId: firstAttempt.attemptId,
      providerRequestId: "request-1",
      source: "CALLBACK" as const,
      normalizedEventKey: "event-1",
      externalStatus: "SUCCEEDED",
    };
    await expect(service.recordProviderEvent(event)).resolves.toBe(true);
    await expect(service.recordProviderEvent(event)).resolves.toBe(false);

    const second = await createJob(workspaceId, projectId, "provider-2");
    await service.queueJob({ workspaceId, jobId: second.jobId, traceId: "trace-provider-q2" });
    const secondAttempt = await service.acquireQueuedJob({
      workspaceId,
      jobId: second.jobId,
      dispatchSeq: 1,
      leaseOwner: "provider-worker-2",
      leaseMs: 30_000,
      traceId: "trace-provider-a2",
      providerConfigurationId,
    });
    if (!secondAttempt) throw new Error("second attempt not acquired");
    await service.attachProviderRequest({
      workspaceId,
      attemptId: secondAttempt.attemptId,
      providerConfigurationId,
      providerRequestId: "request-2",
    });

    await expect(
      service.recordProviderEvent({
        ...event,
        jobAttemptId: secondAttempt.attemptId,
        normalizedEventKey: "mismatched-attempt",
      }),
    ).rejects.toThrow();
  });

  it("enforces workspace-scoped composite relationships", async () => {
    const first = await seedWorkspaceProject("workspace-a");
    const second = await seedWorkspaceProject("workspace-b");

    await expect(
      pool.query(
        `INSERT INTO workflow_run (workspace_id, project_id, type, requested_by, input_snapshot)
         VALUES ($1, $2, 'MOCK', 'test', '{}'::jsonb)`,
        [second.workspaceId, first.projectId],
      ),
    ).rejects.toThrow();
  });

  it("persists DomainEvents with job state changes", async () => {
    const { workspaceId, projectId } = await seedWorkspaceProject("events");
    const { workflowRunId, jobId } = await createJob(workspaceId, projectId, "events");
    await service.queueJob({ workspaceId, jobId, traceId: "trace-events-queue" });
    const eventsAttempt = await service.acquireQueuedJob({
      workspaceId,
      jobId,
      dispatchSeq: 1,
      leaseOwner: "events-worker",
      leaseMs: 30_000,
      traceId: "trace-events-start",
    });
    if (!eventsAttempt) throw new Error("events attempt not acquired");
    await service.succeedJob({
      workspaceId,
      jobId,
      attemptId: eventsAttempt.attemptId,
      traceId: "trace-events-success",
    });

    const events = await pool.query<{ event_type: string } & QueryResultRow>(
      "SELECT event_type FROM domain_event WHERE aggregate_id = $1 ORDER BY id",
      [jobId],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      "job.created",
      "job.queued",
      "job.started",
      "job.succeeded",
    ]);

    const workflowEvents = await pool.query<{ event_type: string; payload_json: { status?: string } } & QueryResultRow>(
      "SELECT event_type, payload_json FROM domain_event WHERE aggregate_id = $1 ORDER BY id",
      [workflowRunId],
    );
    expect(workflowEvents.rows.map((row) => row.event_type)).toEqual(["workflow.updated", "workflow.updated"]);
    expect(workflowEvents.rows.map((row) => row.payload_json.status)).toEqual(["RUNNING", "SUCCEEDED"]);
  });
});
