// @vitest-environment happy-dom
// P2-A and P2-B on the progress page: a late cancel failure next to a run whose stop is already confirmed, and reads
// of the same run that never overlap. Simulated interface tests: fetch is mocked; no browser, API or model.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TitleWritingRunView, TitleWritingStepView } from "@ai-drama/contracts";
import { TitleWritingClient } from "../lib/title-writing-client";
import { TITLE_WRITING_POLL_MS, TitleWritingRun } from "./title-writing-run";

const PA = "22222222-2222-4222-8222-222222222222";
const PB = "33333333-3333-4333-8333-333333333333";
const RUN_A = "66666666-6666-4666-8666-66666666000a";
const RUN_B = "66666666-6666-4666-8666-66666666000b";
const KEYS = ["concept", "outline", "episode:1", "episode:2", "episode:3"] as const;
const CANCEL_FAILED = "没能提交停止请求，请重试。";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function steps(state: TitleWritingStepView["state"]): TitleWritingStepView[] {
  return KEYS.map((stepKey, index) => ({ stepKey, state: index === 0 ? state : "pending", attemptNo: index === 0 ? 1 : 0,
    errorCode: null, output: null, text: null, scriptSave: stepKey.startsWith("episode:") ? "pending" : null, scriptRevisionId: null }));
}

function view(overrides: Partial<TitleWritingRunView> = {}, first: TitleWritingStepView["state"] = "submitted"): TitleWritingRunView {
  return {
    runId: RUN_A, projectId: PA, title: "作品甲", settings: { episodeCount: 3, episodeSeconds: 90, style: "" }, providerKey: "qwen",
    model: "q-1", state: "running", errorCode: null, cancelRequested: false, callCap: 8, callsUsed: 1, storySave: "pending", storyRevisionId: null,
    storyText: null, steps: steps(first), calls: [], createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z", ...overrides,
  };
}

interface Held { url: string; resolve: (response: Response) => void; reject: (error: unknown) => void }

/**
 * POSTs wait until the test settles them. A GET is answered with what `latest` holds when the server receives it; while
 * `holdGets` is on, that answer is held back until the test releases it, as a slow response would be. `maxGets` is the
 * largest number of GETs that were in flight at the same time.
 */
function server(latest: Record<string, TitleWritingRunView | null | Error>) {
  const posts: Held[] = [];
  const gets: string[] = [];
  const held: Array<{ release: () => void; fail: () => void }> = [];
  const state = { holdGets: false, inFlight: 0, maxGets: 0 };
  vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "POST") {
      return new Promise<Response>((resolve, reject) => { posts.push({ url: input, resolve, reject }); });
    }
    gets.push(input);
    state.inFlight += 1;
    state.maxGets = Math.max(state.maxGets, state.inFlight);
    const now = latest[input.includes(PB) ? PB : PA];
    const answer = () => now instanceof Error ? json({ error: { code: "INTERNAL", message: "暂时不可用" } }, 500) : json({ run: now ?? null });
    return new Promise<Response>((resolve, reject) => {
      const release = () => { state.inFlight -= 1; resolve(answer()); };
      const fail = () => { state.inFlight -= 1; reject(new TypeError("network")); };
      if (state.holdGets) held.push({ release, fail });
      else release();
    });
  }));
  return { posts, gets, held, state };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function settle() {
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
}

async function poll() {
  await act(async () => { await vi.advanceTimersByTimeAsync(TITLE_WRITING_POLL_MS); });
}

