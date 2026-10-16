// @vitest-environment happy-dom
// Simulated interface tests. fetch is mocked; this file does not start a browser, the API or a model.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

function harness(latest: ScriptBreakdownRunView | null, answers: Array<Response | Error> = [], options: ScriptBreakdownOptionsView = OPTIONS) {
  const seen: Seen[] = [];
  const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
    const headers = Object.fromEntries([...new Headers(init?.headers).entries()].map(([name, value]) => [name.toLowerCase(), value]));
    seen.push({ method: init?.method ?? "GET", url: input, headers, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (input.endsWith("/writing/script-breakdowns/options")) return json(options);
    if (input.endsWith("/latest-saved")) return json({ run: null });
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

  it("says only script breakdown is off when the server reports it disabled, and cannot start", async () => {
    const h = harness(null, [], { ...OPTIONS, enabled: false, code: "TITLE_WRITING_DISABLED" });
    panel(h);
    const blocked = await screen.findByTestId("breakdown-blocked");
    await waitFor(() => expect(blocked.textContent).toContain("剧本拆解尚未开启。"));
    expect(blocked.textContent).not.toContain("AI 写作");
    expect((screen.getByRole("button", { name: "生成场景与分镜" }) as HTMLButtonElement).disabled).toBe(true);
    expect(h.seen.filter((item) => item.method === "POST")).toHaveLength(0);
  });

  it("explains a run stopped because breakdown was switched off on the server", async () => {
    panel(harness(run({ state: "needs_attention", errorCode: "run_kind_disabled", step: { state: "pending", attemptNo: 0, errorCode: null },
      output: null, save: "pending", scenes: [], callsUsed: 0 })));
    expect(await screen.findByText(/剧本拆解已在服务端关闭，任务已停止，没有发出新的调用/)).toBeTruthy();
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
      "duration_out_of_range", "truncated", "breakdown_source_changed", "breakdown_conflict", "executor_lost", "run_kind_disabled"]) {
      expect(breakdownErrorText(code)).not.toContain(code);
    }
    expect(breakdownErrorText(null)).toBeNull();
  });

  it("rejects an unreadable options/snapshot response without allowing a new request", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: string) => {
      seen.push(input);
      if (input.endsWith("/latest-saved")) return json({ run: null });
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

describe("start identity: confirming a sent start, reading settings again, releasing a refused start", () => {
  const E2 = "33333333-3333-4333-8333-333333333334";
  const OLD_KEY = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const E2_KEY = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const storageKey = (episodeId = E1) => `ads:breakdown:${P1}:${episodeId}:start:v1`;
  const stored = (episodeId = E1) => {
    const raw = window.sessionStorage.getItem(storageKey(episodeId));
    return raw ? JSON.parse(raw) as { kind: string; key: string; body: unknown } : null;
  };
  const restore = (body: Record<string, unknown>, key = OLD_KEY, episodeId = E1) =>
    window.sessionStorage.setItem(storageKey(episodeId), JSON.stringify({ kind: "start", key, body }));
  const UNCONFIGURED: ScriptBreakdownOptionsView = { ...OPTIONS, code: "TITLE_WRITING_PROVIDER_UNCONFIGURED", defaultProvider: null,
    providers: [{ providerKey: "qwen", label: "千问", ready: false, models: [], defaultModel: null, missing: ["DASHSCOPE_API_KEY"] }] };
  const existing = () => json({ error: { code: "SCRIPT_BREAKDOWN_EXISTING_SCENES", message: "这一集已经有场景。确认用新结果取代后才能拆解（旧版本会保留）。",
    details: { sceneCount: 2, shotCount: 0 } } }, 409);
  const started = () => json({ run: run({ state: "running", step: { state: "submitted", attemptNo: 1, errorCode: null }, output: null,
    plannedTotalSeconds: null, save: "pending", scenes: [] }) }, 201);
  function held<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }

  /** A scripted server: options answers in order (the last repeats), POST answers in order; every request is recorded. */
  function server(optionAnswers: Array<() => Response | Promise<Response>>, posts: Array<() => Response | Promise<Response>>) {
    const seen: Seen[] = [];
    let optionCalls = 0;
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
      const headers = Object.fromEntries([...new Headers(init?.headers).entries()].map(([name, value]) => [name.toLowerCase(), value]));
      seen.push({ method: init?.method ?? "GET", url: input, headers, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (input.endsWith("/writing/script-breakdowns/options")) {
        optionCalls += 1;
        return optionAnswers[Math.min(optionCalls, optionAnswers.length) - 1]!();
      }
      if (input.endsWith("/latest-saved")) return json({ run: null });
      if (input.endsWith("/latest")) return json({ run: null });
      const next = posts.shift();
      if (!next) throw new Error(`unexpected ${input}`);
      return next();
    });
    return {
      seen,
      client: new ScriptBreakdownClient(fetchImpl as unknown as typeof fetch),
      posts: () => seen.filter((item) => item.method === "POST"),
      optionReads: () => seen.filter((item) => item.url.endsWith("/options")).length,
    };
  }
  const panelFor = (client: ScriptBreakdownClient, episodeId = E1) => (
    <ScriptBreakdownPanel projectId={P1} episodeId={episodeId} episodeNo={episodeId === E1 ? 2 : 3} scriptReady sceneCount={0}
      onOpenScene={vi.fn()} onChanged={vi.fn(async () => undefined)} client={client} />
  );
  const enterToken = async () => fireEvent.change(await screen.findByLabelText("操作者令牌"), { target: { value: TOKEN } });
  const button = (name: string) => screen.getByRole<HTMLButtonElement>("button", { name });

  it("confirms a restored start with its own key and body although its provider is no longer configured", async () => {
    const body = { replaceExisting: false, providerKey: "deepseek", model: "d-1" };
    restore(body);
    const s = server([() => json(UNCONFIGURED)], [() => json({ run: run() }, 200)]);
    render(panelFor(s.client));
    await enterToken();
    await waitFor(() => expect(s.optionReads()).toBe(1));
    expect(screen.getByTestId("breakdown-pending-start").textContent).toContain("确认只会重放上次的同一个请求");
    const confirm = button("确认上次启动结果");
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await screen.findByText(/状态：已完成/);
    expect(s.posts()).toHaveLength(1);
    expect([s.posts()[0]!.headers["idempotency-key"], s.posts()[0]!.body, s.posts()[0]!.headers["x-operator-token"]]).toEqual([OLD_KEY, body, TOKEN]);
    expect(stored()).toBeNull();
  });

  it("lets a restored start be confirmed while the settings cannot be read, but never starts a new request without them", async () => {
    restore({ replaceExisting: false, providerKey: "qwen", model: "q-1" });
    const s = server([() => new Response("down", { status: 502 })], [() => json({ run: run() }, 200)]);
    render(panelFor(s.client));
    await enterToken();
    expect((await screen.findByTestId("breakdown-options-error")).textContent).toContain("功能配置暂时无法读取");
    fireEvent.click(button("确认上次启动结果"));
    await screen.findByText(/状态：已完成/);
    expect(s.posts().map((item) => item.headers["idempotency-key"])).toEqual([OLD_KEY]);
    cleanup();

    const fresh = server([() => new Response("down", { status: 502 })], []);
    render(panelFor(fresh.client));
    await enterToken();
    await screen.findByTestId("breakdown-options-error");
    expect(button("生成场景与分镜").disabled).toBe(true);
    expect(screen.getByTestId("breakdown-blocked").textContent).toContain("功能配置读取失败");
    fireEvent.click(button("生成场景与分镜"));
    expect(fresh.posts()).toHaveLength(0);
    expect(stored()).toBeNull();
  });

  it("reads the settings again on request, once at a time, without a reload, a task or a model call", async () => {
    const second = held<Response>();
    const s = server([() => new Response("down", { status: 503 }), () => second.promise], []);
    render(panelFor(s.client));
    await enterToken();
    const retry = await screen.findByRole<HTMLButtonElement>("button", { name: "重新读取功能配置" });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(s.optionReads()).toBe(2);
    expect(button("重新读取功能配置").disabled).toBe(true);
    second.resolve(json(OPTIONS));
    await waitFor(() => expect(screen.queryByTestId("breakdown-options-error")).toBeNull());
    expect(button("生成场景与分镜").disabled).toBe(false);
    expect((screen.getByLabelText("操作者令牌") as HTMLInputElement).value).toBe(TOKEN);
    expect(s.posts()).toHaveLength(0);
    expect(s.optionReads()).toBe(2);
  });

  for (const origin of ["sent from this page", "restored after a reload"] as const) {
    it(`releases a start ${origin} once the server refuses it for existing scenes, and asks for consent before a new key`, async () => {
      if (origin === "restored after a reload") restore({ replaceExisting: false, providerKey: "qwen", model: "q-1" });
      const s = server([() => json(OPTIONS)], [existing, started]);
      render(panelFor(s.client));
      await enterToken();
      await waitFor(() => expect(s.optionReads()).toBe(1));
      fireEvent.click(button(origin === "restored after a reload" ? "确认上次启动结果" : "生成场景与分镜"));
      expect((await screen.findByRole("alert")).textContent).toContain("这一集已经有场景");
      const firstKey = s.posts()[0]!.headers["idempotency-key"]!;
      if (origin === "restored after a reload") expect(firstKey).toBe(OLD_KEY);
      expect(stored()).toBeNull();
      // The parent's scene count was stale (0): the refusal itself shows the consent box, unchecked.
      const consent = screen.getByRole<HTMLInputElement>("checkbox", { name: /用新结果取代这一集现有的场景/ });
      expect([consent.checked, consent.disabled]).toEqual([false, false]);
      expect(button("生成场景与分镜").disabled).toBe(true);
      fireEvent.click(button("生成场景与分镜"));
      expect(s.posts()).toHaveLength(1);
      fireEvent.click(consent);
      fireEvent.click(button("生成场景与分镜"));
      await screen.findByText(/状态：进行中/);
      const second = s.posts()[1]!;
      expect(second.headers["idempotency-key"]).not.toBe(firstKey);
      expect(second.body).toEqual({ replaceExisting: true, providerKey: "qwen", model: "q-1" });
      expect(s.posts()).toHaveLength(2);
      expect(stored()).toBeNull();
    });
  }

  it("keeps a restored start's identity through a lost answer, a gateway error, a 5xx and a non-definitive refusal, sending once per click", async () => {
    const body = { replaceExisting: false, providerKey: "qwen", model: "q-1" };
    restore(body);
    const slow = held<Response>();
    const s = server([() => json(OPTIONS)], [
      () => Promise.reject(new TypeError("network down")),
      () => new Response("gateway", { status: 504 }),
      () => json({ error: { code: "INTERNAL", message: "boom" } }, 500),
      () => json({ error: { code: "TITLE_WRITING_RUN_ACTIVE", message: "busy" } }, 409),
      () => slow.promise,
    ]);
    render(panelFor(s.client));
    await enterToken();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await waitFor(() => expect(button("确认上次启动结果").disabled).toBe(false));
      fireEvent.click(button("确认上次启动结果"));
      await waitFor(() => expect(s.posts()).toHaveLength(attempt));
      await screen.findByRole("alert");
      expect(stored()).toEqual({ kind: "start", key: OLD_KEY, body });
    }
    await waitFor(() => expect(button("确认上次启动结果").disabled).toBe(false));
    fireEvent.click(button("确认上次启动结果"));
    fireEvent.click(button("确认上次启动结果"));
    expect(s.posts()).toHaveLength(5);
    slow.resolve(json({ run: run() }, 200));
    await screen.findByText(/状态：已完成/);
    expect(new Set(s.posts().map((item) => item.headers["idempotency-key"]))).toEqual(new Set([OLD_KEY]));
    expect(s.posts().every((item) => JSON.stringify(item.body) === JSON.stringify(body))).toBe(true);
    expect(stored()).toBeNull();
  });

  it("does not let a late refusal for another episode or an unmounted panel release a newer identity", async () => {
    const late = held<Response>();
    const s = server([() => json(OPTIONS)], [() => late.promise]);
    const mounted = render(panelFor(s.client));
    await enterToken();
    await waitFor(() => expect(s.optionReads()).toBe(1));
    fireEvent.click(button("生成场景与分镜"));
    await waitFor(() => expect(s.posts()).toHaveLength(1));
    const e1Key = stored()!.key;
    // Episode 2 holds its own restored start; the panel switches to it before episode 1's answer arrives.
    restore({ replaceExisting: true, providerKey: "qwen", model: "q-1" }, E2_KEY, E2);
    mounted.rerender(panelFor(s.client, E2));
    expect(await screen.findByRole("button", { name: "确认上次启动结果" })).toBeTruthy();
    late.resolve(existing());
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The answer belongs to no current request: nothing is released, and episode 2 is untouched.
    expect(stored(E2)).toEqual({ kind: "start", key: E2_KEY, body: { replaceExisting: true, providerKey: "qwen", model: "q-1" } });
    expect(stored(E1)?.key).toBe(e1Key);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "确认上次启动结果" })).toBeTruthy();
    mounted.unmount();
    expect(stored(E2)?.key).toBe(E2_KEY);
  });
});

