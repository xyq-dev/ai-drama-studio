// @vitest-environment happy-dom
// Simulated interface tests. fetch is mocked; this file does not start a browser or a backend.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BeginnerStart } from "./beginner-start";
import { MyWorks } from "./my-works";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  assign = vi.fn();
  Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, assign, search: "" } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe("beginner start page", () => {
  it("never creates a project while typing, choosing a template or opening inspiration", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${input}`);
      return Promise.resolve(json({ items: [], nextCursor: null }));
    }));
    render(<BeginnerStart active="/create" />);
    expect(screen.getByRole("heading", { name: "你的故事，从一句话开始" })).toBeTruthy();
    expect(screen.getByText("不用会写剧本，先告诉我你想拍什么。")).toBeTruthy();
    expect(screen.getByRole("link", { name: "还没想法？看看灵感" }).getAttribute("href")).toBe("/categories");
    expect(screen.getByText(/固定三集、竖屏 9:16/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("你想拍一个什么样的故事？"), { target: { value: "一个外卖员的故事" } });
    fireEvent.click(screen.getByRole("button", { name: "示例 · 家庭情感" }));
    expect((screen.getByLabelText("你想拍一个什么样的故事？") as HTMLTextAreaElement).value).toContain("回到老家");
    fireEvent.click(screen.getByRole("button", { name: "开始构思" }));
    expect(await screen.findByRole("heading", { name: "确认创建作品" })).toBeTruthy();
    // The suggested name is cut from the user's own words and says so.
    expect((screen.getByLabelText("作品名称") as HTMLInputElement).value).toBe("在外打拼十年的女儿回到老…");
    expect(screen.getByText(/不是 AI 生成/)).toBeTruthy();
    expect(calls.filter((call) => call.startsWith("POST"))).toEqual([]);
  });

  it("asks for an idea before confirming", () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(json({ items: [], nextCursor: null }))));
    render(<BeginnerStart active={undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "开始构思" }));
    expect(screen.getByRole("alert").textContent).toBe("先写下一句你想拍的故事。");
    expect(screen.queryByRole("heading", { name: "确认创建作品" })).toBeNull();
  });

  it("creates on confirmation only, keeps the input and the key after an unsure failure, then opens the beginner flow", async () => {
    const posts: Array<{ body: unknown; key: string | null }> = [];
    let fail = true;
    vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push({ body: JSON.parse(String(init.body)), key: new Headers(init.headers).get("Idempotency-Key") });
        if (fail) return Promise.reject(new TypeError("network down"));
        return Promise.resolve(json({ id: "11111111-1111-4111-8111-111111111111", title: "夜班" }, 201));
      }
      return Promise.resolve(json({ items: [{ id: "old", title: "上一部作品" }], nextCursor: null }));
    }));
    render(<BeginnerStart active="/create" />);
    expect((await screen.findByRole("link", { name: "继续上次创作：上一部作品" })).getAttribute("href")).toBe("/projects/old/create");
    fireEvent.change(screen.getByLabelText("你想拍一个什么样的故事？"), { target: { value: "夜班，店员发现记录被改。" } });
    fireEvent.click(screen.getByRole("button", { name: "开始构思" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认创建作品" }));
    expect((await screen.findByRole("alert")).textContent).toContain("没有确认作品是否已创建");
    expect((screen.getByLabelText("你想拍一个什么样的故事？") as HTMLTextAreaElement).value).toBe("夜班，店员发现记录被改。");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "确认创建作品" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/projects/11111111-1111-4111-8111-111111111111/create"));
    expect(posts).toHaveLength(2);
    expect(posts[0]?.body).toEqual({ title: "夜班", premise: "夜班，店员发现记录被改。" });
    expect(posts[1]?.key).toBe(posts[0]?.key);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("does not lose input written while a slow create is pending (review P1)", async () => {
    let resolve!: (response: Response) => void;
    const posts: string[] = [];
    vi.stubGlobal("fetch", vi.fn((_input: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push(String(init.body));
        return new Promise<Response>((done) => { resolve = done; });
      }
      return Promise.resolve(json({ items: [], nextCursor: null }));
    }));
    render(<BeginnerStart active="/create" />);
    const idea = screen.getByLabelText("你想拍一个什么样的故事？") as HTMLTextAreaElement;
    fireEvent.change(idea, { target: { value: "旧梗概" } });
    fireEvent.click(screen.getByRole("button", { name: "开始构思" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认创建作品" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    // While the request is in flight every control that changes the request is frozen.
    expect(idea.disabled).toBe(true);
    expect((screen.getByLabelText("作品名称") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "示例 · 家庭情感" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("正在创建，内容已锁定，完成前不能修改。")).toBeTruthy();
    fireEvent.change(idea, { target: { value: "旧梗概，新结局" } });
    const submitted = window.sessionStorage.getItem("ads-draft:new:project:new");
    expect(submitted).toContain("旧梗概");
    expect(submitted).not.toContain("新结局");
    // A newer draft written to the slot meanwhile must survive the old request's success.
    const newer = JSON.stringify({ ...JSON.parse(submitted!), payload: { title: "旧梗概", premise: "后来写的新结局" }, fingerprint: "newer" });
    window.sessionStorage.setItem("ads-draft:new:project:new", newer);
    resolve(json({ id: "11111111-1111-4111-8111-111111111111", title: "旧梗概" }, 201));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/projects/11111111-1111-4111-8111-111111111111/create"));
    expect(JSON.parse(posts[0]!)).toEqual({ title: "旧梗概", premise: "旧梗概" });
    expect(window.sessionStorage.getItem("ads-draft:new:project:new")).toBe(newer);
  });

  it("restores an unfinished create after a reload with the same key", async () => {
    const posts: Array<string | null> = [];
    vi.stubGlobal("fetch", vi.fn((_input: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push(new Headers(init.headers).get("Idempotency-Key"));
        return Promise.resolve(json({ error: { code: "VALIDATION_ERROR", message: "标题过长" } }, 400));
      }
      return Promise.resolve(json({ items: [], nextCursor: null }));
    }));
    const first = render(<BeginnerStart active="/create" />);
    fireEvent.change(screen.getByLabelText("你想拍一个什么样的故事？"), { target: { value: "回家" } });
    fireEvent.click(screen.getByRole("button", { name: "开始构思" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认创建作品" }));
    expect((await screen.findByRole("alert")).textContent).toContain("作品没有创建：标题过长");
    first.unmount();
    render(<BeginnerStart active="/create" />);
    expect(await screen.findByRole("heading", { name: "确认创建作品" })).toBeTruthy();
    expect((screen.getByLabelText("你想拍一个什么样的故事？") as HTMLTextAreaElement).value).toBe("回家");
    fireEvent.click(screen.getByRole("button", { name: "确认创建作品" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toBe(posts[0]);
  });
});

const PROJECT = "22222222-2222-4222-8222-222222222222";

describe("my works", () => {
  function stubProject(stage: "fresh" | "story-draft" | "failed") {
    vi.stubGlobal("fetch", vi.fn((input: string) => {
      const path = String(input);
      if (path === "/api/v1/projects") return Promise.resolve(json({ items: [{ id: PROJECT, title: "夜班", premise: "店员" }], nextCursor: null }));
      if (stage === "failed") return Promise.resolve(json({ error: { code: "DOWN", message: "x" } }, 503));
      if (path.endsWith("/stories")) {
        return Promise.resolve(json({ items: stage === "story-draft" ? [{ id: "s", revisionNo: 1, content: {}, reviewStatus: "DRAFT",
          freshnessStatus: "CURRENT", reviewVersion: 1, staleReason: null, staleFromRef: null, reviewNote: null }] : [] }));
      }
      if (path.endsWith("/workflow-runs")) return Promise.resolve(json([]));
      return Promise.resolve(json({ items: [], nextCursor: null }));
    }));
  }

  it("names each project's stage from its real content", async () => {
    stubProject("story-draft");
    render(<MyWorks />);
    expect(await screen.findByText(/当前阶段：第 1 步 定故事 · ？ 待确认/)).toBeTruthy();
    expect(screen.getByText("定故事：有内容等你检查确认")).toBeTruthy();
    expect(screen.getByRole("link", { name: "继续创作" }).getAttribute("href")).toBe(`/projects/${PROJECT}/create`);
    expect(screen.getByRole("link", { name: "高级编辑" }).getAttribute("href")).toBe(`/projects/${PROJECT}`);
  });

  it("starts a new project at 定故事 and offers a retry when progress cannot be read", async () => {
    stubProject("fresh");
    const view = render(<MyWorks />);
    expect(await screen.findByText(/第 1 步 定故事 · ○ 未开始/)).toBeTruthy();
    view.unmount();
    stubProject("failed");
    render(<MyWorks />);
    expect(await screen.findByText(/进度读取失败/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/%/);
  });

  it("names the stage when local compose is not configured instead of failing the card", async () => {
    vi.stubGlobal("fetch", vi.fn((input: string) => {
      const path = String(input);
      if (path === "/api/v1/projects") return Promise.resolve(json({ items: [{ id: PROJECT, title: "夜班", premise: "" }], nextCursor: null }));
      if (path.endsWith("/stories")) {
        return Promise.resolve(json({ items: [{ id: "s", revisionNo: 1, content: {}, reviewStatus: "APPROVED", freshnessStatus: "CURRENT",
          reviewVersion: 1, staleReason: null, staleFromRef: null, reviewNote: null }] }));
      }
      if (path.endsWith("/episodes")) {
        return Promise.resolve(json({ items: [{ id: "e1", episodeNo: 1, title: "", rowVersion: 1, currentScriptRevisionId: "r",
          approvedScriptRevisionId: "r", currentScriptReviewStatus: "APPROVED", currentScriptFreshnessStatus: "CURRENT" }] }));
      }
      if (path.includes("/compose-candidates") || path.includes("/composites")) {
        return Promise.resolve(json({ error: { code: "CONFIGURATION_ERROR", message: "Local compose is not enabled" } }, 503));
      }
      if (path.endsWith("/workflow-runs")) return Promise.resolve(json([]));
      return Promise.resolve(json({ items: [], nextCursor: null }));
    }));
    render(<MyWorks />);
    expect(await screen.findByText(/当前阶段：第 2 步 看剧本/)).toBeTruthy();
    expect(screen.queryByText(/进度读取失败/)).toBeNull();
  });

  it("loads the next page once even when 加载更多作品 is clicked twice (review)", async () => {
    let releasePage!: () => void;
    const pageHold = new Promise<void>((done) => { releasePage = done; });
    const pageRequests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = String(input);
      if (url === "/api/v1/projects") return json({ items: [{ id: "a", title: "第一部", premise: "" }], nextCursor: "next" });
      if (url.startsWith("/api/v1/projects?cursor=")) {
        pageRequests.push(url);
        await pageHold;
        return json({ items: [{ id: "b", title: "第二部", premise: "" }], nextCursor: null });
      }
      if (url.endsWith("/workflow-runs")) return json([]);
      return json({ items: [], nextCursor: null });
    }));
    render(<MyWorks />);
    const more = await screen.findByRole("button", { name: "加载更多作品" });
    fireEvent.click(more);
    fireEvent.click(more);
    await act(async () => { releasePage(); await pageHold; });
    expect(await screen.findByRole("heading", { name: "第二部" })).toBeTruthy();
    expect(pageRequests).toHaveLength(1);
    expect(screen.getAllByRole("heading", { name: "第二部" })).toHaveLength(1);
  });

  it("shows a failed list as an error, not sample works", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(json({ error: { code: "DOWN", message: "服务不可用" } }, 503))));
    render(<MyWorks />);
    expect((await screen.findByRole("alert")).textContent).toContain("不会显示示例作品");
  });
});

describe("my works refreshes cards whose workflows run (Issue #52 item 6)", () => {
  let visibility: "visible" | "hidden" = "visible";

  interface Card { story: string; runs: string; fail?: boolean }

  function stubCards(cards: Record<string, Card>) {
    const reads: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = String(input);
      if (path === "/api/v1/projects") {
        return json({ items: Object.keys(cards).map((id) => ({ id, title: `作品${id}`, premise: "" })), nextCursor: null });
      }
      const id = Object.keys(cards).find((key) => path.includes(`/projects/${key}/`));
      const card = id ? cards[id] : undefined;
      if (!card) return json({ items: [], nextCursor: null });
      if (path.endsWith("/stories")) {
        reads.push(id!);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        if (card.fail) return json({ error: { code: "DOWN", message: "x" } }, 503);
        return json({ items: [{ id: "s", revisionNo: 1, content: {}, reviewStatus: card.story, freshnessStatus: "CURRENT",
          reviewVersion: 1, staleReason: null, staleFromRef: null, reviewNote: null }] });
      }
      if (path.endsWith("/workflow-runs")) {
        return json([{ id: "run", type: "TEXT_STORY", status: card.runs, createdAt: "2026-10-07T00:00:00.000Z", jobs: [] }]);
      }
      return json({ items: [], nextCursor: null });
    }));
    return { reads, maxInFlight: () => maxInFlight };
  }

  function setVisibility(next: "visible" | "hidden") {
    visibility = next;
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  }

  async function advance(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rereads a running card until its workflow ends, then stops", async () => {
    const card: Card = { story: "DRAFT", runs: "RUNNING" };
    const { reads } = stubCards({ a: card });
    render(<MyWorks />);
    expect(await screen.findByText(/有任务正在处理，进度会自动刷新/)).toBeTruthy();
    card.story = "APPROVED";
    card.runs = "SUCCEEDED";
    await advance(5000);
    expect(await screen.findByText(/当前阶段：第 2 步 看剧本/)).toBeTruthy();
    expect(screen.queryByText(/有任务正在处理/)).toBeNull();
    const count = reads.length;
    await advance(120_000);
    expect(reads.length).toBe(count);
  });

  it("does not read while hidden and rereads when the page is visible again", async () => {
    const card: Card = { story: "DRAFT", runs: "RUNNING" };
    const { reads } = stubCards({ a: card });
    render(<MyWorks />);
    await screen.findByText(/有任务正在处理/);
    setVisibility("hidden");
    const count = reads.length;
    await advance(60_000);
    expect(reads.length).toBe(count);
    card.story = "APPROVED";
    card.runs = "SUCCEEDED";
    setVisibility("visible");
    expect(await screen.findByText(/当前阶段：第 2 步 看剧本/)).toBeTruthy();
    expect(reads.length).toBe(count + 1);
  });

  it("is bounded: a card that keeps running pauses and offers a manual refresh", async () => {
    const card: Card = { story: "DRAFT", runs: "RUNNING" };
    const { reads } = stubCards({ a: card });
    render(<MyWorks />);
    await screen.findByText(/有任务正在处理/);
    await advance(5000 * 30);
    expect(reads.length).toBeLessThanOrEqual(1 + 24);
    const button = await screen.findByRole("button", { name: "刷新进度" });
    const count = reads.length;
    await advance(60_000);
    expect(reads.length).toBe(count);
    card.runs = "SUCCEEDED";
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByText(/已暂停自动刷新/)).toBeNull());
    expect(reads.length).toBe(count + 1);
  });

  it("does not start a queued reread while hidden, and starts it once when visible again (PR #53 review 4)", async () => {
    const cards: Record<string, Card> = { a: { story: "DRAFT", runs: "RUNNING" }, b: { story: "DRAFT", runs: "RUNNING" },
      c: { story: "DRAFT", runs: "RUNNING" } };
    const started: Array<{ id: string; visibility: string }> = [];
    const holds = new Map<string, () => void>();
    let holdRereads = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = String(input);
      if (path === "/api/v1/projects") return json({ items: Object.keys(cards).map((id) => ({ id, title: `作品${id}`, premise: "" })), nextCursor: null });
      const id = Object.keys(cards).find((key) => path.includes(`/projects/${key}/`));
      if (!id) return json({ items: [], nextCursor: null });
      if (path.endsWith("/stories")) {
        started.push({ id, visibility });
        if (holdRereads && id !== "c") await new Promise<void>((done) => { holds.set(id, done); });
        return json({ items: [{ id: "s", revisionNo: 1, content: {}, reviewStatus: cards[id]!.story, freshnessStatus: "CURRENT",
          reviewVersion: 1, staleReason: null, staleFromRef: null, reviewNote: null }] });
      }
      if (path.endsWith("/workflow-runs")) return json([{ id: "run", type: "TEXT_STORY", status: cards[id]!.runs, createdAt: "2026-10-07T00:00:00.000Z", jobs: [] }]);
      return json({ items: [], nextCursor: null });
    }));
    const view = render(<MyWorks />);
    await waitFor(() => expect(screen.getAllByText(/有任务正在处理/)).toHaveLength(3));
    // All three rereads fall due together; A and B are slow and fill both slots, C waits in the queue.
    holdRereads = true;
    started.length = 0;
    await advance(5000);
    await waitFor(() => expect(holds.size).toBe(2));
    expect(started.map((item) => item.id).sort()).toEqual(["a", "b"]);
    setVisibility("hidden");
    await act(async () => { holds.get("a")!(); });
    await advance(100);
    // A freed a slot while hidden: C must not start.
    expect(started.filter((item) => item.id === "c")).toHaveLength(0);
    setVisibility("visible");
    await waitFor(() => expect(started.filter((item) => item.id === "c")).toHaveLength(1));
    expect(started.every((item) => item.visibility === "visible")).toBe(true);
    await act(async () => { holds.get("b")!(); });
    await advance(100);
    expect(started.filter((item) => item.id === "c")).toHaveLength(1);
    view.unmount();
    const count = started.length;
    holdRereads = false;
    await advance(60_000);
    expect(started.length).toBe(count);
  });

  it("keeps cards apart, the concurrency limit, and the last stage when a reread fails", async () => {
    const cards: Record<string, Card> = { a: { story: "DRAFT", runs: "RUNNING" }, b: { story: "DRAFT", runs: "RUNNING" },
      c: { story: "DRAFT", runs: "SUCCEEDED" } };
    const stub = stubCards(cards);
    render(<MyWorks />);
    await waitFor(() => expect(screen.getAllByText(/当前阶段：第 1 步 定故事/)).toHaveLength(3));
    cards.a!.fail = true;
    cards.b!.story = "APPROVED";
    cards.b!.runs = "SUCCEEDED";
    await advance(5000);
    expect(await screen.findByText(/当前阶段：第 2 步 看剧本/)).toBeTruthy();
    // a keeps its last stage and says the reread failed; c finished before and was not read again.
    expect(await screen.findByText(/最新进度暂时没有读到/)).toBeTruthy();
    expect(stub.reads.filter((id) => id === "c")).toHaveLength(1);
    expect(stub.maxInFlight()).toBeLessThanOrEqual(2);
  });
});
