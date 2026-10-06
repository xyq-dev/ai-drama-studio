import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  JobPersistenceService,
  MediaAssetStore,
  RuntimeStore,
  closePostgresPool,
  createPostgresPool,
  mockMediaRetryLineage,
  requestHash,
  runMigrations,
  type IdempotencyScope,
  type MockMediaRetryFlags,
  type PostgresPool,
} from "@ai-drama/database";
import { MockMediaAdapter } from "@ai-drama/providers";
import { LocalMockObjects } from "./local-mock-objects";
import { runMockAvJob } from "./mock-av-generation";
import { runMockImageJob } from "./mock-image-generation";
import { runMockSmJob } from "./mock-sm-generation";

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
