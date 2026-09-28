import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  JobPersistenceService, MockTextService, RuntimeStore, TextChainService, runMigrations, createPostgresPool, requestHash,
  type MockSceneSnapshot,
} from "@ai-drama/database";
import { completeMockJob } from "./mock-text-completion";

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
