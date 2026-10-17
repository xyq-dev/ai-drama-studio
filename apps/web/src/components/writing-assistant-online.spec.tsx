// @vitest-environment happy-dom
/**
 * Online candidates in the writing assistant against a fake server that keeps the API's rules (one request per key,
 * one open request per target, an unknown result is never resent). The candidates are handwritten fixtures, not model
 * results. A real browser, the real API and PostgreSQL are covered by the writing online browser acceptance.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WritingCandidateView } from "@ai-drama/contracts";
import type { StoryPlanCandidate, WritingTargetSnapshot } from "@ai-drama/domain/writing-assistant";
import { WritingAssistant } from "./writing-assistant";

const P1 = "22222222-2222-4222-8222-222222222222";
const P2 = "33333333-3333-4333-8333-333333333333";
const E2 = "55555555-5555-4555-8555-555555555555";

const PLAN: StoryPlanCandidate = {
  schema: "ads.writing.story-plan.v1",
  logline: "手写在线候选，不是模型结果",
  protagonistGoal: "守住班次记录",
  opposition: "店长能改时间",
  coreConflict: "解释会被当成承认",
  relationships: [{ name: "店员", pressure: "不能供出同事" }],
  episodes: [1, 2, 3].map((episodeNo) => ({ episodeNo: episodeNo as 1 | 2 | 3, entryState: `进入${episodeNo}`, goal: `目标${episodeNo}`,
    action: `行动${episodeNo}`, turn: `转折${episodeNo}`, result: `结果${episodeNo}`, handoff: `交接${episodeNo}` })),
};

function json(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

interface ServerOptions {
  tokenRequired?: boolean;
  /** What the request becomes when it is read (after its send). */
  outcome?: "completed" | "unknown" | "rejected";
  /** Reads before the request is reported finished. */
  pendingReads?: number;
  /** Cut the answer of the first POST after the server stored it. */
  dropFirstAnswer?: boolean;
  /** Hold every GET of a request until released. */
  holdReads?: Promise<void>;
  /** The options answer instead of the ready Claude one. */
  optionsBody?: Record<string, unknown>;
}

/** A fake API: the request is stored before its answer; the same key returns the same request. */
function fakeServer(options: ServerOptions = {}) {
  const posts: Array<{ url: string; key: string | null; token: string | null; body: Record<string, unknown> }> = [];
  const requests = new Map<string, WritingCandidateView & { key: string; reads: number }>();
  let dropped = false;
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    if (url === "/api/v1/writing/candidates/options") {
      if (options.optionsBody) return json(options.optionsBody);
      return json({ enabled: true, code: "WRITING_CANDIDATE_READY", storageReady: true, operatorTokenRequired: options.tokenRequired ?? false,
        defaultProvider: "anthropic", maxCallsPerDay: 30, billing: "unknown", providers: [
          { providerKey: "openai", label: "OpenAI", ready: false, models: [], defaultModel: null, missing: ["OPENAI_API_KEY"] },
          { providerKey: "anthropic", label: "Claude", ready: true, models: ["claude-opus-5-5", "claude-sonnet-5-5"], defaultModel: "claude-opus-5-5", missing: [] },
        ] });
    }
    const list = /^\/api\/v1\/projects\/([^/]+)\/writing\/candidates\?(.*)$/.exec(url);
    if (list && method === "GET") {
      const mode = new URLSearchParams(list[2]).get("mode");
      return json({ items: [...requests.values()].filter((item) => item.projectId === list[1] && item.mode === mode).reverse() });
    }
    const one = /^\/api\/v1\/projects\/([^/]+)\/writing\/candidates\/([^/?]+)$/.exec(url);
    if (one && method === "GET") {
      if (options.holdReads) await options.holdReads;
      const found = requests.get(one[2]!);
      if (!found || found.projectId !== one[1]) return json({ error: { code: "NOT_FOUND", message: "没有找到这次在线生成。" } }, 404);
      found.reads += 1;
      if (found.state === "reserved" && found.reads > (options.pendingReads ?? 0)) {
        const outcome = options.outcome ?? "completed";
        Object.assign(found, outcome === "completed"
          ? { state: "completed", candidate: { mode: "story", plan: PLAN } }
          : { state: outcome, errorCode: outcome === "unknown" ? "timeout" : "refusal" });
      }
      return json({ request: found });
    }
    const start = /^\/api\/v1\/projects\/([^/]+)\/writing\/candidates$/.exec(url);
    if (start && method === "POST") {
      const key = headers.get("Idempotency-Key");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      posts.push({ url, key, token: headers.get("X-Operator-Token"), body });
      let found = [...requests.values()].find((item) => item.key === key);
      if (!found) {
        const open = [...requests.values()].find((item) => item.projectId === start[1] && item.state === "reserved");
        if (open) return json({ error: { code: "WRITING_CANDIDATE_ACTIVE", message: "这个编辑对象已有一次在线生成正在进行，请等它结束。没有发出新的调用。", details: { requestId: open.requestId } } }, 409);
        const latest = [...requests.values()].filter((item) => item.projectId === start[1]).at(-1);
        if (latest?.state === "unknown" && body.confirmUncertainRequestId !== latest.requestId) {
          return json({ error: { code: "WRITING_CANDIDATE_NEEDS_CONFIRMATION", message: "上一次在线生成的结果不确定，可能已经产生费用。请先确认后再发起新的生成。", details: { requestId: latest.requestId } } }, 409);
        }
        const id = `9999999${String(requests.size)}-9999-4999-8999-999999999999`;
        found = { key: key ?? "", reads: 0, requestId: id, projectId: start[1]!, mode: body.mode as "story", episodeId: (body.episodeId as string | undefined) ?? null,
          episodeNo: null, providerKey: "anthropic", providerLabel: "Claude", model: String(body.model), state: "reserved", errorCode: null,
          providerRequestId: null, responseModel: null, usage: { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null },
          billing: "unknown", base: body.base as { sourceRevisionId: string | null; ifMatch: number }, request: body.request as never, candidate: null,
          createdAt: new Date(Date.now() + requests.size).toISOString(), finishedAt: null };
        requests.set(id, found);
      }
      if (options.dropFirstAnswer && !dropped) {
        dropped = true;
        throw new TypeError("network connection lost");
      }
      return json({ request: found }, 202);
    }
    return json({ error: { code: "NOT_FOUND", message: url } }, 404);
  });
  return { fetch, posts, requests };
}

