import { describe, expect, it } from "vitest";
import { PersistenceError } from "@ai-drama/database";
import {
  InMemoryTitleWritingStore,
  TitleWritingEngine,
  titleWritingProviderConfigs,
  type TitleWritingProviderEnv,
  type WritingTransport,
} from "@ai-drama/providers";
import { fixtureChatTransport, type FixtureExchange, type FixtureStep } from "@ai-drama/providers/title-writing-fixtures";
import { loadApiEnv } from "../config/env";
import { TitleWritingService } from "./title-writing.service";

const WS = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222222";
const P2 = "33333333-3333-4333-8333-333333333333";
const MISSING = "44444444-4444-4444-8444-444444444444";
const TOKEN = "operator-token-0123456789";
const SECRET = "sk-live-secret-abcdefghijkl";
const CONFIGURED: TitleWritingProviderEnv = {
  DASHSCOPE_API_KEY: SECRET, BAILIAN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1", TITLE_WRITING_QWEN_MODELS: "q-1,q-2",
  DEEPSEEK_API_KEY: SECRET, TITLE_WRITING_DEEPSEEK_MODELS: "d-1",
};
const CONTEXT = (key?: string) => ({ actorId: "server-owner", traceId: "t", ...(key ? { idempotencyKey: key } : {}) });

function setup(options: {
  enabled?: boolean;
  nodeEnv?: "development" | "test" | "production";
  env?: TitleWritingProviderEnv;
  storageReady?: boolean;
  override?: (step: FixtureStep, attempt: number) => { status: number; body: unknown } | "hang" | "throw" | undefined;
  operatorToken?: string | null;
} = {}) {
  const store = new InMemoryTitleWritingStore();
  store.ready = options.storageReady ?? true;
  store.addProject(WS, P1);
  store.addProject(WS, P2);
  const seen: FixtureExchange[] = [];
  const providers = titleWritingProviderConfigs(options.env ?? CONFIGURED);
  const transport: WritingTransport = fixtureChatTransport("夜班证词", { seen, ...(options.override ? { override: options.override } : {}) });
  const engine = new TitleWritingEngine({ workspaceId: WS, store, providers, transport, maxCallsPerDay: 30, timeoutMs: 20 });
  const pending: Array<Promise<void>> = [];
  const service = new TitleWritingService({
    workspaceId: WS,
    nodeEnv: options.nodeEnv ?? "test",
    enabled: options.enabled ?? true,
    operatorToken: options.operatorToken === undefined ? TOKEN : options.operatorToken,
    defaultProvider: null,
    providers,
    store,
    engine,
    projects: {
      getProject: async (_workspaceId: string, projectId: string) => {
        if (projectId !== P1 && projectId !== P2) throw new PersistenceError("NOT_FOUND", "Project not found");
        return { id: projectId } as never;
      },
    },
    maxCallsPerDay: 30,
    maxActiveRuns: 1,
    schedule: (work) => { pending.push(work()); },
  });
  const settle = async () => { while (pending.length > 0) await pending.shift(); };
  return { store, service, seen, settle };
}

function errorCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } }).error?.code;
}

describe("title writing options", () => {
  it("lists providers, models and missing variable names without any secret value", async () => {
    const { service } = setup({ env: { ...CONFIGURED, OPENAI_API_KEY: undefined } });
    const result = await service.options();
    const body = result.body as { code: string; providers: Array<{ providerKey: string; ready: boolean; models: string[]; missing: string[] }> };
    expect(body.code).toBe("TITLE_WRITING_READY");
    expect(body.providers).toEqual([
      expect.objectContaining({ providerKey: "qwen", ready: true, models: ["q-1", "q-2"], missing: [] }),
      expect.objectContaining({ providerKey: "openai", ready: false, missing: ["OPENAI_API_KEY", "TITLE_WRITING_OPENAI_MODELS"] }),
      expect.objectContaining({ providerKey: "deepseek", ready: true, models: ["d-1"] }),
    ]);
    expect(JSON.stringify(result.body)).not.toContain(SECRET);
    expect(JSON.stringify(result.body)).not.toContain(TOKEN);
  });

  it("reports what is missing instead of pretending to be ready", async () => {
    expect((await setup({ enabled: false }).service.options()).body).toMatchObject({ code: "TITLE_WRITING_DISABLED", enabled: false });
    expect((await setup({ nodeEnv: "production" }).service.options()).body).toMatchObject({ code: "TITLE_WRITING_DISABLED" });
    expect((await setup({ storageReady: false }).service.options()).body).toMatchObject({ code: "TITLE_WRITING_STORAGE_UNAVAILABLE" });
    expect((await setup({ env: {} }).service.options()).body).toMatchObject({ code: "TITLE_WRITING_PROVIDER_UNCONFIGURED", defaultProvider: null });
  });
});

