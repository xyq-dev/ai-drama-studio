import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createPostgresPool, JobPersistenceService, MockTextService, runMigrations,
  RuntimeStore, TextChainService,
} from "@ai-drama/database";
import { MockProvider } from "@ai-drama/providers";
import { AppModule } from "../../../api/src/app.module";
import { loadApiEnv } from "../../../api/src/config/env";
import { SafeExceptionFilter } from "../../../api/src/http/safe-exception.filter";
import { MockJobConsumer } from "./consumer";
import { OutboxDispatcher, type DispatchMessage, type JobEnqueuer } from "./dispatcher";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
if (!databaseUrl || !redisUrl) throw new Error("DATABASE_URL and REDIS_URL are required for isolated integration tests");
const pool = createPostgresPool({ connectionString: databaseUrl, connectionTimeoutMs: 2000,
  statementTimeoutMs: 10000, queryTimeoutMs: 10000 });
function sql<T>(query: string, values: unknown[] = []): Promise<{ rows: T[] }> {
  return pool.query(query, values) as Promise<{ rows: T[] }>;
}
const chain = new TextChainService(pool);
const jobs = new JobPersistenceService(pool);
const store = new RuntimeStore(pool);
let app: INestApplication;
let base: string;

beforeAll(async () => {
  // CI gives this test an isolated database; never point DATABASE_URL at shared data.
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await runMigrations(pool);
  await pool.query("INSERT INTO workspace (id, name, status) VALUES ($1, 'm2-http-worker', 'ACTIVE')", [workspaceId]);
  const env = loadApiEnv({ DATABASE_URL: databaseUrl, REDIS_URL: redisUrl,
    S3_ENDPOINT: "http://127.0.0.1:59000", S3_REGION: "us-east-1", S3_BUCKET: "test",
    S3_ACCESS_KEY_ID: "test", S3_SECRET_ACCESS_KEY: "test", APP_WORKSPACE_ID: workspaceId });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(env)] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix("api/v1");
  app.useGlobalFilters(new SafeExceptionFilter());
  await app.init();
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
});
afterAll(async () => { if (app) await app.close(); await pool.end(); });

