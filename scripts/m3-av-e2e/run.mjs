import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";

const repo = resolve(import.meta.dirname, "../..");
const outputDir = resolve(repo, "m3-av-e2e-output");
const composeFile = resolve(repo, "infra/compose.yaml");
const runId = process.env.GITHUB_RUN_ID ?? `${Date.now()}`;
const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? "0";
const runToken = `${runId}a${runAttempt}`.replace(/[^a-zA-Z0-9]/g, "");
const project = `m3av-${runId}-${runAttempt}`.toLowerCase().replace(/[^a-z0-9_-]/g, "");
const dbName = `m3av_${runToken}`.slice(0, 60);
const dbUser = `m3av_${runToken}`.slice(0, 60);
const dbPassword = randomBytes(18).toString("hex");
const minioUser = `m3av${runToken}`.slice(0, 32);
const minioPassword = randomBytes(18).toString("hex");
const bucket = `m3av-${runToken}`.slice(0, 63).toLowerCase();
const postgresPort = "55432";
const redisPort = "56379";
const s3Port = "59000";
const tempRoot = process.env.RUNNER_TEMP ?? tmpdir();
const mockDir = join(tempRoot, `m3-av-mock-${runToken}`);
const envFile = join(tempRoot, `m3-av-compose-${runToken}.env`);
const apiOrigin = "http://127.0.0.1:3001";
const webOrigin = "http://127.0.0.1:3000";
const workerOrigin = "http://127.0.0.1:3002";
const promptText = "fixed black frame for audit";
const dialogueText = "fixed silence for audit";
const draftMarker = "unsaved-draft-m3-av-e2e";
const videoSha = "6cbb357d0c5429c415430d0596dfc04417b9fa967eeb34e55186b0a3a9f590e3";
const audioSha = "c726d333dd159a31423f3480dbb1c5c4a9dfcd30efe1f7e12ade390dc92e8908";

const databaseUrl = `postgresql://${dbUser}:${dbPassword}@127.0.0.1:${postgresPort}/${dbName}`;
const redisUrl = `redis://127.0.0.1:${redisPort}`;
const s3Endpoint = `http://127.0.0.1:${s3Port}`;
const workspaceId = randomUUID();
const otherWorkspaceId = randomUUID();
const secrets = [dbPassword, minioPassword, databaseUrl];

const state = {
  apps: [],
  logFds: [],
  db: null,
  browser: null,
  page: null,
  composeStarted: false,
  bak: null,
  posts: [],
  contentRequests: [],
  consoleEvents: [],
  world: null,
  evidence: {},
};

const stages = [];
const pending = [
  "docker",
  "compose",
  "identity",
  "migrate-provision",
  "processes",
  "source-chain",
  "page-submit",
  "playback",
  "content-headers",
  "png-draft-viewport",
  "idempotency-retry",
  "revision-history",
  "gates",
  "mock-boundary",
  "recovery-disk",
  "recovery-flag",
];

const notRun = [
  "成本冲突",
  "全部暂时故障与取消竞争",
  "隐藏标签页",
  "Windows 与其余未在本轮触发的 Compose 故障组合",
  "既有 integration 套件（那些套件会 DROP SCHEMA，不能代替本闭环）",
  "新 Migration、DROP SCHEMA、全库重置、main、force push、PR、merge、应用 pack、部署、付费 Provider、ComfyUI、真实模型",
];

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repo,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new Error(`${command} timed out\n${stderr.slice(-2000)}`));
    }, options.timeoutMs ?? 120_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !options.allowFail) {
        rejectRun(new Error(`${command} ${args.join(" ")} exited ${code}\n${stderr.slice(-2000)}\n${stdout.slice(-2000)}`));
        return;
      }
      resolveRun({ code: code ?? 1, stdout, stderr });
    });
  });
}

function killGroup(pid) {
  if (!pid) return;
  try {
    process.kill(process.platform === "linux" ? -pid : pid, "SIGTERM");
  } catch {
    try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ }
  }
}

function spawnApp(name, args, env) {
  mkdirSync(outputDir, { recursive: true });
  const logPath = join(outputDir, `${name}.log`);
  const fd = openSync(logPath, "a");
  state.logFds.push(fd);
  const child = spawn(args[0], args.slice(1), {
    cwd: repo,
    env,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  const app = { name, pid: child.pid, logPath };
  state.apps.push(app);
  return app;
}

async function stopApp(name) {
  const app = state.apps.find((item) => item.name === name);
  if (!app?.pid) return;
  killGroup(app.pid);
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    try {
      process.kill(app.pid, 0);
      await sleep(200);
    } catch {
      break;
    }
  }
  try { process.kill(process.platform === "linux" ? -app.pid : app.pid, "SIGKILL"); } catch { /* exited */ }
  state.apps = state.apps.filter((item) => item !== app);
}

function appEnv(overrides = {}) {
  return {
    ...process.env,
    NODE_ENV: "development",
    BIND_HOST: "127.0.0.1",
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    S3_ENDPOINT: s3Endpoint,
    S3_REGION: "us-east-1",
    S3_BUCKET: bucket,
    S3_ACCESS_KEY_ID: minioUser,
    S3_SECRET_ACCESS_KEY: minioPassword,
    S3_FORCE_PATH_STYLE: "true",
    HEALTH_CHECK_TIMEOUT_MS: "2000",
    APP_WORKSPACE_ID: workspaceId,
    APP_WORKSPACE_NAME: "M3 AV E2E",
    M3_MOCK_IMAGE_ENABLED: "true",
    M3_MOCK_AV_ENABLED: "true",
    MOCK_OBJECT_DIR: mockDir,
    API_PORT: "3001",
    WORKER_HEALTH_PORT: "3002",
    NEXT_PUBLIC_API_BASE_URL: apiOrigin,
    ...overrides,
  };
}

async function sql(text, params = []) {
  if (!/^\s*(select|with)\b/i.test(text)) throw new Error("harness SQL is read-only");
  const result = await state.db.query(text, params);
  return result.rows;
}

async function connectDb() {
  const require = createRequire(resolve(repo, "packages/database/package.json"));
  const { Client } = require("pg");
  const client = new Client({ connectionString: databaseUrl, statement_timeout: 10_000 });
  await client.connect();
  return client;
}

async function callApi(base, method, path, options = {}) {
  const headers = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && method !== "HEAD") headers["idempotency-key"] = options.key ?? randomUUID();
  if (options.ifMatch !== undefined) headers["if-match"] = String(options.ifMatch);
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  const text = await response.text();
  let body = null;
  if (text.length > 0) {
    try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 400) }; }
  }
  return { status: response.status, body };
}

