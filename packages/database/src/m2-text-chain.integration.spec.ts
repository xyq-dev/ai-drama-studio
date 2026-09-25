import { canonicalInputHash } from "@ai-drama/domain";
import { Pool, type QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PersistenceError } from "./job-service";
import { runMigrations } from "./migrations";
import { TextChainService } from "./text-chain";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
}

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const chain = new TextChainService(pool);
const hash = "ab".repeat(32);

beforeAll(async () => {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await runMigrations(pool);
});

beforeEach(async () => {
  await pool.query("TRUNCATE TABLE workspace RESTART IDENTITY CASCADE");
});

afterAll(async () => {
  await pool.end();
});

async function seedProject(): Promise<{ workspaceId: string; projectId: string }> {
  const workspace = await pool.query<{ id: string } & QueryResultRow>(
    "INSERT INTO workspace (name) VALUES ($1) RETURNING id",
    ["m2"],
  );
  const workspaceId = workspace.rows[0]?.id;
  if (!workspaceId) throw new Error("workspace insert failed");
  const project = await pool.query<{ id: string } & QueryResultRow>(
    "INSERT INTO project (workspace_id, title) VALUES ($1, $2) RETURNING id",
    [workspaceId, "pilot"],
  );
  const projectId = project.rows[0]?.id;
  if (!projectId) throw new Error("project insert failed");
  return { workspaceId, projectId };
}

async function approveStory(
  workspaceId: string,
  projectId: string,
  revisionId: string,
  expectedVersion: number,
): Promise<void> {
  await chain.transitionReview({
    table: "story_revision",
    revisionId,
    workspaceId,
    expectedReviewVersion: 1,
    to: "IN_REVIEW",
  });
  await chain.approveStory({
    workspaceId,
    projectId,
    revisionId,
    expectedVersion,
    expectedReviewVersion: 2,
    reviewedBy: "editor",
  });
}

