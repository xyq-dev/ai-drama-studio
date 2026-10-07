/**
 * Real Web + API + PostgreSQL + Chromium acceptance for the beginner pages (红果创作).
 * Candidates are handwritten; no model is called. The browser drives the beginner pages; the only direct API calls
 * are reads used as evidence and one labelled test-data preparation (a second project for the switching check).
 * Network faults are injected with route.abort on one request; nothing else is mocked.
 * It initializes only the dedicated, empty database named below, applying the existing migrations only.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const apiRequire = createRequire(join(root, "apps/api/package.json"));
const { createPostgresPool, closePostgresPool, runMigrations } = apiRequire("@ai-drama/database");
const { chromium } = createRequire(join(root, "package.json"))("playwright");

const DEDICATED_DATABASE = "ai_drama_beginner_web";
const workspaceId = process.env.APP_WORKSPACE_ID ?? "11111111-1111-4111-8111-111111111111";
// next build stores the /api/v1 rewrite to port 3001.
const apiOrigin = "http://127.0.0.1:3001";
const webOrigin = "http://127.0.0.1:3010";
const evidenceDir = join(root, "beginner-web-evidence");
const evidence = { steps: [], screenshots: [], requests: {} };

/** Handwritten story candidate. Not a model result. */
const storyPlan = {
  schema: "ads.writing.story-plan.v1",
  logline: "手写新手验收候选，不是模型结果",
  protagonistGoal: "守住班次记录",
  opposition: "店长能改时间",
  coreConflict: "解释会被当成承认",
  relationships: [{ name: "店员", pressure: "不能供出同事" }],
  episodes: [1, 2, 3].map((episodeNo) => ({ episodeNo, entryState: `进入${episodeNo}`, goal: `目标${episodeNo}`,
    action: `行动${episodeNo}`, turn: `转折${episodeNo}`, result: `结果${episodeNo}`, handoff: `交接${episodeNo}` })),
};

/** Handwritten episode candidate. Not a model result. */
const episodeDraft = {
  schema: "ads.writing.episode-draft.v1",
  episodeNo: 1,
  title: "夜班",
  screenplay: "店员把记录按在柜台上。店长：你自己看时间。",
  scenes: [{ heading: "店内", action: "她没有松手", dialogue: "店长：你自己看时间。", sound: "[SFX] 冰柜" }],
  handoffFacts: ["记录仍被按在柜台上"],
};

function step(name) {
  evidence.steps.push(name);
  console.log(`ok - ${name}`);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the beginner web acceptance`);
  return value;
}

async function assertDedicatedEmptyDatabase(pool) {
  if (process.env.BEGINNER_ACCEPTANCE_DATABASE !== DEDICATED_DATABASE) {
    throw new Error(`BEGINNER_ACCEPTANCE_DATABASE must be ${DEDICATED_DATABASE}`);
  }
  const current = String((await pool.query("SELECT current_database() AS name")).rows[0]?.name ?? "");
  if (current !== DEDICATED_DATABASE) throw new Error(`connected to ${current}; refusing to initialize anything else`);
  const tables = await pool.query(
    "SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'");
  if (tables.rows.length > 0) throw new Error(`${DEDICATED_DATABASE} already has tables; refusing to reset it`);
}

async function waitFor(check, label, timeoutMs = 60_000) {
  const started = Date.now();
  let last = "not started";
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await check();
      if (result === true) return;
      last = String(result);
    } catch (error) {
      last = error instanceof Error ? error.message : "failed";
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${label}: ${last}`);
}

function startProcess(command, args, env, cwd) {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  const append = (chunk) => { logs = `${logs}${chunk.toString()}`.slice(-8_000); };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return { child, logs: () => logs };
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

async function apiGet(path) {
  const response = await fetch(`${apiOrigin}/api/v1${path}`);
  if (!response.ok) throw new Error(`GET ${path} returned ${response.status}`);
  return response.json();
}

/** No horizontal page scroll, and the fixed bottom action never hides the end of the content. */
async function assertLayout(page, label) {
  const result = await page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const bar = [...document.querySelectorAll(".fixed.inset-x-0.bottom-0")].find((element) => getComputedStyle(element).position === "fixed");
    const main = document.querySelector("main");
    const padding = main ? Number.parseFloat(getComputedStyle(main).paddingBottom) : 0;
    return { overflow, barHeight: bar ? bar.getBoundingClientRect().height : 0, padding };
  });
  if (result.overflow > 1) throw new Error(`${label}: horizontal overflow ${result.overflow}px`);
  if (result.barHeight > result.padding + 1) throw new Error(`${label}: bottom action (${result.barHeight}px) covers content (padding ${result.padding}px)`);
  return result;
}

