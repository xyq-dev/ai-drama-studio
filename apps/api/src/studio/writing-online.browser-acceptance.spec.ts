/// <reference lib="dom" />
/**
 * Online writing in a real browser with the site login on: the administrator signs in once and then starts a title run,
 * asks for an episode candidate (Claude) and a story candidate (OpenAI), adopts each into the editor draft and saves it
 * with the editor's own "保存新版本" — without ever typing an operator token. A real browser drives the built Next app,
 * which reaches the real Nest API through its same-origin /api/v1 rewrite; the API runs on a new, empty, disposable
 * PostgreSQL database with the full migration chain (a fresh install). NOT part of `test` or `integration`: run only with
 * `pnpm --filter @ai-drama/api writing-online:browser-acceptance` and the title writing acceptance guard variables.
 *
 * What is real: Chrome, the built web app and its rewrite and page protection, the site login (scrypt hash, session
 * cookie, CSRF token, origin check), the Nest controllers (operator proof from the session), the services, both
 * PostgreSQL stores and the text chain. What is not: the model. The title and candidate services the controllers use are
 * built here with a stub transport that answers in each provider's own wire format (Claude Messages, OpenAI Responses),
 * records every request and never opens a network connection. Its texts say they are the double's samples.
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
import {
  PostgresTitleWritingStore,
  PostgresWritingCandidateStore,
  TextChainService,
  WRITING_CANDIDATE_MIGRATION,
  checkTitleWritingAcceptanceEnv,
  closePostgresPool,
  createPostgresPool,
  runMigrations,
  verifyTitleWritingAcceptanceDatabase,
} from "@ai-drama/database";
import {
  ANTHROPIC_MESSAGES_URL,
  TitleWritingEngine,
  WritingCandidateExecutor,
  titleWritingProviderConfigs,
  type WritingTransport,
} from "@ai-drama/providers";
import {
  fixtureCandidateFromPrompt,
  fixtureConcept,
  fixtureEpisode,
  fixtureOutline,
  fixtureOutlineCountOf,
  fixtureStepOf,
  providerAnswer,
} from "@ai-drama/providers/title-writing-fixtures";
import { AppModule } from "../app.module";
import { hashPassword } from "../auth/password-hash";
import { loadApiEnv } from "../config/env";
import { SafeExceptionFilter } from "../http/safe-exception.filter";
import type { StudioRuntime } from "./studio.runtime";
import { TitleWritingService } from "./title-writing.service";
import { STUDIO_RUNTIME, TITLE_WRITING_SERVICE, WRITING_CANDIDATE_SERVICE } from "./tokens";
import { WritingCandidateService } from "./writing-candidate.service";

const decision = checkTitleWritingAcceptanceEnv(process.env);
if (!decision.ok) throw new Error(`Writing online browser acceptance refused: ${decision.reason}`);
const acceptanceUrl = decision.url;

const ROOT = join(__dirname, "..", "..", "..", "..");
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
// `next build` compiles the /api/v1 rewrite to this origin (the web's default upstream); the API listens there.
const API_PORT = 3001;
const WEB_PORT = 3010;
const WEB = `http://127.0.0.1:${String(WEB_PORT)}`;
const API = `http://127.0.0.1:${String(API_PORT)}`;
// Generated per run, held in memory, typed into the login form only; never printed or written to the evidence.
const PASSWORD = `acceptance-${randomUUID()}`;
// Not a key of any provider account: the stub never sends it anywhere.
// A personal Claude Console key shape (sk-ant-usr-) with a workspace id, as a key not scoped to one workspace needs.
const STUB_KEY = `sk-ant-usr-stub-not-a-provider-key-${randomUUID()}`;
const STUB_WORKSPACE = "wrkspc_01OnlineAcceptanceStubWorkspace";
const TITLE = "模型替身样例·在线候选";
const ONLINE_MARK = "（模型替身样例·在线候选改写）";
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

const pool = createPostgresPool({ connectionString: acceptanceUrl, connectionTimeoutMs: 2_000, statementTimeoutMs: 10_000, queryTimeoutMs: 10_000 });
async function q<T>(sql: string, values: unknown[] = []): Promise<T[]> {
  return (await pool.query(sql, values) as { rows: T[] }).rows;
}
const evidenceDir = process.env.TITLE_WRITING_ACCEPTANCE_EVIDENCE_DIR;
const shotsDir = evidenceDir ? join(evidenceDir, "online-screenshots") : null;
const evidence: Record<string, unknown> = { flows: {} as Record<string, unknown>, screenshots: [] as string[], checks: {} as Record<string, unknown> };
const flows = evidence.flows as Record<string, unknown>;

// ---------------------------------------------------------------------------------------------------------------
// Model double: one transport for title steps and online candidates, in the wire format of the endpoint addressed.

interface Sent { kind: string; endpoint: string; keyMatches: boolean }
const sent: Sent[] = [];
/** The next candidate answers of an episode: a status and body to return instead of the fixture. */
const episodePlans = new Map<number, Array<{ status: number; body: unknown }>>();