async function approveScene(projectId: string, episodeId: string, sceneId: string,
  revisionId: string, version: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const review = await chain.reviewSceneShotInTransaction(client, {
      kind: "scene", workspaceId, projectId, episodeId, sceneId, revisionId,
      expectedVersion: version, expectedReviewVersion: 1, to: "IN_REVIEW", reviewedBy: "editor",
    });
    await chain.reviewSceneShotInTransaction(client, {
      kind: "scene", workspaceId, projectId, episodeId, sceneId, revisionId,
      expectedVersion: review.rowVersion, expectedReviewVersion: review.reviewVersion,
      to: "APPROVED", reviewedBy: "editor",
    });
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

it("queues Mock Scenes and Shots by HTTP and commits each three-episode batch through the worker", async () => {
  const project = await sql<{ id: string }>(
    "INSERT INTO project (workspace_id, title) VALUES ($1, 'http-to-worker') RETURNING id", [workspaceId]);
  const projectId = project.rows[0]!.id;
  const story = await chain.createStoryRevision({ workspaceId, projectId,
    content: { premise: "three chapters" }, createdBy: "author", expectedVersion: 1 });
  const storyReview = await chain.transitionReview({ table: "story_revision", workspaceId,
    revisionId: story.revisionId, expectedVersion: story.rowVersion,
    expectedReviewVersion: 1, to: "IN_REVIEW" });
  await chain.approveStory({ workspaceId, projectId, revisionId: story.revisionId,
    expectedVersion: storyReview.rowVersion, expectedReviewVersion: 2, reviewedBy: "editor" });
  const episodes = await chain.listEpisodes(workspaceId, projectId);
  expect(episodes).toHaveLength(3);
  for (const episode of episodes) {
    const script = await chain.createScriptRevision({ workspaceId, projectId,
      episodeId: episode.id, sourceStoryRevisionId: story.revisionId,
      content: { episode: episode.episodeNo }, createdBy: "author", expectedVersion: episode.rowVersion });
    const review = await chain.transitionReview({ table: "script_revision", workspaceId,
      revisionId: script.revisionId, expectedVersion: script.rowVersion,
      expectedReviewVersion: 1, to: "IN_REVIEW" });
    await chain.approveScript({ workspaceId, episodeId: episode.id, revisionId: script.revisionId,
      expectedVersion: review.rowVersion, expectedReviewVersion: 2, reviewedBy: "editor" });
  }

  const messages: DispatchMessage[] = [];
  const queue: JobEnqueuer = {
    async enqueue(message) { messages.push(message); return "enqueued"; },
    async hasDispatch(jobId, dispatchSeq) {
      return messages.some((message) => message.jobId === jobId && message.dispatchSeq === dispatchSeq);
    },
  };
  const dispatcher = new OutboxDispatcher(store, queue);
  const consumer = new MockJobConsumer(jobs, store, new MockProvider(), "m2-http-worker", 10000,
    new MockTextService(pool));
  async function runWorkflow(kind: "scenes" | "shots") {
    const url = `${base}/api/v1/projects/${projectId}/workflows/mock-${kind}`;
    const headers = { "content-type": "application/json", "idempotency-key": `m2-http-${kind}` };
    const queued = await fetch(url, { method: "POST", headers, body: "{}" });
    expect(queued.status).toBe(202);
    const created = (await queued.json()) as { jobId: string; workflowRunId: string };
    const replay = await fetch(url, { method: "POST", headers, body: "{}" });
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual(created);
    expect(await dispatcher.dispatchOnce()).toBe(1);
    const message = messages.pop();
    expect(message?.jobId).toBe(created.jobId);
    expect(await consumer.handle(message!)).toBe("processed");
    const job = await store.getJob(workspaceId, created.jobId);
    expect(job.state, `${job.errorCode}: ${job.errorMessage}`).toBe("SUCCEEDED");
    const attempt = await sql<{ response_snapshot: Record<string, string[]> }>(
      "SELECT response_snapshot FROM job_attempt WHERE generation_job_id = $1", [created.jobId]);
    expect(attempt.rows[0]?.response_snapshot[`${kind === "scenes" ? "scene" : "shot"}RevisionIds`])
      .toHaveLength(3);
    expect(await consumer.handle(message!)).toBe("ignored");
  }

  await runWorkflow("scenes");
  const scenes = await sql<{ id: string; episode_id: string; revision_id: string;
    row_version: number; source_script_revision_id: string; review_status: string }>(
    `SELECT s.id, s.episode_id, s.current_revision_id AS revision_id, s.row_version,
            r.source_script_revision_id, r.review_status
       FROM scene s JOIN scene_revision r ON r.id = s.current_revision_id
      WHERE s.project_id = $1 ORDER BY s.episode_id`, [projectId]);
  expect(scenes.rows).toHaveLength(3);
  const sourceScripts = (await chain.listEpisodes(workspaceId, projectId))
    .map((episode) => episode.currentScriptRevisionId);
  expect(scenes.rows.map((scene) => scene.source_script_revision_id).sort()).toEqual(sourceScripts.sort());
  expect(scenes.rows.every((scene) => scene.review_status === "DRAFT")).toBe(true);
  for (const scene of scenes.rows) {
    await approveScene(projectId, scene.episode_id, scene.id, scene.revision_id, scene.row_version);
  }

  await runWorkflow("shots");
  const shots = await sql<{ source_scene_revision_id: string; review_status: string }>(
    "SELECT source_scene_revision_id, review_status FROM shot_revision WHERE project_id = $1", [projectId]);
  expect(shots.rows).toHaveLength(3);
  expect(shots.rows.map((shot) => shot.source_scene_revision_id).sort()).toEqual(
    scenes.rows.map((scene) => scene.revision_id).sort());
  expect(shots.rows.every((shot) => shot.review_status === "DRAFT")).toBe(true);
});
