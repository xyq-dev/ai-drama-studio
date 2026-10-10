// Unified site login, end to end: real Chrome -> Caddy (candidate config from infra/caddy, no basic_auth) -> production
// Next (page proxy) -> real API (dist/main.js, site login, model console) -> a new, empty PostgreSQL database.
// No route.fulfill, no mocked fetch, no model provider, no paid call. The password is generated per run (test-only)
// and never written to evidence. Refuses unless SITE_LOGIN_ACCEPTANCE=isolated and the database is empty.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { renderCaddySite } from "./render-caddy-site.mjs";

if (process.env.SITE_LOGIN_ACCEPTANCE !== "isolated") throw new Error("Set SITE_LOGIN_ACCEPTANCE=isolated to run against a new, empty database.");
const run = promisify(execFile);
const root = join(import.meta.dirname, "..");
const { createPostgresPool, closePostgresPool, runMigrations } = createRequire(join(root, "apps/api/package.json"))("@ai-drama/database");
const { chromium } = createRequire(join(root, "package.json"))("playwright");

const SITE = "https://localhost:8443";
const API = "http://127.0.0.1:3201";
const WEB = "http://127.0.0.1:3210";
const LEGACY_TOKEN = `legacy-admin-token-${randomBytes(18).toString("base64url")}`;
const PASSWORD = `test-only-${randomBytes(18).toString("base64url")}`;
const evidenceDir = process.env.SITE_LOGIN_EVIDENCE_DIR ?? join(root, "site-login-evidence");
const caddyBin = process.env.CADDY_BIN ?? "caddy";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const procs = [];
const evidence = { kind: "real-browser-real-api-real-caddy", caddyConfig: "infra/caddy/site.Caddyfile.template (tls internal)", database: "new, empty",
  headSha: process.env.SITE_LOGIN_HEAD_SHA ?? null, routeFulfill: false, mockFetch: false, modelCalls: 0, checks: {}, screenshots: [], pageErrors: [],
  basicAuthChallenges: [] };

function start(name, command, args, env, cwd = root) {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  const keep = (chunk) => { log = `${log}${chunk.toString()}`.slice(-20_000); };
  child.stdout.on("data", keep); child.stderr.on("data", keep);
  procs.push({ name, child, log: () => log });
}
async function waitFor(check, label) {
  const until = Date.now() + 90_000;
  let last = "";
  while (Date.now() < until) {
    try { const result = await check(); if (result === true) return; last = String(result); } catch (error) { last = error.message; }
    const exited = procs.find(({ child }) => child.exitCode !== null);
    if (exited) throw new Error(`${exited.name} exited: ${exited.log().slice(-2_000).replaceAll(PASSWORD, "<password>")}`);
    await delay(250);
  }
  throw new Error(`timed out waiting for ${label}: ${last}`);
}
async function capture(page, name) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo(0, 0); });
  const size = await page.evaluate(() => ({ width: window.innerWidth, scroll: document.documentElement.scrollWidth }));
  assert.equal(size.scroll, size.width, `horizontal overflow on ${name}`);
  await page.screenshot({ path: join(evidenceDir, `${name}.png`), fullPage: true });
  evidence.screenshots.push({ name, ...size });
}

