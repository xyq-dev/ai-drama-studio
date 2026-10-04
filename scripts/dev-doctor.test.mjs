import assert from "node:assert/strict";
import test from "node:test";
import { inspectDevEnvironment, parseEnvText, renderReport } from "./dev-doctor.mjs";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const DATABASE = "postgresql://ai_drama:super-secret-token@127.0.0.1:55432/ai_drama";
const SECRET = "secret-token-value";

function baseFile(extra = "") {
  return [
    "NODE_ENV=development",
    `DATABASE_URL=${DATABASE}`,
    "REDIS_URL=redis://127.0.0.1:56379",
    "S3_ENDPOINT=http://127.0.0.1:59000",
    "S3_REGION=us-east-1",
    "S3_BUCKET=ai-drama-dev",
    "S3_ACCESS_KEY_ID=ai-drama-dev",
    `S3_SECRET_ACCESS_KEY=${SECRET}`,
    `APP_WORKSPACE_ID=${WORKSPACE}`,
    "M3_MOCK_IMAGE_ENABLED=false",
    "M3_MOCK_AV_ENABLED=false",
    "M3_MOCK_SUBTITLE_MUSIC_ENABLED=false",
    "M4_MOCK_SAMPLE_VIDEO_ENABLED=false",
    "M4_LOCAL_COMPOSE_ENABLED=false",
    "M4_LOCAL_EPISODE_COMPOSE_ENABLED=false",
    extra,
  ].join("\n");
}

const example = [
  "POSTGRES_HOST=127.0.0.1",
  "POSTGRES_PORT=55432",
  "POSTGRES_DB=ai_drama",
  "POSTGRES_USER=ai_drama",
  "POSTGRES_PASSWORD=super-secret-token",
].join("\n");

function tools(overrides = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const override = overrides[command];
    if (override) return override;
    if (command === "pnpm") return { status: 0, stdout: "10.17.0\n" };
    if (command === "ffmpeg" || command === "ffprobe") return { status: 0, stdout: "ffmpeg version\n" };
    if (args[0] === "-m") return { status: 0, stdout: "pytest 9.1.1\n" };
    return { status: 0, stdout: `${command}\n` };
  };
  return { calls, spawn };
}

function inspect(options) {
  const { calls, spawn } = tools(options.overrides);
  const result = inspectDevEnvironment({
    processEnv: options.processEnv ?? {},
    fileText: options.fileText ?? baseFile(),
    exampleText: options.exampleText === undefined ? example : options.exampleText,
    platform: "win32",
    nodeVersion: "v24.21.0",
    spawn,
    pathExists: options.pathExists ?? (() => false),
  });
  return { result, calls, report: renderReport(result, { ...parseEnvText(options.fileText ?? baseFile()), ...(options.processEnv ?? {}) }) };
}

function finding(result, id) {
  return result.findings.find((item) => item.id === id);
}

test("missing ffmpeg and ffprobe are reported without claiming ready", () => {
  const missing = { error: Object.assign(new Error("not found"), { code: "ENOENT" }), status: null };
  const { result, report } = inspect({ overrides: { ffmpeg: missing, ffprobe: missing } });
  assert.equal(result.ok, false);
  assert.equal(result.serviceReady, false);
  assert.equal(result.businessLoop, false);
  assert.equal(finding(result, "ffmpeg").status, "missing");
  assert.match(finding(result, "ffmpeg").suggestion, /Install ffmpeg/);
  assert.match(finding(result, "ffprobe").suggestion, /does not install/);
  assert.match(report, /serviceReady: false/);
  assert.match(report, /businessLoop: false/);
  assert.doesNotMatch(report, /business loop passed/);
});

test("the selected verify interpreter is probed and an empty value is not replaced", () => {
  const selected = "C:\\Program Files\\Python\\python.exe";
  const filePython = "C:\\file python\\python.exe";
  const chosen = inspect({
    fileText: baseFile(`MEDIA_WORKER_PYTHON=${filePython}\n`),
    processEnv: { MEDIA_WORKER_PYTHON: selected },
  });
  assert.ok(chosen.calls.some((call) => call.command === selected && call.options.shell === false));
  assert.equal(chosen.calls.some((call) => call.command === filePython), false);
  assert.equal(finding(chosen.result, "python").status, "ok");

  const empty = inspect({
    fileText: baseFile(`MEDIA_WORKER_PYTHON=${filePython}\n`),
    processEnv: { MEDIA_WORKER_PYTHON: "" },
  });
  assert.equal(finding(empty.result, "python-selection").status, "invalid");
  assert.equal(empty.calls.some((call) => call.command === filePython), false);
  assert.match(finding(empty.result, "python-selection").suggestion, /will not substitute/);
});

test("process environment overrides the env file and a quoted path keeps its spaces", () => {
  const parsed = parseEnvText("M4_COMPOSE_WORK_DIR=\"C:\\ai drama\\work\"\nMEDIA_WORKER_PYTHON=from-file\n");
  assert.equal(parsed.M4_COMPOSE_WORK_DIR, "C:\\ai drama\\work");
  const work = "C:\\ai drama\\work";
  const objects = "C:\\ai drama\\objects";
  const mock = "C:\\ai drama\\mock";
  const composePython = "C:\\Program Files\\Python\\python.exe";
  const { result, calls, report } = inspect({
    fileText: baseFile([
      "M4_LOCAL_COMPOSE_ENABLED=true",
      `MOCK_OBJECT_DIR=${mock}`,
      `M4_COMPOSE_WORK_DIR=${work}`,
      `M4_COMPOSE_OBJECT_DIR=${objects}`,
      `M4_COMPOSE_PYTHON=${composePython}`,
      "MEDIA_WORKER_PYTHON=from-file",
    ].join("\n")),
    processEnv: { MEDIA_WORKER_PYTHON: "from-process" },
    pathExists: (value) => [work, objects, mock].includes(value),
  });
  assert.equal(result.ok, true);
  assert.ok(calls.some((call) => call.command === "from-process" && call.options.timeout === 8_000));
  assert.equal(calls.some((call) => call.command === "from-file"), false);
  assert.ok(calls.some((call) => call.command === composePython && call.args[0] === "-c" && call.options.shell === false));
  assert.equal(calls.some((call) => call.command === "C:\\ai"), false);
  assert.match(report, /Program Files/);
});

test("disabled features do not require directories or the compose interpreter", () => {
  const { result, calls } = inspect({ pathExists: () => false });
  assert.equal(result.ok, true);
  assert.equal(finding(result, "features").status, "note");
  assert.match(finding(result, "features").summary, /off/);
  assert.equal(finding(result, "MOCK_OBJECT_DIR"), undefined);
  assert.equal(finding(result, "compose-python").status, "note");
  assert.equal(calls.some((call) => call.command === "python3"), false);
});

test("a timed-out probe stays a tool failure and secrets are absent from the report", () => {
  const timedOut = { error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }), status: null };
  const { report } = inspect({ overrides: { ffmpeg: timedOut } });
  assert.match(report, /exceeded 8000ms/);
  assert.equal(report.includes("super-secret-token"), false);
  assert.equal(report.includes(SECRET), false);
  assert.equal(report.includes("postgresql://"), false);
  assert.equal(report.includes(DATABASE), false);
});
