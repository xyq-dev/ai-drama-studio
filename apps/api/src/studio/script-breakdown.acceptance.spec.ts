/**
 * Script breakdown acceptance over real HTTP and real PostgreSQL, with a model double. NOT part of `test` or
 * `integration`: run only with `pnpm --filter @ai-drama/api script-breakdown:acceptance` against a newly created, empty,
 * disposable database (the title writing acceptance guard and variables). It migrates that database through the whole
 * chain, then drives the real Nest application with fetch.
 *
 * What is real: the Nest application with its real controllers and services on a local port; the PostgreSQL store and
 * text chain. What is not: the model. The breakdown service the controller uses is built here with a stub transport
 * that records every request, answers from the script copy in the prompt and never opens a network connection. The
 * runtime's own title writing stays switched off without provider keys, so nothing here can reach a real provider.
 */
import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScriptBreakdownPlacementOutcome, ScriptBreakdownRunView } from "@ai-drama/contracts";
import {
  PostgresTitleWritingStore,
  SCRIPT_BREAKDOWN_MIGRATION,
  TextChainService,
  checkTitleWritingAcceptanceEnv,
  closePostgresPool,
  createPostgresPool,
  runMigrations,
  verifyTitleWritingAcceptanceDatabase,
} from "@ai-drama/database";
import { TitleWritingEngine, titleWritingProviderConfigs, type WritingTransport } from "@ai-drama/providers";
import { breakdownPromptParts, chatAnswer, fixtureBreakdownFromPrompt } from "@ai-drama/providers/title-writing-fixtures";
import { AppModule } from "../app.module";
import { loadApiEnv } from "../config/env";
import { SafeExceptionFilter } from "../http/safe-exception.filter";
import { ScriptBreakdownService } from "./script-breakdown.service";
import type { StudioRuntime } from "./studio.runtime";
import { SCRIPT_BREAKDOWN_SERVICE, STUDIO_RUNTIME } from "./tokens";

const decision = checkTitleWritingAcceptanceEnv(process.env);
if (!decision.ok) throw new Error(`Script breakdown API acceptance refused: ${decision.reason}`);
const acceptanceUrl = decision.url;

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const OPERATOR_TOKEN = `acceptance-${randomUUID()}`;
const STUB_KEY = `stub-not-a-provider-key-${randomUUID()}`;
const STUB_MODEL = "qwen-acceptance-stub";

const pool = createPostgresPool({ connectionString: acceptanceUrl, connectionTimeoutMs: 2_000, statementTimeoutMs: 10_000, queryTimeoutMs: 10_000 });
async function q<T>(sql: string, values: unknown[] = []): Promise<{ rows: T[]; rowCount: number | null }> {
  return await pool.query(sql, values) as { rows: T[]; rowCount: number | null };
}
const evidence: Record<string, unknown> = { scenarios: {} as Record<string, unknown> };
const scenarios = evidence.scenarios as Record<string, unknown>;

// Model double: answers each breakdown prompt from the script copy inside it, unless told otherwise for an episode.
interface Sent { episodeNo: number; script: string; keyMatches: boolean; endpoint: string }
const sent: Sent[] = [];
const overrides = new Map<string, () => { status: number; body: unknown }>();

const transport: WritingTransport = async (request) => {
  const body = JSON.parse(request.body) as { messages?: Array<{ role: string; content: string }> };
  const user = body.messages?.find((message) => message.role === "user")?.content ?? "";
  const parts = breakdownPromptParts(user);
  const headers = request.headers as Record<string, string>;
  const endpoint = new URL(request.url);
  sent.push({ episodeNo: parts.episodeNo, script: parts.script, keyMatches: (headers.Authorization ?? headers.authorization) === `Bearer ${STUB_KEY}`,
    endpoint: `${endpoint.host}${endpoint.pathname}` });
  const marker = /标记：(\S+)/.exec(parts.script)?.[1] ?? "";
  const answer = overrides.get(marker)?.() ?? { status: 200, body: chatAnswer(fixtureBreakdownFromPrompt(user)) };
  return {
    status: answer.status,
    headers: { get: (name: string) => name.toLowerCase() === "x-request-id" ? `stub-${String(sent.length)}` : null },
    body: new TextEncoder().encode(JSON.stringify(answer.body)),
  };
};

