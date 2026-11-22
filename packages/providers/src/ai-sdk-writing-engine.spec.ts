import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BAILIAN_AI_SDK_ADAPTER,
  BAILIAN_COMPATIBLE_BASE_URL,
  DEEPSEEK_AI_SDK_ADAPTER,
  DEEPSEEK_PROVIDER_ADAPTER,
  QWEN_PLUS_MODEL,
  TITLE_WRITING_DEFAULT_EPISODE_SECONDS,
} from "@ai-drama/contracts";
import { titleWritingProviderConfigs, type WritingProviderConfig, type WritingTransport } from "./text-writing";
import { InMemoryTitleWritingStore, TitleWritingEngine, newTitleRun, titleRunView } from "./title-writing-engine";
import { fixtureConcept, fixtureEpisode, fixtureOutline, fixtureStepOf } from "./title-writing-fixtures";

const WS = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const SENTINEL = "sk-sentinel-engine-key-do-not-leak";
const TITLE = "夜班证词";

function providers(): Record<"openai" | "anthropic" | "deepseek", WritingProviderConfig> {
  return titleWritingProviderConfigs({
    ANTHROPIC_API_KEY: "unused-anthropic-key",
    OPENAI_API_KEY: "unused-openai-key",
    DEEPSEEK_API_KEY: "unused-deepseek-key",
    TITLE_WRITING_DEEPSEEK_MODELS: "deepseek-flash",
  });
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

function answerFor(user: string): string {
  const step = fixtureStepOf(user);
  if (step === "concept") return JSON.stringify(fixtureConcept(TITLE));
  if (step === "outline") return JSON.stringify(fixtureOutline());
  const episodeNo = Number(step.slice("episode:".length));
  return JSON.stringify(fixtureEpisode(episodeNo));
}

function chatFetch(options: { kind: "bailian" | "deepseek"; content?: (user: string) => string; hang?: boolean } ): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    urls.push(url);
    expect(String(init?.body)).not.toContain(SENTINEL);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${SENTINEL}`);
    if (options.hang) {
      return new Promise((_resolve, reject) => {
        const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        init?.signal?.addEventListener("abort", fail, { once: true });
      });
    }
    const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role: string; content: unknown }> };
    const user = (body.messages ?? []).map((message) => messageText(message.content)).join("\n");
    const text = options.content ? options.content(user) : answerFor(user);
    return new Response(JSON.stringify({
      id: "chatcmpl-engine",
      model: options.kind === "bailian" ? QWEN_PLUS_MODEL : "deepseek-flash",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, urls };
}

function refusingTransport(): WritingTransport {
  return async () => { throw new Error("http transport"); };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SDK writing engine", () => {
  it("saves a bailian qwen-plus story from injected chat completions and never leaks the key", async () => {
    vi.stubGlobal("fetch", () => { throw new Error("global fetch"); });
    const store = new InMemoryTitleWritingStore();
    store.bailianReady = true;
    store.addProject(WS, PROJECT);
    const { fetchImpl, urls } = chatFetch({ kind: "bailian" });
    const engine = new TitleWritingEngine({
      workspaceId: WS,
      store,
      providers: providers(),
      transport: refusingTransport(),
      sdkFetch: fetchImpl,
      maxCallsPerDay: 30,
      featureCredential: async () => ({ apiKey: SENTINEL, url: BAILIAN_COMPATIBLE_BASE_URL, models: [QWEN_PLUS_MODEL] }),
    });
    const created = await store.createRun(newTitleRun({
      workspaceId: WS, projectId: PROJECT, actorId: "owner", idempotencyKey: "bailian-1", title: TITLE,
      settings: { episodeCount: 3, episodeSeconds: TITLE_WRITING_DEFAULT_EPISODE_SECONDS, style: "" },
      providerKey: "bailian", model: QWEN_PLUS_MODEL, providerAdapter: BAILIAN_AI_SDK_ADAPTER, now: new Date(),
    }), { maxActiveRuns: 1 });
    expect(created.kind).toBe("created");
    if (created.kind === "blocked") return;
    await engine.drive(created.bundle.run.id);
    const bundle = (await store.latestRun(WS, PROJECT))!;
    const view = titleRunView(bundle);
    expect(view.state).toBe("completed");
    expect(view.storySave).toBe("saved");
    expect(store.projects.get(PROJECT)?.stories).toHaveLength(1);
    expect(urls).toHaveLength(5);
    expect(new Set(urls)).toEqual(new Set([`${BAILIAN_COMPATIBLE_BASE_URL}/chat/completions`]));
    expect(JSON.stringify(bundle)).not.toContain(SENTINEL);
    expect(JSON.stringify(view)).not.toContain(SENTINEL);
  });

  it("saves the same fixture through the DeepSeek SDK adapter", async () => {
    const store = new InMemoryTitleWritingStore();
    store.addProject(WS, PROJECT);
    const { fetchImpl, urls } = chatFetch({ kind: "deepseek" });
    const engine = new TitleWritingEngine({
      workspaceId: WS, store, providers: providers(), transport: refusingTransport(), sdkFetch: fetchImpl, maxCallsPerDay: 30,
      featureCredential: async () => ({ apiKey: SENTINEL, url: "https://api.deepseek.com", models: ["deepseek-flash"] }),
    });
    const created = await store.createRun(newTitleRun({
      workspaceId: WS, projectId: PROJECT, actorId: "owner", idempotencyKey: "deepseek-sdk-1", title: TITLE,
      settings: { episodeCount: 3, episodeSeconds: TITLE_WRITING_DEFAULT_EPISODE_SECONDS, style: "" },
      providerKey: "deepseek", model: "deepseek-flash", providerAdapter: DEEPSEEK_AI_SDK_ADAPTER, now: new Date(),
    }), { maxActiveRuns: 1 });
    if (created.kind === "blocked") throw new Error("blocked");
    await engine.drive(created.bundle.run.id);
    expect((await store.latestRun(WS, PROJECT))?.run.state).toBe("completed");
    expect(urls.every((url) => url === "https://api.deepseek.com/chat/completions")).toBe(true);
    expect(urls.some((url) => url.includes("gateway"))).toBe(false);
  });

  it("rejects a schema mismatch and does not save a story", async () => {
    const store = new InMemoryTitleWritingStore();
    store.bailianReady = true;
    store.addProject(WS, PROJECT);
    const { fetchImpl } = chatFetch({ kind: "bailian", content: () => JSON.stringify({ genre: "x" }) });
    const engine = new TitleWritingEngine({
      workspaceId: WS, store, providers: providers(), transport: refusingTransport(), sdkFetch: fetchImpl, maxCallsPerDay: 30,
      featureCredential: async () => ({ apiKey: SENTINEL, url: BAILIAN_COMPATIBLE_BASE_URL, models: [QWEN_PLUS_MODEL] }),
    });
    const created = await store.createRun(newTitleRun({
      workspaceId: WS, projectId: PROJECT, actorId: "owner", idempotencyKey: "bad-schema", title: TITLE,
      settings: { episodeCount: 3, episodeSeconds: TITLE_WRITING_DEFAULT_EPISODE_SECONDS, style: "" },
      providerKey: "bailian", model: QWEN_PLUS_MODEL, providerAdapter: BAILIAN_AI_SDK_ADAPTER, now: new Date(),
    }), { maxActiveRuns: 1 });
    if (created.kind === "blocked") throw new Error("blocked");
    await engine.drive(created.bundle.run.id);
    const bundle = (await store.getRunById(WS, created.bundle.run.id))!;
    expect(bundle.calls[0]?.state).toBe("rejected");
    expect(store.projects.get(PROJECT)?.stories).toHaveLength(0);
    expect(JSON.stringify(bundle)).not.toContain(SENTINEL);
  });

  it("rejects invalid JSON and does not save a story", async () => {
    const store = new InMemoryTitleWritingStore();
    store.bailianReady = true;
    store.addProject(WS, PROJECT);
    const { fetchImpl, urls } = chatFetch({ kind: "bailian", content: () => "not-json" });
    const engine = new TitleWritingEngine({
      workspaceId: WS, store, providers: providers(), transport: refusingTransport(), sdkFetch: fetchImpl, maxCallsPerDay: 30,
      featureCredential: async () => ({ apiKey: SENTINEL, url: BAILIAN_COMPATIBLE_BASE_URL, models: [QWEN_PLUS_MODEL] }),
    });
    const created = await store.createRun(newTitleRun({
      workspaceId: WS, projectId: PROJECT, actorId: "owner", idempotencyKey: "bad-json", title: TITLE,
      settings: { episodeCount: 3, episodeSeconds: TITLE_WRITING_DEFAULT_EPISODE_SECONDS, style: "" },
      providerKey: "bailian", model: QWEN_PLUS_MODEL, providerAdapter: BAILIAN_AI_SDK_ADAPTER, now: new Date(),
    }), { maxActiveRuns: 1 });
    if (created.kind === "blocked") throw new Error("blocked");
    await engine.drive(created.bundle.run.id);
    const bundle = (await store.getRunById(WS, created.bundle.run.id))!;
    expect(bundle.run.state).toBe("failed");
    expect(bundle.calls[0]?.state).toBe("rejected");
    expect(store.projects.get(PROJECT)?.stories).toHaveLength(0);
    expect(urls).toHaveLength(1);
  });

  it("stops a timeout as unknown and does not send again", async () => {
    const store = new InMemoryTitleWritingStore();
    store.bailianReady = true;
    store.addProject(WS, PROJECT);
    const { fetchImpl, urls } = chatFetch({ kind: "bailian", hang: true });
    const engine = new TitleWritingEngine({
      workspaceId: WS, store, providers: providers(), transport: refusingTransport(), sdkFetch: fetchImpl, maxCallsPerDay: 30, timeoutMs: 30,
      featureCredential: async () => ({ apiKey: SENTINEL, url: BAILIAN_COMPATIBLE_BASE_URL, models: [QWEN_PLUS_MODEL] }),
    });
    const created = await store.createRun(newTitleRun({
      workspaceId: WS, projectId: PROJECT, actorId: "owner", idempotencyKey: "timeout", title: TITLE,
      settings: { episodeCount: 3, episodeSeconds: TITLE_WRITING_DEFAULT_EPISODE_SECONDS, style: "" },
      providerKey: "bailian", model: QWEN_PLUS_MODEL, providerAdapter: BAILIAN_AI_SDK_ADAPTER, now: new Date(),
    }), { maxActiveRuns: 1 });
    if (created.kind === "blocked") throw new Error("blocked");
    await engine.drive(created.bundle.run.id);
    const bundle = (await store.getRunById(WS, created.bundle.run.id))!;
    expect(bundle.run.state).toBe("needs_attention");
    expect(bundle.calls[0]?.state).toBe("unknown");
    expect(urls).toHaveLength(1);
    await engine.drive(created.bundle.run.id);
    expect(urls).toHaveLength(1);
    expect(store.projects.get(PROJECT)?.stories).toHaveLength(0);
  });

  it("does not reserve or send a historical qwen run", async () => {
    const store = new InMemoryTitleWritingStore();
    store.addProject(WS, PROJECT);
    let sdkCalls = 0;
    const engine = new TitleWritingEngine({
      workspaceId: WS, store, providers: providers(), transport: refusingTransport(),
      sdkFetch: async () => { sdkCalls += 1; throw new Error("sdk"); },
      maxCallsPerDay: 30,
      featureCredential: async () => ({ apiKey: SENTINEL, url: BAILIAN_COMPATIBLE_BASE_URL, models: ["qwen-plus"] }),
    });
    const created = await store.createRun(newTitleRun({
      workspaceId: WS, projectId: PROJECT, actorId: "owner", idempotencyKey: "qwen-old", title: TITLE,
      settings: { episodeCount: 3, episodeSeconds: TITLE_WRITING_DEFAULT_EPISODE_SECONDS, style: "" },
      providerKey: "qwen", model: "qwen-plus", now: new Date(),
    }), { maxActiveRuns: 1 });
    if (created.kind === "blocked") throw new Error("blocked");
    await engine.drive(created.bundle.run.id);
    const bundle = (await store.getRunById(WS, created.bundle.run.id))!;
    expect(bundle.run.errorCode).toBe("provider_unconfigured");
    expect(bundle.calls).toHaveLength(0);
    expect(sdkCalls).toBe(0);
  });

  it("keeps the chat-completions DeepSeek adapter on the HTTP transport", async () => {
    const store = new InMemoryTitleWritingStore();
    store.addProject(WS, PROJECT);
    let httpCalls = 0;
    const transport: WritingTransport = async () => { httpCalls += 1; return { status: 401, body: {} }; };
    let sdkCalls = 0;
    const engine = new TitleWritingEngine({
      workspaceId: WS, store, providers: providers(), transport, maxCallsPerDay: 30,
      sdkFetch: async () => { sdkCalls += 1; throw new Error("sdk"); },
    });
    const created = await store.createRun(newTitleRun({
      workspaceId: WS, projectId: PROJECT, actorId: "owner", idempotencyKey: "deepseek-http", title: TITLE,
      settings: { episodeCount: 3, episodeSeconds: TITLE_WRITING_DEFAULT_EPISODE_SECONDS, style: "" },
      providerKey: "deepseek", model: "deepseek-flash", now: new Date(),
    }), { maxActiveRuns: 1 });
    if (created.kind === "blocked") throw new Error("blocked");
    expect(created.bundle.run.input).toMatchObject({ providerAdapter: DEEPSEEK_PROVIDER_ADAPTER });
    await engine.drive(created.bundle.run.id);
    expect(httpCalls).toBe(1);
    expect(sdkCalls).toBe(0);
  });

  it("stops an SDK run before reserve when fetch is not injected", async () => {
    const store = new InMemoryTitleWritingStore();
    store.bailianReady = true;
    store.addProject(WS, PROJECT);
    const engine = new TitleWritingEngine({
      workspaceId: WS, store, providers: providers(), transport: refusingTransport(), maxCallsPerDay: 30,
      featureCredential: async () => ({ apiKey: SENTINEL, url: BAILIAN_COMPATIBLE_BASE_URL, models: [QWEN_PLUS_MODEL] }),
    });
    const created = await store.createRun(newTitleRun({
      workspaceId: WS, projectId: PROJECT, actorId: "owner", idempotencyKey: "no-fetch", title: TITLE,
      settings: { episodeCount: 3, episodeSeconds: TITLE_WRITING_DEFAULT_EPISODE_SECONDS, style: "" },
      providerKey: "bailian", model: QWEN_PLUS_MODEL, providerAdapter: BAILIAN_AI_SDK_ADAPTER, now: new Date(),
    }), { maxActiveRuns: 1 });
    if (created.kind === "blocked") throw new Error("blocked");
    await engine.drive(created.bundle.run.id);
    const bundle = (await store.getRunById(WS, created.bundle.run.id))!;
    expect(bundle.run.errorCode).toBe("provider_unconfigured");
    expect(bundle.calls).toHaveLength(0);
  });
});
