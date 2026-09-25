import {
  assertProductionEpisodeSet,
  assertReviewTransition,
  canonicalInputHash,
  type ReviewStatus,
} from "@ai-drama/domain";
import type { PoolClient, QueryResultRow } from "pg";
import { PersistenceError, type DatabasePool } from "./job-service";

export interface RevisionCreated {
  revisionId: string;
  revisionNo: number;
  contentHash: string;
  rowVersion: number;
}

async function withTransaction<T>(pool: DatabasePool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    client.release();
  }
}

async function bumpPointer(
  client: PoolClient,
  table: "project" | "episode" | "character" | "location" | "scene" | "shot",
  id: string,
  workspaceId: string,
  expectedVersion: number,
  column: string,
  revisionId: string,
): Promise<number> {
  const versionColumn = table === "project" ? "row_version" : "row_version";
  const result = await client.query<{ row_version: number } & QueryResultRow>(
    `UPDATE ${table}
        SET ${column} = $4, ${versionColumn} = ${versionColumn} + 1, updated_at = now()
      WHERE id = $1 AND workspace_id = $2 AND ${versionColumn} = $3
      RETURNING ${versionColumn}`,
    [id, workspaceId, expectedVersion, revisionId],
  );
  const row = result.rows[0];
  if (!row) throw new PersistenceError("REVISION_CONFLICT", "Aggregate version did not match");
  return row.row_version;
}

export class TextChainService {
  constructor(private readonly pool: DatabasePool) {}

  async createStoryRevision(input: {
    workspaceId: string;
    projectId: string;
    content: unknown;
    createdBy: string;
    expectedVersion: number;
  }): Promise<RevisionCreated> {
    const contentHash = canonicalInputHash(input.content);
    return withTransaction(this.pool, async (client) => {
      const next = await client.query<{ revision_no: number } & QueryResultRow>(
        `SELECT COALESCE(MAX(revision_no), 0)::int + 1 AS revision_no
           FROM story_revision WHERE project_id = $1 AND workspace_id = $2`,
        [input.projectId, input.workspaceId],
      );
      const revisionNo = next.rows[0]?.revision_no ?? 1;
      const inserted = await client.query<{ id: string } & QueryResultRow>(
        `INSERT INTO story_revision
          (workspace_id, project_id, revision_no, content_json, content_hash, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         RETURNING id`,
        [input.workspaceId, input.projectId, revisionNo, JSON.stringify(input.content), contentHash, input.createdBy],
      );
      const revisionId = inserted.rows[0]?.id;
      if (!revisionId) throw new PersistenceError("REVISION_CREATE_FAILED", "Story revision was not created");
      const rowVersion = await bumpPointer(
        client,
        "project",
        input.projectId,
        input.workspaceId,
        input.expectedVersion,
        "current_story_revision_id",
        revisionId,
      );
      return { revisionId, revisionNo, contentHash, rowVersion };
    });
  }

  async transitionReview(input: ReviewTransition): Promise<number> {
    return withTransaction(this.pool, async (client) => applyReview(client, input));
  }

