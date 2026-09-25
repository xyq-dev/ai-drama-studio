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

async function lockAggregateForRevision(
  client: PoolClient,
  table: "project" | "episode" | "shot",
  id: string,
  workspaceId: string,
  expectedVersion: number,
): Promise<void> {
  const versionColumn = table === "project" ? "version" : "row_version";
  const result = await client.query<{ aggregate_version: number } & QueryResultRow>(
    `SELECT ${versionColumn} AS aggregate_version FROM ${table}
      WHERE id = $1 AND workspace_id = $2
      FOR UPDATE`,
    [id, workspaceId],
  );
  const row = result.rows[0];
  if (!row) throw new PersistenceError("NOT_FOUND", "Aggregate not found");
  if (row.aggregate_version !== expectedVersion) {
    throw new PersistenceError("REVISION_CONFLICT", "Aggregate version did not match");
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
  const versionColumn = table === "project" ? "version" : "row_version";
  const result = await client.query<{ aggregate_version: number } & QueryResultRow>(
    `UPDATE ${table}
        SET ${column} = $4, ${versionColumn} = ${versionColumn} + 1, updated_at = now()
      WHERE id = $1 AND workspace_id = $2 AND ${versionColumn} = $3
      RETURNING ${versionColumn} AS aggregate_version`,
    [id, workspaceId, expectedVersion, revisionId],
  );
  const row = result.rows[0];
  if (!row) throw new PersistenceError("REVISION_CONFLICT", "Aggregate version did not match");
  return row.aggregate_version;
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
      await lockAggregateForRevision(client, "project", input.projectId, input.workspaceId, input.expectedVersion);
      const previousCurrent = await client.query<{ current_story_revision_id: string | null } & QueryResultRow>(
        "SELECT current_story_revision_id FROM project WHERE id = $1 AND workspace_id = $2",
        [input.projectId, input.workspaceId],
      );
      const previousCurrentId = previousCurrent.rows[0]?.current_story_revision_id ?? null;
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
      if (previousCurrentId && previousCurrentId !== revisionId) {
        await staleFromStory(client, input.workspaceId, previousCurrentId);
      }
      return { revisionId, revisionNo, contentHash, rowVersion };
    });
  }

  async transitionReview(input: ReviewTransition): Promise<number> {
    if (input.to === "APPROVED") {
      throw new PersistenceError("REVIEW_GATE_REQUIRED", "Approval must use the aggregate-specific review gate");
    }
    return withTransaction(this.pool, async (client) => {
      await lockParentForReview(client, input);
      return applyReview(client, input);
    });
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
      const project = await client.query<
        {
          version: number;
          current_story_revision_id: string | null;
          approved_story_revision_id: string | null;
        } & QueryResultRow
      >(
        `SELECT version, current_story_revision_id, approved_story_revision_id
           FROM project WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
        [input.projectId, input.workspaceId],
      );
      const projectRow = project.rows[0];
      if (!projectRow) throw new PersistenceError("NOT_FOUND", "Project not found");
      if (projectRow.version !== input.expectedVersion) {
        throw new PersistenceError("REVISION_CONFLICT", "Aggregate version did not match");
      }
      if (projectRow.current_story_revision_id !== input.revisionId) {
        throw new PersistenceError("REVISION_CONFLICT", "Only the current story revision can be approved");
      }
      const previousId = projectRow.approved_story_revision_id;

      await applyReview(client, {
        table: "story_revision",
        revisionId: input.revisionId,
        workspaceId: input.workspaceId,
        expectedVersion: input.expectedVersion,
        expectedReviewVersion: input.expectedReviewVersion,
        to: "APPROVED",
        reviewedBy: input.reviewedBy,
      });
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
      await lockAggregateForRevision(client, "episode", input.episodeId, input.workspaceId, input.expectedVersion);
      await lockProject(client, input.projectId, input.workspaceId);
      const currentScript = await client.query<{ current_script_revision_id: string | null } & QueryResultRow>(
        "SELECT current_script_revision_id FROM episode WHERE id = $1 AND workspace_id = $2",
        [input.episodeId, input.workspaceId],
      );
      const currentScriptId = currentScript.rows[0]?.current_script_revision_id;
      if (currentScriptId) {
        await client.query("SELECT id FROM script_revision WHERE id = $1 AND workspace_id = $2 FOR UPDATE", [
          currentScriptId,
          input.workspaceId,
        ]);
      }
      const source = await client.query<
        {
          current_script_revision_id: string | null;
          current_story_revision_id: string | null;
          approved_story_revision_id: string | null;
          review_status: string;
          freshness_status: string;
        } & QueryResultRow
      >(
        `SELECT e.current_script_revision_id,
                p.current_story_revision_id,
                p.approved_story_revision_id,
                sr.review_status,
                sr.freshness_status
           FROM episode e
           JOIN project p
             ON p.id = e.project_id
            AND p.workspace_id = e.workspace_id
           JOIN story_revision sr
             ON sr.id = $4
            AND sr.project_id = e.project_id
            AND sr.workspace_id = e.workspace_id
          WHERE e.id = $1 AND e.workspace_id = $2 AND e.project_id = $3`,
        [input.episodeId, input.workspaceId, input.projectId, input.sourceStoryRevisionId],
      );
      const sourceRow = source.rows[0];
      if (!sourceRow) throw new PersistenceError("NOT_FOUND", "Episode or source story revision not found");
      if (
        sourceRow.current_story_revision_id !== input.sourceStoryRevisionId ||
        sourceRow.approved_story_revision_id !== input.sourceStoryRevisionId ||
        sourceRow.review_status !== "APPROVED" ||
        sourceRow.freshness_status !== "CURRENT"
      ) {
        throw new PersistenceError("REVIEW_REQUIRED", "Scripts require the current approved story revision");
      }
      const previousCurrentId = sourceRow.current_script_revision_id;
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
      if (previousCurrentId && previousCurrentId !== revisionId) {
        await staleFromScript(client, input.workspaceId, previousCurrentId);
      }
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
      await lockAggregateForRevision(client, "episode", input.episodeId, input.workspaceId, input.expectedVersion);
      const source = await client.query<
        {
          freshness_status: string;
          source_story_revision_id: string;
          current_script_revision_id: string | null;
          current_story_revision_id: string | null;
          approved_story_revision_id: string | null;
          source_review_status: string;
          source_freshness_status: string;
        } & QueryResultRow
      >(
        `SELECT sr.freshness_status, sr.source_story_revision_id,
                e.current_script_revision_id,
                p.current_story_revision_id,
                p.approved_story_revision_id,
                source.review_status AS source_review_status,
                source.freshness_status AS source_freshness_status
           FROM script_revision sr
           JOIN episode e
             ON e.id = sr.episode_id
            AND e.workspace_id = sr.workspace_id
            AND e.project_id = sr.project_id
           JOIN project p
             ON p.id = sr.project_id
            AND p.workspace_id = sr.workspace_id
           JOIN story_revision source
             ON source.id = sr.source_story_revision_id
            AND source.project_id = sr.project_id
            AND source.workspace_id = sr.workspace_id
          WHERE sr.id = $1 AND sr.episode_id = $2 AND sr.workspace_id = $3
          FOR UPDATE OF sr`,
        [input.revisionId, input.episodeId, input.workspaceId],
      );
      const sourceRow = source.rows[0];
      if (!sourceRow) throw new PersistenceError("NOT_FOUND", "Script revision not found");
      if (sourceRow.current_script_revision_id !== input.revisionId) {
        throw new PersistenceError("REVISION_CONFLICT", "Only the current script revision can be approved");
      }
      if (sourceRow.freshness_status !== "CURRENT") {
        throw new PersistenceError("SOURCE_STALE", "Stale script revision cannot be approved");
      }
      if (
        sourceRow.current_story_revision_id !== sourceRow.source_story_revision_id ||
        sourceRow.approved_story_revision_id !== sourceRow.source_story_revision_id ||
        sourceRow.source_review_status !== "APPROVED" ||
        sourceRow.source_freshness_status !== "CURRENT"
      ) {
        throw new PersistenceError("REVIEW_REQUIRED", "Script source must be the current approved story revision");
      }

      await applyReview(client, {
        table: "script_revision",
        revisionId: input.revisionId,
        workspaceId: input.workspaceId,
        expectedVersion: input.expectedVersion,
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

  async approveCharacter(input: AggregateApproval): Promise<void> {
    await approveEntityRevision(this.pool, { ...input, parentTable: "character", revisionTable: "character_revision" });
  }

  async approveLocation(input: AggregateApproval): Promise<void> {
    await approveEntityRevision(this.pool, { ...input, parentTable: "location", revisionTable: "location_revision" });
  }

  async approveScene(input: AggregateApproval): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const parentId = await lockCurrentRevision(client, {
        parentTable: "scene",
        revisionTable: "scene_revision",
        parentId: input.parentId,
        revisionId: input.revisionId,
        workspaceId: input.workspaceId,
        expectedVersion: input.expectedVersion,
      });
      const source = await client.query<{ ok: boolean } & QueryResultRow>(
        `SELECT (
            e.current_script_revision_id = sr.source_script_revision_id
            AND e.approved_script_revision_id = sr.source_script_revision_id
            AND script.review_status = 'APPROVED'
            AND script.freshness_status = 'CURRENT'
            AND (
              sr.location_revision_id IS NULL
              OR (
                loc.current_revision_id = sr.location_revision_id
                AND loc.approved_revision_id = sr.location_revision_id
                AND location_revision.review_status = 'APPROVED'
                AND location_revision.freshness_status = 'CURRENT'
              )
            )
          ) AS ok
           FROM scene_revision sr
           JOIN episode e ON e.id = sr.episode_id AND e.workspace_id = sr.workspace_id
           JOIN script_revision script ON script.id = sr.source_script_revision_id
           LEFT JOIN location_revision ON location_revision.id = sr.location_revision_id
           LEFT JOIN location loc ON loc.id = location_revision.location_id
          WHERE sr.id = $1 AND sr.scene_id = $2 AND sr.workspace_id = $3`,
        [input.revisionId, parentId, input.workspaceId],
      );
      if (source.rows[0]?.ok !== true) {
        throw new PersistenceError("REVIEW_REQUIRED", "Scene source must be the current approved script revision");
      }
      await finishApproval(client, input, "scene", "scene_revision");
    });
  }

  async approveShot(input: AggregateApproval): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const parentId = await lockCurrentRevision(client, {
        parentTable: "shot",
        revisionTable: "shot_revision",
        parentId: input.parentId,
        revisionId: input.revisionId,
        workspaceId: input.workspaceId,
        expectedVersion: input.expectedVersion,
      });
      const source = await client.query<{ ok: boolean } & QueryResultRow>(
        `SELECT (
            scene.current_revision_id = shot_revision.source_scene_revision_id
            AND scene.approved_revision_id = shot_revision.source_scene_revision_id
            AND scene_revision.review_status = 'APPROVED'
            AND scene_revision.freshness_status = 'CURRENT'
          ) AS ok
           FROM shot_revision
           JOIN scene ON scene.id = shot_revision.scene_id AND scene.workspace_id = shot_revision.workspace_id
           JOIN scene_revision ON scene_revision.id = shot_revision.source_scene_revision_id
          WHERE shot_revision.id = $1 AND shot_revision.shot_id = $2 AND shot_revision.workspace_id = $3`,
        [input.revisionId, parentId, input.workspaceId],
      );
      if (source.rows[0]?.ok !== true) {
        throw new PersistenceError("REVIEW_REQUIRED", "Shot source must be the current approved scene revision");
      }
      await finishApproval(client, input, "shot", "shot_revision");
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
      await lockAggregateForRevision(client, "shot", input.shotId, input.workspaceId, input.expectedVersion);
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
  expectedVersion: number;
  expectedReviewVersion: number;
  to: ReviewStatus;
  reviewedBy?: string;
  reviewNote?: string | null;
}

const reviewParents = {
  story_revision: {
    parentTable: "project",
    parentColumn: "project_id",
    versionColumn: "version",
    currentColumn: "current_story_revision_id",
  },
  script_revision: {
    parentTable: "episode",
    parentColumn: "episode_id",
    versionColumn: "row_version",
    currentColumn: "current_script_revision_id",
  },
  character_revision: {
    parentTable: "character",
    parentColumn: "character_id",
    versionColumn: "row_version",
    currentColumn: "current_revision_id",
  },
  location_revision: {
    parentTable: "location",
    parentColumn: "location_id",
    versionColumn: "row_version",
    currentColumn: "current_revision_id",
  },
  scene_revision: {
    parentTable: "scene",
    parentColumn: "scene_id",
    versionColumn: "row_version",
    currentColumn: "current_revision_id",
  },
  shot_revision: {
    parentTable: "shot",
    parentColumn: "shot_id",
    versionColumn: "row_version",
    currentColumn: "current_revision_id",
  },
} as const;

async function lockParentForReview(client: PoolClient, input: ReviewTransition): Promise<void> {
  const parent = reviewParents[input.table];
  const located = await client.query<{ parent_id: string } & QueryResultRow>(
    `SELECT ${parent.parentColumn} AS parent_id FROM ${input.table} WHERE id = $1 AND workspace_id = $2`,
    [input.revisionId, input.workspaceId],
  );
  const parentId = located.rows[0]?.parent_id;
  if (!parentId) throw new PersistenceError("NOT_FOUND", "Revision not found");
  const locked = await client.query<{ aggregate_version: number; current_revision_id: string | null } & QueryResultRow>(
    `SELECT ${parent.versionColumn} AS aggregate_version, ${parent.currentColumn} AS current_revision_id
       FROM ${parent.parentTable}
      WHERE id = $1 AND workspace_id = $2
      FOR UPDATE`,
    [parentId, input.workspaceId],
  );
  const row = locked.rows[0];
  if (!row) throw new PersistenceError("NOT_FOUND", "Aggregate not found");
  if (row.aggregate_version !== input.expectedVersion) {
    throw new PersistenceError("REVISION_CONFLICT", "Aggregate version did not match");
  }
  if (row.current_revision_id !== input.revisionId) {
    throw new PersistenceError("REVISION_CONFLICT", "Only the current revision can change review state");
  }
}

async function applyReview(client: PoolClient, input: ReviewTransition): Promise<number> {
  const current = await client.query<
    { review_status: ReviewStatus; freshness_status: string; project_id: string } & QueryResultRow
  >(
    `SELECT review_status, freshness_status, project_id FROM ${input.table} WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
    [input.revisionId, input.workspaceId],
  );
  const row = current.rows[0];
  if (!row) throw new PersistenceError("NOT_FOUND", "Revision not found");
  if (row.freshness_status !== "CURRENT") {
    throw new PersistenceError("SOURCE_STALE", "Stale revision cannot change review state");
  }
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
  const aggregateType = input.table
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  await client.query(
    `INSERT INTO domain_event
      (workspace_id, project_id, aggregate_type, aggregate_id, event_type, payload_json, trace_id)
     VALUES ($1, $2, $3, $4, 'revision.review', $5::jsonb, 'm2-text-chain')`,
    [
      input.workspaceId,
      row.project_id,
      aggregateType,
      input.revisionId,
      JSON.stringify({
        revisionId: input.revisionId,
        reviewStatus: input.to,
        reviewVersion: version,
      }),
    ],
  );
  return version;
}

