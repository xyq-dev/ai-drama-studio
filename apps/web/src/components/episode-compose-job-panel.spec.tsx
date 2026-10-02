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
});
