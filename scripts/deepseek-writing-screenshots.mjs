// Capture 1440×900 and 390×844 shots of the DeepSeek writing admin paths
// against the isolated preview. In-process probe stub only. No paid outbound.
import { createRequire } from "node:module";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const reviewDir =
  process.env.ADMIN_AI_MODELS_REVIEW_DIR ||
  "/workspace/drama-studio/reviews/deepseek-writing-2026-11-23";
const secretsDir = process.env.ADMIN_AI_MODELS_SECRETS_DIR || resolve(reviewDir, ".secrets");
const outDir = resolve(reviewDir, "screenshots");
const origin = process.env.ADMIN_AI_MODELS_ORIGIN || "http://127.0.0.1:3824";
const password = readFileSync(resolve(secretsDir, "ADMIN_MODELS_TEST_PASSWORD"), "utf8").trim();
const username = process.env.SITE_AUTH_USERNAME || "admin";
const KEY = "fake-deepseek-isolated-key-not-real";
const FORBIDDEN = [password, KEY];

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
  assert.equal(
    await page.getByText("演示", { exact: true }).count(),
    0,
    `演示 badge must not render (${name})`,
  );
  assert.equal(
    await page.getByText("连接正常", { exact: true }).count(),
    0,
    `连接正常 must not appear as a status (${name})`,
  );
}

async function hideDevBadge(page) {
  await page
    .addStyleTag({
      content: `nextjs-portal,[data-next-badge],[data-next-badge-root],[data-nextjs-dev-indicator],#__next-build-watcher{display:none!important;visibility:hidden!important;pointer-events:none!important}`,
    })
    .catch(() => {});
}

async function shot(page, name, { scroll = false } = {}) {
  await hideDevBadge(page);
  await page.evaluate(async (shouldScroll) => {
    await document.fonts.ready;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    if (!shouldScroll) window.scrollTo(0, 0);
  }, scroll);
  await page.waitForTimeout(80);
  const file = `${name}.png`;
  await page.screenshot({ path: resolve(outDir, file), fullPage: false });
  await assertClean(page, name);
  shots.push(file);
}

async function assertModelLabelFullyVisible(page, expected) {
  const select = page.getByLabel("模型");
  await select.waitFor();
  const info = await select.evaluate((element) => {
    if (!(element instanceof HTMLSelectElement)) return { selected: "", textWidth: 0, inner: 0, width: 0 };
    const selected = element.options[element.selectedIndex]?.text ?? "";
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return { selected, textWidth: 0, inner: 0, width: rect.width };
    ctx.font = style.font;
    const textWidth = ctx.measureText(selected).width;
    const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
    const paddingRight = Number.parseFloat(style.paddingRight) || 0;
    const arrow = 28;
    return {
      selected,
      textWidth,
      inner: rect.width - paddingLeft - paddingRight - arrow,
      width: rect.width,
    };
  });
  assert.equal(info.selected, expected, `selected model should be ${expected}`);
  assert.ok(
    info.textWidth <= info.inner + 0.5,
    `model label is clipped in the select: ${JSON.stringify(info)}`,
  );
}

async function signIn(page) {

  await page.goto(`${origin}/admin/ai-models`, { waitUntil: "networkidle" });
  if (new URL(page.url()).pathname === "/login") {
    await page.getByRole("heading", { name: "登录红果创作", exact: true }).waitFor();
    await page.locator('input[name="username"]').fill(username);
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
  }
  await page.getByRole("heading", { name: "模型供应商", exact: true }).waitFor({ timeout: 60_000 });
}

async function gotoReady(page, path, heading) {
  await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: heading, exact: true }).waitFor({ timeout: 60_000 });
  await page
    .getByRole("heading", { name: "正在加载配置" })
    .waitFor({ state: "detached", timeout: 60_000 })
    .catch(() => {});
  await page
    .getByText("正在核对登录身份", { exact: false })
    .waitFor({ state: "detached", timeout: 30_000 })
    .catch(() => {});
}

