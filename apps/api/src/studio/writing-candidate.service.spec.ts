import { describe, expect, it } from "vitest";
import { PersistenceError } from "@ai-drama/database";
import {
  ANTHROPIC_MESSAGES_URL,
  InMemoryWritingCandidateStore,
  WritingCandidateExecutor,
  titleWritingProviderConfigs,
  type TitleWritingProviderEnv,
  type WritingTransport,
} from "@ai-drama/providers";
import { fixtureCandidateFromPrompt, messagesAnswer, responsesAnswer } from "@ai-drama/providers/title-writing-fixtures";
import { SiteAuth } from "../auth/site-auth";
import { hashPassword } from "../auth/password-hash";
import { operatorProof } from "./operator-access";
import { WritingCandidateService } from "./writing-candidate.service";

const WS = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222222";
const P2 = "33333333-3333-4333-8333-333333333333";
const MISSING = "44444444-4444-4444-8444-444444444444";
const E2 = "55555555-5555-4555-8555-555555555555";
const STORY_REV = "66666666-6666-4666-8666-666666666666";
const TOKEN = "operator-token-0123456789";
const SECRET = "sk-ant-api03-not-a-real-key-abcdefghijkl";
const CONFIGURED: TitleWritingProviderEnv = { ANTHROPIC_API_KEY: SECRET, OPENAI_API_KEY: SECRET, TITLE_WRITING_OPENAI_MODELS: "o-1" };
const CONTEXT = (key?: string) => ({ actorId: "server-owner", traceId: "t", ...(key ? { idempotencyKey: key } : {}) });
const STORY = {
  mode: "story",
  base: { sourceRevisionId: STORY_REV, ifMatch: 4 },
  request: { premise: "夜班便利店", genre: "悬疑", audience: "", characters: "", mustKeep: "", mustNotChange: "", currentText: "旧故事" },
};
const EPISODE = {
  mode: "episode",
  episodeId: E2,
  base: { sourceRevisionId: null, ifMatch: 2 },
  request: { episodeNo: 2, premise: "夜班便利店", genre: "", audience: "", characters: "", confirmedStory: "已确认的故事", currentText: "",
    revisionRequest: "", mustKeep: "", mustKeepDialogue: "", mustKeepEnding: "" },
};

function setup(options: {
  enabled?: boolean;
  nodeEnv?: "development" | "test" | "production";
  allowProduction?: boolean;
  env?: TitleWritingProviderEnv;
  storageReady?: boolean;
  operatorToken?: string | null;
  siteOperator?: boolean;
  defaultProvider?: "openai" | "anthropic" | null;
  answer?: (url: string) => { status: number; body: unknown } | undefined;
  maxCallsPerDay?: number;
} = {}) {
  const store = new InMemoryWritingCandidateStore();
  store.ready = options.storageReady ?? true;
  store.targets.set(`${P1}:story`, { episodeId: null, episodeNo: null, revisions: [STORY_REV], episodeCount: 3 });
  store.targets.set(`${P1}:${E2}`, { episodeId: E2, episodeNo: 2, revisions: [], episodeCount: 3 });
  store.targets.set(`${P2}:story`, { episodeId: null, episodeNo: null, revisions: [], episodeCount: 6 });
  const providers = titleWritingProviderConfigs(options.env ?? CONFIGURED);
  const sent: Array<{ url: string; headers: Record<string, string> }> = [];
  const transport: WritingTransport = async (request) => {
    sent.push({ url: request.url, headers: request.headers as Record<string, string> });
    const body = JSON.parse(request.body) as { messages?: Array<{ content: string }>; input?: string };
    const user = body.messages?.[0]?.content ?? body.input ?? "";
    const planned = options.answer?.(request.url);
    const answer = planned ?? { status: 200, body: request.url === ANTHROPIC_MESSAGES_URL
      ? messagesAnswer(fixtureCandidateFromPrompt(user)) : responsesAnswer(fixtureCandidateFromPrompt(user)) };
    return { status: answer.status, headers: { get: () => null }, body: new TextEncoder().encode(JSON.stringify(answer.body)) };
  };
  // Sends start only when the test settles, so a request stays open (reserved) until then.
  const pending: Array<() => Promise<void>> = [];
  const service = new WritingCandidateService({
    workspaceId: WS,
    nodeEnv: options.nodeEnv ?? "test",
    enabled: options.enabled ?? true,
    allowProduction: options.allowProduction ?? false,
    operatorToken: options.operatorToken === undefined ? TOKEN : options.operatorToken,
    siteOperator: options.siteOperator ?? false,
    defaultProvider: options.defaultProvider ?? null,
    providers,
    store,
    executor: new WritingCandidateExecutor({ workspaceId: WS, store, providers, transport }),
    projects: {
      getProject: async (_workspaceId: string, projectId: string) => {
        if (projectId !== P1 && projectId !== P2) throw new PersistenceError("NOT_FOUND", "Project not found");
        return {} as never;
      },
    },
    maxCallsPerDay: options.maxCallsPerDay ?? 30,
    schedule: (work) => { pending.push(work); },
  });
  const settle = async () => { while (pending.length > 0) await pending.shift()!(); };
  return { service, store, sent, settle };
}

