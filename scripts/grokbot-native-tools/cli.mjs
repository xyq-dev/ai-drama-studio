#!/usr/bin/env node
/**
 * GrokBot native drama tools CLI
 * Local loop: create / list / continue / save-script / approve-script /
 *   set-characters / set-storyboard / approve-scene / voice-plan / status
 *
 * Default backend: local JSON store (works without site login).
 * --live: read/create/save-script against /api/v1 only (no approve forge, no TTS).
 * Live writes need ADS_* + --execute. Paid paths refused.
 */
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  defaultStorePath,
  loadStore,
  saveStore,
  createProject,
  listProjects,
  continueProject,
  saveScript,
  approveScript,
  setCharacters,
  setStoryboard,
  approveScene,
  voicePlan,
  projectStatus,
} from "./store.mjs";
import {
  liveConfigFromEnv,
  assertLiveReady,
  liveCreateProject,
  liveListProjects,
  liveGetProject,
  liveListEpisodes,
  liveSaveScript,
  liveListScripts,
} from "./live-api.mjs";

const LOCAL_COMMANDS = new Set([
  "help",
  "create",
  "list",
  "continue",
  "save-script",
  "approve-script",
  "set-characters",
  "set-storyboard",
  "approve-scene",
  "voice-plan",
  "status",
]);

const LIVE_COMMANDS = new Set(["help", "create", "list", "continue", "save-script", "status"]);

function loadEnvFile(path) {
  if (!path || !existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

function readJsonOpt(values, flag, fileFlag) {
  if (values[fileFlag]) {
    return JSON.parse(readFileSync(resolve(values[fileFlag]), "utf8"));
  }
  if (values[flag]) return JSON.parse(values[flag]);
  return null;
}

function printJson(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function helpText() {
  return [
    "grokbot-native-tools — local text→voice-plan loop (+ optional live create/list/script)",
    "",
    "Usage:",
    "  node scripts/grokbot-native-tools/cli.mjs <command> [options]",
    "",
    "Commands (local store):",
    "  create           --title ... [--premise ...] [--genre ...] [--audience ...] [--episodes N]",
    "  list",
    "  continue         [--project-id ID]",
    "  save-script      --text ... | --text-file PATH [--project-id ID] [--episode N] [--script-title ...]",
    "  approve-script   --approved-by user:... [--project-id ID] [--episode N] [--revision-id ID]",
    "  set-characters   --characters '[...]' | --characters-file PATH [--project-id ID]",
    "  set-storyboard   --scene '{...}' | --scene-file PATH [--project-id ID]",
    "  approve-scene    --approved-by user:... [--project-id ID] [--scene-id ID]",
    "  voice-plan       [--project-id ID] [--episode N] [--currency ...] [--budget-cap ...]",
    "  status           [--project-id ID]",
    "  help",
    "",
    "Backends:",
    "  (default) local store: ADS_LOCAL_STORE or .grokbot-drama-store.json",
    "  --live      limited to create/list/continue/save-script/status (needs ADS_*)",
    "  --env-file  protected credentials file (never paste secrets in chat)",
    "  --dry-run   print plan only; no write",
    "  --execute   allow live writes when --live",
    "",
    "APPROVE is a human gate: --approved-by is required. No paid TTS/generate here.",
    "gpt-image-2.5-sunburst is not invoked by this CLI. Image spend stays behind real-media quote/authorize.",
  ].join("\n");
}

export async function runCli(argv = process.argv.slice(2), { env = process.env } = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", default: false },
      live: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      execute: { type: "boolean", default: false },
      "env-file": { type: "string" },
      title: { type: "string" },
      premise: { type: "string" },
      genre: { type: "string" },
      audience: { type: "string" },
      episodes: { type: "string" },
      "project-id": { type: "string" },
      episode: { type: "string" },
      "episode-id": { type: "string" },
      text: { type: "string" },
      "text-file": { type: "string" },
      "script-title": { type: "string" },
      "revision-id": { type: "string" },
      "approved-by": { type: "string" },
      characters: { type: "string" },
      "characters-file": { type: "string" },
      scene: { type: "string" },
      "scene-file": { type: "string" },
      "scene-id": { type: "string" },
      currency: { type: "string" },
      "budget-cap": { type: "string" },
      store: { type: "string" },
    },
  });

  if (values["env-file"]) loadEnvFile(resolve(values["env-file"]));

  const command = values.help ? "help" : positionals[0] || "help";
  if (!LOCAL_COMMANDS.has(command)) {
    return { ok: false, exitCode: 1, output: { error: `Unknown command: ${command}`, help: helpText() } };
  }
  if (command === "help") {
    return { ok: true, exitCode: 0, output: { help: helpText() } };
  }

  const dryRun = Boolean(values["dry-run"]);
  const live = Boolean(values.live);
  const allowLiveWrite = Boolean(values.execute) || env.ADS_LIVE_WRITES === "1";
  const storePath = values.store || defaultStorePath();

  if (live) {
    if (!LIVE_COMMANDS.has(command)) {
      return {
        ok: false,
        exitCode: 2,
        output: {
          mode: "live",
          error: `Command ${command} is local-store only in this PR (no live forge of APPROVE / no TTS). Use local mode.`,
        },
      };
    }
    const cfg = liveConfigFromEnv(env);
    try {
      assertLiveReady(cfg);
    } catch (error) {
      return {
        ok: false,
        exitCode: 2,
        output: {
          mode: "live",
          error: error instanceof Error ? error.message : String(error),
          hint: "Use local mode (omit --live) or supply --env-file with ADS_* vars.",
        },
      };
    }
    return runLive(command, values, { cfg, dryRun, allowLiveWrite });
  }

  return runLocal(command, values, { storePath, dryRun });
}

