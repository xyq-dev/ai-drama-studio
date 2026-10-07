/**
 * Real Web + API + Worker + PostgreSQL + FFmpeg + Chrome acceptance for the beginner route (红果创作):
 * /create and /projects/[id]/create, steps 定故事 → 看剧本 → 定人物 → 试一段 → 出成片.
 *
 * Every key business action of the five steps is done by clicking the beginner pages. The advanced workbench is
 * opened once, only to check that an unsaved draft survives a beginner ↔ advanced switch; nothing is saved there.
 * Direct API calls are of two labelled kinds: reads used as evidence, and "prep" writes that create the second
 * shot composite step 5 needs (the first one is made through the page). Read-only SQL is used for evidence only.
 * A network cut is injected once with route.abort; nothing is answered with route.fulfill or a mocked fetch.
 *
 * It initializes only the dedicated, empty database named below with the existing migrations and the existing
 * provisioning commands. Mock media and local compose switches are turned on for these child processes only.
 */
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = join(import.meta.dirname, "..");
const apiRequire = createRequire(join(root, "apps/api/package.json"));
const { createPostgresPool, closePostgresPool, runMigrations } = apiRequire("@ai-drama/database");
const { chromium } = createRequire(join(root, "package.json"))("playwright");

const DEDICATED_DATABASE = "ai_drama_beginner_web";
const workspaceId = process.env.APP_WORKSPACE_ID ?? "11111111-1111-4111-8111-111111111111";
// next build stores the /api/v1 rewrite to port 3001.
const apiOrigin = "http://127.0.0.1:3001";
const webOrigin = "http://127.0.0.1:3010";
const workerOrigin = "http://127.0.0.1:3002";
const evidenceDir = join(root, "beginner-web-evidence");
const runToken = `${process.env.GITHUB_RUN_ID ?? Date.now()}-${process.env.GITHUB_RUN_ATTEMPT ?? "0"}`;
const scratch = join(process.env.RUNNER_TEMP ?? tmpdir(), `beginner-web-${runToken}`);
const mockDir = join(scratch, "mock-objects");
const composeWorkDir = join(scratch, "compose-work");
const composeObjectDir = join(scratch, "compose-objects");

/** Required stages. Anything not "passed" at the end fails the run. */
const REQUIRED = [
  "environment",
  "home-and-create",
  "step1-story",
  "step2-script",
  "compose-off-state",
  "step3-cast",
  "step4-sample",
  "step5-prep",
  "step5-final",
  "layout-390",
];
const results = Object.fromEntries(REQUIRED.map((name) => [name, { status: "missing" }]));
const evidence = { runToken, results, screenshots: [], prep: [], browser: [], checks: {} };

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

