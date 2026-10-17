import { createCipheriv, randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPostgresPool, PostgresTitleWritingStore, RuntimeStore, TITLE_WRITING_TABLES, type PostgresPool,
} from "@ai-drama/database";
import type { TitleWritingOptionsView } from "@ai-drama/contracts";
import { loadApiEnv, type ApiEnv } from "../config/env";
import { StudioRuntime } from "../studio/studio.runtime";
import { hashPassword } from "../auth/password-hash";

vi.mock("@ai-drama/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ai-drama/database")>();
  return { ...actual, createPostgresPool: vi.fn() };
});

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const LEGACY_KEY = "sk-ant-api03-test-environment-claude-secret";
const SAVED_KEY = "sk-test-managed-openai-secret";
const BASE = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/no-database",
  REDIS_URL: "redis://127.0.0.1:1", S3_ENDPOINT: "http://127.0.0.1:1", S3_REGION: "us-east-1",
  S3_BUCKET: "test", S3_ACCESS_KEY_ID: "unused", S3_SECRET_ACCESS_KEY: "unused", APP_WORKSPACE_ID: WORKSPACE,
  TITLE_WRITING_ENABLED: "true", TITLE_WRITING_OPERATOR_TOKEN: "test-only-title-operator-token",
  TITLE_WRITING_DEFAULT_PROVIDER: "anthropic", TITLE_WRITING_MAX_CALLS_PER_DAY: "30", TITLE_WRITING_MAX_ACTIVE_RUNS: "1",
  ANTHROPIC_API_KEY: LEGACY_KEY,
  TITLE_WRITING_ANTHROPIC_MODELS: "environment-claude-model",
};

