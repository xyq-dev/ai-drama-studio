/**
 * Title writing runtime acceptance: the API is started the normal way (`node dist/main.js`, i.e. main.ts → loadApiEnv →
 * AppModule.register → StudioRuntime.open with its store, engine and recovery timer) as a child process of this test, on
 * a newly created, empty, disposable database. NOT part of `test` or `integration`: run only with
 * `pnpm --filter @ai-drama/api title-writing:runtime-acceptance` after `pnpm build`, with the same guard and variables as
 * the other title writing acceptances (and a database of its own).
 *
 * Nothing in the API is replaced: no provider is overridden, no service is built here, and maintain() is never called by
 * the test. The model is reached the way production reaches it, through the API's own fetch; a test-only preload
 * (acceptance/title-writing-runtime-preload.cjs, deny by default) delivers fetches to provider hosts to the counting stub
 * in THIS process and refuses any other outbound fetch. The stub's counts therefore survive killing the API. The same
 * preload offers one pause point (before a reserved call is marked as sent) and reports each recovery pass.
 *
 * Crashes are real: the API child is killed with SIGKILL, its exit and the end of its database sessions are checked,
 * and a new child is started on the same database. Recovery is the API's own timer after the product lease (240 s)
 * expires; the test only waits for it with bounded polling.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TitleWritingRunView } from "@ai-drama/contracts";
import {
  checkTitleWritingAcceptanceEnv,
  closePostgresPool,
  createPostgresPool,
  TITLE_WRITING_MIGRATION,
  runMigrations,
  verifyTitleWritingAcceptanceDatabase,
} from "@ai-drama/database";
import { chatAnswer, fixtureConcept, fixtureEpisode, fixtureOutline, fixtureStepOf, type FixtureStep } from "@ai-drama/providers/title-writing-fixtures";

// Refuse before any connection is opened.
const decision = checkTitleWritingAcceptanceEnv(process.env);
if (!decision.ok) throw new Error(`Title writing runtime acceptance refused: ${decision.reason}`);
const acceptanceUrl = decision.url;

const ROOT = join(__dirname, "..", "..", "..", "..");
const API_DIR = join(ROOT, "apps", "api");
const PRELOAD = join(API_DIR, "acceptance", "title-writing-runtime-preload.cjs");
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const API_PORT = 3101;
const API = `http://127.0.0.1:${String(API_PORT)}/api/v1`;
// Generated per run, held in memory, given only to the API child's environment; never printed or written to evidence.
const OPERATOR_TOKEN = `acceptance-${randomUUID()}`;
// Not a key of any provider account; it only lets the stub check that the API sent its configured key.
const FAKE_KEY = `stub-not-a-provider-key-${randomUUID()}`;
const QWEN_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const STUB_MODEL = "qwen-acceptance-stub";
const PRODUCT_LEASE_MS = 240_000;
const MAINTENANCE_MS = 15_000;

const pool = createPostgresPool({ connectionString: acceptanceUrl, connectionTimeoutMs: 2_000, statementTimeoutMs: 10_000, queryTimeoutMs: 10_000 });
async function q<T>(sql: string, values: unknown[] = []): Promise<T[]> {
  return (await pool.query(sql, values) as { rows: T[] }).rows;
}
const evidence: Record<string, unknown> = { generations: [] as unknown[], checks: {} as Record<string, unknown>, scenarios: {} as Record<string, unknown> };
const generations = evidence.generations as Array<Record<string, unknown>>;
const checks = evidence.checks as Record<string, unknown>;
const scenarios = evidence.scenarios as Record<string, unknown>;

function redact(text: string): string {
  return text.split(OPERATOR_TOKEN).join("[token]").split(FAKE_KEY).join("[stub-key]").split(acceptanceUrl).join("[database-url]");
}

// ---------------------------------------------------------------------------------------------------------------
// Controller and model stub, in this process: counts survive the API.

type Plan = { status: number; body: unknown } | "hold";
interface Sent { title: string; step: FixtureStep; attempt: number; endpoint: string; keyMatches: boolean; at: string }
const sent: Sent[] = [];
const attempts = new Map<string, number>();
const plans = new Map<string, (step: FixtureStep, attempt: number) => Plan | undefined>();
/** Held model requests and held pause-point answers: never answered; closed when the API dies or at cleanup. */
const held: ServerResponse[] = [];
/** "title|stepKey" whose reserved call must wait before it is marked as sent. */
const armed = new Set<string>();
const paused: Array<{ title: string; stepKey: string; callId: string; pid: number; at: string }> = [];
const barrierPasses: Array<{ pid: number; at: string }> = [];
const recoveryPasses: Array<{ pid: number; at: string }> = [];
let server: Server | undefined;
let controlUrl = "";

