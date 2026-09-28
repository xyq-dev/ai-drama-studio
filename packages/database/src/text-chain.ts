import {
  assertProductionEpisodeSet,
  assertReviewTransition,
  canonicalInputHash,
  type ReviewStatus,
} from "@ai-drama/domain";
import type { PoolClient, QueryResultRow } from "pg";
import { PersistenceError, type DatabasePool } from "./job-service";
import {
  affectedScriptConsumerIds,
  insertScriptDependencies,
  validateScriptDependencyBinding,
  type ScriptDependencyBinding,
} from "./script-dependencies";

export interface RevisionCreated {
  revisionId: string;
  revisionNo: number;
  contentHash: string;
  rowVersion: number;
}

export interface ReviewTransitioned {
  reviewVersion: number;
  rowVersion: number;
}

export interface StoryRevisionView {
  id: string;
  projectId: string;
  revisionNo: number;
  content: unknown;
  contentHash: string;
  reviewStatus: string;
  freshnessStatus: string;
  staleReason: string | null;
  staleFromRef: string | null;
  reviewVersion: number;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdBy: string;
  createdAt: string;
}

export interface StoryRevisionPage {
  items: StoryRevisionView[];
  nextCursor: string | null;
}

export interface EpisodeSummary {
  id: string;
  projectId: string;
  episodeNo: number;
  title: string;
  rowVersion: number;
  currentScriptRevisionId: string | null;
  approvedScriptRevisionId: string | null;
  currentScriptReviewStatus: string | null;
  currentScriptFreshnessStatus: string | null;
}

export interface ScriptRevisionView {
  id: string;
  episodeId: string;
  projectId: string;
  revisionNo: number;
  sourceStoryRevisionId: string;
  content: unknown;
  contentHash: string;
  reviewStatus: string;
  freshnessStatus: string;
  reviewVersion: number;
  createdBy: string;
  createdAt: string;
}

export interface ScriptRevisionPage {
  items: ScriptRevisionView[];
  nextCursor: string | null;
}

