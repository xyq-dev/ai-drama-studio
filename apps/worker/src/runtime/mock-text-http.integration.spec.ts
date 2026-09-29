import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresPool, JobPersistenceService, MockTextService, runMigrations,
  RuntimeStore } from "@ai-drama/database";
import { MockProvider } from "@ai-drama/providers";
import type { TextGenerationAdapter, TextGenerationRequest } from "@ai-drama/contracts";
import { AppModule } from "../../../api/src/app.module";
import { loadApiEnv } from "../../../api/src/config/env";
import { SafeExceptionFilter } from "../../../api/src/http/safe-exception.filter";
import { BullMqQueue, startBullWorker } from "./bullmq-queue";
import { MockJobConsumer } from "./consumer";
import { OutboxDispatcher } from "./dispatcher";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
if (!databaseUrl || !redisUrl) throw new Error("DATABASE_URL and REDIS_URL are required for isolated integration tests");
const pool = createPostgresPool({ connectionString: databaseUrl, connectionTimeoutMs: 2000,
  statementTimeoutMs: 10000, queryTimeoutMs: 10000 });
const jobs = new JobPersistenceService(pool);
const store = new RuntimeStore(pool);
const prefix = `m2-http-${process.pid}`;
const connection = { url: redisUrl, maxRetriesPerRequest: null as null };
const queue = new BullMqQueue(connection, prefix);
class DistinctTextAdapter implements TextGenerationAdapter {
  readonly providerKey = "integration-distinct";
  readonly replayPolicy = "REPLAY_SAFE_SYNC";
  async generate(request: TextGenerationRequest) {
    if (request.kind === "SCENES") return { kind: "succeeded" as const,
      output: { schema: "m2.text.scenes.output.v1" as const,
      scenes: request.sources.map((source) => ({ projectId: request.projectId,
        episodeId: source.episodeId, episodeNo: source.episodeNo,
        sourceScriptRevisionId: source.scriptRevisionId, ordinal: 1,
        heading: `Adapter scene ${source.episodeNo}`, summary: `Distinct scene ${source.episodeNo}` })) } };
    return { kind: "succeeded" as const, output: { schema: "m2.text.shots.output.v1" as const,
      shots: request.sources.map((source) => ({ projectId: request.projectId,
        episodeId: source.episodeId, episodeNo: source.episodeNo, sceneId: source.sceneId,
        sourceSceneRevisionId: source.sceneRevisionId, ordinal: 1, shotType: "CLOSE",
        camera: "adapter-camera", action: `Distinct action ${source.episodeNo}`,
        promptText: `Distinct prompt ${source.episodeNo}` })) } };
  }
}
const consumer = new MockJobConsumer(jobs, store, new MockProvider(), "m2-http-worker", 10000,
  new MockTextService(pool), new DistinctTextAdapter());
const worker = startBullWorker(connection, prefix, async (message) => { await consumer.handle(message); });
let app: INestApplication;
let base: string;
let keyNo = 0;

