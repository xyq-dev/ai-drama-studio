import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MockProvider } from "@ai-drama/providers";
import {
  JobPersistenceService, MockTextService, RuntimeStore, TextChainService, runMigrations, createPostgresPool, requestHash,
  type MockSceneSnapshot, type MockShotSnapshot,
} from "@ai-drama/database";
import { completeMockJob } from "./mock-text-completion";
import { BullMqQueue, startBullWorker } from "./bullmq-queue";
import { MockJobConsumer } from "./consumer";
import { OutboxDispatcher } from "./dispatcher";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for isolated PostgreSQL integration tests");
const pool = createPostgresPool({ connectionString: databaseUrl, connectionTimeoutMs: 2000, statementTimeoutMs: 10000, queryTimeoutMs: 10000 });
async function sql<T>(query: string, values: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
  return pool.query(query, values) as Promise<{ rows: T[]; rowCount: number }>;
}
const jobs = new JobPersistenceService(pool);
const store = new RuntimeStore(pool);
const chain = new TextChainService(pool);
const mockText = new MockTextService(pool);
let keySerial = 0;

beforeAll(async () => {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await runMigrations(pool);
});
beforeEach(async () => { await pool.query("TRUNCATE workspace RESTART IDENTITY CASCADE"); });
afterAll(async () => { await pool.end(); });

async function approvedThreeScripts() {
  const workspaceId = (await sql<{ id: string }>(
    "INSERT INTO workspace (name) VALUES ('mock-text') RETURNING id",
  )).rows[0]!.id;
  const projectId = (await sql<{ id: string }>(
    "INSERT INTO project (workspace_id, title) VALUES ($1, 'mock') RETURNING id", [workspaceId],
  )).rows[0]!.id;
  const story = await chain.createStoryRevision({
    workspaceId, projectId, content: { premise: "three chapters" },
    createdBy: "author", expectedVersion: 1,
  });
  const inReview = await chain.transitionReview({
    table: "story_revision", workspaceId, revisionId: story.revisionId,
    expectedVersion: story.rowVersion, expectedReviewVersion: 1, to: "IN_REVIEW",
  });
  await chain.approveStory({ workspaceId, projectId, revisionId: story.revisionId,
    expectedVersion: inReview.rowVersion, expectedReviewVersion: 2, reviewedBy: "editor" });
  const episodes = await chain.listEpisodes(workspaceId, projectId);
  for (const episode of episodes) {
    const script = await chain.createScriptRevision({
      workspaceId, projectId, episodeId: episode.id, sourceStoryRevisionId: story.revisionId,
      content: { episode: episode.episodeNo }, createdBy: "author", expectedVersion: episode.rowVersion,
    });
    const review = await chain.transitionReview({
      table: "script_revision", workspaceId, revisionId: script.revisionId,
      expectedVersion: script.rowVersion, expectedReviewVersion: 1, to: "IN_REVIEW",
    });
    await chain.approveScript({ workspaceId, episodeId: episode.id, revisionId: script.revisionId,
      expectedVersion: review.rowVersion, expectedReviewVersion: 2, reviewedBy: "editor" });
  }
  return queueAnother(workspaceId, projectId);
}

async function queueAnother(workspaceId: string, projectId: string) {
  const snapshot: MockSceneSnapshot = {
    schema: "m2.mock.scenes.v1", projectId, requestedBy: "author", outcome: "success",
    episodes: await mockText.loadSources(workspaceId, projectId),
  };
  const key = `mock-scenes-${++keySerial}`;
  const queued = await jobs.createAndQueueWorkflowJob({
    workspaceId, actorId: "author", httpMethod: "POST",
    routeKey: `/projects/${projectId}/workflows/mock-scenes`, key,
    requestHash: requestHash({}),
  }, {
    workspaceId, projectId, type: "MOCK_TEXT_SCENES", requestedBy: "author",
    kind: "MOCK_TEXT_SCENES", inputHash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
    inputSnapshot: snapshot, traceId: "mock-test",
  });
  const created = queued.body;
  const providerId = await store.ensureMockProvider(workspaceId);
  const attempt = await jobs.acquireQueuedJob({ workspaceId, jobId: created.jobId,
    dispatchSeq: queued.body.dispatchSeq, leaseOwner: "test", leaseMs: 10_000,
    traceId: "mock-test", providerConfigurationId: providerId });
  if (!attempt) throw new Error("Mock job not acquired");
  const execution = await store.loadExecution(workspaceId, created.jobId);
  if (!execution) throw new Error("Mock execution missing");
  return { workspaceId, projectId, snapshot, created, attempt, execution };
}

