/**
 * Real HTTP + PostgreSQL E2-B acceptance, selected only by vimax-candidate:acceptance. No model/runtime/Worker is booted.
 * Refuses before connecting unless BOTH authorizations and a dedicated URL/name are supplied. After connecting, only
 * read-only identity/emptiness checks run until the database is confirmed new and disposable. No reset or truncation.
 * The reviewed SQL draft is explicitly applied here only, never by the ordinary migration discovery mechanism.
 */
import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  VIMAX_CANDIDATE_CREATE_SCHEMA,
  VIMAX_CANDIDATE_PLACE_SHOTS_SCHEMA,
  VIMAX_CANDIDATE_SAVE_SCENE_SCHEMA,
  VIMAX_CANDIDATE_SQL_DRAFT,
  VIMAX_PLATFORM_PREVIEW_REQUEST_SCHEMA,
  vimaxCandidateCreateResponseSchema,
  vimaxCandidateCreateSchema,
  vimaxCandidatePageSchema,
  vimaxCandidateTargetsSchema,
  vimaxCandidateViewSchema,
  vimaxCandidateWriteResponseSchema,
  vimaxEvaluationInputSchema,
  vimaxEvaluationSupplementsSchema,
  vimaxPlanCandidateSchema,
  type VimaxCandidateCreate,
} from "@ai-drama/contracts";
import {
  TextChainService,
  VimaxCandidateStore,
  checkTitleWritingAcceptanceEnv,
  closePostgresPool,
  createPostgresPool,
  runMigrations,
  verifyTitleWritingAcceptanceDatabase,
} from "@ai-drama/database";
import type { ApiEnv } from "../config/env";
import { AuthModule } from "../auth/auth.module";
import { hashPassword } from "../auth/password-hash";
import { SiteAuth } from "../auth/site-auth";
import { SafeExceptionFilter } from "../http/safe-exception.filter";
import { VIMAX_CANDIDATE_SERVICE } from "./tokens";
import { VimaxCandidateController } from "./vimax-candidate.controller";
import { VimaxCandidateService } from "./vimax-candidate.service";

