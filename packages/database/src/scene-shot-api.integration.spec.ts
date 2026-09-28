import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "./migrations";
import { TextChainService } from "./text-chain";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for isolated PostgreSQL integration tests");
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const chain = new TextChainService(pool);

beforeAll(async () => {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await runMigrations(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE workspace RESTART IDENTITY CASCADE");
});
afterAll(async () => {
  await pool.end();
});

async function tx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function approvedScript() {
  const workspaceId = (await pool.query<{ id: string } & QueryResultRow>(
    "INSERT INTO workspace (name) VALUES ('scene-shot') RETURNING id",
  )).rows[0]!.id;
  const projectId = (await pool.query<{ id: string } & QueryResultRow>(
    "INSERT INTO project (workspace_id, title) VALUES ($1, 'script') RETURNING id", [workspaceId],
  )).rows[0]!.id;
  const story = await chain.createStoryRevision({
    workspaceId, projectId, content: { premise: "pilot" }, createdBy: "author", expectedVersion: 1,
  });
  const storyReview = await chain.transitionReview({
    table: "story_revision", workspaceId, revisionId: story.revisionId,
    expectedVersion: story.rowVersion, expectedReviewVersion: 1, to: "IN_REVIEW",
  });
  await chain.approveStory({
    workspaceId, projectId, revisionId: story.revisionId,
    expectedVersion: storyReview.rowVersion, expectedReviewVersion: 2, reviewedBy: "editor",
  });
  const episodeId = (await pool.query<{ id: string } & QueryResultRow>(
    "SELECT id FROM episode WHERE project_id = $1 AND episode_no = 1", [projectId],
  )).rows[0]!.id;
  const script = await chain.createScriptRevision({
    workspaceId, projectId, episodeId, sourceStoryRevisionId: story.revisionId,
    content: { scenes: ["intro"] }, createdBy: "author", expectedVersion: 1,
  });
  const scriptReview = await chain.transitionReview({
    table: "script_revision", workspaceId, revisionId: script.revisionId,
    expectedVersion: script.rowVersion, expectedReviewVersion: 1, to: "IN_REVIEW",
  });
  await chain.approveScript({
    workspaceId, episodeId, revisionId: script.revisionId,
    expectedVersion: scriptReview.rowVersion, expectedReviewVersion: 2, reviewedBy: "editor",
  });
  const episodeVersion = (await pool.query<{ row_version: number } & QueryResultRow>(
    "SELECT row_version FROM episode WHERE id = $1", [episodeId],
  )).rows[0]!.row_version;
  return { workspaceId, projectId, episodeId, episodeVersion, scriptRevisionId: script.revisionId };
}

describe("project-scoped Scene / Shot text chain", () => {
  it("creates and reviews a scene and shot, preserving lineage and scoping", async () => {
    const scope = await approvedScript();
    const input = {
      ...scope, sourceScriptRevisionId: scope.scriptRevisionId,
      ordinal: 1, heading: "Opening", summary: "On the court",
      createdBy: "author", expectedVersion: scope.episodeVersion,
    };
    const scene = await tx((client) => chain.createSceneRevisionInTransaction(client, input));
    await expect(tx((client) => chain.createShotScopedInTransaction(client, {
      ...scope, sceneId: scene.entityId, sourceSceneRevisionId: scene.revisionId,
      ordinal: 1, shotType: "WIDE", camera: "static", action: "run",
      promptText: "basketball court", createdBy: "author", expectedVersion: scene.rowVersion,
    }))).rejects.toMatchObject({ code: "REVIEW_REQUIRED" });
    await expect(tx((client) => chain.createSceneRevisionInTransaction(client, {
      ...input, sceneId: scene.entityId, expectedVersion: 1,
    }))).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const sceneReview = await tx((client) => chain.reviewSceneShotInTransaction(client, {
      kind: "scene", ...scope, sceneId: scene.entityId, revisionId: scene.revisionId,
      expectedVersion: scene.rowVersion, expectedReviewVersion: 1,
      to: "IN_REVIEW", reviewedBy: "editor",
    }));
    const sceneApproved = await tx((client) => chain.reviewSceneShotInTransaction(client, {
      kind: "scene", ...scope, sceneId: scene.entityId, revisionId: scene.revisionId,
      expectedVersion: sceneReview.rowVersion, expectedReviewVersion: sceneReview.reviewVersion,
      to: "APPROVED", reviewedBy: "editor",
    }));
    const sceneVersion = (await pool.query<{ row_version: number } & QueryResultRow>(
      "SELECT row_version FROM scene WHERE id = $1", [scene.entityId],
    )).rows[0]!.row_version;
    const shotInput = {
      ...scope, sceneId: scene.entityId, sourceSceneRevisionId: scene.revisionId,
      ordinal: 1, shotType: "WIDE", camera: "static", action: "run", promptText: "basketball court",
      createdBy: "author", expectedVersion: sceneVersion,
    };
    const shot = await tx((client) => chain.createShotScopedInTransaction(client, shotInput));
    const shotReview = await tx((client) => chain.reviewSceneShotInTransaction(client, {
      kind: "shot", ...scope, sceneId: scene.entityId, shotId: shot.entityId,
      revisionId: shot.revisionId, expectedVersion: shot.rowVersion,
      expectedReviewVersion: 1, to: "IN_REVIEW", reviewedBy: "editor",
    }));
    await tx((client) => chain.reviewSceneShotInTransaction(client, {
      kind: "shot", ...scope, sceneId: scene.entityId, shotId: shot.entityId,
      revisionId: shot.revisionId, expectedVersion: shotReview.rowVersion,
      expectedReviewVersion: shotReview.reviewVersion, to: "APPROVED", reviewedBy: "editor",
    }));
    expect((await chain.listSceneRevisions(
      scope.workspaceId, scope.projectId, scope.episodeId, scene.entityId,
    )).items[0]).toMatchObject({ id: scene.revisionId, sourceScriptRevisionId: scope.scriptRevisionId });
    expect((await chain.listShotRevisions(
      scope.workspaceId, scope.projectId, scene.entityId, shot.entityId,
    )).items[0]).toMatchObject({ id: shot.revisionId, sourceSceneRevisionId: scene.revisionId });
    await expect(chain.listShotRevisions(
      scope.workspaceId, "22222222-2222-4222-8222-222222222222", scene.entityId, shot.entityId,
    )).rejects.toMatchObject({ code: "NOT_FOUND" });
    const hash = "ab".repeat(32);
    const assetId = (await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO asset (workspace_id, project_id, kind, storage_provider,
        object_key, mime_type, byte_size, checksum_sha256, source_kind)
       VALUES ($1,$2,'IMAGE','test','shot-stale','image/png',1,$3,'UPLOAD') RETURNING id`,
      [scope.workspaceId, scope.projectId, hash],
    )).rows[0]!.id;
    await pool.query(
      `INSERT INTO asset_revision_dependency
        (workspace_id, project_id, dependent_asset_id, shot_revision_id)
       VALUES ($1,$2,$3,$4)`,
      [scope.workspaceId, scope.projectId, assetId, shot.revisionId],
    );
    const descendants = await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO asset (workspace_id, project_id, kind, storage_provider,
        object_key, mime_type, byte_size, checksum_sha256, source_kind)
       SELECT $1,$2,'IMAGE','test','shot-dependent-' || n,'image/png',1,$3,'UPLOAD'
         FROM generate_series(1,204) n RETURNING id`,
      [scope.workspaceId, scope.projectId, hash],
    );
    await pool.query(
      `INSERT INTO asset_dependency
        (workspace_id, project_id, dependent_asset_id, source_asset_id)
       SELECT $1,$2,child.id,$3 FROM unnest($4::uuid[]) AS child(id)`,
      [scope.workspaceId, scope.projectId, assetId, descendants.rows.map((row) => row.id)],
    );
    const revisedShot = await tx((client) => chain.createShotScopedInTransaction(client, {
      ...shotInput, shotId: shot.entityId, expectedVersion: shotReview.rowVersion + 1,
      action: "jump",
    }));
    expect(revisedShot.revisionNo).toBe(2);
    expect((await pool.query<{ count: number } & QueryResultRow>(
      "SELECT COUNT(*)::int AS count FROM asset WHERE project_id = $1 AND status = 'STALE'",
      [scope.projectId],
    )).rows[0]!.count).toBe(200);
    expect((await pool.query<{ status: string } & QueryResultRow>(
      "SELECT status FROM stale_recalculation WHERE stale_from_ref = $1",
      [`shot_revision:${shot.revisionId}`],
    )).rows[0]!.status).toBe("PENDING");
    await expect(tx((client) => chain.createSceneRevisionInTransaction(client, {
      ...input, sceneId: scene.entityId, expectedVersion: sceneApproved.rowVersion + 1,
      heading: "Blocked during stale propagation",
    }))).rejects.toMatchObject({ code: "SOURCE_STALE" });
    expect(await chain.continueStaleRecalculation()).toBe(true);
    expect((await pool.query<{ count: number } & QueryResultRow>(
      "SELECT COUNT(*)::int AS count FROM asset WHERE project_id = $1 AND status = 'STALE'",
      [scope.projectId],
    )).rows[0]!.count).toBe(205);
    expect((await pool.query<{ status: string } & QueryResultRow>(
      "SELECT status FROM stale_recalculation WHERE stale_from_ref = $1",
      [`shot_revision:${shot.revisionId}`],
    )).rows[0]!.status).toBe("DONE");
    expect((await pool.query<{ status: string } & QueryResultRow>(
      "SELECT status FROM asset WHERE id = $1", [assetId],
    )).rows[0]!.status).toBe("STALE");
    const secondAssetId = (await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO asset (workspace_id, project_id, kind, storage_provider,
        object_key, mime_type, byte_size, checksum_sha256, source_kind)
       VALUES ($1,$2,'IMAGE','test','scene-stale','image/png',1,$3,'UPLOAD') RETURNING id`,
      [scope.workspaceId, scope.projectId, hash],
    )).rows[0]!.id;
    await pool.query(
      `INSERT INTO asset_revision_dependency
        (workspace_id, project_id, dependent_asset_id, shot_revision_id)
       VALUES ($1,$2,$3,$4)`,
      [scope.workspaceId, scope.projectId, secondAssetId, revisedShot.revisionId],
    );
    const newScene = await tx((client) => chain.createSceneRevisionInTransaction(client, {
      ...input, sceneId: scene.entityId, expectedVersion: sceneApproved.rowVersion + 1,
      heading: "Next",
    }));
    expect(newScene.revisionNo).toBe(2);
    expect((await pool.query<{ freshness_status: string } & QueryResultRow>(
      "SELECT freshness_status FROM shot_revision WHERE id = $1", [revisedShot.revisionId],
    )).rows[0]!.freshness_status).toBe("STALE");
    expect((await pool.query<{ status: string } & QueryResultRow>(
      "SELECT status FROM asset WHERE id = $1", [secondAssetId],
    )).rows[0]!.status).toBe("STALE");
  });
});
