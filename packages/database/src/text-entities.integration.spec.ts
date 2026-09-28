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
    await expect(transaction((client) => chain.createTextEntityRevisionInTransaction(client, {
      ...input, workspaceId: "22222222-2222-4222-8222-222222222222",
      entityId: first.entityId, expectedVersion: second.rowVersion,
    }))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(transaction((client) => chain.createTextEntityRevisionInTransaction(client, {
      ...input, entityId: first.entityId, sourceScriptRevisionId: first.revisionId,
      expectedVersion: second.rowVersion,
    }))).rejects.toMatchObject({ code: "SCRIPT_REVIEW_REQUIRED" });
  });
});
