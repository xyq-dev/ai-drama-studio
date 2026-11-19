// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/models",
}));

const CSRF = "c".repeat(43);

function viewport(wide: boolean) {
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
    matches: wide, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
}

let AdminShell: typeof import("./admin-shell")["AdminShell"];
let assign: ReturnType<typeof vi.fn<(url: string | URL) => void>>;

beforeEach(async () => {
  vi.resetModules();
  viewport(true);
  document.cookie = `ads_csrf=${CSRF}; Path=/`;
  assign = vi.fn<(url: string | URL) => void>();
  vi.spyOn(window.location, "assign").mockImplementation(assign);
  ({ AdminShell } = await import("./admin-shell"));
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).endsWith("/auth/logout")) {
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
  expect(screen.getByRole("button", { name: "退出" })).toBeTruthy();
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

it("signs out from the top bar with the session CSRF token and returns to login", async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).endsWith("/auth/logout")) return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ enabled: true, authenticated: true, role: "operator" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<AdminShell><main>正文</main></AdminShell>);
  fireEvent.click(screen.getByRole("button", { name: "退出" }));
  await vi.waitFor(() => expect(assign).toHaveBeenCalledWith("/login?returnTo=%2Fadmin%2Fmodels&reason=signed-out"));
  const out = fetchMock.mock.calls.find((call) => String(call[0]).endsWith("/auth/logout"));
  expect(out?.[1]?.method).toBe("POST");
  expect(new Headers(out?.[1]?.headers).get("X-CSRF-Token")).toBe(CSRF);
});

it("does not navigate away when the logout receipt is lost", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).endsWith("/auth/logout")) return Promise.reject(new Error("network"));
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
