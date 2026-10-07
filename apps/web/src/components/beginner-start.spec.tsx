// @vitest-environment happy-dom
// Simulated interface tests. fetch is mocked; this file does not start a browser or a backend.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("shows a failed list as an error, not sample works", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(json({ error: { code: "DOWN", message: "服务不可用" } }, 503))));
    render(<MyWorks />);
    expect((await screen.findByRole("alert")).textContent).toContain("不会显示示例作品");
  });
});
