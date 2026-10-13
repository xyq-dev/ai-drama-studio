import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CharacterReferenceStore,
  JobPersistenceService,
  MediaAssetStore,
  RuntimeStore,
  closePostgresPool,
  createPostgresPool,
  mockMediaRetryLineage,
  requestHash,
  runMigrations,
  staleAssetsDependingOn,
  type IdempotencyScope,
  type MockMediaRetryFlags,
  type PostgresPool,
} from "@ai-drama/database";
import { MockMediaAdapter } from "@ai-drama/providers";
import { LocalMockObjects } from "./local-mock-objects";
import { runMockAvJob } from "./mock-av-generation";
import { runMockImageJob } from "./mock-image-generation";
import { runMockSmJob } from "./mock-sm-generation";
import { MockMediaRecovery } from "./mock-media-recovery";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for media retry integration tests");
}

const pool: PostgresPool = createPostgresPool({
  connectionString: databaseUrl,
  connectionTimeoutMs: 2_000,
  statementTimeoutMs: 10_000,
  queryTimeoutMs: 10_000,
});
const jobs = new JobPersistenceService(pool);
const assets = new MediaAssetStore(pool);
const store = new RuntimeStore(pool);
const adapter = new MockMediaAdapter();
const ALL_ON: MockMediaRetryFlags = {
  mockImageEnabled: true, mockAvEnabled: true, mockSmEnabled: true, mockSampleVideoEnabled: true,
};

type Kind = "MEDIA_IMAGE" | "MEDIA_VIDEO" | "MEDIA_TTS" | "MEDIA_SUBTITLE" | "MEDIA_MUSIC";
const CAPABILITY: Record<Kind, string> = {
  MEDIA_IMAGE: "image.generate",
  MEDIA_VIDEO: "video.generate",
  MEDIA_TTS: "audio.tts",
  MEDIA_SUBTITLE: "subtitle.generate",
  MEDIA_MUSIC: "audio.music",
};
const RUNTIME_CODE: Record<Kind, string> = {
  MEDIA_IMAGE: "MOCK_IMAGE_RUNTIME_FAILED",
  MEDIA_VIDEO: "MOCK_AV_RUNTIME_FAILED",
  MEDIA_TTS: "MOCK_AV_RUNTIME_FAILED",
  MEDIA_SUBTITLE: "MOCK_SM_RUNTIME_FAILED",
  MEDIA_MUSIC: "MOCK_SM_RUNTIME_FAILED",
};
const KINDS = Object.keys(CAPABILITY) as Kind[];
const PROMPT = "prompt";
const DIALOGUE = "line";

interface World {
  workspaceId: string;
  projectId: string;
  shotId: string;
  shotRevisionId: string;
  providers: Record<Kind, string>;
}

async function sql<T>(text: string, values: unknown[] = []): Promise<{ rows: T[] }> {
  return pool.query(text, values) as Promise<{ rows: T[] }>;
}

async function insertId(query: string, values: unknown[]): Promise<string> {
  const result = await sql<{ id: string }>(query, values);
  if (!result.rows[0]?.id) throw new Error("fixture insert failed");
  return result.rows[0].id;
}

async function seedApprovedShot(): Promise<World> {
  const checksum = "ab".repeat(32);
  const workspaceId = await insertId("INSERT INTO workspace (name) VALUES ($1) RETURNING id", [`ws-${randomUUID()}`]);
  const projectId = await insertId("INSERT INTO project (workspace_id, title) VALUES ($1, 'retry') RETURNING id",
    [workspaceId]);
  const story = await insertId(
    `INSERT INTO story_revision (workspace_id, project_id, revision_no, content_json, content_hash, created_by)
     VALUES ($1,$2,1,'{}'::jsonb,$3,'test') RETURNING id`, [workspaceId, projectId, checksum]);
  await sql(`UPDATE story_revision SET review_status = 'APPROVED', reviewed_by = 'test',
    reviewed_at = now(), reviewed_content_hash = content_hash WHERE id = $1`, [story]);
  await sql(`UPDATE project SET current_story_revision_id = $1, approved_story_revision_id = $1 WHERE id = $2`,
    [story, projectId]);
  const episode = await insertId(`INSERT INTO episode (workspace_id, project_id, episode_no, title)
    VALUES ($1,$2,1,'test') RETURNING id`, [workspaceId, projectId]);
  const script = await insertId(`INSERT INTO script_revision (workspace_id, project_id, episode_id,
    revision_no, source_story_revision_id, content_json, content_hash, created_by)
    VALUES ($1,$2,$3,1,$4,'{}'::jsonb,$5,'test') RETURNING id`, [workspaceId, projectId, episode, story, checksum]);
  await sql(`UPDATE script_revision SET review_status = 'APPROVED', reviewed_by = 'test',
    reviewed_at = now(), reviewed_content_hash = content_hash WHERE id = $1`, [script]);
  await sql(`UPDATE episode SET current_script_revision_id = $1, approved_script_revision_id = $1 WHERE id = $2`,
    [script, episode]);
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
  const shotId = await insertId(`INSERT INTO shot (workspace_id, project_id, episode_id, scene_id)
    VALUES ($1,$2,$3,$4) RETURNING id`, [workspaceId, projectId, episode, scene]);
  const shotRevisionId = await insertId(`INSERT INTO shot_revision
    (workspace_id, project_id, scene_id, shot_id, revision_no, source_scene_revision_id,
     ordinal, shot_type, camera, action, prompt_text, dialogue, content_hash, review_status,
     reviewed_by, reviewed_at, reviewed_content_hash, created_by)
    VALUES ($1,$2,$3,$4,1,$5,1,'close','static','look',$6,$7,$8,
      'APPROVED','test',now(),$8,'test') RETURNING id`,
  [workspaceId, projectId, scene, shotId, sceneRevision, PROMPT, DIALOGUE, checksum]);
  await sql(`UPDATE shot SET current_revision_id = $1, approved_revision_id = $1 WHERE id = $2`,
    [shotRevisionId, shotId]);
  const providers = {} as Record<Kind, string>;
  for (const kind of KINDS) {
    providers[kind] = await insertId(`INSERT INTO provider_configuration
      (workspace_id, provider_key, capability, default_timeout_ms)
      VALUES ($1,'mock-media',$2,30000) RETURNING id`, [workspaceId, CAPABILITY[kind]]);
  }
  return { workspaceId, projectId, shotId, shotRevisionId, providers };
}

/** The same frozen snapshots the API builds for each generate endpoint. */
function snapshotFor(kind: Kind, shotRevisionId: string, seed: string): Record<string, unknown> {
  if (kind === "MEDIA_IMAGE") {
    return { schema: "m3.mock.image.v1", shotRevisionId, seed, outcome: "success", bypassCache: false };
  }
  const sourceText = kind === "MEDIA_VIDEO" || kind === "MEDIA_MUSIC" ? PROMPT : DIALOGUE;
  const schema = {
    MEDIA_VIDEO: "m3.mock.video.v1", MEDIA_TTS: "m3.mock.tts.v1",
    MEDIA_SUBTITLE: "m3.mock.subtitle.v1", MEDIA_MUSIC: "m3.mock.music.v1",
  }[kind];
  return {
    schema, shotRevisionId, seed,
    ...(kind === "MEDIA_VIDEO" || kind === "MEDIA_TTS" ? { bypassCache: false } : {}),
    outcome: "success", executionMode: "sync", capability: CAPABILITY[kind],
    sourceText, sourceHash: createHash("sha256").update(sourceText).digest("hex"),
  };
}

async function createMediaJob(world: World, kind: Kind, snapshot = snapshotFor(kind, world.shotRevisionId, "seed-1")) {
  const created = await jobs.createWorkflowJob({
    workspaceId: world.workspaceId, projectId: world.projectId, sourceShotRevisionId: world.shotRevisionId,
    type: kind, requestedBy: "test", kind,
    inputHash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
    inputSnapshot: snapshot, traceId: `create-${kind}`,
  });
  const queued = await jobs.queueJob({ workspaceId: world.workspaceId, jobId: created.jobId, traceId: "queue" });
  return { ...created, dispatchSeq: queued.dispatchSeq };
}