  async approveStory(input: {
    workspaceId: string;
    projectId: string;
    revisionId: string;
    expectedVersion: number;
    expectedReviewVersion: number;
    reviewedBy: string;
  }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await applyReview(client, {
        table: "story_revision",
        revisionId: input.revisionId,
        workspaceId: input.workspaceId,
        expectedReviewVersion: input.expectedReviewVersion,
        to: "APPROVED",
        reviewedBy: input.reviewedBy,
      });
      const previous = await client.query<{ approved_story_revision_id: string | null } & QueryResultRow>(
        `SELECT approved_story_revision_id FROM project WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
        [input.projectId, input.workspaceId],
      );
      const previousId = previous.rows[0]?.approved_story_revision_id ?? null;
      await bumpPointer(
        client,
        "project",
        input.projectId,
        input.workspaceId,
        input.expectedVersion,
        "approved_story_revision_id",
        input.revisionId,
      );
      await ensureEpisodes(client, input.workspaceId, input.projectId);
      if (previousId && previousId !== input.revisionId) {
        await staleFromStory(client, input.workspaceId, previousId);
      }
    });
  }

  async assertProductionEpisodes(workspaceId: string, projectId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      const rows = await client.query<{ episode_no: number } & QueryResultRow>(
        `SELECT episode_no FROM episode WHERE workspace_id = $1 AND project_id = $2`,
        [workspaceId, projectId],
      );
      assertProductionEpisodeSet(rows.rows.map((row) => row.episode_no));
    } finally {
      client.release();
    }
  }

  async createScriptRevision(input: {
    workspaceId: string;
    projectId: string;
    episodeId: string;
    sourceStoryRevisionId: string;
    content: unknown;
    createdBy: string;
    expectedVersion: number;
  }): Promise<RevisionCreated> {
    const contentHash = canonicalInputHash(input.content);
    return withTransaction(this.pool, async (client) => {
      const next = await client.query<{ revision_no: number } & QueryResultRow>(
        `SELECT COALESCE(MAX(revision_no), 0)::int + 1 AS revision_no FROM script_revision WHERE episode_id = $1`,
        [input.episodeId],
      );
      const revisionNo = next.rows[0]?.revision_no ?? 1;
      const inserted = await client.query<{ id: string } & QueryResultRow>(
        `INSERT INTO script_revision
          (workspace_id, project_id, episode_id, revision_no, source_story_revision_id, content_json, content_hash, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
         RETURNING id`,
        [
          input.workspaceId,
          input.projectId,
          input.episodeId,
          revisionNo,
          input.sourceStoryRevisionId,
          JSON.stringify(input.content),
          contentHash,
          input.createdBy,
        ],
      );
      const revisionId = inserted.rows[0]?.id;
      if (!revisionId) throw new PersistenceError("REVISION_CREATE_FAILED", "Script revision was not created");
      const rowVersion = await bumpPointer(
        client,
        "episode",
        input.episodeId,
        input.workspaceId,
        input.expectedVersion,
        "current_script_revision_id",
        revisionId,
      );
      return { revisionId, revisionNo, contentHash, rowVersion };
    });
  }

  async approveScript(input: {
    workspaceId: string;
    episodeId: string;
    revisionId: string;
    expectedVersion: number;
    expectedReviewVersion: number;
    reviewedBy: string;
  }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await applyReview(client, {
        table: "script_revision",
        revisionId: input.revisionId,
        workspaceId: input.workspaceId,
        expectedReviewVersion: input.expectedReviewVersion,
        to: "APPROVED",
        reviewedBy: input.reviewedBy,
      });
      const previous = await client.query<{ approved_script_revision_id: string | null } & QueryResultRow>(
        `SELECT approved_script_revision_id FROM episode WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
        [input.episodeId, input.workspaceId],
      );
      const previousId = previous.rows[0]?.approved_script_revision_id ?? null;
      await bumpPointer(
        client,
        "episode",
        input.episodeId,
        input.workspaceId,
        input.expectedVersion,
        "approved_script_revision_id",
        input.revisionId,
      );
      if (previousId && previousId !== input.revisionId) {
        await staleFromScript(client, input.workspaceId, previousId);
      }
    });
  }

  async createShotRevision(input: {
    workspaceId: string;
    projectId: string;
    sceneId: string;
    shotId: string;
    sourceSceneRevisionId: string;
    ordinal: number;
    shotType: string;
    camera: string;
    action: string;
    dialogue: string | null;
    durationHint: string | null;
    promptText: string;
    createdBy: string;
    expectedVersion: number;
  }): Promise<RevisionCreated> {
    const contentHash = canonicalInputHash({
      schema: "m2.shot.revision.v1",
      sourceSceneRevisionId: input.sourceSceneRevisionId,
      ordinal: input.ordinal,
      shotType: input.shotType,
      camera: input.camera,
      action: input.action,
      dialogue: input.dialogue,
      durationHint: input.durationHint,
      promptText: input.promptText,
    });
    return withTransaction(this.pool, async (client) => {
      const next = await client.query<{ revision_no: number } & QueryResultRow>(
        `SELECT COALESCE(MAX(revision_no), 0)::int + 1 AS revision_no FROM shot_revision WHERE shot_id = $1`,
        [input.shotId],
      );
      const revisionNo = next.rows[0]?.revision_no ?? 1;
      const inserted = await client.query<{ id: string } & QueryResultRow>(
        `INSERT INTO shot_revision
          (workspace_id, project_id, scene_id, shot_id, revision_no, source_scene_revision_id,
           ordinal, shot_type, camera, action, dialogue, duration_hint, prompt_text, content_hash, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING id`,
        [
          input.workspaceId,
          input.projectId,
          input.sceneId,
          input.shotId,
          revisionNo,
          input.sourceSceneRevisionId,
          input.ordinal,
          input.shotType,
          input.camera,
          input.action,
          input.dialogue,
          input.durationHint,
          input.promptText,
          contentHash,
          input.createdBy,
        ],
      );
      const revisionId = inserted.rows[0]?.id;
      if (!revisionId) throw new PersistenceError("REVISION_CREATE_FAILED", "Shot revision was not created");
      const rowVersion = await bumpPointer(
        client,
        "shot",
        input.shotId,
        input.workspaceId,
        input.expectedVersion,
        "current_revision_id",
        revisionId,
      );
      return { revisionId, revisionNo, contentHash, rowVersion };
    });
  }
}

interface ReviewTransition {
  table: "story_revision" | "script_revision" | "character_revision" | "location_revision" | "scene_revision" | "shot_revision";
  revisionId: string;
  workspaceId: string;
  expectedReviewVersion: number;
  to: ReviewStatus;
  reviewedBy?: string;
  reviewNote?: string | null;
}

