// Actual React component + same-origin fixture API. Never calls an external storage provider.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve(import.meta.dirname, ".."), web = resolve(root, "apps/web");
const requireWeb = createRequire(resolve(web, "package.json"));
const { createServer } = await import(pathToFileURL(requireWeb.resolve("vite")).href);
const { default: react } = await import(pathToFileURL(requireWeb.resolve("@vitejs/plugin-react")).href);
const { chromium } = createRequire(resolve(root, "package.json"))("playwright");
const output = resolve(root, "test-results/storage-settings-ui");
const id = "11111111-1111-4111-8111-111111111111";
const initial = () => ({ revision: 1, managed: true,
  active: { id: null, provider: "minio", endpoint: "https://legacy.example.com", region: "us-east-1", bucket: "legacy-media", prefix: "", forcePathStyle: true, hasCredentials: true, source: "environment" },
  draft: { id, provider: "cos", endpoint: "https://cos.ap-guangzhou.myqcloud.com", region: "ap-guangzhou", bucket: "hongguo-media-1250000000", prefix: "hongguo/", forcePathStyle: false, hasCredentials: true, source: "managed" },
  test: { status: "not_tested", testedAt: null, expiresAt: null } });
const entry = `import React from 'react';import{createRoot}from'react-dom/client';import'/src/app/globals.css';import{StorageSettings}from'/src/components/storage-settings.tsx';createRoot(document.getElementById('root')).render(React.createElement(StorageSettings));`;
const evidence = { kind: "chromium-actual-react-fixture-api", externalRequests: 0, checks: [], errors: [] };
let view = initial(), unavailable = false;
const writes = [];
const server = await createServer({ configFile: false, root: web, optimizeDeps: { include: ["react", "react-dom/client", "@ai-drama/contracts"] },
  server: { host: "127.0.0.1", port: 3847, strictPort: true }, plugins: [react(), { name: "storage-settings-fixture",
    resolveId(id) { if (id === "/fixture.tsx") return "\0fixture.tsx"; }, load(id) { if (id === "\0fixture.tsx") return entry; },
    configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
      if (req.url?.startsWith("/api/v1/admin/storage")) {
        res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store");
        if (unavailable) { res.statusCode = 503; res.end(JSON.stringify({ error: { code: "STORAGE_SETTINGS_UNAVAILABLE" } })); return; }
        if (req.method !== "GET") {
          let raw = ""; for await (const bytes of req) raw += bytes;
          const body = JSON.parse(raw); assert.equal(body.expectedRevision, view.revision);
          assert.equal(req.headers["x-csrf-token"], "c".repeat(43)); writes.push(req.url);
          if (req.url.endsWith("/draft")) view = { ...view, revision: view.revision + 1, test: initial().test };
          if (req.url.endsWith("/test")) { assert.equal(body.confirmProbe, true); view = { ...view, revision: view.revision + 1, test: { status: "passed", testedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 900000).toISOString() } }; }
          if (req.url.endsWith("/activate")) view = { ...view, revision: view.revision + 1, active: view.draft };
        }
        res.end(JSON.stringify(view)); return;
      }
      if (req.url !== "/") { next(); return; }
      res.setHeader("Content-Type", "text/html"); res.end(await vite.transformIndexHtml("/", '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>'));
    }); },
  }] });
let browser;
try {
  await mkdir(output, { recursive: true }); await server.listen(); browser = await chromium.launch({ headless: true });
  for (const width of [1440, 390]) {
    view = initial(); writes.length = 0; unavailable = false;
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    await context.addCookies([{ name: "ads_csrf", value: "c".repeat(43), url: "http://127.0.0.1:3847" }]);
    const page = await context.newPage(); page.on("pageerror", error => evidence.errors.push(error.message));
    await page.route("**/*", route => { const url = new URL(route.request().url()); if (url.hostname !== "127.0.0.1") { evidence.externalRequests++; return route.abort(); } return route.continue(); });
    await page.goto("http://127.0.0.1:3847"); await page.getByText("草稿 · 未启用", { exact: true }).waitFor();
    const save = page.getByRole("button", { name: "保存草稿", exact: true });
    const test = page.getByRole("button", { name: "检测连接", exact: true });
    const activate = page.getByRole("button", { name: "启用此配置", exact: true });
    assert.equal(await activate.isDisabled(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    await page.screenshot({ path: resolve(output, `storage-settings-${width}.png`), fullPage: true });
    await page.getByLabel("阿里云 OSS", { exact: true }).check();
    assert.equal(await page.getByLabel("Access Key Secret", { exact: false }).inputValue(), "");
    await page.getByLabel("腾讯云 COS", { exact: true }).check();
    await save.click(); await page.getByText("草稿已保存。当前存储未改变，请检测连接。", { exact: true }).waitFor();
    assert.equal(writes.length, 1); assert.equal(view.active.bucket, "legacy-media");
    await test.click(); await page.getByText("连接检测通过，15 分钟内可启用此版本。", { exact: true }).waitFor();
    await activate.click(); const dialog = page.getByRole("dialog"); await dialog.waitFor();
    await page.keyboard.press("Escape"); assert.equal(await dialog.count(), 0);
    assert.equal(await activate.evaluate(el => el === document.activeElement), true);
    await activate.click(); await page.getByRole("button", { name: "确认启用", exact: true }).click();
    await page.getByText("当前已启用", { exact: true }).waitFor(); assert.equal(writes.length, 3);
    await page.reload(); await page.getByText("当前已启用", { exact: true }).waitFor(); assert.equal(writes.length, 3);
    if (width === 390) { await page.getByRole("button", { name: "打开导航" }).click(); assert.equal(await page.getByRole("dialog").getByRole("link", { name: "设置", exact: true }).getAttribute("href"), "/settings/storage"); await page.keyboard.press("Escape"); }
    unavailable = true; await page.reload(); await page.getByRole("alert").waitFor(); assert.equal(await save.isDisabled(), true);
    await page.screenshot({ path: resolve(output, `storage-unavailable-${width}.png`), fullPage: true });
    evidence.checks.push({ width, overflow: false, providers: true, saveProbeActivate: true, escapeRestoresFocus: true, refreshNoWrites: true, unavailableDisabled: true });
    await context.close();
  }
  assert.deepEqual(evidence.errors, []); assert.equal(evidence.externalRequests, 0);
} finally { await browser?.close(); await server.close(); await writeFile(resolve(output, "evidence.json"), JSON.stringify(evidence, null, 2)); }
process.stdout.write("Storage settings UI: desktop/mobile, providers, save/probe/activate separation, refresh and unavailable checks passed. External requests: 0.\n");
