// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RegisterPage } from "./register-page";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function session(body: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (String(input).endsWith("/auth/session") && (init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }
    if (String(input).endsWith("/auth/register") && init?.method === "POST") {
      return new Response(JSON.stringify({ error: { code: "AUTH_REGISTRATION_DISABLED", message: "公开自助注册未开启。" } }), {
        status: 403, headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  }));
}

describe("RegisterPage registration flag", () => {
  it("shows closed copy when the server flag is off", async () => {
    session({ enabled: true, authenticated: false, publicRegistrationEnabled: false });
    render(<RegisterPage />);
    expect((await screen.findByTestId("register-closed")).textContent).toContain("公开自助注册未开启");
    expect(screen.queryByRole("button", { name: "注册" })).toBeNull();
  });

  it("shows the form when the server flag is on", async () => {
    session({ enabled: true, authenticated: false, publicRegistrationEnabled: true });
    render(<RegisterPage />);
    expect(await screen.findByRole("button", { name: "注册" })).toBeTruthy();
    expect(screen.queryByTestId("register-closed")).toBeNull();
  });

  it("treats a 401 session answer as closed (safe default)", async () => {
    session({}, 401);
    render(<RegisterPage />);
    await waitFor(() => expect(screen.getByTestId("register-closed")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "注册" })).toBeNull();
  });
});
