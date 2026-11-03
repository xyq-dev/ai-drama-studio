#!/usr/bin/env node
/**
 * GrokBot native drama tools CLI — first valuable loop:
 *   create / list / continue / save-script / status
 *
 * Default backend: local JSON store (works without site login).
 * --live: use ADS_* credentials against existing API (no paid paths).
 * --dry-run: print intended action only (default false for local; for --live
 *            writes, set ADS_LIVE_WRITES=1 explicitly or pass --execute).
 *
 * See docs/GROKBOT_NATIVE_TOOLS.md and grokbot-skills/ai-drama-native-tools/.
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

const COMMANDS = new Set(["help", "create", "list", "continue", "save-script", "status"]);

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

function printJson(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function helpText() {
  return [
    "grokbot-native-tools — create/list/continue/save-script/status",
    "",
    "Usage:",
    "  node scripts/grokbot-native-tools/cli.mjs <command> [options]",
    "",
    "Commands:",
    "  create        --title ... [--premise ...] [--genre ...] [--audience ...] [--episodes N]",
    "  list",
    "  continue      [--project-id ID]",
    "  save-script   --text ... | --text-file PATH [--project-id ID] [--episode N] [--script-title ...]",
    "  status        [--project-id ID]",
    "  help",
    "",
    "Backends:",
    "  (default) local store file: ADS_LOCAL_STORE or .grokbot-drama-store.json",
    "  --live      call existing /api/v1 (needs ADS_SESSION_COOKIE, ADS_CSRF_TOKEN, ADS_ORIGIN)",
    "  --env-file  load credentials from a protected file (never paste secrets in chat)",
    "  --dry-run   print plan only; no write",
    "  --execute   allow live writes when --live (also ADS_LIVE_WRITES=1)",
    "",
    "Paid generate/authorize/auto-runs are refused. Local store is offline text cache,",
    "not a second GenerationJob DB — promote to live API when credentials exist.",
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
      store: { type: "string" },
    },
  });

  if (values["env-file"]) loadEnvFile(resolve(values["env-file"]));

  const command = values.help ? "help" : positionals[0] || "help";
  if (!COMMANDS.has(command)) {
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
      output: {
        mode: "local",
        dryRun: true,
        storePath,
        command,
        plan: describeLocalPlan(command, values, store),
      },
    };
  }

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
  if (command === "status") {
    return {
      ok: true,
      exitCode: 0,
      output: { mode: "local", action: "status", storePath, status: projectStatus(store, values["project-id"]) },
    };
  }
  return { ok: false, exitCode: 1, output: { error: "unreachable" } };
}

function describeLocalPlan(command, values, store) {
  if (command === "create") return { create: { title: values.title, premise: values.premise } };
  if (command === "list") return { list: true, count: Object.keys(store.projects).length };
  if (command === "continue") return { continue: values["project-id"] || store.currentProjectId };
  if (command === "save-script") {
    return {
      saveScript: {
        projectId: values["project-id"] || store.currentProjectId,
        episode: values.episode || 1,
        textChars: (values.text || "").length || (values["text-file"] ? "(from file)" : 0),
      },
    };
  }
  if (command === "status") return { status: values["project-id"] || store.currentProjectId };
  return {};
}

async function runLive(command, values, { cfg, dryRun, allowLiveWrite }) {
  if (command === "list") {
    if (dryRun) {
      return { ok: true, exitCode: 0, output: { mode: "live", dryRun: true, plan: { GET: "/projects" } } };
    }
    const res = await liveListProjects(cfg);
    return { ok: true, exitCode: 0, output: { mode: "live", action: "list", ...res } };
  }
  if (command === "continue" || command === "status") {
    const projectId = values["project-id"];
    if (!projectId) {
      return { ok: false, exitCode: 1, output: { error: "--project-id required for live continue/status" } };
    }
    if (dryRun) {
      return {
        ok: true,
        exitCode: 0,
        output: {
          mode: "live",
          dryRun: true,
          plan: {
            GET: [`/projects/${projectId}`, `/projects/${projectId}/episodes`],
          },
        },
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
      output: {
        mode: "live",
        action: command,
        project: project.data,
        episodes: episodes.data,
        scripts: scripts?.data || null,
        note: "Live status is read-only aggregation; blockers must still be judged against reviewStatus/STALE.",
      },
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
      return {
        ok: false,
        exitCode: 1,
        output: { error: "live save-script needs --project-id and --episode-id" },
      };
    }
    const plan = {
      POST: `/projects/${projectId}/episodes/${episodeId}/scripts`,
      bodyChars: text.length,
    };
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
