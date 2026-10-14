// @vitest-environment happy-dom
// Simulated interface tests. fetch is mocked; this file does not start a browser, the API or a model.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EpisodeOutline, TitleConcept, TitleWritingRunView, TitleWritingStepView } from "@ai-drama/contracts";
import { TitleWritingClient } from "../lib/title-writing-client";
import { EpisodeWritingGuidance } from "./episode-writing-guidance";
import { TitleWritingRun } from "./title-writing-run";

const P1 = "22222222-2222-4222-8222-222222222222";
const RUN = "66666666-6666-4666-8666-666666666666";

const concept: TitleConcept = {
  schema: "ads.writing.title-concept.v1", genre: "都市", logline: "一句话", synopsis: "梗概", protagonistGoal: "目标", opposition: "阻力",
  coreConflict: "冲突", direction: "走向", characters: [{ name: "林夏", role: "主角", profile: "p" }, { name: "周岩", role: "r", profile: "p" }],
  relationships: [{ name: "林夏与周岩", pressure: "x" }],
};

function outline(goalOfTwo: string): EpisodeOutline {
  return { schema: "ads.writing.episode-outline.v1", episodes: [1, 2, 3].map((episodeNo) => ({ episodeNo, title: `集名${String(episodeNo)}`,
    entryState: `开场${String(episodeNo)}`, goal: episodeNo === 2 ? goalOfTwo : `目标${String(episodeNo)}`, action: `行动${String(episodeNo)}`,
    turn: `转折${String(episodeNo)}`, result: `结果${String(episodeNo)}`, handoff: `交接${String(episodeNo)}` })) };
}

function run(plan: EpisodeOutline | null, overrides: Partial<TitleWritingRunView> = {}): TitleWritingRunView {
  const step = (stepKey: TitleWritingStepView["stepKey"], output: TitleWritingStepView["output"]): TitleWritingStepView => ({
    stepKey, state: output ? "completed" : "pending", attemptNo: output ? 1 : 0, errorCode: null, output, text: null,
    scriptSave: stepKey.startsWith("episode:") ? "pending" : null, scriptRevisionId: null });
  return {
    runId: RUN, projectId: P1, title: "夜班证词", inputVersion: 1, episodeCount: 3, settings: { episodeCount: 3, episodeSeconds: 90, style: "" },
    providerKey: "qwen", model: "q-1", state: "partial", errorCode: null, cancelRequested: false, callCap: 8, callsUsed: 2, storySave: "saved",
    storyRevisionId: null, storyText: null, calls: [], createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z",
    steps: [step("concept", concept), step("outline", plan), step("episode:1", null), step("episode:2", null), step("episode:3", null)],
    ...overrides,
  };
}

