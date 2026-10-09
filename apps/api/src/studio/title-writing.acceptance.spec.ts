/**
 * Title writing acceptance over real HTTP and real PostgreSQL, with a controllable model double. NOT part of `test` or
 * `integration`: run only with `pnpm --filter @ai-drama/api title-writing:acceptance` against a newly created, empty,
 * disposable database (same guard and variables as the store acceptance, a different database). It migrates that
 * database through the released migrations only, checks the refusal, then upgrades it through the normal migration
 * chain while the API keeps running. The draft SQL is never applied.
 *
 * What is real: the Nest application with its real controllers and services, listening on a local port and called with
 * fetch; the PostgreSQL store and text chain. What is not: the model. The title writing service the controller uses is
 * built here with a stub transport that records every request and never opens a network connection. The runtime's own
 * title writing stays switched off without provider keys, so nothing in this process can reach a real provider.
 */
import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TitleWritingRunView } from "@ai-drama/contracts";
import {
  PostgresTitleWritingStore,
  TextChainService,
  checkTitleWritingAcceptanceEnv,
  closePostgresPool,
  createPostgresPool,
  TITLE_WRITING_MIGRATION,
  runMigrations,
  verifyTitleWritingAcceptanceDatabase,
} from "@ai-drama/database";
import { TITLE_WRITING_LEASE_MS, TitleWritingEngine, newTitleRun, titleWritingProviderConfigs, type WritingTransport } from "@ai-drama/providers";
import {
  chatAnswer,
  fixtureConcept,
  fixtureEpisode,
  fixtureOutline,
  fixtureStepOf,
  type FixtureStep,
} from "@ai-drama/providers/title-writing-fixtures";
import { AppModule } from "../app.module";
import { loadApiEnv } from "../config/env";
import { SafeExceptionFilter } from "../http/safe-exception.filter";
import type { StudioRuntime } from "./studio.runtime";
import { TitleWritingService } from "./title-writing.service";
import { STUDIO_RUNTIME, TITLE_WRITING_SERVICE } from "./tokens";

// Refuse before any connection is opened.
const decision = checkTitleWritingAcceptanceEnv(process.env);
if (!decision.ok) throw new Error(`Title writing API acceptance refused: ${decision.reason}`);
const acceptanceUrl = decision.url;

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
// Generated per run, held in memory, never printed or written to the evidence.
const OPERATOR_TOKEN = `acceptance-${randomUUID()}`;
// Not a key of any provider account: the stub never sends it anywhere.
const STUB_KEY = `stub-not-a-provider-key-${randomUUID()}`;
const QWEN_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const STUB_MODEL = "qwen-acceptance-stub";

const pool = createPostgresPool({ connectionString: acceptanceUrl, connectionTimeoutMs: 2_000, statementTimeoutMs: 10_000, queryTimeoutMs: 10_000 });
/** Typed rows from the acceptance pool (PostgresPool.query is untyped). */
async function q<T>(sql: string, values: unknown[] = []): Promise<{ rows: T[]; rowCount: number | null }> {
  return await pool.query(sql, values) as { rows: T[]; rowCount: number | null };
}
const evidence: Record<string, unknown> = { scenarios: {} as Record<string, unknown> };
const scenarios = evidence.scenarios as Record<string, unknown>;

// ---------------------------------------------------------------------------------------------------------------
// Model double: records every request, answers from fixtures, and can be told per title and attempt to fail.

type Plan = { status: number; body: unknown } | "throw" | "hang" | { hold: Promise<void> };
interface Sent { title: string; step: FixtureStep; attempt: number; endpoint: string; keyMatches: boolean }

const sent: Sent[] = [];
const plans = new Map<string, (step: FixtureStep, attempt: number) => Plan | undefined>();
const attempts = new Map<string, number>();

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