async function shot(page, name) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  const path = join(evidenceDir, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  evidence.screenshots.push(`${name}.png`);
}

async function importCandidate(page, candidate) {
  await page.getByRole("button", { name: "编剧助手" }).click();
  if (await page.getByLabel("题材").isVisible()) {
    await page.getByLabel("题材").fill("悬疑");
    await page.getByLabel("目标观众").fill("成人");
    await page.getByLabel("人物设定").fill("店员");
  }
  const confirm = page.getByRole("checkbox", { name: "确认使用当前已加载的故事与分集材料" });
  if (await confirm.count()) await confirm.check();
  await page.getByRole("button", { name: "准备创作指令" }).click();
  await page.getByLabel("创作指令").waitFor();
  await page.getByLabel("粘贴 JSON 候选").fill(JSON.stringify(candidate));
  await page.getByRole("button", { name: "校验并预览" }).click();
  await page.getByLabel("候选正文").waitFor();
  await page.getByRole("button", { name: "采纳到草稿" }).click();
  await page.getByText("已放入编辑草稿。还没有保存，请使用原来的保存新版本。").waitFor();
}

/** Review through the version column on the beginner page: 提交审核, then 通过. */
async function reviewThroughPage(page, label) {
  const inspect = page.getByRole("complementary", { name: "检查面板" }).first();
  const submit = inspect.getByRole("button", { name: "提交审核", exact: true });
  await submit.waitFor();
  const firstReview = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/review"));
  await submit.click();
  if ((await firstReview).status() !== 200) throw new Error(`${label}: 提交审核 failed`);
  const approve = inspect.getByRole("button", { name: "通过", exact: true });
  await approve.waitFor();
  const secondReview = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/review"));
  await approve.click();
  if ((await secondReview).status() !== 200) throw new Error(`${label}: 通过 failed`);
}

