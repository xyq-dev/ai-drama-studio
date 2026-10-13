/**
 * Browser check of the character reference task flow (PR #49 item 5 and review 1) on the real production build of the
 * web app, in Chromium, against a LOCAL STUB API. This is not an end-to-end acceptance: no API, Worker or database
 * runs. A small HTTP server on the API port answers /api/v1 with scripted state (login switched off), and the Next
 * build's own /api/v1 rewrite sends the browser's requests to it. Nothing is answered with route.fulfill.
 *
 * Checked at 1280 and 390 px, on the advanced workbench's character page:
 * - idle project (nothing runs, so the task poll has stopped); a generation is accepted (202);
 * - the task list rereads /workflow-runs right after the acceptance and lists the reference task;
 * - both the panel's job poll and the task poll follow it; SUCCEEDED rereads the reference list and the task shows
 *   成功; a later FAILED job shows its code in the panel and 失败 in the task list; polling stops after terminal states;
 * - no horizontal overflow.
 *
 * Needs `pnpm build` first. Run: node scripts/character-reference-web-stub-check.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const { chromium } = createRequire(join(root, "package.json"))("playwright");

// next build stores the /api/v1 rewrite to port 3001.
const apiPort = 3001;
const webPort = 3011;
const webOrigin = `http://127.0.0.1:${webPort}`;

const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHARACTER = "11111111-1111-4111-8111-111111111111";
const REVISION = "22222222-2222-4222-8222-222222222222";
const SCRIPT = "33333333-3333-4333-8333-333333333333";
const HASH = "ab".repeat(32);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

/** Scripted server state. The check moves it forward; the page only ever reads it through HTTP. */
const state = { runs: [], jobs: new Map(), assets: [], nextJob: 1, log: [], unknown: [] };

function run(job) {
  return { id: `run-${job.id}`, type: "MEDIA_CHARACTER_REFERENCE", status: job.state, createdAt: job.createdAt,
    jobs: [{ id: job.id, kind: "MEDIA_CHARACTER_REFERENCE", state: job.state, errorCode: job.errorCode, errorMessage: null,
      attempts: [] }] };
}

function setJob(id, jobState, errorCode = null) {
  const job = state.jobs.get(id);
  job.state = jobState;
  job.errorCode = errorCode;
  state.runs = [...state.jobs.values()].map(run);
}

function listing() {
  return { characterId: CHARACTER, currentRevisionId: REVISION, selection: null,
    videoReadiness: { usable: false, blockers: ["CHARACTER_REVISION_NOT_APPROVED", "REFERENCE_NOT_SELECTED"] },
    items: state.assets, hasMore: false };
}

const aggregate = { entityId: CHARACTER, name: "林", rowVersion: 1, currentRevisionId: REVISION, approvedRevisionId: null,
  currentRevision: { reviewStatus: "DRAFT", freshnessStatus: "CURRENT", reviewVersion: 1 } };

function answer(method, path) {
  if (path === "/api/v1/auth/session") return [200, { enabled: false, authenticated: false }];
  if (path === `/api/v1/projects/${PROJECT}`) {
    return [200, { id: PROJECT, title: "参考图桩检查", premise: "", version: 1, status: "ACTIVE", episodeCount: 3 }];
  }
  if (path === `/api/v1/projects/${PROJECT}/episodes`) return [200, { items: [] }];
  if (path === `/api/v1/projects/${PROJECT}/workflow-runs`) return [200, state.runs];
  if (path === `/api/v1/projects/${PROJECT}/characters`) return [200, { items: [aggregate], nextCursor: null }];
  if (path === `/api/v1/projects/${PROJECT}/characters/${CHARACTER}/revisions`) {
    return [200, { aggregate, items: [{ id: REVISION, revisionNo: 1, content: { name: "林", description: "店员" },
      sourceScriptRevisionId: SCRIPT, reviewStatus: "DRAFT", freshnessStatus: "CURRENT", reviewVersion: 1 }] }];
  }
  if (path === `/api/v1/characters/${CHARACTER}/reference-images`) return [200, listing()];
  if (method === "POST" && path === `/api/v1/character-revisions/${REVISION}/reference-images/generate`) {
    const id = `cccccccc-cccc-4ccc-8ccc-${String(state.nextJob++).padStart(12, "0")}`;
    state.jobs.set(id, { id, state: "QUEUED", errorCode: null, createdAt: new Date().toISOString() });
    state.runs = [...state.jobs.values()].map(run);
    return [202, { workflowRunId: `run-${id}`, jobId: id, dispatchSeq: state.nextJob }];
  }
  const job = /^\/api\/v1\/generation-jobs\/([^/]+)$/.exec(path);
  if (job && state.jobs.has(job[1])) {
    const found = state.jobs.get(job[1]);
    return [200, { id: found.id, state: found.state, errorCode: found.errorCode, errorMessage: null }];
  }
  if (/^\/api\/v1\/assets\/[^/]+\/content$/.test(path)) return [200, PNG];
  if (method === "GET" && /^\/api\/v1\/projects\/[^/]+\/(stories|locations)$/.test(path)) return [200, { items: [], nextCursor: null }];
  state.unknown.push(`${method} ${path}`);
  return [404, { error: { code: "NOT_FOUND", message: "stub has no answer" } }];
}