const browser = await chromium.launch({ headless: true });
try {
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await desktop.newPage();
  await signIn(page);

  await gotoReady(page, "/admin/ai-models", "模型供应商");
  await page.getByText("2 个候选模型 · 编剧已接入").waitFor();
  await shot(page, "desktop-vendor-catalog-empty");

  await page.getByRole("link", { name: "进入设置" }).first().click();
  await page.getByRole("heading", { name: "DeepSeek", exact: true }).waitFor();
  await page.getByText("DeepSeek Flash").first().waitFor();
  await page.getByText("DeepSeek V4 Pro").first().waitFor();
  await shot(page, "desktop-deepseek-settings-empty");

  await page.getByRole("button", { name: "编辑设置" }).click();
  await page.getByRole("dialog", { name: "编辑设置" }).waitFor();
  await shot(page, "desktop-deepseek-edit-drawer");
  await page.getByLabel("API Key").fill(KEY);
  await page.getByRole("button", { name: "保存凭证", exact: true }).click();
  await page.getByText("密钥已保存 · 连接待测试").first().waitFor();
  await shot(page, "desktop-deepseek-saved");

  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "DeepSeek", exact: true }).waitFor();
  await page.getByText("密钥已保存 · 连接待测试").first().waitFor();
  await shot(page, "desktop-deepseek-after-refresh");

  await gotoReady(page, "/admin/features?feature=writing", "模型与密钥");
  await page.getByText("暂无草稿").waitFor();
  await shot(page, "desktop-writing-current-empty");

  const earlyMobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const earlyPage = await earlyMobile.newPage();
  await signIn(earlyPage);
  await gotoReady(earlyPage, "/admin/features?feature=writing", "模型与密钥");
  await earlyPage.getByText("暂无草稿").waitFor();
  await earlyPage.getByRole("button", { name: "修改配置" }).click();
  await earlyPage.getByRole("dialog", { name: "修改配置" }).waitFor();
  await earlyPage.getByRole("button", { name: "DeepSeek", exact: true }).click();
  await earlyPage.getByText("将使用已在「AI 大模型」保存的凭证。保存草稿不会把完整密钥再显示在页面上。").waitFor();
  await earlyPage.getByLabel("已保存密钥").waitFor();
  await assertModelLabelFullyVisible(earlyPage, "DeepSeek Flash");
  await shot(earlyPage, "mobile-writing-bind-vendor-drawer");
  await earlyMobile.close();

  await page.getByRole("button", { name: "修改配置" }).click();
  await page.getByRole("dialog", { name: "修改配置" }).waitFor();
  await page.getByRole("button", { name: "DeepSeek", exact: true }).click();
  await page.getByText("将使用已在「AI 大模型」保存的凭证。保存草稿不会把完整密钥再显示在页面上。").waitFor();
  await page.getByLabel("已保存密钥").waitFor();
  const modelSelect = page.getByLabel("模型");
  await modelSelect.selectOption("deepseek-v4-pro");
  await assertModelLabelFullyVisible(page, "DeepSeek V4 Pro");
  await shot(page, "desktop-writing-bind-vendor-drawer");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await page.getByText("草稿未启用").waitFor();
  await page.getByText("DeepSeek V4 Pro").first().waitFor();
  await shot(page, "desktop-writing-draft-unenabled");

  await page.getByRole("button", { name: "检测连接", exact: true }).click();
  await page.getByRole("dialog", { name: "确认测试费用" }).waitFor();
  await shot(page, "desktop-writing-test-confirm");
  await page.getByRole("button", { name: "确认测试", exact: true }).click();
  await page.getByText("检测通过").waitFor({ timeout: 20_000 });
  await page.getByText("已用所选模型完成一次最小 JSON 编剧探测，可以启用这一份草稿。").waitFor();
  await page.getByText("未设置").first().waitFor();
  await shot(page, "desktop-writing-test-passed");

  await page.getByRole("button", { name: "确认启用", exact: true }).click();
  await page.getByRole("dialog", { name: "确认启用" }).waitFor();
  await shot(page, "desktop-writing-enable-confirm");
  await page
    .getByRole("dialog", { name: "确认启用" })
    .getByRole("button", { name: "确认启用", exact: true })
    .click();
  await page.getByLabel("配置变更").getByText("已生效", { exact: true }).waitFor();
  await page.getByText("DeepSeek V4 Pro").first().waitFor();
  await shot(page, "desktop-writing-enabled");

  await desktop.close();

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const mobilePage = await mobile.newPage();
  await signIn(mobilePage);

  await gotoReady(mobilePage, "/admin/ai-models", "模型供应商");
  await mobilePage.getByText("2 个候选模型 · 编剧已接入").waitFor();
  await shot(mobilePage, "mobile-vendor-catalog");

  await mobilePage.getByRole("link", { name: "进入设置" }).first().click();
  await mobilePage.getByRole("heading", { name: "DeepSeek", exact: true }).waitFor();
  await mobilePage.getByText("密钥已保存 · 连接待测试").first().waitFor();
  await shot(mobilePage, "mobile-deepseek-saved");

  await gotoReady(mobilePage, "/admin/features?feature=writing", "模型与密钥");
  await mobilePage.getByLabel("配置变更").getByText("已生效", { exact: true }).waitFor();
  const rollback = mobilePage.getByRole("button", { name: "回退到上一配置版本" });
  if (await rollback.count()) {
    await rollback.scrollIntoViewIfNeeded();
  }
  await shot(mobilePage, "mobile-writing-enabled", { scroll: true });

  await mobilePage.getByRole("button", { name: "修改配置" }).click();
  await mobilePage.getByRole("dialog", { name: "修改配置" }).waitFor();
  await mobilePage.getByRole("button", { name: "DeepSeek", exact: true }).click();
  await mobilePage.getByLabel("已保存密钥").waitFor();
  await mobilePage.getByRole("button", { name: "更换" }).waitFor();
  await shot(mobilePage, "mobile-writing-edit-drawer");
  await mobilePage.getByRole("button", { name: "取消", exact: true }).click();

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