const headline = () => screen.getByRole("status").textContent;
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("P2-A: a late cancel failure", () => {
  it("after a newer snapshot already showed the run CANCELED, the late failure shows no contradicting message", async () => {
    const latest: Record<string, TitleWritingRunView | null> = { [PA]: view() };
    const { posts, gets } = server(latest);
    render(<TitleWritingRun projectId={PA} client={new TitleWritingClient()} />);
    fireEvent.click(await screen.findByRole("button", { name: "停止创作" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    latest[PA] = view({ state: "canceled", cancelRequested: true }, "canceled");
    await poll();
    await waitFor(() => expect(headline()).toBe("已取消"));

    await act(async () => { posts[0]!.reject(new TypeError("network")); });
    await settle();
    expect(screen.queryByText(CANCEL_FAILED)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(headline()).toBe("已取消");
    // Nothing was sent again and the finished run is not polled.
    const reads = gets.length;
    await poll();
    await poll();
    expect(posts).toHaveLength(1);
    expect(gets).toHaveLength(reads);
  });

  it("a newer snapshot that only shows the stop as requested also makes the late failure moot", async () => {
    const latest: Record<string, TitleWritingRunView | null> = { [PA]: view() };
    const { posts } = server(latest);
    render(<TitleWritingRun projectId={PA} client={new TitleWritingClient()} />);
    fireEvent.click(await screen.findByRole("button", { name: "停止创作" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    latest[PA] = view({ cancelRequested: true });
    await poll();
    await waitFor(() => expect(headline()).toBe("正在停止"));
    await act(async () => { posts[0]!.reject(new TypeError("network")); });
    await settle();
    expect(screen.queryByText(CANCEL_FAILED)).toBeNull();
  });

  it("a failure while the run is still shown running and not stopping is shown, and an unrelated poll does not hide it", async () => {
    const latest: Record<string, TitleWritingRunView | null> = { [PA]: view() };
    const { posts } = server(latest);
    render(<TitleWritingRun projectId={PA} client={new TitleWritingClient()} />);
    fireEvent.click(await screen.findByRole("button", { name: "停止创作" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    // A poll during the request still shows the run running, stop not requested.
    await poll();
    await act(async () => { posts[0]!.reject(new TypeError("network")); });
    await settle();
    expect(screen.getByRole("alert").textContent).toBe(CANCEL_FAILED);
    await poll();
    expect(screen.getByRole("alert").textContent).toBe(CANCEL_FAILED);
    expect(button("停止创作").disabled).toBe(false);
    expect(posts).toHaveLength(1);
  });

  it("a failure shown first is withdrawn once a later snapshot confirms the stop", async () => {
    const latest: Record<string, TitleWritingRunView | null> = { [PA]: view() };
    const { posts } = server(latest);
    render(<TitleWritingRun projectId={PA} client={new TitleWritingClient()} />);
    fireEvent.click(await screen.findByRole("button", { name: "停止创作" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    await act(async () => { posts[0]!.reject(new TypeError("network")); });
    await settle();
    expect(screen.getByRole("alert").textContent).toBe(CANCEL_FAILED);
    // The request reached the server after all; the next poll shows the run canceled.
    latest[PA] = view({ state: "canceled", cancelRequested: true }, "canceled");
    await poll();
    await waitFor(() => expect(headline()).toBe("已取消"));
    expect(screen.queryByText(CANCEL_FAILED)).toBeNull();
  });

  it("after the work changed, or after the run changed, a late cancel failure shows nothing", async () => {
    const latest: Record<string, TitleWritingRunView | null> = {
      [PA]: view(),
      [PB]: view({ runId: RUN_B, projectId: PB, title: "作品乙" }),
    };
    const { posts } = server(latest);
    const client = new TitleWritingClient();
    const page = render(<TitleWritingRun projectId={PA} client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "停止创作" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    page.rerender(<TitleWritingRun projectId={PB} client={client} />);
    await screen.findByText("《作品乙》");
    await act(async () => { posts[0]!.reject(new TypeError("network")); });
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();

    // The same work, a newer run.
    fireEvent.click(button("停止创作"));
    await waitFor(() => expect(posts).toHaveLength(2));
    latest[PB] = view({ runId: RUN_A, projectId: PB, title: "作品乙第二次", createdAt: "2026-10-08T00:01:00Z" });
    await poll();
    await screen.findByText("《作品乙第二次》");
    await act(async () => { posts[1]!.reject(new TypeError("network")); });
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(button("停止创作").disabled).toBe(false);
  });
});

describe("P2-B: reads of one run never overlap", () => {
  it("an action answer during a slow poll waits for it, then reads once more; the old poll answer is not taken as final", async () => {
    const latest: Record<string, TitleWritingRunView | null> = { [PA]: view() };
    const { posts, gets, held, state } = server(latest);
    render(<TitleWritingRun projectId={PA} client={new TitleWritingClient()} />);
    fireEvent.click(await screen.findByRole("button", { name: "停止创作" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    // One poll is answered while the stop is on its way, so the action's answer is no longer known to be the newest.
    await poll();
    expect(gets).toHaveLength(2);
    // The next poll is slow: the server read the run before it applied the stop.
    state.holdGets = true;
    await poll();
    expect(gets).toHaveLength(3);
    latest[PA] = view({ cancelRequested: true });
    await act(async () => { posts[0]!.resolve(json({ run: view({ cancelRequested: true }) })); });
    await settle();
    // The answer asked for a read; none starts while the slow one is in flight.
    expect(gets).toHaveLength(3);
    expect(state.inFlight).toBe(1);
    state.holdGets = false;
    await act(async () => { held.shift()!.release(); });
    await waitFor(() => expect(gets).toHaveLength(4));
    await waitFor(() => expect(headline()).toBe("正在停止"));
    expect(state.maxGets).toBe(1);
  });

  it("an action answer shown directly during a slow poll is not replaced by that poll's older answer", async () => {
    const latest: Record<string, TitleWritingRunView | null> = { [PA]: view() };
    const { posts, gets, held, state } = server(latest);
    render(<TitleWritingRun projectId={PA} client={new TitleWritingClient()} />);
    fireEvent.click(await screen.findByRole("button", { name: "停止创作" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    state.holdGets = true;
    await poll();
    expect(gets).toHaveLength(2);
    latest[PA] = view({ cancelRequested: true });
    await act(async () => { posts[0]!.resolve(json({ run: view({ cancelRequested: true }) })); });
    await waitFor(() => expect(headline()).toBe("正在停止"));
    state.holdGets = false;
    // The slow poll still carries the state from before the stop.
    await act(async () => { held.shift()!.release(); });
    await settle();
    expect(gets).toHaveLength(3);
    expect(headline()).toBe("正在停止");
    expect(state.maxGets).toBe(1);
  });

  it("re-read requests during a slow read merge into one; a failed read can still be re-read", async () => {
    const latest: Record<string, TitleWritingRunView | null | Error> = { [PA]: new Error("down") };
    const { gets, held, state } = server(latest);
    render(<TitleWritingRun projectId={PA} client={new TitleWritingClient()} />);
    await screen.findByText("暂时读不到创作进度。已显示的内容仍是上次读到的结果。");
    expect(gets).toHaveLength(1);
    state.holdGets = true;
    fireEvent.click(button("重新读取"));
    await settle();
    expect(gets).toHaveLength(2);
    fireEvent.click(button("重新读取"));
    fireEvent.click(button("重新读取"));
    fireEvent.click(button("重新读取"));
    await settle();
    expect(gets).toHaveLength(2);
    latest[PA] = view({ state: "completed", storySave: "saved" }, "completed");
    state.holdGets = false;
    await act(async () => { held.shift()!.fail(); });
    await waitFor(() => expect(gets).toHaveLength(3));
    await waitFor(() => expect(headline()).toBe("创作完成"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(state.maxGets).toBe(1);
    await poll();
    expect(gets).toHaveLength(3);
  });

  it("a finished run leaves no timer; unmounting during a slow read writes nothing and schedules nothing", async () => {
    const latest: Record<string, TitleWritingRunView | null> = { [PA]: view() };
    const { gets, held, state } = server(latest);
    const errors = vi.spyOn(console, "error");
    const page = render(<TitleWritingRun projectId={PA} client={new TitleWritingClient()} />);
    await waitFor(() => expect(headline()).toBe("正在构思故事"));
    expect(vi.getTimerCount()).toBe(1);
    latest[PA] = view({ state: "completed", storySave: "saved" }, "completed");
    await poll();
    await waitFor(() => expect(headline()).toBe("创作完成"));
    expect(vi.getTimerCount()).toBe(0);
    page.unmount();

    latest[PA] = view();
    render(<TitleWritingRun projectId={PA} client={new TitleWritingClient()} />);
    await waitFor(() => expect(headline()).toBe("正在构思故事"));
    state.holdGets = true;
    await poll();
    const reads = gets.length;
    cleanup();
    await act(async () => { held.shift()!.release(); });
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    await poll();
    expect(gets).toHaveLength(reads);
    expect(errors.mock.calls.filter((call) => String(call[0]).includes("unmounted"))).toHaveLength(0);
  });
});
