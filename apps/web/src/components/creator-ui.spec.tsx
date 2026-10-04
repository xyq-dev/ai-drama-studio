// @vitest-environment happy-dom
// Simulated interface tests. fetch is mocked; this file does not start a browser or a backend.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

  it("shows a create failure inside the dialog and keeps it apart from a list failure", async () => {
    let listMode: "fail" | "ok" = "fail";
    const posts: string[] = [];
    vi.stubGlobal("fetch", vi.fn((_input: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push(new Headers(init.headers).get("Idempotency-Key") ?? "");
        return Promise.resolve(json({ error: { code: "UNAVAILABLE", message: "暂时不能创建这部很长的作品因为接口没有接上" } }, 503));
      }
      if (listMode === "fail") return Promise.resolve(json({ error: { code: "UNAVAILABLE", message: "项目列表加载失败" } }, 503));
      return Promise.resolve(json({ items: [], nextCursor: null }));
    }));
    render(<ProjectHome />);
    expect(await screen.findByText(/连接状态：读取失败/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "新建作品" }));
    const title = await screen.findByLabelText("标题");
    fireEvent.change(title, { target: { value: "夜班便利店夜班便利店夜班便利店夜班便利店" } });
    fireEvent.change(screen.getByLabelText("故事梗概"), { target: { value: "最后一盒饭团" } });
    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("暂时不能创建这部很长的作品因为接口没有接上");
    expect(dialog.textContent).not.toContain("项目列表加载失败");
    expect(dialog.textContent).not.toContain("读取失败");
    expect(screen.getByText(/连接状态：读取失败/)).toBeTruthy();
    listMode = "ok";
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText(/还没有项目/)).toBeTruthy();
    expect(screen.getByRole("dialog").textContent).toContain("暂时不能创建这部很长的作品因为接口没有接上");
    expect(window.sessionStorage.getItem("ads-draft:new:project:new")).toContain("夜班便利店");
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    fireEvent.click(screen.getByRole("button", { name: "新建作品" }));
    expect((screen.getByLabelText("标题") as HTMLInputElement).value).toContain("夜班便利店");
    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[0]).toBeTruthy();
    expect(posts[1]).toBe(posts[0]);
  });

  it("keeps tab focus inside the create dialog", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(json({ items: [], nextCursor: null }))));
    render(<ProjectHome />);
    fireEvent.click(await screen.findByRole("button", { name: "新建作品" }));
    const close = await screen.findByRole("button", { name: "关闭" });
    const title = screen.getByLabelText("标题");
    close.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(title);
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(close);
    const opener = [...document.querySelectorAll("button")].find((button) => button.textContent === "新建作品");
    expect(opener?.closest("[inert]")).toBeTruthy();
  });

  it("drops the mobile navigation trap when the viewport becomes wide", async () => {
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    let matches = false;
    window.matchMedia = (query: string) => ({
      get matches() { return matches; },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: EventListener) => listeners.add(listener as (event: MediaQueryListEvent) => void),
      removeEventListener: (_type: string, listener: EventListener) => listeners.delete(listener as (event: MediaQueryListEvent) => void),
      dispatchEvent: () => false,
      addListener: () => undefined,
      removeListener: () => undefined,
    });
    render(<ProductHome />);
    fireEvent.click(screen.getByRole("button", { name: "打开导航" }));
    const dialog = await screen.findByRole("dialog", { name: "导航" });
    const close = screen.getByRole("button", { name: "关闭导航" });
    const status = within(dialog).getByRole("link", { name: "服务状态" });
    status.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(status);
    expect(dialog.contains(document.activeElement)).toBe(true);
    matches = true;
    act(() => {
      for (const listener of listeners) listener({ matches: true } as MediaQueryListEvent);
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "导航" })).toBeNull());
    expect(document.querySelector("[inert]")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
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
