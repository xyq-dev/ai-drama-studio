// @vitest-environment happy-dom
// Simulated API. fetch is mocked; this file does not start the API, database, worker, or a real browser.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioClient } from "../lib/studio-client";
import { ComposeJobPanel } from "./compose-job-panel";

const REVISION = "33333333-3333-4333-8333-333333333333";
const OTHER_REVISION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const JOB_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JOB_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ASSET = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const HASH = "ab".repeat(32);

const body = {
  videoAssetId: "44444444-4444-4444-8444-444444444444",
  audioAssetId: null,
  musicAssetId: null,
  subtitleAssetId: null,
  expectedInputHash: HASH,
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function composite(reviewStatus: string, rowVersion = 1) {
  return {
    id: ASSET,
    kind: "COMPOSITE",
    status: "ACTIVE",
    reviewStatus,
    rowVersion,
    checksumSha256: HASH,
    width: 1080,
    height: 1920,
    durationMs: 1000,
    sourceShotRevisionId: REVISION,
    sourceGenerationJobId: JOB_A,
  };
}

function panel(fetchImpl: (input: string, init?: RequestInit) => Promise<Response>, revisionId = REVISION) {
  return createElement(ComposeJobPanel, {
    revisionId,
    eligible: true,
    body,
    client: new StudioClient(fetchImpl),
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("compose job panel", () => {
  it("retries a lost acceptance with the same request and uses a new key after that job is accepted", async () => {
    const posts: Array<{ key: string; body: string }> = [];
    let composePosts = 0;
    const fetchImpl = (input: string, init?: RequestInit) => {
      if (input.includes("/assets")) return Promise.resolve(json({ items: [] }));
      if (input.includes("/compose")) {
        composePosts += 1;
        const headers = init?.headers as Record<string, string>;
        posts.push({ key: String(headers?.["Idempotency-Key"] ?? ""), body: String(init?.body ?? "") });
        if (composePosts === 1) return Promise.reject(new TypeError("network down"));
        const jobId = composePosts === 2 ? JOB_A : JOB_B;
        return Promise.resolve(json({ jobId, state: "QUEUED" }, 202));
      }
      const jobId = input.includes(JOB_B) ? JOB_B : JOB_A;
      return Promise.resolve(json({ id: jobId, state: "QUEUED", errorCode: null, errorMessage: null }));
    };
    render(panel(fetchImpl));
    fireEvent.click(screen.getByRole("button", { name: "开始合成" }));
    expect((await screen.findByRole("alert")).textContent).toContain("合成提交失败");
    fireEvent.click(screen.getByRole("button", { name: "开始合成" }));
    expect(await screen.findByText("合成任务已受理")).toBeTruthy();
    expect(posts[0]?.key).toBe(posts[1]?.key);
    expect(posts[0]?.body).toBe(posts[1]?.body);
    fireEvent.click(screen.getByRole("button", { name: "开始合成" }));
    await waitFor(() => expect(posts).toHaveLength(3));
    expect(posts[2]?.key).not.toBe(posts[0]?.key);
    expect(posts[2]?.body).toBe(posts[0]?.body);
    expect(document.querySelector("[data-compose-job]")?.getAttribute("data-compose-job")).toBe(JOB_B);
  });

  it("does not let a late draft list replace an approval", async () => {
    let assetCalls = 0;
    let releaseLate: (response: Response) => void = () => undefined;
    const late = new Promise<Response>((resolve) => { releaseLate = resolve; });
    const fetchImpl = (input: string, init?: RequestInit) => {
      if (input.includes("/assets/") && init?.method === "POST") {
        return Promise.resolve(json({ reviewStatus: "APPROVED", rowVersion: 2 }));
      }
      if (input.includes("/assets")) {
        assetCalls += 1;
        if (assetCalls === 1) return Promise.resolve(json({ items: [composite("DRAFT")] }));
        return late;
      }
      return Promise.resolve(json({ items: [] }));
    };
    render(panel(fetchImpl));
    expect(await screen.findByRole("button", { name: "批准成片" })).toBeTruthy();
    await waitFor(() => expect(assetCalls).toBeGreaterThan(1), { timeout: 2500 });
    fireEvent.click(screen.getByRole("button", { name: "批准成片" }));
    expect(await screen.findByText("审核 APPROVED · 当前有效")).toBeTruthy();
    releaseLate(json({ items: [composite("DRAFT")] }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.getByText("审核 APPROVED · 当前有效")).toBeTruthy();
    expect(screen.queryByText("审核 DRAFT · 当前有效")).toBeNull();
  });

  it("stops polling a terminal job and still refreshes assets when the page is visible", async () => {
    vi.useFakeTimers();
    let jobGets = 0;
    let assetGets = 0;
    let hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    const fetchImpl = (input: string) => {
      if (input.includes("/assets")) {
        assetGets += 1;
        return Promise.resolve(json({ items: [] }));
      }
      if (input.includes("/compose")) return Promise.resolve(json({ jobId: JOB_A, state: "QUEUED" }, 202));
      jobGets += 1;
      return Promise.resolve(json({
        id: JOB_A,
        state: jobGets === 1 ? "RUNNING" : "SUCCEEDED",
        errorCode: null,
        errorMessage: null,
      }));
    };
    render(panel(fetchImpl));
    fireEvent.click(screen.getByRole("button", { name: "开始合成" }));
    await vi.waitFor(() => expect(document.body.textContent).toContain("合成任务 RUNNING"));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(document.body.textContent).toContain("合成任务 SUCCEEDED"));
    const jobsAfterTerminal = jobGets;
    const assetsAfterTerminal = assetGets;
    await vi.advanceTimersByTimeAsync(3000);
    expect(jobGets).toBe(jobsAfterTerminal);
    expect(assetGets).toBeGreaterThan(assetsAfterTerminal);
    hidden = true;
    const assetsWhileHidden = assetGets;
    await vi.advanceTimersByTimeAsync(3000);
    expect(assetGets).toBe(assetsWhileHidden);
    expect(jobGets).toBe(jobsAfterTerminal);
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(assetGets).toBeGreaterThan(assetsWhileHidden));
    expect(jobGets).toBe(jobsAfterTerminal);
  });

  it("does not apply an old cancel read to the next job on the same revision or after A to B to A", async () => {
    let releaseCancel: (response: Response) => void = () => undefined;
    const cancelRead = new Promise<Response>((resolve) => { releaseCancel = resolve; });
    let composePosts = 0;
    const fetchImpl = (input: string, _init?: RequestInit) => {
      if (input.includes("/assets")) return Promise.resolve(json({ items: [] }));
      if (input.includes("/cancel")) return Promise.resolve(json({ state: "CANCELED" }));
      if (input.includes("/compose")) {
        composePosts += 1;
        const jobId = composePosts === 1 ? JOB_A : JOB_B;
        return Promise.resolve(json({ jobId, state: "QUEUED" }, 202));
      }
      if (input.includes(JOB_A)) return cancelRead;
      return Promise.resolve(json({ id: JOB_B, state: "QUEUED", errorCode: null, errorMessage: null }));
    };
    const view = render(panel(fetchImpl));
    fireEvent.click(screen.getByRole("button", { name: "开始合成" }));
    expect(await screen.findByRole("button", { name: "取消合成" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消合成" }));
    fireEvent.click(screen.getByRole("button", { name: "开始合成" }));
    await waitFor(() => expect(document.querySelector("[data-compose-job]")?.getAttribute("data-compose-job")).toBe(JOB_B));
    view.rerender(panel(fetchImpl, OTHER_REVISION));
    view.rerender(panel(fetchImpl, REVISION));
    releaseCancel(json({ id: JOB_A, state: "CANCELED", errorCode: null, errorMessage: null }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByText("合成任务 CANCELED")).toBeNull();
    expect(screen.queryByText(JOB_A)).toBeNull();
    expect(document.querySelector("[data-compose-job]")).toBeNull();
  });
});
