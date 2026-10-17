// @vitest-environment happy-dom
// "AI 自动创作" start card and run page. Simulated interface tests: fetch is mocked; no browser, API or model.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoCreationOptionsView, AutoCreationRunView } from "@ai-drama/contracts";
import { AutoCreationStart } from "./auto-creation-start";
import { AutoCreationRun } from "./auto-creation-run";

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
      calls: [], legacyProviderRun: false, createdAt: "2026-10-18T00:00:00Z", updatedAt: "2026-10-18T00:00:00Z",
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
