#!/usr/bin/env node
/**
 * Thin GrokBot orchestration helper for ai-drama-studio.
 * Default mode is dry-run: print mapped HTTP/CLI only. Never sends paid generate/authorize/confirm.
 * See docs/GROKBOT_ORCHESTRATION.md.
 */
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const PAID_PATH_MARKERS = [
  "/real-media/generate",
  "/real-media/authorize",
  "/lines/", // narrowed below
  "/speech-batches/", // confirm/resume may create paid jobs
  "/auto-runs",
  "/title-runs",
  "/writing/candidates",
  "/writing/series",
  "/vimax-planning/requests",
  "generate-image",
  "generate-video",
  "generate-tts",
  "generate-music",
  "generate-subtitle",
];

const READ_COMMANDS = new Set([
  "help",
  "health",
  "progress",
  "pending-review",
  "quote-plan",
  "redo-plan",
  "compose-plan",
  "export-plan",
  "pause-plan",
  "create-plan",
]);

/** @typedef {{ name: string; method: string; path: string; paid: boolean; note?: string }} Step */

export function buildSteps(command, opts = {}) {
  const projectId = opts.projectId || "<projectId>";
  const episodeId = opts.episodeId || "<episodeId>";
  const shotRevisionId = opts.shotRevisionId || "<shotRevisionId>";
  const jobId = opts.jobId || "<jobId>";
  const batchId = opts.batchId || "<batchId>";
  const assetId = opts.assetId || "<assetId>";
  const lineId = opts.lineId || "<lineId>";
  const sceneId = opts.sceneId || "<sceneId>";
  const shotId = opts.shotId || "<shotId>";

  /** @type {Record<string, Step[]>} */
  const catalog = {
    help: [],
    health: [
      { name: "live", method: "GET", path: "/health/live", paid: false },
      { name: "ready", method: "GET", path: "/health/ready", paid: false },
    ],
    progress: [
      { name: "project", method: "GET", path: `/projects/${projectId}`, paid: false },
      { name: "cost-summary", method: "GET", path: `/projects/${projectId}/cost-summary`, paid: false },
      { name: "workflows", method: "GET", path: `/projects/${projectId}/workflow-runs`, paid: false },
      { name: "real-media-capabilities", method: "GET", path: `/projects/${projectId}/real-media/capabilities`, paid: false },
      { name: "cost-exposure", method: "GET", path: `/projects/${projectId}/real-media/cost-exposure`, paid: false },
      { name: "speech-capabilities", method: "GET", path: `/projects/${projectId}/speech-capabilities`, paid: false },
      { name: "speech-batch-plan", method: "GET", path: `/projects/${projectId}/episodes/${episodeId}/speech-batch-plan`, paid: false },
      { name: "speech-batches", method: "GET", path: `/projects/${projectId}/episodes/${episodeId}/speech-batches`, paid: false },
    ],
    "pending-review": [
      { name: "stories", method: "GET", path: `/projects/${projectId}/stories`, paid: false },
      { name: "episodes", method: "GET", path: `/projects/${projectId}/episodes`, paid: false },
      { name: "scripts", method: "GET", path: `/projects/${projectId}/episodes/${episodeId}/scripts`, paid: false },
      { name: "scenes", method: "GET", path: `/projects/${projectId}/episodes/${episodeId}/scenes`, paid: false },
      { name: "shots", method: "GET", path: `/projects/${projectId}/episodes/${episodeId}/scenes/${sceneId}/shots`, paid: false },
      { name: "composites", method: "GET", path: `/projects/${projectId}/episodes/${episodeId}/composites`, paid: false },
    ],
    "quote-plan": [
      { name: "real-media-quote", method: "POST", path: `/projects/${projectId}/shot-revisions/${shotRevisionId}/real-media/quote`, paid: false, note: "free quote; does not call provider" },
      { name: "speech-line-quote", method: "POST", path: `/speech-plans/${shotRevisionId}/lines/${lineId}/quote`, paid: false, note: "free quote" },
      { name: "authorize-checklist", method: "POST", path: `/projects/${projectId}/real-media/authorize`, paid: true, note: "BLOCKED here: needs confirmSinglePaidOperation + user budget" },
      { name: "generate-checklist", method: "POST", path: `/projects/${projectId}/shot-revisions/${shotRevisionId}/real-media/generate`, paid: true, note: "BLOCKED here: paid provider call" },
    ],
    "redo-plan": [
      { name: "shot-revisions", method: "GET", path: `/projects/${projectId}/episodes/${episodeId}/scenes/${sceneId}/shots/${shotId}/revisions`, paid: false },
      { name: "speech-plan", method: "GET", path: `/shot-revisions/${shotRevisionId}/speech-plan`, paid: false },
      { name: "takes", method: "GET", path: `/speech-plans/${shotRevisionId}/takes`, paid: false },
      { name: "line-generate", method: "POST", path: `/speech-plans/${shotRevisionId}/lines/${lineId}/generate`, paid: true, note: "BLOCKED here: paid TTS" },
      { name: "real-media-generate", method: "POST", path: `/projects/${projectId}/shot-revisions/${shotRevisionId}/real-media/generate`, paid: true, note: "BLOCKED here: paid media" },
    ],
    "compose-plan": [
      { name: "mix-preflight", method: "POST", path: `/speech-plans/${shotRevisionId}/mix-preflight`, paid: false, note: "read-only mix check" },
      { name: "shot-compose-preflight", method: "POST", path: `/shot-revisions/${shotRevisionId}/compose-preflight`, paid: false },
      { name: "episode-compose-preflight", method: "POST", path: `/projects/${projectId}/episodes/${episodeId}/compose-preflight`, paid: false },
      { name: "voice-compose", method: "POST", path: `/shot-revisions/${shotRevisionId}/voice-compose`, paid: false, note: "local ffmpeg; still needs Idempotency-Key + human review after" },
    ],
    "export-plan": [
      { name: "candidates", method: "GET", path: `/projects/${projectId}/episodes/${episodeId}/compose-candidates`, paid: false },
      { name: "composites", method: "GET", path: `/projects/${projectId}/episodes/${episodeId}/composites`, paid: false },
      { name: "download", method: "GET", path: `/projects/${projectId}/episodes/${episodeId}/composites/${assetId}/download`, paid: false },
      { name: "manifest", method: "GET", path: `/projects/${projectId}/episodes/${episodeId}/composites/${assetId}/export-manifest`, paid: false },
    ],
    "pause-plan": [
      { name: "job", method: "GET", path: `/generation-jobs/${jobId}`, paid: false },
      { name: "cancel-job", method: "POST", path: `/generation-jobs/${jobId}/cancel`, paid: false, note: "stops further work; does not refund provider charges" },
      { name: "batch", method: "GET", path: `/speech-batches/${batchId}`, paid: false },
      { name: "cancel-batch", method: "POST", path: `/speech-batches/${batchId}/cancel`, paid: false, note: "blocks new jobs only" },
      { name: "provision-plan-cli", method: "CLI", path: "pnpm --filter @ai-drama/api real-media:provision", paid: false, note: "plan only; never pass --execute from this script" },
    ],
    "create-plan": [
      { name: "create-project", method: "POST", path: "/projects", paid: false, note: "Idempotency-Key required; body {title,premise}" },
      { name: "auto-run-options", method: "GET", path: "/writing/auto-runs/options", paid: false },
      { name: "auto-run-start", method: "POST", path: `/projects/${projectId}/auto-runs`, paid: true, note: "BLOCKED here: paid text model" },
    ],
  };

  if (!catalog[command]) {
    throw new Error(`Unknown command: ${command}`);
  }
  return catalog[command];
}

