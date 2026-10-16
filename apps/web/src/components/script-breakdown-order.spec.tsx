// @vitest-environment happy-dom
// Simulated ordering and receipt regressions; no API/database/provider requests.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScriptBreakdownOptionsView, ScriptBreakdownRunView } from "@ai-drama/contracts";
import { SCRIPT_BREAKDOWN_LIMITS } from "@ai-drama/contracts";
import { ScriptBreakdownClient } from "../lib/script-breakdown-client";
import { ScriptBreakdownPanel } from "./script-breakdown-panel";
const P1 = "22222222-2222-4222-8222-222222222222";
const E1 = "33333333-3333-4333-8333-333333333333";
const RUN = "66666666-6666-4666-8666-666666666666";
const SCENE = "77777777-7777-4777-8777-777777777777";
const TOKEN = "operator-token-0123456789";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

const OPTIONS: ScriptBreakdownOptionsView = {
  enabled: true, code: "SCRIPT_BREAKDOWN_READY", storageReady: true, operatorTokenRequired: true, defaultProvider: "anthropic",
  providers: [{ providerKey: "anthropic", label: "Claude", ready: true, models: ["q-1"], defaultModel: "q-1", missing: [] }],
  maxCallsPerDay: 30, callCapPerRun: 3, billing: "unknown", limits: SCRIPT_BREAKDOWN_LIMITS,
};

