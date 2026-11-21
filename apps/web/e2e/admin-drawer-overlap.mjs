// Admin mobile drawer acceptance. Renders the real AdminShell in Chromium.
// Local Vite fixture only: no API, database, provider, or other external call.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const web = resolve(import.meta.dirname, "..");
const root = resolve(web, "../..");
const requireWeb = createRequire(resolve(web, "package.json"));
const { createServer } = await import(pathToFileURL(requireWeb.resolve("vite")).href);
const { default: react } = await import(pathToFileURL(requireWeb.resolve("@vitejs/plugin-react")).href);
const { chromium } = createRequire(resolve(root, "package.json"))("playwright");
const output = resolve(process.env.ADMIN_DRAWER_EVIDENCE_DIR || resolve(root, "test-results/admin-drawer-overlap"));
const entry = `import React from 'react';import{createRoot}from'react-dom/client';import'/src/app/globals.css';import{AdminShell}from'/src/components/admin-shell.tsx';createRoot(document.getElementById('root')).render(React.createElement(AdminShell,null,React.createElement('main',null,'媒体密钥')));`;
const navigationStub = resolve(import.meta.dirname, "admin-drawer-navigation-stub.mjs");
const evidence = { kind: "chromium-admin-shell-drawer-overlap", externalRequests: 0, checks: [], errors: [] };

// The planned heading is a label. Its rows expand one at a time.
const PLANNED = [
  { name: "创作内容", items: ["作品管理", "素材库"] },
  { name: "系统管理", items: ["用户与权限", "操作日志"] },
];
const ALWAYS_VISIBLE = [
  { role: "text", name: "模型与 API" },
  { role: "link", name: "功能配置" },
  { role: "text", name: "任务与用量" },
  { role: "link", name: "调用记录" },
  { role: "text", name: "规划中的栏目" },
  ...PLANNED.map(({ name }) => ({ role: "button", name })),
];

function intersects(a, b) {
  return a.x < b.right - 0.5 && a.right > b.x + 0.5 && a.y < b.bottom - 0.5 && a.bottom > b.y + 0.5;
}

function contains(outer, inner) {
  return inner.x >= outer.x - 1 && inner.right <= outer.right + 1 && inner.y >= outer.y - 1 && inner.bottom <= outer.bottom + 1;
}

async function box(locator) {
  return locator.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
  });
}

const server = await createServer({
  configFile: false,
  root: web,
  resolve: { alias: [{ find: /^next\/navigation$/, replacement: navigationStub }] },
  optimizeDeps: { include: ["react", "react-dom/client"], exclude: ["next", "next/navigation"] },
  server: { host: "127.0.0.1", port: 3866, strictPort: true },
  plugins: [react(), {
    name: "admin-drawer-fixture",
    resolveId(id) { if (id === "/fixture.tsx") return "\0fixture.tsx"; },
    load(id) { if (id === "\0fixture.tsx") return entry; },
    configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url !== "/" && !req.url?.startsWith("/?")) { next(); return; }
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml("/", '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>'));
      });
    },
  }],
});

