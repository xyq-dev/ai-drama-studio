// @vitest-environment happy-dom
// Simulated interface tests. fetch is mocked; this file does not start a browser, the API or a model.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TitleWritingOptionsView, TitleWritingRunView, TitleWritingStepView } from "@ai-drama/contracts";
import { TitleWritingClient, runHeadline } from "../lib/title-writing-client";
import { BeginnerStart } from "./beginner-start";
import { TITLE_WRITING_POLL_MS, TitleWritingRun } from "./title-writing-run";

const P1 = "22222222-2222-4222-8222-222222222222";
const RUN = "66666666-6666-4666-8666-666666666666";
const TOKEN = "operator-token-0123456789";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function options(overrides: Partial<TitleWritingOptionsView> = {}): TitleWritingOptionsView {
  return {
    enabled: true, code: "TITLE_WRITING_READY", storageReady: true, operatorTokenRequired: true, defaultProvider: "qwen",
    providers: [
      { providerKey: "qwen", label: "千问", ready: true, models: ["q-1", "q-2"], defaultModel: "q-1", missing: [] },
      { providerKey: "openai", label: "OpenAI", ready: false, models: [], defaultModel: null, missing: ["OPENAI_API_KEY", "TITLE_WRITING_OPENAI_MODELS"] },
      { providerKey: "deepseek", label: "DeepSeek", ready: true, models: ["d-1"], defaultModel: "d-1", missing: [] },
    ],
    maxCallsPerDay: 30, maxActiveRuns: 1, callCapPerRun: 8, billing: "unknown",
    defaults: { episodeCount: 3, episodeSeconds: 90, style: "" },
    ...overrides,
  };
}

const KEYS = ["concept", "outline", "episode:1", "episode:2", "episode:3"] as const;

function steps(states: Array<TitleWritingStepView["state"]>): TitleWritingStepView[] {
  return KEYS.map((stepKey, index) => {
    const state = states[index] ?? "pending";
    const episode = stepKey.startsWith("episode:");
    return {
      stepKey, state, attemptNo: state === "pending" ? 0 : 1, errorCode: state === "unknown" ? "timeout" : state === "rejected" ? "invalid_output" : null,
      output: state !== "completed" ? null : stepKey === "concept" ? {
        schema: "ads.writing.title-concept.v1", genre: "都市悬疑", logline: "一句话", synopsis: "梗概正文", protagonistGoal: "目标", opposition: "阻力",
        coreConflict: "冲突", direction: "走向", characters: [{ name: "林夏", role: "主角", profile: "倔强" }, { name: "周岩", role: "刑警", profile: "冷淡" }],
        relationships: [{ name: "林夏与周岩", pressure: "互相怀疑" }],
      } : stepKey === "outline" ? {
        schema: "ads.writing.episode-outline.v1", episodes: [1, 2, 3].map((episodeNo) => ({ episodeNo, title: `集名${episodeNo}`, entryState: "a",
          goal: "目标", action: "行动", turn: "转折", result: "结果", handoff: "交接" })),
      } as never : null,
      text: episode && state === "completed" ? `第 ${stepKey.slice(-1)} 集 剧本正文` : null,
      scriptSave: episode ? (state === "completed" ? "awaiting_story_approval" : "pending") : null,
      scriptRevisionId: null,
    };
  });
}

function run(overrides: Partial<TitleWritingRunView> = {}, states: Array<TitleWritingStepView["state"]> = []): TitleWritingRunView {
  return {
    runId: RUN, projectId: P1, title: "夜班证词", settings: { episodeCount: 3, episodeSeconds: 90, style: "" }, providerKey: "qwen", model: "q-1",
    state: "running", errorCode: null, cancelRequested: false, callCap: 8, callsUsed: 0, storySave: "pending", storyRevisionId: null,
    storyText: null, steps: steps(states), calls: [], createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z",
    ...overrides,
  };
}

let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  assign = vi.fn();
  Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, assign, search: "" } });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

interface Call { method: string; url: string; headers: Record<string, string>; body: unknown }

function server(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? "GET", url: input, headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null };
    calls.push(call);
    return handler(call);
  }));
  return calls;
}