describe("saving an answer that a cancel left unsaved", () => {
  const completedCall = { callId: "99999999-bbbb-4bbb-8bbb-bbbbbbbbbbbb", stepKey: "breakdown", attemptNo: 1, state: "completed", providerKey: "qwen",
    model: "q-1", outcome: null, rejectionCode: null, usage: null, billing: "unknown", createdAt: "2026-10-12T00:00:00Z" } as unknown as ScriptBreakdownRunView["calls"][number];
  const unsaved = (overrides: Partial<ScriptBreakdownRunView> = {}) => run({ state: "canceled", save: "pending", scenes: [],
    step: { state: "completed", attemptNo: 1, errorCode: null }, calls: [completedCall], ...overrides });
  const saveButton = () => screen.queryByRole<HTMLButtonElement>("button", { name: "保存已有结果（不再调用模型）" });

  it("offers to save the stored answer without a billing confirmation or a resend, once per click", async () => {
    const h = harness(unsaved(), [json({ run: run({ state: "running", save: "pending", scenes: [], step: { state: "completed", attemptNo: 1, errorCode: null } }) })]);
    panel(h);
    fireEvent.change(await screen.findByLabelText("操作者令牌"), { target: { value: TOKEN } });
    expect(screen.getByTestId("breakdown-save-only").textContent).toContain("不会再次调用模型");
    expect(screen.queryByRole("checkbox", { name: /可能已经计费/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "续跑（重新发送一次调用）" })).toBeNull();
    const save = saveButton()!;
    fireEvent.click(save);
    fireEvent.click(save);
    await screen.findByText(/状态：进行中/);
    const posts = h.seen.filter((item) => item.method === "POST");
    expect(posts).toHaveLength(1);
    expect([posts[0]!.url, posts[0]!.body]).toEqual([`/api/v1/projects/${P1}/episodes/${E1}/script-breakdowns/${RUN}/resume`, { confirmUncertainCallIds: [] }]);
  });

  it("offers no save once the source is no longer valid, after saving, or while running", async () => {
    for (const shown of [
      unsaved({ episodeScript: { currentRevisionId: "88888888-8888-4888-8888-888888888888", currentRevisionNo: 3, approved: false } }),
      unsaved({ episodeScript: { currentRevisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", currentRevisionNo: 4, approved: true } }),
      unsaved({ save: "source_changed" }),
      unsaved({ state: "completed", save: "saved" }),
      unsaved({ state: "running" }),
    ]) {
      panel(harness(shown));
      await screen.findByText(/状态：/);
      expect(saveButton()).toBeNull();
      expect(screen.queryByRole("button", { name: "续跑（重新发送一次调用）" })).toBeNull();
      cleanup();
    }
  });
});

describe("follow-up refresh and restored resume identities", () => {
  const OLD_CALL = "99999999-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const NEW_CALL = "99999999-cccc-4ccc-8ccc-cccccccccccc";
  const RESUME_KEY = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const resumeStorage = `ads:breakdown:${P1}:${E1}:resume:v1`;
  const unknownCall = (callId: string, attemptNo: number) => ({ callId, stepKey: "breakdown", attemptNo, state: "unknown", providerKey: "qwen", model: "q-1",
    outcome: null, rejectionCode: null, usage: null, billing: "unknown", createdAt: "2026-10-12T00:00:00Z" }) as unknown as ScriptBreakdownRunView["calls"][number];
  const uncertain = (callId: string, attemptNo: number) => run({ state: "needs_attention", save: "pending", output: null, scenes: [],
    step: { state: "unknown", attemptNo, errorCode: "executor_lost" }, calls: [unknownCall(callId, attemptNo)] });

  it("reports an accepted shot write as done when only the following page refresh fails", async () => {
    const placed = run({ scenes: [{ ...run().scenes[0]!, shotSave: "saved" }] });
    const h = harness(run(), [json({ run: placed, placement: { placed: ["S1"], awaitingApproval: [], sceneChanged: [], charactersChanged: [], unavailable: [] } })]);
    h.onChanged.mockRejectedValueOnce(new Error("scene list unavailable"));
    panel(h);
    fireEvent.click(await screen.findByRole("button", { name: "写入已批准场景的镜头" }));
    expect(await screen.findByText("已写入：S1")).toBeTruthy();
    const alert = (await screen.findByRole("alert")).textContent ?? "";
    expect(alert).toContain("已完成");
    expect(alert).toContain("刷新");
    expect(alert).not.toContain("写入镜头失败");
    expect(h.seen.filter((item) => item.method === "POST")).toHaveLength(1);
  });

  it("releases a restored resume refused for a stale confirmation, reads the run again and confirms the current call with a new key", async () => {
    window.sessionStorage.setItem(resumeStorage, JSON.stringify({ kind: "resume", runId: RUN, confirmed: [OLD_CALL], key: RESUME_KEY }));
    let latest = uncertain(OLD_CALL, 1);
    const posts: Seen[] = [];
    const answers = [
      () => { latest = uncertain(NEW_CALL, 2); return json({ error: { code: "TITLE_WRITING_CONFIRMATION_STALE", message: "确认的不确定调用和现在的不一致。" } }, 409); },
      () => json({ run: run({ state: "running", save: "pending", output: null, scenes: [], step: { state: "pending", attemptNo: 2, errorCode: null } }) }),
    ];
    const client = new ScriptBreakdownClient((async (input: string, init?: RequestInit) => {
      if (input.endsWith("/options")) return json(OPTIONS);
      if (input.endsWith("/latest-saved")) return json({ run: null });
      if (input.endsWith("/latest")) return json({ run: latest });
      const headers = Object.fromEntries([...new Headers(init?.headers).entries()].map(([name, value]) => [name.toLowerCase(), value]));
      posts.push({ method: "POST", url: input, headers, body: JSON.parse(String(init?.body)) });
      return answers.shift()!();
    }) as unknown as typeof fetch);
    render(<ScriptBreakdownPanel projectId={P1} episodeId={E1} episodeNo={2} scriptReady sceneCount={0} onOpenScene={vi.fn()}
      onChanged={vi.fn(async () => undefined)} client={client} />);
    fireEvent.change(await screen.findByLabelText("操作者令牌"), { target: { value: TOKEN } });
    fireEvent.click(await screen.findByRole("button", { name: "确认上次续跑结果" }));
    await waitFor(() => expect(window.sessionStorage.getItem(resumeStorage)).toBeNull());
    // The run is read again: the current unknown call needs its own confirmation, under a new key.
    const confirm = await screen.findByRole<HTMLInputElement>("checkbox", { name: /我知道上一次调用结果未知/ });
    expect(confirm.checked).toBe(false);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "续跑（重新发送一次调用）" }).disabled).toBe(true);
    fireEvent.click(confirm);
    fireEvent.click(screen.getByRole("button", { name: "续跑（重新发送一次调用）" }));
    await screen.findByText(/状态：进行中/);
    expect(posts.map((item) => [item.headers["idempotency-key"] === RESUME_KEY, item.body])).toEqual([
      [true, { confirmUncertainCallIds: [OLD_CALL] }], [false, { confirmUncertainCallIds: [NEW_CALL] }]]);
  });

  it("keeps a restored resume identity through a lost answer, a 5xx, a busy run and a refused token", async () => {
    window.sessionStorage.setItem(resumeStorage, JSON.stringify({ kind: "resume", runId: RUN, confirmed: [OLD_CALL], key: RESUME_KEY }));
    const h = harness(uncertain(OLD_CALL, 1), [new TypeError("network down"), json({ error: { code: "INTERNAL", message: "x" } }, 502),
      json({ error: { code: "TITLE_WRITING_RUN_ACTIVE", message: "busy" } }, 409), json({ error: { code: "TITLE_WRITING_FORBIDDEN", message: "token" } }, 403)]);
    panel(h);
    fireEvent.change(await screen.findByLabelText("操作者令牌"), { target: { value: TOKEN } });
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "确认上次续跑结果" }).disabled).toBe(false));
      fireEvent.click(screen.getByRole("button", { name: "确认上次续跑结果" }));
      await waitFor(() => expect(h.seen.filter((item) => item.method === "POST")).toHaveLength(attempt));
      await screen.findByRole("alert");
      expect(JSON.parse(window.sessionStorage.getItem(resumeStorage)!)).toMatchObject({ key: RESUME_KEY, confirmed: [OLD_CALL] });
    }
    expect(new Set(h.seen.filter((item) => item.method === "POST").map((item) => item.headers["idempotency-key"]))).toEqual(new Set([RESUME_KEY]));
  });

  it("releases a restored resume only after its receipt lookup definitively refuses a changed scene snapshot", async () => {
    const pending = { kind: "resume", runId: RUN, confirmed: [OLD_CALL], key: RESUME_KEY };
    window.sessionStorage.setItem(resumeStorage, JSON.stringify(pending));
    const h = harness(uncertain(OLD_CALL, 1), [json({ error: { code: "SCRIPT_BREAKDOWN_CONFLICT",
      message: "这一集的场景或镜头已改变，不能续跑原任务，请重新生成。" } }, 409)]);
    panel(h);
    fireEvent.change(await screen.findByLabelText("操作者令牌"), { target: { value: TOKEN } });
    const reads = h.seen.filter((item) => item.url.endsWith("/latest")).length;
    fireEvent.click(await screen.findByRole("button", { name: "确认上次续跑结果" }));
    await waitFor(() => expect(window.sessionStorage.getItem(resumeStorage)).toBeNull());
    await waitFor(() => expect(h.seen.filter((item) => item.url.endsWith("/latest")).length).toBeGreaterThan(reads));
    expect(screen.queryByRole("button", { name: "确认上次续跑结果" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("请重新生成");
    const posts = h.seen.filter((item) => item.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.headers["idempotency-key"]).toBe(RESUME_KEY);
    expect(posts[0]!.body).toEqual({ confirmUncertainCallIds: [OLD_CALL] });
  });
});

describe("a resume identity left for an earlier run after a newer run appeared", () => {
  const RUN_B = "66666666-6666-4666-8666-6666666666bb";
  const E2 = "33333333-3333-4333-8333-333333333334";
  const KEY_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const KEY_E2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const storage = (episodeId = E1) => `ads:breakdown:${P1}:${episodeId}:resume:v1`;
  const stored = (episodeId = E1) => {
    const raw = window.sessionStorage.getItem(storage(episodeId));
    return raw ? JSON.parse(raw) as { kind: string; runId: string; key: string; confirmed: string[] } : null;
  };
  const restore = (runId = RUN, key = KEY_A, episodeId = E1) =>
    window.sessionStorage.setItem(storage(episodeId), JSON.stringify({ kind: "resume", runId, confirmed: [], key }));
  /** Run A stopped before its call was reserved: a new resume is offered without a billing question. */
  const stoppedA = () => run({ state: "failed", errorCode: "TITLE_WRITING_DAILY_CAP", step: { state: "pending", attemptNo: 0, errorCode: null },
    output: null, plannedTotalSeconds: null, save: "pending", scenes: [], callsUsed: 0 });
  const runB = (overrides: Partial<ScriptBreakdownRunView> = {}) => run({ runId: RUN_B, model: "q-B", ...overrides });
  const stoppedB = () => runB({ state: "failed", errorCode: "TITLE_WRITING_DAILY_CAP", step: { state: "pending", attemptNo: 0, errorCode: null },
    output: null, plannedTotalSeconds: null, save: "pending", scenes: [], callsUsed: 0 });
  const resumedA = () => json({ run: run({ state: "completed", model: "q-A" }) });
  function held<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }
  /** `latest` answers from a switchable source (a run, null or a failure); POSTs answer in order and are recorded. */
  function server(answers: Array<() => Response | Promise<Response>>) {
    const seen: Seen[] = [];
    const state = { latest: (): Response => json({ run: null }) };
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
      const headers = Object.fromEntries([...new Headers(init?.headers).entries()].map(([name, value]) => [name.toLowerCase(), value]));
      seen.push({ method: init?.method ?? "GET", url: input, headers, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (input.endsWith("/writing/script-breakdowns/options")) return json(OPTIONS);
      if (input.endsWith("/latest-saved")) return json({ run: null });
      if (input.endsWith("/latest")) return state.latest();
      const next = answers.shift();
      if (!next) throw new Error(`unexpected ${input}`);
      return await next();
    });
    return {
      seen, state,
      client: new ScriptBreakdownClient(fetchImpl as unknown as typeof fetch),
      posts: () => seen.filter((item) => item.method === "POST"),
      reads: () => seen.filter((item) => item.url.endsWith("/latest")).length,
      show: (next: ScriptBreakdownRunView | null) => { state.latest = () => json({ run: next }); },
    };
  }
  const panelFor = (s: ReturnType<typeof server>, epoch = 0, episodeId = E1) => (
    <ScriptBreakdownPanel projectId={P1} episodeId={episodeId} episodeNo={episodeId === E1 ? 2 : 3} scriptReady sceneCount={0}
      onOpenScene={vi.fn()} onChanged={vi.fn(async () => undefined)} client={s.client} refreshEpoch={epoch} />
  );
  const enterToken = async () => fireEvent.change(await screen.findByLabelText("操作者令牌"), { target: { value: TOKEN } });
  const confirmA = () => screen.queryByRole<HTMLButtonElement>("button", { name: "确认上次续跑结果" });
  const newResume = () => screen.queryByRole<HTMLButtonElement>("button", { name: "续跑（重新发送一次调用）" });
  const resumeOf = (item: Seen) => [item.url, item.headers["idempotency-key"], item.body];
  const sentA = [`/api/v1/projects/${P1}/episodes/${E1}/script-breakdowns/${RUN}/resume`, KEY_A, { confirmUncertainCallIds: [] }];

  it("keeps the confirmation of a lost resume after the latest run became another one, and replays A's own key and body", async () => {
    const s = server([() => { throw new TypeError("network down"); }, resumedA]);
    s.show(stoppedA());
    const view = render(panelFor(s));
    await enterToken();
    fireEvent.click(newResume()!);
    await screen.findByRole("alert");
    const sent = stored()!;
    expect(sent.runId).toBe(RUN);
    // Another tab started run B; this page reads the episode again.
    s.show(runB());
    view.rerender(panelFor(s, 1));
    await screen.findByText(/模型 q-B/);
    expect(screen.getByTestId("breakdown-pending-resume").textContent).toContain("不是下面显示的任务");
    fireEvent.click(confirmA()!);
    await waitFor(() => expect(s.posts()).toHaveLength(2));
    expect(resumeOf(s.posts()[1]!)).toEqual([sentA[0], sent.key, { confirmUncertainCallIds: [] }]);
    expect(s.posts()[0]!.headers["idempotency-key"]).toBe(sent.key);
  });

  it("offers a restored identity of run A while the latest run is B, none, or cannot be read", async () => {
    for (const latest of [() => json({ run: runB() }), () => json({ run: null }), () => json({ error: { code: "INTERNAL", message: "x" } }, 500)]) {
      restore();
      const s = server([resumedA]);
      s.state.latest = latest;
      render(panelFor(s));
      await enterToken();
      await waitFor(() => expect(confirmA()?.disabled).toBe(false));
      fireEvent.click(confirmA()!);
      await waitFor(() => expect(stored()).toBeNull());
      expect(s.posts().map(resumeOf)).toEqual([sentA]);
      cleanup();
      window.sessionStorage.clear();
    }
  });

  it("blocks a new resume of B and a new start until A is confirmed, so A's identity is never overwritten", async () => {
    restore();
    const s = server([]);
    s.show(stoppedB());
    render(panelFor(s));
    await enterToken();
    await screen.findByText(/模型 q-B/);
    expect(newResume()).toBeNull();
    expect(screen.getByTestId("breakdown-resume-blocked").textContent).toContain("请先确认上次续跑结果");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "重新生成场景与分镜" }).disabled).toBe(true);
    expect(screen.getByTestId("breakdown-blocked").textContent).toContain("请先确认上次续跑结果");
    fireEvent.click(screen.getByRole("button", { name: "重新生成场景与分镜" }));
    expect(s.posts()).toHaveLength(0);
    expect(stored()).toEqual({ kind: "resume", runId: RUN, confirmed: [], key: KEY_A });
    expect(confirmA()!.disabled).toBe(false);
  });

  it("settles A's confirmation while the latest run turned into B, sends once on a double click, then shows and polls B", async () => {
    restore();
    const answer = held<Response>();
    const s = server([() => answer.promise]);
    s.show(stoppedA());
    const view = render(panelFor(s));
    await enterToken();
    await waitFor(() => expect(confirmA()?.disabled).toBe(false));
    fireEvent.click(confirmA()!);
    fireEvent.click(confirmA()!);
    await waitFor(() => expect(s.posts()).toHaveLength(1));
    // While A's answer is in flight, the page reads B.
    s.show(runB({ state: "running", step: { state: "submitted", attemptNo: 1, errorCode: null }, output: null, save: "pending", scenes: [] }));
    view.rerender(panelFor(s, 1));
    await screen.findByText(/模型 q-B/);
    answer.resolve(resumedA());
    await waitFor(() => expect(stored()).toBeNull());
    await waitFor(() => expect(confirmA()).toBeNull());
    // A's answer is not shown over B; B stays shown and is polled.
    expect(screen.getByTestId("breakdown-run").textContent).toContain("模型 q-B");
    expect(screen.queryByText(/模型 q-A/)).toBeNull();
    expect(screen.getByText(/状态：进行中/)).toBeTruthy();
    const reads = s.reads();
    await waitFor(() => expect(s.reads()).toBeGreaterThan(reads), { timeout: 3_000 });
    expect(screen.getByTestId("breakdown-run").textContent).toContain("模型 q-B");
    expect(s.posts()).toHaveLength(1);
  });

  it("keeps A's identity through a lost answer, a 5xx and a refused token, and a success clears only the matching identity", async () => {
    restore();
    const last = held<Response>();
    const s = server([() => { throw new TypeError("network down"); }, () => json({ error: { code: "INTERNAL", message: "x" } }, 502),
      () => json({ error: { code: "TITLE_WRITING_FORBIDDEN", message: "token" } }, 403), () => last.promise]);
    s.show(runB());
    render(panelFor(s));
    await enterToken();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await waitFor(() => expect(confirmA()?.disabled).toBe(false));
      fireEvent.click(confirmA()!);
      await waitFor(() => expect(s.posts()).toHaveLength(attempt));
      await screen.findByRole("alert");
      expect(stored()).toEqual({ kind: "resume", runId: RUN, confirmed: [], key: KEY_A });
    }
    await waitFor(() => expect(confirmA()?.disabled).toBe(false));
    fireEvent.click(confirmA()!);
    await waitFor(() => expect(s.posts()).toHaveLength(4));
    // Another identity took the slot meanwhile (as a late write would): A's receipt must not remove it.
    restore(RUN_B, KEY_E2);
    last.resolve(resumedA());
    await waitFor(() => expect(screen.queryByTestId("breakdown-pending-resume")).toBeNull());
    expect(stored()?.key).toBe(KEY_E2);
    expect(new Set(s.posts().map((item) => item.headers["idempotency-key"]))).toEqual(new Set([KEY_A]));
  });

  it("keeps protecting A's identity when the browser cannot clear it after a confirmed answer", async () => {
    restore();
    const s = server([resumedA]);
    s.show(runB());
    render(panelFor(s));
    await enterToken();
    await waitFor(() => expect(confirmA()?.disabled).toBe(false));
    const remove = vi.spyOn(window.sessionStorage, "removeItem").mockImplementation(() => { throw new Error("storage blocked"); });
    try {
      fireEvent.click(confirmA()!);
      expect((await screen.findByRole("alert")).textContent).toContain("浏览器未能更新请求身份");
    } finally { remove.mockRestore(); }
    expect(stored()?.key).toBe(KEY_A);
    expect(screen.getByTestId("breakdown-pending-resume")).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "重新生成场景与分镜" }).disabled).toBe(true);
  });

  it("does not let A's late answer change another episode's page or identity, or an unmounted panel", async () => {
    restore();
    restore(RUN_B, KEY_E2, E2);
    const answer = held<Response>();
    const s = server([() => answer.promise]);
    s.show(runB());
    const view = render(panelFor(s));
    await enterToken();
    await waitFor(() => expect(confirmA()?.disabled).toBe(false));
    fireEvent.click(confirmA()!);
    await waitFor(() => expect(s.posts()).toHaveLength(1));
    s.show(null);
    view.rerender(panelFor(s, 0, E2));
    await waitFor(() => expect(screen.getByRole("heading", { level: 2 }).id).toBe(`breakdown-${E2}`));
    expect(await screen.findByTestId("breakdown-pending-resume")).toBeTruthy();
    answer.resolve(resumedA());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stored(E2)).toEqual({ kind: "resume", runId: RUN_B, confirmed: [], key: KEY_E2 });
    expect(stored(E1)?.key).toBe(KEY_A);
    expect(screen.getByTestId("breakdown-pending-resume")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    view.unmount();
    expect(stored(E2)?.key).toBe(KEY_E2);
  });
});