interface AggregateApproval {
  workspaceId: string;
  parentId: string;
  revisionId: string;
  expectedVersion: number;
  expectedReviewVersion: number;
  reviewedBy: string;
}

async function lockProject(client: PoolClient, projectId: string, workspaceId: string): Promise<void> {
  const locked = await client.query(
    "SELECT id FROM project WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
    [projectId, workspaceId],
  );
  if (!locked.rows[0]) throw new PersistenceError("NOT_FOUND", "Project not found");
}

async function lockCurrentRevision(
  client: PoolClient,
  input: {
    parentTable: "character" | "location" | "scene" | "shot";
    revisionTable: "character_revision" | "location_revision" | "scene_revision" | "shot_revision";
    parentId: string;
    revisionId: string;
    workspaceId: string;
    expectedVersion: number;
  },
): Promise<string> {
  const parent = await client.query<{ row_version: number; current_revision_id: string | null } & QueryResultRow>(
    `SELECT row_version, current_revision_id FROM ${input.parentTable}
      WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
    [input.parentId, input.workspaceId],
  );
  const row = parent.rows[0];
  if (!row) throw new PersistenceError("NOT_FOUND", "Aggregate not found");
  if (row.row_version !== input.expectedVersion) {
    throw new PersistenceError("REVISION_CONFLICT", "Aggregate version did not match");
  }
  if (row.current_revision_id !== input.revisionId) {
    throw new PersistenceError("REVISION_CONFLICT", "Only the current revision can be approved");
  }
  const owned = await client.query(
    `SELECT id FROM ${input.revisionTable} WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
    [input.revisionId, input.workspaceId],
  );
  if (!owned.rows[0]) throw new PersistenceError("NOT_FOUND", "Revision not found");
  return input.parentId;
}

