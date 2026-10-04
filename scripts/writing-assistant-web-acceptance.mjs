/**
 * real Web, API, and PostgreSQL acceptance for the writing assistant.
 * Story and episode candidates are handwritten. This script does not call a model.
 * It does not use route.fulfill or a mocked fetch. Existing business tables abort
 * initialization; this script does not reset them.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const apiRequire = createRequire(join(root, "apps/api/package.json"));
const { createPostgresPool, closePostgresPool, runMigrations } = apiRequire("@ai-drama/database");
const { formatStoryPlan, formatEpisodeDraft } = apiRequire("@ai-drama/domain");
const { assertEmptyWritingAcceptanceDatabase, WRITING_WEB_DATABASE } = apiRequire(
  join(root, "apps/api/dist/studio/writing-acceptance-database.js"),
);
const { chromium } = createRequire(join(root, "package.json"))("playwright");

const workspaceId = process.env.APP_WORKSPACE_ID ?? "11111111-1111-4111-8111-111111111111";
const apiPort = "3011";
const webPort = "3010";
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const webOrigin = `http://127.0.0.1:${webPort}`;

/** Handwritten story candidate. This is not a model result. */
const storyPlan = {
  schema: "ads.writing.story-plan.v1",
  logline: "手写网页验收候选，不是模型结果",
  protagonistGoal: "守住班次记录",
  opposition: "店长能改时间",
  coreConflict: "解释会被当成承认",
  relationships: [{ name: "店员", pressure: "不能供出同事" }],
  episodes: [1, 2, 3].map((episodeNo) => ({
    episodeNo,
    entryState: `进入${episodeNo}`,
    goal: `目标${episodeNo}`,
    action: `行动${episodeNo}`,
    turn: `转折${episodeNo}`,
    result: `结果${episodeNo}`,
    handoff: `交接${episodeNo}`,
  })),
};

/** Handwritten episode candidate. This is not a model result. */
const episodeDraft = {
  schema: "ads.writing.episode-draft.v1",
  episodeNo: 1,
  title: "夜班",
  screenplay: "店员把记录按在柜台上。店长：你自己看时间。",
  scenes: [{ heading: "店内", action: "她没有松手", dialogue: "店长：你自己看时间。", sound: "[SFX] 冰柜" }],
  handoffFacts: ["记录仍被按在柜台上"],
};

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the writing web acceptance`);
  return value;
}

async function waitForOk(url) {
  const started = Date.now();
  let last = "not started";
  while (Date.now() - started < 60_000) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      last = String(response.status);
    } catch (error) {
      last = error instanceof Error ? error.message : "fetch failed";
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${url}: ${last}`);
}

