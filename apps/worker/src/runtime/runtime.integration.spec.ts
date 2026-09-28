import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { MockMediaAdapter } from "@ai-drama/providers";
import { MediaAssetStore } from "@ai-drama/database";
import { BullMqQueue, startBullWorker } from "./bullmq-queue";
import { MockJobConsumer } from "./consumer";
import { OutboxDispatcher, dispatchJobId } from "./dispatcher";
import { RuntimeReconciler } from "./reconciler";
import { startQueueRuntime } from "./start-runtime";
import { MockMediaRecovery } from "./mock-media-recovery";
import { LocalMockObjects } from "./local-mock-objects";

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

async function seedApprovedMediaShot(): Promise<{
  workspaceId: string; projectId: string; shotRevisionId: string; mediaProviderId: string;
}> {
  const { workspaceId, projectId } = await seed();
  const checksum = "ab".repeat(32);
  const insertId = async (query: string, values: unknown[]) => {
    const result = await sql<{ id: string }>(query, values);
    if (!result.rows[0]?.id) throw new Error("fixture insert failed");
    return result.rows[0].id;
  };
  const story = await insertId(
    `INSERT INTO story_revision (workspace_id, project_id, revision_no, content_json,
       content_hash, created_by) VALUES ($1,$2,1,'{}'::jsonb,$3,'test') RETURNING id`,
    [workspaceId, projectId, checksum]);
  await sql(`UPDATE story_revision SET review_status = 'APPROVED', reviewed_by = 'test',
    reviewed_at = now(), reviewed_content_hash = content_hash WHERE id = $1`, [story]);
  await sql(`UPDATE project SET current_story_revision_id = $1,
    approved_story_revision_id = $1 WHERE id = $2`, [story, projectId]);
  const episode = await insertId(`INSERT INTO episode (workspace_id, project_id, episode_no, title)
    VALUES ($1,$2,1,'test') RETURNING id`, [workspaceId, projectId]);
  const script = await insertId(`INSERT INTO script_revision (workspace_id, project_id, episode_id,
    revision_no, source_story_revision_id, content_json, content_hash, created_by)
    VALUES ($1,$2,$3,1,$4,'{}'::jsonb,$5,'test') RETURNING id`,
  [workspaceId, projectId, episode, story, checksum]);
  await sql(`UPDATE script_revision SET review_status = 'APPROVED', reviewed_by = 'test',
    reviewed_at = now(), reviewed_content_hash = content_hash WHERE id = $1`, [script]);
  await sql(`UPDATE episode SET current_script_revision_id = $1,
    approved_script_revision_id = $1 WHERE id = $2`, [script, episode]);
  const scene = await insertId(`INSERT INTO scene (workspace_id, project_id, episode_id)
    VALUES ($1,$2,$3) RETURNING id`, [workspaceId, projectId, episode]);
  const sceneRevision = await insertId(`INSERT INTO scene_revision
    (workspace_id, project_id, episode_id, scene_id, revision_no, source_script_revision_id,
     ordinal, heading, summary, content_hash, review_status, reviewed_by, reviewed_at,
     reviewed_content_hash, created_by)
    VALUES ($1,$2,$3,$4,1,$5,1,'INT. ROOM','room',$6,'APPROVED','test',now(),$6,'test')
    RETURNING id`, [workspaceId, projectId, episode, scene, script, checksum]);
  await sql(`UPDATE scene SET current_revision_id = $1, approved_revision_id = $1 WHERE id = $2`,
    [sceneRevision, scene]);
  const shot = await insertId(`INSERT INTO shot (workspace_id, project_id, episode_id, scene_id)
    VALUES ($1,$2,$3,$4) RETURNING id`, [workspaceId, projectId, episode, scene]);
  const shotRevisionId = await insertId(`INSERT INTO shot_revision
    (workspace_id, project_id, scene_id, shot_id, revision_no, source_scene_revision_id,
     ordinal, shot_type, camera, action, prompt_text, content_hash, review_status,
     reviewed_by, reviewed_at, reviewed_content_hash, created_by)
    VALUES ($1,$2,$3,$4,1,$5,1,'close','static','look','prompt',$6,
      'APPROVED','test',now(),$6,'test') RETURNING id`,
  [workspaceId, projectId, scene, shot, sceneRevision, checksum]);
  await sql(`UPDATE shot SET current_revision_id = $1, approved_revision_id = $1 WHERE id = $2`,
    [shotRevisionId, shot]);
  const mediaProviderId = await insertId(`INSERT INTO provider_configuration
    (workspace_id, provider_key, capability, default_timeout_ms)
    VALUES ($1,'mock-media','image.generate',30000) RETURNING id`, [workspaceId]);
  return { workspaceId, projectId, shotRevisionId, mediaProviderId };
}