async function withTransaction<T>(
  pool: DatabasePool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
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
  await lockProjectForAggregate(client, table, id, workspaceId);
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

  async bindScriptSourceDependencies(
    input: ScriptDependencyBinding,
  ): Promise<{ rowVersion: number }> {
    validateScriptDependencyBinding(input);
    return withTransaction(this.pool, async (client) => {
      const parentTable = input.consumerType.replace("_revision", "") as
        "scene" | "shot" | "character" | "location";
      const located = await client.query(
        `SELECT id FROM ${input.consumerType} WHERE id = $1 AND workspace_id = $2 AND project_id = $3 AND ${parentTable}_id = $4`,
        [input.revisionId, input.workspaceId, input.projectId, input.parentId],
      );
      if (!located.rows[0])
        throw new PersistenceError(
          "INVALID_SOURCE_REFERENCE",
          "Script consumer does not belong to this project and parent",
        );
      await lockProject(client, input.projectId, input.workspaceId);
      // Match the source -> consumer lock order enforced by provenance insertion triggers.
      const source = await client.query(
        `SELECT episode.id FROM episode JOIN script_revision source
           ON source.episode_id = episode.id AND source.workspace_id = episode.workspace_id
          WHERE source.id = $1 AND source.workspace_id = $2 AND source.project_id = $3
            AND episode.current_script_revision_id = source.id AND source.freshness_status = 'CURRENT'
          FOR SHARE OF episode, source`,
        [input.sourceScriptRevisionId, input.workspaceId, input.projectId],
      );
      if (!source.rows[0])
        throw new PersistenceError("INVALID_SOURCE_REFERENCE", "Script source is not current");
      await lockCurrentRevision(client, {
        parentTable,
        revisionTable: input.consumerType,
        parentId: input.parentId,
        revisionId: input.revisionId,
        workspaceId: input.workspaceId,
        expectedVersion: input.expectedVersion,
      });
      const owned = await client.query(
        `SELECT id FROM ${input.consumerType} WHERE id = $1 AND workspace_id = $2 AND project_id = $3
           AND review_status = 'DRAFT' AND freshness_status = 'CURRENT'`,
        [input.revisionId, input.workspaceId, input.projectId],
      );
      if (!owned.rows[0])
        throw new PersistenceError(
          "INVALID_SOURCE_REFERENCE",
          "Only a fresh draft can bind script inputs",
        );
      await insertScriptDependencies(client, input);
      const rowVersion = await bumpPointer(
        client,
        parentTable,
        input.parentId,
        input.workspaceId,
        input.expectedVersion,
        "current_revision_id",
        input.revisionId,
      );
      await client.query(
        `INSERT INTO domain_event
          (workspace_id, project_id, aggregate_type, aggregate_id, event_type, payload_json, trace_id)
         VALUES ($1, $2, $3, $4, 'revision.script_dependencies_bound', $5::jsonb, $6)`,
        [
          input.workspaceId,
          input.projectId,
          input.consumerType,
          input.revisionId,
          JSON.stringify({
            revisionId: input.revisionId,
            sourceScriptRevisionId: input.sourceScriptRevisionId,
            sourcePaths: input.sourcePaths,
            rowVersion,
          }),
          input.traceId ?? "m2-text-chain",
        ],
      );
      return { rowVersion };
    });
  }

  async createStoryRevision(input: {
    workspaceId: string;
    projectId: string;
    content: unknown;
    createdBy: string;
    expectedVersion: number;
    traceId?: string;
  }): Promise<RevisionCreated> {
    return withTransaction(this.pool, (client) => this.createStoryRevisionInTransaction(client, input));
  }

  async createStoryRevisionInTransaction(
    client: PoolClient,
    input: {
      workspaceId: string;
      projectId: string;
      content: unknown;
      createdBy: string;
      expectedVersion: number;
      traceId?: string;
    },
  ): Promise<RevisionCreated> {
    const contentHash = canonicalInputHash(input.content);
    await lockAggregateForRevision(
      client,
      "project",
      input.projectId,
      input.workspaceId,
      input.expectedVersion,
    );
    const previousCurrent = await client.query<
      { current_story_revision_id: string | null } & QueryResultRow
    >("SELECT current_story_revision_id FROM project WHERE id = $1 AND workspace_id = $2", [
      input.projectId,
      input.workspaceId,
    ]);
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
      [
        input.workspaceId,
        input.projectId,
        revisionNo,
        JSON.stringify(input.content),
        contentHash,
        input.createdBy,
      ],
    );
    const revisionId = inserted.rows[0]?.id;
    if (!revisionId) {
      throw new PersistenceError("REVISION_CREATE_FAILED", "Story revision was not created");
    }
    const rowVersion = await bumpPointer(
      client,
      "project",
      input.projectId,
      input.workspaceId,
      input.expectedVersion,
      "current_story_revision_id",
      revisionId,
    );
    const traceId = input.traceId ?? "m2-text-chain";
    await emitCurrentRevisionEvent(
      client,
      input.workspaceId,
      input.projectId,
      "Project",
      input.projectId,
      revisionId,
      rowVersion,
      traceId,
    );
    if (previousCurrentId && previousCurrentId !== revisionId) {
      if (await staleFromStory(client, input.workspaceId, previousCurrentId, traceId)) {
        await enqueueStaleRecalculation(
          client,
          input.workspaceId,
          input.projectId,
          "SOURCE_STORY_REPLACED",
          `story_revision:${previousCurrentId}`,
        );
      }
    }
    return { revisionId, revisionNo, contentHash, rowVersion };
  }

  async listStoryRevisions(
    workspaceId: string,
    projectId: string,
    cursor?: string,
    limit = 20,
  ): Promise<StoryRevisionPage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new PersistenceError("VALIDATION_ERROR", "Story revision page size is invalid");
    }
    let cursorRevisionNo: number | null = null;
    if (cursor !== undefined) {
      if (!/^[1-9][0-9]*$/.test(cursor)) {
        throw new PersistenceError("VALIDATION_ERROR", "Story revision cursor is invalid");
      }
      cursorRevisionNo = Number(cursor);
      if (!Number.isSafeInteger(cursorRevisionNo) || cursorRevisionNo > 2_147_483_647) {
        throw new PersistenceError("VALIDATION_ERROR", "Story revision cursor is invalid");
      }
    }

    const client = await this.pool.connect();
    try {
      const params: unknown[] = [workspaceId, projectId, limit + 1];
      let cursorSql = "";
      if (cursorRevisionNo !== null) {
        params.push(cursorRevisionNo);
        cursorSql = "AND revision_no < $4";
      }
      const result = await client.query<QueryResultRow>(
        `SELECT id, project_id, revision_no, content_json, content_hash,
                review_status, freshness_status, stale_reason, stale_from_ref,
                review_version, reviewed_by, reviewed_at, review_note,
                created_by, created_at
           FROM story_revision
          WHERE workspace_id = $1 AND project_id = $2 ${cursorSql}
          ORDER BY revision_no DESC
          LIMIT $3`,
        params,
      );
      const items = result.rows.slice(0, limit).map((row) => ({
        id: String(row.id),
        projectId: String(row.project_id),
        revisionNo: Number(row.revision_no),
        content: row.content_json,
        contentHash: String(row.content_hash),
        reviewStatus: String(row.review_status),
        freshnessStatus: String(row.freshness_status),
        staleReason: row.stale_reason === null ? null : String(row.stale_reason),
        staleFromRef: row.stale_from_ref === null ? null : String(row.stale_from_ref),
        reviewVersion: Number(row.review_version),
        reviewedBy: row.reviewed_by === null ? null : String(row.reviewed_by),
        reviewedAt: row.reviewed_at === null ? null : new Date(row.reviewed_at as Date | string).toISOString(),
        reviewNote: row.review_note === null ? null : String(row.review_note),
        createdBy: String(row.created_by),
        createdAt: new Date(row.created_at as Date | string).toISOString(),
      }));
      const last = items.at(-1);
      return {
        items,
        nextCursor: result.rows.length > limit && last ? String(last.revisionNo) : null,
      };
    } finally {
      client.release();
    }
  }

  async listEpisodes(workspaceId: string, projectId: string): Promise<EpisodeSummary[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<QueryResultRow>(
        `SELECT e.id, e.project_id, e.episode_no, e.title, e.row_version,
                e.current_script_revision_id, e.approved_script_revision_id,
                sr.review_status AS current_script_review_status,
                sr.freshness_status AS current_script_freshness_status
           FROM episode e
           LEFT JOIN script_revision sr
             ON sr.id = e.current_script_revision_id
            AND sr.workspace_id = e.workspace_id
          WHERE e.workspace_id = $1 AND e.project_id = $2
          ORDER BY e.episode_no`,
        [workspaceId, projectId],
      );
      return result.rows.map((row) => ({
        id: String(row.id),
        projectId: String(row.project_id),
        episodeNo: Number(row.episode_no),
        title: String(row.title),
        rowVersion: Number(row.row_version),
        currentScriptRevisionId:
          row.current_script_revision_id === null ? null : String(row.current_script_revision_id),
        approvedScriptRevisionId:
          row.approved_script_revision_id === null ? null : String(row.approved_script_revision_id),
        currentScriptReviewStatus:
          row.current_script_review_status === null ? null : String(row.current_script_review_status),
        currentScriptFreshnessStatus:
          row.current_script_freshness_status === null ? null : String(row.current_script_freshness_status),
      }));
    } finally {
      client.release();
    }
  }

  async transitionReview(input: ReviewTransition): Promise<ReviewTransitioned> {
    return withTransaction(this.pool, (client) => this.transitionReviewInTransaction(client, input));
  }

  async transitionReviewInTransaction(
    client: PoolClient,
    input: ReviewTransition,
  ): Promise<ReviewTransitioned> {
    if (input.to === "APPROVED") {
      throw new PersistenceError(
        "REVIEW_GATE_REQUIRED",
        "Approval must use the aggregate-specific review gate",
      );
    }
    const parentId = await lockParentForReview(client, input);
    const reviewVersion = await applyReview(client, input);
    const rowVersion = await bumpReviewParentVersion(client, input, parentId);
    return { reviewVersion, rowVersion };
  }

  async approveStory(input: {
    workspaceId: string;
    projectId: string;
    revisionId: string;
    expectedVersion: number;
    expectedReviewVersion: number;
    reviewedBy: string;
    traceId?: string;
  }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await this.approveStoryInTransaction(client, input);
    });
  }

  async approveStoryInTransaction(
    client: PoolClient,
    input: {
      workspaceId: string;
      projectId: string;
      revisionId: string;
      expectedVersion: number;
      expectedReviewVersion: number;
      reviewedBy: string;
      traceId?: string;
    },
  ): Promise<ReviewTransitioned> {
    await lockProject(client, input.projectId, input.workspaceId);
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
      throw new PersistenceError(
        "REVISION_CONFLICT",
        "Only the current story revision can be approved",
      );
    }

    const reviewVersion = await applyReview(client, {
      table: "story_revision",
      revisionId: input.revisionId,
      workspaceId: input.workspaceId,
      expectedVersion: input.expectedVersion,
      expectedReviewVersion: input.expectedReviewVersion,
      to: "APPROVED",
      reviewedBy: input.reviewedBy,
      traceId: input.traceId,
    });
    const rowVersion = await bumpPointer(
      client,
      "project",
      input.projectId,
      input.workspaceId,
      input.expectedVersion,
      "approved_story_revision_id",
      input.revisionId,
    );
    await ensureEpisodes(client, input.workspaceId, input.projectId);
    return { reviewVersion, rowVersion };
  }

  async continueStaleRecalculation(): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      // Match service lock order: project, continuation, then affected revisions.
      // Skip a busy project so multiple workers can make independent progress.
      const project = await client.query<{ id: string; workspace_id: string } & QueryResultRow>(
        `SELECT p.id, p.workspace_id
           FROM project p
          WHERE EXISTS (
            SELECT 1 FROM stale_recalculation work
             WHERE work.project_id = p.id AND work.workspace_id = p.workspace_id
               AND work.status IN ('PENDING', 'RUNNING')
          )
          ORDER BY (
            SELECT MIN(work.created_at) FROM stale_recalculation work
             WHERE work.project_id = p.id AND work.workspace_id = p.workspace_id
               AND work.status IN ('PENDING', 'RUNNING')
          ), p.id
          LIMIT 1 FOR UPDATE OF p SKIP LOCKED`,
      );
      const scope = project.rows[0];
      if (!scope) return false;
      const task = await client.query<{ id: string; stale_from_ref: string } & QueryResultRow>(
        `SELECT id, stale_from_ref FROM stale_recalculation
          WHERE project_id = $1 AND workspace_id = $2 AND status IN ('PENDING', 'RUNNING')
          ORDER BY created_at, id LIMIT 1 FOR UPDATE`,
        [scope.id, scope.workspace_id],
      );
      const work = task.rows[0];
      if (!work) return false;
      const root = parseStaleRoot(work.stale_from_ref);
      const owned = await client.query(
        `SELECT id FROM ${root.table} WHERE id = $1 AND project_id = $2 AND workspace_id = $3`,
        [root.id, scope.id, scope.workspace_id],
      );
      if (!owned.rows[0])
        throw new PersistenceError("NOT_FOUND", "Stale propagation root not found");
      const traceId = `stale-recalculation:${work.id}`;
      const hasMore =
        root.table === "story_revision"
          ? await staleFromStory(client, scope.workspace_id, root.id, traceId)
          : await staleFromScript(client, scope.workspace_id, root.id, traceId);
      await client.query(
        `UPDATE stale_recalculation SET status = $2, updated_at = now() WHERE id = $1`,
        [work.id, hasMore ? "PENDING" : "DONE"],
      );
      return true;
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
    traceId?: string;
  }): Promise<RevisionCreated> {
    return withTransaction(this.pool, (client) => this.createScriptRevisionInTransaction(client, input));
  }

  async createScriptRevisionInTransaction(
    client: PoolClient,
    input: {
      workspaceId: string;
      projectId: string;
      episodeId: string;
      sourceStoryRevisionId: string;
      content: unknown;
      createdBy: string;
      expectedVersion: number;
      traceId?: string;
    },
  ): Promise<RevisionCreated> {
    const contentHash = canonicalInputHash(input.content);
    await lockAggregateForRevision(
      client,
      "episode",
      input.episodeId,
      input.workspaceId,
      input.expectedVersion,
    );
    const currentScript = await client.query<
      { current_script_revision_id: string | null } & QueryResultRow
    >("SELECT current_script_revision_id FROM episode WHERE id = $1 AND workspace_id = $2", [
      input.episodeId,
      input.workspaceId,
    ]);
    const currentScriptId = currentScript.rows[0]?.current_script_revision_id;
    if (currentScriptId) {
      await client.query(
        "SELECT id FROM script_revision WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
        [currentScriptId, input.workspaceId],
      );
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
    if (!sourceRow) {
      throw new PersistenceError("NOT_FOUND", "Episode or source story revision not found");
    }
    if (
      sourceRow.current_story_revision_id !== input.sourceStoryRevisionId ||
      sourceRow.approved_story_revision_id !== input.sourceStoryRevisionId ||
      sourceRow.review_status !== "APPROVED" ||
      sourceRow.freshness_status !== "CURRENT"
    ) {
      throw new PersistenceError(
        "REVIEW_REQUIRED",
        "Scripts require the current approved story revision",
      );
    }

    const previousCurrentId = sourceRow.current_script_revision_id;
    const next = await client.query<{ revision_no: number } & QueryResultRow>(
      "SELECT COALESCE(MAX(revision_no), 0)::int + 1 AS revision_no FROM script_revision WHERE episode_id = $1",
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
    if (!revisionId) {
      throw new PersistenceError("REVISION_CREATE_FAILED", "Script revision was not created");
    }

    if (previousCurrentId) {
      await client.query(
        `INSERT INTO script_revision_replacement
          (workspace_id, project_id, episode_id, previous_script_revision_id, new_script_revision_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [input.workspaceId, input.projectId, input.episodeId, previousCurrentId, revisionId],
      );
    }

    const rowVersion = await bumpPointer(
      client,
      "episode",
      input.episodeId,
      input.workspaceId,
      input.expectedVersion,
      "current_script_revision_id",
      revisionId,
    );
    const traceId = input.traceId ?? "m2-text-chain";
    await emitCurrentRevisionEvent(
      client,
      input.workspaceId,
      input.projectId,
      "Episode",
      input.episodeId,
      revisionId,
      rowVersion,
      traceId,
    );
    if (previousCurrentId && previousCurrentId !== revisionId) {
      if (await staleFromScript(client, input.workspaceId, previousCurrentId, traceId)) {
        await enqueueStaleRecalculation(
          client,
          input.workspaceId,
          input.projectId,
          "SOURCE_SCRIPT_REPLACED",
          `script_revision:${previousCurrentId}`,
        );
      }
    }
    return { revisionId, revisionNo, contentHash, rowVersion };
  }

  async requireScriptRevision(
    workspaceId: string,
    revisionId: string,
  ): Promise<{ id: string; projectId: string; episodeId: string; reviewVersion: number }> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<
        { id: string; project_id: string; episode_id: string; review_version: number } & QueryResultRow
      >(
        `SELECT id, project_id, episode_id, review_version
           FROM script_revision
          WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, revisionId],
      );
      const row = result.rows[0];
      if (!row) throw new PersistenceError("NOT_FOUND", "Script revision not found");
      return {
        id: row.id,
        projectId: row.project_id,
        episodeId: row.episode_id,
        reviewVersion: row.review_version,
      };
    } finally {
      client.release();
    }
  }

  async listScriptRevisions(
    workspaceId: string,
    projectId: string,
    episodeId: string,
    cursor?: string,
    limit = 20,
  ): Promise<ScriptRevisionPage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new PersistenceError("VALIDATION_ERROR", "Script revision page size is invalid");
    }
    let cursorRevisionNo: number | null = null;
    if (cursor !== undefined) {
      if (!/^[1-9][0-9]*$/.test(cursor)) {
        throw new PersistenceError("VALIDATION_ERROR", "Script revision cursor is invalid");
      }
      cursorRevisionNo = Number(cursor);
      if (!Number.isSafeInteger(cursorRevisionNo) || cursorRevisionNo > 2_147_483_647) {
        throw new PersistenceError("VALIDATION_ERROR", "Script revision cursor is invalid");
      }
    }

    const client = await this.pool.connect();
    try {
      const params: unknown[] = [workspaceId, projectId, episodeId, limit + 1];
      let cursorSql = "";
      if (cursorRevisionNo !== null) {
        params.push(cursorRevisionNo);
        cursorSql = "AND revision_no < $5";
      }
      const result = await client.query<QueryResultRow>(
        `SELECT id, episode_id, project_id, revision_no, source_story_revision_id,
                content_json, content_hash, review_status, freshness_status,
                review_version, created_by, created_at
           FROM script_revision
          WHERE workspace_id = $1
            AND project_id = $2
            AND episode_id = $3
            ${cursorSql}
          ORDER BY revision_no DESC
          LIMIT $4`,
        params,
      );
      const items = result.rows.slice(0, limit).map((row) => ({
        id: String(row.id),
        episodeId: String(row.episode_id),
        projectId: String(row.project_id),
        revisionNo: Number(row.revision_no),
        sourceStoryRevisionId: String(row.source_story_revision_id),
        content: row.content_json,
        contentHash: String(row.content_hash),
        reviewStatus: String(row.review_status),
        freshnessStatus: String(row.freshness_status),
        reviewVersion: Number(row.review_version),
        createdBy: String(row.created_by),
        createdAt: new Date(row.created_at as Date | string).toISOString(),
      }));
      const last = items.at(-1);
      return {
        items,
        nextCursor: result.rows.length > limit && last ? String(last.revisionNo) : null,
      };
    } finally {
      client.release();
    }
  }

  async approveScript(input: {
    workspaceId: string;
    episodeId: string;
    revisionId: string;
    expectedVersion: number;
    expectedReviewVersion: number;
    reviewedBy: string;
    traceId?: string;
  }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await this.approveScriptInTransaction(client, input);
    });
  }

  async approveScriptInTransaction(
    client: PoolClient,
    input: {
      workspaceId: string;
      episodeId: string;
      revisionId: string;
      expectedVersion: number;
      expectedReviewVersion: number;
      reviewedBy: string;
      traceId?: string;
    },
  ): Promise<ReviewTransitioned> {
    await lockAggregateForRevision(
      client,
      "episode",
      input.episodeId,
      input.workspaceId,
      input.expectedVersion,
    );
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
      throw new PersistenceError(
        "REVISION_CONFLICT",
        "Only the current script revision can be approved",
      );
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
      throw new PersistenceError(
        "REVIEW_REQUIRED",
        "Script source must be the current approved story revision",
      );
    }

    const reviewVersion = await applyReview(client, {
      table: "script_revision",
      revisionId: input.revisionId,
      workspaceId: input.workspaceId,
      expectedVersion: input.expectedVersion,
      expectedReviewVersion: input.expectedReviewVersion,
      to: "APPROVED",
      reviewedBy: input.reviewedBy,
      traceId: input.traceId,
    });
    const rowVersion = await bumpPointer(
      client,
      "episode",
      input.episodeId,
      input.workspaceId,
      input.expectedVersion,
      "approved_script_revision_id",
      input.revisionId,
    );
    return { reviewVersion, rowVersion };
  }

  async approveCharacter(input: AggregateApproval): Promise<void> {
    await approveEntityRevision(this.pool, {
      ...input,
      parentTable: "character",
      revisionTable: "character_revision",
    });
  }

  async approveLocation(input: AggregateApproval): Promise<void> {
    await approveEntityRevision(this.pool, {
      ...input,
      parentTable: "location",
      revisionTable: "location_revision",
    });
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
            m2_script_source_is_usable(sr.workspace_id, sr.project_id, 'scene_revision', sr.id, sr.source_script_revision_id)
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
        throw new PersistenceError(
          "REVIEW_REQUIRED",
          "Scene source must be the current approved script revision",
        );
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
        throw new PersistenceError(
          "REVIEW_REQUIRED",
          "Shot source must be the current approved scene revision",
        );
      }
      const invalidScript = await client.query(
        `SELECT 1 FROM script_revision_consumer_source edge
          WHERE edge.workspace_id = $1 AND edge.consumer_type = 'shot_revision' AND edge.consumer_revision_id = $2
            AND m2_script_source_is_usable(edge.workspace_id, edge.project_id, edge.consumer_type,
                  edge.consumer_revision_id, edge.script_revision_id) IS NOT TRUE LIMIT 1`,
        [input.workspaceId, input.revisionId],
      );
      if (invalidScript.rows[0]) {
        throw new PersistenceError(
          "REVIEW_REQUIRED",
          "Shot script inputs must match the current approved script",
        );
      }
      const characterDependencies = await client.query<
        { character_revision_id: string; ok: boolean } & QueryResultRow
      >(
        `SELECT refs.character_revision_id,
                (
                  character.current_revision_id = character_revision.id
                  AND character.approved_revision_id = character_revision.id
                  AND character_revision.review_status = 'APPROVED'
                  AND character_revision.freshness_status = 'CURRENT'
                ) AS ok
           FROM shot_character_reference refs
           JOIN character_revision
             ON character_revision.id = refs.character_revision_id
            AND character_revision.workspace_id = refs.workspace_id
            AND character_revision.project_id = refs.project_id
           JOIN character
             ON character.id = character_revision.character_id
            AND character.workspace_id = character_revision.workspace_id
          WHERE refs.shot_revision_id = $1
            AND refs.workspace_id = $2
          FOR SHARE OF character_revision, character`,
        [input.revisionId, input.workspaceId],
      );
      if (characterDependencies.rows.some((row) => row.ok !== true)) {
        throw new PersistenceError(
          "REVIEW_REQUIRED",
          "Shot character references must be current approved character revisions",
        );
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
    traceId?: string;
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
      await lockAggregateForRevision(
        client,
        "shot",
        input.shotId,
        input.workspaceId,
        input.expectedVersion,
      );
      const source = await client.query<
        { freshness_status: string; current_revision_id: string | null } & QueryResultRow
      >(
        `SELECT revision.freshness_status, scene.current_revision_id
           FROM scene
           JOIN scene_revision revision ON revision.scene_id = scene.id
             AND revision.project_id = scene.project_id AND revision.workspace_id = scene.workspace_id
          WHERE revision.id = $1 AND scene.id = $2 AND scene.project_id = $3 AND scene.workspace_id = $4
            AND EXISTS (
              SELECT 1 FROM shot WHERE id = $5 AND scene_id = scene.id
                AND project_id = scene.project_id AND workspace_id = scene.workspace_id
            )
          FOR UPDATE OF scene FOR SHARE OF revision`,
        [
          input.sourceSceneRevisionId,
          input.sceneId,
          input.projectId,
          input.workspaceId,
          input.shotId,
        ],
      );
      if (!source.rows[0])
        throw new PersistenceError("NOT_FOUND", "Source scene revision not found");
      if (
        source.rows[0].freshness_status !== "CURRENT" ||
        source.rows[0].current_revision_id !== input.sourceSceneRevisionId
      ) {
        throw new PersistenceError(
          "SOURCE_STALE",
          "Shots require the current fresh scene revision",
        );
      }
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
      if (!revisionId)
        throw new PersistenceError("REVISION_CREATE_FAILED", "Shot revision was not created");
      const rowVersion = await bumpPointer(
        client,
        "shot",
        input.shotId,
        input.workspaceId,
        input.expectedVersion,
        "current_revision_id",
        revisionId,
      );
      await emitCurrentRevisionEvent(
        client,
        input.workspaceId,
        input.projectId,
        "Shot",
        input.shotId,
        revisionId,
        rowVersion,
        input.traceId ?? "m2-text-chain",
      );
      return { revisionId, revisionNo, contentHash, rowVersion };
    });
  }
}

