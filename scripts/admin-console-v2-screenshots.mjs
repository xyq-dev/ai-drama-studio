#!/usr/bin/env node
/**
 * Capture acceptance screenshots for T-ENG-WEB-ADMIN-CONSOLE-V2.
 * Starts a local mock admin API + Next.js web, then Playwright screenshots at 1440×900 and 390×844.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "reviews", "admin-console-v2-2026-11-20");
const API_PORT = 18081;
const WEB_PORT = 13000;
const CSRF = "c".repeat(43);

const modelsView = {
  savedRevision: 4,
  activeRevision: 4,
  pendingRestart: false,
  activationDeferred: false,
  source: "managed",
  titleWriting: { enabled: true, productionBlocked: false, operatorConfigured: true, siteOperator: true },
  storage: { titleWriting: true, claude: true, candidates: true, deepseek: true },
  saved: {
    defaultProvider: "deepseek",
    maxCallsPerDay: 30,
    maxActiveRuns: 1,
    providers: [
      { providerKey: "deepseek", label: "DeepSeek", models: ["deepseek-flash"], baseUrl: "https://api.deepseek.com/chat/completions", keyConfigured: true, ready: true, missing: [] },
      { providerKey: "anthropic", label: "Claude", models: ["claude-opus-5-5"], baseUrl: "https://api.anthropic.com/v1/messages", keyConfigured: true, ready: true, missing: [] },
      { providerKey: "openai", label: "OpenAI", models: [], baseUrl: "https://api.openai.com/v1/responses", keyConfigured: false, ready: false, missing: ["apiKey", "models"] },
    ],
  },
  active: {
    defaultProvider: "deepseek",
    maxCallsPerDay: 30,
    maxActiveRuns: 1,
    providers: [
      { providerKey: "deepseek", label: "DeepSeek", models: ["deepseek-flash"], baseUrl: "https://api.deepseek.com/chat/completions", keyConfigured: true, ready: true, missing: [] },
      { providerKey: "anthropic", label: "Claude", models: ["claude-opus-5-5"], baseUrl: "https://api.anthropic.com/v1/messages", keyConfigured: true, ready: true, missing: [] },
      { providerKey: "openai", label: "OpenAI", models: [], baseUrl: "https://api.openai.com/v1/responses", keyConfigured: false, ready: false, missing: ["apiKey", "models"] },
    ],
  },
  audit: [],
  validation: "local_only",
};

const mediaView = {
  savedRevision: 1,
  pendingRestart: false,
  source: "managed",
  validation: "local_only",
  notices: [],
  slots: [
    { slot: "OPENAI_MEDIA_API_KEY", label: "OpenAI 生图", hint: "正式生图", keyConfigured: false, status: "empty", managed: false, source: "none", priceConfigured: false, serviceState: "unconfigured" },
    { slot: "DASHSCOPE_MEDIA_API_KEY", label: "百炼生图 / 视频", hint: "百炼媒体", keyConfigured: false, status: "empty", managed: false, source: "none", priceConfigured: false, serviceState: "unconfigured" },
    { slot: "MINIMAX_API_KEY", label: "MiniMax 正式配音", hint: "speech-2.8-hd", keyConfigured: true, status: "saved", managed: true, source: "managed", priceConfigured: false, serviceState: "saved_not_ready" },
  ],
};

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "*",
  });
  res.end(data);
}

function startMockApi() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url ?? "/";
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "*",
        });
        res.end();
        return;
      }
      if (url.startsWith("/api/v1/auth/session")) {
        send(res, 200, {
          enabled: true,
          authenticated: true,
          username: "admin",
          role: "operator",
          csrfToken: CSRF,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
        return;
      }
      if (url.startsWith("/api/v1/admin/models") && req.method === "GET") {
        send(res, 200, modelsView);
        return;
      }
      if (url.startsWith("/api/v1/admin/media-keys") && req.method === "GET") {
        send(res, 200, mediaView);
        return;
      }
      send(res, 404, { error: { code: "NOT_FOUND" } });
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
        if (response.status < 500) {
          resolve();
          return;
        }
      } catch {
        // keep waiting
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Timed out waiting for ${url}`));
        return;
      }
      setTimeout(tick, 1000);
    };
    void tick();
  });
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const api = await startMockApi();
  const web = spawn(
    "pnpm",
    ["exec", "next", "dev", "--hostname", "127.0.0.1", "--port", String(WEB_PORT)],
    {
      cwd: path.join(root, "apps/web"),
      env: {
        ...process.env,
        NEXT_PUBLIC_API_BASE_URL: `http://127.0.0.1:${API_PORT}`,
        NODE_ENV: "development",
        NEXT_DISABLE_DEVTOOLS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let webLog = "";
  web.stdout.on("data", (chunk) => { webLog += chunk.toString(); });
  web.stderr.on("data", (chunk) => { webLog += chunk.toString(); });

  try {
    await waitForUrl(`http://127.0.0.1:${WEB_PORT}/login`);
    const browser = await chromium.launch({ headless: true });
    const shots = [
      { name: "desktop-text-models", path: "/admin/models", width: 1440, height: 900, mobileMenu: false },
      { name: "desktop-media-keys", path: "/admin/media-keys", width: 1440, height: 900, mobileMenu: false },
      { name: "mobile-text-models", path: "/admin/models", width: 390, height: 844, mobileMenu: false },
      { name: "mobile-media-keys", path: "/admin/media-keys", width: 390, height: 844, mobileMenu: false },
      { name: "mobile-menu", path: "/admin/media-keys", width: 390, height: 844, mobileMenu: true },
    ];

    for (const shot of shots) {
      const context = await browser.newContext({
        viewport: { width: shot.width, height: shot.height },
        deviceScaleFactor: 1,
      });
      await context.addCookies([{
        name: "ads_csrf",
        value: CSRF,
        domain: "127.0.0.1",
        path: "/",
      }, {
        name: "ads_session",
        value: "screenshot-session",
        domain: "127.0.0.1",
        path: "/",
      }]);
      const page = await context.newPage();
      await page.addInitScript(() => {
        const style = document.createElement("style");
        style.textContent = "nextjs-portal, #__next-build-watcher, [data-nextjs-toast], [data-next-badge-root] { display: none !important; }";
        document.documentElement.appendChild(style);
      });
      await page.goto(`http://127.0.0.1:${WEB_PORT}${shot.path}`, { waitUntil: "networkidle", timeout: 120_000 });
      await page.waitForSelector("h1", { timeout: 60_000 });
      if (shot.mobileMenu) {
        await page.getByRole("button", { name: "打开导航" }).click();
        await page.getByRole("dialog", { name: "管理导航" }).waitFor();
      }
      const file = path.join(outDir, `${shot.name}.png`);
      await page.screenshot({ path: file, fullPage: false });
      await context.close();
      console.log(`wrote ${file}`);
    }

    await writeFile(path.join(outDir, "README.md"), `# Admin console V2 acceptance screenshots

Captured against local mock API + Next.js for T-ENG-WEB-ADMIN-CONSOLE-V2.

| File | Viewport | Route |
| --- | --- | --- |
| desktop-text-models.png | 1440×900 | /admin/models |
| desktop-media-keys.png | 1440×900 | /admin/media-keys |
| mobile-text-models.png | 390×844 | /admin/models |
| mobile-media-keys.png | 390×844 | /admin/media-keys |
| mobile-menu.png | 390×844 | /admin/media-keys (drawer open) |

Limits/ready values come from the mock API fixture, not hardcoded page copy.
`);
    await browser.close();
  } catch (error) {
    console.error(webLog);
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