async function failJob(world: World, kind: Kind, job: { jobId: string; dispatchSeq: number },
  errorCode = RUNTIME_CODE[kind], providerConfigurationId = world.providers[kind]) {
  const acquired = await jobs.acquireQueuedJob({
    workspaceId: world.workspaceId, jobId: job.jobId, dispatchSeq: job.dispatchSeq,
    leaseOwner: "test", leaseMs: 60_000, traceId: "acquire", providerConfigurationId,
  });
  if (!acquired) throw new Error("job was not acquired");
  await jobs.failJob({ workspaceId: world.workspaceId, jobId: job.jobId, attemptId: acquired.attemptId,
    traceId: "fail", errorCode, errorMessage: "test failure", retryable: false });
  return acquired;
}

async function failedMediaJob(world: World, kind: Kind) {
  const job = await createMediaJob(world, kind);
  const attempt = await failJob(world, kind, job);
  return { ...job, attemptId: attempt.attemptId };
}

function retry(world: World, jobId: string, flags: MockMediaRetryFlags = ALL_ON) {
  return jobs.manualRetry({
    workspaceId: world.workspaceId, jobId, requestedBy: "test", traceId: `retry-${jobId}`, retryable: true,
    lineage: mockMediaRetryLineage({ workspaceId: world.workspaceId, mediaAssets: assets, flags }),
  });
}

function scope(world: World, jobId: string, key: string): IdempotencyScope {
  return { workspaceId: world.workspaceId, actorId: "test", httpMethod: "POST",
    routeKey: `/generation-jobs/${jobId}/retry`, key, requestHash: requestHash({}) };
}

function retryWithKey(world: World, jobId: string, key: string) {
  return jobs.manualRetryIdempotent(scope(world, jobId, key), {
    workspaceId: world.workspaceId, jobId, requestedBy: "test", traceId: `retry-${key}`, retryable: true,
    lineage: mockMediaRetryLineage({ workspaceId: world.workspaceId, mediaAssets: assets, flags: ALL_ON }),
  });
}

async function jobRow(jobId: string) {
  return (await sql<Record<string, unknown>>(
    `SELECT id, kind, state, error_code, row_version, updated_at, completed_at, source_shot_revision_id,
            input_hash, input_snapshot, workflow_run_id
       FROM generation_job WHERE id = $1`, [jobId])).rows[0];
}

async function jobCount(world: World): Promise<number> {
  return (await sql<{ count: number }>("SELECT count(*)::int AS count FROM generation_job WHERE workspace_id = $1",
    [world.workspaceId])).rows[0]?.count ?? -1;
}

async function attemptCount(jobId: string): Promise<number> {
  return (await sql<{ count: number }>("SELECT count(*)::int AS count FROM job_attempt WHERE generation_job_id = $1",
    [jobId])).rows[0]?.count ?? -1;
}

async function retryEvents(jobId: string) {
  return (await sql<{ event_type: string; payload_json: Record<string, unknown> }>(
    `SELECT event_type, payload_json FROM domain_event
      WHERE aggregate_id = $1 AND event_type IN ('job.retried', 'job.retry_of') ORDER BY id`, [jobId])).rows;
}

beforeAll(async () => {
  await sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await runMigrations(pool);
});

beforeEach(async () => {
  await sql("TRUNCATE workspace RESTART IDENTITY CASCADE");
});

afterAll(async () => {
  await closePostgresPool(pool);
});

