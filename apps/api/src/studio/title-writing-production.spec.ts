import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPostgresPool, PostgresTitleWritingStore, RuntimeStore, type PostgresPool,
} from "@ai-drama/database";
import { newScriptBreakdownRun, newTitleRun, type TitleRunBundle } from "@ai-drama/providers";
import { hashPassword } from "../auth/password-hash";
import { loadApiEnv } from "../config/env";
import { StudioRuntime } from "./studio.runtime";

vi.mock("@ai-drama/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ai-drama/database")>();
  return { ...actual, createPostgresPool: vi.fn() };
});

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const EPISODE = "33333333-3333-4333-8333-333333333333";
const TOKEN = "test-only-production-writing-token";
const BASE = {
  NODE_ENV: "production", DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/no-database",
  REDIS_URL: "redis://127.0.0.1:1", S3_ENDPOINT: "http://127.0.0.1:1", S3_REGION: "us-east-1",
  S3_BUCKET: "test", S3_ACCESS_KEY_ID: "unused", S3_SECRET_ACCESS_KEY: "unused", APP_WORKSPACE_ID: WORKSPACE,
  TITLE_WRITING_ENABLED: "true", TITLE_WRITING_OPERATOR_TOKEN: TOKEN, TITLE_WRITING_DEFAULT_PROVIDER: "deepseek",
  TITLE_WRITING_MAX_CALLS_PER_DAY: "3", TITLE_WRITING_MAX_ACTIVE_RUNS: "1",
  DEEPSEEK_API_KEY: "sk-test-only-production-writing", TITLE_WRITING_DEEPSEEK_MODELS: "test-only-deepseek-model",
};
let passwordHash = "";

beforeAll(async () => {
  passwordHash = await hashPassword("test-only-login-password", { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 });
});

