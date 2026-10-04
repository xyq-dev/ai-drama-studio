import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const PROBE_TIMEOUT_MS = 8_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET_KEY = /PASSWORD|SECRET|TOKEN|DATABASE_URL|REDIS_URL|_KEY/i;

const REQUIRED_FIELDS = [
  "DATABASE_URL",
  "REDIS_URL",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "APP_WORKSPACE_ID",
];

const OPTIONAL_NONEMPTY = [
  "MOCK_OBJECT_DIR",
  "M4_COMPOSE_WORK_DIR",
  "M4_COMPOSE_OBJECT_DIR",
];

const ENUM_FLAGS = [
  "M3_MOCK_IMAGE_ENABLED",
  "M3_MOCK_AV_ENABLED",
  "M3_MOCK_SUBTITLE_MUSIC_ENABLED",
  "M4_MOCK_SAMPLE_VIDEO_ENABLED",
  "M4_LOCAL_COMPOSE_ENABLED",
  "M4_LOCAL_EPISODE_COMPOSE_ENABLED",
];

export function parseEnvText(text) {
  const values = {};
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const normalized = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
    const separator = normalized.indexOf("=");
    if (separator <= 0) continue;
    const key = normalized.slice(0, separator).trim();
    let value = normalized.slice(separator + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) values[key] = value;
  }
  return values;
}

export function mergeEnv(processEnv, fileEnv) {
  const merged = {};
  const keys = new Set([...Object.keys(fileEnv), ...Object.keys(processEnv)]);
  for (const key of keys) {
    if (processEnv[key] !== undefined) merged[key] = processEnv[key];
    else if (fileEnv[key] !== undefined) merged[key] = fileEnv[key];
  }
  return merged;
}

export function nodeVersionAccepted(version) {
  const match = /^v(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major !== 24) return false;
  if (minor > 21) return true;
  if (minor < 21) return false;
  return patch >= 0;
}

function flagState(value) {
  if (value === undefined) return "default-false";
  if (value === "true") return "true";
  if (value === "false") return "false";
  return "invalid";
}

function quotePath(value) {
  return `"${value}"`;
}

function secretValues(env) {
  const values = [];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && value.length >= 4 && SECRET_KEY.test(key)) values.push(value);
  }
  return values;
}

export function scrubSecrets(text, env) {
  let output = text;
  for (const secret of secretValues(env)) output = output.split(secret).join("[redacted]");
  return output;
}

function item(status, id, summary, suggestion) {
  return { status, id, summary, suggestion };
}

function defaultSpawn(command, args, spawnOptions) {
  if (process.platform === "win32" && command === "pnpm" && Array.isArray(args) && args.length === 1 && args[0] === "-v") {
    return spawnSync("pnpm -v", { ...spawnOptions, shell: true });
  }
  return spawnSync(command, args, spawnOptions);
}

function probe(spawn, command, args, timeoutMs) {
  const result = spawn(command, args, {
    timeout: timeoutMs,
    windowsHide: true,
    shell: false,
    encoding: "utf8",
  });
  if (result?.error?.code === "ETIMEDOUT" || result?.signal === "SIGTERM") {
    return { ok: false, reason: "timeout" };
  }
  if (result?.error) return { ok: false, reason: "missing" };
  if (result?.status !== 0) return { ok: false, reason: "failed" };
  return { ok: true, stdout: String(result.stdout ?? "") };
}

function toolSuggestion(id, reason) {
  const timeout = reason === "timeout" ? ` The probe exceeded ${PROBE_TIMEOUT_MS}ms and was stopped.` : "";
  if (id === "pnpm") {
    return `Install the pinned pnpm 10.17.0 with Corepack. The doctor does not install it.${timeout}`;
  }
  if (id === "python" || id === "pytest" || id === "compose-python") {
    return `Point the selected interpreter at the media-worker virtualenv and install services/media-worker[dev] there. The doctor does not install it or choose another Python.${timeout}`;
  }
  return `Install ${id} and put it on PATH. Ubuntu 24.04 CI uses ffmpeg 7:6.1.1-3ubuntu5 with ffprobe, libx264, and the subtitles filter. A Windows machine still needs its own install. The doctor does not install it.${timeout}`;
}

function absoluteDirIssue(name, value, exists) {
  if (value === undefined || value.length === 0) {
    if (value === undefined) {
      return item("missing", name, `${name} is unset.`, `Set ${name} to an existing absolute directory. The doctor does not create it.`);
    }
    return null;
  }
  if (!isAbsolute(value)) {
    return item("invalid", name, `${name} is not absolute.`, `Set ${name} to an absolute path. A relative path leaves the feature off.`);
  }
  if (!exists(value)) {
    return item("missing", name, `${name} does not exist: ${quotePath(value)}.`, `Create ${quotePath(value)} yourself before expecting the feature to run. The doctor does not create it.`);
  }
  return null;
}

