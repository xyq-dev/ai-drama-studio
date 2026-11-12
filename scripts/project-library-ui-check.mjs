// Actual MyWorks + CreatorShell in Chromium. All project/media responses below are local test fixtures.
// This proves browser interaction and layout, not a production API or database deployment.
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
const output = resolve(process.env.PROJECT_LIBRARY_UI_EVIDENCE_DIR || resolve(root, "test-results/project-library-ui"));
const P = "11111111-1111-4111-8111-111111111111", C = "22222222-2222-4222-8222-222222222222";
const P2 = "33333333-3333-4333-8333-333333333333", P3 = "44444444-4444-4444-8444-444444444444";
const P4 = "55555555-5555-4555-8555-555555555555";
const evidence = { kind: "chromium-actual-react-local-api-fixture", database: false, productionData: false, checks: [], errors: [] };
let categories, projects, requests, listMode = "normal";
function reset() {
  categories = [{ id: C, name: "都市情感" }]; requests = [];
  projects = [
    { id: P, title: "重逢在雨夜", premise: "一封未寄出的信，让旧日恋人再度相遇。", categoryId: C, thumbnailAssetId: P, writingMode: "short", episodeCount: 3 },
    { id: P2, title: "长街旧事", premise: "回到故乡的女儿，寻找父亲留下的答案。", categoryId: C, thumbnailAssetId: P2, writingMode: "series", episodeCount: 12 },
    { id: P3, title: "最后一班地铁", premise: "末班车到站时，一个陌生人交给她一把钥匙。", categoryId: null, thumbnailAssetId: null, writingMode: "short", episodeCount: 3 },
    { id: P4, title: "风起的时候", premise: "三个年轻人在小城里开始一段新的旅程。", categoryId: null, thumbnailAssetId: null, writingMode: "short", episodeCount: 3 },
  ].map((item, index) => ({ ...item, categoryName: item.categoryId ? "都市情感" : null, categoryRevision: 0,
    thumbnailUrl: item.thumbnailAssetId ? `/api/v1/real-media/assets/${item.thumbnailAssetId}/content` : null,
    createdAt: "2026-11-01T00:00:00Z", updatedAt: `2026-11-${String(10 - index).padStart(2, "0")}T08:00:00Z` }));
}
const entry = `import React from 'react';import {createRoot} from 'react-dom/client';import '/src/app/globals.css';import {MyWorks} from '/src/components/my-works.tsx';createRoot(document.getElementById('root')).render(React.createElement(MyWorks));`;
const server = await createServer({ configFile: false, root: web, optimizeDeps: { include: ["react", "react-dom/client"], force: true },
  server: { host: "127.0.0.1", port: 3856, strictPort: true }, plugins: [react(), {
    name: "local-project-library-fixture", resolveId(id) { if (id === "/fixture.tsx") return "\0fixture.tsx"; },
    load(id) { if (id === "\0fixture.tsx") return entry; }, configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || "/", "http://fixture.invalid");
        if (url.pathname.startsWith("/api/v1/")) {
          if (url.pathname.startsWith("/api/v1/real-media/assets/")) {
            res.setHeader("Content-Type", "image/svg+xml");
            res.end('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300" viewBox="0 0 480 300"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#395b60"/><stop offset="1" stop-color="#cdb48e"/></linearGradient></defs><rect width="480" height="300" fill="url(#g)"/><path d="M0 240 90 110 165 180 250 75 380 180 480 110V300H0" fill="#233c3d" opacity=".6"/><circle cx="360" cy="78" r="32" fill="#e9d1a4"/><text x="26" y="275" font-size="22" fill="white">本地测试封面</text></svg>'); return;
          }
          res.setHeader("Content-Type", "application/json");
          if (url.pathname === "/api/v1/library/projects") {
            if (listMode === "error") { res.statusCode = 503; res.end(JSON.stringify({ error: { code: "DOWN", message: "本地测试读取失败" } })); return; }
            const q = url.searchParams.get("q") || "", category = url.searchParams.get("category") || "all";
            requests.push({ q, category, sort: url.searchParams.get("sort") || "updated", cursor: url.searchParams.get("cursor") });
            const found = projects.filter((item) => item.title.includes(q) || item.premise.includes(q));
            const filtered = found.filter((item) => category === "all" || (category === "uncategorized" ? item.categoryId === null : item.categoryId === category));
            const offset = url.searchParams.get("cursor") ? 3 : 0;
            res.end(JSON.stringify({ items: filtered.slice(offset, offset + 3), nextCursor: filtered.length > offset + 3 ? "next" : null,
              total: filtered.length, allCount: found.length, unclassifiedCount: found.filter((item) => !item.categoryId).length,
              categories: categories.map((item) => ({ ...item, count: found.filter((project) => project.categoryId === item.id).length })), categoriesReady: true })); return;
          }
          if (url.pathname.endsWith("/script-workbench/deletion-preview")) {
            const item = projects.find((project) => url.pathname.includes(project.id));
            res.end(JSON.stringify({ projectId: item.id, title: item.title, version: 4, episodeCount: item.episodeCount,
              canDelete: item.id !== P2, blockedReason: item.id === P2 ? "作品仍有任务运行中" : null,
              dependencies: { scenes: 2, shots: 6, speech: 1, video: 0, other: 0, total: 9 } })); return;
          }
          if (req.method === "POST") {
            let raw = ""; for await (const chunk of req) raw += chunk;
            const body = JSON.parse(raw);
            if (url.pathname === "/api/v1/library/categories") { categories.push({ id: body.id, name: body.name }); res.end(JSON.stringify({ ...body, count: 0 })); return; }
            const item = projects.find((project) => url.pathname.includes(project.id));
            if (url.pathname.endsWith("/script-workbench/trash")) {
              assert.notEqual(item.id, P2); assert.equal(body.expectedVersion, 4);
              projects = projects.filter((project) => project.id !== item.id);
              res.end(JSON.stringify({ projectId: item.id })); return;
            }
            assert.equal(body.expectedRevision, item.categoryRevision); item.categoryId = body.categoryId;
            item.categoryName = categories.find((category) => category.id === body.categoryId)?.name || null; item.categoryRevision++;
            res.end(JSON.stringify({ projectId: item.id, categoryId: item.categoryId, categoryName: item.categoryName, categoryRevision: item.categoryRevision })); return;
          }
          if (url.pathname.endsWith("/stories")) {
            const approved = url.pathname.includes(P2);
            res.end(JSON.stringify({ items: [{ id: "story", revisionNo: 1, content: {}, reviewStatus: approved ? "APPROVED" : "DRAFT", freshnessStatus: "CURRENT", reviewVersion: 1 }] })); return;
          }
          res.end(JSON.stringify(url.pathname.endsWith("/workflow-runs") ? [] : { items: [], nextCursor: null })); return;
        }
        if (url.pathname !== "/" && url.pathname !== "/studio") { next(); return; }
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml("/", '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>'));
      });
    },
  }] });