const sends = (title: string) => sent.filter((item) => item.title === title).length;

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const raw = await readBody(request);
  if (request.method === "POST" && url.pathname.startsWith("/model/")) {
    const body = JSON.parse(raw) as { messages?: Array<{ role: string; content: string }> };
    const user = body.messages?.find((message) => message.role === "user")?.content ?? "";
    const title = /剧名：(.+)/.exec(user)?.[1]?.trim() ?? "";
    const step = fixtureStepOf(user);
    const key = `${title}|${step}`;
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    sent.push({ title, step, attempt, endpoint: url.pathname.slice("/model/".length), keyMatches: request.headers.authorization === `Bearer ${FAKE_KEY}`,
      at: new Date().toISOString() });
    const plan = plans.get(title)?.(step, attempt);
    if (plan === "hold") {
      held.push(response);
      return;
    }
    const answer = plan ?? { status: 200, body: chatAnswer(step === "concept" ? fixtureConcept(title)
      : step === "outline" ? fixtureOutline() : fixtureEpisode(Number(step.slice(-1)) as 1 | 2 | 3)) };
    response.writeHead(answer.status, { "content-type": "application/json", "x-request-id": `stub-${step}-${String(attempt)}` });
    response.end(JSON.stringify(answer.body));
    return;
  }
  if (request.method === "POST" && url.pathname === "/barrier") {
    const message = JSON.parse(raw) as { pid: number; callId: string };
    const row = (await q<{ title: string; step_key: string }>(
      `SELECT r.input_json->>'title' AS title, c.step_key FROM title_writing_call c JOIN title_writing_run r ON r.id = c.run_id WHERE c.id = $1`,
      [message.callId]))[0];
    if (row && armed.has(`${row.title}|${row.step_key}`)) {
      paused.push({ title: row.title, stepKey: row.step_key, callId: message.callId, pid: message.pid, at: new Date().toISOString() });
      held.push(response);
      return;
    }
    barrierPasses.push({ pid: message.pid, at: new Date().toISOString() });
    response.writeHead(204).end();
    return;
  }
  if (request.method === "POST" && url.pathname === "/observe") {
    const message = JSON.parse(raw) as { pid: number; at: string };
    recoveryPasses.push({ pid: message.pid, at: message.at });
    response.writeHead(204).end();
    return;
  }
  response.writeHead(404).end();
}

// ---------------------------------------------------------------------------------------------------------------
// API child processes, started through the normal entry point.

interface Generation { label: string; child: ChildProcess; pid: number; record: Record<string, unknown>; logs: () => string; exited: Promise<void> }
let current: Generation | undefined;
const children: Generation[] = [];

function apiEnv(label: string, overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "development",
    BIND_HOST: "127.0.0.1",
    API_PORT: String(API_PORT),
    DATABASE_URL: acceptanceUrl,
    REDIS_URL: "redis://127.0.0.1:6399",
    S3_ENDPOINT: "http://127.0.0.1:59000",
    S3_REGION: "us-east-1",
    S3_BUCKET: "ai-drama-dev",
    S3_ACCESS_KEY_ID: "test",
    S3_SECRET_ACCESS_KEY: "test",
    APP_WORKSPACE_ID: WORKSPACE,
    // Names this child's database sessions, so their end can be checked after a kill.
    PGAPPNAME: `title-runtime-${label}`,
    TITLE_WRITING_ACCEPTANCE_AUTHORIZED: "true",
    TITLE_WRITING_ACCEPTANCE_DATABASE_NAME: decision.ok ? decision.databaseName : "",
    TITLE_WRITING_RUNTIME_ACCEPTANCE_CONTROL: controlUrl,
  };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

const ENABLED: Record<string, string> = {
  TITLE_WRITING_ENABLED: "true",
  TITLE_WRITING_OPERATOR_TOKEN: OPERATOR_TOKEN,
  TITLE_WRITING_DEFAULT_PROVIDER: "qwen",
  // Configuration, not rules: room for the parallel crash scenarios. Lease, recovery and caps per run are unchanged.
  TITLE_WRITING_MAX_CALLS_PER_DAY: "100",
  TITLE_WRITING_MAX_ACTIVE_RUNS: "5",
  DASHSCOPE_API_KEY: FAKE_KEY,
  BAILIAN_BASE_URL: QWEN_BASE,
  TITLE_WRITING_QWEN_MODELS: STUB_MODEL,
};