describe("Mock media manual retry", () => {
  it.each(KINDS)("copies the source shot and frozen input of a failed %s into one new queued job", async (kind) => {
    const world = await seedApprovedShot();
    const source = await failedMediaJob(world, kind);
    const before = await jobRow(source.jobId);

    const retried = await retry(world, source.jobId);

    expect(retried.jobId).not.toBe(source.jobId);
    expect(retried.workflowRunId).not.toBe(source.workflowRunId);
    expect(retried.retry).toEqual({ sourceJobId: source.jobId, rootJobId: source.jobId, manualRetryCount: 1 });
    const next = await jobRow(retried.jobId);
    expect(next).toMatchObject({
      kind, state: "QUEUED", source_shot_revision_id: world.shotRevisionId,
      input_hash: before?.input_hash, input_snapshot: before?.input_snapshot,
    });
    expect(await jobRow(source.jobId)).toEqual(before);
    expect(await attemptCount(source.jobId)).toBe(1);
    expect(await attemptCount(retried.jobId)).toBe(0);
    expect(await retryEvents(source.jobId)).toEqual([{ event_type: "job.retried", payload_json: {
      jobId: source.jobId, retryJobId: retried.jobId, workflowRunId: retried.workflowRunId,
      rootJobId: source.jobId, manualRetryCount: 1,
    } }]);
    expect(await retryEvents(retried.jobId)).toEqual([{ event_type: "job.retry_of", payload_json: {
      jobId: retried.jobId, sourceJobId: source.jobId, rootJobId: source.jobId, manualRetryCount: 1,
    } }]);
    const outbox = await sql<{ count: number }>(
      "SELECT count(*)::int AS count FROM dispatch_outbox WHERE job_id = $1", [retried.jobId]);
    expect(outbox.rows[0]?.count).toBe(1);
  });

  it("retries a canceled media job and a failed media job whose lease expired", async () => {
    const world = await seedApprovedShot();
    const canceled = await createMediaJob(world, "MEDIA_VIDEO");
    await jobs.cancelJob({ workspaceId: world.workspaceId, jobId: canceled.jobId, traceId: "cancel" });
    await expect(retry(world, canceled.jobId)).resolves.toMatchObject({ retry: { manualRetryCount: 1 } });
    const expired = await createMediaJob(world, "MEDIA_TTS");
    await failJob(world, "MEDIA_TTS", expired, "LEASE_EXPIRED");
    await expect(retry(world, expired.jobId)).resolves.toMatchObject({ retry: { manualRetryCount: 1 } });
  });

  it.each([
    ["MOCK_IMAGE_OUTPUT_INVALID", "JOB_NOT_RETRYABLE"],
    ["MOCK_MEDIA_NOT_CONFIGURED", "JOB_NOT_RETRYABLE"],
    ["MOCK_MEDIA_ROUTE_INVALID", "JOB_NOT_RETRYABLE"],
    ["MOCK_PROVIDER_FAILED", "JOB_NOT_RETRYABLE"],
    ["MOCK_REQUEST_UNKNOWN", "JOB_NOT_RETRYABLE"],
  ])("rejects a media job that failed with %s and writes nothing", async (errorCode, expected) => {
    const world = await seedApprovedShot();
    const job = await createMediaJob(world, "MEDIA_IMAGE");
    await failJob(world, "MEDIA_IMAGE", job, errorCode);
    const before = await jobCount(world);
    await expect(retry(world, job.jobId)).rejects.toMatchObject({ code: expected });
    expect(await jobCount(world)).toBe(before);
    expect(await retryEvents(job.jobId)).toEqual([]);
  });

  it("rejects succeeded, running and compose jobs", async () => {
    const world = await seedApprovedShot();
    const objectDir = await mkdtemp(join(tmpdir(), "media-retry-"));
    try {
      const succeeded = await createMediaJob(world, "MEDIA_IMAGE");
      await runMockImageJob({ workspaceId: world.workspaceId, projectId: world.projectId,
        shotRevisionId: world.shotRevisionId, jobId: succeeded.jobId, dispatchSeq: succeeded.dispatchSeq,
        providerConfigurationId: world.providers.MEDIA_IMAGE,
        inputHash: (await jobRow(succeeded.jobId))?.input_hash as string,
        inputSnapshot: (await jobRow(succeeded.jobId))?.input_snapshot, traceId: "run" },
      { jobs, assets, adapter, objects: new LocalMockObjects(objectDir) });
      expect((await jobRow(succeeded.jobId))?.state).toBe("SUCCEEDED");
      await expect(retry(world, succeeded.jobId)).rejects.toMatchObject({ code: "JOB_NOT_RETRYABLE" });
      const queued = await createMediaJob(world, "MEDIA_MUSIC");
      await expect(retry(world, queued.jobId)).rejects.toMatchObject({ code: "JOB_NOT_RETRYABLE" });
      const compose = await jobs.createWorkflowJob({ workspaceId: world.workspaceId, projectId: world.projectId,
        type: "MEDIA_COMPOSE", requestedBy: "test", kind: "MEDIA_COMPOSE", inputHash: "cd".repeat(32),
        inputSnapshot: {}, traceId: "compose" });
      await jobs.cancelJob({ workspaceId: world.workspaceId, jobId: compose.jobId, traceId: "cancel" });
      await expect(retry(world, compose.jobId)).rejects.toMatchObject({ code: "JOB_NOT_RETRYABLE" });
      // The job view names the episode an episode compose froze, and nothing for any other job.
      const episodeId = randomUUID();
      const episodeCompose = await jobs.createWorkflowJob({ workspaceId: world.workspaceId, projectId: world.projectId,
        type: "MEDIA_COMPOSE", requestedBy: "test", kind: "MEDIA_COMPOSE", inputHash: "ce".repeat(32),
        inputSnapshot: { schema: "m4.episode.compose.v1", input: { episodeId } }, traceId: "episode-compose" });
      expect((await store.getJob(world.workspaceId, episodeCompose.jobId)).composeEpisodeId).toBe(episodeId);
      expect((await store.getJob(world.workspaceId, compose.jobId)).composeEpisodeId).toBeNull();
      expect((await store.getJob(world.workspaceId, succeeded.jobId)).composeEpisodeId).toBeNull();
      const listed = (await store.listWorkflows(world.workspaceId, world.projectId)).flatMap((run) => run.jobs);
      expect(listed.find((job) => job.id === episodeCompose.jobId)?.composeEpisodeId).toBe(episodeId);
    } finally {
      await rm(objectDir, { recursive: true, force: true });
    }
  });

  it("rejects a stale, unapproved or recalculating shot without creating a job", async () => {
    const world = await seedApprovedShot();
    const video = await failedMediaJob(world, "MEDIA_VIDEO");
    const image = await failedMediaJob(world, "MEDIA_IMAGE");
    const before = await jobCount(world);

    await sql(`UPDATE shot SET approved_revision_id = NULL WHERE id = $1`, [world.shotId]);
    await expect(retry(world, video.jobId)).rejects.toMatchObject({ code: "REVIEW_REQUIRED" });
    await sql(`UPDATE shot SET approved_revision_id = current_revision_id WHERE id = $1`, [world.shotId]);

    const pending = await insertId(`INSERT INTO stale_recalculation
        (workspace_id, project_id, stale_from_ref, reason, status)
       VALUES ($1, $2, 'story_revision:11111111-1111-4111-8111-111111111111', 'SOURCE_STORY_REPLACED', 'PENDING')
       RETURNING id`, [world.workspaceId, world.projectId]);
    await expect(retry(world, image.jobId)).rejects.toMatchObject({ code: "STALE_RECALCULATION_PENDING" });
    await sql("DELETE FROM stale_recalculation WHERE id = $1", [pending]);

    await sql(`UPDATE shot_revision
        SET freshness_status = 'STALE', stale_reason = 'TEST',
            stale_from_ref = 'script_revision:11111111-1111-4111-8111-111111111111',
            review_version = review_version + 1
      WHERE id = $1`, [world.shotRevisionId]);
    await expect(retry(world, image.jobId)).rejects.toMatchObject({ code: "REVIEW_REQUIRED" });
    await expect(retry(world, video.jobId)).rejects.toMatchObject({ code: "REVIEW_REQUIRED" });

    expect(await jobCount(world)).toBe(before);
    expect(await retryEvents(image.jobId)).toEqual([]);
    expect(await retryEvents(video.jobId)).toEqual([]);
  });

  it("rejects a closed switch, a disabled provider, a non-Mock attempt and a mismatched snapshot", async () => {
    const world = await seedApprovedShot();
    const image = await failedMediaJob(world, "MEDIA_IMAGE");
    const subtitle = await failedMediaJob(world, "MEDIA_SUBTITLE");
    const tts = await failedMediaJob(world, "MEDIA_TTS");
    const before = await jobCount(world);
    await expect(retry(world, image.jobId, { ...ALL_ON, mockImageEnabled: false }))
      .rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });
    await expect(retry(world, subtitle.jobId, { ...ALL_ON, mockSmEnabled: false }))
      .rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });
    await expect(retry(world, tts.jobId, { ...ALL_ON, mockAvEnabled: false }))
      .rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });

    await sql("UPDATE provider_configuration SET enabled = false WHERE id = $1", [world.providers.MEDIA_SUBTITLE]);
    await expect(retry(world, subtitle.jobId)).rejects.toMatchObject({ code: "PROVIDER_CONFIG_INVALID" });

    const plainMockProvider = await store.ensureMockProvider(world.workspaceId, 3);
    const foreign = await createMediaJob(world, "MEDIA_MUSIC");
    await failJob(world, "MEDIA_MUSIC", foreign, RUNTIME_CODE.MEDIA_MUSIC, plainMockProvider);
    await expect(retry(world, foreign.jobId)).rejects.toMatchObject({ code: "JOB_NOT_RETRYABLE" });

    const otherShot = { ...snapshotFor("MEDIA_VIDEO", world.shotRevisionId, "seed-1"), shotRevisionId: randomUUID() };
    const mismatched = await createMediaJob(world, "MEDIA_VIDEO", otherShot);
    await failJob(world, "MEDIA_VIDEO", mismatched);
    await expect(retry(world, mismatched.jobId)).rejects.toMatchObject({ code: "JOB_NOT_RETRYABLE" });

    const changedText = { ...snapshotFor("MEDIA_TTS", world.shotRevisionId, "seed-1"), sourceText: "other line" };
    const changed = await createMediaJob(world, "MEDIA_TTS", changedText);
    await failJob(world, "MEDIA_TTS", changed);
    await expect(retry(world, changed.jobId)).rejects.toMatchObject({ code: "JOB_NOT_RETRYABLE" });

    expect(await jobCount(world)).toBe(before + 3);
  });

  it("replays the same key to the first successor and refuses a second key with that successor", async () => {
    const world = await seedApprovedShot();
    const source = await failedMediaJob(world, "MEDIA_IMAGE");
    const first = await retryWithKey(world, source.jobId, "key-a");
    expect(first).toMatchObject({ replayed: false, status: 202 });
    const replay = await retryWithKey(world, source.jobId, "key-a");
    expect(replay).toEqual({ replayed: true, status: 202, body: first.body });

    const error = await retryWithKey(world, source.jobId, "key-b").catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "JOB_NOT_RETRYABLE",
      details: { retryJobId: first.body.jobId, rootJobId: source.jobId, manualRetryCount: 1 },
    });
    const children = await sql<{ count: number }>(
      `SELECT count(*)::int AS count FROM domain_event WHERE aggregate_id = $1 AND event_type = 'job.retried'`,
      [source.jobId]);
    expect(children.rows[0]?.count).toBe(1);
    const replayAfter = await retryWithKey(world, source.jobId, "key-a");
    expect(replayAfter.body).toEqual(first.body);
  });

  it("creates exactly one successor when different keys race on PostgreSQL", async () => {
    const world = await seedApprovedShot();
    const source = await failedMediaJob(world, "MEDIA_VIDEO");
    const before = await jobCount(world);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) => retryWithKey(world, source.jobId, `race-${index}`)),
    );
    const created = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(5);
    const winner = (created[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof retryWithKey>>>).value.body.jobId;
    for (const result of rejected) {
      expect(result.reason).toMatchObject({ code: "JOB_NOT_RETRYABLE", details: { retryJobId: winner } });
    }
    expect(await jobCount(world)).toBe(before + 1);
    const keys = await sql<{ count: number }>(
      "SELECT count(*)::int AS count FROM idempotency_record WHERE workspace_id = $1", [world.workspaceId]);
    expect(keys.rows[0]?.count).toBe(1);
  });

  it("allows two manual retries per chain and rejects the third with RETRY_LIMIT", async () => {
    const world = await seedApprovedShot();
    const root = await failedMediaJob(world, "MEDIA_MUSIC");
    const first = await retry(world, root.jobId);
    await failJob(world, "MEDIA_MUSIC", first);
    const second = await retry(world, first.jobId);
    expect(second.retry).toEqual({ sourceJobId: first.jobId, rootJobId: root.jobId, manualRetryCount: 2 });
    await failJob(world, "MEDIA_MUSIC", second);
    const rows = [await jobRow(root.jobId), await jobRow(first.jobId), await jobRow(second.jobId)];
    const before = await jobCount(world);

    const limit = await retry(world, second.jobId).catch((caught: unknown) => caught);
    expect(limit).toMatchObject({ code: "RETRY_LIMIT",
      details: { rootJobId: root.jobId, manualRetryCount: 2, limit: 2 } });
    await expect(retry(world, root.jobId)).rejects.toMatchObject({ code: "JOB_NOT_RETRYABLE",
      details: { retryJobId: first.jobId } });
    expect(await jobCount(world)).toBe(before);
    expect([await jobRow(root.jobId), await jobRow(first.jobId), await jobRow(second.jobId)]).toEqual(rows);
    expect((await retryEvents(second.jobId)).map((event) => event.event_type)).toEqual(["job.retry_of"]);
  });

  it("refuses a chain whose parent does not point back to the job", async () => {
    const world = await seedApprovedShot();
    const job = await failedMediaJob(world, "MEDIA_IMAGE");
    await sql(`INSERT INTO domain_event
        (workspace_id, project_id, aggregate_type, aggregate_id, event_type, payload_json, trace_id)
      VALUES ($1, $2, 'GenerationJob', $3, 'job.retry_of', $4::jsonb, 'forged')`,
    [world.workspaceId, world.projectId, job.jobId, JSON.stringify({
      jobId: job.jobId, sourceJobId: randomUUID(), rootJobId: randomUUID(), manualRetryCount: 1 })]);
    await expect(retry(world, job.jobId)).rejects.toMatchObject({ code: "RETRY_LINEAGE_INVALID" });
  });

  it("runs the retried jobs through the workers, books their own cost and rejects late source results", async () => {
    const world = await seedApprovedShot();
    const objectDir = await mkdtemp(join(tmpdir(), "media-retry-"));
    const objects = new LocalMockObjects(objectDir);
    try {
      for (const kind of ["MEDIA_IMAGE", "MEDIA_VIDEO", "MEDIA_MUSIC"] as const) {
        const source = await failedMediaJob(world, kind);
        const costsBefore = await sql<{ count: number }>(
          "SELECT count(*)::int AS count FROM cost_ledger WHERE generation_job_id = $1", [source.jobId]);
        const retried = await retry(world, source.jobId);
        const row = await jobRow(retried.jobId);
        const common = {
          workspaceId: world.workspaceId, projectId: world.projectId, shotRevisionId: world.shotRevisionId,
          jobId: retried.jobId, dispatchSeq: retried.dispatchSeq, providerConfigurationId: world.providers[kind],
          inputHash: row?.input_hash as string, inputSnapshot: row?.input_snapshot, traceId: `run-${kind}`,
        };
        const asset = kind === "MEDIA_IMAGE"
          ? await runMockImageJob(common, { jobs, assets, adapter, objects })
          : kind === "MEDIA_VIDEO"
            ? await runMockAvJob({ ...common, capability: "video.generate" }, { jobs, assets, adapter, objects })
            : await runMockSmJob({ ...common, capability: "audio.music" }, { jobs, assets, adapter, objects });
        expect(asset).not.toBeNull();
        expect((await jobRow(retried.jobId))?.state).toBe("SUCCEEDED");
        const stored = await sql<{ source_generation_job_id: string; source_shot_revision_id: string }>(
          "SELECT source_generation_job_id, source_shot_revision_id FROM asset WHERE id = $1", [asset?.id]);
        expect(stored.rows[0]).toEqual({ source_generation_job_id: retried.jobId,
          source_shot_revision_id: world.shotRevisionId });
        const costs = await sql<{ kind: string; amount_decimal: string; job_attempt_id: string }>(
          "SELECT kind, amount_decimal, job_attempt_id FROM cost_ledger WHERE generation_job_id = $1",
          [retried.jobId]);
        expect(costs.rows).toHaveLength(1);
        expect(costs.rows[0]).toMatchObject({ kind: "ACTUAL" });
        expect(Number(costs.rows[0]?.amount_decimal)).toBe(0);
        expect((await sql<{ count: number }>(
          "SELECT count(*)::int AS count FROM cost_ledger WHERE generation_job_id = $1", [source.jobId])).rows)
          .toEqual(costsBefore.rows);

        await expect(jobs.succeedJobWithArtifact({
          workspaceId: world.workspaceId, jobId: source.jobId, attemptId: source.attemptId, traceId: "late",
          persistArtifact: () => Promise.resolve({ id: "late" }),
        })).rejects.toMatchObject({ code: "JOB_TERMINAL" });
        expect((await jobRow(source.jobId))?.state).toBe("FAILED");
        const late = await sql<{ count: number }>(
          "SELECT count(*)::int AS count FROM asset WHERE source_generation_job_id = $1", [source.jobId]);
        expect(late.rows[0]?.count).toBe(0);
      }
    } finally {
      await rm(objectDir, { recursive: true, force: true });
    }
  });

  it("leaves text job retries unchanged: no lineage events and no per-job successor limit", async () => {
    const world = await seedApprovedShot();
    const providerId = await store.ensureMockProvider(world.workspaceId, 3);
    const created = await jobs.createWorkflowJob({ workspaceId: world.workspaceId, projectId: world.projectId,
      type: "MOCK_GENERATION", requestedBy: "test", kind: "MOCK",
      inputHash: createHash("sha256").update("terminal").digest("hex"), inputSnapshot: { outcome: "terminal" },
      traceId: "text" });
    const queued = await jobs.queueJob({ workspaceId: world.workspaceId, jobId: created.jobId, traceId: "queue" });
    const acquired = await jobs.acquireQueuedJob({ workspaceId: world.workspaceId, jobId: created.jobId,
      dispatchSeq: queued.dispatchSeq, leaseOwner: "test", leaseMs: 60_000, traceId: "acquire",
      providerConfigurationId: providerId });
    await jobs.failJob({ workspaceId: world.workspaceId, jobId: created.jobId, attemptId: acquired!.attemptId,
      traceId: "fail", errorCode: "MOCK_RETRYABLE", errorMessage: "x", retryable: false });
    const input = { workspaceId: world.workspaceId, jobId: created.jobId, requestedBy: "test",
      traceId: "text-retry", retryable: true };
    const first = await jobs.manualRetry(input);
    const second = await jobs.manualRetry(input);
    expect(first.retry).toBeUndefined();
    expect(second.jobId).not.toBe(first.jobId);
    expect(await retryEvents(created.jobId)).toEqual([]);
    await expect(jobs.manualRetry({ ...input, retryable: false })).rejects.toMatchObject({ code: "JOB_NOT_RETRYABLE" });
  });
});

