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

  it("keeps terminal jobs immutable", async () => {
    const { workspaceId, projectId } = await seedWorkspaceProject("terminal");
    const { jobId } = await createJob(workspaceId, projectId, "terminal");
    await service.queueJob({ workspaceId, jobId, traceId: "trace-terminal-queue" });
    await service.acquireQueuedJob({
      workspaceId,
      jobId,
      dispatchSeq: 1,
      leaseOwner: "worker-terminal",
      leaseMs: 30_000,
      traceId: "trace-terminal-start",
    });
    await service.succeedJob({ workspaceId, jobId, traceId: "trace-terminal-success" });

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
    await service.acquireQueuedJob({
      workspaceId,
      jobId: original.jobId,
      dispatchSeq: 1,
      leaseOwner: "worker-manual",
      leaseMs: 30_000,
      traceId: "trace-manual-start",
    });
    await service.failJob({
      workspaceId,
      jobId: original.jobId,
      traceId: "trace-manual-fail",
      errorCode: "PERMANENT_FOR_ATTEMPT",
      errorMessage: "manual retry required",
      retryable: false,
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
    const { jobId } = await createJob(workspaceId, projectId, "events");
    await service.queueJob({ workspaceId, jobId, traceId: "trace-events-queue" });
    await service.acquireQueuedJob({
      workspaceId,
      jobId,
      dispatchSeq: 1,
      leaseOwner: "events-worker",
      leaseMs: 30_000,
      traceId: "trace-events-start",
    });
    await service.succeedJob({ workspaceId, jobId, traceId: "trace-events-success" });

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
  });
});
