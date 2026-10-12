// @vitest-environment happy-dom
// Simulated interface tests. fetch is mocked; this file does not start a browser, the API or a model.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScriptBreakdownOptionsView, ScriptBreakdownRunView } from "@ai-drama/contracts";
import { SCRIPT_BREAKDOWN_LIMITS } from "@ai-drama/contracts";
import { ScriptBreakdownClient } from "../lib/script-breakdown-client";
import { ScriptBreakdownPanel, breakdownErrorText } from "./script-breakdown-panel";
import { plannedDurationOf } from "./workbench";

const P1 = "22222222-2222-4222-8222-222222222222";
const E1 = "33333333-3333-4333-8333-333333333333";
const RUN = "66666666-6666-4666-8666-666666666666";
const SCENE = "77777777-7777-4777-8777-777777777777";
const TOKEN = "operator-token-0123456789";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

const OPTIONS: ScriptBreakdownOptionsView = {
  enabled: true, code: "SCRIPT_BREAKDOWN_READY", storageReady: true, operatorTokenRequired: true, defaultProvider: "qwen",
  providers: [{ providerKey: "qwen", label: "千问", ready: true, models: ["q-1"], defaultModel: "q-1", missing: [] }],
  maxCallsPerDay: 30, callCapPerRun: 3, billing: "unknown", limits: SCRIPT_BREAKDOWN_LIMITS,
};

