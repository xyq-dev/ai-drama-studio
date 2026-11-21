// Acceptance screenshots for the operator directory. Local Vite fixture only:
// session and lists are fake JSON. No database, vendor, or credential is used.
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const web = resolve(import.meta.dirname, "../apps/web");
const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "reviews/admin-planned-sections-2026-11-21");
const requireWeb = createRequire(resolve(web, "package.json"));
const { createServer } = await import(pathToFileURL(requireWeb.resolve("vite")).href);
const { default: react } = await import(pathToFileURL(requireWeb.resolve("@vitejs/plugin-react")).href);
const { chromium } = createRequire(resolve(root, "package.json"))("playwright");
const navigationStub = resolve(web, "e2e/admin-planned-sections-navigation-stub.mjs");

const entry = `
import React from "react";
import { createRoot } from "react-dom/client";
import "/src/app/globals.css";
import { AdminShell } from "/src/components/admin-shell.tsx";
import { AdminDirectory } from "/src/components/admin-directory.tsx";

const params = new URLSearchParams(location.search);
const kind = params.get("kind") || "works";
const mode = params.get("mode") || "list";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const works = [
  { id: "11111111-1111-4111-8111-111111111111", title: "雨夜来信", updatedAt: "2026-11-21T10:24:00.000Z", ownerName: "linxia", ownerLegacy: false, productionLabel: "制作中", episodeProgress: "共 3 集，第 1 集制作中", recentTask: "分镜生图进行中", reviewHref: "/admin/works/11111111-1111-4111-8111-111111111111/review" },
  { id: "22222222-2222-4222-8222-222222222222", title: "旧巷灯火", updatedAt: "2026-11-21T06:02:00.000Z", ownerName: "aze", ownerLegacy: false, productionLabel: "剧本待审", episodeProgress: "共 2 集，剧本待审", recentTask: "剧本编写 · 成功", reviewHref: "/admin/works/22222222-2222-4222-8222-222222222222/review" },
  { id: "33333333-3333-4333-8333-333333333333", title: "南风过境", updatedAt: "2026-11-20T13:16:00.000Z", ownerName: "zhouyu", ownerLegacy: false, productionLabel: "分镜中", episodeProgress: "共 1 集，第 1 集分镜中", recentTask: "分镜生图进行中", reviewHref: "/admin/works/33333333-3333-4333-8333-333333333333/review" },
  { id: "44444444-4444-4444-8444-444444444444", title: "海边的信", updatedAt: "2026-11-18T01:40:00.000Z", ownerName: "linxia", ownerLegacy: false, productionLabel: "已完结", episodeProgress: "共 4 集，已完结", recentTask: "视频生成成功", reviewHref: "/admin/works/44444444-4444-4444-8444-444444444444/review" },
  { id: "55555555-5555-4555-8555-555555555555", title: "城南旧事·番外", updatedAt: "2026-11-17T08:05:00.000Z", ownerName: "chenke", ownerLegacy: false, productionLabel: "草稿", episodeProgress: "尚未分集", recentTask: "尚无生成任务", reviewHref: "/admin/works/55555555-5555-4555-8555-555555555555/review" },
];
const assets = [
  { id: "a1", name: "第 1 集 · 镜号 03", type: "image", typeLabel: "分镜图", projectTitle: "雨夜来信", updatedAt: "2026-11-21T10:10:00.000Z", sourceTask: "分镜生图 · JOB-2184", contentHref: "/missing-preview" },
  { id: "a2", name: "第 1 集 · 镜号 07", type: "image", typeLabel: "分镜图", projectTitle: "雨夜来信", updatedAt: "2026-11-21T10:08:00.000Z", sourceTask: "分镜生图 · JOB-2180", contentHref: "/missing-preview" },
  { id: "a3", name: "林夏旁白 · 第 1 集", type: "voice", typeLabel: "角色配音", projectTitle: "雨夜来信", updatedAt: "2026-11-21T09:42:00.000Z", sourceTask: "角色配音 · JOB-2177", contentHref: "/missing-preview" },
  { id: "a4", name: "旧巷灯火 · 第 2 集成片", type: "video", typeLabel: "成片视频", projectTitle: "旧巷灯火", updatedAt: "2026-11-20T14:05:00.000Z", sourceTask: "视频生成 · JOB-2100", contentHref: "/missing-preview" },
  { id: "a5", name: "第 1 集 · 镜号 01", type: "image", typeLabel: "分镜图", projectTitle: "南风过境", updatedAt: "2026-11-20T13:10:00.000Z", sourceTask: "分镜生图 · JOB-2090", contentHref: "/missing-preview" },
];
const jobs = [
  { id: "j1", code: "JOB-2184", typeLabel: "分镜生图", subject: "雨夜来信 / 第 1 集", updatedAt: "2026-11-21T10:12:00.000Z", status: "succeeded", statusLabel: "成功", action: "view" },
  { id: "j2", code: "JOB-2177", typeLabel: "角色配音", subject: "雨夜来信 / 第 1 集", updatedAt: "2026-11-21T10:20:00.000Z", status: "running", statusLabel: "进行中", action: "view" },
  { id: "j3", code: "JOB-2169", typeLabel: "分镜生图", subject: "旧巷灯火 / 第 2 集", updatedAt: "2026-11-21T10:16:41.000Z", status: "failed", statusLabel: "失败", action: "retry" },
  { id: "j4", code: "JOB-2160", typeLabel: "视频生成", subject: "南风过境 / 第 1 集", updatedAt: "2026-11-21T03:05:00.000Z", status: "unknown", statusLabel: "结果未知", action: "view" },
  { id: "j5", code: "JOB-2148", typeLabel: "剧本编写", subject: "海边的信 / 第 3 集", updatedAt: "2026-11-20T01:18:00.000Z", status: "canceled", statusLabel: "已取消", action: "view" },
  { id: "j6", code: "JOB-2142", typeLabel: "分镜生图", subject: "城南旧事·番外 / 第 1 集", updatedAt: "2026-11-21T10:22:00.000Z", status: "queued", statusLabel: "排队中", action: "view" },
];
const users = [
  { id: "operator", displayName: "平台管理员", username: "admin", role: "operator", roleLabel: "平台管理员", status: "ACTIVE", statusLabel: "已启用", activityAt: null, activitySource: "unknown", mutable: false },
  { id: "u1", displayName: "linxia", username: "linxia", role: "creator", roleLabel: "创作者", status: "ACTIVE", statusLabel: "已启用", activityAt: "2026-11-21T10:18:24.000Z", activitySource: "updated_at", mutable: true },
  { id: "u2", displayName: "aze", username: "aze", role: "creator", roleLabel: "创作者", status: "ACTIVE", statusLabel: "已启用", activityAt: "2026-11-20T13:00:00.000Z", activitySource: "updated_at", mutable: true },
  { id: "u3", displayName: "zhouyu", username: "zhouyu", role: "creator", roleLabel: "创作者", status: "DISABLED", statusLabel: "已停用", activityAt: "2026-11-12T01:18:00.000Z", activitySource: "updated_at", mutable: true },
  { id: "u4", displayName: "chenke", username: "chenke", role: "creator", roleLabel: "创作者", status: "ACTIVE", statusLabel: "已启用", activityAt: "2026-11-17T08:05:00.000Z", activitySource: "updated_at", mutable: true },
];
const logs = [
  { id: "l1", at: "2026-11-21T13:21:06.000Z", actor: "平台管理员", action: "启用功能配置", target: "剧本编写 · DeepSeek", result: "success", secretStatus: null, secretMask: null, source: "管理后台 /admin/features", detail: "已启用刚刚测试通过的草稿。完整密钥未写入。" },
  { id: "l2", at: "2026-11-21T12:48:00.000Z", actor: "平台管理员", action: "保存媒体密钥", target: "MiniMax · 已保存 (sk-***8hd)", result: "success", secretStatus: "已保存", secretMask: "sk-***8hd", source: "管理后台 /admin/media-keys", detail: "日志只记录掩码状态和操作结果，完整密钥未写入，也不会在详情中展示。" },
  { id: "l3", at: "2026-11-21T11:12:00.000Z", actor: "平台管理员", action: "清除媒体密钥", target: "分镜生图 · 阿里云 · 已清除", result: "success", secretStatus: "已清除", secretMask: null, source: "管理后台 /admin/media-keys", detail: "日志只记录掩码状态和操作结果，完整密钥未写入，也不会在详情中展示。" },
  { id: "l4", at: "2026-11-21T10:01:00.000Z", actor: "平台管理员", action: "登录后台", target: "/admin", result: "success", secretStatus: null, secretMask: null, source: "管理后台 /admin", detail: "管理员登录。日志不记录密码。" },
  { id: "l5", at: "2026-11-20T08:40:00.000Z", actor: "平台管理员", action: "调整用户状态", target: "zhouyu · 创作者 · 已停用", result: "success", secretStatus: null, secretMask: null, source: "管理后台 /admin/users", detail: "只调整创作者的现有状态列。没有新增角色或工作区。" },
  { id: "l6", at: "2026-11-20T03:22:00.000Z", actor: "平台管理员", action: "测试功能配置", target: "分镜生图 · 阿里云", result: "failed", secretStatus: null, secretMask: null, source: "管理后台 /admin/features", detail: "测试结果已记录。完整密钥未写入。" },
];
const lists = { works, assets, jobs, users, logs };
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes("/auth/session")) {
    const role = mode === "forbidden" ? "creator" : "operator";
    return json({ enabled: true, authenticated: true, role, username: role === "operator" ? "admin" : "linxia" });
  }
  if (mode === "loading") return new Promise(() => {});
  if (mode === "failed" || mode === "unconfigured") return mode === "unconfigured" ? json({ storage: "unconfigured", items: [], total: 0 }) : json({}, 503);
  if (mode === "empty") return json({ items: [], total: 0, owners: [], projects: [], actors: [], storage: "ready" });
  const items = lists[kind] || [];
  return json({ items, total: items.length, owners: [{ id: "u1", name: "linxia" }], projects: [{ id: "p1", title: "雨夜来信" }], actors: ["平台管理员"], storage: "ready" });
};
createRoot(document.getElementById("root")).render(React.createElement(AdminShell, null, React.createElement(AdminDirectory, { kind })));
`;