describe("the latest saved breakdown stays reachable while a newer run has not saved", () => {
  const RUN_B = "66666666-6666-4666-8666-6666666666bb";
  const SCENE_B = "77777777-7777-4777-8777-7777777777bb";
  const E2 = "33333333-3333-4333-8333-333333333334";
  const REVISION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const PLACED = { placed: ["S1"], awaitingApproval: [], sceneChanged: [], charactersChanged: [], unavailable: [] };
  const approvedScene = (sceneId = SCENE, shotSave: "pending" | "saved" = "pending") => [{ key: "S1", ordinal: 1, sceneId, sceneRevisionId: REVISION,
    shotSave, placedSceneRevisionId: null, current: { archived: false, currentRevisionId: REVISION, approvedRevisionId: REVISION, reviewStatus: "APPROVED", freshnessStatus: "CURRENT" } }];
  const savedA = (overrides: Partial<ScriptBreakdownRunView> = {}) => run({ model: "q-A", scenes: approvedScene(), ...overrides });
  const placedA = () => savedA({ scenes: approvedScene(SCENE, "saved") });
  const savedB = () => run({ runId: RUN_B, model: "q-B", scenes: approvedScene(SCENE_B) });
  const unsaved = (overrides: Partial<ScriptBreakdownRunView>) => run({ runId: RUN_B, model: "q-B", output: null, plannedTotalSeconds: null, save: "pending", scenes: [], ...overrides });
  const NOT_SAVED: Array<[string, () => ScriptBreakdownRunView]> = [
    ["failed (its output was refused)", () => unsaved({ state: "failed", step: { state: "rejected", attemptNo: 1, errorCode: "invalid_output" } })],
    ["canceled", () => unsaved({ state: "canceled", errorCode: "canceled_before_send", step: { state: "canceled", attemptNo: 0, errorCode: null } })],
    ["stopped with a result that could not be saved", () => unsaved({ state: "needs_attention", errorCode: "breakdown_conflict", save: "conflict",
      output: run().output, plannedTotalSeconds: 7 })],
    ["still running", () => unsaved({ state: "running", step: { state: "submitted", attemptNo: 1, errorCode: null } })],
  ];
  function held<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }
  type Answer = (url: string) => Response | Promise<Response>;
  /** Reads answer from switchable sources per URL; POSTs answer in order. Every request is recorded. */
  function server() {
    const seen: Seen[] = [];
    const state: { latest: Answer; saved: Answer; posts: Array<() => Response | Promise<Response>> } = {
      latest: () => json({ run: null }), saved: () => json({ run: null }), posts: [] };
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
      const headers = Object.fromEntries([...new Headers(init?.headers).entries()].map(([name, value]) => [name.toLowerCase(), value]));
      seen.push({ method: init?.method ?? "GET", url: input, headers, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (input.endsWith("/writing/script-breakdowns/options")) return json(OPTIONS);
      if (input.endsWith("/latest-saved")) return await state.saved(input);
      if (input.endsWith("/latest")) return await state.latest(input);
      const next = state.posts.shift();
      if (!next) throw new Error(`unexpected ${input}`);
      return await next();
    });
    return {
      seen, state, client: new ScriptBreakdownClient(fetchImpl as unknown as typeof fetch),
      posts: () => seen.filter((item) => item.method === "POST"),
      gets: (suffix: string) => seen.filter((item) => item.method === "GET" && item.url.endsWith(suffix)).length,
    };
  }
  const panelFor = (s: ReturnType<typeof server>, options: { epoch?: number; episodeId?: string; onChanged?: () => Promise<void> } = {}) => (
    <ScriptBreakdownPanel projectId={P1} episodeId={options.episodeId ?? E1} episodeNo={2} scriptReady sceneCount={1}
      onOpenScene={vi.fn()} onChanged={options.onChanged ?? vi.fn(async () => undefined)} client={s.client} refreshEpoch={options.epoch ?? 0} />
  );
  const shotsUrl = (runId: string) => `/api/v1/projects/${P1}/episodes/${E1}/script-breakdowns/${runId}/shots`;
  const latestBlock = () => screen.getByTestId("breakdown-run");
  const keptBlock = () => screen.queryByTestId("breakdown-saved");
  const placeButtons = () => screen.queryAllByRole<HTMLButtonElement>("button", { name: "写入已批准场景的镜头" });

  // B is stopped in each case: it saves only if someone resumes it.
  for (const [label, newer] of NOT_SAVED.slice(0, 3)) {
    it(`keeps A viewable and writes its shots through A's endpoint while the newer run B is ${label}`, async () => {
      const s = server();
      s.state.latest = () => json({ run: newer() });
      s.state.saved = () => json({ run: savedA() });
      s.state.posts.push(() => json({ run: placedA(), placement: PLACED }));
      const onChanged = vi.fn(async () => undefined);
      render(panelFor(s, { onChanged }));
      const kept = await screen.findByTestId("breakdown-saved");
      expect(latestBlock().textContent).toContain("模型 q-B");
      expect(latestBlock().textContent).not.toContain("模型 q-A");
      expect(kept.textContent).toContain("最近已保存方案");
      expect(kept.textContent).toContain("模型 q-A");
      expect(kept.textContent).toContain("S1 · 便利店");
      expect(kept.textContent).toContain("场景：已通过 · 镜头未写入");
      expect(within(kept).getByRole("button", { name: "打开场景（修改或审核）" })).toBeTruthy();
      // The only write offered is A's.
      expect(placeButtons()).toHaveLength(1);
      s.state.saved = () => json({ run: placedA() });
      const reads = s.gets("/latest-saved");
      fireEvent.click(within(kept).getByRole("button", { name: "写入已批准场景的镜头" }));
      fireEvent.click(within(kept).getByRole("button", { name: "写入已批准场景的镜头" }));
      await waitFor(() => expect(screen.getByTestId("breakdown-saved").textContent).toContain("已写入：S1"));
      expect(s.posts().map((item) => [item.url, item.body])).toEqual([[shotsUrl(RUN), { acceptSceneChanged: false }]]);
      // A's answer refreshed both reads; it never became the latest run.
      await waitFor(() => expect(s.gets("/latest-saved")).toBeGreaterThan(reads));
      await waitFor(() => expect(screen.getByTestId("breakdown-saved").textContent).toContain("镜头已写入"));
      expect(latestBlock().textContent).toContain("模型 q-B");
      expect(latestBlock().textContent).not.toContain("模型 q-A");
      expect(placeButtons()).toHaveLength(0);
      expect(onChanged).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("alert")).toBeNull();
    });
  }

  it("shows A but holds its shot write while B is running (B froze A's scenes), then allows it once B stopped, stating what it means for B", async () => {
    const s = server();
    s.state.latest = () => json({ run: NOT_SAVED[3]![1]() });
    s.state.saved = () => json({ run: savedA() });
    s.state.posts.push(() => json({ run: placedA(), placement: PLACED }));
    const view = render(panelFor(s));
    const kept = await screen.findByTestId("breakdown-saved");
    expect(kept.textContent).toContain("S1 · 便利店");
    expect(within(kept).getByTestId("breakdown-saved-wait").textContent).toContain("付费得到的结果将因冲突不能保存");
    const write = within(kept).getByRole<HTMLButtonElement>("button", { name: "写入已批准场景的镜头" });
    expect(write.disabled).toBe(true);
    fireEvent.click(write);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.posts()).toHaveLength(0);
    // B stopped after its answer was refused: it would save only through a resume, so A's write is allowed and says so.
    s.state.latest = () => json({ run: NOT_SAVED[0]![1]() });
    view.rerender(panelFor(s, { epoch: 1 }));
    await waitFor(() => expect(screen.queryByTestId("breakdown-saved-wait")).toBeNull());
    expect(screen.getByTestId("breakdown-saved-supersedes").textContent).toContain("上面的最新任务将无法续跑，需要按当前内容重新生成");
    fireEvent.click(within(screen.getByTestId("breakdown-saved")).getByRole("button", { name: "写入已批准场景的镜头" }));
    await screen.findByText("已写入：S1");
    expect(s.posts().map((item) => item.url)).toEqual([shotsUrl(RUN)]);
  });

  it("finds A again from the server after a remount while the latest run is B; nothing is kept in the browser", async () => {
    const s = server();
    s.state.latest = () => json({ run: NOT_SAVED[0]![1]() });
    s.state.saved = () => json({ run: savedA() });
    const first = render(panelFor(s));
    await screen.findByTestId("breakdown-saved");
    first.unmount();
    window.sessionStorage.clear();
    render(panelFor(s));
    expect((await screen.findByTestId("breakdown-saved")).textContent).toContain("模型 q-A");
    expect(s.gets("/latest-saved")).toBe(2);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("shows B's saved result once B is saved, and offers A no more, even when a stale read still names A", async () => {
    const s = server();
    s.state.latest = () => json({ run: NOT_SAVED[3]![1]() });
    s.state.saved = () => json({ run: savedA() });
    s.state.posts.push(() => json({ run: run({ runId: RUN_B, model: "q-B", scenes: approvedScene(SCENE_B, "saved") }), placement: PLACED }));
    const view = render(panelFor(s));
    expect((await screen.findByTestId("breakdown-saved")).textContent).toContain("模型 q-A");
    // B is saved. The saved read answers A still (it may lag behind); latest names B saved, which wins.
    s.state.latest = () => json({ run: savedB() });
    view.rerender(panelFor(s, { epoch: 1 }));
    await waitFor(() => expect(keptBlock()).toBeNull());
    expect(latestBlock().textContent).toContain("最新拆解任务（也是最近已保存方案）");
    expect(screen.queryByText(/模型 q-A/)).toBeNull();
    expect(placeButtons()).toHaveLength(1);
    fireEvent.click(placeButtons()[0]!);
    await waitFor(() => expect(s.posts()).toHaveLength(1));
    expect(s.posts()[0]!.url).toBe(shotsUrl(RUN_B));
    await screen.findByText("已写入：S1");
    expect(keptBlock()).toBeNull();
  });

  it("shows a run that is both the latest and the saved one once, without reading the saved one separately", async () => {
    const s = server();
    s.state.latest = () => json({ run: savedA() });
    s.state.saved = () => json({ run: savedA() });
    render(panelFor(s));
    await screen.findByText(/模型 q-A/);
    expect(keptBlock()).toBeNull();
    expect(screen.getAllByText(/S1 · 便利店/)).toHaveLength(1);
    expect(placeButtons()).toHaveLength(1);
    expect(s.gets("/latest-saved")).toBe(0);
  });

  it("reports a failed saved read with a retry instead of 'nothing saved', and keeps what it showed when a later read fails", async () => {
    const s = server();
    s.state.latest = () => json({ run: NOT_SAVED[0]![1]() });
    s.state.saved = () => json({ error: { code: "INTERNAL", message: "x" } }, 500);
    const view = render(panelFor(s));
    const failed = await screen.findByTestId("breakdown-saved-error");
    expect(failed.textContent).toContain("这不表示没有已保存的方案");
    expect(keptBlock()).toBeNull();
    s.state.saved = () => json({ run: savedA() });
    fireEvent.click(within(failed).getByRole("button", { name: "重新读取已保存方案" }));
    expect((await screen.findByTestId("breakdown-saved")).textContent).toContain("模型 q-A");
    expect(screen.queryByTestId("breakdown-saved-error")).toBeNull();
    // A later read fails: A stays, marked as possibly outdated.
    s.state.saved = () => json({ error: { code: "INTERNAL", message: "x" } }, 502);
    view.rerender(panelFor(s, { epoch: 1 }));
    expect((await screen.findByTestId("breakdown-saved-error")).textContent).toContain("下面显示的可能不是最新状态");
    expect(keptBlock()!.textContent).toContain("模型 q-A");
    expect(s.posts()).toHaveLength(0);
  });

  it("shows a saved run whose source went out of date as such, and does not offer to write its shots", async () => {
    const s = server();
    s.state.latest = () => json({ run: NOT_SAVED[0]![1]() });
    s.state.saved = () => json({ run: savedA({ episodeScript: { currentRevisionId: "99999999-9999-4999-8999-99999999999a", currentRevisionNo: 4, approved: true } }) });
    render(panelFor(s));
    const kept = await screen.findByTestId("breakdown-saved");
    expect(within(kept).getByTestId("breakdown-saved-outdated").textContent).toContain("来源剧本已更新到第 4 版");
    expect(within(kept).getByRole<HTMLButtonElement>("button", { name: "写入已批准场景的镜头" }).disabled).toBe(true);
  });

  it("drops a saved read or a shot write answered after the episode changed or the panel was unmounted", async () => {
    const s = server();
    const lateRead = held<Response>();
    s.state.latest = (url) => json({ run: url.includes(E2) ? null : NOT_SAVED[0]![1]() });
    s.state.saved = () => lateRead.promise;
    const view = render(panelFor(s));
    await waitFor(() => expect(s.gets("/latest-saved")).toBe(1));
    view.rerender(panelFor(s, { episodeId: E2 }));
    await screen.findByText("这一集还没有拆解过。");
    lateRead.resolve(json({ run: savedA() }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(keptBlock()).toBeNull();
    expect(screen.getByRole("heading", { level: 2 }).id).toBe(`breakdown-${E2}`);

    // Back on E1 with A shown, a shot write is still in flight when the panel goes to E2, then unmounts.
    s.state.saved = () => json({ run: savedA() });
    view.rerender(panelFor(s, { episodeId: E1 }));
    const kept = await screen.findByTestId("breakdown-saved");
    const lateWrite = held<Response>();
    s.state.posts.push(() => lateWrite.promise);
    const onChanged = vi.fn(async () => undefined);
    view.rerender(panelFor(s, { episodeId: E1, onChanged }));
    fireEvent.click(within(kept).getByRole("button", { name: "写入已批准场景的镜头" }));
    await waitFor(() => expect(s.posts()).toHaveLength(1));
    view.rerender(panelFor(s, { episodeId: E2, onChanged }));
    await screen.findByText("这一集还没有拆解过。");
    lateWrite.resolve(json({ run: placedA(), placement: PLACED }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(keptBlock()).toBeNull();
    expect(screen.queryByText("已写入：S1")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
    view.unmount();
  });

  it("holds A's shot write while a resume of B is unconfirmed (B may be running), keeping B's identity and its confirmation", async () => {
    const KEY = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const storage = `ads:breakdown:${P1}:${E1}:resume:v1`;
    window.sessionStorage.setItem(storage, JSON.stringify({ kind: "resume", runId: RUN_B, confirmed: [], key: KEY }));
    const s = server();
    s.state.latest = () => json({ run: NOT_SAVED[0]![1]() });
    s.state.saved = () => json({ run: savedA() });
    render(panelFor(s));
    fireEvent.change(await screen.findByLabelText("操作者令牌"), { target: { value: TOKEN } });
    const kept = await screen.findByTestId("breakdown-saved");
    expect(screen.getByTestId("breakdown-pending-resume")).toBeTruthy();
    expect(within(kept).getByTestId("breakdown-saved-wait")).toBeTruthy();
    const write = within(kept).getByRole<HTMLButtonElement>("button", { name: "写入已批准场景的镜头" });
    expect(write.disabled).toBe(true);
    fireEvent.click(write);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.posts()).toHaveLength(0);
    expect(JSON.parse(window.sessionStorage.getItem(storage)!)).toEqual({ kind: "resume", runId: RUN_B, confirmed: [], key: KEY });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "确认上次续跑结果" }).disabled).toBe(false);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "重新生成场景与分镜" }).disabled).toBe(true);
  });

  for (const oldLatest of ["saved A", "stopped B"] as const) {
    it(`refreshes a stale ${oldLatest} after the server refuses its shot write for an active breakdown, preserving the saved plan and request identity`, async () => {
      const s = server();
      const storage = `ads:breakdown:${P1}:${E1}:start:v1`;
      const pending = { kind: "start", key: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        body: { providerKey: "qwen", model: "q-1", replaceExisting: true } };
      window.sessionStorage.setItem(storage, JSON.stringify(pending));
      s.state.latest = () => json({ run: oldLatest === "saved A" ? savedA() : NOT_SAVED[0]![1]() });
      s.state.saved = () => json({ run: savedA() });
      s.state.posts.push(() => {
        s.state.latest = () => json({ run: NOT_SAVED[3]![1]() });
        return json({ error: { code: "SCRIPT_BREAKDOWN_RUN_ACTIVE", message: "本集拆解正在进行，未写入镜头，请结束后再试。" } }, 409);
      });
      const onChanged = vi.fn(async () => undefined);
      render(panelFor(s, { onChanged }));
      const write = await screen.findByRole<HTMLButtonElement>("button", { name: "写入已批准场景的镜头" });
      expect(write.disabled).toBe(false);
      const reads = s.gets("/latest");
      fireEvent.click(write);
      await waitFor(() => expect(s.gets("/latest")).toBeGreaterThan(reads));
      await screen.findByText(/状态：进行中/);
      const kept = await screen.findByTestId("breakdown-saved");
      expect(kept.textContent).toContain("模型 q-A");
      expect(within(kept).getByTestId("breakdown-saved-wait")).toBeTruthy();
      expect(within(kept).getByRole<HTMLButtonElement>("button", { name: "写入已批准场景的镜头" }).disabled).toBe(true);
      expect(s.posts().map((item) => [item.url, item.body])).toEqual([[shotsUrl(RUN), { acceptSceneChanged: false }]]);
      expect(JSON.parse(window.sessionStorage.getItem(storage)!)).toEqual(pending);
      expect(screen.queryByText("已写入：S1")).toBeNull();
      expect(onChanged).not.toHaveBeenCalled();
    });
  }
});

