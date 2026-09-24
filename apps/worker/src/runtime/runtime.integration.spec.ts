import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  JobPersistenceService,
  RuntimeStore,
  closePostgresPool,
  createPostgresPool,
  runMigrations,
  type PostgresPool,
} from "@ai-drama/database";
import { MockProvider } from "@ai-drama/providers";
import { BullMqQueue } from "./bullmq-queue";
import { MockJobConsumer } from "./consumer";
import { OutboxDispatcher, dispatchJobId } from "./dispatcher";
import { RuntimeReconciler } from "./reconciler";
import { startQueueRuntime } from "./start-runtime";

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
if (!databaseUrl || !redisUrl) {
  throw new Error("DATABASE_URL and REDIS_URL are required for Redis/BullMQ integration tests");
}

const pool: PostgresPool = createPostgresPool({
  connectionString: databaseUrl,
  connectionTimeoutMs: 2_000,
  statementTimeoutMs: 10_000,
  queryTimeoutMs: 10_000,
});

async function sql<T>(text: string, values: unknown[] = []): Promise<{ rows: T[] }> {
  return pool.query(text, values) as Promise<{ rows: T[] }>;
}
const provider = new MockProvider();
const jobs = new JobPersistenceService(pool, {
  inspect: ({ providerRequestId }) => {
    const state = provider.inspect(providerRequestId);
    if (state === "SUCCEEDED") return Promise.resolve("SUCCEEDED");
    if (state === "FAILED" || state === "CANCELED") return Promise.resolve("FAILED");
    if (state === "ACTIVE") return Promise.resolve("ACTIVE");
    return Promise.resolve("UNKNOWN");
  },
});
const store = new RuntimeStore(pool);
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const prefix = `m1c-${randomUUID()}`;
const queue = new BullMqQueue({ url: redisUrl, maxRetriesPerRequest: null }, prefix);
const dispatcher = new OutboxDispatcher(store, queue);
const consumer = new MockJobConsumer(jobs, store, provider, "integration-worker", 1_000);
const reconciler = new RuntimeReconciler(jobs, store, provider, dispatcher, 0);

async function seed(): Promise<{ workspaceId: string; projectId: string; providerId: string }> {
  const workspace = await sql<{ id: string }>(
    "INSERT INTO workspace (name) VALUES ($1) RETURNING id",
    [`ws-${randomUUID()}`],
  );
  const workspaceId = workspace.rows[0]?.id;
  if (!workspaceId) throw new Error("workspace missing");
  const project = await sql<{ id: string }>(
    "INSERT INTO project (workspace_id, title) VALUES ($1, $2) RETURNING id",
    [workspaceId, "runtime"],
  );
  const projectId = project.rows[0]?.id;
  if (!projectId) throw new Error("project missing");
  const providerId = await store.ensureMockProvider(workspaceId, 3);
  return { workspaceId, projectId, providerId };
}

async function queueOutcome(workspaceId: string, projectId: string, outcome: string) {
  const created = await jobs.createWorkflowJob({
    workspaceId,
    projectId,
    type: "MOCK_GENERATION",
    requestedBy: "integration",
    kind: "MOCK",
    inputHash: outcome,
    inputSnapshot: { outcome },
    traceId: `trace-${outcome}`,
  });
  const queued = await jobs.queueJob({ workspaceId, jobId: created.jobId, traceId: `trace-${outcome}` });
  return { ...created, dispatchSeq: queued.dispatchSeq };
}

async function jobState(jobId: string): Promise<string> {
  const result = await sql<{ state: string }>(
    "SELECT state FROM generation_job WHERE id = $1",
    [jobId],
  );
  return result.rows[0]?.state ?? "";
}

beforeAll(async () => {
  await sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await runMigrations(pool);
});

beforeEach(async () => {
  await sql(`
    TRUNCATE TABLE
      provider_event, cost_ledger, dispatch_outbox, job_attempt, generation_job_dependency,
      generation_job, domain_event, idempotency_record, workflow_run, provider_configuration,
      project, workspace
    RESTART IDENTITY CASCADE
  `);
  await queue.queue.obliterate({ force: true });
});

afterAll(async () => {
  await queue.close();
  redis.disconnect();
  await closePostgresPool(pool);
});

