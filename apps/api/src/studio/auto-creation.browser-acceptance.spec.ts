/// <reference lib="dom" />
/**
 * AI automatic creation in a real browser with the site login on. Chrome drives the built Next app, which reaches the
 * real Nest API through its same-origin /api/v1 rewrite; the API runs on a new, empty, disposable PostgreSQL database
 * with the test site's migration combination (base seven, guarded Claude, candidate and DeepSeek candidate migrations,
 * script breakdown NOT applied) plus the guarded automatic creation migration. NOT part of `test` or `integration`:
 *   pnpm build && pnpm --filter @ai-drama/api auto-creation:browser-acceptance
 * with the title writing acceptance guard variables. What is not real: the model. The automatic creation service the
 * controller uses is built here with the automatic creation double as its transport (DeepSeek wire format, the
 * configured default); it records every request and never opens a network connection.
 * DOM and layout checks are asserted here; the screenshots it saves are for a separate visual review.
 */
import "reflect-metadata";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { type Browser, type BrowserContext, type Locator, type Page, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { autoCreationNormalCalls } from "@ai-drama/contracts";
import {
  AUTO_CREATION_MIGRATION,
  BASE_MIGRATIONS,
  GUARDED_SINGLE_MIGRATIONS,
  PostgresAutoCreationStore,
  SCRIPT_BREAKDOWN_MIGRATION,
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
import { AutoCreationEngine, titleWritingProviderConfigs } from "@ai-drama/providers";
import { autoFixtureTransport, type AutoFixtureExchange, type AutoFixturePlan } from "@ai-drama/providers/title-writing-fixtures";
import { AppModule } from "../app.module";
import { hashPassword } from "../auth/password-hash";
import { loadApiEnv } from "../config/env";
import { SafeExceptionFilter } from "../http/safe-exception.filter";
import { AutoCreationService } from "./auto-creation.service";
import type { StudioRuntime } from "./studio.runtime";
import { AUTO_CREATION_SERVICE, STUDIO_RUNTIME } from "./tokens";

const decision = checkTitleWritingAcceptanceEnv(process.env);
if (!decision.ok) throw new Error(`Auto creation browser acceptance refused: ${decision.reason}`);
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
const evidenceDir = process.env.TITLE_WRITING_ACCEPTANCE_EVIDENCE_DIR;
const shotsDir = evidenceDir ? join(evidenceDir, "auto-creation-screenshots") : null;
const evidence: Record<string, unknown> = { screenshots: [] as string[], layout: [] as unknown[], flows: {} as Record<string, unknown>, paidCalls: 0 };

let plan: AutoFixturePlan = {};
const seen: AutoFixtureExchange[] = [];
const transport = autoFixtureTransport({ seen, plan: new Proxy({}, { get: (_target, key) => (plan as Record<string | symbol, unknown>)[key] }) as AutoFixturePlan });
const providers = titleWritingProviderConfigs({ DEEPSEEK_API_KEY: DEEPSEEK_STUB_KEY });

function autoService(runtime: StudioRuntime): AutoCreationService {
  const store = new PostgresAutoCreationStore(runtime.pool, new TextChainService(runtime.pool));
  return new AutoCreationService({
    workspaceId: WORKSPACE, enabled: true, operatorToken: null, siteOperator: true, defaultProvider: "deepseek", providers, store,
    engine: new AutoCreationEngine({ workspaceId: WORKSPACE, store, providers, transport, maxCallsPerDay: 200, timeoutMs: 30_000 }),
    projects: runtime.store, maxCallsPerDay: 200, maxActiveRuns: 2, research: { fetchEnabled: false, allowedHosts: [] },
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
    .overrideProvider(AUTO_CREATION_SERVICE).useFactory({ inject: [STUDIO_RUNTIME], factory: (runtime: StudioRuntime) => autoService(runtime) })
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

/** At 1280×800 and 390×844: no horizontal overflow, the primary action visible inside the viewport and not covered. */
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
      const covered = await primary.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return !(hit && (hit === node || node.contains(hit)));
      });
      expect(covered, `${name} ${label}: primary action is covered`).toBe(false);
    }
    (evidence.layout as unknown[]).push({ name, viewport: label, overflow, primaryInView });
    if (shotsDir) {
      const file = `${name}-${label}.png`;
      await page.screenshot({ path: join(shotsDir, file), fullPage: true });
      (evidence.screenshots as string[]).push(file);
    }
  }
  await page.setViewportSize(DESKTOP);
}