const requestOf = (result: { body: unknown }) => (result.body as { request: Record<string, unknown> }).request;
const errorOf = (result: { body: unknown }) => (result.body as { error: { code: string; details?: Record<string, unknown> } }).error;

describe("who may ask for an online candidate", () => {
  it("refuses before anything is written when the switch is off, in production without authorization, without an operator, or without storage", async () => {
    for (const [options, status, code] of [
      [{ enabled: false }, 404, "WRITING_CANDIDATE_DISABLED"],
      [{ nodeEnv: "production" as const }, 404, "WRITING_CANDIDATE_DISABLED"],
      [{ operatorToken: null }, 403, "WRITING_CANDIDATE_FORBIDDEN"],
      [{ storageReady: false }, 503, "WRITING_CANDIDATE_STORAGE_UNAVAILABLE"],
    ] as const) {
      const { service, store, sent } = setup(options);
      const result = await service.start(P1, STORY, TOKEN, CONTEXT("k1"));
      expect([result.status, errorOf(result).code]).toEqual([status, code]);
      expect(store.records.size).toBe(0);
      expect(sent).toHaveLength(0);
    }
  });

  it("a wrong or missing token is refused; with the site login the administrator's session is enough and no token is asked for", async () => {
    const tokenOnly = setup();
    expect(errorOf(await tokenOnly.service.start(P1, STORY, "wrong-token-0123456789", CONTEXT("k1"))).code).toBe("WRITING_CANDIDATE_FORBIDDEN");
    expect(errorOf(await tokenOnly.service.start(P1, STORY, undefined, CONTEXT("k1"))).code).toBe("WRITING_CANDIDATE_FORBIDDEN");
    // Without the site login a session claim means nothing.
    expect(errorOf(await tokenOnly.service.start(P1, STORY, { session: true, token: undefined }, CONTEXT("k1"))).code).toBe("WRITING_CANDIDATE_FORBIDDEN");
    expect(((await tokenOnly.service.options()).body as { operatorTokenRequired: boolean }).operatorTokenRequired).toBe(true);
    expect(tokenOnly.store.records.size).toBe(0);

    const site = setup({ siteOperator: true, operatorToken: null });
    expect(((await site.service.options()).body as { operatorTokenRequired: boolean; code: string })).toMatchObject({ operatorTokenRequired: false, code: "WRITING_CANDIDATE_READY" });
    expect(errorOf(await site.service.start(P1, STORY, { session: false, token: undefined }, CONTEXT("k1"))).code).toBe("WRITING_CANDIDATE_FORBIDDEN");
    const accepted = await site.service.start(P1, STORY, { session: true, token: undefined }, CONTEXT("k1"));
    expect(accepted.status).toBe(202);
  });

  it("the session proof is the site login's own write check: origin, session cookie and CSRF token", async () => {
    const auth = new SiteAuth({ username: "admin", passwordHash: await hashPassword("correct horse battery", { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 }),
      publicOrigin: "http://127.0.0.1:3010" });
    const { session, cookies } = await auth.login({ origin: "http://127.0.0.1:3010", "content-type": "application/json" },
      { username: "admin", password: "correct horse battery" });
    const cookie = cookies.map((item) => item.split(";", 1)[0]).join("; ");
    const site = { kind: "enabled" as const, auth };
    expect(operatorProof(site, { origin: "http://127.0.0.1:3010", cookie, "x-csrf-token": session.csrfToken })).toEqual({ session: true, token: undefined });
    expect(operatorProof(site, { origin: "http://127.0.0.1:3010", cookie })).toEqual({ session: false, token: undefined });
    expect(operatorProof(site, { origin: "https://evil.example", cookie, "x-csrf-token": session.csrfToken }).session).toBe(false);
    expect(operatorProof(site, { origin: "http://127.0.0.1:3010", "x-csrf-token": session.csrfToken }).session).toBe(false);
    // Without the site login nothing is a session, whatever the request carries.
    expect(operatorProof({ kind: "disabled" }, { cookie, "x-csrf-token": session.csrfToken, "x-operator-token": TOKEN })).toEqual({ session: false, token: TOKEN });
  });
});