describe("M1-C Redis and BullMQ integration", () => {
  it("marks the outbox dispatched only after BullMQ accepts the job id", async () => {
    const { workspaceId, projectId } = await seed();
    const created = await queueOutcome(workspaceId, projectId, "success");
    const before = await sql<{ dispatched_at: Date | null }>(
      "SELECT dispatched_at FROM dispatch_outbox WHERE job_id = $1",
      [created.jobId],
    );
    expect(before.rows[0]?.dispatched_at).toBeNull();
    await dispatcher.dispatchOnce();
    const after = await sql<{ dispatched_at: Date | null }>(
      "SELECT dispatched_at FROM dispatch_outbox WHERE job_id = $1",
      [created.jobId],
    );
    expect(after.rows[0]?.dispatched_at).toBeTruthy();
    const bullJob = await queue.queue.getJob(dispatchJobId(created.jobId, created.dispatchSeq));
    expect(bullJob?.id).toBe(dispatchJobId(created.jobId, created.dispatchSeq));
  });

  it("treats a repeated enqueue of the same dispatch id as safe", async () => {
    const { workspaceId, projectId } = await seed();
    const created = await queueOutcome(workspaceId, projectId, "success");
    await dispatcher.dispatchOnce();
    await sql("UPDATE dispatch_outbox SET dispatched_at = NULL WHERE job_id = $1", [created.jobId]);
    await expect(dispatcher.dispatchOnce()).resolves.toBe(1);
    const count = await queue.queue.getJobCountByTypes("waiting", "paused", "delayed");
    expect(count).toBe(1);
  });

  it("ignores a stale dispatch sequence and a duplicate message", async () => {
    const { workspaceId, projectId } = await seed();
    const created = await queueOutcome(workspaceId, projectId, "success");
    expect(await consumer.handle({ ...created, dispatchSeq: created.dispatchSeq + 9 })).toBe("ignored");
    expect(await consumer.handle(created)).toBe("processed");
    expect(await consumer.handle(created)).toBe("ignored");
    expect(await jobState(created.jobId)).toBe("SUCCEEDED");
  });

  it("creates a job attempt while the worker holds the lease", async () => {
    const { workspaceId, projectId } = await seed();
    const created = await queueOutcome(workspaceId, projectId, "success");
    await consumer.handle(created);
    const attempts = await sql<{ count: number; lease_owner: string | null }>(
      `SELECT COUNT(*)::int AS count, MAX(j.lease_owner) AS lease_owner
         FROM job_attempt a JOIN generation_job j ON j.id = a.generation_job_id
        WHERE a.generation_job_id = $1`,
      [created.jobId],
    );
    expect(attempts.rows[0]?.count).toBe(1);
    expect(attempts.rows[0]?.lease_owner).toBeNull();
  });

  it("completes success, retryable, terminal, and cooperative cancel outcomes", async () => {
    const { workspaceId, projectId } = await seed();
    const success = await queueOutcome(workspaceId, projectId, "success");
    const retryable = await queueOutcome(workspaceId, projectId, "retryable_failure");
    const terminal = await queueOutcome(workspaceId, projectId, "terminal_failure");
    const cancel = await queueOutcome(workspaceId, projectId, "cancel");
    await consumer.handle(success);
    await consumer.handle(retryable);
    await consumer.handle(terminal);
    await consumer.handle(cancel);
    expect(await jobState(success.jobId)).toBe("SUCCEEDED");
    expect(await jobState(retryable.jobId)).toBe("QUEUED");
    expect(await jobState(terminal.jobId)).toBe("FAILED");
    expect(await jobState(cancel.jobId)).toBe("CANCELED");
    const attempts = await sql<{ attempt_no: number; dispatch_seq: number }>(
      `SELECT MAX(a.attempt_no)::int AS attempt_no, j.dispatch_seq
         FROM generation_job j JOIN job_attempt a ON a.generation_job_id = j.id
        WHERE j.id = $1 GROUP BY j.dispatch_seq`,
      [retryable.jobId],
    );
    expect(attempts.rows[0]?.attempt_no).toBe(1);
    expect(attempts.rows[0]?.dispatch_seq).toBe(2);
  });

  it("keeps automatic retry on the same job and manual retry on a new workflow", async () => {
    const { workspaceId, projectId } = await seed();
    const created = await queueOutcome(workspaceId, projectId, "terminal_failure");
    await consumer.handle(created);
    const retried = await jobs.manualRetry({
      workspaceId,
      jobId: created.jobId,
      requestedBy: "integration",
      traceId: "manual",
      retryable: true,
    });
    expect(retried.jobId).not.toBe(created.jobId);
    expect(retried.workflowRunId).not.toBe(created.workflowRunId);
    expect(await jobState(created.jobId)).toBe("FAILED");
  });

  it("recovers an expired lease and a lost Redis message without a blind provider submit", async () => {
    const { workspaceId, projectId } = await seed();
    const lost = await queueOutcome(workspaceId, projectId, "success");
    await dispatcher.dispatchOnce();
    await queue.queue.obliterate({ force: true });
    expect(await jobState(lost.jobId)).toBe("QUEUED");
    await reconciler.reconcileOnce();
    const redispatched = await sql<{ dispatch_seq: number }>(
      "SELECT dispatch_seq FROM generation_job WHERE id = $1",
      [lost.jobId],
    );
    expect(redispatched.rows[0]?.dispatch_seq).toBe(2);
    const restored = await queue.queue.getJob(dispatchJobId(lost.jobId, 2));
    expect(restored).toBeTruthy();

    const delayed = await queueOutcome(workspaceId, projectId, "delayed");
    await consumer.handle(delayed);
    expect(await jobState(delayed.jobId)).toBe("WAITING_EXTERNAL");
    await sql(
      "UPDATE generation_job SET state = 'RUNNING', lease_owner = 'expired-worker', lease_until = now() - interval '1 minute' WHERE id = $1",
      [delayed.jobId],
    );
    const seqBefore = await sql<{ dispatch_seq: number }>(
      "SELECT dispatch_seq FROM generation_job WHERE id = $1",
      [delayed.jobId],
    );
    await reconciler.reconcileOnce();
    const seqAfter = await sql<{ dispatch_seq: number }>(
      "SELECT dispatch_seq FROM generation_job WHERE id = $1",
      [delayed.jobId],
    );
    expect(seqAfter.rows[0]?.dispatch_seq).toBe(seqBefore.rows[0]?.dispatch_seq);
    const restartedProvider = new MockProvider();
    const restartedReconciler = new RuntimeReconciler(jobs, store, restartedProvider, dispatcher, 0);
    await restartedReconciler.reconcileOnce();
    expect(await jobState(delayed.jobId)).toBe("SUCCEEDED");
  });

  it("rejects cancellation from a superseded attempt", async () => {
    const { workspaceId, projectId, providerId } = await seed();
    const created = await queueOutcome(workspaceId, projectId, "success");
    const first = await jobs.acquireQueuedJob({
      workspaceId,
      jobId: created.jobId,
      dispatchSeq: 1,
      leaseOwner: "cancel-worker-1",
      leaseMs: 1_000,
      traceId: "cancel-attempt-1",
      providerConfigurationId: providerId,
    });
    if (!first) throw new Error("first cancellation attempt not acquired");
    await sql("UPDATE generation_job SET lease_until = now() - interval '1 second' WHERE id = $1", [created.jobId]);
    await expect(
      jobs.recoverExpiredLease({ workspaceId, jobId: created.jobId, traceId: "cancel-recover" }),
    ).resolves.toBe("requeued");
    const second = await jobs.acquireQueuedJob({
      workspaceId,
      jobId: created.jobId,
      dispatchSeq: 2,
      leaseOwner: "cancel-worker-2",
      leaseMs: 1_000,
      traceId: "cancel-attempt-2",
      providerConfigurationId: providerId,
    });
    if (!second) throw new Error("second cancellation attempt not acquired");

    await expect(
      jobs.confirmCancellation({
        workspaceId,
        jobId: created.jobId,
        attemptId: first.attemptId,
        traceId: "stale-cancel",
      }),
    ).rejects.toMatchObject({ code: "ATTEMPT_SUPERSEDED" });
    expect(await jobState(created.jobId)).toBe("RUNNING");

    await jobs.confirmCancellation({
      workspaceId,
      jobId: created.jobId,
      attemptId: second.attemptId,
      traceId: "current-cancel",
    });
    expect(await jobState(created.jobId)).toBe("CANCELED");
  });

  it("honors the persisted provider max_attempts", async () => {
    const { workspaceId, projectId, providerId } = await seed();
    await sql("UPDATE provider_configuration SET max_attempts = 1 WHERE id = $1", [providerId]);
    const created = await queueOutcome(workspaceId, projectId, "retryable_failure");
    await consumer.handle(created);
    expect(await jobState(created.jobId)).toBe("FAILED");
    const attempts = await sql<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM job_attempt WHERE generation_job_id = $1",
      [created.jobId],
    );
    expect(attempts.rows[0]?.count).toBe(1);
  });

  it("closes PostgreSQL and Redis connections after runtime shutdown", async () => {
    const runtime = await startQueueRuntime({
      databaseUrl,
      redisUrl,
      dispatchIntervalMs: 60_000,
      reconcileIntervalMs: 60_000,
    });
    expect(runtime.status.running).toBe(true);
    await runtime.shutdown();
    expect(runtime.status.running).toBe(false);
    await expect(redis.ping()).resolves.toBe("PONG");
  });
});
