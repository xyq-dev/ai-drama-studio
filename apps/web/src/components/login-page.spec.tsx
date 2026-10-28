// @vitest-environment happy-dom
// Simulated fetch: checks the form's requests and navigation. Real sign-in is covered by the API HTTP tests and the
// real-browser acceptance against the real API.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "./login-page";

const PASSWORD = "test-only-site-password";
let replace: ReturnType<typeof vi.fn<(url: string | URL) => void>>;
type Call = { url: string; init: RequestInit };

function server(login: () => Response, session: () => Response = () => new Response("{}", { status: 401 })) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return url.endsWith("/auth/session") ? session() : login();
  }));
  return calls;
}

function open(query: string) {
  window.history.replaceState(null, "", `/login${query}`);
  render(<LoginPage />);
}

function submit(password = PASSWORD) {
  fireEvent.change(screen.getByLabelText("密码"), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: "登录" }));
}

beforeEach(() => {
  replace = vi.fn<(url: string | URL) => void>();
  vi.spyOn(window.location, "replace").mockImplementation(replace);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.localStorage.clear(); window.sessionStorage.clear(); });

describe("site login page", () => {
  it("defaults the username to admin, sends one JSON login and returns to the requested page", async () => {
    const calls = server(() => new Response(JSON.stringify({ authenticated: true }), { status: 200 }));
    open("?returnTo=%2Fprojects%2Fp1%2Fcreate%3Fstep%3Dstory");
    expect((screen.getByLabelText("账号") as HTMLInputElement).value).toBe("admin");
    submit();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/projects/p1/create?step=story"));
    const login = calls.find((call) => call.url === "/api/v1/auth/login")!;
    expect(login.init.method).toBe("POST");
    expect(JSON.parse(String(login.init.body))).toEqual({ username: "admin", password: PASSWORD });
  });
  it("goes to 我的作品 when opened directly, and never to another site", async () => {
    server(() => new Response("{}", { status: 200 }));
    open("?returnTo=https%3A%2F%2Fevil.example%2F");
    submit();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/studio"));
    cleanup(); replace.mockClear();
    open("");
    submit();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/studio"));
  });
  it("shows one message for a wrong username or password, clears the password and stays", async () => {
    server(() => new Response(JSON.stringify({ error: { code: "AUTH_LOGIN_FAILED" } }), { status: 401 }));
    open("?returnTo=%2Fstudio");
    submit();
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "账号或密码不正确。");
    expect((screen.getByLabelText("密码") as HTMLInputElement).value).toBe("");
    expect(replace).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(PASSWORD);
  });
  it("explains rate limiting and an unconfigured login service", async () => {
    server(() => new Response(JSON.stringify({ error: { code: "AUTH_RATE_LIMITED" } }), { status: 429 }));
    open(""); submit();
    expect((await screen.findByRole("alert")).textContent).toContain("过于频繁");
    cleanup();
    server(() => new Response(JSON.stringify({ error: { code: "AUTH_NOT_CONFIGURED" } }), { status: 503 }));
    open(""); submit();
    expect((await screen.findByRole("alert")).textContent).toContain("已拒绝访问");
  });
  it("says why the visitor is here when the session expired", async () => {
    server(() => new Response("{}"));
    open("?returnTo=%2Fadmin%2Fmodels&reason=expired");
    expect((await screen.findByRole("status")).textContent).toContain("登录已过期");
  });
  it("skips the form when the browser is already signed in", async () => {
    server(() => new Response("{}"), () => new Response(JSON.stringify({ enabled: true, authenticated: true })));
    open("?returnTo=%2Fadmin%2Fmodels");
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/admin/models"));
  });
  it("stores nothing in browser storage", async () => {
    const set = vi.spyOn(Storage.prototype, "setItem");
    server(() => new Response("{}"));
    open(""); submit();
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(set).not.toHaveBeenCalled();
  });
});