const procs = {};
let pool;
let page;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the beginner web acceptance`);
  return value;
}

async function stage(name, fn) {
  const started = Date.now();
  results[name] = { status: "running" };
  try {
    const detail = await fn();
    results[name] = { status: "passed", ms: Date.now() - started, detail: detail ?? null };
    console.log(`ok - ${name}`);
  } catch (error) {
    results[name] = { status: "failed", ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
    console.error(`not ok - ${name}: ${results[name].error}`);
    throw error;
  }
}

function browserDid(text) {
  evidence.browser.push(text);
}

function prepDid(text) {
  evidence.prep.push(text);
}

async function assertDedicatedEmptyDatabase() {
  if (process.env.BEGINNER_ACCEPTANCE_DATABASE !== DEDICATED_DATABASE) {
    throw new Error(`BEGINNER_ACCEPTANCE_DATABASE must be ${DEDICATED_DATABASE}`);
  }
  const current = String((await pool.query("SELECT current_database() AS name")).rows[0]?.name ?? "");
  if (current !== DEDICATED_DATABASE) throw new Error(`connected to ${current}; refusing to initialize anything else`);
  const tables = await pool.query(
    "SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'");
  if (tables.rows.length > 0) throw new Error(`${DEDICATED_DATABASE} already has tables; refusing to reset it`);
}

async function sql(text, params = []) {
  if (!/^\s*(select|with)\b/i.test(text)) throw new Error("acceptance SQL is read-only");
  return (await pool.query(text, params)).rows;
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
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`timed out waiting for ${label}: ${last}`);
}

function startProcess(name, args, env, cwd) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  const append = (chunk) => { logs = `${logs}${chunk.toString()}`.slice(-20_000); };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  procs[name] = { child, logs: () => logs };
}

async function stopProcess(name) {
  const child = procs[name]?.child;
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 8_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

function baseEnv(databaseUrl, redisUrl) {
  return { ...process.env, NODE_ENV: "development", DATABASE_URL: databaseUrl, REDIS_URL: redisUrl, BIND_HOST: "127.0.0.1",
    S3_ENDPOINT: "http://127.0.0.1:59000", S3_REGION: "us-east-1", S3_BUCKET: "ai-drama-dev", S3_ACCESS_KEY_ID: "test",
    S3_SECRET_ACCESS_KEY: "test", APP_WORKSPACE_ID: workspaceId, APP_WORKSPACE_NAME: "beginner acceptance",
    API_PORT: "3001", WORKER_HEALTH_PORT: "3002" };
}

/** Mock media and local compose for this isolated run only; product defaults stay off elsewhere. */
function mediaEnv(env) {
  return { ...env, M3_MOCK_IMAGE_ENABLED: "true", M3_MOCK_AV_ENABLED: "true", M4_LOCAL_COMPOSE_ENABLED: "true",
    M4_LOCAL_EPISODE_COMPOSE_ENABLED: "true", MOCK_OBJECT_DIR: mockDir, M4_COMPOSE_OBJECT_DIR: composeObjectDir,
    M4_COMPOSE_WORK_DIR: composeWorkDir, M4_COMPOSE_PYTHON: "python3" };
}

async function startApi(env) {
  startProcess("api", ["dist/main.js"], env, join(root, "apps/api"));
  await waitFor(async () => {
    const ready = await fetch(`${apiOrigin}/api/v1/health/ready`);
    const body = await ready.json();
    return (body?.dependencies?.postgres?.status === "ok" && body?.dependencies?.redis?.status === "ok")
      || `postgres ${body?.dependencies?.postgres?.status} redis ${body?.dependencies?.redis?.status}`;
  }, "API ready (postgres and redis)");
}

async function api(method, path, options = {}) {
  const headers = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers["idempotency-key"] = options.key ?? randomUUID();
  if (options.ifMatch !== undefined) headers["if-match"] = String(options.ifMatch);
  const response = await fetch(`${apiOrigin}/api/v1${path}`, { method, headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: AbortSignal.timeout(20_000) });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 300) }; }
  return { status: response.status, body };
}

function expect(response, status, label) {
  if (response.status !== status) throw new Error(`${label}: expected ${status}, got ${response.status} ${JSON.stringify(response.body).slice(0, 400)}`);
  return response.body;
}

async function pollJob(jobId, timeoutMs = 180_000) {
  let last = null;
  await waitFor(async () => {
    last = expect(await api("GET", `/generation-jobs/${jobId}`), 200, "job read");
    return ["SUCCEEDED", "FAILED", "CANCELED"].includes(last.state) || last.state;
  }, `job ${jobId}`, timeoutMs);
  return last;
}

/** Approve one revision through its review path: IN_REVIEW then APPROVED (prep only). */
async function approveByApi(path, rowVersion, label) {
  const submitted = expect(await api("POST", path, { ifMatch: rowVersion, body: { to: "IN_REVIEW", expectedReviewVersion: 1 } }), 200, label);
  return expect(await api("POST", path, { ifMatch: submitted.rowVersion,
    body: { to: "APPROVED", expectedReviewVersion: submitted.reviewVersion } }), 200, label);
}

async function counts() {
  const row = (await sql(`SELECT (SELECT count(*)::int FROM generation_job WHERE workspace_id = $1) AS jobs,
    (SELECT count(*)::int FROM cost_ledger WHERE workspace_id = $1) AS costs`, [workspaceId]))[0];
  return row;
}

async function assertLayout(label) {
  const result = await page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const bar = [...document.querySelectorAll(".fixed.inset-x-0.bottom-0")].find((element) => getComputedStyle(element).position === "fixed");
    const main = document.querySelector("main");
    const padding = main ? Number.parseFloat(getComputedStyle(main).paddingBottom) : 0;
    const button = bar?.querySelector("button");
    const rect = button?.getBoundingClientRect();
    return { overflow, barHeight: bar ? bar.getBoundingClientRect().height : 0, padding,
      primaryVisible: rect ? rect.bottom <= window.innerHeight + 1 && rect.width > 40 : null };
  });
  if (result.overflow > 1) throw new Error(`${label}: horizontal overflow ${result.overflow}px`);
  if (result.barHeight > result.padding + 1) throw new Error(`${label}: bottom action (${result.barHeight}px) covers content (padding ${result.padding}px)`);
  if (result.primaryVisible === false) throw new Error(`${label}: bottom primary action is not visible`);
  return result;
}

async function shot(name) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(evidenceDir, `${name}.png`), fullPage: true });
  evidence.screenshots.push(`${name}.png`);
}

async function importCandidate(candidate) {
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

function reviewResponse() {
  return page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/review"), { timeout: 20_000 });
}

/** 提交审核 then 通过 (or 退回 with a note) in one version column on the beginner page. */
async function reviewInColumn(column, decision, label, note) {
  const submit = column.getByRole("button", { name: "提交审核", exact: true });
  await submit.waitFor({ timeout: 20_000 });
  let response = reviewResponse();
  await submit.click();
  if ((await response).status() !== 200) throw new Error(`${label}: 提交审核 failed`);
  const final = column.getByRole("button", { name: decision === "APPROVED" ? "通过" : "退回", exact: true });
  await final.waitFor({ timeout: 20_000 });
  if (note) await column.getByLabel("备注").fill(note);
  response = reviewResponse();
  await final.click();
  if ((await response).status() !== 200) throw new Error(`${label}: ${decision} failed`);
}

function inspectColumns() {
  return page.getByRole("complementary", { name: "检查面板" });
}

async function playVideo(video, minWidth) {
  await video.waitFor({ state: "attached", timeout: 30_000 });
  await video.scrollIntoViewIfNeeded();
  const result = await video.evaluate(async (node) => {
    const media = node;
    media.muted = true;
    const once = (event, ms, message) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      media.addEventListener(event, () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    if (media.readyState < 1) await once("loadedmetadata", 20_000, "loadedmetadata timeout");
    if (media.readyState < 2) await once("loadeddata", 20_000, "decoded frame timeout");
    const source = new URL(media.currentSrc || media.src, location.href);
    await media.play();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("playback did not advance")), 20_000);
      const tick = () => { if (media.currentTime > 0.2) { clearTimeout(timer); resolve(); } };
      media.addEventListener("timeupdate", tick);
    });
    return { sameOrigin: source.origin === location.origin, path: source.pathname, width: media.videoWidth, height: media.videoHeight,
      duration: media.duration, currentTime: media.currentTime, readyState: media.readyState };
  });
  if (!result.sameOrigin || result.width < minWidth || !(result.currentTime > 0.2)) throw new Error(`playback ${JSON.stringify(result)}`);
  return result;
}

async function saveDownload(button, target) {
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), button.click()]);
  await download.saveAs(target);
}

async function stepButton(title) {
  await page.getByRole("navigation", { name: "创作步骤" }).getByRole("button", { name: new RegExp(title) }).click();
  await page.getByRole("heading", { name: new RegExp(`第 \\d 步 · ${title}`) }).waitFor({ timeout: 20_000 });
}

async function main() {
  const databaseUrl = requireEnv("DATABASE_URL");
  const redisUrl = requireEnv("REDIS_URL");
  await rm(evidenceDir, { recursive: true, force: true });
  await mkdir(evidenceDir, { recursive: true });
  for (const dir of [mockDir, composeWorkDir, composeObjectDir]) await mkdir(dir, { recursive: true });
  pool = createPostgresPool({ connectionString: databaseUrl, connectionTimeoutMs: 2_000, statementTimeoutMs: 10_000, queryTimeoutMs: 10_000 });
  const env = baseEnv(databaseUrl, redisUrl);
  let browser;
  const world = {};
  try {
    await stage("environment", async () => {
      await assertDedicatedEmptyDatabase();
      await runMigrations(pool);
      const provision = [];
      for (const command of ["workspace:provision", "mock-media:provision", "mock-av:provision"]) {
        // The provisioning commands refuse unless the matching Mock switch is on, as in the M4 harness.
        const { stdout } = await execFileAsync("pnpm", ["--filter", "@ai-drama/database", command], { cwd: root, env: mediaEnv(env) });
        provision.push(`${command}: ${stdout.trim().split("\n").at(-1)}`);
      }
      const ffmpeg = (await execFileAsync("ffmpeg", ["-version"])).stdout.split("\n")[0];
      // API first without the compose switches: step 4 must report compose as off, not fail.
      await startApi(env);
      // The existing compose hold keeps attempt 1 RUNNING for a few seconds before commit (well under the 30 s
      // lease), so step 5 can reopen the page while the episode compose is really still running.
      startProcess("worker", ["dist/main.js"], { ...mediaEnv(env), M4_COMPOSE_HOLD_BEFORE_COMMIT_MS: "8000" }, join(root, "apps/worker"));
      await waitFor(async () => {
        const body = await (await fetch(`${workerOrigin}/health/ready`)).json();
        return body?.dependencies?.queue?.status === "ok" || JSON.stringify(body).slice(0, 200);
      }, "worker ready (queue)");
      const nextBin = createRequire(join(root, "apps/web/package.json")).resolve("next/dist/bin/next");
      startProcess("web", [nextBin, "start", "--hostname", "127.0.0.1", "--port", "3010"],
        { ...process.env, NEXT_PUBLIC_API_BASE_URL: apiOrigin }, join(root, "apps/web"));
      await waitFor(async () => (await fetch(webOrigin)).ok || "web not up", "web");
      if (!(await fetch(`${webOrigin}/api/v1/health/live`)).ok) throw new Error("web /api/v1 rewrite did not reach the API");
      browser = await chromium.launch({ headless: true, channel: "chrome" });
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
      page = await context.newPage();
      page.on("pageerror", (error) => { evidence.checks.pageErrors = [...(evidence.checks.pageErrors ?? []), error.message]; });
      return { provision, ffmpeg, migrations: "existing only" };
    });

    await stage("home-and-create", async () => {
      await page.goto(`${webOrigin}/`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "你的故事，从一句话开始" }).waitFor();
      await page.getByRole("link", { name: "还没想法？看看灵感" }).click();
      await page.waitForURL(`${webOrigin}/categories`);
      await page.goto(`${webOrigin}/create`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "示例 · 都市悬疑" }).click();
      if ((await api("GET", "/projects")).body.items.length !== 0) throw new Error("browsing or choosing a template created a project");
      await shot("01-create-1440");
      const keys = [];
      page.on("request", (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/projects") keys.push(request.headers()["idempotency-key"]);
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
      world.projectId = new URL(page.url()).pathname.split("/")[2];
      const projects = (await api("GET", "/projects")).body.items;
      if (projects.length !== 1 || projects[0].title !== "新手验收作品") throw new Error("create did not yield exactly one project");
      if (keys.length < 2 || new Set(keys).size !== 1) throw new Error(`retry changed the idempotency key: ${keys.join(",")}`);
      browserDid("created the work on /create; a cut-off first POST was retried with the same key");
      return { projectId: world.projectId, posts: keys.length };
    });

    await stage("step1-story", async () => {
      await page.getByRole("heading", { name: "第 1 步 · 定故事" }).waitFor();
      await importCandidate(storyPlan);
      const save = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith(`/projects/${world.projectId}/stories`));
      await page.getByRole("button", { name: "保存新版本", exact: true }).first().click();
      if ((await save).status() !== 201) throw new Error("story save failed");
      await page.getByText("保存状态：服务器已保存").waitFor();
      await shot("02-step1-saved-1440");
      await reviewInColumn(inspectColumns().first(), "APPROVED", "story");
      await page.getByRole("button", { name: "继续下一步" }).waitFor();
      if ((await api("GET", `/projects/${world.projectId}/stories`)).body.items[0]?.reviewStatus !== "APPROVED") throw new Error("story not approved");
      browserDid("step 1: imported, adopted, saved and approved the story");
    });

    await stage("step2-script", async () => {
      await page.getByRole("button", { name: "继续下一步" }).click();
      await page.getByRole("heading", { name: "第 2 步 · 看剧本" }).waitFor();
      await page.getByRole("tab", { name: /第 1 集/ }).click();
      await importCandidate(episodeDraft);
      await page.getByText(/保存状态：有未保存修改/).waitFor();
      const draftText = await page.getByLabel("正文").first().inputValue();
      // The advanced page is only opened to see the draft survive; nothing is saved there.
      await page.getByRole("link", { name: "高级编辑" }).click();
      await page.waitForURL(/focus=script&episode=1/);
      await page.getByRole("button", { name: "编剧助手" }).waitFor();
      if ((await page.getByLabel("正文").first().inputValue()) !== draftText) throw new Error("advanced editor lost the beginner draft");
      await page.getByRole("link", { name: "新手模式" }).click();
      await page.waitForURL(/\/create/);
      await stepButton("看剧本");
      await page.getByRole("tab", { name: /第 1 集/ }).click();
      await waitFor(async () => (await page.getByLabel("正文").first().inputValue()) === draftText || "draft not restored", "draft back", 15_000);
      const save = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/scripts"));
      await page.getByRole("button", { name: "保存新版本", exact: true }).first().click();
      if ((await save).status() !== 201) throw new Error("script save failed");
      await reviewInColumn(inspectColumns().first(), "APPROVED", "episode 1 script");
      await page.getByRole("tab", { name: /第 1 集 · ✓ 已完成/ }).waitFor();
      const episodes = (await api("GET", `/projects/${world.projectId}/episodes`)).body.items;
      world.episode = episodes.find((item) => item.episodeNo === 1);
      if (episodes.some((item) => item.episodeNo !== 1 && item.currentScriptRevisionId !== null)) throw new Error("other episodes changed");
      // The scene is a separate record: create it with the scene form on this step.
      await page.locator("#scene-heading").fill("店内 夜");
      await page.locator("#scene-summary").fill("店员和店长在柜台前对峙");
      const sceneSave = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/scenes"));
      await page.locator("form", { has: page.locator("#scene-heading") }).getByRole("button", { name: "保存新版本" }).click();
      if ((await sceneSave).status() !== 201) throw new Error("scene save failed");
      const scenes = (await api("GET", `/projects/${world.projectId}/episodes/${world.episode.id}/scenes`)).body.items;
      if (scenes.length !== 1) throw new Error(`expected one scene, got ${scenes.length}`);
      world.sceneId = scenes[0].entityId;
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "第 2 步 · 看剧本" }).waitFor();
      browserDid("step 2: episode 1 draft survived the advanced switch, was saved and approved; scene created from the page");
    });

    await stage("compose-off-state", async () => {
      // Episode compose is off on this API: step 5 says so per its own switch, and nothing is called done.
      await stepButton("出成片");
      await page.getByText(/当前环境没有开启集级合成/).waitFor({ timeout: 20_000 });
      await page.getByRole("tab", { name: /第 1 集 · — 尚未确认/ }).waitFor({ timeout: 20_000 });
      if (await page.getByRole("button", { name: "查看并下载成片" }).count()) throw new Error("compose-off final step claimed done");
      await stepButton("试一段");
      if (await page.getByRole("button", { name: "继续下一步" }).count()) throw new Error("compose-off sample step offered 继续下一步");
      if (await page.getByRole("button", { name: /第 4 步 试一段：已完成/ }).count()) throw new Error("sample marked done");
      await page.goto(`${webOrigin}/studio`, { waitUntil: "domcontentloaded" });
      await page.getByText(/当前阶段：第 2 步 看剧本/).waitFor();
      if (await page.getByText(/进度读取失败/).count()) throw new Error("compose-off made the work unreadable");
      await shot("03-compose-off-studio-1440");
      // Restart the API with the compose switches for the rest of the run.
      await stopProcess("api");
      await startApi(mediaEnv(env));
      return { message: "当前环境没有开启集级合成", episode1: "尚未确认", studioStage: "第 2 步 看剧本" };
    });

    await stage("step3-cast", async () => {
      await page.goto(`${webOrigin}/projects/${world.projectId}/create?step=cast`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "第 3 步 · 定人物" }).waitFor();
      const newForm = page.locator("form", { has: page.locator("#entity-name") });
      for (const [name, text] of [["林晓", "夜班店员，二十五岁，说话很慢"], ["王店长", "店长，四十岁，习惯改记录"]]) {
        await page.locator("#entity-name").fill(name);
        await page.locator("#entity-text").fill(text);
        const created = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/characters"));
        await newForm.getByRole("button", { name: "保存新版本" }).click();
        if ((await created).status() !== 201) throw new Error(`character ${name} not created`);
      }
      const characters = (await api("GET", `/projects/${world.projectId}/characters`)).body.items;
      if (characters.length !== 2) throw new Error(`expected 2 characters, got ${characters.length}`);
      const [first, second] = characters;
      // Switch objects: the opened character's editor must show that character, not the previous one.
      const open = async (entity) => {
        await page.getByRole("button", { name: new RegExp(`^${entity.entityId.slice(0, 8)}`) }).click();
        const history = (await api("GET", `/projects/${world.projectId}/characters/${entity.entityId}/revisions`)).body;
        const text = history.items.find((item) => item.id === history.aggregate.currentRevisionId)?.content?.text ?? "";
        await waitFor(async () => (await page.getByLabel("正文").first().inputValue()).includes(text.slice(0, 6)) || "editor shows another object", "object switch", 15_000);
        return text;
      };
      await open(second);
      const firstText = await open(first);
      // Unsaved vs saved: an edit is first a tab draft, then a new server version after save.
      await page.getByLabel("正文").first().fill(`${firstText}；左手腕有旧伤`);
      await page.getByText(/保存状态：有未保存修改/).waitFor();
      const save = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes(`/characters/${first.entityId}/revisions`));
      await page.getByRole("button", { name: "保存新版本", exact: true }).first().click();
      const saved = await save;
      if (saved.status() !== 201) throw new Error("character edit not saved");
      if (saved.request().headers()["if-match"] === undefined) throw new Error("character save sent no If-Match");
      await page.getByText("保存状态：服务器已保存").waitFor();
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "第 3 步 · 定人物" }).waitFor();
      await page.getByRole("button", { name: new RegExp(`^${first.entityId.slice(0, 8)}`) }).click();
      await waitFor(async () => (await page.getByLabel("正文").first().inputValue()).includes("左手腕有旧伤") || "saved text not reread", "reread", 15_000);
      await reviewInColumn(inspectColumns().first(), "APPROVED", "character 1");
      // The reference image storage is the unapplied draft: the panel must say so and offer nothing.
      await page.getByRole("region", { name: "角色参考图" }).getByText(/参考图存储尚未启用/).waitFor({ timeout: 20_000 });
      if (await page.getByRole("button", { name: "为当前版本生成参考图" }).count()) throw new Error("reference generation offered without storage");
      await page.getByRole("button", { name: new RegExp(`^${second.entityId.slice(0, 8)}`) }).click();
      await reviewInColumn(inspectColumns().first(), "APPROVED", "character 2");
      // A location, returned with a note through the same review flow.
      await page.getByRole("tab", { name: /场地/ }).click();
      await page.locator("#entity-name").fill("便利店");
      await page.locator("#entity-text").fill("二十四小时便利店，冰柜嗡嗡响");
      const location = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/locations"));
      await newForm.getByRole("button", { name: "保存新版本" }).click();
      if ((await location).status() !== 201) throw new Error("location not created");
      const locations = (await api("GET", `/projects/${world.projectId}/locations`)).body.items;
      await page.getByRole("button", { name: new RegExp(`^${locations[0].entityId.slice(0, 8)}`) }).click();
      await reviewInColumn(inspectColumns().first(), "REJECTED", "location", "灯光描述不够具体");
      const rejected = (await api("GET", `/projects/${world.projectId}/locations`)).body.items[0];
      if (rejected.currentRevision?.reviewStatus !== "REJECTED") throw new Error(`location review ${rejected.currentRevision?.reviewStatus}`);
      await page.getByRole("tab", { name: /场地 · 0\/1 已确认/ }).waitFor();
      await page.getByRole("tab", { name: /角色/ }).click();
      await page.getByRole("tab", { name: /角色 · 2\/2 已确认/ }).waitFor();
      await shot("04-step3-1440");
      // Next and back keep the state.
      await stepButton("试一段");
      await stepButton("定人物");
      await page.getByRole("tab", { name: /角色 · 2\/2 已确认/ }).waitFor();
      const after = (await api("GET", `/projects/${world.projectId}/characters`)).body.items;
      if (after.some((item) => item.currentRevision?.reviewStatus !== "APPROVED")) throw new Error("characters not approved on the server");
      browserDid("step 3: two characters created, one edited (draft → saved → reread), both approved; a location created and returned with a note; reference images shown as unavailable");
      return { characters: after.length, locationReview: "REJECTED", referenceImages: "unavailable (draft not applied) — not accepted" };
    });

    await stage("step4-sample", async () => {
      await stepButton("试一段");
      await page.getByText(/演示视频约 1 秒/).waitFor();
      if (await page.getByText(/当前环境没有开启/).count()) throw new Error("compose still reported off after enabling it");
      const picker = page.locator("[data-beginner-picker]");
      await picker.getByRole("button", { name: /场景 1/ }).click();
      // Approve the scene shown, then create the shot under it.
      await page.locator("#new-shot-action").waitFor({ timeout: 20_000 });
      await reviewInColumn(inspectColumns().first(), "APPROVED", "scene");
      await page.locator("#new-shot-action").fill("店员把记录按在柜台上");
      await page.locator("#new-shot-prompt").fill("fixed black frame for audit");
      const shotSave = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/shots"));
      await page.locator("form", { has: page.locator("#new-shot-action") }).getByRole("button", { name: "保存新版本" }).click();
      if ((await shotSave).status() !== 201) throw new Error("shot save failed");
      const shots = (await api("GET", `/projects/${world.projectId}/episodes/${world.episode.id}/scenes/${world.sceneId}/shots`)).body.items;
      world.shot1 = shots[0];
      await page.getByRole("button", { name: `镜头 ${world.shot1.entityId.slice(0, 8)}` }).click();
      await page.locator("#shot-action").waitFor({ timeout: 20_000 });
      await reviewInColumn(inspectColumns().nth(1), "APPROVED", "shot 1");
      const shotHistory = (await api("GET", `/projects/${world.projectId}/episodes/${world.episode.id}/scenes/${world.sceneId}/shots/${world.shot1.entityId}/revisions`)).body;
      world.shot1Revision = shotHistory.aggregate.currentRevisionId;
      // Mock video through the page; 202 is only acceptance, the worker finishes it.
      const video = page.getByRole("button", { name: "生成 Mock 视频", exact: true });
      await video.waitFor({ timeout: 30_000 });
      const videoResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes(`/shot-revisions/${world.shot1Revision}/generate-video`));
      await video.click();
      const accepted = await videoResponse;
      if (accepted.status() !== 202) throw new Error(`video not accepted: ${accepted.status()}`);
      await page.getByText("已受理，结果以任务和视频列表为准。这不是生成成功。").waitFor({ timeout: 20_000 });
      const videoJob = await pollJob((await accepted.json()).jobId, 120_000);
      if (videoJob.state !== "SUCCEEDED") throw new Error(`video job ${videoJob.state} ${videoJob.errorCode ?? ""}`);
      const videoAsset = (await sql("SELECT id::text AS id FROM asset WHERE source_generation_job_id = $1 AND kind = 'VIDEO'", [videoJob.id]))[0];
      // Single-shot preflight and real FFmpeg compose through the page.
      const panel = page.getByRole("region", { name: "Mock 单镜合成预检" });
      await waitFor(async () => (await panel.locator(`#compose-video option[value="${videoAsset.id}"]`).count()) > 0
        || "video not offered yet", "video in compose select", 60_000);
      await panel.locator("#compose-video").selectOption(videoAsset.id);
      const preflight = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes(`/shot-revisions/${world.shot1Revision}/compose-preflight`));
      await panel.getByRole("button", { name: "预检合成输入" }).click();
      if ((await preflight).status() !== 200) throw new Error("single-shot preflight failed");
      await panel.getByText("合成尚未执行").waitFor({ timeout: 20_000 });
      const composeResponse = page.waitForResponse((response) => response.request().method() === "POST"
        && response.url().endsWith(`/shot-revisions/${world.shot1Revision}/compose`));
      await panel.getByRole("button", { name: "开始合成" }).click();
      const composeAccepted = await composeResponse;
      if (composeAccepted.status() !== 202) throw new Error(`compose not accepted: ${composeAccepted.status()}`);
      await panel.getByText("合成任务已受理").waitFor({ timeout: 20_000 });
      const composeJob = await pollJob((await composeAccepted.json()).jobId, 240_000);
      if (composeJob.state !== "SUCCEEDED") throw new Error(`compose ${composeJob.state} ${composeJob.errorCode ?? ""} ${composeJob.errorMessage ?? ""}`);
      const composite = (await sql(`SELECT id::text AS id, project_id::text AS project_id, checksum_sha256, review_status, status, kind
        FROM asset WHERE source_generation_job_id = $1`, [composeJob.id]))[0];
      if (composite?.kind !== "COMPOSITE" || composite.project_id !== world.projectId || composite.review_status !== "DRAFT") {
        throw new Error(`composite ${JSON.stringify(composite)}`);
      }
      const card = panel.locator(`[data-composite-id="${composite.id}"]`);
      const playback = await playVideo(card.locator("video"), 1000);
      await shot("05-step4-composed-1440");
      // From here on the page must update in place: a reload would clear this marker.
      await page.evaluate(() => { window.__beginnerNoReload = "step4"; });
      if (await page.getByRole("tab", { name: /第 1 集 · ✓ 已完成/ }).count()) throw new Error("sample shown done before approval");
      const review = reviewResponse();
      await card.getByRole("button", { name: "批准成片" }).click();
      if ((await review).status() !== 200) throw new Error("composite approval failed");
      const approved = (await sql("SELECT review_status, reviewed_content_hash, checksum_sha256 FROM asset WHERE id = $1", [composite.id]))[0];
      if (approved.review_status !== "APPROVED" || approved.reviewed_content_hash !== approved.checksum_sha256) throw new Error(`approval ${JSON.stringify(approved)}`);
      world.composite1 = composite.id;
      // No reload: the approval notifies the page, which rereads its facts in place.
      await page.getByRole("tab", { name: /第 1 集 · ✓ 已完成/ }).waitFor({ timeout: 30_000 });
      await page.getByRole("button", { name: /第 4 步 试一段：已完成/ }).waitFor({ timeout: 10_000 });
      await page.getByRole("button", { name: "继续下一步" }).waitFor({ timeout: 10_000 });
      if (await page.evaluate(() => window.__beginnerNoReload) !== "step4") throw new Error("the page reloaded");
      browserDid("step 4: scene approved, shot created and approved, Mock video generated (worker), single-shot preflight and FFmpeg compose submitted, composite played and approved — all on the beginner page");
      return { videoJob: videoJob.id, composeJob: composeJob.id, composite: composite.id, playback };
    });

    await stage("step5-prep", async () => {
      // PREP through the real API (not a page action): a second approved single-shot composite in the same episode.
      const sceneHistory = expect(await api("GET", `/projects/${world.projectId}/episodes/${world.episode.id}/scenes/${world.sceneId}/revisions`), 200, "scene read");
      const created = expect(await api("POST", `/projects/${world.projectId}/episodes/${world.episode.id}/scenes/${world.sceneId}/shots`, {
        ifMatch: sceneHistory.aggregate.rowVersion,
        body: { sourceSceneRevisionId: sceneHistory.aggregate.currentRevisionId, ordinal: 2, shotType: "wide", camera: "static",
          action: "店长伸手去拿记录", promptText: "fixed black frame for audit", dialogue: "店长：给我。" },
      }), 201, "prep shot 2");
      await approveByApi(`/projects/${world.projectId}/episodes/${world.episode.id}/scenes/${world.sceneId}/shots/${created.entityId}/revisions/${created.revisionId}/review`,
        created.rowVersion, "prep shot 2 review");
      const video = expect(await api("POST", `/shot-revisions/${created.revisionId}/generate-video`, { body: { seed: "beginner-prep-2" } }), 202, "prep video");
      const videoJob = await pollJob(video.jobId, 120_000);
      if (videoJob.state !== "SUCCEEDED") throw new Error(`prep video ${videoJob.state}`);
      const videoId = (await sql("SELECT id::text AS id FROM asset WHERE source_generation_job_id = $1", [videoJob.id]))[0].id;
      const pre = expect(await api("POST", `/shot-revisions/${created.revisionId}/compose-preflight`, { body: { videoAssetId: videoId } }), 200, "prep preflight");
      const compose = expect(await api("POST", `/shot-revisions/${created.revisionId}/compose`, {
        body: { videoAssetId: videoId, expectedInputHash: pre.inputHash } }), 202, "prep compose");
      const composeJob = await pollJob(compose.jobId, 240_000);
      if (composeJob.state !== "SUCCEEDED") throw new Error(`prep compose ${composeJob.state} ${composeJob.errorCode ?? ""}`);
      const asset = (await sql("SELECT id::text AS id, row_version, checksum_sha256 FROM asset WHERE source_generation_job_id = $1", [composeJob.id]))[0];
      expect(await api("POST", `/assets/${asset.id}/review`, { ifMatch: Number(asset.row_version),
        body: { decision: "APPROVE", note: "prep", contentHash: asset.checksum_sha256 } }), 200, "prep composite review");
      world.composite2 = asset.id;
      prepDid("API: shot 2 created and approved, Mock video generated, single-shot preflight + compose (worker FFmpeg), composite approved");
      return { shot: created.entityId, composite: asset.id };
    });

    await stage("step5-final", async () => {
      await stepButton("出成片");
      await page.getByRole("tab", { name: /第 1 集/ }).click();
      const panel = page.getByRole("region", { name: "多镜编排" });
      await panel.getByRole("heading", { name: "多镜编排" }).waitFor({ timeout: 30_000 });
      for (const id of [world.composite1, world.composite2]) {
        await panel.locator(`[data-asset-id="${id}"]`).getByRole("button", { name: "加入" }).click({ timeout: 30_000 });
      }
      // Reorder: the second composite moves up, so the frozen order is [composite2, composite1].
      await panel.locator(`[data-selected-asset-id="${world.composite2}"]`).getByRole("button", { name: "上移" }).click();
      const preflightResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/compose-preflight"));
      await panel.getByRole("button", { name: "预检编排" }).click();
      const preflight = await preflightResponse;
      if (preflight.status() !== 200) throw new Error(`episode preflight ${preflight.status()}`);
      const preflightBody = await preflight.json();
      await panel.getByText("预检通过，尚未执行多镜合成").waitFor({ timeout: 20_000 });
      const before = await counts();
      const composeResponse = page.waitForResponse((response) => response.request().method() === "POST"
        && response.url().endsWith(`/episodes/${world.episode.id}/compose`));
      await panel.getByRole("button", { name: "开始多镜合成" }).click();
      const accepted = await composeResponse;
      if (accepted.status() !== 202) throw new Error(`episode compose not accepted ${accepted.status()}`);
      const acceptedJobId = (await accepted.json()).jobId;
      // Recovery: leave and reopen the step while the compose is still RUNNING. The reopened page did not submit
      // the job, so only its own run tracking can notice the end.
      await page.goto(`${webOrigin}/projects/${world.projectId}/create?step=final`, { waitUntil: "domcontentloaded" });
      await page.getByRole("tab", { name: /第 1 集 · … 处理中/ }).waitFor({ timeout: 20_000 });
      const stateOnEntry = expect(await api("GET", `/generation-jobs/${acceptedJobId}`), 200, "job read").state;
      if (!["QUEUED", "RUNNING"].includes(stateOnEntry)) throw new Error(`compose already ${stateOnEntry} when the page reopened`);
      await page.evaluate(() => { window.__beginnerResume = "reopened"; });
      // Only episode 1 is composing: episodes 2 and 3 must never show 处理中 while it runs.
      const tabTexts = async () => Promise.all([2, 3].map((no) => page.getByRole("tab", { name: new RegExp(`第 ${no} 集`) }).innerText()));
      const whileRunning = await tabTexts();
      if (whileRunning.some((text) => text.includes("处理中"))) throw new Error(`other episodes shown as running: ${whileRunning.join(" | ")}`);
      // No click, no tab switch, no reload: the reopened page itself sees the compose finish.
      await page.getByRole("tab", { name: /第 1 集 · ？ 待确认/ }).waitFor({ timeout: 120_000 });
      if (await page.evaluate(() => window.__beginnerResume) !== "reopened") throw new Error("the reopened page was reloaded");
      evidence.checks.resume = { stateOnEntry, updatedWithoutReload: true };
      const job = await pollJob(acceptedJobId, 300_000);
      const afterRun = await tabTexts();
      if (afterRun.some((text) => text.includes("处理中"))) throw new Error(`other episodes shown as running: ${afterRun.join(" | ")}`);
      if (job.state !== "SUCCEEDED") throw new Error(`episode compose ${job.state} ${job.errorCode ?? ""} ${job.errorMessage ?? ""}`);
      const asset = (await sql(`SELECT a.id::text AS id, a.project_id::text AS project_id, a.checksum_sha256, a.byte_size, a.review_status,
          a.status, a.source_job_attempt_id::text AS attempt_id, j.project_id::text AS job_project, j.input_snapshot,
          t.generation_job_id::text AS attempt_job
        FROM asset a JOIN generation_job j ON j.id = a.source_generation_job_id
        JOIN job_attempt t ON t.id = a.source_job_attempt_id
        WHERE a.source_generation_job_id = $1`, [job.id]))[0];
      if (!asset || asset.project_id !== world.projectId || asset.job_project !== world.projectId || asset.attempt_job !== job.id) {
        throw new Error(`episode composite lineage ${JSON.stringify(asset)}`);
      }
      if (!JSON.stringify(asset.input_snapshot).includes(world.episode.id)) throw new Error("frozen input does not name this episode");
      const card = page.locator(`[data-composite-id="${asset.id}"]`);
      await card.waitFor({ timeout: 60_000 });
      // From here on, approval must update the page in place.
      await page.evaluate(() => { window.__beginnerNoReload = "step5"; });
      // Not approved yet: no download button, and the export route refuses.
      if (await card.getByRole("button", { name: "下载 MP4" }).count()) throw new Error("draft composite offered a download");
      const draftDownload = await api("GET", `/projects/${world.projectId}/episodes/${world.episode.id}/composites/${asset.id}/download?expectedContentHash=${asset.checksum_sha256}`);
      if (draftDownload.status === 200) throw new Error("draft composite was exportable");
      const playback = await playVideo(card.locator("video"), 1000);
      await shot("06-step5-composed-1440");
      const review = reviewResponse();
      await card.getByRole("button", { name: "批准成片" }).click();
      if ((await review).status() !== 200) throw new Error("episode composite approval failed");
      await card.getByRole("button", { name: "下载 MP4" }).waitFor({ timeout: 20_000 });
      const mp4Path = join(evidenceDir, "episode.mp4");
      const jsonPath = join(evidenceDir, "episode-manifest.json");
      const beforeDownloads = await counts();
      await saveDownload(card.getByRole("button", { name: "下载 MP4" }), mp4Path);
      await saveDownload(card.getByRole("button", { name: "下载来源清单" }), jsonPath);
      const afterDownloads = await counts();
      if (afterDownloads.jobs !== beforeDownloads.jobs || afterDownloads.costs !== beforeDownloads.costs) throw new Error("downloads created jobs or costs");
      const mp4 = await readFile(mp4Path);
      const manifest = JSON.parse(await readFile(jsonPath, "utf8"));
      const sha = createHash("sha256").update(mp4).digest("hex");
      const stored = (await sql("SELECT checksum_sha256, reviewed_content_hash, review_status, byte_size FROM asset WHERE id = $1", [asset.id]))[0];
      if (sha !== stored.checksum_sha256 || sha !== stored.reviewed_content_hash || mp4.length !== Number(stored.byte_size)) {
        throw new Error(`download ${sha}/${mp4.length} record ${stored.checksum_sha256}/${stored.reviewed_content_hash}/${stored.byte_size}`);
      }
      if (manifest.asset?.checksumSha256 !== sha || manifest.compose?.jobId !== job.id || manifest.compose?.attemptId !== asset.attempt_id) {
        throw new Error("manifest does not describe the downloaded asset and its job");
      }
      const order = manifest.segments.map((segment) => segment.shotAssetId);
      const frozen = (preflightBody.manifest?.segments ?? []).map((segment) => segment.assetId);
      if (order.join() !== [world.composite2, world.composite1].join() || (frozen.length && frozen.join() !== order.join())) {
        throw new Error(`segment order ${order.join()} preflight ${frozen.join()}`);
      }
      const probe = JSON.parse((await execFileAsync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", mp4Path])).stdout);
      // No reload: the approval notifies the page; episode 1 is done and the done step offers a real action.
      await page.getByRole("tab", { name: /第 1 集 · ✓ 已完成/ }).waitFor({ timeout: 30_000 });
      if (await page.evaluate(() => window.__beginnerNoReload) !== "step5") throw new Error("the page reloaded");
      for (const no of [2, 3]) {
        const text = await page.getByRole("tab", { name: new RegExp(`第 ${no} 集`) }).innerText();
        if (text.includes("处理中") || text.includes("已完成")) throw new Error(`episode ${no} misreported: ${text}`);
      }
      browserDid("step 5: chose two approved composites, moved one up, episode preflight, submitted episode compose (worker FFmpeg), played, approved, downloaded MP4 and manifest — all on the beginner page");
      return { job: job.id, asset: asset.id, sha256: sha, bytes: mp4.length, order, playback, jobsBefore: before.jobs,
        draftDownloadStatus: draftDownload.status, videoStream: probe.streams?.find((item) => item.codec_type === "video")?.codec_name,
        durationSeconds: Number(probe.format?.duration) };
    });

    await stage("layout-390", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      const layout = {};
      for (const [path, name] of [["/", "10-home-390"], ["/studio", "11-studio-390"],
        [`/projects/${world.projectId}/create?step=story`, "12-step1-390"], [`/projects/${world.projectId}/create?step=script`, "13-step2-390"],
        [`/projects/${world.projectId}/create?step=cast`, "14-step3-390"], [`/projects/${world.projectId}/create?step=sample`, "15-step4-390"],
        [`/projects/${world.projectId}/create?step=final`, "16-step5-390"], ["/help", "17-help-390"]]) {
        await page.goto(`${webOrigin}${path}`, { waitUntil: "domcontentloaded" });
        await page.locator("main").waitFor();
        await page.waitForLoadState("networkidle").catch(() => undefined);
        if (path.includes("step=final")) {
          await page.getByRole("tab", { name: /第 1 集/ }).click();
          await page.getByRole("region", { name: "多镜编排" }).waitFor({ timeout: 30_000 });
        }
        layout[name] = await assertLayout(name);
        await shot(name);
      }
      await page.goto(`${webOrigin}/projects/99999999-9999-4999-8999-999999999999/create`, { waitUntil: "domcontentloaded" });
      await page.getByRole("alert").filter({ hasText: "作品读取失败" }).waitFor();
      await shot("18-error-390");
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${webOrigin}/studio`, { waitUntil: "domcontentloaded" });
      await page.getByText(/当前阶段：第 2 步 看剧本/).waitFor();
      await shot("19-studio-final-1440");
      return layout;
    });

    if (evidence.checks.pageErrors?.length) throw new Error(`page errors: ${evidence.checks.pageErrors.join(" | ")}`);
  } finally {
    const failed = REQUIRED.filter((name) => results[name].status !== "passed");
    evidence.passed = failed.length === 0;
    evidence.notPassed = failed;
    await writeFile(join(evidenceDir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`).catch(() => undefined);
    for (const name of ["api", "worker", "web"]) {
      if (procs[name]) await writeFile(join(evidenceDir, `${name}.log`), procs[name].logs()).catch(() => undefined);
    }
    if (browser) await browser.close().catch(() => undefined);
    for (const name of ["web", "worker", "api"]) await stopProcess(name);
    await closePostgresPool(pool).catch(() => undefined);
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    if (failed.length) {
      console.error(`required stages not passed: ${failed.map((name) => `${name}=${results[name].status}`).join(", ")}`);
      process.exitCode = 1;
    } else {
      console.log("beginner web acceptance passed: all required stages");
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "beginner web acceptance failed");
  process.exitCode = 1;
});