describe("Mock media input reuse lookup", () => {
  async function succeededImage(world: World, seed: string) {
    const objectDir = await mkdtemp(join(tmpdir(), "media-reuse-"));
    const job = await createMediaJob(world, "MEDIA_IMAGE", snapshotFor("MEDIA_IMAGE", world.shotRevisionId, seed));
    const row = await jobRow(job.jobId);
    const asset = await runMockImageJob({ workspaceId: world.workspaceId, projectId: world.projectId,
      shotRevisionId: world.shotRevisionId, jobId: job.jobId, dispatchSeq: job.dispatchSeq,
      providerConfigurationId: world.providers.MEDIA_IMAGE, inputHash: row?.input_hash as string,
      inputSnapshot: row?.input_snapshot, traceId: "run" }, { jobs, assets, adapter, objects: new LocalMockObjects(objectDir) });
    await rm(objectDir, { recursive: true, force: true });
    return { job, row, assetId: asset!.id };
  }

  async function lookup(world: World, inputHash: string, overrides: Partial<{ projectId: string; jobKind: string;
    capability: string; assetKind: string; shotRevisionId: string }> = {}) {
    const client = await pool.connect();
    try {
      return (await assets.findReusableShotAssetsInTransaction(client, {
        workspaceId: world.workspaceId, projectId: world.projectId, shotRevisionId: world.shotRevisionId,
        jobKind: "MEDIA_IMAGE", inputHash, capability: "image.generate", assetKind: "IMAGE", ...overrides,
      })).map((candidate) => ({ assetId: candidate.asset.id, jobId: candidate.jobId }));
    } finally {
      client.release();
    }
  }

  it("finds only an ACTIVE asset of a SUCCEEDED job with the same scope, input and enabled provider", async () => {
    const world = await seedApprovedShot();
    const done = await succeededImage(world, "reuse-seed");
    const hash = done.row?.input_hash as string;
    expect(await lookup(world, hash)).toEqual([{ assetId: done.assetId, jobId: done.job.jobId }]);
    expect(await lookup(world, "ef".repeat(32))).toEqual([]);
    expect(await lookup(world, hash, { jobKind: "MEDIA_VIDEO", capability: "video.generate", assetKind: "VIDEO" })).toEqual([]);
    expect(await lookup(world, hash, { shotRevisionId: randomUUID() })).toEqual([]);
    const other = await seedApprovedShot();
    expect(await lookup({ ...other, shotRevisionId: world.shotRevisionId }, hash)).toEqual([]);

    const failed = await failedMediaJob(world, "MEDIA_IMAGE");
    expect(await lookup(world, (await jobRow(failed.jobId))?.input_hash as string)).toEqual([]);

    await sql("UPDATE provider_configuration SET enabled = false WHERE id = $1", [world.providers.MEDIA_IMAGE]);
    expect(await lookup(world, hash)).toEqual([]);
    await sql("UPDATE provider_configuration SET enabled = true WHERE id = $1", [world.providers.MEDIA_IMAGE]);
    await sql("UPDATE asset SET status = 'STALE', row_version = row_version + 1 WHERE id = $1", [done.assetId]);
    expect(await lookup(world, hash)).toEqual([]);
  });

  it("answers a reuse with 200 under the idempotency record and creates no job, attempt, outbox or cost", async () => {
    const world = await seedApprovedShot();
    const done = await succeededImage(world, "reuse-key");
    const counts = async () => (await sql<{ jobs: number; attempts: number; outbox: number; costs: number }>(
      `SELECT (SELECT count(*)::int FROM generation_job WHERE workspace_id = $1) AS jobs,
              (SELECT count(*)::int FROM job_attempt WHERE workspace_id = $1) AS attempts,
              (SELECT count(*)::int FROM dispatch_outbox WHERE workspace_id = $1) AS outbox,
              (SELECT count(*)::int FROM cost_ledger WHERE workspace_id = $1) AS costs`, [world.workspaceId])).rows[0];
    const before = await counts();
    const reuseScope: IdempotencyScope = { workspaceId: world.workspaceId, actorId: "test", httpMethod: "POST",
      routeKey: `/shot-revisions/${world.shotRevisionId}/generate-image`, key: "reuse-1", requestHash: requestHash({ seed: "reuse-key" }) };
    const resolve = async (client: Parameters<typeof assets.findReusableShotAssetsInTransaction>[0]) => {
      const [hit] = await assets.findReusableShotAssetsInTransaction(client, {
        workspaceId: world.workspaceId, projectId: world.projectId, shotRevisionId: world.shotRevisionId,
        jobKind: "MEDIA_IMAGE", inputHash: done.row?.input_hash as string, capability: "image.generate", assetKind: "IMAGE",
      });
      if (!hit) throw new Error("expected a reusable asset");
      return { kind: "reuse" as const, body: { cache: "HIT" as const, assetId: hit.asset.id, sourceJobId: hit.jobId } };
    };
    const first = await jobs.createQueueOrReuse(reuseScope, resolve);
    expect(first).toEqual({ replayed: false, status: 200,
      body: { cache: "HIT", assetId: done.assetId, sourceJobId: done.job.jobId } });
    const replay = await jobs.createQueueOrReuse(reuseScope, resolve);
    expect(replay).toEqual({ replayed: true, status: 200, body: first.body });
    expect(await counts()).toEqual(before);

    const miss = await jobs.createQueueOrReuse({ ...reuseScope, key: "reuse-2" }, async () => ({
      kind: "job" as const,
      input: { workspaceId: world.workspaceId, projectId: world.projectId, sourceShotRevisionId: world.shotRevisionId,
        type: "MEDIA_IMAGE", requestedBy: "test", kind: "MEDIA_IMAGE", inputHash: done.row?.input_hash as string,
        inputSnapshot: done.row?.input_snapshot, traceId: "miss" },
    }));
    expect(miss.status).toBe(202);
    expect(miss.body).toMatchObject({ dispatchSeq: 1 });
    expect((await counts())?.jobs).toBe((before?.jobs ?? 0) + 1);
  });

  it("finds and answers a reuse on a one-connection pool, so the check never needs a second connection", async () => {
    const world = await seedApprovedShot();
    const done = await succeededImage(world, "single-connection");
    // Any request for a second connection while the transaction holds the first one fails immediately.
    let held = 0;
    let secondRequested = false;
    const narrow = {
      connect: async () => {
        if (held >= 1) {
          secondRequested = true;
          throw new Error("a second connection was requested inside the reuse transaction");
        }
        held += 1;
        const client = await pool.connect();
        const release = client.release.bind(client);
        client.release = (...args: Parameters<typeof release>) => {
          held -= 1;
          client.release = release;
          return release(...args);
        };
        return client;
      },
    };
    try {
      const narrowAssets = new MediaAssetStore(narrow);
      const narrowJobs = new JobPersistenceService(narrow);
      const answer = await narrowJobs.createQueueOrReuse({ workspaceId: world.workspaceId, actorId: "test", httpMethod: "POST",
        routeKey: `/shot-revisions/${world.shotRevisionId}/generate-image`, key: "single", requestHash: requestHash({}) },
      async (client) => {
        const [hit] = await narrowAssets.findReusableShotAssetsInTransaction(client, {
          workspaceId: world.workspaceId, projectId: world.projectId, shotRevisionId: world.shotRevisionId,
          jobKind: "MEDIA_IMAGE", inputHash: done.row?.input_hash as string, capability: "image.generate", assetKind: "IMAGE",
        });
        if (!hit) throw new Error("expected a reusable asset");
        expect(hit.asset).toMatchObject({ id: done.assetId, kind: "IMAGE", status: "ACTIVE", sourceShotRevisionId: world.shotRevisionId });
        return { kind: "reuse" as const, body: { cache: "HIT" as const, assetId: hit.asset.id } };
      });
      expect(answer).toMatchObject({ status: 200, body: { assetId: done.assetId } });
      expect(secondRequested).toBe(false);
    } finally {
      expect(held).toBe(0);
    }
  });
});

