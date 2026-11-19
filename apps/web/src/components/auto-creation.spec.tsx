// @vitest-environment happy-dom
// "AI 自动创作" start card and run page. Simulated interface tests: fetch is mocked; no browser, API or model.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoCreationOptionsView, AutoCreationRunView } from "@ai-drama/contracts";
import { fixtureAutoBible, fixtureAutoEpisode, fixtureAutoOutline } from "@ai-drama/providers/title-writing-fixtures";
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
    media: {
      realProviders: [],
      mockOnly: true,
      missing: [],
      imageProviders: [
        {
          providerKey: "openai-media",
          model: "gpt-image-2.5-sunburst",
          connected: false,
          missing: ["OpenAI 生图未接通：缺少 OPENAI_MEDIA_API_KEY（媒体密钥，不是写作 OPENAI_API_KEY）"],
          unitPrice: null,
          currency: null,
        },
        {
          providerKey: "dashscope-media",
          model: "qwen-image-3.0",
          connected: false,
          missing: ["百炼生图未接通：缺少 DASHSCOPE_MEDIA_API_KEY（媒体密钥；与视频同源，不是百炼 TTS 或其他密钥）"],
          unitPrice: null,
          currency: null,
        },
      ],
    },
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
  it.each([false, true])("freezes the optional storyboard preference without starting media (%s)", async (checked) => {
    const calls = server(options(), ({ url }) => url === "/api/v1/projects" ? json({ id: P1 }, 201)
      : json({ run: { runId: RUN, projectId: P1, state: "running" } }, 201));
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    render(<AutoCreationStart />);
    await screen.findByTestId("auto-provider-target");
    expect(screen.getByTestId("auto-storyboard-source")).toBeTruthy();
    const preference = screen.getByRole("checkbox", { name: "剧本写完后，自动为每集生成分镜头" }) as HTMLInputElement;
    expect(preference.checked).toBe(false);
    expect(preference.disabled).toBe(false);
    expect(screen.getByTestId("auto-storyboard-openai-status").textContent).toContain("尚未计价");
    expect(screen.getByTestId("auto-storyboard-image-status").textContent).toMatch(/未接通|缺少/);
    expect(screen.getByTestId("auto-voice-status").textContent).toContain("还没有接通正式配音");
    expect(screen.getByTestId("auto-finished-video-status").textContent).toContain("还没有接通真实视频与成片");
    expect(screen.getByTestId("auto-media-delivery").textContent).not.toContain("配音、动态和成片不在本次任务内");
    if (checked) fireEvent.click(preference);
    fireEvent.click(screen.getByRole("button", { name: "AI 自动创作" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/projects/${P1}/auto`));
    const writes = calls.filter(({ method }) => method === "POST");
    expect(writes.map(({ url }) => url)).toEqual(["/api/v1/projects", `/api/v1/projects/${P1}/auto-runs`]);
    expect(writes[1]?.body).toMatchObject({
      autoStoryboardAfterScripts: checked,
      storyboardSource: "model",
      storyboardImageProvider: "openai-media",
    });
    // Checkbox only freezes the quote preference — no media quote/authorize/generate on start.
    expect(writes.every(({ url }) => !url.includes("/real-media/") && !url.includes("/storyboards"))).toBe(true);
  });

  it("upload mode hides auto checkbox and freezes storyboardSource without quoting", async () => {
    const calls = server(options(), ({ url }) => url === "/api/v1/projects" ? json({ id: P1 }, 201)
      : json({ run: { runId: RUN, projectId: P1, state: "running" } }, 201));
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    render(<AutoCreationStart />);
    await screen.findByTestId("auto-provider-target");
    fireEvent.click(screen.getByRole("radio", { name: "自己上传图片" }));
    expect(screen.queryByRole("checkbox", { name: "剧本写完后，自动为每集生成分镜头" })).toBeNull();
    expect(screen.getByTestId("auto-storyboard-upload-note").textContent).toContain("不报价");
    expect(screen.getByTestId("auto-storyboard-upload-note").textContent).toContain("不等于分镜审核通过");
    fireEvent.click(screen.getByRole("button", { name: "AI 自动创作" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/projects/${P1}/auto`));
    const start = calls.find((call) => call.url.endsWith("/auto-runs"));
    expect(start?.body).toMatchObject({ storyboardSource: "upload", autoStoryboardAfterScripts: false });
    expect(start?.body).not.toHaveProperty("storyboardImageProvider");
  });

  it("shows OpenAI and Bailian image provider notes with unit price or 尚未计价", async () => {
    const calls = server(options({
      media: {
        realProviders: ["openai-media"],
        mockOnly: false,
        missing: ["正式配音未接通：缺少 MINIMAX_API_KEY（不得用 ELEVENLABS_TTS_API_KEY、写作 OPENAI_API_KEY 或百炼 TTS 替补）"],
        imageProviders: [
          {
            providerKey: "openai-media",
            model: "gpt-image-2.5-sunburst",
            connected: true,
            missing: [],
            unitPrice: "0.04",
            currency: "USD",
          },
          {
            providerKey: "dashscope-media",
            model: "qwen-image-3.0",
            connected: false,
            missing: ["百炼生图未接通：缺少 DASHSCOPE_MEDIA_API_KEY（媒体密钥；与视频同源，不是百炼 TTS 或其他密钥）"],
            unitPrice: null,
            currency: null,
          },
        ],
      },
    }));
    render(<AutoCreationStart />);
    await screen.findByTestId("auto-provider-target");
    expect(screen.getByTestId("auto-storyboard-openai-status").textContent).toContain("已接通");
    expect(screen.getByTestId("auto-storyboard-openai-status").textContent).toContain("0.04");
    expect(screen.getByTestId("auto-storyboard-dashscope-status").textContent).toContain("尚未计价");
    expect(screen.getByTestId("auto-storyboard-dashscope-status").textContent).toContain("DASHSCOPE_MEDIA_API_KEY");
    expect(screen.getByTestId("auto-voice-status").textContent).toContain("MINIMAX_API_KEY");
    expect((screen.getByRole("checkbox", { name: "剧本写完后，自动为每集生成分镜头" }) as HTMLInputElement).disabled).toBe(false);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("shows MiniMax voice and finished video connected without starting paid generation", async () => {
    const calls = server(options({
      media: {
        realProviders: ["openai-media", "minimax-tts", "dashscope-media"],
        mockOnly: false,
        missing: ["剧本拆解功能（服务端关闭，不会写入分镜生产数据）"],
        imageProviders: [
          {
            providerKey: "openai-media",
            model: "gpt-image-2.5-sunburst",
            connected: true,
            missing: [],
            unitPrice: "0.04",
            currency: "USD",
          },
          {
            providerKey: "dashscope-media",
            model: "qwen-image-3.0",
            connected: true,
            missing: [],
            unitPrice: "0.12",
            currency: "CNY",
          },
        ],
      },
    }));
    render(<AutoCreationStart />);
    await screen.findByTestId("auto-provider-target");
    expect(screen.getByTestId("auto-voice-status").textContent).toContain("正式配音已接通");
    expect(screen.getByTestId("auto-voice-status").textContent).toContain("确认费用后才生成");
    expect(screen.getByTestId("auto-finished-video-status").textContent).toContain("真实视频与成片已接通");
    expect(screen.getByTestId("auto-media-delivery").textContent).toContain("正式配音已接通");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("start page keeps call budget honest and does not collapse unpriced amount into 费用未知", async () => {
    server(options());
    render(<AutoCreationStart />);
    await screen.findByTestId("auto-provider-target");
    expect(screen.getByTestId("auto-calls").textContent).toContain("正常 6 次");
    const billing = screen.getByTestId("auto-billing-note").textContent!;
    expect(billing).toContain("本页不估算金额");
    expect(billing).toContain("金额尚未计价");
    expect(billing).not.toContain("费用未知");
    expect(billing).not.toMatch(/金额\s*0|费用\s*0/u);
  });

  it("uses the same optional genre for presets and advanced settings without starting a request", async () => {
    const calls = server(options());
    render(<AutoCreationStart />);
    await screen.findByTestId("auto-provider-target");
    const group = screen.getByRole("group", { name: "选题材开始" });
    expect(within(group).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "玄幻修仙", "都市情感", "豪门甜宠", "穿越重生", "悬疑推理", "年代家庭",
    ]);
    const xianxia = within(group).getByRole("button", { name: "玄幻修仙" });
    const mystery = within(group).getByRole("button", { name: "悬疑推理" });
    const advancedGenre = document.getElementById("auto-genre") as HTMLInputElement;
    expect((screen.getByLabelText("集数") as HTMLSelectElement).value).toBe("1");
    fireEvent.click(xianxia);
    expect(xianxia.getAttribute("aria-pressed")).toBe("true");
    expect(advancedGenre.value).toBe("玄幻修仙");
    expect(screen.getByTestId("auto-confirm-genre").textContent).toContain("玄幻修仙");
    fireEvent.change(advancedGenre, { target: { value: "悬疑推理" } });
    expect(xianxia.getAttribute("aria-pressed")).toBe("false");
    expect(mystery.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(mystery);
    expect(advancedGenre.value).toBe("");
    expect(mystery.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "AI 自动创作" })).toBeTruthy();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("keeps the genre, episode count and duration chosen while options are loading", async () => {
    const calls: Call[] = [];
    let returnOptions: (response: Response) => void = () => undefined;
    const delayedOptions = new Promise<Response>((resolve) => { returnOptions = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/writing/auto-runs/options")) return delayedOptions;
      return url === "/api/v1/projects"
        ? json({ id: P1 }, 201)
        : json({ run: { runId: RUN, projectId: P1, state: "running" } }, 201);
    }));
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    render(<AutoCreationStart />);
    fireEvent.click(screen.getByRole("button", { name: "都市情感" }));
    fireEvent.change(screen.getByLabelText("集数"), { target: { value: "6" } });
    fireEvent.change(screen.getByLabelText("每集时长"), { target: { value: "90" } });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    returnOptions(json(options()));
    await screen.findByTestId("auto-provider-target");
    expect((screen.getByLabelText("集数") as HTMLSelectElement).value).toBe("6");
    expect((screen.getByLabelText("每集时长") as HTMLSelectElement).value).toBe("90");
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 创作" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/projects/${P1}/auto`));
    const posts = calls.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[0]!.body).toMatchObject({ premise: "", episodeCount: 6, targetEpisodeSeconds: 90 });
    expect(posts[1]!.body).toMatchObject({ idea: "", constraints: { genre: "都市情感" }, episodeCount: 6, episodeSeconds: 90 });
  });

  it("uses the configured episode defaults when the plan was not edited", async () => {
    const calls = server(options({
      episodePlan: { minEpisodes: 1, maxEpisodes: 6, defaultEpisodes: 3, secondsChoices: [60, 90], defaultSeconds: 90 },
    }));
    render(<AutoCreationStart />);
    await screen.findByTestId("auto-provider-target");
    expect((screen.getByLabelText("集数") as HTMLSelectElement).value).toBe("3");
    expect((screen.getByLabelText("每集时长") as HTMLSelectElement).value).toBe("90");
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("shows the real provider, the call counts and the research limits before anything is sent", async () => {
    server(options());
    render(<AutoCreationStart />);
    await waitFor(() => expect(screen.getByTestId("auto-provider-target").textContent).toContain("DeepSeek · deepseek-flash"));
    expect(screen.getByTestId("auto-calls").textContent).toContain("正常 6 次");
    expect(screen.getByTestId("auto-calls").textContent).toContain("最坏 10 次");
    expect(screen.getByTestId("auto-research-mode").textContent).toContain("AI 创作策划");
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

  it("places storyboard actions next to the written episodes but never quotes for a legacy writing-only run", async () => {
    const stages = [1, 2].map((episodeNo) => ({ stageKey: `episode:${episodeNo}`, kind: "episode" as const,
      state: "completed" as const, attemptNo: 1, errorCode: null, output: fixtureAutoEpisode(episodeNo), upstreamChanged: false,
      supersededBy: null, scriptSave: "saved" as const, scriptRevisionId: null }));
    const done = run({ episodeCount: 2, currentEpisodes: { "episode:1": "episode:1", "episode:2": "episode:2" }, stages });
    const calls = server(options(), ({ url }) => {
      if (url.endsWith("/auto-runs/latest")) return json({ run: done });
      if (url.endsWith("/short-sequels")) return json({ episodeCount: 2, targetEpisodeSeconds: 60, nextEpisodeNo: 3, continuations: [] });
      if (url.endsWith("/storyboards")) return json({ imageAvailable: true, selectionAvailable: true, characterReferencesAvailable: true,
        episodes: [P1, RUN].map((id, index) => ({ episodeNo: index + 1, episodeId: id, blocked: null,
          shots: [{ shotRevisionId: id, shotId: id, caption: "门口相遇", state: "ready", previewAssetId: null, keptAssetId: null, jobId: null, quoteId: null }] })) });
      return json({}, 500);
    });
    render(<AutoCreationRun projectId={P1} />);
    const list = await screen.findByTestId("auto-episodes");
    const all = await within(list).findByRole("button", { name: "为全部集生成分镜头" });
    await waitFor(() => expect((all as HTMLButtonElement).disabled).toBe(false));
    expect(within(list).getAllByRole("button", { name: /生成这一集的分镜头/ })).toHaveLength(2);
    expect(calls.every(({ method }) => method === "GET")).toBe(true);
  });

  it("keeps the package, the machine check, the person's review and the video as separate facts; needs work is never shown as passed", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => input.endsWith("/auto-runs/latest") ? json({ run: run() }) : json(options())));
    render(<AutoCreationRun projectId={P1} />);
    await waitFor(() => expect(screen.getByTestId("auto-headline").textContent).toBe("剧本包已完成（待完善）"));
    expect(screen.getByTestId("auto-package-status").textContent).toContain("已完成");
    expect(screen.getByTestId("auto-quality").textContent).toContain("待完善");
    expect(screen.getByTestId("auto-quality").textContent).toContain("不是人工审核");
    expect(screen.getByTestId("auto-video-status").textContent).toContain("未开始");
    expect(screen.getByTestId("auto-video-status").textContent).toMatch(/尚未接通|人工审核/);
    expect(screen.getByTestId("auto-open-issues").textContent).toContain("开场没有主动选择");
    expect(screen.getByTestId("auto-download-md").getAttribute("href")).toBe(`/api/v1/projects/${P1}/auto-runs/${RUN}/package?format=markdown`);
    expect(screen.queryByTestId("auto-story-prose")).toBeNull();
  });

  it("keeps story prose and scripts readable when the continuation response is invalid and can be retried", async () => {
    const paragraphs = [
      "陈默夜里经过小区楼道，在一扇没关严的铁门旁捡到一只信封。里面的工时表有调班和加班记录，角上却留着一截被撕掉的签名。第二天是发薪日，陈默知道再拖一晚，负责结账的人就得回总部，便约同事去站点办公室核对原本。他把信封塞进口袋，抄下了每个人的班次。",
      "站长把空白工资单摊在桌上，催他先按手印再签字。陈默把自己的那页工时表放到桌角，请同事看清被抹掉的是谁的名字。他没有抢工资单，也没有说自己知道是谁动了手脚，只问站长愿不愿意当着所有人的面，把这些班次逐笔对照。门口陆续站满了人，原先催签的站长只好停笔。",
      "总部巡查员推门进来时，听见大家正在念工时。他查出值班夹里有一张未被处理的原件，把签名与信封里的半截笔迹一一对上，补记了少算的工资。陈默请他出具可复查的回执，再把那只信封还给同事。空白工资单被收回，工人围着桌子签下各自能核实的数字。",
    ];
    const stage = (stageKey: "bible" | "outline" | "episode:1", kind: "bible" | "outline" | "episode", output: AutoCreationRunView["stages"][number]["output"]) => ({
      stageKey, kind, state: "completed" as const, attemptNo: 1, errorCode: null, output,
      upstreamChanged: false, supersededBy: null, scriptSave: null, scriptRevisionId: null,
    });
    let sequelReads = 0;
    const calls = server(options(), (call) => {
      if (call.url.endsWith("/short-sequels")) {
        sequelReads += 1;
        return sequelReads === 1 ? json({ run: null }) : json({
          episodeCount: 1, targetEpisodeSeconds: 60, nextEpisodeNo: 2, continuations: [],
        });
      }
      if (!call.url.endsWith("/auto-runs/latest")) return json({}, 404);
      return json({ run: run({
        promptVersion: "ads.auto-creation.prompt.v15",
        currentEpisodes: { "episode:1": "episode:1" },
        stages: [
          stage("bible", "bible", fixtureAutoBible()),
          stage("outline", "outline", { ...fixtureAutoOutline(1), storyProse: paragraphs }),
          stage("episode:1", "episode", fixtureAutoEpisode(1)),
        ],
      }) });
    });
    render(<AutoCreationRun projectId={P1} />);
    const retry = await screen.findByRole("button", { name: "重新读取" });
    const reader = await screen.findByTestId("auto-story-prose") as HTMLDetailsElement;
    expect(reader.open).toBe(false);
    const trigger = within(reader).getByText("故事正文").closest("summary")!;
    fireEvent.click(trigger);
    expect(reader.open).toBe(true);
    const story = within(reader).getByLabelText("故事正文");
    expect([...story.querySelectorAll("p")].map((p) => p.textContent)).toEqual(paragraphs);
    expect(screen.getByRole("heading", { name: "分集剧本" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "下载剧本包（Markdown）" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "去作品中人工审核故事" })).toBeTruthy();
    fireEvent.click(retry);
    await screen.findByRole("button", { name: "续写下一集" });
    expect(reader.open).toBe(true);
    expect(sequelReads).toBe(2);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("lists written episodes in order and uses each current script to show its own cast and scenes", async () => {
    window.history.replaceState(null, "", "#auto-episodes-title");
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => undefined);
    const first = fixtureAutoEpisode(1, { tag: "已被替换的初稿" });
    const revised = {
      ...fixtureAutoEpisode(1, { tag: "第 2 轮当前版本" }),
      changes: [{ issueId: "R1", change: "集中到同一场" }],
    };
    revised.scenes = [revised.scenes[0]!];
    const second = fixtureAutoEpisode(2);
    const stage = (stageKey: string, kind: "bible" | "outline" | "episode" | "revise", output: AutoCreationRunView["stages"][number]["output"]) => ({
      stageKey, kind, state: "completed" as const, attemptNo: 1, errorCode: null, output,
      upstreamChanged: false, supersededBy: null, scriptSave: null, scriptRevisionId: null,
    });
    const calls = server(options(), (call) => call.url.endsWith("/short-sequels")
      ? json({ episodeCount: 3, targetEpisodeSeconds: 60, nextEpisodeNo: 4, continuations: [] })
      : json({ run: run({
        episodeCount: 3,
        currentEpisodes: { "episode:2": "episode:2", "episode:1": "revise:2:episode:1" },
        stages: [stage("bible", "bible", fixtureAutoBible()), stage("outline", "outline", fixtureAutoOutline(3)),
          stage("episode:1", "episode", first), stage("episode:2", "episode", second), stage("revise:2:episode:1", "revise", revised)],
      }) }));
    render(<AutoCreationRun projectId={P1} />);

    const list = await screen.findByTestId("auto-episodes");
    expect(scroll).toHaveBeenCalledWith({ block: "start" });
    expect(scroll.mock.instances[0]).toBe(within(list).getByRole("heading", { name: "分集剧本" }));
    window.history.replaceState(null, "", window.location.pathname);
    const entries = [...list.querySelectorAll("details")];
    expect(entries).toHaveLength(2);
    expect(list.textContent).toContain("已写好 2 / 3 集");
    expect(entries.every((entry) => !entry.open)).toBe(true);
    const [one, two] = entries;
    expect(one!.querySelector("summary strong")?.textContent).toBe("第 1 集 · 午夜工资单");
    expect(one!.querySelector("summary small")?.textContent).toBe("1 场 · 第 2 轮修改稿");
    expect(two!.querySelector("summary strong")?.textContent).toBe("第 2 集 · 午夜工资单");
    expect(two!.querySelector("summary small")?.textContent).toBe("3 场 · 初稿");
    const oneText = within(one!);
    const twoText = within(two!);
    expect(oneText.getByText("第 1 场 · 小区楼道 · 内景 · 夜", { selector: "strong" })).toBeTruthy();
    expect(oneText.getByText("总部巡查员")).toBeTruthy();
    expect(oneText.queryByText("赵强", { exact: true })).toBeNull();
    expect(oneText.queryByText("站点办公室", { exact: false })).toBeNull();
    expect(twoText.getByText("赵强", { exact: true })).toBeTruthy();
    expect(twoText.getByText("第 2 场、第 3 场出场")).toBeTruthy();
    expect(oneText.getByText("陈默找到证人")).toBeTruthy();
    expect(oneText.getByText("第 1 集结束时陈默拿到了巡查员的签名。")).toBeTruthy();
    expect(one!.textContent).toContain("第 2 轮当前版本");
    expect(list.textContent).not.toContain("已被替换的初稿");
    expect(calls.every((call) => call.method === "GET")).toBe(true);
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
      // checks v7: a viewing time, a duration the code cannot place in a text with no notice exit, and a changed length.
      ["unsourced_number@hypotheses[0].statement:digits+market_statistic+viewing_duration", ["hypotheses[0].statement", "市场或受众统计", "观众实际看多久、看多久后退出"]],
      ["unsourced_number@audience.viewingNeeds[0]:digits+unclassified+duration_unconfirmed", ["audience.viewingNeeds[0]", "程序无法确认这个时长是本剧篇幅还是观看时长"]],
      ["constraint_violation@hypotheses[0].statement:digits+frozen_conflict+length_changed", ["hypotheses[0].statement", "冻结的硬约束", "本剧时长与冻结的每集时长不同"]],
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

  it.each([
    { diagnostic: { excerpt: "计划比较排名第一的作品", truncated: true }, shown: true },
    { diagnostic: undefined, shown: false },
    { diagnostic: { excerpt: "<b>失效片段</b>", truncated: false }, shown: false },
  ])("shows only a validated ranking refusal excerpt and labels truncation ($shown)", async ({ diagnostic, shown }) => {
    const stage = {
      stageKey: "research", kind: "research" as const, state: "rejected" as const, attemptNo: 1, output: null,
      errorCode: "unsourced_number@contentStructure[5].application.pattern:rank+market_statistic+ranking",
      upstreamChanged: false, supersededBy: null, scriptSave: null, scriptRevisionId: null,
      ...(diagnostic ? { rejectionDiagnostic: diagnostic } : {}),
    };
    const failed = run({ state: "failed", errorCode: "unsourced_number", quality: "pending", packageStatus: "incomplete", callsUsed: 1, stages: [stage] });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => input.endsWith("/auto-runs/latest") ? json({ run: failed }) : json(options())));
    render(<AutoCreationRun projectId={P1} />);
    await waitFor(() => expect(screen.getByTestId("auto-headline").textContent).toBe("没有完成"));
    expect(screen.getByText(/^停在「/u).textContent).toContain("contentStructure[5].application.pattern");
    expect(screen.getByText(/^停在「/u).textContent).toContain("排名");
    const note = screen.queryByTestId("auto-rejection-diagnostic");
    if (shown) {
      expect(note).not.toBeNull();
      expect(note!.textContent).toContain("计划比较排名第一的作品");
      expect(note!.textContent).toContain("片段已截断");
    } else {
      expect(note).toBeNull();
    }
  });

  it("a viewing time names the branch the program took; an older code keeps the general text; an unknown branch is not shown", async () => {
    const stage = (errorCode: string) => ({ stageKey: "research", kind: "research" as const, state: "rejected" as const, attemptNo: 1, errorCode, output: null,
      upstreamChanged: false, supersededBy: null, scriptSave: null, scriptRevisionId: null });
    const at = "unsourced_number@contentStructure[0].application.why:digits+market_statistic+viewing_duration";
    for (const [code, expected, absent] of [
      [`${at}+viewing_habit`, ["程序命中了「观看习惯词」"], []],
      [`${at}+leaving_after`, ["程序命中了「时长后接退出或流失」"], []],
      [`${at}+viewing_the_work`, ["程序命中了「观看动词直接支配本剧」"], []],
      [`${at}+viewing_verb_before`, ["程序命中了「观看动词直接接时长」"], []],
      [`${at}+over_episode_length`, ["程序命中了「超过冻结的每集时长」"], []],
      [`${at}+not_pending`, ["程序命中了「缺少待验证或计划标记」"], []],
      [`${at}+not_observation_unit`, ["程序命中了「时长单位不能按观察期处理」"], []],
      [`${at}+no_plan_verb`, ["程序命中了「缺少观察计划动作」"], []],
      [at, [], ["程序命中了"]],
      [`${at}+made_up_branch`, [], ["程序命中了", "made_up_branch"]],
    ] as const) {
      cleanup();
      const failed = run({ state: "failed", errorCode: "unsourced_number", quality: "pending", storySave: "pending", storyRevisionId: null, packageStatus: "incomplete",
        callsUsed: 1, callCap: 6, openIssues: [], stages: [stage(code)] });
      vi.stubGlobal("fetch", vi.fn(async (input: string) => input.endsWith("/auto-runs/latest") ? json({ run: failed }) : json(options())));
      render(<AutoCreationRun projectId={P1} />);
      await waitFor(() => expect(screen.getByTestId("auto-headline").textContent).toBe("没有完成"));
      const stop = screen.getByText(/^停在「/u).textContent!;
      // The five parts read as before, whatever the branch.
      for (const text of ["contentStructure[0].application.why", "市场或受众统计", "观众实际看多久、看多久后退出"]) expect(stop, code).toContain(text);
      for (const text of expected) expect(stop, code).toContain(text);
      if (expected.length > 0) expect(stop, code).toContain("不还原原句");
      for (const text of absent) expect(stop, code).not.toContain(text);
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
    expect(limited.textContent).toContain("待验证的创作假设");
    expect(limited.textContent).toContain("验证计划尚未执行");
    expect(limited.textContent).toContain("不是实时市场验证");
    const detail = screen.getByTestId("auto-research-detail").textContent!;
    expect(detail).toContain("无（没有可引用的资料）");
    expect(screen.getByTestId("auto-hypotheses").textContent).toContain("H1 假设：两个互不信任的人");
    expect(screen.getByTestId("auto-hypotheses").textContent).toContain("验证计划：计划比较两个版本后再判断。");
    expect(screen.getByTestId("auto-audience").textContent).toContain("不是平台真实用户画像");
    // Stored v1/v2 research: the model's own limits and constraints, shown as it wrote them and marked as history.
    expect(detail).toContain("采用的约束（AI 复述，历史版本）：共 1 集，每集约 60 秒");
    expect(screen.getByTestId("auto-legacy-limitations").textContent).toBe("局限（AI 填写，历史版本）：官方条目没有读到正文");
    expect(screen.queryByTestId("auto-server-record")).toBeNull();
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

  it("research v3 shows the answer, the server's record and the unverified notices apart; nothing reads as verified", async () => {
    const notice = (field: string, token: string) => ({ origin: "server_check", field, token, semantic: "unclassified", rule: "no_role", note: "程序未能判定数字含义，未核实" });
    const research = {
      schema: "ads.auto-creation.research.v3", facts: [], observations: [],
      hypotheses: [{ id: "H1", statement: "主角只剩五十元，必须在午夜前讨回工资。", howToVerify: "计划上线后观察七天再判断。" }],
      audience: { primary: "拟面向通勤时刷剧的成年观众（待验证）", viewingNeeds: ["一集内看到结果"], emotionalAppeals: ["扳回一局"], basis: "hypothesis", sourceIds: [] },
      contentStructure: [{ reference: null, application: { pattern: "失踪者留下三块拼图，主角逐场拼出真相。", why: "自主创作设计。" } }],
      opportunities: ["小人物在一个夜晚完成一次反击"],
      serverRecord: { origin: "server_record",
        executedWith: { promptVersion: "ads.auto-creation.prompt.v5", checksVersion: "ads.auto-creation.checks.v5", researchSchema: "ads.auto-creation.research.v3" },
        settings: { origin: "user_setting", items: [{ key: "episodes", label: "集数", value: "共 1 集" }, { key: "maxCharacters", label: "出场人物上限", value: "最多 3 人" }] },
        material: { origin: "source_snapshot", researchMode: "limited",
          read: [{ sourceId: "S-KB-CRAFT", title: "短剧写作方法", readScope: "full_text", topic: "craft", note: "只涉及故事结构" }],
          unread: [{ sourceId: "S-OE-1", title: "巨量引擎帮助中心条目", status: "unreadable", note: "空壳" }],
          gaps: ["没有可读取的近期市场资料：本次为「资料有限策划模式」，不是实时市场验证。"] } },
      unverified: [notice("hypotheses[0].statement", "五十元"), notice("contentStructure[0].application.pattern", "三块")],
    };
    const directions = {
      schema: "ads.auto-creation.directions.v1",
      candidates: ["D1", "D2"].map((id) => ({ id, title: `方向${id}`, logline: `${id}：一个故事`, protagonist: "p", goal: "g", obstacle: "o", stakes: "s", coreEmotion: "e",
        differentiation: "用三块拼图代替三角恋", productionDifficulty: "low", difficultyNote: "n", audienceFit: "a", evidenceIds: [],
        ratings: { audienceFit: 4, conflictStrength: 4, originality: 4, feasibility: 4, constraintFit: 4 } })),
      selection: { rules: "ads.auto-creation.selection-rules.v1", chosenId: "D2", scores: [{ id: "D1", score: 4, excluded: null }, { id: "D2", score: 4, excluded: null }], reasons: ["理由"] },
      unverified: [notice("candidates[0].differentiation", "三块"), notice("candidates[1].differentiation", "三块")],
    };
    const done = run({ stages: [
      { stageKey: "sources", kind: "sources", state: "completed", attemptNo: 0, errorCode: null, output: null, upstreamChanged: false, supersededBy: null, scriptSave: null, scriptRevisionId: null },
      { stageKey: "research", kind: "research", state: "completed", attemptNo: 1, errorCode: null, output: research as never, upstreamChanged: false, supersededBy: null, scriptSave: null, scriptRevisionId: null },
      { stageKey: "directions", kind: "directions", state: "completed", attemptNo: 1, errorCode: null, output: directions as never, upstreamChanged: false, supersededBy: null, scriptSave: null, scriptRevisionId: null },
    ] });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => input.endsWith("/auto-runs/latest") ? json({ run: done }) : json(options())));
    render(<AutoCreationRun projectId={P1} />);
    const record = await screen.findByTestId("auto-server-record");
    expect(record.textContent).toContain("用户设定｜出场人物上限：最多 3 人");
    expect(record.textContent).toContain("资料模式：AI 创作策划（市场证据不可用，不是实时市场验证）");
    // research v3 never recorded market evidence apart: none is made up for it.
    expect(screen.queryByTestId("auto-server-market")).toBeNull();
    expect(screen.queryByTestId("auto-market-evidence")).toBeNull();
    expect(record.textContent).toContain("未读取：S-OE-1「巨量引擎帮助中心条目」（unreadable）");
    expect(screen.getByTestId("auto-research-detail").textContent).toContain("用户设定与资料记录（来自用户设定和服务端记录，不是 AI 调研结论）");
    // The model's text is shown as written, with a mark where a notice is; the notices are listed on their own.
    expect(screen.getByTestId("auto-hypotheses").textContent).toContain("H1 假设：主角只剩五十元，必须在午夜前讨回工资。（含未核实数字）");
    expect(screen.getAllByTestId("auto-unverified-mark")).toHaveLength(2);
    // Every notice of this older run is no_role: its heading reads as it did.
    expect(screen.getByText(/^未核实提示（/u).textContent).toContain("未核实提示（程序未能判定数字含义，未核实；");
    expect([...screen.getByTestId("auto-unverified").querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "第1条假设（H1）中的「五十元」：程序未能判定数字含义，未核实；只属于创作假设或设计，不是有来源的事实或市场结论。",
      "第1条内容结构的本剧应用设计中的「三块」：程序未能判定数字含义，未核实；只属于创作假设或设计，不是有来源的事实或市场结论。",
    ]);
    // Only the chosen direction's notice is shown with it.
    expect(screen.getByTestId("auto-direction-unverified").textContent).toBe("未核实提示：方向 D2 的差异点中的「三块」：程序未能判定数字含义，未核实；只属于创作假设或设计，不是有来源的事实或市场结论。");
    expect(screen.queryByTestId("auto-legacy-limitations")).toBeNull();
    expect(document.body.textContent).not.toMatch(/市场验证(已)?完成|已完成市场验证|已核实/u);
  });

  it.each(["limited", "sourced"] as const)("research v4 %s: the page says what the evidence is, from the server's record", async (mode) => {
    const limitedMode = mode === "limited";
    const research = {
      schema: "ads.auto-creation.research.v4",
      facts: limitedMode ? [] : [{ id: "F1", statement: "合成样本：写作方法要求主角主动。", sourceIds: ["S-KB-CRAFT"], evidence: "关键结果来自主角的选择和行动" }],
      observations: [],
      hypotheses: [{ id: "H1", statement: "合成样本：两个互不信任的人可能带来悬念。", howToVerify: "计划比较两个版本后再判断。" }],
      audience: { primary: "拟面向通勤时刷剧的成年观众（待验证）", viewingNeeds: ["一集内看到结果"], emotionalAppeals: ["扳回一局"], basis: "hypothesis", sourceIds: [] },
      contentStructure: [{ reference: { sourceId: "S-KB-CRAFT", quote: "关键结果来自主角的选择和行动" }, application: { pattern: "主角主动选择推动结果", why: "创作设计。" } }],
      opportunities: ["小人物在一个夜晚完成一次反击"],
      serverRecord: { origin: "server_record",
        executedWith: { promptVersion: "ads.auto-creation.prompt.v6", checksVersion: "ads.auto-creation.checks.v6", researchSchema: "ads.auto-creation.research.v4", answerContract: mode },
        marketEvidence: { origin: "source_snapshot", status: limitedMode ? "unavailable" : "available",
          note: limitedMode ? "市场证据不可用：本次资料快照没有符合条件的近期市场资料。" : "有可读取的市场资料：事实与观察逐条引用所读资料的原文。" },
        settings: { origin: "user_setting", items: [{ key: "episodes", label: "集数", value: "共 1 集" }] },
        material: { origin: "source_snapshot", researchMode: mode, read: [{ sourceId: "S-KB-CRAFT", title: "短剧写作方法", readScope: "full_text", topic: "craft", note: "写作方法" }],
          unread: [], gaps: [] } },
      unverified: [],
    };
    const done = run({ researchMode: mode, stages: [
      { stageKey: "sources", kind: "sources", state: "completed", attemptNo: 0, errorCode: null, output: null, upstreamChanged: false, supersededBy: null, scriptSave: null, scriptRevisionId: null },
      { stageKey: "research", kind: "research", state: "completed", attemptNo: 1, errorCode: null, output: research as never, upstreamChanged: false, supersededBy: null, scriptSave: null, scriptRevisionId: null },
    ] });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => input.endsWith("/auto-runs/latest") ? json({ run: done }) : json(options())));
    render(<AutoCreationRun projectId={P1} />);
    const detail = await screen.findByTestId("auto-research-detail");
    expect(screen.getByTestId("auto-server-market").textContent).toContain(limitedMode ? "市场证据：不可用" : "市场证据：可用");
    // The method reference stays a method reference in both modes.
    expect(screen.getByTestId("auto-structure-reference").textContent).toBe("参考方法原文：S-KB-CRAFT「关键结果来自主角的选择和行动」");
    if (limitedMode) {
      expect(screen.getByTestId("auto-research").textContent).toContain("AI 创作策划（受众待验证，市场证据不可用");
      expect(detail.querySelector("h2")!.textContent).toBe("AI 创作策划");
      expect(screen.getByTestId("auto-market-evidence").textContent).toContain("市场证据：不可用（服务端记录）");
      expect(screen.queryByTestId("auto-facts")).toBeNull();
      expect(screen.getByTestId("auto-audience").textContent).toContain("受众待验证");
      expect(screen.getByTestId("auto-research-limited").textContent).toContain("方法引用只是写作方法，不是市场证据");
    } else {
      expect(screen.getByTestId("auto-research").textContent).toContain("有可读取的市场资料");
      expect(screen.queryByTestId("auto-market-evidence")).toBeNull();
      expect(screen.getByTestId("auto-facts").textContent).toContain("合成样本：写作方法要求主角主动。");
      expect(screen.queryByTestId("auto-research-limited")).toBeNull();
    }
    expect(screen.queryByTestId("auto-legacy-limitations")).toBeNull();
    expect(document.body.textContent).not.toMatch(/市场验证(已)?完成|已完成市场验证|已核实/u);
  });

  it("checks v7: a duration notice is listed with its own note beside an older no_role one; the text stays as written and nothing reads as verified", async () => {
    const research = {
      schema: "ads.auto-creation.research.v4", facts: [], observations: [],
      hypotheses: [{ id: "H1", statement: "待验证：观众能否在60秒内理解人物冲突。", howToVerify: "计划邀请试看者复述人物关系。" }],
      audience: { primary: "拟面向通勤时刷剧的成年观众（待验证）", viewingNeeds: ["一集内看到结果"], emotionalAppeals: ["扳回一局"], basis: "hypothesis", sourceIds: [] },
      contentStructure: [{ reference: null, application: { pattern: "失踪者留下三块拼图，主角逐场拼出真相。", why: "自主创作设计。" } }],
      opportunities: ["小人物在一个夜晚完成一次反击"],
      serverRecord: { origin: "server_record",
        executedWith: { promptVersion: "ads.auto-creation.prompt.v7", checksVersion: "ads.auto-creation.checks.v7", researchSchema: "ads.auto-creation.research.v4", answerContract: "limited" },
        marketEvidence: { origin: "source_snapshot", status: "unavailable", note: "市场证据不可用：本次资料快照没有符合条件的近期市场资料。" },
        settings: { origin: "user_setting", items: [{ key: "episodes", label: "集数", value: "共 1 集" }] },
        material: { origin: "source_snapshot", researchMode: "limited", read: [], unread: [], gaps: [] } },
      unverified: [
        { origin: "server_check", field: "hypotheses[0].statement", token: "60", semantic: "unclassified", rule: "duration_unconfirmed", note: "程序无法确认时长含义（不是已判定的观看统计），未核实" },
        { origin: "server_check", field: "contentStructure[0].application.pattern", token: "三块", semantic: "unclassified", rule: "no_role", note: "程序未能判定数字含义，未核实" },
      ],
    };
    const done = run({ researchMode: "limited", stages: [
      { stageKey: "sources", kind: "sources", state: "completed", attemptNo: 0, errorCode: null, output: null, upstreamChanged: false, supersededBy: null, scriptSave: null, scriptRevisionId: null },
      { stageKey: "research", kind: "research", state: "completed", attemptNo: 1, errorCode: null, output: research as never, upstreamChanged: false, supersededBy: null, scriptSave: null, scriptRevisionId: null },
    ] });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => input.endsWith("/auto-runs/latest") ? json({ run: done }) : json(options())));
    render(<AutoCreationRun projectId={P1} />);
    await screen.findByTestId("auto-research-detail");
    expect(screen.getByTestId("auto-hypotheses").textContent).toContain("H1 假设：待验证：观众能否在60秒内理解人物冲突。（含未核实数字）");
    expect(screen.getByText(/^未核实提示（/u).textContent).toContain("未核实提示（程序未能判定数字或时长含义，未核实；");
    expect([...screen.getByTestId("auto-unverified").querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "第1条假设（H1）中的「60」：程序无法确认时长含义（不是已判定的观看统计），未核实；只属于创作假设或设计，不是有来源的事实或市场结论。",
      "第1条内容结构的本剧应用设计中的「三块」：程序未能判定数字含义，未核实；只属于创作假设或设计，不是有来源的事实或市场结论。",
    ]);
    expect(screen.queryByTestId("auto-facts")).toBeNull();
    expect(document.body.textContent).not.toMatch(/市场验证(已)?完成|已完成市场验证|已核实/u);
  });

  it("checks v11: an episode-scope notice on a plan is listed with its own note; the plan stays as written and reads as no viewing time or finding", async () => {
    const plan = "计划请试看者看完前三集再收集反馈。";
    const research = {
      schema: "ads.auto-creation.research.v4", facts: [], observations: [],
      hypotheses: [{ id: "H1", statement: "开场就让主角做出冒险选择，可能更容易让观众代入。", howToVerify: plan }],
      audience: { primary: "拟面向通勤时刷剧的成年观众（待验证）", viewingNeeds: ["一集内看到结果"], emotionalAppeals: ["扳回一局"], basis: "hypothesis", sourceIds: [] },
      contentStructure: [{ reference: null, application: { pattern: "主角主动选择推动结果", why: "自主创作设计。" } }],
      opportunities: ["小人物在一个夜晚完成一次反击"],
      serverRecord: { origin: "server_record",
        executedWith: { promptVersion: "ads.auto-creation.prompt.v10", checksVersion: "ads.auto-creation.checks.v11", researchSchema: "ads.auto-creation.research.v4", answerContract: "limited" },
        marketEvidence: { origin: "source_snapshot", status: "unavailable", note: "市场证据不可用：本次资料快照没有符合条件的近期市场资料。" },
        settings: { origin: "user_setting", items: [{ key: "episodes", label: "集数", value: "共 60 集" }] },
        material: { origin: "source_snapshot", researchMode: "limited", read: [], unread: [], gaps: [] } },
      unverified: [
        { origin: "server_check", field: "hypotheses[0].howToVerify", token: "三集", semantic: "unclassified", rule: "episode_scope_unconfirmed", note: "程序无法确认集数描述的作用范围，未核实" },
      ],
    };
    const done = run({ researchMode: "limited", stages: [
      { stageKey: "sources", kind: "sources", state: "completed", attemptNo: 0, errorCode: null, output: null, upstreamChanged: false, supersededBy: null, scriptSave: null, scriptRevisionId: null },
      { stageKey: "research", kind: "research", state: "completed", attemptNo: 1, errorCode: null, output: research as never, upstreamChanged: false, supersededBy: null, scriptSave: null, scriptRevisionId: null },
    ] });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => input.endsWith("/auto-runs/latest") ? json({ run: done }) : json(options())));
    render(<AutoCreationRun projectId={P1} />);
    await screen.findByTestId("auto-research-detail");
    expect(screen.getByTestId("auto-hypotheses").textContent).toContain(`验证计划：${plan}（含未核实数字）`);
    expect(screen.getByText(/^未核实提示（/u).textContent).toContain("未核实提示（程序未能判定数字、时长含义或集数作用范围，未核实；");
    expect([...screen.getByTestId("auto-unverified").querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "第1条假设（H1）的验证计划中的「三集」：程序无法确认集数描述的作用范围，未核实；只属于创作假设或设计，不是有来源的事实或市场结论。",
    ]);
    expect(document.body.textContent).not.toMatch(/市场验证(已)?完成|已完成市场验证|已核实|程序无法确认时长含义/u);
  });

  it("checks v11: a sample outside the work names the frozen episodes, never a key problem", async () => {
    const code = "constraint_violation@hypotheses[0].howToVerify:chinese_numeral+frozen_conflict+sample_out_of_range";
    const failed = run({ state: "failed", errorCode: "constraint_violation", quality: "pending", storySave: "pending", storyRevisionId: null, packageStatus: "incomplete",
      callsUsed: 1, callCap: 6, openIssues: [], stages: [{ stageKey: "research", kind: "research", state: "rejected", attemptNo: 1, errorCode: code, output: null,
        upstreamChanged: false, supersededBy: null, scriptSave: null, scriptRevisionId: null }] });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => input.endsWith("/auto-runs/latest") ? json({ run: failed }) : json(options())));
    render(<AutoCreationRun projectId={P1} />);
    const stop = (await screen.findByText(/^停在「/u)).textContent!;
    expect(stop).toContain("位置：hypotheses[0].howToVerify");
    expect(stop).toContain("验证计划抽取的集数或第几集超出本剧冻结的集数");
    expect(stop).not.toContain("sample_out_of_range");
    expect(screen.getByTestId("auto-output-refused").textContent).toContain("不是密钥或账户问题");
  });

  it("checks v12: a part or position of the work outside it in a creative design names the frozen episodes, never a key problem", async () => {
    const code = "constraint_violation@contentStructure[4].application.pattern:chinese_numeral+frozen_conflict+episode_range_out_of_range";
    const failed = run({ state: "failed", errorCode: "constraint_violation", quality: "pending", storySave: "pending", storyRevisionId: null, packageStatus: "incomplete",
      callsUsed: 1, callCap: 6, openIssues: [], stages: [{ stageKey: "research", kind: "research", state: "rejected", attemptNo: 1, errorCode: code, output: null,
        upstreamChanged: false, supersededBy: null, scriptSave: null, scriptRevisionId: null }] });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => input.endsWith("/auto-runs/latest") ? json({ run: failed }) : json(options())));
    render(<AutoCreationRun projectId={P1} />);
    const stop = (await screen.findByText(/^停在「/u)).textContent!;
    expect(stop).toContain("位置：contentStructure[4].application.pattern");
    expect(stop).toContain("本剧创作设计里的局部集数范围或第几集为零或超出本剧冻结的集数");
    expect(stop).not.toContain("episode_range_out_of_range");
    expect(screen.getByTestId("auto-output-refused").textContent).toContain("不是密钥或账户问题");
  });

  it("research v4: a limited answer carrying a sourced field is explained as the limited contract, never a key problem", async () => {
    const code = "invalid_output@facts:unrecognized_keys+limited_contract+forbidden_field";
    const failed = run({ state: "failed", errorCode: "invalid_output", quality: "pending", storySave: "pending", storyRevisionId: null, packageStatus: "incomplete",
      callsUsed: 1, callCap: 6, openIssues: [], stages: [{ stageKey: "research", kind: "research", state: "rejected", attemptNo: 1, errorCode: code, output: null,
        upstreamChanged: false, supersededBy: null, scriptSave: null, scriptRevisionId: null }] });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => input.endsWith("/auto-runs/latest") ? json({ run: failed }) : json(options())));
    render(<AutoCreationRun projectId={P1} />);
    const stop = (await screen.findByText(/^停在「/u)).textContent!;
    expect(stop).toContain("位置：facts");
    expect(stop).toContain("本次是 AI 创作策划（市场证据不可用），这个字段由服务端写入，模型回答不能包含，空值也不行");
    expect(stop).toContain("资料有限契约不允许的字段");
    expect(screen.getByTestId("auto-output-refused").textContent).toContain("不需要更换密钥");
  });

  it("research v3: an answer that writes the server's fields is refused as an extra field, named, never a key problem", async () => {
    const code = "invalid_output@appliedConstraints:unrecognized_keys";
    const failed = run({ state: "failed", errorCode: "invalid_output", quality: "pending", storySave: "pending", storyRevisionId: null, packageStatus: "incomplete",
      callsUsed: 1, callCap: 6, openIssues: [], stages: [{ stageKey: "research", kind: "research", state: "rejected", attemptNo: 1, errorCode: code, output: null,
        upstreamChanged: false, supersededBy: null, scriptSave: null, scriptRevisionId: null }] });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => input.endsWith("/auto-runs/latest") ? json({ run: failed }) : json(options())));
    render(<AutoCreationRun projectId={P1} />);
    await waitFor(() => expect(screen.getByTestId("auto-headline").textContent).toBe("没有完成"));
    const stop = screen.getByText(/^停在「/u).textContent!;
    expect(stop).toContain("appliedConstraints");
    expect(stop).toContain("模型回答包含契约不允许的额外字段；用户设定与资料局限由服务端记录，模型不能填写");
    expect(screen.getByTestId("auto-output-refused").textContent).toContain("不是密钥或账户问题");
  });

  it("an extra field in another stage, or an unnamed one in research, gets the general wording, never the research one", async () => {
    for (const [stageKey, kind, code, location] of [
      ["bible", "bible", "invalid_output:unrecognized_keys", "JSON 顶层对象"],
      ["directions", "directions", "invalid_output@candidates[0]:unrecognized_keys", "candidates[0]"],
      ["episode:1", "episode", "invalid_output@scenes[0]:unrecognized_keys", "scenes[0]"],
      ["research", "research", "invalid_output:unrecognized_keys", "JSON 顶层对象"],
    ] as const) {
      cleanup();
      const failed = run({ state: "failed", errorCode: "invalid_output", quality: "pending", storySave: "pending", storyRevisionId: null, packageStatus: "incomplete",
        callsUsed: 1, callCap: 6, openIssues: [], stages: [{ stageKey, kind, state: "rejected", attemptNo: 1, errorCode: code, output: null,
          upstreamChanged: false, supersededBy: null, scriptSave: null, scriptRevisionId: null }] });
      vi.stubGlobal("fetch", vi.fn(async (input: string) => input.endsWith("/auto-runs/latest") ? json({ run: failed }) : json(options())));
      render(<AutoCreationRun projectId={P1} />);
      await waitFor(() => expect(screen.getByTestId("auto-headline").textContent).toBe("没有完成"));
      const stop = screen.getByText(/^停在「/u).textContent!;
      expect(stop, code).toContain(`位置：${location}（`);
      expect(stop, code).toContain("模型回答包含契约不允许的额外字段");
      expect(stop, code).not.toContain("服务端记录");
      expect(screen.getByTestId("auto-output-refused").textContent).toContain("不是密钥或账户问题");
    }
  });

  it.each([
    ["dangling_reference@scenes[2].locationId", "第 3 场使用了未登记的地点编号"],
    ["dangling_reference@scenes[0].characterIds[1]", "第 1 场的第 2 个出场人物编号不在设定中"],
    ["dangling_reference@scenes[1].dialogue[0].characterId", "第 2 场的第 1 句对白用了本场未出场的人物编号"],
    ["dangling_reference@changes[0].issueId", "第 1 条改稿记录引用了本轮不适用于本集的问题编号"],
    ["dangling_reference", "结果引用了设定中不存在的人物、地点或编号"],
  ])("shows the revision reference error for %s", async (code, message) => {
    const failed = run({ state: "partial", errorCode: "dangling_reference", quality: "pending", storySave: "pending", storyRevisionId: null,
      packageStatus: "incomplete", callsUsed: 9, callCap: 12, openIssues: [], stages: [{
        stageKey: "revise:2:episode:1", kind: "revise", state: "rejected", attemptNo: 1, errorCode: code, output: null,
        upstreamChanged: false, supersededBy: null, scriptSave: null, scriptRevisionId: null,
      }] });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => input.endsWith("/auto-runs/latest") ? json({ run: failed }) : json(options())));
    render(<AutoCreationRun projectId={P1} />);
    expect((await screen.findByText(/^停在「/u)).textContent).toContain(message);
    expect(screen.getByTestId("auto-output-refused").textContent).toContain("新的计费调用");
  });

  it("prompt v9: a structure method id outside the run's catalog is a refused answer, named by field, never a key problem", async () => {
    const code = "unknown_reference@contentStructure[0].referenceId";
    const failed = run({ state: "failed", errorCode: "unknown_reference", quality: "pending", storySave: "pending", storyRevisionId: null, packageStatus: "incomplete",
      callsUsed: 1, callCap: 6, openIssues: [], stages: [{ stageKey: "research", kind: "research", state: "rejected", attemptNo: 1, errorCode: code, output: null,
        upstreamChanged: false, supersededBy: null, scriptSave: null, scriptRevisionId: null }] });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => input.endsWith("/auto-runs/latest") ? json({ run: failed }) : json(options())));
    render(<AutoCreationRun projectId={P1} />);
    await waitFor(() => expect(screen.getByTestId("auto-headline").textContent).toBe("没有完成"));
    const stop = screen.getByText(/^停在「/u).textContent!;
    expect(stop).toContain("回答选择的方法片段编号不在本次引用目录中，已拒收，后续阶段没有发送。");
    expect(stop).toContain("位置：contentStructure[0].referenceId");
    expect(stop).not.toContain("未识别的问题");
    const note = screen.getByTestId("auto-output-refused").textContent!;
    expect(note).toContain("不是密钥或账户问题");
    expect(note).toContain("新的计费调用");
    expect(document.body.textContent).not.toMatch(/认证失败|额度不足|连接中断|R-[0-9a-f]{10}/u);
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

  it("after story_update_conflict shows write + ack, stays disabled until checked, then sends acceptStoryChanged", async () => {
    const bodies: unknown[] = [];
    const conflicted = run({
      state: "completed",
      quality: "passed",
      errorCode: "story_update_conflict",
      storySave: "conflict",
      storyUpdateConflict: true,
      packageStatus: "ready",
      openIssues: [],
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/auto-runs/latest") || /\/auto-runs\/[0-9a-f-]+$/i.test(input)) return json({ run: conflicted });
      if (input.endsWith("/scripts")) {
        const body = JSON.parse(String(init?.body)) as { acceptStoryChanged: boolean };
        bodies.push(body);
        expect(body.acceptStoryChanged).toBe(true);
        return json({ run: conflicted });
      }
      return json(options());
    }));
    render(<AutoCreationRun projectId={P1} />);
    expect(await screen.findByTestId("auto-download-md")).toBeTruthy();
    expect(screen.getByTestId("auto-human-review").textContent).toContain("不是同一版本");
    expect(screen.getByTestId("auto-review-story-link").getAttribute("href")).toBe(`/projects/${P1}/create?step=story`);
    const place = await screen.findByRole("button", { name: "写入分集剧本草稿" });
    const confirm = await screen.findByTestId("auto-accept-story-changed");
    expect(confirm.textContent).toContain("不是同一版本");
    expect((place as HTMLButtonElement).disabled).toBe(true);
    expect(bodies).toHaveLength(0);
    fireEvent.click(confirm.querySelector("input")!);
    expect((place as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(place);
    await waitFor(() => expect(bodies).toEqual([{ acceptStoryChanged: true }]));
  });

  it("result page quotes user revise cost before confirm and starts only after confirm", async () => {
    const posts: Array<{ url: string; body: unknown; key?: string | null }> = [];
    const passed = run({
      state: "completed", quality: "passed", errorCode: null, revisionRoundsUsed: 0, callsUsed: 8, callCap: 12,
      selectableFindings: [
        { id: "R1", target: "episode:1", severity: "low", detail: "开门前缺少可见权衡" },
        { id: "R2", target: "outline", severity: "low", detail: "阻碍者动机应改为误以为争房产" },
      ],
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/auto-runs/latest") || /\/auto-runs\/[0-9a-f-]+$/i.test(input)) return json({ run: passed });
      if (input.endsWith("/user-revise")) {
        const body = JSON.parse(String(init?.body)) as { confirm: boolean; findingIds: string[]; instruction: string };
        posts.push({ url: input, body, key: new Headers(init?.headers).get("Idempotency-Key") });
        if (!body.confirm) {
          return json({
            run: passed,
            quote: { callsNeeded: 2, roundsUsed: 0, roundsBudget: 2, roundsRemainingAfter: 1, callsUsed: 8, callCap: 12, callsRemainingAfter: 2, episodeTargets: [1], syncStory: true },
          });
        }
        return json({ run: { ...passed, state: "running", revisionRoundsUsed: 1, quality: "pending" } });
      }
      return json(options());
    }));
    render(<AutoCreationRun projectId={P1} />);
    const section = await screen.findByTestId("auto-user-revise");
    expect(within(section).getByText(/R2/)).toBeTruthy();
    fireEvent.click(within(section).getByText(/R2/).closest("label")!.querySelector("input")!);
    fireEvent.change(screen.getByTestId("auto-user-revise-instruction"), { target: { value: "并写清可见犹豫" } });
    fireEvent.click(screen.getByTestId("auto-user-revise-preview"));
    const quote = await screen.findByTestId("auto-user-revise-quote");
    expect(quote.textContent).toContain("消耗 2 次");
    expect(quote.textContent).toContain("剩余修改轮次将变为 1");
    expect(quote.textContent).toContain("金额尚未计价");
    expect(quote.textContent).not.toContain("费用未知");
    expect(quote.textContent).not.toMatch(/金额\s*0|费用\s*0/u);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({ confirm: false, findingIds: ["R2"] });
    expect(posts[0]!.key).toBeFalsy();
    expect((screen.getByTestId("auto-user-revise-start") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("auto-user-revise-confirm").querySelector("input")!);
    fireEvent.click(screen.getByTestId("auto-user-revise-start"));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]!.body).toMatchObject({ confirm: true, findingIds: ["R2"], instruction: "并写清可见犹豫" });
    expect(posts[1]!.key).toBeTruthy();
  });

  it("result page separates recorded usage from amount not yet priced and lists bill-check call fields", async () => {
    const callId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const done = run({
      state: "completed", quality: "passed", errorCode: null, callsUsed: 8, callCap: 12, revisionRoundsUsed: 0,
      openIssues: [],
      calls: [{
        callId, stageKey: "research", attemptNo: 1, providerKey: "deepseek", model: "deepseek-flash",
        responseModel: "deepseek-flash", providerRequestId: "req-last-key-1", state: "completed", errorCode: null,
        usage: { status: "present", inputTokens: 120, outputTokens: 340, totalTokens: 460 },
        billingStatus: "unknown", createdAt: "2026-11-17T01:00:00.000Z", finishedAt: "2026-11-17T01:00:02.000Z",
      }],
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => input.endsWith("/auto-runs/latest") ? json({ run: done }) : json(options())));
    render(<AutoCreationRun projectId={P1} />);
    const header = await screen.findByTestId("auto-call-count");
    expect(header.textContent).toContain("已用 8 / 预算 12 次");
    expect(header.textContent).toContain("金额尚未计价");
    expect(header.textContent).not.toContain("费用未知");
    expect(header.textContent).not.toMatch(/金额\s*0|费用\s*0/u);
    const row = await screen.findByTestId(`auto-call-${callId}`);
    expect(row.textContent).toContain("研究与受众分析");
    expect(row.textContent).toContain("服务商 DeepSeek");
    expect(row.textContent).toContain("模型 deepseek-flash");
    expect(row.textContent).toContain("请求 id req-last-key-1");
    expect(row.textContent).toContain("用量 输入 120 / 输出 340 / 合计 460 tokens");
    expect(row.textContent).toContain("时间 2026-11-17T01:00:02.000Z");
    expect(row.textContent).toContain("计费 尚未计价");
    expect(row.textContent).not.toContain("费用未知");
  });

  it("a user-revise start whose answer was lost is replayed with its own key and body; a new key only after a confirmed result", async () => {
    const posts: Array<{ key: string | null; body: unknown }> = [];
    let latest = run({
      state: "completed", quality: "passed", errorCode: null, revisionRoundsUsed: 0, callsUsed: 8, callCap: 12,
      selectableFindings: [
        { id: "R2", target: "outline", severity: "low", detail: "阻碍者动机应改为误以为争房产" },
      ],
    });
    let lose = true;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/auto-runs/latest") || /\/auto-runs\/[0-9a-f-]+$/i.test(input)) return json({ run: latest });
      if (input.endsWith("/user-revise")) {
        const body = JSON.parse(String(init?.body)) as {
          confirm: boolean; findingIds: string[]; instruction: string; confirmUncertainCallIds: string[];
        };
        const key = new Headers(init?.headers).get("Idempotency-Key");
        posts.push({ key, body });
        if (!body.confirm) {
          return json({
            run: latest,
            quote: { callsNeeded: 2, roundsUsed: 0, roundsBudget: 2, roundsRemainingAfter: 1, callsUsed: 8, callCap: 12, callsRemainingAfter: 2, episodeTargets: [1], syncStory: true },
          });
        }
        if (lose) {
          lose = false;
          throw new TypeError("network down");
        }
        latest = { ...latest, state: "running", revisionRoundsUsed: 1, quality: "pending" };
        return json({ run: latest });
      }
      return json(options());
    }));
    render(<AutoCreationRun projectId={P1} />);
    await screen.findByTestId("auto-user-revise");
    fireEvent.click(screen.getByText(/R2/).closest("label")!.querySelector("input")!);
    fireEvent.change(screen.getByTestId("auto-user-revise-instruction"), { target: { value: "并写清可见犹豫" } });
    fireEvent.click(screen.getByTestId("auto-user-revise-preview"));
    await screen.findByTestId("auto-user-revise-quote");
    fireEvent.click(screen.getByTestId("auto-user-revise-confirm").querySelector("input")!);
    fireEvent.click(screen.getByTestId("auto-user-revise-start"));
    await waitFor(() => expect(posts.filter((item) => (item.body as { confirm: boolean }).confirm)).toHaveLength(1));
    expect(await screen.findByTestId("auto-user-revise-pending")).toBeTruthy();
    const firstConfirm = posts.find((item) => (item.body as { confirm: boolean }).confirm)!;
    expect(firstConfirm.body).toMatchObject({
      confirm: true, findingIds: ["R2"], instruction: "并写清可见犹豫", confirmUncertainCallIds: [],
    });
    expect(firstConfirm.key).toBeTruthy();
    const retry = await screen.findByRole("button", { name: "重试上次改稿请求" });
    fireEvent.click(retry);
    fireEvent.click(retry);
    await waitFor(() => expect(posts.filter((item) => (item.body as { confirm: boolean }).confirm)).toHaveLength(2));
    const secondConfirm = posts.filter((item) => (item.body as { confirm: boolean }).confirm)[1]!;
    expect(secondConfirm).toEqual({
      key: firstConfirm.key,
      body: {
        confirm: true, findingIds: ["R2"], instruction: "并写清可见犹豫", confirmUncertainCallIds: [],
      },
    });
    await waitFor(() => expect(screen.queryByTestId("auto-user-revise-pending")).toBeNull());
    expect(Object.keys(window.sessionStorage).some((key) => (window.sessionStorage.getItem(key) ?? "").includes(firstConfirm.key!))).toBe(false);
    // After a confirmed result, a later revise mints a new identity (reload a completed run with leftover rounds).
    latest = {
      ...latest, state: "completed", quality: "passed", revisionRoundsUsed: 1, callsUsed: 10, errorCode: null,
      selectableFindings: [{ id: "R2", target: "outline", severity: "low", detail: "阻碍者动机应改为误以为争房产" }],
    };
    cleanup();
    render(<AutoCreationRun projectId={P1} />);
    await screen.findByTestId("auto-user-revise");
    fireEvent.click(screen.getByText(/R2/).closest("label")!.querySelector("input")!);
    fireEvent.change(screen.getByTestId("auto-user-revise-instruction"), { target: { value: "再改一次动机" } });
    fireEvent.click(screen.getByTestId("auto-user-revise-preview"));
    await screen.findByTestId("auto-user-revise-quote");
    fireEvent.click(screen.getByTestId("auto-user-revise-confirm").querySelector("input")!);
    fireEvent.click(screen.getByRole("button", { name: "确认并开始改稿" }));
    await waitFor(() => expect(posts.filter((item) => (item.body as { confirm: boolean }).confirm)).toHaveLength(3));
    const thirdConfirm = posts.filter((item) => (item.body as { confirm: boolean }).confirm)[2]!;
    expect(thirdConfirm.key).toBeTruthy();
    expect(thirdConfirm.key).not.toBe(firstConfirm.key);
    expect(thirdConfirm.body).toMatchObject({ confirm: true, findingIds: ["R2"], instruction: "再改一次动机" });
  });

  describe("phase 5 commercial robustness", () => {
    it("machine-passed drafts keep human-review wording and never show an external publish affordance", async () => {
      const done = run({
        state: "completed", quality: "passed", errorCode: null, openIssues: [],
        storySave: "saved", packageStatus: "ready",
      });
      vi.stubGlobal("fetch", vi.fn(async (input: string) => input.endsWith("/auto-runs/latest") ? json({ run: done }) : json(options())));
      render(<AutoCreationRun projectId={P1} />);
      await waitFor(() => expect(screen.getByTestId("auto-headline").textContent).toBe("剧本包已完成（机器检查通过，仍需人工审核）"));
      expect(screen.getByTestId("auto-quality").textContent).toContain("不是人工审核");
      expect(screen.getByTestId("auto-human-review").textContent).toContain("请在作品中由人审核");
      const gate = screen.getByTestId("auto-publish-gate");
      expect(gate.textContent).toContain("不等于人工审核通过");
      expect(gate.textContent).toContain("不提供一键发布到红果、抖音");
      expect(gate.textContent).toContain("不能当作可发布成品");
      // Negation copy may mention those platforms; the page must not offer a publish action.
      expect(screen.queryByRole("button", { name: /一键发布|发布到红果|发布到抖音|自动外发|发布/ })).toBeNull();
      expect(screen.queryByRole("link", { name: /一键发布|发布到红果|发布到抖音/ })).toBeNull();
    });

    it("expired-session continue retains the pending user-revise identity and does not auto-submit a paid confirm", async () => {
      const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
      window.history.replaceState(null, "", `/projects/${P1}/auto`);
      const posts: Array<{ url: string; body: unknown; key: string | null }> = [];
      const passed = run({
        state: "completed", quality: "passed", errorCode: null, revisionRoundsUsed: 0, callsUsed: 8, callCap: 12,
        selectableFindings: [{ id: "R2", target: "outline", severity: "low", detail: "阻碍者动机应改为误以为争房产" }],
      });
      let expireOnce = true;
      vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
        if (input.endsWith("/auto-runs/latest") || /\/auto-runs\/[0-9a-f-]+$/i.test(input)) return json({ run: passed });
        if (input.endsWith("/user-revise")) {
          const body = JSON.parse(String(init?.body)) as { confirm: boolean };
          const key = new Headers(init?.headers).get("Idempotency-Key");
          posts.push({ url: input, body, key });
          if (!body.confirm) {
            return json({
              run: passed,
              quote: { callsNeeded: 2, roundsUsed: 0, roundsBudget: 2, roundsRemainingAfter: 1, callsUsed: 8, callCap: 12, callsRemainingAfter: 2, episodeTargets: [1], syncStory: true },
            });
          }
          if (expireOnce) {
            expireOnce = false;
            return json({ error: { code: "AUTH_SESSION_EXPIRED", message: "登录已过期" } }, 401);
          }
          return json({ run: { ...passed, state: "running", revisionRoundsUsed: 1, quality: "pending" } });
        }
        return json(options());
      }));
      const first = render(<AutoCreationRun projectId={P1} />);
      await screen.findByTestId("auto-user-revise");
      fireEvent.click(screen.getByText(/R2/).closest("label")!.querySelector("input")!);
      fireEvent.change(screen.getByTestId("auto-user-revise-instruction"), { target: { value: "并写清可见犹豫" } });
      fireEvent.click(screen.getByTestId("auto-user-revise-preview"));
      await screen.findByTestId("auto-user-revise-quote");
      fireEvent.click(screen.getByTestId("auto-user-revise-confirm").querySelector("input")!);
      fireEvent.click(screen.getByTestId("auto-user-revise-start"));
      await waitFor(() => expect(assign).toHaveBeenCalledWith(`/login?returnTo=${encodeURIComponent(`/projects/${P1}/auto`)}&reason=expired`));
      const confirmed = posts.filter((item) => (item.body as { confirm: boolean }).confirm);
      expect(confirmed).toHaveLength(1);
      expect(confirmed[0]!.key).toBeTruthy();
      const stored = Object.keys(window.sessionStorage).map((key) => window.sessionStorage.getItem(key) ?? "").join("\n");
      expect(stored).toContain(confirmed[0]!.key!);
      expect(stored).toContain("并写清可见犹豫");
      first.unmount();
      // Re-login / refresh: pending identity restores; no automatic paid confirm POST.
      const beforeRestore = posts.length;
      render(<AutoCreationRun projectId={P1} />);
      expect(await screen.findByTestId("auto-user-revise-pending")).toBeTruthy();
      expect(posts.length).toBe(beforeRestore);
      expect(posts.filter((item) => (item.body as { confirm: boolean }).confirm)).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: "重试上次改稿请求" }));
      await waitFor(() => expect(posts.filter((item) => (item.body as { confirm: boolean }).confirm)).toHaveLength(2));
      expect(posts.filter((item) => (item.body as { confirm: boolean }).confirm)[1]!.key).toBe(confirmed[0]!.key);
      assign.mockRestore();
    });

    it("does not treat an unconfirmed revise click as billed or auto-start paid revise", async () => {
      const posts: Array<{ body: unknown; key: string | null }> = [];
      const passed = run({
        state: "completed", quality: "passed", errorCode: null, revisionRoundsUsed: 0, callsUsed: 8, callCap: 12,
        selectableFindings: [{ id: "R2", target: "outline", severity: "low", detail: "阻碍者动机应改为误以为争房产" }],
      });
      vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
        if (input.endsWith("/auto-runs/latest") || /\/auto-runs\/[0-9a-f-]+$/i.test(input)) return json({ run: passed });
        if (input.endsWith("/user-revise")) {
          const body = JSON.parse(String(init?.body)) as { confirm: boolean };
          posts.push({ body, key: new Headers(init?.headers).get("Idempotency-Key") });
          return json({
            run: passed,
            quote: { callsNeeded: 2, roundsUsed: 0, roundsBudget: 2, roundsRemainingAfter: 1, callsUsed: 8, callCap: 12, callsRemainingAfter: 2, episodeTargets: [1], syncStory: true },
          });
        }
        return json(options());
      }));
      render(<AutoCreationRun projectId={P1} />);
      await screen.findByTestId("auto-user-revise");
      fireEvent.click(screen.getByText(/R2/).closest("label")!.querySelector("input")!);
      fireEvent.click(screen.getByTestId("auto-user-revise-preview"));
      await screen.findByTestId("auto-user-revise-quote");
      expect((screen.getByTestId("auto-user-revise-start") as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getByTestId("auto-user-revise-start"));
      expect(posts).toHaveLength(1);
      expect(posts[0]!.body).toMatchObject({ confirm: false });
      expect(posts[0]!.key).toBeFalsy();
      expect(posts.every((item) => (item.body as { confirm: boolean }).confirm === false)).toBe(true);
    });
  });
});
