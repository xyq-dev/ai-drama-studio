/// <reference lib="dom" />
/**
 * Title writing browser acceptance: a real browser drives the real Next pages, which reach the real API through the
 * web's own same-origin /api/v1 rewrite; the API runs on a newly created, empty, disposable PostgreSQL database. NOT part
 * of `test` or `integration`: run only with `pnpm --filter @ai-drama/api title-writing:browser-acceptance`, with the same
 * guard and variables as the other title writing acceptances (and a database of its own). It applies the migrations and
 * the unapplied draft SQL to that database and nothing else. Run `pnpm build` first: it serves the built web app.
 *
 * What is real: Chrome, the built Next app, its rewrite, the Nest application with its controllers, services, store and
 * text chain, and PostgreSQL. What is not: the model. As in the API acceptance, the title writing service the controller
 * uses is built in this test with a stub transport that records every request and never opens a network connection; the
 * runtime's own title writing stays switched off without provider keys. So this verifies the business logic behind the
 * pages; it does not accept the StudioRuntime's own enabled configuration or its recovery timer.
 *
 * Every business action (start, refresh, approving the story, writing the scripts, confirming and resuming) is done on
 * the pages. The only API writes outside the browser are the conflict preparation (a person's script on one episode),
 * and reads that check what the pages did. SQL here is read-only after setup. The only network interference is one
 * resume answer that is passed to the server unchanged and, once the server has accepted it, cut off on its way back.
 */
import "reflect-metadata";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { type Browser, type BrowserContext, type Locator, type Page, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TitleWritingRunView } from "@ai-drama/contracts";
import {
  PostgresTitleWritingStore,
  TextChainService,
  checkTitleWritingAcceptanceEnv,
  closePostgresPool,
  createPostgresPool,
  runMigrations,
  verifyTitleWritingAcceptanceDatabase,
} from "@ai-drama/database";
import { TitleWritingEngine, titleWritingProviderConfigs, type WritingTransport } from "@ai-drama/providers";
import { chatAnswer, fixtureConcept, fixtureEpisode, fixtureOutline, fixtureStepOf, type FixtureStep } from "@ai-drama/providers/title-writing-fixtures";
import { AppModule } from "../app.module";
import { loadApiEnv } from "../config/env";
import { SafeExceptionFilter } from "../http/safe-exception.filter";
import type { StudioRuntime } from "./studio.runtime";
import { TitleWritingService } from "./title-writing.service";
import { STUDIO_RUNTIME, TITLE_WRITING_SERVICE } from "./tokens";

// Refuse before any connection is opened.
const decision = checkTitleWritingAcceptanceEnv(process.env);
if (!decision.ok) throw new Error(`Title writing browser acceptance refused: ${decision.reason}`);
const acceptanceUrl = decision.url;

const ROOT = join(__dirname, "..", "..", "..", "..");
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const DRAFT_NAME = "20261008000100_title_writing.sql";
// `next build` compiles the /api/v1 rewrite to this origin (the web's default upstream); the API listens there.
const API_PORT = 3001;
const WEB_PORT = 3010;
const WEB = `http://127.0.0.1:${String(WEB_PORT)}`;
const API = `http://127.0.0.1:${String(API_PORT)}`;
// Generated per run, held in memory, typed into password fields only; never printed or written to the evidence.
const OPERATOR_TOKEN = `acceptance-${randomUUID()}`;
// Not a key of any provider account: the stub never sends it anywhere.
const STUB_KEY = `stub-not-a-provider-key-${randomUUID()}`;
const QWEN_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const STUB_MODEL = "qwen-acceptance-stub";
// Every title says on screen that its text is the model double's fixture, not something a model wrote.
const MAIN_TITLE = "模型替身样例·夜班证词";
const CONFLICT_TITLE = "模型替身样例·已有剧本";
const UNKNOWN_TITLE = "模型替身样例·结果未知";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const pool = createPostgresPool({ connectionString: acceptanceUrl, connectionTimeoutMs: 2_000, statementTimeoutMs: 10_000, queryTimeoutMs: 10_000 });
async function q<T>(sql: string, values: unknown[] = []): Promise<T[]> {
  return (await pool.query(sql, values) as { rows: T[] }).rows;
}
const evidenceDir = process.env.TITLE_WRITING_ACCEPTANCE_EVIDENCE_DIR;
const shotsDir = evidenceDir ? join(evidenceDir, "screenshots") : null;
const evidence: Record<string, unknown> = { flows: {} as Record<string, unknown>, screenshots: [] as string[], networkInterference: [] as unknown[] };
const flows = evidence.flows as Record<string, unknown>;

