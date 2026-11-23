import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersistenceError } from "@ai-drama/database";
import {
  DEEPSEEK_AI_SDK_ADAPTER,
  DEEPSEEK_AI_SDK_BASE_URL,
} from "@ai-drama/contracts";
import {
  DEEPSEEK_CHAT_COMPLETIONS_URL,
  InMemoryTitleWritingStore,
  TitleWritingEngine,
  probeDeepseekWriting,
  titleWritingProviderConfigs,
  type WritingTransport,
} from "@ai-drama/providers";
import { fixtureConcept, fixtureEpisode, fixtureOutline, fixtureStepOf } from "@ai-drama/providers/title-writing-fixtures";
import { loadApiEnv } from "../config/env";
import { FeatureConfigService } from "../admin/feature-config.service";
import { FeatureConfigVault, featureVaultPath } from "../admin/feature-config-vault";
import { FeatureUsageStore } from "../admin/feature-usage-store";
import { featureWritingProbe } from "../admin/feature-writing-probe";
import { adminBootstrap } from "../admin/admin-bootstrap";
import { AdminModelsService } from "../admin/admin-models.service";
import { TitleWritingService } from "./title-writing.service";

const WS = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const VENDOR_KEY = "fake-deepseek-vendor-key-0123456789";
const TITLE = "夜班证词";
const CLAUDE_KEY = "sk-ant-api03-test-only-not-a-real-key-0123456789";

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempDir() {
  const directory = await mkdtemp(join(tmpdir(), "deepseek-writing-connect-"));
  await chmod(directory, 0o700);
  directories.push(directory);
  return directory;
}

function chatBody(init: RequestInit | undefined) {
  return JSON.parse(String(init?.body)) as {
    model?: string;
    response_format?: { type?: string };
    messages?: Array<{ role: string; content: unknown }>;
  };
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && "text" in part) return String(part.text);
    return "";
  }).join("\n");
}

function scriptAnswer(user: string): string {
  const step = fixtureStepOf(user);
  if (step === "concept") return JSON.stringify(fixtureConcept(TITLE));
  if (step === "outline") return JSON.stringify(fixtureOutline());
  return JSON.stringify(fixtureEpisode(Number(step.slice("episode:".length))));
}

function chatResponse(content: string, model: string, status = 200): Response {
  return new Response(JSON.stringify({
    id: "chatcmpl-connect",
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
  }), { status, headers: { "content-type": "application/json" } });
}

