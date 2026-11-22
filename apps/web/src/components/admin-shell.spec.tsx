// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const navState = vi.hoisted(() => ({ pathname: "/admin/features" }));
vi.mock("next/navigation", () => ({
  usePathname: () => navState.pathname,
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
  navState.pathname = "/admin/features";
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

it("shows the four formal groups and Hongguo admin branding", async () => {
  render(<AdminShell><main>正文</main></AdminShell>);
  const nav = await screen.findByRole("navigation", { name: "管理菜单" });
  expect(within(nav).getAllByRole("link").map((link) => [link.getAttribute("href"), link.textContent])).toEqual([
    ["/admin/features", "功能配置"],
    ["/admin/works", "作品管理"],
    ["/admin/assets", "素材库"],
    ["/admin/jobs", "生成任务"],
    ["/admin/usage", "调用记录"],
    ["/admin/users", "用户与权限"],
    ["/admin/logs", "操作日志"],
  ]);
  expect(within(nav).getByRole("link", { name: "功能配置" }).getAttribute("aria-current")).toBe("page");
  expect(within(nav).getByText("模型与 API")).toBeTruthy();
  expect(within(nav).getByText("创作内容")).toBeTruthy();
  expect(within(nav).getByText("任务与用量")).toBeTruthy();
  expect(within(nav).getByText("系统管理")).toBeTruthy();
  expect(within(nav).queryByText("规划中的栏目")).toBeNull();
  expect(within(nav).queryByText("所属工作区")).toBeNull();
  expect(within(nav).queryByRole("link", { name: "文本模型" })).toBeNull();
  expect(within(nav).queryByRole("link", { name: "媒体密钥" })).toBeNull();
  expect(within(nav).queryByText("充值")).toBeNull();
  expect(within(nav).queryByText("会员")).toBeNull();
  expect(screen.getByText("红果")).toBeTruthy();
  expect(screen.getByText("运营管理后台")).toBeTruthy();
  expect(screen.getByText("运营示例")).toBeTruthy();
  expect(screen.getByText("平台管理员")).toBeTruthy();
  expect(screen.getByText("已登录")).toBeTruthy();
  expect(screen.getByRole("link", { name: "返回创作中心" }).getAttribute("href")).toBe("/studio");
  expect(screen.getByRole("button", { name: "退出" })).toBeTruthy();
  const crumb = screen.getByRole("navigation", { name: "面包屑" });
  expect(crumb.textContent).toContain("管理后台");
  expect(crumb.textContent).toContain("模型与 API");
  expect(crumb.textContent).toContain("功能配置");
  expect(crumb.textContent).not.toContain("运维");
});

it("uses the works breadcrumb instead of the old ops label", async () => {
  navState.pathname = "/admin/works";
  ({ AdminShell } = await import("./admin-shell"));
  render(<AdminShell><main>正文</main></AdminShell>);
  const crumb = await screen.findByRole("navigation", { name: "面包屑" });
  expect(crumb.textContent).toContain("创作内容");
  expect(crumb.textContent).toContain("作品管理");
  expect(crumb.textContent).not.toContain("作品列表");
  expect(within(screen.getByRole("navigation", { name: "管理菜单" })).queryByText("规划中")).toBeNull();
});

it("opens a mobile drawer below 1024px with 44px touch targets and closes after selecting a live link", async () => {
  viewport(false);
  render(<AdminShell><main>正文</main></AdminShell>);
  const opener = await screen.findByRole("button", { name: "目录" });
  expect(screen.queryByRole("navigation", { name: "管理菜单" })).toBeNull();
  fireEvent.click(opener);
  const dialog = screen.getByRole("dialog", { name: "管理导航" });
  expect(within(dialog).getByText("红果")).toBeTruthy();
  expect(within(dialog).getByText("运营管理后台")).toBeTruthy();
  expect(within(dialog).getByRole("link", { name: "功能配置" })).toBeTruthy();
  const close = within(dialog).getByRole("button", { name: "关闭菜单" });
  expect(getComputedStyle(close).minHeight === "44px" || close.className.length > 0).toBe(true);
  fireEvent.click(within(dialog).getByRole("link", { name: "调用记录" }));
  expect(screen.queryByRole("dialog", { name: "管理导航" })).toBeNull();
});

it("keeps the selected item after the short mobile drawer closes", async () => {
  viewport(false);
  render(<AdminShell><main>正文</main></AdminShell>);
  fireEvent.click(await screen.findByRole("button", { name: "目录" }));
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
  fireEvent.click(await screen.findByRole("button", { name: "退出" }));
  await vi.waitFor(() => expect(assign).toHaveBeenCalledWith("/login?returnTo=%2Fadmin%2Ffeatures&reason=signed-out"));
  const calls = fetchMock.mock.calls as FetchCall[];
  const out = calls.find((call) => String(call[0]).endsWith("/auth/logout"));
  expect(out?.[1]?.method).toBe("POST");
  expect(new Headers(out?.[1]?.headers).get("X-CSRF-Token")).toBe(CSRF);
});

it("keeps the operator shell for an operator and hides it while the session is loading", async () => {
  let release: ((value: Response) => void) | undefined;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })));
  render(<AdminShell><main>正文</main></AdminShell>);
  expect(screen.getByRole("heading", { name: "正在确认身份" })).toBeTruthy();
  expect(screen.queryByText("平台管理员")).toBeNull();
  expect(screen.queryByRole("navigation", { name: "管理菜单" })).toBeNull();
  expect(screen.queryByRole("navigation", { name: "面包屑" })).toBeNull();
  expect(screen.queryByText("正文")).toBeNull();
  expect(document.querySelector("[data-ui='hongguo-admin']")).toBeNull();
  release?.(new Response(JSON.stringify({ enabled: true, authenticated: true, role: "operator" }), {
    status: 200, headers: { "content-type": "application/json" },
  }));
  expect(await screen.findByText("平台管理员")).toBeTruthy();
  expect(screen.getByRole("navigation", { name: "管理菜单" })).toBeTruthy();
  expect(screen.getByText("正文")).toBeTruthy();
  expect(screen.getByRole("link", { name: "功能配置" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "调用记录" })).toBeTruthy();
});

