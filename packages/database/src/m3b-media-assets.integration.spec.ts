import { Pool, type QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MediaAssetStore } from "./media-assets";
import { JobPersistenceService } from "./job-service";
import { runMigrations } from "./migrations";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for PostgreSQL integration tests");

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const store = new MediaAssetStore(pool);
const jobs = new JobPersistenceService(pool);
const hash = "ab".repeat(32);

beforeAll(async () => {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await runMigrations(pool);
});

beforeEach(async () => {
  await pool.query(`
    TRUNCATE TABLE
      asset,
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
      shot_character_reference,
      shot_revision,
      shot,
      scene_revision,
      scene,
      location_revision_script_source,
      location_revision,
      location,
      character_revision_script_source,
      character_revision,
      character,
      script_revision_replacement,
      script_source_dependency,
      script_revision,
      episode,
      story_revision,
      stale_recalculation,
      project,
      workspace
    RESTART IDENTITY CASCADE
  `);
});

afterAll(async () => {
  await pool.end();
});

async function seedApprovedShot() {
  const workspace = await pool.query<{ id: string } & QueryResultRow>(
    "INSERT INTO workspace (name) VALUES ('m3b') RETURNING id",
  );
  const workspaceId = workspace.rows[0]?.id;
  if (!workspaceId) throw new Error("workspace missing");

  const project = await pool.query<{ id: string } & QueryResultRow>(
    "INSERT INTO project (workspace_id, title) VALUES ($1, 'm3b') RETURNING id",
    [workspaceId],
  );
  const projectId = project.rows[0]?.id;
  if (!projectId) throw new Error("project missing");

  const story = await pool.query<{ id: string } & QueryResultRow>(
    `INSERT INTO story_revision
      (workspace_id, project_id, revision_no, content_json, content_hash, created_by)
     VALUES ($1,$2,1,'{}'::jsonb,$3,'test')
     RETURNING id`,
    [workspaceId, projectId, hash],
  );
  const storyRevisionId = story.rows[0]?.id;
  if (!storyRevisionId) throw new Error("story missing");

  await pool.query(
    `UPDATE story_revision
        SET review_status = 'APPROVED',
            reviewed_by = 'editor',
            reviewed_at = now(),
            reviewed_content_hash = content_hash
      WHERE id = $1`,
    [storyRevisionId],
  );
  await pool.query(
    `UPDATE project
        SET current_story_revision_id = $1,
            approved_story_revision_id = $1
      WHERE id = $2`,
    [storyRevisionId, projectId],
  );

  const episode = await pool.query<{ id: string } & QueryResultRow>(
    `INSERT INTO episode (workspace_id, project_id, episode_no, title)
     VALUES ($1,$2,1,'Episode 1') RETURNING id`,
    [workspaceId, projectId],
  );
  const episodeId = episode.rows[0]?.id;
  if (!episodeId) throw new Error("episode missing");

  const script = await pool.query<{ id: string } & QueryResultRow>(
    `INSERT INTO script_revision
      (workspace_id, project_id, episode_id, revision_no, source_story_revision_id,
       content_json, content_hash, created_by)
     VALUES ($1,$2,$3,1,$4,'{}'::jsonb,$5,'test')
     RETURNING id`,
    [workspaceId, projectId, episodeId, storyRevisionId, hash],
  );
  const scriptRevisionId = script.rows[0]?.id;
  if (!scriptRevisionId) throw new Error("script missing");

  await pool.query(
    `UPDATE script_revision
        SET review_status = 'APPROVED',
            reviewed_by = 'editor',
            reviewed_at = now(),
            reviewed_content_hash = content_hash
      WHERE id = $1`,
    [scriptRevisionId],
  );
  await pool.query(
    `UPDATE episode
        SET current_script_revision_id = $1,
            approved_script_revision_id = $1
      WHERE id = $2`,
    [scriptRevisionId, episodeId],
  );

  const scene = await pool.query<{ id: string } & QueryResultRow>(
    `INSERT INTO scene (workspace_id, project_id, episode_id)
     VALUES ($1,$2,$3) RETURNING id`,
    [workspaceId, projectId, episodeId],
  );
  const sceneId = scene.rows[0]?.id;
  if (!sceneId) throw new Error("scene missing");

  const sceneRevision = await pool.query<{ id: string } & QueryResultRow>(
    `INSERT INTO scene_revision
      (workspace_id, project_id, episode_id, scene_id, revision_no,
       source_script_revision_id, ordinal, heading, summary, content_hash,
       review_status, reviewed_by, reviewed_at, reviewed_content_hash, created_by)
     VALUES ($1,$2,$3,$4,1,$5,1,'INT. ROOM','room',$6,
             'APPROVED','editor',now(),$6,'test')
     RETURNING id`,
    [workspaceId, projectId, episodeId, sceneId, scriptRevisionId, hash],
  );
  const sceneRevisionId = sceneRevision.rows[0]?.id;
  if (!sceneRevisionId) throw new Error("scene revision missing");

  await pool.query(
    `UPDATE scene
        SET current_revision_id = $1,
            approved_revision_id = $1
      WHERE id = $2`,
    [sceneRevisionId, sceneId],
  );

  const shot = await pool.query<{ id: string } & QueryResultRow>(
    `INSERT INTO shot (workspace_id, project_id, episode_id, scene_id)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [workspaceId, projectId, episodeId, sceneId],
  );
  const shotId = shot.rows[0]?.id;
  if (!shotId) throw new Error("shot missing");

  const shotRevision = await pool.query<{ id: string } & QueryResultRow>(
    `INSERT INTO shot_revision
      (workspace_id, project_id, scene_id, shot_id, revision_no,
       source_scene_revision_id, ordinal, shot_type, camera, action,
       prompt_text, content_hash, review_status, reviewed_by, reviewed_at,
       reviewed_content_hash, created_by)
     VALUES ($1,$2,$3,$4,1,$5,1,'close','static','look',
             'prompt',$6,'APPROVED','editor',now(),$6,'test')
     RETURNING id`,
    [workspaceId, projectId, sceneId, shotId, sceneRevisionId, hash],
  );
  const shotRevisionId = shotRevision.rows[0]?.id;
  if (!shotRevisionId) throw new Error("shot revision missing");

  await pool.query(
    `UPDATE shot
        SET current_revision_id = $1,
            approved_revision_id = $1
      WHERE id = $2`,
    [shotRevisionId, shotId],
  );

  const provider = await pool.query<{ id: string } & QueryResultRow>(
    `INSERT INTO provider_configuration
      (workspace_id, provider_key, capability, default_timeout_ms)
     VALUES ($1,'mock-media','image.generate',30000)
     RETURNING id`,
    [workspaceId],
  );
  const providerConfigurationId = provider.rows[0]?.id;
  if (!providerConfigurationId) throw new Error("provider missing");

  const workflow = await pool.query<{ id: string } & QueryResultRow>(
    `INSERT INTO workflow_run
      (workspace_id, project_id, type, requested_by, input_snapshot)
     VALUES ($1,$2,'MEDIA_IMAGE','test','{}'::jsonb)
     RETURNING id`,
    [workspaceId, projectId],
  );
  const workflowRunId = workflow.rows[0]?.id;
  if (!workflowRunId) throw new Error("workflow missing");

  const job = await pool.query<{ id: string } & QueryResultRow>(
    `INSERT INTO generation_job
      (workspace_id, project_id, workflow_run_id, source_shot_revision_id, kind, input_hash, input_snapshot)
     VALUES ($1,$2,$3,$4,'MEDIA_IMAGE',$5,'{}'::jsonb)
     RETURNING id`,
    [workspaceId, projectId, workflowRunId, shotRevisionId, hash],
  );
  const generationJobId = job.rows[0]?.id;
  if (!generationJobId) throw new Error("job missing");

  const providerRequestId = "mock-media|image.generate|shot";
  const attempt = await pool.query<{ id: string } & QueryResultRow>(
    `INSERT INTO job_attempt
      (workspace_id, generation_job_id, attempt_no, provider_configuration_id,
       provider_request_id, provider_client_request_key, request_snapshot)
     VALUES ($1,$2,1,$3,$4,'m3b-shot','{}'::jsonb)
     RETURNING id`,
    [workspaceId, generationJobId, providerConfigurationId, providerRequestId],
  );
  const jobAttemptId = attempt.rows[0]?.id;
  if (!jobAttemptId) throw new Error("attempt missing");

  return {
    workspaceId,
    projectId,
    shotRevisionId,
    providerConfigurationId,
    providerRequestId,
    generationJobId,
    jobAttemptId,
  };
}

describe("M3-B media asset store", () => {
  it("commits the approved-shot Asset, attempt, job and workflow together", async () => {
    const seeded = await seedApprovedShot();
    await pool.query(
      "UPDATE generation_job SET state = 'RUNNING' WHERE id = $1", [seeded.generationJobId],
    );
    const asset = await store.completeAttemptWithAsset(jobs, {
      workspaceId: seeded.workspaceId,
      projectId: seeded.projectId,
      generationJobId: seeded.generationJobId,
      traceId: "mock-media-success",
      kind: "IMAGE",
      storageProvider: "minio",
      objectKey: "shots/atomic-frame.png",
      mimeType: "image/png",
      byteSize: 1,
      checksumSha256: hash,
      width: 1,
      height: 1,
      sourceJobAttemptId: seeded.jobAttemptId,
      sourceShotRevisionId: seeded.shotRevisionId,
      providerConfigurationId: seeded.providerConfigurationId,
      providerRequestId: seeded.providerRequestId,
    });
    expect(asset?.id).toBeTruthy();
    const result = await pool.query<{
      state: string; status: string; finished_at: Date | null; output_ids: string[];
    } & QueryResultRow>(
      `SELECT job.state, workflow.status, attempt.finished_at,
              ARRAY(SELECT jsonb_array_elements_text(attempt.response_snapshot->'outputAssetIds')) AS output_ids
         FROM generation_job job
         JOIN workflow_run workflow ON workflow.id = job.workflow_run_id
         JOIN job_attempt attempt ON attempt.generation_job_id = job.id
        WHERE job.id = $1`, [seeded.generationJobId],
    );
    expect(result.rows[0]).toMatchObject({ state: "SUCCEEDED", status: "SUCCEEDED", output_ids: [asset?.id] });
    expect(result.rows[0]?.finished_at).toBeTruthy();
  });

  it("rolls back Asset insertion if job completion fails", async () => {
    const seeded = await seedApprovedShot();
    await expect(store.completeAttemptWithAsset(jobs, {
      workspaceId: seeded.workspaceId,
      projectId: seeded.projectId,
      generationJobId: seeded.generationJobId,
      traceId: "mock-media-invalid-state",
      kind: "IMAGE",
      storageProvider: "minio",
      objectKey: "shots/should-not-exist.png",
      mimeType: "image/png",
      byteSize: 1,
      checksumSha256: hash,
      sourceJobAttemptId: seeded.jobAttemptId,
      sourceShotRevisionId: seeded.shotRevisionId,
      providerConfigurationId: seeded.providerConfigurationId,
      providerRequestId: seeded.providerRequestId,
    })).rejects.toThrow(/Cannot succeed job from PENDING/);
    const count = await pool.query<{ count: number } & QueryResultRow>(
      "SELECT count(*)::int AS count FROM asset WHERE object_key = 'shots/should-not-exist.png'",
    );
    expect(count.rows[0]?.count).toBe(0);
  });

  it("does not create an Asset after cancellation was requested", async () => {
    const seeded = await seedApprovedShot();
    await pool.query(
      "UPDATE generation_job SET state = 'RUNNING', cancel_requested_at = now() WHERE id = $1",
      [seeded.generationJobId],
    );
    const asset = await store.completeAttemptWithAsset(jobs, {
      workspaceId: seeded.workspaceId,
      projectId: seeded.projectId,
      generationJobId: seeded.generationJobId,
      traceId: "mock-media-canceled",
      kind: "IMAGE",
      storageProvider: "minio",
      objectKey: "shots/canceled.png",
      mimeType: "image/png",
      byteSize: 1,
      checksumSha256: hash,
      sourceJobAttemptId: seeded.jobAttemptId,
      sourceShotRevisionId: seeded.shotRevisionId,
      providerConfigurationId: seeded.providerConfigurationId,
      providerRequestId: seeded.providerRequestId,
    });
    expect(asset).toBeNull();
    const count = await pool.query<{ count: number } & QueryResultRow>(
      "SELECT count(*)::int AS count FROM asset WHERE object_key = 'shots/canceled.png'",
    );
    expect(count.rows[0]?.count).toBe(0);
  });

  it("accepts approved current shots and replays an identical asset safely", async () => {
    const seeded = await seedApprovedShot();
    const input = {
      workspaceId: seeded.workspaceId,
      projectId: seeded.projectId,
      kind: "IMAGE" as const,
      storageProvider: "minio",
      objectKey: "shots/frame-1.png",
      mimeType: "image/png",
      byteSize: 1,
      checksumSha256: hash,
      width: 1024,
      height: 1792,
      sourceJobAttemptId: seeded.jobAttemptId,
      sourceShotRevisionId: seeded.shotRevisionId,
      providerConfigurationId: seeded.providerConfigurationId,
      providerRequestId: seeded.providerRequestId,
      metadata: { source: "mock" },
    };

    const first = await store.createAsset(input);
    const replay = await store.createAsset(input);
    expect(replay).toEqual(first);

    const lineage = await pool.query<{ source_generation_job_id: string } & QueryResultRow>(
      "SELECT source_generation_job_id FROM asset WHERE id = $1",
      [first.id],
    );
    expect(lineage.rows[0]?.source_generation_job_id).toBe(seeded.generationJobId);

    const dependencies = await pool.query<{
      shot_revision_id: string | null;
      scene_revision_id: string | null;
      script_revision_id: string | null;
    } & QueryResultRow>(
      `SELECT shot_revision_id, scene_revision_id, script_revision_id
         FROM asset_revision_dependency WHERE dependent_asset_id = $1`,
      [first.id],
    );
    const source = await pool.query<{
      source_scene_revision_id: string;
      source_script_revision_id: string;
    } & QueryResultRow>(
      `SELECT shot.source_scene_revision_id, scene.source_script_revision_id
         FROM shot_revision shot JOIN scene_revision scene
           ON scene.id = shot.source_scene_revision_id WHERE shot.id = $1`,
      [seeded.shotRevisionId],
    );
    expect(dependencies.rows).toHaveLength(3);
    expect(dependencies.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ shot_revision_id: seeded.shotRevisionId }),
      expect.objectContaining({ scene_revision_id: source.rows[0]?.source_scene_revision_id }),
      expect.objectContaining({ script_revision_id: source.rows[0]?.source_script_revision_id }),
    ]));

    const listed = await store.listShotAssets(
      seeded.workspaceId,
      seeded.projectId,
      seeded.shotRevisionId,
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(first.id);
  });

  it("blocks asset creation while project stale recalculation is pending", async () => {
    const seeded = await seedApprovedShot();
    await pool.query(
      `INSERT INTO stale_recalculation
        (workspace_id, project_id, stale_from_ref, reason, status)
       VALUES ($1, $2, 'story_revision:11111111-1111-4111-8111-111111111111',
               'SOURCE_STORY_REPLACED', 'PENDING')`,
      [seeded.workspaceId, seeded.projectId],
    );

    await expect(
      store.createAsset({
        workspaceId: seeded.workspaceId,
        projectId: seeded.projectId,
        kind: "IMAGE",
        storageProvider: "minio",
        objectKey: "shots/pending-stale.png",
        mimeType: "image/png",
        byteSize: 1,
        checksumSha256: hash,
        sourceJobAttemptId: seeded.jobAttemptId,
        sourceShotRevisionId: seeded.shotRevisionId,
        providerConfigurationId: seeded.providerConfigurationId,
        providerRequestId: seeded.providerRequestId,
      }),
    ).rejects.toMatchObject({ code: "STALE_RECALCULATION_PENDING" });
  });

  it("rejects a shot after it becomes stale", async () => {
    const seeded = await seedApprovedShot();
    await pool.query(
      `UPDATE shot_revision
          SET freshness_status = 'STALE',
              stale_reason = 'TEST',
              stale_from_ref = 'script_revision:11111111-1111-4111-8111-111111111111',
              review_version = review_version + 1
        WHERE id = $1`,
      [seeded.shotRevisionId],
    );

    await expect(
      store.createAsset({
        workspaceId: seeded.workspaceId,
        projectId: seeded.projectId,
        kind: "IMAGE",
        storageProvider: "minio",
        objectKey: "shots/stale.png",
        mimeType: "image/png",
        byteSize: 1,
        checksumSha256: hash,
        sourceJobAttemptId: seeded.jobAttemptId,
        sourceShotRevisionId: seeded.shotRevisionId,
        providerConfigurationId: seeded.providerConfigurationId,
        providerRequestId: seeded.providerRequestId,
      }),
    ).rejects.toMatchObject({ code: "REVIEW_REQUIRED" });
  });

  it("allows an image preview before shot approval and still blocks video", async () => {
    const seeded = await seedApprovedShot();
    await pool.query(
      `UPDATE shot SET approved_revision_id = NULL
        WHERE id = (SELECT shot_id FROM shot_revision WHERE id = $1)`,
      [seeded.shotRevisionId],
    );
    await pool.query(`UPDATE shot_revision SET review_status = 'DRAFT' WHERE id = $1`, [seeded.shotRevisionId]);
    await pool.query(
      `INSERT INTO provider_configuration
        (workspace_id, provider_key, capability, default_timeout_ms)
       VALUES ($1,'mock-media','video.generate',30000)`,
      [seeded.workspaceId],
    );
    const client = await pool.connect();
    try {
      await expect(store.prepareShotGenerationInTransaction(
        client, seeded.workspaceId, seeded.shotRevisionId, "image.generate",
      )).resolves.toMatchObject({ projectId: seeded.projectId });
      await expect(store.prepareShotGenerationInTransaction(
        client, seeded.workspaceId, seeded.shotRevisionId, "video.generate",
      )).rejects.toMatchObject({ code: "REVIEW_REQUIRED" });
    } finally {
      client.release();
    }
  });

  it("rejects asset lineage from a different project in the same workspace", async () => {
    const seeded = await seedApprovedShot();

    const otherProject = await pool.query<{ id: string } & QueryResultRow>(
      "INSERT INTO project (workspace_id, title) VALUES ($1, 'other-project') RETURNING id",
      [seeded.workspaceId],
    );
    const otherProjectId = otherProject.rows[0]?.id;
    if (!otherProjectId) throw new Error("other project missing");

    const otherWorkflow = await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO workflow_run
        (workspace_id, project_id, type, requested_by, input_snapshot)
       VALUES ($1,$2,'MEDIA_IMAGE','test','{}'::jsonb)
       RETURNING id`,
      [seeded.workspaceId, otherProjectId],
    );
    const otherWorkflowId = otherWorkflow.rows[0]?.id;
    if (!otherWorkflowId) throw new Error("other workflow missing");

    const otherJob = await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO generation_job
        (workspace_id, project_id, workflow_run_id, kind, input_hash, input_snapshot)
       VALUES ($1,$2,$3,'MEDIA_IMAGE',$4,'{}'::jsonb)
       RETURNING id`,
      [seeded.workspaceId, otherProjectId, otherWorkflowId, hash],
    );
    const otherJobId = otherJob.rows[0]?.id;
    if (!otherJobId) throw new Error("other job missing");

    const otherProviderRequestId = `${seeded.providerRequestId}|other-project`;
    const otherAttempt = await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO job_attempt
        (workspace_id, generation_job_id, attempt_no, provider_configuration_id,
         provider_request_id, provider_client_request_key, request_snapshot)
       VALUES ($1,$2,1,$3,$4,'m3b-cross-project','{}'::jsonb)
       RETURNING id`,
      [
        seeded.workspaceId,
        otherJobId,
        seeded.providerConfigurationId,
        otherProviderRequestId,
      ],
    );
    const otherAttemptId = otherAttempt.rows[0]?.id;
    if (!otherAttemptId) throw new Error("other attempt missing");

    await expect(
      store.createAsset({
        workspaceId: seeded.workspaceId,
        projectId: seeded.projectId,
        kind: "IMAGE",
        storageProvider: "minio",
        objectKey: "shots/cross-project.png",
        mimeType: "image/png",
        byteSize: 1,
        checksumSha256: hash,
        sourceJobAttemptId: otherAttemptId,
        sourceShotRevisionId: seeded.shotRevisionId,
        providerConfigurationId: seeded.providerConfigurationId,
        providerRequestId: otherProviderRequestId,
      }),
    ).rejects.toMatchObject({ code: "ASSET_LINEAGE_INVALID" });
  });

  it("rejects an attempt bound to a different approved shot in the same project", async () => {
    const seeded = await seedApprovedShot();

    const otherShot = await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO shot (workspace_id, project_id, episode_id, scene_id)
       SELECT workspace_id, project_id, episode_id, scene_id
         FROM shot
        WHERE id = (SELECT shot_id FROM shot_revision WHERE id = $1)
       RETURNING id`,
      [seeded.shotRevisionId],
    );
    const otherShotId = otherShot.rows[0]?.id;
    if (!otherShotId) throw new Error("other shot missing");

    const source = await pool.query<{ scene_id: string; source_scene_revision_id: string } & QueryResultRow>(
      "SELECT scene_id, source_scene_revision_id FROM shot_revision WHERE id = $1",
      [seeded.shotRevisionId],
    );
    const sceneId = source.rows[0]?.scene_id;
    const sourceSceneRevisionId = source.rows[0]?.source_scene_revision_id;
    if (!sceneId || !sourceSceneRevisionId) throw new Error("shot source missing");

    const otherRevision = await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO shot_revision
        (workspace_id, project_id, scene_id, shot_id, revision_no,
         source_scene_revision_id, ordinal, shot_type, camera, action,
         prompt_text, content_hash, review_status, reviewed_by, reviewed_at,
         reviewed_content_hash, created_by)
       VALUES ($1,$2,$3,$4,1,$5,2,'close','static','look',
               'other',$6,'APPROVED','editor',now(),$6,'test')
       RETURNING id`,
      [seeded.workspaceId, seeded.projectId, sceneId, otherShotId, sourceSceneRevisionId, hash],
    );
    const otherRevisionId = otherRevision.rows[0]?.id;
    if (!otherRevisionId) throw new Error("other shot revision missing");
    await pool.query(
      "UPDATE shot SET current_revision_id = $1, approved_revision_id = $1 WHERE id = $2",
      [otherRevisionId, otherShotId],
    );

    await expect(
      store.createAsset({
        workspaceId: seeded.workspaceId,
        projectId: seeded.projectId,
        kind: "IMAGE",
        storageProvider: "minio",
        objectKey: "shots/cross-shot.png",
        mimeType: "image/png",
        byteSize: 1,
        checksumSha256: hash,
        sourceJobAttemptId: seeded.jobAttemptId,
        sourceShotRevisionId: otherRevisionId,
        providerConfigurationId: seeded.providerConfigurationId,
        providerRequestId: seeded.providerRequestId,
      }),
    ).rejects.toMatchObject({ code: "ASSET_LINEAGE_INVALID" });
  });

  it("rejects a shot whose selected script dependency is not approved", async () => {
    const seeded = await seedApprovedShot();
    const source = await pool.query<{ script_revision_id: string; episode_id: string } & QueryResultRow>(
      `SELECT source.script_revision_id, script.episode_id
         FROM script_revision_consumer_source source
         JOIN script_revision script ON script.id = source.script_revision_id
        WHERE source.consumer_type = 'shot_revision'
          AND source.consumer_revision_id = $1
        LIMIT 1`,
      [seeded.shotRevisionId],
    );
    const sourceScriptId = source.rows[0]?.script_revision_id;
    const episodeId = source.rows[0]?.episode_id;
    if (!sourceScriptId || !episodeId) throw new Error("shot script source missing");

    const sourceStory = await pool.query<{ source_story_revision_id: string; revision_no: number } & QueryResultRow>(
      `SELECT source_story_revision_id, revision_no FROM script_revision WHERE id = $1`,
      [sourceScriptId],
    );
    const sourceStoryRevisionId = sourceStory.rows[0]?.source_story_revision_id;
    const sourceRevisionNo = sourceStory.rows[0]?.revision_no;
    if (!sourceStoryRevisionId || !sourceRevisionNo) throw new Error("source script data missing");

    const replacement = await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO script_revision
        (workspace_id, project_id, episode_id, revision_no, source_story_revision_id,
         content_json, content_hash, created_by)
       VALUES ($1,$2,$3,$4,$5,'{}'::jsonb,$6,'test')
       RETURNING id`,
      [
        seeded.workspaceId,
        seeded.projectId,
        episodeId,
        sourceRevisionNo + 1,
        sourceStoryRevisionId,
        hash,
      ],
    );
    const replacementId = replacement.rows[0]?.id;
    if (!replacementId) throw new Error("replacement script missing");

    await pool.query(
      `UPDATE episode SET current_script_revision_id = $1 WHERE id = $2`,
      [replacementId, episodeId],
    );

    await expect(
      store.createAsset({
        workspaceId: seeded.workspaceId,
        projectId: seeded.projectId,
        kind: "IMAGE",
        storageProvider: "minio",
        objectKey: "shots/unapproved-script.png",
        mimeType: "image/png",
        byteSize: 1,
        checksumSha256: hash,
        sourceJobAttemptId: seeded.jobAttemptId,
        sourceShotRevisionId: seeded.shotRevisionId,
        providerConfigurationId: seeded.providerConfigurationId,
        providerRequestId: seeded.providerRequestId,
      }),
    ).rejects.toMatchObject({ code: "REVIEW_REQUIRED" });
  });

  it("rejects an approved shot when its scene script source is stale", async () => {
    const seeded = await seedApprovedShot();
    await pool.query(
      `UPDATE script_revision SET freshness_status = 'STALE',
          stale_reason = 'TEST', stale_from_ref = 'story_revision:11111111-1111-4111-8111-111111111111'
        WHERE id = (
          SELECT scene_revision.source_script_revision_id
            FROM shot_revision JOIN scene_revision
              ON scene_revision.id = shot_revision.source_scene_revision_id
           WHERE shot_revision.id = $1
        )`,
      [seeded.shotRevisionId],
    );

    await expect(store.createAsset({
      workspaceId: seeded.workspaceId,
      projectId: seeded.projectId,
      kind: "IMAGE",
      storageProvider: "minio",
      objectKey: "shots/stale-scene-script.png",
      mimeType: "image/png",
      byteSize: 1,
      checksumSha256: hash,
      sourceJobAttemptId: seeded.jobAttemptId,
      sourceShotRevisionId: seeded.shotRevisionId,
      providerConfigurationId: seeded.providerConfigurationId,
      providerRequestId: seeded.providerRequestId,
    })).rejects.toMatchObject({ code: "REVIEW_REQUIRED" });
  });

  it("replays an existing asset after its source shot becomes stale", async () => {
    const seeded = await seedApprovedShot();
    const input = {
      workspaceId: seeded.workspaceId,
      projectId: seeded.projectId,
      kind: "IMAGE" as const,
      storageProvider: "minio",
      objectKey: "shots/stale-replay.png",
      mimeType: "image/png",
      byteSize: 1,
      checksumSha256: hash,
      width: 1024,
      height: 1792,
      sourceJobAttemptId: seeded.jobAttemptId,
      sourceShotRevisionId: seeded.shotRevisionId,
      providerConfigurationId: seeded.providerConfigurationId,
      providerRequestId: seeded.providerRequestId,
      metadata: { source: "mock" },
    };
    const first = await store.createAsset(input);

    await pool.query(
      `UPDATE shot_revision
          SET freshness_status = 'STALE',
              stale_reason = 'TEST_AFTER_COMMIT',
              stale_from_ref = 'script_revision:11111111-1111-4111-8111-111111111111',
              review_version = review_version + 1
        WHERE id = $1`,
      [seeded.shotRevisionId],
    );

    await expect(store.createAsset(input)).resolves.toEqual(first);
  });

  it("rejects conflicting replay content for the same storage object key", async () => {
    const seeded = await seedApprovedShot();
    const base = {
      workspaceId: seeded.workspaceId,
      projectId: seeded.projectId,
      kind: "IMAGE" as const,
      storageProvider: "minio",
      objectKey: "shots/conflict.png",
      mimeType: "image/png",
      byteSize: 1,
      checksumSha256: hash,
      sourceJobAttemptId: seeded.jobAttemptId,
      sourceShotRevisionId: seeded.shotRevisionId,
      providerConfigurationId: seeded.providerConfigurationId,
      providerRequestId: seeded.providerRequestId,
      metadata: { source: "mock", version: 1 },
    };
    await store.createAsset(base);
    await expect(
      store.createAsset({ ...base, checksumSha256: "cd".repeat(32) }),
    ).rejects.toMatchObject({ code: "ASSET_CONFLICT" });
    await expect(
      store.createAsset({ ...base, mimeType: "image/jpeg" }),
    ).rejects.toMatchObject({ code: "ASSET_CONFLICT" });
    await expect(
      store.createAsset({ ...base, byteSize: 2 }),
    ).rejects.toMatchObject({ code: "ASSET_CONFLICT" });
    await expect(
      store.createAsset({ ...base, metadata: { source: "mock", version: 2 } }),
    ).rejects.toMatchObject({ code: "ASSET_CONFLICT" });

    const secondProviderRequestId = `${seeded.providerRequestId}|second-attempt`;
    const secondAttempt = await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO job_attempt
        (workspace_id, generation_job_id, attempt_no, provider_configuration_id,
         provider_request_id, provider_client_request_key, request_snapshot)
       VALUES ($1,$2,2,$3,$4,'m3b-shot-second','{}'::jsonb)
       RETURNING id`,
      [
        seeded.workspaceId,
        seeded.generationJobId,
        seeded.providerConfigurationId,
        secondProviderRequestId,
      ],
    );
    const secondAttemptId = secondAttempt.rows[0]?.id;
    if (!secondAttemptId) throw new Error("second attempt missing");

    await expect(
      store.createAsset({
        ...base,
        sourceJobAttemptId: secondAttemptId,
        providerRequestId: secondProviderRequestId,
      }),
    ).rejects.toMatchObject({ code: "ASSET_CONFLICT" });
  });
});

