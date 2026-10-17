// @vitest-environment happy-dom
// Start idempotency of "AI 一键创作". Simulated interface tests: fetch is mocked; no browser, API or model.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TitleWritingOptionsView, TitleWritingRunView } from "@ai-drama/contracts";
import { TitleWritingStart } from "./title-writing-start";

const P1 = "22222222-2222-4222-8222-222222222222";
const TOKEN = "operator-token-0123456789";
const DRAFT_KEY = "title-writing:start";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function options(overrides: Partial<TitleWritingOptionsView> = {}): TitleWritingOptionsView {
  return {
    enabled: true, code: "TITLE_WRITING_READY", storageReady: true, operatorTokenRequired: true, defaultProvider: "anthropic",
    providers: [
      { providerKey: "openai", label: "OpenAI", ready: true, models: ["d-1", "d-2"], defaultModel: "d-1", missing: [] },
      { providerKey: "anthropic", label: "Claude", ready: true, models: ["q-1", "q-2"], defaultModel: "q-1", missing: [] },
    ],
    maxCallsPerDay: 30, maxActiveRuns: 1, callCapPerRun: 8, billing: "unknown", defaults: { episodeCount: 3, episodeSeconds: 90, style: "" },
    episodePlan: { minEpisodes: 1, maxEpisodes: 6, defaultEpisodes: 3, secondsChoices: [60, 90], defaultSeconds: 90 }, episodePlanReady: true,
    ...overrides,
  };
}

function finished(state: TitleWritingRunView["state"] = "running"): { run: Partial<TitleWritingRunView> } {
  return { run: { runId: "66666666-6666-4666-8666-666666666666", projectId: P1, state } };
}

interface Call { method: string; url: string; headers: Record<string, string>; body: unknown }

/** handler answers POSTs; options can be swapped between mounts to model a server default change. */
function server(handler: (call: Call) => Response | Promise<Response>, current: { options: TitleWritingOptionsView } = { options: options() }) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? "GET", url: input, headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null };
    calls.push(call);
    if (input.endsWith("/writing/title-runs/options")) return json(current.options);
    return handler(call);
  }));
  return { calls, current };
}

const projectPosts = (calls: Call[]) => calls.filter((call) => call.method === "POST" && call.url === "/api/v1/projects");
const runPosts = (calls: Call[]) => calls.filter((call) => call.method === "POST" && call.url.endsWith("/title-runs"));

async function mount() {
  const view = render(<TitleWritingStart />);
  const button = await screen.findByRole("button", { name: /AI 一键创作|重试上次请求/ });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText("操作者令牌"), { target: { value: TOKEN } });
  return { view, button };
}

function fillNonDefault() {
  fireEvent.change(screen.getByLabelText("剧名"), { target: { value: "夜班证词" } });
  fireEvent.change(screen.getByLabelText("集数"), { target: { value: "5" } });
  fireEvent.change(screen.getByLabelText("每集时长"), { target: { value: "60" } });
  fireEvent.change(screen.getByLabelText("风格"), { target: { value: "悬疑" } });
  fireEvent.change(screen.getByLabelText("模型服务"), { target: { value: "openai" } });
  fireEvent.change(screen.getByLabelText("模型"), { target: { value: "d-2" } });
}

const NON_DEFAULT_BODY = { title: "夜班证词", providerKey: "openai", model: "d-2", settings: { episodeCount: 5, episodeSeconds: 60, style: "悬疑" } };
const NON_DEFAULT_PROJECT = { title: "夜班证词", premise: "", episodeCount: 5, targetEpisodeSeconds: 60 };

let assign: ReturnType<typeof vi.fn>;
const realSessionStorage = Object.getOwnPropertyDescriptor(window, "sessionStorage");

/** Replaces session storage for one test; afterEach puts the real one back. */
function useSessionStorage(overrides: Partial<Storage>): void {
  const map = new Map<string, string>();
  const fake = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
    clear: () => map.clear(),
    key: () => null,
    length: 0,
    ...overrides,
  };
  Object.defineProperty(window, "sessionStorage", { configurable: true, value: fake });
}