const transport: WritingTransport = async (request) => {
  const endpoint = new URL(request.url);
  const body = JSON.parse(request.body) as { messages?: Array<{ role: string; content: string }>; input?: string };
  const user = body.messages?.find((message) => message.role === "user")?.content ?? body.input ?? "";
  const headers = request.headers as Record<string, string>;
  // Claude: x-api-key and the configured workspace, never a bearer token. OpenAI: its bearer token and no workspace.
  const names = Object.keys(headers).map((name) => name.toLowerCase());
  const keyMatches = endpoint.host === "api.anthropic.com"
    ? headers["x-api-key"] === STUB_KEY && headers["anthropic-workspace-id"] === STUB_WORKSPACE && !names.includes("authorization")
    : headers.Authorization === `Bearer ${STUB_KEY}` && !names.includes("anthropic-workspace-id") && !names.includes("x-api-key");
  let kind: string;
  let value: unknown;
  let planned: { status: number; body: unknown } | undefined;
  if (user.includes("模式：故事策划") || user.includes("模式：单集写作")) {
    const candidate = fixtureCandidateFromPrompt(user);
    kind = "episodeNo" in candidate ? `candidate:episode:${String(candidate.episodeNo)}` : "candidate:story";
    if ("episodeNo" in candidate) planned = episodePlans.get(candidate.episodeNo)?.shift();
    // An episode candidate differs visibly from the script the title run placed, so adoption can be seen.
    value = "episodeNo" in candidate ? { ...candidate, screenplay: `${candidate.screenplay}\n${ONLINE_MARK}` } : candidate;
  } else {
    const title = /剧名：(.+)/.exec(user)?.[1]?.trim();
    if (!title) throw new Error("stub: a prompt that is neither a title step nor a candidate");
    const step = fixtureStepOf(user);
    kind = `title:${step}`;
    value = step === "concept" ? fixtureConcept(title) : step === "outline" ? fixtureOutline(fixtureOutlineCountOf(user)) : fixtureEpisode(Number(step.slice(-1)));
  }
  sent.push({ kind, endpoint: `${endpoint.host}${endpoint.pathname}`, keyMatches });
  const answer = planned ?? { status: 200, body: providerAnswer(request.url, value) };
  return {
    status: answer.status,
    headers: { get: (name: string) => ["x-request-id", "request-id"].includes(name.toLowerCase()) ? `stub-${String(sent.length)}` : null },
    body: new TextEncoder().encode(JSON.stringify(answer.body)),
  };
};
const sends = (prefix: string) => sent.filter((item) => item.kind.startsWith(prefix)).length;

/** Claude with only its key (the default model), OpenAI with its key and list: the configuration an administrator gives. */
const providers = titleWritingProviderConfigs({ ANTHROPIC_API_KEY: STUB_KEY, ANTHROPIC_WORKSPACE_ID: STUB_WORKSPACE,
  OPENAI_API_KEY: STUB_KEY, TITLE_WRITING_OPENAI_MODELS: "openai-acceptance-stub" });

function titleService(runtime: StudioRuntime): TitleWritingService {
  const store = new PostgresTitleWritingStore(runtime.pool, new TextChainService(runtime.pool));
  return new TitleWritingService({
    workspaceId: WORKSPACE, nodeEnv: "test", enabled: true, operatorToken: null, siteOperator: true, defaultProvider: null, providers, store,
    engine: new TitleWritingEngine({ workspaceId: WORKSPACE, store, providers, transport, maxCallsPerDay: 200, timeoutMs: 30_000 }),
    projects: runtime.store, maxCallsPerDay: 200, maxActiveRuns: 10,
  });
}