describe("replacing a selected reference stales what was made from it", () => {
  it("marks dependent videos and their downstream assets STALE and leaves the reference, other branches, reviews and costs alone", async () => {
    const world = await seedApprovedShot();
    const objectDir = await mkdtemp(join(tmpdir(), "reference-stale-"));
    const objects = new LocalMockObjects(objectDir);
    const run = async (kind: "MEDIA_IMAGE" | "MEDIA_VIDEO" | "MEDIA_MUSIC", seed: string) => {
      const job = await createMediaJob(world, kind, snapshotFor(kind, world.shotRevisionId, seed));
      const row = await jobRow(job.jobId);
      const common = { workspaceId: world.workspaceId, projectId: world.projectId, shotRevisionId: world.shotRevisionId,
        jobId: job.jobId, dispatchSeq: job.dispatchSeq, providerConfigurationId: world.providers[kind],
        inputHash: row?.input_hash as string, inputSnapshot: row?.input_snapshot, traceId: `stale-${seed}` };
      const asset = kind === "MEDIA_IMAGE" ? await runMockImageJob(common, { jobs, assets, adapter, objects })
        : kind === "MEDIA_VIDEO" ? await runMockAvJob({ ...common, capability: "video.generate" }, { jobs, assets, adapter, objects })
          : await runMockSmJob({ ...common, capability: "audio.music" }, { jobs, assets, adapter, objects });
      return asset!.id;
    };
    try {
      // Stand-ins for the strict path: a reference image, a video made from it, and an asset made from that video.
      const reference = await run("MEDIA_IMAGE", "reference-a");
      const video = await run("MEDIA_VIDEO", "video-from-a");
      const downstream = await run("MEDIA_MUSIC", "downstream-of-video");
      const unrelated = await run("MEDIA_VIDEO", "video-from-b");
      const edge = (dependent: string, source: string) => sql(
        `INSERT INTO asset_dependency (workspace_id, project_id, dependent_asset_id, source_asset_id) VALUES ($1, $2, $3, $4)`,
        [world.workspaceId, world.projectId, dependent, source]);
      await edge(video, reference);
      await edge(downstream, video);
      const costsBefore = await sql<{ count: number }>("SELECT count(*)::int AS count FROM cost_ledger WHERE workspace_id = $1",
        [world.workspaceId]);
      const client = await pool.connect();
      let staled: string[];
      try {
        await client.query("BEGIN");
        staled = await staleAssetsDependingOn(client, world.workspaceId, reference, "character_reference_selection:test", "stale-test");
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      expect(staled.sort()).toEqual([video, downstream].sort());
      const states = await sql<{ id: string; status: string; review_status: string; row_version: number }>(
        "SELECT id, status, review_status, row_version FROM asset WHERE id = ANY($1::uuid[])",
        [[reference, video, downstream, unrelated]]);
      const byId = Object.fromEntries(states.rows.map((row) => [row.id, row]));
      expect(byId[reference]).toMatchObject({ status: "ACTIVE", row_version: 1 });
      expect(byId[video]).toMatchObject({ status: "STALE", review_status: "DRAFT", row_version: 2 });
      expect(byId[downstream]).toMatchObject({ status: "STALE", row_version: 2 });
      expect(byId[unrelated]).toMatchObject({ status: "ACTIVE", row_version: 1 });
      const events = await sql<{ aggregate_id: string; payload_json: { staleFromRef: string } }>(
        "SELECT aggregate_id, payload_json FROM domain_event WHERE event_type = 'asset.stale' AND workspace_id = $1",
        [world.workspaceId]);
      expect(events.rows.map((row) => row.aggregate_id).sort()).toEqual([video, downstream].sort());
      expect(events.rows.every((row) => row.payload_json.staleFromRef === "character_reference_selection:test")).toBe(true);
      expect((await sql<{ count: number }>("SELECT count(*)::int AS count FROM cost_ledger WHERE workspace_id = $1",
        [world.workspaceId])).rows).toEqual(costsBefore.rows);
      // A second pass finds nothing left ACTIVE on that branch.
      const again = await pool.connect();
      try {
        expect(await staleAssetsDependingOn(again, world.workspaceId, reference, "character_reference_selection:test", "again")).toEqual([]);
      } finally {
        again.release();
      }
    } finally {
      await rm(objectDir, { recursive: true, force: true });
    }
  });
});

describe("a strict video whose reference probe hits a transient database error", () => {
  it("keeps the attempt recoverable through execution and recovery, then settles once the probe answers", async () => {
    const world = await seedApprovedShot();
    const objectDir = await mkdtemp(join(tmpdir(), "probe-fault-"));
    const objects = new LocalMockObjects(objectDir);
    // The real pool; only the structure probe's query fails while the fault is on, as a statement timeout would.
    const fault = { on: true };
    const faultyPool = {
      connect: async () => {
        const client = await pool.connect();
        const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
        (client as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = (...args: unknown[]) => {
          const text = typeof args[0] === "string" ? args[0] : "";
          if (fault.on && text.includes("information_schema.columns")) {
            return Promise.reject(Object.assign(new Error("canceling statement due to statement timeout"),
              { code: "57014", severity: "ERROR" }));
          }
          return query(...args);
        };
        const release = client.release.bind(client);
        client.release = (...releaseArgs: Parameters<typeof release>) => {
          (client as unknown as { query: unknown }).query = query;
          client.release = release;
          return release(...releaseArgs);
        };
        return client;
      },
    };
    // The completion transaction is opened by JobPersistenceService.succeedJobWithArtifact, so both services must use
    // the faulty pool for the probe inside that transaction to see the fault.
    const faultyAssets = new MediaAssetStore(faultyPool);
    const faultyJobs = new JobPersistenceService(faultyPool);
    const strictSnapshot = { ...snapshotFor("MEDIA_VIDEO", world.shotRevisionId, "strict-probe"),
      characterReferences: [{ characterRevisionId: randomUUID(), assetId: randomUUID(), checksumSha256: "ab".repeat(32) }] };
    const job = await createMediaJob(world, "MEDIA_VIDEO", strictSnapshot);
    const row = await jobRow(job.jobId);
    const adapter = new MockMediaAdapter();
    let submits = 0;
    const submit = adapter.submit.bind(adapter);
    adapter.submit = async (request) => { submits += 1; return submit(request); };
    const ledger = async () => (await sql<{ state: string; error_code: string | null; attempts: number; requests: string[];
      assets: number; costs: number; succeeded: number; failed: number }>(
      `SELECT job.state, job.error_code,
              (SELECT count(*)::int FROM job_attempt WHERE generation_job_id = job.id) AS attempts,
              (SELECT array_agg(provider_request_id) FROM job_attempt WHERE generation_job_id = job.id) AS requests,
              (SELECT count(*)::int FROM asset WHERE source_generation_job_id = job.id) AS assets,
              (SELECT count(*)::int FROM cost_ledger WHERE generation_job_id = job.id) AS costs,
              (SELECT count(*)::int FROM domain_event WHERE aggregate_id = job.id AND event_type = 'job.succeeded') AS succeeded,
              (SELECT count(*)::int FROM domain_event WHERE aggregate_id = job.id AND event_type = 'job.failed') AS failed
         FROM generation_job job WHERE job.id = $1`, [job.jobId])).rows[0]!;
    try {
      await expect(runMockAvJob({ workspaceId: world.workspaceId, projectId: world.projectId,
        shotRevisionId: world.shotRevisionId, jobId: job.jobId, dispatchSeq: job.dispatchSeq,
        providerConfigurationId: world.providers.MEDIA_VIDEO, inputHash: row?.input_hash as string,
        inputSnapshot: row?.input_snapshot, traceId: "strict-probe", capability: "video.generate" },
      { jobs: faultyJobs, assets: faultyAssets, adapter, objects })).rejects.toMatchObject({ code: "57014" });
      const afterRun = await ledger();
      expect(afterRun).toMatchObject({ state: "RUNNING", attempts: 1, assets: 0, costs: 0, succeeded: 0, failed: 0 });
      const requestId = afterRun.requests[0];
      expect(requestId).toMatch(/^mock-media\|sync\|video\.generate\|/);

      await sql("UPDATE generation_job SET lease_until = now() - interval '1 second' WHERE id = $1", [job.jobId]);
      const recovery = new MockMediaRecovery(faultyJobs, faultyAssets, store, adapter, objects,
        { mockImageEnabled: false, mockAvEnabled: true });
      await expect(recovery.reconcileOnce()).rejects.toBeInstanceOf(AggregateError);
      expect(await ledger()).toMatchObject({ state: "RUNNING", attempts: 1, requests: [requestId], assets: 0, costs: 0, failed: 0 });

      // The probe now answers: these migrations have no reference structure, so the frozen input cannot complete.
      fault.on = false;
      await recovery.reconcileOnce();
      expect(await ledger()).toMatchObject({ state: "FAILED", error_code: "CHARACTER_REFERENCE_STORAGE_UNAVAILABLE",
        attempts: 1, requests: [requestId], assets: 0, costs: 0, succeeded: 0, failed: 1 });
      await recovery.reconcileOnce();
      expect(await ledger()).toMatchObject({ state: "FAILED", attempts: 1, failed: 1 });
      expect(submits).toBe(1);
    } finally {
      await rm(objectDir, { recursive: true, force: true });
    }
  });
});

/** Polls until a backend waits on a lock for exactly this statement text. No fixed sleep. */
async function waitForLockWaiter(statement: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const waiting = await sql<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query = $1`, [statement]);
    if ((waiting.rows[0]?.count ?? 0) > 0) return;
    if (Date.now() > deadline) throw new Error("no backend waited on the project lock");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * A pool whose next statement matching the pattern stops until released, inside its transaction and with every lock
 * the transaction already holds. `reached` resolves when the statement is about to run.
 */
function barrierPool(pattern: RegExp) {
  let notify!: () => void;
  const reached = new Promise<void>((resolve) => { notify = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let armed = true;
  const wrapped = {
    connect: async () => {
      const client = await pool.connect();
      const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      (client as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = async (...args: unknown[]) => {
        const text = typeof args[0] === "string" ? args[0] : "";
        if (armed && pattern.test(text)) {
          armed = false;
          notify();
          await released;
        }
        return query(...args);
      };
      const originalRelease = client.release.bind(client);
      client.release = (...releaseArgs: Parameters<typeof originalRelease>) => {
        (client as unknown as { query: unknown }).query = query;
        client.release = originalRelease;
        return originalRelease(...releaseArgs);
      };
      return client;
    },
  };
  return { pool: wrapped, reached, release: () => release() };
}

const PROJECT_LOCK = "SELECT id FROM project WHERE id = $1 AND workspace_id = $2 FOR UPDATE";

describe("a reference selection and a video completion in the same project are serialized", () => {
  it("makes the selection wait while a video completion holds the project lock", async () => {
    const world = await seedApprovedShot();
    const objectDir = await mkdtemp(join(tmpdir(), "lock-order-"));
    const characterId = (await sql<{ id: string }>(
      "INSERT INTO character (workspace_id, project_id, name) VALUES ($1, $2, 'lin') RETURNING id",
      [world.workspaceId, world.projectId])).rows[0]!.id;
    // Stop the completion right before it inserts the video asset: it already holds the project lock from the gate.
    const barrier = barrierPool(/^\s*INSERT INTO asset\s/);
    const job = await createMediaJob(world, "MEDIA_VIDEO", snapshotFor("MEDIA_VIDEO", world.shotRevisionId, "lock-order"));
    const row = await jobRow(job.jobId);
    try {
      const completion = runMockAvJob({ workspaceId: world.workspaceId, projectId: world.projectId,
        shotRevisionId: world.shotRevisionId, jobId: job.jobId, dispatchSeq: job.dispatchSeq,
        providerConfigurationId: world.providers.MEDIA_VIDEO, inputHash: row?.input_hash as string,
        inputSnapshot: row?.input_snapshot, traceId: "lock-order", capability: "video.generate" },
      { jobs: new JobPersistenceService(barrier.pool), assets: new MediaAssetStore(barrier.pool), adapter,
        objects: new LocalMockObjects(objectDir) });
      await barrier.reached;
      const references = new CharacterReferenceStore(pool);
      let selectionSettled = false;
      const selection = references.transaction((client) => references.selectInTransaction(client, {
        workspaceId: world.workspaceId, characterId, assetId: randomUUID(), expectedSelectedAssetId: null,
        selectedBy: "owner", traceId: "lock-order" })).finally(() => { selectionSettled = true; });
      selection.catch(() => undefined);
      await waitForLockWaiter(PROJECT_LOCK);
      expect(selectionSettled).toBe(false);
      barrier.release();
      expect(await completion).not.toBeNull();
      expect((await jobRow(job.jobId))?.state).toBe("SUCCEEDED");
      await expect(selection).rejects.toMatchObject({ code: "CHARACTER_REFERENCE_STORAGE_UNAVAILABLE" });
    } finally {
      barrier.release();
      await rm(objectDir, { recursive: true, force: true });
    }
  });
});

/**
 * The full race needs the reference draft (selection table, reference columns, IMAGE approval). These cases run only
 * on an isolated database where that SQL was explicitly authorized; CI does not set the variable. Written, not run.
 */
describe.runIf(process.env.CHARACTER_REFERENCE_DRAFT_SQL_AUTHORIZED === "true")(
  "strict video completion against reference replacement on the authorized draft",
  () => {
    beforeAll(async () => {
      const { readFile } = await import("node:fs/promises");
      const draft = await readFile(join(__dirname, "..", "..", "..", "..", "packages", "database", "prisma", "drafts",
        "20261005000200_character_reference_image.sql"), "utf8");
      await sql(draft);
    });

    const SHOT_PROJECT_LOCK = "SELECT id FROM project WHERE id = $1 AND workspace_id = $2%FOR UPDATE%";

    async function waitForLockWaiterLike(pattern: string): Promise<void> {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = await sql<{ count: number }>(
          `SELECT count(*)::int AS count FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`, [pattern]);
        if ((waiting.rows[0]?.count ?? 0) > 0) return;
        if (Date.now() > deadline) throw new Error(`no backend waited on a lock for ${pattern}`);
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    /** An approved current character referenced by the shot, two approved references A and B, and A selected. */
    async function strictWorld() {
      const world = await seedApprovedShot();
      const hash = "ab".repeat(32);
      const characterId = await insertId(
        "INSERT INTO character (workspace_id, project_id, name) VALUES ($1, $2, 'lin') RETURNING id",
        [world.workspaceId, world.projectId]);
      const revisionId = await insertId(
        `INSERT INTO character_revision (workspace_id, project_id, character_id, revision_no, content_json, content_hash,
           review_status, reviewed_by, reviewed_at, reviewed_content_hash, created_by)
         VALUES ($1, $2, $3, 1, '{}'::jsonb, $4, 'APPROVED', 'test', now(), $4, 'test') RETURNING id`,
        [world.workspaceId, world.projectId, characterId, hash]);
      await sql("UPDATE character SET current_revision_id = $1, approved_revision_id = $1 WHERE id = $2", [revisionId, characterId]);
      await sql(`INSERT INTO shot_character_reference (workspace_id, project_id, shot_revision_id, character_revision_id, role)
        VALUES ($1, $2, $3, $4, 'lead')`, [world.workspaceId, world.projectId, world.shotRevisionId, revisionId]);
      const references = new CharacterReferenceStore(pool);
      const reference = async (key: string) => {
        const assetId = await insertId(
          `INSERT INTO asset (workspace_id, project_id, kind, storage_provider, object_key, mime_type, byte_size,
             checksum_sha256, source_kind, reference_role, source_character_revision_id)
           VALUES ($1, $2, 'IMAGE', 'mock-object-store', $3, 'image/png', 1, $4, 'UPLOAD', 'character_reference', $5)
           RETURNING id`, [world.workspaceId, world.projectId, key, hash, revisionId]);
        await references.transaction((client) => references.reviewInTransaction(client, { workspaceId: world.workspaceId,
          assetId, reviewedBy: "test", traceId: "t", decision: "APPROVED", expectedRowVersion: 1, contentHash: hash, note: null }));
        return assetId;
      };
      const a = await reference(`refs/${characterId}-a.png`);
      const b = await reference(`refs/${characterId}-b.png`);
      await references.transaction((client) => references.selectInTransaction(client, { workspaceId: world.workspaceId,
        characterId, assetId: a, expectedSelectedAssetId: null, selectedBy: "test", traceId: "t" }));
      const frozen = await references.transaction((client) =>
        references.strictVideoReferencesInTransaction(client, world.workspaceId, world.projectId, world.shotRevisionId));
      expect(frozen.map((item) => item.assetId)).toEqual([a]);
      return { world, characterId, a, b, frozen, references };
    }

    async function strictJob(world: World, frozen: unknown[], seed: string) {
      const job = await createMediaJob(world, "MEDIA_VIDEO",
        { ...snapshotFor("MEDIA_VIDEO", world.shotRevisionId, seed), characterReferences: frozen });
      const row = await jobRow(job.jobId);
      return { job, input: { workspaceId: world.workspaceId, projectId: world.projectId, shotRevisionId: world.shotRevisionId,
        jobId: job.jobId, dispatchSeq: job.dispatchSeq, providerConfigurationId: world.providers.MEDIA_VIDEO,
        inputHash: row?.input_hash as string, inputSnapshot: row?.input_snapshot, traceId: seed, capability: "video.generate" as const } };
    }

    async function jobLedger(jobId: string) {
      return (await sql<{ state: string; error_code: string | null; assets: number; costs: number; succeeded: number }>(
        `SELECT job.state, job.error_code,
                (SELECT count(*)::int FROM asset WHERE source_generation_job_id = job.id) AS assets,
                (SELECT count(*)::int FROM cost_ledger WHERE generation_job_id = job.id) AS costs,
                (SELECT count(*)::int FROM domain_event WHERE aggregate_id = job.id AND event_type = 'job.succeeded') AS succeeded
           FROM generation_job job WHERE job.id = $1`, [jobId])).rows[0]!;
    }

    it("video completes first, then A -> B: the video becomes STALE once and the references stay ACTIVE", async () => {
      const { world, characterId, a, b, frozen, references } = await strictWorld();
      const objectDir = await mkdtemp(join(tmpdir(), "race-video-first-"));
      const barrier = barrierPool(/^\s*INSERT INTO asset_dependency/);
      const { input } = await strictJob(world, frozen, "video-first");
      try {
        const completion = runMockAvJob(input, { jobs: new JobPersistenceService(barrier.pool),
          assets: new MediaAssetStore(barrier.pool), adapter, objects: new LocalMockObjects(objectDir) });
        await barrier.reached;
        let replaced = false;
        const replacement = references.transaction((client) => references.selectInTransaction(client, {
          workspaceId: world.workspaceId, characterId, assetId: b, expectedSelectedAssetId: a, selectedBy: "test",
          traceId: "replace" })).finally(() => { replaced = true; });
        replacement.catch(() => undefined);
        await waitForLockWaiter(PROJECT_LOCK);
        expect(replaced).toBe(false);
        barrier.release();
        const video = await completion;
        expect(video).not.toBeNull();
        const result = await replacement;
        expect(result.staleAssetIds).toContain(video!.id);
        const status = await sql<{ id: string; status: string }>("SELECT id, status FROM asset WHERE id = ANY($1::uuid[])",
          [[video!.id, a, b]]);
        expect(Object.fromEntries(status.rows.map((row) => [row.id, row.status])))
          .toMatchObject({ [video!.id]: "STALE", [a]: "ACTIVE", [b]: "ACTIVE" });
        // Replacing again does not write a second stale event for assets that are already STALE.
        await references.transaction((client) => references.selectInTransaction(client, { workspaceId: world.workspaceId,
          characterId, assetId: a, expectedSelectedAssetId: b, selectedBy: "test", traceId: "back" }));
        await references.transaction((client) => references.selectInTransaction(client, { workspaceId: world.workspaceId,
          characterId, assetId: b, expectedSelectedAssetId: a, selectedBy: "test", traceId: "again" }));
        const events = await sql<{ count: number }>(
          "SELECT count(*)::int AS count FROM domain_event WHERE event_type = 'asset.stale' AND aggregate_id = $1", [video!.id]);
        expect(events.rows[0]?.count).toBe(1);
      } finally {
        barrier.release();
        await rm(objectDir, { recursive: true, force: true });
      }
    });

    it("A -> B commits first: the video frozen on A is refused with no asset, cost or success event", async () => {
      const { world, characterId, a, b, frozen } = await strictWorld();
      const objectDir = await mkdtemp(join(tmpdir(), "race-selection-first-"));
      const barrier = barrierPool(/WITH RECURSIVE affected/);
      const blocked = new CharacterReferenceStore(barrier.pool);
      const { job, input } = await strictJob(world, frozen, "selection-first");
      try {
        const replacement = blocked.transaction((client) => blocked.selectInTransaction(client, {
          workspaceId: world.workspaceId, characterId, assetId: b, expectedSelectedAssetId: a, selectedBy: "test",
          traceId: "replace" }));
        await barrier.reached;
        const completion = runMockAvJob(input, { jobs, assets, adapter, objects: new LocalMockObjects(objectDir) });
        await waitForLockWaiterLike(SHOT_PROJECT_LOCK);
        barrier.release();
        await replacement;
        expect(await completion).toBeNull();
        expect(await jobLedger(job.jobId)).toMatchObject({ state: "FAILED", error_code: "CHARACTER_REFERENCE_REQUIRED",
          assets: 0, costs: 0, succeeded: 0 });
      } finally {
        barrier.release();
        await rm(objectDir, { recursive: true, force: true });
      }
    });

    it("recovers a strict video after a transient probe failure without a second asset or cost", async () => {
      const { world, frozen } = await strictWorld();
      const objectDir = await mkdtemp(join(tmpdir(), "probe-heal-"));
      const objects = new LocalMockObjects(objectDir);
      const fault = { on: true };
      const faultyPool = {
        connect: async () => {
          const client = await pool.connect();
          const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
          (client as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = (...args: unknown[]) => {
            const text = typeof args[0] === "string" ? args[0] : "";
            if (fault.on && text.includes("information_schema.columns")) {
              return Promise.reject(Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }));
            }
            return query(...args);
          };
          const release = client.release.bind(client);
          client.release = (...releaseArgs: Parameters<typeof release>) => {
            (client as unknown as { query: unknown }).query = query;
            client.release = release;
            return release(...releaseArgs);
          };
          return client;
        },
      };
      const faultyJobs = new JobPersistenceService(faultyPool);
      const faultyAssets = new MediaAssetStore(faultyPool);
      const { job, input } = await strictJob(world, frozen, "probe-heal");
      const adapterWithCount = new MockMediaAdapter();
      let submits = 0;
      const submit = adapterWithCount.submit.bind(adapterWithCount);
      adapterWithCount.submit = async (request) => { submits += 1; return submit(request); };
      try {
        await expect(runMockAvJob(input, { jobs: faultyJobs, assets: faultyAssets, adapter: adapterWithCount, objects }))
          .rejects.toMatchObject({ code: "57014" });
        await sql("UPDATE generation_job SET lease_until = now() - interval '1 second' WHERE id = $1", [job.jobId]);
        fault.on = false;
        await new MockMediaRecovery(faultyJobs, faultyAssets, store, adapterWithCount, objects,
          { mockImageEnabled: false, mockAvEnabled: true }).reconcileOnce();
        expect(await jobLedger(job.jobId)).toMatchObject({ state: "SUCCEEDED", assets: 1, costs: 1, succeeded: 1 });
        expect(submits).toBe(1);
      } finally {
        await rm(objectDir, { recursive: true, force: true });
      }
    });
  },
);
