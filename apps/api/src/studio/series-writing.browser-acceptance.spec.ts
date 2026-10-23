/// <reference lib="dom" />
/**
 * Series writing in a real browser with the site login on. Chrome drives the built Next app, which reaches the real
 * Nest API through its same-origin /api/v1 rewrite; the API runs on a new, empty, disposable PostgreSQL database with the
 * test site's migration combination plus the guarded automatic creation and series writing migrations. NOT part of
 * `test` or `integration`:
 *   pnpm build && pnpm --filter @ai-drama/api series-writing:browser-acceptance
 * with the title writing acceptance guard variables. What is not real: the model. The series service the controller uses
 * is built here with the series double as its transport (DeepSeek wire format); it never opens a network connection.
 * DOM and layout checks are asserted here; the screenshots it saves are for a separate visual review.
 */
import "reflect-metadata";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { type Browser, type BrowserContext, type Locator, type Page, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seriesScopeCalls } from "@ai-drama/contracts";
import type { SeriesView } from "@ai-drama/domain";
import {
  AUTO_CREATION_MIGRATION,
  BASE_MIGRATIONS,
  GUARDED_SINGLE_MIGRATIONS,
  PostgresSeriesWritingStore,
  SCRIPT_BREAKDOWN_MIGRATION,
  SERIES_WRITING_MIGRATION,
  TextChainService,
  WRITING_CANDIDATE_DEEPSEEK_MIGRATION,
  WRITING_CANDIDATE_MIGRATION,
  WRITING_PROVIDER_MIGRATION,
  checkTitleWritingAcceptanceEnv,
  closePostgresPool,
  createPostgresPool,
  runMigrations,
  verifyTitleWritingAcceptanceDatabase,
} from "@ai-drama/database";
import { SeriesWritingEngine, titleWritingProviderConfigs } from "@ai-drama/providers";
import { seriesFixtureTransport, type SeriesFixtureExchange, type SeriesFixturePlan } from "@ai-drama/providers/title-writing-fixtures";
import { AppModule } from "../app.module";
import { hashPassword } from "../auth/password-hash";
import { loadApiEnv } from "../config/env";
import { SafeExceptionFilter } from "../http/safe-exception.filter";
import { SeriesWritingService } from "./series-writing.service";
import type { StudioRuntime } from "./studio.runtime";
import { SERIES_WRITING_SERVICE, STUDIO_RUNTIME } from "./tokens";

const decision = checkTitleWritingAcceptanceEnv(process.env);
if (!decision.ok) throw new Error(`Series writing browser acceptance refused: ${decision.reason}`);
const acceptanceUrl = decision.url;

const ROOT = join(__dirname, "..", "..", "..", "..");
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const API_PORT = 3001;
const WEB_PORT = 3010;
const WEB = `http://127.0.0.1:${String(WEB_PORT)}`;
const API = `http://127.0.0.1:${String(API_PORT)}`;
const PASSWORD = `acceptance-${randomUUID()}`;
const DEEPSEEK_STUB_KEY = `stub-deepseek-not-a-provider-key-${randomUUID()}`;
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

const pool = createPostgresPool({ connectionString: acceptanceUrl, connectionTimeoutMs: 2_000, statementTimeoutMs: 10_000, queryTimeoutMs: 10_000 });
async function q<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> {
  return (await pool.query(sql, values) as { rows: T[] }).rows;
}
const textChain = new TextChainService(pool);
const evidenceDir = process.env.TITLE_WRITING_ACCEPTANCE_EVIDENCE_DIR;
const shotsDir = evidenceDir ? join(evidenceDir, "series-writing-screenshots") : null;
const evidence: Record<string, unknown> = { screenshots: [] as string[], layout: [] as unknown[], flows: {} as Record<string, unknown>, paidCalls: 0 };

let plan: SeriesFixturePlan = {};
const seen: SeriesFixtureExchange[] = [];
const transport = seriesFixtureTransport({ seen, plan: () => plan });
const providers = titleWritingProviderConfigs({ DEEPSEEK_API_KEY: DEEPSEEK_STUB_KEY });

function seriesService(runtime: StudioRuntime): SeriesWritingService {
  const store = new PostgresSeriesWritingStore(runtime.pool, new TextChainService(runtime.pool));
  return new SeriesWritingService({
    workspaceId: WORKSPACE, enabled: true, operatorToken: null, siteOperator: true, defaultProvider: "deepseek", providers, store,
    engine: new SeriesWritingEngine({ workspaceId: WORKSPACE, store, providers, transport, maxCallsPerDay: 500, maxActiveRuns: 2, timeoutMs: 30_000 }),
    projects: runtime.store, maxCallsPerDay: 500, maxActiveRuns: 2, research: { fetchEnabled: false, allowedHosts: [] },
  });
}