describe("DeepSeek writing connect (isolated, no real outbound)", () => {
  it("saves a vendor key, binds it in 功能配置, probes JSON Output, enables, and writes a schema-valid script", async () => {
    vi.stubGlobal("fetch", () => { throw new Error("global fetch"); });
    const directory = await tempDir();
    const env = loadApiEnv({
      DATABASE_URL: "postgresql://unused:unused@127.0.0.1:55432/unused",
      REDIS_URL: "redis://127.0.0.1:56379",
      S3_ENDPOINT: "http://127.0.0.1:59000",
      S3_REGION: "us-east-1",
      S3_BUCKET: "test",
      S3_ACCESS_KEY_ID: "unused",
      S3_SECRET_ACCESS_KEY: "unused",
      APP_WORKSPACE_ID: WS,
      MODEL_ADMIN_ENABLED: "true",
      MODEL_ADMIN_MASTER_KEY: randomBytes(32).toString("hex"),
      MODEL_ADMIN_CONFIG_PATH: join(directory, "models.enc"),
      ANTHROPIC_API_KEY: CLAUDE_KEY,
      TITLE_WRITING_ANTHROPIC_MODELS: "claude-opus-5-5",
      TITLE_WRITING_DEFAULT_PROVIDER: "anthropic",
    });
    const bootstrap = adminBootstrap(env)!;
    const catalogueFetch = vi.fn<typeof fetch>(async (input, init) => {
      expect(new URL(String(input)).hostname).toBe("api.deepseek.com");
      expect(new URL(String(input)).pathname).toMatch(/^\/(?:v1\/)?models$/);
      expect(init?.method ?? "GET").toBe("GET");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${VENDOR_KEY}`);
      return Response.json({ data: [{ id: "deepseek-v4-pro" }] });
    });
    const models = await AdminModelsService.open(env, bootstrap, async () => true, undefined, null, catalogueFetch);
    const before = await models.view();
    const initial = await models.vendor("deepseek");
    const selected = { model: "deepseek-v4-pro", channel: "deepseek-direct" };
    const saved = await models.saveVendor("deepseek", {
      ...selected, expectedRevision: initial.revision, secretAction: "replace", apiKey: VENDOR_KEY,
    });
    expect(saved).toMatchObject({ ...selected, keyConfigured: true });
    expect(JSON.stringify(saved)).not.toContain(VENDOR_KEY);
    expect(catalogueFetch).not.toHaveBeenCalled();
    expect(await models.checkVendor("deepseek", { ...selected, expectedRevision: saved.revision }))
      .toMatchObject({ ...selected, status: "listed" });
    expect(catalogueFetch).toHaveBeenCalledTimes(1);

    // Restarting reads the supplier preference without activating it for an existing business.
    const restarted = await AdminModelsService.open(env, bootstrap, async () => true);
    expect(await restarted.vendor("deepseek")).toEqual(saved);
    expect((await restarted.view()).active).toEqual(before.active);
    expect((await restarted.view()).saved).toEqual(before.saved);
    expect(await restarted.pendingRestart()).toBe(false);

    const outbound: Array<{ url: string; model: string; authorization: string | null; responseFormat: unknown; body: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = chatBody(init);
      outbound.push({
        url,
        model: body.model ?? "",
        authorization: new Headers(init?.headers).get("authorization"),
        responseFormat: body.response_format,
        body: String(init?.body),
      });
      expect(url).toBe(`${DEEPSEEK_AI_SDK_BASE_URL}/chat/completions`);
      expect(url).toBe(DEEPSEEK_CHAT_COMPLETIONS_URL);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${VENDOR_KEY}`);
      expect(body.response_format).toEqual({ type: "json_object" });
      expect(String(init?.body)).not.toContain(VENDOR_KEY);
      const user = (body.messages ?? []).map((message) => messageText(message.content)).join("\n");
      if (user.includes('{"ok":true}')) return chatResponse('{"ok":true}', body.model ?? "deepseek-flash");
      return chatResponse(scriptAnswer(user), body.model ?? "deepseek-v4-pro");
    };

    const featureConfig = await FeatureConfigService.open({
      vault: await FeatureConfigVault.open({ path: featureVaultPath(bootstrap.path), masterKey: bootstrap.masterKey }),
      usage: new FeatureUsageStore(join(directory, "feature-usage.json")),
      probe: featureWritingProbe(fetchImpl),
      homeWorkspaceId: WS,
      legacy: {
        live: async () => ({ writing: null, storyboard: null, voice: null }),
        secret: async () => null,
        vendorSecret: async (feature, vendor) => feature === "writing" && vendor === "deepseek"
          ? restarted.vendorSecret(vendor) : null,
      },
    });

    let view = await featureConfig.view();
    expect(view.features.find((item) => item.feature === "writing")?.slots.find((item) => item.vendor === "deepseek")?.vendorKeyConfigured).toBe(true);
    view = await featureConfig.saveDraft("writing", {
      expectedRevision: view.revision,
      vendor: "deepseek",
      model: "deepseek-v4-pro",
      secretAction: "bind_vendor",
    });
    expect(view.features.find((item) => item.feature === "writing")?.live).toBeNull();
    expect(outbound).toHaveLength(0);
    const tested = await featureConfig.testDraft("writing", { expectedRevision: view.revision, vendor: "deepseek", confirmCost: true });
    expect(tested.probe.ok).toBe(true);
    expect(tested.view.features.find((item) => item.feature === "writing")?.live).toBeNull();
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toMatchObject({ model: "deepseek-v4-pro", authorization: `Bearer ${VENDOR_KEY}` });
    const enabled = await featureConfig.enable("writing", {
      expectedRevision: tested.view.revision,
      vendor: "deepseek",
      testToken: tested.view.features.find((item) => item.feature === "writing")!.slots.find((item) => item.vendor === "deepseek")!.testToken!,
    });
    expect(enabled.features.find((item) => item.feature === "writing")?.live).toMatchObject({
      source: "enabled",
      vendor: "deepseek",
      model: "deepseek-v4-pro",
    });
    expect(JSON.stringify({ saved, tested, enabled })).not.toContain(VENDOR_KEY);

    const store = new InMemoryTitleWritingStore();
    store.addProject(WS, PROJECT);
    // No process writing provider is ready. The leftover default stays anthropic, which saving the DeepSeek key did not switch.
    const providers = titleWritingProviderConfigs({});
    const transport: WritingTransport = async () => { throw new Error("http transport"); };
    const engine = new TitleWritingEngine({
      workspaceId: WS,
      store,
      providers,
      transport,
      sdkFetch: fetchImpl,
      maxCallsPerDay: 30,
      featureCredential: async (run) => {
        const locked = await featureConfig.credentialForTask("writing", WS, run.id);
        if (!locked || locked.vendor !== "deepseek" || locked.model !== run.model) return null;
        return { apiKey: locked.apiKey, url: DEEPSEEK_AI_SDK_BASE_URL, models: [locked.model] };
      },
    });
    const pending: Array<Promise<void>> = [];
    const service = new TitleWritingService({
      workspaceId: WS,
      nodeEnv: "test",
      enabled: true,
      allowProduction: false,
      operatorToken: null,
      siteOperator: true,
      defaultProvider: "anthropic",
      providers,
      store,
      engine,
      projects: {
        getProject: async (_workspaceId, projectId) => {
          if (projectId !== PROJECT) throw new PersistenceError("NOT_FOUND", "Project not found");
          return { id: projectId } as never;
        },
        getProjectEpisodePlan: async () => ({ episodeCount: 3, targetEpisodeSeconds: null }),
        episodePlanReady: async () => true,
      },
      maxCallsPerDay: 30,
      maxActiveRuns: 1,
      schedule: (work) => { pending.push(work()); },
      featureWritingLock: async () => {
        const binding = await featureConfig.readBinding("writing");
        if (!binding || binding.source !== "enabled") return null;
        return {
          providerKey: "deepseek" as const,
          model: binding.model,
          configVersion: binding.configVersion,
          credentialRef: binding.credentialRef,
          apiKey: binding.secret,
          providerAdapter: DEEPSEEK_AI_SDK_ADAPTER,
        };
      },
      featureWritingCommit: async (input) => {
        const binding = await featureConfig.readBinding("writing");
        if (!binding || binding.credentialRef !== input.credentialRef) return;
        await featureConfig.rememberLock({
          workspaceId: WS,
          taskId: input.runId,
          feature: "writing",
          versionId: input.configVersion,
          credentialRef: input.credentialRef,
          vendor: "deepseek",
          model: input.model,
          projectId: input.projectId,
          episodeId: null,
        });
      },
    });

    const options = (await service.options()).body as {
      code: string;
      defaultProvider: string | null;
      providers: Array<{ providerKey: string; ready: boolean; defaultModel: string | null; missing: string[] }>;
    };
    expect(options.code).toBe("TITLE_WRITING_READY");
    expect(options.defaultProvider).toBe("deepseek");
    expect(options.providers.find((item) => item.providerKey === "deepseek")).toMatchObject({
      ready: true, defaultModel: "deepseek-v4-pro", missing: [],
    });
    expect(options.providers.find((item) => item.providerKey === "anthropic")?.ready).toBe(false);
    expect(options.providers.find((item) => item.providerKey === options.defaultProvider)?.ready).toBe(true);
    expect(JSON.stringify(options)).not.toContain(VENDOR_KEY);
    expect(JSON.stringify(options)).not.toContain(CLAUDE_KEY);

    const started = await service.start(PROJECT, { title: TITLE }, { session: true, token: undefined }, {
      actorId: "operator",
      traceId: "t",
      idempotencyKey: "deepseek-connect-1",
    });
    expect(started.status).toBe(201);
    while (pending.length > 0) await pending.shift();
    const bundle = (await store.latestRun(WS, PROJECT))!;
    expect(bundle.run.state).toBe("completed");
    expect(bundle.run.input).toMatchObject({
      providerKey: "deepseek",
      model: "deepseek-v4-pro",
      providerAdapter: DEEPSEEK_AI_SDK_ADAPTER,
    });
    expect(store.projects.get(PROJECT)?.stories).toHaveLength(1);
    const story = store.projects.get(PROJECT)?.stories[0]?.text ?? "";
    expect(story.length).toBeGreaterThan(20);
    expect(outbound.slice(1).every((item) => item.url === DEEPSEEK_CHAT_COMPLETIONS_URL && item.model === "deepseek-v4-pro" && item.authorization === `Bearer ${VENDOR_KEY}`)).toBe(true);
    expect(outbound.length).toBeGreaterThan(1);
    expect(JSON.stringify(bundle)).not.toContain(VENDOR_KEY);
    expect(JSON.stringify(started.body)).not.toContain(VENDOR_KEY);
  });

  it("does not automatically resend an unknown timeout on the enabled DeepSeek path", async () => {
    vi.stubGlobal("fetch", () => { throw new Error("global fetch"); });
    let calls = 0;
    const fetchImpl: typeof fetch = (_input, init) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (init?.signal?.aborted) fail();
        init?.signal?.addEventListener("abort", fail, { once: true });
      });
    };
    const result = await probeDeepseekWriting({
      apiKey: VENDOR_KEY,
      model: "deepseek-flash",
      fetchImpl,
      timeoutMs: 30,
    });
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("unknown");
    expect(calls).toBe(1);
  });
});