// ---------------------------------------------------------------------------------------------------------------
// Model double: records every request, answers from fixtures, and can be told per title and attempt to wait or fail.

type Plan = { status: number; body: unknown } | { hold: Promise<void> };
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
  const headers = request.headers as Record<string, string>;
  sent.push({ title, step, attempt, endpoint: `${endpoint.host}${endpoint.pathname}`, keyMatches: (headers.Authorization ?? headers.authorization) === `Bearer ${STUB_KEY}` });
  const plan = plans.get(title)?.(step, attempt);
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

function titleService(runtime: StudioRuntime): TitleWritingService {
  const providers = titleWritingProviderConfigs({ DASHSCOPE_API_KEY: STUB_KEY, BAILIAN_BASE_URL: QWEN_BASE, TITLE_WRITING_QWEN_MODELS: STUB_MODEL });
  const store = new PostgresTitleWritingStore(runtime.pool, new TextChainService(runtime.pool));
  return new TitleWritingService({
    workspaceId: WORKSPACE,
    nodeEnv: "test",
    enabled: true,
    operatorToken: OPERATOR_TOKEN,
    defaultProvider: "qwen",
    providers,
    store,
    engine: new TitleWritingEngine({ workspaceId: WORKSPACE, store, providers, transport, maxCallsPerDay: 200, timeoutMs: 30_000 }),
    projects: runtime.store,
    maxCallsPerDay: 200,
    maxActiveRuns: 10,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Processes: the API in this test process, the built web app as a child process, Chrome.

let app: INestApplication | undefined;
let web: { child: ChildProcess; logs: () => string } | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page;
const pageErrors: string[] = [];

/** Removes anything secret from text that may be printed: the token, the stub key and the database URL. */
function redact(text: string): string {
  return text.split(OPERATOR_TOKEN).join("[token]").split(STUB_KEY).join("[stub-key]").split(acceptanceUrl).join("[database-url]");
}

async function bootApi(): Promise<INestApplication> {
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
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(env)] })
    .overrideProvider(TITLE_WRITING_SERVICE)
    .useFactory({ inject: [STUDIO_RUNTIME], factory: (runtime: StudioRuntime) => titleService(runtime) })
    .compile();
  const nest = moduleRef.createNestApplication();
  nest.setGlobalPrefix("api/v1");
  nest.useGlobalFilters(new SafeExceptionFilter());
  await nest.init();
  await nest.listen(API_PORT, "127.0.0.1");
  return nest;
}