async function transaction<T>(work: (client: Awaited<ReturnType<typeof pool.connect>>) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function approvedThreeScenes() {
  const first = await approvedThreeScripts();
  await completeMockJob(jobs, mockText, first.execution, first.attempt.attemptId,
    "three-scenes", { outcome: "success" });
  const scenes = await sql<{ id: string; episode_id: string; revision_id: string; row_version: number }>(
    `SELECT scene.id, scene.episode_id, scene.current_revision_id AS revision_id, scene.row_version
       FROM scene WHERE scene.project_id = $1 ORDER BY scene.episode_id`, [first.projectId],
  );
  for (const scene of scenes.rows) {
    const review = await transaction((client) => chain.reviewSceneShotInTransaction(client, {
      kind: "scene", workspaceId: first.workspaceId, projectId: first.projectId,
      episodeId: scene.episode_id, sceneId: scene.id, revisionId: scene.revision_id,
      expectedVersion: scene.row_version, expectedReviewVersion: 1,
      to: "IN_REVIEW", reviewedBy: "editor",
    }));
    await transaction((client) => chain.reviewSceneShotInTransaction(client, {
      kind: "scene", workspaceId: first.workspaceId, projectId: first.projectId,
      episodeId: scene.episode_id, sceneId: scene.id, revisionId: scene.revision_id,
      expectedVersion: review.rowVersion, expectedReviewVersion: review.reviewVersion,
      to: "APPROVED", reviewedBy: "editor",
    }));
  }
  return queueShotAnother(first.workspaceId, first.projectId);
}

async function queueShotAnother(workspaceId: string, projectId: string) {
  const client = await pool.connect();
  let scenes;
  try {
    scenes = await mockText.currentShotSources(client, workspaceId, projectId);
  } finally {
    client.release();
  }
  const snapshot: MockShotSnapshot = {
    schema: "m2.mock.shots.v1", projectId, requestedBy: "author", outcome: "success", scenes,
  };
  const queued = await jobs.createAndQueueWorkflowJob({
    workspaceId, actorId: "author", httpMethod: "POST",
    routeKey: `/projects/${projectId}/workflows/mock-shots`,
    key: `mock-shots-${++keySerial}`, requestHash: requestHash({}),
  }, {
    workspaceId, projectId, type: "MOCK_TEXT_SHOTS", requestedBy: "author",
    kind: "MOCK_TEXT_SHOTS", inputHash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
    inputSnapshot: snapshot, traceId: "mock-shots-test",
  });
  const created = queued.body;
  const providerId = await store.ensureMockProvider(workspaceId);
  const attempt = await jobs.acquireQueuedJob({ workspaceId, jobId: created.jobId,
    dispatchSeq: created.dispatchSeq, leaseOwner: "test", leaseMs: 10_000,
    traceId: "mock-shots-test", providerConfigurationId: providerId });
  if (!attempt) throw new Error("Mock Shot job not acquired");
  const execution = await store.loadExecution(workspaceId, created.jobId);
  if (!execution) throw new Error("Mock Shot execution missing");
  return { workspaceId, projectId, snapshot, created, attempt, execution };
}

describe("Mock three episode Scene workflow", () => {
  it("commits three DRAFT revisions and job success atomically, rejecting duplicate completion", async () => {
    const source = await approvedThreeScripts();
    await completeMockJob(jobs, mockText, source.execution, source.attempt.attemptId,
      "mock-success", { outcome: "success" });
    const revisions = await sql<{ episode_no: number; review_status: string; source_script_revision_id: string }>(
      `SELECT e.episode_no, r.review_status, r.source_script_revision_id
         FROM scene_revision r JOIN episode e ON e.id = r.episode_id
        WHERE r.project_id = $1 ORDER BY e.episode_no`, [source.projectId],
    );
    expect(revisions.rows.map((row) => row.episode_no)).toEqual([1, 2, 3]);
    expect(revisions.rows.every((row, index) => row.review_status === "DRAFT" &&
      row.source_script_revision_id === source.snapshot.episodes[index]?.scriptRevisionId)).toBe(true);
    expect((await store.getJob(source.workspaceId, source.created.jobId)).state).toBe("SUCCEEDED");
    const response = await sql<{ response_snapshot: { sceneRevisionIds: string[] } }>(
      "SELECT response_snapshot FROM job_attempt WHERE generation_job_id = $1",
      [source.created.jobId],
    );
    expect(response.rows[0]?.response_snapshot.sceneRevisionIds).toHaveLength(3);
    await expect(completeMockJob(jobs, mockText, source.execution, source.attempt.attemptId,
      "mock-duplicate", {})).rejects.toMatchObject({ code: "JOB_TERMINAL" });
    expect((await sql("SELECT id FROM scene_revision WHERE project_id = $1", [source.projectId])).rowCount).toBe(3);
  });

  it("fails the job without partial Scenes if a frozen Script source changed", async () => {
    const source = await approvedThreeScripts();
    await pool.query("UPDATE episode SET row_version = row_version + 1 WHERE id = $1",
      [source.snapshot.episodes[2]!.episodeId]);
    await completeMockJob(jobs, mockText, source.execution, source.attempt.attemptId,
      "mock-stale", { outcome: "success" });
    expect((await store.getJob(source.workspaceId, source.created.jobId)).state).toBe("FAILED");
    expect((await sql("SELECT id FROM scene_revision WHERE project_id = $1", [source.projectId])).rowCount).toBe(0);
  });

  it("persists the same Scenes when completion is recovered after provider success", async () => {
    const source = await approvedThreeScripts();
    await completeMockJob(jobs, mockText, source.execution, source.attempt.attemptId,
      "reconcile-success", { recovered: true });
    expect((await store.getJob(source.workspaceId, source.created.jobId)).state).toBe("SUCCEEDED");
    expect((await sql("SELECT id FROM scene_revision WHERE project_id = $1", [source.projectId])).rowCount).toBe(3);
  });

  it("terminates a second job with a different key when all Scene slots are already used", async () => {
    const first = await approvedThreeScripts();
    await completeMockJob(jobs, mockText, first.execution, first.attempt.attemptId,
      "first-success", { outcome: "success" });
    const second = await queueAnother(first.workspaceId, first.projectId);
    await completeMockJob(jobs, mockText, second.execution, second.attempt.attemptId,
      "second-conflict", { outcome: "success" });
    const job = await store.getJob(second.workspaceId, second.created.jobId);
    expect(job).toMatchObject({ state: "FAILED", errorCode: "MOCK_SCENE_SLOT_OCCUPIED" });
    expect((await sql("SELECT id FROM scene_revision WHERE project_id = $1", [first.projectId])).rowCount).toBe(3);
  });

  it("terminates without partial Scenes if ordinal 1 was already occupied", async () => {
    const first = await approvedThreeScripts();
    const episode = first.snapshot.episodes[1]!;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await chain.createSceneRevisionInTransaction(client, {
        workspaceId: first.workspaceId, projectId: first.projectId,
        episodeId: episode.episodeId, sourceScriptRevisionId: episode.scriptRevisionId,
        ordinal: 1, heading: "Existing Scene", summary: "Already drafted",
        createdBy: "author", expectedVersion: episode.episodeVersion,
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const second = await queueAnother(first.workspaceId, first.projectId);
    await completeMockJob(jobs, mockText, second.execution, second.attempt.attemptId,
      "occupied-conflict", { outcome: "success" });
    expect(await store.getJob(second.workspaceId, second.created.jobId)).toMatchObject({
      state: "FAILED", errorCode: "MOCK_SCENE_SLOT_OCCUPIED",
    });
    expect((await sql("SELECT id FROM scene_revision WHERE project_id = $1", [first.projectId])).rowCount).toBe(1);
  });
});

describe("Mock three episode Shot workflow", () => {
  it("atomically creates three DRAFT Shots with lineage and rejects duplicate completion", async () => {
    const source = await approvedThreeScenes();
    await completeMockJob(jobs, mockText, source.execution, source.attempt.attemptId,
      "three-shots", { outcome: "success" });
    const revisions = await sql<{ source_scene_revision_id: string; review_status: string }>(
      `SELECT source_scene_revision_id, review_status FROM shot_revision
        WHERE project_id = $1 ORDER BY source_scene_revision_id`, [source.projectId],
    );
    expect(revisions.rows.map((row) => row.source_scene_revision_id).sort()).toEqual(
      source.snapshot.scenes.map((scene) => scene.sceneRevisionId).sort(),
    );
    expect(revisions.rows.every((row) => row.review_status === "DRAFT")).toBe(true);
    const response = await sql<{ response_snapshot: { shotRevisionIds: string[] } }>(
      "SELECT response_snapshot FROM job_attempt WHERE generation_job_id = $1", [source.created.jobId],
    );
    expect(response.rows[0]?.response_snapshot.shotRevisionIds).toHaveLength(3);
    expect((await store.getJob(source.workspaceId, source.created.jobId)).state).toBe("SUCCEEDED");
    await expect(completeMockJob(jobs, mockText, source.execution, source.attempt.attemptId,
      "shot-duplicate", {})).rejects.toMatchObject({ code: "JOB_TERMINAL" });
    expect((await sql("SELECT id FROM shot_revision WHERE project_id = $1", [source.projectId])).rowCount).toBe(3);
  });

  it("terminally fails a second key after ordinal 1 slots are occupied", async () => {
    const first = await approvedThreeScenes();
    await completeMockJob(jobs, mockText, first.execution, first.attempt.attemptId,
      "first-shots", { outcome: "success" });
    const second = await queueShotAnother(first.workspaceId, first.projectId);
    await completeMockJob(jobs, mockText, second.execution, second.attempt.attemptId,
      "second-shots", { outcome: "success" });
    expect(await store.getJob(second.workspaceId, second.created.jobId)).toMatchObject({
      state: "FAILED", errorCode: "MOCK_SHOT_SLOT_OCCUPIED",
    });
    expect((await sql("SELECT id FROM shot_revision WHERE project_id = $1", [first.projectId])).rowCount).toBe(3);
  });

  it("fails without partial writes when a middle Scene already has a Shot", async () => {
    const first = await approvedThreeScenes();
    const scene = first.snapshot.scenes[1]!;
    await transaction((client) => chain.createShotScopedInTransaction(client, {
      workspaceId: first.workspaceId, projectId: first.projectId, sceneId: scene.sceneId,
      sourceSceneRevisionId: scene.sceneRevisionId, ordinal: 1,
      shotType: "WIDE", camera: "static", action: "existing", promptText: "existing",
      createdBy: "author", expectedVersion: scene.sceneVersion,
    }));
    const second = await queueShotAnother(first.workspaceId, first.projectId);
    await completeMockJob(jobs, mockText, second.execution, second.attempt.attemptId,
      "occupied-shots", { outcome: "success" });
    expect(await store.getJob(second.workspaceId, second.created.jobId)).toMatchObject({
      state: "FAILED", errorCode: "MOCK_SHOT_SLOT_OCCUPIED",
    });
    expect((await sql("SELECT id FROM shot_revision WHERE project_id = $1", [first.projectId])).rowCount).toBe(1);
  });

  it("fails after a source Scene is replaced, with no Shot drafts", async () => {
    const first = await approvedThreeScenes();
    const scene = first.snapshot.scenes[1]!;
    const script = await sql<{ source_script_revision_id: string }>(
      "SELECT source_script_revision_id FROM scene_revision WHERE id = $1", [scene.sceneRevisionId],
    );
    await transaction((client) => chain.createSceneRevisionInTransaction(client, {
      workspaceId: first.workspaceId, projectId: first.projectId,
      episodeId: scene.episodeId, sceneId: scene.sceneId,
      sourceScriptRevisionId: script.rows[0]!.source_script_revision_id,
      ordinal: 1, heading: "Replaced", summary: "Replaced", createdBy: "author",
      expectedVersion: scene.sceneVersion,
    }));
    await completeMockJob(jobs, mockText, first.execution, first.attempt.attemptId,
      "changed-scenes", { outcome: "success" });
    const job = await store.getJob(first.workspaceId, first.created.jobId);
    expect(job.state).toBe("FAILED");
    expect(["SOURCE_STALE", "REVIEW_REQUIRED", "REVISION_CONFLICT"]).toContain(job.errorCode);
    expect((await sql("SELECT id FROM shot_revision WHERE project_id = $1", [first.projectId])).rowCount).toBe(0);
  });

  it("persists all three Shots on recovered provider completion", async () => {
    const source = await approvedThreeScenes();
    await completeMockJob(jobs, mockText, source.execution, source.attempt.attemptId,
      "recover-shots", { recovered: true });
    expect((await store.getJob(source.workspaceId, source.created.jobId)).state).toBe("SUCCEEDED");
    expect((await sql("SELECT id FROM shot_revision WHERE project_id = $1", [source.projectId])).rowCount).toBe(3);
  });

  it.skipIf(!process.env.REDIS_URL)("dispatches a Mock Shot Job through Redis and persists its three drafts", async () => {
    const first = await approvedThreeScenes();
    const snapshot = first.snapshot;
    const queued = await jobs.createAndQueueWorkflowJob({
      workspaceId: first.workspaceId, actorId: "author", httpMethod: "POST",
      routeKey: `/projects/${first.projectId}/workflows/mock-shots`,
      key: `redis-shots-${++keySerial}`, requestHash: requestHash({}),
    }, {
      workspaceId: first.workspaceId, projectId: first.projectId,
      type: "MOCK_TEXT_SHOTS", requestedBy: "author", kind: "MOCK_TEXT_SHOTS",
      inputHash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
      inputSnapshot: snapshot, traceId: "redis-shots",
    });
    const prefix = `mock-shot-${randomUUID()}`;
    const connection = { url: process.env.REDIS_URL!, maxRetriesPerRequest: null };
    const queue = new BullMqQueue(connection, prefix);
    const consumer = new MockJobConsumer(jobs, store, new MockProvider(), "redis-shots", 10_000, mockText);
    const worker = startBullWorker(connection, prefix, async (message) => { await consumer.handle(message); });
    worker.on("error", () => undefined);
    try {
      await new OutboxDispatcher(store, queue).dispatchOnce();
      let state = "QUEUED";
      for (let i = 0; i < 100 && state !== "SUCCEEDED"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        state = (await store.getJob(first.workspaceId, queued.body.jobId)).state;
        if (state === "FAILED") break;
      }
      expect(state).toBe("SUCCEEDED");
      expect((await sql("SELECT id FROM shot_revision WHERE project_id = $1", [first.projectId])).rowCount).toBe(3);
    } finally {
      await worker.close();
      await queue.close();
    }
  });
});
