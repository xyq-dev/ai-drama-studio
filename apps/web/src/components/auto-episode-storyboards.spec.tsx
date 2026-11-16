// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCRIPT_BREAKDOWN_LIMITS, type ScriptBreakdownOptionsView } from "@ai-drama/contracts";
import type { AutoStoryboardEpisode, AutoStoryboardShot, AutoStoryboardView, StoryboardGate } from "../lib/auto-episode-storyboards-client";
import { AutoEpisodeStoryboards } from "./auto-episode-storyboards";

const P = "11111111-1111-4111-8111-111111111111";
const R = "22222222-2222-4222-8222-222222222222";
const A = "33333333-3333-4333-8333-333333333333";
const B = "44444444-4444-4444-8444-444444444444";
const ASSET = "55555555-5555-4555-8555-555555555555";
const Q = "66666666-6666-4666-8666-666666666666";
const AUTH = "77777777-7777-4777-8777-777777777777";
const J = "88888888-8888-4888-8888-888888888888";
const BASE = `/api/v1/projects/${P}/auto-runs/${R}/storyboards`;
const shot = (id: string, state: AutoStoryboardShot["state"] = "ready", asset: string | null = null): AutoStoryboardShot => ({
  shotRevisionId: id, shotId: id, caption: id === A ? "门口一镜" : "庭院二镜",
  state, jobId: null, quoteId: null, previewAssetId: asset, keptAssetId: null,
});
const episode = (episodeNo: number, shots = [shot(A)], blocked: StoryboardGate | null = null): AutoStoryboardEpisode => ({
  episodeNo, episodeId: episodeNo === 1 ? A : B, blocked, shots,
});
const view = (...episodes: AutoStoryboardEpisode[]): AutoStoryboardView => ({
  imageAvailable: true, selectionAvailable: true, characterReferencesAvailable: false, episodes,
});