let app: INestApplication | undefined;
let web: { child: ChildProcess; logs: () => string } | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page;
const pageErrors: string[] = [];

async function bootApi(): Promise<INestApplication> {
  const env = loadApiEnv({
    NODE_ENV: "test", DATABASE_URL: acceptanceUrl, REDIS_URL: "redis://127.0.0.1:6399", S3_ENDPOINT: "http://127.0.0.1:59000", S3_REGION: "us-east-1",
    S3_BUCKET: "ai-drama-dev", S3_ACCESS_KEY_ID: "test", S3_SECRET_ACCESS_KEY: "test", APP_WORKSPACE_ID: WORKSPACE,
    SITE_AUTH_ENABLED: "true", SITE_AUTH_USERNAME: "admin",
    SITE_AUTH_PASSWORD_HASH: await hashPassword(PASSWORD, { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 }), SITE_AUTH_PUBLIC_ORIGIN: WEB,
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(env)] })
    .overrideProvider(SERIES_WRITING_SERVICE).useFactory({ inject: [STUDIO_RUNTIME], factory: (runtime: StudioRuntime) => seriesService(runtime) })
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

async function waitFor(what: string, check: () => Promise<boolean>, ms = 90_000): Promise<void> {
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

/** At 1280×800 and 390×844: no horizontal overflow, the primary action inside the viewport and not covered; full-page screenshots. */
async function viewports(name: string, ready: Locator, primary?: Locator): Promise<void> {
  for (const [label, size] of [["1280", DESKTOP], ["390", PHONE]] as const) {
    await page.setViewportSize(size);
    await ready.first().waitFor({ state: "visible", timeout: 20_000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${name} ${label}: horizontal overflow`).toBeLessThanOrEqual(0);
    let primaryInView: boolean | null = null;
    if (primary) {
      await primary.scrollIntoViewIfNeeded();
      const box = await primary.boundingBox();
      expect(box, `${name} ${label}: primary action has no box`).not.toBeNull();
      primaryInView = box!.x >= -1 && box!.x + box!.width <= size.width + 1;
      expect(primaryInView, `${name} ${label}: primary action outside the viewport`).toBe(true);
    }
    (evidence.layout as unknown[]).push({ name, viewport: label, overflow, primaryInView });
    if (shotsDir) {
      const file = `${name}-${label}.png`;
      await page.screenshot({ path: join(shotsDir, file), fullPage: true });
      (evidence.screenshots as string[]).push(file);
      // A focused shot of the area under review, as wide as the viewport.
      const area = `${name}-${label}-area.png`;
      await ready.first().screenshot({ path: join(shotsDir, area) });
      (evidence.screenshots as string[]).push(area);
    }
  }
  await page.setViewportSize(DESKTOP);
}

async function login(returnTo: string): Promise<void> {
  await page.goto(`${WEB}${returnTo}`, { waitUntil: "domcontentloaded" });
  await page.waitForURL(/\/login\?returnTo=/, { timeout: 30_000 });
  await page.getByLabel("账号").fill("admin");
  await page.getByLabel("密码").fill(PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL(`${WEB}${returnTo}`, { timeout: 30_000 });
}

/** A person's review through the text chain's own transitions: DRAFT → IN_REVIEW → APPROVED of the current story. */
async function approveCurrentStory(projectId: string): Promise<string> {
  const readStory = async () => (await q<{ id: string; review_version: number }>(
    "SELECT sr.id, sr.review_version FROM story_revision sr JOIN project p ON p.current_story_revision_id = sr.id WHERE p.id = $1", [projectId]))[0]!;
  const readVersion = async () => (await q<{ version: number }>("SELECT version FROM project WHERE id = $1", [projectId]))[0]!.version;
  let story = await readStory();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await textChain.transitionReviewInTransaction(client, { table: "story_revision", revisionId: story.id, workspaceId: WORKSPACE,
      expectedVersion: await readVersion(), expectedReviewVersion: story.review_version, to: "IN_REVIEW", reviewNote: null, traceId: "acceptance" });
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  story = await readStory();
  await textChain.approveStory({ workspaceId: WORKSPACE, projectId, revisionId: story.id, expectedVersion: await readVersion(),
    expectedReviewVersion: story.review_version, reviewedBy: "acceptance-person" });
  return story.id;
}

const completion = () => page.getByTestId("series-completion");

async function createFromStart(title: string, episodes: number): Promise<string> {
  await page.goto(`${WEB}/create`, { waitUntil: "domcontentloaded" });
  const card = page.getByTestId("series-start");
  await card.waitFor({ timeout: 30_000 });
  await card.getByTestId("series-start-open").click();
  await card.getByLabel("系列作品名称").fill(title);
  await card.getByLabel(/^总集数/).fill(String(episodes));
  const navigated = page.waitForURL(/\/projects\/[0-9a-f-]{36}\/series$/, { timeout: 30_000 });
  await card.getByRole("button", { name: "创建系列作品" }).click();
  await navigated;
  return /\/projects\/([0-9a-f-]{36})\/series$/.exec(page.url())![1]!;
}

async function authorize(preset: string, lastBatch?: number): Promise<void> {
  const card = page.getByTestId("series-card");
  await card.waitFor({ timeout: 30_000 });
  await page.getByTestId("series-preset").selectOption(preset);
  if (lastBatch !== undefined) await card.getByLabel("写到第几批").selectOption(String(lastBatch));
  await page.getByTestId("series-confirm").check();
  const answered = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/series/grants"), { timeout: 30_000 });
  await page.getByTestId("series-grant").click();
  expect((await answered).status()).toBe(201);
}

beforeAll(async () => {
  const verified = await verifyTitleWritingAcceptanceDatabase({ query: async (sql, values) => ({ rows: await q(sql, values) }) }, decision.databaseName);
  if (!verified.ok) {
    await closePostgresPool(pool);
    throw new Error(`Series writing browser acceptance refused: ${verified.reason}`);
  }
  expect((await runMigrations(pool, undefined, { before: SCRIPT_BREAKDOWN_MIGRATION })).applied).toEqual([...BASE_MIGRATIONS]);
  for (const name of [WRITING_PROVIDER_MIGRATION, WRITING_CANDIDATE_MIGRATION, WRITING_CANDIDATE_DEEPSEEK_MIGRATION, AUTO_CREATION_MIGRATION, SERIES_WRITING_MIGRATION]) {
    expect((await runMigrations(pool, undefined, { only: { name, requires: GUARDED_SINGLE_MIGRATIONS[name]! } })).applied).toEqual([name]);
  }
  evidence.migrationsApplied = (await q<{ name: string }>("SELECT name FROM schema_migration ORDER BY name")).map((row) => row.name);
  await q("INSERT INTO workspace (id, name, status) VALUES ($1, 'series-writing-browser-acceptance', 'ACTIVE')", [WORKSPACE]);
  if (shotsDir) await mkdir(shotsDir, { recursive: true });
  app = await bootApi();
  web = startWeb();
  await waitFor("the API", async () => (await fetch(`${API}/api/v1/health/live`)).ok);
  await waitFor("the web app", async () => (await fetch(`${WEB}/login`)).ok);
  // Anonymous: a paid grant is refused before anything is written.
  const anonymous = await fetch(`${WEB}/api/v1/projects/${randomUUID()}/series/grants`, { method: "POST", headers: { origin: WEB, "content-type": "application/json" }, body: "{}" });
  expect(anonymous.status).toBe(401);
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  context = await browser.newContext({ viewport: DESKTOP, acceptDownloads: true });
  page = await context.newPage();
  page.on("pageerror", (error) => { pageErrors.push(error.message); });
}, 240_000);

afterAll(async () => {
  await context?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await stopChild(web?.child);
  await app?.close().catch(() => undefined);
  await closePostgresPool(pool).catch(() => undefined);
  evidence.stub = { totalSends: seen.length, endpoints: [...new Set(seen.map((item) => item.url))] };
  evidence.pageErrors = pageErrors;
  if (evidenceDir) {
    await mkdir(evidenceDir, { recursive: true });
    const text = JSON.stringify(evidence, null, 2);
    if (text.includes(PASSWORD) || text.includes(DEEPSEEK_STUB_KEY) || text.includes(acceptanceUrl)) throw new Error("secret in evidence");
    await writeFile(join(evidenceDir, "series-writing-browser-acceptance.json"), `${text}\n`, "utf8");
  }
}, 60_000);

let sixty = "";
/** The 3-episode work S7 completes (final review recorded by a person): S9 replaces its story. */
let finished = "";

describe("series writing in a real browser (site login, built web, real API, isolated PostgreSQL, model stubbed)", () => {
  it("S1: a 60-episode work from the start page; the plan and episodes 1–3 stop at 3/60 in 19 calls; refresh shows the same", async () => {
    plan = {};
    await login("/create");
    const card = page.getByTestId("series-start");
    await card.waitFor({ timeout: 30_000 });
    // The other ways to start stay on the page.
    await page.getByTestId("auto-creation-start").waitFor({ timeout: 30_000 });
    await card.getByTestId("series-start-open").click();
    await expect.poll(async () => await card.getByTestId("series-start-calls").textContent(), { timeout: 30_000 }).toContain("全部正文及检查 96 次");
    expect(await card.getByTestId("series-start-calls").textContent()).toContain("规划加前 3 集正文及该批审阅 19 次");
    await viewports("01-series-start", card, card.getByRole("button", { name: "创建系列作品" }));
    sixty = await createFromStart("六十集替身样例", 60);
    expect(seen).toHaveLength(0);
    await page.getByTestId("series-card").waitFor({ timeout: 30_000 });
    expect(await page.getByTestId("series-card-summary").textContent()).toContain("正常调用 19 次");
    await viewports("02-series-card", page.getByTestId("series-card"), page.getByTestId("series-grant"));
    await authorize("plan_first");
    await expect.poll(async () => await completion().textContent(), { timeout: 120_000, interval: 500 }).toContain("已完成 3/60 集");
    expect(seen).toHaveLength(19);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(async () => await completion().textContent(), { timeout: 30_000 }).toContain("已完成 3/60 集");
    expect(await page.locator("[data-testid^=series-episode-]").count()).toBe(60);
    expect(await page.locator("[data-testid^=series-batch-]").count()).toBe(20);
    expect(await page.getByTestId("series-calls-used").textContent()).toContain("已用调用：19 次");
    expect(await page.getByTestId("series-budget").textContent()).toContain("全剧 96 次");
    expect(await page.getByTestId("series-episode-3").textContent()).toContain("已写");
    expect(await page.getByTestId("series-episode-4").textContent()).toContain("待写");
    expect(await page.getByTestId("series-plan-status").textContent()).toContain("规划审阅通过");
    await viewports("03-series-status", page.getByTestId("series-status"));
    await viewports("04-series-plan-characters", page.getByTestId("series-plan"));
    await viewports("05-series-episodes", page.getByTestId("series-episodes"));
    await viewports("06-series-batches", page.getByTestId("series-batches"));
    expect(await q<{ n: number }>("SELECT count(*)::int AS n FROM series_writing_call WHERE billing_status = 'unknown'")).toEqual([{ n: 19 }]);
    (evidence.flows as Record<string, unknown>).S1 = { project: sixty, sends: seen.length };
  }, 300_000);

  it("S2: continuing with episodes 4–6 sends only those and their review; nothing is planned again", async () => {
    const before = seen.length;
    await page.goto(`${WEB}/projects/${sixty}/series`, { waitUntil: "domcontentloaded" });
    await authorize("continue", 2);
    await expect.poll(async () => await completion().textContent(), { timeout: 120_000, interval: 500 }).toContain("已完成 6/60 集");
    expect(seen.slice(before).map((item) => item.stage)).toEqual(["episode:4", "episode:5", "episode:6", "batch_review:2"]);
    expect(await page.getByTestId("series-batch-2").textContent()).toContain("机器检查通过");
    (evidence.flows as Record<string, unknown>).S2 = { sends: seen.length - before };
  }, 300_000);

  it("S3: a person approves the story, the batch is placed as DRAFT scripts, an edit stops the series until the ledger and review are confirmed", async () => {
    const storyId = await approveCurrentStory(sixty);
    await page.goto(`${WEB}/projects/${sixty}/series`, { waitUntil: "domcontentloaded" });
    const batch1 = page.getByTestId("series-batch-1");
    await batch1.waitFor({ timeout: 30_000 });
    const placed = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/series/batches/1/scripts"), { timeout: 30_000 });
    await batch1.getByRole("button", { name: "写入正式分集" }).click();
    expect((await placed).status()).toBe(200);
    await expect.poll(async () => await batch1.textContent(), { timeout: 30_000 }).toContain("3/3");
    expect(await q<{ n: number }>("SELECT count(*)::int AS n FROM script_revision WHERE project_id = $1 AND review_status = 'DRAFT'", [sixty])).toEqual([{ n: 3 }]);
    // A person edits episode 2 in the workbench's script editor.
    const episode2 = (await q<{ id: string; row_version: number }>("SELECT id, row_version FROM episode WHERE project_id = $1 AND episode_no = 2", [sixty]))[0]!;
    await textChain.createScriptRevision({ workspaceId: WORKSPACE, projectId: sixty, episodeId: episode2.id, sourceStoryRevisionId: storyId,
      content: { text: "人工修改后的第 2 集全文" }, createdBy: "acceptance-person", expectedVersion: episode2.row_version });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(async () => await batch1.textContent(), { timeout: 30_000 }).toContain("待确认");
    expect(await page.getByTestId("series-episode-2").textContent()).toContain("工作台人工修改稿");
    await page.getByTestId("series-preset").selectOption("continue");
    await page.getByTestId("series-blockers").waitFor({ timeout: 20_000 });
    expect(await page.getByTestId("series-blockers").textContent()).toContain("连续性台账待确认");
    await viewports("07-series-pending-ledger", page.getByTestId("series-batches"));
    // Confirm the ledger: the editor opens prefilled; saving calls no model.
    const sends = seen.length;
    await batch1.getByRole("button", { name: "确认台账" }).click();
    await page.getByTestId("series-ledger-editor").waitFor({ timeout: 20_000 });
    await viewports("08-series-ledger-editor", page.getByTestId("series-ledger-editor"));
    const saved = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/series/ledger-revisions"), { timeout: 30_000 });
    await page.getByRole("button", { name: "保存并确认台账" }).click();
    expect((await saved).status()).toBe(201);
    await expect.poll(async () => await batch1.textContent(), { timeout: 30_000 }).toContain("有效（人工确认）");
    // The confirmed ledger kept the same content, so batch 2 (built on that content) stays valid; the person then records
    // the review of batch 1, whose episode 2 changed after its review.
    const batch2 = page.getByTestId("series-batch-2");
    expect(await batch2.textContent()).toContain("有效（程序台账）");
    await page.getByTestId("series-note").fill("已人工复核第 2 集的修改");
    const decided = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/series/decisions"), { timeout: 30_000 });
    await batch1.getByRole("button", { name: "记录人工复核" }).click();
    expect((await decided).status()).toBe(201);
    await expect.poll(async () => await batch1.textContent(), { timeout: 30_000 }).toContain("已人工复核");
    expect(seen.length).toBe(sends);
    expect(await q<{ n: number }>("SELECT count(*)::int AS n FROM script_revision WHERE episode_id = $1", [episode2.id])).toEqual([{ n: 2 }]);
    (evidence.flows as Record<string, unknown>).S3 = { storyId, sendsDuringEdits: seen.length - sends };
  }, 300_000);

  it("S4: the current package carries the person's edit, is the same on a second read, and the page offers both downloads", async () => {
    await page.goto(`${WEB}/projects/${sixty}/series`, { waitUntil: "domcontentloaded" });
    const download = page.getByTestId("series-download");
    await download.waitFor({ timeout: 30_000 });
    await viewports("09-series-download", download, page.getByTestId("series-download-markdown"));
    const [markdown] = await Promise.all([page.waitForEvent("download"), page.getByTestId("series-download-markdown").click()]);
    const markdownPath = join(shotsDir ?? ROOT, "series-package.md");
    await markdown.saveAs(markdownPath);
    const text = await readFile(markdownPath, "utf8");
    expect(text).toContain("当前编剧交付包");
    expect(text).toContain("人工修改后的第 2 集全文");
    const first = await (await page.request.get(`${WEB}/api/v1/projects/${sixty}/series/package?format=json`)).json() as { completion: { label: string }; episodes: Array<{ current: { source: string } | null }> };
    expect(first.episodes[1]!.current!.source).toBe("workbench_manual_revision");
    expect(first.completion.label).toContain("已完成 6/60 集");
    const second = await (await page.request.get(`${WEB}/api/v1/projects/${sixty}/series/package?format=json`)).json() as typeof first;
    expect({ ...second, generatedAt: null }).toEqual({ ...first, generatedAt: null });
  }, 120_000);

  it("S4b: the work's own workbench opens for a 60-episode series work (the approved story and its 60 episodes) without errors", async () => {
    await page.goto(`${WEB}/projects/${sixty}/create`, { waitUntil: "domcontentloaded" });
    const main = page.locator("main").first();
    await main.waitFor({ timeout: 30_000 });
    await page.waitForLoadState("networkidle");
    expect(await q<{ n: number }>("SELECT count(*)::int AS n FROM episode WHERE project_id = $1", [sixty])).toEqual([{ n: 60 }]);
    // Every one of the 60 episodes can be opened for review and editing (not the short-drama 1–6).
    await page.getByRole("tab", { name: /第 60 集/ }).first().waitFor({ timeout: 30_000 });
    await viewports("12-series-workbench", main);
    expect(pageErrors).toEqual([]);
  }, 120_000);

  it("S5: an injected contradiction is shown as a blocking finding and the grant stops; no pass is shown", async () => {
    plan = { propContradiction: 5 };
    const project = await createFromStart("矛盾注入替身样例", 9);
    await authorize("plan_first");
    await expect.poll(async () => await completion().textContent(), { timeout: 120_000, interval: 500 }).toContain("已完成 3/9 集");
    await authorize("continue", 3);
    await expect.poll(async () => await page.getByTestId("series-batch-2").textContent(), { timeout: 120_000, interval: 500 }).toContain("待修改");
    plan = {};
    expect(await page.getByTestId("series-batch-3").textContent()).toContain("0/3");
    expect(await page.getByTestId("series-diagnostics").textContent()).toContain("道具 P2");
    expect(await page.getByTestId("series-grants").textContent()).toContain("批次全文审阅发现必须修改的问题");
    await viewports("10-series-diagnostics", page.getByTestId("series-diagnostics"));
    await viewports("11-series-grants-stopped", page.getByTestId("series-budget"));
    (evidence.flows as Record<string, unknown>).S5 = { project };
    expect(pageErrors).toEqual([]);
  }, 300_000);

  it("S6: a story saved in the workbench stops the series; the page offers binding plan and story again, and the plan review that follows", async () => {
    plan = {};
    const project = await createFromStart("故事同步替身样例", 6);
    await authorize("plan_first");
    await expect.poll(async () => await completion().textContent(), { timeout: 120_000, interval: 500 }).toContain("已完成 3/6 集");
    const version = (await q<{ version: number }>("SELECT version FROM project WHERE id = $1", [project]))[0]!.version;
    const replaced = await textChain.createStoryRevision({ workspaceId: WORKSPACE, projectId: project, content: { text: "工作台人工另存的故事" },
      createdBy: "acceptance-person", expectedVersion: version });
    await page.reload({ waitUntil: "domcontentloaded" });
    const sync = page.getByTestId("series-story-sync");
    await sync.waitFor({ timeout: 30_000 });
    await page.getByTestId("series-preset").selectOption("continue");
    await expect.poll(async () => await page.getByTestId("series-blockers").textContent(), { timeout: 20_000 }).toContain("工作台的故事已另存");
    await viewports("13-series-story-sync", page.getByTestId("series-plan"), sync.getByRole("button", { name: "以工作台当前故事为准" }));
    const sends = seen.length;
    const saved = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/series/plan-revisions"), { timeout: 30_000 });
    await sync.getByRole("button", { name: "以工作台当前故事为准" }).click();
    expect((await saved).status()).toBe(201);
    await expect.poll(async () => await page.getByTestId("series-plan-status").textContent(), { timeout: 30_000 }).toContain("人工修改，待复核");
    expect(await page.getByTestId("series-story-sync").count()).toBe(0);
    expect((await q<{ story_revision_id: string }>("SELECT story_revision_id FROM series_writing_plan_revision WHERE revision_no = 2 AND series_id = (SELECT id FROM series_writing_series WHERE project_id = $1)",
      [project]))[0]!.story_revision_id).toBe(replaced.revisionId);
    await page.getByTestId("series-note").fill("采用工作台故事，已复核规划");
    const decided = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/series/decisions"), { timeout: 30_000 });
    await page.getByRole("button", { name: "记录规划人工复核" }).click();
    expect((await decided).status()).toBe(201);
    await expect.poll(async () => await page.getByTestId("series-plan-status").textContent(), { timeout: 30_000 }).toContain("已人工复核");
    expect(seen.length).toBe(sends);
    (evidence.flows as Record<string, unknown>).S6 = { project, adoptedStory: replaced.revisionId };
    expect(pageErrors).toEqual([]);
  }, 300_000);

  it("S7: the final review shows its findings and scope; a review from a page that saw an older ledger is refused with the note kept; on the current versions it is recorded", async () => {
    plan = {};
    const project = await createFromStart("总检复核替身样例", 3);
    finished = project;
    await authorize("plan_first");
    await expect.poll(async () => await completion().textContent(), { timeout: 120_000, interval: 500 }).toContain("已完成 3/3 集");
    await authorize("final");
    await expect.poll(async () => await page.getByTestId("series-final").textContent(), { timeout: 120_000, interval: 500 }).toContain("机器检查通过");
    // Another page changes the last ledger: the final review read an older one.
    const changeLedger = async (state: string) => {
      const view = (await (await page.request.get(`${WEB}/api/v1/projects/${project}/series`)).json() as { series: SeriesView }).series;
      const ledger = view.batches[0]!.ledger.revision!;
      const content = { ...ledger.content, props: ledger.content.props.map((item) => ({ ...item, state })) };
      // Another page of the same signed-in person: the session's CSRF token, as the page's own writes carry it.
      const csrf = (await context!.cookies()).find((cookie) => cookie.name.endsWith("ads_csrf"))?.value ?? "";
      const response = await page.request.post(`${WEB}/api/v1/projects/${project}/series/ledger-revisions`, { headers: { origin: WEB, "X-CSRF-Token": csrf },
        data: { batchNo: 1, baseLedgerRevisionId: ledger.id, content, summaries: view.episodes.map((item) => ({ episodeNo: item.episodeNo, summary: "另一页面确认" })),
          expectedBasis: view.batches[0]!.ledgerBasis } });
      expect(response.status()).toBe(201);
    };
    await changeLedger("另一页面改过");
    await page.reload({ waitUntil: "domcontentloaded" });
    const section = page.getByTestId("series-final-review");
    await expect.poll(async () => await section.textContent(), { timeout: 30_000 }).toContain("原结论只对旧版本有效");
    expect(await section.textContent()).toContain("不逐字读取各集正文");
    await viewports("14-series-final-review", section, page.getByTestId("series-final-decide"));
    await page.getByTestId("series-final-note").fill("已人工核对总检");
    await changeLedger("又一次改过");
    const refused = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/series/decisions"), { timeout: 30_000 });
    await page.getByTestId("series-final-decide").click();
    expect((await refused).status()).toBe(409);
    await expect.poll(async () => await page.getByTestId("series-error").textContent(), { timeout: 30_000 }).toContain("你复核的版本已不是当前版本");
    expect(await page.getByTestId("series-final-note").inputValue()).toBe("已人工核对总检");
    expect(await q<{ n: number }>("SELECT count(*)::int AS n FROM series_writing_decision WHERE series_id = (SELECT id FROM series_writing_series WHERE project_id = $1)",
      [project])).toEqual([{ n: 0 }]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("series-final-note").fill("按最新台账核对总检");
    const decided = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/series/decisions"), { timeout: 30_000 });
    await page.getByTestId("series-final-decide").click();
    expect((await decided).status()).toBe(201);
    await expect.poll(async () => await page.getByTestId("series-final").textContent(), { timeout: 30_000 }).toContain("已人工复核");
    // A person's final review approves nothing: the story and scripts keep their own review state.
    expect(await completion().textContent()).not.toContain("审定完成");
    (evidence.flows as Record<string, unknown>).S7 = { project };
    expect(pageErrors).toEqual([]);
  }, 300_000);

  it("S8: a pending grant after a refresh shows only its frozen request, keeps its frozen service when that is gone, and retries the same body and key", async () => {
    await page.goto(`${WEB}/projects/${sixty}/series`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("series-card").waitFor({ timeout: 30_000 });
    const view = (await (await page.request.get(`${WEB}/api/v1/projects/${sixty}/series`)).json() as { series: SeriesView }).series;
    const scope = { plan: false, batchFrom: 3, batchTo: 20, final: true };
    const normal = seriesScopeCalls(60, scope);
    const frozen = { scope, normalCalls: normal, resendAllowance: 1, callBudget: normal + 1, providerKey: "openai", model: "gpt-frozen", basePlanRevisionId: view.plan!.revisionId };
    await page.evaluate(([projectId, body]) => {
      window.sessionStorage.setItem(`series-writing:grant:${projectId}`, JSON.stringify({ version: 1, scope: `grant:${projectId}`, key: "frozen-grant-key", body }));
    }, [sixty, frozen] as const);
    await page.reload({ waitUntil: "domcontentloaded" });
    const card = page.getByTestId("series-card");
    await page.getByTestId("series-card-config-changed").waitFor({ timeout: 30_000 });
    expect(await page.getByTestId("series-card-frozen").textContent()).toContain("第 7–60 集正文及逐批审阅 + 全剧结构与连续性总检");
    expect(await page.getByTestId("series-card-frozen").textContent()).toContain("gpt-frozen");
    expect(await page.getByTestId("series-card-summary").textContent()).toContain(`预算 ${String(normal + 1)} 次`);
    expect(await card.getByTestId("series-preset").count()).toBe(0);
    await viewports("15-series-frozen-card", card, page.getByTestId("series-grant"));
    const sends = seen.length;
    const posted = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith("/series/grants"), { timeout: 30_000 });
    await page.getByTestId("series-grant").click();
    const request = await posted;
    expect(request.postDataJSON()).toEqual(frozen);
    expect(request.headers()["idempotency-key"]).toBe("frozen-grant-key");
    await page.getByTestId("series-error").waitFor({ timeout: 30_000 });
    expect(seen.length).toBe(sends);
    expect(await q<{ n: number }>("SELECT count(*)::int AS n FROM series_writing_grant WHERE idempotency_key = 'frozen-grant-key'")).toEqual([{ n: 0 }]);
    await page.getByRole("button", { name: "放弃这次请求" }).click();
    await page.getByTestId("series-preset").waitFor({ timeout: 20_000 });
    expect(await page.getByTestId("series-card-config-changed").count()).toBe(0);
    (evidence.flows as Record<string, unknown>).S8 = { frozenKeyReplayed: true };
    expect(pageErrors).toEqual([]);
  }, 120_000);

  it("S9: a story saved after the series was complete revokes the completion on the page and in both packages; the old final pass is shown as no longer valid", async () => {
    await page.goto(`${WEB}/projects/${finished}/series`, { waitUntil: "domcontentloaded" });
    await expect.poll(async () => await completion().textContent(), { timeout: 30_000 }).toContain("全剧文本完成");
    const version = (await q<{ version: number }>("SELECT version FROM project WHERE id = $1", [finished]))[0]!.version;
    await textChain.createStoryRevision({ workspaceId: WORKSPACE, projectId: finished, content: { text: "完成后工作台另存的故事" }, createdBy: "acceptance-person",
      expectedVersion: version });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(async () => await completion().textContent(), { timeout: 30_000 }).toContain("待同步");
    expect(await completion().textContent()).not.toContain("全剧文本完成");
    expect(await page.getByTestId("series-attention").textContent()).toContain("工作台的故事已另存");
    const section = page.getByTestId("series-final-review");
    expect(await section.textContent()).toContain("旧版本曾通过总检，不代表当前依赖有效");
    expect(await page.getByTestId("series-final-decide").count()).toBe(0);
    await viewports("16-series-story-after-complete", page.getByTestId("series-status"));
    await viewports("16b-series-final-after-story", section);
    const json = await (await page.request.get(`${WEB}/api/v1/projects/${finished}/series/package?format=json`)).json() as { completion: { level: string; attention: string[] } };
    expect(json.completion.level).toBe("partial");
    expect(json.completion.attention).toContain("story_changed");
    const markdown = await (await page.request.get(`${WEB}/api/v1/projects/${finished}/series/package?format=markdown`)).text();
    expect(markdown).toContain("待办：story_changed");
    (evidence.flows as Record<string, unknown>).S9 = { project: finished };
    expect(pageErrors).toEqual([]);
  }, 120_000);

  it("S10: a ledger editor opened before another page confirmed the ledger is refused on save, keeping the person's text", async () => {
    await page.goto(`${WEB}/projects/${finished}/series`, { waitUntil: "domcontentloaded" });
    const sync = page.getByTestId("series-story-sync");
    await sync.waitFor({ timeout: 30_000 });
    const adopted = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/series/plan-revisions"), { timeout: 30_000 });
    await sync.getByRole("button", { name: "以工作台当前故事为准" }).click();
    expect((await adopted).status()).toBe(201);
    const batch1 = page.getByTestId("series-batch-1");
    await expect.poll(async () => await batch1.textContent(), { timeout: 30_000 }).toContain("需重新确认");
    await batch1.getByRole("button", { name: "确认台账" }).click();
    const editor = page.getByTestId("series-ledger-editor");
    await editor.waitFor({ timeout: 20_000 });
    const text = (await page.getByLabel("台账 JSON").inputValue()).replace(/"summary": "[^"]*"/, '"summary": "A 页面写的概要"');
    await page.getByLabel("台账 JSON").fill(text);
    // Another page confirms the same ledger first.
    const view = (await (await page.request.get(`${WEB}/api/v1/projects/${finished}/series`)).json() as { series: SeriesView }).series;
    const csrf = (await context!.cookies()).find((cookie) => cookie.name.endsWith("ads_csrf"))?.value ?? "";
    const other = await page.request.post(`${WEB}/api/v1/projects/${finished}/series/ledger-revisions`, { headers: { origin: WEB, "X-CSRF-Token": csrf },
      data: { batchNo: 1, baseLedgerRevisionId: view.batches[0]!.ledger.revision!.id, content: view.batches[0]!.ledger.revision!.content,
        summaries: view.episodes.map((item) => ({ episodeNo: item.episodeNo, summary: "另一页面确认" })), expectedBasis: view.batches[0]!.ledgerBasis } });
    expect(other.status()).toBe(201);
    const ledgers = await q<{ n: number }>("SELECT count(*)::int AS n FROM series_writing_ledger_revision WHERE series_id = (SELECT id FROM series_writing_series WHERE project_id = $1)", [finished]);
    const refused = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/series/ledger-revisions"), { timeout: 30_000 });
    await page.getByRole("button", { name: "保存并确认台账" }).click();
    expect((await refused).status()).toBe(409);
    await expect.poll(async () => await page.getByTestId("series-error").textContent(), { timeout: 30_000 }).toContain("打开台账编辑后");
    expect(await editor.count()).toBe(1);
    expect(await page.getByLabel("台账 JSON").inputValue()).toBe(text);
    expect(await q<{ n: number }>("SELECT count(*)::int AS n FROM series_writing_ledger_revision WHERE series_id = (SELECT id FROM series_writing_series WHERE project_id = $1)", [finished]))
      .toEqual(ledgers);
    await viewports("17-series-ledger-refused", editor);
    (evidence.flows as Record<string, unknown>).S10 = { project: finished };
    expect(pageErrors).toEqual([]);
  }, 120_000);
});