const headline = () => page.getByTestId("auto-headline");

beforeAll(async () => {
  const verified = await verifyTitleWritingAcceptanceDatabase({ query: async (sql, values) => ({ rows: await q(sql, values) }) }, decision.databaseName);
  if (!verified.ok) {
    await closePostgresPool(pool);
    throw new Error(`Auto creation browser acceptance refused: ${verified.reason}`);
  }
  expect((await runMigrations(pool, undefined, { before: SCRIPT_BREAKDOWN_MIGRATION })).applied).toEqual([...BASE_MIGRATIONS]);
  for (const name of [WRITING_PROVIDER_MIGRATION, WRITING_CANDIDATE_MIGRATION, WRITING_CANDIDATE_DEEPSEEK_MIGRATION, AUTO_CREATION_MIGRATION]) {
    expect((await runMigrations(pool, undefined, { only: { name, requires: GUARDED_SINGLE_MIGRATIONS[name]! } })).applied).toEqual([name]);
  }
  const ledger = (await q<{ name: string }>("SELECT name FROM schema_migration ORDER BY name")).map((row) => row.name);
  expect(ledger).not.toContain(SCRIPT_BREAKDOWN_MIGRATION);
  evidence.migrationsApplied = ledger;
  await q("INSERT INTO workspace (id, name, status) VALUES ($1, 'auto-creation-browser-acceptance', 'ACTIVE')", [WORKSPACE]);
  if (shotsDir) await mkdir(shotsDir, { recursive: true });
  app = await bootApi();
  web = startWeb();
  await waitFor("the API", async () => (await fetch(`${API}/api/v1/health/live`)).ok);
  await waitFor("the web app", async () => (await fetch(`${WEB}/login`)).ok);
  // Anonymous: the paid start is refused before anything is written.
  const anonymous = await fetch(`${WEB}/api/v1/projects/${randomUUID()}/auto-runs`, { method: "POST", headers: { origin: WEB, "content-type": "application/json" }, body: "{}" });
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
  evidence.stub = { totalSends: seen.length, stages: seen.map((item) => item.stage), endpoints: [...new Set(seen.map((item) => item.url))] };
  evidence.pageErrors = pageErrors;
  if (evidenceDir) {
    await mkdir(evidenceDir, { recursive: true });
    const text = JSON.stringify(evidence, null, 2);
    if (text.includes(PASSWORD) || text.includes(DEEPSEEK_STUB_KEY) || text.includes(acceptanceUrl)) throw new Error("secret in evidence");
    await writeFile(join(evidenceDir, "auto-creation-browser-acceptance.json"), `${text}\n`, "utf8");
  }
}, 60_000);

let firstProject = "";