async function main() {
  const databaseUrl = requireEnv("DATABASE_URL");
  const redisUrl = requireEnv("REDIS_URL");
  await mkdir(evidenceDir, { recursive: true });
  const pool = createPostgresPool({ connectionString: databaseUrl, connectionTimeoutMs: 2_000, statementTimeoutMs: 10_000, queryTimeoutMs: 10_000 });
  const apiEnv = { ...process.env, DATABASE_URL: databaseUrl, REDIS_URL: redisUrl, S3_ENDPOINT: "http://127.0.0.1:59000",
    S3_REGION: "us-east-1", S3_BUCKET: "ai-drama-dev", S3_ACCESS_KEY_ID: "test", S3_SECRET_ACCESS_KEY: "test",
    APP_WORKSPACE_ID: workspaceId, API_PORT: "3001", BIND_HOST: "127.0.0.1" };
  let api;
  let web;
  let browser;
  try {
    await assertDedicatedEmptyDatabase(pool);
    await runMigrations(pool);
    await pool.query("INSERT INTO workspace (id, name, status) VALUES ($1, 'configured', 'ACTIVE')", [workspaceId]);
    const nextBin = createRequire(join(root, "apps/web/package.json")).resolve("next/dist/bin/next");
    api = startProcess(process.execPath, ["dist/main.js"], apiEnv, join(root, "apps/api"));
    web = startProcess(process.execPath, [nextBin, "start", "--hostname", "127.0.0.1", "--port", "3010"],
      { ...process.env, NEXT_PUBLIC_API_BASE_URL: apiOrigin }, join(root, "apps/web"));
    await waitFor(async () => (await fetch(`${apiOrigin}/api/v1/health/live`)).ok || "api not live", "API");
    await waitFor(async () => (await fetch(webOrigin)).ok || "web not up", "web");
    if (!(await fetch(`${webOrigin}/api/v1/health/live`)).ok) throw new Error("web /api/v1 rewrite did not reach the API");

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("pageerror", (error) => consoleErrors.push(error.message));

    // 1. Home: idea input and inspiration entry; nothing is created by browsing.
    await page.goto(`${webOrigin}/`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "你的故事，从一句话开始" }).waitFor();
    await page.getByRole("link", { name: "还没想法？看看灵感" }).click();
    await page.waitForURL(`${webOrigin}/categories`);
    await page.goto(`${webOrigin}/create`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "示例 · 都市悬疑" }).click();
    const before = await apiGet("/projects");
    if (before.items.length !== 0) throw new Error("browsing or choosing a template created a project");
    step("home idea input, inspiration link and template do not create a project");
    await shot(page, "01-create-1440");

    // 2. Create through the page; the first POST is cut off by the network, the retry keeps the same key.
    const projectPosts = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/projects") {
        projectPosts.push(request.headers()["idempotency-key"]);
      }
    });
    await page.getByRole("button", { name: "开始构思" }).click();
    await page.getByLabel("作品名称").fill("新手验收作品");
    let aborted = false;
    await page.route("**/api/v1/projects", async (route) => {
      if (route.request().method() === "POST" && !aborted) {
        aborted = true;
        await route.abort("connectionreset");
        return;
      }
      await route.fallback();
    });
    await page.getByRole("button", { name: "确认创建作品" }).click();
    await page.getByRole("alert").filter({ hasText: "没有确认作品是否已创建" }).waitFor();
    await page.unroute("**/api/v1/projects");
    await page.getByRole("button", { name: "确认创建作品" }).click();
    await page.waitForURL(/\/projects\/[0-9a-f-]+\/create/);
    const projectId = new URL(page.url()).pathname.split("/")[2];
    const afterCreate = await apiGet("/projects");
    if (afterCreate.items.length !== 1 || afterCreate.items[0].title !== "新手验收作品") throw new Error("create did not yield exactly one project");
    if (projectPosts.length < 2 || new Set(projectPosts).size !== 1) throw new Error(`retry changed the idempotency key: ${projectPosts.join(",")}`);
    evidence.requests.createKeys = projectPosts.length;
    step("create through the page; a cut-off first request is retried with the same key and creates one project");

    // 3. Step 1 定故事: import, compare, adopt, save, then review on the shown version.
    await page.getByRole("heading", { name: "第 1 步 · 定故事" }).waitFor();
    await importCandidate(page, storyPlan);
    const storySave = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith(`/projects/${projectId}/stories`));
    await page.getByRole("button", { name: "保存新版本", exact: true }).first().click();
    if ((await storySave).status() !== 201) throw new Error("story save failed");
    await page.getByText("保存状态：服务器已保存").waitFor();
    await page.getByRole("button", { name: "检查并确认当前版本" }).waitFor();
    await shot(page, "02-step1-saved-1440");
    await reviewThroughPage(page, "story");
    await page.getByRole("button", { name: "继续下一步" }).waitFor();
    const stories = await apiGet(`/projects/${projectId}/stories`);
    if (stories.items[0]?.reviewStatus !== "APPROVED") throw new Error("story is not approved on the server");
    step("step 1: candidate imported, adopted, saved as a new version and approved through the page");

    // 4. Step 2 看剧本: adopt an episode draft, switch to 高级编辑 and back without losing it, then save and approve.
    await page.getByRole("button", { name: "继续下一步" }).click();
    await page.getByRole("heading", { name: "第 2 步 · 看剧本" }).waitFor();
    await page.getByRole("tab", { name: /第 1 集/ }).click();
    await importCandidate(page, episodeDraft);
    await page.getByText(/保存状态：有未保存修改/).waitFor();
    const draftText = await page.getByLabel("正文").first().inputValue();
    await page.getByRole("link", { name: "高级编辑" }).click();
    await page.waitForURL(/focus=script&episode=1/);
    await page.getByRole("button", { name: "编剧助手" }).waitFor();
    if ((await page.getByLabel("正文").first().inputValue()) !== draftText) throw new Error("advanced editor lost the beginner draft");
    await page.getByRole("link", { name: "新手模式" }).click();
    await page.waitForURL(/\/create/);
    await page.getByRole("heading", { name: /第 \d 步/ }).waitFor();
    if (!page.url().includes("step=")) throw new Error("beginner flow lost its step");
    await page.getByRole("button", { name: /看剧本/ }).first().click();
    await page.getByRole("tab", { name: /第 1 集/ }).click();
    await waitFor(async () => (await page.getByLabel("正文").first().inputValue()) === draftText || "draft not restored", "draft back in beginner", 15_000);
    step("beginner ↔ advanced switch keeps the unsaved episode draft");
    const scriptSave = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/scripts"));
    await page.getByRole("button", { name: "保存新版本", exact: true }).first().click();
    if ((await scriptSave).status() !== 201) throw new Error("script save failed");
    await reviewThroughPage(page, "episode 1 script");
    await page.getByRole("tab", { name: /第 1 集 · ✓ 已完成/ }).waitFor();
    step("step 2: episode 1 draft saved and approved; other episodes untouched");
    const episodes = await apiGet(`/projects/${projectId}/episodes`);
    const others = episodes.items.filter((item) => item.episodeNo !== 1);
    if (others.some((item) => item.currentScriptRevisionId !== null)) throw new Error("other episodes were changed");

    // 5. Refresh keeps the step; the next steps say what is missing.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "第 2 步 · 看剧本" }).waitFor();
    await page.getByRole("button", { name: /试一段/ }).first().click();
    await page.getByRole("heading", { name: "第 4 步 · 试一段" }).waitFor();
    await page.getByText(/演示视频约 1 秒/).waitFor();
    await page.getByText("这一集还没有场景。场景和镜头是单独的记录，需要先建立：").waitFor();
    // This acceptance runs with local compose off (the default): the page must say so, not fail or fake a sample.
    await page.getByText(/当前环境没有开启本地合成/).waitFor();
    step("refresh keeps the step; 试一段 explains demo media and the missing scenes");

    // 6. My works shows the real stage.
    await page.goto(`${webOrigin}/studio`, { waitUntil: "domcontentloaded" });
    await page.getByText(/当前阶段：第 2 步 看剧本/).waitFor();
    step("my works names the real stage (episodes 2 and 3 still need scripts)");
    await shot(page, "03-studio-1440");

    // 7. Project switching: a second project (test data prepared through the API) shows its own content.
    const second = await fetch(`${apiOrigin}/api/v1/projects`, { method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "beginner-web-second" },
      body: JSON.stringify({ title: "第二部作品", premise: "测试数据：通过 API 准备" }) });
    if (second.status !== 201) throw new Error("test-data project create failed");
    const secondProject = await second.json();
    await page.goto(`${webOrigin}/projects/${secondProject.id}/create`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "第二部作品" }).waitFor();
    await page.getByRole("heading", { name: "第 1 步 · 定故事" }).waitFor();
    await page.goBack({ waitUntil: "domcontentloaded" });
    await page.goto(`${webOrigin}/projects/${projectId}/create`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "新手验收作品" }).waitFor();
    step("switching projects shows each project's own title and step");

    // 8. 390px pages and an error state.
    await page.setViewportSize({ width: 390, height: 844 });
    for (const [path, name] of [["/", "04-home-390"], ["/studio", "05-studio-390"], [`/projects/${projectId}/create?step=story`, "06-step1-390"],
      [`/projects/${projectId}/create?step=script`, "07-step2-390"], [`/projects/${projectId}/create?step=sample`, "08-step4-390"],
      [`/projects/${projectId}/create?step=final`, "09-step5-390"], ["/help", "10-help-390"]]) {
      await page.goto(`${webOrigin}${path}`, { waitUntil: "domcontentloaded" });
      await page.locator("main").waitFor();
      await page.waitForLoadState("networkidle").catch(() => undefined);
      evidence.requests[name] = await assertLayout(page, name);
      await shot(page, name);
    }
    await page.goto(`${webOrigin}/projects/99999999-9999-4999-8999-999999999999/create`, { waitUntil: "domcontentloaded" });
    await page.getByRole("alert").filter({ hasText: "作品读取失败" }).waitFor();
    await shot(page, "11-error-390");
    step("390px pages have no horizontal overflow and the bottom action does not cover content; missing project shows an error");

    if (consoleErrors.length) throw new Error(`page errors: ${consoleErrors.join(" | ")}`);
    await writeFile(join(evidenceDir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log("beginner web acceptance passed");
  } catch (error) {
    if (api) console.error(api.logs());
    if (web) console.error(web.logs());
    await writeFile(join(evidenceDir, "evidence.json"), `${JSON.stringify({ ...evidence, failed: String(error) }, null, 2)}\n`).catch(() => undefined);
    throw error;
  } finally {
    if (browser) await browser.close();
    await stopProcess(web?.child);
    await stopProcess(api?.child);
    await closePostgresPool(pool);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "beginner web acceptance failed");
  process.exit(1);
});
