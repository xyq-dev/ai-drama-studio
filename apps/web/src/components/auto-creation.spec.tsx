// @vitest-environment happy-dom
// "AI 自动创作" start card and run page. Simulated interface tests: fetch is mocked; no browser, API or model.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoCreationOptionsView, AutoCreationRunView } from "@ai-drama/contracts";
import { AutoCreationStart } from "./auto-creation-start";
import { AutoCreationRun } from "./auto-creation-run";
import { AutoRunEntry } from "./auto-run-entry";

const P1 = "22222222-2222-4222-8222-222222222222";
const RUN = "66666666-6666-4666-8666-666666666666";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function options(overrides: Partial<AutoCreationOptionsView> = {}): AutoCreationOptionsView {
  return {
    enabled: true, code: "AUTO_CREATION_READY", storageReady: true, operatorTokenRequired: false, defaultProvider: "deepseek",
    providers: [
      { providerKey: "deepseek", label: "DeepSeek", ready: true, models: ["deepseek-flash"], defaultModel: "deepseek-flash", missing: [] },
      { providerKey: "anthropic", label: "Claude", ready: true, models: ["claude-opus-5-5"], defaultModel: "claude-opus-5-5", missing: [] },
    ],
    maxCallsPerDay: 30, maxActiveRuns: 1, billing: "unknown",
    episodePlan: { minEpisodes: 1, maxEpisodes: 6, defaultEpisodes: 1, secondsChoices: [60, 90], defaultSeconds: 60 }, episodePlanReady: true,
    revisionRounds: { max: 2, default: 2 }, maxOutputTokensPerCall: 4096, maxPromptChars: 40000,
    research: { fetchEnabled: false, allowedHosts: [], builtInSources: 4, readableMarketSources: 0, expectedMode: "limited", visualAnalysis: false },
    media: { realProviders: [], mockOnly: true, missing: [] },
    ...overrides,
  };
}

interface Call { method: string; url: string; body: unknown }

function server(current: AutoCreationOptionsView, handler: (call: Call) => Response = () => json({}, 500)) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", url: input, body: typeof init?.body === "string" ? JSON.parse(init.body) : null };
    calls.push(call);
    if (input.endsWith("/writing/auto-runs/options")) return json(current);
    return handler(call);
  }));
  return calls;
}

