/**
 * Guarded E2-B SQL-draft acceptance. This file does not use DATABASE_URL, drop schemas or truncate existing data.
 * Run only after independent draft review, on a named, new, empty, disposable database, with BOTH acceptance flags.
 * The ordinary test/integration commands never collect this suite. No provider, model, worker or media file is used.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SCRIPT_BREAKDOWN_CALL_CAP, SCRIPT_BREAKDOWN_INPUT_SCHEMA, SCRIPT_BREAKDOWN_PROMPT_VERSION,
  VIMAX_CANDIDATE_CREATE_SCHEMA, VIMAX_CANDIDATE_PLACE_SHOTS_SCHEMA, VIMAX_CANDIDATE_SAVE_SCENE_SCHEMA,
  VIMAX_CANDIDATE_SQL_DRAFT, VIMAX_PLATFORM_PREVIEW_REQUEST_SCHEMA,
  vimaxCandidateCreateSchema, vimaxEvaluationInputSchema, vimaxEvaluationSupplementsSchema, vimaxPlanCandidateSchema,
  type ScriptBreakdownFrozenInput, type TitleRunRecord, type VimaxCandidateCreate, type VimaxCandidateView,
} from "@ai-drama/contracts";
import { canonicalInputHash } from "@ai-drama/domain";
import { runMigrations } from "./migrations";
import { TextChainService } from "./text-chain";
import { PostgresTitleWritingStore } from "./title-writing-store";
import { checkTitleWritingAcceptanceEnv, verifyTitleWritingAcceptanceDatabase } from "./title-writing-acceptance-guard";
import { VimaxCandidateStore } from "./vimax-candidate-store";
import type { DatabasePool } from "./job-service";

const decision = checkTitleWritingAcceptanceEnv(process.env);
if (!decision.ok) throw new Error(`ViMax candidate acceptance refused: ${decision.reason}`);
if (process.env.VIMAX_CANDIDATE_ACCEPTANCE_DRAFT_AUTHORIZED !== "true") {
  throw new Error("ViMax candidate acceptance refused: VIMAX_CANDIDATE_ACCEPTANCE_DRAFT_AUTHORIZED must be true after draft review.");
}
const pool = new Pool({ connectionString: decision.url, max: 8, connectionTimeoutMillis: 5_000,
  statement_timeout: 15_000, query_timeout: 20_000, application_name: "vimax-candidate-draft-acceptance" });
const chain = new TextChainService(pool);
const store = new VimaxCandidateStore(pool, chain);
const actor = "server-owner";
const trace = "vimax-candidate-acceptance";
let initialReady = true;
let discovered: string[] = [];
let fixture!: {
  input: ReturnType<typeof vimaxEvaluationInputSchema.parse>;
  candidate: ReturnType<typeof vimaxPlanCandidateSchema.parse>;
  supplements: ReturnType<typeof vimaxEvaluationSupplementsSchema.parse>;
};

beforeAll(async () => {
  const safe = await verifyTitleWritingAcceptanceDatabase(pool, decision.databaseName);
  if (!safe.ok) throw new Error(`ViMax candidate acceptance refused before writes: ${safe.reason}`);
  const migrated = await runMigrations(pool);
  discovered = [...migrated.applied, ...migrated.alreadyApplied];
  initialReady = await store.storageReady();
  if (initialReady) throw new Error("ViMax draft unexpectedly appeared in the ordinary migration chain.");
  const sql = await readFile(resolve(__dirname, "../prisma/drafts/20261031000100_vimax_storyboard_candidate.sql"), "utf8");
  await transaction(async (client) => { await client.query(sql); });
  const raw = JSON.parse(await readFile(resolve(__dirname, "../../../scripts/vimax-evaluation/fixtures/single-scene.json"), "utf8")) as Record<string, unknown>;
  fixture = { input: vimaxEvaluationInputSchema.parse(raw.input), candidate: vimaxPlanCandidateSchema.parse(raw.candidate),
    supplements: vimaxEvaluationSupplementsSchema.parse(raw.supplements) };
});
afterAll(async () => { await pool.end(); });

async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
async function scalar(sql: string, values: unknown[] = []): Promise<string> {
  return (await pool.query<{ id: string }>(sql, values)).rows[0]!.id;
}
async function rowVersion(table: "project" | "episode" | "scene" | "character", id: string): Promise<number> {
  return Number((await pool.query<Record<string, number>>(`SELECT ${table === "project" ? "version" : "row_version"} AS value FROM ${table} WHERE id=$1`, [id])).rows[0]!.value);
}
async function approveText(table: "story_revision" | "script_revision", workspaceId: string, projectId: string, revisionId: string, expectedVersion: number, episodeId?: string) {
  const review = await chain.transitionReview({ table, workspaceId, revisionId, expectedVersion, expectedReviewVersion: 1, to: "IN_REVIEW" });
  if (table === "story_revision") await chain.approveStory({ workspaceId, projectId, revisionId,
    expectedVersion: review.rowVersion, expectedReviewVersion: review.reviewVersion, reviewedBy: "editor" });
  else await chain.approveScript({ workspaceId, episodeId: episodeId!, revisionId,
    expectedVersion: review.rowVersion, expectedReviewVersion: review.reviewVersion, reviewedBy: "editor" });
}

/** Independent works avoid truncation/deletion and also keep pending-stale cases isolated from other tests. */
async function world(paddedDialogue = false) {
  const localFixture = structuredClone(fixture);
  if (paddedDialogue) {
    // Preserve deliberate leading/trailing spaces after the speaker delimiter, including their source offsets.
    for (const line of localFixture.input.sourceDialogue) {
      localFixture.input.scriptText = localFixture.input.scriptText.replace(`${line.speaker}：${line.line}`, `${line.speaker}：  ${line.line}  `);
    }
    let from = 0;
    for (const line of localFixture.input.sourceDialogue) {
      line.line = `  ${line.line}  `;
      const physical = `${line.speaker}：${line.line}`;
      line.start = localFixture.input.scriptText.indexOf(physical, from);
      line.end = line.start + physical.length;
      from = line.end;
    }
    localFixture.input.sceneSpans[0]!.end = localFixture.input.scriptText.length;
    for (const shot of localFixture.supplements.shots) for (const line of shot.dialogue) {
      line.line = localFixture.input.sourceDialogue.find((source) => source.id === line.sourceDialogueId)!.line;
    }
  }
  const workspaceId = await scalar("INSERT INTO workspace (name) VALUES ('ViMax synthetic acceptance') RETURNING id");
  const projectId = await scalar("INSERT INTO project (workspace_id,title) VALUES ($1,'ViMax synthetic acceptance') RETURNING id", [workspaceId]);
  const story = await chain.createStoryRevision({ workspaceId, projectId, content: { text: "Synthetic journey" }, createdBy: actor, expectedVersion: 1 });
  await approveText("story_revision", workspaceId, projectId, story.revisionId, story.rowVersion);
  const episodeId = await scalar("SELECT id FROM episode WHERE project_id=$1 AND episode_no=1", [projectId]);
  const tail = "【场景】外景 街道\n【动作】行人穿过路口。\n";
  const text = localFixture.input.scriptText + tail;
  const script = await chain.createScriptRevision({ workspaceId, projectId, episodeId, sourceStoryRevisionId: story.revisionId,
    content: { text }, createdBy: actor, expectedVersion: await rowVersion("episode", episodeId) });
  await approveText("script_revision", workspaceId, projectId, script.revisionId, script.rowVersion, episodeId);
  for (const name of ["林晚", "陈默"]) {
    const expectedVersion = await rowVersion("project", projectId);
    await transaction((client) => chain.createTextEntityRevisionInTransaction(client, { kind: "character", workspaceId, projectId,
      name, sourceScriptRevisionId: script.revisionId, content: { description: "Synthetic character" }, createdBy: actor,
      expectedVersion }));
  }
  const targetParentVersion = await rowVersion("episode", episodeId);
  const target = await transaction((client) => chain.createSceneRevisionInTransaction(client, { workspaceId, projectId, episodeId,
    sourceScriptRevisionId: script.revisionId, ordinal: 1, heading: localFixture.input.sceneSpans[0]!.heading, timeOfDay: "夜", summary: "Original target scene.",
    createdBy: actor, expectedVersion: targetParentVersion }));
  const siblingParentVersion = await rowVersion("episode", episodeId);
  const sibling = await transaction((client) => chain.createSceneRevisionInTransaction(client, { workspaceId, projectId, episodeId,
    sourceScriptRevisionId: script.revisionId, ordinal: 2, heading: "外景 街道", summary: "Preserve this other scene.",
    createdBy: actor, expectedVersion: siblingParentVersion }));
  // A real immutable asset/provenance record attached only to the unrelated scene: no provider or file is involved.
  const assetId = await scalar(`INSERT INTO asset (workspace_id,project_id,kind,storage_provider,object_key,mime_type,byte_size,checksum_sha256,source_kind)
    VALUES ($1,$2,'IMAGE','test-only',$3,'image/png',0,$4,'UPLOAD') RETURNING id`, [workspaceId, projectId, randomUUID(), "a".repeat(64)]);
  await pool.query("INSERT INTO asset_revision_dependency (workspace_id,project_id,dependent_asset_id,scene_revision_id) VALUES ($1,$2,$3,$4)",
    [workspaceId, projectId, assetId, sibling.revisionId]);
  const options = await store.targets(workspaceId, projectId, episodeId);
  const targetSnapshot = options.targets.find((item) => item.sceneId === target.entityId)!;
  const originalNames = new Map(localFixture.input.characters.map((item) => [item.key, item.name]));
  const keysByName = new Map(options.source.characters.map((item) => [item.name, item.key]));
  const mapped = (key: string) => keysByName.get(originalNames.get(key)!)!;
  const supplements = localFixture.supplements;
  supplements.characters.forEach((item) => { item.characterKey = mapped(item.characterKey); });
  supplements.shots.forEach((shot) => {
    shot.characterKeys = shot.characterKeys.map(mapped);
    shot.dialogue.forEach((line) => { if (line.characterKey !== null) line.characterKey = mapped(line.characterKey); });
  });
  const body = vimaxCandidateCreateSchema.parse({ schema: VIMAX_CANDIDATE_CREATE_SCHEMA,
    target: { sceneId: target.entityId, sceneRevisionId: target.revisionId, rowVersion: targetSnapshot.rowVersion },
    request: { schema: VIMAX_PLATFORM_PREVIEW_REQUEST_SCHEMA,
      source: { scriptRevisionId: options.source.scriptRevisionId, scriptContentHash: options.source.scriptContentHash, characters: options.source.characters },
      sceneSpans: [...localFixture.input.sceneSpans, { key: "S2", start: localFixture.input.scriptText.length, end: text.length,
        heading: "外景 街道", timeOfDay: "", description: "行人穿过路口。" }], selectedSceneKeys: ["S1"],
      sourceDialogue: localFixture.input.sourceDialogue.map((line) => ({ ...line, characterKey: mapped(line.characterKey!) })),
      requirements: localFixture.input.requirements, candidate: localFixture.candidate, supplements,
    } });
  return { workspaceId, projectId, episodeId, storyId: story.revisionId, scriptId: script.revisionId,
    target, sibling, assetId, body, text };
}
type World = Awaited<ReturnType<typeof world>>;
const create = (w: World, key = randomUUID(), body: VimaxCandidateCreate = w.body) =>
  store.create(w.workspaceId, w.projectId, w.episodeId, actor, key, body, trace);