async function bindFixedImage() {
  const seeded = await seedApprovedShot();
  const snapshot = {
    schema: "m3.mock.image.v1",
    shotRevisionId: seeded.shotRevisionId,
    seed: null,
    outcome: "success",
    bypassCache: false,
  };
  const providerRequestId = `mock-media|image.generate|${seeded.generationJobId}:1`;
  await pool.query(
    `UPDATE generation_job
        SET state = 'RUNNING', input_snapshot = $2::jsonb
      WHERE id = $1`,
    [seeded.generationJobId, JSON.stringify(snapshot)],
  );
  await pool.query(
    `UPDATE job_attempt
        SET provider_request_id = $2,
            provider_client_request_key = $3,
            request_snapshot = $4::jsonb
      WHERE id = $1`,
    [seeded.jobAttemptId, providerRequestId, `${seeded.generationJobId}:1`, JSON.stringify(snapshot)],
  );
  return { ...seeded, providerRequestId };
}

function fixedImageCost(bound: Awaited<ReturnType<typeof bindFixedImage>>, amount = "0.00000000") {
  return {
    workspaceId: bound.workspaceId,
    projectId: bound.projectId,
    generationJobId: bound.generationJobId,
    jobAttemptId: bound.jobAttemptId,
    providerConfigurationId: bound.providerConfigurationId,
    providerRequestId: bound.providerRequestId,
    idempotencyKey: `${bound.providerRequestId}:request:actual`,
    currency: "USD",
    amountDecimal: amount,
    kind: "ACTUAL",
    basis: "PROVIDER_REPORTED",
    unitType: "request",
    unitQuantity: "1",
    unitPriceSnapshot: "0",
    provider: "mock-media",
    model: "mock-v1",
  };
}

