import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const workflow = readFileSync(resolve(root, ".github/workflows/m3-av-e2e.yml"), "utf8").replace(/\r\n/g, "\n");
const smWorkflow = readFileSync(resolve(root, ".github/workflows/m3-sm-e2e.yml"), "utf8").replace(/\r\n/g, "\n");
const harness = readFileSync(resolve(root, "scripts/m3-av-e2e/run.mjs"), "utf8").replace(/\r\n/g, "\n");
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

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("m3-av-e2e workflow and harness checks passed\n");