interface FakePool extends PostgresPool {
  query: ReturnType<typeof vi.fn<(sql: string, values?: unknown[]) => Promise<unknown>>>;
  end: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

/** This suite exercises the real startup wiring, not PostgreSQL concurrency or a real provider. */
describe.skipIf(process.platform === "win32")("StudioRuntime managed model startup (real vault, fake database boundary)", () => {
  const directories: string[] = [];
  const runtimes = new Set<StudioRuntime>();
  const pools: FakePool[] = [];
  let running = false;
  let tableMissing = false;
  let candidateTableMissing = false;
  let candidateOpen = false;
  // Automatic creation tables are absent unless a test says otherwise (servers before its migration).
  let autoTableMissing = true;
  let autoRunning = false;
  let metadataFailure: Error | undefined;
  let queryFailure: Error | undefined;
  let outbound: ReturnType<typeof vi.fn>;
  let passwordHash = "";

  beforeAll(async () => {
    passwordHash = await hashPassword("test-only-production-site-password", { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 });
  });

  beforeEach(() => {
    running = false;
    tableMissing = false;
    candidateTableMissing = false;
    candidateOpen = false;
    autoTableMissing = true;
    autoRunning = false;
    metadataFailure = undefined;
    queryFailure = undefined;
    vi.spyOn(RuntimeStore.prototype, "requireActiveWorkspace").mockResolvedValue(WORKSPACE);
    vi.spyOn(PostgresTitleWritingStore.prototype, "storageReady").mockResolvedValue(true);
    // The provider migration is applied in this fake database; its own readiness query is covered by the store acceptance.
    vi.spyOn(PostgresTitleWritingStore.prototype, "providerStorageReady").mockResolvedValue(true);
    vi.mocked(createPostgresPool).mockImplementation(() => {
      const pool: FakePool = {
        query: vi.fn(async (sql: string, values?: unknown[]) => {
          if (sql.includes("to_regclass") && sql.includes("title_writing_run")) {
            if (metadataFailure) throw metadataFailure;
            return { rows: [{ missing: tableMissing }] };
          }
          // The activation check also waits for open online candidates (they send with the active configuration).
          if (sql.includes("to_regclass('writing_candidate_request') IS NULL")) {
            if (metadataFailure) throw metadataFailure;
            return { rows: [{ missing: candidateTableMissing }] };
          }
          if (sql.includes("FROM writing_candidate_request") && sql.includes("state IN ('reserved', 'submitted')") && values?.[0] === WORKSPACE) {
            if (queryFailure) throw queryFailure;
            return { rows: [{ open: candidateOpen }] };
          }
          // The activation check also waits for running automatic creation runs.
          if (sql.includes("to_regclass('auto_creation_run') IS NULL")) {
            if (metadataFailure) throw metadataFailure;
            return { rows: [{ missing: autoTableMissing }] };
          }
          if (sql.includes("FROM auto_creation_run") && sql.includes("state = 'running'") && values?.[0] === WORKSPACE) {
            if (queryFailure) throw queryFailure;
            return { rows: [{ running: autoRunning }] };
          }
          if (sql.includes("information_schema.columns")) {
            if (metadataFailure) throw metadataFailure;
            return { rows: tableMissing ? [] : Object.entries(TITLE_WRITING_TABLES).flatMap(([table, columns]) =>
              columns.map((column) => ({ table_name: table, column_name: column }))) };
          }
          if (!sql.includes("title_writing_run") || !sql.includes("state = 'running'") || values?.[0] !== WORKSPACE) {
            throw new Error("Unexpected database operation in no-database startup test");
          }
          if (queryFailure) throw queryFailure;
          return { rows: [{ running }] };
        }),
        connect: vi.fn(async () => { throw new Error("Database connections are forbidden in this startup wiring test"); }),
        end: vi.fn(async () => undefined),
        totalCount: 0,
      };
      pools.push(pool);
      return pool;
    });
    outbound = vi.fn(async () => { throw new Error("Provider network calls are forbidden in this startup wiring test"); });
    vi.stubGlobal("fetch", outbound);
  });

  afterEach(async () => {
    try {
      for (const runtime of runtimes) await runtime.onModuleDestroy();
      expect(outbound).not.toHaveBeenCalled();
    } finally {
      runtimes.clear();
      pools.splice(0);
      vi.restoreAllMocks();
      vi.mocked(createPostgresPool).mockReset();
      vi.unstubAllGlobals();
      await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
    }
  });

  async function environment(): Promise<ApiEnv> {
    const directory = await mkdtemp(join(tmpdir(), "ads-admin-runtime-"));
    await chmod(directory, 0o700);
    directories.push(directory);
    return loadApiEnv({
      ...BASE, MODEL_ADMIN_ENABLED: "true",
      MODEL_ADMIN_MASTER_KEY: randomBytes(32).toString("hex"), MODEL_ADMIN_CONFIG_PATH: join(directory, "models.enc"),
    });
  }

  async function open(env: ApiEnv): Promise<StudioRuntime> {
    const runtime = await StudioRuntime.open(env);
    runtimes.add(runtime);
    return runtime;
  }

  async function close(runtime: StudioRuntime): Promise<void> {
    await runtime.onModuleDestroy();
    runtimes.delete(runtime);
  }

  async function options(runtime: StudioRuntime): Promise<TitleWritingOptionsView> {
    const result = await runtime.titleWriting!.options();
    expect(result.status).toBe(200);
    expect(JSON.stringify(result.body)).not.toContain(LEGACY_KEY);
    expect(JSON.stringify(result.body)).not.toContain(SAVED_KEY);
    return result.body as TitleWritingOptionsView;
  }

  async function savePending(env: ApiEnv) {
    const current = await open(env);
    await current.adminModels!.updateProvider("openai", {
      expectedRevision: 0, models: ["managed-openai-model"], secretAction: "replace", apiKey: SAVED_KEY,
    });
    await current.adminModels!.updateLimits({
      expectedRevision: 1, defaultProvider: "openai", maxCallsPerDay: 8, maxActiveRuns: 2,
    });
    // Saving must not mutate the already-instantiated service or execution engine's provider/caps.
    expect(await options(current)).toMatchObject({ defaultProvider: "anthropic", maxCallsPerDay: 30, maxActiveRuns: 1 });
    expect((await options(current)).providers.find((provider) => provider.providerKey === "openai")?.ready).toBe(false);
    await close(current);
  }

  it("defers a pending provider and limits when startup finds a running workspace task", async () => {
    const env = await environment();
    await savePending(env);
    running = true;
    const restarted = await open(env);
    const view = await options(restarted);
    expect(view).toMatchObject({ enabled: true, defaultProvider: "anthropic", maxCallsPerDay: 30, maxActiveRuns: 1 });
    expect(view.providers.find((provider) => provider.providerKey === "anthropic")?.models).toEqual(["environment-claude-model"]);
    expect(view.providers.find((provider) => provider.providerKey === "openai")?.ready).toBe(false);
    expect(await restarted.adminModels!.view()).toMatchObject({
      pendingRestart: true, activationDeferred: true, activeRevision: 0, savedRevision: 2,
    });
    expect(pools.at(-1)!.query).toHaveBeenCalledTimes(2);
    expect(pools.at(-1)!.query.mock.calls.find(([sql]) => sql.includes("state = 'running'"))?.[1]).toEqual([WORKSPACE]);
  });

  it("uses pending provider and limits in the actual title service only after an idle restart", async () => {
    const env = await environment();
    await savePending(env);
    running = true;
    const busy = await open(env);
    await close(busy);
    running = false;
    const idle = await open(env);
    const view = await options(idle);
    expect(view).toMatchObject({ enabled: true, defaultProvider: "openai", maxCallsPerDay: 8, maxActiveRuns: 2 });
    expect(view.providers.find((provider) => provider.providerKey === "openai")).toMatchObject({ ready: true, models: ["managed-openai-model"] });
    expect(await idle.adminModels!.view()).toMatchObject({ pendingRestart: false, activationDeferred: false, activeRevision: 2, savedRevision: 2 });
  });

  it("keeps managed configuration effective when admin login is disabled, and retains production blocking", async () => {
    const env = await environment();
    await savePending(env);
    const runtime = await open({ ...env, MODEL_ADMIN_ENABLED: "false", NODE_ENV: "production" });
    expect(runtime.adminConsoleEnabled).toBe(false);
    expect(runtime.adminModels).not.toBeNull();
    expect(await options(runtime)).toMatchObject({
      enabled: false, code: "TITLE_WRITING_DISABLED", defaultProvider: "openai", maxCallsPerDay: 8, maxActiveRuns: 2,
    });
  });

  it.each([
    [true, "true", "true", true, false],
    [false, "true", "true", false, true],
    [true, "false", "true", false, true],
    [true, "true", "false", false, false],
  ] as const)("projects actual production authorization in the model console (%s, %s, %s)",
    async (allowProduction, siteLogin, enabledSwitch, enabled, productionBlocked) => {
      const env = await environment();
      const runtime = await open({ ...env, NODE_ENV: "production", TITLE_WRITING_ALLOW_PRODUCTION: allowProduction,
        TITLE_WRITING_ENABLED: enabledSwitch === "true", SITE_AUTH_ENABLED: siteLogin, SITE_AUTH_PASSWORD_HASH: passwordHash,
        SITE_AUTH_PUBLIC_ORIGIN: "https://drama.example.test" });
      expect(await options(runtime)).toMatchObject({ enabled, code: enabled ? "TITLE_WRITING_READY" : "TITLE_WRITING_DISABLED" });
      // siteOperator: the site login (when valid) makes the signed-in administrator the operator.
      expect((await runtime.adminModels!.view()).titleWriting).toEqual({ enabled, productionBlocked, operatorConfigured: true, siteOperator: siteLogin === "true" });
    });

  it("leaves legacy environment configuration unchanged when admin bootstrap is absent", async () => {
    const runtime = await open(loadApiEnv(BASE));
    expect(runtime.adminConsoleEnabled).toBe(false);
    expect(runtime.adminModels).toBeNull();
    expect(await options(runtime)).toMatchObject({ defaultProvider: "anthropic", maxCallsPerDay: 30, maxActiveRuns: 1 });
    expect(pools.at(-1)!.query).not.toHaveBeenCalled();
  });

  it("fails closed on a corrupted vault and closes the startup database pool without installing timers", async () => {
    const env = await environment();
    await savePending(env);
    await writeFile(env.MODEL_ADMIN_CONFIG_PATH!, "corrupted private contents", { mode: 0o600 });
    const interval = vi.spyOn(globalThis, "setInterval");
    await expect(StudioRuntime.open(env)).rejects.toMatchObject({ code: "ADMIN_CONFIG_STORAGE_UNAVAILABLE" });
    expect(pools.at(-1)!.end).toHaveBeenCalledExactlyOnceWith();
    expect(pools.at(-1)!.query).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
  });

  it("does not activate pending settings when the running-task check fails, and closes the pool", async () => {
    const env = await environment();
    await savePending(env);
    queryFailure = new Error("unavailable database");
    await expect(StudioRuntime.open(env)).rejects.toMatchObject({ code: "ADMIN_CONFIG_STORAGE_UNAVAILABLE" });
    expect(pools.at(-1)!.end).toHaveBeenCalledExactlyOnceWith();
    queryFailure = undefined;
    running = true;
    const restarted = await open(env);
    expect(await options(restarted)).toMatchObject({ defaultProvider: "anthropic", maxCallsPerDay: 30 });
    expect((await restarted.adminModels!.view()).activeRevision).toBe(0);
  });

  it("does not treat a transient metadata query failure as an idle workspace", async () => {
    const env = await environment();
    await savePending(env);
    // Exercise the existing real storageReady() in the old startup implementation: it catches this error
    // and returns false. Returning true from the activation callback on that false used to apply pending settings.
    vi.mocked(PostgresTitleWritingStore.prototype.storageReady).mockRestore();
    metadataFailure = Object.assign(new Error("metadata query timed out"), { code: "57014" });
    const outcome = await open(env).then(() => "startup unexpectedly succeeded", (error: unknown) => error);
    expect(outcome).toMatchObject({ code: "ADMIN_CONFIG_STORAGE_UNAVAILABLE" });
    expect(pools.at(-1)!.end).toHaveBeenCalledExactlyOnceWith();
    expect(pools.at(-1)!.query.mock.calls.some(([sql]) => sql.includes("state = 'running'"))).toBe(false);

    // A subsequent healthy metadata read with a running task still sees the old active revision:
    // the failed startup must not have persisted the pending provider or lowered its call cap.
    metadataFailure = undefined;
    running = true;
    const recovered = await open(env);
    expect(await options(recovered)).toMatchObject({ defaultProvider: "anthropic", maxCallsPerDay: 30, maxActiveRuns: 1 });
    expect(await recovered.adminModels!.view()).toMatchObject({ activeRevision: 0, savedRevision: 2, activationDeferred: true });
  });

  it("allows activation only after the run table is positively confirmed absent", async () => {
    const env = await environment();
    await savePending(env);
    tableMissing = true;
    vi.mocked(PostgresTitleWritingStore.prototype.storageReady).mockResolvedValue(false);
    const runtime = await open(env);
    expect(await options(runtime)).toMatchObject({ storageReady: false, defaultProvider: "openai", maxCallsPerDay: 8, maxActiveRuns: 2 });
    expect(await runtime.adminModels!.view()).toMatchObject({ pendingRestart: false, activationDeferred: false, activeRevision: 2 });
    expect(pools.at(-1)!.query).toHaveBeenCalledTimes(1);
    expect(pools.at(-1)!.query.mock.calls[0]?.[0]).toContain("to_regclass");
    expect(pools.at(-1)!.query.mock.calls.some(([sql]) => sql.includes("state = 'running'"))).toBe(false);
  });

  it("defers activation while an automatic creation run is running, and applies it once none is", async () => {
    const env = await environment();
    await savePending(env);
    autoTableMissing = false;
    autoRunning = true;
    const deferred = await open(env);
    expect(await deferred.adminModels!.view()).toMatchObject({ activeRevision: 0, activationDeferred: true });
    await close(deferred);
    autoRunning = false;
    const applied = await open(env);
    expect(await applied.adminModels!.view()).toMatchObject({ activeRevision: 2, activationDeferred: false });
  });

  it("clears all maintenance timers and closes the pool on runtime teardown", async () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const clear = vi.spyOn(globalThis, "clearInterval");
    const runtime = await open(await environment());
    const timers = interval.mock.results.filter((result) => result.type === "return").map((result) => result.value);
    // Title writing recovery, online candidate recovery and automatic creation recovery.
    expect(timers).toHaveLength(3);
    await close(runtime);
    for (const timer of timers) expect(clear).toHaveBeenCalledWith(timer);
    expect(pools.at(-1)!.end).toHaveBeenCalledExactlyOnceWith();
  });

  it("starts on a vault saved by the released three-provider console: only OpenAI and Claude, no retired default, nothing sent", async () => {
    const env = await environment();
    const path = env.MODEL_ADMIN_CONFIG_PATH!;
    const masterKey = Buffer.from(env.MODEL_ADMIN_MASTER_KEY!, "hex");
    const settings = {
      revision: 1, defaultProvider: "qwen", maxCallsPerDay: 9, maxActiveRuns: 1,
      providers: {
        qwen: { apiKey: "sk-retired-qwen-secret-0123", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", models: ["qwen-old"] },
        openai: { apiKey: SAVED_KEY, baseUrl: "https://api.openai.com/v1/responses", models: ["managed-openai-model"] },
        deepseek: { apiKey: null, baseUrl: "https://api.deepseek.com/chat/completions", models: [] },
      },
    };
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", masterKey, nonce);
    cipher.setAAD(Buffer.from("ai-drama-studio.admin-model-vault.v1"));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ active: settings, saved: settings, audit: [] })), cipher.final()]);
    await writeFile(path, JSON.stringify({ format: "ai-drama-studio.admin-model-vault.v1", nonce: nonce.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }), { mode: 0o600 });
    await writeFile(`${path}.initialized`, "ai-drama-studio.admin-model-vault.v1.initialized\n", { mode: 0o600 });
    const runtime = await open(env);
    const view = await options(runtime);
    expect(view.providers.map((provider) => provider.providerKey)).toEqual(["openai", "anthropic", "deepseek"]);
    // DeepSeek is active again but its v1 key is never carried over: it waits for a new key from the console.
    expect(view.providers.find((provider) => provider.providerKey === "deepseek")).toMatchObject({ ready: false, missing: ["DEEPSEEK_API_KEY"] });
    // The retired default is not used, and nothing switches to it; the first ready active provider is offered instead.
    expect(view).toMatchObject({ defaultProvider: "openai", maxCallsPerDay: 9 });
    expect(view.providers.find((provider) => provider.providerKey === "anthropic")).toMatchObject({ ready: false, missing: ["ANTHROPIC_API_KEY"] });
    const admin = await runtime.adminModels!.view();
    expect(admin.retired).toEqual({ providers: ["qwen"], retiredDefault: "qwen", backupKept: false });
    expect(admin.saved.providers.map((provider) => provider.providerKey)).toEqual(["openai", "anthropic", "deepseek"]);
    expect(JSON.stringify(admin)).not.toContain("sk-retired-qwen-secret");
    expect(JSON.stringify(admin)).not.toContain(SAVED_KEY);
  });

  it("defers activation while an online candidate is still open, and applies it once none is", async () => {
    const env = await environment();
    await savePending(env);
    candidateOpen = true;
    const busy = await open(env);
    expect(await busy.adminModels!.view()).toMatchObject({ pendingRestart: true, activationDeferred: true, activeRevision: 0 });
    expect(await options(busy)).toMatchObject({ defaultProvider: "anthropic", maxCallsPerDay: 30 });
    await close(busy);
    candidateOpen = false;
    const idle = await open(env);
    expect(await idle.adminModels!.view()).toMatchObject({ pendingRestart: false, activationDeferred: false, activeRevision: 2 });
    // A database without the candidate table has no open candidate either.
    candidateTableMissing = true;
    await close(idle);
    expect((await (await open(env)).adminModels!.view()).activeRevision).toBe(2);
  });

  it("a DeepSeek key saved in the console is applied only at the next idle start, becomes the default and is never sent here", async () => {
    const env = await environment();
    const current = await open(env);
    const saved = await current.adminModels!.updateProvider("deepseek", { expectedRevision: 0, models: [], secretAction: "replace",
      apiKey: "fake-deepseek-runtime-key-0123456789" });
    expect(saved).toMatchObject({ pendingRestart: true, savedRevision: 1 });
    expect(saved.saved.defaultProvider).toBe("deepseek");
    expect(saved.saved.providers.find((provider) => provider.providerKey === "deepseek")).toMatchObject({ keyConfigured: true, models: ["deepseek-flash"] });
    expect(JSON.stringify(saved)).not.toContain("fake-deepseek-runtime-key");
    // The running service keeps its configuration until the restart.
    expect((await options(current)).providers.find((provider) => provider.providerKey === "deepseek")).toMatchObject({ ready: false });
    await close(current);
    const restarted = await open(env);
    const view = await options(restarted);
    expect(view.defaultProvider).toBe("deepseek");
    expect(view.providers.find((provider) => provider.providerKey === "deepseek")).toMatchObject({ ready: true, models: ["deepseek-flash"], missing: [] });
    // Claude from the environment seed is kept as it was.
    expect(view.providers.find((provider) => provider.providerKey === "anthropic")).toMatchObject({ ready: true, models: ["environment-claude-model"] });
    expect(JSON.stringify(view)).not.toContain("fake-deepseek-runtime-key");
  });

  it("starts with a retired default provider in the environment and offers no default until one is chosen", async () => {
    const runtime = await open(loadApiEnv({ ...BASE, TITLE_WRITING_DEFAULT_PROVIDER: "qwen", ANTHROPIC_API_KEY: undefined }));
    expect(await options(runtime)).toMatchObject({ code: "TITLE_WRITING_PROVIDER_UNCONFIGURED", defaultProvider: null });
  });
});
