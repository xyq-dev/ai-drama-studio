// Real Chrome -> production Next (page proxy) -> Nest site login + admin controller -> encrypted temporary file.
// This isolated harness never connects to the application DB or a model provider.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

if (process.env.ADMIN_MODELS_BROWSER_ACCEPTANCE !== "local-temporary-storage") {
  throw new Error("Explicit local-temporary-storage acceptance flag required.");
}
const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = "http://127.0.0.1:3820";
const output = resolve(root, process.env.ADMIN_MODELS_EVIDENCE_DIR || "docs/admin-models");
// Generated per run, test-only; passed to the fixture server through its environment, never written to evidence.
const password = `test-only-${randomBytes(18).toString("base64url")}`;
process.env.ADMIN_MODELS_TEST_PASSWORD = password;
const fakeKey = "sk-admin-browser-fake-key";
const processes = [];
let browser;
const evidence = {
  kind: "real-browser-real-site-login-admin-http-temporary-encrypted-file", database: false, modelCalls: 0,
  headSha: process.env.ADMIN_MODELS_HEAD_SHA || null,
  routeFulfill: false, mockFetch: false, screenshots: [], checks: {}, errors: [],
};
await mkdir(output, { recursive: true });
function launch(args, cwd = root) {
  const process = spawn(globalThis.process.execPath, args, { cwd, env: globalThis.process.env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  process.stdout.on("data", (chunk) => { log += chunk.toString(); });
  process.stderr.on("data", (chunk) => { log += chunk.toString(); });
  processes.push({ process, log: () => log });
  return process;
}
async function waitHttp(url, status) {
  const limit = Date.now() + 30_000;
  while (Date.now() < limit) {
    try { if ((await fetch(url)).status === status) return; } catch { /* readiness polling */ }
    if (processes.some(({ process }) => process.exitCode !== null)) throw new Error("Acceptance process exited before readiness.");
    await delay(100);
  }
  throw new Error(`Readiness timed out: ${url}`);
}
async function capture(page, name) {
  await page.evaluate(() => document.fonts.ready);
  // Start from the top so full-page screenshots do not stitch offscreen fixed skip links into content.
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo(0, 0); });
  const dimensions = await page.evaluate(() => ({ width: window.innerWidth, scroll: document.documentElement.scrollWidth }));
  assert.equal(dimensions.scroll, dimensions.width, `Horizontal overflow: ${name}`);
  const file = `${name}.png`;
  await page.screenshot({ path: resolve(output, file), fullPage: true });
  evidence.screenshots.push({ file, ...dimensions });
}
async function signIn(page) {
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "校验并保存配置", exact: true }).waitFor();
}
async function readView(page) {
  const result = await page.evaluate(async () => {
    const response = await fetch("/api/v1/admin/models", { credentials: "same-origin", cache: "no-store" });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(result.status, 200);
  assert.equal(JSON.stringify(result.body).includes(fakeKey), false);
  assert.equal(JSON.stringify(result.body).includes(password), false);
  return result.body;
}

try {
  launch(["scripts/admin-models-browser-server.mjs"]);
  const webRequire = createRequire(resolve(root, "apps/web/package.json"));
  launch([webRequire.resolve("next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", "3820"], resolve(root, "apps/web"));
  await waitHttp("http://127.0.0.1:3841/api/v1/auth/session", 401);
  await waitHttp(`${origin}/admin/models`, 200);
  browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
    args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => evidence.errors.push(error.message));
  const requests = [];
  page.on("request", (request) => { if (request.url().includes("/api/v1/admin/")) requests.push({ path: new URL(request.url()).pathname, method: request.method() }); });
  // Signed out: the page proxy sends the console to the site login, keeping where it was going.
  const response = await page.goto(`${origin}/admin/models`);
  assert.equal(response.status(), 200);
  assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, "/login?returnTo=%2Fadmin%2Fmodels");
  const headers = response.headers();
  assert.equal(headers["x-frame-options"], "DENY");
  assert.equal(headers["content-security-policy"], "frame-ancestors 'none'");
  assert.ok(headers["cache-control"].includes("no-store"), "Administrator HTML must not be cached");
  await page.getByRole("heading", { name: "登录红果创作", exact: true }).waitFor();
  await capture(page, "desktop-login");
  await signIn(page);
  await capture(page, "desktop-models-empty");
  const cookies = await context.cookies();
  const session = cookies.find((cookie) => cookie.name === "ads_session");
  assert.ok(session && session.httpOnly && session.sameSite === "Lax" && session.path === "/");
  const before = await readView(page);
  assert.equal(before.savedRevision, 0);
  await page.getByLabel(/^服务端点/).fill("https://dashscope.aliyuncs.com/compatible-mode/v1");
  await page.getByLabel(/^允许使用的模型 ID/).fill("browser-test-model");
  await page.getByRole("radio", { name: "填写 / 替换", exact: true }).check();
  await page.getByLabel(/^新的 API Key/).fill(fakeKey);
  await page.getByRole("button", { name: "校验并保存配置", exact: true }).click();
  await page.getByRole("status").filter({ hasText: /^千问配置已保存/ }).waitFor();
  assert.equal(await page.getByLabel(/^新的 API Key/).count(), 0);
  const saved = await readView(page);
  assert.equal(saved.savedRevision, 1); assert.equal(saved.activeRevision, 0); assert.equal(saved.pendingRestart, true);
  assert.equal(saved.saved.providers.find((provider) => provider.providerKey === "qwen").keyConfigured, true);
  assert.equal(saved.active.providers.find((provider) => provider.providerKey === "qwen").keyConfigured, false);
  await capture(page, "desktop-models-saved");
  await page.reload();
  await page.getByRole("button", { name: "校验并保存配置", exact: true }).waitFor();
  assert.equal((await readView(page)).savedRevision, 1);
  const storage = await page.evaluate(() => ({ local: Object.values(localStorage), session: Object.values(sessionStorage), cookie: document.cookie }));
  assert.equal(JSON.stringify(storage).includes(fakeKey), false);
  assert.equal(JSON.stringify(storage).includes(password), false);
  // Only the CSRF cookie is readable; the session cookie is HttpOnly.
  assert.match(storage.cookie, /^ads_csrf=[A-Za-z0-9_-]{43}$/);
  assert.equal(storage.cookie.includes(session.value), false);
  evidence.checks.refresh = { sameSavedRevision: true, httpOnlySession: true, noSecretsInBrowserStorage: true };
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await page.waitForURL(/\/login\?returnTo=%2Fadmin%2Fmodels&reason=signed-out$/);
  const afterLogout = await context.request.get(`${origin}/api/v1/admin/models`);
  assert.equal(afterLogout.status(), 401);
  await signIn(page);
  assert.equal((await readView(page)).savedRevision, 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, "mobile-models-saved");
  await page.getByRole("button", { name: /^OpenAI/ }).click();
  await page.getByRole("region", { name: "OpenAI设置" }).waitFor();
  assert.equal(await page.getByLabel(/^服务端点/).getAttribute("readonly"), "");
  await capture(page, "mobile-openai");
  await page.getByRole("button", { name: /^千问/ }).click();
  await page.getByRole("radio", { name: "清除密钥", exact: true }).check();
  assert.equal(await page.getByRole("button", { name: "校验并保存配置", exact: true }).isDisabled(), true);
  await page.getByRole("checkbox", { name: /我确认清除/ }).check();
  await page.getByRole("button", { name: "校验并保存配置", exact: true }).click();
  await page.getByRole("status").filter({ hasText: /^千问配置已保存/ }).waitFor();
  const cleared = await readView(page);
  assert.equal(cleared.savedRevision, 2);
  assert.equal(cleared.saved.providers.find((provider) => provider.providerKey === "qwen").keyConfigured, false);
  await page.getByRole("combobox", { name: /^默认供应商/ }).selectOption("qwen");
  await page.getByLabel(/^每日最多调用次数/).fill("8");
  await page.getByRole("button", { name: "保存调用规则", exact: true }).click();
  await page.getByRole("status").filter({ hasText: /^调用规则已保存/ }).waitFor();
  const limits = await readView(page);
  assert.equal(limits.savedRevision, 3); assert.equal(limits.saved.maxCallsPerDay, 8); assert.equal(limits.activeRevision, 0);
  assert.equal(limits.titleWriting.enabled, false);
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await page.waitForURL(/\/login\?/);
  await page.getByRole("heading", { name: "登录红果创作", exact: true }).waitFor();
  await capture(page, "mobile-login");
  assert.deepEqual(evidence.errors, []);
  evidence.checks.save = { savedRevision: 1, activeRevision: 0, pendingRestart: true, secretNotReturned: true };
  evidence.checks.clear = { explicitConfirmation: true, keyConfigured: false, revision: 2 };
  evidence.checks.limits = { daily: 8, savedRevision: 3, activeRevision: 0, titleWritingEnabled: false };
  evidence.checks.logout = { protectedReadAfterLogout: 401, reloginReadsSavedConfig: true };
  evidence.checks.headers = { frameOptions: headers["x-frame-options"], csp: headers["content-security-policy"], cache: headers["cache-control"] };
  evidence.requests = requests;
  evidence.success = true;
} catch (error) {
  evidence.success = false; evidence.failure = error.message;
  throw error;
} finally {
  await browser?.close();
  for (const { process } of processes.reverse()) {
    process.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => process.once("exit", resolve)), delay(5000).then(() => { if (process.exitCode === null) process.kill("SIGKILL"); })]);
  }
  await writeFile(resolve(output, "browser-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify({ success: evidence.success, screenshots: evidence.screenshots.length, pageErrors: evidence.errors.length, database: false, modelCalls: 0 }));
}