describe("the feature switch is the main state, whatever the task read says", () => {
  const E2 = "33333333-3333-4333-8333-333333333334";
  const DISABLED: ScriptBreakdownOptionsView = { ...OPTIONS, enabled: false, code: "TITLE_WRITING_DISABLED", storageReady: false };
  const STORAGE_OFF: ScriptBreakdownOptionsView = { ...OPTIONS, code: "SCRIPT_BREAKDOWN_STORAGE_UNAVAILABLE", storageReady: false };
  const storage503 = () => json({ error: { code: "SCRIPT_BREAKDOWN_STORAGE_UNAVAILABLE", message: "剧本拆解的数据库迁移还没有执行，没有启动任何调用。" } }, 503);
  function held<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }
  type Answer = (url: string) => Response | Promise<Response>;
  /** Options, latest and latest-saved answer from switchable sources; every request is recorded, POSTs answer in order. */
  function server(options: Answer, latest: Answer) {
    const seen: Seen[] = [];
    const state: { options: Answer; latest: Answer; saved: Answer; posts: Array<() => Response | Promise<Response>> } = {
      options, latest, saved: () => json({ run: null }), posts: [] };
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
      const headers = Object.fromEntries([...new Headers(init?.headers).entries()].map(([name, value]) => [name.toLowerCase(), value]));
      seen.push({ method: init?.method ?? "GET", url: input, headers, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (input.endsWith("/writing/script-breakdowns/options")) return await state.options(input);
      if (input.endsWith("/latest-saved")) return await state.saved(input);
      if (input.endsWith("/latest")) return await state.latest(input);
      const next = state.posts.shift();
      if (!next) throw new Error(`unexpected ${input}`);
      return await next();
    });
    return { seen, state, client: new ScriptBreakdownClient(fetchImpl as unknown as typeof fetch),
      posts: () => seen.filter((item) => item.method !== "GET") };
  }
  const panelFor = (s: ReturnType<typeof server>, props: { scriptReady?: boolean; sceneCount?: number; episodeId?: string; epoch?: number } = {}) => (
    <ScriptBreakdownPanel projectId={P1} episodeId={props.episodeId ?? E1} episodeNo={2} scriptReady={props.scriptReady ?? true}
      sceneCount={props.sceneCount ?? 0} onOpenScene={vi.fn()} onChanged={vi.fn(async () => undefined)} client={s.client} refreshEpoch={props.epoch ?? 0} />
  );
  const blocked = () => screen.queryByTestId("breakdown-blocked")?.textContent ?? null;
  const startButton = () => screen.getByRole<HTMLButtonElement>("button", { name: /生成场景与分镜|确认上次启动结果/ });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  /** What the person sees for the live combination, in one comparable value. */
  function disabledView() {
    return {
      blocked: blocked(),
      history: screen.queryByTestId("breakdown-history-error")?.textContent ?? null,
      alert: screen.queryByRole("alert")?.textContent ?? null,
      empty: screen.queryByText("这一集还没有拆解过。") !== null,
      startDisabled: startButton().disabled,
    };
  }

  it("A: says it is off (not 'read again') when off and the task read is a storage 503, keeps start disabled and sends nothing", async () => {
    const s = server(() => json(DISABLED), storage503);
    render(panelFor(s));
    await waitFor(() => expect(screen.queryByTestId("breakdown-history-error")).not.toBeNull());
    const view = disabledView();
    expect(view.blocked).toBe("剧本拆解尚未开启。");
    expect(view.alert).toBeNull();
    expect(view.empty).toBe(false);
    expect(view.startDisabled).toBe(true);
    expect(view.history).toContain("历史拆解记录暂时无法读取（剧本拆解的数据存储还没有就绪）");
    expect(view.history).toContain("不会开启拆解");
    expect(document.body.textContent).not.toContain("请先重新读取本集任务状态");
    expect(document.body.textContent).not.toContain("迁移");
    fireEvent.change(screen.getByLabelText("操作者令牌"), { target: { value: TOKEN } });
    expect(startButton().disabled).toBe(true);
    fireEvent.click(startButton());
    await settle();
    expect(s.posts()).toHaveLength(0);
  });

  it("B: ends the same whether the settings or the failed task read answers first; a late failure does not replace the off state", async () => {
    // Settings first, task read fails later.
    const lateLatest = held<Response>();
    const first = server(() => json(DISABLED), () => lateLatest.promise);
    render(panelFor(first));
    // Shown as soon as the settings are read, without waiting for the task read, and never startable in between.
    await waitFor(() => expect(blocked()).toBe("剧本拆解尚未开启。"));
    expect(startButton().disabled).toBe(true);
    expect(screen.queryByText("这一集还没有拆解过。")).toBeNull();
    lateLatest.resolve(storage503());
    await waitFor(() => expect(screen.queryByTestId("breakdown-history-error")).not.toBeNull());
    const settingsFirst = disabledView();
    expect(first.posts()).toHaveLength(0);
    cleanup();

    // Task read fails first, settings later.
    const lateOptions = held<Response>();
    const second = server(() => lateOptions.promise, storage503);
    render(panelFor(second));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeNull());
    // Before the settings answer, the page says only what it knows: the task read failed. Not "off", not ready, not empty.
    expect(blocked()).toBe("请先重新读取本集任务状态。");
    expect(document.body.textContent).not.toContain("剧本拆解尚未开启");
    expect(screen.queryByText("这一集还没有拆解过。")).toBeNull();
    expect(startButton().disabled).toBe(true);
    lateOptions.resolve(json(DISABLED));
    await waitFor(() => expect(blocked()).toBe("剧本拆解尚未开启。"));
    expect(disabledView()).toEqual(settingsFirst);
    expect(second.posts()).toHaveLength(0);
  });

  it("C: off with an unapproved script, an empty token and scenes to replace: says it is off and keeps every gate", async () => {
    const s = server(() => json(DISABLED), storage503);
    render(panelFor(s, { scriptReady: false, sceneCount: 2 }));
    await waitFor(() => expect(blocked()).toBe("剧本拆解尚未开启。"));
    expect(startButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("操作者令牌"), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole("checkbox", { name: /用新结果取代这一集现有的场景/ }));
    expect(blocked()).toBe("剧本拆解尚未开启。");
    expect(startButton().disabled).toBe(true);
    fireEvent.click(startButton());
    await settle();
    expect(s.posts()).toHaveLength(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("D: on, but storage not ready or the task read failing: the real error stays, start stays blocked, never shown as off or empty", async () => {
    const storage = server(() => json(STORAGE_OFF), storage503);
    render(panelFor(storage));
    expect((await screen.findByRole("alert")).textContent).toContain("剧本拆解的数据存储还没有就绪");
    await waitFor(() => expect(blocked()).toBe("剧本拆解的数据库迁移还没有执行。"));
    expect(document.body.textContent).not.toContain("剧本拆解尚未开启");
    expect(screen.queryByText("这一集还没有拆解过。")).toBeNull();
    expect(screen.queryByTestId("breakdown-history-error")).toBeNull();
    fireEvent.change(screen.getByLabelText("操作者令牌"), { target: { value: TOKEN } });
    expect(startButton().disabled).toBe(true);
    expect(storage.posts()).toHaveLength(0);
    cleanup();

    const failures: Array<[Answer, string]> = [
      [() => json({ error: { code: "INTERNAL", message: "x" } }, 500), "拆解状态暂时无法读取"],
      [() => json({ error: { code: "UNAUTHORIZED", message: "x" } }, 401), "没有读取拆解状态的权限（HTTP 401）"],
      [() => json({ error: { code: "FORBIDDEN", message: "x" } }, 403), "没有读取拆解状态的权限（HTTP 403）"],
      [() => { throw new TypeError("network down"); }, "拆解状态暂时无法读取"],
    ];
    for (const [answer, text] of failures) {
      const s = server(() => json(OPTIONS), answer);
      render(panelFor(s));
      expect((await screen.findByRole("alert")).textContent).toContain(text);
      await waitFor(() => expect(blocked()).toBe("请先重新读取本集任务状态。"));
      expect(screen.getByRole("button", { name: "重新读取" })).toBeTruthy();
      expect(screen.queryByText("这一集还没有拆解过。")).toBeNull();
      expect(document.body.textContent).not.toContain("剧本拆解尚未开启");
      fireEvent.change(screen.getByLabelText("操作者令牌"), { target: { value: TOKEN } });
      expect(startButton().disabled).toBe(true);
      expect(s.posts()).toHaveLength(0);
      cleanup();
    }

    // Off with a refused read: the refusal is still said (as the reason the history is unreadable), not swallowed.
    const refusedRead = server(() => json(DISABLED), () => json({ error: { code: "UNAUTHORIZED", message: "x" } }, 401));
    render(panelFor(refusedRead));
    expect((await screen.findByTestId("breakdown-history-error")).textContent).toContain("没有读取权限（HTTP 401）");
    expect(blocked()).toBe("剧本拆解尚未开启。");
  });

  it("E: settings unread or unreadable say nothing about the switch, and nothing is sent on its own", async () => {
    const pending = held<Response>();
    const loading = server(() => pending.promise, storage503);
    render(panelFor(loading));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeNull());
    expect(document.body.textContent).not.toContain("剧本拆解尚未开启");
    expect(startButton().disabled).toBe(true);
    cleanup();

    const failing = server(() => json({ error: { code: "INTERNAL", message: "x" } }, 500), () => json({ run: null }));
    render(panelFor(failing));
    await screen.findByTestId("breakdown-options-error");
    await waitFor(() => expect(blocked()).toBe("功能配置读取失败，请先“重新读取功能配置”。"));
    expect(document.body.textContent).not.toContain("剧本拆解尚未开启");
    // This task read did succeed and said there is no task: that alone may be shown as empty.
    expect(screen.getByText("这一集还没有拆解过。")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("操作者令牌"), { target: { value: TOKEN } });
    expect(startButton().disabled).toBe(true);
    await settle();
    expect([...loading.posts(), ...failing.posts()]).toHaveLength(0);
  });

  it("F: a failed read clears once a read succeeds, which then shows 'none' or the task as it is", async () => {
    const s = server(() => json(OPTIONS), () => json({ error: { code: "INTERNAL", message: "x" } }, 500));
    const view = render(panelFor(s));
    await screen.findByRole("alert");
    s.state.latest = () => json({ run: null });
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    await screen.findByText("这一集还没有拆解过。");
    expect(screen.queryByRole("alert")).toBeNull();
    s.state.latest = () => json({ run: run() });
    view.rerender(panelFor(s, { epoch: 1 }));
    await screen.findByTestId("breakdown-run");
    expect(screen.queryByText("这一集还没有拆解过。")).toBeNull();
    cleanup();

    // Off: the shown task stays through a later failed read, marked as possibly outdated; a later success clears the note.
    const off = server(() => json(DISABLED), () => json({ run: run() }));
    const offView = render(panelFor(off));
    await screen.findByTestId("breakdown-run");
    await waitFor(() => expect(blocked()).toBe("剧本拆解尚未开启。"));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "重新生成场景与分镜" }).disabled).toBe(true);
    off.state.latest = storage503;
    offView.rerender(panelFor(off, { epoch: 1 }));
    expect((await screen.findByTestId("breakdown-history-error")).textContent).toContain("下面显示的可能不是最新状态");
    expect(screen.getByTestId("breakdown-run").textContent).toContain("状态：已完成");
    off.state.latest = () => json({ run: null });
    fireEvent.click(screen.getByRole("button", { name: "重新读取历史记录" }));
    await screen.findByText("这一集还没有拆解过。");
    expect(screen.queryByTestId("breakdown-history-error")).toBeNull();
    expect(blocked()).toBe("剧本拆解尚未开启。");
    expect([...s.posts(), ...off.posts()]).toHaveLength(0);
  });

  it("G: late answers for a left episode change nothing on the new one", async () => {
    const lateOptions = held<Response>();
    const lateLatest = held<Response>();
    let optionReads = 0;
    const s = server(() => (optionReads++ === 0 ? lateOptions.promise : json(OPTIONS)),
      (url) => (url.includes(E2) ? json({ run: null }) : lateLatest.promise));
    const view = render(panelFor(s));
    view.rerender(panelFor(s, { episodeId: E2 }));
    await screen.findByText("这一集还没有拆解过。");
    await waitFor(() => expect(blocked()).toBe("请填写操作者令牌。"));
    lateOptions.resolve(json(DISABLED));
    lateLatest.resolve(storage503());
    await settle();
    expect(document.body.textContent).not.toContain("剧本拆解尚未开启");
    expect(screen.queryByTestId("breakdown-history-error")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("这一集还没有拆解过。")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("操作者令牌"), { target: { value: TOKEN } });
    expect(startButton().disabled).toBe(false);
    expect(s.posts()).toHaveLength(0);
  });

  it("G: off keeps a restored start's identity: confirmed only on click, with its own key and body, once", async () => {
    const storage = `ads:breakdown:${P1}:${E1}:start:v1`;
    const pending = { kind: "start", key: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", body: { providerKey: "qwen", model: "q-1", replaceExisting: false } };
    window.sessionStorage.setItem(storage, JSON.stringify(pending));
    const s = server(() => json(DISABLED), storage503);
    s.state.posts.push(() => json({ run: run() }, 200));
    render(panelFor(s, { scriptReady: false }));
    // The off state is said on its own line; the pending start keeps its own gate (the token), as before.
    expect((await screen.findByTestId("breakdown-disabled")).textContent).toBe("剧本拆解尚未开启。");
    await waitFor(() => expect(blocked()).toBe("请填写操作者令牌。"));
    expect(screen.getByTestId("breakdown-pending-start")).toBeTruthy();
    await settle();
    expect(s.posts()).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("操作者令牌"), { target: { value: TOKEN } });
    fireEvent.click(startButton());
    fireEvent.click(startButton());
    await screen.findByText(/状态：已完成/);
    expect(s.posts().map((item) => [item.headers["idempotency-key"], item.body])).toEqual([[pending.key, pending.body]]);
    expect(window.sessionStorage.getItem(storage)).toBeNull();
  });

  it("G: off with an unconfirmed resume keeps it first and offers only its confirmation", async () => {
    const storage = `ads:breakdown:${P1}:${E1}:resume:v1`;
    const pending = { kind: "resume", runId: RUN, confirmed: [], key: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" };
    window.sessionStorage.setItem(storage, JSON.stringify(pending));
    const s = server(() => json(DISABLED), storage503);
    render(panelFor(s));
    expect((await screen.findByTestId("breakdown-disabled")).textContent).toBe("剧本拆解尚未开启。");
    await waitFor(() => expect(blocked()).toBe("请先确认上次续跑结果，之后才能发起新的生成。"));
    expect(screen.getByTestId("breakdown-pending-resume")).toBeTruthy();
    expect(startButton().disabled).toBe(true);
    await settle();
    expect(s.posts()).toHaveLength(0);
    expect(JSON.parse(window.sessionStorage.getItem(storage)!)).toEqual(pending);
  });
});