async function finishApproval(
  client: PoolClient,
  input: AggregateApproval,
  parentTable: "character" | "location" | "scene" | "shot",
  revisionTable: ReviewTransition["table"],
): Promise<void> {
  await applyReview(client, {
    table: revisionTable,
    revisionId: input.revisionId,
    workspaceId: input.workspaceId,
    expectedVersion: input.expectedVersion,
    expectedReviewVersion: input.expectedReviewVersion,
    to: "APPROVED",
    reviewedBy: input.reviewedBy,
  });
  await bumpPointer(
    client,
    parentTable,
    input.parentId,
    input.workspaceId,
    input.expectedVersion,
    "approved_revision_id",
    input.revisionId,
  );
}

async function approveEntityRevision(
  pool: DatabasePool,
  input: AggregateApproval & {
    parentTable: "character" | "location";
    revisionTable: "character_revision" | "location_revision";
  },
): Promise<void> {
  const edgeTable =
    input.parentTable === "character" ? "character_revision_script_source" : "location_revision_script_source";
  const edgeColumn = input.parentTable === "character" ? "character_revision_id" : "location_revision_id";
  await withTransaction(pool, async (client) => {
    await lockCurrentRevision(client, input);
    const invalid = await client.query(
      `SELECT 1
         FROM ${edgeTable} edge
         JOIN script_revision sr ON sr.id = edge.script_revision_id
         JOIN episode e ON e.id = sr.episode_id AND e.workspace_id = sr.workspace_id
        WHERE edge.${edgeColumn} = $1
          AND edge.workspace_id = $2
          AND (
            e.current_script_revision_id IS DISTINCT FROM sr.id
            OR e.approved_script_revision_id IS DISTINCT FROM sr.id
            OR sr.review_status <> 'APPROVED'
            OR sr.freshness_status <> 'CURRENT'
          )
        LIMIT 1`,
      [input.revisionId, input.workspaceId],
    );
    if (invalid.rows[0]) {
      throw new PersistenceError("REVIEW_REQUIRED", "Entity source must be a current approved script revision");
    }
    await finishApproval(client, input, input.parentTable, input.revisionTable);
  });
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

async function markStale(
  client: PoolClient,
  table: string,
  idsSql: string,
  params: unknown[],
  reason: string,
  staleFromRef: string,
): Promise<void> {
  const reasonParam = params.length + 1;
  const refParam = params.length + 2;
  const updated = await client.query<{ id: string; project_id: string } & QueryResultRow>(
    `UPDATE ${table}
        SET freshness_status = 'STALE',
            review_version = review_version + 1,
            stale_reason = COALESCE(stale_reason, $${reasonParam}),
            stale_from_ref = COALESCE(stale_from_ref, $${refParam})
      WHERE workspace_id = $1 AND freshness_status = 'CURRENT' AND id IN (${idsSql})
      RETURNING id, project_id`,
    [...params, reason, staleFromRef],
  );
  const aggregateType = table
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  for (const row of updated.rows) {
    await client.query(
      `INSERT INTO domain_event
        (workspace_id, project_id, aggregate_type, aggregate_id, event_type, payload_json, trace_id)
       VALUES ($1, $2, $3, $4, 'revision.stale', $5::jsonb, 'm2-text-chain')`,
      [
        params[0],
        row.project_id,
        aggregateType,
        row.id,
        JSON.stringify({
          revisionId: row.id,
          freshnessStatus: "STALE",
          staleReason: reason,
          staleFromRef,
        }),
      ],
    );
  }
}

async function staleFromStory(client: PoolClient, workspaceId: string, storyRevisionId: string): Promise<void> {
  const reason = "SOURCE_STORY_REPLACED";
  const staleFromRef = `story_revision:${storyRevisionId}`;
  await markStale(
    client,
    "script_revision",
    `SELECT id FROM script_revision WHERE workspace_id = $1 AND source_story_revision_id = $2`,
    [workspaceId, storyRevisionId],
    reason,
    staleFromRef,
  );
  await markStale(
    client,
    "scene_revision",
    `SELECT scene_revision.id FROM scene_revision
       JOIN script_revision ON script_revision.id = scene_revision.source_script_revision_id
      WHERE script_revision.workspace_id = $1 AND script_revision.source_story_revision_id = $2`,
    [workspaceId, storyRevisionId],
    reason,
    staleFromRef,
  );
  await markStale(
    client,
    "shot_revision",
    `SELECT shot_revision.id FROM shot_revision
       JOIN scene_revision ON scene_revision.id = shot_revision.source_scene_revision_id
       JOIN script_revision ON script_revision.id = scene_revision.source_script_revision_id
      WHERE script_revision.workspace_id = $1 AND script_revision.source_story_revision_id = $2`,
    [workspaceId, storyRevisionId],
    reason,
    staleFromRef,
  );
  await markStale(
    client,
    "character_revision",
    `SELECT character_revision_id FROM character_revision_script_source
      WHERE workspace_id = $1 AND script_revision_id IN (
        SELECT id FROM script_revision WHERE workspace_id = $1 AND source_story_revision_id = $2
      )`,
    [workspaceId, storyRevisionId],
    reason,
    staleFromRef,
  );
  await markStale(
    client,
    "location_revision",
    `SELECT location_revision_id FROM location_revision_script_source
      WHERE workspace_id = $1 AND script_revision_id IN (
        SELECT id FROM script_revision WHERE workspace_id = $1 AND source_story_revision_id = $2
      )`,
    [workspaceId, storyRevisionId],
    reason,
    staleFromRef,
  );
  await staleSharedDescendants(
    client,
    reason,
    staleFromRef,
    [workspaceId, storyRevisionId],
    `SELECT location_revision_id FROM location_revision_script_source
      WHERE workspace_id = $1 AND script_revision_id IN (
        SELECT id FROM script_revision WHERE workspace_id = $1 AND source_story_revision_id = $2
      )`,
    `SELECT character_revision_id FROM character_revision_script_source
      WHERE workspace_id = $1 AND script_revision_id IN (
        SELECT id FROM script_revision WHERE workspace_id = $1 AND source_story_revision_id = $2
      )`,
  );
}

async function staleFromScript(client: PoolClient, workspaceId: string, scriptRevisionId: string): Promise<void> {
  const reason = "SOURCE_SCRIPT_REPLACED";
  const staleFromRef = `script_revision:${scriptRevisionId}`;
  await markStale(
    client,
    "scene_revision",
    `SELECT id FROM scene_revision WHERE workspace_id = $1 AND source_script_revision_id = $2`,
    [workspaceId, scriptRevisionId],
    reason,
    staleFromRef,
  );
  await markStale(
    client,
    "shot_revision",
    `SELECT shot_revision.id FROM shot_revision
       JOIN scene_revision ON scene_revision.id = shot_revision.source_scene_revision_id
      WHERE scene_revision.workspace_id = $1 AND scene_revision.source_script_revision_id = $2`,
    [workspaceId, scriptRevisionId],
    reason,
    staleFromRef,
  );
  await markStale(
    client,
    "character_revision",
    `SELECT character_revision_id FROM character_revision_script_source
      WHERE workspace_id = $1 AND script_revision_id = $2`,
    [workspaceId, scriptRevisionId],
    reason,
    staleFromRef,
  );
  await markStale(
    client,
    "location_revision",
    `SELECT location_revision_id FROM location_revision_script_source
      WHERE workspace_id = $1 AND script_revision_id = $2`,
    [workspaceId, scriptRevisionId],
    reason,
    staleFromRef,
  );
  await staleSharedDescendants(
    client,
    reason,
    staleFromRef,
    [workspaceId, scriptRevisionId],
    `SELECT location_revision_id FROM location_revision_script_source
      WHERE workspace_id = $1 AND script_revision_id = $2`,
    `SELECT character_revision_id FROM character_revision_script_source
      WHERE workspace_id = $1 AND script_revision_id = $2`,
  );
}

async function staleSharedDescendants(
  client: PoolClient,
  reason: string,
  staleFromRef: string,
  params: unknown[],
  locationIdsSql: string,
  characterIdsSql: string,
): Promise<void> {
  await markStale(
    client,
    "scene_revision",
    `SELECT id FROM scene_revision
      WHERE workspace_id = $1 AND location_revision_id IN (${locationIdsSql})`,
    params,
    reason,
    staleFromRef,
  );
  await markStale(
    client,
    "shot_revision",
    `SELECT shot_revision.id FROM shot_revision
       JOIN scene_revision ON scene_revision.id = shot_revision.source_scene_revision_id
        AND scene_revision.workspace_id = shot_revision.workspace_id
        AND scene_revision.project_id = shot_revision.project_id
      WHERE shot_revision.workspace_id = $1
        AND scene_revision.location_revision_id IN (${locationIdsSql})`,
    params,
    reason,
    staleFromRef,
  );
  await markStale(
    client,
    "shot_revision",
    `SELECT shot_revision_id FROM shot_character_reference
      WHERE workspace_id = $1 AND character_revision_id IN (${characterIdsSql})`,
    params,
    reason,
    staleFromRef,
  );
}