beforeEach(() => {
  assign = vi.fn();
  Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, assign, search: "" } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (realSessionStorage) Object.defineProperty(window, "sessionStorage", realSessionStorage);
  window.sessionStorage.clear();
});

describe("an unconfirmed start", () => {
  it("non-default settings, a lost run receipt and a reload: the form shows the frozen request and the retry replays it", async () => {
    let lose = true;
    const { calls } = server((call) => {
      if (call.url === "/api/v1/projects") return json({ id: P1 }, 201);
      if (lose) { lose = false; return Promise.reject(new TypeError("network")); }
      return json(finished(), 200);
    });
    const first = await mount();
    fillNonDefault();
    fireEvent.click(first.button);
    expect((await screen.findByRole("alert")).textContent).toContain("没有确认是否已经启动");
    expect(screen.getByRole("alert").textContent).not.toMatch(/不会重复/);
    first.view.unmount();

    // Reload: the server default is still qwen / 90 s, but the restored request is shown and locked.
    const second = await mount();
    expect(second.button.textContent).toBe("重试上次请求");
    expect((screen.getByLabelText("剧名") as HTMLInputElement).value).toBe("夜班证词");
    expect((screen.getByLabelText("剧名") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("集数") as HTMLSelectElement).value).toBe("5");
    expect((screen.getByLabelText("集数") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText("每集时长") as HTMLSelectElement).value).toBe("60");
    expect((screen.getByLabelText("风格") as HTMLInputElement).value).toBe("悬疑");
    expect(screen.getByText(/OpenAI · d-2（上次提交的选择）/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "查看进度" }).getAttribute("href")).toBe(`/projects/${P1}/writing`);
    fireEvent.click(second.button);
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/projects/${P1}/writing`));
    expect(projectPosts(calls)).toHaveLength(1);
    expect(projectPosts(calls)[0]?.body).toEqual(NON_DEFAULT_PROJECT);
    const runs = runPosts(calls);
    expect(runs).toHaveLength(2);
    expect(runs[0]?.body).toEqual(NON_DEFAULT_BODY);
    expect(runs[1]?.body).toEqual(NON_DEFAULT_BODY);
    expect(runs[1]?.headers["Idempotency-Key"]).toBe(runs[0]?.headers["Idempotency-Key"]);
    expect(window.sessionStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it("a lost project receipt and changed server defaults: the retry reuses the project key and the original body", async () => {
    let lose = true;
    const { calls, current } = server((call) => {
      if (call.url === "/api/v1/projects") {
        if (lose) { lose = false; return Promise.reject(new TypeError("network")); }
        return json({ id: P1 }, 200);
      }
      return json(finished(), 201);
    });
    const first = await mount();
    fireEvent.change(screen.getByLabelText("剧名"), { target: { value: "夜班证词" } });
    fireEvent.click(first.button);
    expect((await screen.findByRole("alert")).textContent).toContain("没有确认是否已经启动");
    first.view.unmount();
    current.options = options({ defaultProvider: "openai",
      episodePlan: { minEpisodes: 1, maxEpisodes: 6, defaultEpisodes: 6, secondsChoices: [60, 90], defaultSeconds: 60 } });

    const second = await mount();
    expect((screen.getByLabelText("集数") as HTMLSelectElement).value).toBe("3");
    expect((screen.getByLabelText("每集时长") as HTMLSelectElement).value).toBe("90");
    fireEvent.click(second.button);
    await waitFor(() => expect(assign).toHaveBeenCalled());
    const projects = projectPosts(calls);
    expect(projects).toHaveLength(2);
    expect(projects[1]?.headers["Idempotency-Key"]).toBe(projects[0]?.headers["Idempotency-Key"]);
    expect(projects[1]?.body).toEqual(projects[0]?.body);
    expect(projects[0]?.body).toEqual({ title: "夜班证词", premise: "", episodeCount: 3, targetEpisodeSeconds: 90 });
    expect(runPosts(calls).map((call) => call.body)).toEqual([
      { title: "夜班证词", providerKey: "anthropic", model: "q-1", settings: { episodeCount: 3, episodeSeconds: 90, style: "" } },
    ]);
  });

  it("a record saved by the earlier page (no plan, 180 seconds) is shown and replayed exactly as it was saved", async () => {
    const legacy = { version: 2, request: { title: "旧剧名", providerKey: "qwen", model: "q-1", settings: { episodeSeconds: 180, style: "悬疑" } },
      projectKey: "11111111-aaaa-4aaa-8aaa-111111111111", projectId: null, runKey: "22222222-bbbb-4bbb-8bbb-222222222222" };
    window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(legacy));
    const { calls } = server((call) => call.url === "/api/v1/projects" ? json({ id: P1 }, 201) : json(finished(), 201));
    const { button } = await mount();
    expect(button.textContent).toBe("重试上次请求");
    expect(screen.getByText(/集数：3 集 · 每集约 180 秒（上次请求来自旧版页面，按原样重放）/)).toBeTruthy();
    expect(screen.queryByLabelText("集数")).toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/projects/${P1}/writing`));
    expect(projectPosts(calls).map((call) => [call.body, call.headers["Idempotency-Key"]])).toEqual([[{ title: "旧剧名", premise: "" }, legacy.projectKey]]);
    expect(runPosts(calls).map((call) => [call.body, call.headers["Idempotency-Key"]])).toEqual([[legacy.request, legacy.runKey]]);
  });

  it.each(["qwen"])("a stored request of the retired provider %s is kept, shown with its real provider and replayed unchanged", async (retired) => {
    const stored = { version: 2, request: { title: "旧剧名", providerKey: retired, model: `${retired}-old`, settings: { episodeSeconds: 90, style: "" } },
      projectKey: "11111111-aaaa-4aaa-8aaa-111111111111", projectId: P1, runKey: "22222222-bbbb-4bbb-8bbb-222222222222" };
    window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(stored));
    const label = "千问（已退役）";
    const { calls } = server(() => json({ error: { code: "TITLE_WRITING_PROVIDER_RETIRED", message: "x", details: { providerKey: retired, label } } }, 409));
    const { button } = await mount();
    expect(button.textContent).toBe("重试上次请求");
    expect(screen.getByText(new RegExp(`模型服务：${label} · ${retired}-old`))).toBeTruthy();
    fireEvent.click(button);
    // The server found no run for this identity: it created and sent nothing, and the page says so.
    expect((await screen.findByRole("alert")).textContent).toContain(`上次请求选择的模型服务（${label}）已经退役。服务端没有找到这次请求创建的任务，也没有发出模型调用。`);
    expect(runPosts(calls).map((call) => [call.body, call.headers["Idempotency-Key"]])).toEqual([[stored.request, stored.runKey]]);
    expect(projectPosts(calls)).toHaveLength(0);
    // The identity is not silently dropped: only the person can abandon it.
    expect(JSON.parse(window.sessionStorage.getItem(DRAFT_KEY) ?? "null")).toEqual(stored);
    expect(assign).not.toHaveBeenCalled();
  });

  it("the same unconfirmed request replayed several times always carries the same body and both keys", async () => {
    let failures = 2;
    const { calls } = server((call) => {
      if (call.url === "/api/v1/projects") return json({ id: P1 }, 201);
      if (failures > 0) { failures -= 1; return json({ error: { code: "INTERNAL", message: "x" } }, 503); }
      return json(finished(), 200);
    });
    const { button } = await mount();
    fillNonDefault();
    fireEvent.click(button);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await screen.findByRole("alert");
      await waitFor(() => expect((screen.getByRole("button", { name: "重试上次请求" }) as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(screen.getByRole("button", { name: "重试上次请求" }));
    }
    await waitFor(() => expect(assign).toHaveBeenCalled());
    const runs = runPosts(calls);
    expect(runs).toHaveLength(3);
    expect(new Set(runs.map((call) => call.headers["Idempotency-Key"])).size).toBe(1);
    expect(runs.every((call) => JSON.stringify(call.body) === JSON.stringify(NON_DEFAULT_BODY))).toBe(true);
    expect(projectPosts(calls)).toHaveLength(1);
  });

  it("a retry after the original run already finished replays the same key and opens that run", async () => {
    let lose = true;
    const { calls } = server((call) => {
      if (call.url === "/api/v1/projects") return json({ id: P1 }, 201);
      if (lose) { lose = false; return Promise.reject(new TypeError("network")); }
      // The server matched the key to the original, completed run: 200, no new run.
      return json(finished("completed"), 200);
    });
    const first = await mount();
    fillNonDefault();
    fireEvent.click(first.button);
    await screen.findByRole("alert");
    first.view.unmount();
    const second = await mount();
    fireEvent.click(second.button);
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/projects/${P1}/writing`));
    const runs = runPosts(calls);
    expect(runs.map((call) => call.headers["Idempotency-Key"])).toEqual([runs[0]?.headers["Idempotency-Key"], runs[0]?.headers["Idempotency-Key"]]);
    expect(runs[1]?.body).toEqual(runs[0]?.body);
  });

  it("starting something new is a separate, explicit choice with new keys", async () => {
    let lose = true;
    const { calls } = server((call) => {
      if (call.url === "/api/v1/projects") return json({ id: P1 }, 201);
      if (lose) { lose = false; return Promise.reject(new TypeError("network")); }
      return json(finished(), 201);
    });
    const { button } = await mount();
    fillNonDefault();
    fireEvent.click(button);
    await screen.findByRole("alert");
    fireEvent.click(await screen.findByRole("button", { name: "放弃上次请求，重新填写" }));
    expect(window.sessionStorage.getItem(DRAFT_KEY)).toBeNull();
    expect((screen.getByLabelText("剧名") as HTMLInputElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("剧名"), { target: { value: "天台" } });
    fireEvent.click(screen.getByRole("button", { name: "AI 一键创作" }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    const projects = projectPosts(calls);
    const runs = runPosts(calls);
    expect(projects).toHaveLength(2);
    expect(projects[1]?.headers["Idempotency-Key"]).not.toBe(projects[0]?.headers["Idempotency-Key"]);
    expect(runs[1]?.headers["Idempotency-Key"]).not.toBe(runs[0]?.headers["Idempotency-Key"]);
  });
});

describe("when the request identity cannot be kept", () => {
  it("a failing session storage write sends nothing at all", async () => {
    const { calls } = server(() => json({ id: P1 }, 201));
    const { button } = await mount();
    useSessionStorage({ setItem: () => { throw new Error("QuotaExceededError"); } });
    fireEvent.change(screen.getByLabelText("剧名"), { target: { value: "夜班证词" } });
    fireEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toContain("没有发送请求");
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("a write that cannot be read back sends nothing", async () => {
    const { calls } = server(() => json({ id: P1 }, 201));
    const { button } = await mount();
    useSessionStorage({ getItem: () => null });
    fireEvent.change(screen.getByLabelText("剧名"), { target: { value: "夜班证词" } });
    fireEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toContain("没有发送请求");
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("the project id cannot be saved after the project was created: the run is not started", async () => {
    const { calls } = server(() => json({ id: P1 }, 201));
    const { button } = await mount();
    const saved = new Map<string, string>();
    let writes = 0;
    useSessionStorage({
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes += 1;
        if (writes > 1) throw new Error("QuotaExceededError");
        saved.set(key, value);
      },
    });
    fireEvent.change(screen.getByLabelText("剧名"), { target: { value: "夜班证词" } });
    fireEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toContain("没有发送请求");
    expect(projectPosts(calls)).toHaveLength(1);
    expect(runPosts(calls)).toHaveLength(0);
  });

  it("the operator token never reaches browser storage", async () => {
    server((call) => call.url === "/api/v1/projects" ? json({ id: P1 }, 201) : Promise.reject(new TypeError("network")));
    const { button } = await mount();
    fireEvent.change(screen.getByLabelText("剧名"), { target: { value: "夜班证词" } });
    fireEvent.click(button);
    await screen.findByRole("alert");
    expect(window.sessionStorage.getItem(DRAFT_KEY)).not.toContain(TOKEN);
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(TOKEN);
  });
});

describe("the episode plan of a new work", () => {
  it("shows the normal requests and the cap for the chosen count, and offers only 1–6 episodes and about 1 or 1.5 minutes", async () => {
    server(() => json({ id: P1 }, 201));
    await mount();
    expect([...(screen.getByLabelText("集数") as HTMLSelectElement).options].map((option) => option.value)).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect([...(screen.getByLabelText("每集时长") as HTMLSelectElement).options].map((option) => option.textContent)).toEqual(["约 1 分钟", "约 1.5 分钟"]);
    expect(screen.getByText(/正常需要 5 次模型调用，这次创作最多 8 次/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("集数"), { target: { value: "6" } });
    expect(screen.getByText(/正常需要 8 次模型调用，这次创作最多 11 次/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("集数"), { target: { value: "1" } });
    expect(screen.getByText(/正常需要 3 次模型调用，这次创作最多 6 次/)).toBeTruthy();
    expect(screen.getByText(/每集时长是写作目标，用来控制剧本篇幅，不代表成片已经达到这个长度/)).toBeTruthy();
  });

  it("a quota refusal confirms the work exists and this request created no new run or call", async () => {
    server((call) => call.url === "/api/v1/projects" ? json({ id: P1 }, 201)
      : json({ error: { code: "TITLE_WRITING_DAILY_QUOTA_LOW", message: "额度不足", details: { requiredCalls: 8, remainingCalls: 2 } } }, 429));
    const { button } = await mount();
    fireEvent.change(screen.getByLabelText("剧名"), { target: { value: "夜班证词" } });
    fireEvent.change(screen.getByLabelText("集数"), { target: { value: "6" } });
    fireEvent.click(button);
    const alert = (await screen.findByRole("alert")).textContent ?? "";
    expect(alert).toContain("作品已经创建，可以在作品列表里找到");
    expect(alert).not.toContain("空作品");
    expect(alert).toContain("本次请求未创建新任务，也未发出模型调用");
    expect(alert).toContain("最近 24 小时还剩 2 次调用，这次创作正常需要 8 次");
    expect(assign).not.toHaveBeenCalled();
  });

  it("while the server's episode plan storage is not ready, a new work is not started and nothing is sent", async () => {
    const { calls } = server(() => json({ id: P1 }, 201), { options: options({ episodePlanReady: false }) });
    const { button } = await mount();
    expect(screen.getByText(/集数和时长设置还没有在服务器上就绪/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("剧名"), { target: { value: "夜班证词" } });
    fireEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toContain("数据库迁移尚未执行");
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
  });
});

describe("the site login authorizes the call", () => {
  beforeEach(() => { window.sessionStorage.clear(); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.sessionStorage.clear(); });

  it("shows no token field and sends no X-Operator-Token when the server says the session is enough", async () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    const { calls } = server((call) => call.url === "/api/v1/projects"
      ? json({ id: P1, title: "夜班证词", premise: "", version: 1, status: "ACTIVE" }, 201)
      : json(finished(), 201), { options: options({ operatorTokenRequired: false }) });
    render(<TitleWritingStart />);
    const button = await screen.findByRole("button", { name: "AI 一键创作" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByLabelText("操作者令牌")).toBeNull();
    expect(screen.getByText("调用权限由当前管理员登录确认，不需要填写操作者令牌。模型密钥只在服务端。")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("剧名"), { target: { value: "夜班证词" } });
    fireEvent.click(button);
    await waitFor(() => expect(runPosts(calls)).toHaveLength(1));
    expect(Object.keys(runPosts(calls)[0]!.headers).map((name) => name.toLowerCase())).not.toContain("x-operator-token");
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/projects/${P1}/writing`));
  });
});
