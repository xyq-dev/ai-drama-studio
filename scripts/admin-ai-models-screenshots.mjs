// Walk both admin paths against the isolated preview and capture 1440×900 / 390×844 screenshots.
// Uses isolated-env test credentials and the in-process mock probe. No paid outbound.
import { createRequire } from "node:module";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const require = createRequire(import.meta.url);
const { WRITING_MODEL_CHANNELS } = createRequire(resolve(root, "apps/web/package.json"))("@ai-drama/contracts");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const reviewDir =
  process.env.ADMIN_AI_MODELS_REVIEW_DIR ||
  "/workspace/drama-studio/reviews/admin-ai-models-writing-2026-11-23";
const secretsDir = process.env.ADMIN_AI_MODELS_SECRETS_DIR || resolve(reviewDir, ".secrets");
const outDir = resolve(reviewDir, "screenshots");
const origin = process.env.ADMIN_AI_MODELS_ORIGIN || "http://127.0.0.1:3822";
const password = readFileSync(resolve(secretsDir, "ADMIN_MODELS_TEST_PASSWORD"), "utf8").trim();
const username = process.env.SITE_AUTH_USERNAME || "admin";

// Clearly fake isolated keys. Never printed. The FAILPROBE token trips the mock probe.
const KEYS = {
  openai: "sk-test-isolated-openai-key-not-real",
  deepseek: "fake-deepseek-isolated-key-not-real",
  bailianFail: "FAILPROBE-bailian-isolated-key-not-real",
  bailianPlan: "sk-sp-test-only-not-a-real-key",
  bailianPass: "fake-bailian-isolated-key-not-real",
  deepseekFail: "FAILPROBE-deepseek-isolated-key-not-real",
};
const FORBIDDEN = [password, ...Object.values(KEYS)];

mkdirSync(outDir, { recursive: true });
const shots = [];
const checks = [];

function leaked(text) {
  return FORBIDDEN.some((secret) => text.includes(secret));
}

async function assertClean(page, name) {
  const html = await page.evaluate(() => {
    const clone = document.documentElement.cloneNode(true);
    for (const input of clone.querySelectorAll('input[type="password"]')) input.value = "";
    return clone.outerHTML;
  });
  assert.equal(leaked(html), false, `Secret appeared in DOM for ${name}`);
}

async function chooseWritingModel(page, vendor, modelId) {
  const drawer = page.getByRole("dialog", { name: "修改配置" });
  await drawer.getByRole("combobox", { name: "供应商", exact: true }).selectOption(vendor);
  await chooseModel(drawer, vendor, modelId);
}

async function chooseModel(drawer, vendor, modelId) {
  const model = WRITING_MODEL_CHANNELS[vendor].models.find(({ id }) => id === modelId);
  assert.ok(model, `Missing fixture model: ${vendor}/${modelId}`);
  await drawer.getByRole("combobox", { name: "模型", exact: true }).click();
  await drawer.getByRole("option").filter({ hasText: model.label }).click();
}

async function checkDraftColor(page, passed) {
  const label = passed ? "检测通过" : "检测未通过";
  const status = page.getByRole("dialog", { name: "修改配置" }).getByText(label, { exact: true });
  await status.waitFor();
  const color = await status.evaluate((node) => getComputedStyle(node).color);
  const [red, green, blue] = color.match(/\d+/g).map(Number);
  assert.ok(passed ? green > Math.max(red, blue) : red > Math.max(green, blue), label + " " + color);
  checks.push({ label, color, viewport: page.viewportSize() });
}

async function revealPrimary(page, locator, label) {
  await locator.scrollIntoViewIfNeeded();
  await page.waitForTimeout(120);
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(box, `${label}: no bounding box`);
  assert.ok(box.y >= 0 && box.y + box.height <= viewport.height, `${label}: outside viewport`);
  assert.ok(box.x >= 0 && box.x + box.width <= viewport.width, `${label}: horizontally clipped`);
  const hit = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const target = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    let clipped = false;
    for (let node = element.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/(hidden|clip)/.test(style.overflowY) || /(hidden|clip)/.test(style.overflow)) {
        const outer = node.getBoundingClientRect();
        if (rect.bottom > outer.bottom + 0.5 || rect.top < outer.top - 0.5) clipped = true;
      }
    }
    return { onTop: target === element || element.contains(target), clipped };
  });
  assert.ok(hit.onTop, `${label}: covered by another element`);
  assert.ok(!hit.clipped, `${label}: clipped by an overflow ancestor`);
  checks.push({ label, box, ...hit });
}

