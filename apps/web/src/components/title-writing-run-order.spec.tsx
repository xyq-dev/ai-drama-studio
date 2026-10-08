// @vitest-environment happy-dom
// Order of answers on the progress page: a late action answer never replaces a newer run or a newer state of the same
// run. Simulated interface tests: fetch is mocked; no browser, API or model.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TitleWritingRunView, TitleWritingStepView } from "@ai-drama/contracts";
import { TitleWritingClient } from "../lib/title-writing-client";
import { TITLE_WRITING_POLL_MS, TitleWritingRun } from "./title-writing-run";

const PA = "22222222-2222-4222-8222-222222222222";
const PB = "33333333-3333-4333-8333-333333333333";
const RUN_A = "66666666-6666-4666-8666-66666666000a";
const RUN_B = "66666666-6666-4666-8666-66666666000b";
const TOKEN = "operator-token-0123456789";
const KEYS = ["concept", "outline", "episode:1", "episode:2", "episode:3"] as const;

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

function completedWithScripts(overrides: Partial<TitleWritingRunView> = {}): TitleWritingRunView {
  const done = KEYS.map((stepKey) => ({ stepKey, state: "completed" as const, attemptNo: 1, errorCode: null, output: null,
    text: stepKey.startsWith("episode:") ? `${stepKey} 正文` : null,
    scriptSave: stepKey.startsWith("episode:") ? "awaiting_story_approval" as const : null, scriptRevisionId: null }));
  return view({ state: "completed", storySave: "saved", steps: done, ...overrides });
}

interface Held { url: string; resolve: (response: Response) => void; reject: (error: unknown) => void }

/** GETs answer with what `latest` holds for that work at that moment; POSTs wait until the test settles them. */
function server(latest: Record<string, TitleWritingRunView | null>) {
  const posts: Held[] = [];
  const gets: string[] = [];
  vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "POST") {
      return new Promise<Response>((resolve, reject) => { posts.push({ url: input, resolve, reject }); });
    }
    gets.push(input);
    return Promise.resolve(json({ run: latest[input.includes(PB) ? PB : PA] ?? null }));
  }));
  return { posts, gets };
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