function startWeb() {
  const nextBin = createRequire(join(ROOT, "apps", "web", "package.json")).resolve("next/dist/bin/next");
  // The web process gets no database, token or acceptance variable: only what `next start` needs.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const child = spawn(process.execPath, [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(WEB_PORT)],
    { cwd: join(ROOT, "apps", "web"), env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  const append = (chunk: Buffer) => { logs = `${logs}${chunk.toString()}`.slice(-8_000); };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return { child, logs: () => logs };
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

async function waitFor(what: string, check: () => Promise<boolean>, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Reads the API directly (not through the page) to check what the page did. */
async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${API}/api/v1${path}`, { headers: { accept: "application/json" } });
  expect(response.status).toBe(200);
  return await response.json() as T;
}

const latestRun = async (projectId: string) => (await apiGet<{ run: TitleWritingRunView }>(`/projects/${projectId}/title-runs/latest`)).run;

// ---------------------------------------------------------------------------------------------------------------
// Page helpers.

/** Business writes the page sent to /api/v1, with only the method, path and idempotency key kept. */
const pageWrites: Array<{ method: string; path: string; key: string | null }> = [];

function headline(): Locator {
  return page.locator("main").getByRole("status").first();
}

async function waitHeadline(text: string, timeout = 30_000): Promise<void> {
  await expect.poll(async () => await headline().textContent(), { timeout, interval: 200 }).toBe(text);
}

/**
 * At this viewport: no horizontal page overflow, the primary action (when given) on screen, enabled where expected and
 * not covered, then a full-page screenshot once the real content named by `ready` is shown.
 */
async function capture(name: string, ready: Locator, primary?: Locator): Promise<void> {
  for (const [label, size] of [["desktop", DESKTOP], ["390", PHONE]] as const) {
    await page.setViewportSize(size);
    await ready.first().waitFor({ state: "visible", timeout: 20_000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${name} ${label}: horizontal overflow`).toBeLessThanOrEqual(0);
    if (primary) {
      await primary.scrollIntoViewIfNeeded();
      const box = await primary.boundingBox();
      expect(box, `${name} ${label}: primary action has no box`).not.toBeNull();
      expect(box!.x >= -1 && box!.y >= -1 && box!.x + box!.width <= size.width + 1 && box!.y + box!.height <= size.height + 1,
        `${name} ${label}: primary action outside the viewport`).toBe(true);
      const covered = await primary.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return !(hit && (hit === node || node.contains(hit)));
      });
      expect(covered, `${name} ${label}: primary action is covered`).toBe(false);
    }
    if (shotsDir) {
      const file = `${name}-${label}.png`;
      await page.screenshot({ path: join(shotsDir, file), fullPage: true });
      (evidence.screenshots as string[]).push(file);
    }
  }
  await page.setViewportSize(DESKTOP);
}

/** Fills the start form on /create and starts; returns the work the page navigated to. */
async function startOnPage(title: string): Promise<string> {
  await page.goto(`${WEB}/create`, { waitUntil: "domcontentloaded" });
  await page.getByText("服务端已配置：千问").waitFor({ timeout: 30_000 });
  await page.locator("#ai-title").fill(title);
  await page.locator("#ai-token").fill(OPERATOR_TOKEN);
  const navigated = page.waitForURL(/\/projects\/[0-9a-f-]{36}\/writing$/, { timeout: 30_000 });
  await page.getByRole("button", { name: "AI 一键创作" }).click();
  await navigated;
  const projectId = /\/projects\/([0-9a-f-]{36})\/writing$/.exec(page.url())![1]!;
  await page.getByRole("heading", { name: `《${title}》` }).waitFor({ timeout: 30_000 });
  return projectId;
}

/** On the beginner story step the run linked to: 提交审核, then 通过, in the version column. */
async function approveStoryOnPage(projectId: string): Promise<void> {
  await page.getByRole("link", { name: "查看和修改故事草稿" }).click();
  await page.waitForURL(`${WEB}/projects/${projectId}/create?step=story`, { timeout: 30_000 });
  await page.getByRole("heading", { name: "第 1 步 · 定故事" }).waitFor({ timeout: 30_000 });
  const column = page.getByRole("complementary", { name: "检查面板" }).first();
  for (const [name, to] of [["提交审核", "IN_REVIEW"], ["通过", "APPROVED"]] as const) {
    const action = column.getByRole("button", { name, exact: true });
    await action.waitFor({ timeout: 20_000 });
    const answered = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/review"), { timeout: 20_000 });
    await action.click();
    const response = await answered;
    expect(response.status(), `story review to ${to}`).toBe(200);
  }
}

async function openRunPage(projectId: string): Promise<void> {
  await page.goto(`${WEB}/projects/${projectId}/writing`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: /^《.+》$/ }).waitFor({ timeout: 30_000 });
}

const scriptSummaries = () => page.locator("summary");

/** What the visible editors on the page hold. */
async function editorTexts(): Promise<string[]> {
  return await page.locator("textarea:visible").evaluateAll((nodes) => nodes.map((node) => (node as HTMLTextAreaElement).value));
}

async function scriptsOf(projectId: string) {
  return await q<{ id: string; episode_no: number; review_status: string; source_story_revision_id: string | null; text: string; current: boolean }>(
    `SELECT s.id, e.episode_no, s.review_status, s.source_story_revision_id, s.content->>'text' AS text, e.current_script_revision_id = s.id AS current
       FROM script_revision s JOIN episode e ON e.id = s.episode_id WHERE s.project_id = $1 ORDER BY e.episode_no, s.created_at`, [projectId]);
}