export function inspectDevEnvironment(options) {
  const processEnv = options.processEnv ?? {};
  const fileEnv = options.fileEnv ?? parseEnvText(options.fileText ?? "");
  const merged = mergeEnv(processEnv, fileEnv);
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const spawn = options.spawn ?? defaultSpawn;
  const exists = options.pathExists ?? existsSync;
  const findings = [];

  const nodeVersion = options.nodeVersion ?? process.version;
  if (nodeVersionAccepted(nodeVersion)) {
    findings.push(item("ok", "node", `Node ${nodeVersion} satisfies >=24.21.0 <25.`, "No change."));
  } else {
    findings.push(item("missing", "node", `Node ${nodeVersion} is outside >=24.21.0 <25.`, "Use Node.js 24.21.0. The doctor does not install it. A tool check is not service ready."));
  }

  const pnpm = probe(spawn, "pnpm", ["-v"], timeoutMs);
  const pnpmVersion = pnpm.ok ? pnpm.stdout.trim() : "";
  if (pnpm.ok && pnpmVersion === "10.17.0") {
    findings.push(item("ok", "pnpm", "pnpm 10.17.0 is available.", "No change."));
  } else if (pnpm.ok) {
    findings.push(item("invalid", "pnpm", `pnpm ${pnpmVersion} is not the pinned 10.17.0.`, "Use Corepack with pnpm 10.17.0. The doctor does not change the installed version."));
  } else {
    findings.push(item("missing", "pnpm", "pnpm 10.17.0 was not probed successfully.", toolSuggestion("pnpm", pnpm.reason)));
  }

  const verifyPython = merged.MEDIA_WORKER_PYTHON;
  let verifyCommand = platform === "win32" ? "python" : "python3";
  if (verifyPython === undefined) {
    findings.push(item("ok", "python-selection", `MEDIA_WORKER_PYTHON is unset. pnpm verify uses ${verifyCommand}.`, "Set MEDIA_WORKER_PYTHON only when verify should use the media-worker virtualenv."));
  } else if (verifyPython.length === 0) {
    verifyCommand = "";
    findings.push(item("invalid", "python-selection", "MEDIA_WORKER_PYTHON is empty.", "Unset it to use the platform fallback, or set the media-worker virtualenv interpreter. The doctor will not substitute another Python."));
  } else {
    verifyCommand = verifyPython;
    findings.push(item("ok", "python-selection", `pnpm verify uses MEDIA_WORKER_PYTHON ${quotePath(verifyCommand)}.`, "This is the verify interpreter, not M4_COMPOSE_PYTHON and not the HTTP health process."));
  }

  if (verifyCommand.length > 0) {
    const python = probe(spawn, verifyCommand, ["-c", "import sys; print(sys.executable)"], timeoutMs);
    if (python.ok) {
      findings.push(item("ok", "python", `The selected verify interpreter started.`, "A successful probe is not media-worker ready and not a business loop."));
    } else {
      findings.push(item("missing", "python", `The selected verify interpreter did not start: ${quotePath(verifyCommand)}.`, toolSuggestion("python", python.reason)));
    }
    const pytest = python.ok ? probe(spawn, verifyCommand, ["-m", "pytest", "--version"], timeoutMs) : { ok: false, reason: "missing" };
    if (pytest.ok) {
      findings.push(item("ok", "pytest", "pytest runs inside the selected verify interpreter.", "No change."));
    } else if (python.ok) {
      findings.push(item("missing", "pytest", "The selected verify interpreter does not provide pytest.", toolSuggestion("pytest", pytest.reason)));
    } else {
      findings.push(item("missing", "pytest", "pytest was not probed because the selected verify interpreter did not start.", toolSuggestion("pytest", "missing")));
    }
  } else {
    findings.push(item("missing", "python", "No verify interpreter was selected.", toolSuggestion("python", "missing")));
    findings.push(item("missing", "pytest", "pytest was not probed because no verify interpreter was selected.", toolSuggestion("pytest", "missing")));
  }

  for (const command of ["ffmpeg", "ffprobe"]) {
    const result = probe(spawn, command, ["-version"], timeoutMs);
    if (result.ok) {
      findings.push(item("ok", command, `${command} responded to -version.`, "This does not mean a compose service is ready."));
    } else {
      findings.push(item("missing", command, `${command} was not probed successfully.`, toolSuggestion(command, result.reason)));
    }
  }

  if (options.envFileMissing) {
    findings.push(item("note", "env-file", "The selected env file is absent. Process environment is the only source, matching API and Worker when .env is absent.", "Copy .env.example to .env if you want the applications to read a file. The doctor does not create or edit it."));
  }

  for (const key of OPTIONAL_NONEMPTY) {
    if (merged[key] === "") {
      findings.push(item("invalid", key, `${key} is present and empty.`, `Remove ${key} or set a non-empty value. z.string().min(1).optional() rejects an empty string.`));
    }
  }

  for (const key of REQUIRED_FIELDS) {
    const value = merged[key];
    if (value === undefined || value.length === 0) {
      findings.push(item("missing", key, `${key} is missing.`, `Set ${key} in the process environment or the selected env file. Process environment wins when the variable is present, including an empty value. The doctor does not print the value.`));
      continue;
    }
    if (key === "DATABASE_URL" && !acceptableUrl(value, ["postgresql:", "postgres:"])) {
      findings.push(item("invalid", key, "DATABASE_URL is not a PostgreSQL URL.", "Use a postgresql:// or postgres:// URL. The doctor does not print the connection string or connect to it."));
    } else if (key === "REDIS_URL" && !acceptableUrl(value, ["redis:", "rediss:"])) {
      findings.push(item("invalid", key, "REDIS_URL is not a Redis URL.", "Use a redis:// or rediss:// URL. The doctor does not print the connection string."));
    } else if (key === "S3_ENDPOINT" && !acceptableUrl(value, ["http:", "https:"])) {
      findings.push(item("invalid", key, "S3_ENDPOINT is not an HTTP URL.", "Use an http:// or https:// endpoint. The doctor does not print credentials."));
    } else if (key === "APP_WORKSPACE_ID" && !UUID.test(value)) {
      findings.push(item("invalid", key, "APP_WORKSPACE_ID is not a UUID.", "Set the same workspace id the provision command expects."));
    } else {
      findings.push(item("ok", key, `${key} is present.`, "The value is not printed."));
    }
  }

  for (const key of ENUM_FLAGS) {
    const state = flagState(merged[key]);
    if (state === "invalid") {
      findings.push(item("invalid", key, `${key} must be true or false.`, "Use false to keep the feature off. The doctor does not change the flag."));
    }
  }

  const nodeEnv = merged.NODE_ENV;
  if (nodeEnv !== undefined && !["development", "test", "production"].includes(nodeEnv)) {
    findings.push(item("invalid", "NODE_ENV", "NODE_ENV is not development, test, or production.", "Use development for the local path."));
  }

  const image = flagState(merged.M3_MOCK_IMAGE_ENABLED) === "true";
  const av = flagState(merged.M3_MOCK_AV_ENABLED) === "true";
  const subtitles = flagState(merged.M3_MOCK_SUBTITLE_MUSIC_ENABLED) === "true";
  const sample = flagState(merged.M4_MOCK_SAMPLE_VIDEO_ENABLED) === "true";
  const compose = flagState(merged.M4_LOCAL_COMPOSE_ENABLED) === "true";
  const episode = flagState(merged.M4_LOCAL_EPISODE_COMPOSE_ENABLED) === "true";
  const enabled = image || av || subtitles || sample || compose || episode;
  if (!enabled) {
    findings.push(item("note", "features", "Mock, sample, and local compose switches are off.", "Leaving them false is the normal default. The doctor does not enable them."));
  }

  if (image || av || subtitles || sample || compose) {
    const directory = absoluteDirIssue("MOCK_OBJECT_DIR", merged.MOCK_OBJECT_DIR, exists);
    if (directory) findings.push(directory);
  }
  if (sample && !av) {
    findings.push(item("missing", "sample-video", "M4_MOCK_SAMPLE_VIDEO_ENABLED is true while M3_MOCK_AV_ENABLED is not true.", "Sample generation also requires the AV switch and an absolute MOCK_OBJECT_DIR. The doctor does not turn the AV switch on."));
  }
  if (compose || episode) {
    const work = absoluteDirIssue("M4_COMPOSE_WORK_DIR", merged.M4_COMPOSE_WORK_DIR, exists);
    const objectDir = absoluteDirIssue("M4_COMPOSE_OBJECT_DIR", merged.M4_COMPOSE_OBJECT_DIR, exists);
    if (work) findings.push(work);
    if (objectDir) findings.push(objectDir);
    const composePython = merged.M4_COMPOSE_PYTHON === undefined ? "python3" : merged.M4_COMPOSE_PYTHON;
    if (composePython.length === 0) {
      findings.push(item("invalid", "compose-python", "M4_COMPOSE_PYTHON is empty.", "Set the worker compose interpreter. The doctor does not choose another one."));
    } else {
      const result = probe(spawn, composePython, ["-c", "import sys; print(sys.executable)"], timeoutMs);
      if (result.ok) {
        findings.push(item("ok", "compose-python", `The worker compose interpreter started: ${quotePath(composePython)}.`, "M4_COMPOSE_PYTHON runs the compose CLI. It is separate from MEDIA_WORKER_PYTHON and from python -m media_worker."));
      } else {
        findings.push(item("missing", "compose-python", `The worker compose interpreter did not start: ${quotePath(composePython)}.`, toolSuggestion("compose-python", result.reason)));
      }
    }
  } else {
    const composePython = merged.M4_COMPOSE_PYTHON === undefined ? "python3" : merged.M4_COMPOSE_PYTHON;
    findings.push(item("note", "compose-python", `Local compose is off. The worker default interpreter is ${quotePath(composePython)} and was not required.`, "Set M4_COMPOSE_PYTHON only when compose is explicitly enabled."));
  }
  if (episode && !compose) {
    findings.push(item("missing", "episode-compose", "M4_LOCAL_EPISODE_COMPOSE_ENABLED is true while M4_LOCAL_COMPOSE_ENABLED is not true.", "Episode compose also requires the single-shot compose switch. The doctor does not turn it on."));
  }

  if (options.exampleText) {
    const example = parseEnvText(options.exampleText);
    const mismatch = infraMismatch(merged, example);
    if (mismatch) findings.push(mismatch);
  }

  const blocking = findings.filter((finding) => finding.status === "missing" || finding.status === "invalid");
  return {
    ok: blocking.length === 0,
    serviceReady: false,
    businessLoop: false,
    findings,
  };
}

