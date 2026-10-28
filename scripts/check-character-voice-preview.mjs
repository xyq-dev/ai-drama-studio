import assert from "node:assert/strict";
import { readFile, mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Script } from "node:vm";

// Offline design verification only. No API, TTS, project, database or paid service is used.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, process.argv[2] ?? "artifacts/character-voice-preview");
const htmlPath = path.join(root, "docs/design/character-voice-preview.html");
const html = await readFile(htmlPath, "utf8");
const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
assert.equal(inlineScripts.length, 1);
for (const script of inlineScripts) new Script(script[1]);
assert.equal(/\b(?:fetch|XMLHttpRequest|WebSocket|sendBeacon)\s*\(/u.test(html), false);
assert.equal(
  /<(?:script|img|link|iframe|audio|video)[^>]*(?:src|href)=["']https?:/iu.test(html),
  false,
);
JSON.parse(await readFile(path.join(root, "docs/design/voice-preview-checks.json"), "utf8"));
const markdownFiles = [
  "README.md",
  "docs/CHARACTER_VOICE_DESIGN.md",
  "docs/VOICE_OPEN_SOURCE_RESEARCH.md",
  "docs/design/README.md",
  "docs/IMPLEMENTATION_PLAN.md",
  "docs/PROVIDER_READINESS.md",
  "docs/V1_DELIVERY_MATRIX.md",
];
let relativeLinks = 0;
for (const file of markdownFiles) {
  for (const match of (await readFile(path.join(root, file), "utf8")).matchAll(
    /\[[^\]]*\]\(([^)]+)\)/g,
  )) {
    const target = match[1].split("#")[0];
    if (!target || /^[a-z]+:\/\//iu.test(target)) continue;
    await access(path.resolve(root, path.dirname(file), target));
    relativeLinks++;
  }
}

// Optional module override lets a reviewer use an already installed Playwright without changing the lockfile.
const playwrightModule = process.env.PLAYWRIGHT_MODULE ?? "playwright";
const { chromium } = await import(
  path.isAbsolute(playwrightModule) ? pathToFileURL(playwrightModule).href : playwrightModule
);
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const result = {
  ok: false,
  kind: "offline-design-prototype-only",
  checkedAt: new Date().toISOString(),
  browser: browser.version(),
  static: { inlineScripts: inlineScripts.length, relativeLinks, metadataJson: "valid" },
  pages: [],
  interactions: [],
  pageErrors: [],
  externalRequests: [],
  api: false,
  modelCalls: false,
};
await mkdir(output, { recursive: true });
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: width === 390 ? 844 : 1000 },
    });
    await context.route(/^https?:\/\//u, (route) => route.abort());
    context.on("request", (request) => {
      if (/^https?:\/\//u.test(request.url())) result.externalRequests.push(request.url());
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => result.pageErrors.push(error.message));
    await page.goto(pathToFileURL(htmlPath).href);
    for (const tab of ["cast", "lines", "mix", "delivery"]) {
      await page.locator(`#tab-${tab}`).click();
      assert.equal(await page.locator(`#tab-${tab}`).getAttribute("aria-selected"), "true");
      const layout = await page.evaluate(() => ({
        width: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      }));
      assert.equal(layout.scrollWidth, layout.width, `${width}px ${tab} document overflow`);
      const screenshot = `voice-${tab}-${width}.png`;
      await page.screenshot({ path: path.join(output, screenshot), fullPage: true });
      result.pages.push({ viewport: width, tab, ...layout, screenshot });
    }

    await page.locator("#tab-cast").focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator("#tab-lines").getAttribute("aria-selected"), "true");
    await page.keyboard.press("End");
    assert.equal(await page.locator("#tab-delivery").getAttribute("aria-selected"), "true");
    await page.keyboard.press("Home");
    assert.equal(await page.locator("#tab-cast").getAttribute("aria-selected"), "true");

    await page.locator('[data-action="choose"]').click();
    assert.equal(await page.locator("#voices").evaluate((dialog) => dialog.open), true);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#voices").evaluate((dialog) => dialog.open), false);
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("data-action")),
      "choose",
    );

    await page.locator("#tab-lines").click();
    await page.locator('[data-action="select"]').click();
    await page.locator("#tab-mix").click();
    assert.equal(await page.locator('#content [data-tab="delivery"]').isEnabled(), true);
    await page.locator('[data-action="overflow"]').click();
    assert.equal(await page.locator('#content [data-tab="delivery"]').isDisabled(), true);
    await page.locator('[data-action="overflow"]').click();
    assert.equal(await page.locator('#content [data-tab="delivery"]').isEnabled(), true);

    await page.locator("#tab-cast").click();
    await page.locator('[data-action="choose"]').click();
    await page.locator('[data-voice="清亮有活力"]').click();
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("data-action")),
      "choose",
    );
    await page.locator("#tab-lines").click();
    assert.equal(await page.locator('[data-action="select"]').isDisabled(), true);
    await page.locator("#tab-mix").click();
    assert.equal(await page.locator('#content [data-tab="delivery"]').isDisabled(), true);
    await page.locator("#tab-lines").click();
    await page.locator('[data-action="regenerate"]').click();
    assert.equal(await page.locator('[data-action="select"]').isEnabled(), true);
    await page.locator('[data-action="select"]').click();
    await page.locator("#tab-mix").click();
    assert.equal(await page.locator('#content [data-tab="delivery"]').isEnabled(), true);
    result.interactions.push({
      viewport: width,
      tabKeyboard: "pass",
      dialogEscapeFocus: "pass",
      voiceChoiceFocus: "pass",
      overflowBlocking: "pass",
      changedVoiceInvalidatesSelection: "pass",
      oldCandidateDisabled: "pass",
      newCandidateRestores: "pass",
    });
    await context.close();
  }
  assert.deepEqual(result.pageErrors, []);
  assert.deepEqual(result.externalRequests, []);
  result.ok = true;
} finally {
  await browser.close();
  await writeFile(path.join(output, "report.json"), `${JSON.stringify(result, null, 2)}\n`);
}
console.log(JSON.stringify(result, null, 2));