function serve(view: TitleWritingRunView) {
  const calls: Array<{ method: string; url: string }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url });
    return new Response(JSON.stringify({ run: view }), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { calls, client: new TitleWritingClient(fetchImpl) };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("编剧检查 on the episode plan of a run", () => {
  it("an old run without a prompt version still shows its plan; the check opens on demand, by episode, without any request", async () => {
    const { client, calls } = serve(run(outline("目标1")));
    render(<TitleWritingRun projectId={P1} client={client} />);
    await screen.findByRole("heading", { name: "分集大纲" });
    expect(screen.getByText("进入状态：开场1")).toBeTruthy();
    expect(screen.queryByText(/加入编剧要求的提示词/)).toBeNull();
    const requestsBefore = calls.length;
    const button = screen.getByRole("button", { name: "编剧检查" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/待人工判断 \d+ 项/)).toBeNull();

    fireEvent.click(button);
    expect(screen.getByText(/包括页面未逐项展示的主角目标和阻力/)).toBeTruthy();
    expect(screen.queryByText(/只读取上面的/)).toBeNull();
    expect(screen.getByRole("button", { name: "收起编剧检查" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/明确缺项 0 项 · 待人工判断 \d+ 项 · 当前无法判断 0 项/)).toBeTruthy();
    expect(screen.getByText("没有发现明确缺项，这不代表故事合格。待人工判断的项仍需要你判断。")).toBeTruthy();
    // Episode 2 repeats episode 1's goal: a question for a person, located at episode 2, with both fields quoted.
    const second = screen.getByRole("region", { name: "第 2 集 集名2的检查结果" });
    expect(within(second).getByText("本集是否在重复上一集的冲突？")).toBeTruthy();
    expect(within(second).getByText(/第 1 集 goal（目标）：“目标1”/)).toBeTruthy();
    expect(within(second).getByRole("link", { name: "查看这一集大纲" }).getAttribute("href")).toBe("#outline-episode-2");
    expect(document.getElementById("outline-episode-2")).not.toBeNull();
    // The check reads what is on the page: no request, and the plan text is unchanged.
    expect(calls.length).toBe(requestsBefore);
    expect(screen.getByText("目标：目标1", { selector: "li#outline-episode-2 p" })).toBeTruthy();
    expect(screen.queryByText(/检查通过|已通过|总分|得分|爆款/)).toBeNull();
  });

  it("no missing item does not claim the fields are all written when some questions are undetermined", async () => {
    const plan = outline("目标2");
    plan.episodes[1] = { ...plan.episodes[1]!, turn: "…" };
    const { client } = serve(run(plan));
    render(<TitleWritingRun projectId={P1} client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "编剧检查" }));
    expect(screen.getByText(/明确缺项 0 项 · 待人工判断 \d+ 项 · 当前无法判断 3 项/)).toBeTruthy();
    expect(screen.queryByText(/字段都有内容/)).toBeNull();
    expect(screen.getByText(/没有发现明确缺项，这不代表故事合格。另有 3 项因相关内容为空或只是占位文字，当前无法判断。/)).toBeTruthy();
  });

  it("an empty field is a missing item of its episode", async () => {
    const { client } = serve(run(outline("   ")));
    render(<TitleWritingRun projectId={P1} client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "编剧检查" }));
    expect(screen.getByText(/明确缺项 1 项/)).toBeTruthy();
    const second = screen.getByRole("region", { name: "第 2 集 集名2的检查结果" });
    expect(within(second).getByText("明确缺项")).toBeTruthy();
    expect(within(second).getByText(/第 2 集 goal（目标）：（空）/)).toBeTruthy();
  });

  it("guided runs name their prompt; a running run without an outline does not report gaps prematurely", async () => {
    const guided = serve(run(outline("目标2"), { inputVersion: 2, promptVersion: "ads.title-writing.prompt.v3" }));
    render(<TitleWritingRun projectId={P1} client={guided.client} />);
    const note = await screen.findByText(/加入编剧要求的提示词（ads.title-writing.prompt.v3）/);
    expect(note.textContent).toContain("各集剧本按本次创作保存的分集大纲生成；大纲生成后没有人工确认步骤");
    cleanup();
    const latest = serve(run(outline("目标2"), { inputVersion: 2, promptVersion: "ads.title-writing.prompt.v4" }));
    render(<TitleWritingRun projectId={P1} client={latest.client} />);
    expect(await screen.findByText(/加入编剧要求的提示词（ads.title-writing.prompt.v4）/)).toBeTruthy();
    cleanup();
    const early = serve(run(null, { state: "running" }));
    render(<TitleWritingRun projectId={P1} client={early.client} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "故事策划" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "编剧检查" })).toBeNull();
  });
});


it("qualifies next-episode advice and explains closure on the shared guidance panel", () => {
  render(<EpisodeWritingGuidance defaultOpen />);
  expect(screen.getByText(/非最后一集解决一部分问题/)).toBeTruthy();
  expect(screen.getByText(/单集作品或最后一集应收束主线、回应整部期待，不再新留悬念/)).toBeTruthy();
  expect(screen.getByText(/终集：凭录音洗清冤屈/)).toBeTruthy();
});