beforeAll(async () => {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await runMigrations(pool);
  await pool.query("INSERT INTO workspace (id,name,status) VALUES ($1,'m2-http-worker','ACTIVE')", [workspaceId]);
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
afterAll(async () => { if (app) await app.close(); await worker.close(); await queue.close(); await pool.end(); });

async function post<T>(path: string, body: unknown, version?: number): Promise<T> {
  const response = await fetch(`${base}/api/v1${path}`, { method: "POST", headers: {
    "content-type": "application/json", "idempotency-key": `m2-e2e-${++keyNo}`,
    ...(version === undefined ? {} : { "if-match": String(version) }),
  }, body: JSON.stringify(body) });
  expect(response.status, `${path}: ${await response.clone().text()}`).toBeLessThan(300);
  return response.json() as Promise<T>;
}
async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${base}/api/v1${path}`);
  expect(response.status, `${path}: ${await response.clone().text()}`).toBe(200);
  return response.json() as Promise<T>;
}
async function review(path: string, version: number, reviewVersion = 1) {
  const first = await post<{ rowVersion: number; reviewVersion: number }>(path,
    { to: "IN_REVIEW", expectedReviewVersion: reviewVersion }, version);
  return post<{ rowVersion: number; reviewVersion: number }>(path,
    { to: "APPROVED", expectedReviewVersion: first.reviewVersion }, first.rowVersion);
}
async function runWorkflow(projectId: string, kind: "scenes" | "shots") {
  const path = `/projects/${projectId}/workflows/mock-${kind}`;
  const headers = { "content-type": "application/json", "idempotency-key": `m2-workflow-${kind}` };
  const first = await fetch(`${base}/api/v1${path}`, { method: "POST", headers, body: "{}" });
  expect(first.status).toBe(202);
  const created = (await first.json()) as { jobId: string; workflowRunId: string };
  const replay = await fetch(`${base}/api/v1${path}`, { method: "POST", headers, body: "{}" });
  expect(replay.status).toBe(202);
  expect(await replay.json()).toEqual(created);
  const dispatcher = new OutboxDispatcher(store, queue);
  expect(await dispatcher.dispatchOnce()).toBe(1);
  for (let index = 0; index < 100; index += 1) {
    const job = await get<{ state: string; errorCode?: string }>(`/generation-jobs/${created.jobId}`);
    if (job.state === "SUCCEEDED") return;
    if (["FAILED", "CANCELLED"].includes(job.state)) throw new Error(`${kind} job ${job.state}: ${job.errorCode}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${kind} job timed out`);
}

type Aggregate = { entityId: string; projectId: string; episodeId?: string; sceneId?: string;
  rowVersion: number; currentRevisionId: string; approvedRevisionId: string | null;
  currentRevision: { reviewVersion: number; reviewStatus: string; freshnessStatus: string } };

it("completes the three-episode Mock chain through public HTTP and real BullMQ", async () => {
  const project = await post<{ id: string; version: number }>("/projects", { title: "API-only M2" });
  const story = await post<{ revisionId: string; rowVersion: number }>(`/projects/${project.id}/stories`,
    { content: { premise: "three episodes" } }, project.version);
  await review(`/projects/${project.id}/stories/${story.revisionId}/review`, story.rowVersion);
  let episodes = (await get<{ items: Array<{ id: string; episodeNo: number; rowVersion: number }> }>(
    `/projects/${project.id}/episodes`)).items;
  expect(episodes.map((item) => item.episodeNo)).toEqual([1, 2, 3]);
  for (const episode of episodes) {
    const script = await post<{ revisionId: string; rowVersion: number }>(
      `/projects/${project.id}/episodes/${episode.id}/scripts`,
      { storyRevisionId: story.revisionId, content: { episode: episode.episodeNo } }, episode.rowVersion);
    await review(`/projects/${project.id}/episodes/${episode.id}/scripts/${script.revisionId}/review`, script.rowVersion);
  }
  episodes = (await get<{ items: typeof episodes }>(`/projects/${project.id}/episodes`)).items;
  const sourceScriptId = (await get<{ items: Array<{ id: string }> }>(
    `/projects/${project.id}/episodes/${episodes[0]!.id}/scripts`)).items[0]!.id;
  const refreshedProject = await get<{ version: number }>(`/projects/${project.id}`);
  await post(`/projects/${project.id}/characters`,
    { name: "Hero", sourceScriptRevisionId: sourceScriptId, content: { role: "lead" } }, refreshedProject.version);
  const afterCharacter = await get<{ version: number }>(`/projects/${project.id}`);
  await post(`/projects/${project.id}/locations`,
    { name: "Studio", sourceScriptRevisionId: sourceScriptId, content: { kind: "interior" } }, afterCharacter.version);

  await runWorkflow(project.id, "scenes");
  const scenes: Aggregate[] = [];
  for (const episode of episodes) {
    const page = await get<{ items: Aggregate[] }>(`/projects/${project.id}/episodes/${episode.id}/scenes`);
    expect(page.items).toHaveLength(1);
    const scene = page.items[0]!;
    await review(`/projects/${project.id}/episodes/${episode.id}/scenes/${scene.entityId}/revisions/${scene.currentRevisionId}/review`,
      scene.rowVersion, scene.currentRevision.reviewVersion);
    scenes.push(scene);
  }
  await runWorkflow(project.id, "shots");
  const shots: Aggregate[] = [];
  for (let index = 0; index < episodes.length; index += 1) {
    const page = await get<{ items: Aggregate[] }>(
      `/projects/${project.id}/episodes/${episodes[index]!.id}/scenes/${scenes[index]!.entityId}/shots`);
    expect(page.items).toHaveLength(1);
    const shot = page.items[0]!;
    await review(`/projects/${project.id}/episodes/${episodes[index]!.id}/scenes/${scenes[index]!.entityId}/shots/${shot.entityId}/revisions/${shot.currentRevisionId}/review`,
      shot.rowVersion, shot.currentRevision.reviewVersion);
    shots.push(shot);
  }

  // Simulate a refresh: retain only project id, then rediscover all four entity classes and versions.
  const characters = (await get<{ items: Aggregate[] }>(`/projects/${project.id}/characters`)).items;
  const locations = (await get<{ items: Aggregate[] }>(`/projects/${project.id}/locations`)).items;
  expect(characters).toHaveLength(1);
  expect(locations).toHaveLength(1);
  await review(`/projects/${project.id}/characters/${characters[0]!.entityId}/revisions/${characters[0]!.currentRevisionId}/review`,
    characters[0]!.rowVersion, characters[0]!.currentRevision.reviewVersion);
  await review(`/projects/${project.id}/locations/${locations[0]!.entityId}/revisions/${locations[0]!.currentRevisionId}/review`,
    locations[0]!.rowVersion, locations[0]!.currentRevision.reviewVersion);
  episodes = (await get<{ items: typeof episodes }>(`/projects/${project.id}/episodes`)).items;
  const rediscoveredScenes = await Promise.all(episodes.map(async (episode) =>
    (await get<{ items: Aggregate[] }>(`/projects/${project.id}/episodes/${episode.id}/scenes`)).items[0]!));
  const rediscoveredShots = await Promise.all(episodes.map(async (episode, index) =>
    (await get<{ items: Aggregate[] }>(`/projects/${project.id}/episodes/${episode.id}/scenes/${rediscoveredScenes[index]!.entityId}/shots`)).items[0]!));

  const scriptIds = await Promise.all(episodes.map(async (episode) =>
    (await get<{ items: Array<{ id: string }> }>(`/projects/${project.id}/episodes/${episode.id}/scripts`)).items[0]!.id));
  for (let index = 0; index < episodes.length; index += 1) {
    const sceneHistory = await get<{ items: Array<{ sourceScriptRevisionId: string; heading: string; summary: string }> }>(
      `/projects/${project.id}/episodes/${episodes[index]!.id}/scenes/${rediscoveredScenes[index]!.entityId}/revisions`);
    expect(sceneHistory.items[0]!.sourceScriptRevisionId).toBe(scriptIds[index]);
    expect(sceneHistory.items[0]).toMatchObject({ heading: `Adapter scene ${index + 1}`,
      summary: `Distinct scene ${index + 1}` });
    const shotHistory = await get<{ items: Array<{ sourceSceneRevisionId: string; camera: string;
      action: string; promptText: string }> }>(
      `/projects/${project.id}/episodes/${episodes[index]!.id}/scenes/${rediscoveredScenes[index]!.entityId}/shots/${rediscoveredShots[index]!.entityId}/revisions`);
    expect(shotHistory.items[0]!.sourceSceneRevisionId).toBe(rediscoveredScenes[index]!.currentRevisionId);
    expect(shotHistory.items[0]).toMatchObject({ camera: "adapter-camera",
      action: `Distinct action ${index + 1}`, promptText: `Distinct prompt ${index + 1}` });
  }

  const sibling = await post<{ entityId: string; revisionId: string; rowVersion: number }>(
    `/projects/${project.id}/episodes/${episodes[1]!.id}/scenes/${rediscoveredScenes[1]!.entityId}/shots`,
    { sourceSceneRevisionId: rediscoveredScenes[1]!.currentRevisionId, ordinal: 2,
      shotType: "WIDE", camera: "fixed", action: "sibling", promptText: "sibling" },
    rediscoveredScenes[1]!.rowVersion);

  const target = rediscoveredShots[1]!;
  const historyPath = `/projects/${project.id}/episodes/${episodes[1]!.id}/scenes/${rediscoveredScenes[1]!.entityId}/shots/${target.entityId}/revisions`;
  const before = await get<{ aggregate: { rowVersion: number }; items: Array<{ id: string; sourceSceneRevisionId: string }> }>(historyPath);
  const revisionPath = `/projects/${project.id}/episodes/${episodes[1]!.id}/scenes/${rediscoveredScenes[1]!.entityId}/shots/${target.entityId}/revisions`;
  const body = { sourceSceneRevisionId: before.items[0]!.sourceSceneRevisionId, ordinal: 1,
    shotType: "CLOSE", camera: "locked", action: "changed only in episode two", promptText: "changed" };
  const conflict = await fetch(`${base}/api/v1${revisionPath}`, { method: "POST", headers: {
    "content-type": "application/json", "idempotency-key": `m2-e2e-${++keyNo}`, "if-match": String(target.rowVersion - 1),
  }, body: JSON.stringify(body) });
  expect(conflict.status).toBe(409);
  const refreshed = await get<{ aggregate: { rowVersion: number } }>(historyPath);
  await post(revisionPath, body, refreshed.aggregate.rowVersion);
  const after = await get<{ aggregate: { rowVersion: number }; items: Array<{ reviewStatus: string }> }>(historyPath);
  expect(after.items[0]!.reviewStatus).toBe("DRAFT");
  expect(after.aggregate.rowVersion).toBe(refreshed.aggregate.rowVersion + 1);
  const siblingAfter = await get<{ aggregate: { rowVersion: number; currentRevisionId: string } }>(
    `/projects/${project.id}/episodes/${episodes[1]!.id}/scenes/${rediscoveredScenes[1]!.entityId}/shots/${sibling.entityId}/revisions`);
  expect(siblingAfter.aggregate).toMatchObject({ rowVersion: sibling.rowVersion, currentRevisionId: sibling.revisionId });
  for (const index of [0, 2]) {
    const sibling = await get<{ items: Aggregate[] }>(
      `/projects/${project.id}/episodes/${episodes[index]!.id}/scenes/${rediscoveredScenes[index]!.entityId}/shots`);
    expect(sibling.items[0]!.currentRevisionId).toBe(rediscoveredShots[index]!.currentRevisionId);
  }
  const rows = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM shot_revision WHERE shot_id=$1", [target.entityId]);
  expect(rows.rows[0]!.count).toBe(2);
});