const server = await createServer({
  configFile: false,
  root: web,
  resolve: { alias: [{ find: /^next\/navigation$/, replacement: navigationStub }] },
  optimizeDeps: { include: ["react", "react-dom/client"], exclude: ["next", "next/navigation"] },
  server: { host: "127.0.0.1", port: 3877, strictPort: true },
  plugins: [react(), {
    name: "admin-planned-fixture",
    resolveId(id) { if (id === "/fixture.tsx") return "\0fixture.tsx"; },
    load(id) { if (id === "\0fixture.tsx") return entry; },
    configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "";
        if (url !== "/" && !url.startsWith("/?")) { next(); return; }
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml("/", `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700&display=swap"><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>`));
      });
    },
  }],
});

const shots = [
  ["01-desktop-works-list", "/?path=/admin/works&kind=works&mode=list", 1440, 900],
  ["02-desktop-works-empty", "/?path=/admin/works&kind=works&mode=empty", 1440, 900],
  ["03-desktop-works-loading", "/?path=/admin/works&kind=works&mode=loading", 1440, 900],
  ["04-desktop-works-noperm", "/?path=/admin/works&kind=works&mode=forbidden", 1440, 900],
  ["05-desktop-works-fail", "/?path=/admin/works&kind=works&mode=failed", 1440, 900],
  ["06-desktop-works-detail", "/?path=/admin/works&kind=works&mode=list", 1440, 900, async (page) => { await page.getByRole("button", { name: "查看" }).first().click(); await page.getByRole("link", { name: "打开核对" }).waitFor(); }],
  ["07-desktop-assets-list", "/?path=/admin/assets&kind=assets&mode=list", 1440, 900],
  ["08-desktop-assets-preview", "/?path=/admin/assets&kind=assets&mode=list", 1440, 900, async (page) => { await page.getByRole("button", { name: "预览" }).first().click(); await page.getByRole("heading", { name: "第 1 集 · 镜号 03" }).waitFor(); }],
  ["09-desktop-jobs-list", "/?path=/admin/jobs&kind=jobs&mode=list", 1440, 900],
  ["10-desktop-jobs-confirm", "/?path=/admin/jobs&kind=jobs&mode=list", 1440, 900, async (page) => { await page.getByRole("button", { name: "重试" }).click(); await page.getByRole("heading", { name: "确认重试该任务？" }).waitFor(); }],
  ["11-desktop-users-list", "/?path=/admin/users&kind=users&mode=list", 1440, 900],
  ["12-desktop-users-create", "/?path=/admin/users&kind=users&mode=list", 1440, 900, async (page) => { await page.getByRole("button", { name: "创建创作者账号" }).click(); await page.getByRole("heading", { name: "创建创作者账号" }).waitFor(); }],
  ["13-desktop-logs-list", "/?path=/admin/logs&kind=logs&mode=list", 1440, 900],
  ["14-desktop-logs-detail", "/?path=/admin/logs&kind=logs&mode=list", 1440, 900, async (page) => { await page.getByRole("button", { name: "详情" }).nth(1).click(); await page.getByRole("heading", { name: "保存媒体密钥" }).waitFor(); }],
  ["15-mobile-works-list", "/?path=/admin/works&kind=works&mode=list", 390, 844],
  ["16-mobile-works-directory", "/?path=/admin/works&kind=works&mode=list", 390, 844, async (page) => { await page.getByRole("button", { name: "目录" }).click(); await page.getByRole("dialog", { name: "管理导航" }).waitFor(); }],
  ["17-mobile-works-empty", "/?path=/admin/works&kind=works&mode=empty", 390, 844],
  ["18-mobile-works-loading", "/?path=/admin/works&kind=works&mode=loading", 390, 844],
  ["19-mobile-works-noperm", "/?path=/admin/works&kind=works&mode=forbidden", 390, 844],
  ["20-mobile-works-fail", "/?path=/admin/works&kind=works&mode=failed", 390, 844],
  ["21-mobile-assets-list", "/?path=/admin/assets&kind=assets&mode=list", 390, 844],
  ["22-mobile-jobs-confirm", "/?path=/admin/jobs&kind=jobs&mode=list", 390, 844, async (page) => { await page.getByRole("button", { name: "重试" }).click(); await page.getByRole("heading", { name: "确认重试该任务？" }).waitFor(); }],
  ["23-mobile-users-create", "/?path=/admin/users&kind=users&mode=list", 390, 844, async (page) => { await page.getByRole("button", { name: "创建创作者账号" }).click(); await page.getByRole("heading", { name: "创建创作者账号" }).waitFor(); }],
  ["24-mobile-logs-detail", "/?path=/admin/logs&kind=logs&mode=list", 390, 844, async (page) => { await page.getByRole("button", { name: "详情" }).nth(1).click(); await page.getByRole("heading", { name: "保存媒体密钥" }).waitFor(); }],
  ["25-desktop-assets-empty", "/?path=/admin/assets&kind=assets&mode=empty", 1440, 900],
  ["26-desktop-jobs-empty", "/?path=/admin/jobs&kind=jobs&mode=empty", 1440, 900],
  ["27-desktop-users-empty", "/?path=/admin/users&kind=users&mode=empty", 1440, 900],
  ["28-desktop-logs-empty", "/?path=/admin/logs&kind=logs&mode=empty", 1440, 900],
  ["29-desktop-assets-noperm", "/?path=/admin/assets&kind=assets&mode=forbidden", 1440, 900],
  ["30-desktop-jobs-noperm", "/?path=/admin/jobs&kind=jobs&mode=forbidden", 1440, 900],
  ["31-desktop-logs-fail", "/?path=/admin/logs&kind=logs&mode=failed", 1440, 900],
];

await mkdir(output, { recursive: true });
await server.listen();
const browser = await chromium.launch({ headless: true });
try {
  for (const [name, path, width, height, action] of shots) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(`http://127.0.0.1:3877${path}`, { waitUntil: "domcontentloaded" });
    if (path.includes("mode=loading")) await page.getByRole("heading", { name: /正在加载/ }).waitFor();
    else if (path.includes("mode=forbidden")) await page.getByRole("heading", { name: /没有/ }).waitFor();
    else if (path.includes("mode=failed")) await page.getByRole("heading", { name: /失败/ }).waitFor();
    else if (path.includes("mode=empty")) await page.getByRole("heading", { name: /还没有/ }).waitFor();
    else await page.getByRole("heading", { level: 2 }).waitFor();
    if (action) await action(page);
    await page.screenshot({ path: resolve(output, `${name}.png`) });
    await page.close();
    process.stdout.write(`wrote ${name}.png\n`);
  }
} finally {
  await browser.close();
  await server.close();
}