describe("outline closure labels", () => {
  it.each(["ads.title-writing.prompt.v3", "ads.title-writing.prompt.v4"])("%s labels the actual final episode and single-episode plan as closure", async (promptVersion) => {
    for (const count of [1, 3, 6]) {
      const plan: EpisodeOutline = { schema: "ads.writing.episode-outline.v2", episodes: Array.from({ length: count }, (_, index) => ({
        ...outline("目标2").episodes[0]!, episodeNo: index + 1, title: `集名${index + 1}`, handoff: `交接${index + 1}` })) };
      const { client } = serve(run(plan, { inputVersion: 2, promptVersion, episodeCount: count }));
      render(<TitleWritingRun projectId={P1} client={client} />);
      await screen.findByRole("heading", { name: "分集大纲" });
      expect(screen.getByText(`全剧收尾：交接${count}`)).toBeTruthy();
      expect(screen.queryByText(`交给下一集：交接${count}`)).toBeNull();
      for (let n = 1; n < count; n++) expect(screen.getByText(`交给下一集：交接${n}`)).toBeTruthy();
      cleanup();
    }
  });

  it("uses neutral legacy labels and does not mistake a partial outline for the finale", async () => {
    const old = serve(run(outline("目标2")));
    render(<TitleWritingRun projectId={P1} client={old.client} />);
    expect(await screen.findByText("结尾记录：交接3")).toBeTruthy();
    cleanup();
    const plan = outline("目标2");
    plan.episodes = plan.episodes.slice(0, 1);
    const { client } = serve(run(plan, { inputVersion: 2, promptVersion: "ads.title-writing.prompt.v4", episodeCount: 3 }));
    render(<TitleWritingRun projectId={P1} client={client} />);
    expect(await screen.findByText("交给下一集：交接1")).toBeTruthy();
    expect(screen.queryByText(/全剧收尾：/)).toBeNull();
  });
});

describe("missing outline check on stopped runs", () => {
  it.each(["failed", "canceled", "needs_attention", "partial", "completed"] as const)("makes %s run gaps inspectable without requests or dead anchors", async (state) => {
    const { client, calls } = serve(run(null, { state, episodeCount: 6, promptVersion: "ads.title-writing.prompt.v4" }));
    render(<TitleWritingRun projectId={P1} client={client} />);
    const button = await screen.findByRole("button", { name: "编剧检查" });
    const before = calls.length;
    fireEvent.click(button);
    expect(screen.getByText(/明确缺项 \d+ 项 · 待人工判断/).textContent).toContain("明确缺项 6 项");
    expect(screen.getAllByText("这次创作没有可读的分集大纲。")).toHaveLength(6);
    expect(within(screen.getByRole("region", { name: "第 6 集的检查结果" })).getByText(/主线如何收束、整部期待如何回应/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "查看这一集大纲" })).toBeNull();
    expect(calls.length).toBe(before);
  });

  it("falls back to frozen settings when the optional episodeCount view field is absent", async () => {
    const { client } = serve(run(null, { state: "failed", episodeCount: undefined,
      settings: { episodeCount: 1, episodeSeconds: 90, style: "" } }));
    render(<TitleWritingRun projectId={P1} client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "编剧检查" }));
    expect(screen.getByText(/明确缺项 \d+ 项 · 待人工判断/).textContent).toContain("明确缺项 1 项");
  });
});


it.each([undefined, "ads.title-writing.prompt.v1", "ads.title-writing.prompt.v2"])("keeps legacy %s finale evidence and advice neutral", async (promptVersion) => {
  for (const handoff of ["旧版后续信息", "待定"]) {
    const plan = outline("目标2");
    plan.episodes[2]!.handoff = handoff;
    const { client } = serve(run(plan, { promptVersion }));
    render(<TitleWritingRun projectId={P1} client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "编剧检查" }));
    expect(screen.getByText(`结尾记录：${handoff}`)).toBeTruthy();
    const last = screen.getByRole("region", { name: "第 3 集 集名3的检查结果" });
    expect(within(last).getByText("结尾记录是否与故事走向一致？")).toBeTruthy();
    expect(within(last).queryByText(/最后一集是否回应了整部期待|最后一集怎样收束主线|handoff（全剧收尾）/)).toBeNull();
    expect(within(last).getAllByText(/handoff（结尾记录）/).length).toBeGreaterThan(0);
    if (handoff === "待定") expect(within(last).getByText("最后一集的结尾记录是什么？")).toBeTruthy();
    cleanup();
  }
});
