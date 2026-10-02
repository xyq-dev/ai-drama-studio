import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const workflow = readFileSync(resolve(root, ".github/workflows/m3-av-e2e.yml"), "utf8").replace(/\r\n/g, "\n");
const smWorkflow = readFileSync(resolve(root, ".github/workflows/m3-sm-e2e.yml"), "utf8").replace(/\r\n/g, "\n");
const harness = [
  readFileSync(resolve(root, "scripts/m3-av-e2e/run.mjs"), "utf8"),
  readFileSync(resolve(root, "scripts/m3-av-e2e/lifecycle.mjs"), "utf8"),
  readFileSync(resolve(root, "scripts/m3-av-e2e/compose-preflight.mjs"), "utf8"),
  readFileSync(resolve(root, "scripts/m3-av-e2e/compose-render.mjs"), "utf8"),
  readFileSync(resolve(root, "scripts/m3-av-e2e/episode-compose-preflight.mjs"), "utf8"),
].join("\n").replace(/\r\n/g, "\n");
const outcome = readFileSync(resolve(root, "scripts/m3-av-e2e/outcome.mjs"), "utf8").replace(/\r\n/g, "\n");

const required = [
  "branches:\n      - feat/m3-av-workbench",
  "workflow_dispatch:",
  "contents: read",
  "ubuntu-24.04",
  "timeout-minutes: 30",
  "node-version: 24.21.0",
  "version: 10.17.0",
  "pnpm install --frozen-lockfile",
  "playwright install --with-deps chrome",
  "node scripts/m3-av-e2e/run.mjs",
  "actions/upload-artifact@v4",
  "retention-days: 7",
  "if: always()",
  "scripts/m3-av-e2e/**",
  "pnpm-lock.yaml",
  "apps/**",
  "packages/**",
];

const forbidden = [
  "pull_request:",
  "branches:\n      - main",
  "secrets.",
  "environment:",
];