function acceptableUrl(value, protocols) {
  try {
    const url = new URL(value);
    return protocols.includes(url.protocol);
  } catch {
    return false;
  }
}

function infraMismatch(merged, example) {
  const database = merged.DATABASE_URL;
  if (!database || !acceptableUrl(database, ["postgresql:", "postgres:"])) return null;
  let url;
  try {
    url = new URL(database);
  } catch {
    return null;
  }
  const expectedHost = example.POSTGRES_HOST;
  const expectedPort = example.POSTGRES_PORT;
  const expectedDb = example.POSTGRES_DB;
  const expectedUser = example.POSTGRES_USER;
  const same = url.hostname === expectedHost
    && url.port === expectedPort
    && url.pathname === `/${expectedDb}`
    && decodeURIComponent(url.username) === expectedUser;
  if (same) {
    return item("ok", "infra-env", "DATABASE_URL host, port, database, and user match .env.example.", "pnpm infra:* still reads .env.example. Keep the two files aligned. The connection string is not printed.");
  }
  return item("invalid", "infra-env", "DATABASE_URL host, port, database, or user differs from POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DB, or POSTGRES_USER in .env.example.", "pnpm infra:up always uses --env-file .env.example, while API and Worker read the selected env file with process environment overriding it. Align those fields. The doctor does not change either file or print the connection string.");
}

