// Actual React components in Chromium, with explicit local fixture clients only. No API/DB/provider acceptance.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const web = resolve(root, "apps/web");
const requireWeb = createRequire(resolve(web, "package.json"));
const { createServer } = await import(pathToFileURL(requireWeb.resolve("vite")).href);
const { default: react } = await import(pathToFileURL(requireWeb.resolve("@vitejs/plugin-react")).href);
const { chromium } = createRequire(resolve(root, "package.json"))("playwright");
const output = resolve(process.env.REAL_PRODUCTION_UI_EVIDENCE_DIR || resolve(root, "test-results/real-production-ui"));
const P = "11111111-1111-4111-8111-111111111111", S = "22222222-2222-4222-8222-222222222222";
const Q = "33333333-3333-4333-8333-333333333333", A = "44444444-4444-4444-8444-444444444444";
const J = "55555555-5555-4555-8555-555555555555", W = "66666666-6666-4666-8666-666666666666";
const evidence = { kind: "chromium-actual-react-local-fixture-client", modelCalls: 0, database: false, checks: [], errors: [] };
const entry = `
import React from 'react';import {createRoot} from 'react-dom/client';
import {RealMediaPanel} from '/src/components/real-media-panel.tsx';
const ids=${JSON.stringify({ P, S, Q, A, J, W })};window.sends=0;
const api={capabilities:async()=>({available:true,readAvailable:true,reasonCode:null,capabilities:['image.generate','video.generate','audio.tts','audio.music']}),
assets:async()=>({items:[],nextCursor:null}),characters:async()=>[{id:ids.A,name:'林夏'}],
quote:async()=>({quoteId:ids.Q,inputHash:'a'.repeat(64),capability:'image.generate',currency:'CNY',estimatedAmount:'0.50',maximumAmount:'1.00',
providerConfigurationId:ids.A,providerConfigurationVersion:'fixture-v1',priceVersion:'fixture-v1',actualCost:'unknown',singleOperation:true,
expiresAt:'2099-01-01T00:00:00.000Z',uncertainJobIds:[]}),
authorize:async()=>ids.A,generate:async()=>{window.sends++;return {jobId:ids.J,workflowRunId:ids.W}},
job:async()=>({id:ids.J,state:'WAITING_EXTERNAL',errorCode:'REAL_MEDIA_SUBMISSION_UNKNOWN'}),compose:async()=>{throw Error('Not part of fixture')}};
createRoot(document.getElementById('root')).render(React.createElement('main',{style:{maxWidth:960,margin:'24px auto',padding:16,fontFamily:'sans-serif'}},
React.createElement('h1',null,'镜头制作'),React.createElement('p',null,'浏览器测试素材，未连接真实模型。'),
React.createElement(RealMediaPanel,{projectId:ids.P,shotRevisionId:ids.S,dialogue:'林夏：这不是我。',usable:true,approved:true,client:api})));
`;
let browser;
const server = await createServer({ configFile: false, root: web, server: { host: "127.0.0.1", port: 3846, strictPort: true },
  plugins: [react(), { name: "local-real-production-fixture", resolveId(id) { if (id === "/fixture.tsx") return "\0fixture.tsx"; },
    load(id) { if (id === "\0fixture.tsx") return entry; }, configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url?.startsWith("/api/v1/")) {
          // Existing speech history and generation remain visibly unavailable in this UI fixture.
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(req.url.includes("speech-capabilities") ? { available: false, reasonCode: "SPEECH_NOT_READY", providers: [] }
            : req.url.includes("voice-bindings") ? { items: [] } : { plan: null, current: null, rowVersion: null })); return;
        }
        if (req.url !== "/") { next(); return; }
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml("/", '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>'));
      });
    } }],
});
try {
  await mkdir(output, { recursive: true }); await server.listen(); browser = await chromium.launch({ headless: true });
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.on("pageerror", error => evidence.errors.push(error.message));
    await page.goto("http://127.0.0.1:3846");
    await page.getByRole("button", { name: /图片、视频与角色配音/ }).click();
    await page.getByRole("button", { name: "查看本次费用", exact: true }).click();
    const submit = page.getByRole("button", { name: "确认生成图片", exact: true });
    await submit.waitFor(); assert.equal(await submit.isDisabled(), true);
    await page.getByLabel("我确认本次可能收费，只提交一次生成。").check();
    assert.equal(await submit.isEnabled(), true);
    const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert.equal(dimensions.scroll, dimensions.width, `Horizontal overflow at ${width}`);
    const name = `real-production-${width}.png`; await page.screenshot({ path: resolve(output, name), fullPage: true });
    await submit.click(); await page.getByText(/结果待核实，可能已产生费用/).waitFor();
    assert.equal(await page.evaluate(() => window.sends), 1);
    await page.reload(); await page.getByRole("button", { name: /图片、视频与角色配音/ }).click();
    await page.getByText(/结果待核实，可能已产生费用/).waitFor();
    assert.equal(await page.evaluate(() => window.sends), 0, "Refresh must only read the acknowledged original job");
    evidence.checks.push({ width, screenshot: name, oneExplicitSend: true, refreshNoSend: true, overflow: false });
    await page.close();
  }
  assert.deepEqual(evidence.errors, []);
} finally {
  await browser?.close(); await server.close();
  await writeFile(resolve(output, "evidence.json"), JSON.stringify(evidence, null, 2));
}
process.stdout.write("Real production UI fixture: desktop/mobile paid confirmation, UNKNOWN and refresh recovery passed; model calls 0.\n");