const failures = [];
for (const snippet of required) {
  if (!workflow.includes(snippet)) failures.push(`workflow missing ${JSON.stringify(snippet)}`);
}
for (const snippet of forbidden) {
  if (workflow.includes(snippet)) failures.push(`workflow contains ${JSON.stringify(snippet)}`);
}
if (workflow.includes("docs/**")) failures.push("workflow paths include docs and would rerun for report-only updates");
if (harness.includes("page.route(") || harness.includes("docker system prune")) {
  failures.push("harness contains fetch interception or global prune");
}
if (/sql\(\s*[`'"][^`'"]*drop\s+schema/i.test(harness)) {
  failures.push("harness SQL drops a schema");
}
if (!harness.includes('channel: "chrome"')) failures.push("harness does not launch Chrome for Testing");
if (!harness.includes('from "./outcome.mjs"')) failures.push("harness does not use the shared outcome module");
if (!harness.includes("acceptanceFailed(") || !harness.includes("acceptanceExitCode(")) {
  failures.push("harness does not use the shared pass/fail decision");
}
if (!harness.includes("assertLinkage(")) failures.push("harness does not assert ledger linkage");
if (!harness.includes("viewport-390.png")) failures.push("harness does not save the 390px screenshot");
if (!harness.includes('["M3_MOCK_AV_ENABLED"]')) failures.push("harness does not unset M3_MOCK_AV_ENABLED");
if (!harness.includes('["M3_MOCK_SUBTITLE_MUSIC_ENABLED"]')) failures.push("harness does not unset M3_MOCK_SUBTITLE_MUSIC_ENABLED");
for (const stage of ["subtitle-music", "subtitle-music-gates", "subtitle-music-recovery"]) {
  if (!outcome.includes(`"${stage}"`)) failures.push(`outcome missing ${stage}`);
  if (!harness.includes(`"${stage}"`)) failures.push(`harness missing ${stage}`);
}
const smRequired = [
  "branches:\n      - feat/m3-subtitle-music-workbench",
  "workflow_dispatch:",
  "contents: read",
  "ubuntu-24.04",
  "timeout-minutes: 30",
  "node-version: 24.21.0",
  "version: 10.17.0",
  "pnpm install --frozen-lockfile",
  "playwright install --with-deps chrome",
  "pnpm m3-av-e2e:outcome",
  "node scripts/m3-av-e2e/run.mjs",
  "name: m3-sm-e2e-evidence",
  "retention-days: 7",
  "if: always()",
];
for (const snippet of smRequired) {
  if (!smWorkflow.includes(snippet)) failures.push(`subtitle workflow missing ${JSON.stringify(snippet)}`);
}
for (const snippet of forbidden) {
  if (smWorkflow.includes(snippet)) failures.push(`subtitle workflow contains ${JSON.stringify(snippet)}`);
}
if (smWorkflow.includes("docs/**")) failures.push("subtitle workflow paths include docs");
if (!harness.includes("7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f")) {
  failures.push("harness does not pin the MinIO release checksum");
}
if (!harness.includes("01f866e9c5f9b87c2b09116fa5d7c06695b106242d829a8bb32990c00312e891")) {
  failures.push("harness does not pin the mc release checksum");
}
for (const stage of ["image-recovery", "image-cost-guard"]) {
  if (!outcome.includes(`"${stage}"`)) failures.push(`outcome missing ${stage}`);
  if (!harness.includes(`"${stage}"`)) failures.push(`harness missing ${stage}`);
}
if (harness.includes("imageCostWritten") || harness.includes("without actualCost")) {
  failures.push("harness still exempts a successful image from a cost row");
}
if (!harness.includes("m3-image-accounting-negative")) {
  failures.push("harness does not mark image ledger negatives");
}
const imageWorkflow = readFileSync(resolve(root, ".github/workflows/m3-image-accounting-e2e.yml"), "utf8").replace(/\r\n/g, "\n");
const imageRequired = [
  "branches:\n      - fix/m3-mock-image-accounting",
  "workflow_dispatch:",
  "contents: read",
  "ubuntu-24.04",
  "timeout-minutes: 40",
  "node-version: 24.21.0",
  "version: 10.17.0",
  "pnpm install --frozen-lockfile",
  "playwright install --with-deps chrome",
  "pnpm m3-av-e2e:outcome",
  "node scripts/m3-av-e2e/run.mjs",
  "name: m3-image-accounting-e2e-evidence",
  "retention-days: 7",
  "if: always()",
];
for (const snippet of imageRequired) {
  if (!imageWorkflow.includes(snippet)) failures.push(`image workflow missing ${JSON.stringify(snippet)}`);
}
for (const snippet of forbidden) {
  if (imageWorkflow.includes(snippet)) failures.push(`image workflow contains ${JSON.stringify(snippet)}`);
}
if (imageWorkflow.includes("docs/**")) failures.push("image workflow paths include docs");

for (const stage of ["media-cancel", "media-terminal-race", "media-observation-replay", "media-shot-isolation"]) {
  if (!outcome.includes(`"${stage}"`)) failures.push(`outcome missing ${stage}`);
  if (!harness.includes(`"${stage}"`)) failures.push(`harness missing ${stage}`);
}
for (const snippet of ["pg_blocking_pids", "recoverMockImageAttempt", "recoverMockAvAttempt", "recoverMockSmAttempt"]) {
  if (!harness.includes(snippet)) failures.push(`harness missing ${snippet}`);
}
const lifecycleWorkflow = readFileSync(resolve(root, ".github/workflows/m3-lifecycle-e2e.yml"), "utf8").replace(/\r\n/g, "\n");
const lifecycleRequired = [
  "branches:\n      - feat/m3-lifecycle-acceptance",
  "workflow_dispatch:",
  "contents: read",
  "ubuntu-24.04",
  "timeout-minutes: 50",
  "node-version: 24.21.0",
  "version: 10.17.0",
  "pnpm install --frozen-lockfile",
  "playwright install --with-deps chrome",
  "pnpm m3-av-e2e:outcome",
  "node scripts/m3-av-e2e/run.mjs",
  "name: m3-lifecycle-e2e-evidence",
  "retention-days: 7",
  "if: always()",
];
for (const snippet of lifecycleRequired) {
  if (!lifecycleWorkflow.includes(snippet)) failures.push(`lifecycle workflow missing ${JSON.stringify(snippet)}`);
}
for (const snippet of forbidden) {
  if (lifecycleWorkflow.includes(snippet)) failures.push(`lifecycle workflow contains ${JSON.stringify(snippet)}`);
}
if (lifecycleWorkflow.includes("docs/**")) failures.push("lifecycle workflow paths include docs");

for (const stage of ["compose-preflight-page", "compose-preflight-gates", "compose-preflight-readonly"]) {
  if (!outcome.includes(`"${stage}"`)) failures.push(`outcome missing ${stage}`);
  if (!harness.includes(`"${stage}"`)) failures.push(`harness missing ${stage}`);
}
if (!harness.includes("尚未覆盖的其他媒体组合成本冲突（图片成本冲突已由 image-cost-guard 通过）")) {
  failures.push("harness still lists image cost conflicts as not run");
}
if (harness.includes("\n  \"成本冲突\",")) failures.push("harness still has a blanket cost-conflict not-run item");
const composeWorkflow = readFileSync(resolve(root, ".github/workflows/m4-compose-preflight-e2e.yml"), "utf8").replace(/\r\n/g, "\n");
const composeRequired = [
  "branches:\n      - feat/m4-compose-preflight",
  "workflow_dispatch:",
  "contents: read",
  "ubuntu-24.04",
  "timeout-minutes: 60",
  "node-version: 24.21.0",
  "version: 10.17.0",
  "pnpm install --frozen-lockfile",
  "playwright install --with-deps chrome",
  "pnpm m3-av-e2e:outcome",
  "node scripts/m3-av-e2e/run.mjs",
  "name: m4-compose-preflight-e2e-evidence",
  "retention-days: 7",
  "if: always()",
];
for (const snippet of composeRequired) {
  if (!composeWorkflow.includes(snippet)) failures.push(`compose workflow missing ${JSON.stringify(snippet)}`);
}
for (const snippet of forbidden) {
  if (composeWorkflow.includes(snippet)) failures.push(`compose workflow contains ${JSON.stringify(snippet)}`);
}
if (composeWorkflow.includes("docs/**")) failures.push("compose workflow paths include docs");

for (const stage of ["compose-render-page", "compose-render-gates", "compose-render-lifecycle", "compose-review", "compose-provenance-stale"]) {
  if (!outcome.includes(`"${stage}"`)) failures.push(`outcome missing ${stage}`);
  if (!harness.includes(`"${stage}"`)) failures.push(`harness missing ${stage}`);
}
const renderWorkflow = readFileSync(resolve(root, ".github/workflows/m4-single-shot-render-e2e.yml"), "utf8").replace(/\r\n/g, "\n");
const renderRequired = [
  "branches:\n      - feat/m4-single-shot-render",
  "workflow_dispatch:",
  "contents: read",
  "ubuntu-24.04",
  "timeout-minutes: 90",
  "node-version: 24.21.0",
  "version: 10.17.0",
  "pnpm install --frozen-lockfile",
  "playwright install --with-deps chrome",
  "python3-pytest",
  "fonts-dejavu-core",
  "ffmpeg=7:6.1.1-3ubuntu5",
  "fonts-dejavu-core=2.37-8",
  "python3-pytest=7.4.4-1",
  "pytest services/media-worker/tests",
  "node scripts/run-media-worker-tests.mjs",
  "node scripts/m3-av-e2e/run.mjs",
  "name: m4-single-shot-render-e2e-evidence",
  "retention-days: 7",
  "if: always()",
];
for (const snippet of renderRequired) {
  if (!renderWorkflow.includes(snippet)) failures.push(`render workflow missing ${JSON.stringify(snippet)}`);
}
for (const snippet of forbidden) {
  if (renderWorkflow.includes(snippet)) failures.push(`render workflow contains ${JSON.stringify(snippet)}`);
}
if (renderWorkflow.includes("docs/**")) failures.push("render workflow paths include docs");

for (const stage of ["episode-compose-preflight", "episode-compose-gates", "episode-compose-readonly"]) {
  if (!outcome.includes(`"${stage}"`)) failures.push(`outcome missing ${stage}`);
  if (!harness.includes(`"${stage}"`)) failures.push(`harness missing ${stage}`);
}
const episodeWorkflow = readFileSync(resolve(root, ".github/workflows/m4-episode-compose-preflight-e2e.yml"), "utf8").replace(/\r\n/g, "\n");
const episodeRequired = [
  "branches:\n      - feat/m4-episode-compose-preflight",
  "workflow_dispatch:",
  "contents: read",
  "ubuntu-24.04",
  "timeout-minutes: 90",
  "node-version: 24.21.0",
  "version: 10.17.0",
  "pnpm install --frozen-lockfile",
  "playwright install --with-deps chrome",
  "python3-pytest",
  "fonts-dejavu-core",
  "ffmpeg=7:6.1.1-3ubuntu5",
  "fonts-dejavu-core=2.37-8",
  "python3-pytest=7.4.4-1",
  "pytest services/media-worker/tests",
  "node scripts/run-media-worker-tests.mjs",
  "node scripts/m3-av-e2e/run.mjs",
  "name: m4-episode-compose-preflight-e2e-evidence",
  "retention-days: 7",
  "if: always()",
];
for (const snippet of episodeRequired) {
  if (!episodeWorkflow.includes(snippet)) failures.push(`episode workflow missing ${JSON.stringify(snippet)}`);
}
for (const snippet of forbidden) {
  if (episodeWorkflow.includes(snippet)) failures.push(`episode workflow contains ${JSON.stringify(snippet)}`);
}
if (episodeWorkflow.includes("docs/**")) failures.push("episode workflow paths include docs");

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("m3-av-e2e workflow and harness checks passed\n");
