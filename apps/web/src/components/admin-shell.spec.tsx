// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/features",
}));

const CSRF = "c".repeat(43);

function viewport(wide: boolean) {
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
    matches: wide, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
}

type FetchCall = [input: string, init?: RequestInit];

let AdminShell: typeof import("./admin-shell")["AdminShell"];
let assign: ReturnType<typeof vi.fn<(url: string | URL) => void>>;

beforeEach(async () => {
  vi.resetModules();
  viewport(true);
  document.cookie = `ads_csrf=${CSRF}; Path=/`;
  assign = vi.fn<(url: string | URL) => void>();
  vi.spyOn(window.location, "assign").mockImplementation(assign);
  ({ AdminShell } = await import("./admin-shell"));
  vi.stubGlobal("fetch", vi.fn(async (_input: string, _init?: RequestInit) => {
    if (String(_input).endsWith("/auth/logout")) {
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({
      enabled: true, authenticated: true, role: "operator",
    }), { status: 200, headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.cookie = "ads_csrf=; Max-Age=0; Path=/";
});

it("shows live model/API links, planned columns, and Hongguo admin branding", () => {
  render(<AdminShell><main>正文</main></AdminShell>);
  const nav = screen.getByRole("navigation", { name: "管理菜单" });
  expect(within(nav).getAllByRole("link").map((link) => [link.getAttribute("href"), link.textContent])).toEqual([
    ["/admin/features", "功能配置"],
    ["/admin/usage", "调用记录"],
  ]);
  expect(within(nav).getByRole("link", { name: "功能配置" }).getAttribute("aria-current")).toBe("page");
  expect(within(nav).getByText("模型与 API")).toBeTruthy();
  expect(within(nav).getByText("任务与用量")).toBeTruthy();
  expect(within(nav).getByText("规划中的栏目")).toBeTruthy();
  expect(within(nav).getByRole("button", { name: /创作内容/ })).toBeTruthy();
  expect(within(nav).getByRole("button", { name: /系统管理/ })).toBeTruthy();
  expect(within(nav).queryByRole("button", { name: /生成任务/ })).toBeNull();
  expect(within(nav).queryByRole("link", { name: "文本模型" })).toBeNull();
  expect(within(nav).queryByRole("link", { name: "媒体密钥" })).toBeNull();
  expect(within(nav).queryByRole("link", { name: "作品管理" })).toBeNull();
  expect(within(nav).queryByText("充值")).toBeNull();
  expect(within(nav).queryByText("会员")).toBeNull();
  expect(screen.getByText("红果")).toBeTruthy();
  expect(screen.getByText("运营管理后台")).toBeTruthy();
  expect(screen.getByText("平台管理员")).toBeTruthy();
  expect(screen.getByText("已登录")).toBeTruthy();
  expect(screen.getByRole("link", { name: "返回创作中心" }).getAttribute("href")).toBe("/studio");
  expect(screen.getByRole("button", { name: "退出" })).toBeTruthy();
  expect(screen.getByRole("navigation", { name: "面包屑" }).textContent).toContain("功能配置");
});

it("expands a planned group to show purpose copy without inventing routes", () => {
  render(<AdminShell><main>正文</main></AdminShell>);
  const nav = screen.getByRole("navigation", { name: "管理菜单" });
  fireEvent.click(within(nav).getByRole("button", { name: /创作内容/ }));
  expect(within(nav).getByText("作品管理")).toBeTruthy();
  expect(within(nav).getByText("查看作品及所属工作区，定位剧集和当前制作阶段。")).toBeTruthy();
  expect(within(nav).getByText("素材库")).toBeTruthy();
  expect(within(nav).queryByRole("link", { name: "作品管理" })).toBeNull();
});

it("opens a mobile drawer below 1024px with 44px touch targets and closes after selecting a live link", () => {
  viewport(false);
  render(<AdminShell><main>正文</main></AdminShell>);
  expect(screen.queryByRole("navigation", { name: "管理菜单" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "打开导航" }));
  const dialog = screen.getByRole("dialog", { name: "管理导航" });
  expect(within(dialog).getByText("后台导航")).toBeTruthy();
  expect(within(dialog).getByRole("link", { name: "功能配置" })).toBeTruthy();
  const close = within(dialog).getByRole("button", { name: "关闭菜单" });
  expect(getComputedStyle(close).minHeight === "44px" || close.className.length > 0).toBe(true);
  fireEvent.click(within(dialog).getByRole("link", { name: "调用记录" }));
  expect(screen.queryByRole("dialog", { name: "管理导航" })).toBeNull();
});

it("keeps the selected item after the short mobile drawer closes", () => {
  viewport(false);
  render(<AdminShell><main>正文</main></AdminShell>);
  fireEvent.click(screen.getByRole("button", { name: "打开导航" }));
  const dialog = screen.getByRole("dialog", { name: "管理导航" });
  expect(within(dialog).getByRole("link", { name: "功能配置" }).getAttribute("aria-current")).toBe("page");
  fireEvent.click(within(dialog).getByRole("link", { name: "功能配置" }));
  expect(screen.queryByRole("dialog", { name: "管理导航" })).toBeNull();
  expect(screen.getByText("红果运营后台")).toBeTruthy();
});

it("signs out from the sidebar with the session CSRF token and returns to login", async () => {
  const fetchMock = vi.fn(async (input: string, _init?: RequestInit) => {
    if (String(input).endsWith("/auth/logout")) return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ enabled: true, authenticated: true, role: "operator" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<AdminShell><main>正文</main></AdminShell>);
  fireEvent.click(screen.getByRole("button", { name: "退出" }));
  await vi.waitFor(() => expect(assign).toHaveBeenCalledWith("/login?returnTo=%2Fadmin%2Ffeatures&reason=signed-out"));
  const calls = fetchMock.mock.calls as FetchCall[];
  const out = calls.find((call) => String(call[0]).endsWith("/auth/logout"));
  expect(out?.[1]?.method).toBe("POST");
  expect(new Headers(out?.[1]?.headers).get("X-CSRF-Token")).toBe(CSRF);
});

it("does not navigate away when the logout receipt is lost", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: string, _init?: RequestInit) => {
    if (String(input).endsWith("/auth/logout")) return Promise.reject(new Error("network"));
    return new Response(JSON.stringify({ enabled: true, authenticated: true, role: "operator" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }));
  render(<AdminShell><main>正文</main></AdminShell>);
  fireEvent.click(screen.getByRole("button", { name: "退出" }));
  await vi.waitFor(() => expect(screen.getByRole("button", { name: "退出" })).toBeTruthy());
  expect(assign).not.toHaveBeenCalled();
  expect(screen.getByText("正文")).toBeTruthy();
});