function run(overrides: Partial<ScriptBreakdownRunView> = {}): ScriptBreakdownRunView {
  return {
    runId: RUN, projectId: P1, episodeId: E1, episodeNo: 2, scriptRevisionId: "88888888-8888-4888-8888-888888888888", scriptRevisionNo: 3,
    targetEpisodeSeconds: 60, characters: [{ key: "C1", characterId: "99999999-9999-4999-8999-999999999999", revisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "林夏" }],
    replacedScenes: 0, providerKey: "qwen", model: "q-1", state: "completed", errorCode: null, cancelRequested: false, callCap: 3, callsUsed: 1,
    step: { state: "completed", attemptNo: 1, errorCode: null },
    output: {
      schema: "ads.script-breakdown.output.v1", episodeNo: 2,
      scenes: [{ key: "S1", heading: "便利店", timeOfDay: "夜", description: "林夏发现监控被改。" }],
      shots: [
        { key: "S1-1", sceneKey: "S1", shotType: "中景", camera: "缓慢推近监控屏幕", action: "林夏盯着屏幕", dialogue: [], characterKeys: ["C1"], plannedSeconds: 4 },
        { key: "S1-2", sceneKey: "S1", shotType: "近景", camera: "固定机位", action: "林夏后退", dialogue: [{ speaker: "林夏", line: "这不是我。" }], characterKeys: ["C1"], plannedSeconds: 3 },
      ],
    },
    plannedTotalSeconds: 7, save: "saved",
    scenes: [{ key: "S1", ordinal: 1, sceneId: SCENE, sceneRevisionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", shotSave: "pending", placedSceneRevisionId: null,
      current: { archived: false, currentRevisionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", approvedRevisionId: null, reviewStatus: "DRAFT", freshnessStatus: "CURRENT" } }],
    episodeScript: { currentRevisionId: "88888888-8888-4888-8888-888888888888", currentRevisionNo: 3, approved: true },
    calls: [], createdAt: "2026-10-12T00:00:00Z", updatedAt: "2026-10-12T00:00:00Z",
    ...overrides,
  };
}

interface Seen { method: string; url: string; headers: Record<string, string>; body: unknown }

function harness(latest: ScriptBreakdownRunView | null, answers: Array<Response | Error> = []) {
  const seen: Seen[] = [];
  const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
    const headers = Object.fromEntries([...new Headers(init?.headers).entries()].map(([name, value]) => [name.toLowerCase(), value]));
    seen.push({ method: init?.method ?? "GET", url: input, headers, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (input.endsWith("/writing/script-breakdowns/options")) return json(OPTIONS);
    if (input.endsWith("/latest")) return json({ run: latest });
    const next = answers.shift();
    if (!next) throw new Error(`unexpected ${input}`);
    if (next instanceof Error) throw next;
    return next;
  });
  const client = new ScriptBreakdownClient(fetchImpl as unknown as typeof fetch);
  const onOpenScene = vi.fn();
  const onChanged = vi.fn(async () => undefined);
  return { seen, client, onOpenScene, onChanged };
}

function panel(h: ReturnType<typeof harness>, props: { scriptReady?: boolean; sceneCount?: number } = {}) {
  return render(<ScriptBreakdownPanel projectId={P1} episodeId={E1} episodeNo={2} scriptReady={props.scriptReady ?? true}
    sceneCount={props.sceneCount ?? 0} onOpenScene={h.onOpenScene} onChanged={h.onChanged} client={h.client} />);
}

beforeEach(() => window.sessionStorage.clear());
afterEach(() => cleanup());

describe("AI breakdown panel", () => {
  it("keeps the script gate and shows the bounds before anything can start", async () => {
    const h = harness(null);
    panel(h, { scriptReady: false });
    expect((await screen.findByTestId("breakdown-blocked")).textContent).toContain("剧本批准后才能拆解");
    expect((screen.getByRole("button", { name: "生成场景与分镜" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("breakdown-limits")).textContent).toContain("每集 1–8 场、1–20 镜");
    expect((screen.getByTestId("breakdown-limits")).textContent).toContain("也不会改用固定模板");
    expect(h.seen.filter((item) => item.method === "POST")).toHaveLength(0);
  });

  it("asks before replacing scenes, then starts once with the token, key and replacement in the request", async () => {
    const h = harness(null, [json({ run: run({ state: "running", step: { state: "submitted", attemptNo: 1, errorCode: null }, output: null, plannedTotalSeconds: null, save: "pending", scenes: [] }) }, 201)]);
    panel(h, { sceneCount: 2 });
    fireEvent.change(await screen.findByLabelText("操作者令牌"), { target: { value: TOKEN } });
    const start = screen.getByRole("button", { name: "生成场景与分镜" });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("breakdown-blocked")).textContent).toContain("勾选“用新结果取代”");
    fireEvent.click(screen.getByRole("checkbox", { name: /用新结果取代这一集现有的场景/ }));
    fireEvent.click(screen.getByRole("button", { name: "生成场景与分镜" }));
    await screen.findByText(/状态：进行中/);
    const post = h.seen.find((item) => item.method === "POST")!;
    expect(post.url).toBe(`/api/v1/projects/${P1}/episodes/${E1}/script-breakdowns`);
    expect(post.body).toEqual({ replaceExisting: true, providerKey: "qwen", model: "q-1" });
    expect(post.headers["x-operator-token"]).toBe(TOKEN);
    expect(post.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("replays the same key after an unanswered start instead of creating a second task", async () => {
    const h = harness(null, [new TypeError("network down"), json({ run: run() }, 200)]);
    panel(h);
    fireEvent.change(await screen.findByLabelText("操作者令牌"), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: "生成场景与分镜" }));
    expect((await screen.findByRole("alert")).textContent).toContain("只会重放同一个请求");
    fireEvent.click(screen.getByRole("button", { name: "确认上次启动结果" }));
    await screen.findByText(/状态：已完成/);
    const keys = h.seen.filter((item) => item.method === "POST").map((item) => item.headers["idempotency-key"]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("shows scenes and shots with each field apart, the plan labelled as a plan, and opens a scene", async () => {
    const h = harness(run());
    panel(h);
    const scene = await screen.findByTestId("breakdown-scene-S1");
    expect((scene).textContent).toContain("场景描述：林夏发现监控被改。");
    expect((scene).textContent).toContain("镜头描述：缓慢推近监控屏幕");
    expect((scene).textContent).toContain("动作：林夏后退");
    expect((scene).textContent).toContain("林夏：这不是我。");
    expect((scene).textContent).toContain("预计 3 秒");
    expect((scene).textContent).toContain("角色：林夏");
    expect((scene).textContent).toContain("场景：待审核 · 镜头未写入");
    expect(screen.getByText(/预计合计 7 秒（计划，不是成片时长）；作品目标约 60 秒/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "打开场景（修改或审核）" }));
    expect(h.onOpenScene).toHaveBeenCalledWith(SCENE);
  });

  it("marks a result whose source script was replaced as needing regeneration, without starting anything", async () => {
    const h = harness(run({ episodeScript: { currentRevisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", currentRevisionNo: 4, approved: false },
      scenes: [{ ...run().scenes[0]!, current: { ...run().scenes[0]!.current, freshnessStatus: "STALE" } }] }));
    panel(h);
    expect((await screen.findByTestId("breakdown-outdated")).textContent).toContain("来源剧本已更新到第 4 版，下面的场景与分镜来自第 3 版，需要重新生成");
    expect((screen.getByTestId("breakdown-scene-S1")).textContent).toContain("已过期，需要重新生成");
    expect((screen.getByRole("button", { name: "写入已批准场景的镜头" }) as HTMLButtonElement).disabled).toBe(true);
    expect(h.seen.filter((item) => item.method === "POST")).toHaveLength(0);
  });

  it("explains a refused answer and writes approved scenes' shots on request", async () => {
    const failed = harness(run({ state: "failed", step: { state: "rejected", attemptNo: 1, errorCode: "dialogue_not_in_script" }, output: null, plannedTotalSeconds: null, save: "pending", scenes: [] }));
    panel(failed);
    expect(await screen.findByText(/对白或说话人在剧本里找不到/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "续跑（重新发送一次调用）" })).toBeTruthy();
    cleanup();

    const placed = run({ scenes: [{ ...run().scenes[0]!, shotSave: "saved" }] });
    const h = harness(run(), [json({ run: placed, placement: { placed: ["S1"], awaitingApproval: [], sceneChanged: [], charactersChanged: [], unavailable: [] } })]);
    panel(h);
    fireEvent.click(await screen.findByRole("button", { name: "写入已批准场景的镜头" }));
    expect(await screen.findByText("已写入：S1")).toBeTruthy();
    const post = h.seen.find((item) => item.method === "POST")!;
    expect([post.url, post.body]).toEqual([`/api/v1/projects/${P1}/episodes/${E1}/script-breakdowns/${RUN}/shots`, { acceptSceneChanged: false }]);
    await waitFor(() => expect(h.onChanged).toHaveBeenCalled());
  });

  it("names every refusal code in words and never shows a bare provider message", () => {
    for (const code of ["invalid_json", "invalid_output", "episode_mismatch", "duplicate_key", "missing_reference", "dialogue_not_in_script",
      "duration_out_of_range", "truncated", "breakdown_source_changed", "breakdown_conflict", "executor_lost"]) {
      expect(breakdownErrorText(code)).not.toContain(code);
    }
    expect(breakdownErrorText(null)).toBeNull();
  });

  it("rejects an unreadable options/snapshot response without allowing a new request", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: string) => {
      seen.push(input);
      if (input.endsWith("/latest")) return json({ run: { ...run(), episodeId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" } });
      return json({ items: [] });
    });
    const client = new ScriptBreakdownClient(fetchImpl as unknown as typeof fetch);
    render(<ScriptBreakdownPanel projectId={P1} episodeId={E1} episodeNo={2} scriptReady sceneCount={0} onOpenScene={vi.fn()}
      onChanged={vi.fn(async () => undefined)} client={client} />);
    expect((await screen.findByRole("alert")).textContent).toContain("拆解状态暂时无法读取");
    expect(screen.queryByTestId("breakdown-run")).toBeNull();
    expect((screen.getByRole("button", { name: "生成场景与分镜" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("planned seconds in the shot form", () => {
  it("accepts empty or a whole number of seconds from 1 to 15", () => {
    expect(plannedDurationOf("")).toEqual({ ok: true, ms: null });
    expect(plannedDurationOf(" 4 ")).toEqual({ ok: true, ms: 4000 });
    expect(plannedDurationOf("15")).toEqual({ ok: true, ms: 15000 });
    for (const bad of ["0", "16", "2.5", "-1", "abc"]) expect(plannedDurationOf(bad)).toEqual({ ok: false });
  });
});

describe("source validity and resume entry", () => {
  const SAME_SCRIPT = "88888888-8888-4888-8888-888888888888";
  const pendingStepRun = (overrides: Partial<ScriptBreakdownRunView> = {}) => run({ state: "failed", errorCode: "TITLE_WRITING_DAILY_CAP",
    step: { state: "pending", attemptNo: 0, errorCode: null }, output: null, plannedTotalSeconds: null, save: "pending", scenes: [], callsUsed: 0, ...overrides });
  const unknownCall = { callId: "99999999-aaaa-4aaa-aaaa-aaaaaaaaaaaa", stepKey: "breakdown", attemptNo: 1, state: "unknown", providerKey: "qwen", model: "q-1",
    outcome: null, rejectionCode: null, usage: null, billing: "unknown", createdAt: "2026-10-12T00:00:00Z" } as unknown as ScriptBreakdownRunView["calls"][number];
  const newResume = () => screen.queryByRole<HTMLButtonElement>("button", { name: "续跑（重新发送一次调用）" });

  it("treats the same script revision that went STALE or lost approval as an invalid source: says so plainly and disables shot writing", async () => {
    const h = harness(run({ episodeScript: { currentRevisionId: SAME_SCRIPT, currentRevisionNo: 3, approved: false } }));
    panel(h);
    const notice = (await screen.findByTestId("breakdown-outdated")).textContent!;
    expect(notice).toContain("第 3 版剧本已过期或不再是已批准版本");
    expect(notice).not.toContain("已更新到第 3 版");
    expect(screen.getByTestId("breakdown-run").textContent).toContain("来源：第 3 版剧本（已过期或未批准）");
    expect((screen.getByRole("button", { name: "写入已批准场景的镜头" }) as HTMLButtonElement).disabled).toBe(true);
    // The old result stays readable.
    expect(screen.getByTestId("breakdown-scene-S1").textContent).toContain("场景描述：林夏发现监控被改。");
    expect(h.seen.filter((item) => item.method === "POST")).toHaveLength(0);
  });

  it("offers a manual resume for a terminal run stopped before its call was reserved, without a billing confirmation, once per click", async () => {
    const h = harness(pendingStepRun(), [json({ run: run({ state: "running", step: { state: "pending", attemptNo: 0, errorCode: null }, output: null, save: "pending", scenes: [] }) })]);
    panel(h);
    fireEvent.change(await screen.findByLabelText("操作者令牌"), { target: { value: TOKEN } });
    expect(screen.queryByRole("checkbox", { name: /可能已经计费/ })).toBeNull();
    const button = newResume()!;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    fireEvent.click(button);
    await screen.findByText(/状态：进行中/);
    const posts = h.seen.filter((item) => item.method === "POST");
    expect(posts).toHaveLength(1);
    expect([posts[0]!.url, posts[0]!.body]).toEqual([`/api/v1/projects/${P1}/episodes/${E1}/script-breakdowns/${RUN}/resume`, { confirmUncertainCallIds: [] }]);
    expect(posts[0]!.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("offers the same resume for a needs-attention run whose provider was unconfigured before the call", async () => {
    panel(harness(pendingStepRun({ state: "needs_attention", errorCode: "provider_unconfigured" })));
    await screen.findByText(/状态：/);
    expect(newResume()).not.toBeNull();
  });

  it("still requires the billing confirmation for a truly unknown call", async () => {
    panel(harness(run({ state: "needs_attention", save: "pending", output: null, scenes: [], step: { state: "unknown", attemptNo: 1, errorCode: "executor_lost" }, calls: [unknownCall] })));
    fireEvent.change(await screen.findByLabelText("操作者令牌"), { target: { value: TOKEN } });
    expect(newResume()!.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /我知道上一次调用结果未知、可能已经计费/ }));
    expect(newResume()!.disabled).toBe(false);
  });

  it("offers no new resume while running, after completion, or once the source was replaced or went STALE", async () => {
    for (const shown of [
      run({ state: "running", step: { state: "pending", attemptNo: 0, errorCode: null }, output: null, save: "pending", scenes: [] }),
      run(),
      pendingStepRun({ episodeScript: { currentRevisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", currentRevisionNo: 4, approved: true } }),
      pendingStepRun({ episodeScript: { currentRevisionId: SAME_SCRIPT, currentRevisionNo: 3, approved: false } }),
      run({ state: "failed", step: { state: "rejected", attemptNo: 1, errorCode: "invalid_output" }, output: null, save: "pending", scenes: [],
        episodeScript: { currentRevisionId: SAME_SCRIPT, currentRevisionNo: 3, approved: false } }),
    ]) {
      const h = harness(shown);
      panel(h);
      await screen.findByText(/状态：/);
      expect(newResume()).toBeNull();
      expect(screen.queryByRole("button", { name: "确认上次续跑结果" })).toBeNull();
      cleanup();
    }
  });

  it("still lets a person confirm an already sent resume after the source changed", async () => {
    window.sessionStorage.setItem(`ads:breakdown:${P1}:${E1}:resume:v1`, JSON.stringify({ kind: "resume", runId: RUN, confirmed: [], key: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }));
    const h = harness(pendingStepRun({ episodeScript: { currentRevisionId: SAME_SCRIPT, currentRevisionNo: 3, approved: false } }),
      [json({ run: pendingStepRun({ state: "needs_attention", errorCode: "breakdown_source_changed" }) })]);
    panel(h);
    fireEvent.change(await screen.findByLabelText("操作者令牌"), { target: { value: TOKEN } });
    expect(newResume()).toBeNull();
    const confirm = screen.getByRole("button", { name: "确认上次续跑结果" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(h.seen.filter((item) => item.method === "POST")).toHaveLength(1));
    expect(h.seen.find((item) => item.method === "POST")!.headers["idempotency-key"]).toBe("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  });
});