describe("AI automatic creation in a real browser (site login, built web, real API, isolated PostgreSQL, model stubbed)", () => {
  it("A: empty idea, one click, the default one sixty-second episode; progress, refresh recovery, statuses and downloads", async () => {
    plan = {};
    await page.goto(`${WEB}/create`, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/login\?returnTo=%2Fcreate/, { timeout: 30_000 });
    await page.getByLabel("账号").fill("admin");
    await page.getByLabel("密码").fill(PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL(`${WEB}/create`, { timeout: 30_000 });
    const card = page.getByTestId("auto-creation-start");
    await card.waitFor({ timeout: 30_000 });
    // The plan shown before the start: the real provider and model, call counts, research limits.
    await expect.poll(async () => await page.getByTestId("auto-provider-target").textContent(), { timeout: 30_000 }).toContain("DeepSeek · deepseek-flash");
    expect(await page.getByTestId("auto-calls").textContent()).toContain("正常 6 次");
    expect(await page.getByTestId("auto-calls").textContent()).toContain("最坏 10 次");
    expect(await page.getByTestId("auto-research-mode").textContent()).toContain("资料有限策划模式");
    expect(await page.locator("#auto-episodes").inputValue()).toBe("1");
    expect(await page.locator("#auto-seconds").inputValue()).toBe("60");
    // The original title-driven entry is still on the page.
    await page.getByRole("button", { name: "AI 一键创作" }).waitFor();
    const startButton = card.getByRole("button", { name: "AI 自动创作" });
    await viewports("01-auto-start", card, startButton);
    const navigated = page.waitForURL(/\/projects\/[0-9a-f-]{36}\/auto$/, { timeout: 30_000 });
    await startButton.click();
    await navigated;
    firstProject = /\/projects\/([0-9a-f-]{36})\/auto$/.exec(page.url())![1]!;
    await expect.poll(async () => await headline().textContent(), { timeout: 90_000, interval: 300 }).toBe("剧本包已完成（机器质量检查通过）");
    expect(seen).toHaveLength(autoCreationNormalCalls(1));
    // Reload: the stored stages and results come back as they are.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(async () => await headline().textContent(), { timeout: 30_000 }).toBe("剧本包已完成（机器质量检查通过）");
    const states = await page.locator("[data-testid=auto-stages] li").evaluateAll((items) => items.map((item) => `${item.getAttribute("data-stage")}=${item.getAttribute("data-state")}`));
    expect(states).toEqual(["sources=completed", "research=completed", "directions=completed", "bible=completed", "outline=completed", "episode:1=completed", "review:1=completed"]);
    expect(await page.getByTestId("auto-quality").textContent()).toContain("不是人工审核");
    expect(await page.getByTestId("auto-video-status").textContent()).toContain("未开始");
    expect(await page.getByTestId("auto-call-count").textContent()).toContain("已用 6 / 预算 12 次");
    expect(await page.getByTestId("auto-research").textContent()).toContain("资料有限策划模式");
    await page.getByTestId("auto-direction").getByText("午夜工资单").first().waitFor();
    await viewports("02-auto-run-done", page.getByTestId("auto-status"), page.getByTestId("auto-download-md"));
    // Downloads through the same-origin rewrite.
    const [markdown] = await Promise.all([page.waitForEvent("download"), page.getByTestId("auto-download-md").click()]);
    const markdownPath = join(shotsDir ?? ROOT, "auto-package.md");
    await markdown.saveAs(markdownPath);
    const response = await page.request.get(`${WEB}/api/v1/projects/${firstProject}/auto-runs/${(await q<{ id: string }>("SELECT id FROM auto_creation_run WHERE project_id = $1", [firstProject]))[0]!.id}/package?format=json`);
    expect(response.headers()["content-disposition"]).toContain("attachment");
    const json = await response.json() as { status: Record<string, string>; episodes: unknown[]; research: { sources: { researchMode: string } } };
    expect(json.status).toMatchObject({ scriptPackage: "ready", video: "not_started", humanReview: "not_confirmed" });
    expect(json.research.sources.researchMode).toBe("limited");
    // The database: one run, six calls, billing unknown, a DRAFT story authored by the machine run.
    const run = (await q<{ id: string; state: string; quality: string; calls_used: number; provider_key: string; model: string }>(
      "SELECT id, state, quality, calls_used, provider_key, model FROM auto_creation_run WHERE project_id = $1", [firstProject]));
    expect(run).toHaveLength(1);
    expect(run[0]).toMatchObject({ state: "completed", quality: "passed", calls_used: 6, provider_key: "deepseek", model: "deepseek-flash" });
    const stories = await q<{ review_status: string; created_by: string }>("SELECT review_status, created_by FROM story_revision WHERE project_id = $1", [firstProject]);
    expect(stories).toEqual([{ review_status: "DRAFT", created_by: `auto-creation:${run[0]!.id}` }]);
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM auto_creation_call WHERE run_id = $1 AND billing_status = 'unknown'", [run[0]!.id]))[0]!.n).toBe(6);
    (evidence.flows as Record<string, unknown>).A = { stubSends: seen.length, run: run[0], stories };
  }, 240_000);

  it("A2: from the finished run to the story review, approved there, back to the run through the work's own entry, scripts written", async () => {
    expect(firstProject).not.toBe("");
    const sendsBefore = seen.length;
    const runId = (await q<{ id: string }>("SELECT id FROM auto_creation_run WHERE project_id = $1", [firstProject]))[0]!.id;
    await page.goto(`${WEB}/projects/${firstProject}/auto`, { waitUntil: "domcontentloaded" });
    await expect.poll(async () => await headline().textContent(), { timeout: 30_000 }).toBe("剧本包已完成（机器质量检查通过）");
    // The run's own link opens the story review of the work.
    await page.getByRole("link", { name: "去作品中人工审核故事" }).click();
    await page.waitForURL(`${WEB}/projects/${firstProject}/create?step=story`, { timeout: 30_000 });
    await page.getByRole("heading", { name: "第 1 步 · 定故事" }).waitFor({ timeout: 30_000 });
    const entry = page.getByTestId("auto-run-entry");
    await entry.waitFor({ timeout: 30_000 });
    // A person reviews: 提交审核, then 通过, in the version column of the story actually shown.
    const column = page.getByRole("complementary", { name: "检查面板" }).first();
    for (const [name, to] of [["提交审核", "IN_REVIEW"], ["通过", "APPROVED"]] as const) {
      const action = column.getByRole("button", { name, exact: true });
      await action.waitFor({ timeout: 20_000 });
      const answered = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/review"), { timeout: 20_000 });
      await action.click();
      expect((await answered).status(), `story review to ${to}`).toBe(200);
    }
    expect((await q<{ review_status: string }>("SELECT sr.review_status FROM story_revision sr JOIN project p ON p.current_story_revision_id = sr.id WHERE p.id = $1",
      [firstProject]))[0]!.review_status).toBe("APPROVED");
    // The entry stays after a refresh, and after signing in again with the work opened directly.
    await page.reload({ waitUntil: "domcontentloaded" });
    await entry.waitFor({ timeout: 30_000 });
    // Leave the work first: a request of the open page answered 401 after the cookies are gone sends that page to the
    // login on its own, which would race (and abort) the direct navigation below.
    await page.goto("about:blank");
    await context!.clearCookies();
    await page.goto(`${WEB}/projects/${firstProject}/create`, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/login\?returnTo=/, { timeout: 30_000 });
    await page.getByLabel("账号").fill("admin");
    await page.getByLabel("密码").fill(PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL(`${WEB}/projects/${firstProject}/create`, { timeout: 30_000 });
    await entry.waitFor({ timeout: 30_000 });
    await viewports("02b-auto-entry-on-work", entry, entry.getByRole("link", { name: "回到 AI 自动创作任务" }));
    // Back through the page's own link, not history or a typed address.
    await entry.getByRole("link", { name: "回到 AI 自动创作任务" }).click();
    await page.waitForURL(`${WEB}/projects/${firstProject}/auto`, { timeout: 30_000 });
    await expect.poll(async () => await headline().textContent(), { timeout: 30_000 }).toBe("剧本包已完成（机器质量检查通过）");
    const placed = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes(`/auto-runs/${runId}/scripts`), { timeout: 20_000 });
    await page.getByRole("button", { name: "写入分集剧本草稿" }).click();
    expect((await placed).status()).toBe(200);
    await page.getByTestId("auto-script-save-episode:1").waitFor({ timeout: 20_000 });
    // Refresh: the placement is stored, and nothing was sent to a model.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(async () => await page.getByTestId("auto-script-save-episode:1").textContent(), { timeout: 30_000 }).toContain("已写入作品分集草稿");
    // Written by the person who placed them (a DRAFT, to be reviewed like any script), once.
    const scripts = await q<{ review_status: string }>("SELECT review_status FROM script_revision WHERE project_id = $1", [firstProject]);
    expect(scripts).toEqual([{ review_status: "DRAFT" }]);
    expect((await q<{ script_save: string }>("SELECT script_save FROM auto_creation_stage WHERE run_id = $1 AND stage_key = 'episode:1'", [runId]))[0]!.script_save).toBe("saved");
    expect(seen.length).toBe(sendsBefore);
    (evidence.flows as Record<string, unknown>).A2 = { byPage: ["去作品中人工审核故事", "提交审核", "通过", "reload", "sign in again", "回到 AI 自动创作任务", "写入分集剧本草稿", "reload"], scripts, stubSends: 0 };
  }, 240_000);

  it("B: a one-line idea and hard constraints at 390px; a review issue is revised once; every record is persisted", async () => {
    plan = { review: { highIssueRounds: [1] } };
    const before = seen.length;
    await page.setViewportSize(PHONE);
    await page.goto(`${WEB}/create`, { waitUntil: "domcontentloaded" });
    const card = page.getByTestId("auto-creation-start");
    await card.waitFor({ timeout: 30_000 });
    await expect.poll(async () => await page.getByTestId("auto-provider-target").textContent(), { timeout: 30_000 }).toContain("DeepSeek");
    await page.locator("#auto-idea").fill("一个外卖骑手在午夜前讨回被扣的工资");
    await card.getByText("高级设置", { exact: false }).click();
    await page.locator("#auto-characters").fill("3");
    await page.locator("#auto-forbidden").fill("复仇");
    await page.locator("#auto-ending").fill("主角拿回工资");
    const navigated = page.waitForURL(/\/projects\/[0-9a-f-]{36}\/auto$/, { timeout: 30_000 });
    await card.getByRole("button", { name: "AI 自动创作" }).click();
    await navigated;
    const projectId = /\/projects\/([0-9a-f-]{36})\/auto$/.exec(page.url())![1]!;
    await expect.poll(async () => await headline().textContent(), { timeout: 90_000, interval: 300 }).toBe("剧本包已完成（机器质量检查通过）");
    expect(seen.length - before).toBe(autoCreationNormalCalls(1) + 2);
    expect(seen.slice(before).every((item) => item.user.includes("一个外卖骑手在午夜前讨回被扣的工资") || item.stage.startsWith("review"))).toBe(true);
    expect(seen.slice(before).every((item) => item.user.includes("禁止题材或元素：复仇"))).toBe(true);
    await page.getByTestId("auto-reviews").getByText("R1", { exact: false }).first().waitFor();
    await viewports("03-auto-run-revised", page.getByTestId("auto-reviews"), page.getByTestId("auto-download-md"));
    const run = (await q<{ id: string; calls_used: number; revision_rounds_used: number; input_json: { idea: string; constraints: { maxCharacters: number } } }>(
      "SELECT id, calls_used, revision_rounds_used, input_json FROM auto_creation_run WHERE project_id = $1", [projectId]))[0]!;
    expect(run).toMatchObject({ calls_used: 8, revision_rounds_used: 1 });
    expect(run.input_json.idea).toBe("一个外卖骑手在午夜前讨回被扣的工资");
    expect(run.input_json.constraints.maxCharacters).toBe(3);
    const stages = await q<{ stage_key: string; state: string }>("SELECT stage_key, state FROM auto_creation_stage WHERE run_id = $1 ORDER BY ordinal", [run.id]);
    expect(stages.map((item) => item.stage_key)).toEqual(["sources", "research", "directions", "bible", "outline", "episode:1", "review:1", "revise:1:episode:1", "review:2"]);
    expect(stages.every((item) => item.state === "completed")).toBe(true);
    (evidence.flows as Record<string, unknown>).B = { stubSends: seen.length - before, stages: stages.map((item) => item.stage_key) };
    await page.setViewportSize(DESKTOP);
  }, 240_000);

  /** Starts from the card with no idea, no revision rounds and a budget of six; returns the new work. */
  async function startZeroRounds(): Promise<string> {
    await page.goto(`${WEB}/create`, { waitUntil: "domcontentloaded" });
    const card = page.getByTestId("auto-creation-start");
    await card.waitFor({ timeout: 30_000 });
    await expect.poll(async () => await page.getByTestId("auto-provider-target").textContent(), { timeout: 30_000 }).toContain("DeepSeek");
    await card.getByText("高级设置", { exact: false }).click();
    await page.locator("#auto-rounds").selectOption("0");
    await page.locator("#auto-budget").fill("6");
    expect(await page.getByTestId("auto-calls").textContent()).toContain("本次预算上限 6 次");
    const navigated = page.waitForURL(/\/projects\/[0-9a-f-]{36}\/auto$/, { timeout: 30_000 });
    await card.getByRole("button", { name: "AI 自动创作" }).click();
    await navigated;
    return /\/projects\/([0-9a-f-]{36})\/auto$/.exec(page.url())![1]!;
  }

  it("B2: the failed test-site shape (no rounds, budget 6) keeps running after the page is left, and is read back unchanged", async () => {
    plan = {};
    const before = seen.length;
    const projectId = await startZeroRounds();
    // Leave at once; the run belongs to the server, not to the page.
    await page.goto(`${WEB}/create`, { waitUntil: "domcontentloaded" });
    await waitFor("the run to finish without the page", async () =>
      (await q<{ state: string }>("SELECT state FROM auto_creation_run WHERE project_id = $1", [projectId]))[0]?.state === "completed");
    await page.goto(`${WEB}/projects/${projectId}/auto`, { waitUntil: "domcontentloaded" });
    await expect.poll(async () => await headline().textContent(), { timeout: 30_000 }).toBe("剧本包已完成（机器质量检查通过）");
    expect(await page.getByTestId("auto-call-count").textContent()).toContain("已用 6 / 预算 6 次");
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(async () => await headline().textContent(), { timeout: 30_000 }).toBe("剧本包已完成（机器质量检查通过）");
    expect(seen.length - before).toBe(6);
    expect((await q<{ review_status: string }>("SELECT review_status FROM story_revision WHERE project_id = $1", [projectId]))).toEqual([{ review_status: "DRAFT" }]);
    (evidence.flows as Record<string, unknown>).B2 = { stubSends: seen.length - before };
  }, 240_000);

  it("B3: a research answer the checks refuse stops after one call; the page names the stage, rule and field, not the key", async () => {
    plan = { fabricatedNumber: true };
    const before = seen.length;
    const projectId = await startZeroRounds();
    await expect.poll(async () => await headline().textContent(), { timeout: 90_000, interval: 300 }).toBe("没有完成");
    const refused = page.getByTestId("auto-output-refused");
    await refused.waitFor({ timeout: 30_000 });
    expect(await refused.textContent()).toContain("不是密钥或账户问题");
    expect(await page.getByText(/^停在「/u).textContent()).toContain("hypotheses[0].statement");
    await viewports("04-auto-research-refused", refused, page.getByTestId("auto-headline"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(async () => await headline().textContent(), { timeout: 30_000 }).toBe("没有完成");
    expect(seen.length - before).toBe(1);
    const stage = (await q<{ error_code: string; output_json: unknown }>(
      "SELECT s.error_code, s.output_json FROM auto_creation_stage s JOIN auto_creation_run r ON r.id = s.run_id WHERE r.project_id = $1 AND s.stage_key = 'research'", [projectId]))[0]!;
    expect(stage).toEqual({ error_code: "unsourced_number@hypotheses[0].statement:percent", output_json: null });
    plan = {};
    (evidence.flows as Record<string, unknown>).B3 = { stubSends: seen.length - before, stageError: stage.error_code };
  }, 240_000);

  it("C: no page errors and no real model was called", () => {
    expect(pageErrors).toEqual([]);
    expect(new Set(seen.map((item) => item.url))).toEqual(new Set(["https://api.deepseek.com/chat/completions"]));
    evidence.paidCalls = 0;
  });
});
