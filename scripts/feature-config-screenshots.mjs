#!/usr/bin/env node
/**
 * Acceptance screenshots for T-ENG-WEB-FEATURE-CONFIG.
 * Local mock API only. No real vendor, secret, or database.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "reviews", "feature-config-2026-11-21");
const API_PORT = 18082;
const WEB_PORT = 13010;
const CSRF = "c".repeat(43);

const openai = [
  { id: "gpt-6-astra", label: "GPT-6 Astra" },
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
  { id: "gpt-6-luna", label: "GPT-6 Luna" },
];

function slot(vendor, label, connected, models, extra = {}) {
  return {
    vendor, label, connected, gap: connected ? null : "该服务商尚未接入。",
    models, model: models[0]?.id ?? null, keyConfigured: false, draftStatus: "blank",
    testToken: null, failureMessage: null, ...extra,
  };
}

function card(feature, label, slots, extra = {}) {
  return {
    feature, label, live: null, firstTime: true,
    probeScale: "1 次最小请求",
    probeCostNote: "可能产生供应商费用。金额未回传前不会显示为 0。取消则不会发起调用。",
    slots, ...extra,
  };
}

const writingSlots = [
  slot("bailian", "阿里云", false, [], { gap: "剧本编写的阿里云百炼文本适配器已退役，无法保存、测试或启用。接入缺口：在用的百炼编剧适配器。" }),
  slot("openai", "OpenAI", true, openai),
  slot("deepseek", "DeepSeek", true, [{ id: "deepseek-flash", label: "DeepSeek Flash" }]),
];
const storyboardSlots = [
  slot("bailian", "阿里云", true, [{ id: "qwen-image-3.0", label: "Qwen Image" }]),
  slot("openai", "OpenAI", true, [{ id: "gpt-image-2.5-sunburst", label: "GPT Image Sunburst" }]),
  slot("google", "Google", false, [], { gap: "分镜生图目前没有 Google 生图适配器，无法保存、测试或启用。接入缺口：Google 图像生成适配器。" }),
];
const voiceSlots = [
  slot("bailian", "阿里云", true, [{ id: "qwen3-tts-flash", label: "qwen3-tts-flash" }]),
  slot("minimax", "MiniMax", true, [{ id: "speech-2.8-hd", label: "speech-2.8-hd" }]),
];

function cloneSlots(slots) {
  return slots.map((item) => ({ ...item, models: item.models.map((model) => ({ ...model })) }));
}

function emptyView() {
  return {
    revision: 4,
    validation: "local_only",
    features: [
      card("writing", "剧本编写", cloneSlots(writingSlots)),
      card("storyboard", "分镜生图", cloneSlots(storyboardSlots)),
      card("voice", "角色配音", cloneSlots(voiceSlots)),
    ],
  };
}

function savedView() {
  const view = emptyView();
  const storyboard = view.features[1];
  storyboard.firstTime = false;
  storyboard.live = { source: "enabled", vendor: "openai", vendorLabel: "OpenAI", model: "gpt-image-2.5-sunburst", modelLabel: "GPT Image Sunburst", version: "ver_live" };
  const bailian = storyboard.slots[0];
  bailian.keyConfigured = true;
  bailian.draftStatus = "saved";
  bailian.model = "qwen-image-3.0";
  view.features[0].firstTime = false;
  view.features[0].live = { source: "legacy", vendor: "deepseek", vendorLabel: "DeepSeek", model: "deepseek-flash", modelLabel: "DeepSeek Flash", version: null };
  view.features[2].firstTime = false;
  view.features[2].live = { source: "enabled", vendor: "minimax", vendorLabel: "MiniMax", model: "speech-2.8-hd", modelLabel: "speech-2.8-hd", version: "ver_voice" };
  return view;
}

function passedView() {
  const view = savedView();
  const bailian = view.features[1].slots[0];
  bailian.draftStatus = "passed";
  bailian.testToken = "t".repeat(24);
  return view;
}

const usage = {
  scope: "episode_production",
  projectId: "work-1",
  episodeId: "ep-1",
  projects: [{ id: "work-1", label: "雨夜来信" }],
  episodes: [{ id: "ep-1", label: "第 1 集", projectId: "work-1" }],
  totals: [
    { feature: "writing", featureLabel: "剧本编写", usageText: "未知", costText: "未知" },
    { feature: "storyboard", featureLabel: "分镜生图", usageText: "2 张", costText: "待回传费用" },
    { feature: "voice", featureLabel: "角色配音", usageText: "未知", costText: "未知" },
  ],
  records: [{
    id: "rec-1", taskId: "task-1", attempt: 1, feature: "storyboard", featureLabel: "分镜生图",
    vendorLabel: "阿里云", modelLabel: "Qwen Image", configVersion: "ver_live", result: "succeeded",
    startedAt: "2026-11-21T02:00:00.000Z", usageText: "1 张", costText: "待回传费用",
    projectId: "work-1", projectLabel: "雨夜来信", episodeId: "ep-1", episodeLabel: "第 1 集",
    kind: "production", credentialRef: null,
  }],
  footnote: "仅汇总已确认金额；部分费用待回传。未知用量按原样保留，不会显示为 0。不同单位分别汇总。管理员测试不计入本集生产汇总。",
};

const operator = {
  enabled: true, authenticated: true, role: "operator", username: "admin", csrfToken: CSRF,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};
const creator = { ...operator, role: "creator", username: "creator-a" };

function startMockApi() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" });
      if (req.method === "OPTIONS") { res.end(); return; }
      const url = req.url ?? "/";
      if (url.startsWith("/api/v1/auth/session")) { res.end(JSON.stringify(operator)); return; }
      if (url.startsWith("/api/v1/admin/usage")) { res.end(JSON.stringify(usage)); return; }
      res.end(JSON.stringify(savedView()));
    });
    server.listen(API_PORT, "127.0.0.1", () => resolve(server));
  });
}

function waitForUrl(url, timeoutMs = 120_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const response = await fetch(url, { redirect: "manual" });
        if (response.status < 500) { resolve(); return; }
      } catch { /* retry */ }
      if (Date.now() - started > timeoutMs) { reject(new Error(`Timed out waiting for ${url}`)); return; }
      setTimeout(tick, 1000);
    };
    void tick();
  });
}

