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
