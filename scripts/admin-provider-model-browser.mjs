// Exercise the real Next.js routes with a loopback-only admin API; no upstream credentials or calls.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "..");
const web = resolve(root, "apps/web");
const webRequire = createRequire(resolve(web, "package.json"));
const { WRITING_MODEL_CHANNELS } = webRequire("@ai-drama/contracts");
const output = resolve(process.env.SCREENSHOT_DIR || resolve(root, "test-results/provider-models"));
const csrf = "b".repeat(43);
// The synthetic long catalog exercises scrolling independently of any real provider's model count.
const extraModels = Array.from({ length: 24 }, (_, index) => ({
  id: `fixture-long-${index}`,
  label: `测试专用长模型名称 · 搜索与滚动样本 ${String(index + 1).padStart(2, "0")}`,
}));
const records = new Map(Object.entries(WRITING_MODEL_CHANNELS).map(([vendor, catalog]) => [
  vendor, { vendor, channel: catalog.id, models: [...catalog.models], revision: 1, model: null, keyConfigured: true },
]));
const writes = [];
const checks = [];
const errors = [];
let checkStatus = "listed";
let holdCheck;
let holdRead;

function json(response, body, status = 200) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function mockApi(request, response) {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  if (pathname === "/api/v1/auth/session") {
    json(response, { enabled: true, authenticated: true, role: "operator", username: "admin" });
    return;
  }
  if (request.method === "GET" && pathname === "/api/v1/admin/models/vendors") {
    json(response, [...records.values()]);
    return;
  }
  const match = /^\/api\/v1\/admin\/models\/vendors\/(openai|deepseek|anthropic|bailian)(\/check)?$/.exec(pathname);
  if (!match) {
    throw new Error(`Unexpected API request: ${request.method} ${pathname}`);
  }
  const record = records.get(match[1]);
  if (request.method === "GET" && !match[2]) {
    const snapshot = structuredClone(record);
    if (holdRead?.vendor === record.vendor) await holdRead.pending;
    json(response, snapshot);
    return;
  }
  let text = "";
  for await (const chunk of request) text += chunk;
  const body = JSON.parse(text);
  assert.equal(request.headers["x-csrf-token"], csrf);
  assert.equal(body.expectedRevision, record.revision);
  assert.equal(body.channel, record.channel);
  assert.ok(record.models.some(({ id }) => id === body.model), `unlisted model: ${body.model}`);
  if (request.method === "PUT" && !match[2]) {
    writes.push({ vendor: record.vendor, channel: body.channel, model: body.model });
    record.revision++;
    record.model = body.model;
    json(response, record);
    return;
  }
  assert.equal(request.method, "POST");
  assert.equal(match[2], "/check");
  assert.equal(body.model, record.model);
  const receipt = {
    vendor: record.vendor, channel: record.channel, revision: record.revision, model: record.model,
    status: checkStatus, message: checkStatus === "listed" ? "已读取模型列表" : "结果未知",
  };
  checks.push({ vendor: record.vendor, channel: body.channel, model: body.model });
  if (holdCheck) await holdCheck;
  json(response, receipt);
}

const api = createServer((request, response) => {
  mockApi(request, response).catch((error) => {
    errors.push(error.message);
    json(response, { error: { code: "FIXTURE_REQUEST_REJECTED" } }, 400);
  });
});
await new Promise((ready) => api.listen(0, "127.0.0.1", ready));
const port = Number(process.env.PROVIDER_UI_WEB_PORT || 3827);
const origin = `http://127.0.0.1:${port}`;
const next = webRequire.resolve("next/dist/bin/next");
const dev = spawn(process.execPath, [next, "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: web, env: { ...process.env, NEXT_PUBLIC_API_BASE_URL: `http://127.0.0.1:${api.address().port}`,
    NEXT_TELEMETRY_DISABLED: "1", NODE_ENV: "development" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
dev.stdout.on("data", (bytes) => { log += bytes; });
dev.stderr.on("data", (bytes) => { log += bytes; });

async function openPage(browser, width, height) {
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 1, hasTouch: width === 390, locale: "zh-CN",
  });
  await context.addCookies([{ name: "ads_csrf", value: csrf, url: origin }]);
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    if (route.request().resourceType() !== "stylesheet") errors.push(`Unexpected outbound request: ${route.request().url()}`);
    return route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(12_000);
  return page;
}