const save = (w: World, candidate: VimaxCandidateView, key = randomUUID()) => store.saveScene(w.workspaceId, w.projectId, w.episodeId, actor,
  candidate.candidateId, key, { schema: VIMAX_CANDIDATE_SAVE_SCENE_SCHEMA, expectedVersion: candidate.rowVersion, confirmedReview: true }, trace);
const place = (w: World, candidateId: string, key = randomUUID(), expectedVersion = 2) => store.placeShots(w.workspaceId, w.projectId, w.episodeId, actor,
  candidateId, key, { schema: VIMAX_CANDIDATE_PLACE_SHOTS_SCHEMA, expectedVersion, confirmedReview: true }, trace);
async function approveScene(w: World, revisionId: string) {
  const row = (await pool.query<{ current_revision_id: string; row_version: number; review_version: number }>(
    `SELECT s.current_revision_id,s.row_version,r.review_version FROM scene s JOIN scene_revision r ON r.id=s.current_revision_id WHERE s.id=$1`, [w.target.entityId])).rows[0]!;
  expect(row.current_revision_id).toBe(revisionId);
  const review = await transaction((client) => chain.reviewSceneShotInTransaction(client, { kind: "scene", workspaceId: w.workspaceId,
    projectId: w.projectId, episodeId: w.episodeId, sceneId: w.target.entityId, revisionId, expectedVersion: row.row_version,
    expectedReviewVersion: row.review_version, to: "IN_REVIEW", reviewedBy: "editor" }));
  await transaction((client) => chain.reviewSceneShotInTransaction(client, { kind: "scene", workspaceId: w.workspaceId,
    projectId: w.projectId, episodeId: w.episodeId, sceneId: w.target.entityId, revisionId, expectedVersion: review.rowVersion,
    expectedReviewVersion: review.reviewVersion, to: "APPROVED", reviewedBy: "editor" }));
}
async function counts(w: World) {
  return (await pool.query(`SELECT
    (SELECT count(*)::int FROM scene_revision WHERE project_id=$1) AS scenes,
    (SELECT count(*)::int FROM shot_revision WHERE project_id=$1) AS shots,
    (SELECT count(*)::int FROM shot WHERE project_id=$1) AS shot_entities,
    (SELECT count(*)::int FROM shot_character_reference WHERE project_id=$1) AS character_references,
    (SELECT count(*)::int FROM domain_event WHERE project_id=$1) AS events,
    (SELECT count(*)::int FROM vimax_storyboard_candidate WHERE project_id=$1) AS candidates,
    (SELECT count(*)::int FROM vimax_storyboard_candidate_shot WHERE project_id=$1) AS mappings`, [w.projectId])).rows[0];
}
async function siblingSnapshot(w: World) {
  return (await pool.query(`SELECT
    (SELECT to_jsonb(s) FROM scene s WHERE id=$1) AS scene,
    (SELECT to_jsonb(r) FROM scene_revision r WHERE id=$2) AS revision,
    (SELECT to_jsonb(a) FROM asset a WHERE id=$3) AS asset,
    (SELECT jsonb_agg(to_jsonb(d) ORDER BY d.id) FROM asset_revision_dependency d WHERE dependent_asset_id=$3) AS dependencies`,
  [w.sibling.entityId, w.sibling.revisionId, w.assetId])).rows[0];
}

