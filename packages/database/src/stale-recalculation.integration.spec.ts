import { Pool, type QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "./migrations";
import { TextChainService } from "./text-chain";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
const pool = new Pool({ connectionString: databaseUrl, max: 8 });
const chain = new TextChainService(pool);
const hash = "cd".repeat(32);

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

async function seedProject(workspaceId?: string) {
  const workspace =
    workspaceId ??
    (
      await pool.query<{ id: string } & QueryResultRow>(
        "INSERT INTO workspace (name) VALUES ('continuation') RETURNING id",
      )
    ).rows[0]!.id;
  const projectId = (
    await pool.query<{ id: string } & QueryResultRow>(
      "INSERT INTO project (workspace_id, title) VALUES ($1, 'continuation') RETURNING id",
      [workspace],
    )
  ).rows[0]!.id;
  const story = await chain.createStoryRevision({
    workspaceId: workspace,
    projectId,
    expectedVersion: 1,
    createdBy: "author",
    content: { premise: "source" },
  });
  const review = await chain.transitionReview({
    table: "story_revision",
    workspaceId: workspace,
    revisionId: story.revisionId,
    expectedVersion: story.rowVersion,
    expectedReviewVersion: 1,
    to: "IN_REVIEW",
  });
  await chain.approveStory({
    workspaceId: workspace,
    projectId,
    revisionId: story.revisionId,
    expectedVersion: review.rowVersion,
    expectedReviewVersion: 2,
    reviewedBy: "editor",
  });
  const episodeId = (
    await pool.query<{ id: string } & QueryResultRow>(
      "SELECT id FROM episode WHERE project_id = $1 AND episode_no = 1",
      [projectId],
    )
  ).rows[0]!.id;
  return { workspaceId: workspace, projectId, storyId: story.revisionId, episodeId };
}

async function replaceStory(scope: Awaited<ReturnType<typeof seedProject>>) {
  const version = (
    await pool.query<{ version: number } & QueryResultRow>(
      "SELECT version FROM project WHERE id = $1",
      [scope.projectId],
    )
  ).rows[0]!.version;
  return chain.createStoryRevision({
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    expectedVersion: version,
    createdBy: "author",
    content: { premise: "replacement" },
  });
}

async function seedLargeGraph(workspaceId?: string) {
  const scope = await seedProject(workspaceId);
  await pool.query(
    `INSERT INTO script_revision
      (workspace_id, project_id, episode_id, revision_no, source_story_revision_id,
       content_json, content_hash, created_by)
     SELECT $1, $2, $3, n, $4, jsonb_build_object('revision', n), $5, 'author'
       FROM generate_series(1, 401) n`,
    [scope.workspaceId, scope.projectId, scope.episodeId, scope.storyId, hash],
  );
  const replacement = await replaceStory(scope);
  return { ...scope, replacement };
}

async function snapshot(projectId: string) {
  const result = await pool.query<
    { stale: number; current: number; events: number; status: string | null } & QueryResultRow
  >(
    `SELECT
       (SELECT COUNT(*)::int FROM script_revision WHERE project_id = $1 AND freshness_status = 'STALE') AS stale,
       (SELECT COUNT(*)::int FROM script_revision WHERE project_id = $1 AND freshness_status = 'CURRENT') AS current,
       (SELECT COUNT(*)::int FROM domain_event WHERE project_id = $1 AND event_type = 'revision.stale') AS events,
       (SELECT status FROM stale_recalculation WHERE project_id = $1 LIMIT 1) AS status`,
    [projectId],
  );
  return result.rows[0]!;
}

async function drain(source = chain): Promise<void> {
  for (let batch = 0; batch < 10; batch += 1) {
    if (!(await source.continueStaleRecalculation())) return;
  }
  throw new Error("Stale continuation did not finish");
}

describe("durable stale continuation", () => {
  it("finishes 401 dependencies across restarted and competing consumers exactly once", async () => {
    const graph = await seedLargeGraph();
    expect(await snapshot(graph.projectId)).toEqual({
      stale: 200,
      current: 201,
      events: 200,
      status: "PENDING",
    });
    const restarted = new TextChainService(pool);
    expect(await restarted.continueStaleRecalculation()).toBe(true);
    expect(await snapshot(graph.projectId)).toEqual({
      stale: 400,
      current: 1,
      events: 400,
      status: "PENDING",
    });
    await Promise.all([
      new TextChainService(pool).continueStaleRecalculation(),
      new TextChainService(pool).continueStaleRecalculation(),
    ]);
    await drain(restarted);
    expect(await snapshot(graph.projectId)).toEqual({
      stale: 401,
      current: 0,
      events: 401,
      status: "DONE",
    });
    expect(await chain.continueStaleRecalculation()).toBe(false);
    const versions = await pool.query<{ review_version: number } & QueryResultRow>(
      "SELECT DISTINCT review_version FROM script_revision WHERE project_id = $1",
      [graph.projectId],
    );
    expect(versions.rows).toEqual([{ review_version: 2 }]);

    // Approving the replacement does not re-open completed work or stale rows again.
    const review = await chain.transitionReview({
      table: "story_revision",
      workspaceId: graph.workspaceId,
      revisionId: graph.replacement.revisionId,
      expectedVersion: graph.replacement.rowVersion,
      expectedReviewVersion: 1,
      to: "IN_REVIEW",
    });
    await chain.approveStory({
      workspaceId: graph.workspaceId,
      projectId: graph.projectId,
      revisionId: graph.replacement.revisionId,
      expectedVersion: review.rowVersion,
      expectedReviewVersion: 2,
      reviewedBy: "editor",
    });
    expect(await snapshot(graph.projectId)).toEqual({
      stale: 401,
      current: 0,
      events: 401,
      status: "DONE",
    });
  });

  it("rolls a failed continuation batch back and retries from persisted CURRENT rows", async () => {
    const graph = await seedLargeGraph();
    await pool.query(`CREATE FUNCTION test_fail_stale_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.trace_id LIKE 'stale-recalculation:%' THEN RAISE EXCEPTION 'test batch failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_fail_stale_event BEFORE INSERT ON domain_event
      FOR EACH ROW EXECUTE FUNCTION test_fail_stale_event()`);
    try {
      await expect(chain.continueStaleRecalculation()).rejects.toThrow("test batch failure");
      expect(await snapshot(graph.projectId)).toEqual({
        stale: 200,
        current: 201,
        events: 200,
        status: "PENDING",
      });
    } finally {
      await pool.query(
        "DROP TRIGGER test_fail_stale_event ON domain_event; DROP FUNCTION test_fail_stale_event()",
      );
    }
    await drain(new TextChainService(pool));
    expect(await snapshot(graph.projectId)).toEqual({
      stale: 401,
      current: 0,
      events: 401,
      status: "DONE",
    });
  });

  it("skips a locked project and leaves its graph unchanged while processing another project", async () => {
    const first = await seedLargeGraph();
    const second = await seedLargeGraph(first.workspaceId);
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM project WHERE id = $1 FOR UPDATE", [first.projectId]);
      await chain.continueStaleRecalculation();
      expect(await snapshot(first.projectId)).toEqual({
        stale: 200,
        current: 201,
        events: 200,
        status: "PENDING",
      });
      expect(await snapshot(second.projectId)).toEqual({
        stale: 400,
        current: 1,
        events: 400,
        status: "PENDING",
      });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    await drain();
    expect((await snapshot(first.projectId)).status).toBe("DONE");
    expect((await snapshot(second.projectId)).status).toBe("DONE");
  });

  it("deduplicates shared source edges before applying the batch limit", async () => {
    const scope = await seedProject();
    await pool.query(
      `INSERT INTO script_revision
        (workspace_id, project_id, episode_id, revision_no, source_story_revision_id, content_json, content_hash, created_by)
       SELECT workspace_id, project_id, id, 1, $2, '{}', $3, 'author'
         FROM episode WHERE project_id = $1 AND episode_no IN (1, 2)`,
      [scope.projectId, scope.storyId, hash],
    );
    await pool.query(
      `UPDATE episode e SET current_script_revision_id = sr.id FROM script_revision sr
        WHERE e.id = sr.episode_id AND e.project_id = $1`,
      [scope.projectId],
    );
    await pool.query(
      `INSERT INTO character (workspace_id, project_id, name)
       SELECT $1, $2, 'character-' || n FROM generate_series(1, 205) n`,
      [scope.workspaceId, scope.projectId],
    );
    await pool.query(
      `INSERT INTO character_revision
        (workspace_id, project_id, character_id, revision_no, content_json, content_hash, created_by)
       SELECT workspace_id, project_id, id, 1, '{}', $2, 'author' FROM character WHERE project_id = $1`,
      [scope.projectId, hash],
    );
    await pool.query(
      `INSERT INTO character_revision_script_source
        (workspace_id, project_id, character_revision_id, script_revision_id)
       SELECT cr.workspace_id, cr.project_id, cr.id, sr.id
         FROM character_revision cr JOIN script_revision sr ON sr.project_id = cr.project_id
        WHERE cr.project_id = $1`,
      [scope.projectId],
    );
    await replaceStory(scope);
    const counts = await pool.query<{ freshness_status: string; count: number } & QueryResultRow>(
      `SELECT freshness_status, COUNT(*)::int AS count FROM character_revision
        WHERE project_id = $1 GROUP BY freshness_status`,
      [scope.projectId],
    );
    expect(Object.fromEntries(counts.rows.map((row) => [row.freshness_status, row.count]))).toEqual(
      { CURRENT: 5, STALE: 200 },
    );
    await drain();
    const remaining = await pool.query(
      "SELECT 1 FROM character_revision WHERE project_id = $1 AND freshness_status = 'CURRENT'",
      [scope.projectId],
    );
    expect(remaining.rows).toHaveLength(0);
  });
});

async function seedShot() {
  const scope = await seedProject();
  const script = await chain.createScriptRevision({
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    episodeId: scope.episodeId,
    sourceStoryRevisionId: scope.storyId,
    expectedVersion: 1,
    createdBy: "author",
    content: { dialogue: "hello" },
  });
  const sceneId = (
    await pool.query<{ id: string } & QueryResultRow>(
      "INSERT INTO scene (workspace_id, project_id, episode_id) VALUES ($1, $2, $3) RETURNING id",
      [scope.workspaceId, scope.projectId, scope.episodeId],
    )
  ).rows[0]!.id;
  const sceneRevisionId = (
    await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO scene_revision
      (workspace_id, project_id, episode_id, scene_id, revision_no, source_script_revision_id,
       ordinal, heading, summary, content_hash, created_by)
     VALUES ($1,$2,$3,$4,1,$5,1,'INT. ROOM','room',$6,'author') RETURNING id`,
      [scope.workspaceId, scope.projectId, scope.episodeId, sceneId, script.revisionId, hash],
    )
  ).rows[0]!.id;
  await pool.query("UPDATE scene SET current_revision_id = $2 WHERE id = $1", [
    sceneId,
    sceneRevisionId,
  ]);
  const shotId = (
    await pool.query<{ id: string } & QueryResultRow>(
      "INSERT INTO shot (workspace_id, project_id, episode_id, scene_id) VALUES ($1,$2,$3,$4) RETURNING id",
      [scope.workspaceId, scope.projectId, scope.episodeId, sceneId],
    )
  ).rows[0]!.id;
  const input = {
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    sceneId,
    shotId,
    sourceSceneRevisionId: sceneRevisionId,
    ordinal: 1,
    shotType: "close",
    camera: "static",
    action: "look",
    dialogue: null,
    durationHint: null,
    promptText: "room",
    createdBy: "author",
    expectedVersion: 1,
  };
  const shot = await chain.createShotRevision(input);
  return { ...scope, script, sceneId, sceneRevisionId, shotId, shot, input };
}

describe("incomplete propagation gates", () => {
  it("blocks all existing revision and review mutations until project propagation finishes", async () => {
    const graph = await seedShot();
    const entities: { table: "character" | "location"; parentId: string; revisionId: string }[] =
      [];
    for (const table of ["character", "location"] as const) {
      const parentId = (
        await pool.query<{ id: string } & QueryResultRow>(
          `INSERT INTO ${table} (workspace_id, project_id, name) VALUES ($1,$2,$3) RETURNING id`,
          [graph.workspaceId, graph.projectId, table],
        )
      ).rows[0]!.id;
      const revisionId = (
        await pool.query<{ id: string } & QueryResultRow>(
          `INSERT INTO ${table}_revision
          (workspace_id, project_id, ${table}_id, revision_no, content_json, content_hash, created_by)
         VALUES ($1,$2,$3,1,'{}',$4,'author') RETURNING id`,
          [graph.workspaceId, graph.projectId, parentId, hash],
        )
      ).rows[0]!.id;
      await pool.query(`UPDATE ${table} SET current_revision_id = $2 WHERE id = $1`, [
        parentId,
        revisionId,
      ]);
      entities.push({ table, parentId, revisionId });
    }
    await pool.query(
      `INSERT INTO stale_recalculation (workspace_id, project_id, stale_from_ref, reason)
       VALUES ($1,$2,$3,'SOURCE_STORY_REPLACED')`,
      [graph.workspaceId, graph.projectId, `story_revision:${graph.storyId}`],
    );
    const approvals = {
      workspaceId: graph.workspaceId,
      expectedVersion: 1,
      expectedReviewVersion: 1,
      reviewedBy: "editor",
    };
    const calls: (() => Promise<unknown>)[] = [
      () => replaceStory(graph),
      () =>
        chain.createScriptRevision({
          workspaceId: graph.workspaceId,
          projectId: graph.projectId,
          episodeId: graph.episodeId,
          sourceStoryRevisionId: graph.storyId,
          expectedVersion: graph.script.rowVersion,
          createdBy: "author",
          content: { dialogue: "changed" },
        }),
      () => chain.createShotRevision({ ...graph.input, expectedVersion: graph.shot.rowVersion }),
      () =>
        chain.transitionReview({
          table: "shot_revision",
          workspaceId: graph.workspaceId,
          revisionId: graph.shot.revisionId,
          expectedVersion: graph.shot.rowVersion,
          expectedReviewVersion: 1,
          to: "IN_REVIEW",
        }),
      () =>
        chain.approveStory({ ...approvals, projectId: graph.projectId, revisionId: graph.storyId }),
      () =>
        chain.approveScript({
          ...approvals,
          episodeId: graph.episodeId,
          revisionId: graph.script.revisionId,
        }),
      () =>
        chain.approveScene({
          ...approvals,
          parentId: graph.sceneId,
          revisionId: graph.sceneRevisionId,
        }),
      () =>
        chain.approveShot({
          ...approvals,
          parentId: graph.shotId,
          revisionId: graph.shot.revisionId,
        }),
      ...entities.map(
        (entity) => () =>
          entity.table === "character"
            ? chain.approveCharacter({ ...approvals, ...entity })
            : chain.approveLocation({ ...approvals, ...entity }),
      ),
    ];
    for (const call of calls) await expect(call()).rejects.toMatchObject({ code: "SOURCE_STALE" });
    const unrelated = await seedProject(graph.workspaceId);
    await expect(replaceStory(unrelated)).resolves.toHaveProperty("revisionId");
  });

  it("rejects a STALE scene source after its continuation has completed", async () => {
    const graph = await seedShot();
    await replaceStory(graph);
    await drain();
    await expect(
      chain.createShotRevision({ ...graph.input, expectedVersion: graph.shot.rowVersion }),
    ).rejects.toMatchObject({ code: "SOURCE_STALE" });
  });

  it("rejects a historical scene source even when that revision remains CURRENT", async () => {
    const graph = await seedShot();
    const replacement = (
      await pool.query<{ id: string } & QueryResultRow>(
        `INSERT INTO scene_revision
        (workspace_id, project_id, episode_id, scene_id, revision_no, source_script_revision_id,
         ordinal, heading, summary, content_hash, created_by)
       VALUES ($1,$2,$3,$4,2,$5,1,'INT. NEW','new room',$6,'author') RETURNING id`,
        [
          graph.workspaceId,
          graph.projectId,
          graph.episodeId,
          graph.sceneId,
          graph.script.revisionId,
          hash,
        ],
      )
    ).rows[0]!.id;
    await pool.query("UPDATE scene SET current_revision_id = $2 WHERE id = $1", [
      graph.sceneId,
      replacement,
    ]);
    await expect(
      chain.createShotRevision({ ...graph.input, expectedVersion: graph.shot.rowVersion }),
    ).rejects.toMatchObject({ code: "SOURCE_STALE" });
    const count = (
      await pool.query<{ count: number } & QueryResultRow>(
        "SELECT COUNT(*)::int AS count FROM shot_revision WHERE shot_id = $1",
        [graph.shotId],
      )
    ).rows[0]!.count;
    expect(count).toBe(1);
  });
});