interface ReviewTransition {
  table:
    | "story_revision"
    | "script_revision"
    | "character_revision"
    | "location_revision"
    | "scene_revision"
    | "shot_revision";
  revisionId: string;
  workspaceId: string;
  expectedVersion: number;
  expectedReviewVersion: number;
  to: ReviewStatus;
  reviewedBy?: string;
  reviewNote?: string | null;
  traceId?: string;
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

async function lockParentForReview(client: PoolClient, input: ReviewTransition): Promise<string> {
  const scope = await client.query<{ project_id: string } & QueryResultRow>(
    `SELECT project_id FROM ${input.table} WHERE id = $1 AND workspace_id = $2`,
    [input.revisionId, input.workspaceId],
  );
  if (!scope.rows[0]) throw new PersistenceError("NOT_FOUND", "Revision not found");
  await lockProject(client, scope.rows[0].project_id, input.workspaceId);
  const parent = reviewParents[input.table];
  const located = await client.query<{ parent_id: string } & QueryResultRow>(
    `SELECT ${parent.parentColumn} AS parent_id FROM ${input.table} WHERE id = $1 AND workspace_id = $2`,
    [input.revisionId, input.workspaceId],
  );
  const parentId = located.rows[0]?.parent_id;
  if (!parentId) throw new PersistenceError("NOT_FOUND", "Revision not found");
  const locked = await client.query<
    { aggregate_version: number; current_revision_id: string | null } & QueryResultRow
  >(
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
    throw new PersistenceError(
      "REVISION_CONFLICT",
      "Only the current revision can change review state",
    );
  }
  return parentId;
}

async function bumpReviewParentVersion(
  client: PoolClient,
  input: ReviewTransition,
  parentId: string,
): Promise<number> {
  const parent = reviewParents[input.table];
  const updated = await client.query<{ aggregate_version: number } & QueryResultRow>(
    `UPDATE ${parent.parentTable}
        SET ${parent.versionColumn} = ${parent.versionColumn} + 1,
            updated_at = now()
      WHERE id = $1
        AND workspace_id = $2
        AND ${parent.versionColumn} = $3
        AND ${parent.currentColumn} = $4
      RETURNING ${parent.versionColumn} AS aggregate_version`,
    [parentId, input.workspaceId, input.expectedVersion, input.revisionId],
  );
  const row = updated.rows[0];
  if (!row) {
    throw new PersistenceError(
      "REVISION_CONFLICT",
      "Aggregate version changed during review transition",
    );
  }
  return row.aggregate_version;
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
     VALUES ($1, $2, $3, $4, 'revision.review', $5::jsonb, $6)`,
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
      input.traceId ?? "m2-text-chain",
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
  traceId?: string;
}

async function lockProject(
  client: PoolClient,
  projectId: string,
  workspaceId: string,
): Promise<void> {
  const locked = await client.query(
    "SELECT id FROM project WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
    [projectId, workspaceId],
  );
  if (!locked.rows[0]) throw new PersistenceError("NOT_FOUND", "Project not found");
  const pending = await client.query(
    `SELECT 1 FROM stale_recalculation
      WHERE workspace_id = $1 AND project_id = $2 AND status IN ('PENDING', 'RUNNING')
      LIMIT 1`,
    [workspaceId, projectId],
  );
  if (pending.rows[0]) {
    throw new PersistenceError("SOURCE_STALE", "Project dependency propagation is incomplete");
  }
}

async function lockProjectForAggregate(
  client: PoolClient,
  table: "project" | "episode" | "character" | "location" | "scene" | "shot",
  id: string,
  workspaceId: string,
): Promise<void> {
  if (table === "project") {
    await lockProject(client, id, workspaceId);
    return;
  }
  const located = await client.query<{ project_id: string } & QueryResultRow>(
    `SELECT project_id FROM ${table} WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  if (!located.rows[0]) throw new PersistenceError("NOT_FOUND", "Aggregate not found");
  await lockProject(client, located.rows[0].project_id, workspaceId);
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
  await lockProjectForAggregate(client, input.parentTable, input.parentId, input.workspaceId);
  const parent = await client.query<
    { row_version: number; current_revision_id: string | null } & QueryResultRow
  >(
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
    traceId: input.traceId,
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
    input.parentTable === "character"
      ? "character_revision_script_source"
      : "location_revision_script_source";
  const edgeColumn =
    input.parentTable === "character" ? "character_revision_id" : "location_revision_id";
  await withTransaction(pool, async (client) => {
    await lockCurrentRevision(client, input);
    const invalid = await client.query(
      `SELECT 1
         FROM ${edgeTable} edge
         JOIN script_revision sr ON sr.id = edge.script_revision_id
         JOIN episode e ON e.id = sr.episode_id AND e.workspace_id = sr.workspace_id
        WHERE edge.${edgeColumn} = $1
          AND edge.workspace_id = $2
          AND m2_script_source_is_usable(edge.workspace_id, edge.project_id, '${input.revisionTable}',
                edge.${edgeColumn}, edge.script_revision_id) IS NOT TRUE
        LIMIT 1`,
      [input.revisionId, input.workspaceId],
    );
    if (invalid.rows[0]) {
      throw new PersistenceError(
        "REVIEW_REQUIRED",
        "Entity source must be a current approved script revision",
      );
    }
    await finishApproval(client, input, input.parentTable, input.revisionTable);
  });
}

async function emitCurrentRevisionEvent(
  client: PoolClient,
  workspaceId: string,
  projectId: string,
  aggregateType: string,
  aggregateId: string,
  revisionId: string,
  rowVersion: number,
  traceId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO domain_event
      (workspace_id, project_id, aggregate_type, aggregate_id, event_type, payload_json, trace_id)
     VALUES ($1, $2, $3, $4, 'revision.current_changed', $5::jsonb, $6)`,
    [
      workspaceId,
      projectId,
      aggregateType,
      aggregateId,
      JSON.stringify({ revisionId, rowVersion }),
      traceId,
    ],
  );
}

async function ensureEpisodes(
  client: PoolClient,
  workspaceId: string,
  projectId: string,
): Promise<void> {
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

const STALE_SYNC_LIMIT = 200;

function parseStaleRoot(ref: string): { table: "story_revision" | "script_revision"; id: string } {
  const matched =
    /^(story_revision|script_revision):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
      ref,
    );
  if (!matched || !matched[2]) {
    throw new PersistenceError("INVALID_STALE_ROOT", "Unsupported stale propagation root");
  }
  return { table: matched[1] as "story_revision" | "script_revision", id: matched[2] };
}

async function enqueueStaleRecalculation(
  client: PoolClient,
  workspaceId: string,
  projectId: string,
  reason: string,
  staleFromRef: string,
): Promise<void> {
  await client.query(
    `INSERT INTO stale_recalculation
      (workspace_id, project_id, stale_from_ref, reason, status)
     VALUES ($1, $2, $3, $4, 'PENDING')
     ON CONFLICT (workspace_id, project_id, stale_from_ref) DO NOTHING`,
    [workspaceId, projectId, staleFromRef, reason],
  );
}

async function markStale(
  client: PoolClient,
  table: string,
  idsSql: string,
  params: unknown[],
  reason: string,
  staleFromRef: string,
  traceId: string,
): Promise<boolean> {
  const root = parseStaleRoot(staleFromRef);
  const reasonParam = params.length + 1;
  const refParam = params.length + 2;
  const traceParam = params.length + 3;
  const aggregateTypeParam = params.length + 4;
  const aggregateType = table
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  const updated = await client.query<{ has_more: boolean } & QueryResultRow>(
    `WITH candidates AS (
       SELECT DISTINCT candidate.id
         FROM ${table} candidate
         JOIN (${idsSql}) AS source_ids(id) ON source_ids.id = candidate.id
        WHERE candidate.workspace_id = $1
          AND candidate.project_id = (
            SELECT project_id FROM ${root.table}
             WHERE workspace_id = $1 AND id = split_part($${refParam}, ':', 2)::uuid
          )
          AND candidate.freshness_status = 'CURRENT'
        ORDER BY candidate.id
        LIMIT ${STALE_SYNC_LIMIT + 1}
     ),
     selected AS (
       SELECT id FROM candidates ORDER BY id LIMIT ${STALE_SYNC_LIMIT}
     ),
     updated AS (
       UPDATE ${table}
          SET freshness_status = 'STALE',
              review_version = review_version + 1,
              stale_reason = COALESCE(stale_reason, $${reasonParam}),
              stale_from_ref = COALESCE(stale_from_ref, $${refParam})
        WHERE workspace_id = $1
          AND freshness_status = 'CURRENT'
          AND id IN (SELECT id FROM selected)
       RETURNING id, project_id
     ),
     inserted_events AS (
       INSERT INTO domain_event
         (workspace_id, project_id, aggregate_type, aggregate_id, event_type, payload_json, trace_id)
       SELECT $1,
              project_id,
              $${aggregateTypeParam},
              id,
              'revision.stale',
              jsonb_build_object(
                'revisionId', id,
                'freshnessStatus', 'STALE',
                'staleReason', $${reasonParam},
                'staleFromRef', $${refParam}
              ),
              $${traceParam}
         FROM updated
       RETURNING 1
     )
     SELECT (SELECT COUNT(*) FROM candidates) > ${STALE_SYNC_LIMIT} AS has_more`,
    [...params, reason, staleFromRef, traceId, aggregateType],
  );
  return updated.rows[0]?.has_more === true;
}

async function staleFromStory(
  client: PoolClient,
  workspaceId: string,
  storyRevisionId: string,
  traceId: string,
): Promise<boolean> {
  let hasMore = false;
  const reason = "SOURCE_STORY_REPLACED";
  const staleFromRef = `story_revision:${storyRevisionId}`;
  hasMore =
    (await markStale(
      client,
      "script_revision",
      `SELECT id FROM script_revision WHERE workspace_id = $1 AND source_story_revision_id = $2`,
      [workspaceId, storyRevisionId],
      reason,
      staleFromRef,
      traceId,
    )) || hasMore;
  hasMore =
    (await markStale(
      client,
      "scene_revision",
      `SELECT scene_revision.id FROM scene_revision
       JOIN script_revision ON script_revision.id = scene_revision.source_script_revision_id
      WHERE script_revision.workspace_id = $1 AND script_revision.source_story_revision_id = $2`,
      [workspaceId, storyRevisionId],
      reason,
      staleFromRef,
      traceId,
    )) || hasMore;
  hasMore =
    (await markStale(
      client,
      "shot_revision",
      `SELECT shot_revision.id FROM shot_revision
       JOIN scene_revision ON scene_revision.id = shot_revision.source_scene_revision_id
       JOIN script_revision ON script_revision.id = scene_revision.source_script_revision_id
      WHERE script_revision.workspace_id = $1 AND script_revision.source_story_revision_id = $2`,
      [workspaceId, storyRevisionId],
      reason,
      staleFromRef,
      traceId,
    )) || hasMore;
  hasMore =
    (await markStale(
      client,
      "character_revision",
      `SELECT character_revision_id FROM character_revision_script_source
      WHERE workspace_id = $1 AND script_revision_id IN (
        SELECT id FROM script_revision WHERE workspace_id = $1 AND source_story_revision_id = $2
      )`,
      [workspaceId, storyRevisionId],
      reason,
      staleFromRef,
      traceId,
    )) || hasMore;
  hasMore =
    (await markStale(
      client,
      "location_revision",
      `SELECT location_revision_id FROM location_revision_script_source
      WHERE workspace_id = $1 AND script_revision_id IN (
        SELECT id FROM script_revision WHERE workspace_id = $1 AND source_story_revision_id = $2
      )`,
      [workspaceId, storyRevisionId],
      reason,
      staleFromRef,
      traceId,
    )) || hasMore;
  hasMore =
    (await staleSharedDescendants(
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
      traceId,
    )) || hasMore;
  return hasMore;
}

async function staleFromScript(
  client: PoolClient,
  workspaceId: string,
  scriptRevisionId: string,
  traceId: string,
): Promise<boolean> {
  const reason = "SOURCE_SCRIPT_REPLACED";
  const staleFromRef = `script_revision:${scriptRevisionId}`;
  const params = [workspaceId, scriptRevisionId];
  const characterIds = affectedScriptConsumerIds("character_revision");
  const locationIds = affectedScriptConsumerIds("location_revision");
  const directSceneIds = affectedScriptConsumerIds("scene_revision");
  const directShotIds = affectedScriptConsumerIds("shot_revision");
  const existedAtReplacement = `AND revision.created_at <= COALESCE(
    (SELECT created_at FROM script_revision_replacement WHERE previous_script_revision_id = $2
      AND workspace_id = $1), 'infinity'::timestamptz)`;
  const sceneIds = `${directSceneIds}
    UNION
    SELECT revision.id FROM scene_revision revision
     WHERE revision.workspace_id = $1 AND revision.location_revision_id IN (${locationIds})
       ${existedAtReplacement}`;
  const shotIds = `${directShotIds}
    UNION
    SELECT revision.id FROM shot_revision revision
     WHERE revision.workspace_id = $1 AND revision.source_scene_revision_id IN (${sceneIds})
       ${existedAtReplacement}
    UNION
    SELECT revision.id FROM shot_revision revision
      JOIN shot_character_reference reference ON reference.shot_revision_id = revision.id
       AND reference.workspace_id = revision.workspace_id AND reference.project_id = revision.project_id
     WHERE revision.workspace_id = $1 AND reference.character_revision_id IN (${characterIds})
       ${existedAtReplacement}`;
  let hasMore = false;
  // Do not short-circuit: every class must run even when an earlier batch has a continuation.
  for (const [table, ids] of [
    ["character_revision", characterIds],
    ["location_revision", locationIds],
    ["scene_revision", sceneIds],
    ["shot_revision", shotIds],
  ] as const) {
    const remaining = await markStale(client, table, ids, params, reason, staleFromRef, traceId);
    hasMore = remaining || hasMore;
  }
  return hasMore;
}

async function staleSharedDescendants(
  client: PoolClient,
  reason: string,
  staleFromRef: string,
  params: unknown[],
  locationIdsSql: string,
  characterIdsSql: string,
  traceId: string,
): Promise<boolean> {
  let hasMore = false;
  hasMore =
    (await markStale(
      client,
      "scene_revision",
      `SELECT id FROM scene_revision
      WHERE workspace_id = $1 AND location_revision_id IN (${locationIdsSql})`,
      params,
      reason,
      staleFromRef,
      traceId,
    )) || hasMore;
  hasMore =
    (await markStale(
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
      traceId,
    )) || hasMore;
  hasMore =
    (await markStale(
      client,
      "shot_revision",
      `SELECT shot_revision_id FROM shot_character_reference
      WHERE workspace_id = $1 AND character_revision_id IN (${characterIdsSql})`,
      params,
      reason,
      staleFromRef,
      traceId,
    )) || hasMore;
  return hasMore;
}
