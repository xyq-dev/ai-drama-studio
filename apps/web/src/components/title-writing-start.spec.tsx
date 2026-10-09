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
    enabled: true, code: "TITLE_WRITING_READY", storageReady: true, operatorTokenRequired: true, defaultProvider: "qwen",
    providers: [
      { providerKey: "qwen", label: "千问", ready: true, models: ["q-1", "q-2"], defaultModel: "q-1", missing: [] },
      { providerKey: "openai", label: "OpenAI", ready: false, models: [], defaultModel: null, missing: ["OPENAI_API_KEY"] },
      { providerKey: "deepseek", label: "DeepSeek", ready: true, models: ["d-1", "d-2"], defaultModel: "d-1", missing: [] },
    ],
    maxCallsPerDay: 30, maxActiveRuns: 1, callCapPerRun: 8, billing: "unknown", defaults: { episodeCount: 3, episodeSeconds: 90, style: "" },
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
  fireEvent.change(screen.getByLabelText("每集时长"), { target: { value: "180" } });
  fireEvent.change(screen.getByLabelText("风格"), { target: { value: "悬疑" } });
  fireEvent.change(screen.getByLabelText("模型服务"), { target: { value: "deepseek" } });
  fireEvent.change(screen.getByLabelText("模型"), { target: { value: "d-2" } });
}

const NON_DEFAULT_BODY = { title: "夜班证词", providerKey: "deepseek", model: "d-2", settings: { episodeSeconds: 180, style: "悬疑" } };

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
    expect((screen.getByLabelText("每集时长") as HTMLSelectElement).value).toBe("180");
    expect((screen.getByLabelText("风格") as HTMLInputElement).value).toBe("悬疑");
    expect(screen.getByText(/DeepSeek · d-2（上次提交的选择）/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "查看进度" }).getAttribute("href")).toBe(`/projects/${P1}/writing`);
    fireEvent.click(second.button);
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/projects/${P1}/writing`));
    expect(projectPosts(calls)).toHaveLength(1);
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
    current.options = options({ defaultProvider: "deepseek", defaults: { episodeCount: 3, episodeSeconds: 120, style: "" } });

    const second = await mount();
    expect((screen.getByLabelText("每集时长") as HTMLSelectElement).value).toBe("90");
    fireEvent.click(second.button);
    await waitFor(() => expect(assign).toHaveBeenCalled());
    const projects = projectPosts(calls);
    expect(projects).toHaveLength(2);
    expect(projects[1]?.headers["Idempotency-Key"]).toBe(projects[0]?.headers["Idempotency-Key"]);
    expect(projects[1]?.body).toEqual(projects[0]?.body);
    expect(runPosts(calls).map((call) => call.body)).toEqual([
      { title: "夜班证词", providerKey: "qwen", model: "q-1", settings: { episodeSeconds: 90, style: "" } },
    ]);
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
