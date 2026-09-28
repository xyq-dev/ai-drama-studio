import { canonicalInputHash } from "@ai-drama/domain";
import { Pool, type QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "./migrations";
import { affectedScriptConsumerIds, type ScriptDependencyConsumer } from "./script-dependencies";
import { TextChainService } from "./text-chain";

if (!process.env.DATABASE_URL)
  throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const chain = new TextChainService(pool);
const content = () => ({
  schema: "m2.script.scoped.v1",
  global: { tone: "quiet" },
  scenes: {
    a: { heading: "INT. ROOM", dialogue: { a: "hello", b: "stay" } },
    b: { heading: "EXT. YARD", dialogue: "wait" },
  },
});
type Content = ReturnType<typeof content>;
interface Graph {
  workspaceId: string;
  projectId: string;
  storyId: string;
  episodeId: string;
  scriptId: string;
}
interface Derived {
  id: string;
  revisionId: string;
}

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

async function version(table: string, id: string): Promise<number> {
  const row = await pool.query<{ value: number } & QueryResultRow>(
    `SELECT ${table === "project" ? "version" : "row_version"} AS value FROM ${table} WHERE id = $1`,
    [id],
  );
  return row.rows[0]!.value;
}

async function seed(existingWorkspaceId?: string): Promise<Graph> {
  const workspaceId =
    existingWorkspaceId ??
    (
      await pool.query<{ id: string } & QueryResultRow>(
        "INSERT INTO workspace (name) VALUES ('scopes') RETURNING id",
      )
    ).rows[0]!.id;
  const projectId = (
    await pool.query<{ id: string } & QueryResultRow>(
      "INSERT INTO project (workspace_id, title) VALUES ($1, 'scopes') RETURNING id",
      [workspaceId],
    )
  ).rows[0]!.id;
  const story = await chain.createStoryRevision({
    workspaceId,
    projectId,
    content: { premise: "scoped inputs" },
    createdBy: "author",
    expectedVersion: 1,
  });
  const storyReview = await chain.transitionReview({
    table: "story_revision",
    workspaceId,
    revisionId: story.revisionId,
    expectedVersion: story.rowVersion,
    expectedReviewVersion: 1,
    to: "IN_REVIEW",
  });
  await chain.approveStory({
    workspaceId,
    projectId,
    revisionId: story.revisionId,
    expectedVersion: storyReview.rowVersion,
    expectedReviewVersion: 2,
    reviewedBy: "editor",
  });
  const episodeId = (
    await pool.query<{ id: string } & QueryResultRow>(
      "SELECT id FROM episode WHERE project_id = $1 AND episode_no = 1",
      [projectId],
    )
  ).rows[0]!.id;
  const script = await chain.createScriptRevision({
    workspaceId,
    projectId,
    episodeId,
    sourceStoryRevisionId: story.revisionId,
    content: content(),
    createdBy: "author",
    expectedVersion: 1,
  });
  const graph = {
    workspaceId,
    projectId,
    storyId: story.revisionId,
    episodeId,
    scriptId: script.revisionId,
  };
  await approveScript(graph, script.revisionId);
  return graph;
}

async function approveScript(graph: Graph, revisionId: string): Promise<void> {
  const review = await chain.transitionReview({
    table: "script_revision",
    workspaceId: graph.workspaceId,
    revisionId,
    expectedVersion: await version("episode", graph.episodeId),
    expectedReviewVersion: 1,
    to: "IN_REVIEW",
  });
  await chain.approveScript({
    workspaceId: graph.workspaceId,
    episodeId: graph.episodeId,
    revisionId,
    expectedVersion: review.rowVersion,
    expectedReviewVersion: 2,
    reviewedBy: "editor",
  });
}

async function replace(graph: Graph, next: unknown): Promise<string> {
  const created = await chain.createScriptRevision({
    workspaceId: graph.workspaceId,
    projectId: graph.projectId,
    episodeId: graph.episodeId,
    sourceStoryRevisionId: graph.storyId,
    content: next,
    createdBy: "author",
    expectedVersion: await version("episode", graph.episodeId),
  });
  return created.revisionId;
}

async function bind(
  graph: Graph,
  consumerType: ScriptDependencyConsumer,
  derived: Derived,
  paths: readonly (readonly string[])[],
  sourceId = graph.scriptId,
): Promise<void> {
  await chain.bindScriptSourceDependencies({
    workspaceId: graph.workspaceId,
    projectId: graph.projectId,
    consumerType,
    parentId: derived.id,
    revisionId: derived.revisionId,
    sourceScriptRevisionId: sourceId,
    sourcePaths: paths,
    expectedVersion: await version(consumerType.replace("_revision", ""), derived.id),
  });
}

async function approve(graph: Graph, type: "scene" | "shot", derived: Derived): Promise<void> {
  const review = await chain.transitionReview({
    table: `${type}_revision`,
    workspaceId: graph.workspaceId,
    revisionId: derived.revisionId,
    expectedVersion: await version(type, derived.id),
    expectedReviewVersion: 1,
    to: "IN_REVIEW",
  });
  await (type === "scene" ? chain.approveScene.bind(chain) : chain.approveShot.bind(chain))({
    workspaceId: graph.workspaceId,
    parentId: derived.id,
    revisionId: derived.revisionId,
    expectedVersion: review.rowVersion,
    expectedReviewVersion: 2,
    reviewedBy: "editor",
  });
}

async function scene(
  graph: Graph,
  ordinal: number,
  paths?: readonly (readonly string[])[],
  approved = true,
  locationRevisionId: string | null = null,
): Promise<Derived> {
  const id = (
    await pool.query<{ id: string } & QueryResultRow>(
      "INSERT INTO scene (workspace_id, project_id, episode_id) VALUES ($1,$2,$3) RETURNING id",
      [graph.workspaceId, graph.projectId, graph.episodeId],
    )
  ).rows[0]!.id;
  const revisionId = (
    await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO scene_revision
      (workspace_id, project_id, episode_id, scene_id, revision_no, source_script_revision_id,
       ordinal, heading, summary, content_hash, created_by, location_revision_id)
     VALUES ($1,$2,$3,$4,1,$5,$6,'INT. ROOM','scene',$7,'author',$8) RETURNING id`,
      [
        graph.workspaceId,
        graph.projectId,
        graph.episodeId,
        id,
        graph.scriptId,
        ordinal,
        canonicalInputHash({ ordinal }),
        locationRevisionId,
      ],
    )
  ).rows[0]!.id;
  await pool.query(
    "UPDATE scene SET current_revision_id = $2, row_version = row_version + 1 WHERE id = $1",
    [id, revisionId],
  );
  const derived = { id, revisionId };
  if (paths) await bind(graph, "scene_revision", derived, paths);
  if (approved) await approve(graph, "scene", derived);
  return derived;
}

async function shot(
  graph: Graph,
  source: Derived,
  ordinal: number,
  paths?: readonly (readonly string[])[],
  approved = true,
  sourceScriptId = graph.scriptId,
): Promise<Derived> {
  const id = (
    await pool.query<{ id: string } & QueryResultRow>(
      "INSERT INTO shot (workspace_id, project_id, episode_id, scene_id) VALUES ($1,$2,$3,$4) RETURNING id",
      [graph.workspaceId, graph.projectId, graph.episodeId, source.id],
    )
  ).rows[0]!.id;
  const revision = await chain.createShotRevision({
    workspaceId: graph.workspaceId,
    projectId: graph.projectId,
    sceneId: source.id,
    shotId: id,
    sourceSceneRevisionId: source.revisionId,
    ordinal,
    shotType: "wide",
    camera: "static",
    action: "speak",
    dialogue: "hello",
    durationHint: "3",
    promptText: "room",
    createdBy: "author",
    expectedVersion: 1,
  });
  const derived = { id, revisionId: revision.revisionId };
  if (paths) await bind(graph, "shot_revision", derived, paths, sourceScriptId);
  if (approved) await approve(graph, "shot", derived);
  return derived;
}

async function status(
  ids: string[],
): Promise<Record<string, { freshness: string; review: string; reviewedBy: string | null }>> {
  const rows = await pool.query<
    { id: string; freshness: string; review: string; reviewedBy: string | null } & QueryResultRow
  >(
    `SELECT id, freshness_status AS freshness, review_status AS review, reviewed_by AS "reviewedBy"
       FROM scene_revision WHERE id = ANY($1::uuid[])
     UNION ALL
     SELECT id, freshness_status, review_status, reviewed_by FROM shot_revision WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return Object.fromEntries(rows.rows.map((row) => [row.id, row]));
}

async function entity(graph: Graph, kind: "character" | "location"): Promise<Derived> {
  const id = (
    await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO ${kind} (workspace_id,project_id,name) VALUES ($1,$2,$3) RETURNING id`,
      [graph.workspaceId, graph.projectId, kind],
    )
  ).rows[0]!.id;
  const revisionId = (
    await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO ${kind}_revision (workspace_id,project_id,${kind}_id,revision_no,content_json,content_hash,created_by)
     VALUES ($1,$2,$3,1,'{}',$4,'author') RETURNING id`,
      [graph.workspaceId, graph.projectId, id, canonicalInputHash({ kind })],
    )
  ).rows[0]!.id;
  await pool.query(
    `INSERT INTO ${kind}_revision_script_source (workspace_id,project_id,${kind}_revision_id,script_revision_id)
    VALUES ($1,$2,$3,$4)`,
    [graph.workspaceId, graph.projectId, revisionId, graph.scriptId],
  );
  await pool.query(
    `UPDATE ${kind} SET current_revision_id = $2, row_version = row_version + 1 WHERE id = $1`,
    [id, revisionId],
  );
  const derived = { id, revisionId };
  await bind(graph, `${kind}_revision`, derived, [["global"]]);
  const review = await chain.transitionReview({
    table: `${kind}_revision`,
    workspaceId: graph.workspaceId,
    revisionId,
    expectedVersion: await version(kind, id),
    expectedReviewVersion: 1,
    to: "IN_REVIEW",
  });
  await (
    kind === "character" ? chain.approveCharacter.bind(chain) : chain.approveLocation.bind(chain)
  )({
    workspaceId: graph.workspaceId,
    parentId: id,
    revisionId,
    expectedVersion: review.rowVersion,
    expectedReviewVersion: 2,
    reviewedBy: "editor",
  });
  return derived;
}

describe("immutable fine script dependencies", () => {
  it("invalidates only scene A and preserves B provenance, approvals and later draft approval", async () => {
    const graph = await seed();
    const a = await scene(graph, 1, [["global"], ["scenes", "a"]]);
    const b = await scene(graph, 2, [["global"], ["scenes", "b"]]);
    const pendingB = await scene(graph, 3, [["scenes", "b"]], false);
    const aShot = await shot(graph, a, 1, [["scenes", "a"]]);
    const bShot = await shot(graph, b, 1, [["scenes", "b"]]);
    const next = content();
    next.scenes.a.dialogue.a = "changed";
    const replacement = await replace(graph, next);
    let result = await status([a.revisionId, b.revisionId, aShot.revisionId, bShot.revisionId]);
    expect(result[a.revisionId]!.freshness).toBe("STALE");
    expect(result[aShot.revisionId]!.freshness).toBe("STALE");
    expect(result[b.revisionId]).toMatchObject({
      freshness: "CURRENT",
      review: "APPROVED",
      reviewedBy: "editor",
    });
    expect(result[bShot.revisionId]).toMatchObject({
      freshness: "CURRENT",
      review: "APPROVED",
      reviewedBy: "editor",
    });
    const before = (
      await pool.query(
        "SELECT id FROM domain_event WHERE project_id = $1 AND event_type = 'revision.stale'",
        [graph.projectId],
      )
    ).rowCount;
    await approveScript(graph, replacement);
    expect(
      (
        await pool.query(
          "SELECT id FROM domain_event WHERE project_id = $1 AND event_type = 'revision.stale'",
          [graph.projectId],
        )
      ).rowCount,
    ).toBe(before);
    await approve(graph, "scene", pendingB);
    const newBShot = await shot(graph, b, 2, [["scenes", "b"]], true, replacement);
    result = await status([newBShot.revisionId]);
    expect(result[newBShot.revisionId]!.review).toBe("APPROVED");
    const source = await pool.query<{ source_script_revision_id: string } & QueryResultRow>(
      "SELECT source_script_revision_id FROM scene_revision WHERE id = $1",
      [b.revisionId],
    );
    expect(source.rows[0]!.source_script_revision_id).toBe(graph.scriptId);
  });

  it("catches retained v1 descendants on a later edit and never broadens a no-op or reactivates old content", async () => {
    const graph = await seed();
    const a = await scene(graph, 1, [["scenes", "a"]]);
    const b = await scene(graph, 2, [["scenes", "b"]]);
    const bShot = await shot(graph, b, 1, [["scenes", "b"]]);
    const v2 = content();
    v2.scenes.a.dialogue.a = "A2";
    const second = await replace(graph, v2);
    await approveScript(graph, second);
    const noop = await replace(graph, { scenes: v2.scenes, global: v2.global, schema: v2.schema });
    expect((await status([b.revisionId, bShot.revisionId]))[b.revisionId]!.freshness).toBe(
      "CURRENT",
    );
    await approveScript(graph, noop);
    const v4 = content();
    v4.scenes.b.dialogue = "B2";
    await replace(graph, v4);
    const result = await status([a.revisionId, b.revisionId, bShot.revisionId]);
    expect(Object.values(result).every((row) => row.freshness === "STALE")).toBe(true);
    // The v1 -> v2 affected set still sees A even though the newest script changed A back.
    const fixed = await pool.query<{ id: string } & QueryResultRow>(
      affectedScriptConsumerIds("scene_revision"),
      [graph.workspaceId, graph.scriptId],
    );
    expect(fixed.rows.map((row) => row.id)).toContain(a.revisionId);
    expect(fixed.rows.map((row) => row.id)).not.toContain(b.revisionId);
  });

  it("keeps unrelated dialogue shots in the same structurally unchanged scene usable", async () => {
    const graph = await seed();
    const source = await scene(graph, 1, [["global"], ["scenes", "a", "heading"]]);
    const a = await shot(graph, source, 1, [["scenes", "a", "dialogue", "a"]]);
    const b = await shot(graph, source, 2, [["scenes", "a", "dialogue", "b"]], false);
    const next = content();
    next.scenes.a.dialogue.a = "new line";
    const replacement = await replace(graph, next);
    const result = await status([source.revisionId, a.revisionId, b.revisionId]);
    expect(result[source.revisionId]!.freshness).toBe("CURRENT");
    expect(result[a.revisionId]).toMatchObject({
      freshness: "STALE",
      review: "APPROVED",
      reviewedBy: "editor",
    });
    expect(result[b.revisionId]!.freshness).toBe("CURRENT");
    await approveScript(graph, replacement);
    await approve(graph, "shot", b);
  });

  it("treats deleted paths as changed and rejects unknown or empty scopes without weakening legacy fallback", async () => {
    const graph = await seed();
    const scoped = await scene(graph, 1, [["scenes", "b"]]);
    const legacy = await scene(graph, 2, undefined, false);
    await expect(
      bind(graph, "scene_revision", legacy, [["scenes", "a"], ["missing"]]),
    ).rejects.toThrow(/path does not exist/);
    await expect(bind(graph, "scene_revision", legacy, [])).rejects.toMatchObject({
      code: "INVALID_SOURCE_REFERENCE",
    });
    const scopes = await pool.query(
      "SELECT id FROM script_source_dependency WHERE consumer_revision_id = $1",
      [legacy.revisionId],
    );
    expect(scopes.rows).toHaveLength(0);
    const next: Omit<Content, "scenes"> & { scenes: Pick<Content["scenes"], "a"> } = content();
    next.scenes = { a: next.scenes.a };
    await replace(graph, next);
    const result = await status([scoped.revisionId, legacy.revisionId]);
    expect(result[scoped.revisionId]!.freshness).toBe("STALE");
    expect(result[legacy.revisionId]!.freshness).toBe("STALE");
  });

  it("preserves whole-script legacy dependencies for a byte-equivalent JSON no-op", async () => {
    const graph = await seed();
    const legacy = await scene(graph, 1);
    const revision = await replace(graph, content());
    await approveScript(graph, revision);
    expect((await status([legacy.revisionId]))[legacy.revisionId]!.freshness).toBe("CURRENT");
  });

  it("narrows shared character/location edges and still propagates their later changes", async () => {
    const graph = await seed();
    const character = await entity(graph, "character");
    const location = await entity(graph, "location");
    const located = await scene(graph, 1, [["scenes", "b"]], true, location.revisionId);
    const cast = await shot(graph, located, 1, [["scenes", "b"]], false);
    await pool.query(
      `INSERT INTO shot_character_reference (workspace_id,project_id,shot_revision_id,character_revision_id,role)
      VALUES ($1,$2,$3,$4,'lead')`,
      [graph.workspaceId, graph.projectId, cast.revisionId, character.revisionId],
    );
    await approve(graph, "shot", cast);
    const unrelated = await scene(graph, 2, [["scenes", "b"]]);
    const changed = content();
    changed.scenes.a.dialogue.a = "A2";
    const second = await replace(graph, changed);
    expect(
      (await status([located.revisionId, cast.revisionId]))[located.revisionId]!.freshness,
    ).toBe("CURRENT");
    const shared = await pool.query<{ freshness_status: string } & QueryResultRow>(
      `SELECT freshness_status FROM character_revision WHERE id = $1
       UNION ALL SELECT freshness_status FROM location_revision WHERE id = $2`,
      [character.revisionId, location.revisionId],
    );
    expect(shared.rows.every((row) => row.freshness_status === "CURRENT")).toBe(true);
    await approveScript(graph, second);
    changed.global.tone = "tense";
    await replace(graph, changed);
    const result = await status([located.revisionId, cast.revisionId, unrelated.revisionId]);
    expect(result[located.revisionId]!.freshness).toBe("STALE");
    expect(result[cast.revisionId]!.freshness).toBe("STALE");
    expect(result[unrelated.revisionId]!.freshness).toBe("CURRENT");
  });

  it("isolates projects/workspaces and rejects cross-project binding", async () => {
    const graph = await seed();
    const sameWorkspace = await seed(graph.workspaceId);
    const otherWorkspace = await seed();
    const own = await scene(graph, 1, [["scenes", "a"]]);
    const neighbor = await scene(sameWorkspace, 1, [["scenes", "a"]]);
    const outside = await scene(otherWorkspace, 1, [["scenes", "a"]]);
    const draft = await scene(graph, 2, undefined, false);
    await expect(
      bind(graph, "scene_revision", draft, [["scenes", "a"]], sameWorkspace.scriptId),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE_REFERENCE" });
    await expect(bind(graph, "scene_revision", neighbor, [["global"]])).rejects.toMatchObject({
      code: "INVALID_SOURCE_REFERENCE",
    });
    const next = content();
    next.scenes.a.dialogue.a = "isolated";
    await replace(graph, next);
    const result = await status([own.revisionId, neighbor.revisionId, outside.revisionId]);
    expect(result[own.revisionId]!.freshness).toBe("STALE");
    expect(result[neighbor.revisionId]!.freshness).toBe("CURRENT");
    expect(result[outside.revisionId]!.freshness).toBe("CURRENT");
  });

  it("freezes input provenance at review and enforces typed foreign keys and immutable replacement facts", async () => {
    const graph = await seed();
    const draft = await scene(graph, 1, [["scenes", "a"]], false);
    await expect(
      pool.query(
        "UPDATE script_source_dependency SET source_path = ARRAY['scenes','b'] WHERE consumer_revision_id = $1",
        [draft.revisionId],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      pool.query("DELETE FROM script_source_dependency WHERE consumer_revision_id = $1", [
        draft.revisionId,
      ]),
    ).rejects.toThrow(/immutable/);
    const another = await scene(graph, 2, undefined, false);
    await expect(
      pool.query(
        `INSERT INTO script_source_dependency
      (workspace_id,project_id,script_revision_id,consumer_type,consumer_revision_id,shot_revision_id,source_path,source_value,source_value_hash)
      VALUES ($1,$2,$3,'scene_revision',$4,$4,ARRAY['scenes','b'],'null','')`,
        [graph.workspaceId, graph.projectId, graph.scriptId, another.revisionId],
      ),
    ).rejects.toThrow(/check constraint/);
    await approve(graph, "scene", draft);
    await expect(bind(graph, "scene_revision", draft, [["global"]])).rejects.toMatchObject({
      code: "INVALID_SOURCE_REFERENCE",
    });
    const next = content();
    next.scenes.a.dialogue.a = "new";
    const replacement = await replace(graph, next);
    await expect(
      pool.query(
        "UPDATE script_revision_replacement SET new_script_revision_id = $1 WHERE previous_script_revision_id = $2",
        [graph.scriptId, graph.scriptId],
      ),
    ).rejects.toThrow(/immutable/);
    const facts = await pool.query<{ new_script_revision_id: string } & QueryResultRow>(
      "SELECT new_script_revision_id FROM script_revision_replacement WHERE previous_script_revision_id = $1",
      [graph.scriptId],
    );
    expect(facts.rows[0]!.new_script_revision_id).toBe(replacement);
  });

  it("continues a 205-target fine script change without staling its unaffected control or repeating events", async () => {
    const graph = await seed();
    const targets: string[] = [];
    for (let ordinal = 1; ordinal <= 205; ordinal += 1) {
      const source = await scene(graph, ordinal, [["scenes", "a"]], false);
      const derived = await shot(graph, source, 1, [["scenes", "a"]], false);
      targets.push(source.revisionId, derived.revisionId);
    }
    const controlScene = await scene(graph, 206, [["scenes", "b"]], false);
    const controlShot = await shot(graph, controlScene, 1, [["scenes", "b"]], false);
    const next = content();
    next.scenes.a.dialogue.a = "large scoped replacement";
    await replace(graph, next);
    const pending = await pool.query<{ status: string } & QueryResultRow>(
      "SELECT status FROM stale_recalculation WHERE project_id = $1 AND stale_from_ref = $2",
      [graph.projectId, `script_revision:${graph.scriptId}`],
    );
    expect(pending.rows[0]!.status).toBe("PENDING");
    expect(
      Object.values(await status(targets)).filter((row) => row.freshness === "CURRENT"),
    ).toHaveLength(10);
    // This regression is integrated with the P1 continuation implementation in the same PR.
    const resumed = new TextChainService(pool);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (!(await resumed.continueStaleRecalculation())) break;
    }
    expect(await resumed.continueStaleRecalculation()).toBe(false);
    expect(Object.values(await status(targets)).every((row) => row.freshness === "STALE")).toBe(
      true,
    );
    expect(
      Object.values(await status([controlScene.revisionId, controlShot.revisionId])).every(
        (row) => row.freshness === "CURRENT",
      ),
    ).toBe(true);
    const emitted = await pool.query<{ aggregate_id: string } & QueryResultRow>(
      "SELECT aggregate_id FROM domain_event WHERE project_id = $1 AND event_type = 'revision.stale'",
      [graph.projectId],
    );
    expect(emitted.rows).toHaveLength(410);
    expect(new Set(emitted.rows.map((row) => row.aggregate_id)).size).toBe(410);
    const done = await pool.query<{ status: string } & QueryResultRow>(
      "SELECT status FROM stale_recalculation WHERE project_id = $1",
      [graph.projectId],
    );
    expect(done.rows[0]!.status).toBe("DONE");
  }, 90_000);
});
