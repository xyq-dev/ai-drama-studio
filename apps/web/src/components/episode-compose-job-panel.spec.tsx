// @vitest-environment happy-dom
// Simulated API. fetch is mocked; this file does not start the API, database, worker, or a real browser.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioClient } from "../lib/studio-client";
import { EpisodeComposeJobPanel, type EpisodeComposeBody } from "./episode-compose-job-panel";

const PROJECT = "22222222-2222-4222-8222-222222222222";
const EPISODE = "33333333-3333-4333-8333-333333333333";
const OTHER = "34343434-3434-4434-8434-343434343434";
const JOB_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JOB_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HASH = "ab".repeat(32);

const body: EpisodeComposeBody = {
  compositeAssetIds: ["44444444-4444-4444-8444-444444444441", "44444444-4444-4444-8444-444444444442"],
  expectedInputHash: HASH,
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function composite(assetId: string, overrides: {
  status?: "ACTIVE" | "STALE";
  reviewStatus?: "DRAFT" | "APPROVED" | "REJECTED";
  rowVersion?: number;
  checksumSha256?: string;
} = {}) {
  return {
    assetId,
    status: "ACTIVE" as const,
    reviewStatus: "DRAFT" as const,
    checksumSha256: HASH,
    rowVersion: 1,
    durationMs: 2000,
    segments: [] as Array<{ position: number; assetId: string; shotId: string; startMs: number; endMs: number }>,
    ...overrides,
  };
}

function buttonNamed(card: Element | null, name: string): HTMLButtonElement | undefined {
  return [...(card?.querySelectorAll("button") ?? [])].find((node) => node.textContent === name) as HTMLButtonElement | undefined;
}

function panel(
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
  next: EpisodeComposeBody | null = body,
  episodeId = EPISODE,
) {
  return createElement(EpisodeComposeJobPanel, {
    client: new StudioClient(fetchImpl),
    projectId: PROJECT,
    episodeId,
    body: next,
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("episode compose job panel", () => {
  it("retries a lost or incomplete acceptance with the original body and key", async () => {
    const posts: Array<{ key: string; body: string }> = [];
    let composePosts = 0;
    const fetchImpl = (input: string, init?: RequestInit) => {
      if (input.includes("/composites")) return Promise.resolve(json({ items: [], nextCursor: null }));
      if (input.includes("/compose")) {
        composePosts += 1;
        const headers = init?.headers as Record<string, string>;
        posts.push({ key: String(headers?.["Idempotency-Key"] ?? ""), body: String(init?.body ?? "") });
        if (composePosts === 1) return Promise.reject(new TypeError("network down"));
        if (composePosts === 2) return Promise.resolve(json({ state: "QUEUED" }, 202));
        if (composePosts === 3) return Promise.resolve(json({ error: { code: "UNAVAILABLE", message: "服务暂不可用" } }, 503));
        return Promise.resolve(json({ jobId: composePosts === 4 ? JOB_A : JOB_B, state: "QUEUED" }, 202));
      }
      return Promise.resolve(json({ id: JOB_A, state: "QUEUED", errorMessage: null }));
    };
    const view = render(panel(fetchImpl));
    const button = () => screen.getByRole("button", { name: "开始多镜合成" });
    fireEvent.click(button());
    expect((await screen.findByRole("alert")).textContent).toContain("网络异常");
    view.rerender(panel(fetchImpl, { ...body, expectedInputHash: "cd".repeat(32) }));
    fireEvent.click(button());
    expect((await screen.findByRole("alert")).textContent).toContain("没有返回有效任务编号");
    fireEvent.click(button());
    expect((await screen.findByRole("alert")).textContent).toContain("服务暂不可用");
    fireEvent.click(button());
    expect(await screen.findByText(/多镜合成已受理/)).toBeTruthy();
    expect(posts.slice(0, 4).every((item) => item.key === posts[0]?.key && item.body === posts[0]?.body)).toBe(true);
    fireEvent.click(button());
    await waitFor(() => expect(posts.length).toBeGreaterThanOrEqual(5));
    expect(posts[4]?.key).not.toBe(posts[0]?.key);
    expect(posts[4]?.body).toContain("cd".repeat(32));
  });

  it("keeps a slow list read from overlapping and offers a reread without another compose", async () => {
    let listReads = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const posts: string[] = [];
    const fetchImpl = (input: string, init?: RequestInit) => {
      if (input.includes("/composites")) {
        listReads += 1;
        if (listReads === 1) return gate.then(() => json({ items: [], nextCursor: null }));
        return Promise.resolve(json({ error: { code: "UNAVAILABLE", message: "list down" } }, 503));
      }
      posts.push(String(init?.method ?? "GET"));
      return Promise.resolve(json({ items: [] }));
    };
    render(panel(fetchImpl, null));
    await waitFor(() => expect(listReads).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(listReads).toBe(1);
    release();
    await waitFor(() => expect(screen.getByRole("button", { name: "重新查询成片" })).toBeTruthy(), { timeout: 4000 });
    expect(posts.filter((item) => item === "POST")).toEqual([]);
  });

  it("stops job polling on a terminal state and drops a late response after the episode changes", async () => {
    let jobReads = 0;
    let mode: "hang" | "done" = "done";
    let releaseLate: (value: Response) => void = () => undefined;
    const fetchImpl = (input: string) => {
      if (input.includes("/composites")) return Promise.resolve(json({ items: [], nextCursor: null }));
      if (input.includes("/compose")) return Promise.resolve(json({ jobId: JOB_A, state: "QUEUED" }, 202));
      if (!input.includes("/generation-jobs/")) return Promise.resolve(json({}));
      jobReads += 1;
      if (mode === "hang") return new Promise<Response>((resolve) => { releaseLate = resolve; });
      return Promise.resolve(json({ id: JOB_A, state: "SUCCEEDED", errorMessage: null }));
    };
    const view = render(panel(fetchImpl));
    fireEvent.click(screen.getByRole("button", { name: "开始多镜合成" }));
    expect(await screen.findByText(/SUCCEEDED/)).toBeTruthy();
    const settled = jobReads;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(jobReads).toBe(settled);
    mode = "hang";
    view.rerender(panel(fetchImpl, { ...body, expectedInputHash: "cd".repeat(32) }, EPISODE));
    fireEvent.click(screen.getByRole("button", { name: "开始多镜合成" }));
    await waitFor(() => expect(jobReads).toBe(settled + 1));
    view.rerender(panel(fetchImpl, body, OTHER));
    releaseLate(json({ id: JOB_A, state: "CANCELED", errorMessage: null }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText(/CANCELED/)).toBeNull();
  });

  it("replays one server job when the first response is an ambiguous failure", async () => {
    const jobs = new Map<string, string>();
    const posts: string[] = [];
    const failures = [500, 502, 504];
    let calls = 0;
    const fetchImpl = (input: string, init?: RequestInit) => {
      if (input.includes("/composites")) return Promise.resolve(json({ items: [], nextCursor: null }));
      if (!input.includes("/compose")) return Promise.resolve(json({ id: JOB_A, state: "QUEUED", errorMessage: null }));
      const headers = init?.headers as Record<string, string>;
      const key = String(headers?.["Idempotency-Key"] ?? "");
      posts.push(key);
      if (!jobs.has(key)) jobs.set(key, JOB_A);
      calls += 1;
      if (calls <= failures.length) {
        return Promise.resolve(json({ error: { code: "INTERNAL", message: `服务端 ${failures[calls - 1]}` } }, failures[calls - 1]));
      }
      if (calls === failures.length + 1) return Promise.resolve(new Response("not-json", { status: 200 }));
      return Promise.resolve(json({ jobId: jobs.get(key), state: "QUEUED" }, 202));
    };
    render(panel(fetchImpl));
    const button = () => screen.getByRole("button", { name: "开始多镜合成" });
    fireEvent.click(button());
    expect((await screen.findByRole("alert")).textContent).toContain("服务端 500");
    fireEvent.click(button());
    expect((await screen.findByRole("alert")).textContent).toContain("服务端 502");
    fireEvent.click(button());
    expect((await screen.findByRole("alert")).textContent).toContain("服务端 504");
    fireEvent.click(button());
    expect((await screen.findByRole("alert")).textContent).toContain("响应无法解析");
    fireEvent.click(button());
    expect(await screen.findByText(/多镜合成已受理/)).toBeTruthy();
    expect(jobs.size).toBe(1);
    expect(jobs.get(posts[0] ?? "")).toBe(JOB_A);
    expect(posts.every((key) => key === posts[0])).toBe(true);
  });

  it("releases the original key only after an explicit compose rejection", async () => {
    const posts: Array<{ key: string; body: string }> = [];
    let calls = 0;
    const fetchImpl = (input: string, init?: RequestInit) => {
      if (input.includes("/composites")) return Promise.resolve(json({ items: [], nextCursor: null }));
      if (!input.includes("/compose")) return Promise.resolve(json({}));
      calls += 1;
      const headers = init?.headers as Record<string, string>;
      posts.push({ key: String(headers?.["Idempotency-Key"] ?? ""), body: String(init?.body ?? "") });
      if (calls === 1) return Promise.resolve(json({ error: { code: "COMPOSE_INPUT_CHANGED", message: "来源已变化" } }, 409));
      return Promise.resolve(json({ jobId: JOB_B, state: "QUEUED" }, 202));
    };
    const view = render(panel(fetchImpl));
    const button = () => screen.getByRole("button", { name: "开始多镜合成" });
    fireEvent.click(button());
    expect((await screen.findByRole("alert")).textContent).toContain("来源已变化");
    view.rerender(panel(fetchImpl, { ...body, expectedInputHash: "cd".repeat(32) }));
    fireEvent.click(button());
    expect(await screen.findByText(/多镜合成已受理/)).toBeTruthy();
    expect(posts[1]?.key).not.toBe(posts[0]?.key);
    expect(posts[1]?.body).toContain("cd".repeat(32));
  });

  it("loads older composites without duplicating a refreshed page", async () => {
    const newest = "55555555-5555-4555-8555-555555555555";
    const older = "66666666-6666-4666-8666-666666666666";
    const oldest = "77777777-7777-4777-8777-777777777777";
    const item = (assetId: string, reviewStatus: "DRAFT" | "APPROVED") => ({
      assetId, status: "ACTIVE", reviewStatus, checksumSha256: HASH, rowVersion: 1, durationMs: 2000, segments: [],
    });
    let refreshes = 0;
    const fetchImpl = (input: string) => {
      if (!input.includes("/composites")) return Promise.resolve(json({}));
      if (input.includes("cursor=")) return Promise.resolve(json({ items: [item(newest, "DRAFT"), item(older, "DRAFT"), item(oldest, "DRAFT")], nextCursor: null }));
      refreshes += 1;
      return Promise.resolve(json({
        items: [item(newest, refreshes === 1 ? "DRAFT" : "APPROVED")],
        nextCursor: "page-2",
      }));
    };
    render(panel(fetchImpl, null));
    fireEvent.click(await screen.findByRole("button", { name: "加载更早的成片" }));
    await waitFor(() => expect(document.querySelector(`[data-composite-id="${oldest}"]`)).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/APPROVED/)).toBeTruthy(), { timeout: 4000 });
    const ids = [...document.querySelectorAll("[data-composite-id]")].map((node) => node.getAttribute("data-composite-id"));
    expect(ids).toEqual([newest, older, oldest]);
    expect(screen.getAllByRole("button", { name: "批准成片" })).toHaveLength(2);
  });

  it("ignores a delayed cancel from the previous job on the same episode", async () => {
    let composePosts = 0;
    let cancelReleased = false;
    let releaseCancel: (value: Response) => void = () => undefined;
    const fetchImpl = (input: string, init?: RequestInit) => {
      if (input.includes("/composites")) return Promise.resolve(json({ items: [], nextCursor: null }));
      if (input.includes("/compose")) {
        composePosts += 1;
        return Promise.resolve(json({ jobId: composePosts === 1 ? JOB_A : JOB_B, state: "RUNNING" }, 202));
      }
      if (init?.method === "POST") {
        return new Promise<Response>((resolve) => {
          releaseCancel = () => { cancelReleased = true; resolve(json({})); };
        });
      }
      const jobId = input.includes(JOB_B) ? JOB_B : JOB_A;
      const state = jobId === JOB_A && cancelReleased ? "CANCELED" : "RUNNING";
      return Promise.resolve(json({ id: jobId, state, errorMessage: null }));
    };
    render(panel(fetchImpl));
    fireEvent.click(screen.getByRole("button", { name: "开始多镜合成" }));
    expect(await screen.findByText(/RUNNING/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消合成" }));
    fireEvent.click(screen.getByRole("button", { name: "开始多镜合成" }));
    await waitFor(() => expect(composePosts).toBe(2));
    releaseCancel(json({}));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(screen.getByText(/多镜合成已受理/).textContent).toContain("RUNNING");
    expect(screen.getByRole("button", { name: "取消合成" })).toBeTruthy();
    expect(screen.queryByText(/CANCELED/)).toBeNull();
  });

  it("ignores a delayed cancel failure after a newer job is accepted", async () => {
    let composePosts = 0;
    let releaseCancel: (value: Response) => void = () => undefined;
    const fetchImpl = (input: string, init?: RequestInit) => {
      if (input.includes("/composites")) return Promise.resolve(json({ items: [], nextCursor: null }));
      if (input.includes("/compose")) {
        composePosts += 1;
        return Promise.resolve(json({ jobId: composePosts === 1 ? JOB_A : JOB_B, state: "RUNNING" }, 202));
      }
      if (init?.method === "POST") {
        return new Promise<Response>((resolve) => { releaseCancel = resolve; });
      }
      const jobId = input.includes(JOB_B) ? JOB_B : JOB_A;
      return Promise.resolve(json({ id: jobId, state: "RUNNING", errorMessage: null }));
    };
    render(panel(fetchImpl));
    fireEvent.click(screen.getByRole("button", { name: "开始多镜合成" }));
    expect(await screen.findByText(/RUNNING/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消合成" }));
    fireEvent.click(screen.getByRole("button", { name: "开始多镜合成" }));
    await waitFor(() => expect(composePosts).toBe(2));
    releaseCancel(json({ error: { code: "INTERNAL", message: "取消没有完成" } }, 500));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/多镜合成已受理/).textContent).toContain("RUNNING");
    expect(screen.getByRole("button", { name: "取消合成" })).toBeTruthy();
  });

  it("drops a cancel from episode A after visiting B and returning to A", async () => {
    let releaseCancel: (value: Response) => void = () => undefined;
    let composePosts = 0;
    const fetchImpl = (input: string, init?: RequestInit) => {
      if (input.includes("/composites")) return Promise.resolve(json({ items: [], nextCursor: null }));
      if (input.includes("/compose")) {
        composePosts += 1;
        return Promise.resolve(json({ jobId: composePosts === 1 ? JOB_A : JOB_B, state: "RUNNING" }, 202));
      }
      if (init?.method === "POST") return new Promise<Response>((resolve) => { releaseCancel = resolve; });
      const jobId = input.includes(JOB_B) ? JOB_B : JOB_A;
      return Promise.resolve(json({ id: jobId, state: "RUNNING", errorMessage: null }));
    };
    const view = render(panel(fetchImpl));
    fireEvent.click(screen.getByRole("button", { name: "开始多镜合成" }));
    expect(await screen.findByText(/RUNNING/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消合成" }));
    view.rerender(panel(fetchImpl, body, OTHER));
    fireEvent.click(screen.getByRole("button", { name: "开始多镜合成" }));
    expect(await screen.findByText(/RUNNING/)).toBeTruthy();
    view.rerender(panel(fetchImpl, body, EPISODE));
    await waitFor(() => expect(screen.queryByText(/多镜合成已受理/)).toBeNull());
    releaseCancel(json({}));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(screen.queryByText(/CANCELED/)).toBeNull();
    expect(screen.queryByText(/RUNNING/)).toBeNull();
  });

  it("does not let an older running read replace a completed cancel", async () => {
    let releaseRead: (value: Response) => void = () => undefined;
    let jobReads = 0;
    const fetchImpl = (input: string, init?: RequestInit) => {
      if (input.includes("/composites")) return Promise.resolve(json({ items: [], nextCursor: null }));
      if (input.includes("/compose")) return Promise.resolve(json({ jobId: JOB_A, state: "RUNNING" }, 202));
      if (init?.method === "POST") return Promise.resolve(json({}));
      jobReads += 1;
      if (jobReads === 1) return new Promise<Response>((resolve) => { releaseRead = resolve; });
      return Promise.resolve(json({ id: JOB_A, state: "CANCELED", errorMessage: null }));
    };
    render(panel(fetchImpl));
    fireEvent.click(screen.getByRole("button", { name: "开始多镜合成" }));
    expect(await screen.findByText(/RUNNING/)).toBeTruthy();
    await waitFor(() => expect(jobReads).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "取消合成" }));
    expect(await screen.findByText(/CANCELED/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "取消合成" })).toBeNull();
    releaseRead(json({ id: JOB_A, state: "RUNNING", errorMessage: null }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(screen.getByText(/多镜合成已受理/).textContent).toContain("CANCELED");
    expect(screen.queryByRole("button", { name: "取消合成" })).toBeNull();
  });

  it("keeps polling after a running cancel until the same job becomes canceled", async () => {
    let jobGets = 0;
    let cancelPosts = 0;
    let getsAfterCancel = 0;
    let phase: "RUNNING" | "CANCELED" = "RUNNING";
    let hidden = false;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
    const fetchImpl = (input: string, init?: RequestInit) => {
      if (input.includes("/composites")) return Promise.resolve(json({ items: [], nextCursor: null }));
      if (input.includes("/compose")) return Promise.resolve(json({ jobId: JOB_A, state: "RUNNING" }, 202));
      if (init?.method === "POST") {
        cancelPosts += 1;
        return Promise.resolve(json({}));
      }
      jobGets += 1;
      if (cancelPosts > 0) getsAfterCancel += 1;
      return Promise.resolve(json({ id: JOB_A, state: phase, errorMessage: null }));
    };
    const client = new StudioClient(fetchImpl);
    try {
      render(createElement(EpisodeComposeJobPanel, { client, projectId: PROJECT, episodeId: EPISODE, body }));
      fireEvent.click(screen.getByRole("button", { name: "开始多镜合成" }));
      expect(await screen.findByText(/RUNNING/)).toBeTruthy();
      const beforeCancel = jobGets;
      fireEvent.click(screen.getByRole("button", { name: "取消合成" }));
      await waitFor(() => expect(getsAfterCancel).toBeGreaterThanOrEqual(1));
      expect(screen.getByText(/多镜合成已受理/).textContent).toContain("RUNNING");
      expect(screen.getByRole("button", { name: "取消合成" })).toBeTruthy();
      expect(jobGets).toBeGreaterThan(beforeCancel);
      await new Promise((resolve) => setTimeout(resolve, 1600));
      const whileHidden = getsAfterCancel;
      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(getsAfterCancel).toBe(whileHidden);
      expect(screen.getByText(/多镜合成已受理/).textContent).toContain("RUNNING");
      phase = "CANCELED";
      hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
      expect(await screen.findByText(/CANCELED/)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "取消合成" })).toBeNull();
      const settled = getsAfterCancel;
      await new Promise((resolve) => setTimeout(resolve, 1700));
      expect(getsAfterCancel).toBe(settled);
      expect(screen.getByText(/多镜合成已受理/).textContent).toContain("CANCELED");
    } finally {
      delete (document as { visibilityState?: string }).visibilityState;
    }
  }, 15000);

  it.each([
    ["APPROVE", "批准成片", "APPROVED"],
    ["REJECT", "退回成片", "REJECTED"],
  ] as const)("updates a loaded history composite after %s", async (_action, buttonName, reviewStatus) => {
    const newest = "55555555-5555-4555-8555-555555555555";
    const historyId = "66666666-6666-4666-8666-666666666666";
    const reviewedHash = "cd".repeat(32);
    let releaseStale: (value: Response) => void = () => undefined;
    let listReads = 0;
    const fetchImpl = (input: string) => {
      if (input.includes("/review")) {
        return Promise.resolve(json({ reviewStatus, rowVersion: 4, contentHash: reviewedHash }));
      }
      if (!input.includes("/composites")) return Promise.resolve(json({}));
      if (input.includes("cursor=")) {
        return Promise.resolve(json({
          items: [composite(historyId, { reviewStatus: "DRAFT", rowVersion: 1 })],
          nextCursor: null,
        }));
      }
      listReads += 1;
      if (listReads === 1) {
        return Promise.resolve(json({ items: [composite(newest, { reviewStatus: "APPROVED", rowVersion: 2 })], nextCursor: "page-2" }));
      }
      return new Promise<Response>((resolve) => { releaseStale = resolve; });
    };
    render(panel(fetchImpl, null));
    fireEvent.click(await screen.findByRole("button", { name: "加载更早的成片" }));
    const card = () => document.querySelector(`[data-composite-id="${historyId}"]`);
    await waitFor(() => expect(card()).toBeTruthy());
    await waitFor(() => expect(listReads).toBeGreaterThanOrEqual(2), { timeout: 4000 });
    const reviewButton = buttonNamed(card(), buttonName);
    expect(reviewButton).toBeTruthy();
    fireEvent.click(reviewButton!);
    await waitFor(() => expect(card()?.getAttribute("data-review-status")).toBe(reviewStatus));
    expect(card()?.getAttribute("data-row-version")).toBe("4");
    expect(card()?.getAttribute("data-reviewed-content")).toBe(reviewedHash);
    expect(card()?.textContent).toContain(reviewStatus);
    expect(buttonNamed(card(), "批准成片")).toBeUndefined();
    expect(buttonNamed(card(), "退回成片")).toBeUndefined();
    releaseStale(json({
      items: [composite(newest, { reviewStatus: "DRAFT", rowVersion: 1 }), composite(historyId, { reviewStatus: "DRAFT", rowVersion: 1 })],
      nextCursor: null,
    }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(card()?.getAttribute("data-review-status")).toBe(reviewStatus);
    expect(card()?.getAttribute("data-row-version")).toBe("4");
    expect(card()?.getAttribute("data-reviewed-content")).toBe(reviewedHash);
    expect(document.querySelector(`[data-composite-id="${newest}"]`)).toBeTruthy();
  }, 10000);

  it("refreshes an already loaded history composite to stale and ignores an older active read", async () => {
    const newest = "55555555-5555-4555-8555-555555555555";
    const historyId = "66666666-6666-4666-8666-666666666666";
    let hidden = false;
    let cursorReads = 0;
    let failList = false;
    let stale = false;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
    const pageFor = (cursor: boolean) => {
      if (cursor) cursorReads += 1;
      const history = composite(historyId, {
        status: stale ? "STALE" : "ACTIVE",
        reviewStatus: "APPROVED",
        rowVersion: stale ? 5 : 2,
      });
      if (cursor) return json({ items: [history], nextCursor: null });
      return json({ items: [composite(newest, { reviewStatus: "APPROVED", rowVersion: 3 })], nextCursor: "page-2" });
    };
    const fetchImpl = (input: string) => {
      if (!input.includes("/composites")) return Promise.resolve(json({}));
      if (failList && !input.includes("cursor=")) {
        return Promise.resolve(json({ error: { code: "UNAVAILABLE", message: "list down" } }, 503));
      }
      return Promise.resolve(pageFor(input.includes("cursor=")));
    };
    try {
      render(panel(fetchImpl, null));
      fireEvent.click(await screen.findByRole("button", { name: "加载更早的成片" }));
      const card = () => document.querySelector(`[data-composite-id="${historyId}"]`);
      await waitFor(() => expect(card()?.textContent).toContain("当前成片"));
      expect(card()?.getAttribute("data-review-status")).toBe("APPROVED");
      expect(card()?.getAttribute("data-row-version")).toBe("2");
      const loadedCursorReads = cursorReads;
      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
      stale = true;
      hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => expect(card()?.getAttribute("data-asset-status")).toBe("STALE"));
      expect(cursorReads).toBeGreaterThan(loadedCursorReads);
      expect(card()?.getAttribute("data-review-status")).toBe("APPROVED");
      expect(card()?.getAttribute("data-row-version")).toBe("5");
      expect(card()?.textContent).toContain("历史成片");
      expect(buttonNamed(card(), "批准成片")).toBeUndefined();
      expect(document.querySelector(`[data-composite-id="${newest}"]`)).toBeTruthy();
      failList = true;
      await waitFor(() => expect(screen.getByRole("button", { name: "重新查询成片" })).toBeTruthy(), { timeout: 4000 });
      const beforeReread = cursorReads;
      failList = false;
      fireEvent.click(screen.getByRole("button", { name: "重新查询成片" }));
      await waitFor(() => expect(cursorReads).toBeGreaterThan(beforeReread));
      expect(card()?.getAttribute("data-asset-status")).toBe("STALE");
      expect(card()?.getAttribute("data-row-version")).toBe("5");
      stale = false;
      const beforeOlderRead = cursorReads;
      await waitFor(() => expect(cursorReads).toBeGreaterThan(beforeOlderRead), { timeout: 4000 });
      expect(card()?.getAttribute("data-asset-status")).toBe("STALE");
      expect(card()?.getAttribute("data-row-version")).toBe("5");
      expect(card()?.getAttribute("data-review-status")).toBe("APPROVED");
      expect(card()?.textContent).toContain("历史成片");
      expect(document.querySelector(`[data-composite-id="${newest}"]`)).toBeTruthy();
    } finally {
      delete (document as { visibilityState?: string }).visibilityState;
    }
  }, 15000);

  it("keeps loaded history when an older page refresh resolves later", async () => {
    const newest = "55555555-5555-4555-8555-555555555555";
    const older = "66666666-6666-4666-8666-666666666666";
    const oldest = "77777777-7777-4777-8777-777777777777";
    let releaseRefresh: (value: Response) => void = () => undefined;
    let nonCursor = 0;
    let cursorReads = 0;
    const fetchImpl = (input: string) => {
      if (!input.includes("/composites")) return Promise.resolve(json({}));
      if (input.includes("cursor=")) {
        cursorReads += 1;
        if (cursorReads === 1) return Promise.resolve(json({ items: [composite(older), composite(oldest)], nextCursor: null }));
        return Promise.resolve(json({
          items: [composite(older, { reviewStatus: "APPROVED", rowVersion: 3 }), composite(oldest, { rowVersion: 2 })],
          nextCursor: null,
        }));
      }
      nonCursor += 1;
      if (nonCursor === 1) return Promise.resolve(json({ items: [composite(newest)], nextCursor: "page-2" }));
      if (nonCursor === 2) return new Promise<Response>((resolve) => { releaseRefresh = resolve; });
      return Promise.resolve(json({ items: [composite(newest, { reviewStatus: "APPROVED", rowVersion: 4 })], nextCursor: "page-2" }));
    };
    render(panel(fetchImpl, null));
    await screen.findByRole("button", { name: "加载更早的成片" });
    await waitFor(() => expect(nonCursor).toBe(2), { timeout: 4000 });
    fireEvent.click(screen.getByRole("button", { name: "加载更早的成片" }));
    await waitFor(() => expect(document.querySelector(`[data-composite-id="${oldest}"]`)).toBeTruthy());
    releaseRefresh(json({ items: [composite(newest, { reviewStatus: "DRAFT", rowVersion: 1 })], nextCursor: "page-2" }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect([...document.querySelectorAll("[data-composite-id]")].map((node) => node.getAttribute("data-composite-id"))).toEqual([newest, older, oldest]);
    await waitFor(() => expect(cursorReads).toBeGreaterThanOrEqual(2), { timeout: 4000 });
    await waitFor(() => expect(document.querySelector(`[data-composite-id="${older}"]`)?.getAttribute("data-review-status")).toBe("APPROVED"));
    expect(document.querySelector(`[data-composite-id="${older}"]`)?.getAttribute("data-row-version")).toBe("3");
    expect(document.querySelector(`[data-composite-id="${oldest}"]`)?.getAttribute("data-row-version")).toBe("2");
    expect(document.querySelector(`[data-composite-id="${newest}"]`)?.getAttribute("data-row-version")).toBe("4");
    expect(document.querySelector(`[data-composite-id="${newest}"]`)?.getAttribute("data-review-status")).toBe("APPROVED");
  }, 10000);

  it("drops a late history response after switching episodes", async () => {
    const newest = "55555555-5555-4555-8555-555555555555";
    const historyId = "66666666-6666-4666-8666-666666666666";
    const otherId = "77777777-7777-4777-8777-777777777777";
    let releaseLate: (value: Response) => void = () => undefined;
    let hangArmed = false;
    let lateStarted = 0;
    const fetchImpl = (input: string) => {
      if (input.includes("/review")) return Promise.resolve(json({ reviewStatus: "APPROVED", rowVersion: 6, contentHash: HASH }));
      if (!input.includes("/composites")) return Promise.resolve(json({}));
      if (input.includes(OTHER)) return Promise.resolve(json({ items: [composite(otherId)], nextCursor: null }));
      if (input.includes("cursor=")) return Promise.resolve(json({ items: [composite(historyId)], nextCursor: null }));
      if (hangArmed) {
        hangArmed = false;
        lateStarted += 1;
        return new Promise<Response>((resolve) => { releaseLate = resolve; });
      }
      return Promise.resolve(json({ items: [composite(newest, { reviewStatus: "APPROVED", rowVersion: 2 })], nextCursor: "page-2" }));
    };
    const client = new StudioClient(fetchImpl);
    const view = render(createElement(EpisodeComposeJobPanel, { client, projectId: PROJECT, episodeId: EPISODE, body: null }));
    fireEvent.click(await screen.findByRole("button", { name: "加载更早的成片" }));
    const card = () => document.querySelector(`[data-composite-id="${historyId}"]`);
    await waitFor(() => expect(card()?.getAttribute("data-review-status")).toBe("DRAFT"));
    const approve = buttonNamed(card(), "批准成片");
    expect(approve).toBeTruthy();
    fireEvent.click(approve!);
    await waitFor(() => expect(card()?.getAttribute("data-row-version")).toBe("6"));
    expect(card()?.getAttribute("data-review-status")).toBe("APPROVED");
    expect(card()?.getAttribute("data-reviewed-content")).toBe(HASH);
    expect(buttonNamed(card(), "批准成片")).toBeUndefined();
    hangArmed = true;
    await waitFor(() => expect(lateStarted).toBe(1), { timeout: 4000 });
    view.rerender(createElement(EpisodeComposeJobPanel, { client, projectId: PROJECT, episodeId: OTHER, body: null }));
    await waitFor(() => expect(document.querySelector(`[data-composite-id="${otherId}"]`)?.getAttribute("data-review-status")).toBe("DRAFT"));
    expect(document.querySelector(`[data-composite-id="${historyId}"]`)).toBeNull();
    releaseLate(json({
      items: [
        composite(historyId, { reviewStatus: "DRAFT", rowVersion: 1 }),
        composite(newest, { reviewStatus: "DRAFT", rowVersion: 1 }),
      ],
      nextCursor: null,
    }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(document.querySelector(`[data-composite-id="${otherId}"]`)?.getAttribute("data-review-status")).toBe("DRAFT");
    expect(document.querySelector(`[data-composite-id="${otherId}"]`)?.getAttribute("data-row-version")).toBe("1");
    expect(document.querySelector(`[data-composite-id="${historyId}"]`)).toBeNull();
    view.rerender(createElement(EpisodeComposeJobPanel, { client, projectId: PROJECT, episodeId: EPISODE, body: null }));
    await waitFor(() => expect(document.querySelector(`[data-composite-id="${newest}"]`)?.getAttribute("data-review-status")).toBe("APPROVED"));
    expect(document.querySelector(`[data-composite-id="${historyId}"]`)).toBeNull();
    expect(document.querySelector(`[data-composite-id="${newest}"]`)?.getAttribute("data-review-status")).toBe("APPROVED");
    expect(document.querySelector(`[data-composite-id="${newest}"]`)?.getAttribute("data-row-version")).toBe("2");
    expect(document.querySelector(`[data-composite-id="${otherId}"]`)).toBeNull();
  }, 10000);

  it("offers downloads only for an active approved composite and saves after the response is valid", async () => {
    const assetId = "55555555-5555-4555-8555-555555555555";
    const created: string[] = [];
    const revoked: string[] = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = ((blob: Blob) => {
      created.push(blob.type);
      return "blob:episode";
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((url: string) => { revoked.push(url); }) as typeof URL.revokeObjectURL;
    let releaseDownload: (value: Response) => void = () => undefined;
    const fetchImpl = (input: string) => {
      if (input.includes("/download?")) {
        return new Promise<Response>((resolve) => { releaseDownload = resolve; });
      }
      if (input.includes("/composites")) {
        return Promise.resolve(json({
          items: [
            composite(assetId, { reviewStatus: "APPROVED", rowVersion: 2 }),
            composite("66666666-6666-4666-8666-666666666666", { reviewStatus: "DRAFT" }),
            composite("77777777-7777-4777-8777-777777777777", { reviewStatus: "REJECTED" }),
            composite("88888888-8888-4888-8888-888888888888", { status: "STALE", reviewStatus: "APPROVED" }),
          ],
          nextCursor: null,
        }));
      }
      return Promise.resolve(json({}));
    };
    render(panel(fetchImpl, null));
    const approved = () => document.querySelector(`[data-composite-id="${assetId}"]`);
    await waitFor(() => expect(buttonNamed(approved(), "下载 MP4")).toBeTruthy());
    expect(buttonNamed(document.querySelector("[data-composite-id=\"66666666-6666-4666-8666-666666666666\"]"), "下载 MP4")).toBeUndefined();
    expect(buttonNamed(document.querySelector("[data-composite-id=\"77777777-7777-4777-8777-777777777777\"]"), "下载来源清单")).toBeUndefined();
    expect(buttonNamed(document.querySelector("[data-composite-id=\"88888888-8888-4888-8888-888888888888\"]"), "下载 MP4")).toBeUndefined();
    fireEvent.click(buttonNamed(approved(), "下载 MP4")!);
    expect(buttonNamed(approved(), "正在下载")).toBeTruthy();
    releaseDownload(new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: {
        "content-type": "video/mp4",
        "content-disposition": `attachment; filename="episode-01-${assetId}.mp4"`,
      },
    }));
    await waitFor(() => expect(created).toEqual(["video/mp4"]));
    expect(revoked).toEqual(["blob:episode"]);
    expect(approved()?.textContent).not.toContain("重新生成");
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  it("does not save an error response and ignores a download that returns after the episode changes", async () => {
    const assetId = "55555555-5555-4555-8555-555555555555";
    const created: string[] = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (() => {
      created.push("saved");
      return "blob:late";
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
    let releaseDownload: (value: Response) => void = () => undefined;
    const fetchImpl = (input: string) => {
      if (input.includes("/download?") || input.includes("/export-manifest?")) {
        return new Promise<Response>((resolve) => { releaseDownload = resolve; });
      }
      if (input.includes(OTHER)) return Promise.resolve(json({ items: [], nextCursor: null }));
      if (input.includes("/composites")) {
        return Promise.resolve(json({ items: [composite(assetId, { reviewStatus: "APPROVED" })], nextCursor: null }));
      }
      return Promise.resolve(json({}));
    };
    const view = render(panel(fetchImpl, null));
    const card = () => document.querySelector(`[data-composite-id="${assetId}"]`);
    fireEvent.click(await screen.findByRole("button", { name: "下载来源清单" }));
    releaseDownload(new Response(JSON.stringify({ error: { code: "COMPOSE_INPUT_INVALID", message: "来源已变化" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "来源已变化");
    expect(created).toEqual([]);
    fireEvent.click(buttonNamed(card(), "下载 MP4")!);
    view.rerender(panel(fetchImpl, null, OTHER));
    releaseDownload(new Response(new Uint8Array([9]), {
      status: 200,
      headers: { "content-type": "video/mp4", "content-disposition": "attachment; filename=\"episode-01-late.mp4\"" },
    }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(created).toEqual([]);
    expect(screen.queryByText("来源已变化")).toBeNull();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });
});