async function shotScrolled(page, name) {
  await hideDevBadge(page);
  await page.evaluate(async () => {
    await document.fonts.ready;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.waitForTimeout(80);
  const file = `${name}.png`;
  await page.screenshot({ path: resolve(outDir, file), fullPage: false });
  await assertClean(page, name);
  shots.push(file);
}

async function hideDevBadge(page) {
  await page
    .addStyleTag({
      content: `nextjs-portal,[data-next-badge],[data-next-badge-root],[data-nextjs-dev-indicator],#__next-build-watcher{display:none!important;visibility:hidden!important;pointer-events:none!important}`,
    })
    .catch(() => {});
}

async function shot(page, name) {
  await hideDevBadge(page);
  await page.evaluate(async () => {
    await document.fonts.ready;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(80);
  const file = `${name}.png`;
  await page.screenshot({ path: resolve(outDir, file), fullPage: false });
  await assertClean(page, name);
  shots.push(file);
}

async function signIn(page) {
  await page.goto(`${origin}/login`);
  await page.locator('input[name="username"]').fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL((url) => url.pathname !== "/login");
  await page.goto(`${origin}/admin/ai-models`);
  await page.getByRole("heading", { name: "模型供应商", exact: true }).waitFor();
}

async function gotoReady(page, path, heading) {
  await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: heading, exact: true }).waitFor({ timeout: 60_000 });
  // Headings also render in the loading intro; wait until the loading gate is gone.
  await page
    .getByRole("heading", { name: "正在加载配置" })
    .waitFor({ state: "detached", timeout: 60_000 })
    .catch(() => {});
  await page
    .getByText("正在核对登录身份", { exact: false })
    .waitFor({ state: "detached", timeout: 30_000 })
    .catch(() => {});
}

async function openMenu(page, category) {
  await page.getByRole("button", { name: `打开${category}目录` }).click();
  await page.getByRole("dialog", { name: "管理导航" }).waitFor();
}

async function walkDesktop(page) {
  await gotoReady(page, "/admin/ai-models", "模型供应商");
  await shot(page, "desktop-vendor-catalog-empty");
  assert.equal(
    await page.getByText("演示", { exact: true }).count(),
    0,
    "演示 badge must not render",
  );
  await shot(page, "desktop-vendor-catalog-nobadge-fixed");

  await page.getByRole("link", { name: "进入设置" }).nth(1).click(); // OpenAI is second
  await page.getByRole("heading", { name: "OpenAI", exact: true }).waitFor();
  await shot(page, "desktop-openai-settings-empty");

  await page.getByRole("button", { name: "编辑设置" }).click();
  await page.getByRole("dialog", { name: "编辑设置" }).waitFor();
  await shot(page, "desktop-openai-edit-drawer");
  await chooseModel(page.getByRole("dialog", { name: "编辑设置" }), "openai", "gpt-6-astra");
  await page.getByLabel("API Key").fill(KEYS.openai);
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.getByText("密钥已保存 · 连接待测试").first().waitFor();
  await shot(page, "desktop-openai-saved");

  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "OpenAI", exact: true }).waitFor();
  await page.getByText("密钥已保存 · 连接待测试").first().waitFor();
  await shot(page, "desktop-openai-after-refresh");
  await page.getByRole("button", { name: "检测连接", exact: true }).click();
  await page.getByText("已读取模型列表", { exact: true }).waitFor();
  assert.equal(await page.getByText("检测通过", { exact: true }).count(), 0);
  await shot(page, "desktop-openai-model-list-read");

  await gotoReady(page, "/admin/ai-models", "模型供应商");
  await page
    .getByText("密钥已保存 · 连接待测试")
    .waitFor({ state: "detached" })
    .catch(() => {});
  await shot(page, "desktop-vendor-catalog-openai-saved");

  await gotoReady(page, "/admin/features?feature=writing", "模型与密钥");
  await page.getByRole("button", { name: "修改配置" }).waitFor();
  assert.equal(await page.getByRole("region", { name: "配置变更" }).count(), 0);
  await shot(page, "desktop-writing-current-empty");

  await page.getByRole("button", { name: "修改配置" }).click();
  await page.getByRole("dialog", { name: "修改配置" }).waitFor();
  await chooseWritingModel(page, "deepseek", "deepseek-flash");
  await shot(page, "desktop-writing-edit-drawer");
  await page.getByLabel("API Key").fill(KEYS.deepseek);
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await page.getByText("草稿未启用").waitFor();
  await page.getByText(WRITING_MODEL_CHANNELS.deepseek.models[0].label).first().waitFor();
  await shot(page, "desktop-writing-draft-unenabled-first");

  await page.getByRole("button", { name: "验证草稿", exact: true }).click();
  await page.getByRole("dialog", { name: "确认测试费用" }).waitFor();
  await shot(page, "desktop-writing-test-confirm");
  await page.getByRole("button", { name: "确认测试", exact: true }).click();
  await checkDraftColor(page, true);
  await page.getByText("未设置").first().waitFor(); // live config unchanged
  await shot(page, "desktop-writing-test-passed-first");

  await page.getByRole("button", { name: "确认启用", exact: true }).click();
  await page.getByRole("dialog", { name: "确认启用" }).waitFor();
  await shot(page, "desktop-writing-enable-confirm-first");
  await page
    .getByRole("dialog", { name: "确认启用" })
    .getByRole("button", { name: "确认启用", exact: true })
    .click();
  await page.getByRole("region", { name: "当前生效配置" }).getByText("已生效", { exact: true }).waitFor();
  await page.getByText(WRITING_MODEL_CHANNELS.deepseek.models[0].label).first().waitFor();
  await shot(page, "desktop-writing-enabled-deepseek");

  // Draft a Bailian change; keep DeepSeek as the live config. Fail, then pass, then enable.
  await page.getByRole("button", { name: "修改配置" }).click();
  await page.getByRole("dialog", { name: "修改配置" }).waitFor();
  await chooseWritingModel(page, "bailian", "qwen-plus");
  await page.getByLabel("API Key").fill(KEYS.bailianFail);
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await page.getByText("草稿未启用").waitFor();
  await page.getByText(WRITING_MODEL_CHANNELS.deepseek.models[0].label).first().waitFor(); // live still DeepSeek
  await shot(page, "desktop-writing-draft-unenabled");

  await page.getByRole("button", { name: "验证草稿", exact: true }).click();
  await page.getByRole("dialog", { name: "确认测试费用" }).waitFor();
  await page.getByRole("button", { name: "确认测试", exact: true }).click();
  await checkDraftColor(page, false);
  await page.getByText(WRITING_MODEL_CHANNELS.deepseek.models[0].label).first().waitFor();
  await shot(page, "desktop-writing-test-failed");

  await page.getByRole("button", { name: "更换" }).click();
  await page.getByLabel("API Key").fill(KEYS.bailianPass);
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await page.getByText("草稿未启用").waitFor();

  await page.getByRole("button", { name: "验证草稿", exact: true }).click();
  await page.getByRole("dialog", { name: "确认测试费用" }).waitFor();
  await page.getByRole("button", { name: "确认测试", exact: true }).click();
  await checkDraftColor(page, true);
  await page.getByText(WRITING_MODEL_CHANNELS.deepseek.models[0].label).first().waitFor(); // live still DeepSeek
  await shot(page, "desktop-writing-test-passed");
  assert.equal(
    await page.getByText("演示", { exact: true }).count(),
    0,
    "演示 badge must not render",
  );
  await shot(page, "desktop-writing-test-passed-nobadge-fixed");

  await page.getByRole("button", { name: "确认启用", exact: true }).click();
  await page.getByRole("dialog", { name: "确认启用" }).waitFor();
  await shot(page, "desktop-writing-enable-confirm");
  await page
    .getByRole("dialog", { name: "确认启用" })
    .getByRole("button", { name: "确认启用", exact: true })
    .click();
  await page.getByRole("region", { name: "当前生效配置" }).getByText("已生效", { exact: true }).waitFor();
  await shot(page, "desktop-writing-enabled");

  await gotoReady(page, "/admin/ai-models/bailian", "阿里云百炼");
  await page.getByRole("button", { name: "编辑设置" }).click();
  const settings = page.getByRole("dialog", { name: "编辑设置" });
  await chooseModel(settings, "bailian", "qwen-plus");
  const key = settings.getByLabel("API Key");
  await key.fill(KEYS.bailianPlan);
  await settings.getByText("这是套餐密钥，请使用百炼按量付费 API Key", { exact: true }).waitFor();
  assert.equal(await settings.getByRole("button", { name: "保存设置" }).isDisabled(), true);
  await key.fill(KEYS.bailianPass);
  await settings.getByLabel("业务空间 ID").fill("llm-isolated");
  await settings.getByRole("button", { name: "保存设置" }).click();
  await settings.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "检测连接", exact: true }).click();
  await page.getByText("已读取模型列表", { exact: true }).waitFor();
  await shot(page, "desktop-bailian-authorized-model");
}