beforeEach(() => window.sessionStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AI 自动创作 start card", () => {
  it("shows the real provider, the call counts and the research limits before anything is sent", async () => {
    server(options());
    render(<AutoCreationStart />);
    await waitFor(() => expect(screen.getByTestId("auto-provider-target").textContent).toContain("DeepSeek · deepseek-flash"));
    expect(screen.getByTestId("auto-calls").textContent).toContain("正常 6 次");
    expect(screen.getByTestId("auto-calls").textContent).toContain("最坏 10 次");
    expect(screen.getByTestId("auto-research-mode").textContent).toContain("资料有限策划模式");
    fireEvent.change(screen.getByLabelText("集数"), { target: { value: "3" } });
    expect(screen.getByTestId("auto-calls").textContent).toContain("正常 8 次");
  });

  it("an unusable configured default blocks the start and is never replaced by a ready provider", async () => {
    const calls = server(options({ providers: [
      { providerKey: "deepseek", label: "DeepSeek", ready: false, models: [], defaultModel: null, missing: ["DEEPSEEK_API_KEY"] },
      { providerKey: "anthropic", label: "Claude", ready: true, models: ["claude-opus-5-5"], defaultModel: "claude-opus-5-5", missing: [] },
    ] }));
    render(<AutoCreationStart />);
    const button = await screen.findByRole("button", { name: "AI 自动创作" });
    await waitFor(() => expect(screen.getByTestId("auto-provider-target").textContent).toContain("不会自动改用其他模型服务"));
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("默认模型服务暂不可用"));
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("a budget below the normal calls is refused in the page with no request", async () => {
    const calls = server(options());
    render(<AutoCreationStart />);
    const button = await screen.findByRole("button", { name: "AI 自动创作" });
    await waitFor(() => expect(screen.getByTestId("auto-provider-target").textContent).toContain("DeepSeek"));
    fireEvent.change(screen.getByLabelText(/调用预算/), { target: { value: "5" } });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("至少要 6 次"));
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it.each([["auto-budget", "3.5", "整数"], ["auto-budget", "abc", "整数"], ["auto-characters", "abc", "1–8"], ["auto-characters", "9", "1–8"], ["auto-locations", "0", "1–6"]])(
    "an invalid %s value %s is refused before anything is created", async (id, value, message) => {
      const calls = server(options());
      render(<AutoCreationStart />);
      const button = await screen.findByRole("button", { name: "AI 自动创作" });
      await waitFor(() => expect(screen.getByTestId("auto-provider-target").textContent).toContain("DeepSeek"));
      fireEvent.change(document.getElementById(id)!, { target: { value } });
      fireEvent.click(button);
      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(message));
      expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    });

  it("more than five forbidden themes are refused, never silently dropped", async () => {
    const calls = server(options());
    render(<AutoCreationStart />);
    const button = await screen.findByRole("button", { name: "AI 自动创作" });
    await waitFor(() => expect(screen.getByTestId("auto-provider-target").textContent).toContain("DeepSeek"));
    fireEvent.change(document.getElementById("auto-forbidden")!, { target: { value: "复仇,出轨,暴力,赌博,穿越,鬼怪" } });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("最多 5 项"));
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("with the default blocked and exactly one other provider ready, the person can choose it explicitly", async () => {
    const calls = server(options({ providers: [
      { providerKey: "deepseek", label: "DeepSeek", ready: false, models: [], defaultModel: null, missing: ["DEEPSEEK_API_KEY"] },
      { providerKey: "anthropic", label: "Claude", ready: true, models: ["claude-opus-5-5"], defaultModel: "claude-opus-5-5", missing: [] },
    ] }), (call) => call.url === "/api/v1/projects" ? json({ id: P1 }, 201) : json({ run: { runId: RUN, projectId: P1, state: "running" } }, 201));
    vi.stubGlobal("location", { ...window.location, assign: vi.fn() });
    render(<AutoCreationStart />);
    const button = await screen.findByRole("button", { name: "AI 自动创作" });
    const select = await screen.findByLabelText("模型服务");
    fireEvent.change(select, { target: { value: "anthropic" } });
    await waitFor(() => expect(screen.getByTestId("auto-provider-target").textContent).toContain("Claude · claude-opus-5-5"));
    fireEvent.click(button);
    await waitFor(() => expect(calls.filter((call) => call.method === "POST")).toHaveLength(2));
    expect(calls.filter((call) => call.method === "POST")[1]!.body).toMatchObject({ providerKey: "anthropic" });
  });

  it("creates the work with its plan, then starts the run with the frozen request and its own key", async () => {
    const calls = server(options(), (call) => call.url === "/api/v1/projects"
      ? json({ id: P1 }, 201)
      : json({ run: { runId: RUN, projectId: P1, state: "running" } }, 201));
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    render(<AutoCreationStart />);
    const button = await screen.findByRole("button", { name: "AI 自动创作" });
    await waitFor(() => expect(screen.getByTestId("auto-provider-target").textContent).toContain("DeepSeek"));
    fireEvent.change(screen.getByLabelText("一句话想法（可不填）"), { target: { value: "骑手讨回工资" } });
    fireEvent.click(button);
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/projects/${P1}/auto`));
    const posts = calls.filter((call) => call.method === "POST");
    expect(posts.map((call) => call.url)).toEqual(["/api/v1/projects", `/api/v1/projects/${P1}/auto-runs`]);
    expect(posts[0]!.body).toMatchObject({ episodeCount: 1, targetEpisodeSeconds: 60 });
    expect(posts[1]!.body).toMatchObject({ idea: "骑手讨回工资", episodeCount: 1, episodeSeconds: 60, callBudget: 12, providerKey: "deepseek" });
  });
});

describe("AI 自动创作 start card with a start whose result is not confirmed", () => {
  const PROJECT_KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const RUN_KEY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  function frozen(overrides: Record<string, unknown> = {}) {
    return {
      idea: "外卖骑手讨回工资",
      constraints: { genre: "都市", audience: "上班族", maxCharacters: 4, maxLocations: 3, forbiddenThemes: ["鬼怪", "穿越"], endingRequirement: "圆满" },
      materials: [{ title: "我的笔记", kind: "notes", text: "骑手的一天", rightsConfirmed: true }],
      episodeCount: 6, episodeSeconds: 90, revisionRounds: 2, callBudget: 21, providerKey: "deepseek", model: "deepseek-flash",
      ...overrides,
    };
  }

  function storePending(request: Record<string, unknown>, projectId: string | null = null) {
    window.sessionStorage.setItem("auto-creation:start", JSON.stringify({
      version: 1, title: "外卖骑手讨回工资", request, projectKey: PROJECT_KEY, projectId, runKey: RUN_KEY,
    }));
  }

  /** Records each write's idempotency key along with its body. */
  function keyedServer(current: AutoCreationOptionsView) {
    const calls: Array<Call & { key: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const key = new Headers(init?.headers).get("Idempotency-Key");
      calls.push({ method: init?.method ?? "GET", url: input, body: typeof init?.body === "string" ? JSON.parse(init.body) : null, key });
      if (input.endsWith("/writing/auto-runs/options")) return json(current);
      if (input === "/api/v1/projects") return json({ id: P1 }, 201);
      return json({ run: { runId: RUN, projectId: P1, state: "running" } }, 201);
    }));
    return calls;
  }

  const select = (label: string) => screen.getByLabelText(label) as HTMLSelectElement;
  const input = (id: string) => document.getElementById(id) as HTMLInputElement;

  it("shows the call counts of the request that will be replayed: six episodes, two rounds, budget 21", async () => {
    storePending(frozen());
    server(options());
    render(<AutoCreationStart />);
    await screen.findByRole("button", { name: "重试上次请求" });
    await waitFor(() => expect(screen.getByTestId("auto-provider-target").textContent).toContain("DeepSeek"));
    const calls = screen.getByTestId("auto-calls").textContent;
    expect(calls).toContain("正常 11 次");
    expect(calls).toContain("最多 2 轮修改");
    expect(calls).toContain("最坏 19 次");
    expect(calls).toContain("本次预算上限 21 次");
    expect(select("集数").value).toBe("6");
    expect(select("每集时长").value).toBe("90");
    expect(select("最多修改轮次").value).toBe("2");
    expect(input("auto-budget").value).toBe("21");
    // Every other shown setting is the frozen one too.
    expect(input("auto-idea").value).toBe("外卖骑手讨回工资");
    expect(input("auto-genre").value).toBe("都市");
    expect(input("auto-audience").value).toBe("上班族");
    expect(input("auto-characters").value).toBe("4");
    expect(input("auto-locations").value).toBe("3");
    expect(input("auto-forbidden").value).toBe("鬼怪，穿越");
    expect(input("auto-ending").value).toBe("圆满");
    expect(input("auto-material-title").value).toBe("我的笔记");
    expect((screen.getByLabelText("资料文字") as HTMLTextAreaElement).value).toBe("骑手的一天");
  });

  it("a custom revision count and budget survive a reload instead of returning to the defaults", async () => {
    storePending(frozen({ revisionRounds: 1, callBudget: 15 }));
    server(options());
    render(<AutoCreationStart />);
    await waitFor(() => expect(screen.getByTestId("auto-calls").textContent).toContain("本次预算上限 15 次"));
    expect(screen.getByTestId("auto-calls").textContent).toContain("最多 1 轮修改");
    expect(screen.getByTestId("auto-calls").textContent).toContain("最坏 15 次");
    expect(select("最多修改轮次").value).toBe("1");
    expect(input("auto-budget").value).toBe("15");
  });

  it("a changed server default never replaces the provider and model of the pending request", async () => {
    storePending(frozen());
    server(options({ defaultProvider: "anthropic" }));
    render(<AutoCreationStart />);
    await waitFor(() => expect(screen.getByTestId("auto-provider-target").textContent).toContain("DeepSeek · deepseek-flash"));
    expect(screen.getByTestId("auto-provider-target").textContent).not.toContain("Claude");
    expect(select("模型服务").value).toBe("deepseek");
    expect(screen.queryByTestId("auto-provider-changed")).toBeNull();
  });

  it("a provider no longer ready is still shown as the request's own, with the change said separately", async () => {
    storePending(frozen());
    server(options({ providers: [
      { providerKey: "deepseek", label: "DeepSeek", ready: false, models: [], defaultModel: null, missing: ["DEEPSEEK_API_KEY"] },
      { providerKey: "anthropic", label: "Claude", ready: true, models: ["claude-opus-5-5"], defaultModel: "claude-opus-5-5", missing: [] },
    ] }));
    render(<AutoCreationStart />);
    await waitFor(() => expect(screen.getByTestId("auto-provider-target").textContent).toContain("DeepSeek · deepseek-flash"));
    expect(screen.getByTestId("auto-provider-changed").textContent).toContain("不会改用其他");
  });

  it("a request with no provider, no materials and open constraints is shown as it is, without a provider of today's", async () => {
    const request = frozen({ constraints: { genre: "", audience: "", maxCharacters: null, maxLocations: null, forbiddenThemes: [], endingRequirement: "" }, materials: [] });
    delete (request as { providerKey?: string }).providerKey;
    delete (request as { model?: string }).model;
    storePending(request);
    server(options());
    render(<AutoCreationStart />);
    await waitFor(() => expect(screen.getByTestId("auto-provider-target").textContent).toContain("原请求没有指定模型服务"));
    expect(screen.getByTestId("auto-provider-target").textContent).not.toContain("DeepSeek");
    expect(screen.queryByTestId("auto-provider-changed")).toBeNull();
    expect(select("模型服务").value).toBe("");
    expect(input("auto-characters").value).toBe("");
    expect(input("auto-forbidden").value).toBe("");
    expect((screen.getByLabelText("资料文字") as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByTestId("auto-calls").textContent).toContain("本次预算上限 21 次");
  });

  it("a stored request missing parts still shows the card, so it can be given up", async () => {
    const request = frozen();
    delete (request as { constraints?: unknown }).constraints;
    delete (request as { materials?: unknown }).materials;
    storePending(request);
    server(options());
    render(<AutoCreationStart />);
    await waitFor(() => expect(screen.getByTestId("auto-calls").textContent).toContain("正常 11 次"));
    fireEvent.click(screen.getByRole("button", { name: "放弃上次请求，重新填写" }));
    await screen.findByRole("button", { name: "AI 自动创作" });
    expect(window.sessionStorage.getItem("auto-creation:start")).toBeNull();
  });

  it("the retry sends exactly the frozen request with its own keys, once however often it is clicked", async () => {
    const request = frozen();
    storePending(request);
    const calls = keyedServer(options({ defaultProvider: "anthropic" }));
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    render(<AutoCreationStart />);
    const button = await screen.findByRole("button", { name: "重试上次请求" });
    await waitFor(() => expect(screen.getByTestId("auto-provider-target").textContent).toContain("DeepSeek"));
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/projects/${P1}/auto`));
    const posts = calls.filter((call) => call.method === "POST");
    expect(posts.map((call) => [call.url, call.key])).toEqual([["/api/v1/projects", PROJECT_KEY], [`/api/v1/projects/${P1}/auto-runs`, RUN_KEY]]);
    expect(posts[0]!.body).toEqual({ title: "外卖骑手讨回工资", premise: request.idea, episodeCount: 6, targetEpisodeSeconds: 90 });
    expect(posts[1]!.body).toEqual(request);
  });

  it("after the pending request is given up, the summary follows the form again", async () => {
    storePending(frozen());
    server(options());
    render(<AutoCreationStart />);
    await waitFor(() => expect(screen.getByTestId("auto-calls").textContent).toContain("正常 11 次"));
    fireEvent.click(screen.getByRole("button", { name: "放弃上次请求，重新填写" }));
    await screen.findByRole("button", { name: "AI 自动创作" });
    expect(screen.getByTestId("auto-calls").textContent).toContain("正常 6 次");
    expect(select("集数").disabled).toBe(false);
    fireEvent.change(select("集数"), { target: { value: "3" } });
    fireEvent.change(select("最多修改轮次"), { target: { value: "0" } });
    expect(screen.getByTestId("auto-calls").textContent).toContain("正常 8 次");
    expect(screen.getByTestId("auto-calls").textContent).toContain("最坏 8 次");
    expect(screen.getByTestId("auto-calls").textContent).toContain("本次预算上限 10 次");
    fireEvent.change(input("auto-budget"), { target: { value: "9" } });
    expect(screen.getByTestId("auto-calls").textContent).toContain("本次预算上限 9 次");
    expect(window.sessionStorage.getItem("auto-creation:start")).toBeNull();
  });
});