function fixture(initial = view(episode(1))) {
  const state = { value: initial, loseReceiptFor: "", zeroQuote: false, breakdownOptions: null as ScriptBreakdownOptionsView | null };
  const writes: Array<{ method: string; url: string; body: unknown; key: string | null }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    const method = options?.method ?? "GET";
    if (method === "GET") {
      if (url === BASE) return Response.json(state.value);
      if (url.endsWith("/writing/script-breakdowns/options")) return state.breakdownOptions
        ? Response.json(state.breakdownOptions) : Response.json({}, { status: 503 });
      return Response.json({}, { status: 404 });
    }
    writes.push({ method, url, body: JSON.parse(String(options?.body)), key: new Headers(options?.headers).get("Idempotency-Key") });
    if (url.endsWith("/quote")) return Response.json({
      quoteId: Q, inputHash: "e".repeat(64), capability: "image.generate", currency: "USD",
      estimatedAmount: state.zeroQuote ? "0" : url.includes(A) ? "0.1" : "0.2",
      maximumAmount: "1", expiresAt: "2099-01-01T00:00:00.000Z",
      providerConfigurationId: J, providerConfigurationVersion: "1", priceVersion: "1",
      actualCost: "unknown", singleOperation: true,
    });
    if (url.endsWith("/authorize")) return Response.json({ quoteId: Q, budgetAuthorizationId: AUTH });
    if (url.endsWith("/generate")) {
      if (state.loseReceiptFor && url.includes(state.loseReceiptFor)) throw new TypeError("network");
      return Response.json({ jobId: J, workflowRunId: J });
    }
    if (url.endsWith("/selection")) return Response.json({ selectedAssetId: ASSET });
    throw new Error(`Unexpected route ${url}`);
  }));
  return { state, writes };
}
afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("Auto episode storyboard", () => {
  it("opens an exact scoped estimate once and authorizes only after confirmation", async () => {
    const { writes } = fixture(view(episode(1, [shot(A)]), episode(2, [shot(B)])));
    const page = render(<AutoEpisodeStoryboards projectId={P} runId={R} autoQuote />);
    expect(await screen.findByText("0.3 USD")).toBeTruthy();
    expect(screen.getByText(/预计生成 2 张图，每镜一张/)).toBeTruthy();
    expect(screen.getByText("第 2 集 · 第 1 镜，共 1 镜")).toBeTruthy();
    expect(writes.map((item) => item.body)).toEqual([
      { capability: "image.generate", autoStoryboardRunId: R },
      { capability: "image.generate", autoStoryboardRunId: R },
    ]);
    page.rerender(<AutoEpisodeStoryboards projectId={P} runId={R} autoQuote refreshKey={1} />);
    expect(writes).toHaveLength(2);
    fireEvent.click(screen.getByRole("checkbox", { name: "确认按上述额度生成分镜图" }));
    fireEvent.click(screen.getByRole("button", { name: "确认生成 2 镜" }));
    await waitFor(() => expect(writes.filter((item) => item.url.endsWith("/generate"))).toHaveLength(2));
    const authorization = writes.find((item) => item.url.endsWith("/authorize"))!;
    const generate = writes.find((item) => item.url.endsWith("/generate"))!;
    expect(authorization.key).toBe(generate.key);
    expect(authorization.body).toMatchObject({ maximumAmount: "0.1", confirmedUncertainJobIds: [] });
  });

  it("holds paid quotes behind script gates and lets an explicit failed-shot retry skip all other shots", async () => {
    const { state, writes } = fixture(view(episode(1, [shot(A, "failed")]), episode(2, [], "script_review_required")));
    const page = render(<AutoEpisodeStoryboards projectId={P} runId={R} autoQuote />);
    expect(await screen.findByText("请先审核通过本集剧本。")).toBeTruthy();
    expect(writes).toHaveLength(0);
    state.value = view(episode(1, [shot(A, "failed"), shot(B, "unknown")]));
    page.rerender(<AutoEpisodeStoryboards projectId={P} runId={R} autoQuote={false} refreshKey={1} />);
    expect(await screen.findByText("结果待核实")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试本镜 门口一镜" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.url).toContain(`/shot-revisions/${A}/`);
  });

  it("manually quotes only ready shots and explains which episodes were skipped", async () => {
    const { writes } = fixture(view(episode(1), episode(2, [], "shots_not_ready")));
    render(<AutoEpisodeStoryboards projectId={P} runId={R} autoQuote />);
    const all = screen.getByRole("button", { name: "为全部集生成分镜头" }) as HTMLButtonElement;
    await waitFor(() => expect(all.disabled).toBe(false));
    expect(writes).toHaveLength(0);
    fireEvent.click(all);
    expect(await screen.findByText(/第 2 集已跳过/)).toBeTruthy();
    expect(writes).toEqual([expect.objectContaining({ url: expect.stringContaining(`/shot-revisions/${A}/real-media/quote`) })]);
  });

  it("explains missing OpenAI configuration without quoting or substituting a provider", async () => {
    const { writes } = fixture({ ...view(episode(1)), imageAvailable: false });
    render(<AutoEpisodeStoryboards projectId={P} runId={R} autoQuote />);
    await screen.findByText("还没有接通 OpenAI 生图，不能生成分镜头");
    expect((screen.getByRole("button", { name: "生成这一集的分镜头" }) as HTMLButtonElement).disabled).toBe(true);
    expect(writes).toEqual([]);
  });

  it.each([
    ["TITLE_WRITING_DISABLED", "当前未开启 AI 剧本拆解。"],
    ["SCRIPT_BREAKDOWN_STORAGE_UNAVAILABLE", "剧本拆解的数据存储还没有就绪。"],
  ])("explains %s without starting a breakdown or quoting images", async (code, message) => {
    const { state, writes } = fixture(view(episode(1, [], "shots_not_ready")));
    state.breakdownOptions = { enabled: code !== "TITLE_WRITING_DISABLED", code, storageReady: code === "TITLE_WRITING_DISABLED",
      operatorTokenRequired: false, defaultProvider: null, providers: [], maxCallsPerDay: 30, callCapPerRun: 3,
      billing: "unknown", limits: SCRIPT_BREAKDOWN_LIMITS };
    render(<AutoEpisodeStoryboards projectId={P} runId={R} autoQuote />);
    await screen.findByText(message);
    expect(screen.getByRole("link", { name: "打开第 1 集工作台" }).getAttribute("href"))
      .toBe(`/projects/${P}?focus=script&episode=1#script-breakdown`);
    expect(writes).toEqual([]);
  });

  it("waits for the full episode gate and never requests authorization for a zero quote", async () => {
    const { state, writes } = fixture(view(episode(1, [], "script_not_placed")));
    state.zeroQuote = true;
    const page = render(<AutoEpisodeStoryboards projectId={P} runId={R} autoQuote />);
    await screen.findByText("请先把本集剧本写入作品。");
    expect(writes).toHaveLength(0);
    state.value = view(episode(1));
    page.rerender(<AutoEpisodeStoryboards projectId={P} runId={R} autoQuote refreshKey={1} />);
    expect(await screen.findByText(/报价不可核实/)).toBeTruthy();
    expect(writes).toHaveLength(1);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText("0 USD", { exact: true })).toBeNull();
  });

  it("pauses one unconfirmed shot while submitting the other, and never reposts the lost receipt after refresh", async () => {
    const { state, writes } = fixture(view(episode(1, [shot(A), shot(B)])));
    state.loseReceiptFor = A;
    const first = render(<AutoEpisodeStoryboards projectId={P} runId={R} autoQuote />);
    await screen.findByText("0.3 USD");
    fireEvent.click(screen.getByRole("checkbox", { name: "确认按上述额度生成分镜图" }));
    fireEvent.click(screen.getByRole("button", { name: "确认生成 2 镜" }));
    await screen.findByText("提交结果待核实");
    await screen.findByText("任务已受理，等待核实状态");
    expect(writes.filter((row) => row.url.endsWith("/generate")).map((row) => row.url)).toEqual([
      expect.stringContaining(`/shot-revisions/${A}/`),
      expect.stringContaining(`/shot-revisions/${B}/`),
    ]);
    state.value = view(episode(1, [{ ...shot(A, "failed"), jobId: AUTH, quoteId: B }, { ...shot(B, "generated", ASSET), jobId: J, quoteId: Q }]));
    const previous = writes.length;
    first.unmount();
    render(<AutoEpisodeStoryboards projectId={P} runId={R} autoQuote />);
    await screen.findByText("提交结果待核实");
    expect(screen.queryByRole("button", { name: "重试本镜 门口一镜" })).toBeNull();
    expect(writes).toHaveLength(previous);
    state.value = view(episode(1, [{ ...shot(A, "unknown"), jobId: AUTH, quoteId: Q }]));
    fireEvent.click(screen.getByRole("button", { name: "刷新分镜图状态" }));
    await screen.findByText("结果待核实", { exact: true });
    expect(writes).toHaveLength(previous);
  });

  it("keeps a successful candidate with an explicit compare-and-set", async () => {
    const { writes } = fixture(view(episode(1, [shot(A, "generated", ASSET)])));
    render(<AutoEpisodeStoryboards projectId={P} runId={R} autoQuote={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "保留本图 门口一镜" }));
    await waitFor(() => expect(writes).toEqual([expect.objectContaining({
      method: "PUT", url: `${BASE}/${A}/selection`, body: { assetId: ASSET, expectedSelectedAssetId: null },
    })]));
  });
});
