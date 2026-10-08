// @vitest-environment happy-dom
// Late answers to write actions on the progress page. Simulated interface tests: fetch is mocked; no browser, API or model.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TitleWritingRunView, TitleWritingStepView } from "@ai-drama/contracts";
import { TitleWritingClient } from "../lib/title-writing-client";
import { TITLE_WRITING_POLL_MS, TitleWritingRun } from "./title-writing-run";

const PA = "22222222-2222-4222-8222-222222222222";
const PB = "33333333-3333-4333-8333-333333333333";
const RUN_A = "66666666-6666-4666-8666-66666666000a";
const RUN_B = "66666666-6666-4666-8666-66666666000b";
const KEYS = ["concept", "outline", "episode:1", "episode:2", "episode:3"] as const;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function view(projectId: string, title: string, overrides: Partial<TitleWritingRunView> = {}): TitleWritingRunView {
  const steps: TitleWritingStepView[] = KEYS.map((stepKey, index) => ({ stepKey, state: index === 0 ? "submitted" : "pending",
    attemptNo: index === 0 ? 1 : 0, errorCode: null, output: null, text: null, scriptSave: stepKey.startsWith("episode:") ? "pending" : null,
    scriptRevisionId: null }));
  return {
    runId: projectId === PA ? RUN_A : RUN_B, projectId, title, settings: { episodeCount: 3, episodeSeconds: 90, style: "" }, providerKey: "qwen",
    model: "q-1", state: "running", errorCode: null, cancelRequested: false, callCap: 8, callsUsed: 1, storySave: "pending", storyRevisionId: null,
    storyText: null, steps, calls: [], createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z", ...overrides,
  };
}

interface Pending { url: string; resolve: (response: Response) => void; reject: (error: unknown) => void }

/** GETs answer at once with the work's own run; POSTs wait until the test settles them. */
function server() {
  const posts: Pending[] = [];
  const gets: string[] = [];
  vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "POST") {
      return new Promise<Response>((resolve, reject) => { posts.push({ url: input, resolve, reject }); });
    }
    gets.push(input);
    return Promise.resolve(json({ run: input.includes(PB) ? view(PB, "作品乙") : view(PA, "作品甲") }));
  }));
  return { posts, gets };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

describe("late write answers stay with their own work", () => {
  it("a late cancel success of work A does not replace work B, its busy state or its polling", async () => {
    const { posts, gets } = server();
    const client = new TitleWritingClient();
    const page = render(<TitleWritingRun projectId={PA} client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "停止创作" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    page.rerender(<TitleWritingRun projectId={PB} client={client} />);
    expect(await screen.findByText("《作品乙》")).toBeTruthy();
    const stopB = screen.getByRole("button", { name: "停止创作" }) as HTMLButtonElement;
    expect(stopB.disabled).toBe(false);
    await act(async () => { posts[0]!.resolve(json({ run: view(PA, "作品甲", { cancelRequested: true }) })); });
    await settle();
    expect(screen.queryByText("《作品甲》")).toBeNull();
    expect(screen.queryByText("正在停止")).toBeNull();
    expect(screen.getByText("《作品乙》")).toBeTruthy();
    expect((screen.getByRole("button", { name: "停止创作" }) as HTMLButtonElement).disabled).toBe(false);
    // B's own action still works and goes to B.
    fireEvent.click(screen.getByRole("button", { name: "停止创作" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]!.url).toBe(`/api/v1/projects/${PB}/title-runs/${RUN_B}/cancel`);
    expect(gets.every((url) => url.includes(PA) || url.includes(PB))).toBe(true);
  });

  it("a late failure of work A shows no error and leaves B's busy state alone", async () => {
    const { posts } = server();
    const client = new TitleWritingClient();
    const page = render(<TitleWritingRun projectId={PA} client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "停止创作" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    page.rerender(<TitleWritingRun projectId={PB} client={client} />);
    expect(await screen.findByText("《作品乙》")).toBeTruthy();
    await act(async () => { posts[0]!.resolve(json({ error: { code: "NOT_FOUND", message: "没有找到这次创作。" } }, 404)); });
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => { posts.length = 0; });
    fireEvent.click(screen.getByRole("button", { name: "停止创作" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    await act(async () => { posts[0]!.reject(new TypeError("network")); });
    expect((await screen.findByRole("alert")).textContent).toContain("没能提交停止请求");
  });

  it("A → B → A: an answer to the first visit of A does not change the second visit", async () => {
    const { posts } = server();
    const client = new TitleWritingClient();
    const page = render(<TitleWritingRun projectId={PA} client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "停止创作" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    page.rerender(<TitleWritingRun projectId={PB} client={client} />);
    expect(await screen.findByText("《作品乙》")).toBeTruthy();
    page.rerender(<TitleWritingRun projectId={PA} client={client} />);
    expect(await screen.findByText("《作品甲》")).toBeTruthy();
    await act(async () => { posts[0]!.resolve(json({ run: view(PA, "作品甲", { cancelRequested: true, title: "旧回执" }) })); });
    await settle();
    expect(screen.queryByText("《旧回执》")).toBeNull();
    expect(screen.queryByText("正在停止")).toBeNull();
    expect((screen.getByRole("button", { name: "停止创作" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("after unmount a late answer schedules no further read", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const { posts, gets } = server();
    const page = render(<TitleWritingRun projectId={PA} client={new TitleWritingClient()} />);
    fireEvent.click(await screen.findByRole("button", { name: "停止创作" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    page.unmount();
    const readsAtUnmount = gets.length;
    await act(async () => { posts[0]!.resolve(json({ run: view(PA, "作品甲", { cancelRequested: true }) })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(TITLE_WRITING_POLL_MS * 5); });
    expect(gets).toHaveLength(readsAtUnmount);
  });
});