describe("ViMax E2-B on an explicitly authorized disposable PostgreSQL database", () => {
  it("keeps the SQL draft out of ordinary migration discovery and requires its independent marker", async () => {
    expect(initialReady).toBe(false);
    expect(discovered).not.toContain(VIMAX_CANDIDATE_SQL_DRAFT);
    expect(await store.storageReady()).toBe(true);
    expect((await pool.query("SELECT obj_description('vimax_storyboard_candidate'::regclass) AS marker")).rows[0]!.marker)
      .toBe("ads.vimax-candidate.storage.v1");
    const rerun = await runMigrations(pool);
    expect(rerun.applied).toEqual([]);
    expect(rerun.alreadyApplied).not.toContain(VIMAX_CANDIDATE_SQL_DRAFT);
  });

  it("preserves the unrelated scene and its existing media provenance while saving only one new draft revision", async () => {
    const w = await world(); const before = await siblingSnapshot(w); const candidate = (await create(w)).candidate;
    const saved = await save(w, candidate);
    expect(saved.receipt).toMatchObject({ operation: "save_scene", state: "scene_saved", rowVersion: 2, sceneId: w.target.entityId, shots: [] });
    expect(saved.receipt.sceneRevisionId).not.toBe(w.target.revisionId);
    expect((await pool.query("SELECT review_status,ordinal,location_revision_id FROM scene_revision WHERE id=$1", [saved.receipt.sceneRevisionId])).rows[0])
      .toEqual({ review_status: "DRAFT", ordinal: 1, location_revision_id: null });
    expect(await siblingSnapshot(w)).toEqual(before);
    expect((await pool.query("SELECT count(*)::int AS n FROM scene_revision WHERE scene_id=$1", [w.target.entityId])).rows[0]!.n).toBe(2);
  });

  it("serializes duplicate candidate creation and rejects changed content under the permanent key", async () => {
    const w = await world(); const key = randomUUID();
    const results = await Promise.all([create(w, key), create(w, key)]);
    expect(new Set(results.map((result) => result.candidate.candidateId)).size).toBe(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    const changed = structuredClone(w.body); changed.request.requirements.style += "different";
    const before = await counts(w);
    await expect(create(w, key, changed)).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(await counts(w)).toEqual(before);
  });

  it("keeps successful permanent receipts replayable after later source changes", async () => {
    const w = await world(); const createKey = randomUUID(); const candidate = (await create(w, createKey)).candidate;
    const saveKey = randomUUID(); const saved = await save(w, candidate, saveKey);
    const afterSave = await counts(w);
    await expect(store.saveScene(w.workspaceId, w.projectId, w.episodeId, actor, candidate.candidateId, saveKey,
      { schema: VIMAX_CANDIDATE_SAVE_SCENE_SCHEMA, expectedVersion: 2, confirmedReview: true }, trace))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(await counts(w)).toEqual(afterSave);
    await chain.createScriptRevision({ workspaceId: w.workspaceId, projectId: w.projectId, episodeId: w.episodeId,
      sourceStoryRevisionId: w.storyId, content: { text: w.text + "【动作】风吹过街道。\n" }, createdBy: "editor", expectedVersion: await rowVersion("episode", w.episodeId) });
    const before = await counts(w);
    expect((await create(w, createKey)).candidate.candidateId).toBe(candidate.candidateId);
    expect((await save(w, candidate, saveKey)).receipt).toEqual(saved.receipt);
    await expect(place(w, candidate.candidateId)).rejects.toMatchObject({ code: "VIMAX_CANDIDATE_SOURCE_CHANGED" });
    expect(await counts(w)).toEqual(before);
  });

  it("requires exact human approval, then writes all draft shots, original dialogue, timing and character references once", async () => {
    const w = await world(); const candidate = (await create(w)).candidate;
    const saveKey = randomUUID();
    const saved = await Promise.all([save(w, candidate, saveKey), save(w, candidate, saveKey)]);
    expect(saved[0]!.receipt).toEqual(saved[1]!.receipt);
    const beforeApproval = await counts(w);
    await expect(place(w, candidate.candidateId)).rejects.toMatchObject({ code: "VIMAX_CANDIDATE_REVIEW_REQUIRED" });
    expect(await counts(w)).toEqual(beforeApproval);
    await approveScene(w, saved[0]!.receipt.sceneRevisionId);
    const key = randomUUID(); const placed = await Promise.all([place(w, candidate.candidateId, key), place(w, candidate.candidateId, key)]);
    expect(placed[0]!.receipt).toEqual(placed[1]!.receipt);
    expect(placed[0]!.receipt).toMatchObject({ state: "shots_saved", sceneRevisionId: saved[0]!.receipt.sceneRevisionId, rowVersion: 3 });
    const shots = (await pool.query(`SELECT r.ordinal,r.dialogue,r.planned_duration_ms,r.review_status,r.source_scene_revision_id,
      (SELECT count(*)::int FROM shot_character_reference ref WHERE ref.shot_revision_id=r.id) AS characters
      FROM shot s JOIN shot_revision r ON r.id=s.current_revision_id WHERE s.scene_id=$1 ORDER BY r.ordinal`, [w.target.entityId])).rows;
    expect(shots).toEqual(fixture.supplements.shots.map((shot, index) => ({ ordinal: index + 1,
      dialogue: shot.dialogue.map((line) => `${line.speaker}：${line.line}`).join("\n") || null,
      planned_duration_ms: shot.plannedSeconds * 1000, review_status: "DRAFT", source_scene_revision_id: saved[0]!.receipt.sceneRevisionId,
      characters: shot.characterKeys.length })));
    const beforeReplay = await counts(w);
    await expect(place(w, candidate.candidateId)).rejects.toMatchObject({ code: "VIMAX_CANDIDATE_ALREADY_SAVED" });
    expect((await place(w, candidate.candidateId, key)).receipt).toEqual(placed[0]!.receipt);
    expect(await counts(w)).toEqual(beforeReplay);
  });

  it("does not expose candidates across actor, episode, project or workspace scopes", async () => {
    const w = await world(); const candidate = (await create(w)).candidate;
    for (const scope of [[randomUUID(), w.projectId, w.episodeId, actor], [w.workspaceId, randomUUID(), w.episodeId, actor],
      [w.workspaceId, w.projectId, randomUUID(), actor], [w.workspaceId, w.projectId, w.episodeId, "other-actor"]]) {
      await expect(store.get(scope[0]!, scope[1]!, scope[2]!, scope[3]!, candidate.candidateId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("preserves leading and trailing source-dialogue spaces in every saved shot", async () => {
    const w = await world(true); const candidate = (await create(w)).candidate; const saved = await save(w, candidate);
    await approveScene(w, saved.receipt.sceneRevisionId);
    await place(w, candidate.candidateId);
    const lines = (await pool.query<{ dialogue: string }>(`SELECT r.dialogue FROM shot s JOIN shot_revision r ON r.id=s.current_revision_id
      WHERE s.scene_id=$1 ORDER BY r.ordinal`, [w.target.entityId])).rows.map((row) => row.dialogue);
    expect(lines).toEqual(w.body.request.supplements.shots.map((shot) => shot.dialogue.map((line) => `${line.speaker}：${line.line}`).join("\n")));
    expect(lines.every((line) => /： {2}.+ {2}$/u.test(line))).toBe(true);
    expect(candidate.frozen.source.scriptText).toBe(w.text);
  });

  it("refuses target edits and changed character identities without creating revisions or receipts", async () => {
    for (const change of ["target", "character"] as const) {
      const w = await world(); const candidate = (await create(w)).candidate;
      if (change === "target") {
        await transaction((client) => chain.createSceneRevisionInTransaction(client, { workspaceId: w.workspaceId, projectId: w.projectId,
          episodeId: w.episodeId, sceneId: w.target.entityId, sourceScriptRevisionId: w.scriptId, ordinal: 1,
          heading: fixture.input.sceneSpans[0]!.heading, summary: "Human correction", createdBy: "editor", expectedVersion: w.body.target.rowVersion }));
      } else {
        const character = candidate.frozen.source.characters[0]!;
        const version = await rowVersion("character", character.characterId);
        await transaction((client) => chain.createTextEntityRevisionInTransaction(client, { kind: "character", workspaceId: w.workspaceId,
          projectId: w.projectId, entityId: character.characterId, name: character.name, sourceScriptRevisionId: w.scriptId,
          content: { description: "Human correction" }, createdBy: "editor", expectedVersion: version }));
      }
      const before = await counts(w);
      await expect(save(w, candidate)).rejects.toMatchObject({ code: change === "target" ? "VIMAX_CANDIDATE_TARGET_CHANGED" : "VIMAX_CANDIDATE_SOURCE_CHANGED" });
      expect(await counts(w)).toEqual(before);
    }
  });

  it("protects an inserted human shot and refuses writing the candidate's shots", async () => {
    const w = await world(); const candidate = (await create(w)).candidate; const saved = await save(w, candidate);
    await approveScene(w, saved.receipt.sceneRevisionId);
    const expectedVersion = await rowVersion("scene", w.target.entityId);
    const manual = await transaction((client) => chain.createShotScopedInTransaction(client, { workspaceId: w.workspaceId, projectId: w.projectId,
      sceneId: w.target.entityId, sourceSceneRevisionId: saved.receipt.sceneRevisionId, ordinal: 1, shotType: "全景", camera: "人工机位",
      action: "人工动作", dialogue: "人工对白", promptText: "人工提示", createdBy: "editor", expectedVersion }));
    const before = await counts(w);
    await expect(place(w, candidate.candidateId)).rejects.toMatchObject({ code: "VIMAX_CANDIDATE_HAS_SHOTS" });
    expect(await counts(w)).toEqual(before);
    expect((await pool.query("SELECT dialogue FROM shot_revision WHERE id=$1", [manual.revisionId])).rows[0]!.dialogue).toBe("人工对白");
  });

  it("blocks pending stale propagation without writing a scene", async () => {
    const w = await world(); const candidate = (await create(w)).candidate;
    await pool.query("INSERT INTO stale_recalculation (workspace_id,project_id,stale_from_ref,reason) VALUES ($1,$2,$3,'ACCEPTANCE_TEST')",
      [w.workspaceId, w.projectId, `test:${randomUUID()}`]);
    const before = await counts(w);
    await expect(save(w, candidate)).rejects.toMatchObject({ code: "SOURCE_STALE" });
    expect(await counts(w)).toEqual(before);
  });

  it("blocks a same-episode active whole-script breakdown without sending or writing anything", async () => {
    const w = await world(); const candidate = (await create(w)).candidate;
    const titleStore = new PostgresTitleWritingStore(pool, chain);
    const source = await titleStore.breakdownSource(w.workspaceId, w.projectId, w.episodeId);
    if (source.kind !== "ok") throw new Error("Synthetic breakdown source unavailable");
    const input: ScriptBreakdownFrozenInput = { schema: SCRIPT_BREAKDOWN_INPUT_SCHEMA, promptVersion: SCRIPT_BREAKDOWN_PROMPT_VERSION,
      episodeId: w.episodeId, episodeNo: source.episodeNo, scriptRevisionId: source.scriptRevisionId, scriptRevisionNo: source.scriptRevisionNo,
      scriptContentHash: source.scriptContentHash, scriptText: w.text, targetEpisodeSeconds: source.targetEpisodeSeconds,
      characters: source.characters.map((character, index) => ({ key: `C${index + 1}`, ...character })),
      replace: { scenes: source.scenes, shots: source.shots }, providerKey: "openai", model: "test-only" };
    const at = new Date().toISOString();
    const run: TitleRunRecord = { id: randomUUID(), workspaceId: w.workspaceId, projectId: w.projectId, actorId: actor,
      idempotencyKey: randomUUID(), inputHash: canonicalInputHash({ kind: "script_breakdown", projectId: w.projectId, request: { episodeId: w.episodeId } }),
      input, state: "running", errorCode: null, cancelRequestedAt: null, executorId: null, leaseUntil: null,
      callCap: SCRIPT_BREAKDOWN_CALL_CAP, callsUsed: 0, storySave: "pending", storyRevisionId: null, breakdownSave: "pending", createdAt: at, updatedAt: at };
    expect((await titleStore.createRun(run, { maxActiveRuns: 10 })).kind).toBe("created");
    const before = await counts(w);
    await expect(save(w, candidate)).rejects.toMatchObject({ code: "VIMAX_CANDIDATE_ACTIVE_BREAKDOWN" });
    expect(await counts(w)).toEqual(before);
    expect((await pool.query("SELECT calls_used FROM title_writing_run WHERE id=$1", [run.id])).rows[0]!.calls_used).toBe(0);
  });

  it("rolls back shot drafts, provenance and candidate state when a later write fails", async () => {
    const w = await world(); const candidate = (await create(w)).candidate; const saved = await save(w, candidate);
    await approveScene(w, saved.receipt.sceneRevisionId);
    let inserts = 0;
    const failingPool = { connect: async () => {
      const client = await pool.connect();
      return { query: async (sql: string, values?: unknown[]) => {
        if (/INSERT INTO shot_revision/.test(sql) && ++inserts === 2) throw new Error("Synthetic second shot insertion failure");
        return client.query(sql, values);
      }, release: () => client.release() };
    } } as unknown as DatabasePool;
    const failing = new VimaxCandidateStore(failingPool, new TextChainService(failingPool));
    const before = await counts(w);
    await expect(failing.placeShots(w.workspaceId, w.projectId, w.episodeId, actor, candidate.candidateId, randomUUID(),
      { schema: VIMAX_CANDIDATE_PLACE_SHOTS_SCHEMA, expectedVersion: 2, confirmedReview: true }, trace)).rejects.toThrow("Synthetic second shot insertion failure");
    expect(inserts).toBe(2);
    expect(await counts(w)).toEqual(before);
    const current = await store.get(w.workspaceId, w.projectId, w.episodeId, actor, candidate.candidateId);
    expect(current.state).toBe("scene_saved"); expect(current.shotsReceipt).toBeNull();
  });

  it("prevents frozen identity, completed-state and permanent mapping mutation or deletion", async () => {
    const w = await world(); const candidate = (await create(w)).candidate;
    await expect(pool.query("UPDATE vimax_storyboard_candidate SET request_hash=repeat('0',64) WHERE id=$1", [candidate.candidateId])).rejects.toThrow();
    await expect(pool.query("DELETE FROM vimax_storyboard_candidate WHERE id=$1", [candidate.candidateId])).rejects.toThrow();
    const beforeInvalid = await counts(w);
    for (const malformed of ["missing", null, 3, "scalar", {}]) {
      const frozen = structuredClone(candidate.frozen) as unknown as { request: { supplements: Record<string, unknown> } };
      if (malformed === "missing") delete frozen.request.supplements.shots;
      else frozen.request.supplements.shots = malformed;
      await expect(pool.query(`INSERT INTO vimax_storyboard_candidate
        (id,workspace_id,project_id,episode_id,actor_id,idempotency_key,request_hash,frozen_hash,frozen_json,
         source_script_revision_id,scene_id,baseline_scene_revision_id,baseline_scene_row_version,shot_count)
        SELECT $2,workspace_id,project_id,episode_id,actor_id,$3,request_hash,frozen_hash,$4::jsonb,
          source_script_revision_id,scene_id,baseline_scene_revision_id,baseline_scene_row_version,shot_count
        FROM vimax_storyboard_candidate WHERE id=$1`, [candidate.candidateId, randomUUID(), randomUUID(), JSON.stringify(frozen)])).rejects.toThrow();
    }
    expect(await counts(w)).toEqual(beforeInvalid);
    const saved = await save(w, candidate); await approveScene(w, saved.receipt.sceneRevisionId); await place(w, candidate.candidateId);
    const before = await counts(w);
    const completed = await store.get(w.workspaceId, w.projectId, w.episodeId, actor, candidate.candidateId);
    for (const malformed of ["missing", null, 3, "scalar", {}]) {
      const receipt = structuredClone(completed.shotsReceipt) as unknown as Record<string, unknown>;
      if (malformed === "missing") delete receipt.shots;
      else receipt.shots = malformed;
      await expect(pool.query("UPDATE vimax_storyboard_candidate SET shots_receipt=$2::jsonb WHERE id=$1",
        [candidate.candidateId, JSON.stringify(receipt)])).rejects.toThrow();
    }
    await expect(pool.query("UPDATE vimax_storyboard_candidate SET state='stored',row_version=1 WHERE id=$1", [candidate.candidateId])).rejects.toThrow();
    await expect(pool.query("UPDATE vimax_storyboard_candidate_shot SET shot_index=shot_index+1 WHERE candidate_id=$1", [candidate.candidateId])).rejects.toThrow();
    await expect(pool.query("DELETE FROM vimax_storyboard_candidate_shot WHERE candidate_id=$1", [candidate.candidateId])).rejects.toThrow();
    expect(await counts(w)).toEqual(before);
  });
});