/** Real startup, services and shared engine; only the database boundary is replaced. No provider send is permitted. */
describe("production title writing authorization through StudioRuntime.open", () => {
  const runtimes = new Set<StudioRuntime>();
  let outbound: ReturnType<typeof vi.fn>;
  let databaseQuery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.spyOn(RuntimeStore.prototype, "requireActiveWorkspace").mockResolvedValue(WORKSPACE);
    vi.spyOn(RuntimeStore.prototype, "episodePlanReady").mockResolvedValue(true);
    vi.spyOn(PostgresTitleWritingStore.prototype, "storageReady").mockResolvedValue(true);
    vi.spyOn(PostgresTitleWritingStore.prototype, "breakdownStorageReady").mockResolvedValue(false);
    databaseQuery = vi.fn(async () => { throw new Error("Unexpected database access in startup wiring test"); });
    vi.mocked(createPostgresPool).mockReturnValue({
      query: databaseQuery,
      connect: vi.fn(async () => { throw new Error("Database connections are forbidden in startup wiring test"); }),
      end: vi.fn(async () => undefined), totalCount: 0,
    } as unknown as PostgresPool);
    outbound = vi.fn(async () => { throw new Error("Provider calls are forbidden in startup wiring test"); });
    vi.stubGlobal("fetch", outbound);
  });

  afterEach(async () => {
    try {
      for (const runtime of runtimes) await runtime.onModuleDestroy();
      expect(outbound).not.toHaveBeenCalled();
      expect(databaseQuery).not.toHaveBeenCalled();
    } finally {
      runtimes.clear();
      vi.restoreAllMocks();
      vi.mocked(createPostgresPool).mockReset();
      vi.unstubAllGlobals();
    }
  });

  async function open(overrides: Record<string, string | undefined> = {}) {
    const runtime = await StudioRuntime.open(loadApiEnv({
      ...BASE, SITE_AUTH_ENABLED: "true", SITE_AUTH_PASSWORD_HASH: passwordHash,
      SITE_AUTH_PUBLIC_ORIGIN: "https://drama.example.test", ...overrides,
    }));
    runtimes.add(runtime);
    return runtime;
  }

  it.each([
    ["authorization unset", {}, false],
    ["authorization false", { TITLE_WRITING_ALLOW_PRODUCTION: "false" }, false],
    ["base switch off", { TITLE_WRITING_ALLOW_PRODUCTION: "true", TITLE_WRITING_ENABLED: "false" }, false],
    ["login unset", { TITLE_WRITING_ALLOW_PRODUCTION: "true", SITE_AUTH_ENABLED: undefined }, false],
    ["login disabled", { TITLE_WRITING_ALLOW_PRODUCTION: "true", SITE_AUTH_ENABLED: "false" }, false],
    ["invalid login switch", { TITLE_WRITING_ALLOW_PRODUCTION: "true", SITE_AUTH_ENABLED: "yes" }, false],
    ["password missing", { TITLE_WRITING_ALLOW_PRODUCTION: "true", SITE_AUTH_PASSWORD_HASH: undefined }, false],
    ["password invalid", { TITLE_WRITING_ALLOW_PRODUCTION: "true", SITE_AUTH_PASSWORD_HASH: "invalid" }, false],
    ["origin missing", { TITLE_WRITING_ALLOW_PRODUCTION: "true", SITE_AUTH_PUBLIC_ORIGIN: undefined }, false],
    ["insecure origin", { TITLE_WRITING_ALLOW_PRODUCTION: "true", SITE_AUTH_PUBLIC_ORIGIN: "http://127.0.0.1:3001" }, false],
    ["explicit authorization and valid login", { TITLE_WRITING_ALLOW_PRODUCTION: "true" }, true],
    ["breakdown switch on", { TITLE_WRITING_ALLOW_PRODUCTION: "true", SCRIPT_BREAKDOWN_ENABLED: "true" }, true],
  ] as const)("%s", async (_label, overrides, enabled) => {
    const runtime = await open(overrides);
    expect((await runtime.titleWriting!.options()).body).toMatchObject({
      enabled, code: enabled ? "TITLE_WRITING_READY" : "TITLE_WRITING_DISABLED",
      defaultProvider: "deepseek", storageReady: true, episodePlanReady: true,
      maxCallsPerDay: 3, maxActiveRuns: 1,
    });
    expect((await runtime.scriptBreakdown!.options()).body).toMatchObject({ enabled: false, code: "TITLE_WRITING_DISABLED" });
    if (!enabled) {
      expect(await runtime.titleWriting!.start(PROJECT, { title: "夜班证词" }, TOKEN,
        { actorId: "owner", traceId: "test", idempotencyKey: "blocked-start" }))
        .toMatchObject({ status: 404, body: { error: { code: "TITLE_WRITING_DISABLED" } } });
      expect(await runtime.titleWriting!.resume(PROJECT, EPISODE, {}, TOKEN,
        { actorId: "owner", traceId: "test", idempotencyKey: "blocked-resume" }))
        .toMatchObject({ status: 404, body: { error: { code: "TITLE_WRITING_DISABLED" } } });
    }
  });

  it("retains the operator gate on both start and resume after production authorization", async () => {
    const runtime = await open({ TITLE_WRITING_ALLOW_PRODUCTION: "true" });
    for (const token of [undefined, "wrong-operator-token"]) {
      expect(await runtime.titleWriting!.start(PROJECT, { title: "夜班证词" }, token,
        { actorId: "owner", traceId: "test", idempotencyKey: "wrong-token-start" }))
        .toMatchObject({ status: 403, body: { error: { code: "TITLE_WRITING_FORBIDDEN" } } });
      expect(await runtime.titleWriting!.resume(PROJECT, EPISODE, {}, token,
        { actorId: "owner", traceId: "test", idempotencyKey: "wrong-token-resume" }))
        .toMatchObject({ status: 403, body: { error: { code: "TITLE_WRITING_FORBIDDEN" } } });
    }
  });

  it("filters recovery to title runs and refuses a breakdown even if a store returns it", async () => {
    const runtime = await open({ TITLE_WRITING_ALLOW_PRODUCTION: "true" });
    const title = newTitleRun({ workspaceId: WORKSPACE, projectId: PROJECT, actorId: "owner", idempotencyKey: "title",
      title: "夜班证词", settings: { episodeCount: 1, episodeSeconds: 90, style: "" }, providerKey: "deepseek",
      model: "test-only-deepseek-model", now: new Date(), version: 2 });
    const breakdown = newScriptBreakdownRun({ workspaceId: WORKSPACE, projectId: PROJECT, actorId: "owner",
      idempotencyKey: "breakdown", requestHash: "a".repeat(64), now: new Date(), input: {
        episodeId: EPISODE, episodeNo: 1, scriptRevisionId: EPISODE, scriptRevisionNo: 1, scriptContentHash: "b".repeat(64),
        scriptText: "已有剧本", targetEpisodeSeconds: 90, characters: [], replace: { scenes: [], shots: [] },
        providerKey: "deepseek", model: "test-only-deepseek-model",
      } });
    const recover = vi.spyOn(PostgresTitleWritingStore.prototype, "recoverExpired").mockResolvedValue(0);
    const list = vi.spyOn(PostgresTitleWritingStore.prototype, "listClaimable").mockResolvedValue([breakdown.id, title.id]);
    vi.spyOn(PostgresTitleWritingStore.prototype, "getRunById").mockImplementation(async (workspaceId, id): Promise<TitleRunBundle | null> => {
      const run = [title, breakdown].find((item) => item.id === id && item.workspaceId === workspaceId);
      return run ? { run, steps: [], calls: [] } : null;
    });
    const claim = vi.spyOn(PostgresTitleWritingStore.prototype, "claimRun").mockResolvedValue(false);
    const reserve = vi.spyOn(PostgresTitleWritingStore.prototype, "reserveCall");
    const retire = vi.spyOn(PostgresTitleWritingStore.prototype, "retireDisabledRuns").mockResolvedValue(1);
    await runtime.titleWriting!.maintain();
    expect(recover).toHaveBeenCalledOnce();
    expect(retire).toHaveBeenCalledExactlyOnceWith(WORKSPACE, expect.any(String), ["script_breakdown"]);
    expect(list).toHaveBeenCalledWith(WORKSPACE, expect.any(String), 5, ["title"]);
    expect(claim.mock.calls.map((args) => args[1])).toEqual([title.id]);
    expect(reserve).not.toHaveBeenCalled();
    expect(await runtime.scriptBreakdown!.start(PROJECT, { episodeId: EPISODE }, TOKEN,
      { actorId: "owner", traceId: "test", idempotencyKey: "breakdown-start" }))
      .toMatchObject({ status: 404, body: { error: { code: "TITLE_WRITING_DISABLED" } } });
  });

  it.each([undefined, "false"])("does not execute recovery with production authorization %s", async (authorization) => {
    const runtime = await open({ TITLE_WRITING_ALLOW_PRODUCTION: authorization });
    const recover = vi.spyOn(PostgresTitleWritingStore.prototype, "recoverExpired").mockResolvedValue(0);
    const list = vi.spyOn(PostgresTitleWritingStore.prototype, "listClaimable");
    const claim = vi.spyOn(PostgresTitleWritingStore.prototype, "claimRun");
    const retire = vi.spyOn(PostgresTitleWritingStore.prototype, "retireDisabledRuns");
    await runtime.titleWriting!.maintain();
    expect(recover).toHaveBeenCalledOnce();
    expect(retire).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it.each(["development", "test"])("retains both run kinds in %s when both switches are on, without authorization or login", async (nodeEnv) => {
    const runtime = await open({ NODE_ENV: nodeEnv, SITE_AUTH_ENABLED: undefined, SCRIPT_BREAKDOWN_ENABLED: "true" });
    expect((await runtime.titleWriting!.options()).body).toMatchObject({ enabled: true });
    expect((await runtime.scriptBreakdown!.options()).body).toMatchObject({ enabled: true });
    vi.spyOn(PostgresTitleWritingStore.prototype, "recoverExpired").mockResolvedValue(0);
    const list = vi.spyOn(PostgresTitleWritingStore.prototype, "listClaimable").mockResolvedValue([]);
    const retire = vi.spyOn(PostgresTitleWritingStore.prototype, "retireDisabledRuns");
    await runtime.titleWriting!.maintain();
    expect(retire).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledWith(WORKSPACE, expect.any(String), 5, ["title", "script_breakdown"]);
  });

  describe.each(["development", "test"])("script breakdown switch in %s", (nodeEnv) => {
    const local = { NODE_ENV: nodeEnv, SITE_AUTH_ENABLED: undefined };

    it.each([
      ["unset", {}],
      ["false", { SCRIPT_BREAKDOWN_ENABLED: "false" }],
    ] as const)("offers only title writing when the breakdown switch is %s", async (_label, overrides) => {
      const runtime = await open({ ...local, ...overrides });
      expect((await runtime.titleWriting!.options()).body).toMatchObject({ enabled: true, code: "TITLE_WRITING_READY" });
      expect((await runtime.scriptBreakdown!.options()).body).toMatchObject({ enabled: false, code: "TITLE_WRITING_DISABLED" });
      expect(await runtime.scriptBreakdown!.start(PROJECT, EPISODE, {}, TOKEN,
        { actorId: "owner", traceId: "test", idempotencyKey: "breakdown-start" }))
        .toMatchObject({ status: 404, body: { error: { code: "TITLE_WRITING_DISABLED" } } });
      expect(await runtime.scriptBreakdown!.resume(PROJECT, EPISODE, EPISODE, {}, TOKEN,
        { actorId: "owner", traceId: "test", idempotencyKey: "breakdown-resume" }))
        .toMatchObject({ status: 404, body: { error: { code: "TITLE_WRITING_DISABLED" } } });
    });

    it("filters recovery to title runs while the breakdown switch is off", async () => {
      const runtime = await open(local);
      const breakdown = newScriptBreakdownRun({ workspaceId: WORKSPACE, projectId: PROJECT, actorId: "owner",
        idempotencyKey: "breakdown", requestHash: "a".repeat(64), now: new Date(), input: {
          episodeId: EPISODE, episodeNo: 1, scriptRevisionId: EPISODE, scriptRevisionNo: 1, scriptContentHash: "b".repeat(64),
          scriptText: "已有剧本", targetEpisodeSeconds: 90, characters: [], replace: { scenes: [], shots: [] },
          providerKey: "deepseek", model: "test-only-deepseek-model",
        } });
      vi.spyOn(PostgresTitleWritingStore.prototype, "recoverExpired").mockResolvedValue(0);
      const list = vi.spyOn(PostgresTitleWritingStore.prototype, "listClaimable").mockResolvedValue([breakdown.id]);
      vi.spyOn(PostgresTitleWritingStore.prototype, "getRunById").mockImplementation(async (workspaceId, id): Promise<TitleRunBundle | null> =>
        breakdown.id === id && breakdown.workspaceId === workspaceId ? { run: breakdown, steps: [], calls: [] } : null);
      const claim = vi.spyOn(PostgresTitleWritingStore.prototype, "claimRun").mockResolvedValue(false);
      const reserve = vi.spyOn(PostgresTitleWritingStore.prototype, "reserveCall");
      const retire = vi.spyOn(PostgresTitleWritingStore.prototype, "retireDisabledRuns").mockResolvedValue(1);
      await runtime.titleWriting!.maintain();
      // Unheld breakdowns are stopped without a send before claimable runs are listed.
      expect(retire).toHaveBeenCalledExactlyOnceWith(WORKSPACE, expect.any(String), ["script_breakdown"]);
      expect(retire.mock.invocationCallOrder[0]).toBeLessThan(list.mock.invocationCallOrder[0]!);
      expect(list).toHaveBeenCalledWith(WORKSPACE, expect.any(String), 5, ["title"]);
      // Even a store that returns a breakdown run cannot get it claimed by the shared engine.
      expect(claim).not.toHaveBeenCalled();
      expect(reserve).not.toHaveBeenCalled();
    });

    it("turns both off when title writing is off, whatever the breakdown switch says", async () => {
      const runtime = await open({ ...local, TITLE_WRITING_ENABLED: "false", SCRIPT_BREAKDOWN_ENABLED: "true" });
      expect((await runtime.titleWriting!.options()).body).toMatchObject({ enabled: false, code: "TITLE_WRITING_DISABLED" });
      expect((await runtime.scriptBreakdown!.options()).body).toMatchObject({ enabled: false, code: "TITLE_WRITING_DISABLED" });
      vi.spyOn(PostgresTitleWritingStore.prototype, "recoverExpired").mockResolvedValue(0);
      const list = vi.spyOn(PostgresTitleWritingStore.prototype, "listClaimable");
      const retire = vi.spyOn(PostgresTitleWritingStore.prototype, "retireDisabledRuns");
      await runtime.titleWriting!.maintain();
      expect(retire).not.toHaveBeenCalled();
      expect(list).not.toHaveBeenCalled();
    });
  });
});