describe("M2 text chain schema", () => {
  it("applies the additive migration beside M1", async () => {
    const names = await pool.query<{ name: string } & QueryResultRow>(
      "SELECT name FROM schema_migration ORDER BY name",
    );
    expect(names.rows.map((row) => row.name)).toEqual(
      expect.arrayContaining(["20260924000100_m1b_job_core", "20260925000100_m2a_text_chain"]),
    );
    const column = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'project' AND column_name = 'row_version'`,
    );
    expect(column.rowCount).toBe(1);
  });

  it("rejects a story revision that crosses workspace or project", async () => {
    const first = await seedProject();
    const second = await seedProject();
    await expect(
      pool.query(
        `INSERT INTO story_revision (workspace_id, project_id, revision_no, content_json, content_hash, created_by)
         VALUES ($1, $2, 1, '{}', $3, 'author')`,
        [second.workspaceId, first.projectId, hash],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("rejects a duplicate revision number and content updates", async () => {
    const { workspaceId, projectId } = await seedProject();
    const created = await chain.createStoryRevision({
      workspaceId,
      projectId,
      content: { schema: "m2.story.revision.v1", premise: "one" },
      createdBy: "author",
      expectedVersion: 1,
    });
    await expect(
      pool.query(
        `INSERT INTO story_revision (workspace_id, project_id, revision_no, content_json, content_hash, created_by)
         VALUES ($1, $2, $3, '{}', $4, 'author')`,
        [workspaceId, projectId, created.revisionNo, hash],
      ),
    ).rejects.toThrow(/unique/i);
    await expect(
      pool.query("UPDATE story_revision SET content_json = '{\"changed\":true}' WHERE id = $1", [created.revisionId]),
    ).rejects.toThrow(/immutable/i);
    await expect(pool.query("DELETE FROM story_revision WHERE id = $1", [created.revisionId])).rejects.toThrow(
      /cannot be deleted/i,
    );
  });

  it("constrains episode numbers to 1..3 and ensures that set on first story approval", async () => {
    const { workspaceId, projectId } = await seedProject();
    await expect(
      pool.query("INSERT INTO episode (workspace_id, project_id, episode_no, title) VALUES ($1, $2, 4, 'extra')", [
        workspaceId,
        projectId,
      ]),
    ).rejects.toThrow(/check/i);
    const created = await chain.createStoryRevision({
      workspaceId,
      projectId,
      content: { schema: "m2.story.revision.v1", premise: "pilot" },
      createdBy: "author",
      expectedVersion: 1,
    });
    await approveStory(workspaceId, projectId, created.revisionId, created.rowVersion);
    await chain.assertProductionEpisodes(workspaceId, projectId);
    const episodes = await pool.query<{ episode_no: number } & QueryResultRow>(
      "SELECT episode_no FROM episode WHERE project_id = $1 ORDER BY episode_no",
      [projectId],
    );
    expect(episodes.rows.map((row) => row.episode_no)).toEqual([1, 2, 3]);
    await pool.query("DELETE FROM episode WHERE project_id = $1 AND episode_no = 2", [projectId]);
    await expect(chain.assertProductionEpisodes(workspaceId, projectId)).rejects.toMatchObject({
      code: "EPISODE_SET_INVALID",
    });
  });

  it("keeps current and approved pointers inside the same parent", async () => {
    const first = await seedProject();
    const second = await seedProject();
    const story = await chain.createStoryRevision({
      workspaceId: first.workspaceId,
      projectId: first.projectId,
      content: { schema: "m2.story.revision.v1", premise: "owned" },
      createdBy: "author",
      expectedVersion: 1,
    });
    await expect(
      pool.query("UPDATE project SET current_story_revision_id = $1 WHERE id = $2", [
        story.revisionId,
        second.projectId,
      ]),
    ).rejects.toThrow(/foreign key/i);
    const pointer = await pool.query<{ current_story_revision_id: string } & QueryResultRow>(
      "SELECT current_story_revision_id FROM project WHERE id = $1",
      [first.projectId],
    );
    expect(pointer.rows[0]?.current_story_revision_id).toBe(story.revisionId);
  });

  it("rejects a ShotRevision sourced from another scene in the same project", async () => {
    const graph = await buildChain();
    const otherScene = await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO scene (workspace_id, project_id, episode_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [graph.workspaceId, graph.projectId, graph.episode2Id],
    );
    const otherSceneId = otherScene.rows[0]?.id;
    if (!otherSceneId) throw new Error("other scene missing");
    const otherSceneRevision = await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO scene_revision
        (workspace_id, project_id, episode_id, scene_id, revision_no, source_script_revision_id,
         ordinal, heading, summary, content_hash, created_by)
       VALUES ($1,$2,$3,$4,1,$5,2,'INT. OTHER','other',$6,'author') RETURNING id`,
      [
        graph.workspaceId,
        graph.projectId,
        graph.episode2Id,
        otherSceneId,
        graph.scriptRevisionId,
        hash,
      ],
    );
    const otherSceneRevisionId = otherSceneRevision.rows[0]?.id;
    if (!otherSceneRevisionId) throw new Error("other scene revision missing");

    await expect(
      pool.query(
        `INSERT INTO shot_revision
          (workspace_id, project_id, scene_id, shot_id, revision_no, source_scene_revision_id,
           ordinal, shot_type, camera, action, prompt_text, content_hash, created_by)
         VALUES ($1,$2,$3,$4,2,$5,1,'close','static','bad provenance','bad',$6,'author')`,
        [
          graph.workspaceId,
          graph.projectId,
          graph.sceneId,
          graph.shotId,
          otherSceneRevisionId,
          hash,
        ],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("conflicts when the expected aggregate or review version is stale", async () => {
    const { workspaceId, projectId } = await seedProject();
    await expect(
      chain.createStoryRevision({
        workspaceId,
        projectId,
        content: { schema: "m2.story.revision.v1", premise: "race" },
        createdBy: "author",
        expectedVersion: 9,
      }),
    ).rejects.toBeInstanceOf(PersistenceError);
    const created = await chain.createStoryRevision({
      workspaceId,
      projectId,
      content: { schema: "m2.story.revision.v1", premise: "race" },
      createdBy: "author",
      expectedVersion: 1,
    });
    await expect(
      chain.transitionReview({
        table: "story_revision",
        revisionId: created.revisionId,
        workspaceId,
        expectedReviewVersion: 4,
        to: "IN_REVIEW",
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await expect(
      chain.transitionReview({
        table: "story_revision",
        revisionId: created.revisionId,
        workspaceId,
        expectedReviewVersion: 1,
        to: "APPROVED",
        reviewedBy: "editor",
      }),
    ).rejects.toMatchObject({ code: "REVIEW_GATE_REQUIRED" });
  });
});

  it("serializes concurrent revision creation into an explicit revision conflict", async () => {
    const { workspaceId, projectId } = await seedProject();
    const results = await Promise.allSettled([
      chain.createStoryRevision({
        workspaceId,
        projectId,
        content: { schema: "m2.story.revision.v1", premise: "first contender" },
        createdBy: "author-a",
        expectedVersion: 1,
      }),
      chain.createStoryRevision({
        workspaceId,
        projectId,
        content: { schema: "m2.story.revision.v1", premise: "second contender" },
        createdBy: "author-b",
        expectedVersion: 1,
      }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "REVISION_CONFLICT" });
    const rows = await pool.query<{ count: number } & QueryResultRow>(
      "SELECT COUNT(*)::int AS count FROM story_revision WHERE project_id = $1",
      [projectId],
    );
    expect(rows.rows[0]?.count).toBe(1);
  });

  it("keeps typed revision provenance append-only", async () => {
    const graph = await buildChain();
    await expect(
      pool.query(
        "DELETE FROM character_revision_script_source WHERE character_revision_id = $1 AND script_revision_id = $2",
        [graph.characterRevisionId, graph.scriptRevisionId],
      ),
    ).rejects.toThrow(/provenance is immutable/i);

    await pool.query(
      `INSERT INTO shot_character_reference
        (workspace_id, project_id, shot_revision_id, character_revision_id, role)
       VALUES ($1, $2, $3, $4, 'lead')`,
      [graph.workspaceId, graph.projectId, graph.shotRevisionId, graph.characterRevisionId],
    );
    await expect(
      pool.query(
        "UPDATE shot_character_reference SET role = 'background' WHERE shot_revision_id = $1 AND character_revision_id = $2",
        [graph.shotRevisionId, graph.characterRevisionId],
      ),
    ).rejects.toThrow(/provenance is immutable/i);
  });

  it("rejects approval when a script becomes stale before review completes", async () => {
    const graph = await buildChain();
    const pending = await chain.createScriptRevision({
      workspaceId: graph.workspaceId,
      projectId: graph.projectId,
      episodeId: graph.episode2Id,
      sourceStoryRevisionId: graph.storyRevisionId,
      content: { schema: "m2.script.revision.v1", episode: 2, pending: true },
      createdBy: "author",
      expectedVersion: graph.episode2Version,
    });
    await chain.transitionReview({
      table: "script_revision",
      revisionId: pending.revisionId,
      workspaceId: graph.workspaceId,
      expectedReviewVersion: 1,
      to: "IN_REVIEW",
    });

    const replacementStory = await chain.createStoryRevision({
      workspaceId: graph.workspaceId,
      projectId: graph.projectId,
      content: { schema: "m2.story.revision.v1", premise: "new approved source" },
      createdBy: "author",
      expectedVersion: graph.projectVersion,
    });
    await chain.transitionReview({
      table: "story_revision",
      revisionId: replacementStory.revisionId,
      workspaceId: graph.workspaceId,
      expectedReviewVersion: 1,
      to: "IN_REVIEW",
    });
    await approveStory(
      graph.workspaceId,
      graph.projectId,
      replacementStory.revisionId,
      replacementStory.rowVersion,
    );

    await expect(
      chain.approveScript({
        workspaceId: graph.workspaceId,
        episodeId: graph.episode2Id,
        revisionId: pending.revisionId,
        expectedVersion: pending.rowVersion,
        expectedReviewVersion: 2,
        reviewedBy: "editor",
      }),
    ).rejects.toMatchObject({ code: "SOURCE_STALE" });
  });

  it("blocks new scripts from an approved story that is no longer current", async () => {
    const graph = await buildChain();
    const replacementStory = await chain.createStoryRevision({
      workspaceId: graph.workspaceId,
      projectId: graph.projectId,
      content: { schema: "m2.story.revision.v1", premise: "draft current source" },
      createdBy: "author",
      expectedVersion: graph.projectVersion,
    });
    expect(replacementStory.revisionId).toBeTruthy();

    const episode = await pool.query<{ row_version: number } & QueryResultRow>(
      "SELECT row_version FROM episode WHERE id = $1",
      [graph.episode2Id],
    );
    await expect(
      chain.createScriptRevision({
        workspaceId: graph.workspaceId,
        projectId: graph.projectId,
        episodeId: graph.episode2Id,
        sourceStoryRevisionId: graph.storyRevisionId,
        content: { schema: "m2.script.revision.v1", episode: 2, invalidSource: true },
        createdBy: "author",
        expectedVersion: episode.rows[0]?.row_version ?? 0,
      }),
    ).rejects.toMatchObject({ code: "REVIEW_REQUIRED" });
  });

describe("STALE propagation", () => {
  it("stales the whole chain derived from a replaced approved story", async () => {
    const graph = await buildChain();
    const next = await chain.createStoryRevision({
      workspaceId: graph.workspaceId,
      projectId: graph.projectId,
      content: { schema: "m2.story.revision.v1", premise: "rewrite" },
      createdBy: "author",
      expectedVersion: graph.projectVersion,
    });
    const immediate = await pool.query<
      { freshness_status: string; stale_reason: string | null; stale_from_ref: string | null } & QueryResultRow
    >(
      "SELECT freshness_status, stale_reason, stale_from_ref FROM script_revision WHERE id = $1",
      [graph.scriptRevisionId],
    );
    expect(immediate.rows[0]).toMatchObject({
      freshness_status: "STALE",
      stale_reason: "SOURCE_STORY_REPLACED",
      stale_from_ref: `story_revision:${graph.storyRevisionId}`,
    });

    await approveStory(graph.workspaceId, graph.projectId, next.revisionId, next.rowVersion);
    const freshness = await pool.query<{ kind: string; freshness_status: string } & QueryResultRow>(
      `SELECT 'script' AS kind, freshness_status FROM script_revision WHERE id = $1
       UNION ALL SELECT 'scene', freshness_status FROM scene_revision WHERE id = $2
       UNION ALL SELECT 'shot', freshness_status FROM shot_revision WHERE id = $3
       UNION ALL SELECT 'character', freshness_status FROM character_revision WHERE id = $4
       UNION ALL SELECT 'unlinked', freshness_status FROM character_revision WHERE id = $5
       UNION ALL SELECT 'location', freshness_status FROM location_revision WHERE id = $6`,
      [
        graph.scriptRevisionId,
        graph.sceneRevisionId,
        graph.shotRevisionId,
        graph.characterRevisionId,
        graph.unlinkedCharacterRevisionId,
        graph.locationRevisionId,
      ],
    );
    const byKind = Object.fromEntries(freshness.rows.map((row) => [row.kind, row.freshness_status]));
    expect(byKind.script).toBe("STALE");
    expect(byKind.scene).toBe("STALE");
    expect(byKind.shot).toBe("STALE");
    expect(byKind.character).toBe("STALE");
    expect(byKind.location).toBe("STALE");
    expect(byKind.unlinked).toBe("CURRENT");
  });

  it("stales only the episode whose approved script changed", async () => {
    const graph = await buildChain();
    const episodes = await pool.query<{ id: string; episode_no: number; row_version: number } & QueryResultRow>(
      "SELECT id, episode_no, row_version FROM episode WHERE project_id = $1",
      [graph.projectId],
    );
    const episode1 = episodes.rows.find((row) => row.episode_no === 1);
    const episode3 = episodes.rows.find((row) => row.episode_no === 3);
    if (!episode1 || !episode3) throw new Error("episodes missing");
    const other = await chain.createScriptRevision({
      workspaceId: graph.workspaceId,
      projectId: graph.projectId,
      episodeId: episode1.id,
      sourceStoryRevisionId: graph.storyRevisionId,
      content: { schema: "m2.script.revision.v1", episode: 1 },
      createdBy: "author",
      expectedVersion: episode1.row_version,
    });
    const untouched = await chain.createScriptRevision({
      workspaceId: graph.workspaceId,
      projectId: graph.projectId,
      episodeId: episode3.id,
      sourceStoryRevisionId: graph.storyRevisionId,
      content: { schema: "m2.script.revision.v1", episode: 3 },
      createdBy: "author",
      expectedVersion: episode3.row_version,
    });
    const replacement = await chain.createScriptRevision({
      workspaceId: graph.workspaceId,
      projectId: graph.projectId,
      episodeId: graph.episode2Id,
      sourceStoryRevisionId: graph.storyRevisionId,
      content: { schema: "m2.script.revision.v1", episode: 2, take: 2 },
      createdBy: "author",
      expectedVersion: graph.episode2Version,
    });
    const immediateDownstream = await pool.query<
      { freshness_status: string; stale_reason: string | null; stale_from_ref: string | null } & QueryResultRow
    >(
      "SELECT freshness_status, stale_reason, stale_from_ref FROM scene_revision WHERE id = $1",
      [graph.sceneRevisionId],
    );
    expect(immediateDownstream.rows[0]).toMatchObject({
      freshness_status: "STALE",
      stale_reason: "SOURCE_SCRIPT_REPLACED",
      stale_from_ref: `script_revision:${graph.scriptRevisionId}`,
    });

    await chain.transitionReview({
      table: "script_revision",
      revisionId: replacement.revisionId,
      workspaceId: graph.workspaceId,
      expectedReviewVersion: 1,
      to: "IN_REVIEW",
    });
    await chain.approveScript({
      workspaceId: graph.workspaceId,
      episodeId: graph.episode2Id,
      revisionId: replacement.revisionId,
      expectedVersion: replacement.rowVersion,
      expectedReviewVersion: 2,
      reviewedBy: "editor",
    });
    const rows = await pool.query<{ id: string; freshness_status: string } & QueryResultRow>(
      "SELECT id, freshness_status FROM script_revision WHERE id = ANY($1::uuid[])",
      [[graph.scriptRevisionId, other.revisionId, untouched.revisionId]],
    );
    const status = Object.fromEntries(rows.rows.map((row) => [row.id, row.freshness_status]));
    expect(status[graph.scriptRevisionId]).toBe("CURRENT");
    expect(status[other.revisionId]).toBe("CURRENT");
    expect(status[untouched.revisionId]).toBe("CURRENT");
    const downstream = await pool.query<{ freshness_status: string } & QueryResultRow>(
      "SELECT freshness_status FROM scene_revision WHERE id = $1",
      [graph.sceneRevisionId],
    );
    expect(downstream.rows[0]?.freshness_status).toBe("STALE");
  });

  it("creates one shot revision without staling siblings", async () => {
    const graph = await buildChain();
    const sibling = await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO shot (workspace_id, project_id, episode_id, scene_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [graph.workspaceId, graph.projectId, graph.episode2Id, graph.sceneId],
    );
    const siblingId = sibling.rows[0]?.id;
    if (!siblingId) throw new Error("sibling shot missing");
    await pool.query(
      `INSERT INTO shot_revision
        (workspace_id, project_id, scene_id, shot_id, revision_no, source_scene_revision_id,
         ordinal, shot_type, camera, action, prompt_text, content_hash, created_by)
       VALUES ($1,$2,$3,$4,1,$5,2,'wide','static','wait','sibling', $6, 'author')`,
      [graph.workspaceId, graph.projectId, graph.sceneId, siblingId, graph.sceneRevisionId, hash],
    );
    const created = await chain.createShotRevision({
      workspaceId: graph.workspaceId,
      projectId: graph.projectId,
      sceneId: graph.sceneId,
      shotId: graph.shotId,
      sourceSceneRevisionId: graph.sceneRevisionId,
      ordinal: 1,
      shotType: "close",
      camera: "push",
      action: "turn",
      dialogue: null,
      durationHint: null,
      promptText: "second take",
      createdBy: "author",
      expectedVersion: 1,
    });
    expect(created.revisionNo).toBe(2);
    const freshness = await pool.query<{ freshness_status: string } & QueryResultRow>(
      `SELECT freshness_status FROM shot_revision WHERE shot_id = $1 AND revision_no = 1
       UNION ALL
       SELECT freshness_status FROM shot_revision WHERE shot_id = $2`,
      [graph.shotId, siblingId],
    );
    expect(freshness.rows.every((row) => row.freshness_status === "CURRENT")).toBe(true);
  });
});

interface ChainGraph {
  workspaceId: string;
  projectId: string;
  projectVersion: number;
  storyRevisionId: string;
  episode2Id: string;
  episode2Version: number;
  scriptRevisionId: string;
  sceneId: string;
  sceneRevisionId: string;
  shotId: string;
  shotRevisionId: string;
  characterRevisionId: string;
  unlinkedCharacterRevisionId: string;
  locationRevisionId: string;
}

async function buildChain(): Promise<ChainGraph> {
  const { workspaceId, projectId } = await seedProject();
  const story = await chain.createStoryRevision({
    workspaceId,
    projectId,
    content: { schema: "m2.story.revision.v1", premise: "origin" },
    createdBy: "author",
    expectedVersion: 1,
  });
  await approveStory(workspaceId, projectId, story.revisionId, story.rowVersion);
  const episode = await pool.query<{ id: string; row_version: number } & QueryResultRow>(
    "SELECT id, row_version FROM episode WHERE project_id = $1 AND episode_no = 2",
    [projectId],
  );
  const episode2Id = episode.rows[0]?.id;
  const episode2Version = episode.rows[0]?.row_version;
  if (!episode2Id || !episode2Version) throw new Error("episode 2 missing");
  const script = await chain.createScriptRevision({
    workspaceId,
    projectId,
    episodeId: episode2Id,
    sourceStoryRevisionId: story.revisionId,
    content: { schema: "m2.script.revision.v1", episode: 2 },
    createdBy: "author",
    expectedVersion: episode2Version,
  });
  await chain.transitionReview({
    table: "script_revision",
    revisionId: script.revisionId,
    workspaceId,
    expectedReviewVersion: 1,
    to: "IN_REVIEW",
  });
  await chain.approveScript({
    workspaceId,
    episodeId: episode2Id,
    revisionId: script.revisionId,
    expectedVersion: script.rowVersion,
    expectedReviewVersion: 2,
    reviewedBy: "editor",
  });
  const scene = await pool.query<{ id: string } & QueryResultRow>(
    `INSERT INTO scene (workspace_id, project_id, episode_id) VALUES ($1, $2, $3) RETURNING id`,
    [workspaceId, projectId, episode2Id],
  );
  const sceneId = scene.rows[0]?.id;
  if (!sceneId) throw new Error("scene missing");
  const sceneRevision = await pool.query<{ id: string } & QueryResultRow>(
    `INSERT INTO scene_revision
      (workspace_id, project_id, episode_id, scene_id, revision_no, source_script_revision_id,
       ordinal, heading, summary, content_hash, created_by)
     VALUES ($1,$2,$3,$4,1,$5,1,'INT. ROOM','a room',$6,'author') RETURNING id`,
    [workspaceId, projectId, episode2Id, sceneId, script.revisionId, hash],
  );
  const sceneRevisionId = sceneRevision.rows[0]?.id;
  if (!sceneRevisionId) throw new Error("scene revision missing");
  const shot = await pool.query<{ id: string } & QueryResultRow>(
    `INSERT INTO shot (workspace_id, project_id, episode_id, scene_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    [workspaceId, projectId, episode2Id, sceneId],
  );
  const shotId = shot.rows[0]?.id;
  if (!shotId) throw new Error("shot missing");
  const shotRevision = await pool.query<{ id: string } & QueryResultRow>(
    `INSERT INTO shot_revision
      (workspace_id, project_id, scene_id, shot_id, revision_no, source_scene_revision_id,
       ordinal, shot_type, camera, action, prompt_text, content_hash, created_by)
     VALUES ($1,$2,$3,$4,1,$5,1,'close','static','look','prompt',$6,'author') RETURNING id`,
    [workspaceId, projectId, sceneId, shotId, sceneRevisionId, hash],
  );
  const shotRevisionId = shotRevision.rows[0]?.id;
  if (!shotRevisionId) throw new Error("shot revision missing");
  const character = await insertEntityRevision("character", workspaceId, projectId, script.revisionId, true);
  const unlinked = await insertEntityRevision("character", workspaceId, projectId, script.revisionId, false);
  const location = await insertEntityRevision("location", workspaceId, projectId, script.revisionId, true);
  const versions = await pool.query<{ project_version: number; episode_version: number } & QueryResultRow>(
    `SELECT project.row_version AS project_version, episode.row_version AS episode_version
       FROM project JOIN episode ON episode.project_id = project.id
      WHERE project.id = $1 AND episode.id = $2`,
    [projectId, episode2Id],
  );
  return {
    workspaceId,
    projectId,
    projectVersion: versions.rows[0]?.project_version ?? 0,
    storyRevisionId: story.revisionId,
    episode2Id,
    episode2Version: versions.rows[0]?.episode_version ?? 0,
    scriptRevisionId: script.revisionId,
    sceneId,
    sceneRevisionId,
    shotId,
    shotRevisionId,
    characterRevisionId: character,
    unlinkedCharacterRevisionId: unlinked,
    locationRevisionId: location,
  };
}

async function insertEntityRevision(
  kind: "character" | "location",
  workspaceId: string,
  projectId: string,
  scriptRevisionId: string,
  linked: boolean,
): Promise<string> {
  const entity = await pool.query<{ id: string } & QueryResultRow>(
    `INSERT INTO ${kind} (workspace_id, project_id, name) VALUES ($1, $2, $3) RETURNING id`,
    [workspaceId, projectId, `${kind}-${linked ? "linked" : "free"}-${canonicalInputHash({ kind, linked }).slice(0, 8)}`],
  );
  const entityId = entity.rows[0]?.id;
  if (!entityId) throw new Error(`${kind} missing`);
  const revision = await pool.query<{ id: string } & QueryResultRow>(
    `INSERT INTO ${kind}_revision
      (workspace_id, project_id, ${kind}_id, revision_no, content_json, content_hash, created_by)
     VALUES ($1, $2, $3, 1, '{}', $4, 'author') RETURNING id`,
    [workspaceId, projectId, entityId, hash],
  );
  const revisionId = revision.rows[0]?.id;
  if (!revisionId) throw new Error(`${kind} revision missing`);
  if (linked) {
    await pool.query(
      `INSERT INTO ${kind}_revision_script_source
        (workspace_id, project_id, ${kind}_revision_id, script_revision_id)
       VALUES ($1, $2, $3, $4)`,
      [workspaceId, projectId, revisionId, scriptRevisionId],
    );
  }
  return revisionId;
}