const decision = checkTitleWritingAcceptanceEnv(process.env);
if (!decision.ok) throw new Error(`ViMax candidate HTTP acceptance refused: ${decision.reason}`);
if (process.env.VIMAX_CANDIDATE_ACCEPTANCE_DRAFT_AUTHORIZED !== "true") {
  throw new Error("ViMax candidate HTTP acceptance refused: VIMAX_CANDIDATE_ACCEPTANCE_DRAFT_AUTHORIZED must be true after SQL draft review.");
}
const pool = createPostgresPool({ connectionString: decision.url, connectionTimeoutMs: 5_000, statementTimeoutMs: 15_000, queryTimeoutMs: 20_000 });
type Client = Awaited<ReturnType<typeof pool.connect>>;
const chain = new TextChainService(pool);
const store = new VimaxCandidateStore(pool, chain);
const WORKSPACE = randomUUID();
const ACTOR = "server-owner";
const ORIGIN = "https://candidate-acceptance.example.test";
const PASSWORD = `test-only-http-candidate-${randomUUID()}`;
let app: INestApplication | undefined;
let url = "";
let cookie = "";
let csrf = "";
let fixture!: {
  input: ReturnType<typeof vimaxEvaluationInputSchema.parse>;
  candidate: ReturnType<typeof vimaxPlanCandidateSchema.parse>;
  supplements: ReturnType<typeof vimaxEvaluationSupplementsSchema.parse>;
};
async function q<T>(sql: string, values: unknown[] = []): Promise<{ rows: T[] }> {
  return await pool.query(sql, values) as { rows: T[] };
}
async function transaction<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
async function scalar(sql: string, values: unknown[] = []): Promise<string> {
  return (await q<{ id: string }>(sql, values)).rows[0]!.id;
}
async function version(table: "project" | "episode" | "scene", id: string): Promise<number> {
  return (await q<{ value: number }>(`SELECT ${table === "project" ? "version" : "row_version"} AS value FROM ${table} WHERE id=$1`, [id])).rows[0]!.value;
}
interface World { projectId: string; episodeId: string; storyId: string; scriptId: string; targetId: string; text: string }
const base = (w: Pick<World, "projectId" | "episodeId">) => `/projects/${w.projectId}/episodes/${w.episodeId}/vimax-candidates`;
async function http(method: "GET" | "POST", path: string, body?: unknown, key = randomUUID(), traceId = "candidate-http-acceptance") {
  const response = await fetch(`${url}${path}`, {
    method, headers: { cookie, accept: "application/json", ...(method === "POST" ? {
      origin: ORIGIN, "x-csrf-token": csrf, "content-type": "application/json", "idempotency-key": key, "x-trace-id": traceId,
    } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as unknown };
}

beforeAll(async () => {
  const safe = await verifyTitleWritingAcceptanceDatabase({ query: (sql, values) => q<Record<string, unknown>>(sql, values) }, decision.databaseName);
  if (!safe.ok) throw new Error(`ViMax candidate HTTP acceptance refused before writes: ${safe.reason}`);
  const migrated = await runMigrations(pool);
  expect([...migrated.applied, ...migrated.alreadyApplied]).not.toContain(VIMAX_CANDIDATE_SQL_DRAFT);
  expect(await store.storageReady()).toBe(false);
  const sql = await readFile(resolve(__dirname, "../../../../packages/database/prisma/drafts/20261031000100_vimax_storyboard_candidate.sql"), "utf8");
  await transaction(async (client) => { await client.query(sql); });
  expect(await store.storageReady()).toBe(true);
  await pool.query("INSERT INTO workspace (id,name) VALUES ($1,'ViMax HTTP synthetic acceptance')", [WORKSPACE]);
  const raw = JSON.parse(await readFile(resolve(__dirname, "../../../../scripts/vimax-evaluation/fixtures/single-scene.json"), "utf8")) as Record<string, unknown>;
  fixture = { input: vimaxEvaluationInputSchema.parse(raw.input), candidate: vimaxPlanCandidateSchema.parse(raw.candidate),
    supplements: vimaxEvaluationSupplementsSchema.parse(raw.supplements) };
  const passwordHash = await hashPassword(PASSWORD, { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 });
  const module = await Test.createTestingModule({
    imports: [AuthModule.register({ NODE_ENV: "test" } as ApiEnv,
      { kind: "enabled", auth: new SiteAuth({ username: "admin", passwordHash, publicOrigin: ORIGIN }) })],
    controllers: [VimaxCandidateController],
    providers: [{ provide: VIMAX_CANDIDATE_SERVICE, useValue: new VimaxCandidateService({ workspaceId: WORKSPACE, nodeEnv: "test", store }) }],
  }).compile();
  app = module.createNestApplication({ logger: false }); app.setGlobalPrefix("api/v1");
  (app as unknown as { useBodyParser(type: "json", options: { limit: string }): void }).useBodyParser("json", { limit: "300kb" });
  app.useGlobalFilters(new SafeExceptionFilter()); await app.listen(0, "127.0.0.1"); url = `${await app.getUrl()}/api/v1`;
  const login = await fetch(`${url}/auth/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: PASSWORD }) });
  expect(login.status).toBe(200); cookie = login.headers.getSetCookie().map((item) => item.split(";", 1)[0]).join("; ");
  csrf = (await login.json() as { csrfToken: string }).csrfToken;
});
afterAll(async () => { await app?.close(); await closePostgresPool(pool); });

async function approveText(table: "story_revision" | "script_revision", projectId: string, revisionId: string,
  expectedVersion: number, episodeId?: string) {
  const review = await chain.transitionReview({ table, workspaceId: WORKSPACE, revisionId, expectedVersion,
    expectedReviewVersion: 1, to: "IN_REVIEW" });
  if (table === "story_revision") await chain.approveStory({ workspaceId: WORKSPACE, projectId, revisionId,
    expectedVersion: review.rowVersion, expectedReviewVersion: review.reviewVersion, reviewedBy: "editor" });
  else await chain.approveScript({ workspaceId: WORKSPACE, episodeId: episodeId!, revisionId,
    expectedVersion: review.rowVersion, expectedReviewVersion: review.reviewVersion, reviewedBy: "editor" });
}
/** New works for each case: no deletion, resets or truncation, including after a rejected write. */
async function world(): Promise<World> {
  const projectId = await scalar("INSERT INTO project (workspace_id,title) VALUES ($1,'Synthetic HTTP scene') RETURNING id", [WORKSPACE]);
  const story = await chain.createStoryRevision({ workspaceId: WORKSPACE, projectId, content: { text: "Synthetic journey" }, createdBy: ACTOR, expectedVersion: 1 });
  await approveText("story_revision", projectId, story.revisionId, story.rowVersion);
  const episodeId = await scalar("SELECT id FROM episode WHERE project_id=$1 AND episode_no=1", [projectId]);
  const script = await chain.createScriptRevision({ workspaceId: WORKSPACE, projectId, episodeId,
    sourceStoryRevisionId: story.revisionId, content: { text: fixture.input.scriptText }, createdBy: ACTOR, expectedVersion: await version("episode", episodeId) });
  await approveText("script_revision", projectId, script.revisionId, script.rowVersion, episodeId);
  for (const character of fixture.input.characters) {
    const expectedVersion = await version("project", projectId);
    await transaction((client) => chain.createTextEntityRevisionInTransaction(client, { kind: "character", workspaceId: WORKSPACE, projectId,
      name: character.name, sourceScriptRevisionId: script.revisionId, content: { description: "Synthetic character" }, createdBy: ACTOR, expectedVersion }));
  }
  const expectedVersion = await version("episode", episodeId);
  const target = await transaction((client) => chain.createSceneRevisionInTransaction(client, { workspaceId: WORKSPACE, projectId, episodeId,
    sourceScriptRevisionId: script.revisionId, ordinal: 1, heading: fixture.input.sceneSpans[0]!.heading,
    timeOfDay: "夜", summary: "Original scene", createdBy: ACTOR, expectedVersion }));
  return { projectId, episodeId, storyId: story.revisionId, scriptId: script.revisionId, targetId: target.entityId, text: fixture.input.scriptText };
}
async function requestFor(w: World): Promise<VimaxCandidateCreate> {
  const response = await http("GET", `${base(w)}/targets`); expect(response.status).toBe(200);
  const options = vimaxCandidateTargetsSchema.parse(response.body);
  const target = options.targets.find((item) => item.sceneId === w.targetId)!;
  const originalNames = new Map(fixture.input.characters.map((item) => [item.key, item.name]));
  const serverKeys = new Map(options.source.characters.map((item) => [item.name, item.key]));
  const mapKey = (key: string) => serverKeys.get(originalNames.get(key)!)!;
  const supplements = structuredClone(fixture.supplements);
  supplements.characters.forEach((item) => { item.characterKey = mapKey(item.characterKey); });
  supplements.shots.forEach((shot) => {
    shot.characterKeys = shot.characterKeys.map(mapKey);
    shot.dialogue.forEach((line) => { if (line.characterKey !== null) line.characterKey = mapKey(line.characterKey); });
  });
  return vimaxCandidateCreateSchema.parse({ schema: VIMAX_CANDIDATE_CREATE_SCHEMA,
    target: { sceneId: target.sceneId, sceneRevisionId: target.sceneRevisionId, rowVersion: target.rowVersion },
    request: { schema: VIMAX_PLATFORM_PREVIEW_REQUEST_SCHEMA,
      source: { scriptRevisionId: options.source.scriptRevisionId, scriptContentHash: options.source.scriptContentHash, characters: options.source.characters },
      sceneSpans: fixture.input.sceneSpans, selectedSceneKeys: fixture.input.selectedSceneKeys,
      sourceDialogue: fixture.input.sourceDialogue.map((line) => ({ ...line, characterKey: line.characterKey === null ? null : mapKey(line.characterKey) })),
      requirements: fixture.input.requirements, candidate: fixture.candidate, supplements,
    } });
}
async function approveScene(w: World, revisionId: string) {
  const scene = (await q<{ current_revision_id: string; row_version: number; review_version: number }>(
    `SELECT s.current_revision_id,s.row_version,r.review_version FROM scene s JOIN scene_revision r ON r.id=s.current_revision_id WHERE s.id=$1`, [w.targetId])).rows[0]!;
  expect(scene.current_revision_id).toBe(revisionId);
  const review = await transaction((client) => chain.reviewSceneShotInTransaction(client, { kind: "scene", workspaceId: WORKSPACE,
    projectId: w.projectId, episodeId: w.episodeId, sceneId: w.targetId, revisionId, expectedVersion: scene.row_version,
    expectedReviewVersion: scene.review_version, to: "IN_REVIEW", reviewedBy: "editor" }));
  await transaction((client) => chain.reviewSceneShotInTransaction(client, { kind: "scene", workspaceId: WORKSPACE,
    projectId: w.projectId, episodeId: w.episodeId, sceneId: w.targetId, revisionId, expectedVersion: review.rowVersion,
    expectedReviewVersion: review.reviewVersion, to: "APPROVED", reviewedBy: "editor" }));
}
async function counts(w: World) {
  return (await q<Record<string, number>>(`SELECT
    (SELECT count(*)::int FROM vimax_storyboard_candidate WHERE project_id=$1) AS candidates,
    (SELECT count(*)::int FROM vimax_storyboard_candidate_shot WHERE project_id=$1) AS mappings,
    (SELECT count(*)::int FROM scene_revision WHERE project_id=$1) AS scenes,
    (SELECT count(*)::int FROM shot_revision WHERE project_id=$1) AS shots,
    (SELECT count(*)::int FROM domain_event WHERE project_id=$1) AS events`, [w.projectId])).rows[0]!;
}

describe("ViMax E2-B real HTTP and PostgreSQL, with a reviewed draft only on this disposable database", () => {
  it("logs in, persists and replays a candidate, requires exact scene approval, then writes and replays draft shots once", async () => {
    const w = await world(); const body = await requestFor(w); const createKey = randomUUID();
    const before = await counts(w);
    expect((await fetch(`${url}${base(w)}/targets`)).status).toBe(401);
    const noCsrf = await fetch(`${url}${base(w)}`, { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/json", "idempotency-key": createKey }, body: JSON.stringify(body) });
    expect(noCsrf.status).toBe(403); expect(await counts(w)).toEqual(before);
    const created = await http("POST", base(w), body, createKey, "http-candidate-created"); expect(created.status).toBe(201);
    const candidate = vimaxCandidateCreateResponseSchema.parse(created.body).candidate;
    const afterCreate = await counts(w);
    const replayed = await http("POST", base(w), body, createKey, "must-not-replace-original-trace"); expect(replayed.status).toBe(200);
    expect(vimaxCandidateCreateResponseSchema.parse(replayed.body).candidate.candidateId).toBe(candidate.candidateId);
    expect(await counts(w)).toEqual(afterCreate);
    const saved = await http("POST", `${base(w)}/${candidate.candidateId}/scene`, {
      schema: VIMAX_CANDIDATE_SAVE_SCENE_SCHEMA, expectedVersion: candidate.rowVersion, confirmedReview: true,
    }, randomUUID(), "http-scene-written"); expect(saved.status).toBe(200);
    const sceneReceipt = vimaxCandidateWriteResponseSchema.parse(saved.body).receipt;
    const shotsBody = { schema: VIMAX_CANDIDATE_PLACE_SHOTS_SCHEMA, expectedVersion: 2, confirmedReview: true };
    const shotKey = randomUUID(); const beforeReview = await counts(w);
    const unapproved = await http("POST", `${base(w)}/${candidate.candidateId}/shots`, shotsBody, shotKey);
    expect(unapproved.status).toBe(409); expect(unapproved.body).toMatchObject({ error: { code: "VIMAX_CANDIDATE_REVIEW_REQUIRED" } });
    expect(await counts(w)).toEqual(beforeReview);
    await approveScene(w, sceneReceipt.sceneRevisionId);
    const placed = await http("POST", `${base(w)}/${candidate.candidateId}/shots`, shotsBody, shotKey, "http-shots-written"); expect(placed.status).toBe(200);
    const receipt = vimaxCandidateWriteResponseSchema.parse(placed.body).receipt;
    expect(receipt.state).toBe("shots_saved"); expect(receipt.shots).toHaveLength(3);
    const after = await counts(w);
    const replay = await http("POST", `${base(w)}/${candidate.candidateId}/shots`, shotsBody, shotKey, "must-not-add-replay-event"); expect(replay.status).toBe(200);
    expect(vimaxCandidateWriteResponseSchema.parse(replay.body).receipt).toEqual(receipt); expect(await counts(w)).toEqual(after);
    const history = await http("GET", base(w)); expect(history.status).toBe(200);
    expect(vimaxCandidatePageSchema.parse(history.body).items.map((item) => item.candidateId)).toContain(candidate.candidateId);
    const read = await http("GET", `${base(w)}/${candidate.candidateId}`); expect(read.status).toBe(200);
    expect(vimaxCandidateViewSchema.parse(read.body)).toMatchObject({ state: "shots_saved", rowVersion: 3 });
    const shots = (await q<{ review_status: string; source_scene_revision_id: string; planned_duration_ms: number; created_by: string }>(
      `SELECT r.review_status,r.source_scene_revision_id,r.planned_duration_ms,r.created_by FROM shot s
         JOIN shot_revision r ON r.id=s.current_revision_id WHERE s.scene_id=$1 ORDER BY r.ordinal`, [w.targetId])).rows;
    expect(shots).toEqual(body.request.supplements.shots.map((shot) => ({ review_status: "DRAFT", source_scene_revision_id: sceneReceipt.sceneRevisionId,
      planned_duration_ms: shot.plannedSeconds * 1000, created_by: ACTOR })));
    const events = (await q<{ trace_id: string; aggregate_id: string }>(
      `SELECT trace_id,aggregate_id FROM domain_event WHERE project_id=$1 AND trace_id=ANY($2::text[])`,
      [w.projectId, ["http-candidate-created", "http-scene-written", "http-shots-written"]])).rows;
    expect(new Set(events.map((event) => event.trace_id))).toEqual(new Set(["http-candidate-created", "http-scene-written", "http-shots-written"]));
    expect(events.some((event) => event.trace_id === "http-scene-written" && event.aggregate_id === w.targetId)).toBe(true);
    for (const shot of receipt.shots) expect(events.some((event) => event.trace_id === "http-shots-written" && event.aggregate_id === shot.shotId)).toBe(true);
  });

  it("preserves a stored candidate and returns 409 with no new writes after the script changes", async () => {
    const w = await world(); const body = await requestFor(w); const key = randomUUID();
    const created = await http("POST", base(w), body, key); expect(created.status).toBe(201);
    const candidate = vimaxCandidateCreateResponseSchema.parse(created.body).candidate;
    await chain.createScriptRevision({ workspaceId: WORKSPACE, projectId: w.projectId, episodeId: w.episodeId,
      sourceStoryRevisionId: w.storyId, content: { text: w.text + "【动作】风吹过门口。\n" }, createdBy: "editor", expectedVersion: await version("episode", w.episodeId) });
    const before = await counts(w);
    const refused = await http("POST", `${base(w)}/${candidate.candidateId}/scene`, {
      schema: VIMAX_CANDIDATE_SAVE_SCENE_SCHEMA, expectedVersion: 1, confirmedReview: true,
    });
    expect(refused.status).toBe(409); expect(refused.body).toMatchObject({ error: { code: "VIMAX_CANDIDATE_SOURCE_CHANGED" } });
    expect(await counts(w)).toEqual(before);
    const replay = await http("POST", base(w), body, key); expect(replay.status).toBe(200);
    expect(vimaxCandidateCreateResponseSchema.parse(replay.body).candidate.candidateId).toBe(candidate.candidateId);
    expect(await counts(w)).toEqual(before);
  });

  it("rejects a target with an existing manual shot without changing that shot", async () => {
    const w = await world();
    const revisionId = await scalar("SELECT current_revision_id AS id FROM scene WHERE id=$1", [w.targetId]);
    await approveScene(w, revisionId);
    const expectedVersion = await version("scene", w.targetId);
    const manual = await transaction((client) => chain.createShotScopedInTransaction(client, { workspaceId: WORKSPACE, projectId: w.projectId,
      sceneId: w.targetId, sourceSceneRevisionId: revisionId, ordinal: 1, shotType: "中景", camera: "人工机位", action: "保留人工动作",
      dialogue: "林晚：人工对白", promptText: "人工镜头", createdBy: "editor", expectedVersion }));
    const body = await requestFor(w); const before = await counts(w);
    const refused = await http("POST", base(w), body); expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: { code: "VIMAX_CANDIDATE_HAS_SHOTS" } }); expect(await counts(w)).toEqual(before);
    expect((await q<{ id: string; dialogue: string; action: string }>("SELECT id,dialogue,action FROM shot_revision WHERE id=$1", [manual.revisionId])).rows[0])
      .toEqual({ id: manual.revisionId, dialogue: "林晚：人工对白", action: "保留人工动作" });
  });

  it("refuses project/episode/candidate scope mismatches over HTTP", async () => {
    const a = await world(); const b = await world(); const body = await requestFor(a);
    const created = await http("POST", base(a), body); expect(created.status).toBe(201);
    const candidate = vimaxCandidateCreateResponseSchema.parse(created.body).candidate;
    const beforeA = await counts(a); const beforeB = await counts(b);
    expect((await http("GET", `${base(b)}/${candidate.candidateId}`)).status).toBe(404);
    expect((await http("POST", base({ projectId: a.projectId, episodeId: b.episodeId }), body)).status).toBe(404);
    expect((await http("GET", base({ projectId: randomUUID(), episodeId: a.episodeId }) + "/targets")).status).toBe(404);
    expect(await counts(a)).toEqual(beforeA); expect(await counts(b)).toEqual(beforeB);
  });
});
