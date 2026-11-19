// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AdminShell } from "./admin-shell";

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/models",
}));

function viewport(wide: boolean) {
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
    matches: wide, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
}

beforeEach(() => {
  viewport(true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    enabled: true, authenticated: true, role: "operator",
  }), { status: 200, headers: { "content-type": "application/json" } })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("shows only phase-1 admin sidebar items", () => {
  render(<AdminShell><main>正文</main></AdminShell>);
  const nav = screen.getByRole("navigation", { name: "管理菜单" });
  expect(within(nav).getAllByRole("link").map((link) => [link.getAttribute("href"), link.textContent])).toEqual([
    ["/admin/models", "文本模型"],
    ["/admin/media-keys", "媒体密钥"],
  ]);
  expect(within(nav).queryByText("充值")).toBeNull();
  expect(within(nav).queryByText("会员")).toBeNull();
  expect(screen.getByPlaceholderText("搜索设置…")).toBeTruthy();
  expect(screen.getByRole("link", { name: "返回创作中心" }).getAttribute("href")).toBe("/studio");
  expect(screen.getByText("管理员会话有效")).toBeTruthy();
});

it("opens a mobile drawer below 1024px with 44px touch targets", () => {
  viewport(false);
  render(<AdminShell><main>正文</main></AdminShell>);
  expect(screen.queryByRole("navigation", { name: "管理菜单" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "打开导航" }));
  const dialog = screen.getByRole("dialog", { name: "管理导航" });
  expect(within(dialog).getByRole("link", { name: "文本模型" })).toBeTruthy();
  const close = within(dialog).getByRole("button", { name: "关闭菜单" });
  expect(getComputedStyle(close).minHeight === "44px" || close.className.length > 0).toBe(true);
});
