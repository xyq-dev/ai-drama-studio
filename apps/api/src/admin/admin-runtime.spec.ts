import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPostgresPool, PostgresTitleWritingStore, RuntimeStore, TITLE_WRITING_TABLES, type PostgresPool,
} from "@ai-drama/database";
import type { TitleWritingOptionsView } from "@ai-drama/contracts";
import { loadApiEnv, type ApiEnv } from "../config/env";
import { StudioRuntime } from "../studio/studio.runtime";

vi.mock("@ai-drama/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ai-drama/database")>();
  return { ...actual, createPostgresPool: vi.fn() };
});

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const LEGACY_KEY = "sk-test-legacy-qwen-secret";
const SAVED_KEY = "sk-test-managed-openai-secret";
const BASE = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/no-database",
  REDIS_URL: "redis://127.0.0.1:1", S3_ENDPOINT: "http://127.0.0.1:1", S3_REGION: "us-east-1",
  S3_BUCKET: "test", S3_ACCESS_KEY_ID: "unused", S3_SECRET_ACCESS_KEY: "unused", APP_WORKSPACE_ID: WORKSPACE,
  TITLE_WRITING_ENABLED: "true", TITLE_WRITING_OPERATOR_TOKEN: "test-only-title-operator-token",
  TITLE_WRITING_DEFAULT_PROVIDER: "qwen", TITLE_WRITING_MAX_CALLS_PER_DAY: "30", TITLE_WRITING_MAX_ACTIVE_RUNS: "1",
  DASHSCOPE_API_KEY: LEGACY_KEY,
  BAILIAN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  TITLE_WRITING_QWEN_MODELS: "legacy-qwen-model",
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
  let metadataFailure: Error | undefined;
  let queryFailure: Error | undefined;
  let outbound: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    running = false;
    tableMissing = false;
    metadataFailure = undefined;
    queryFailure = undefined;
    vi.spyOn(RuntimeStore.prototype, "requireActiveWorkspace").mockResolvedValue(WORKSPACE);
    vi.spyOn(PostgresTitleWritingStore.prototype, "storageReady").mockResolvedValue(true);
    vi.mocked(createPostgresPool).mockImplementation(() => {
      const pool: FakePool = {
        query: vi.fn(async (sql: string, values?: unknown[]) => {
          if (sql.includes("to_regclass") && sql.includes("title_writing_run")) {
            if (metadataFailure) throw metadataFailure;
            return { rows: [{ missing: tableMissing }] };
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
    expect(await options(current)).toMatchObject({ defaultProvider: "qwen", maxCallsPerDay: 30, maxActiveRuns: 1 });
    expect((await options(current)).providers.find((provider) => provider.providerKey === "openai")?.ready).toBe(false);
    await close(current);
  }

  it("defers a pending provider and limits when startup finds a running workspace task", async () => {
    const env = await environment();
    await savePending(env);
    running = true;
    const restarted = await open(env);
    const view = await options(restarted);
    expect(view).toMatchObject({ enabled: true, defaultProvider: "qwen", maxCallsPerDay: 30, maxActiveRuns: 1 });
    expect(view.providers.find((provider) => provider.providerKey === "qwen")?.models).toEqual(["legacy-qwen-model"]);
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

  it("leaves legacy environment configuration unchanged when admin bootstrap is absent", async () => {
    const runtime = await open(loadApiEnv(BASE));
    expect(runtime.adminConsoleEnabled).toBe(false);
    expect(runtime.adminModels).toBeNull();
    expect(await options(runtime)).toMatchObject({ defaultProvider: "qwen", maxCallsPerDay: 30, maxActiveRuns: 1 });
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
    expect(await options(restarted)).toMatchObject({ defaultProvider: "qwen", maxCallsPerDay: 30 });
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
    expect(await options(recovered)).toMatchObject({ defaultProvider: "qwen", maxCallsPerDay: 30, maxActiveRuns: 1 });
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

  it("clears all maintenance timers and closes the pool on runtime teardown", async () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const clear = vi.spyOn(globalThis, "clearInterval");
    const runtime = await open(await environment());
    const timers = interval.mock.results.filter((result) => result.type === "return").map((result) => result.value);
    expect(timers).toHaveLength(1);
    await close(runtime);
    for (const timer of timers) expect(clear).toHaveBeenCalledWith(timer);
    expect(pools.at(-1)!.end).toHaveBeenCalledExactlyOnceWith();
  });
});