describe("AI 自动创作 run page", () => {
  function run(overrides: Partial<AutoCreationRunView> = {}): AutoCreationRunView {
    return {
      runId: RUN, projectId: P1, inputVersion: "ads.auto-creation.input.v1", promptVersion: "ads.auto-creation.prompt.v1", idea: "",
      constraints: { genre: "", audience: "", maxCharacters: null, maxLocations: null, forbiddenThemes: [], endingRequirement: "" },
      episodeCount: 1, episodeSeconds: 60, providerKey: "deepseek", model: "deepseek-flash",
      authorization: { mode: "auto", proof: "site_session", initiatedBy: "server-owner", executor: "auto-creation-engine" },
      researchFetch: false, researchMode: "limited", state: "completed", errorCode: "revision_rounds_exhausted", cancelRequested: false,
      budget: { normalCalls: 6, worstCalls: 10, hardCap: 12, callBudget: 12, revisionRounds: 2, revisionsPerRound: 1, maxOutputTokensPerCall: 4096, maxPromptChars: 40000, billing: "unknown" },
      callsUsed: 10, callCap: 12, revisionRoundsUsed: 2, quality: "needs_work",
      openIssues: [{ id: "R1", target: "episode:1", severity: "high", detail: "开场没有主动选择" }],
      storySave: "saved", storyRevisionId: "77777777-7777-4777-8777-777777777777", packageStatus: "ready", videoStatus: "not_started",
      currentEpisodes: {}, stages: [{ stageKey: "sources", kind: "sources", state: "completed", attemptNo: 0, errorCode: null, output: null,
        upstreamChanged: false, supersededBy: null, scriptSave: null, scriptRevisionId: null }],
      calls: [], legacyProviderRun: false, resumeBlock: null, createdAt: "2026-10-18T00:00:00Z", updatedAt: "2026-10-18T00:00:00Z",
      ...overrides,
    };
  }

  it("keeps the package, the machine check, the person's review and the video as separate facts; needs work is never shown as passed", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => input.endsWith("/auto-runs/latest") ? json({ run: run() }) : json(options())));
    render(<AutoCreationRun projectId={P1} />);
    await waitFor(() => expect(screen.getByTestId("auto-headline").textContent).toBe("剧本包已完成（待完善）"));
    expect(screen.getByTestId("auto-package-status").textContent).toContain("已完成");
    expect(screen.getByTestId("auto-quality").textContent).toContain("待完善");
    expect(screen.getByTestId("auto-quality").textContent).toContain("不是人工审核");
    expect(screen.getByTestId("auto-video-status").textContent).toContain("未开始");
    expect(screen.getByTestId("auto-open-issues").textContent).toContain("开场没有主动选择");
    expect(screen.getByTestId("auto-download-md").getAttribute("href")).toBe(`/api/v1/projects/${P1}/auto-runs/${RUN}/package?format=markdown`);
  });

  it("a research answer refused by the checks names the stage, the rule and the field, and is never called a key problem", async () => {
    const refused = "unsourced_number@limitations[0]:digits";
    const failed = run({
      state: "failed", errorCode: "unsourced_number", quality: "pending", storySave: "pending", storyRevisionId: null, packageStatus: "incomplete",
      callsUsed: 1, callCap: 6, openIssues: [],
      stages: [
        { stageKey: "sources", kind: "sources", state: "completed", attemptNo: 0, errorCode: null, output: null, upstreamChanged: false, supersededBy: null, scriptSave: null, scriptRevisionId: null },
        { stageKey: "research", kind: "research", state: "rejected", attemptNo: 1, errorCode: refused, output: null, upstreamChanged: false, supersededBy: null, scriptSave: null, scriptRevisionId: null },
      ],
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => input.endsWith("/auto-runs/latest") ? json({ run: failed }) : json(options())));
    render(<AutoCreationRun projectId={P1} />);
    await waitFor(() => expect(screen.getByTestId("auto-headline").textContent).toBe("没有完成"));
    const stop = screen.getByText(/^停在「/u).textContent!;
    expect(stop).toContain("研究");
    expect(stop).toContain("没有通过真实性检查");
    expect(stop).toContain("limitations[0]");
    expect(stop).toContain("阿拉伯数字");
    const note = screen.getByTestId("auto-output-refused").textContent!;
    expect(note).toContain("不是密钥或账户问题");
    expect(note).toContain("新的计费调用");
    expect(screen.getByTestId("auto-quality").textContent).toContain("未完成");
    expect(document.body.textContent).not.toContain("认证失败");
  });

  it("checks v3: a refusal says what the number was taken for and the sub-rule, never blames the model or the key outright", async () => {
    const stage = (errorCode: string) => ({ stageKey: "research", kind: "research" as const, state: "rejected" as const, attemptNo: 1, errorCode, output: null,
      upstreamChanged: false, supersededBy: null, scriptSave: null, scriptRevisionId: null });
    for (const [code, expected] of [
      ["unsourced_number@hypotheses[0].statement:chinese_numeral+market_statistic+audience_count", ["hypotheses[0].statement", "中文数字", "市场或受众统计", "观众或用户人数", "不说明模型一定编造"]],
      ["unsourced_number@hypotheses[0].howToVerify:digits+result_claim+unmarked_audience_judgement", ["hypotheses[0].howToVerify", "已经得到的调查或观众结论", "没有写明待验证或计划"]],
      ["constraint_violation@appliedConstraints[0]:digits+frozen_conflict+cast_over_limit", ["appliedConstraints[0]", "冻结的硬约束", "人物数超过上限"]],
      ["unsourced_number@limitations[0]:digits+unclassified+date_or_range", ["limitations[0]", "无法确认是创作设定还是统计", "日期或数值范围"]],
    ] as const) {
      cleanup();
      const failed = run({ state: "failed", errorCode: code.split("@")[0]!, quality: "pending", storySave: "pending", storyRevisionId: null, packageStatus: "incomplete",
        callsUsed: 1, callCap: 6, openIssues: [], stages: [stage(code)] });
      vi.stubGlobal("fetch", vi.fn(async (input: string) => input.endsWith("/auto-runs/latest") ? json({ run: failed }) : json(options())));
      render(<AutoCreationRun projectId={P1} />);
      await waitFor(() => expect(screen.getByTestId("auto-headline").textContent).toBe("没有完成"));
      const stop = screen.getByText(/^停在「/u).textContent!;
      for (const text of expected) expect(stop, code).toContain(text);
      expect(screen.getByTestId("auto-output-refused").textContent).toContain("不需要更换密钥");
      expect(document.body.textContent).not.toContain("认证失败");
    }
  });

  it("limited research shows facts, hypotheses and their unexecuted plans apart, and never claims a market validation", async () => {
    const research = {
      schema: "ads.auto-creation.research.v1", facts: [], observations: [],
      hypotheses: [{ id: "H1", statement: "两个互不信任的人被迫共同寻找真相，这种设定可能带来悬念。", howToVerify: "计划比较两个版本后再判断。" }],
      audience: { primary: "拟面向通勤时刷剧的成年观众（待验证）", viewingNeeds: ["一集内看到结果"], emotionalAppeals: ["扳回一局"], basis: "hypothesis", sourceIds: [] },
      contentStructure: [{ pattern: "主角主动", why: "知识库", sourceIds: ["S-KB-CRAFT"] }],
      opportunities: ["三天内讨回工资"], limitations: ["官方条目没有读到正文"], appliedConstraints: ["共 1 集，每集约 60 秒"],
    };
    const done = run({ stages: [
      { stageKey: "sources", kind: "sources", state: "completed", attemptNo: 0, errorCode: null, output: null, upstreamChanged: false, supersededBy: null, scriptSave: null, scriptRevisionId: null },
      { stageKey: "research", kind: "research", state: "completed", attemptNo: 1, errorCode: null, output: research as never, upstreamChanged: false, supersededBy: null, scriptSave: null, scriptRevisionId: null },
    ] });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => input.endsWith("/auto-runs/latest") ? json({ run: done }) : json(options())));
    render(<AutoCreationRun projectId={P1} />);
    const limited = await screen.findByTestId("auto-research-limited");
    expect(limited.textContent).toContain("待验证的假设");
    expect(limited.textContent).toContain("验证计划尚未执行");
    expect(limited.textContent).toContain("不是实时市场验证");
    const detail = screen.getByTestId("auto-research-detail").textContent!;
    expect(detail).toContain("无（没有可引用的资料）");
    expect(screen.getByTestId("auto-hypotheses").textContent).toContain("H1 假设：两个互不信任的人");
    expect(screen.getByTestId("auto-hypotheses").textContent).toContain("验证计划：计划比较两个版本后再判断。");
    expect(screen.getByTestId("auto-audience").textContent).toContain("不是平台真实用户画像");
    expect(detail).toContain("采用的约束：共 1 集，每集约 60 秒");
    expect(document.body.textContent).not.toMatch(/市场验证(已)?完成|已完成市场验证/u);
    // Stored v1 research: shown as it was, marked as history, with no quote made up for it.
    expect(screen.getByTestId("auto-structure-legacy").textContent).toBe("历史版本（未区分参考原文与本剧应用）：主角主动：知识库（S-KB-CRAFT）");
    expect(screen.queryByTestId("auto-structure-reference")).toBeNull();
  });

  it("research v2 shows each structure's quoted method and this work's own design apart; no quote reads as self-designed", async () => {
    const research = {
      schema: "ads.auto-creation.research.v2", facts: [], observations: [],
      hypotheses: [{ id: "H1", statement: "可能带来悬念。", howToVerify: "计划比较两个版本后再判断。" }],
      audience: { primary: "拟面向通勤时刷剧的成年观众（待验证）", viewingNeeds: ["一集内看到结果"], emotionalAppeals: ["扳回一局"], basis: "hypothesis", sourceIds: [] },
      contentStructure: [
        { reference: { sourceId: "S-KB-CRAFT", quote: "关键结果来自主角的选择和行动" }, application: { pattern: "计划用两次反转推动主角主动选择。", why: "这是本作品的创作设计。" } },
        { reference: null, application: { pattern: "三名骑手被迫合作。", why: "自主设计。" } },
      ],
      opportunities: ["三天内讨回工资"], limitations: ["官方条目没有读到正文"], appliedConstraints: [],
    };
    const done = run({ stages: [
      { stageKey: "sources", kind: "sources", state: "completed", attemptNo: 0, errorCode: null, output: null, upstreamChanged: false, supersededBy: null, scriptSave: null, scriptRevisionId: null },
      { stageKey: "research", kind: "research", state: "completed", attemptNo: 1, errorCode: null, output: research as never, upstreamChanged: false, supersededBy: null, scriptSave: null, scriptRevisionId: null },
    ] });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => input.endsWith("/auto-runs/latest") ? json({ run: done }) : json(options())));
    render(<AutoCreationRun projectId={P1} />);
    await screen.findByTestId("auto-structure");
    expect(screen.getAllByTestId("auto-structure-reference").map((item) => item.textContent)).toEqual([
      "参考方法原文：S-KB-CRAFT「关键结果来自主角的选择和行动」", "参考方法原文：无（自主创作设计）"]);
    expect(screen.getAllByTestId("auto-structure-application").map((item) => item.textContent)).toEqual([
      "本剧应用设计：计划用两次反转推动主角主动选择。：这是本作品的创作设计。", "本剧应用设计：三名骑手被迫合作。：自主设计。"]);
    expect(screen.queryByTestId("auto-structure-legacy")).toBeNull();
    expect(screen.getByTestId("auto-research-limited").textContent).toContain("不是平台真实用户画像");
  });

  it("a key problem is not described as a refused answer", async () => {
    const failed = run({ state: "failed", errorCode: "auth", quality: "pending", storySave: "pending", storyRevisionId: null, packageStatus: "incomplete", openIssues: [],
      stages: [{ stageKey: "research", kind: "research", state: "rejected", attemptNo: 1, errorCode: "auth", output: null, upstreamChanged: false, supersededBy: null, scriptSave: null, scriptRevisionId: null }] });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => input.endsWith("/auto-runs/latest") ? json({ run: failed }) : json(options())));
    render(<AutoCreationRun projectId={P1} />);
    await waitFor(() => expect(screen.getByTestId("auto-headline").textContent).toBe("没有完成"));
    expect(screen.queryByTestId("auto-output-refused")).toBeNull();
    expect(document.body.textContent).toContain("认证失败");
  });

  it("shows which episodes were written into the work and which were kept because a script already existed", async () => {
    const stage = (stageKey: string, scriptSave: "saved" | "conflict") => ({ stageKey, kind: "episode" as const, state: "completed" as const, attemptNo: 1,
      errorCode: null, output: null, upstreamChanged: false, supersededBy: null, scriptSave, scriptRevisionId: null });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => input.endsWith("/auto-runs/latest")
      ? json({ run: run({ episodeCount: 2, stages: [stage("episode:1", "saved"), stage("episode:2", "conflict")] }) }) : json(options())));
    render(<AutoCreationRun projectId={P1} />);
    await waitFor(() => expect(screen.getByTestId("auto-script-save-episode:1").textContent).toContain("已写入"));
    expect(screen.getByTestId("auto-script-save-episode:2").textContent).toContain("没有覆盖");
  });

  function uncertainRun(callIds: string[]): AutoCreationRunView {
    const call = (callId: string, attemptNo: number, state: "unknown" | "completed") => ({ callId, stageKey: "review:1", attemptNo, providerKey: "deepseek" as const,
      model: "deepseek-flash", responseModel: null, providerRequestId: null, state, errorCode: state === "unknown" ? "timeout" : null,
      usage: { status: "unknown" as const, inputTokens: null, outputTokens: null, totalTokens: null }, billingStatus: "unknown" as const,
      createdAt: "2026-10-18T00:00:00Z", finishedAt: null });
    return run({ state: "needs_attention", errorCode: "timeout", quality: "pending", storySave: "pending", storyRevisionId: null, packageStatus: "in_progress",
      stages: [{ stageKey: "review:1", kind: "review", state: "unknown", attemptNo: callIds.length, errorCode: "timeout", output: null, upstreamChanged: false,
        supersededBy: null, scriptSave: null, scriptRevisionId: null }],
      calls: callIds.map((callId, index) => call(callId, index + 1, index + 1 === callIds.length ? "unknown" : "completed")) } as Partial<AutoCreationRunView>);
  }

  it("a resume whose answer was lost is replayed with its own key and confirmations, even after another call became uncertain", async () => {
    const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let latest = uncertainRun([A]);
    const resumes: Array<{ key: string | null; body: unknown; token: string | null }> = [];
    let lose = true;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/auto-runs/latest")) return json({ run: latest });
      if (input.endsWith("/resume")) {
        const headers = new Headers(init?.headers);
        resumes.push({ key: headers.get("Idempotency-Key"), body: JSON.parse(String(init?.body)), token: headers.get("X-Operator-Token") });
        if (lose) {
          // The server accepted the resume with [A]; the answer never arrived. The run went on and call B became uncertain.
          lose = false;
          latest = uncertainRun([A, B]);
          throw new TypeError("network down");
        }
        return json({ run: latest });
      }
      return json(options({ operatorTokenRequired: true }));
    }));
    const view = render(<AutoCreationRun projectId={P1} />);
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.change(await screen.findByLabelText("操作者令牌"), { target: { value: "operator-secret-token" } });
    fireEvent.click(screen.getByRole("button", { name: "从已保存的阶段继续" }));
    await waitFor(() => expect(resumes).toHaveLength(1));
    expect(resumes[0]!.body).toEqual({ confirmUncertainCallIds: [A] });
    // The pending resume survives a reload; no credential is ever stored.
    await waitFor(() => expect(screen.getByTestId("auto-resume-pending").textContent).toContain(A));
    const stored = Object.keys(window.sessionStorage).map((key) => window.sessionStorage.getItem(key) ?? "").join("\n");
    expect(stored).toContain(resumes[0]!.key!);
    expect(stored).not.toContain("operator-secret-token");
    view.unmount();
    render(<AutoCreationRun projectId={P1} />);
    const retry = await screen.findByRole("button", { name: "重试上次继续请求" });
    expect(screen.getByTestId("auto-resume-pending").textContent).toContain(A);
    fireEvent.change(await screen.findByLabelText("操作者令牌"), { target: { value: "operator-secret-token" } });
    fireEvent.click(retry);
    fireEvent.click(retry);
    await waitFor(() => expect(resumes).toHaveLength(2));
    // The same action: its own key and its own confirmation list, never the new uncertain call.
    expect(resumes[1]).toEqual({ key: resumes[0]!.key, body: { confirmUncertainCallIds: [A] }, token: "operator-secret-token" });
    // Answered: the identity is cleared, and only now may a new resume confirm B under a new key.
    await waitFor(() => expect(screen.queryByTestId("auto-resume-pending")).toBeNull());
    expect(screen.getByText(/有 1 次调用结果不确定（bbbbbbbb/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "从已保存的阶段继续" }));
    await waitFor(() => expect(resumes).toHaveLength(3));
    expect(resumes[2]!.body).toEqual({ confirmUncertainCallIds: [B] });
    expect(resumes[2]!.key).not.toBe(resumes[0]!.key);
    expect(Object.keys(window.sessionStorage).some((key) => (window.sessionStorage.getItem(key) ?? "").includes(resumes[0]!.key!))).toBe(false);
  });

  it("a pending resume belongs to its own work and run: another work never sends it", async () => {
    const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const P2 = "33333333-3333-4333-8333-333333333333";
    const resumes: string[] = [];
    let fail = true;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (input.endsWith("/auto-runs/latest")) return json({ run: { ...uncertainRun([A]), projectId: input.includes(P2) ? P2 : P1 } });
      if (input.endsWith("/resume")) {
        resumes.push(input);
        if (fail) throw new TypeError("network down");
        return json({ run: uncertainRun([A]) });
      }
      return json(options());
    }));
    const view = render(<AutoCreationRun projectId={P1} />);
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "从已保存的阶段继续" }));
    await waitFor(() => expect(screen.getByTestId("auto-resume-pending")).toBeTruthy());
    view.unmount();
    fail = false;
    render(<AutoCreationRun projectId={P2} />);
    await screen.findByRole("button", { name: "从已保存的阶段继续" });
    expect(screen.queryByTestId("auto-resume-pending")).toBeNull();
    expect(resumes).toHaveLength(1);
  });

  it("a definite refusal ends the pending resume; a run stopped for good offers no resume but keeps its downloads", async () => {
    const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let answer: Response | "throw" = "throw";
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (input.endsWith("/auto-runs/latest")) return json({ run: uncertainRun([A]) });
      if (input.endsWith("/resume")) {
        if (answer === "throw") throw new TypeError("network down");
        return answer;
      }
      return json(options());
    }));
    render(<AutoCreationRun projectId={P1} />);
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "从已保存的阶段继续" }));
    const retry = await screen.findByRole("button", { name: "重试上次继续请求" });
    answer = json({ error: { code: "AUTO_CREATION_CONFIRMATION_STALE", message: "确认已过期" } }, 409);
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByTestId("auto-resume-pending")).toBeNull());
    cleanup();

    const final = run({ state: "needs_attention", errorCode: "story_too_large", quality: "passed", storySave: "pending", storyRevisionId: null,
      stages: [{ stageKey: "review:1", kind: "review", state: "completed", attemptNo: 1, errorCode: null, output: null, upstreamChanged: false,
        supersededBy: null, scriptSave: null, scriptRevisionId: null }] } as Partial<AutoCreationRunView>);
    vi.stubGlobal("fetch", vi.fn(async (input: string) => input.endsWith("/auto-runs/latest") ? json({ run: final }) : json(options())));
    render(<AutoCreationRun projectId={P1} />);
    await screen.findByTestId("auto-download-md");
    expect(screen.queryByRole("button", { name: "从已保存的阶段继续" })).toBeNull();
    expect(screen.queryByRole("button", { name: "写入分集剧本草稿" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("再次继续也只会得到同样的结果");
  });

  it("a run the server cannot continue as it stands offers no resume and says why; its package stays downloadable", async () => {
    for (const [resumeBlock, errorCode, text] of [
      ["prompt_too_large", "prompt_too_large", "再次继续也只会停在这里"],
      ["research_fetch_unavailable", "research_fetch_unavailable", "恢复页面读取后可以继续"],
    ] as const) {
      const blocked = run({ state: "needs_attention", errorCode, quality: "pending", storySave: "pending", storyRevisionId: null, packageStatus: "incomplete",
        resumeBlock, stages: [{ stageKey: "review:1", kind: "review", state: "pending", attemptNo: 0, errorCode: null, output: null, upstreamChanged: false,
          supersededBy: null, scriptSave: null, scriptRevisionId: null }] } as Partial<AutoCreationRunView>);
      const fetches: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
        fetches.push(`${init?.method ?? "GET"} ${input}`);
        return input.endsWith("/auto-runs/latest") ? json({ run: blocked }) : json(options());
      }));
      render(<AutoCreationRun projectId={P1} />);
      await screen.findByTestId("auto-download-md");
      expect(screen.getByRole("status").textContent).toContain(text);
      expect(screen.queryByRole("button", { name: "从已保存的阶段继续" })).toBeNull();
      expect(fetches.some((item) => item.startsWith("POST"))).toBe(false);
      cleanup();
    }
  });

  it("the entry on the work reads the run only and leads back to it", async () => {
    const fetches: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      fetches.push(`${init?.method ?? "GET"} ${input}`);
      return json({ run: run({ state: "completed", quality: "passed", storySave: "saved" }) });
    }));
    render(<AutoRunEntry projectId={P1} />);
    const link = await screen.findByRole("link", { name: "回到 AI 自动创作任务" });
    expect(link.getAttribute("href")).toBe(`/projects/${P1}/auto`);
    expect(fetches).toEqual([`GET /api/v1/projects/${P1}/auto-runs/latest`]);
    cleanup();
    // Unreadable (storage not migrated, network down): no entry, no error on the work's page.
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { code: "AUTO_CREATION_STORAGE_UNAVAILABLE", message: "x" } }, 503)));
    render(<AutoRunEntry projectId={P1} />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(screen.queryByTestId("auto-run-entry")).toBeNull();
  });

  it("after a person edited the story in review, placement asks for an explicit confirmation and then sends it", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/auto-runs/latest")) return json({ run: run() });
      if (input.endsWith("/scripts")) {
        const body = JSON.parse(String(init?.body)) as { acceptStoryChanged: boolean };
        bodies.push(body);
        return body.acceptStoryChanged ? json({ run: run() }) : json({ error: { code: "AUTO_CREATION_STORY_CHANGED", message: "故事已改" } }, 409);
      }
      return json(options());
    }));
    render(<AutoCreationRun projectId={P1} />);
    const place = await screen.findByRole("button", { name: "写入分集剧本草稿" });
    fireEvent.click(place);
    const confirm = await screen.findByTestId("auto-accept-story-changed");
    expect((place as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(confirm.querySelector("input")!);
    fireEvent.click(place);
    await waitFor(() => expect(bodies).toEqual([{ acceptStoryChanged: false }, { acceptStoryChanged: true }]));
  });
});
