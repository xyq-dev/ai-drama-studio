// @vitest-environment happy-dom
import { useEffect, useRef, useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useModalKeyboard } from "../lib/modal-keyboard";
import { CreatorShell } from "./creator-shell";
import { BeginnerShell } from "./beginner-shell";

function viewport(wide: boolean) {
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
    matches: wide, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
}

beforeEach(() => viewport(true));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const destinations = [
  ["/studio", "我的作品"],
  ["/preview", "界面示例"], ["/status", "服务状态"],
  ["/settings/storage", "设置"],
] as const;

it.each(destinations)("keeps the same destinations and marks the current page at %s", (path, label) => {
  render(<CreatorShell activePath={path}><main>内容</main></CreatorShell>);
  const nav = screen.getByRole("navigation", { name: "主导航" });
  expect(within(nav).getAllByRole("link").map((link) => [link.getAttribute("href"), link.textContent])).toEqual(destinations);
  expect(within(nav).getByRole("link", { name: label }).getAttribute("aria-current")).toBe("page");
  expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  expect(document.querySelectorAll('[data-ui="hongguo"]')).toHaveLength(1);
  expect(screen.queryByText("开发预览")).toBeNull();
});

it("uses the identical navigation and content frame for guided creation", () => {
  const view = render(<BeginnerShell active="/studio"><main>我的故事</main></BeginnerShell>);
  const navigation = screen.getByRole("navigation", { name: "主导航" }).innerHTML;
  view.rerender(<CreatorShell activePath="/studio"><main>我的故事</main></CreatorShell>);
  expect(screen.getByRole("navigation", { name: "主导航" }).innerHTML).toBe(navigation);
  expect(screen.getByRole("link", { name: "跳到正文" }).getAttribute("href")).toBe("#main");
  expect(document.querySelector("#main")?.textContent).toBe("我的故事");
});

it("passes workspace and header content through the guided frame and restores a collapsed sidebar", () => {
  render(<BeginnerShell active="/studio" workspaceNavigation={<button type="button">悬疑推理</button>}
    headerContent={<input aria-label="搜索作品" />}><main>我的故事</main></BeginnerShell>);
  const nav = screen.getByRole("navigation", { name: "主导航" });
  expect(within(nav).getByRole("button", { name: "悬疑推理" })).toBeTruthy();
  expect(within(screen.getByRole("banner")).getByRole("textbox", { name: "搜索作品" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "收起侧栏" }));
  expect(screen.queryByRole("navigation", { name: "主导航" })).toBeNull();
  expect(screen.getByRole("main").textContent).toBe("我的故事");
  const toggle = screen.getByRole("button", { name: "展开侧栏" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(screen.getByRole("button", { name: "悬疑推理" })).toBeTruthy();
});

it("uses one mobile navigation instance, traps focus and returns focus after choosing a category", () => {
  viewport(false);
  const onCategory = vi.fn();
  render(<CreatorShell workspaceNavigation={<button id="category-entry" type="button" onClick={onCategory}>悬疑推理</button>}><main>我的故事</main></CreatorShell>);
  expect(screen.queryByRole("navigation", { name: "主导航" })).toBeNull();
  const opener = screen.getByRole("button", { name: "打开导航" });
  fireEvent.click(opener);
  const dialog = screen.getByRole("dialog", { name: "导航" });
  expect(document.querySelectorAll("#category-entry")).toHaveLength(1);
  expect(screen.getAllByRole("navigation", { name: "主导航" })).toHaveLength(1);
  const close = within(dialog).getByRole("button", { name: "关闭导航" });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(within(dialog).getByRole("link", { name: "设置" }));
  fireEvent.keyDown(window, { key: "Tab" });
  expect(document.activeElement).toBe(close);
  fireEvent.click(within(dialog).getByRole("button", { name: "悬疑推理" }));
  expect(onCategory).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(opener);
  expect(screen.getByRole("main").closest("[inert]")).toBeNull();
  fireEvent.click(opener);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(opener);
});

function CategoryDialog({ onClose }: { onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useModalKeyboard(true, panel, onClose);
  useEffect(() => { panel.current?.querySelector("input")?.focus(); }, []);
  return <div ref={panel} role="dialog" aria-modal="true" aria-label="新建分类"><input aria-label="分类名称" /><button type="button" onClick={onClose}>取消新建</button></div>;
}

function CategoryNavigation() {
  const [creating, setCreating] = useState(false);
  return <CreatorShell workspaceNavigation={<button type="button" onClick={() => setCreating(true)}>新建分类</button>}>
    <main>我的故事</main>{creating ? <CategoryDialog onClose={() => setCreating(false)} /> : null}
  </CreatorShell>;
}

it("hands focus and inert ownership from the drawer to a category dialog", () => {
  viewport(false);
  render(<CategoryNavigation />);
  const opener = screen.getByRole("button", { name: "打开导航" });
  fireEvent.click(opener);
  fireEvent.click(screen.getByRole("button", { name: "新建分类" }));
  expect(screen.queryByRole("dialog", { name: "导航" })).toBeNull();
  const dialog = screen.getByRole("dialog", { name: "新建分类" });
  const input = within(dialog).getByRole("textbox", { name: "分类名称" });
  expect(dialog.closest("[inert]")).toBeNull();
  expect(document.activeElement).toBe(input);
  fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "取消新建" }));
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(opener.closest("[inert]")).toBeNull();
});
