import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "./migrations";
import { TextChainService, type TextEntityKind } from "./text-chain";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const chain = new TextChainService(pool);

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

async function setup() {
  const workspaceId = (await pool.query<{ id: string } & QueryResultRow>(
    "INSERT INTO workspace (name) VALUES ('entity-slice') RETURNING id",
  )).rows[0]!.id;
  const projectId = (await pool.query<{ id: string } & QueryResultRow>(
    "INSERT INTO project (workspace_id, title) VALUES ($1, 'slice') RETURNING id", [workspaceId],
  )).rows[0]!.id;
  const story = await chain.createStoryRevision({
    workspaceId, projectId, content: { premise: "pilot" }, createdBy: "author", expectedVersion: 1,
  });
  const review = await chain.transitionReview({
    table: "story_revision", workspaceId, revisionId: story.revisionId,
    expectedVersion: story.rowVersion, expectedReviewVersion: 1, to: "IN_REVIEW",
  });
  await chain.approveStory({
    workspaceId, projectId, revisionId: story.revisionId,
    expectedVersion: review.rowVersion, expectedReviewVersion: 2, reviewedBy: "editor",
  });
  const episodeId = (await pool.query<{ id: string } & QueryResultRow>(
    "SELECT id FROM episode WHERE project_id = $1 AND episode_no = 1", [projectId],
  )).rows[0]!.id;
  const script = await chain.createScriptRevision({
    workspaceId, projectId, episodeId, sourceStoryRevisionId: story.revisionId,
    content: { scenes: [] }, createdBy: "author", expectedVersion: 1,
  });
  return { workspaceId, projectId, episodeId, script };
}

async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