function candidateService(runtime: StudioRuntime): WritingCandidateService {
  const store = new PostgresWritingCandidateStore(runtime.pool);
  return new WritingCandidateService({
    workspaceId: WORKSPACE, nodeEnv: "test", enabled: true, operatorToken: null, siteOperator: true, defaultProvider: null, providers, store,
    executor: new WritingCandidateExecutor({ workspaceId: WORKSPACE, store, providers, transport, timeoutMs: 30_000 }),
    projects: runtime.store, maxCallsPerDay: 200,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Processes.

let app: INestApplication | undefined;
let web: { child: ChildProcess; logs: () => string } | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page;
const pageErrors: string[] = [];
const pageWrites: Array<{ method: string; path: string; key: string | null; token: boolean }> = [];

function redact(text: string): string {
  return text.split(PASSWORD).join("[password]").split(STUB_KEY).join("[stub-key]").split(acceptanceUrl).join("[database-url]");
}

async function bootApi(): Promise<INestApplication> {
  const env = loadApiEnv({
    NODE_ENV: "test", DATABASE_URL: acceptanceUrl, REDIS_URL: "redis://127.0.0.1:6399", S3_ENDPOINT: "http://127.0.0.1:59000", S3_REGION: "us-east-1",
    S3_BUCKET: "ai-drama-dev", S3_ACCESS_KEY_ID: "test", S3_SECRET_ACCESS_KEY: "test", APP_WORKSPACE_ID: WORKSPACE,
    SITE_AUTH_ENABLED: "true", SITE_AUTH_USERNAME: "admin",
    SITE_AUTH_PASSWORD_HASH: await hashPassword(PASSWORD, { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 }), SITE_AUTH_PUBLIC_ORIGIN: WEB,
  });
  // No operator token anywhere: the signed-in administrator is the operator.
  expect(env.TITLE_WRITING_OPERATOR_TOKEN).toBeUndefined();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(env)] })
    .overrideProvider(TITLE_WRITING_SERVICE).useFactory({ inject: [STUDIO_RUNTIME], factory: (runtime: StudioRuntime) => titleService(runtime) })
    .overrideProvider(WRITING_CANDIDATE_SERVICE).useFactory({ inject: [STUDIO_RUNTIME], factory: (runtime: StudioRuntime) => candidateService(runtime) })
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

// ---------------------------------------------------------------------------------------------------------------
// Page helpers.

/** At 1280×800 and 390×844: no horizontal overflow, the primary action on screen and not covered, then a screenshot. */
async function viewports(name: string, ready: Locator, primary?: Locator): Promise<void> {
  for (const [label, size] of [["1280", DESKTOP], ["390", PHONE]] as const) {
    await page.setViewportSize(size);
    await ready.first().waitFor({ state: "visible", timeout: 20_000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${name} ${label}: horizontal overflow`).toBeLessThanOrEqual(0);
    if (primary) {
      await primary.scrollIntoViewIfNeeded();
      const box = await primary.boundingBox();
      expect(box, `${name} ${label}: primary action has no box`).not.toBeNull();
      expect(box!.x >= -1 && box!.x + box!.width <= size.width + 1, `${name} ${label}: primary action outside the viewport`).toBe(true);
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

function headline(): Locator {
  return page.locator("main").getByRole("status").first();
}

/** The editor card of one title ("故事" or "第 N 集剧本") and its assistant. */
function editor(title: string): Locator {
  return page.locator("form").filter({ has: page.getByRole("heading", { name: title, exact: true }) }).first();
}

async function editorText(card: Locator): Promise<string> {
  return await card.getByLabel("正文", { exact: true }).inputValue();
}

const candidatePosts = () => pageWrites.filter((write) => write.method === "POST" && write.path.endsWith("/writing/candidates"));

async function scriptRows(projectId: string, episodeNo: number) {
  return await q<{ id: string; text: string; current: boolean }>(
    `SELECT s.id, s.content_json->>'text' AS text, e.current_script_revision_id = s.id AS current
       FROM script_revision s JOIN episode e ON e.id = s.episode_id WHERE s.project_id = $1 AND e.episode_no = $2 ORDER BY s.revision_no`,
    [projectId, episodeNo]);
}

async function storyRows(projectId: string) {
  return await q<{ id: string; text: string; review_status: string }>(
    "SELECT id, content_json->>'text' AS text, review_status FROM story_revision WHERE project_id = $1 ORDER BY revision_no", [projectId]);
}

async function candidateRows(projectId: string) {
  return await q<{ mode: string; episode_no: number | null; provider_key: string; model: string; state: string; error_code: string | null; billing_status: string }>(
    `SELECT mode, episode_no, provider_key, model, state, error_code, billing_status FROM writing_candidate_request
      WHERE project_id = $1 ORDER BY created_at`, [projectId]);
}

// ---------------------------------------------------------------------------------------------------------------

beforeAll(async () => {
  const verified = await verifyTitleWritingAcceptanceDatabase({ query: async (sql, values) => ({ rows: await q<Record<string, unknown>>(sql, values) }) },
    decision.databaseName);
  if (!verified.ok) {
    await closePostgresPool(pool);
    throw new Error(`Writing online browser acceptance refused: ${verified.reason}`);
  }
  const migrated = await runMigrations(pool);
  expect(migrated.applied.at(-1)).toBe(WRITING_CANDIDATE_MIGRATION);
  evidence.migrationsApplied = migrated.applied;
  await q("INSERT INTO workspace (id, name, status) VALUES ($1, 'writing-online-browser-acceptance', 'ACTIVE')", [WORKSPACE]);
  if (shotsDir) await mkdir(shotsDir, { recursive: true });

  app = await bootApi();
  web = startWeb();
  await waitFor("the API", async () => (await fetch(`${API}/api/v1/health/live`)).ok);
  await waitFor("the web app", async () => (await fetch(`${WEB}/login`)).ok);
  // Anonymous: the API refuses both paid routes and the candidate reads; nothing is written.
  const id = randomUUID();
  for (const [method, path] of [["GET", "/writing/candidates/options"], ["POST", `/projects/${id}/writing/candidates`], ["POST", `/projects/${id}/title-runs`]] as const) {
    const response = await fetch(`${WEB}/api/v1${path}`, { method, headers: { origin: WEB, "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
    expect(response.status, `${method} ${path} without a login`).toBe(401);
  }
  (evidence.checks as Record<string, unknown>).anonymous = "401 for options, candidate start and title start";

  browser = await chromium.launch({ headless: true, channel: "chrome" });
  // No trace and no HAR are recorded: they could hold request headers. Screenshots only.
  context = await browser.newContext({ viewport: DESKTOP });
  page = await context.newPage();
  page.on("pageerror", (error) => { pageErrors.push(redact(error.message)); });
  page.on("request", (request) => {
    const method = request.method();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS" || !request.url().includes("/api/v1/")) return;
    const headers = request.headers();
    pageWrites.push({ method, path: new URL(request.url()).pathname, key: headers["idempotency-key"] ?? null, token: "x-operator-token" in headers });
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
  evidence.stub = { totalSends: sent.length, kinds: sent.map((item) => item.kind), everyEndpoint: [...new Set(sent.map((item) => item.endpoint))],
    everyKeyWasTheStubKey: sent.every((item) => item.keyMatches) };
  evidence.pageErrors = pageErrors;
  evidence.pageWrites = pageWrites.map((write) => ({ method: write.method, path: write.path, operatorTokenHeader: write.token }));
  evidence.cleanup = { problems };
  if (evidenceDir) {
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(join(evidenceDir, "writing-online-browser-acceptance.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    for (const file of await readdir(evidenceDir, { recursive: true })) {
      if (!String(file).endsWith(".json")) continue;
      const text = await readFile(join(evidenceDir, String(file)), "utf8");
      if (text.includes(PASSWORD) || text.includes(STUB_KEY) || text.includes(acceptanceUrl)) problems.push(`secret in ${String(file)}`);
    }
  }
  if (problems.length > 0) throw new Error(`writing online browser acceptance cleanup: ${problems.join("; ")}`);
}, 60_000);

let projectId = "";

describe("online writing in a real browser with the site login, real web and API, isolated PostgreSQL, model stubbed", () => {
  it("A: one login; the title run starts without any operator token and its scripts are placed after the story review", async () => {
    await page.goto(`${WEB}/create`, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/login\?returnTo=%2Fcreate/, { timeout: 30_000 });
    await page.getByLabel("账号").fill("admin");
    await page.getByLabel("密码").fill(PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL(`${WEB}/create`, { timeout: 30_000 });
    await page.getByText(/服务端已配置：OpenAI、Claude/).waitFor({ timeout: 30_000 });
    expect(await page.locator("#ai-token").count()).toBe(0);
    await page.getByText("调用权限由当前管理员登录确认，不需要填写操作者令牌。模型密钥只在服务端。").waitFor();
    await page.locator("#ai-title").fill(TITLE);
    await viewports("01-title-start", page.getByText("调用权限由当前管理员登录确认", { exact: false }), page.getByRole("button", { name: "AI 一键创作" }));
    const navigated = page.waitForURL(/\/projects\/[0-9a-f-]{36}\/writing$/, { timeout: 30_000 });
    await page.getByRole("button", { name: "AI 一键创作" }).click();
    await navigated;
    projectId = /\/projects\/([0-9a-f-]{36})\/writing$/.exec(page.url())![1]!;
    await expect.poll(async () => await headline().textContent(), { timeout: 60_000, interval: 250 }).toBe("创作完成");
    expect(sends("title:")).toBe(5);
    // The default provider without a configured default is Claude, with the model a key alone gives it.
    const run = (await q<{ provider_key: string; model: string }>("SELECT provider_key, model FROM title_writing_run WHERE project_id = $1", [projectId]))[0]!;
    expect(run).toEqual({ provider_key: "anthropic", model: "claude-opus-5-5" });
    expect(pageWrites.filter((write) => write.token)).toEqual([]);

    // The person reviews the story, then places the scripts (the existing human gates are unchanged).
    await page.getByRole("link", { name: "查看和修改故事草稿" }).click();
    await page.getByRole("heading", { name: "第 1 步 · 定故事" }).waitFor({ timeout: 30_000 });
    const column = page.getByRole("complementary", { name: "检查面板" }).first();
    for (const name of ["提交审核", "通过"]) {
      const answered = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/review"), { timeout: 20_000 });
      await column.getByRole("button", { name, exact: true }).click();
      expect((await answered).status()).toBe(200);
    }
    await page.goto(`${WEB}/projects/${projectId}/writing`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "写入剧本草稿" }).click();
    await expect.poll(async () => await page.locator("summary").filter({ hasText: "已写入剧本草稿" }).count(), { timeout: 30_000 }).toBe(3);
    flows.title = { projectId, provider: run, stubSends: sends("title:"), operatorTokenHeaders: 0 };
  }, 240_000);

  it("B: an episode candidate from Claude is previewed, compared, adopted only on click and saved as a new version", async () => {
    const before = await scriptRows(projectId, 1);
    expect(before).toHaveLength(1);
    await page.goto(`${WEB}/projects/${projectId}?focus=script&episode=1`, { waitUntil: "domcontentloaded" });
    const card = editor("第 1 集剧本");
    await card.getByRole("button", { name: "编剧助手" }).click();
    const panel = card.getByTestId("online-candidate");
    await expect.poll(async () => await panel.getByTestId("online-provider").textContent(), { timeout: 30_000 }).toContain("Claude · claude-opus-5-5");
    expect(await panel.getByLabel("操作者令牌").count()).toBe(0);
    const generate = panel.getByRole("button", { name: "在线生成本集候选" });
    // Not yet confirmed: refused on the page, nothing sent.
    await generate.click();
    await panel.getByText("请先确认使用当前已加载的故事与分集材料").waitFor();
    expect(candidatePosts()).toHaveLength(0);
    await card.getByLabel("确认使用当前已加载的故事与分集材料").check();
    await card.getByLabel("修改要求").fill("节奏更紧，保留结尾。");
    await card.getByLabel("必须保留的对白").fill("林夏：这不是我。");
    const original = await editorText(card);
    await viewports("02-episode-ready", panel, generate);
    await generate.dblclick();
    await card.getByLabel("候选正文").waitFor({ timeout: 30_000 });
    expect(candidatePosts()).toHaveLength(1);
    expect(sends("candidate:episode:1")).toBe(1);
    expect(await card.getByLabel("候选正文").inputValue()).toContain(ONLINE_MARK);
    expect(original).not.toContain(ONLINE_MARK);
    await card.getByText("与当前正文的差异").waitFor();
    // Previewed, not adopted: the editor and the database are unchanged.
    expect(await editorText(card)).toBe(original);
    expect(await scriptRows(projectId, 1)).toEqual(before);
    await viewports("03-episode-candidate", card.getByLabel("候选正文"), card.getByRole("button", { name: "采纳到草稿" }));
    await card.getByRole("button", { name: "采纳到草稿" }).click();
    await card.getByText("已放入编辑草稿。还没有保存，请使用原来的保存新版本。").waitFor();
    expect(await editorText(card)).toContain(ONLINE_MARK);
    expect(await scriptRows(projectId, 1)).toEqual(before);
    const saved = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith(`/scripts`) && response.url().includes("/episodes/"), { timeout: 20_000 });
    await card.getByRole("button", { name: "保存新版本" }).click();
    expect((await saved).status()).toBe(201);
    await expect.poll(async () => (await scriptRows(projectId, 1)).length, { timeout: 20_000 }).toBe(2);
    const after = await scriptRows(projectId, 1);
    expect(after[1]).toMatchObject({ current: true });
    expect(after[1]!.text).toContain(ONLINE_MARK);
    // A refresh reads the saved version, and the request is in the history; nothing is sent again.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(async () => await editorText(editor("第 1 集剧本")), { timeout: 30_000 }).toContain(ONLINE_MARK);
    await editor("第 1 集剧本").getByRole("button", { name: "编剧助手" }).click();
    await editor("第 1 集剧本").getByText(/Claude claude-opus-5-5 · 已生成/).waitFor({ timeout: 30_000 });
    expect(sends("candidate:")).toBe(1);
    expect(await candidateRows(projectId)).toEqual([{ mode: "episode", episode_no: 1, provider_key: "anthropic", model: "claude-opus-5-5", state: "completed",
      error_code: null, billing_status: "unknown" }]);
    flows.episode = { projectId, scriptRevisions: { before: 1, after: 2 }, candidatePosts: candidatePosts().length, stubSends: sends("candidate:episode:1") };
  }, 240_000);

  it("C: an unknown result is shown as possibly charged, is never resent on reload, and a new request needs the confirmation", async () => {
    episodePlans.set(2, [{ status: 529, body: { type: "error", error: { type: "overloaded_error", message: "stub" } } }]);
    await page.goto(`${WEB}/projects/${projectId}?focus=script&episode=2`, { waitUntil: "domcontentloaded" });
    let card = editor("第 2 集剧本");
    await card.getByRole("button", { name: "编剧助手" }).click();
    await expect.poll(async () => await card.getByTestId("online-provider").textContent(), { timeout: 30_000 }).toContain("Claude");
    await card.getByLabel("确认使用当前已加载的故事与分集材料").check();
    await card.getByRole("button", { name: "在线生成本集候选" }).click();
    await card.getByText(/结果不确定：模型服务可能已经处理并产生费用，系统不会自动重发/).waitFor({ timeout: 30_000 });
    expect(sends("candidate:episode:2")).toBe(1);
    await page.reload({ waitUntil: "domcontentloaded" });
    card = editor("第 2 集剧本");
    await card.getByRole("button", { name: "编剧助手" }).click();
    await card.getByText(/结果不确定（可能已产生费用）/).waitFor({ timeout: 30_000 });
    const confirm = card.getByRole("checkbox", { name: /上一次结果不确定的请求可能已经产生费用/ });
    const generate = card.getByRole("button", { name: "在线生成本集候选" });
    await card.getByLabel("确认使用当前已加载的故事与分集材料").check();
    expect(await generate.isDisabled()).toBe(true);
    await viewports("04-unknown", confirm, confirm);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(sends("candidate:episode:2")).toBe(1);
    await confirm.check();
    await generate.click();
    await card.getByLabel("候选正文").waitFor({ timeout: 30_000 });
    expect(sends("candidate:episode:2")).toBe(2);
    const rows = (await candidateRows(projectId)).filter((row) => row.episode_no === 2);
    expect(rows.map((row) => `${row.state}/${row.error_code ?? "-"}/${row.billing_status}`)).toEqual(["unknown/server_error/unknown", "completed/-/unknown"]);
    flows.unknown = { rows, stubSends: sends("candidate:episode:2"), resentOnReload: false };
  }, 240_000);

  it("D: a story candidate from OpenAI (chosen in the advanced settings) is adopted and saved; the breakdown stays off", async () => {
    const storiesBefore = await storyRows(projectId);
    await page.goto(`${WEB}/projects/${projectId}?focus=story`, { waitUntil: "domcontentloaded" });
    const card = editor("故事");
    await card.getByRole("button", { name: "编剧助手" }).click();
    const panel = card.getByTestId("online-candidate");
    await expect.poll(async () => await panel.getByTestId("online-provider").textContent(), { timeout: 30_000 }).toContain("Claude");
    await panel.getByText("高级设置（可不填）").click();
    await panel.getByLabel("模型服务").selectOption("openai");
    await expect.poll(async () => await panel.getByTestId("online-provider").textContent()).toContain("OpenAI · openai-acceptance-stub");
    await card.getByLabel("修改要求（可不填）").fill("让冲突更早出现。");
    await panel.getByRole("button", { name: "在线生成故事候选" }).click();
    await card.getByLabel("候选正文").waitFor({ timeout: 30_000 });
    expect(await card.getByLabel("候选正文").inputValue()).toContain("模型替身样例");
    expect(sent.filter((item) => item.kind === "candidate:story").map((item) => item.endpoint)).toEqual(["api.openai.com/v1/responses"]);
    await card.getByRole("button", { name: "采纳到草稿" }).click();
    expect(await editorText(card)).toContain("一句话故事");
    expect(await storyRows(projectId)).toEqual(storiesBefore);
    const saved = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/stories"), { timeout: 20_000 });
    await card.getByRole("button", { name: "保存新版本" }).click();
    expect((await saved).status()).toBe(201);
    await expect.poll(async () => (await storyRows(projectId)).length, { timeout: 20_000 }).toBe(storiesBefore.length + 1);
    expect((await storyRows(projectId)).at(-1)!.text).toContain("模型替身样例");
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(async () => await editorText(editor("故事")), { timeout: 30_000 }).toContain("模型替身样例");

    // PR #72: the script breakdown stays off and says so.
    await page.goto(`${WEB}/projects/${projectId}?focus=script&episode=1`, { waitUntil: "domcontentloaded" });
    const blocked = page.locator('section[aria-labelledby^="breakdown-"]').getByTestId("breakdown-blocked");
    await expect.poll(async () => await blocked.textContent(), { timeout: 30_000 }).toBe("剧本拆解尚未开启。");
    await viewports("05-breakdown-off", blocked);
    flows.story = { provider: "openai", storyRevisions: { before: storiesBefore.length, after: storiesBefore.length + 1 }, breakdown: "剧本拆解尚未开启。" };
  }, 240_000);

  it("E: the browser never holds a key or token, every model request went to a stub with the stub key, and no page error was raised", async () => {
    const stored = await page.evaluate(() => JSON.stringify({ local: { ...window.localStorage }, session: { ...window.sessionStorage }, cookie: document.cookie }));
    const cookies = JSON.stringify(await context!.cookies());
    expect(stored.includes(STUB_KEY) || cookies.includes(STUB_KEY)).toBe(false);
    const options = await page.evaluate(async () => await (await fetch("/api/v1/writing/candidates/options")).text());
    expect(options.includes(STUB_KEY)).toBe(false);
    expect(JSON.parse(options)).toMatchObject({ code: "WRITING_CANDIDATE_READY", operatorTokenRequired: false, defaultProvider: "anthropic" });
    expect(pageWrites.filter((write) => write.token)).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(sent.every((item) => item.keyMatches)).toBe(true);
    expect(new Set(sent.map((item) => item.endpoint))).toEqual(new Set(["api.anthropic.com/v1/messages", "api.openai.com/v1/responses"]));
    expect(sent.filter((item) => item.endpoint === new URL(ANTHROPIC_MESSAGES_URL).host + new URL(ANTHROPIC_MESSAGES_URL).pathname).length).toBe(sent.length - 1);
    (evidence.checks as Record<string, unknown>).browser = { keyInStorageOrCookies: false, operatorTokenHeaders: 0, pageErrors: 0 };
  });
});