export function renderReport(result, env = {}) {
  const lines = [
    "dev-doctor",
    "scope: selected tools and configuration only",
    "serviceReady: false",
    "businessLoop: false",
    result.ok ? "result: no missing tool or configuration item" : "result: missing or invalid items follow",
  ];
  for (const finding of result.findings) {
    lines.push(`[${finding.status}] ${finding.id}`);
    lines.push(`summary: ${finding.summary}`);
    lines.push(`suggestion: ${finding.suggestion}`);
  }
  return scrubSecrets(`${lines.join("\n")}\n`, env);
}

function findRepoRoot(start) {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

function readOptional(file) {
  if (!existsSync(file)) return { missing: true, text: "" };
  return { missing: false, text: readFileSync(file, "utf8") };
}

export function runCli(argv, io = {}) {
  const stdout = io.stdout ?? ((text) => process.stdout.write(text));
  const stderr = io.stderr ?? ((text) => process.stderr.write(text));
  let envFile = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--env-file") {
      envFile = argv[index + 1] ?? "";
      index += 1;
      if (envFile.length === 0) {
        stderr("dev-doctor: --env-file requires a path\n");
        return 2;
      }
    } else {
      stderr("dev-doctor: unknown argument\n");
      return 2;
    }
  }
  const root = findRepoRoot(process.cwd());
  const selected = envFile.length > 0 ? envFile : join(root, ".env");
  const file = readOptional(selected);
  const example = readOptional(join(root, ".env.example"));
  const result = inspectDevEnvironment({
    processEnv: process.env,
    fileText: file.text,
    envFileMissing: file.missing,
    exampleText: example.missing ? "" : example.text,
  });
  const secrets = { ...parseEnvText(file.text), ...process.env };
  stdout(renderReport(result, secrets));
  return result.ok ? 0 : 1;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = runCli(process.argv.slice(2));
}