async function screenshot(page, filename) {
  await page.addStyleTag({ content: "nextjs-portal{display:none!important;}" });
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), page.viewportSize().width);
  await page.screenshot({ path: resolve(output, filename), animations: "disabled" });
}

const byButton = (scope, name) => scope.getByRole("button", { name, exact: true });
async function editor(page) {
  await byButton(page, "编辑设置").click();
  return page.getByRole("dialog", { name: "编辑设置" });
}
async function choose(dialog, label) {
  await dialog.getByRole("combobox", { name: "模型", exact: true }).click();
  await dialog.getByRole("option", { name: label, exact: true }).click();
}
async function openSettings(page, vendor) {
  await page.goto(`${origin}/admin/ai-models/${vendor}`);
  await byButton(page, "编辑设置").waitFor();
}
async function listed(page) {
  await page.getByText("已读取模型列表", { exact: true }).waitFor();
  assert.equal(await page.getByText("检测通过", { exact: true }).count(), 0);
}

let browser;
try {
  const limit = Date.now() + 120_000;
  for (;;) {
    if (dev.exitCode !== null || Date.now() > limit) throw new Error(log.slice(-2000));
    const ready = await fetch(`${origin}/admin/ai-models/deepseek`).catch(() => null);
    if (ready?.ok) break;
    await delay(300);
  }
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  const page = await openPage(browser, 1440, 900);
  await page.goto(`${origin}/admin/ai-models`);
  await page.getByRole("link", { name: "进入设置" }).first().waitFor();
  await screenshot(page, "desktop-catalog.png");
  await page.getByRole("link", { name: "进入设置" }).first().click();
  let dialog = await editor(page);
  await choose(dialog, "DeepSeek-V4.1-Flash-1017");
  await dialog.getByRole("combobox", { name: "供应商" }).selectOption("openai");
  await dialog.getByText("请选择模型", { exact: true }).waitFor();
  await dialog.getByRole("combobox", { name: "模型", exact: true }).click();
  assert.equal(await dialog.getByRole("listbox").getByRole("option", { name: /DeepSeek/ }).count(), 0);
  await dialog.getByRole("option", { name: "GPT-6.1 Sol" }).click();
  await byButton(dialog, "保存设置").click();
  await page.waitForURL("**/admin/ai-models/openai");
  await page.reload();
  await page.getByRole("heading", { name: "OpenAI", exact: true }).waitFor();
  dialog = await editor(page);
  assert.equal(await dialog.getByRole("combobox", { name: "模型", exact: true }).innerText(), "GPT-6.1 Sol");
  await byButton(dialog, "取消").click();
  assert.deepEqual(writes, [{ vendor: "openai", channel: "openai-direct", model: "gpt-6.1-sol" }]);
  assert.deepEqual(checks, []);

  // Double-click while a list read is pending. Both the stored selection and request count matter.
  const hold = Promise.withResolvers();
  holdCheck = hold.promise;
  const checkButton = byButton(page, "检测连接");
  const listRequest = page.waitForRequest((req) => req.url().endsWith("/check"));
  await checkButton.dblclick();
  await listRequest;
  hold.resolve();
  holdCheck = null;
  await listed(page);
  assert.deepEqual(checks, writes);
  await screenshot(page, "desktop-model-list-read.png");

  checkStatus = "unknown";
  await checkButton.click();
  await page.getByText("结果未知", { exact: true }).waitFor();
  assert.equal(checks.length, 2);

  // An old check may finish after the user begins editing another supplier.
  checkStatus = "listed";
  const delayed = Promise.withResolvers();
  holdCheck = delayed.promise;
  const pendingRequest = page.waitForRequest((req) => req.url().endsWith("/check"));
  await checkButton.click();
  await pendingRequest;
  dialog = await editor(page);
  await dialog.getByRole("combobox", { name: "供应商" }).selectOption("deepseek");
  await dialog.getByText("请选择模型", { exact: true }).waitFor();
  const done = page.waitForResponse((res) => res.url().endsWith("/check"));
  delayed.resolve();
  await done;
  holdCheck = null;
  await choose(dialog, "DeepSeek-V4-Pro-0813");
  assert.equal(await page.getByText("已读取模型列表", { exact: true }).count(), 0);
  page.once("dialog", confirmation => confirmation.accept());
  await byButton(dialog, "取消").click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(checks.length, 3);

  // A legacy ID not present in the current catalog is visible and stays stored until explicit save.
  const retired = "retired-model-fixture";
  records.get("openai").model = retired;
  await page.reload();
  dialog = await editor(page);
  await dialog.getByText("当前列表不可用", { exact: true }).waitFor();
  assert.equal(await dialog.getByRole("combobox", { name: "模型", exact: true }).innerText(), retired);
  await byButton(dialog, "取消").click();
  assert.equal(records.get("openai").model, retired);
  assert.equal(writes.length, 1);

  records.get("openai").model = "gpt-6.1-sol";
  const mobile = await openPage(browser, 390, 844);
  await openSettings(mobile, "openai");
  await byButton(mobile, "检测连接").click();
  await listed(mobile);
  await screenshot(mobile, "mobile-model-list-read.png");
  await openSettings(mobile, "deepseek");
  dialog = await editor(mobile);
  await choose(dialog, "DeepSeek-V4.1-Flash-1017");
  const selected = dialog.getByRole("combobox", { name: "模型", exact: true });
  assert.equal(await selected.innerText(), "DeepSeek-V4.1-Flash-1017");
  assert.ok(await selected.evaluate(el => el.firstElementChild.scrollWidth <= el.firstElementChild.clientWidth + 1));
  await selected.click();
  await dialog.getByRole("searchbox", { name: "搜索模型" }).fill("Flash");
  assert.equal(await dialog.getByRole("listbox").getByRole("option").count(), 1);
  await screenshot(mobile, "mobile-model-picker.png");
  await dialog.getByRole("option", { name: "DeepSeek-V4.1-Flash-1017" }).click();

  const delayedRead = Promise.withResolvers();
  holdRead = { vendor: "anthropic", pending: delayedRead.promise };
  const oldRead = mobile.waitForRequest(req => req.url().endsWith("/vendors/anthropic"));
  const vendorSelect = dialog.getByRole("combobox", { name: "供应商" });
  await vendorSelect.selectOption("anthropic");
  await oldRead;
  const oldResponse = mobile.waitForResponse(res => res.url().endsWith("/vendors/anthropic"));
  records.get("openai").models.push(...extraModels);
  await dialog.getByRole("combobox", { name: "供应商" }).selectOption("openai");
  await selected.click();
  delayedRead.resolve();
  await oldResponse;
  holdRead = null;
  const list = dialog.getByRole("listbox");
  await dialog.getByRole("option", { name: extraModels[23].label }).waitFor({ state: "attached" });
  assert.ok(await list.evaluate(el => el.scrollHeight > el.clientHeight));
  await list.evaluate(el => el.scrollTo(0, el.scrollHeight));
  assert.ok(await list.evaluate(el => el.scrollTop > 0));
  const search = dialog.getByRole("searchbox", { name: "搜索模型" });
  await search.fill(extraModels[23].id);
  assert.equal(await list.getByRole("option").count(), 1);
  await dialog.getByRole("option", { name: extraModels[23].label }).click();
  assert.equal(await selected.innerText(), extraModels[23].label);
  assert.ok(await selected.evaluate(el => el.firstElementChild.scrollWidth <= el.firstElementChild.clientWidth + 1));
  mobile.once("dialog", confirmation => confirmation.accept());
  await byButton(dialog, "取消").click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(writes.length, 1);
  assert.equal(checks.length, 4);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ writes, checks, modelInvocations: 0, screenshots: output }, null, 2));
} catch (error) {
  console.error(log.slice(-2000));
  console.error(errors);
  throw error;
} finally {
  await browser?.close();
  dev.kill("SIGTERM");
  api.closeAllConnections();
  api.close();
}