describe("F3: a late action answer of the same work", () => {
  it("cancel of run A is pending, a poll shows the newer run B: A's late success changes nothing and B is free to act", async () => {
    const latest: Record<string, TitleWritingRunView | null> = { [PA]: view() };
    const { posts } = server(latest);
    render(<TitleWritingRun projectId={PA} client={new TitleWritingClient()} />);
    fireEvent.click(await screen.findByRole("button", { name: "停止创作" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    latest[PA] = view({ runId: RUN_B, title: "新的一次", createdAt: "2026-10-08T00:01:00Z", updatedAt: "2026-10-08T00:01:00Z" });
    await poll();
    expect(await screen.findByText("《新的一次》")).toBeTruthy();
    expect(button("停止创作").disabled).toBe(false);

    await act(async () => { posts[0]!.resolve(json({ run: view({ cancelRequested: true }) })); });
    await settle();
    expect(screen.getByText("《新的一次》")).toBeTruthy();
    expect(headline()).not.toBe("正在停止");
    expect(button("停止创作").disabled).toBe(false);
    fireEvent.click(button("停止创作"));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]!.url).toBe(`/api/v1/projects/${PA}/title-runs/${RUN_B}/cancel`);
  });

  it("A's late failure and finally neither show an error nor end B's own pending action", async () => {
    const latest: Record<string, TitleWritingRunView | null> = { [PA]: view() };
    const { posts } = server(latest);
    render(<TitleWritingRun projectId={PA} client={new TitleWritingClient()} />);
    fireEvent.click(await screen.findByRole("button", { name: "停止创作" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    latest[PA] = view({ runId: RUN_B, title: "新的一次" });
    await poll();
    await screen.findByText("《新的一次》");
    fireEvent.click(button("停止创作"));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(button("停止创作").disabled).toBe(true);
    await act(async () => { posts[0]!.resolve(json({ error: { code: "NOT_FOUND", message: "没有找到这次创作。" } }, 404)); });
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(button("停止创作").disabled).toBe(true);
    await act(async () => { posts[1]!.resolve(json({ run: view({ runId: RUN_B, title: "新的一次", cancelRequested: true }) })); });
    await waitFor(() => expect(headline()).toBe("正在停止"));
  });

  it("an older cancel snapshot (RUNNING, stop requested) does not replace the CANCELED state a poll already showed", async () => {
    const latest: Record<string, TitleWritingRunView | null> = { [PA]: view() };
    const { posts, gets } = server(latest);
    render(<TitleWritingRun projectId={PA} client={new TitleWritingClient()} />);
    fireEvent.click(await screen.findByRole("button", { name: "停止创作" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    latest[PA] = view({ state: "canceled", cancelRequested: true, updatedAt: "2026-10-08T00:00:05Z" }, "canceled");
    await poll();
    await waitFor(() => expect(headline()).toBe("已取消"));

    await act(async () => { posts[0]!.resolve(json({ run: view({ cancelRequested: true, updatedAt: "2026-10-08T00:00:02Z" }) })); });
    await settle();
    expect(headline()).toBe("已取消");
    expect(screen.queryByRole("button", { name: "停止创作" })).toBeNull();
    // The page asked once more instead of guessing, then stopped polling: the run is over.
    const reads = gets.length;
    await poll();
    await poll();
    expect(gets).toHaveLength(reads);
  });

  it("a newer cancel answer than the poll is still shown after one serial re-read, and polling continues once", async () => {
    const latest: Record<string, TitleWritingRunView | null> = { [PA]: view() };
    const { posts, gets } = server(latest);
    render(<TitleWritingRun projectId={PA} client={new TitleWritingClient()} />);
    fireEvent.click(await screen.findByRole("button", { name: "停止创作" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    // The poll was answered before the server applied the stop.
    await poll();
    latest[PA] = view({ cancelRequested: true });
    await act(async () => { posts[0]!.resolve(json({ run: view({ cancelRequested: true }) })); });
    await waitFor(() => expect(headline()).toBe("正在停止"));
    const reads = gets.length;
    await poll();
    expect(gets).toHaveLength(reads + 1);
    await poll();
    expect(gets).toHaveLength(reads + 2);
  });

  it("an explicit resume of a canceled run may make it run again", async () => {
    const latest: Record<string, TitleWritingRunView | null> = { [PA]: view({ state: "canceled", cancelRequested: true }, "canceled") };
    const { posts, gets } = server(latest);
    render(<TitleWritingRun projectId={PA} client={new TitleWritingClient()} />);
    await waitFor(() => expect(headline()).toBe("已取消"));
    fireEvent.change(screen.getByLabelText("操作者令牌"), { target: { value: TOKEN } });
    fireEvent.click(button("继续创作"));
    await waitFor(() => expect(posts).toHaveLength(1));
    latest[PA] = view({ updatedAt: "2026-10-08T00:00:09Z" });
    await act(async () => { posts[0]!.resolve(json({ run: view({ updatedAt: "2026-10-08T00:00:09Z" }) })); });
    await waitFor(() => expect(headline()).toBe("正在构思故事"));
    const reads = gets.length;
    await poll();
    expect(gets).toHaveLength(reads + 1);
  });
});

describe("F3: late resume and script answers after the work changed", () => {
  it("a late resume answer and error of work A leave work B's own pending resume busy and unchanged", async () => {
    const latest: Record<string, TitleWritingRunView | null> = {
      [PA]: view({ state: "partial" }, "rejected"),
      [PB]: view({ runId: RUN_B, projectId: PB, title: "作品乙", state: "partial" }, "rejected"),
    };
    const { posts } = server(latest);
    const client = new TitleWritingClient();
    const page = render(<TitleWritingRun projectId={PA} client={client} />);
    await waitFor(() => expect(headline()).toBe("部分完成"));
    fireEvent.change(screen.getByLabelText("操作者令牌"), { target: { value: TOKEN } });
    fireEvent.click(button("继续创作"));
    await waitFor(() => expect(posts).toHaveLength(1));
    page.rerender(<TitleWritingRun projectId={PB} client={client} />);
    await screen.findByText("《作品乙》");
    fireEvent.change(screen.getByLabelText("操作者令牌"), { target: { value: TOKEN } });
    fireEvent.click(button("继续创作"));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]!.url).toBe(`/api/v1/projects/${PB}/title-runs/${RUN_B}/resume`);
    await act(async () => { posts[0]!.reject(new TypeError("network")); });
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(button("继续创作").disabled).toBe(true);
    await act(async () => { posts[1]!.resolve(json({ run: view({ runId: RUN_B, projectId: PB, title: "作品乙" }) })); });
    await waitFor(() => expect(headline()).toBe("正在构思故事"));
    expect(screen.getByText("《作品乙》")).toBeTruthy();
  });

  it("A → B → A: a late script placement answer of the first visit does not change the second", async () => {
    const latest: Record<string, TitleWritingRunView | null> = {
      [PA]: completedWithScripts(),
      [PB]: view({ runId: RUN_B, projectId: PB, title: "作品乙" }),
    };
    const { posts } = server(latest);
    const client = new TitleWritingClient();
    const page = render(<TitleWritingRun projectId={PA} client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "写入剧本草稿" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    page.rerender(<TitleWritingRun projectId={PB} client={client} />);
    await screen.findByText("《作品乙》");
    page.rerender(<TitleWritingRun projectId={PA} client={client} />);
    await screen.findByRole("button", { name: "写入剧本草稿" });
    const saved = completedWithScripts({ title: "旧回执" });
    saved.steps = saved.steps.map((step) => step.stepKey.startsWith("episode:") ? { ...step, scriptSave: "saved" } : step);
    await act(async () => { posts[0]!.resolve(json({ run: saved })); });
    await settle();
    expect(screen.queryByText("《旧回执》")).toBeNull();
    expect(screen.queryByText(/已写入剧本草稿/)).toBeNull();
    expect(button("写入剧本草稿").disabled).toBe(false);
  });
});