function startProcess(command, args, env, cwd) {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  const append = (chunk) => {
    logs = `${logs}${chunk.toString()}`.slice(-8_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return { child, logs: () => logs };
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function trackWrites(page) {
  const writes = [];
  page.on("request", (request) => {
    const method = request.method();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
    if (!request.url().includes("/api/v1/")) return;
    writes.push({ method, url: request.url(), ifMatch: request.headers()["if-match"] ?? null });
  });
  return writes;
}

async function assertOperable(page, editor) {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("missing viewport");
  const names = ["准备创作指令", "校验并预览", "采纳到草稿"];
  for (const name of names) {
    await assertButton(page.getByRole("button", { name, exact: true }), name, viewport);
  }
  await assertButton(editor.getByRole("button", { name: "保存新版本", exact: true }), "保存新版本", viewport);
}

async function assertButton(button, name, viewport) {
  await button.scrollIntoViewIfNeeded();
  const box = await button.boundingBox();
  if (!box || box.width < 8 || box.height < 8) throw new Error(`${name} is not operable`);
  if (box.x < -1 || box.y < -1 || box.x + box.width > viewport.width + 2 || box.y + box.height > viewport.height + 2) {
    throw new Error(`${name} is outside the ${viewport.width}px viewport`);
  }
  if (await button.isDisabled()) throw new Error(`${name} is disabled`);
}

async function importCandidate(page, editor, candidate) {
  await page.getByRole("button", { name: "编剧助手" }).click();
  if (await page.getByLabel("题材").isVisible()) {
    await page.getByLabel("题材").fill("悬疑");
    await page.getByLabel("目标观众").fill("成人");
    await page.getByLabel("人物设定").fill("店员");
  }
  const confirm = page.getByRole("checkbox", { name: "确认使用当前已加载的故事与分集材料" });
  if (await confirm.count()) await confirm.check();
  await page.getByRole("button", { name: "准备创作指令" }).click();
  const instruction = page.getByLabel("创作指令");
  await instruction.waitFor();
  const text = await instruction.inputValue();
  if (!text.includes("ads.writing.prompt.v1") || !text.includes("悬疑") || !text.includes("成人") || !text.includes("店员")) {
    throw new Error("copied instruction is missing the episode notes or prompt version");
  }
  if (text.includes("正在生成") || text.includes("生成成功")) throw new Error("instruction claims the page generated a result");
  await page.getByLabel("粘贴 JSON 候选").fill(JSON.stringify(candidate));
  await page.getByRole("button", { name: "校验并预览" }).click();
  await page.getByLabel("候选正文").waitFor();
  return editor;
}

async function main() {
  if (process.env.WRITING_ACCEPTANCE_DATABASE !== WRITING_WEB_DATABASE) {
    throw new Error(`the web acceptance only initializes ${WRITING_WEB_DATABASE}`);
  }
  const databaseUrl = requireEnv("DATABASE_URL");
  const redisUrl = requireEnv("REDIS_URL");
  const pool = createPostgresPool({
    connectionString: databaseUrl,
    connectionTimeoutMs: 2_000,
    statementTimeoutMs: 10_000,
    queryTimeoutMs: 10_000,
  });
  const apiEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    S3_ENDPOINT: "http://127.0.0.1:59000",
    S3_REGION: "us-east-1",
    S3_BUCKET: "ai-drama-dev",
    S3_ACCESS_KEY_ID: "test",
    S3_SECRET_ACCESS_KEY: "test",
    APP_WORKSPACE_ID: workspaceId,
    API_PORT: apiPort,
    BIND_HOST: "127.0.0.1",
  };
  let api;
  let web;
  let browser;
  try {
    await assertEmptyWritingAcceptanceDatabase(pool);
    await runMigrations(pool);
    await pool.query("INSERT INTO workspace (id, name, status) VALUES ($1, 'configured', 'ACTIVE')", [workspaceId]);
    const nextBin = createRequire(join(root, "apps/web/package.json")).resolve("next/dist/bin/next");
    api = startProcess(process.execPath, ["dist/main.js"], apiEnv, join(root, "apps/api"));
    web = startProcess(process.execPath, [nextBin, "start", "--hostname", "127.0.0.1", "--port", webPort], {
      ...process.env,
      NEXT_PUBLIC_API_BASE_URL: apiOrigin,
    }, join(root, "apps/web"));
    await waitForOk(`${apiOrigin}/api/v1/health/ready`);
    await waitForOk(webOrigin);

    const created = await fetch(`${apiOrigin}/api/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "writing-web-project" },
      body: JSON.stringify({ title: "编剧助手网页验收", premise: "夜班便利店" }),
    });
    if (created.status !== 201) throw new Error(`project create returned ${created.status}`);
    const project = await created.json();
    const expectedStory = formatStoryPlan(storyPlan);
    const expectedEpisode = formatEpisodeDraft(episodeDraft);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const writes = trackWrites(page);
    await page.goto(`${webOrigin}/projects/${project.id}?focus=story`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "编剧助手" }).waitFor();
    const beforeStory = writes.length;
    const storyEditor = page.locator("form", { has: page.getByRole("region", { name: "编剧助手" }) });
    await importCandidate(page, storyEditor, storyPlan);
    if (!((await page.getByLabel("创作指令").inputValue()).includes("模式：故事策划"))) {
      throw new Error("story instruction used the wrong mode");
    }
    if (writes.length !== beforeStory) throw new Error("story preview sent a business write");
    await assertOperable(page, storyEditor);
    await page.setViewportSize({ width: 390, height: 844 });
    await assertOperable(page, storyEditor);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "采纳到草稿" }).click();
    await page.getByText("已放入编辑草稿。还没有保存，请使用原来的保存新版本。").waitFor();
    if (writes.length !== beforeStory) throw new Error("story adoption sent a business write");
    const storySave = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes(`/projects/${project.id}/stories`));
    await storyEditor.getByRole("button", { name: "保存新版本", exact: true }).click();
    const storyResponse = await storySave;
    if (storyResponse.status() !== 201) throw new Error(`story save returned ${storyResponse.status()}`);
    const storyBody = await storyResponse.json();
    const storyWrite = writes.find((item) => item.method === "POST" && item.url.includes("/stories"));
    if (!storyWrite || storyWrite.ifMatch !== String(project.version)) {
      throw new Error(`story save If-Match ${storyWrite?.ifMatch ?? "missing"} did not stay ${project.version}`);
    }
    await page.getByText("已保存", { exact: true }).waitFor();
    const historyResponse = await fetch(`${apiOrigin}/api/v1/projects/${project.id}/stories`);
    const history = await historyResponse.json();
    const savedStory = history.items?.find((item) => item.id === storyBody.revisionId);
    if (!savedStory || savedStory.content?.text !== expectedStory || savedStory.reviewStatus !== "DRAFT") {
      throw new Error("reread story revision did not keep the formatted draft");
    }

    const inReview = await fetch(`${apiOrigin}/api/v1/projects/${project.id}/stories/${storyBody.revisionId}/review`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "writing-web-story-review", "if-match": String(storyBody.rowVersion) },
      body: JSON.stringify({ to: "IN_REVIEW", expectedReviewVersion: 1 }),
    });
    if (inReview.status !== 200) throw new Error(`story review returned ${inReview.status}`);
    const reviewed = await inReview.json();
    const approved = await fetch(`${apiOrigin}/api/v1/projects/${project.id}/stories/${storyBody.revisionId}/review`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "writing-web-story-approved", "if-match": String(reviewed.rowVersion) },
      body: JSON.stringify({ to: "APPROVED", expectedReviewVersion: reviewed.reviewVersion }),
    });
    if (approved.status !== 200) throw new Error(`story approval returned ${approved.status}`);
    const episodesResponse = await fetch(`${apiOrigin}/api/v1/projects/${project.id}/episodes`);
    const episodes = await episodesResponse.json();
    const episode = episodes.items?.find((item) => item.episodeNo === 1);
    if (!episode) throw new Error("episode 1 was not created with the approved story");

    await page.setViewportSize({ width: 390, height: 844 });
    const scriptsReady = page.waitForResponse((response) => response.request().method() === "GET" && response.url().includes(`/episodes/${episode.id}/scripts`));
    await page.goto(`${webOrigin}/projects/${project.id}?focus=script&episode=1`, { waitUntil: "domcontentloaded" });
    await scriptsReady;
    await page.getByRole("button", { name: "编剧助手" }).waitFor();
    const beforeEpisode = writes.length;
    const episodeEditor = page.locator("form", { has: page.getByRole("region", { name: "编剧助手" }) });
    await importCandidate(page, episodeEditor, episodeDraft);
    if (!((await page.getByLabel("创作指令").inputValue()).includes("模式：单集写作"))) {
      throw new Error("episode instruction used the wrong mode");
    }
    if (writes.length !== beforeEpisode) throw new Error("episode preview sent a business write");
    await assertOperable(page, episodeEditor);
    await page.setViewportSize({ width: 1440, height: 900 });
    await assertOperable(page, episodeEditor);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "采纳到草稿" }).click();
    await page.getByText("已放入编辑草稿。还没有保存，请使用原来的保存新版本。").waitFor();
    if (writes.length !== beforeEpisode) throw new Error("episode adoption sent a business write");
    const scriptSave = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/scripts"));
    await episodeEditor.getByRole("button", { name: "保存新版本", exact: true }).click();
    const scriptResponse = await scriptSave;
    if (scriptResponse.status() !== 201) throw new Error(`script save returned ${scriptResponse.status()}`);
    const scriptWrite = writes.find((item) => item.method === "POST" && item.url.includes("/scripts"));
    if (!scriptWrite || scriptWrite.ifMatch !== String(episode.rowVersion)) {
      throw new Error(`script save If-Match ${scriptWrite?.ifMatch ?? "missing"} did not stay ${episode.rowVersion}`);
    }
    const scriptsResponse = await fetch(`${apiOrigin}/api/v1/projects/${project.id}/episodes/${episode.id}/scripts`);
    const scripts = await scriptsResponse.json();
    const savedScript = scripts.items?.[0];
    if (!savedScript || savedScript.content?.text !== expectedEpisode || savedScript.reviewStatus !== "DRAFT") {
      throw new Error("reread script revision did not keep the formatted draft");
    }
    console.log("writing web acceptance passed");
  } catch (error) {
    if (api) console.error(api.logs());
    if (web) console.error(web.logs());
    throw error;
  } finally {
    if (browser) await browser.close();
    await stopProcess(web?.child);
    await stopProcess(api?.child);
    await closePostgresPool(pool);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "writing web acceptance failed");
  process.exit(1);
});