async function startApi(label: string, purpose: string, overrides: Record<string, string | undefined>): Promise<Generation> {
  const child = spawn(process.execPath, ["--require", PRELOAD, "dist/main.js"], { cwd: API_DIR, env: apiEnv(label, overrides), stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  const append = (chunk: Buffer) => { logs = `${logs}${chunk.toString()}`.slice(-8_000); };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const record: Record<string, unknown> = { label, purpose, pid: child.pid, startedAt: new Date().toISOString() };
  generations.push(record);
  const exited = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => {
      record.exitedAt = new Date().toISOString();
      record.exitCode = code;
      record.signal = signal;
      resolve();
    });
  });
  const generation: Generation = { label, child, pid: child.pid!, record, logs: () => redact(logs), exited };
  children.push(generation);
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`API ${label} exited during start: ${generation.logs()}`);
    try {
      if ((await fetch(`${API}/health/live`)).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`API ${label} did not start: ${generation.logs()}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  record.listeningAt = new Date().toISOString();
  current = generation;
  return generation;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Sessions the named generation still has in the acceptance database. */
const sessionsOf = async (label: string) =>
  (await q<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND application_name = $1",
    [`title-runtime-${label}`]))[0]!.n;

/** Ends one generation this test started: SIGKILL for a crash, SIGTERM for a normal stop. Only its own recorded PID. */
async function stopApi(generation: Generation, signal: "SIGKILL" | "SIGTERM"): Promise<void> {
  generation.record.stoppedWith = signal;
  generation.record.stopRequestedAt = new Date().toISOString();
  if (generation.child.exitCode === null && generation.child.signalCode === null) generation.child.kill(signal);
  await Promise.race([generation.exited, new Promise((resolve) => setTimeout(resolve, 15_000))]);
  if (alive(generation.pid)) throw new Error(`API ${generation.label} (pid ${String(generation.pid)}) is still running`);
  generation.record.pidGone = true;
  const deadline = Date.now() + 30_000;
  let left = await sessionsOf(generation.label);
  while (left > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    left = await sessionsOf(generation.label);
  }
  generation.record.databaseSessionsLeft = left;
  if (left > 0) throw new Error(`API ${generation.label} left ${String(left)} database sessions`);
  if (current === generation) current = undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP to the API child.

interface Answer { status: number; body: { id?: string; run?: TitleWritingRunView; error?: { code: string }; code?: string; items?: Array<Record<string, unknown>>;
  revisionId?: string; reviewVersion?: number; rowVersion?: number; version?: number } }

async function http(method: "GET" | "POST", path: string, options: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Answer> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { accept: "application/json", ...(options.body !== undefined ? { "content-type": "application/json" } : {}), ...options.headers },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Answer["body"] : {} };
}

const operator = (key?: string) => ({ "x-operator-token": OPERATOR_TOKEN, ...(key ? { "idempotency-key": key } : {}) });

async function createProject(title: string): Promise<string> {
  const created = await http("POST", "/projects", { body: { title, premise: "" }, headers: { "idempotency-key": randomUUID() } });
  expect(created.status).toBe(201);
  return created.body.id!;
}

const start = (projectId: string, title: string, headers: Record<string, string> = operator(randomUUID())) =>
  http("POST", `/projects/${projectId}/title-runs`, { body: { title }, headers });

async function runState(runId: string) {
  // Times as epoch milliseconds, so they compare with the controller's clock without parsing PostgreSQL text.
  return (await q<{ state: string; executor_id: string | null; lease_ms: number | null; error_code: string | null; updated_ms: number }>(
    `SELECT state, executor_id, (extract(epoch FROM lease_until) * 1000)::float8 AS lease_ms, error_code,
            (extract(epoch FROM updated_at) * 1000)::float8 AS updated_ms FROM title_writing_run WHERE id = $1`, [runId]))[0]!;
}

async function calls(runId: string) {
  return (await q<{ step_key: string; attempt_no: number; state: string; error_code: string | null }>(
    "SELECT step_key, attempt_no, state, error_code FROM title_writing_call WHERE run_id = $1 ORDER BY created_at, attempt_no", [runId]))
    .map((row) => `${row.step_key}#${String(row.attempt_no)} ${row.state}${row.error_code ? `/${row.error_code}` : ""}`);
}

const count = async (sql: string, values: unknown[]) => (await q<{ n: number }>(sql, values))[0]!.n;
const storyCount = (projectId: string) => count("SELECT count(*)::int AS n FROM story_revision WHERE project_id = $1", [projectId]);
const scriptCount = (projectId: string) => count("SELECT count(*)::int AS n FROM script_revision WHERE project_id = $1", [projectId]);
const runCount = (projectId: string) => count("SELECT count(*)::int AS n FROM title_writing_run WHERE project_id = $1", [projectId]);

/** Bounded polling for a condition on persisted state; fails with the last value when it never holds. */
async function until<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean, ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${String(ms)} ms: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function approveStory(projectId: string, revisionId: string): Promise<void> {
  const project = await http("GET", `/projects/${projectId}`);
  const stories = await http("GET", `/projects/${projectId}/stories`);
  const story = stories.body.items!.find((item) => item.id === revisionId) as { reviewVersion: number };
  const inReview = await http("POST", `/projects/${projectId}/stories/${revisionId}/review`, {
    body: { to: "IN_REVIEW", expectedReviewVersion: story.reviewVersion },
    headers: { "idempotency-key": randomUUID(), "if-match": String(project.body.version) },
  });
  expect(inReview.status).toBe(200);
  const approved = await http("POST", `/projects/${projectId}/stories/${revisionId}/review`, {
    body: { to: "APPROVED", expectedReviewVersion: inReview.body.reviewVersion },
    headers: { "idempotency-key": randomUUID(), "if-match": String(inReview.body.rowVersion) },
  });
  expect(approved.status).toBe(200);
}

// ---------------------------------------------------------------------------------------------------------------

beforeAll(async () => {
  // The API reads <repo>/.env; a file there could carry real keys into this run.
  if (existsSync(join(ROOT, ".env"))) throw new Error("Title writing runtime acceptance refused: a .env file exists at the repository root.");
  const verified = await verifyTitleWritingAcceptanceDatabase({ query: async (sql, values) => ({ rows: await q<Record<string, unknown>>(sql, values) }) },
    decision.databaseName);
  if (!verified.ok) {
    await closePostgresPool(pool);
    throw new Error(`Title writing runtime acceptance refused: ${verified.reason}`);
  }
  const identity = (await q<{ name: string; version: string; tables: number }>(
    `SELECT current_database() AS name, current_setting('server_version') AS version,
            (SELECT count(*)::int FROM information_schema.tables
              WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg_toast%') AS tables`))[0]!;
  evidence.database = { name: identity.name, serverVersion: identity.version, tablesBeforeWrite: identity.tables };
  // For a pull request GITHUB_SHA is the merge commit; the workflow passes the branch head it was made from.
  evidence.source = { headSha: process.env.TITLE_WRITING_ACCEPTANCE_HEAD_SHA ?? null, event: process.env.GITHUB_EVENT_NAME ?? null,
    testedSha: process.env.GITHUB_SHA ?? null, runId: process.env.GITHUB_RUN_ID ?? null, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    job: process.env.GITHUB_JOB ?? null };
  // A second layer under the preload: on the runner the provider hosts resolve to loopback, so no request can reach them.
  const resolved = await Promise.all(["dashscope.aliyuncs.com", "api.openai.com", "api.deepseek.com"].map(async (host) =>
    [host, (await lookup(host).catch(() => ({ address: "unresolved" }))).address] as const));
  evidence.providerHostsResolveTo = Object.fromEntries(resolved);
  expect(resolved.every(([, address]) => address === "127.0.0.1" || address === "::1" || address === "unresolved")).toBe(true);
  // The released schema: every migration before the title writing one, as on a server before this release.
  evidence.migrationsApplied = (await runMigrations(pool, undefined, { before: TITLE_WRITING_MIGRATION })).applied;
  await q("INSERT INTO workspace (id, name, status) VALUES ($1, 'title-runtime-acceptance', 'ACTIVE')", [WORKSPACE]);
  server = createServer((request, response) => {
    void handle(request, response).catch(() => { if (!response.headersSent) response.writeHead(500).end(); });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  controlUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}, 120_000);

afterAll(async () => {
  const problems: string[] = [];
  const attempt = async (what: string, work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      problems.push(`${what}: ${redact(error instanceof Error ? error.message : String(error))}`);
    }
  };
  for (const generation of children) {
    if (generation.child.exitCode === null && generation.child.signalCode === null) await attempt(`stop ${generation.label}`, () => stopApi(generation, "SIGTERM"));
    if (alive(generation.pid)) await attempt(`kill ${generation.label}`, () => stopApi(generation, "SIGKILL"));
  }
  for (const response of held) response.destroy();
  server?.closeAllConnections();
  await attempt("control server", () => new Promise<void>((resolve, reject) => {
    if (!server) {
      resolve();
      return;
    }
    server.close((error) => { if (error) reject(error); else resolve(); });
  }));
  evidence.stub = { totalSends: sent.length, perTitle: Object.fromEntries([...new Set(sent.map((item) => item.title))].map((title) => [title, sends(title)])),
    everyEndpoint: [...new Set(sent.map((item) => item.endpoint))], everyKeyWasTheConfiguredFakeKey: sent.every((item) => item.keyMatches) };
  evidence.pausePoint = { paused: paused.map(({ title, stepKey, pid, at }) => ({ title, stepKey, pid, at })), passedThrough: barrierPasses.length };
  evidence.recoveryPasses = recoveryPasses;
  evidence.cleanup = { childrenAlive: children.filter((generation) => alive(generation.pid)).map((generation) => generation.pid), problems };
  const dir = process.env.TITLE_WRITING_ACCEPTANCE_EVIDENCE_DIR;
  if (dir) {
    await attempt("evidence", async () => {
      await mkdir(dir, { recursive: true });
      const text = `${JSON.stringify(evidence, null, 2)}\n`;
      if (text.includes(OPERATOR_TOKEN) || text.includes(FAKE_KEY) || text.includes(acceptanceUrl)) throw new Error("secret in the evidence");
      await writeFile(join(dir, "title-writing-runtime-acceptance.json"), text, "utf8");
    });
  }
  await attempt("pool", () => closePostgresPool(pool));
  if (problems.length > 0) throw new Error(`runtime acceptance cleanup: ${problems.join("; ")}`);
}, 120_000);

describe("title writing on the real runtime, killed and restarted, model stubbed outside the API", () => {
  it("refuses as configured, through the normal entry point, before anything is sent", async () => {
    const results: Record<string, unknown> = {};
    // Off by default: the title writing variables are simply absent.
    let api = await startApi("off-by-default", "TITLE_WRITING_ENABLED unset", { DASHSCOPE_API_KEY: FAKE_KEY, BAILIAN_BASE_URL: QWEN_BASE, TITLE_WRITING_QWEN_MODELS: STUB_MODEL,
      TITLE_WRITING_OPERATOR_TOKEN: OPERATOR_TOKEN });
    let projectId = await createProject("运行时默认关闭");
    let refused = await start(projectId, "运行时默认关闭");
    expect([refused.status, refused.body.error?.code]).toEqual([404, "TITLE_WRITING_DISABLED"]);
    results.offByDefault = refused.status;
    await stopApi(api, "SIGTERM");

    // Production stays off even when switched on.
    api = await startApi("production", "NODE_ENV=production with TITLE_WRITING_ENABLED=true", { ...ENABLED, NODE_ENV: "production" });
    projectId = await createProject("运行时生产环境");
    refused = await start(projectId, "运行时生产环境");
    expect([refused.status, refused.body.error?.code]).toEqual([404, "TITLE_WRITING_DISABLED"]);
    expect((await http("GET", "/writing/title-runs/options")).body.code).toBe("TITLE_WRITING_DISABLED");
    results.productionEnabled = refused.status;
    await stopApi(api, "SIGTERM");

    // Storage missing: the database is not migrated to the title writing migration yet.
    api = await startApi("no-storage", "enabled, title writing migration not applied", ENABLED);
    projectId = await createProject("运行时存储未就绪");
    refused = await start(projectId, "运行时存储未就绪");
    expect([refused.status, refused.body.error?.code]).toEqual([503, "TITLE_WRITING_STORAGE_UNAVAILABLE"]);
    results.storageMissing = refused.status;
    await stopApi(api, "SIGTERM");

    // The deploy step: the normal chain applies only the title writing migration; a second run applies nothing.
    const upgrade = await runMigrations(pool);
    expect(upgrade.applied).toEqual([TITLE_WRITING_MIGRATION]);
    const again = await runMigrations(pool);
    expect(again.applied).toEqual([]);
    evidence.migration = { upgradeApplied: upgrade.applied, redeployApplied: again.applied };

    // After the migration the feature is still off by default, and the API starts and refuses as before.
    api = await startApi("off-after-migration", "TITLE_WRITING_ENABLED unset, after the migration", { DASHSCOPE_API_KEY: FAKE_KEY,
      BAILIAN_BASE_URL: QWEN_BASE, TITLE_WRITING_QWEN_MODELS: STUB_MODEL, TITLE_WRITING_OPERATOR_TOKEN: OPERATOR_TOKEN });
    projectId = await createProject("运行时迁移后默认关闭");
    refused = await start(projectId, "运行时迁移后默认关闭");
    expect([refused.status, refused.body.error?.code]).toEqual([404, "TITLE_WRITING_DISABLED"]);
    results.offAfterMigration = refused.status;
    await stopApi(api, "SIGTERM");

    // No operator token configured on the server: every token is refused.
    api = await startApi("no-server-token", "enabled, TITLE_WRITING_OPERATOR_TOKEN unset", { ...ENABLED, TITLE_WRITING_OPERATOR_TOKEN: undefined });
    projectId = await createProject("运行时未配置令牌");
    refused = await start(projectId, "运行时未配置令牌");
    expect([refused.status, refused.body.error?.code]).toEqual([403, "TITLE_WRITING_FORBIDDEN"]);
    results.serverTokenMissing = refused.status;
    await stopApi(api, "SIGTERM");

    // Provider configuration missing.
    api = await startApi("no-provider", "enabled, DASHSCOPE_API_KEY unset", { ...ENABLED, DASHSCOPE_API_KEY: undefined });
    projectId = await createProject("运行时缺供应商配置");
    refused = await start(projectId, "运行时缺供应商配置");
    expect([refused.status, refused.body.error?.code]).toEqual([503, "TITLE_WRITING_PROVIDER_UNCONFIGURED"]);
    results.providerMissing = refused.status;
    await stopApi(api, "SIGTERM");

    expect(sent).toHaveLength(0);
    expect(await count("SELECT count(*)::int AS n FROM title_writing_run", [])).toBe(0);
    checks.refusals = { ...results, sends: 0, runs: 0 };
  }, 300_000);

  it("on the valid configuration, a request without or with a wrong token is refused and a run is driven by the runtime", async () => {
    const api = await startApi("g1", "valid configuration; later killed", ENABLED);
    const projectId = await createProject("模型替身样例·运行时正常");
    const noToken = await start(projectId, "模型替身样例·运行时正常", { "idempotency-key": randomUUID() });
    const wrongToken = await start(projectId, "模型替身样例·运行时正常", { "x-operator-token": `wrong-${randomUUID()}`, "idempotency-key": randomUUID() });
    expect([noToken.status, wrongToken.status]).toEqual([403, 403]);
    expect(sent).toHaveLength(0);

    const started = await start(projectId, "模型替身样例·运行时正常");
    expect(started.status).toBe(201);
    const runId = started.body.run!.runId;
    const done = await until("the normal run to complete", () => runState(runId), (row) => row.state !== "running", 60_000);
    expect(done.state).toBe("completed");
    expect(sends("模型替身样例·运行时正常")).toBe(5);
    expect(await calls(runId)).toEqual(["concept#1 completed", "outline#1 completed", "episode:1#1 completed", "episode:2#1 completed", "episode:3#1 completed"]);
    expect(await storyCount(projectId)).toBe(1);
    checks.validConfiguration = { pid: api.pid, noToken: noToken.status, wrongToken: wrongToken.status, runId, state: done.state, sends: 5, storyRevisions: 1 };
  }, 120_000);

  it("A/B/C: killed at a reserved call, a sent call and after a committed step; restarted; recovered by the runtime's timer", async () => {
    const api = current!;
    const TA = "模型替身样例·崩溃A预约未发送";
    const TB = "模型替身样例·崩溃B已发送";
    const TC = "模型替身样例·崩溃C已提交";
    // A: the first call is reserved, then held before it is marked as sent.
    armed.add(`${TA}|concept`);
    // B: the story plan completes; the outline is sent and its answer never comes.
    plans.set(TB, (step, attempt) => step === "outline" && attempt === 1 ? "hold" : undefined);
    // C: three steps complete; episode 2 is reserved, then held before it is marked as sent.
    armed.add(`${TC}|episode:2`);

    const projects = { A: await createProject(TA), B: await createProject(TB), C: await createProject(TC) };
    const runs = {
      A: (await start(projects.A, TA)).body.run!.runId,
      B: (await start(projects.B, TB)).body.run!.runId,
      C: (await start(projects.C, TC)).body.run!.runId,
    };
    // Barriers, not sleeps: each process stands where it was told to, as the controller and the database say.
    await until("A and C at the pause point and B's outline at the stub", async () => ({ paused: paused.map((item) => item.title), b: sends(TB) }),
      (value) => value.paused.includes(TA) && value.paused.includes(TC) && value.b === 2, 60_000);
    const before = {
      A: { calls: await calls(runs.A), sends: sends(TA), run: await runState(runs.A) },
      B: { calls: await calls(runs.B), sends: sends(TB), run: await runState(runs.B) },
      C: { calls: await calls(runs.C), sends: sends(TC), run: await runState(runs.C) },
    };
    expect(before.A.calls).toEqual(["concept#1 reserved"]);
    expect(before.A.sends).toBe(0);
    expect(before.B.calls).toEqual(["concept#1 completed", "outline#1 submitted"]);
    expect(before.B.sends).toBe(2);
    expect(before.C.calls).toEqual(["concept#1 completed", "outline#1 completed", "episode:1#1 completed", "episode:2#1 reserved"]);
    expect(before.C.sends).toBe(3);
    for (const run of Object.values(before)) expect(run.run).toMatchObject({ state: "running" });
    expect(Object.values(before).every((run) => run.run.executor_id !== null)).toBe(true);

    // Crash: SIGKILL to this test's own API child, then its exit and the end of its sessions are checked.
    const killedAt = new Date();
    await stopApi(api, "SIGKILL");
    expect(api.record.signal).toBe("SIGKILL");
    const afterKill = { A: await calls(runs.A), B: await calls(runs.B), C: await calls(runs.C) };
    // The held submission died with the process: nothing was marked as sent after the kill.
    expect(afterKill).toEqual({ A: before.A.calls, B: before.B.calls, C: before.C.calls });
    const leaseMs = { A: (await runState(runs.A)).lease_ms!, B: (await runState(runs.B)).lease_ms!, C: (await runState(runs.C)).lease_ms! };
    const leases = Object.fromEntries(Object.entries(leaseMs).map(([key, value]) => [key, new Date(value).toISOString()]));
    armed.clear();

    const restarted = await startApi("g2", "restart on the same database after the SIGKILL", ENABLED);
    const restartedAt = new Date();
    // Only the runtime's own timer recovers: the test waits for the persisted outcome, bounded by the lease plus slack.
    const latestLease = Math.max(...Object.values(leaseMs));
    const bound = Math.max(0, latestLease - Date.now()) + 4 * MAINTENANCE_MS + 60_000;
    await until("the runtime's recovery of A, B and C", async () => ({
      A: (await runState(runs.A)).state, B: (await runState(runs.B)).state, C: (await runState(runs.C)).state,
    }), (value) => value.A === "completed" && value.B === "needs_attention" && value.C === "completed", bound);
    const recoveredSeenAt = new Date();
    const bState = await runState(runs.B);
    const restartedPasses = recoveryPasses.filter((pass) => pass.pid === restarted.pid);

    // A: the never-sent reservation was released and the step continued; one run, five sends, one story.
    expect(await calls(runs.A)).toEqual(["concept#1 rejected/executor_lost_before_send", "concept#2 completed", "outline#1 completed",
      "episode:1#1 completed", "episode:2#1 completed", "episode:3#1 completed"]);
    expect(sends(TA)).toBe(5);
    expect(await runCount(projects.A)).toBe(1);
    expect(await storyCount(projects.A)).toBe(1);

    // C: the committed steps were not called again; episode 2 continued; one story, no script yet.
    expect(await calls(runs.C)).toEqual(["concept#1 completed", "outline#1 completed", "episode:1#1 completed",
      "episode:2#1 rejected/executor_lost_before_send", "episode:2#2 completed", "episode:3#1 completed"]);
    expect(sends(TC)).toBe(5);
    expect(sent.filter((item) => item.title === TC && ["concept", "outline", "episode:1"].includes(item.step)).every((item) => item.attempt === 1)).toBe(true);
    expect(await storyCount(projects.C)).toBe(1);
    expect(await scriptCount(projects.C)).toBe(0);

    // B: the maybe-sent call became unknown and was not sent again.
    expect(await calls(runs.B)).toEqual(["concept#1 completed", "outline#1 unknown/executor_lost"]);
    expect(bState).toMatchObject({ state: "needs_attention", error_code: "executor_lost" });
    expect(sends(TB)).toBe(2);

    scenarios.crash = {
      killedPid: api.pid, killedAt: killedAt.toISOString(), killSignal: api.record.signal, restartedPid: restarted.pid, restartedAt: restartedAt.toISOString(),
      leaseUntil: leases, productLeaseMs: PRODUCT_LEASE_MS, maintenanceMs: MAINTENANCE_MS, recoveryBoundMs: bound,
      recoveredSeenAt: recoveredSeenAt.toISOString(), secondsFromKillToRecoverySeen: Math.round((recoveredSeenAt.getTime() - killedAt.getTime()) / 1000),
      recoveryPassesOfRestartedApi: restartedPasses.length,
      before: { A: before.A.calls, B: before.B.calls, C: before.C.calls }, sendsBeforeKill: { A: before.A.sends, B: before.B.sends, C: before.C.sends },
      after: { A: await calls(runs.A), B: await calls(runs.B), C: await calls(runs.C) }, sendsAfterRecovery: { A: sends(TA), B: sends(TB), C: sends(TC) },
      runsPerProject: { A: await runCount(projects.A), B: await runCount(projects.B), C: await runCount(projects.C) },
      storyRevisions: { A: await storyCount(projects.A), C: await storyCount(projects.C) },
    };
    evidence.runs = { projects, runs };
  }, 900_000);

  it("B: reads and at least two further recovery passes send nothing; resume needs the token, the confirmation and a key; a replay sends nothing", async () => {
    const { projects, runs } = evidence.runs as { projects: Record<"A" | "B" | "C", string>; runs: Record<"A" | "B" | "C", string> };
    const TB = "模型替身样例·崩溃B已发送";
    const api = current!;
    const unknownSince = new Date((await runState(runs.B)).updated_ms).toISOString();
    for (let index = 0; index < 3; index += 1) {
      expect((await http("GET", `/projects/${projects.B}/title-runs/latest`)).status).toBe(200);
      expect((await http("GET", `/projects/${projects.B}/title-runs/${runs.B}`)).status).toBe(200);
    }
    const passes = await until("two recovery passes after B became uncertain",
      async () => recoveryPasses.filter((pass) => pass.pid === api.pid && pass.at > unknownSince),
      (value) => value.length >= 2, 4 * MAINTENANCE_MS + 15_000);
    expect(sends(TB)).toBe(2);
    expect((await runState(runs.B)).state).toBe("needs_attention");

    const view = (await http("GET", `/projects/${projects.B}/title-runs/${runs.B}`)).body.run!;
    const uncertain = view.calls.filter((call) => call.state === "unknown").map((call) => call.callId);
    expect(uncertain).toHaveLength(1);
    const path = `/projects/${projects.B}/title-runs/${runs.B}/resume`;
    const noToken = await http("POST", path, { body: { confirmUncertainCallIds: uncertain }, headers: { "idempotency-key": randomUUID() } });
    const wrongToken = await http("POST", path, { body: { confirmUncertainCallIds: uncertain }, headers: { "x-operator-token": `wrong-${randomUUID()}`, "idempotency-key": randomUUID() } });
    const noKey = await http("POST", path, { body: { confirmUncertainCallIds: uncertain }, headers: operator() });
    const unconfirmed = await http("POST", path, { body: { confirmUncertainCallIds: [] }, headers: operator(randomUUID()) });
    expect([noToken.status, wrongToken.status, noKey.status, unconfirmed.status]).toEqual([403, 403, 400, 409]);
    expect(unconfirmed.body.error?.code).toBe("TITLE_WRITING_NEEDS_CONFIRMATION");
    expect(sends(TB)).toBe(2);

    const key = randomUUID();
    const resumed = await http("POST", path, { body: { confirmUncertainCallIds: uncertain }, headers: operator(key) });
    expect(resumed.status).toBe(200);
    await until("B to complete after the resume", () => runState(runs.B), (row) => row.state !== "running", 60_000);
    expect((await runState(runs.B)).state).toBe("completed");
    const afterResume = sends(TB);
    const replay = await http("POST", path, { body: { confirmUncertainCallIds: uncertain }, headers: operator(key) });
    expect(replay.status).toBe(200);
    expect(sends(TB)).toBe(afterResume);
    expect(afterResume).toBe(6);
    expect(await calls(runs.B)).toEqual(["concept#1 completed", "outline#1 unknown/executor_lost", "outline#2 completed",
      "episode:1#1 completed", "episode:2#1 completed", "episode:3#1 completed"]);
    expect(sent.filter((item) => item.title === TB && item.step === "concept")).toHaveLength(1);
    expect(await count("SELECT count(*)::int AS n FROM title_writing_resume WHERE run_id = $1", [runs.B])).toBe(1);
    expect(await storyCount(projects.B)).toBe(1);
    scenarios.uncertainAfterCrash = {
      runId: runs.B, uncertainSince: unknownSince, recoveryPassesWhileUncertain: passes.length, passesObserved: passes.map((pass) => pass.at), sendsWhileUncertain: 2,
      refusals: { noToken: noToken.status, wrongToken: wrongToken.status, noKey: noKey.status, unconfirmed: unconfirmed.status },
      resume: resumed.status, replay: replay.status, sendsAfterResume: afterResume, sendsAfterReplay: sends(TB), resumeRows: 1, conceptCalls: 1,
      calls: await calls(runs.B),
    };
  }, 300_000);

  it("C: scripts are written only after a person approves the story, and an episode with a person's script keeps it", async () => {
    const { projects, runs } = evidence.runs as { projects: Record<"A" | "B" | "C", string>; runs: Record<"A" | "B" | "C", string> };
    const view = (await http("GET", `/projects/${projects.C}/title-runs/${runs.C}`)).body.run!;
    const early = await http("POST", `/projects/${projects.C}/title-runs/${runs.C}/scripts`, { body: {} });
    expect([early.status, early.body.error?.code]).toEqual([409, "TITLE_WRITING_STORY_NOT_APPROVED"]);
    expect(await scriptCount(projects.C)).toBe(0);
    await approveStory(projects.C, view.storyRevisionId!);
    const episodes = (await http("GET", `/projects/${projects.C}/episodes`)).body.items as Array<{ id: string; episodeNo: number; rowVersion: number }>;
    const third = episodes.find((item) => item.episodeNo === 3)!;
    // Preparation through the API: a person's script on episode 3.
    const human = await http("POST", `/projects/${projects.C}/episodes/${third.id}/scripts`, {
      body: { sourceStoryRevisionId: view.storyRevisionId, content: { text: "人工剧本，写入前已存在（运行时验收准备）" } },
      headers: { "idempotency-key": randomUUID(), "if-match": String(third.rowVersion) },
    });
    expect(human.status).toBe(201);
    const placed = await http("POST", `/projects/${projects.C}/title-runs/${runs.C}/scripts`, { body: {} });
    expect(placed.status).toBe(200);
    expect(placed.body.run!.steps.slice(2).map((step) => step.scriptSave)).toEqual(["saved", "saved", "conflict"]);
    const kept = (await q<{ text: string; current: boolean }>(
      `SELECT s.content_json->>'text' AS text, e.current_script_revision_id = s.id AS current FROM script_revision s JOIN episode e ON e.id = s.episode_id
        WHERE e.id = $1`, [third.id]));
    expect(kept).toEqual([{ text: "人工剧本，写入前已存在（运行时验收准备）", current: true }]);
    expect(await scriptCount(projects.C)).toBe(3);
    const again = await http("POST", `/projects/${projects.C}/title-runs/${runs.C}/scripts`, { body: {} });
    expect(again.status).toBe(200);
    expect(await scriptCount(projects.C)).toBe(3);
    scenarios.placementAfterCrash = { runId: runs.C, beforeApproval: early.status, perEpisode: ["saved", "saved", "conflict"], humanKept: true,
      scriptRevisions: 3, afterReplay: 3, storyRevisions: await storyCount(projects.C) };

    // A normal stop of the restarted API ends the run of this file.
    await stopApi(current!, "SIGTERM");
    expect(sent.every((item) => item.keyMatches)).toBe(true);
    expect(new Set(sent.map((item) => item.endpoint))).toEqual(new Set(["dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"]));
  }, 120_000);
});