function expectStatus(response, status, code) {
  if (response.status !== status || (code && response.body?.error?.code !== code)) {
    throw new Error(`expected ${status}${code ? ` ${code}` : ""}, got ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response;
}

async function approve(base, path, ifMatch) {
  const submitted = expectStatus(await callApi(base, "POST", path, {
    ifMatch,
    body: { to: "IN_REVIEW", expectedReviewVersion: 1 },
  }), 200);
  return expectStatus(await callApi(base, "POST", path, {
    ifMatch: submitted.body.rowVersion,
    body: { to: "APPROVED", expectedReviewVersion: submitted.body.reviewVersion },
  }), 200).body;
}

async function projectVersion() {
  const response = expectStatus(await callApi(apiOrigin, "GET", `/projects/${state.world.projectId}`), 200);
  return response.body.version;
}

async function episodeOne() {
  const response = expectStatus(await callApi(apiOrigin, "GET", `/projects/${state.world.projectId}/episodes`), 200);
  const episode = response.body.items.find((item) => item.episodeNo === 1);
  if (!episode) throw new Error(`episode 1 missing: ${JSON.stringify(response.body)}`);
  return episode;
}

function shotPayload(sourceSceneRevisionId, ordinal, action, prompt, dialogue) {
  return {
    sourceSceneRevisionId,
    ordinal,
    shotType: "wide",
    camera: "static",
    action,
    promptText: prompt,
    dialogue,
  };
}

async function createApprovedShot(ordinal, action, prompt, dialogue) {
  const sceneVersion = expectStatus(await callApi(
    apiOrigin, "GET",
    `/projects/${state.world.projectId}/episodes/${state.world.episodeId}/scenes/${state.world.sceneId}/revisions`,
  ), 200).body.aggregate.rowVersion;
  const created = expectStatus(await callApi(
    apiOrigin, "POST",
    `/projects/${state.world.projectId}/episodes/${state.world.episodeId}/scenes/${state.world.sceneId}/shots`,
    { ifMatch: sceneVersion, body: shotPayload(state.world.sceneRevisionId, ordinal, action, prompt, dialogue) },
  ), 201);
  const approved = await approve(
    apiOrigin,
    `/projects/${state.world.projectId}/episodes/${state.world.episodeId}/scenes/${state.world.sceneId}/shots/${created.body.entityId}/revisions/${created.body.revisionId}/review`,
    created.body.rowVersion,
  );
  return { shotId: created.body.entityId, revisionId: created.body.revisionId, rowVersion: approved.rowVersion };
}

async function jobCount(workspace = workspaceId) {
  const rows = await sql("SELECT count(*)::int AS count FROM generation_job WHERE workspace_id = $1", [workspace]);
  return rows[0].count;
}

async function jobLedger(jobId) {
  const jobs = await sql(
    `SELECT id, kind, state, error_code, error_message, source_shot_revision_id, input_snapshot, retry_count
       FROM generation_job WHERE id = $1`,
    [jobId],
  );
  const attempts = await sql(
    `SELECT attempt_no, provider_request_id FROM job_attempt
      WHERE generation_job_id = $1 ORDER BY attempt_no`,
    [jobId],
  );
  const assets = await sql(
    `SELECT id, kind, storage_provider, object_key, mime_type, byte_size::text, checksum_sha256,
            width, height, duration_ms::text, status, review_status, source_shot_revision_id,
            source_generation_job_id, provider_request_id
       FROM asset WHERE source_generation_job_id = $1 ORDER BY created_at`,
    [jobId],
  );
  const costs = await sql(
    `SELECT kind, currency, amount_decimal::text, basis, unit_type, provider_request_id,
            job_attempt_id, supersedes_cost_id, supersedes_estimate_key
       FROM cost_ledger WHERE generation_job_id = $1`,
    [jobId],
  );
  return { job: jobs[0] ?? null, attempts, assets, costs };
}

function assertLedger(ledger, kind, revisionId, sourceText, mimeType, bytes, sha, duration, width) {
  if (!ledger.job || ledger.job.kind !== kind || ledger.job.state !== "SUCCEEDED") {
    throw new Error(`job ledger mismatch ${JSON.stringify(ledger.job)}`);
  }
  if (ledger.attempts.length !== 1 || ledger.attempts[0].attempt_no !== 1) {
    throw new Error(`attempt mismatch ${JSON.stringify(ledger.attempts)}`);
  }
  const capability = kind === "MEDIA_VIDEO" ? "video.generate" : "audio.tts";
  const requestId = `mock-media|sync|${capability}|${ledger.job.id}:1`;
  if (ledger.attempts[0].provider_request_id !== requestId) {
    throw new Error(`provider request ${ledger.attempts[0].provider_request_id}`);
  }
  if (String(ledger.job.source_shot_revision_id) !== revisionId) {
    throw new Error("source revision mismatch");
  }
  const snapshot = ledger.job.input_snapshot;
  if (snapshot?.sourceText !== sourceText || snapshot?.executionMode !== "sync" || snapshot?.outcome !== "success") {
    throw new Error(`snapshot mismatch ${JSON.stringify(snapshot)}`);
  }
  if (ledger.assets.length !== 1 || ledger.costs.length !== 1) {
    throw new Error(`expected one asset and one cost, got ${ledger.assets.length}/${ledger.costs.length}`);
  }
  const asset = ledger.assets[0];
  if (asset.mime_type !== mimeType || asset.byte_size !== String(bytes) || asset.checksum_sha256 !== sha) {
    throw new Error(`asset bytes mismatch ${JSON.stringify(asset)}`);
  }
  if (asset.duration_ms !== String(duration) || asset.storage_provider !== "mock-object-store") {
    throw new Error(`asset metadata mismatch ${JSON.stringify(asset)}`);
  }
  if (asset.review_status !== "DRAFT" || asset.status !== "ACTIVE") {
    throw new Error(`asset status mismatch ${asset.review_status}/${asset.status}`);
  }
  if (String(asset.source_shot_revision_id) !== revisionId || asset.provider_request_id !== requestId) {
    throw new Error("asset lineage mismatch");
  }
  if (width === null) {
    if (asset.width !== null || asset.height !== null) throw new Error("audio dimensions are not empty");
  } else if (asset.width !== width || asset.height !== width) {
    throw new Error(`dimensions ${asset.width}x${asset.height}`);
  }
  const cost = ledger.costs[0];
  if (cost.kind !== "ACTUAL" || cost.currency !== "USD" || Number(cost.amount_decimal) !== 0) {
    throw new Error(`cost mismatch ${JSON.stringify(cost)}`);
  }
  if (cost.basis !== "PROVIDER_REPORTED" || cost.unit_type !== "request" || cost.supersedes_estimate_key !== null) {
    throw new Error(`cost basis mismatch ${JSON.stringify(cost)}`);
  }
  if (!asset.object_key.startsWith(kind === "MEDIA_VIDEO" ? "mock-videos/" : "mock-audio/")) {
    throw new Error(`object key ${asset.object_key}`);
  }
  return { requestId, assetId: asset.id };
}

async function pollJob(jobId, timeoutMs, terminal = ["SUCCEEDED", "FAILED", "CANCELED"]) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = expectStatus(await callApi(apiOrigin, "GET", `/generation-jobs/${jobId}`), 200).body;
    if (terminal.includes(last.state)) return last;
    await sleep(1000);
  }
  throw new Error(`job ${jobId} stayed ${last?.state ?? "unknown"} past ${timeoutMs}ms`);
}

async function waitHttp(url, accept, timeoutMs) {
  const started = Date.now();
  let last = "no response";
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      const text = await response.text();
      let body = null;
      try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
      if (accept(response.status, body)) return body;
      last = `${response.status} ${JSON.stringify(body).slice(0, 300)}`;
    } catch (error) {
      last = error instanceof Error ? error.name : "error";
    }
    await sleep(1000);
  }
  throw new Error(`timeout ${url}: ${last}`);
}

function listFiles(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(relative(dir, full).replaceAll("\\", "/"));
    }
  };
  walk(dir);
  return files.sort();
}

async function countMinio() {
  const require = createRequire(resolve(repo, "apps/api/package.json"));
  const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
  const client = new S3Client({
    region: "us-east-1",
    endpoint: s3Endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: minioUser, secretAccessKey: minioPassword },
  });
  let count = 0;
  let token;
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      ContinuationToken: token,
    }));
    count += page.KeyCount ?? 0;
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return count;
}

async function breakMockDir() {
  const bak = `${mockDir}.bak`;
  await rename(mockDir, bak);
  await writeFile(mockDir, "not-a-directory\n");
  state.bak = bak;
  return bak;
}

async function restoreMockDir() {
  const bak = state.bak;
  if (!bak || !existsSync(bak)) {
    state.bak = null;
    return;
  }
  await rm(mockDir, { force: true });
  await rename(bak, mockDir);
  state.bak = null;
}

async function stage(name, fn) {
  if (pending[0] !== name) throw new Error(`stage order expected ${pending[0]}, called ${name}`);
  pending.shift();
  const started = Date.now();
  try {
    const detail = await fn();
    stages.push({ name, status: "passed", ms: Date.now() - started, detail: detail ?? null });
    return detail;
  } catch (error) {
    const status = error && error.status === "blocked" ? "blocked" : "failed";
    stages.push({
      name,
      status,
      ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function toolVersion(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", timeout: 15_000 }).trim();
  } catch (error) {
    return error instanceof Error ? error.message : "unavailable";
  }
}

async function main() {
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(mockDir, { recursive: true });
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  state.evidence.meta = {
    githubRunId: process.env.GITHUB_RUN_ID ?? null,
    githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    githubSha: process.env.GITHUB_SHA ?? null,
    sourceSha,
    node: process.version,
    pnpm: toolVersion("pnpm", ["-v"]),
    docker: toolVersion("docker", ["--version"]),
    compose: toolVersion("docker", ["compose", "version"]),
    workspaceId,
    otherWorkspaceId,
    database: dbName,
    bucket,
    composeProject: project,
  };

  await stage("docker", async () => {
    const dockerConfigDir = join(tempRoot, `m3-av-docker-${runToken}`);
    mkdirSync(dockerConfigDir, { recursive: true });
    writeFileSync(join(dockerConfigDir, "config.json"), "{}\n");
    process.env.DOCKER_CONFIG = dockerConfigDir;
    delete process.env.DOCKER_AUTH_CONFIG;
    try {
      await run("docker", ["info"], { timeoutMs: 30_000 });
    } catch (error) {
      const blocked = new Error(`Docker is not available, so real services were not started. ${error instanceof Error ? error.message : ""}`);
      blocked.status = "blocked";
      throw blocked;
    }
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)) throw new Error(`refusing compose project ${project}`);
    return { project, dockerConfig: "empty anonymous config" };
  });

  await stage("compose", async () => {
    writeFileSync(envFile, [
      `POSTGRES_USER=${dbUser}`,
      `POSTGRES_PASSWORD=${dbPassword}`,
      `POSTGRES_DB=${dbName}`,
      `POSTGRES_PORT=${postgresPort}`,
      `REDIS_PORT=${redisPort}`,
      `MINIO_ROOT_USER=${minioUser}`,
      `MINIO_ROOT_PASSWORD=${minioPassword}`,
      `S3_API_PORT=${s3Port}`,
      "S3_CONSOLE_PORT=59001",
      `S3_BUCKET=${bucket}`,
      "",
    ].join("\n"));
    state.composeStarted = true;
    const mirrors = [
      ["minio/minio:RELEASE.2025-09-07T16-13-09Z", "quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z"],
      ["minio/mc:RELEASE.2025-08-13T08-35-41Z", "quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z"],
    ];
    for (const [source, target] of mirrors) {
      await run("docker", ["pull", source], { timeoutMs: 180_000 });
      await run("docker", ["tag", source, target]);
    }
    await run("docker", [
      "compose", "-p", project, "-f", composeFile, "--env-file", envFile,
      "up", "--pull", "missing", "-d", "postgres", "redis", "minio", "minio-init",
    ], { timeoutMs: 180_000 });
    const started = Date.now();
    let ready = false;
    let last = "";
    while (Date.now() - started < 120_000) {
      const ps = await run("docker", [
        "compose", "-p", project, "-f", composeFile, "--env-file", envFile, "ps", "-a", "--format", "json",
      ], { allowFail: true });
      last = ps.stdout;
      const trimmed = ps.stdout.trim();
      let rows = [];
      try {
        rows = trimmed.startsWith("[")
          ? JSON.parse(trimmed)
          : trimmed.split(/\r?\n/).filter(Boolean).flatMap((line) => {
            const parsed = JSON.parse(line);
            return Array.isArray(parsed) ? parsed : [parsed];
          });
      } catch {
        rows = [];
      }
      const byName = (service) => rows.find((row) => row.Service === service);
      const healthy = (service) => byName(service)?.Health === "healthy";
      const init = byName("minio-init");
      const initDone = init?.State === "exited" && Number(init.ExitCode) === 0;
      if (healthy("postgres") && healthy("redis") && healthy("minio") && initDone) {
        ready = true;
        break;
      }
      await sleep(2000);
    }
    if (!ready) throw new Error(`compose did not become healthy\n${last.slice(-2000)}`);
    const images = [];
    for (const image of [
      "postgres:16.15-alpine",
      "redis:7.4.11-alpine",
      "quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z",
      "quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z",
    ]) {
      const inspected = await run("docker", [
        "image", "inspect", image, "--format", "{{.Id}} {{json .RepoDigests}}",
      ]);
      images.push({ image, inspect: inspected.stdout.trim() });
    }
    state.evidence.minioBefore = await countMinio();
    return {
      images,
      minioObjects: state.evidence.minioBefore,
      minioMirror: "Docker Hub release tags retagged to the compose quay.io names after quay.io rejected anonymous pulls",
    };
  });

  await stage("identity", async () => {
    const url = new URL(databaseUrl);
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      throw new Error(`refusing non-loopback database host ${url.hostname}`);
    }
    if (url.pathname !== `/${dbName}`) throw new Error(`refusing unexpected database ${url.pathname}`);
    state.db = await connectDb();
    const rows = await sql(
      `SELECT current_database() AS database, current_user AS role,
              inet_server_addr()::text AS server_addr, inet_server_port() AS server_port,
              (SELECT count(*)::int FROM information_schema.tables
                WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS public_tables`,
    );
    const identity = rows[0];
    if (identity.database !== dbName || identity.role !== dbUser || identity.public_tables !== 0) {
      throw new Error(`refusing database identity ${JSON.stringify(identity)}`);
    }
    state.evidence.identity = identity;
    return identity;
  });

  await stage("migrate-provision", async () => {
    const env = appEnv();
    const migrated = await run("pnpm", ["--filter", "@ai-drama/database", "migrate"], { env, timeoutMs: 180_000 });
    const workspace = await run("pnpm", ["--filter", "@ai-drama/database", "workspace:provision"], { env });
    const image = await run("pnpm", ["--filter", "@ai-drama/database", "mock-media:provision"], { env });
    const first = await run("pnpm", ["--filter", "@ai-drama/database", "mock-av:provision"], { env });
    const second = await run("pnpm", ["--filter", "@ai-drama/database", "mock-av:provision"], { env });
    if (!first.stdout.includes("created") || !second.stdout.includes("already present")) {
      throw new Error(`mock-av provision was not idempotent\n${first.stdout}\n${second.stdout}`);
    }
    const capabilities = await sql(
      `SELECT capability, enabled, encrypted_credential_ref IS NULL AS no_credential, count(*)::int AS count
         FROM provider_configuration
        WHERE workspace_id = $1 AND provider_key = 'mock-media'
        GROUP BY capability, enabled, encrypted_credential_ref
        ORDER BY capability`,
      [workspaceId],
    );
    const expected = ["audio.tts", "image.generate", "video.generate"];
    if (capabilities.length !== 3 || capabilities.some((row, index) =>
      row.capability !== expected[index] || row.enabled !== true || row.no_credential !== true || row.count !== 1)) {
      throw new Error(`provider capability mismatch ${JSON.stringify(capabilities)}`);
    }
    const workspaceRow = await sql("SELECT status FROM workspace WHERE id = $1", [workspaceId]);
    if (workspaceRow[0]?.status !== "ACTIVE") throw new Error("workspace is not ACTIVE");
    return {
      migrated: migrated.stdout.trim(),
      workspace: workspace.stdout.trim(),
      image: image.stdout.trim(),
      first: first.stdout.trim(),
      second: second.stdout.trim(),
      capabilities,
    };
  });

  await stage("processes", async () => {
    spawnApp("api", ["pnpm", "--filter", "@ai-drama/api", "start"], appEnv());
    const apiReady = await waitHttp(`${apiOrigin}/api/v1/health/ready`, (status, body) =>
      status === 200 && body?.status === "ok"
      && body.dependencies?.postgres?.status === "ok"
      && body.dependencies?.redis?.status === "ok"
      && body.dependencies?.objectStorage?.status === "ok", 60_000);
    spawnApp("worker", ["pnpm", "--filter", "@ai-drama/worker", "start"], appEnv());
    const workerReady = await waitHttp(`${workerOrigin}/health/ready`, (status, body) =>
      status === 200 && body?.status === "ok"
      && body.dependencies?.postgres?.status === "ok"
      && body.dependencies?.redis?.status === "ok"
      && body.dependencies?.queue?.status === "ok", 60_000);
    spawnApp("web", ["pnpm", "--filter", "@ai-drama/web", "start"], appEnv({ NODE_ENV: "production" }));
    await waitHttp(webOrigin, (status) => status === 200, 60_000);
    return { apiReady, workerReady };
  });

  await stage("source-chain", async () => {
    const project = expectStatus(await callApi(apiOrigin, "POST", "/projects", {
      body: { title: "M3 AV E2E", premise: "isolated acceptance" },
    }), 201).body;
    const story = expectStatus(await callApi(apiOrigin, "POST", `/projects/${project.id}/stories`, {
      ifMatch: project.version,
      body: { content: { schema: "m2.story.revision.v1", premise: "approved source for mock av" } },
    }), 201).body;
    const storyReview = await approve(apiOrigin, `/projects/${project.id}/stories/${story.revisionId}/review`, story.rowVersion);
    state.world = { projectId: project.id, storyRevisionId: story.revisionId };
    const episode = await episodeOne();
    if (episode.episodeNo !== 1) throw new Error("story approval did not create episode 1");
    const script = expectStatus(await callApi(apiOrigin, "POST", `/projects/${project.id}/episodes/${episode.id}/scripts`, {
      ifMatch: episode.rowVersion,
      body: {
        storyRevisionId: story.revisionId,
        content: { schema: "m2.script.revision.v1", episode: 1, scenes: [] },
      },
    }), 201).body;
    await approve(apiOrigin, `/projects/${project.id}/episodes/${episode.id}/scripts/${script.revisionId}/review`, script.rowVersion);
    const versionForCharacter = await projectVersion();
    const character = expectStatus(await callApi(apiOrigin, "POST", `/projects/${project.id}/characters`, {
      ifMatch: versionForCharacter,
      body: { name: "Lead", sourceScriptRevisionId: script.revisionId, content: { role: "lead" } },
    }), 201).body;
    await approve(apiOrigin, `/projects/${project.id}/characters/${character.entityId}/revisions/${character.revisionId}/review`, character.rowVersion);
    const location = expectStatus(await callApi(apiOrigin, "POST", `/projects/${project.id}/locations`, {
      ifMatch: await projectVersion(),
      body: { name: "Room", sourceScriptRevisionId: script.revisionId, content: { kind: "room" } },
    }), 201).body;
    await approve(apiOrigin, `/projects/${project.id}/locations/${location.entityId}/revisions/${location.revisionId}/review`, location.rowVersion);
    const episodeAfterScript = await episodeOne();
    const scene = expectStatus(await callApi(apiOrigin, "POST", `/projects/${project.id}/episodes/${episode.id}/scenes`, {
      ifMatch: episodeAfterScript.rowVersion,
      body: {
        sourceScriptRevisionId: script.revisionId,
        ordinal: 1,
        heading: "INT. ROOM",
        summary: "A quiet room",
      },
    }), 201).body;
    const sceneApproved = await approve(
      apiOrigin,
      `/projects/${project.id}/episodes/${episode.id}/scenes/${scene.entityId}/revisions/${scene.revisionId}/review`,
      scene.rowVersion,
    );
    state.world = {
      ...state.world,
      episodeId: episode.id,
      scriptRevisionId: script.revisionId,
      sceneId: scene.entityId,
      sceneRevisionId: scene.revisionId,
    };
    const shot = await createApprovedShot(1, "wait", promptText, dialogueText);
    const history = expectStatus(await callApi(
      apiOrigin, "GET",
      `/projects/${project.id}/episodes/${episode.id}/scenes/${scene.entityId}/shots/${shot.shotId}/revisions`,
    ), 200).body;
    if (history.aggregate.currentRevisionId !== shot.revisionId || history.aggregate.approvedRevisionId !== shot.revisionId) {
      throw new Error(`shot is not current approved ${JSON.stringify(history.aggregate)}`);
    }
    state.world = { ...state.world, shotId: shot.shotId, shotRevisionId: shot.revisionId, storyReview };
    return {
      projectId: project.id,
      storyRevisionId: story.revisionId,
      episodeId: episode.id,
      scriptRevisionId: script.revisionId,
      sceneRevisionId: scene.revisionId,
      shotRevisionId: shot.revisionId,
      sceneApprovedVersion: sceneApproved.rowVersion,
    };
  });

  await stage("page-submit", async () => {
    const playwright = createRequire(resolve(repo, "package.json"))("playwright");
    const { chromium } = playwright;
    state.browser = await chromium.launch({
      channel: "chrome",
      headless: true,
      args: ["--disable-dev-shm-usage"],
    });
    const version = state.browser.version();
    state.evidence.chrome = version;
    const context = await state.browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    state.page = page;
    page.on("console", (message) => {
      state.consoleEvents.push({ type: message.type(), text: message.text().slice(0, 500) });
    });
    page.on("pageerror", (error) => {
      state.consoleEvents.push({ type: "pageerror", text: String(error).slice(0, 500) });
    });
    page.on("request", (request) => {
      if (!request.url().includes("/assets/") || !request.url().includes("/content")) return;
      state.contentRequests.push({
        url: request.url(),
        method: request.method(),
        range: request.headers().range ?? null,
        ifRange: request.headers()["if-range"] ?? null,
      });
    });
    page.on("response", async (response) => {
      const request = response.request();
      if (request.method() !== "POST" || !response.url().includes("/generate-")) return;
      let body = null;
      try { body = await response.json(); } catch { body = null; }
      state.posts.push({
        url: response.url(),
        sameOrigin: response.url().startsWith(webOrigin),
        status: response.status(),
        body,
      });
    });
    const shotUrl = `${webOrigin}/projects/${state.world.projectId}?focus=shot&episode=1&scene=${state.world.sceneId}&shot=${state.world.shotId}`;
    await page.goto(shotUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const videoButton = page.getByRole("button", { name: "生成 Mock 视频", exact: true });
    await videoButton.waitFor({ timeout: 30_000 });
    await page.locator("#shot-action").fill(draftMarker);
    await videoButton.click({ timeout: 30_000 });
    await page.getByText("已受理，结果以任务和视频列表为准。这不是生成成功。").waitFor({ timeout: 20_000 });
    await page.getByRole("button", { name: "生成 Mock 配音", exact: true }).click({ timeout: 30_000 });
    await page.getByText("已受理，结果以任务和配音列表为准。这不是生成成功。").waitFor({ timeout: 20_000 });
    const videoPost = state.posts.find((post) => post.url.includes("generate-video"));
    const speechPost = state.posts.find((post) => post.url.includes("generate-tts"));
    if (!videoPost || !speechPost || videoPost.status !== 202 || speechPost.status !== 202) {
      throw new Error(`missing same-origin 202 ${JSON.stringify(state.posts)}`);
    }
    if (!videoPost.sameOrigin || !speechPost.sameOrigin || !videoPost.body?.jobId || !speechPost.body?.workflowRunId) {
      throw new Error(`acceptance posts were not same-origin jobs ${JSON.stringify(state.posts)}`);
    }
    const videoJob = await pollJob(videoPost.body.jobId, 90_000);
    const speechJob = await pollJob(speechPost.body.jobId, 90_000);
    if (videoJob.state !== "SUCCEEDED" || speechJob.state !== "SUCCEEDED") {
      throw new Error(`terminal state video ${videoJob.state} speech ${speechJob.state}`);
    }
    const videoLedger = await jobLedger(videoPost.body.jobId);
    const speechLedger = await jobLedger(speechPost.body.jobId);
    const video = assertLedger(videoLedger, "MEDIA_VIDEO", state.world.shotRevisionId, promptText, "video/mp4", 1552, videoSha, 1000, 16);
    const speech = assertLedger(speechLedger, "MEDIA_TTS", state.world.shotRevisionId, dialogueText, "audio/wav", 1644, audioSha, 100, null);
    state.world.video = { ...video, jobId: videoPost.body.jobId, workflowRunId: videoPost.body.workflowRunId };
    state.world.speech = { ...speech, jobId: speechPost.body.jobId, workflowRunId: speechPost.body.workflowRunId };
    await page.locator("video").first().waitFor({ state: "attached", timeout: 20_000 });
    await page.locator("audio").first().waitFor({ state: "attached", timeout: 20_000 });
    return {
      chrome: version,
      shotUrl,
      video: state.world.video,
      speech: state.world.speech,
    };
  });

  await stage("playback", async () => {
    const page = state.page;
    const video = page.locator("section").filter({ has: page.getByRole("heading", { name: "Mock 视频", exact: true }) }).locator("video").first();
    await video.click({ position: { x: 12, y: 12 }, force: true, timeout: 10_000 });
    const videoProof = await video.evaluate(async (element) => {
      const media = element;
      if (media.readyState < 1) {
        await new Promise((resolveMedia, rejectMedia) => {
          const timer = setTimeout(() => rejectMedia(new Error("video loadedmetadata timeout")), 15_000);
          media.addEventListener("loadedmetadata", () => { clearTimeout(timer); resolveMedia(); }, { once: true });
          media.addEventListener("error", () => {
            clearTimeout(timer);
            rejectMedia(new Error(media.error?.message ?? "video error"));
          }, { once: true });
        });
      }
      let decodedCallback = false;
      if (typeof media.requestVideoFrameCallback === "function") {
        media.requestVideoFrameCallback(() => { decodedCallback = true; });
      }
      const framesBefore = media.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
      await media.play();
      await new Promise((resolveMedia, rejectMedia) => {
        const timer = setTimeout(() => rejectMedia(new Error("video playback timeout")), 15_000);
        media.addEventListener("ended", () => { clearTimeout(timer); resolveMedia(); }, { once: true });
      });
      const quality = media.getVideoPlaybackQuality?.();
      return {
        videoWidth: media.videoWidth,
        videoHeight: media.videoHeight,
        duration: media.duration,
        currentTime: media.currentTime,
        ended: media.ended,
        decodedCallback,
        framesBefore,
        totalVideoFrames: quality?.totalVideoFrames ?? null,
      };
    });
    if (videoProof.videoWidth !== 16 || videoProof.videoHeight !== 16) {
      throw new Error(`video dimensions ${videoProof.videoWidth}x${videoProof.videoHeight}`);
    }
    if (videoProof.duration < 0.8 || videoProof.duration > 1.2) throw new Error(`video duration ${videoProof.duration}`);
    const decoded = videoProof.decodedCallback || (videoProof.totalVideoFrames ?? 0) > videoProof.framesBefore;
    if (!decoded || (!videoProof.ended && videoProof.currentTime <= 0)) {
      throw new Error(`video did not decode and finish ${JSON.stringify(videoProof)}`);
    }
    const audio = page.locator("section").filter({ has: page.getByRole("heading", { name: "Mock 配音", exact: true }) }).locator("audio").first();
    await audio.click({ position: { x: 16, y: 12 }, force: true, timeout: 10_000 });
    const audioProof = await audio.evaluate(async (element) => {
      const media = element;
      if (media.readyState < 1) {
        await new Promise((resolveMedia, rejectMedia) => {
          const timer = setTimeout(() => rejectMedia(new Error("audio loadedmetadata timeout")), 15_000);
          media.addEventListener("loadedmetadata", () => { clearTimeout(timer); resolveMedia(); }, { once: true });
          media.addEventListener("error", () => {
            clearTimeout(timer);
            rejectMedia(new Error(media.error?.message ?? "audio error"));
          }, { once: true });
        });
      }
      const duration = media.duration;
      await media.play();
      await new Promise((resolveMedia, rejectMedia) => {
        const timer = setTimeout(() => rejectMedia(new Error("audio playback timeout")), 15_000);
        media.addEventListener("ended", () => { clearTimeout(timer); resolveMedia(); }, { once: true });
      });
      return { duration, currentTime: media.currentTime, ended: media.ended, paused: media.paused };
    });
    if (audioProof.duration < 0.08 || audioProof.duration > 0.15) throw new Error(`audio duration ${audioProof.duration}`);
    if (!audioProof.ended && audioProof.currentTime <= 0) throw new Error(`audio did not advance ${JSON.stringify(audioProof)}`);
    await page.screenshot({ path: join(outputDir, "playback.png"), fullPage: true });
    state.evidence.playback = { videoProof, audioProof, contentRequests: state.contentRequests };
    return { videoProof, audioProof, browserRangeRequests: state.contentRequests };
  });

  await stage("content-headers", async () => {
    async function readContent(assetId, expectedType, expectedBytes, expectedSha) {
      const url = `${webOrigin}/api/v1/assets/${assetId}/content`;
      const full = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      const bytes = Buffer.from(await full.arrayBuffer());
      const sha = createHash("sha256").update(bytes).digest("hex");
      if (full.status !== 200 || bytes.length !== expectedBytes || sha !== expectedSha) {
        throw new Error(`GET ${assetId} status ${full.status} bytes ${bytes.length} sha ${sha}`);
      }
      if (!full.headers.get("content-type")?.includes(expectedType)) {
        throw new Error(`GET content-type ${full.headers.get("content-type")}`);
      }
      const head = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
      const headBytes = Buffer.from(await head.arrayBuffer());
      if (head.status !== 200 || headBytes.length !== 0) throw new Error(`HEAD ${head.status} body ${headBytes.length}`);
      if (!head.headers.get("content-type")?.includes(expectedType) || head.headers.get("content-length") !== String(expectedBytes)) {
        throw new Error(`HEAD headers type ${head.headers.get("content-type")} length ${head.headers.get("content-length")}`);
      }
      const ranged = await fetch(url, {
        headers: { range: "bytes=0-10", "if-range": "\"m3-av-e2e\"" },
        signal: AbortSignal.timeout(15_000),
      });
      const rangedBytes = Buffer.from(await ranged.arrayBuffer());
      if (ranged.status !== 200 || rangedBytes.length !== expectedBytes) {
        throw new Error(`Range was not ignored: ${ranged.status} ${rangedBytes.length}`);
      }
      return { sha, bytes: bytes.length, head: head.status, range: ranged.status };
    }
    const video = await readContent(state.world.video.assetId, "video/mp4", 1552, videoSha);
    const audio = await readContent(state.world.speech.assetId, "audio/wav", 1644, audioSha);
    return { video, audio, browserRangeRequests: state.contentRequests };
  });

  await stage("png-draft-viewport", async () => {
    const page = state.page;
    const action = await page.locator("#shot-action").inputValue();
    if (action !== draftMarker) throw new Error(`unsaved draft was overwritten: ${action}`);
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await page.evaluate(() => {
      const hashes = [...document.querySelectorAll("p.break-all")].map((element) => ({
        length: element.textContent?.length ?? 0,
        overflow: element.scrollWidth - element.clientWidth,
      }));
      return {
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
        hashes,
      };
    });
    if (overflow.documentOverflow > 1 || overflow.bodyOverflow > 1) {
      throw new Error(`390px overflow ${JSON.stringify(overflow)}`);
    }
    if (overflow.hashes.length < 2 || overflow.hashes.some((item) => item.length < 64 || item.overflow > 1)) {
      throw new Error(`hash wrap failed ${JSON.stringify(overflow.hashes)}`);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: "生成 Mock 图片", exact: true }).click({ timeout: 30_000 });
    await page.getByText("已受理，结果以任务和图片列表为准。这不是生成成功。").waitFor({ timeout: 20_000 });
    const imagePost = state.posts.find((post) => post.url.includes("generate-image"));
    if (!imagePost || imagePost.status !== 202 || !imagePost.sameOrigin) {
      throw new Error(`image post missing ${JSON.stringify(state.posts)}`);
    }
    const imageJob = await pollJob(imagePost.body.jobId, 90_000);
    if (imageJob.state !== "SUCCEEDED") throw new Error(`image job ${imageJob.state}`);
    const image = page.locator("img").first();
    await image.waitFor({ state: "attached", timeout: 20_000 });
    const decoded = await image.evaluate(async (element) => {
      const picture = element;
      if (!picture.complete || picture.naturalWidth === 0) {
        await new Promise((resolveImage, rejectImage) => {
          const timer = setTimeout(() => rejectImage(new Error("png decode timeout")), 15_000);
          picture.addEventListener("load", () => { clearTimeout(timer); resolveImage(); }, { once: true });
          picture.addEventListener("error", () => { clearTimeout(timer); rejectImage(new Error("png error")); }, { once: true });
        });
      }
      return { naturalWidth: picture.naturalWidth, naturalHeight: picture.naturalHeight };
    });
    if (decoded.naturalWidth !== 1 || decoded.naturalHeight !== 1) {
      throw new Error(`png decoded ${decoded.naturalWidth}x${decoded.naturalHeight}`);
    }
    const src = await image.getAttribute("src");
    const pngResponse = await fetch(`${webOrigin}${src}`, { signal: AbortSignal.timeout(15_000) });
    const pngBytes = Buffer.from(await pngResponse.arrayBuffer());
    if (pngResponse.status !== 200 || pngBytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
      throw new Error(`png signature failed ${pngResponse.status}`);
    }
    await page.screenshot({ path: join(outputDir, "viewport-and-png.png"), fullPage: true });
    return { draft: action, overflow, decoded, imageJobId: imagePost.body.jobId };
  });

  await stage("idempotency-retry", async () => {
    const beforeJobs = await jobCount();
    const beforeAssets = (await sql("SELECT count(*)::int AS count FROM asset WHERE workspace_id = $1", [workspaceId]))[0].count;
    const beforeCosts = (await sql("SELECT count(*)::int AS count FROM cost_ledger WHERE workspace_id = $1", [workspaceId]))[0].count;
    const key = randomUUID();
    const path = `/shot-revisions/${state.world.shotRevisionId}/generate-video`;
    const first = expectStatus(await callApi(apiOrigin, "POST", path, { key, body: { seed: "same-seed" } }), 202);
    const done = await pollJob(first.body.jobId, 90_000);
    if (done.state !== "SUCCEEDED") throw new Error(`idempotent job ${done.state}`);
    const replay = expectStatus(await callApi(apiOrigin, "POST", path, { key, body: { seed: "same-seed" } }), 202);
    if (replay.body.jobId !== first.body.jobId || replay.body.workflowRunId !== first.body.workflowRunId) {
      throw new Error("replay did not return the original workflow");
    }
    const conflict = expectStatus(await callApi(apiOrigin, "POST", path, {
      key, body: { seed: "changed-seed" },
    }), 409, "IDEMPOTENCY_KEY_REUSED");
    const midAssets = (await sql("SELECT count(*)::int AS count FROM asset WHERE workspace_id = $1", [workspaceId]))[0].count;
    const midCosts = (await sql("SELECT count(*)::int AS count FROM cost_ledger WHERE workspace_id = $1", [workspaceId]))[0].count;
    if (midAssets !== beforeAssets + 1 || midCosts !== beforeCosts + 1) {
      throw new Error(`replay changed asset/cost counts ${midAssets}/${midCosts}`);
    }
    const fresh = expectStatus(await callApi(apiOrigin, "POST", path, { body: { seed: "same-seed" } }), 202);
    if (fresh.body.jobId === first.body.jobId) throw new Error("new key reused the original job");
    const freshDone = await pollJob(fresh.body.jobId, 90_000);
    if (freshDone.state !== "SUCCEEDED") throw new Error(`new key job ${freshDone.state}`);
    const retry = expectStatus(await callApi(apiOrigin, "POST", `/generation-jobs/${state.world.video.jobId}/retry`, {
      body: {},
    }), 409, "JOB_NOT_RETRYABLE");
    const afterRetry = await jobLedger(state.world.video.jobId);
    if (afterRetry.attempts.length !== 1) throw new Error("manual retry created an attempt");
    if (await jobCount() < beforeJobs) throw new Error("job count went backwards");
    void conflict;
    void retry;
    return { originalJobId: first.body.jobId, newJobId: fresh.body.jobId };
  });

  await stage("revision-history", async () => {
    const aggregate = expectStatus(await callApi(
      apiOrigin, "GET",
      `/projects/${state.world.projectId}/episodes/${state.world.episodeId}/scenes/${state.world.sceneId}/shots/${state.world.shotId}/revisions`,
    ), 200).body.aggregate;
    const created = expectStatus(await callApi(
      apiOrigin, "POST",
      `/projects/${state.world.projectId}/episodes/${state.world.episodeId}/scenes/${state.world.sceneId}/shots/${state.world.shotId}/revisions`,
      {
        ifMatch: aggregate.rowVersion,
        body: shotPayload(state.world.sceneRevisionId, 1, "saved-revision-two", promptText, dialogueText),
      },
    ), 201);
    await approve(
      apiOrigin,
      `/projects/${state.world.projectId}/episodes/${state.world.episodeId}/scenes/${state.world.sceneId}/shots/${state.world.shotId}/revisions/${created.body.revisionId}/review`,
      created.body.rowVersion,
    );
    state.world.previousRevisionId = state.world.shotRevisionId;
    state.world.shotRevisionId = created.body.revisionId;
    await state.page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    const history = state.page.getByRole("heading", { name: "历史版本视频" }).locator("xpath=..");
    await history.getByText(state.world.video.assetId).waitFor({ timeout: 20_000 });
    const currentText = await state.page.getByRole("heading", { name: "当前版本视频" }).locator("xpath=..").innerText();
    if (currentText.includes(state.world.video.assetId)) throw new Error("old video asset is still in the current region");
    await state.page.getByRole("button", { name: "生成 Mock 视频", exact: true }).click({ timeout: 30_000 });
    await state.page.getByText("已受理，结果以任务和视频列表为准。这不是生成成功。").waitFor({ timeout: 20_000 });
    const post = [...state.posts].reverse().find((item) => item.url.includes("generate-video") && item.body?.jobId !== state.world.video.jobId);
    if (!post || post.status !== 202) throw new Error("new revision video was not accepted");
    const job = await pollJob(post.body.jobId, 90_000);
    if (job.state !== "SUCCEEDED") throw new Error(`new revision video ${job.state}`);
    const ledger = await jobLedger(post.body.jobId);
    const current = assertLedger(ledger, "MEDIA_VIDEO", state.world.shotRevisionId, promptText, "video/mp4", 1552, videoSha, 1000, 16);
    const currentRegion = state.page.getByRole("heading", { name: "当前版本视频" }).locator("xpath=..");
    await currentRegion.getByText(state.world.shotRevisionId).waitFor({ timeout: 20_000 });
    const currentAfter = await currentRegion.innerText();
    const historyText = await history.innerText();
    if (!historyText.includes(state.world.previousRevisionId) || !historyText.includes(state.world.video.assetId)) {
      throw new Error("history does not keep the old source");
    }
    if (currentAfter.includes(state.world.video.assetId) || !currentAfter.includes(current.assetId)) {
      throw new Error("current region does not match the new source asset");
    }
    return { previousRevisionId: state.world.previousRevisionId, currentRevisionId: state.world.shotRevisionId, currentAssetId: current.assetId };
  });

  await stage("gates", async () => {
    const before = await jobCount();
    const old = expectStatus(await callApi(apiOrigin, "POST", `/shot-revisions/${state.world.previousRevisionId}/generate-video`, {
      body: { seed: "old-revision" },
    }), 400, "REVIEW_REQUIRED");
    const draftCreated = expectStatus(await callApi(
      apiOrigin, "POST",
      `/projects/${state.world.projectId}/episodes/${state.world.episodeId}/scenes/${state.world.sceneId}/shots`,
      {
        ifMatch: expectStatus(await callApi(apiOrigin, "GET", `/projects/${state.world.projectId}/episodes/${state.world.episodeId}/scenes/${state.world.sceneId}/revisions`), 200).body.aggregate.rowVersion,
        body: shotPayload(state.world.sceneRevisionId, 2, "draft", promptText, dialogueText),
      },
    ), 201);
    const draft = expectStatus(await callApi(apiOrigin, "POST", `/shot-revisions/${draftCreated.body.revisionId}/generate-video`, {
      body: {},
    }), 400, "REVIEW_REQUIRED");
    const emptyPrompt = await createApprovedShot(3, "empty-prompt", "", dialogueText);
    const promptGate = expectStatus(await callApi(apiOrigin, "POST", `/shot-revisions/${emptyPrompt.revisionId}/generate-video`, {
      body: {},
    }), 400, "VALIDATION_ERROR");
    const emptyDialogue = await createApprovedShot(4, "empty-dialogue", promptText, null);
    const dialogueGate = expectStatus(await callApi(apiOrigin, "POST", `/shot-revisions/${emptyDialogue.revisionId}/generate-tts`, {
      body: {},
    }), 400, "VALIDATION_ERROR");
    await run("pnpm", ["--filter", "@ai-drama/database", "workspace:provision"], {
      env: appEnv({ APP_WORKSPACE_ID: otherWorkspaceId, APP_WORKSPACE_NAME: "M3 AV E2E other" }),
    });
    spawnApp("api-other", ["pnpm", "--filter", "@ai-drama/api", "start"], appEnv({
      APP_WORKSPACE_ID: otherWorkspaceId,
      API_PORT: "3011",
    }));
    spawnApp("api-off", ["pnpm", "--filter", "@ai-drama/api", "start"], appEnv({
      API_PORT: "3012",
      M3_MOCK_AV_ENABLED: "false",
      M3_MOCK_IMAGE_ENABLED: "false",
    }));
    spawnApp("api-prod", ["pnpm", "--filter", "@ai-drama/api", "start"], appEnv({
      API_PORT: "3013",
      NODE_ENV: "production",
      M3_MOCK_AV_ENABLED: "true",
      M3_MOCK_IMAGE_ENABLED: "true",
    }));
    await waitHttp("http://127.0.0.1:3011/api/v1/health/ready", (status, body) => status === 200 && body?.dependencies?.postgres?.status === "ok", 60_000);
    await waitHttp("http://127.0.0.1:3012/api/v1/health/ready", (status, body) => status === 200 && body?.dependencies?.postgres?.status === "ok", 60_000);
    await waitHttp("http://127.0.0.1:3013/api/v1/health/ready", (status, body) => status === 200 && body?.dependencies?.postgres?.status === "ok", 60_000);
    const wrong = expectStatus(await callApi("http://127.0.0.1:3011", "POST", `/shot-revisions/${state.world.shotRevisionId}/generate-video`, {
      body: {},
    }), 404, "NOT_FOUND");
    const disabled = expectStatus(await callApi("http://127.0.0.1:3012", "POST", `/shot-revisions/${state.world.shotRevisionId}/generate-video`, {
      body: {},
    }), 400, "CONFIGURATION_ERROR");
    const production = expectStatus(await callApi("http://127.0.0.1:3013", "POST", `/shot-revisions/${state.world.shotRevisionId}/generate-video`, {
      body: {},
    }), 400, "CONFIGURATION_ERROR");
    const after = await jobCount();
    const otherJobs = await jobCount(otherWorkspaceId);
    if (after !== before || otherJobs !== 0) throw new Error(`gate created jobs ${before} -> ${after}, other ${otherJobs}`);
    await stopApp("api-other");
    await stopApp("api-off");
    await stopApp("api-prod");
    return {
      old: old.body.error.code,
      draft: draft.body.error.code,
      promptGate: promptGate.body.error.code,
      dialogueGate: dialogueGate.body.error.code,
      wrong: wrong.body.error.code,
      disabled: disabled.body.error.code,
      production: production.body.error.code,
    };
  });

  await stage("mock-boundary", async () => {
    const files = listFiles(mockDir);
    const minio = await countMinio();
    if (minio !== state.evidence.minioBefore) throw new Error(`MinIO object count changed ${state.evidence.minioBefore} -> ${minio}`);
    if (!files.some((file) => file.startsWith("mock-videos/")) || !files.some((file) => file.startsWith("mock-audio/"))) {
      throw new Error(`local mock objects missing ${files.join(",")}`);
    }
    if (!files.some((file) => file.startsWith("mock-images/"))) throw new Error("local png object missing");
    state.evidence.localObjects = files;
    return { minio, files: files.length };
  });

  await stage("recovery-disk", async () => {
    await breakMockDir();
    try {
      const accepted = expectStatus(await callApi(apiOrigin, "POST", `/shot-revisions/${state.world.shotRevisionId}/generate-video`, {
        body: { seed: "disk-failure" },
      }), 202);
      const started = Date.now();
      let attached = null;
      while (Date.now() - started < 30_000) {
        attached = (await jobLedger(accepted.body.jobId));
        if (attached.job?.state === "RUNNING" && attached.attempts[0]?.provider_request_id) break;
        if (attached.job?.state === "FAILED" || attached.job?.state === "SUCCEEDED") {
          throw new Error(`fault job did not stay RUNNING after attach: ${JSON.stringify(attached.job)}`);
        }
        await sleep(500);
      }
      if (attached?.job?.state !== "RUNNING" || !attached.attempts[0]?.provider_request_id) {
        throw new Error(`request was not attached ${JSON.stringify(attached)}`);
      }
      const requestId = attached.attempts[0].provider_request_id;
      const aggregate = expectStatus(await callApi(
        apiOrigin, "GET",
        `/projects/${state.world.projectId}/episodes/${state.world.episodeId}/scenes/${state.world.sceneId}/shots/${state.world.shotId}/revisions`,
      ), 200).body.aggregate;
      const created = expectStatus(await callApi(
        apiOrigin, "POST",
        `/projects/${state.world.projectId}/episodes/${state.world.episodeId}/scenes/${state.world.sceneId}/shots/${state.world.shotId}/revisions`,
        {
          ifMatch: aggregate.rowVersion,
          body: shotPayload(state.world.sceneRevisionId, 1, "source-changed-for-recovery", promptText, dialogueText),
        },
      ), 201);
      await approve(
        apiOrigin,
        `/projects/${state.world.projectId}/episodes/${state.world.episodeId}/scenes/${state.world.sceneId}/shots/${state.world.shotId}/revisions/${created.body.revisionId}/review`,
        created.body.rowVersion,
      );
      state.world.shotRevisionId = created.body.revisionId;
      await restoreMockDir();
      const failed = await pollJob(accepted.body.jobId, 100_000);
      const ledger = await jobLedger(accepted.body.jobId);
      if (failed.state !== "FAILED" || ledger.job.error_code !== "MOCK_AV_OUTPUT_INVALID") {
        throw new Error(`recovery result ${failed.state} ${ledger.job?.error_code} ${ledger.job?.error_message}`);
      }
      if (ledger.attempts.length !== 1 || ledger.attempts[0].provider_request_id !== requestId) {
        throw new Error(`attempt was resubmitted ${JSON.stringify(ledger.attempts)}`);
      }
      if (ledger.assets.length !== 0 || ledger.costs.length !== 0) {
        throw new Error("failed recovery left an asset or cost");
      }
      return { jobId: accepted.body.jobId, errorCode: ledger.job.error_code, requestId };
    } finally {
      await restoreMockDir();
    }
  });

  await stage("recovery-flag", async () => {
    const staleStarted = Date.now();
    let pendingStale = [{ count: 1 }];
    while (Date.now() - staleStarted < 30_000) {
      pendingStale = await sql(
        "SELECT count(*)::int AS count FROM stale_recalculation WHERE project_id = $1 AND status IN ('PENDING', 'RUNNING')",
        [state.world.projectId],
      );
      if (pendingStale[0].count === 0) break;
      await sleep(1000);
    }
    if (pendingStale[0].count !== 0) throw new Error("stale recalculation did not finish before the flag recovery");
    await breakMockDir();
    try {
      const accepted = expectStatus(await callApi(apiOrigin, "POST", `/shot-revisions/${state.world.shotRevisionId}/generate-video`, {
        body: { seed: "flag-failure" },
      }), 202);
      const started = Date.now();
      let attached = null;
      while (Date.now() - started < 30_000) {
        attached = await jobLedger(accepted.body.jobId);
        if (attached.job?.state === "RUNNING" && attached.attempts[0]?.provider_request_id) break;
        if (["FAILED", "SUCCEEDED"].includes(attached.job?.state)) {
          throw new Error(`flag fault job did not stay RUNNING ${attached.job?.state}`);
        }
        await sleep(500);
      }
      const requestId = attached?.attempts[0]?.provider_request_id;
      if (attached?.job?.state !== "RUNNING" || !requestId) {
        throw new Error(`flag fault request was not attached ${JSON.stringify(attached?.job)}`);
      }
      await stopApp("worker");
      const downStarted = Date.now();
      while (Date.now() - downStarted < 15_000) {
        try {
          await fetch(`${workerOrigin}/health/ready`, { signal: AbortSignal.timeout(1000) });
          await sleep(300);
        } catch {
          break;
        }
      }
      await restoreMockDir();
      spawnApp("worker", ["pnpm", "--filter", "@ai-drama/worker", "start"], appEnv({
        M3_MOCK_IMAGE_ENABLED: "true",
        M3_MOCK_AV_ENABLED: "false",
      }));
      await waitHttp(`${workerOrigin}/health/ready`, (status, body) =>
        status === 200 && body?.dependencies?.queue?.status === "ok", 60_000);
      const failed = await pollJob(accepted.body.jobId, 100_000);
      const ledger = await jobLedger(accepted.body.jobId);
      if (failed.state !== "FAILED" || ledger.job.error_code !== "MOCK_MEDIA_NOT_CONFIGURED") {
        throw new Error(`AV flag recovery ${failed.state} ${ledger.job?.error_code}`);
      }
      if (ledger.attempts.length !== 1 || ledger.attempts[0].attempt_no !== 1 || ledger.attempts[0].provider_request_id !== requestId) {
        throw new Error(`AV attempt changed ${JSON.stringify(ledger.attempts)}`);
      }
      if (ledger.assets.length !== 0 || ledger.costs.length !== 0) throw new Error("config failure left an asset or cost");
      const image = expectStatus(await callApi(apiOrigin, "POST", `/shot-revisions/${state.world.shotRevisionId}/generate-image`, {
        body: { seed: "image-after-av-off" },
      }), 202);
      const imageDone = await pollJob(image.body.jobId, 90_000);
      if (imageDone.state !== "SUCCEEDED") throw new Error(`image after AV off ${imageDone.state}`);
      const imageLedger = await jobLedger(image.body.jobId);
      if (imageLedger.assets.length !== 1 || imageLedger.assets[0].kind !== "IMAGE") {
        throw new Error("image did not persist an asset");
      }
      const minio = await countMinio();
      if (minio !== state.evidence.minioBefore) throw new Error(`MinIO changed after recovery ${minio}`);
      return {
        failedJobId: accepted.body.jobId,
        requestId,
        attemptNo: ledger.attempts[0].attempt_no,
        imageJobId: image.body.jobId,
        minio,
      };
    } finally {
      await restoreMockDir();
    }
  });
}

function redact(text) {
  let next = text;
  for (const secret of secrets) {
    if (secret) next = next.split(secret).join("[redacted]");
  }
  return next;
}

let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  await restoreMockDir().catch((error) => {
    state.evidence.restoreError = error instanceof Error ? error.message : String(error);
  });
  if (state.page) {
    await state.page.screenshot({ path: join(outputDir, "final-page.png"), fullPage: true }).catch(() => undefined);
  }
  if (state.browser) await state.browser.close().catch(() => undefined);
  for (const app of [...state.apps]) killGroup(app.pid);
  await sleep(500);
  for (const app of state.apps) {
    try { process.kill(process.platform === "linux" ? -app.pid : app.pid, "SIGKILL"); } catch { /* exited */ }
  }
  if (state.composeStarted && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)) {
    const down = await run("docker", [
      "compose", "-p", project, "-f", composeFile, "--env-file", envFile,
      "down", "-v", "--remove-orphans",
    ], { timeoutMs: 120_000, allowFail: true });
    state.evidence.composeDown = { code: down.code, stderr: redact(down.stderr).slice(-1000) };
    if (down.code !== 0) state.evidence.composeDownFailed = true;
  }
  if (state.db) await state.db.end().catch(() => undefined);
  for (const fd of state.logFds) {
    try { closeSync(fd); } catch { /* already closed */ }
  }
  writeFileSync(join(outputDir, "console.json"), JSON.stringify(state.consoleEvents, null, 2));
  writeFileSync(join(outputDir, "content-requests.json"), JSON.stringify(state.contentRequests, null, 2));
  for (const name of ["api.log", "worker.log", "web.log", "api-other.log", "api-off.log", "api-prod.log"]) {
    const file = join(outputDir, name);
    if (existsSync(file)) writeFileSync(file, redact(readFileSync(file, "utf8")));
  }
  if (existsSync(envFile)) rmSync(envFile, { force: true });
  for (const name of pending) stages.push({ name, status: "skipped", reason: "earlier stage did not pass" });
  const failed = stages.some((item) => item.status === "failed" || item.status === "blocked") || state.evidence.composeDownFailed === true;
  const results = {
    ok: !failed,
    meta: state.evidence.meta ?? null,
    identity: state.evidence.identity ?? null,
    chrome: state.evidence.chrome ?? null,
    minioBefore: state.evidence.minioBefore ?? null,
    stages,
    notRun,
    composeDown: state.evidence.composeDown ?? null,
    migration: "Existing repository migrations only, applied after current_database, current_user, loopback URL, and public table count 0 were verified on this run's new database. No new migration and no DROP SCHEMA.",
    fatal: state.evidence.fatal ?? null,
  };
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, "results.json"), JSON.stringify(results, null, 2));
  return failed;
}

process.once("SIGTERM", () => {
  void cleanup().finally(() => process.exit(1));
});
process.once("SIGINT", () => {
  void cleanup().finally(() => process.exit(1));
});

try {
  await main();
} catch (error) {
  state.evidence.fatal = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${state.evidence.fatal}\n`);
} finally {
  const failed = await cleanup();
  process.exitCode = failed ? 1 : 0;
}