function runLocal(command, values, { storePath, dryRun }) {
  const store = loadStore(storePath);
  if (dryRun) {
    return {
      ok: true,
      exitCode: 0,
      output: { mode: "local", dryRun: true, storePath, command, plan: { command, projectId: values["project-id"] || store.currentProjectId } },
    };
  }

  try {
    if (command === "create") {
      const project = createProject(store, {
        title: values.title,
        premise: values.premise,
        genre: values.genre,
        audience: values.audience,
        episodeCount: values.episodes,
      });
      saveStore(store, storePath);
      return { ok: true, exitCode: 0, output: { mode: "local", action: "create", storePath, project } };
    }
    if (command === "list") {
      return {
        ok: true,
        exitCode: 0,
        output: {
          mode: "local",
          action: "list",
          storePath,
          currentProjectId: store.currentProjectId,
          projects: listProjects(store).map((p) => ({
            id: p.id,
            title: p.title,
            stage: p.stage || null,
            updatedAt: p.updatedAt,
            episodeCount: p.episodeCount,
            scriptRevisions: p.episodes.reduce((n, e) => n + e.scripts.length, 0),
          })),
        },
      };
    }
    if (command === "continue") {
      const project = continueProject(store, values["project-id"]);
      saveStore(store, storePath);
      return {
        ok: true,
        exitCode: 0,
        output: {
          mode: "local",
          action: "continue",
          storePath,
          project: {
            id: project.id,
            title: project.title,
            premise: project.premise,
            stage: project.stage || null,
            updatedAt: project.updatedAt,
            episodes: project.episodes.map((e) => ({
              id: e.id,
              episodeNo: e.episodeNo,
              scriptCount: e.scripts.length,
              latestReview: e.scripts.at(-1)?.reviewStatus || null,
            })),
          },
        },
      };
    }
    if (command === "save-script") {
      const text = values.text || (values["text-file"] ? readFileSync(resolve(values["text-file"]), "utf8") : "");
      const result = saveScript(store, {
        projectId: values["project-id"],
        episodeNo: values.episode || 1,
        text,
        title: values["script-title"],
      });
      saveStore(store, storePath);
      return {
        ok: true,
        exitCode: 0,
        output: {
          mode: "local",
          action: "save-script",
          storePath,
          projectId: result.project.id,
          episodeId: result.episode.id,
          revision: result.revision,
        },
      };
    }
    if (command === "approve-script") {
      const result = approveScript(store, {
        projectId: values["project-id"],
        episodeNo: values.episode || 1,
        revisionId: values["revision-id"],
        approvedBy: values["approved-by"],
      });
      saveStore(store, storePath);
      return {
        ok: true,
        exitCode: 0,
        output: {
          mode: "local",
          action: "approve-script",
          storePath,
          alreadyApproved: result.alreadyApproved,
          revision: {
            id: result.revision.id,
            reviewStatus: result.revision.reviewStatus,
            approvedBy: result.revision.approvedBy,
            approvedAt: result.revision.approvedAt,
          },
          stage: result.project.stage,
        },
      };
    }
    if (command === "set-characters") {
      const characters = readJsonOpt(values, "characters", "characters-file");
      const result = setCharacters(store, { projectId: values["project-id"], characters });
      saveStore(store, storePath);
      return {
        ok: true,
        exitCode: 0,
        output: { mode: "local", action: "set-characters", storePath, characters: result.characters, stage: result.project.stage },
      };
    }
    if (command === "set-storyboard") {
      const scene = readJsonOpt(values, "scene", "scene-file");
      if (!scene) throw new Error("--scene or --scene-file required");
      const result = setStoryboard(store, { projectId: values["project-id"], scene });
      saveStore(store, storePath);
      return {
        ok: true,
        exitCode: 0,
        output: { mode: "local", action: "set-storyboard", storePath, scene: result.scene, stage: result.project.stage },
      };
    }
    if (command === "approve-scene") {
      const result = approveScene(store, {
        projectId: values["project-id"],
        sceneId: values["scene-id"],
        approvedBy: values["approved-by"],
      });
      saveStore(store, storePath);
      return {
        ok: true,
        exitCode: 0,
        output: {
          mode: "local",
          action: "approve-scene",
          storePath,
          alreadyApproved: result.alreadyApproved,
          scene: {
            id: result.scene.id,
            status: result.scene.status,
            approvedBy: result.scene.approvedBy,
            approvedAt: result.scene.approvedAt,
          },
          stage: result.project.stage,
        },
      };
    }
    if (command === "voice-plan") {
      const result = voicePlan(store, {
        projectId: values["project-id"],
        episodeNo: values.episode || 1,
        currency: values.currency || "待填",
        budgetCap: values["budget-cap"] || "待你授权",
      });
      saveStore(store, storePath);
      return {
        ok: true,
        exitCode: 0,
        output: {
          mode: "local",
          action: "voice-plan",
          storePath,
          stage: result.project.stage,
          voicePlan: result.voicePlan,
          paidCalls: 0,
          note: "Plan only — no TTS submitted",
        },
      };
    }
    if (command === "status") {
      return {
        ok: true,
        exitCode: 0,
        output: { mode: "local", action: "status", storePath, status: projectStatus(store, values["project-id"]) },
      };
    }
  } catch (error) {
    return {
      ok: false,
      exitCode: 1,
      output: { mode: "local", error: error instanceof Error ? error.message : String(error) },
    };
  }
  return { ok: false, exitCode: 1, output: { error: "unreachable" } };
}