describe("asking, reading and replaying", () => {
  it("a story request is reserved, sent once in the background and read back with its validated candidate; the key and secret never appear", async () => {
    const { service, settle, sent, store } = setup();
    const started = await service.start(P1, STORY, TOKEN, CONTEXT("k1"));
    expect(started.status).toBe(202);
    expect(requestOf(started)).toMatchObject({ state: "reserved", mode: "story", providerKey: "anthropic", model: "claude-opus-5-5", billing: "unknown",
      base: { sourceRevisionId: STORY_REV, ifMatch: 4 } });
    await settle();
    const read = await service.get(P1, String(requestOf(started).requestId));
    expect(requestOf(read)).toMatchObject({ state: "completed", candidate: { mode: "story" } });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers["x-api-key"]).toBe(SECRET);
    for (const text of [JSON.stringify(started.body), JSON.stringify(read.body)]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("k1");
      expect(text).not.toContain(TOKEN);
    }
    // It writes no revision: the store only ever holds the request.
    expect(store.records.size).toBe(1);
  });

  it("double click, a lost answer and a refresh: the same key and body return the same request and send nothing more", async () => {
    const { service, settle, sent } = setup();
    const [first, second] = await Promise.all([service.start(P1, EPISODE, TOKEN, CONTEXT("k1")), service.start(P1, EPISODE, TOKEN, CONTEXT("k1"))]);
    await settle();
    const third = await service.start(P1, EPISODE, TOKEN, CONTEXT("k1"));
    expect(new Set([first, second, third].map((result) => requestOf(result).requestId)).size).toBe(1);
    expect(third.status).toBe(200);
    expect(requestOf(third)).toMatchObject({ state: "completed", episodeNo: 2 });
    expect(sent).toHaveLength(1);
  });

  it("the same key with another body, another provider or another work is refused; a replay after the provider was removed is still answered", async () => {
    const { service, settle } = setup();
    await service.start(P1, EPISODE, TOKEN, CONTEXT("k1"));
    await settle();
    const changed = { ...EPISODE, request: { ...EPISODE.request, revisionRequest: "改一下" } };
    expect(errorOf(await service.start(P1, changed, TOKEN, CONTEXT("k1"))).code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(errorOf(await service.start(P1, { ...EPISODE, providerKey: "openai" }, TOKEN, CONTEXT("k1"))).code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(errorOf(await service.start(P2, STORY, TOKEN, CONTEXT("k1"))).code).toBe("IDEMPOTENCY_KEY_REUSED");
    // The same replay is answered from storage before any provider check.
    expect((await service.start(P1, { ...EPISODE, providerKey: "anthropic", model: "claude-opus-5-5" }, TOKEN, CONTEXT("k1"))).status).toBe(200);
  });

  it("a second request for the same target while one is open is refused with the open one's id; another target is independent", async () => {
    const { service, settle, sent } = setup();
    const open = await service.start(P1, STORY, TOKEN, CONTEXT("k1"));
    const again = await service.start(P1, STORY, TOKEN, CONTEXT("k2"));
    expect([again.status, errorOf(again).code, errorOf(again).details?.requestId]).toEqual([409, "WRITING_CANDIDATE_ACTIVE", requestOf(open).requestId]);
    expect((await service.start(P1, EPISODE, TOKEN, CONTEXT("k3"))).status).toBe(202);
    await settle();
    expect(sent).toHaveLength(2);
  });

  it("an unknown result is never resent; a new request needs the person's confirmation of exactly that request", async () => {
    const { service, settle, sent } = setup({ answer: () => ({ status: 529, body: { type: "error", error: { type: "overloaded_error" } } }) });
    const first = await service.start(P1, STORY, TOKEN, CONTEXT("k1"));
    await settle();
    const id = String(requestOf(first).requestId);
    expect(requestOf(await service.get(P1, id))).toMatchObject({ state: "unknown", errorCode: "server_error", billing: "unknown" });
    // Reading and replaying never send it again.
    await service.start(P1, STORY, TOKEN, CONTEXT("k1"));
    await settle();
    expect(sent).toHaveLength(1);
    const refused = await service.start(P1, STORY, TOKEN, CONTEXT("k2"));
    expect([refused.status, errorOf(refused).code, errorOf(refused).details?.requestId]).toEqual([409, "WRITING_CANDIDATE_NEEDS_CONFIRMATION", id]);
    expect(errorOf(await service.start(P1, { ...STORY, confirmUncertainRequestId: P2 }, TOKEN, CONTEXT("k3"))).code).toBe("WRITING_CANDIDATE_NEEDS_CONFIRMATION");
    expect((await service.start(P1, { ...STORY, confirmUncertainRequestId: id }, TOKEN, CONTEXT("k4"))).status).toBe(202);
    await settle();
    expect(sent).toHaveLength(2);
  });

  it("refuses a target of another work, an episode with another number, a foreign base revision and a six-episode story", async () => {
    const { service, sent, store } = setup();
    expect(errorOf(await service.start(P1, { ...EPISODE, episodeId: MISSING }, TOKEN, CONTEXT("a"))).details?.reason).toBe("episode");
    expect(errorOf(await service.start(P1, { ...EPISODE, request: { ...EPISODE.request, episodeNo: 3 } }, TOKEN, CONTEXT("b"))).details?.reason).toBe("episode");
    expect(errorOf(await service.start(P1, { ...STORY, base: { sourceRevisionId: MISSING, ifMatch: 4 } }, TOKEN, CONTEXT("c"))).details?.reason).toBe("base_revision");
    expect(errorOf(await service.start(P2, STORY, TOKEN, CONTEXT("d"))).details?.reason).toBe("episode_plan");
    await expect(service.start(MISSING, STORY, TOKEN, CONTEXT("e"))).rejects.toThrow("Project not found");
    expect(sent).toHaveLength(0);
    expect(store.records.size).toBe(0);
  });

  it("validates the body, the key, the provider and the model before writing; a retired provider cannot be named", async () => {
    const { service, store } = setup();
    expect(errorOf(await service.start(P1, STORY, TOKEN, CONTEXT())).details?.field).toBe("Idempotency-Key");
    expect((await service.start(P1, { ...STORY, providerKey: "qwen" }, TOKEN, CONTEXT("a"))).status).toBe(400);
    expect((await service.start(P1, { ...STORY, extra: true }, TOKEN, CONTEXT("b"))).status).toBe(400);
    expect(errorOf(await service.start(P1, { ...STORY, model: "claude-haiku-4-5" }, TOKEN, CONTEXT("c"))).code).toBe("WRITING_CANDIDATE_MODEL_UNAVAILABLE");
    expect((await service.start(P1, { ...STORY, request: { ...STORY.request, currentText: "长".repeat(20_001) } }, TOKEN, CONTEXT("d"))).status).toBe(400);
    const openaiOff = setup({ env: { ANTHROPIC_API_KEY: SECRET } });
    expect(errorOf(await openaiOff.service.start(P1, { ...STORY, providerKey: "openai" }, TOKEN, CONTEXT("e"))).code).toBe("WRITING_CANDIDATE_PROVIDER_UNCONFIGURED");
    expect(store.records.size).toBe(0);
  });

  it("Claude is the default without a configured default; without an OpenAI key Claude still works, and the reverse", async () => {
    const both = setup();
    expect(((await both.service.options()).body as { defaultProvider: string }).defaultProvider).toBe("anthropic");
    const claudeOnly = setup({ env: { ANTHROPIC_API_KEY: SECRET } });
    expect((await claudeOnly.service.options()).body).toMatchObject({ code: "WRITING_CANDIDATE_READY", defaultProvider: "anthropic" });
    const openaiOnly = setup({ env: { OPENAI_API_KEY: SECRET, TITLE_WRITING_OPENAI_MODELS: "o-1" } });
    expect((await openaiOnly.service.options()).body).toMatchObject({ code: "WRITING_CANDIDATE_READY", defaultProvider: "openai" });
    const started = await openaiOnly.service.start(P1, STORY, TOKEN, CONTEXT("k1"));
    expect(requestOf(started)).toMatchObject({ providerKey: "openai", model: "o-1" });
    const none = setup({ env: {} });
    expect((await none.service.options()).body).toMatchObject({ code: "WRITING_CANDIDATE_PROVIDER_UNCONFIGURED", defaultProvider: null });
    // The configured default wins when it is ready.
    expect(((await setup({ defaultProvider: "openai" }).service.options()).body as { defaultProvider: string }).defaultProvider).toBe("openai");
  });

  it("the shared daily cap refuses before anything is written", async () => {
    const { service, store, sent } = setup({ maxCallsPerDay: 2 });
    store.otherCalls = [new Date().toISOString(), new Date().toISOString()];
    const refused = await service.start(P1, STORY, TOKEN, CONTEXT("k1"));
    expect([refused.status, errorOf(refused).code]).toEqual([429, "WRITING_CANDIDATE_DAILY_CAP"]);
    expect([store.records.size, sent.length]).toEqual([0, 0]);
  });

  it("lists a target's own requests newest first and reads only this work's requests", async () => {
    const { service, settle } = setup();
    const story = await service.start(P1, STORY, TOKEN, CONTEXT("k1"));
    await service.start(P1, EPISODE, TOKEN, CONTEXT("k2"));
    await settle();
    const stories = (await service.list(P1, { mode: "story" })).body as { items: Array<{ requestId: string; mode: string }> };
    expect(stories.items.map((item) => item.requestId)).toEqual([requestOf(story).requestId]);
    const episodes = (await service.list(P1, { mode: "episode", episodeId: E2 })).body as { items: Array<{ mode: string }> };
    expect(episodes.items.map((item) => item.mode)).toEqual(["episode"]);
    expect((await service.list(P1, { mode: "episode" })).status).toBe(400);
    expect((await service.get(P2, String(requestOf(story).requestId))).status).toBe(404);
  });
});