const scratch = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "site-login-"));
let pool;
let browser;
try {
  await mkdir(evidenceDir, { recursive: true });
  pool = createPostgresPool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMs: 3_000, statementTimeoutMs: 15_000, queryTimeoutMs: 15_000 });
  const tables = (await pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'")).rows[0].n;
  assert.equal(tables, 0, "the acceptance database must be new and empty");
  evidence.checks.migrations = (await runMigrations(pool)).applied;

  // Operator path: the password goes through a private file into the hash script; only the hash reaches the API.
  const passwordFile = join(scratch, "password");
  await writeFile(passwordFile, `${PASSWORD}\n`, { mode: 0o600 });
  const hashed = (await run(process.execPath, [join(root, "scripts/site-auth-password.mjs"), "--password-file", passwordFile])).stdout;
  const hash = /^SITE_AUTH_PASSWORD_HASH=(\S+)$/m.exec(hashed)[1];
  await rm(passwordFile);
  const vault = join(scratch, "vault");
  await mkdir(vault, { mode: 0o700 });
  await chmod(vault, 0o700);

  const env = { ...process.env, NODE_ENV: "production", BIND_HOST: "127.0.0.1", API_PORT: "3201", WORKER_HEALTH_PORT: "3202",
    DATABASE_URL: process.env.DATABASE_URL, REDIS_URL: process.env.REDIS_URL, S3_ENDPOINT: "http://127.0.0.1:59000", S3_REGION: "us-east-1",
    S3_BUCKET: "unused", S3_ACCESS_KEY_ID: "test", S3_SECRET_ACCESS_KEY: "test", APP_WORKSPACE_ID: workspaceId, APP_WORKSPACE_NAME: "site login acceptance",
    SITE_AUTH_ENABLED: "true", SITE_AUTH_USERNAME: "admin", SITE_AUTH_PASSWORD_HASH: hash, SITE_AUTH_PUBLIC_ORIGIN: SITE,
    MODEL_ADMIN_ENABLED: "true", MODEL_ADMIN_CONFIG_PATH: join(vault, "models.enc"), MODEL_ADMIN_MASTER_KEY: randomBytes(32).toString("hex"),
    // Left over from the earlier console: must be ignored, never a way in.
    MODEL_ADMIN_TOKEN: LEGACY_TOKEN };
  await run("pnpm", ["--filter", "@ai-drama/database", "workspace:provision"], { cwd: root, env });
  start("api", process.execPath, ["dist/main.js"], env, join(root, "apps/api"));
  await waitFor(async () => (await fetch(`${API}/api/v1/health/live`)).ok || "api not live", "api");
  const nextBin = createRequire(join(root, "apps/web/package.json")).resolve("next/dist/bin/next");
  start("web", process.execPath, [nextBin, "start", "--hostname", "127.0.0.1", "--port", "3210"], { ...process.env, NODE_ENV: "production" }, join(root, "apps/web"));
  await waitFor(async () => (await fetch(`${WEB}/login`)).ok || "web not up", "web");

  const caddyfile = join(scratch, "Caddyfile");
  await writeFile(caddyfile, `{\n\tadmin off\n\thttp_port 8080\n\thttps_port 8443\n\tskip_install_trust\n}\n\n${await renderCaddySite({ site: "localhost:8443", upstream: "127.0.0.1:3210", tlsInternal: true })}`);
  start("caddy", caddyBin, ["run", "--config", caddyfile, "--adapter", "caddyfile"], { ...process.env, XDG_DATA_HOME: join(scratch, "caddy-data"), XDG_CONFIG_HOME: join(scratch, "caddy-config") });

  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const anonymous = await browser.newContext({ ignoreHTTPSErrors: true });
  await waitFor(async () => (await anonymous.request.get(`${SITE}/login`)).ok() || "caddy not up", "caddy");

  // 1. Anonymous: every business entry refused by the application itself, through the candidate Caddy config.
  const id = randomUUID();
  const refused = {};
  for (const [method, path] of [["GET", "/api/v1/projects"], ["POST", "/api/v1/projects"], ["GET", `/api/v1/projects/${id}/story-revisions`],
    ["GET", `/api/v1/assets/${id}/content`], ["GET", `/api/v1/projects/${id}/episodes/${id}/composites/${id}/download?expectedContentHash=${"a".repeat(64)}`],
    ["GET", "/api/v1/admin/models"], ["GET", "/api/v1/writing/title-runs/options"], ["POST", `/api/v1/projects/${id}/title-runs`]]) {
    const response = await anonymous.request.fetch(`${SITE}${path}`, { method, headers: { origin: SITE, "content-type": "application/json" },
      ...(method === "POST" ? { data: {} } : {}), maxRedirects: 0 });
    assert.equal(response.status(), 401, `${method} ${path}`);
    assert.equal(response.headers()["www-authenticate"], undefined, "no Basic Auth challenge");
    assert.ok(response.headers()["content-type"].includes("application/json"), "API answers JSON, not the login page");
    refused[`${method} ${path.split("?")[0]}`] = response.status();
  }
  evidence.checks.anonymousApi = refused;
  for (const path of ["/", "/studio", "/create", "/admin/models", `/projects/${id}`]) {
    const response = await anonymous.request.get(`${SITE}${path}`, { maxRedirects: 0 });
    assert.equal(response.status(), 307, path);
    const location = new URL(response.headers().location, SITE);
    assert.equal(location.origin + location.pathname + location.search, `${SITE}/login?returnTo=${encodeURIComponent(path)}`);
  }
  evidence.checks.anonymousPages = "307 to /login with returnTo";
  const health = await anonymous.request.get(`${SITE}/api/v1/health/live`);
  assert.equal(health.status(), 200);
  assert.deepEqual(Object.keys(await health.json()).sort(), ["service", "status", "timestamp", "version"]);
  // The old administrator token is no way in.
  assert.equal((await anonymous.request.post(`${SITE}/api/v1/admin/session`, { headers: { origin: SITE }, data: { token: LEGACY_TOKEN } })).status(), 401);
  assert.equal((await anonymous.request.post(`${SITE}/api/v1/auth/login`, { headers: { origin: SITE }, data: { username: "admin", password: LEGACY_TOKEN } })).status(), 401);
  assert.equal((await anonymous.request.get(`${SITE}/api/v1/admin/models`, { headers: { authorization: `Bearer ${LEGACY_TOKEN}` } })).status(), 401);
  evidence.checks.legacyToken = "refused";
  await anonymous.close();

  // 2. One login in the browser, then creation pages, the model console, refresh and logout.
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => evidence.pageErrors.push(error.message));
  page.on("response", (response) => { if (response.headers()["www-authenticate"]) evidence.basicAuthChallenges.push(response.url()); });
  await page.goto(`${SITE}/create`);
  assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, "/login?returnTo=%2Fcreate");
  await page.getByRole("heading", { name: "登录红果创作" }).waitFor();
  await capture(page, "desktop-login");
  assert.equal(await page.getByLabel("账号").inputValue(), "admin");
  await page.getByLabel("密码").fill("wrong-password-for-test");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "账号或密码不正确。" }).waitFor();
  await page.getByLabel("密码").fill(PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL(`${SITE}/create`);
  const cookies = await context.cookies();
  const session = cookies.find((cookie) => cookie.name === "__Host-ads_session");
  assert.ok(session && session.httpOnly && session.secure && session.sameSite === "Lax" && session.path === "/");
  const csrf = cookies.find((cookie) => cookie.name === "__Host-ads_csrf");
  assert.ok(csrf && !csrf.httpOnly && csrf.secure && csrf.sameSite === "Strict");
  evidence.checks.cookies = { session: "HttpOnly Secure SameSite=Lax Path=/", csrf: "readable Secure SameSite=Strict Path=/" };

  // A real write from the creation page: create a work (CSRF header, idempotency key, origin all real).
  const title = `统一登录验收 ${Date.now()}`;
  await page.getByLabel("你想拍一个什么样的故事？").fill("夜班便利店店员发现班次记录被人改过。");
  await page.getByRole("button", { name: "开始构思" }).click();
  await page.getByLabel("作品名称").fill(title);
  await capture(page, "desktop-create");
  await page.getByRole("button", { name: "确认创建作品" }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]+\/create/);
  const projects = await (await page.request.get(`${SITE}/api/v1/projects`)).json();
  assert.ok(projects.items.some((item) => item.title === title), "the created work is listed");
  evidence.checks.createdWork = true;
  await page.goto(`${SITE}/studio`);
  await page.getByText(title).first().waitFor();
  await capture(page, "desktop-studio");

  await page.goto(`${SITE}/admin/models`);
  await page.getByRole("button", { name: "校验并保存配置" }).waitFor();
  assert.equal(await page.getByLabel(/令牌/).count(), 0, "no administrator token field");
  await capture(page, "desktop-admin-models");
  await page.reload();
  await page.getByRole("button", { name: "校验并保存配置" }).waitFor();
  evidence.checks.refreshKeepsSession = true;
  const options = await (await page.request.get(`${SITE}/api/v1/writing/title-runs/options`)).json();
  assert.equal(options.enabled, false, "signing in does not switch on title writing");
  evidence.checks.titleWritingAfterLogin = options.code;

  // Cross-site and token-less writes are refused even with the session cookie.
  const evil = await page.request.post(`${SITE}/api/v1/projects`, { headers: { origin: "https://evil.example", "x-csrf-token": csrf.value, "idempotency-key": randomUUID() }, data: { title: "x", premise: "x" } });
  assert.equal(evil.status(), 403);
  const noCsrf = await page.request.post(`${SITE}/api/v1/projects`, { headers: { origin: SITE, "idempotency-key": randomUUID() }, data: { title: "x", premise: "x" } });
  assert.equal(noCsrf.status(), 403);
  evidence.checks.crossSiteWrite = { evilOrigin: evil.status(), missingCsrf: noCsrf.status() };

  const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie }));
  assert.equal(JSON.stringify(storage).includes(PASSWORD), false);
  assert.equal(storage.cookie.includes(session.value), false);
  evidence.checks.browserStorage = { localKeys: Object.keys(storage.local).length, sessionKeys: Object.keys(storage.session).length, sessionCookieReadable: false };

  // 390 px with the same session.
  const mobile = await context.newPage();
  mobile.on("pageerror", (error) => evidence.pageErrors.push(error.message));
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(`${SITE}/studio`);
  await mobile.getByText(title).first().waitFor();
  await capture(mobile, "mobile-studio");
  await mobile.goto(`${SITE}/admin/models`);
  await mobile.getByRole("button", { name: "校验并保存配置" }).waitFor();
  await capture(mobile, "mobile-admin-models");
  await mobile.goto(`${SITE}/studio`);
  await mobile.getByRole("button", { name: /打开导航|导航|菜单/ }).first().click();
  await mobile.getByRole("dialog", { name: "导航" }).getByRole("button", { name: "退出登录" }).waitFor();
  await capture(mobile, "mobile-navigation");
  await mobile.close();

  // Logout from the shared navigation revokes the session everywhere.
  await page.goto(`${SITE}/studio`);
  await page.getByRole("button", { name: "退出登录" }).click();
  await page.waitForURL(`${SITE}/login?returnTo=%2Fstudio&reason=signed-out`);
  await page.getByRole("status").filter({ hasText: "已退出登录。" }).waitFor();
  const replay = await browser.newContext({ ignoreHTTPSErrors: true });
  await replay.addCookies([{ ...session, sameSite: "Lax" }]);
  assert.equal((await replay.request.get(`${SITE}/api/v1/projects`)).status(), 401, "the old session cookie is revoked");
  assert.ok((await replay.request.get(`${SITE}/studio`, { maxRedirects: 0 })).headers().location.endsWith("/login?returnTo=%2Fstudio&reason=expired"));
  await replay.close();
  await page.goto(`${SITE}/admin/models`);
  await page.waitForURL(`${SITE}/login?returnTo=%2Fadmin%2Fmodels`);
  evidence.checks.logout = "revoked; pages and API need the login again";

  const mobileLogin = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
  const loginPage = await mobileLogin.newPage();
  loginPage.on("pageerror", (error) => evidence.pageErrors.push(error.message));
  await loginPage.goto(`${SITE}/login?returnTo=%2Fstudio&reason=expired`);
  await loginPage.getByRole("heading", { name: "登录红果创作" }).waitFor();
  await capture(loginPage, "mobile-login-expired");
  await mobileLogin.close();

  assert.deepEqual(evidence.pageErrors, []);
  assert.deepEqual(evidence.basicAuthChallenges, []);
  evidence.success = true;
} catch (error) {
  evidence.success = false;
  evidence.failure = String(error?.message ?? error).replaceAll(PASSWORD, "<password>").replaceAll(LEGACY_TOKEN, "<legacy-token>");
  evidence.logs = Object.fromEntries(procs.map(({ name, log }) => [name, log().slice(-3_000).replaceAll(PASSWORD, "<password>").replaceAll(LEGACY_TOKEN, "<legacy-token>")]));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  for (const { child } of procs.reverse()) {
    if (child.exitCode !== null) continue;
    child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(8_000).then(() => child.kill("SIGKILL"))]);
  }
  if (pool) await closePostgresPool(pool);
  await rm(scratch, { recursive: true, force: true });
  const text = `${JSON.stringify(evidence, null, 2)}\n`;
  if (text.includes(PASSWORD)) throw new Error("password in evidence");
  await writeFile(join(evidenceDir, "site-login-evidence.json"), text);
  console.log(JSON.stringify({ success: evidence.success, screenshots: evidence.screenshots.length, pageErrors: evidence.pageErrors.length,
    basicAuthChallenges: evidence.basicAuthChallenges.length, failure: evidence.failure ?? null }));
}