export function assertNoPaidExecution(steps, { allowPaidChecklist = true } = {}) {
  for (const step of steps) {
    if (step.paid && !allowPaidChecklist) {
      throw new Error(`Refusing paid step: ${step.method} ${step.path}`);
    }
  }
  return true;
}

export function formatDryRun(command, steps, base = "/api/v1") {
  const lines = [
    `# grokbot-orchestration dry-run`,
    `command: ${command}`,
    `mode: dry-run (no HTTP unless --live on allowlisted read-only commands)`,
    `base: ${base}`,
    "",
  ];
  if (command === "help" || steps.length === 0) {
    lines.push("commands: " + [...READ_COMMANDS].sort().join(", "));
    lines.push("docs: docs/GROKBOT_ORCHESTRATION.md");
    return lines.join("\n");
  }
  for (const step of steps) {
    const flag = step.paid ? "PAID-CHECKLIST" : "SAFE";
    if (step.method === "CLI") {
      lines.push(`[${flag}] CLI ${step.path}`);
    } else {
      lines.push(`[${flag}] ${step.method} ${base}${step.path}`);
    }
    if (step.note) lines.push(`  note: ${step.note}`);
  }
  lines.push("");
  lines.push("Paid generate/authorize/confirm/execute are never issued by this script.");
  return lines.join("\n");
}

export function isLiveAllowed(command) {
  return command === "health";
}

export async function runLiveHealth(base) {
  const root = base.replace(/\/$/, "");
  const results = [];
  for (const path of ["/health/live", "/health/ready"]) {
    const url = `${root}${path}`;
    const response = await fetch(url, { method: "GET", redirect: "manual" });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    results.push({ path, status: response.status, body });
  }
  return results;
}

function printHelp() {
  process.stdout.write(`${formatDryRun("help", [])}\n`);
}

async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      live: { type: "boolean", default: false },
      "project-id": { type: "string" },
      "episode-id": { type: "string" },
      "shot-revision-id": { type: "string" },
      "job-id": { type: "string" },
      "batch-id": { type: "string" },
      "asset-id": { type: "string" },
      "line-id": { type: "string" },
      "scene-id": { type: "string" },
      "shot-id": { type: "string" },
      base: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });

  const command = values.help ? "help" : positionals[0] || "help";
  if (!READ_COMMANDS.has(command)) {
    process.stderr.write(`Unknown command: ${command}\n`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  const opts = {
    projectId: values["project-id"],
    episodeId: values["episode-id"],
    shotRevisionId: values["shot-revision-id"],
    jobId: values["job-id"],
    batchId: values["batch-id"],
    assetId: values["asset-id"],
    lineId: values["line-id"],
    sceneId: values["scene-id"],
    shotId: values["shot-id"],
  };
  const base = values.base || process.env.ADS_API_BASE || "https://drama.playhubs.cn/api/v1";
  const steps = buildSteps(command, opts);
  assertNoPaidExecution(steps, { allowPaidChecklist: true });
  process.stdout.write(`${formatDryRun(command, steps, base)}\n`);

  if (values.live) {
    if (!isLiveAllowed(command)) {
      process.stderr.write(`--live is only allowed for: health (refusing ${command})\n`);
      process.exitCode = 2;
      return;
    }
    // Guard: refuse if someone points live health at a write URL pattern
    for (const marker of PAID_PATH_MARKERS) {
      if (base.includes(marker)) {
        process.stderr.write("Refusing --live against a base that looks like a paid path.\n");
        process.exitCode = 2;
        return;
      }
    }
    const results = await runLiveHealth(base);
    process.stdout.write(`${JSON.stringify({ live: true, paidCalls: 0, results }, null, 2)}\n`);
  }
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