const api = createServer((request, response) => {
  const path = (request.url ?? "").split("?")[0];
  state.log.push({ method: request.method, path, at: Date.now() });
  request.resume();
  request.on("end", () => {
    const [status, body] = answer(request.method ?? "GET", path);
    if (Buffer.isBuffer(body)) {
      response.writeHead(status, { "content-type": "image/png" });
      response.end(body);
      return;
    }
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
});

const reads = (pattern) => state.log.filter((entry) => entry.method === "GET" && pattern.test(entry.path)).length;
const RUNS = new RegExp(`/projects/${PROJECT}/workflow-runs$`);
const JOBS = /\/generation-jobs\//;

function check(condition, message) {
  if (!condition) throw new Error(`check failed: ${message}`);
  console.log(`ok  ${message}`);
}

async function waitFor(predicate, message, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return check(true, message);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  check(false, message);
}

async function startWeb() {
  const next = spawn(process.execPath, [join(root, "apps/web/node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1",
    "--port", String(webPort)], { cwd: join(root, "apps/web"), env: { ...process.env, NODE_ENV: "production" }, stdio: "pipe" });
  let output = "";
  next.stdout.on("data", (chunk) => { output += chunk; });
  next.stderr.on("data", (chunk) => { output += chunk; });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${webOrigin}/login`);
      if (response.status < 500) return next;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  next.kill();
  throw new Error(`next start did not come up:\n${output}`);
}

async function scenario(browser, width) {
  state.runs = [];
  state.jobs.clear();
  state.assets = [];
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  await page.goto(`${webOrigin}/projects/${PROJECT}?focus=character`);
  await page.getByRole("button", { name: "林" }).click();
  await page.getByRole("region", { name: "角色参考图" }).waitFor();
  check(true, `${width}px: character page with the reference panel loaded`);

  // Idle: nothing runs, so the task poll has stopped.
  const idleRuns = reads(RUNS);
  await page.waitForTimeout(5_000);
  check(reads(RUNS) === idleRuns, `${width}px: idle page does not poll workflow runs (${idleRuns} reads)`);

  // Accept a generation that will succeed.
  await page.getByRole("button", { name: "为当前版本生成参考图" }).click();
  await page.getByText("已受理参考图生成（202）。这不是生成成功，正在跟踪任务。").waitFor();
  const [firstJob] = [...state.jobs.keys()];
  await waitFor(async () => reads(RUNS) > idleRuns, `${width}px: acceptance rereads /workflow-runs at once`, 3_000);
  const tasks = page.getByRole("button", { name: "任务", exact: true });
  await tasks.click();
  await page.getByText("角色参考图 · 进行中 QUEUED").waitFor();
  check(true, `${width}px: the accepted reference task is listed while QUEUED`);
  await page.getByRole("button", { name: "关闭任务" }).click();

  setJob(firstJob, "RUNNING");
  const runningJobReads = reads(JOBS);
  const runningRunReads = reads(RUNS);
  await waitFor(async () => reads(JOBS) > runningJobReads && reads(RUNS) > runningRunReads,
    `${width}px: panel job poll and task poll both keep reading while RUNNING`);
  await page.getByText(/参考图任务 cccccccc · 生成中/).waitFor();

  state.assets = [{ id: "55555555-5555-4555-8555-555555555555", characterRevisionId: REVISION, checksumSha256: HASH,
    status: "ACTIVE", reviewStatus: "DRAFT", reviewNote: null, rowVersion: 1, createdAt: new Date().toISOString(), selectable: false }];
  setJob(firstJob, "SUCCEEDED");
  await page.getByText("参考图生成成功，列表已重新读取。").waitFor();
  await page.getByText("55555555", { exact: true }).waitFor();
  check(true, `${width}px: SUCCEEDED rereads the reference list and shows the new image`);
  await tasks.click();
  await page.getByText("角色参考图 · 成功 SUCCEEDED").waitFor();
  check(true, `${width}px: the task list shows the reference task as 成功 SUCCEEDED`);
  await page.getByRole("button", { name: "关闭任务" }).click();
  const settledRuns = reads(RUNS);
  const settledJobs = reads(JOBS);
  await page.waitForTimeout(6_000);
  check(reads(RUNS) === settledRuns && reads(JOBS) === settledJobs, `${width}px: polling stops after SUCCEEDED`);

  // A second generation that fails.
  await page.getByRole("button", { name: "为当前版本生成参考图" }).click();
  await page.getByText("已受理参考图生成（202）。这不是生成成功，正在跟踪任务。").waitFor();
  const secondJob = [...state.jobs.keys()].at(-1);
  await waitFor(async () => reads(RUNS) > settledRuns, `${width}px: the second acceptance rereads /workflow-runs`, 3_000);
  setJob(secondJob, "FAILED", "MOCK_IMAGE_RUNTIME_FAILED");
  await page.getByText("参考图生成失败（MOCK_IMAGE_RUNTIME_FAILED），没有新增参考图。").waitFor();
  check(true, `${width}px: FAILED shows its code in the panel`);
  await tasks.click();
  await page.getByText("角色参考图 · 失败 FAILED").waitFor();
  check(true, `${width}px: the task list shows the failed reference task as 失败 FAILED`);
  await page.getByRole("button", { name: "关闭任务" }).click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 0, `${width}px: no horizontal overflow (${overflow}px)`);
  check(consoleErrors.length === 0, `${width}px: no page errors${consoleErrors.length ? `: ${consoleErrors.join(" | ")}` : ""}`);
  await page.close();
}

await new Promise((resolve, reject) => api.once("error", reject).listen(apiPort, "127.0.0.1", resolve));
let web;
let browser;
try {
  web = await startWeb();
  browser = await chromium.launch();
  for (const width of [1280, 390]) await scenario(browser, width);
  console.log(`requests the stub could not answer: ${state.unknown.length ? [...new Set(state.unknown)].join(", ") : "none"}`);
  console.log("character reference web stub check passed (stub API, not end-to-end)");
} finally {
  await browser?.close();
  web?.kill();
  api.close();
}