function run(overrides: Partial<ScriptBreakdownRunView> = {}): ScriptBreakdownRunView {
  return {
    runId: RUN, projectId: P1, episodeId: E1, episodeNo: 2, scriptRevisionId: "88888888-8888-4888-8888-888888888888", scriptRevisionNo: 3,
    targetEpisodeSeconds: 60, characters: [{ key: "C1", characterId: "99999999-9999-4999-8999-999999999999", revisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "林夏" }],
    replacedScenes: 0, providerKey: "anthropic", model: "q-1", state: "completed", errorCode: null, cancelRequested: false, callCap: 3, callsUsed: 1,
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


const E2 = "33333333-3333-4333-8333-333333333334";
const RUN2 = "66666666-6666-4666-8666-666666666667";
function held<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const running = (overrides: Partial<ScriptBreakdownRunView> = {}) => run({ state: "running", output: null, save: "pending", scenes: [], ...overrides });
const props = (client: ScriptBreakdownClient, episodeId = E1) => ({ projectId: P1, episodeId, episodeNo: episodeId === E1 ? 2 : 3,
  scriptReady: true, sceneCount: 0, onOpenScene: vi.fn(), onChanged: vi.fn(async () => undefined), client });
async function flush() { await act(async () => { await Promise.resolve(); }); }
async function poll() { await act(async () => { await vi.advanceTimersByTimeAsync(2_000); }); }
function startButton() { return screen.getByRole("button", { name: /^(生成场景与分镜|重新生成场景与分镜|确认上次启动结果)$/ }); }
async function enterToken() { fireEvent.change(await screen.findByLabelText("操作者令牌"), { target: { value: TOKEN } }); }
beforeEach(() => { window.sessionStorage.clear(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: true }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("breakdown actions keep their identity and scope", () => {
  it("replays an accepted start after a proxy 502 with the same key", async () => {
    const keys: string[] = [];
    const client = new ScriptBreakdownClient(async (url, init) => {
      if (url.endsWith("/options")) return json(OPTIONS);
      if (url.endsWith("/latest-saved")) return json({ run: null });
      if (url.endsWith("/latest")) return json({ run: null });
      keys.push(new Headers(init?.headers).get("Idempotency-Key")!);
      return keys.length === 1 ? new Response("Bad Gateway", { status: 502 }) : json({ run: run() });
    });
    render(<ScriptBreakdownPanel {...props(client)} />);
    await enterToken(); await waitFor(() => expect((startButton() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(startButton()); await screen.findByRole("alert");
    fireEvent.click(startButton()); await screen.findByText(/状态：已完成/);
    expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]);
  });

  it("keeps an unanswered start across unmount/remount without storing the token", async () => {
    const keys: string[] = [];
    const client = new ScriptBreakdownClient(async (url, init) => {
      if (url.endsWith("/options")) return json(OPTIONS);
      if (url.endsWith("/latest-saved")) return json({ run: null });
      if (url.endsWith("/latest")) return json({ run: null });
      keys.push(new Headers(init?.headers).get("Idempotency-Key")!);
      if (keys.length === 1) throw new TypeError("lost response");
      return json({ run: run() });
    });
    const mounted = render(<ScriptBreakdownPanel {...props(client)} />);
    await enterToken(); await waitFor(() => expect((startButton() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(startButton()); await screen.findByRole("alert"); mounted.unmount();
    expect(JSON.stringify(window.sessionStorage)).not.toContain(TOKEN);
    render(<ScriptBreakdownPanel {...props(client)} />); await enterToken();
    await waitFor(() => expect((startButton() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(startButton()); await screen.findByText(/状态：已完成/);
    expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]);
  });

  it("drops an old episode's late initial GET after switching episodes", async () => {
    const old = held<Response>();
    const client = new ScriptBreakdownClient(async (url) => {
      if (url.endsWith("/options")) return json(OPTIONS);
      return url.includes(E2) ? json({ run: run({ episodeId: E2, runId: RUN2, model: "new-episode" }) }) : old.promise;
    });
    const mounted = render(<ScriptBreakdownPanel {...props(client)} />);
    mounted.rerender(<ScriptBreakdownPanel {...props(client, E2)} />);
    await screen.findByText(/模型 new-episode/);
    await act(async () => { old.resolve(json({ run: run({ model: "old-episode" }) })); });
    expect(screen.queryByText(/模型 old-episode/)).toBeNull(); expect(screen.getByText(/模型 new-episode/)).toBeTruthy();
  });

  it("releases old episode busy state and ignores its late start", async () => {
    const old = held<Response>();
    const client = new ScriptBreakdownClient(async (url, init) => {
      if (url.endsWith("/options")) return json(OPTIONS);
      if (init?.method === "GET") return json({ run: null });
      return old.promise;
    });
    const mounted = render(<ScriptBreakdownPanel {...props(client)} />);
    await enterToken(); await waitFor(() => expect((startButton() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(startButton());
    mounted.rerender(<ScriptBreakdownPanel {...props(client, E2)} />); await enterToken();
    await waitFor(() => expect((startButton() as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { old.resolve(json({ run: run({ model: "old-episode" }) })); });
    expect(screen.queryByText(/模型 old-episode/)).toBeNull();
  });

  it("does not let a late cancel receipt replace a terminal poll", async () => {
    const receipt = held<Response>(); let latest = running();
    const client = new ScriptBreakdownClient(async (url, init) => {
      if (url.endsWith("/options")) return json(OPTIONS);
      if (init?.method === "POST") return receipt.promise;
      return json({ run: latest });
    });
    render(<ScriptBreakdownPanel {...props(client)} />);
    fireEvent.click(await screen.findByRole("button", { name: "取消" }));
    latest = running({ state: "canceled", cancelRequested: true }); await poll();
    await screen.findByText(/状态：已取消/);
    await act(async () => { receipt.resolve(json({ run: running({ cancelRequested: true }) })); }); await flush();
    expect(screen.getByText(/状态：已取消/)).toBeTruthy(); expect(screen.queryByText(/状态：进行中/)).toBeNull();
  });

  it("never has two latest GETs in flight", async () => {
    const pending = held<Response>(); let reads = 0;
    const client = new ScriptBreakdownClient(async (url) => {
      if (url.endsWith("/options")) return json(OPTIONS);
      if (url.endsWith("/latest-saved")) return json({ run: null });
      reads += 1; return reads === 1 ? json({ run: running() }) : pending.promise;
    });
    render(<ScriptBreakdownPanel {...props(client)} />); await screen.findByText(/状态：进行中/);
    await poll(); await poll(); await poll(); expect(reads).toBe(2);
    await act(async () => { pending.resolve(json({ run: run() })); });
  });

  it("rejects incomplete or wrong-run receipts instead of releasing identity", async () => {
    for (const receipt of [{}, { run: { runId: RUN, projectId: P1, episodeId: E1 } }, { run: run({ episodeId: E2 }) }]) {
      const client = new ScriptBreakdownClient(async () => json(receipt, 201));
      await expect(client.start(P1, E1, { replaceExisting: false }, { token: TOKEN, idempotencyKey: "frozen-key" })).rejects.toThrow();
    }
    const client = new ScriptBreakdownClient(async () => json({ run: run({ runId: RUN2 }) }));
    await expect(client.resume(P1, E1, RUN, { token: TOKEN, idempotencyKey: "frozen-resume", confirmUncertainCallIds: [] })).rejects.toThrow();
  });
});


describe("pending request recovery and source refresh", () => {
  it("keeps the original key through an ambiguous response followed by an authentication refusal", async () => {
    const keys: string[] = [];
    const client = new ScriptBreakdownClient(async (url, init) => {
      if (url.endsWith("/options")) return json(OPTIONS);
      if (url.endsWith("/latest-saved")) return json({ run: null });
      if (url.endsWith("/latest")) return json({ run: null });
      keys.push(new Headers(init?.headers).get("Idempotency-Key")!);
      if (keys.length < 3) return json({ error: { code: "UNAVAILABLE", message: "refused" } }, keys.length === 1 ? 503 : 403);
      return json({ run: run() });
    });
    render(<ScriptBreakdownPanel {...props(client)} />); await enterToken();
    await waitFor(() => expect((startButton() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(startButton()); await screen.findByRole("alert");
    fireEvent.click(startButton()); await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("refused"));
    fireEvent.click(startButton()); await screen.findByText(/状态：已完成/);
    expect(keys).toHaveLength(3); expect(new Set(keys).size).toBe(1);
  });

  it("replays an unanswered resume after remount with the same frozen confirmation and key", async () => {
    const callId = "99999999-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const uncertain = run({ state: "needs_attention", save: "pending", output: null, scenes: [],
      step: { state: "unknown", attemptNo: 1, errorCode: "executor_lost" }, calls: [{
        callId, stepKey: "breakdown", attemptNo: 1, state: "unknown", providerKey: "anthropic", model: "q-1",
        outcome: null, rejectionCode: null, usage: null, billing: "unknown", createdAt: "2026-10-12T00:00:00Z",
      }] as unknown as ScriptBreakdownRunView["calls"] });
    const sent: Array<{ key: string; body: string }> = [];
    const client = new ScriptBreakdownClient(async (url, init) => {
      if (url.endsWith("/options")) return json(OPTIONS);
      if (url.endsWith("/latest-saved")) return json({ run: null });
      if (url.endsWith("/latest")) return json({ run: uncertain });
      sent.push({ key: new Headers(init?.headers).get("Idempotency-Key")!, body: String(init?.body) });
      return sent.length === 1 ? new Response("gateway", { status: 504 }) : json({ run: running() });
    });
    const mounted = render(<ScriptBreakdownPanel {...props(client)} />); await enterToken();
    fireEvent.click(await screen.findByRole("checkbox", { name: /我知道上一次调用结果未知/ }));
    fireEvent.click(screen.getByRole("button", { name: "续跑（重新发送一次调用）" }));
    await screen.findByRole("alert"); mounted.unmount();
    render(<ScriptBreakdownPanel {...props(client)} />); await enterToken();
    fireEvent.click(await screen.findByRole("button", { name: "确认上次续跑结果" }));
    await screen.findByText(/状态：进行中/);
    expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]);
    expect(JSON.parse(sent[0]!.body)).toEqual({ confirmUncertainCallIds: [callId] });
  });

  it("refreshes a terminal result when the parent reports a saved source revision", async () => {
    let latest = run(); let writes = 0;
    const client = new ScriptBreakdownClient(async (url, init) => {
      if (init?.method === "POST") writes += 1;
      return url.endsWith("/options") ? json(OPTIONS) : json({ run: latest });
    });
    const base = props(client);
    const mounted = render(<ScriptBreakdownPanel {...base} refreshEpoch={0} />);
    await screen.findByText(/状态：已完成/);
    latest = run({ episodeScript: { currentRevisionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", currentRevisionNo: 4, approved: false } });
    mounted.rerender(<ScriptBreakdownPanel {...base} refreshEpoch={1} />);
    expect((await screen.findByTestId("breakdown-outdated")).textContent).toContain("来源剧本已更新到第 4 版");
    expect(writes).toBe(0);
  });

  it("does not start a new paid action when the existing task could not be read", async () => {
    let writes = 0;
    const client = new ScriptBreakdownClient(async (url, init) => {
      if (init?.method === "POST") writes += 1;
      return url.endsWith("/options") ? json(OPTIONS) : new Response("unavailable", { status: 503 });
    });
    render(<ScriptBreakdownPanel {...props(client)} />); await enterToken(); await screen.findByRole("alert");
    expect((startButton() as HTMLButtonElement).disabled).toBe(true); expect(writes).toBe(0);
  });
});


describe("cancel errors and persisted identity failures", () => {
  it.each([true, false])("only hides a failed cancel after a confirmed terminal read: %s", async (terminal) => {
    const receipt = held<Response>(); let latest = running();
    const client = new ScriptBreakdownClient(async (url, init) => {
      if (url.endsWith("/options")) return json(OPTIONS);
      if (init?.method === "POST") return receipt.promise;
      return json({ run: latest });
    });
    render(<ScriptBreakdownPanel {...props(client)} />);
    fireEvent.click(await screen.findByRole("button", { name: "取消" }));
    if (terminal) latest = running({ state: "canceled", cancelRequested: true });
    await poll();
    await act(async () => { receipt.resolve(new Response("unavailable", { status: 502 })); });
    if (terminal) expect(screen.queryByRole("alert")).toBeNull();
    else expect((await screen.findByRole("alert")).textContent).toContain("取消请求失败");
  });

  it("does not send a paid request if its identity cannot be persisted", async () => {
    let writes = 0;
    const client = new ScriptBreakdownClient(async (url, init) => {
      if (init?.method === "POST") writes += 1;
      return url.endsWith("/options") ? json(OPTIONS) : json({ run: null });
    });
    render(<ScriptBreakdownPanel {...props(client)} />); await enterToken();
    await waitFor(() => expect((startButton() as HTMLButtonElement).disabled).toBe(false));
    vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
    fireEvent.click(startButton());
    expect((await screen.findByRole("alert")).textContent).toContain("未发送请求"); expect(writes).toBe(0);
  });
});