async function applyReview(client: PoolClient, input: ReviewTransition): Promise<number> {
  const current = await client.query<{ review_status: ReviewStatus } & QueryResultRow>(
    `SELECT review_status FROM ${input.table} WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
    [input.revisionId, input.workspaceId],
  );
  const row = current.rows[0];
  if (!row) throw new PersistenceError("NOT_FOUND", "Revision not found");
  assertReviewTransition(row.review_status, input.to);
  const reviewed = input.to === "APPROVED" || input.to === "REJECTED";
  const updated = await client.query<{ review_version: number } & QueryResultRow>(
    `UPDATE ${input.table}
        SET review_status = $4,
            review_version = review_version + 1,
            reviewed_by = CASE WHEN $5::boolean THEN $6 ELSE reviewed_by END,
            reviewed_at = CASE WHEN $5::boolean THEN now() ELSE reviewed_at END,
            review_note = CASE WHEN $5::boolean THEN $7 ELSE review_note END,
            reviewed_content_hash = CASE WHEN $5::boolean THEN content_hash ELSE reviewed_content_hash END
      WHERE id = $1 AND workspace_id = $2 AND review_version = $3
      RETURNING review_version`,
    [
      input.revisionId,
      input.workspaceId,
      input.expectedReviewVersion,
      input.to,
      reviewed,
      input.reviewedBy ?? null,
      input.reviewNote ?? null,
    ],
  );
  const version = updated.rows[0]?.review_version;
  if (!version) throw new PersistenceError("REVISION_CONFLICT", "Review version did not match");
  return version;
}

async function ensureEpisodes(client: PoolClient, workspaceId: string, projectId: string): Promise<void> {
  await client.query(
    `INSERT INTO episode (workspace_id, project_id, episode_no, title)
     SELECT $1, $2, episode_no, 'Episode ' || episode_no::text
       FROM (VALUES (1), (2), (3)) AS required(episode_no)
     ON CONFLICT (project_id, episode_no) DO NOTHING`,
    [workspaceId, projectId],
  );
  const rows = await client.query<{ episode_no: number } & QueryResultRow>(
    `SELECT episode_no FROM episode WHERE workspace_id = $1 AND project_id = $2`,
    [workspaceId, projectId],
  );
  assertProductionEpisodeSet(rows.rows.map((row) => row.episode_no));
}

async function markStale(client: PoolClient, table: string, idsSql: string, params: unknown[]): Promise<void> {
  await client.query(
    `UPDATE ${table}
        SET freshness_status = 'STALE', review_version = review_version + 1
      WHERE workspace_id = $1 AND freshness_status = 'CURRENT' AND id IN (${idsSql})`,
    params,
  );
}

async function staleFromStory(client: PoolClient, workspaceId: string, storyRevisionId: string): Promise<void> {
  await markStale(
    client,
    "script_revision",
    `SELECT id FROM script_revision WHERE workspace_id = $1 AND source_story_revision_id = $2`,
    [workspaceId, storyRevisionId],
  );
  await markStale(
    client,
    "scene_revision",
    `SELECT scene_revision.id FROM scene_revision
       JOIN script_revision ON script_revision.id = scene_revision.source_script_revision_id
      WHERE script_revision.workspace_id = $1 AND script_revision.source_story_revision_id = $2`,
    [workspaceId, storyRevisionId],
  );
  await markStale(
    client,
    "shot_revision",
    `SELECT shot_revision.id FROM shot_revision
       JOIN scene_revision ON scene_revision.id = shot_revision.source_scene_revision_id
       JOIN script_revision ON script_revision.id = scene_revision.source_script_revision_id
      WHERE script_revision.workspace_id = $1 AND script_revision.source_story_revision_id = $2`,
    [workspaceId, storyRevisionId],
  );
  await markStale(
    client,
    "character_revision",
    `SELECT character_revision_id FROM character_revision_script_source
      WHERE workspace_id = $1 AND script_revision_id IN (
        SELECT id FROM script_revision WHERE workspace_id = $1 AND source_story_revision_id = $2
      )`,
    [workspaceId, storyRevisionId],
  );
  await markStale(
    client,
    "location_revision",
    `SELECT location_revision_id FROM location_revision_script_source
      WHERE workspace_id = $1 AND script_revision_id IN (
        SELECT id FROM script_revision WHERE workspace_id = $1 AND source_story_revision_id = $2
      )`,
    [workspaceId, storyRevisionId],
  );
}

async function staleFromScript(client: PoolClient, workspaceId: string, scriptRevisionId: string): Promise<void> {
  await markStale(
    client,
    "scene_revision",
    `SELECT id FROM scene_revision WHERE workspace_id = $1 AND source_script_revision_id = $2`,
    [workspaceId, scriptRevisionId],
  );
  await markStale(
    client,
    "shot_revision",
    `SELECT shot_revision.id FROM shot_revision
       JOIN scene_revision ON scene_revision.id = shot_revision.source_scene_revision_id
      WHERE scene_revision.workspace_id = $1 AND scene_revision.source_script_revision_id = $2`,
    [workspaceId, scriptRevisionId],
  );
  await markStale(
    client,
    "character_revision",
    `SELECT character_revision_id FROM character_revision_script_source
      WHERE workspace_id = $1 AND script_revision_id = $2`,
    [workspaceId, scriptRevisionId],
  );
  await markStale(
    client,
    "location_revision",
    `SELECT location_revision_id FROM location_revision_script_source
      WHERE workspace_id = $1 AND script_revision_id = $2`,
    [workspaceId, scriptRevisionId],
  );
}