async function walkMobile(page) {
  // Vendor path after OpenAI already saved in the desktop walk (same vault).
  await gotoReady(page, "/admin/ai-models", "模型供应商");
  await shot(page, "mobile-vendor-catalog");
  await openMenu(page, "AI 大模型");
  await shot(page, "mobile-ai-models-menu");
  await page.getByRole("button", { name: "关闭菜单" }).click();

  await page.getByRole("link", { name: "进入设置" }).nth(1).click();
  await page.getByRole("heading", { name: "OpenAI", exact: true }).waitFor();
  await page.getByText("密钥已保存 · 连接待测试").first().waitFor();
  await shot(page, "mobile-openai-settings");

  await gotoReady(page, "/admin/features?feature=writing", "模型与密钥");
  // After desktop walk, writing is enabled on Bailian and leftover test receipts are cleared.
  await page
    .getByRole("region", { name: "当前生效配置" })
    .getByText("已生效", { exact: true })
    .waitFor();
  await shot(page, "mobile-writing-enabled");
  await openMenu(page, "功能配置");
  await shot(page, "mobile-feature-config-menu");
  await page.getByRole("button", { name: "关闭菜单" }).click();
}

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH }
    : {}),
  args: ["--no-sandbox"],
});

async function isolatedContext(viewport) {
  const target = new URL(origin);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname), "Expected a loopback preview");
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, serviceWorkers: "block" });
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === target.origin ? route.continue() : route.abort(),
  );
  return context;
}