async function runRows(projectId: string) {
  return await q<{ id: string; state: string; calls_used: number; story_revision_id: string | null }>(
    "SELECT id, state, calls_used, story_revision_id FROM title_writing_run WHERE project_id = $1", [projectId]);
}

async function callRows(runId: string) {
  return await q<{ step_key: string; attempt_no: number; state: string; error_code: string | null }>(
    "SELECT step_key, attempt_no, state, error_code FROM title_writing_call WHERE run_id = $1 ORDER BY created_at", [runId]);
}

async function storyOf(revisionId: string) {
  return (await q<{ review_status: string; project_current: boolean }>(
    `SELECT s.review_status, p.current_story_revision_id = s.id AS project_current
       FROM story_revision s JOIN project p ON p.id = s.project_id WHERE s.id = $1`, [revisionId]))[0]!;
}

/** Waits a little over two poll intervals and returns how many stub sends happened meanwhile for `title`. */
async function sendsDuring(title: string, ms = 5_000): Promise<number> {
  const before = sends(title);
  await new Promise((resolve) => setTimeout(resolve, ms));
  return sends(title) - before;
}

// ---------------------------------------------------------------------------------------------------------------

beforeAll(async () => {
  const verified = await verifyTitleWritingAcceptanceDatabase({ query: async (sql, values) => ({ rows: await q<Record<string, unknown>>(sql, values) }) },
    decision.databaseName);
  if (!verified.ok) {
    await closePostgresPool(pool);
    throw new Error(`Title writing browser acceptance refused: ${verified.reason}`);
  }
  const identity = (await q<{ name: string; version: string; tables: number }>(
    `SELECT current_database() AS name, current_setting('server_version') AS version,
            (SELECT count(*)::int FROM information_schema.tables
              WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg_toast%') AS tables`))[0]!;
  evidence.database = { name: identity.name, serverVersion: identity.version, tablesBeforeWrite: identity.tables };
  evidence.migrationsApplied = (await runMigrations(pool)).applied;
  await q(await readFile(join(ROOT, "packages", "database", "prisma", "drafts", DRAFT_NAME), "utf8"));
  evidence.draftApplied = DRAFT_NAME;
  await q("INSERT INTO workspace (id, name, status) VALUES ($1, 'title-browser-acceptance', 'ACTIVE')", [WORKSPACE]);
  if (shotsDir) await mkdir(shotsDir, { recursive: true });

  app = await bootApi();
  web = startWeb();
  await waitFor("the API", async () => (await fetch(`${API}/api/v1/health/live`)).ok);
  await waitFor("the web app", async () => (await fetch(WEB)).ok);
  // The page reaches the API only through the web's own rewrite: prove that path before driving it.
  const proxied = await fetch(`${WEB}/api/v1/writing/title-runs/options`);
  expect(proxied.status).toBe(200);
  expect(await proxied.json()).toMatchObject({ code: "TITLE_WRITING_READY", storageReady: true });
  evidence.sameOriginRewrite = { path: "/api/v1/writing/title-runs/options", status: proxied.status, upstream: "127.0.0.1:3001" };

  browser = await chromium.launch({ headless: true, channel: "chrome" });
  // No trace and no HAR are recorded: they could hold request headers (the operator token). Screenshots only.
  context = await browser.newContext({ viewport: DESKTOP });
  page = await context.newPage();
  page.on("pageerror", (error) => { pageErrors.push(redact(error.message)); });
  page.on("request", (request) => {
    const method = request.method();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS" || !request.url().includes("/api/v1/")) return;
    pageWrites.push({ method, path: new URL(request.url()).pathname, key: request.headers()["idempotency-key"] ?? null });
  });
}, 180_000);