function fixedImageAsset(bound: Awaited<ReturnType<typeof bindFixedImage>>, objectKey: string) {
  return {
    workspaceId: bound.workspaceId,
    projectId: bound.projectId,
    generationJobId: bound.generationJobId,
    traceId: "mock-image-cost",
    kind: "IMAGE" as const,
    storageProvider: "mock-object-store",
    objectKey,
    mimeType: "image/png",
    byteSize: 1,
    checksumSha256: hash,
    width: 1,
    height: 1,
    sourceJobAttemptId: bound.jobAttemptId,
    sourceShotRevisionId: bound.shotRevisionId,
    providerConfigurationId: bound.providerConfigurationId,
    providerRequestId: bound.providerRequestId,
    actualCost: fixedImageCost(bound),
  };
}

async function ledgerSnapshot(generationJobId: string) {
  const costs = await pool.query<QueryResultRow>(
    `SELECT id, kind, amount_decimal::text AS amount_decimal, idempotency_key, model, supersedes_estimate_key
       FROM cost_ledger WHERE generation_job_id = $1 ORDER BY idempotency_key`,
    [generationJobId],
  );
  const assets = await pool.query<{ count: number } & QueryResultRow>(
    "SELECT count(*)::int AS count FROM asset WHERE source_generation_job_id = $1",
    [generationJobId],
  );
  const events = await pool.query<{ count: number } & QueryResultRow>(
    "SELECT count(*)::int AS count FROM domain_event WHERE aggregate_id = $1 AND event_type = 'job.succeeded'",
    [generationJobId],
  );
  const job = await pool.query<{ state: string } & QueryResultRow>(
    "SELECT state FROM generation_job WHERE id = $1",
    [generationJobId],
  );
  return {
    costs: costs.rows,
    assets: assets.rows[0]?.count ?? -1,
    succeededEvents: events.rows[0]?.count ?? -1,
    state: job.rows[0]?.state ?? "",
  };
}