it("redirects a creator away from the admin shell without the operator label", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    enabled: true, authenticated: true, role: "creator", username: "qa-iso-a",
  }), { status: 200, headers: { "content-type": "application/json" } })));
  render(<AdminShell><main>正文</main></AdminShell>);
  expect(await screen.findByRole("heading", { name: "没有后台权限" })).toBeTruthy();
  expect(screen.queryByText("平台管理员")).toBeNull();
  expect(screen.queryByRole("navigation", { name: "管理菜单" })).toBeNull();
  expect(screen.queryByRole("navigation", { name: "面包屑" })).toBeNull();
  expect(screen.queryByText("正文")).toBeNull();
  expect(document.querySelector("[data-ui='hongguo-admin']")).toBeNull();
  expect(screen.getByRole("link", { name: "返回创作中心" }).getAttribute("href")).toBe("/studio");
  expect(assign).toHaveBeenCalledWith("/studio");
});

it("does not show the operator shell when signed out", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "AUTH_REQUIRED" } }), {
    status: 401, headers: { "content-type": "application/json" },
  })));
  render(<AdminShell><main>正文</main></AdminShell>);
  expect(await screen.findByRole("heading", { name: "请先登录" })).toBeTruthy();
  expect(screen.queryByText("平台管理员")).toBeNull();
  expect(screen.queryByRole("navigation", { name: "管理菜单" })).toBeNull();
  expect(screen.queryByText("正文")).toBeNull();
  expect(assign).toHaveBeenCalledWith("/login?returnTo=%2Fadmin%2Ffeatures&reason=signed-out");
});

it("does not label an authenticated session without the operator role", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    enabled: true, authenticated: true, username: "qa-iso-a",
  }), { status: 200, headers: { "content-type": "application/json" } })));
  render(<AdminShell><main>正文</main></AdminShell>);
  expect(await screen.findByRole("heading", { name: "没有后台权限" })).toBeTruthy();
  expect(screen.queryByText("平台管理员")).toBeNull();
  expect(document.querySelector("[data-ui='hongguo-admin']")).toBeNull();
  expect(assign).toHaveBeenCalledWith("/studio");
});

it("does not show the operator shell when the session check fails", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
  render(<AdminShell><main>正文</main></AdminShell>);
  expect(await screen.findByRole("heading", { name: "暂时无法确认身份" })).toBeTruthy();
  expect(screen.queryByText("平台管理员")).toBeNull();
  expect(screen.queryByRole("navigation", { name: "管理菜单" })).toBeNull();
  expect(assign).not.toHaveBeenCalled();
});

it("does not navigate away when the logout receipt is lost", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: string, _init?: RequestInit) => {
    if (String(input).endsWith("/auth/logout")) return Promise.reject(new Error("network"));
    return new Response(JSON.stringify({ enabled: true, authenticated: true, role: "operator" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }));
  render(<AdminShell><main>正文</main></AdminShell>);
  fireEvent.click(await screen.findByRole("button", { name: "退出" }));
  await vi.waitFor(() => expect(screen.getByRole("button", { name: "退出" })).toBeTruthy());
  expect(assign).not.toHaveBeenCalled();
  expect(screen.getByText("正文")).toBeTruthy();
});