afterAll(async () => {
  const problems: string[] = [];
  const attempt = async (what: string, work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      problems.push(`${what}: ${redact(error instanceof Error ? error.message : String(error))}`);
    }
  };
  await attempt("browser", async () => { await context?.close(); await browser?.close(); });
  await attempt("web", () => stopChild(web?.child));
  await attempt("api", async () => { await app?.close(); });
  await attempt("pool", () => closePostgresPool(pool));
  evidence.stub = { totalSends: sent.length, perTitle: Object.fromEntries([MAIN_TITLE, CONFLICT_TITLE, UNKNOWN_TITLE].map((title) => [title, sends(title)])),
    everyEndpoint: [...new Set(sent.map((item) => item.endpoint))], everyKeyWasTheStubKey: sent.every((item) => item.keyMatches) };
  evidence.pageErrors = pageErrors;
  evidence.pageWrites = pageWrites.map((write) => ({ method: write.method, path: write.path }));
  evidence.cleanup = { browserClosed: !problems.some((item) => item.startsWith("browser")), webStopped: web?.child.exitCode !== null || web?.child.signalCode !== null,
    apiClosed: !problems.some((item) => item.startsWith("api")), problems };
  if (evidenceDir) {
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(join(evidenceDir, "title-writing-browser-acceptance.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    // Nothing secret may leave this run: every evidence file is checked for the token, the stub key and the URL.
    for (const file of await readdir(evidenceDir, { recursive: true })) {
      const path = join(evidenceDir, String(file));
      if (!String(file).endsWith(".json")) continue;
      const text = await readFile(path, "utf8");
      if (text.includes(OPERATOR_TOKEN) || text.includes(STUB_KEY) || text.includes(acceptanceUrl)) problems.push(`secret in ${String(file)}`);
    }
  }
  if (problems.length > 0) throw new Error(`browser acceptance cleanup: ${problems.join("; ")}`);
}, 60_000);

describe("title writing in a real browser, real web and API, isolated PostgreSQL, model stubbed", () => {
  it("A: start on the page, reload while running, review the story, write the scripts once, read them in the workbench", async () => {
    const gate = deferred();
    plans.set(MAIN_TITLE, (step, attempt) => step === "episode:1" && attempt === 1 ? { hold: gate.promise } : undefined);

    await page.goto(`${WEB}/create`, { waitUntil: "domcontentloaded" });
    await page.getByText("服务端已配置：千问").waitFor({ timeout: 30_000 });
    await page.locator("#ai-title").fill(MAIN_TITLE);
    await page.locator("#ai-token").fill(OPERATOR_TOKEN);
    await capture("01-start", page.getByText("服务端已配置：千问"), page.getByRole("button", { name: "AI 一键创作" }));
    const before = pageWrites.length;
    const navigated = page.waitForURL(/\/projects\/[0-9a-f-]{36}\/writing$/, { timeout: 30_000 });
    await page.getByRole("button", { name: "AI 一键创作" }).click();
    await navigated;
    const projectId = /\/projects\/([0-9a-f-]{36})\/writing$/.exec(page.url())![1]!;
    const startWrites = pageWrites.slice(before);
    expect(startWrites.map((write) => write.path)).toEqual(["/api/v1/projects", `/api/v1/projects/${projectId}/title-runs`]);

    // Running: episode 1 is held in the stub, so the page shows real progress, not a loading state.
    await waitHeadline("正在编写第 1 集");
    expect(sends(MAIN_TITLE)).toBe(3);
    const running = await latestRun(projectId);
    await capture("02-running", page.getByText("故事策划"), page.getByRole("button", { name: "停止创作" }));

    // Reload while running: the same work and run come back, and nothing is sent or written again.
    const writesBeforeReload = pageWrites.length;
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: `《${MAIN_TITLE}》` }).waitFor({ timeout: 30_000 });
    await waitHeadline("正在编写第 1 集");
    expect(page.url()).toBe(`${WEB}/projects/${projectId}/writing`);
    expect(await sendsDuring(MAIN_TITLE)).toBe(0);
    expect((await latestRun(projectId)).runId).toBe(running.runId);
    expect(pageWrites.length).toBe(writesBeforeReload);
    expect(await runRows(projectId)).toHaveLength(1);
    gate.release();

    // Story, outline and three scripts; the story is a DRAFT awaiting a person, no script is in an episode yet.
    await waitHeadline("创作完成", 60_000);
    const done = await latestRun(projectId);
    expect(done).toMatchObject({ runId: running.runId, state: "completed", storySave: "saved", callsUsed: 5 });
    expect(sends(MAIN_TITLE)).toBe(5);
    const notice = page.getByText("剧本已经生成并保存在这次创作里。按审核规则，故事通过审核后才能把剧本写入各集草稿；写入时不会覆盖已有剧本。");
    await notice.waitFor();
    expect(await scriptSummaries().filter({ hasText: "已写入剧本草稿" }).count()).toBe(0);
    expect(await storyOf(done.storyRevisionId!)).toEqual({ review_status: "DRAFT", project_current: true });
    expect(await scriptsOf(projectId)).toEqual([]);
    await capture("03-awaiting-review", notice, page.getByRole("link", { name: "查看和修改故事草稿" }));

    // The person reviews the run's own story on the existing story page.
    await approveStoryOnPage(projectId);
    expect(await storyOf(done.storyRevisionId!)).toEqual({ review_status: "APPROVED", project_current: true });

    await openRunPage(projectId);
    const place = page.getByRole("button", { name: "写入剧本草稿" });
    await place.waitFor();
    await capture("04-awaiting-placement", notice, place);
    const placeWritesBefore = pageWrites.length;
    // A double click sends one request: the page holds a single action at a time.
    await place.dblclick();
    await expect.poll(async () => await scriptSummaries().filter({ hasText: "已写入剧本草稿" }).count(), { timeout: 30_000 }).toBe(3);
    const placeWrites = pageWrites.slice(placeWritesBefore);
    expect(placeWrites.map((write) => write.path)).toEqual([`/api/v1/projects/${projectId}/title-runs/${done.runId}/scripts`]);
    await capture("05-placed", scriptSummaries().filter({ hasText: "已写入剧本草稿" }), page.getByRole("link", { name: "去修改这一集剧本" }).first());

    const placed = await latestRun(projectId);
    const scripts = await scriptsOf(projectId);
    expect(scripts.map((row) => [row.episode_no, row.review_status, row.source_story_revision_id, row.current])).toEqual(
      [1, 2, 3].map((episodeNo) => [episodeNo, "DRAFT", done.storyRevisionId, true]));
    expect(scripts.map((row) => row.id)).toEqual(placed.steps.slice(2).map((step) => step.scriptRevisionId));

    // Reload: still three, nothing new written and no button to write again.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(async () => await scriptSummaries().filter({ hasText: "已写入剧本草稿" }).count(), { timeout: 30_000 }).toBe(3);
    expect(await page.getByRole("button", { name: "写入剧本草稿" }).count()).toBe(0);
    expect(await scriptsOf(projectId)).toHaveLength(3);

    // The same three drafts in the existing editors: the workbench (from the run page link) and the beginner script step.
    const workbench: string[] = [];
    await page.getByRole("link", { name: "去修改这一集剧本" }).first().click();
    await page.waitForURL((url) => url.pathname === `/projects/${projectId}` && url.searchParams.get("focus") === "script", { timeout: 30_000 });
    await expect.poll(() => editorTexts(), { timeout: 30_000 }).toContain(scripts[0]!.text);
    workbench.push("episode 1: workbench editor shows the placed draft");
    await page.goto(`${WEB}/projects/${projectId}/create?step=script`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "第 2 步 · 看剧本" }).waitFor({ timeout: 30_000 });
    for (const row of scripts) {
      await page.getByRole("tab", { name: new RegExp(`第 ${String(row.episode_no)} 集`) }).click();
      await expect.poll(() => editorTexts(), { timeout: 30_000 }).toContain(row.text);
      workbench.push(`episode ${String(row.episode_no)}: beginner script step shows the placed draft`);
    }
    await capture("06-beginner-script", page.getByRole("heading", { name: "第 2 步 · 看剧本" }));
    expect(await scriptsOf(projectId)).toHaveLength(3);
    expect(sends(MAIN_TITLE)).toBe(5);
    expect(await runRows(projectId)).toHaveLength(1);

    flows.main = {
      projectId, runId: done.runId, storyRevisionId: done.storyRevisionId,
      scripts: scripts.map((row) => ({ episodeNo: row.episode_no, revisionId: row.id, reviewStatus: row.review_status, sourceStoryRevisionId: row.source_story_revision_id })),
      stubSends: sends(MAIN_TITLE), calls: (await callRows(done.runId)).map((row) => `${row.step_key}#${String(row.attempt_no)} ${row.state}`),
      runsForProject: 1, reloadWhileRunning: { sameRun: true, newSends: 0, newWrites: 0 },
      storyReview: "DRAFT → IN_REVIEW → APPROVED on /projects/{id}/create?step=story",
      placement: { pagePosts: placeWrites.length, scriptRevisionsAfterPlace: 3, afterReload: 3 }, readBack: workbench,
    };
  }, 240_000);

  it("B: on another work, an episode with a person's script is reported as a conflict per episode and keeps its text", async () => {
    const projectId = await startOnPage(CONFLICT_TITLE);
    await waitHeadline("创作完成", 60_000);
    const done = await latestRun(projectId);
    await approveStoryOnPage(projectId);

    // Preparation through the API, not the page: a person's script on episode 2 before the import.
    const episodes = (await apiGet<{ items: Array<{ id: string; episodeNo: number; rowVersion: number }> }>(`/projects/${projectId}/episodes`)).items;
    const second = episodes.find((item) => item.episodeNo === 2)!;
    const human = await fetch(`${API}/api/v1/projects/${projectId}/episodes/${second.id}/scripts`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": randomUUID(), "if-match": String(second.rowVersion) },
      body: JSON.stringify({ sourceStoryRevisionId: done.storyRevisionId, content: { text: "人工剧本，写入前已存在（验收准备）" } }),
    });
    expect(human.status).toBe(201);
    const humanRevisionId = (await human.json() as { revisionId: string }).revisionId;

    await openRunPage(projectId);
    const place = page.getByRole("button", { name: "写入剧本草稿" });
    await place.click();
    await expect.poll(async () => await scriptSummaries().filter({ hasText: /已写入剧本草稿|该集已有剧本，没有覆盖/ }).count(), { timeout: 30_000 }).toBe(3);
    const labels = await scriptSummaries().allTextContents();
    expect(labels.filter((text) => text.includes("第 1 集"))[0]).toContain("已写入剧本草稿");
    expect(labels.filter((text) => text.includes("第 2 集"))[0]).toContain("该集已有剧本，没有覆盖");
    expect(labels.filter((text) => text.includes("第 3 集"))[0]).toContain("已写入剧本草稿");
    expect(await page.getByText(/全部写入|全部完成/).count()).toBe(0);
    await capture("07-conflict", scriptSummaries().filter({ hasText: "该集已有剧本，没有覆盖" }));

    const scripts = await scriptsOf(projectId);
    const episode2 = scripts.filter((row) => row.episode_no === 2);
    expect(episode2).toEqual([expect.objectContaining({ id: humanRevisionId, text: "人工剧本，写入前已存在（验收准备）", current: true })]);
    expect(scripts).toHaveLength(3);
    flows.conflict = {
      projectId, runId: done.runId, perEpisode: ["saved", "conflict", "saved"], humanRevisionId, humanTextKept: true, humanStillCurrent: true,
      scriptRevisions: 3, stubSends: sends(CONFLICT_TITLE),
      byPage: ["start", "approve story (提交审核, 通过)", "写入剧本草稿"], byApi: ["the person's script on episode 2 (preparation)"],
    };
  }, 240_000);

  it("C: an unknown result is never resent on its own; resume needs the confirmation and the token; a lost answer replays once", async () => {
    plans.set(UNKNOWN_TITLE, (step, attempt) => step === "concept" && attempt === 1 ? { status: 503, body: { error: "upstream" } } : undefined);
    const projectId = await startOnPage(UNKNOWN_TITLE);
    await waitHeadline("需要处理", 60_000);
    await page.getByText("结果不确定").first().waitFor();
    const stopped = await latestRun(projectId);
    expect(stopped.steps[0]).toMatchObject({ state: "unknown", errorCode: "server_error" });
    expect(sends(UNKNOWN_TITLE)).toBe(1);

    // Refreshing and ordinary reads never resend it.
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitHeadline("需要处理");
    expect(await sendsDuring(UNKNOWN_TITLE)).toBe(0);
    const resume = page.getByRole("button", { name: "继续创作" });
    const confirm = page.getByRole("checkbox", { name: /我知道「结果不确定」的那一步可能已经产生费用/ });
    expect(await resume.isDisabled()).toBe(true);
    await capture("08-uncertain", page.getByText("结果不确定").first(), confirm);
    // A token alone is not enough while the possible charge is not confirmed.
    await page.locator("#resume-token").fill(OPERATOR_TOKEN);
    expect(await resume.isDisabled()).toBe(true);
    await confirm.check();
    expect(await resume.isEnabled()).toBe(true);

    // The first resume reaches the server unchanged; only after the server accepted it is its answer cut off.
    const resumePath = `/api/v1/projects/${projectId}/title-runs/${stopped.runId}/resume`;
    const cut: { status?: number; resumesAtCut?: number } = {};
    await page.route(`**${resumePath}`, async (route) => {
      const response = await route.fetch();
      cut.status = response.status();
      cut.resumesAtCut = (await q<{ n: number }>("SELECT count(*)::int AS n FROM title_writing_resume WHERE run_id = $1", [stopped.runId]))[0]!.n;
      await route.abort("connectionreset");
    }, { times: 1 });
    const writesBefore = pageWrites.length;
    await resume.click();
    await page.getByText("没有确认续跑是否已被受理（网络或服务异常）。再次点击会重放同一个续跑请求。").waitFor({ timeout: 30_000 });
    expect(cut).toEqual({ status: 200, resumesAtCut: 1 });
    (evidence.networkInterference as unknown[]).push({ where: `POST ${resumePath.replace(stopped.runId, "{runId}").replace(projectId, "{projectId}")}`,
      how: "passed to the server unchanged (route.fetch); after the server answered 200 and stored the resume, the answer to the browser was cut (connectionreset)",
      serverStatus: cut.status, resumeRowsAtCut: cut.resumesAtCut });
    await capture("09-resume-answer-lost", page.getByText("没有确认续跑是否已被受理（网络或服务异常）。再次点击会重放同一个续跑请求。"), resume);

    // The page replays the same request with the same key; the server applies it once.
    await resume.click();
    await waitHeadline("创作完成", 60_000);
    const resumeWrites = pageWrites.slice(writesBefore).filter((write) => write.path === resumePath);
    expect(resumeWrites).toHaveLength(2);
    expect(resumeWrites[0]!.key).toBeTruthy();
    expect(resumeWrites[1]!.key).toBe(resumeWrites[0]!.key);
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM title_writing_resume WHERE run_id = $1", [stopped.runId]))[0]!.n).toBe(1);
    const calls = await callRows(stopped.runId);
    expect(calls.map((row) => `${row.step_key}#${String(row.attempt_no)} ${row.state}`)).toEqual(
      ["concept#1 unknown", "concept#2 completed", "outline#1 completed", "episode:1#1 completed", "episode:2#1 completed", "episode:3#1 completed"]);
    expect(sends(UNKNOWN_TITLE)).toBe(6);
    await capture("10-resumed", page.getByText("剧本已经生成并保存在这次创作里。", { exact: false }));

    // Neither the page's storage nor its cookies hold the operator token or the provider key.
    const stored = await page.evaluate(() => JSON.stringify({ local: { ...window.localStorage }, session: { ...window.sessionStorage }, cookie: document.cookie }));
    const cookies = JSON.stringify(await context!.cookies());
    expect(stored.includes(OPERATOR_TOKEN) || stored.includes(STUB_KEY)).toBe(false);
    expect(cookies.includes(OPERATOR_TOKEN) || cookies.includes(STUB_KEY)).toBe(false);
    flows.uncertain = {
      projectId, runId: stopped.runId, firstAttempt: "concept#1 → stub 503 → unknown/server_error, run needs_attention",
      sendsAfterReloadAndReads: 1, resumeDisabledWithoutConfirmation: true, resumeRequests: 2, sameIdempotencyKey: true, resumeRows: 1,
      calls: calls.map((row) => `${row.step_key}#${String(row.attempt_no)} ${row.state}`), stubSends: sends(UNKNOWN_TITLE),
      tokenOrKeyInBrowserStorage: false,
    };
  }, 240_000);

  it("no page error was raised and every model request went to the stub with the stub key", () => {
    expect(pageErrors).toEqual([]);
    expect(sent.every((item) => item.keyMatches)).toBe(true);
    expect(new Set(sent.map((item) => item.endpoint))).toEqual(new Set(["dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"]));
  });
});