async function queueOutcome(workspaceId: string, projectId: string, outcome: string) {
  const created = await jobs.createWorkflowJob({
    workspaceId,
    projectId,
    type: "MOCK_GENERATION",
    requestedBy: "integration",
    kind: "MOCK",
    inputHash: createHash("sha256").update(outcome).digest("hex"),
    inputSnapshot: { outcome },
    traceId: `trace-${outcome}`,
  });
  const queued = await jobs.queueJob({ workspaceId, jobId: created.jobId, traceId: `trace-${outcome}` });
  return { workspaceId, ...created, dispatchSeq: queued.dispatchSeq };
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
  it("recovers an attached Mock request after crash and ignores duplicate Redis delivery", async () => {
    const seeded = await seedApprovedMediaShot();
    const created = await jobs.createWorkflowJob({ workspaceId: seeded.workspaceId,
      projectId: seeded.projectId, sourceShotRevisionId: seeded.shotRevisionId,
      type: "MEDIA_IMAGE", requestedBy: "test", kind: "MEDIA_IMAGE",
      inputHash: "ab".repeat(32), inputSnapshot: {}, traceId: "media-crash" });
    const queued = await jobs.queueJob({ workspaceId: seeded.workspaceId,
      jobId: created.jobId, traceId: "media-queued" });
    const acquired = await jobs.acquireQueuedJob({ workspaceId: seeded.workspaceId,
      jobId: created.jobId, dispatchSeq: queued.dispatchSeq,
      leaseOwner: "crashed-media-worker", leaseMs: 1000, traceId: "media-acquired",
      providerConfigurationId: seeded.mediaProviderId });
    if (!acquired) throw new Error("fixture attempt missing");
    const providerRequestId = `mock-media|image.generate|${created.jobId}:1`;
    await jobs.attachProviderRequest({ workspaceId: seeded.workspaceId,
      attemptId: acquired.attemptId, providerConfigurationId: seeded.mediaProviderId,
      providerRequestId });
    await sql("UPDATE generation_job SET lease_until = now() - interval '1 second' WHERE id = $1", [created.jobId]);
    const sibling = await jobs.createWorkflowJob({ workspaceId: seeded.workspaceId,
      projectId: seeded.projectId, type: "MEDIA_IMAGE", requestedBy: "test", kind: "MEDIA_IMAGE",
      inputHash: "cd".repeat(32), inputSnapshot: {}, traceId: "invalid-sibling" });
    const siblingQueue = await jobs.queueJob({ workspaceId: seeded.workspaceId,
      jobId: sibling.jobId, traceId: "invalid-sibling-queued" });
    const siblingAttempt = await jobs.acquireQueuedJob({ workspaceId: seeded.workspaceId, jobId: sibling.jobId,
      dispatchSeq: siblingQueue.dispatchSeq, leaseOwner: "crashed-sibling", leaseMs: 1000,
      traceId: "invalid-sibling-acquired", providerConfigurationId: seeded.mediaProviderId });
    if (!siblingAttempt) throw new Error("sibling attempt missing");
    await jobs.attachProviderRequest({ workspaceId: seeded.workspaceId,
      attemptId: siblingAttempt.attemptId, providerConfigurationId: seeded.mediaProviderId,
      providerRequestId: `mock-media|image.generate|${sibling.jobId}:1` });
    await sql("UPDATE generation_job SET lease_until = now() - interval '2 seconds' WHERE id = $1", [sibling.jobId]);
    const directory = await mkdtemp(join(tmpdir(), "m3-recover-"));
    try {
      const recovery = new MockMediaRecovery(jobs, new MediaAssetStore(pool), store,
        new MockMediaAdapter(), new LocalMockObjects(directory));
      await recovery.reconcileOnce();
      expect(await jobState(created.jobId)).toBe("SUCCEEDED");
      expect(await jobState(sibling.jobId)).toBe("FAILED");
      const assets = await sql<{ count: number }>(
        "SELECT count(*)::int AS count FROM asset WHERE source_job_attempt_id = $1", [acquired.attemptId]);
      expect(assets.rows[0]?.count).toBe(1);

      const runtime = await startQueueRuntime({ databaseUrl, redisUrl, mockObjectDir: directory,
        dispatchIntervalMs: 60_000, reconcileIntervalMs: 60_000 });
      const runtimeQueue = new BullMqQueue({ url: redisUrl, maxRetriesPerRequest: null }, "ai-drama");
      try {
        await runtimeQueue.enqueue({ outboxId: randomUUID(), workspaceId: seeded.workspaceId,
          jobId: created.jobId, dispatchSeq: queued.dispatchSeq });
        const dispatchId = dispatchJobId(created.jobId, queued.dispatchSeq);
        let state = "waiting";
        for (let i = 0; i < 80 && state !== "completed"; i++) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          state = await (await runtimeQueue.queue.getJob(dispatchId))?.getState() ?? "missing";
        }
        expect(state).toBe("completed");
        const same = await sql<{ count: number }>(
          "SELECT count(*)::int AS count FROM asset WHERE source_job_attempt_id = $1", [acquired.attemptId]);
        expect(same.rows[0]?.count).toBe(1);
      } finally {
        await runtime.shutdown();
        await runtimeQueue.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requeues an expired unsent media attempt then fails explicitly without Mock storage", async () => {
    const { workspaceId, projectId, providerId } = await seed();
    const created = await jobs.createWorkflowJob({ workspaceId, projectId, type: "MEDIA_IMAGE",
      requestedBy: "test", kind: "MEDIA_IMAGE", inputHash: "ab".repeat(32),
      inputSnapshot: {}, traceId: "media-expired" });
    const queued = await jobs.queueJob({ workspaceId, jobId: created.jobId, traceId: "media-queued" });
    await jobs.acquireQueuedJob({ workspaceId, jobId: created.jobId,
      dispatchSeq: queued.dispatchSeq, leaseOwner: "crashed-media-worker", leaseMs: 1000,
      traceId: "media-acquired", providerConfigurationId: providerId });
    await sql("UPDATE generation_job SET lease_until = now() - interval '1 second' WHERE id = $1", [created.jobId]);
    const recovery = new MockMediaRecovery(jobs, new MediaAssetStore(pool), store,
      new MockMediaAdapter(), new LocalMockObjects("/tmp/m3-unused-recovery"));
    await recovery.reconcileOnce();
    expect(await jobState(created.jobId)).toBe("QUEUED");
    const runtime = await startQueueRuntime({ databaseUrl, redisUrl,
      dispatchIntervalMs: 60_000, reconcileIntervalMs: 60_000 });
    const runtimeQueue = new BullMqQueue({ url: redisUrl, maxRetriesPerRequest: null }, "ai-drama");
    try {
      const dispatched = await sql<{ dispatch_seq: number }>(
        "SELECT dispatch_seq FROM generation_job WHERE id = $1", [created.jobId],
      );
      await runtimeQueue.enqueue({ outboxId: randomUUID(), workspaceId, jobId: created.jobId,
        dispatchSeq: dispatched.rows[0]?.dispatch_seq ?? -1 });
      const jobId = dispatchJobId(created.jobId, dispatched.rows[0]?.dispatch_seq ?? -1);
      let state = "waiting";
      for (let i = 0; i < 80 && state !== "completed"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        state = await (await runtimeQueue.queue.getJob(jobId))?.getState() ?? "missing";
      }
      expect(state).toBe("completed");
      expect(await jobState(created.jobId)).toBe("FAILED");
    } finally {
      await runtime.shutdown();
      await runtimeQueue.close();
    }
  });

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
    const retrySchedule = await sql<{ available_at: Date; next_run_at: Date | null }>(
      `SELECT o.available_at, j.next_run_at
         FROM dispatch_outbox o
         JOIN generation_job j ON j.id = o.job_id
        WHERE o.job_id = $1 AND o.dispatch_seq = 2`,
      [retryable.jobId],
    );
    expect(retrySchedule.rows[0]?.next_run_at).toBeTruthy();
    expect(retrySchedule.rows[0]?.available_at.getTime()).toBeGreaterThan(Date.now() + 25_000);
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

  it("does not replace a healthy queued BullMQ job merely because it is old", async () => {
    const { workspaceId, projectId } = await seed();
    const created = await queueOutcome(workspaceId, projectId, "success");
    await dispatcher.dispatchOnce();
    await sql(
      "UPDATE dispatch_outbox SET dispatched_at = now() - interval '1 minute' WHERE job_id = $1 AND dispatch_seq = $2",
      [created.jobId, created.dispatchSeq],
    );

    await reconciler.reconcileOnce();

    const job = await sql<{ dispatch_seq: number; state: string }>(
      "SELECT dispatch_seq, state FROM generation_job WHERE id = $1",
      [created.jobId],
    );
    expect(job.rows[0]).toMatchObject({ dispatch_seq: 1, state: "QUEUED" });
    expect(await queue.queue.getJob(dispatchJobId(created.jobId, 1))).toBeTruthy();
  });

  it("redispatches a retained failed BullMQ message with a new dispatch generation", async () => {
    const { workspaceId, projectId } = await seed();
    const created = await queueOutcome(workspaceId, projectId, "success");
    await dispatcher.dispatchOnce();

    const failingWorker = startBullWorker(
      { url: redisUrl, maxRetriesPerRequest: null },
      prefix,
      async () => {
        throw new Error("forced BullMQ handler failure");
      },
    );
    try {
      const deadline = Date.now() + 5_000;
      let state = "unknown";
      while (Date.now() < deadline) {
        const queued = await queue.queue.getJob(dispatchJobId(created.jobId, created.dispatchSeq));
        state = queued ? await queued.getState() : "missing";
        if (state === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(state).toBe("failed");
    } finally {
      await failingWorker.close();
    }

    await reconciler.reconcileOnce();

    const recovered = await sql<{ state: string; dispatch_seq: number }>(
      "SELECT state, dispatch_seq FROM generation_job WHERE id = $1",
      [created.jobId],
    );
    expect(recovered.rows[0]).toMatchObject({ state: "QUEUED", dispatch_seq: 2 });
    expect(await queue.queue.getJob(dispatchJobId(created.jobId, 2))).toBeTruthy();
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

  it("persists deterministic POLL provider events before applying inspected outcomes", async () => {
    const { workspaceId, projectId } = await seed();

    const activeThenSucceeded = await queueOutcome(workspaceId, projectId, "delayed");
    await consumer.handle(activeThenSucceeded);
    await reconciler.reconcileOnce();
    expect(await jobState(activeThenSucceeded.jobId)).toBe("WAITING_EXTERNAL");
    await reconciler.reconcileOnce();
    expect(await jobState(activeThenSucceeded.jobId)).toBe("SUCCEEDED");

    const failed = await queueOutcome(workspaceId, projectId, "delayed");
    await consumer.handle(failed);
    const failedRequestId = provider.requestIdFor(`audit-failed-${failed.jobId}`, "terminal_failure");
    await sql(
      "UPDATE job_attempt SET provider_request_id = $1 WHERE generation_job_id = $2",
      [failedRequestId, failed.jobId],
    );
    await reconciler.reconcileOnce();

    const canceled = await queueOutcome(workspaceId, projectId, "delayed");
    await consumer.handle(canceled);
    const canceledRequestId = provider.requestIdFor(`audit-canceled-${canceled.jobId}`, "cancel");
    await sql(
      "UPDATE job_attempt SET provider_request_id = $1 WHERE generation_job_id = $2",
      [canceledRequestId, canceled.jobId],
    );
    await reconciler.reconcileOnce();
    expect(await jobState(canceled.jobId)).toBe("CANCELED");

    const events = await sql<{
      provider_request_id: string;
      source: string;
      normalized_event_key: string;
      external_status: string;
    }>(
      `SELECT provider_request_id, source, normalized_event_key, external_status
         FROM provider_event
        WHERE source = 'POLL'
        ORDER BY provider_request_id, external_status`,
    );

    expect(events.rows.map((row) => row.external_status)).toEqual(
      expect.arrayContaining(["ACTIVE", "SUCCEEDED", "FAILED", "CANCELED"]),
    );
    for (const row of events.rows) {
      expect(row.source).toBe("POLL");
      expect(row.normalized_event_key).toBe(
        `poll:${row.provider_request_id}:${row.external_status}`,
      );
    }

    const uniqueKeys = new Set(events.rows.map((row) => row.normalized_event_key));
    expect(uniqueKeys.size).toBe(events.rows.length);
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

  it("honors a cancellation requested while waiting on an external mock request", async () => {
    const { workspaceId, projectId } = await seed();
    const delayed = await queueOutcome(workspaceId, projectId, "delayed");
    await consumer.handle(delayed);
    expect(await jobState(delayed.jobId)).toBe("WAITING_EXTERNAL");

    await jobs.cancelJob({
      workspaceId,
      jobId: delayed.jobId,
      traceId: "cancel-waiting-external",
    });
    await reconciler.reconcileOnce();
    expect(await jobState(delayed.jobId)).toBe("CANCELED");
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