async function capture(browser, shot) {
  const context = await browser.newContext({ viewport: { width: shot.width, height: shot.height }, deviceScaleFactor: 1 });
  await context.addCookies([
    { name: "ads_csrf", value: CSRF, domain: "127.0.0.1", path: "/" },
    { name: "ads_session", value: "screenshot-session", domain: "127.0.0.1", path: "/" },
  ]);
  const page = await context.newPage();
  await page.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent = "nextjs-portal, #__next-build-watcher, [data-nextjs-toast], [data-next-badge-root], [data-nextjs-dev-tools-button], button[aria-label='Open Next.js Dev Tools'] { display: none !important; visibility: hidden !important; }";
    document.documentElement.appendChild(style);
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = request.url();
    if (url.includes("/auth/session")) {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(shot.session ?? operator) });
      return;
    }
    if (shot.hang && url.includes("/admin/features")) return;
    if (request.method() === "POST" && url.includes("/test")) {
      const failed = savedView();
      failed.features[1].slots[0].draftStatus = "failed";
      failed.features[1].slots[0].failureMessage = "测试没有通过，草稿已保留，可以重试。";
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ view: failed, probe: { ok: false, message: "测试没有通过，草稿已保留，可以重试。" } }) });
      return;
    }
    if (url.includes("/admin/usage")) {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(shot.usage ?? usage) });
      return;
    }
    const features = shot.features === "empty" ? emptyView() : shot.features === "passed" ? passedView() : savedView();
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(features) });
  });
  await page.goto(`http://127.0.0.1:${WEB_PORT}${shot.path}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.getByRole("heading", { name: shot.heading }).waitFor({ timeout: 60_000 });
  if (shot.openDraft) await page.getByRole("button", { name: "修改配置" }).click();
  if (shot.ready) await page.getByText(shot.ready).first().waitFor({ timeout: 60_000 });
  if (shot.action) await shot.action(page);
  const hideDev = () => document.querySelectorAll("nextjs-portal, [data-nextjs-dev-tools-button], button[aria-label='Open Next.js Dev Tools']").forEach((node) => node.remove());
  await page.evaluate(hideDev);
  await page.waitForTimeout(300);
  await page.evaluate(hideDev);
  const file = path.join(outDir, shot.name);
  await page.screenshot({ path: file, fullPage: false });
  await context.close();
  console.log(`wrote ${file}`);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const api = await startMockApi();
  const web = spawn("pnpm", ["exec", "next", "dev", "--hostname", "127.0.0.1", "--port", String(WEB_PORT)], {
    cwd: path.join(root, "apps/web"),
    env: { ...process.env, NEXT_PUBLIC_API_BASE_URL: `http://127.0.0.1:${API_PORT}`, NODE_ENV: "development", NEXT_DISABLE_DEVTOOLS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let webLog = "";
  web.stdout.on("data", (chunk) => { webLog += chunk.toString(); });
  web.stderr.on("data", (chunk) => { webLog += chunk.toString(); });
  const shots = [
    { name: "desktop-storyboard-saved.png", path: "/admin/features?feature=storyboard&vendor=bailian", width: 1440, height: 900, heading: "模型与密钥", openDraft: true, ready: "草稿未启用" },
    { name: "mobile-storyboard-saved.png", path: "/admin/features?feature=storyboard&vendor=bailian", width: 390, height: 844, heading: "模型与密钥", openDraft: true, ready: "草稿未启用" },
    { name: "desktop-writing-first.png", path: "/admin/features?feature=writing", width: 1440, height: 900, heading: "当前生效配置", ready: "尚未配置", features: "empty" },
    { name: "desktop-storyboard-first.png", path: "/admin/features?feature=storyboard", width: 1440, height: 900, heading: "当前生效配置", ready: "尚未配置", features: "empty" },
    { name: "desktop-voice-first.png", path: "/admin/features?feature=voice", width: 1440, height: 900, heading: "当前生效配置", ready: "尚未配置", features: "empty" },
    { name: "mobile-writing-first.png", path: "/admin/features?feature=writing", width: 390, height: 844, heading: "当前生效配置", ready: "尚未配置", features: "empty" },
    { name: "mobile-storyboard-first.png", path: "/admin/features?feature=storyboard", width: 390, height: 844, heading: "当前生效配置", ready: "尚未配置", features: "empty" },
    { name: "mobile-voice-first.png", path: "/admin/features?feature=voice", width: 390, height: 844, heading: "当前生效配置", ready: "尚未配置", features: "empty" },
    { name: "desktop-no-permission.png", path: "/admin/features", width: 1440, height: 900, heading: "没有配置权限", session: creator },
    { name: "mobile-no-permission.png", path: "/admin/features", width: 390, height: 844, heading: "没有配置权限", session: creator },
    { name: "desktop-loading.png", path: "/admin/features", width: 1440, height: 900, heading: "正在加载配置", hang: true },
    { name: "mobile-loading.png", path: "/admin/features", width: 390, height: 844, heading: "正在加载配置", hang: true },
    { name: "desktop-unconnected.png", path: "/admin/features?feature=voice&vendor=openai", width: 1440, height: 900, heading: "该服务商尚未接入" },
    { name: "mobile-unconnected.png", path: "/admin/features?feature=voice&vendor=openai", width: 390, height: 844, heading: "该服务商尚未接入" },
    { name: "desktop-usage.png", path: "/admin/usage", width: 1440, height: 900, heading: "本集调用" },
    { name: "mobile-usage.png", path: "/admin/usage", width: 390, height: 844, heading: "本集调用" },
    { name: "desktop-task-detail.png", path: "/admin/usage", width: 1440, height: 900, heading: "本集调用", action: async (page) => { await page.getByRole("button", { name: /分镜生图/ }).click(); await page.getByRole("dialog", { name: "任务详情" }).waitFor(); } },
    { name: "desktop-test-confirm.png", openDraft: true, path: "/admin/features?feature=storyboard&vendor=bailian", width: 1440, height: 900, heading: "模型与密钥", action: async (page) => { await page.getByRole("button", { name: "验证草稿" }).click(); await page.getByRole("dialog", { name: "确认测试费用" }).waitFor(); } },
    { name: "desktop-test-failed.png", openDraft: true, path: "/admin/features?feature=storyboard&vendor=bailian", width: 1440, height: 900, heading: "模型与密钥", action: async (page) => { await page.getByRole("button", { name: "验证草稿" }).click(); await page.getByRole("button", { name: "确认测试" }).click(); await page.getByText("检测未通过", { exact: true }).waitFor(); } },
    { name: "desktop-enable-confirm.png", openDraft: true, path: "/admin/features?feature=storyboard&vendor=bailian", width: 1440, height: 900, heading: "模型与密钥", features: "passed", action: async (page) => { await page.getByRole("button", { name: "确认启用" }).click(); await page.getByRole("dialog", { name: "确认启用" }).waitFor(); } },
    { name: "mobile-menu.png", path: "/admin/features", width: 390, height: 844, heading: "模型与密钥", action: async (page) => { await page.getByRole("button", { name: "打开功能配置目录" }).click(); await page.getByRole("dialog", { name: "管理导航" }).waitFor(); } },
  ];
  try {
    await waitForUrl(`http://127.0.0.1:${WEB_PORT}/login`);
    const browser = await chromium.launch({ headless: true });
    for (const shot of shots) await capture(browser, shot);
    await browser.close();
  } catch (error) {
    console.error(webLog.slice(-4000));
    throw error;
  } finally {
    web.kill("SIGTERM");
    api.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