try {
  const desktop = await isolatedContext({ width: 1440, height: 900 });
  const desktopPage = await desktop.newPage();
  desktopPage.setDefaultTimeout(60_000);
  await signIn(desktopPage);
  await walkDesktop(desktopPage);
  await desktop.close();

  const mobile = await isolatedContext({ width: 390, height: 844 });
  const mobilePage = await mobile.newPage();
  mobilePage.setDefaultTimeout(60_000);
  await signIn(mobilePage);
  await walkMobile(mobilePage);

  // Mobile writing states. Each primary action is scrolled into view, hit-tested, and clicked.
  await gotoReady(mobilePage, "/admin/features?feature=writing", "模型与密钥");
  await mobilePage.getByRole("button", { name: "修改配置" }).click();
  await mobilePage.getByRole("dialog", { name: "修改配置" }).waitFor();
  await chooseWritingModel(mobilePage, "deepseek", "deepseek-flash");
  const replace = mobilePage.getByRole("button", { name: "更换" });
  if (await replace.count()) await replace.click();
  await mobilePage.getByLabel("API Key").fill(KEYS.deepseekFail);
  await mobilePage.getByRole("button", { name: "保存草稿", exact: true }).click();
  await mobilePage.getByText("草稿未启用").waitFor();
  await shot(mobilePage, "mobile-writing-draft-unenabled");

  const drawer = mobilePage.getByRole("dialog", { name: "修改配置" });
  await drawer.getByRole("button", { name: "验证草稿", exact: true }).click();
  await mobilePage.getByRole("dialog", { name: "确认测试费用" }).waitFor();
  await mobilePage.getByRole("button", { name: "确认测试", exact: true }).click();
  await checkDraftColor(mobilePage, false);
  const retest = drawer.getByRole("button", { name: "验证草稿", exact: true });
  await revealPrimary(mobilePage, retest, "mobile failed 验证草稿");
  await shotScrolled(mobilePage, "mobile-writing-test-failed-fixed");
  await retest.click();
  await mobilePage.getByRole("dialog", { name: "确认测试费用" }).waitFor();
  await mobilePage.getByRole("button", { name: "取消", exact: true }).click();

  await mobilePage.getByRole("button", { name: "更换" }).click();
  await mobilePage.getByLabel("API Key").fill(KEYS.deepseek);
  await mobilePage.getByRole("button", { name: "保存草稿", exact: true }).click();
  await drawer.getByText("草稿未启用").waitFor();
  await drawer.getByRole("button", { name: "验证草稿", exact: true }).click();
  await mobilePage.getByRole("dialog", { name: "确认测试费用" }).waitFor();
  await mobilePage.getByRole("button", { name: "确认测试", exact: true }).click();
  await checkDraftColor(mobilePage, true);
  const enableButton = drawer.getByRole("button", { name: "确认启用", exact: true });
  await revealPrimary(mobilePage, enableButton, "mobile passed 确认启用");
  await shotScrolled(mobilePage, "mobile-writing-test-passed-fixed");
  await enableButton.click();
  await mobilePage.getByRole("dialog", { name: "确认启用" }).waitFor();
  await mobilePage
    .getByRole("dialog", { name: "确认启用" })
    .getByRole("button", { name: "确认启用", exact: true })
    .click();
  const current = mobilePage.getByRole("region", { name: "当前生效配置" });
  await current.getByText("已生效", { exact: true }).waitFor();
  const rollbackButton = current.getByRole("button", { name: "回退到上一配置版本" });
  await revealPrimary(mobilePage, rollbackButton, "mobile enabled 回退");
  await shotScrolled(mobilePage, "mobile-writing-enabled-fixed");

  await mobile.close();
  writeFileSync(
    resolve(reviewDir, "screenshot-index.json"),
    JSON.stringify({ origin, shots, checks }, null, 2) + "\n",
  );
  console.log(`Captured ${shots.length} screenshots under ${outDir}`);
  console.log(shots.join("\n"));
} finally {
  await browser.close();
}