describe("AI 一键创作 on the start page", () => {
  it("needs only the title: one project and one run, the token only in its header", async () => {
    const calls = server((call) => {
      if (call.url.endsWith("/writing/title-runs/options")) return json(options());
      if (call.method === "POST" && call.url === "/api/v1/projects") return json({ id: P1 }, 201);
      if (call.method === "POST" && call.url.endsWith("/title-runs")) return json({ run: run() }, 201);
      return json({ items: [], nextCursor: null });
    });
    render(<BeginnerStart active="/create" />);
    const button = await screen.findByRole("button", { name: "AI 一键创作" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("剧名"), { target: { value: "夜班证词" } });
    fireEvent.change(screen.getByLabelText("操作者令牌"), { target: { value: TOKEN } });
    fireEvent.click(button);
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/projects/${P1}/writing`));
    const posts = calls.filter((call) => call.method === "POST");
    expect(posts.map((call) => call.url)).toEqual(["/api/v1/projects", `/api/v1/projects/${P1}/title-runs`]);
    expect(posts[0]?.body).toEqual({ title: "夜班证词", premise: "" });
    expect(posts[1]?.body).toEqual({ title: "夜班证词", providerKey: "qwen", model: "q-1", settings: { episodeSeconds: 90, style: "" } });
    expect(posts[1]?.headers["X-Operator-Token"]).toBe(TOKEN);
    expect(posts[1]?.headers["Idempotency-Key"]).toBeTruthy();
    expect(JSON.stringify(posts.map((call) => call.body))).not.toContain(TOKEN);
    expect(posts[0]?.headers["X-Operator-Token"]).toBeUndefined();
    // The manual path stays on the page.
    expect(screen.getByLabelText("你想拍一个什么样的故事？")).toBeTruthy();
  });

  it("does nothing while typing and asks for the title, then the token, before any POST", async () => {
    const calls = server((call) => call.url.endsWith("/options") ? json(options()) : json({ items: [], nextCursor: null }));
    render(<BeginnerStart active="/create" />);
    const button = await screen.findByRole("button", { name: "AI 一键创作" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    expect(screen.getByRole("alert").textContent).toBe("先写一个剧名。");
    fireEvent.change(screen.getByLabelText("剧名"), { target: { value: "夜班证词" } });
    fireEvent.click(button);
    expect(screen.getByRole("alert").textContent).toContain("操作者令牌");
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("says what is missing on the server and never pretends to start", async () => {
    const calls = server((call) => call.url.endsWith("/options")
      ? json(options({ code: "TITLE_WRITING_PROVIDER_UNCONFIGURED", defaultProvider: null,
        providers: options().providers.map((item) => ({ ...item, ready: false, models: [], defaultModel: null, missing: [`${item.providerKey.toUpperCase()}_KEY`] })) }))
      : json({ items: [], nextCursor: null }));
    render(<BeginnerStart active="/create" />);
    expect((await screen.findByText(/还没有可用的模型服务/)).textContent).toContain("千问：QWEN_KEY");
    fireEvent.change(screen.getByLabelText("剧名"), { target: { value: "夜班证词" } });
    fireEvent.change(screen.getByLabelText("操作者令牌"), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: "AI 一键创作" }));
    expect(screen.getByRole("alert").textContent).toContain("可以先手动创作");
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
    expect(assign).not.toHaveBeenCalled();
  });

  it("an unsure failure keeps the title and retries with the same keys, so nothing is created twice", async () => {
    let fail = true;
    const calls = server((call) => {
      if (call.url.endsWith("/options")) return json(options());
      if (call.method === "POST" && call.url === "/api/v1/projects") return json({ id: P1 }, 201);
      if (call.method === "POST" && call.url.endsWith("/title-runs")) {
        if (fail) { fail = false; return Promise.reject(new TypeError("network")); }
        return json({ run: run() }, 200);
      }
      return json({ items: [], nextCursor: null });
    });
    render(<BeginnerStart active="/create" />);
    const button = await screen.findByRole("button", { name: "AI 一键创作" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("剧名"), { target: { value: "夜班证词" } });
    fireEvent.change(screen.getByLabelText("操作者令牌"), { target: { value: TOKEN } });
    fireEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toContain("不会重复创建作品或重复开始创作");
    expect((screen.getByLabelText("剧名") as HTMLInputElement).value).toBe("夜班证词");
    fireEvent.click(button);
    await waitFor(() => expect(assign).toHaveBeenCalled());
    const projectPosts = calls.filter((call) => call.method === "POST" && call.url === "/api/v1/projects");
    const runPosts = calls.filter((call) => call.method === "POST" && call.url.endsWith("/title-runs"));
    expect(projectPosts).toHaveLength(1);
    expect(runPosts).toHaveLength(2);
    expect(runPosts[0]?.headers["Idempotency-Key"]).toBe(runPosts[1]?.headers["Idempotency-Key"]);
  });

  it("a wrong token is reported and nothing navigates", async () => {
    server((call) => {
      if (call.url.endsWith("/options")) return json(options());
      if (call.method === "POST" && call.url === "/api/v1/projects") return json({ id: P1 }, 201);
      if (call.url.endsWith("/title-runs")) return json({ error: { code: "TITLE_WRITING_FORBIDDEN", message: "x" } }, 403);
      return json({ items: [], nextCursor: null });
    });
    render(<BeginnerStart active="/create" />);
    const button = await screen.findByRole("button", { name: "AI 一键创作" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("剧名"), { target: { value: "夜班证词" } });
    fireEvent.change(screen.getByLabelText("操作者令牌"), { target: { value: "wrong-token-0000000" } });
    fireEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toContain("操作者令牌不正确");
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("progress and results page", () => {
  it("headlines follow the server state only", () => {
    expect(runHeadline(run({}, []))).toBe("正在构思故事");
    expect(runHeadline(run({}, ["completed", "submitted"]))).toBe("正在规划分集");
    expect(runHeadline(run({}, ["completed", "completed", "completed", "submitted"]))).toBe("正在编写第 2 集");
    expect(runHeadline(run({}, ["completed", "completed", "completed", "completed", "completed"]))).toBe("正在保存结果");
    expect(runHeadline(run({ state: "completed" }))).toBe("创作完成");
    expect(runHeadline(run({ state: "partial" }))).toBe("部分完成");
    expect(runHeadline(run({ state: "needs_attention" }))).toBe("需要处理");
    expect(runHeadline(run({ cancelRequested: true }))).toBe("正在停止");
  });

  it("polls while running, shows each stage from the server and the results when done, without percentages", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const sequence = [
      run({}, ["submitted"]),
      run({}, ["completed", "completed", "submitted"]),
      run({ state: "completed", storySave: "saved", callsUsed: 5 }, ["completed", "completed", "completed", "completed", "completed"]),
    ];
    let reads = 0;
    server(() => json({ run: sequence[Math.min(reads++, sequence.length - 1)] }));
    render(<TitleWritingRun projectId={P1} client={new TitleWritingClient()} />);
    expect(await screen.findByText("正在构思故事")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(TITLE_WRITING_POLL_MS); });
    expect(await screen.findByText("正在编写第 1 集")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(TITLE_WRITING_POLL_MS); });
    expect(await screen.findByText("创作完成")).toBeTruthy();
    expect(screen.getByText("梗概正文")).toBeTruthy();
    expect(screen.getByText("第 1 集 集名1")).toBeTruthy();
    expect(screen.getByText("第 1 集 剧本正文")).toBeTruthy();
    expect(screen.getByRole("link", { name: "查看和修改故事草稿" }).getAttribute("href")).toBe(`/projects/${P1}/create?step=story`);
    expect(document.body.textContent).not.toMatch(/\d+\s*%/);
    expect(document.body.textContent).not.toContain("{\"schema\"");
    const before = reads;
    await act(async () => { await vi.advanceTimersByTimeAsync(TITLE_WRITING_POLL_MS * 3); });
    expect(reads).toBe(before);
  });

  it("an uncertain step needs the checkbox and the token to resend", async () => {
    const posts: Call[] = [];
    const unknownCall = { callId: "aaaaaaaa-0000-4000-8000-000000000001", stepKey: "outline" as const, attemptNo: 1, providerKey: "qwen" as const,
      model: "q-1", responseModel: null, providerRequestId: null, state: "unknown" as const, errorCode: "timeout",
      usage: { status: "unknown" as const, inputTokens: null, outputTokens: null, totalTokens: null }, billingStatus: "unknown" as const,
      createdAt: "2026-10-08T00:00:00Z", finishedAt: "2026-10-08T00:02:00Z" };
    server((call) => {
      if (call.method === "POST") { posts.push(call); return json({ run: run({}, ["completed", "submitted"]) }); }
      return json({ run: run({ state: "needs_attention", errorCode: "timeout", calls: [unknownCall] }, ["completed", "unknown"]) });
    });
    render(<TitleWritingRun projectId={P1} client={new TitleWritingClient()} />);
    expect(await screen.findByText("需要处理")).toBeTruthy();
    expect(screen.getAllByText(/可能已经处理并产生费用/).length).toBeGreaterThan(0);
    const resume = screen.getByRole("button", { name: "继续创作" }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText("操作者令牌"), { target: { value: TOKEN } });
    expect(resume.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/可能已经产生费用，确认重新发送/));
    expect(resume.disabled).toBe(false);
    fireEvent.click(resume);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.url).toBe(`/api/v1/projects/${P1}/title-runs/${RUN}/resume`);
    expect(posts[0]?.body).toEqual({ confirmUncertainCallIds: ["aaaaaaaa-0000-4000-8000-000000000001"] });
    expect(posts[0]?.headers["Idempotency-Key"]).toBeTruthy();
    expect(posts[0]?.headers["X-Operator-Token"]).toBe(TOKEN);
  });

  it("scripts wait for a person's story approval and the refusal is shown", async () => {
    server((call) => call.method === "POST"
      ? json({ error: { code: "TITLE_WRITING_STORY_NOT_APPROVED", message: "故事还没有通过审核，剧本暂不能写入分集。" } }, 409)
      : json({ run: run({ state: "completed", storySave: "saved" }, ["completed", "completed", "completed", "completed", "completed"]) }));
    render(<TitleWritingRun projectId={P1} client={new TitleWritingClient()} />);
    fireEvent.click(await screen.findByRole("button", { name: "写入剧本草稿" }));
    expect((await screen.findByRole("alert")).textContent).toContain("故事还没有通过审核");
  });

  it("a story conflict keeps the person's story and says so", async () => {
    server(() => json({ run: run({ state: "needs_attention", errorCode: "story_conflict", storySave: "conflict" },
      ["completed", "completed", "completed", "completed", "completed"]) }));
    render(<TitleWritingRun projectId={P1} client={new TitleWritingClient()} />);
    expect(await screen.findByText("没有覆盖已有故事")).toBeTruthy();
    expect(screen.getByText(/AI 没有覆盖它/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "继续创作" })).toBeNull();
  });

  it("cancel asks the server and shows the stopping state from its answer", async () => {
    const posts: string[] = [];
    server((call) => {
      if (call.method === "POST") { posts.push(call.url); return json({ run: run({ cancelRequested: true }, ["submitted"]) }); }
      return json({ run: run({}, ["submitted"]) });
    });
    render(<TitleWritingRun projectId={P1} client={new TitleWritingClient()} />);
    fireEvent.click(await screen.findByRole("button", { name: "停止创作" }));
    expect(await screen.findByText("正在停止")).toBeTruthy();
    expect(screen.getByText(/已经发出的那一步会如实记录结果/)).toBeTruthy();
    expect(posts).toEqual([`/api/v1/projects/${P1}/title-runs/${RUN}/cancel`]);
  });

  it("no run yet offers the manual path", async () => {
    server(() => json({ run: null }));
    render(<TitleWritingRun projectId={P1} client={new TitleWritingClient()} />);
    expect(await screen.findByText("这部作品还没有 AI 创作记录")).toBeTruthy();
    expect(screen.getByRole("link", { name: "手动创作" }).getAttribute("href")).toBe(`/projects/${P1}/create`);
  });
});