let browser;
try {
  await mkdir(output, { recursive: true }); await server.listen(); browser = await chromium.launch({ headless: true });
  for (const width of [1586, 1440, 1280, 1024, 900, 390]) {
    reset(); listMode = "normal";
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 992 } });
    page.on("pageerror", (error) => evidence.errors.push(error.message));
    await page.goto("http://127.0.0.1:3856/studio");
    await page.getByRole("heading", { name: "重逢在雨夜", exact: true }).waitFor();
    await page.getByText(/第 2 步/).waitFor();
    await page.getByRole("img", { name: "重逢在雨夜封面" }).evaluate((img) => img.decode());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `Horizontal overflow at ${width}`);
    // Check actual cell contents, not just the page width: a fixed-width table can hide overlapping controls.
    if (width >= 900) {
      const layout = await page.locator('tbody tr').evaluateAll((rows) => rows.map((row) => {
        const cells = Array.from(row.querySelectorAll('td'));
        const action = cells.at(-1), controls = Array.from(action.querySelectorAll('a, button')).map((control) => control.getBoundingClientRect());
        const bounds = action.getBoundingClientRect();
        return { height: row.getBoundingClientRect().height,
          sameLine: Math.max(...controls.map((rect) => rect.y)) - Math.min(...controls.map((rect) => rect.y)) <= 4,
          actionsFit: controls.every((rect) => rect.x >= bounds.x && rect.right <= bounds.right + 1),
          noOverlap: controls.every((rect, index) => index === 0 || rect.x >= controls[index - 1].right - 1) };
      }));
      assert.ok(layout.every((row) => row.sameLine && row.actionsFit && row.noOverlap), `Overlapping or stacked actions at ${width}: ${JSON.stringify(layout)}`);
      if (width >= 1440) assert.ok(layout.every((row) => row.height <= 80), `Ordinary rows too tall at ${width}`);
    }
    await page.getByRole("checkbox", { name: "选择作品：重逢在雨夜", exact: true }).check();
    await page.getByRole("checkbox", { name: "选择作品：长街旧事", exact: true }).check();
    assert.equal(await page.getByRole("checkbox", { name: "全选已显示作品" }).getAttribute("aria-checked"), "mixed");
    await page.getByText("已选 2 部", { exact: true }).waitFor();
    if (width >= 1024) {
      const nav = page.getByRole("navigation", { name: "主导航" });
      assert.equal(await nav.getByRole("link", { name: "开始创作", exact: true }).count(), 0);
      assert.equal(await nav.getByRole("link", { name: "帮助", exact: true }).count(), 0);
    }
    const screenshot = `project-library-${width}.png`; await page.screenshot({ path: resolve(output, screenshot), fullPage: true });
    await page.getByRole("button", { name: "取消选择", exact: true }).click();
    await page.getByRole("button", { name: "加载更多作品", exact: true }).click();
    await page.getByRole("heading", { name: "风起的时候", exact: true }).waitFor();
    assert.equal(requests.at(-1).cursor, "next");
    await page.getByRole("textbox", { name: "搜索作品", exact: true }).fill("长街");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page.getByRole("heading", { name: "长街旧事", exact: true }).waitFor();
    assert.equal(await page.getByRole("heading", { name: "重逢在雨夜", exact: true }).count(), 0);
    assert.equal(requests.at(-1).q, "长街");
    await page.getByRole("button", { name: "清除搜索", exact: true }).click();
    await page.getByRole("heading", { name: "重逢在雨夜", exact: true }).waitFor();
    await page.getByRole("button", { name: "新建分类", exact: true }).click();
    await page.getByLabel("分类名称").fill("悬疑推理");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("button", { name: "悬疑推理 0", exact: true }).waitFor();
    const savedCategory = categories.at(-1).id;
    await page.getByRole("checkbox", { name: "选择作品：重逢在雨夜", exact: true }).check();
    await page.getByRole("combobox", { name: "归类所选作品", exact: true }).selectOption(savedCategory);
    await page.getByRole("button", { name: "悬疑推理 1", exact: true }).waitFor();
    assert.equal(projects[0].categoryId, savedCategory);
    await page.getByRole("button", { name: "悬疑推理 1", exact: true }).click();
    await page.getByText("已显示 1 / 1 部作品").waitFor();
    await page.getByRole("checkbox", { name: "选择作品：重逢在雨夜", exact: true }).check();
    await page.getByRole("combobox", { name: "归类所选作品", exact: true }).selectOption("");
    await page.getByRole("heading", { name: "没有符合条件的作品", exact: true }).waitFor();
    const empty = `project-library-empty-${width}.png`; await page.screenshot({ path: resolve(output, empty), fullPage: true });
    listMode = "error"; await page.getByRole("button", { name: "刷新作品列表", exact: true }).click();
    await page.getByRole("alert").waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    const error = `project-library-error-${width}.png`; await page.screenshot({ path: resolve(output, error), fullPage: true });
    listMode = "normal";
    await page.getByRole("button", { name: "全部分类", exact: false }).click();
    await page.getByRole("heading", { name: "重逢在雨夜", exact: true }).waitFor();
    await page.getByRole("checkbox", { name: "选择作品：重逢在雨夜", exact: true }).check();
    await page.getByRole("checkbox", { name: "选择作品：长街旧事", exact: true }).check();
    await page.getByRole("button", { name: "移入回收站", exact: true }).click();
    await page.getByText("可移入 1 部；跳过 1 部。", { exact: true }).waitFor();
    const confirmation = `project-library-delete-${width}.png`;
    await page.screenshot({ path: resolve(output, confirmation), fullPage: true });
    await page.getByRole("button", { name: "确认移入 1 部", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(projects.some((item) => item.id === P), false);
    assert.equal(projects.some((item) => item.id === P2), true);
    await page.getByText(/已移入回收站 1 部，未完成 1 部/).waitFor();
    await page.getByText("已选 0 部", { exact: true }).waitFor();
    evidence.checks.push({ width, screenshot, empty, error, confirmation, batchDeletion: true, runningWorkProtected: true, overflow: false, serverSearch: true, loadMore: true, createCategory: true, assignCategory: true, unclassify: true });
    await page.close();
  }
  assert.deepEqual(evidence.errors, []);
} finally {
  await browser?.close(); await server.close(); await writeFile(resolve(output, "evidence.json"), JSON.stringify(evidence, null, 2));
}
process.stdout.write("Project library browser fixture passed at 1586/1440/1280/1024/900/390: layout, server queries, categories, thumbnails, pagination, empty/error states. No business DB or external provider calls.\n");