let browser;
try {
  await mkdir(output, { recursive: true });
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
  });

  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  desktop.on("pageerror", (error) => evidence.errors.push(error.message));
  await desktop.goto("http://127.0.0.1:3866/");
  await desktop.getByRole("navigation", { name: "管理菜单" }).waitFor();
  const desktopStyles = await desktop.locator("aside").evaluate((el) => {
    const nav = el.querySelector('nav[aria-label="管理菜单"]');
    const footer = [...el.querySelectorAll("div")].find((node) => node.textContent?.includes("平台管理员") && node.querySelector("a")?.textContent === "返回创作中心");
    const read = (node) => {
      const style = getComputedStyle(node);
      return { position: style.position, overflowY: style.overflowY, display: style.display, flexDirection: style.flexDirection };
    };
    return { sidebar: read(el), navigation: read(nav), footer: read(footer) };
  });
  assert.equal(desktopStyles.sidebar.position, "sticky", "desktop sidebar positioning changed");
  assert.equal(desktopStyles.sidebar.overflowY, "auto", "desktop sidebar must keep scrolling as one column");
  assert.equal(desktopStyles.navigation.overflowY, "visible", "desktop nav must not become its own scrollport");
  assert.equal(desktopStyles.footer.position, "static", "desktop account block positioning changed");
  assert.equal(await desktop.getByRole("dialog").count(), 0);
  await desktop.screenshot({ path: resolve(output, "desktop-sidebar-1440.png") });
  evidence.checks.push({ viewport: "1440x900", desktopUnchanged: true, styles: desktopStyles });
  await desktop.close();

  for (const viewport of [{ width: 390, height: 844 }, { width: 390, height: 600 }]) {
    const page = await browser.newPage({ viewport });
    page.on("pageerror", (error) => evidence.errors.push(`${viewport.width}x${viewport.height}: ${error.message}`));
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
        evidence.externalRequests += 1;
        return route.abort();
      }
      return route.continue();
    });
    await page.goto("http://127.0.0.1:3866/");
    await page.getByRole("button", { name: "打开导航", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "管理导航" });
    await dialog.waitFor();
    const nav = dialog.getByRole("navigation", { name: "管理菜单" });
    const account = dialog.locator("div").filter({ hasText: "平台管理员" }).filter({ hasText: "已登录" }).filter({ hasText: "返回创作中心" }).filter({ hasText: "退出" });
    assert.equal(await account.count(), 1, "account block should be the single footer");
    await expandPlanned(nav, "创作内容");
    const heading = nav.getByText("规划中的栏目", { exact: true });
    const creationRow = nav.getByRole("button", { name: "创作内容", exact: true });
    await page.screenshot({ path: resolve(output, `drawer-${viewport.width}x${viewport.height}.png`) });

    const accountBox = await box(account);
    const headingBox = await box(heading);
    const creationBox = await box(creationRow);
    const label = `${viewport.width}x${viewport.height}`;
    assert.equal(intersects(accountBox, headingBox), false, `${label}: account block intersects 规划中的栏目 ${JSON.stringify({ accountBox, headingBox })}`);
    assert.equal(intersects(accountBox, creationBox), false, `${label}: account block intersects 创作内容 ${JSON.stringify({ accountBox, creationBox })}`);
    assert.ok(contains(await box(dialog), accountBox), `${label}: account block is clipped by the drawer`);

    const visible = [];
    for (const group of PLANNED) {
      await expandPlanned(nav, group.name);
      const items = [...ALWAYS_VISIBLE, ...group.items.map((name) => ({ role: "group", name }))];
      for (const item of items) {
        const locator = item.role === "text"
          ? nav.getByText(item.name, { exact: true })
          : nav.getByRole(item.role, { name: item.name, exact: true });
        assert.equal(await locator.count(), 1, `${label}: missing nav item ${item.name}`);
        await locator.evaluate((el) => el.scrollIntoView({ block: "nearest", inline: "nearest" }));
        const itemBox = await box(locator);
        const navBox = await box(nav);
        const footerBox = await box(account);
        const inView = contains(navBox, itemBox) && !intersects(footerBox, itemBox);
        assert.equal(inView, true, `${label}: ${item.name} cannot scroll into view ${JSON.stringify({ itemBox, navBox, footerBox })}`);
        visible.push({ name: item.name, inView });
      }
    }
    await page.screenshot({ path: resolve(output, `drawer-${viewport.width}x${viewport.height}-scrolled.png`) });
    evidence.checks.push({ viewport: label, headingClear: true, creationRowClear: true, accountInDrawer: true, items: visible });
    await page.close();
  }

  assert.deepEqual(evidence.errors, []);
  assert.equal(evidence.externalRequests, 0);
} finally {
  await browser?.close();
  await server.close();
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
}

async function expandPlanned(nav, name) {
  const toggle = nav.getByRole("button", { name, exact: true });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  assert.equal(await toggle.getAttribute("aria-expanded"), "true", `${name} did not expand`);
}

process.stdout.write("Admin drawer: account block stays clear of navigation at 390x844 and 390x600. External requests: 0.\n");