describe("synchronous mock image cost guard", () => {
  it("stores one image asset and one zero actual cost", async () => {
    const bound = await bindFixedImage();
    const asset = await store.completeAttemptWithAsset(jobs, fixedImageAsset(bound, "mock-images/fixed.png"));
    expect(asset?.id).toBeTruthy();
    const ledger = await ledgerSnapshot(bound.generationJobId);
    expect(ledger.state).toBe("SUCCEEDED");
    expect(ledger.assets).toBe(1);
    expect(ledger.succeededEvents).toBe(1);
    expect(ledger.costs).toEqual([expect.objectContaining({
      kind: "ACTUAL",
      amount_decimal: "0.00000000",
      idempotency_key: `${bound.providerRequestId}:request:actual`,
      model: "mock-v1",
      supersedes_estimate_key: null,
    })]);
  });

  it("replays an identical actual and does not reopen a finished image", async () => {
    const bound = await bindFixedImage();
    await pool.query(
      `INSERT INTO cost_ledger
        (workspace_id, project_id, generation_job_id, job_attempt_id,
         idempotency_key, provider_configuration_id, provider_request_id,
         currency, amount_decimal, kind, basis, unit_type, unit_quantity, unit_price_snapshot,
         provider, model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'USD',0,'ACTUAL','PROVIDER_REPORTED','request',1,0,'mock-media','mock-v1')`,
      [
        bound.workspaceId, bound.projectId, bound.generationJobId, bound.jobAttemptId,
        `${bound.providerRequestId}:request:actual`, bound.providerConfigurationId, bound.providerRequestId,
      ],
    );
    await store.completeAttemptWithAsset(jobs, fixedImageAsset(bound, "mock-images/replay.png"));
    const afterReplay = await ledgerSnapshot(bound.generationJobId);
    expect(afterReplay.assets).toBe(1);
    expect(afterReplay.costs).toHaveLength(1);
    await expect(store.completeAttemptWithAsset(jobs, fixedImageAsset(bound, "mock-images/replay.png")))
      .rejects.toMatchObject({ code: "JOB_TERMINAL" });
    const afterTerminal = await ledgerSnapshot(bound.generationJobId);
    expect(afterTerminal).toEqual(afterReplay);
  });

  it("rejects estimates, occupied estimate keys, and a conflicting actual without committing success", async () => {
    const cases = [
      {
        key: "m3-image-accounting-negative:other-estimate",
        kind: "ESTIMATED",
        amount: "0",
        model: "m3-image-accounting-negative",
      },
      {
        keySuffix: ":request:estimated",
        kind: "ACTUAL",
        amount: "0",
        model: "m3-image-accounting-negative",
      },
      {
        keySuffix: ":request:actual",
        kind: "ACTUAL",
        amount: "1.00000000",
        model: "m3-image-accounting-negative",
      },
    ] as const;
    for (const [index, entry] of cases.entries()) {
      const bound = await bindFixedImage();
      const idempotencyKey = "key" in entry
        ? entry.key
        : `${bound.providerRequestId}${entry.keySuffix}`;
      const inserted = await pool.query<{ id: string } & QueryResultRow>(
        `INSERT INTO cost_ledger
          (workspace_id, project_id, generation_job_id, job_attempt_id,
           idempotency_key, provider_configuration_id, provider_request_id,
           currency, amount_decimal, kind, basis, unit_type, unit_quantity, unit_price_snapshot,
           provider, model)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'USD',$8,$9,'PROVIDER_REPORTED','request',1,0,'mock-media',$10)
         RETURNING id`,
        [
          bound.workspaceId, bound.projectId, bound.generationJobId, bound.jobAttemptId,
          idempotencyKey, bound.providerConfigurationId, bound.providerRequestId,
          entry.amount, entry.kind, entry.model,
        ],
      );
      const before = await ledgerSnapshot(bound.generationJobId);
      await expect(store.completeAttemptWithAsset(jobs, fixedImageAsset(bound, `mock-images/rejected-${index}.png`)))
        .rejects.toMatchObject({ code: "COST_CONFLICT" });
      const after = await ledgerSnapshot(bound.generationJobId);
      expect(after.state).toBe("RUNNING");
      expect(after.assets).toBe(0);
      expect(after.succeededEvents).toBe(0);
      expect(after.costs).toEqual(before.costs);
      expect(after.costs[0]?.id).toBe(inserted.rows[0]?.id);
    }
  });

  it("rejects a contradictory snapshot or lineage and leaves a succeeded image without a backfill", async () => {
    const contradictory = await bindFixedImage();
    await pool.query(
      `UPDATE generation_job
          SET input_snapshot = jsonb_set(input_snapshot, '{executionMode}', '"delayed"')
        WHERE id = $1`,
      [contradictory.generationJobId],
    );
    await pool.query(
      `UPDATE job_attempt
          SET request_snapshot = (SELECT input_snapshot FROM generation_job WHERE id = $1)
        WHERE id = $2`,
      [contradictory.generationJobId, contradictory.jobAttemptId],
    );
    await expect(store.completeAttemptWithAsset(jobs, fixedImageAsset(contradictory, "mock-images/delayed.png")))
      .rejects.toMatchObject({ code: "COST_CONFLICT" });
    expect((await ledgerSnapshot(contradictory.generationJobId)).assets).toBe(0);

    const mismatched = await bindFixedImage();
    await expect(store.completeAttemptWithAsset(jobs, {
      ...fixedImageAsset(mismatched, "mock-images/lineage.png"),
      providerRequestId: "mock-media|image.generate|other:1",
      actualCost: {
        ...fixedImageCost(mismatched),
        providerRequestId: "mock-media|image.generate|other:1",
        idempotencyKey: "mock-media|image.generate|other:1:request:actual",
      },
    })).rejects.toMatchObject({ code: "COST_CONFLICT" });
    expect((await ledgerSnapshot(mismatched.generationJobId)).assets).toBe(0);

    const historical = await bindFixedImage();
    await pool.query("UPDATE generation_job SET state = 'SUCCEEDED' WHERE id = $1", [historical.generationJobId]);
    await expect(store.completeAttemptWithAsset(jobs, fixedImageAsset(historical, "mock-images/historical.png")))
      .rejects.toMatchObject({ code: "JOB_TERMINAL" });
    const untouched = await ledgerSnapshot(historical.generationJobId);
    expect(untouched.state).toBe("SUCCEEDED");
    expect(untouched.assets).toBe(0);
    expect(untouched.costs).toEqual([]);
  });
});