function breakdownService(runtime: StudioRuntime): ScriptBreakdownService {
  const providers = titleWritingProviderConfigs({ DASHSCOPE_API_KEY: STUB_KEY, BAILIAN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    TITLE_WRITING_QWEN_MODELS: STUB_MODEL });
  const store = new PostgresTitleWritingStore(runtime.pool, new TextChainService(runtime.pool));
  return new ScriptBreakdownService({
    workspaceId: WORKSPACE, nodeEnv: "test", enabled: true, operatorToken: OPERATOR_TOKEN, defaultProvider: "qwen", providers, store,
    engine: new TitleWritingEngine({ workspaceId: WORKSPACE, store, providers, transport, maxCallsPerDay: 200, timeoutMs: 1_500 }),
    projects: runtime.store, maxCallsPerDay: 200, maxActiveRuns: 10,
  });
}

interface Booted { app: INestApplication; base: string }
let main: Booted;
const exchanges: Array<{ method: string; path: string; status: number }> = [];

async function boot(): Promise<Booted> {
  const env = loadApiEnv({
    NODE_ENV: "test", DATABASE_URL: acceptanceUrl, REDIS_URL: "redis://127.0.0.1:6399", S3_ENDPOINT: "http://127.0.0.1:59000",
    S3_REGION: "us-east-1", S3_BUCKET: "ai-drama-dev", S3_ACCESS_KEY_ID: "test", S3_SECRET_ACCESS_KEY: "test", APP_WORKSPACE_ID: WORKSPACE,
  });
  expect(env.TITLE_WRITING_ENABLED).toBe(false);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(env)] })
    .overrideProvider(SCRIPT_BREAKDOWN_SERVICE)
    .useFactory({ inject: [STUDIO_RUNTIME], factory: (runtime: StudioRuntime) => breakdownService(runtime) })
    .compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix("api/v1");
  app.useGlobalFilters(new SafeExceptionFilter());
  await app.init();
  await app.listen(0, "127.0.0.1");
  return { app, base: await app.getUrl() };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function http(method: "GET" | "POST", path: string, options: { body?: unknown; headers?: Record<string, string> } = {}) {
  const response = await fetch(`${main.base}/api/v1${path}`, {
    method,
    headers: { accept: "application/json", ...(options.body !== undefined ? { "content-type": "application/json" } : {}), ...options.headers },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  exchanges.push({ method, path, status: response.status });
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Json };
}

const key = () => ({ "idempotency-key": randomUUID() });
const operator = (idempotencyKey = randomUUID()) => ({ "x-operator-token": OPERATOR_TOKEN, "idempotency-key": idempotencyKey });

function scriptOf(episodeNo: number, scenes: number, marker: string): string {
  const lines = [`第 ${String(episodeNo)} 集`, `标记：${marker}`];
  for (let scene = 1; scene <= scenes; scene += 1) {
    lines.push(`场 ${String(scene)} 地点${String(episodeNo)}-${String(scene)} 夜`, `林夏在第 ${String(scene)} 场停下。`, `林夏：第 ${String(episodeNo)} 集第 ${String(scene)} 句。`);
  }
  return lines.join("\n");
}

async function review(path: string, ifMatch: number, expectedReviewVersion: number, to: "IN_REVIEW" | "APPROVED") {
  const result = await http("POST", path, { body: { to, expectedReviewVersion }, headers: { ...key(), "if-match": String(ifMatch) } });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body as { reviewVersion: number; rowVersion: number };
}

async function episodesOf(projectId: string) {
  const listed = await http("GET", `/projects/${projectId}/episodes`);
  expect(listed.status).toBe(200);
  return listed.body.items as Array<{ id: string; episodeNo: number; rowVersion: number; currentScriptRevisionId: string | null }>;
}

/** Writes a script revision through the editor's route and, unless told not to, approves it through the review route. */
async function saveScript(projectId: string, storyId: string, episodeId: string, text: string, approve = true): Promise<string> {
  const episode = (await episodesOf(projectId)).find((item) => item.id === episodeId)!;
  const created = await http("POST", `/projects/${projectId}/episodes/${episodeId}/scripts`, {
    body: { sourceStoryRevisionId: storyId, content: { text } }, headers: { ...key(), "if-match": String(episode.rowVersion) } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  if (approve) {
    const path = `/projects/${projectId}/episodes/${episodeId}/scripts/${String(created.body.revisionId)}/review`;
    const inReview = await review(path, created.body.rowVersion, 1, "IN_REVIEW");
    await review(path, inReview.rowVersion, inReview.reviewVersion, "APPROVED");
  }
  return String(created.body.revisionId);
}

/** A work with N planned episodes of 60 s, an approved story and an approved script per episode (episode n: n scenes). */
async function work(episodeCount: number, marker: string) {
  const created = await http("POST", "/projects", { body: { title: `拆解${marker}`, premise: "", episodeCount, targetEpisodeSeconds: 60 }, headers: key() });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const projectId = String(created.body.id);
  const story = await http("POST", `/projects/${projectId}/stories`, { body: { content: { text: "故事" } },
    headers: { ...key(), "if-match": String(created.body.version) } });
  expect(story.status).toBe(201);
  const storyPath = `/projects/${projectId}/stories/${String(story.body.revisionId)}/review`;
  const inReview = await review(storyPath, story.body.rowVersion, 1, "IN_REVIEW");
  await review(storyPath, inReview.rowVersion, inReview.reviewVersion, "APPROVED");
  const episodes = await episodesOf(projectId);
  expect(episodes.map((item) => item.episodeNo)).toEqual(Array.from({ length: episodeCount }, (_, index) => index + 1));
  for (const episode of episodes) await saveScript(projectId, String(story.body.revisionId), episode.id, scriptOf(episode.episodeNo, episode.episodeNo, `${marker}-${String(episode.episodeNo)}`));
  return { projectId, storyId: String(story.body.revisionId), episodes: await episodesOf(projectId) };
}

const base = (projectId: string, episodeId: string) => `/projects/${projectId}/episodes/${episodeId}/script-breakdowns`;

async function latest(projectId: string, episodeId: string): Promise<ScriptBreakdownRunView | null> {
  const read = await http("GET", `${base(projectId, episodeId)}/latest`);
  expect(read.status).toBe(200);
  return read.body.run as ScriptBreakdownRunView | null;
}

async function settled(projectId: string, episodeId: string): Promise<ScriptBreakdownRunView> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const run = await latest(projectId, episodeId);
    if (run && run.state !== "running") return run;
    if (Date.now() > deadline) throw new Error(`breakdown did not settle: ${JSON.stringify(run?.state)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function scenesOf(projectId: string, episodeId: string) {
  const listed = await http("GET", `/projects/${projectId}/episodes/${episodeId}/scenes`);
  expect(listed.status).toBe(200);
  return listed.body.items as Array<{ entityId: string; rowVersion: number; currentRevisionId: string; currentRevision: { reviewVersion: number; reviewStatus: string; freshnessStatus: string } }>;
}

async function approveScene(projectId: string, episodeId: string, sceneId: string) {
  const scene = (await scenesOf(projectId, episodeId)).find((item) => item.entityId === sceneId)!;
  const path = `/projects/${projectId}/episodes/${episodeId}/scenes/${sceneId}/revisions/${scene.currentRevisionId}/review`;
  const inReview = await review(path, scene.rowVersion, scene.currentRevision.reviewVersion, "IN_REVIEW");
  await review(path, inReview.rowVersion, inReview.reviewVersion, "APPROVED");
}

beforeAll(async () => {
  const verified = await verifyTitleWritingAcceptanceDatabase({ query: (sql, values) => q<Record<string, unknown>>(sql, values) }, decision.databaseName);
  if (!verified.ok) {
    await closePostgresPool(pool);
    throw new Error(`Script breakdown API acceptance refused: ${verified.reason}`);
  }
  const applied = (await runMigrations(pool)).applied;
  expect(applied.at(-1)).toBe(SCRIPT_BREAKDOWN_MIGRATION);
  evidence.migrationsApplied = applied;
  await q("INSERT INTO workspace (id, name, status) VALUES ($1, 'breakdown-acceptance', 'ACTIVE')", [WORKSPACE]);
  main = await boot();
});

afterAll(async () => {
  if (main) await main.app.close();
  await closePostgresPool(pool);
  evidence.stub = { totalSends: sent.length, everyEndpoint: [...new Set(sent.map((item) => item.endpoint))], everyKeyWasTheStubKey: sent.every((item) => item.keyMatches) };
  evidence.httpExchanges = exchanges.length;
  const dir = process.env.TITLE_WRITING_ACCEPTANCE_EVIDENCE_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "script-breakdown-api-acceptance.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }
});

describe("script breakdown over real HTTP and PostgreSQL, model stubbed", () => {
  it("reports ready options with the bounds and the shared quota", async () => {
    const options = await http("GET", "/writing/script-breakdowns/options");
    expect(options.status).toBe(200);
    expect(options.body).toMatchObject({ code: "SCRIPT_BREAKDOWN_READY", storageReady: true, callCapPerRun: 3, billing: "unknown",
      limits: { maxScenes: 8, maxShots: 20, minShotSeconds: 2, maxShotSeconds: 10 } });
  });

  for (const count of [1, 3, 6]) {
    it(`breaks down only the chosen episode of a ${String(count)}-episode work, from its own approved script`, async () => {
      const { projectId, episodes } = await work(count, `n${String(count)}`);
      const chosen = episodes.at(-1)!;
      const before = sent.length;
      const started = await http("POST", base(projectId, chosen.id), { body: {}, headers: operator() });
      expect(started.status, JSON.stringify(started.body)).toBe(201);
      const run = await settled(projectId, chosen.id);
      expect(run).toMatchObject({ state: "completed", save: "saved", episodeNo: count, targetEpisodeSeconds: 60, callsUsed: 1 });
      expect(sent.length - before).toBe(1);
      expect(sent.at(-1)).toMatchObject({ episodeNo: count, script: scriptOf(count, count, `n${String(count)}-${String(count)}`), keyMatches: true });
      expect(run.output!.scenes).toHaveLength(count);
      expect(run.output!.shots).toHaveLength(count * 2);
      for (const episode of episodes) {
        expect((await scenesOf(projectId, episode.id)).length, `episode ${String(episode.episodeNo)}`).toBe(episode.id === chosen.id ? count : 0);
      }
      scenarios[`episodes${String(count)}`] = { scenes: count, shotsProposed: count * 2, sends: 1 };
    });
  }

  it("refuses before any send: wrong token, unapproved script, existing scenes without consent; replays a key without a second run", async () => {
    const { projectId, storyId, episodes } = await work(2, "refuse");
    const [first, second] = episodes;
    const before = sent.length;
    const forbidden = await http("POST", base(projectId, first!.id), { body: {}, headers: { "x-operator-token": "wrong", ...key() } });
    expect([forbidden.status, forbidden.body.error.code]).toEqual([403, "TITLE_WRITING_FORBIDDEN"]);
    await saveScript(projectId, storyId, second!.id, scriptOf(2, 1, "refuse-draft"), false);
    const unapproved = await http("POST", base(projectId, second!.id), { body: {}, headers: operator() });
    expect([unapproved.status, unapproved.body.error.code]).toEqual([409, "SCRIPT_REVIEW_REQUIRED"]);
    const idempotencyKey = randomUUID();
    const started = await http("POST", base(projectId, first!.id), { body: {}, headers: operator(idempotencyKey) });
    expect(started.status).toBe(201);
    const done = await settled(projectId, first!.id);
    const replay = await http("POST", base(projectId, first!.id), { body: {}, headers: operator(idempotencyKey) });
    expect([replay.status, replay.body.run.runId]).toEqual([200, done.runId]);
    const again = await http("POST", base(projectId, first!.id), { body: {}, headers: operator() });
    expect([again.status, again.body.error.code, again.body.error.details]).toEqual([409, "SCRIPT_BREAKDOWN_EXISTING_SCENES", { sceneCount: 1, shotCount: 0 }]);
    expect(sent.length - before).toBe(1);
    expect(Number((await q<{ n: number }>("SELECT count(*)::int AS n FROM title_writing_run WHERE project_id = $1", [projectId])).rows[0]!.n)).toBe(1);
    scenarios.refusals = { forbidden: 403, unapproved: 409, existingScenes: 409, replaySameRun: true, sends: 1 };
  });

  it("fails an invalid answer with nothing written and no template, and replaces scenes only with consent", async () => {
    const { projectId, episodes } = await work(1, "invalid");
    const episode = episodes[0]!;
    overrides.set("invalid-1", () => ({ status: 200, body: chatAnswer({ schema: "ads.script-breakdown.output.v1", episodeNo: 3, scenes: [], shots: [] }) }));
    await http("POST", base(projectId, episode.id), { body: {}, headers: operator() });
    const failed = await settled(projectId, episode.id);
    expect([failed.state, failed.step.errorCode, failed.save, failed.output]).toEqual(["failed", "episode_mismatch", "pending", null]);
    expect(await scenesOf(projectId, episode.id)).toHaveLength(0);
    overrides.delete("invalid-1");
    const resumed = await http("POST", `${base(projectId, episode.id)}/${failed.runId}/resume`, { body: {}, headers: operator() });
    expect(resumed.status).toBe(200);
    const done = await settled(projectId, episode.id);
    expect([done.state, done.save, done.callsUsed]).toEqual(["completed", "saved", 2]);
    const firstScene = (await scenesOf(projectId, episode.id))[0]!.entityId;
    const replaced = await http("POST", base(projectId, episode.id), { body: { replaceExisting: true }, headers: operator() });
    expect(replaced.status).toBe(201);
    const second = await settled(projectId, episode.id);
    expect([second.state, second.replacedScenes]).toEqual(["completed", 1]);
    const live = await scenesOf(projectId, episode.id);
    expect(live.map((item) => item.entityId)).not.toContain(firstScene);
    expect((await q<{ archived: boolean }>("SELECT archived_at IS NOT NULL AS archived FROM scene WHERE id = $1", [firstScene])).rows[0]!.archived).toBe(true);
    scenarios.invalidThenResume = { firstError: "episode_mismatch", callsUsed: 2, replacedWithConsent: true };
  });

  it("writes shots after the person approves a scene, keeps edits as new revisions, and shows a newer script as a stale source", async () => {
    const { projectId, storyId, episodes } = await work(1, "place");
    const episode = episodes[0]!;
    await http("POST", base(projectId, episode.id), { body: {}, headers: operator() });
    const run = await settled(projectId, episode.id);
    const sceneId = run.scenes[0]!.sceneId;
    const early = await http("POST", `${base(projectId, episode.id)}/${run.runId}/shots`, { body: {} });
    expect((early.body.placement as ScriptBreakdownPlacementOutcome).awaitingApproval).toEqual(["S1"]);
    await approveScene(projectId, episode.id, sceneId);
    const placed = await http("POST", `${base(projectId, episode.id)}/${run.runId}/shots`, { body: {} });
    expect((placed.body.placement as ScriptBreakdownPlacementOutcome).placed).toEqual(["S1"]);
    const shots = await http("GET", `/projects/${projectId}/episodes/${episode.id}/scenes/${sceneId}/shots`);
    expect(shots.body.items).toHaveLength(2);
    const histories = await Promise.all((shots.body.items as Array<{ entityId: string; rowVersion: number }>).map(async (item) => ({ item,
      current: (await http("GET", `/projects/${projectId}/episodes/${episode.id}/scenes/${sceneId}/shots/${item.entityId}/revisions`)).body.items[0] })));
    expect(histories.map((entry) => [entry.current.ordinal, entry.current.plannedDurationMs]).sort()).toEqual([[1, 3000], [2, 4000]]);
    const { item: shot, current } = histories.find((entry) => entry.current.dialogue !== null)!;
    expect(current).toMatchObject({ dialogue: "林夏：第 1 集第 1 句。", plannedDurationMs: 4000, reviewStatus: "DRAFT", freshnessStatus: "CURRENT" });
    // A person edits the shot: a new revision with its own planned seconds; the first one stays readable.
    const edited = await http("POST", `/projects/${projectId}/episodes/${episode.id}/scenes/${sceneId}/shots/${shot.entityId}/revisions`, {
      body: { sourceSceneRevisionId: current.sourceSceneRevisionId, ordinal: current.ordinal, shotType: current.shotType, camera: "改成手持跟拍",
        action: current.action, dialogue: current.dialogue, durationHint: null, plannedDurationMs: 5000, promptText: current.promptText },
      headers: { ...key(), "if-match": String(shot.rowVersion) } });
    expect(edited.status, JSON.stringify(edited.body)).toBe(201);
    const after = await http("GET", `/projects/${projectId}/episodes/${episode.id}/scenes/${sceneId}/shots/${shot.entityId}/revisions`);
    expect(after.body.items.map((item: { revisionNo: number; plannedDurationMs: number; camera: string }) => [item.revisionNo, item.plannedDurationMs, item.camera]))
      .toEqual([[2, 5000, "改成手持跟拍"], [1, 4000, "固定机位，人物胸像"]]);
    // A newer approved script: the breakdown keeps its source; scenes and shots become stale; nothing is sent.
    const before = sent.length;
    await saveScript(projectId, storyId, episode.id, `${scriptOf(1, 1, "place-1")}\n林夏：新的一句。`);
    const stale = (await latest(projectId, episode.id))!;
    expect(stale).toMatchObject({ scriptRevisionNo: run.scriptRevisionNo, episodeScript: { currentRevisionNo: run.scriptRevisionNo + 1, approved: true } });
    expect(stale.scenes[0]!.current.freshnessStatus).toBe("STALE");
    expect(sent.length).toBe(before);
    scenarios.placement = { awaitingThenPlaced: true, editedRevision: 2, staleAfterScript: true };
  });

  it("never reaches a provider: every send went to the stub with the stub key", () => {
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((item) => item.keyMatches)).toBe(true);
  });
});