describe("starting a run", () => {
  it("starts from the title alone and the run completes on the server", async () => {
    const { service, settle, seen, store } = setup();
    const result = await service.start(P1, { title: "夜班证词" }, TOKEN, CONTEXT("k1"));
    expect(result.status).toBe(201);
    await settle();
    const latest = await service.latest(P1);
    const run = (latest.body as { run: { state: string; storySave: string; providerKey: string; model: string } }).run;
    expect(run).toMatchObject({ state: "completed", storySave: "saved", providerKey: "qwen", model: "q-1" });
    expect(seen).toHaveLength(5);
    expect(store.projects.get(P1)!.stories[0]?.reviewStatus).toBe("DRAFT");
    const text = JSON.stringify(latest.body);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("k1");
    expect(text).not.toContain("executor");
  });

  it.each([
    ["switch off", { enabled: false }, TOKEN, 404, "TITLE_WRITING_DISABLED"],
    ["production", { nodeEnv: "production" as const }, TOKEN, 404, "TITLE_WRITING_DISABLED"],
    ["wrong token", {}, "wrong-token-000000000", 403, "TITLE_WRITING_FORBIDDEN"],
    ["no token configured", { operatorToken: null }, TOKEN, 403, "TITLE_WRITING_FORBIDDEN"],
    ["storage missing", { storageReady: false }, TOKEN, 503, "TITLE_WRITING_STORAGE_UNAVAILABLE"],
    ["no provider configured", { env: {} }, TOKEN, 503, "TITLE_WRITING_PROVIDER_UNCONFIGURED"],
  ])("refuses before any reservation or send: %s", async (_label, options, token, status, code) => {
    const { service, seen, store, settle } = setup(options);
    const result = await service.start(P1, { title: "夜班证词" }, token, CONTEXT("k"));
    await settle();
    expect(result.status).toBe(status);
    expect(errorCode(result.body)).toBe(code);
    expect(store.runs).toHaveLength(0);
    expect(seen).toHaveLength(0);
  });

  it("names the missing variables of the chosen provider and never falls back to another one", async () => {
    const { service, seen, store } = setup();
    const result = await service.start(P1, { title: "夜班证词", providerKey: "openai" }, TOKEN, CONTEXT("k"));
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ error: { code: "TITLE_WRITING_PROVIDER_UNCONFIGURED", details: { providerKey: "openai",
      missing: ["OPENAI_API_KEY", "TITLE_WRITING_OPENAI_MODELS"] } } });
    expect(store.runs).toHaveLength(0);
    expect(seen).toHaveLength(0);
  });

  it("accepts only allowlisted models and needs an idempotency key and a valid title", async () => {
    const { service, store } = setup();
    expect((await service.start(P1, { title: "x", model: "gpt-unknown" }, TOKEN, CONTEXT("k"))).body)
      .toMatchObject({ error: { code: "TITLE_WRITING_MODEL_UNAVAILABLE" } });
    expect((await service.start(P1, { title: "x" }, TOKEN, CONTEXT())).status).toBe(400);
    expect((await service.start(P1, { title: "   " }, TOKEN, CONTEXT("k"))).status).toBe(400);
    expect((await service.start(P1, { title: "x", premise: "not accepted here" }, TOKEN, CONTEXT("k"))).status).toBe(400);
    expect((await service.start(P1, { title: "x", settings: { episodeCount: 5 } }, TOKEN, CONTEXT("k"))).status).toBe(400);
    expect(store.runs).toHaveLength(0);
  });

  it("uses a chosen provider and model from the allowlist", async () => {
    const { service, settle, seen } = setup();
    const result = await service.start(P1, { title: "夜班证词", providerKey: "deepseek", model: "d-1" }, TOKEN, CONTEXT("k"));
    expect(result.status).toBe(201);
    await settle();
    expect(new Set(seen.map((item) => item.url))).toEqual(new Set(["https://api.deepseek.com/chat/completions"]));
    expect(seen.every((item) => item.body.model === "d-1")).toBe(true);
  });

  it("repeated clicks and replays start one run; a different input with the same key is refused", async () => {
    const { service, settle, seen, store } = setup();
    const results = await Promise.all([1, 2, 3].map(() => service.start(P1, { title: "夜班证词" }, TOKEN, CONTEXT("same"))));
    expect(results.map((item) => item.status).sort()).toEqual([200, 200, 201]);
    await settle();
    const replay = await service.start(P1, { title: "夜班证词" }, TOKEN, CONTEXT("same"));
    expect(replay.status).toBe(200);
    await settle();
    expect(store.runs).toHaveLength(1);
    expect(seen).toHaveLength(5);
    const conflict = await service.start(P1, { title: "另一个剧名" }, TOKEN, CONTEXT("same"));
    expect(conflict).toMatchObject({ status: 409, body: { error: { code: "IDEMPOTENCY_KEY_REUSED" } } });
  });

  it("a second start with a new key while one runs returns the active run instead of a new one", async () => {
    const { service, store } = setup();
    const first = await service.start(P1, { title: "夜班证词" }, TOKEN, CONTEXT("a"));
    const second = await service.start(P1, { title: "夜班证词" }, TOKEN, CONTEXT("b"));
    expect(second).toMatchObject({ status: 409, body: { error: { code: "TITLE_WRITING_RUN_ACTIVE",
      details: { runId: (first.body as { run: { runId: string } }).run.runId } } } });
    expect(store.runs).toHaveLength(1);
  });

  it("a key used for one project cannot read or start another project's run", async () => {
    const { service, settle } = setup();
    const first = await service.start(P1, { title: "夜班证词" }, TOKEN, CONTEXT("shared"));
    await settle();
    const runId = (first.body as { run: { runId: string } }).run.runId;
    expect((await service.start(P2, { title: "夜班证词" }, TOKEN, CONTEXT("shared"))).status).toBe(409);
    expect((await service.get(P2, runId)).status).toBe(404);
  });

  it("checks that the project exists in this workspace", async () => {
    const { service } = setup();
    await expect(service.start(MISSING, { title: "x" }, TOKEN, CONTEXT("k"))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.latest(MISSING)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("after a start", () => {
  it("an uncertain call needs the operator token and an explicit confirmation to resend", async () => {
    const { service, settle, seen } = setup({ override: (step, attempt) => step === "concept" && attempt === 1 ? { status: 502, body: {} } : undefined });
    const started = await service.start(P1, { title: "夜班证词" }, TOKEN, CONTEXT("k"));
    await settle();
    const runId = (started.body as { run: { runId: string } }).run.runId;
    const shown = (await service.get(P1, runId)).body as { run: { state: string; calls: Array<{ callId: string; state: string }> } };
    expect(shown.run.state).toBe("needs_attention");
    const uncertainIds = shown.run.calls.filter((call) => call.state === "unknown").map((call) => call.callId);
    const confirm = { confirmUncertainCallIds: uncertainIds };
    expect((await service.resume(P1, runId, confirm, undefined, CONTEXT("r1"))).status).toBe(403);
    expect((await service.resume(P1, runId, confirm, "wrong-token-000000000", CONTEXT("r1"))).body)
      .toMatchObject({ error: { code: "TITLE_WRITING_FORBIDDEN" } });
    expect((await service.resume(P1, runId, confirm, TOKEN, CONTEXT())).body).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    expect((await service.resume(P1, runId, { confirmUncertain: true }, TOKEN, CONTEXT("r0"))).status).toBe(400);
    expect((await service.resume(P1, runId, {}, TOKEN, CONTEXT("r0"))).body).toMatchObject({ error: { code: "TITLE_WRITING_NEEDS_CONFIRMATION" } });
    expect(seen).toHaveLength(1);
    expect((await service.resume(P1, runId, confirm, TOKEN, CONTEXT("r1"))).status).toBe(200);
    await settle();
    expect(((await service.get(P1, runId)).body as { run: { state: string } }).run.state).toBe("completed");
    expect(seen.map((item) => item.step)).toEqual(["concept", "concept", "outline", "episode:1", "episode:2", "episode:3"]);
    // The receipt was lost: replaying the same action returns the run as it is now and sends nothing.
    const replay = await service.resume(P1, runId, confirm, TOKEN, CONTEXT("r1"));
    await settle();
    expect(replay.status).toBe(200);
    expect((replay.body as { run: { state: string } }).run.state).toBe("completed");
    expect(seen).toHaveLength(6);
  });

  it("a confirmation for an older uncertain attempt is refused in the store, even when replayed under a new key", async () => {
    const { service, settle, seen } = setup({ override: (step, attempt) => step === "concept" && attempt <= 2 ? { status: 502, body: {} } : undefined });
    const started = await service.start(P1, { title: "夜班证词" }, TOKEN, CONTEXT("k"));
    await settle();
    const runId = (started.body as { run: { runId: string } }).run.runId;
    const read = async () => ((await service.get(P1, runId)).body as { run: { calls: Array<{ callId: string; state: string; attemptNo: number }> } })
      .run.calls.filter((call) => call.state === "unknown");
    const old = { confirmUncertainCallIds: (await read()).map((call) => call.callId) };
    expect((await service.resume(P1, runId, old, TOKEN, CONTEXT("r1"))).status).toBe(200);
    await settle();
    expect(seen).toHaveLength(2);
    // Attempt 2 is uncertain as well. The old confirmation, sent again under the old or a new key, does not resend it.
    expect((await service.resume(P1, runId, old, TOKEN, CONTEXT("r1"))).status).toBe(200);
    expect((await service.resume(P1, runId, old, TOKEN, CONTEXT("r2"))).body).toMatchObject({ error: { code: "TITLE_WRITING_CONFIRMATION_STALE" } });
    expect((await service.resume(P1, runId, { confirmUncertainCallIds: [] }, TOKEN, CONTEXT("r1"))).body)
      .toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REUSED" } });
    await settle();
    expect(seen).toHaveLength(2);
    const fresh = { confirmUncertainCallIds: (await read()).filter((call) => call.attemptNo === 2).map((call) => call.callId) };
    expect((await service.resume(P1, runId, fresh, TOKEN, CONTEXT("r3"))).status).toBe(200);
    await settle();
    expect(seen.map((item) => item.step)).toEqual(["concept", "concept", "concept", "outline", "episode:1", "episode:2", "episode:3"]);
  });

  it("cancel is recorded on the run and later steps never start", async () => {
    const { service, store, seen } = setup();
    const pendingWork: Array<() => Promise<void>> = [];
    // Hold the background work so the cancel lands before the first step.
    (service as unknown as { deps: { schedule: (work: () => Promise<void>) => void } }).deps.schedule = (work) => { pendingWork.push(work); };
    const started = await service.start(P1, { title: "夜班证词" }, TOKEN, CONTEXT("k"));
    const runId = (started.body as { run: { runId: string } }).run.runId;
    const canceled = await service.cancel(P1, runId);
    expect((canceled.body as { run: { cancelRequested: boolean } }).run.cancelRequested).toBe(true);
    for (const work of pendingWork) await work();
    expect(seen).toHaveLength(0);
    expect(store.runs[0]?.state).toBe("canceled");
  });

  it("scripts are written only after a person approved the story", async () => {
    const { service, settle, store } = setup();
    const started = await service.start(P1, { title: "夜班证词" }, TOKEN, CONTEXT("k"));
    await settle();
    const runId = (started.body as { run: { runId: string } }).run.runId;
    expect((await service.placeScripts(P1, runId, {}, CONTEXT())).body).toMatchObject({ error: { code: "TITLE_WRITING_STORY_NOT_APPROVED" } });
    store.approveCurrentStory(P1);
    const placed = await service.placeScripts(P1, runId, {}, CONTEXT());
    expect((placed.body as { run: { steps: Array<{ scriptSave: string | null }> } }).run.steps.map((step) => step.scriptSave))
      .toEqual([null, null, "saved", "saved", "saved"]);
  });

  it("maintenance continues runs only while the feature is on", async () => {
    const off = setup({ enabled: false });
    off.store.addProject(WS, "55555555-5555-4555-8555-555555555555");
    await off.service.maintain();
    expect(off.seen).toHaveLength(0);
  });
});

describe("environment", () => {
  const base = {
    DATABASE_URL: "postgresql://x/y", REDIS_URL: "redis://x", S3_ENDPOINT: "http://x", S3_REGION: "r", S3_BUCKET: "b",
    S3_ACCESS_KEY_ID: "a", S3_SECRET_ACCESS_KEY: "s", APP_WORKSPACE_ID: WS,
  };

  it("is off by default with conservative caps", () => {
    const env = loadApiEnv(base);
    expect(env).toMatchObject({ TITLE_WRITING_ENABLED: false, TITLE_WRITING_MAX_CALLS_PER_DAY: 30, TITLE_WRITING_MAX_ACTIVE_RUNS: 1 });
  });

  it("reads provider keys and model allowlists only from the process environment", () => {
    const fromFile = loadApiEnv(base, { OPENAI_API_KEY: SECRET, DEEPSEEK_API_KEY: SECRET, TITLE_WRITING_OPENAI_MODELS: "o-1" });
    expect(fromFile.OPENAI_API_KEY).toBeUndefined();
    expect(fromFile.DEEPSEEK_API_KEY).toBeUndefined();
    expect(fromFile.TITLE_WRITING_OPENAI_MODELS).toBeUndefined();
    const fromProcess = loadApiEnv({ ...base, OPENAI_API_KEY: SECRET, TITLE_WRITING_OPENAI_MODELS: "o-1", TITLE_WRITING_ENABLED: "true" });
    expect(fromProcess).toMatchObject({ OPENAI_API_KEY: SECRET, TITLE_WRITING_OPENAI_MODELS: "o-1", TITLE_WRITING_ENABLED: true });
  });
});
