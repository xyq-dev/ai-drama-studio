import { Pool, type QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MediaAssetStore } from "./media-assets";
import { runMigrations } from "./migrations";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for PostgreSQL integration tests");

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const store = new MediaAssetStore(pool);
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
    };
    await store.createAsset(base);
    await expect(
      store.createAsset({ ...base, checksumSha256: "cd".repeat(32) }),
    ).rejects.toMatchObject({ code: "ASSET_CONFLICT" });

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
        seeded.providerRequestId,
      ],
    );
    const secondAttemptId = secondAttempt.rows[0]?.id;
    if (!secondAttemptId) throw new Error("second attempt missing");

    await expect(
      store.createAsset({ ...base, sourceJobAttemptId: secondAttemptId }),
    ).rejects.toMatchObject({ code: "ASSET_CONFLICT" });
  });
});