function target(projectId = P1, draftFingerprint = "same"): WritingTargetSnapshot {
  return { projectId, entityKey: "story", mode: "story", episodeNo: null, sourceRevisionId: "66666666-6666-4666-8666-666666666666", ifMatch: 4,
    draftFingerprint, currentText: "旧故事", loaded: true };
}

function props(extra: { projectId?: string; onAdopt?: (text: string) => boolean; capture?: () => WritingTargetSnapshot } = {}) {
  return {
    mode: "story" as const, projectId: extra.projectId ?? P1, entityKey: "story", episodeNo: null, premise: "夜班便利店", confirmedMaterials: "",
    loaded: true, capture: extra.capture ?? (() => target(extra.projectId ?? P1)), onAdopt: extra.onAdopt ?? (() => true),
  };
}

async function openAssistant() {
  fireEvent.click(screen.getByRole("button", { name: "编剧助手" }));
  await screen.findByTestId("online-provider");
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("online candidates in the writing assistant", () => {
  it("asks once, shows the candidate and its diff, adopts only on click, and never saves", async () => {
    const server = fakeServer({ pendingReads: 1 });
    vi.stubGlobal("fetch", server.fetch);
    const adopted: string[] = [];
    render(createElement(WritingAssistant, props({ onAdopt: (text) => { adopted.push(text); return true; } })));
    await openAssistant();
    expect(screen.getByTestId("online-provider").textContent).toContain("Claude · claude-opus-5-5");
    // The site login authorizes the call: no token field.
    expect(screen.queryByLabelText("操作者令牌")).toBeNull();
    const generate = screen.getByRole("button", { name: "在线生成故事候选" });
    fireEvent.click(generate);
    fireEvent.click(generate);
    expect(await screen.findByLabelText("候选正文", undefined, { timeout: 5_000 })).toBeTruthy();
    expect(server.posts).toHaveLength(1);
    expect(server.posts[0]).toMatchObject({ token: null, body: { mode: "story", providerKey: "anthropic", model: "claude-opus-5-5",
      base: { sourceRevisionId: "66666666-6666-4666-8666-666666666666", ifMatch: 4 } } });
    expect((server.posts[0]!.body.request as { premise: string }).premise).toBe("夜班便利店");
    expect((screen.getByLabelText("候选正文") as HTMLTextAreaElement).value).toContain("手写在线候选，不是模型结果");
    expect(screen.getByText("与当前正文的差异")).toBeTruthy();
    expect(adopted).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "采纳到草稿" }));
    expect(adopted).toHaveLength(1);
    expect(adopted[0]).toContain("一句话故事");
    expect(screen.getByText("已放入编辑草稿。还没有保存，请使用原来的保存新版本。")).toBeTruthy();
    // Only the one POST to the candidate route: nothing was saved by the assistant.
    expect(server.fetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toHaveLength(1);
    // The history lists it; a refresh does not hand it over a second time.
    await waitFor(() => expect(screen.getByText(/Claude claude-opus-5-5 · 已生成/)).toBeTruthy());
  });

  it("a lost answer keeps the request: the next click replays the same key and body, and the server sends nothing new", async () => {
    const server = fakeServer({ dropFirstAnswer: true });
    vi.stubGlobal("fetch", server.fetch);
    render(createElement(WritingAssistant, props()));
    await openAssistant();
    fireEvent.click(screen.getByRole("button", { name: "在线生成故事候选" }));
    expect(await screen.findByText(/没有确认这次请求是否已被受理/)).toBeTruthy();
    const replay = screen.getByRole("button", { name: "确认上次请求" });
    fireEvent.click(replay);
    expect(await screen.findByLabelText("候选正文", undefined, { timeout: 5_000 })).toBeTruthy();
    expect(server.posts).toHaveLength(2);
    expect(server.posts[1]!.key).toBe(server.posts[0]!.key);
    expect(server.posts[1]!.body).toEqual(server.posts[0]!.body);
    expect(server.requests.size).toBe(1);
  });

  it("a replay refused by the access gate (login or operator) keeps the unconfirmed request for a later replay", async () => {
    const server = fakeServer({ dropFirstAnswer: true });
    vi.stubGlobal("fetch", server.fetch);
    render(createElement(WritingAssistant, props()));
    await openAssistant();
    fireEvent.click(screen.getByRole("button", { name: "在线生成故事候选" }));
    await screen.findByText(/没有确认这次请求是否已被受理/);
    const stored = sessionStorage.getItem(`ads-writing-online:${P1}:story`);
    expect(stored).toContain("\"requestId\":null");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "WRITING_CANDIDATE_FORBIDDEN", message: "没有调用权限。" } }), { status: 403 })));
    fireEvent.click(screen.getByRole("button", { name: "确认上次请求" }));
    expect(await screen.findByText(/请求记录已保留/)).toBeTruthy();
    expect(sessionStorage.getItem(`ads-writing-online:${P1}:story`)).toBe(stored);
    expect(screen.getByRole("button", { name: "确认上次请求" })).toBeTruthy();
  });

  it("after a reload it reads the request this tab sent and never sends it again", async () => {
    const server = fakeServer({ pendingReads: 2 });
    vi.stubGlobal("fetch", server.fetch);
    const first = render(createElement(WritingAssistant, props()));
    await openAssistant();
    fireEvent.click(screen.getByRole("button", { name: "在线生成故事候选" }));
    await waitFor(() => expect(server.posts).toHaveLength(1));
    first.unmount();
    render(createElement(WritingAssistant, props()));
    await openAssistant();
    expect(await screen.findByLabelText("候选正文", undefined, { timeout: 8_000 })).toBeTruthy();
    expect(server.posts).toHaveLength(1);
  });

  it("an unknown result is shown as possibly charged; a new request needs the confirmation of that request", async () => {
    const server = fakeServer({ outcome: "unknown" });
    vi.stubGlobal("fetch", server.fetch);
    render(createElement(WritingAssistant, props()));
    await openAssistant();
    fireEvent.click(screen.getByRole("button", { name: "在线生成故事候选" }));
    expect(await screen.findByText(/结果不确定：模型服务可能已经处理并产生费用，系统不会自动重发/, undefined, { timeout: 5_000 })).toBeTruthy();
    expect(screen.queryByLabelText("候选正文")).toBeNull();
    const button = screen.getByRole("button", { name: "在线生成故事候选" }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(true));
    const confirm = screen.getByRole("checkbox", { name: /上一次结果不确定的请求可能已经产生费用/ });
    fireEvent.click(confirm);
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(server.posts).toHaveLength(2));
    expect(server.posts[1]!.body.confirmUncertainRequestId).toBe([...server.requests.keys()][0]);
    expect(server.posts[1]!.key).not.toBe(server.posts[0]!.key);
  });

  it("a candidate that arrives after the inputs changed is kept for viewing but cannot overwrite the new draft", async () => {
    const server = fakeServer({ pendingReads: 1 });
    vi.stubGlobal("fetch", server.fetch);
    let fingerprint = "same";
    const adopted: string[] = [];
    render(createElement(WritingAssistant, props({ capture: () => target(P1, fingerprint), onAdopt: (text) => { adopted.push(text); return true; } })));
    await openAssistant();
    fireEvent.click(screen.getByRole("button", { name: "在线生成故事候选" }));
    // The person keeps editing while the model works.
    fingerprint = "edited";
    expect(await screen.findByLabelText("候选正文", undefined, { timeout: 5_000 })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "采纳到草稿" }));
    expect(await screen.findByText("正文草稿已变化。候选仍保留，不能直接覆盖。")).toBeTruthy();
    expect(adopted).toHaveLength(0);
    expect((screen.getByLabelText("候选正文") as HTMLTextAreaElement).value).toContain("手写在线候选");
  });

  it("a late answer for another work is dropped: it never lands in the work now open", async () => {
    let release!: () => void;
    const holdReads = new Promise<void>((resolve) => { release = resolve; });
    const server = fakeServer({ holdReads });
    vi.stubGlobal("fetch", server.fetch);
    const view = render(createElement(WritingAssistant, props()));
    await openAssistant();
    fireEvent.click(screen.getByRole("button", { name: "在线生成故事候选" }));
    await waitFor(() => expect(server.posts).toHaveLength(1));
    view.rerender(createElement(WritingAssistant, props({ projectId: P2 })));
    await act(async () => { release(); await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(screen.queryByLabelText("候选正文")).toBeNull();
    expect(sessionStorage.getItem(`ads-writing:${P2}:story`) ?? "").not.toContain("手写在线候选");
    expect(sessionStorage.getItem(`ads-writing-online:${P2}:story`)).toBeNull();
  });

  it("without the site login the page asks for the operator token and sends it only in its header", async () => {
    const server = fakeServer({ tokenRequired: true });
    vi.stubGlobal("fetch", server.fetch);
    render(createElement(WritingAssistant, props()));
    await openAssistant();
    const button = screen.getByRole("button", { name: "在线生成故事候选" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("操作者令牌"), { target: { value: "operator-token-0123456789" } });
    fireEvent.click(button);
    await waitFor(() => expect(server.posts).toHaveLength(1));
    expect(server.posts[0]!.token).toBe("operator-token-0123456789");
    expect(JSON.stringify(server.posts[0]!.body)).not.toContain("operator-token");
    expect(JSON.stringify({ ...sessionStorage })).not.toContain("operator-token-0123456789");
  });

  it("an episode request names its episode and keeps the dialogue, ending and revision constraints", async () => {
    const server = fakeServer();
    vi.stubGlobal("fetch", server.fetch);
    render(createElement(WritingAssistant, { ...props(), mode: "episode" as const, entityKey: `script:${E2}`, episodeNo: 2, episodeId: E2,
      confirmedMaterials: "已确认的故事", capture: () => ({ ...target(), entityKey: `script:${E2}`, mode: "episode" as const, episodeNo: 2 }) }));
    fireEvent.click(screen.getByRole("button", { name: "编剧助手" }));
    await screen.findByTestId("online-provider");
    fireEvent.change(screen.getByLabelText("修改要求"), { target: { value: "节奏更紧" } });
    fireEvent.change(screen.getByLabelText("必须保留的对白"), { target: { value: "店长：你自己看时间。" } });
    fireEvent.click(screen.getByRole("button", { name: "在线生成本集候选" }));
    // Not yet confirmed: refused on the page, nothing sent.
    expect(await screen.findByText("请先确认使用当前已加载的故事与分集材料")).toBeTruthy();
    expect(server.posts).toHaveLength(0);
    fireEvent.click(screen.getByLabelText("确认使用当前已加载的故事与分集材料"));
    fireEvent.click(screen.getByRole("button", { name: "在线生成本集候选" }));
    await waitFor(() => expect(server.posts).toHaveLength(1));
    expect(server.posts[0]!.body).toMatchObject({ mode: "episode", episodeId: E2,
      request: { episodeNo: 2, confirmedStory: "已确认的故事", revisionRequest: "节奏更紧", mustKeepDialogue: "店长：你自己看时间。" } });
  });
});

describe("why online candidates cannot be asked for, from the real providers and gaps", () => {
  const provider = (providerKey: string, label: string, missing: string[], models: string[] = []) => ({ providerKey, label, ready: missing.length === 0,
    models, defaultModel: models[0] ?? null, missing });
  const optionsWith = (code: string, defaultProvider: string | null, providers: unknown[], extra: Record<string, unknown> = {}) => ({
    enabled: true, code, storageReady: true, operatorTokenRequired: false, defaultProvider, maxCallsPerDay: 30, billing: "unknown", providers, ...extra });
  const NO_KEYS = [provider("openai", "OpenAI", ["OPENAI_API_KEY", "TITLE_WRITING_OPENAI_MODELS"]), provider("anthropic", "Claude", ["ANTHROPIC_API_KEY"]),
    provider("deepseek", "DeepSeek", ["DEEPSEEK_API_KEY"])];

  async function open(optionsBody: Record<string, unknown>) {
    const server = fakeServer({ optionsBody });
    vi.stubGlobal("fetch", server.fetch);
    render(createElement(WritingAssistant, props()));
    fireEvent.click(screen.getByRole("button", { name: "编剧助手" }));
    return server;
  }

  it("no provider has a key: every provider's own gap is named, not a fixed request to configure Claude", async () => {
    const server = await open(optionsWith("WRITING_CANDIDATE_PROVIDER_UNCONFIGURED", null, NO_KEYS));
    const text = (await screen.findByTestId("online-unavailable")).textContent ?? "";
    expect(text).toContain("OpenAI：尚未配置 OpenAI API Key、尚未配置 OpenAI 模型");
    expect(text).toContain("Claude：尚未配置 Claude API Key");
    expect(text).toContain("DeepSeek：尚未配置 DeepSeek API Key");
    expect(screen.queryByTestId("online-provider")).toBeNull();
    expect(server.posts).toHaveLength(0);
  });

  it("only DeepSeek is configured and its candidate migration is missing: the migration is named, no key or other provider is asked for", async () => {
    await open(optionsWith("WRITING_CANDIDATE_PROVIDER_UNCONFIGURED", "deepseek", [NO_KEYS[0], NO_KEYS[1],
      provider("deepseek", "DeepSeek", ["WRITING_CANDIDATE_DEEPSEEK_MIGRATION"], ["deepseek-flash"])]));
    const text = (await screen.findByTestId("online-unavailable")).textContent ?? "";
    expect(text).toContain("DeepSeek：数据库迁移 20261017000100_writing_candidate_deepseek 尚未执行");
    expect(text).not.toMatch(/API Key|Claude|OpenAI/);
  });

  it("a saved configuration that waits for the restart is said so, apart from what is missing", async () => {
    await open(optionsWith("WRITING_CANDIDATE_PROVIDER_UNCONFIGURED", "deepseek", NO_KEYS, { configurationPending: true }));
    const text = (await screen.findByTestId("online-unavailable")).textContent ?? "";
    expect(text).toContain("后台已保存新的模型配置，需要服务器重启 API 后才会生效。");
    expect(text).toContain("DeepSeek：尚未配置 DeepSeek API Key");
  });

  it("the candidate storage itself is not ready: its own migration is named", async () => {
    await open(optionsWith("WRITING_CANDIDATE_STORAGE_UNAVAILABLE", null, NO_KEYS, { storageReady: false }));
    expect((await screen.findByTestId("online-unavailable")).textContent).toContain("20261016000200_writing_candidate");
  });

  it("the configured default DeepSeek is not ready while Claude is: nothing is sent until Claude is chosen explicitly", async () => {
    const server = await open(optionsWith("WRITING_CANDIDATE_READY", "deepseek", [NO_KEYS[0],
      provider("anthropic", "Claude", [], ["claude-opus-5-5"]), provider("deepseek", "DeepSeek", ["WRITING_CANDIDATE_DEEPSEEK_MIGRATION"], ["deepseek-flash"])]));
    const blocked = await screen.findByTestId("online-provider-blocked");
    expect(blocked.textContent).toContain("默认模型服务暂不可用，没有发出调用，也不会自动改用其他模型服务");
    expect(blocked.textContent).toContain("20261017000100_writing_candidate_deepseek");
    expect(screen.queryByTestId("online-provider")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "在线生成故事候选" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.posts).toHaveLength(0);
    const select = screen.getByLabelText("模型服务") as HTMLSelectElement;
    expect(select.value).toBe("deepseek");
    expect([...select.options].map((option) => [option.value, option.disabled])).toEqual([["deepseek", true], ["anthropic", false]]);
    fireEvent.change(select, { target: { value: "anthropic" } });
    expect((await screen.findByTestId("online-provider")).textContent).toContain("Claude · claude-opus-5-5");
    fireEvent.click(screen.getByRole("button", { name: "在线生成故事候选" }));
    await waitFor(() => expect(server.posts).toHaveLength(1));
    expect(server.posts[0]!.body).toMatchObject({ providerKey: "anthropic", model: "claude-opus-5-5" });
  });
});