const transport: WritingTransport = async (request) => {
  const endpoint = new URL(request.url);
  const body = JSON.parse(request.body) as { messages?: Array<{ role: string; content: string }> };
  const user = body.messages?.find((message) => message.role === "user")?.content ?? "";
  const title = /剧名：(.+)/.exec(user)?.[1]?.trim();
  if (!title) throw new Error("stub: a prompt without a title");
  const step = fixtureStepOf(user);
  const key = `${title}|${step}`;
  const attempt = (attempts.get(key) ?? 0) + 1;
  attempts.set(key, attempt);
  const authorization = (request.headers as Record<string, string>).Authorization ?? (request.headers as Record<string, string>).authorization;
  sent.push({ title, step, attempt, endpoint: `${endpoint.host}${endpoint.pathname}`, keyMatches: authorization === `Bearer ${STUB_KEY}` });
  const plan = plans.get(title)?.(step, attempt);
  if (plan === "throw") throw new TypeError("fetch failed");
  if (plan === "hang") {
    return new Promise((_, reject) => {
      request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  }
  if (plan && "hold" in plan) await plan.hold;
  const answer = plan && "status" in plan ? plan : { status: 200, body: chatAnswer(step === "concept" ? fixtureConcept(title)
    : step === "outline" ? fixtureOutline() : fixtureEpisode(Number(step.slice(-1)) as 1 | 2 | 3)) };
  return {
    status: answer.status,
    headers: { get: (name: string) => name.toLowerCase() === "x-request-id" ? `stub-${step}-${String(attempt)}` : null },
    body: new TextEncoder().encode(JSON.stringify(answer.body)),
  };
};

const sends = (title: string) => sent.filter((item) => item.title === title).length;

function stubProviders() {
  return titleWritingProviderConfigs({ DASHSCOPE_API_KEY: STUB_KEY, BAILIAN_BASE_URL: QWEN_BASE, TITLE_WRITING_QWEN_MODELS: STUB_MODEL });
}

/** The service the controller uses: real store on the runtime's pool, engine with the stub transport. */
function titleService(runtime: StudioRuntime, enabled: boolean): TitleWritingService {
  const providers = stubProviders();
  const store = new PostgresTitleWritingStore(runtime.pool, new TextChainService(runtime.pool));
  return new TitleWritingService({
    workspaceId: WORKSPACE,
    nodeEnv: "test",
    enabled,
    operatorToken: OPERATOR_TOKEN,
    defaultProvider: "qwen",
    providers,
    store,
    // timeoutMs only shortens how long the stub's "hang" is waited for; the product cap and lease are unchanged.
    engine: new TitleWritingEngine({ workspaceId: WORKSPACE, store, providers, transport, maxCallsPerDay: 200, timeoutMs: 1_500 }),
    projects: runtime.store,
    maxCallsPerDay: 200,
    maxActiveRuns: 10,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Real application on a local port.

interface Booted { app: INestApplication; base: string; service: TitleWritingService }

async function boot(enabled: boolean): Promise<Booted> {
  // The runtime's own title writing: switched off (the default) and without provider keys.
  const env = loadApiEnv({
    NODE_ENV: "test",
    DATABASE_URL: acceptanceUrl,
    REDIS_URL: "redis://127.0.0.1:6399",
    S3_ENDPOINT: "http://127.0.0.1:59000",
    S3_REGION: "us-east-1",
    S3_BUCKET: "ai-drama-dev",
    S3_ACCESS_KEY_ID: "test",
    S3_SECRET_ACCESS_KEY: "test",
    APP_WORKSPACE_ID: WORKSPACE,
  });
  expect(env.TITLE_WRITING_ENABLED).toBe(false);
  let service: TitleWritingService | undefined;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(env)] })
    .overrideProvider(TITLE_WRITING_SERVICE)
    .useFactory({ inject: [STUDIO_RUNTIME], factory: (runtime: StudioRuntime) => (service = titleService(runtime, enabled)) })
    .compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix("api/v1");
  app.useGlobalFilters(new SafeExceptionFilter());
  await app.init();
  await app.listen(0, "127.0.0.1");
  return { app, base: await app.getUrl(), service: service! };
}

/** The fields this file reads from API answers. Each answer carries only some of them; the assertions say which. */
interface Answer {
  id: string;
  version: number;
  revisionId: string;
  reviewVersion: number;
  rowVersion: number;
  code: string;
  storageReady: boolean;
  items: Array<Record<string, unknown>>;
  run: TitleWritingRunView;
  error: { code: string; details?: Record<string, unknown> };
}

let main: Booted;
const exchanges: Array<{ method: string; path: string; status: number }> = [];

async function http(target: Booted, method: "GET" | "POST", path: string, options: { body?: unknown; headers?: Record<string, string> } = {}) {
  const response = await fetch(`${target.base}/api/v1${path}`, {
    method,
    headers: { accept: "application/json", ...(options.body !== undefined ? { "content-type": "application/json" } : {}), ...options.headers },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  exchanges.push({ method, path, status: response.status });
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Answer };
}

const operator = (key?: string) => ({ "x-operator-token": OPERATOR_TOKEN, ...(key ? { "idempotency-key": key } : {}) });

async function createProject(title: string): Promise<string> {
  const created = await http(main, "POST", "/projects", { body: { title, premise: "" }, headers: { "idempotency-key": randomUUID() } });
  expect(created.status).toBe(201);
  return created.body.id;
}

async function startRun(projectId: string, title: string, key = randomUUID()) {
  return http(main, "POST", `/projects/${projectId}/title-runs`, { body: { title }, headers: operator(key) });
}

async function latest(projectId: string): Promise<TitleWritingRunView> {
  const read = await http(main, "GET", `/projects/${projectId}/title-runs/latest`);
  expect(read.status).toBe(200);
  return read.body.run;
}

/** Reads the server's progress until it rests. It polls a condition with a deadline; it fails when it never holds. */
async function until(projectId: string, done: (run: TitleWritingRunView) => boolean): Promise<TitleWritingRunView> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const run = await latest(projectId);
    if (run && done(run)) return run;
    if (Date.now() > deadline) throw new Error(`run did not reach the expected state: ${JSON.stringify(run?.state)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const resting = (run: TitleWritingRunView) => run.state !== "running";

async function waitForSends(title: string, count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (sends(title) < count) {
    if (Date.now() > deadline) throw new Error(`stub saw ${String(sends(title))} sends for ${title}, expected ${String(count)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function approveStory(projectId: string, revisionId: string): Promise<void> {
  const project = await http(main, "GET", `/projects/${projectId}`);
  const stories = await http(main, "GET", `/projects/${projectId}/stories`);
  const story = (stories.body.items as Array<{ id: string; reviewVersion: number }>).find((item) => item.id === revisionId)!;
  const inReview = await http(main, "POST", `/projects/${projectId}/stories/${revisionId}/review`, {
    body: { to: "IN_REVIEW", expectedReviewVersion: story.reviewVersion },
    headers: { "idempotency-key": randomUUID(), "if-match": String(project.body.version) },
  });
  expect(inReview.status).toBe(200);
  const approved = await http(main, "POST", `/projects/${projectId}/stories/${revisionId}/review`, {
    body: { to: "APPROVED", expectedReviewVersion: inReview.body.reviewVersion },
    headers: { "idempotency-key": randomUUID(), "if-match": String(inReview.body.rowVersion) },
  });
  expect(approved.status).toBe(200);
}

async function episodes(projectId: string) {
  const listed = await http(main, "GET", `/projects/${projectId}/episodes`);
  expect(listed.status).toBe(200);
  return listed.body.items as Array<{ id: string; episodeNo: number; rowVersion: number; currentScriptRevisionId: string | null }>;
}

const scriptRows = async (projectId: string) =>
  (await q<{ id: string; episode_id: string; review_status: string; source_story_revision_id: string }>(
    "SELECT id, episode_id, review_status, source_story_revision_id FROM script_revision WHERE project_id = $1", [projectId])).rows;

const callRows = async (runId: string) =>
  (await q<{ step_key: string; attempt_no: number; state: string; error_code: string | null; billing_status: string }>(
    "SELECT step_key, attempt_no, state, error_code, billing_status FROM title_writing_call WHERE run_id = $1 ORDER BY created_at", [runId])).rows;

beforeAll(async () => {
  const verified = await verifyTitleWritingAcceptanceDatabase({ query: (sql, values) => q<Record<string, unknown>>(sql, values) }, decision.databaseName);
  if (!verified.ok) {
    await closePostgresPool(pool);
    throw new Error(`Title writing API acceptance refused: ${verified.reason}`);
  }
  const identity = (await q<{ name: string; version: string; tables: number }>(
    `SELECT current_database() AS name, current_setting('server_version') AS version,
            (SELECT count(*)::int FROM information_schema.tables
              WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg_toast%') AS tables`)).rows[0]!;
  evidence.database = { name: identity.name, serverVersion: identity.version, tablesBeforeWrite: identity.tables };
  // The released schema: every migration before the title writing one, as on a server before this release.
  evidence.migrationsApplied = (await runMigrations(pool, undefined, { before: TITLE_WRITING_MIGRATION })).applied;
  await q("INSERT INTO workspace (id, name, status) VALUES ($1, 'title-acceptance', 'ACTIVE')", [WORKSPACE]);
  main = await boot(true);
});

afterAll(async () => {
  if (main) await main.app.close();
  await closePostgresPool(pool);
  evidence.stub = { totalSends: sent.length, everyEndpoint: [...new Set(sent.map((item) => item.endpoint))], everyKeyWasTheStubKey: sent.every((item) => item.keyMatches) };
  evidence.httpExchanges = exchanges.length;
  const dir = process.env.TITLE_WRITING_ACCEPTANCE_EVIDENCE_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "title-writing-api-acceptance.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }
});

describe("title writing over real HTTP and PostgreSQL, model stubbed", () => {
  it("before the title writing migration, start is refused with nothing sent; then the normal chain adds it", async () => {
    const projectId = await createProject("存储未就绪");
    const options = await http(main, "GET", "/writing/title-runs/options");
    expect(options.body).toMatchObject({ code: "TITLE_WRITING_STORAGE_UNAVAILABLE", storageReady: false });
    const refused = await startRun(projectId, "存储未就绪");
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe("TITLE_WRITING_STORAGE_UNAVAILABLE");
    expect(sent).toHaveLength(0);

    const upgrade = await runMigrations(pool);
    expect(upgrade.applied).toEqual([TITLE_WRITING_MIGRATION]);
    evidence.upgradeApplied = upgrade.applied;
    const ready = await http(main, "GET", "/writing/title-runs/options");
    expect(ready.body).toMatchObject({ code: "TITLE_WRITING_READY", storageReady: true, billing: "unknown" });
    scenarios.storageNotReady = { status: refused.status, code: refused.body.error.code, sends: 0 };
  });

  it("switched off, a missing or wrong token and a missing key are refused; nothing is stored or sent", async () => {
    const off = await boot(false);
    try {
      const projectId = await createProject("开关关闭");
      const refused = await http(off, "POST", `/projects/${projectId}/title-runs`, { body: { title: "开关关闭" }, headers: operator(randomUUID()) });
      expect(refused.status).toBe(404);
      expect(refused.body.error.code).toBe("TITLE_WRITING_DISABLED");
    } finally {
      await off.app.close();
    }
    const projectId = await createProject("权限检查");
    const noToken = await http(main, "POST", `/projects/${projectId}/title-runs`, { body: { title: "权限检查" }, headers: { "idempotency-key": randomUUID() } });
    const wrongToken = await http(main, "POST", `/projects/${projectId}/title-runs`, { body: { title: "权限检查" },
      headers: { "x-operator-token": `wrong-${randomUUID()}`, "idempotency-key": randomUUID() } });
    const noKey = await http(main, "POST", `/projects/${projectId}/title-runs`, { body: { title: "权限检查" }, headers: operator() });
    expect([noToken.status, wrongToken.status, noKey.status]).toEqual([403, 403, 400]);
    expect(noToken.body.error.code).toBe("TITLE_WRITING_FORBIDDEN");
    expect(sent).toHaveLength(0);
    expect((await q("SELECT 1 FROM title_writing_run")).rowCount).toBe(0);
    scenarios.refusals = { disabled: 404, noToken: 403, wrongToken: 403, noIdempotencyKey: 400, sends: 0, runs: 0 };
  });

  it("title → story, outline, three scripts → DRAFT story → person approves → scripts written once", async () => {
    const title = "夜班证词验收";
    const projectId = await createProject(title);
    const gate = deferred();
    plans.set(title, (step, attempt) => step === "concept" && attempt === 1 ? { hold: gate.promise } : undefined);
    const key = randomUUID();
    const started = await startRun(projectId, title, key);
    expect(started.status).toBe(201);
    const runId = started.body.run.runId;
    const replay = await startRun(projectId, title, key);
    expect(replay.status).toBe(200);
    expect(replay.body.run.runId).toBe(runId);
    const reused = await http(main, "POST", `/projects/${projectId}/title-runs`, { body: { title: `${title}（改）` }, headers: operator(key) });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    const second = await startRun(projectId, title);
    expect(second.status).toBe(409);
    expect(second.body.error).toMatchObject({ code: "TITLE_WRITING_RUN_ACTIVE", details: { runId } });
    await waitForSends(title, 1);
    gate.release();

    const done = await until(projectId, resting);
    expect(done).toMatchObject({ runId, state: "completed", storySave: "saved", callsUsed: 5 });
    expect(sends(title)).toBe(5);
    expect(done.calls.map((call) => [call.stepKey, call.attemptNo, call.state, call.billingStatus])).toEqual(
      ["concept", "outline", "episode:1", "episode:2", "episode:3"].map((stepKey) => [stepKey, 1, "completed", "unknown"]));
    expect(done.steps.slice(2).map((step) => step.scriptSave)).toEqual(["awaiting_story_approval", "awaiting_story_approval", "awaiting_story_approval"]);
    expect((await q("SELECT 1 FROM title_writing_run WHERE project_id = $1", [projectId])).rowCount).toBe(1);

    const stories = await http(main, "GET", `/projects/${projectId}/stories`);
    expect(stories.body.items).toEqual([expect.objectContaining({ id: done.storyRevisionId, reviewStatus: "DRAFT" })]);
    expect(await scriptRows(projectId)).toEqual([]);
    const early = await http(main, "POST", `/projects/${projectId}/title-runs/${runId}/scripts`, { body: {} });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("TITLE_WRITING_STORY_NOT_APPROVED");
    expect((await latest(projectId)).steps.slice(2).every((step) => step.scriptSave === "awaiting_story_approval")).toBe(true);

    await approveStory(projectId, done.storyRevisionId!);
    const placed = await http(main, "POST", `/projects/${projectId}/title-runs/${runId}/scripts`, { body: {} });
    expect(placed.status).toBe(200);
    const placedSteps = (placed.body.run as TitleWritingRunView).steps.slice(2);
    expect(placedSteps.map((step) => step.scriptSave)).toEqual(["saved", "saved", "saved"]);
    const list = await episodes(projectId);
    expect(list.map((item) => item.currentScriptRevisionId)).toEqual(placedSteps.map((step) => step.scriptRevisionId));
    const rows = await scriptRows(projectId);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.review_status === "DRAFT" && row.source_story_revision_id === done.storyRevisionId)).toBe(true);
    for (const item of list) {
      const revisions = await http(main, "GET", `/projects/${projectId}/episodes/${item.id}/scripts`);
      expect(revisions.body.items).toHaveLength(1);
    }
    const again = await http(main, "POST", `/projects/${projectId}/title-runs/${runId}/scripts`, { body: {} });
    expect(again.status).toBe(200);
    expect(await scriptRows(projectId)).toHaveLength(3);
    expect(sends(title)).toBe(5);
    scenarios.fullFlow = { projectId, runId, storyRevisionId: done.storyRevisionId, scriptRevisionIds: placedSteps.map((step) => step.scriptRevisionId),
      sends: sends(title), replayStatus: replay.status, reusedKey: reused.status, secondStart: second.status, beforeApproval: early.status,
      scriptsAfterReplay: 3 };
  });

  it("an episode that already has a person's script is a conflict and keeps its text; the others are written", async () => {
    const title = "已有剧本验收";
    const projectId = await createProject(title);
    const started = await startRun(projectId, title);
    const runId = started.body.run.runId;
    const done = await until(projectId, resting);
    expect(done.state).toBe("completed");
    await approveStory(projectId, done.storyRevisionId!);
    const second = (await episodes(projectId)).find((item) => item.episodeNo === 2)!;
    const human = await http(main, "POST", `/projects/${projectId}/episodes/${second.id}/scripts`, {
      body: { sourceStoryRevisionId: done.storyRevisionId, content: { text: "人工剧本，验收前已存在" } },
      headers: { "idempotency-key": randomUUID(), "if-match": String(second.rowVersion) },
    });
    expect(human.status).toBe(201);
    const placed = await http(main, "POST", `/projects/${projectId}/title-runs/${runId}/scripts`, { body: {} });
    expect(placed.status).toBe(200);
    expect((placed.body.run as TitleWritingRunView).steps.slice(2).map((step) => step.scriptSave)).toEqual(["saved", "conflict", "saved"]);
    const after = (await episodes(projectId)).find((item) => item.episodeNo === 2)!;
    expect(after.currentScriptRevisionId).toBe(human.body.revisionId);
    const kept = await http(main, "GET", `/projects/${projectId}/episodes/${second.id}/scripts`);
    expect(kept.body.items).toEqual([expect.objectContaining({ id: human.body.revisionId, content: { text: "人工剧本，验收前已存在" } })]);
    expect(await scriptRows(projectId)).toHaveLength(3);
    scenarios.partialConflict = { projectId, runId, steps: ["saved", "conflict", "saved"], humanRevisionId: human.body.revisionId, sends: sends(title) };
  });

  it("another approved story version does not stand in for the run's story", async () => {
    const title = "故事换版验收";
    const projectId = await createProject(title);
    const runId = (await startRun(projectId, title)).body.run.runId;
    const done = await until(projectId, resting);
    const project = await http(main, "GET", `/projects/${projectId}`);
    const replaced = await http(main, "POST", `/projects/${projectId}/stories`, { body: { content: { text: "人工改写的故事" } },
      headers: { "idempotency-key": randomUUID(), "if-match": String(project.body.version) } });
    expect(replaced.status).toBe(201);
    const unapproved = await http(main, "POST", `/projects/${projectId}/title-runs/${runId}/scripts`, { body: {} });
    expect(unapproved.body.error.code).toBe("TITLE_WRITING_STORY_NOT_APPROVED");
    await approveStory(projectId, replaced.body.revisionId);
    const changed = await http(main, "POST", `/projects/${projectId}/title-runs/${runId}/scripts`, { body: {} });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe("TITLE_WRITING_STORY_CHANGED");
    expect(await scriptRows(projectId)).toEqual([]);
    expect(done.storyRevisionId).not.toBe(replaced.body.revisionId);
    scenarios.storyVersionBinding = { projectId, runId, runStory: done.storyRevisionId, approvedOther: replaced.body.revisionId,
      unapproved: unapproved.status, changed: changed.status, scripts: 0 };
  });

  it("a sent call with an unknown result (5xx) is never re-sent on its own; resume needs the token, a key and the exact confirmation", async () => {
    const title = "结果未知验收";
    const projectId = await createProject(title);
    plans.set(title, (step, attempt) => step === "concept" && attempt === 1 ? { status: 503, body: { error: "upstream" } } : undefined);
    const runId = (await startRun(projectId, title)).body.run.runId;
    const stopped = await until(projectId, resting);
    expect(stopped).toMatchObject({ state: "needs_attention" });
    expect(stopped.steps[0]).toMatchObject({ state: "unknown", errorCode: "server_error" });
    expect(sends(title)).toBe(1);
    // Maintenance (as the API's periodic pass would run it) does not resend an uncertain call.
    await main.service.maintain();
    await main.service.maintain();
    expect(sends(title)).toBe(1);
    const uncertain = stopped.calls.filter((call) => call.state === "unknown").map((call) => call.callId);
    expect(uncertain).toHaveLength(1);

    const path = `/projects/${projectId}/title-runs/${runId}/resume`;
    const noToken = await http(main, "POST", path, { body: { confirmUncertainCallIds: uncertain }, headers: { "idempotency-key": randomUUID() } });
    const wrongToken = await http(main, "POST", path, { body: { confirmUncertainCallIds: uncertain },
      headers: { "x-operator-token": `wrong-${randomUUID()}`, "idempotency-key": randomUUID() } });
    const noKey = await http(main, "POST", path, { body: { confirmUncertainCallIds: uncertain }, headers: operator() });
    const unconfirmed = await http(main, "POST", path, { body: { confirmUncertainCallIds: [] }, headers: operator(randomUUID()) });
    const stale = await http(main, "POST", path, { body: { confirmUncertainCallIds: [randomUUID()] }, headers: operator(randomUUID()) });
    expect([noToken.status, wrongToken.status, noKey.status, unconfirmed.status, stale.status]).toEqual([403, 403, 400, 409, 409]);
    expect(unconfirmed.body.error.code).toBe("TITLE_WRITING_NEEDS_CONFIRMATION");
    expect(stale.body.error.code).toBe("TITLE_WRITING_CONFIRMATION_STALE");
    expect(sends(title)).toBe(1);

    const resumeKey = randomUUID();
    const resumed = await http(main, "POST", path, { body: { confirmUncertainCallIds: uncertain }, headers: operator(resumeKey) });
    expect(resumed.status).toBe(200);
    const finished = await until(projectId, resting);
    expect(finished.state).toBe("completed");
    expect(sends(title)).toBe(6);
    const replayed = await http(main, "POST", path, { body: { confirmUncertainCallIds: uncertain }, headers: operator(resumeKey) });
    expect(replayed.status).toBe(200);
    expect(replayed.body.run.state).toBe("completed");
    const otherBody = await http(main, "POST", path, { body: { confirmUncertainCallIds: [] }, headers: operator(resumeKey) });
    expect(otherBody.status).toBe(409);
    expect(otherBody.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    await main.service.maintain();
    expect(sends(title)).toBe(6);
    const calls = await callRows(runId);
    expect(calls.map((row) => [row.step_key, row.attempt_no, row.state])).toEqual([
      ["concept", 1, "unknown"], ["concept", 2, "completed"], ["outline", 1, "completed"],
      ["episode:1", 1, "completed"], ["episode:2", 1, "completed"], ["episode:3", 1, "completed"]]);
    expect(calls.every((row) => row.billing_status === "unknown")).toBe(true);
    expect((await q("SELECT 1 FROM title_writing_resume WHERE run_id = $1", [runId])).rowCount).toBe(1);
    scenarios.unknownThenResume = { projectId, runId, sendsBeforeResume: 1, refusals: [403, 403, 400, 409, 409], resumeStatus: resumed.status,
      replayStatus: replayed.status, sameKeyOtherBody: otherBody.status, sends: sends(title), callRows: calls.length, resumeRows: 1 };
  });

  it("a timeout and a dropped connection are uncertain; a truncated answer is a refusal that resumes without confirmation", async () => {
    const timeout = "超时验收";
    const timeoutProject = await createProject(timeout);
    plans.set(timeout, (step, attempt) => step === "concept" && attempt === 1 ? "hang" : undefined);
    await startRun(timeoutProject, timeout);
    const timedOut = await until(timeoutProject, resting);
    expect(timedOut.state).toBe("needs_attention");
    expect(timedOut.steps[0]).toMatchObject({ state: "unknown", errorCode: "timeout" });

    const dropped = "断连验收";
    const droppedProject = await createProject(dropped);
    plans.set(dropped, (step, attempt) => step === "concept" && attempt === 1 ? "throw" : undefined);
    await startRun(droppedProject, dropped);
    const disconnected = await until(droppedProject, resting);
    expect(disconnected.state).toBe("needs_attention");
    expect(disconnected.steps[0]).toMatchObject({ state: "unknown", errorCode: "disconnected" });

    const cut = "截断验收";
    const cutProject = await createProject(cut);
    plans.set(cut, (step, attempt) => step === "outline" && attempt === 1 ? { status: 200, body: chatAnswer(fixtureOutline(), "length") } : undefined);
    const cutRun = (await startRun(cutProject, cut)).body.run.runId;
    const partial = await until(cutProject, resting);
    expect(partial.state).toBe("partial");
    expect(partial.steps[1]).toMatchObject({ state: "rejected", errorCode: "truncated" });
    expect(sends(cut)).toBe(2);
    const resumed = await http(main, "POST", `/projects/${cutProject}/title-runs/${cutRun}/resume`, { body: { confirmUncertainCallIds: [] },
      headers: operator(randomUUID()) });
    expect(resumed.status).toBe(200);
    expect((await until(cutProject, resting)).state).toBe("completed");
    // The completed concept is not called again: outline attempt 2 and the three episodes.
    expect(sends(cut)).toBe(6);
    expect(sent.filter((item) => item.title === cut && item.step === "concept")).toHaveLength(1);
    expect([sends(timeout), sends(dropped)]).toEqual([1, 1]);
    scenarios.failureKinds = { timeout: { sends: sends(timeout), step: "unknown/timeout" }, disconnected: { sends: sends(dropped), step: "unknown/disconnected" },
      truncated: { sends: sends(cut), step: "rejected/truncated then resumed", conceptSends: 1 } };
  });

  it("cancel while a call is in flight: the sent call keeps its result, no further step starts", async () => {
    const title = "取消验收";
    const projectId = await createProject(title);
    const gate = deferred();
    plans.set(title, (step) => step === "concept" ? { hold: gate.promise } : undefined);
    const runId = (await startRun(projectId, title)).body.run.runId;
    await waitForSends(title, 1);
    const canceled = await http(main, "POST", `/projects/${projectId}/title-runs/${runId}/cancel`);
    expect(canceled.status).toBe(200);
    expect(canceled.body.run).toMatchObject({ state: "running", cancelRequested: true });
    gate.release();
    const done = await until(projectId, resting);
    expect(done.state).toBe("canceled");
    expect(done.steps[0]).toMatchObject({ state: "completed" });
    expect(sends(title)).toBe(1);
    expect((await callRows(runId)).map((row) => [row.step_key, row.state])).toEqual([["concept", "completed"]]);
    scenarios.cancelInFlight = { projectId, runId, sends: 1, state: done.state, concept: "completed" };
  });

  it("engine on real PostgreSQL with a logical clock: a fenced executor's late answer is dropped and nothing continues", async () => {
    // Not over HTTP and not a process crash: two engines share the real store, and B's clock is set past A's lease.
    const title = "迟到结果验收";
    const projectId = await createProject(title);
    const gate = deferred();
    plans.set(title, (step) => step === "concept" ? { hold: gate.promise } : undefined);
    const providers = stubProviders();
    const store = new PostgresTitleWritingStore(pool, new TextChainService(pool));
    const startedAt = new Date();
    const record = newTitleRun({ workspaceId: WORKSPACE, projectId, actorId: "acceptance", idempotencyKey: randomUUID(), title,
      settings: { episodeCount: 3, episodeSeconds: 90, style: "" }, providerKey: "qwen", model: STUB_MODEL, now: startedAt });
    expect((await store.createRun(record, { maxActiveRuns: 10 })).kind).toBe("created");
    const engineA = new TitleWritingEngine({ workspaceId: WORKSPACE, store, providers, transport, maxCallsPerDay: 200, executorId: "acceptance-a",
      clock: () => startedAt });
    const engineB = new TitleWritingEngine({ workspaceId: WORKSPACE, store, providers, transport, maxCallsPerDay: 200, executorId: "acceptance-b",
      clock: () => new Date(startedAt.getTime() + TITLE_WRITING_LEASE_MS + 1_000) });
    const driving = engineA.drive(record.id);
    await waitForSends(title, 1);
    await engineB.maintain();
    const fenced = (await store.getRunById(WORKSPACE, record.id))!;
    expect(fenced.run).toMatchObject({ state: "needs_attention", errorCode: "executor_lost" });
    expect(fenced.calls).toEqual([expect.objectContaining({ state: "unknown", errorCode: "executor_lost" })]);
    gate.release();
    await driving;
    const after = (await store.getRunById(WORKSPACE, record.id))!;
    expect(after.calls).toEqual([expect.objectContaining({ state: "unknown", errorCode: "executor_lost" })]);
    expect(after.steps.map((step) => step.state)).toEqual(["unknown", "pending", "pending", "pending", "pending"]);
    expect(sends(title)).toBe(1);
    await engineB.maintain();
    expect(sends(title)).toBe(1);
    scenarios.lateAnswerAfterFence = { projectId, runId: record.id, sends: 1, callRows: 1, call: "unknown/executor_lost", nextStepStarted: false,
      clock: "logical (lease + 1 s); no process was killed" };
  });

  it("the stub was the only model endpoint and saw only the stub key", () => {
    expect(sent.length).toBeGreaterThan(0);
    expect([...new Set(sent.map((item) => item.endpoint))]).toEqual(["dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"]);
    expect(sent.every((item) => item.keyMatches)).toBe(true);
  });
});