describe.each(["character", "location"] as const)("M2 %s API persistence slice", (kind: TextEntityKind) => {
  it("gates on approved script, preserves history and enforces workspace, source and versions", async () => {
    const { workspaceId, projectId, episodeId, script } = await setup();
    const input = {
      kind, workspaceId, projectId, name: "Lead", sourceScriptRevisionId: script.revisionId,
      content: { persona: "steady" }, createdBy: "author", expectedVersion: 4,
    };
    await expect(transaction((client) => chain.createTextEntityRevisionInTransaction(client, input)))
      .rejects.toMatchObject({ code: "SCRIPT_REVIEW_REQUIRED" });
    const scriptReview = await chain.transitionReview({
      table: "script_revision", workspaceId, revisionId: script.revisionId,
      expectedVersion: script.rowVersion, expectedReviewVersion: 1, to: "IN_REVIEW",
    });
    await chain.approveScript({
      workspaceId, episodeId, revisionId: script.revisionId,
      expectedVersion: scriptReview.rowVersion, expectedReviewVersion: 2, reviewedBy: "editor",
    });
    const version = (await pool.query<{ version: number } & QueryResultRow>(
      "SELECT version FROM project WHERE id = $1", [projectId],
    )).rows[0]!.version;
    const first = await transaction((client) => chain.createTextEntityRevisionInTransaction(client, {
      ...input, expectedVersion: version,
    }));
    await expect(transaction((client) => chain.createTextEntityRevisionInTransaction(client, {
      ...input, name: "Other", expectedVersion: version,
    }))).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const history = await chain.listTextEntityRevisions(kind, workspaceId, projectId, first.entityId);
    expect(history.items).toMatchObject([{ id: first.revisionId, sourceScriptRevisionId: script.revisionId }]);
    const reviewed = await transaction((client) => chain.reviewTextEntityInTransaction(client, {
      kind, workspaceId, projectId, entityId: first.entityId, revisionId: first.revisionId,
      expectedVersion: first.rowVersion, expectedReviewVersion: 1, to: "IN_REVIEW", reviewedBy: "editor",
    }));
    const approved = await transaction((client) => chain.reviewTextEntityInTransaction(client, {
      kind, workspaceId, projectId, entityId: first.entityId, revisionId: first.revisionId,
      expectedVersion: reviewed.rowVersion, expectedReviewVersion: reviewed.reviewVersion,
      to: "APPROVED", reviewedBy: "editor",
    }));
    expect(approved.rowVersion).toBe(reviewed.rowVersion + 1);
    const second = await transaction((client) => chain.createTextEntityRevisionInTransaction(client, {
      ...input, entityId: first.entityId, expectedVersion: approved.rowVersion,
      content: { persona: "changed" },
    }));
    expect(second.revisionNo).toBe(2);
    expect((await chain.listTextEntityRevisions(kind, workspaceId, projectId, first.entityId))
      .items.map((item) => item.id)).toEqual([second.revisionId, first.revisionId]);
    // Read-only additions: the list names the entity and a returned revision carries the reviewer's reason.
    expect((await chain.listTextEntities(kind, workspaceId, projectId)).items[0]).toMatchObject({ entityId: first.entityId, name: "Lead" });
    const secondReview = await transaction((client) => chain.reviewTextEntityInTransaction(client, {
      kind, workspaceId, projectId, entityId: first.entityId, revisionId: second.revisionId,
      expectedVersion: second.rowVersion, expectedReviewVersion: 1, to: "IN_REVIEW", reviewedBy: "editor",
    }));
    await transaction((client) => chain.reviewTextEntityInTransaction(client, {
      kind, workspaceId, projectId, entityId: first.entityId, revisionId: second.revisionId,
      expectedVersion: secondReview.rowVersion, expectedReviewVersion: secondReview.reviewVersion,
      to: "REJECTED", reviewedBy: "editor", reviewNote: "光线描述不够具体",
    }));
    const returned = await chain.listTextEntityRevisions(kind, workspaceId, projectId, first.entityId);
    expect(returned.items[0]).toMatchObject({ id: second.revisionId, reviewStatus: "REJECTED", reviewNote: "光线描述不够具体" });
    expect(returned.items[1]?.reviewNote).toBeNull();
    await expect(transaction((client) => chain.createTextEntityRevisionInTransaction(client, {
      ...input, workspaceId: "22222222-2222-4222-8222-222222222222",
      entityId: first.entityId, expectedVersion: second.rowVersion,
    }))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(transaction((client) => chain.createTextEntityRevisionInTransaction(client, {
      ...input, entityId: first.entityId, sourceScriptRevisionId: first.revisionId,
      expectedVersion: second.rowVersion,
    }))).rejects.toMatchObject({ code: "SCRIPT_REVIEW_REQUIRED" });
  });

  it("atomically stales dependent revisions and assets while preserving unrelated inputs", async () => {
    const { workspaceId, projectId, episodeId, script } = await setup();
    const review = await chain.transitionReview({
      table: "script_revision", workspaceId, revisionId: script.revisionId,
      expectedVersion: script.rowVersion, expectedReviewVersion: 1, to: "IN_REVIEW",
    });
    await chain.approveScript({
      workspaceId, episodeId, revisionId: script.revisionId,
      expectedVersion: review.rowVersion, expectedReviewVersion: 2, reviewedBy: "editor",
    });
    const projectVersion = (await pool.query<{ version: number } & QueryResultRow>(
      "SELECT version FROM project WHERE id = $1", [projectId],
    )).rows[0]!.version;
    const input = {
      kind, workspaceId, projectId, name: "Source", sourceScriptRevisionId: script.revisionId,
      content: { description: "original" }, createdBy: "author", expectedVersion: projectVersion,
    };
    const first = await transaction((client) => chain.createTextEntityRevisionInTransaction(client, input));
    const inReview = await transaction((client) => chain.reviewTextEntityInTransaction(client, {
      kind, workspaceId, projectId, entityId: first.entityId, revisionId: first.revisionId,
      expectedVersion: first.rowVersion, expectedReviewVersion: 1, to: "IN_REVIEW", reviewedBy: "editor",
    }));
    const approved = await transaction((client) => chain.reviewTextEntityInTransaction(client, {
      kind, workspaceId, projectId, entityId: first.entityId, revisionId: first.revisionId,
      expectedVersion: inReview.rowVersion, expectedReviewVersion: inReview.reviewVersion,
      to: "APPROVED", reviewedBy: "editor",
    }));
    const hash = "cd".repeat(32);
    const sceneId = (await pool.query<{ id: string } & QueryResultRow>(
      "INSERT INTO scene (workspace_id, project_id, episode_id) VALUES ($1,$2,$3) RETURNING id",
      [workspaceId, projectId, episodeId],
    )).rows[0]!.id;
    const sceneRevisionId = (await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO scene_revision
        (workspace_id, project_id, episode_id, scene_id, revision_no, source_script_revision_id,
         location_revision_id, ordinal, heading, summary, content_hash, created_by)
       VALUES ($1,$2,$3,$4,1,$5,$6,1,'opening','opening',$7,'author') RETURNING id`,
      [workspaceId, projectId, episodeId, sceneId, script.revisionId,
        kind === "location" ? first.revisionId : null, hash],
    )).rows[0]!.id;
    await pool.query("UPDATE scene SET current_revision_id = $1 WHERE id = $2", [sceneRevisionId, sceneId]);
    const shotId = (await pool.query<{ id: string } & QueryResultRow>(
      "INSERT INTO shot (workspace_id, project_id, episode_id, scene_id) VALUES ($1,$2,$3,$4) RETURNING id",
      [workspaceId, projectId, episodeId, sceneId],
    )).rows[0]!.id;
    const shotRevisionId = (await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO shot_revision
        (workspace_id, project_id, scene_id, shot_id, revision_no, source_scene_revision_id,
         ordinal, shot_type, camera, action, prompt_text, content_hash, created_by)
       VALUES ($1,$2,$3,$4,1,$5,1,'WIDE','static','action','prompt',$6,'author') RETURNING id`,
      [workspaceId, projectId, sceneId, shotId, sceneRevisionId, hash],
    )).rows[0]!.id;
    await pool.query("UPDATE shot SET current_revision_id = $1 WHERE id = $2", [shotRevisionId, shotId]);
    if (kind === "character") {
      await pool.query(
        `INSERT INTO shot_character_reference
          (workspace_id, project_id, shot_revision_id, character_revision_id, role)
         VALUES ($1,$2,$3,$4,'lead')`,
        [workspaceId, projectId, shotRevisionId, first.revisionId],
      );
    }
    const assets = await pool.query<{ id: string; object_key: string } & QueryResultRow>(
      `INSERT INTO asset
        (workspace_id, project_id, kind, storage_provider, object_key, mime_type,
         byte_size, checksum_sha256, source_kind)
       SELECT $1, $2, 'IMAGE', 'test', 'entity-stale-' || $3 || '-' || n,
              'image/png', 1, $4, 'UPLOAD'
         FROM generate_series(1, 204) n
       RETURNING id, object_key`,
      [workspaceId, projectId, kind, hash],
    );
    const directId = assets.rows.find((asset) => asset.object_key.endsWith("-1"))!.id;
    const unaffectedId = assets.rows.find((asset) => asset.object_key.endsWith("-204"))!.id;
    const revisionColumn = kind === "location" ? "location_revision_id" : "character_revision_id";
    await pool.query(
      `INSERT INTO asset_revision_dependency
        (workspace_id, project_id, dependent_asset_id, ${revisionColumn})
       VALUES ($1,$2,$3,$4)`,
      [workspaceId, projectId, directId, first.revisionId],
    );
    // A second path via the stale shot must join the same dependency closure.
    const shotAssetId = assets.rows.find((asset) => asset.object_key.endsWith("-2"))!.id;
    await pool.query(
      `INSERT INTO asset_revision_dependency
        (workspace_id, project_id, dependent_asset_id, shot_revision_id)
       VALUES ($1,$2,$3,$4)`,
      [workspaceId, projectId, shotAssetId, shotRevisionId],
    );
    for (const asset of assets.rows.slice(2, 203)) {
      await pool.query(
        `INSERT INTO asset_dependency
          (workspace_id, project_id, dependent_asset_id, source_asset_id)
         VALUES ($1,$2,$3,$4)`,
        [workspaceId, projectId, asset.id, directId],
      );
    }
    const replacement = await transaction((client) => chain.createTextEntityRevisionInTransaction(client, {
      ...input, entityId: first.entityId, expectedVersion: approved.rowVersion,
      content: { description: "replacement" },
    }));
    expect(replacement.revisionNo).toBe(2);
    const scene = await pool.query<{ freshness_status: string } & QueryResultRow>(
      "SELECT freshness_status FROM scene_revision WHERE id = $1", [sceneRevisionId],
    );
    const shot = await pool.query<{ freshness_status: string } & QueryResultRow>(
      "SELECT freshness_status FROM shot_revision WHERE id = $1", [shotRevisionId],
    );
    expect(scene.rows[0]!.freshness_status).toBe(kind === "location" ? "STALE" : "CURRENT");
    expect(shot.rows[0]!.freshness_status).toBe("STALE");
    const initial = await pool.query<{ count: number } & QueryResultRow>(
      "SELECT COUNT(*)::int AS count FROM asset WHERE project_id = $1 AND status = 'STALE'", [projectId],
    );
    expect(initial.rows[0]!.count).toBe(200);
    const queued = await pool.query<{ status: string } & QueryResultRow>(
      "SELECT status FROM stale_recalculation WHERE stale_from_ref = $1",
      [`${kind}_revision:${first.revisionId}`],
    );
    expect(queued.rows[0]!.status).toBe("PENDING");
    expect(await chain.continueStaleRecalculation()).toBe(true);
    const after = await pool.query<{ count: number } & QueryResultRow>(
      "SELECT COUNT(*)::int AS count FROM asset WHERE project_id = $1 AND status = 'STALE'", [projectId],
    );
    expect(after.rows[0]!.count).toBe(203);
    const untouched = await pool.query<{ status: string } & QueryResultRow>(
      "SELECT status FROM asset WHERE id = $1", [unaffectedId],
    );
    expect(untouched.rows[0]!.status).toBe("ACTIVE");
    const oldReview = await pool.query<{ review_status: string; reviewed_by: string } & QueryResultRow>(
      `SELECT review_status, reviewed_by FROM ${kind}_revision WHERE id = $1`, [first.revisionId],
    );
    expect(oldReview.rows[0]).toMatchObject({ review_status: "APPROVED", reviewed_by: "editor" });
  });
});