async function runLive(command, values, { cfg, dryRun, allowLiveWrite }) {
  if (command === "list") {
    if (dryRun) return { ok: true, exitCode: 0, output: { mode: "live", dryRun: true, plan: { GET: "/projects" } } };
    const res = await liveListProjects(cfg);
    return { ok: true, exitCode: 0, output: { mode: "live", action: "list", ...res } };
  }
  if (command === "continue" || command === "status") {
    const projectId = values["project-id"];
    if (!projectId) return { ok: false, exitCode: 1, output: { error: "--project-id required for live continue/status" } };
    if (dryRun) {
      return {
        ok: true,
        exitCode: 0,
        output: { mode: "live", dryRun: true, plan: { GET: [`/projects/${projectId}`, `/projects/${projectId}/episodes`] } },
      };
    }
    const project = await liveGetProject(cfg, projectId);
    const episodes = await liveListEpisodes(cfg, projectId);
    let scripts = null;
    const first = episodes.data?.items?.[0] || episodes.data?.[0];
    if (first?.id) {
      try {
        scripts = await liveListScripts(cfg, projectId, first.id);
      } catch {
        scripts = null;
      }
    }
    return {
      ok: true,
      exitCode: 0,
      output: { mode: "live", action: command, project: project.data, episodes: episodes.data, scripts: scripts?.data || null },
    };
  }
  if (command === "create") {
    const plan = { POST: "/projects", body: { title: values.title, premise: values.premise || "" } };
    if (dryRun || !allowLiveWrite) {
      return {
        ok: true,
        exitCode: 0,
        output: {
          mode: "live",
          dryRun: dryRun || !allowLiveWrite,
          plan,
          hint: allowLiveWrite ? null : "Pass --execute or ADS_LIVE_WRITES=1 to perform live create",
        },
      };
    }
    const res = await liveCreateProject(cfg, { title: values.title, premise: values.premise });
    return { ok: true, exitCode: 0, output: { mode: "live", action: "create", ...res } };
  }
  if (command === "save-script") {
    const projectId = values["project-id"];
    const episodeId = values["episode-id"];
    const text = values.text || (values["text-file"] ? readFileSync(resolve(values["text-file"]), "utf8") : "");
    if (!projectId || !episodeId) {
      return { ok: false, exitCode: 1, output: { error: "live save-script needs --project-id and --episode-id" } };
    }
    const plan = { POST: `/projects/${projectId}/episodes/${episodeId}/scripts`, bodyChars: text.length };
    if (dryRun || !allowLiveWrite) {
      return {
        ok: true,
        exitCode: 0,
        output: {
          mode: "live",
          dryRun: dryRun || !allowLiveWrite,
          plan,
          hint: allowLiveWrite ? null : "Pass --execute or ADS_LIVE_WRITES=1 to write script revision",
        },
      };
    }
    const res = await liveSaveScript(cfg, { projectId, episodeId, text });
    return { ok: true, exitCode: 0, output: { mode: "live", action: "save-script", ...res } };
  }
  return { ok: false, exitCode: 1, output: { error: `live command not implemented: ${command}` } };
}

async function main() {
  try {
    const result = await runCli();
    if (result.output?.help && Object.keys(result.output).length === 1) {
      process.stdout.write(`${result.output.help}\n`);
    } else {
      printJson(result.output);
    }
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  main();
}
