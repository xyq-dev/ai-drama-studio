// @vitest-environment happy-dom
// Simulated interface tests. fetch is mocked; this file does not start a browser or a backend.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewBoard } from "./preview-board";
import { ProductHome } from "./product-home";
import { ProjectHome } from "./project-home";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

describe("creator interface", () => {
  it("links the home page to the studio and the preview", () => {
    render(<ProductHome />);
    expect(screen.getByRole("link", { name: "进入创作中心" }).getAttribute("href")).toBe("/studio");
    expect(screen.getByRole("link", { name: "查看界面示例" }).getAttribute("href")).toBe("/preview");
    expect(document.body.textContent).not.toContain("红果");
    expect(document.body.textContent).not.toContain("无限生成");
  });

  it("opens and closes the mobile navigation and returns focus", async () => {
    window.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
      addListener: () => undefined,
      removeListener: () => undefined,
    });
    render(<ProductHome />);
    const opener = screen.getByRole("button", { name: "打开导航" });
    fireEvent.click(opener);
    expect(screen.getByRole("dialog", { name: "导航" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭导航" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "导航" })).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it("creates a project with the real fields and reuses the idempotency key after failure", async () => {
    const posts: Array<{ body: string; key: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const headers = new Headers(init.headers);
        posts.push({ body: String(init.body), key: headers.get("Idempotency-Key") });
        return Promise.resolve(json({ error: { code: "UNAVAILABLE", message: "暂时不能创建" } }, 503));
      }
      return Promise.resolve(json({ items: [], nextCursor: null }));
    }));
    render(<ProjectHome />);
    expect(await screen.findByText(/还没有项目/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "新建作品" }));
    const title = await screen.findByLabelText("标题");
    expect(document.activeElement).toBe(title);
    fireEvent.change(title, { target: { value: "夜班便利店" } });
    fireEvent.change(screen.getByLabelText("故事梗概"), { target: { value: "最后一盒饭团" } });
    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));
    expect(await screen.findByText(/暂时不能创建/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(JSON.parse(posts[0]?.body ?? "{}")).toEqual({ title: "夜班便利店", premise: "最后一盒饭团" });
    expect(posts[0]?.key).toBeTruthy();
    expect(posts[1]?.key).toBe(posts[0]?.key);
    expect(window.sessionStorage.getItem("ads-draft:new:project:new")).toContain("夜班便利店");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "新建作品" }));
  });

  it("shows loading, an empty list, a failed read, and retry without inventing projects", async () => {
    let mode: "hold" | "fail" | "empty" | "page" = "hold";
    let release: (value: Response) => void = () => undefined;
    vi.stubGlobal("fetch", vi.fn((input: string) => {
      const url = String(input);
      if (mode === "hold") return new Promise<Response>((resolve) => { release = resolve; });
      if (mode === "fail") return Promise.resolve(json({ error: { code: "UNAVAILABLE", message: "项目列表加载失败" } }, 503));
      if (mode === "empty") return Promise.resolve(json({ items: [], nextCursor: null }));
      if (url.includes("cursor=")) {
        return Promise.resolve(json({ items: [{ id: "p2", title: "第二页作品", premise: "后续", version: 1, status: "ACTIVE" }], nextCursor: null }));
      }
      return Promise.resolve(json({
        items: [{ id: "p1", title: "已保存作品", premise: "真实梗概", version: 2, status: "ACTIVE" }],
        nextCursor: "cursor-2",
      }));
    }));
    render(<ProjectHome />);
    expect(screen.getByText("正在加载项目")).toBeTruthy();
    mode = "fail";
    release(json({ error: { code: "UNAVAILABLE", message: "项目列表加载失败" } }, 503));
    expect(await screen.findByText(/连接状态：读取失败/)).toBeTruthy();
    expect(screen.getByText(/不会改用示例项目/)).toBeTruthy();
    expect(screen.queryByText("已保存作品")).toBeNull();
    mode = "page";
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("已保存作品")).toBeTruthy();
    expect(screen.getByText(/状态 ACTIVE · 版本 2/)).toBeTruthy();
    expect(screen.queryByText("夜班便利店")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("第二页作品")).toBeTruthy();
    cleanup();
    mode = "empty";
    render(<ProjectHome />);
    expect(await screen.findByText(/还没有项目/)).toBeTruthy();
  });

  it("previews the sample layout without calling the API", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<PreviewBoard />);
    expect(screen.getByText("界面预览 · 示例内容 · 不会真实生成")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "成片" }));
    expect(screen.getByText(/没有生成结果/)).toBeTruthy();
    expect(screen.getByText(/没有账户余额，也没有支付状态/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("支付成功");
    expect(document.body.textContent).not.toContain("生成成功");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
