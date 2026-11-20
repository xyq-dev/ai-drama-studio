// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AdminMediaKeysView } from "@ai-drama/contracts";
import { mediaKeyStatus } from "./admin-media-keys";

let AdminMediaKeys: typeof import("./admin-media-keys")["AdminMediaKeys"];

const KEY = "synthetic-ui-media-key-never-saved-in-storage";
const CSRF = "c".repeat(43);

function mediaView(overrides: Partial<AdminMediaKeysView> = {}): AdminMediaKeysView {
  return {
    savedRevision: 0,
    pendingRestart: false,
    source: "environment",
    validation: "local_only",
    notices: ["填写密钥不等于自动发起付费生成；正式出图、配音、成片仍须先报价并经用户确认。"],
    slots: [
      {
        slot: "OPENAI_MEDIA_API_KEY",
        label: "OpenAI 生图",
        hint: "仅用于正式生图",
        keyConfigured: false,
        status: "empty",
        managed: false,
        source: "none",
        priceConfigured: false,
        serviceState: "unconfigured",
      },
      {
        slot: "DASHSCOPE_MEDIA_API_KEY",
        label: "百炼生图 / 视频",
        hint: "百炼正式生图与视频同源",
        keyConfigured: false,
        status: "empty",
        managed: false,
        source: "none",
        priceConfigured: false,
        serviceState: "unconfigured",
      },
      {
        slot: "MINIMAX_API_KEY",
        label: "MiniMax 正式配音",
        hint: "仅用于正式配音 MiniMax speech-2.8-hd",
        keyConfigured: true,
        status: "saved",
        managed: true,
        source: "managed",
        priceConfigured: false,
        serviceState: "saved_not_ready",
      },
    ],
    ...overrides,
  };
}

type Call = { url: string; method: string; body?: string };
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function server(handler?: (call: Call) => Response | undefined) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : undefined;
      const call = { url, method, body };
      calls.push(call);
      const custom = handler?.(call);
      if (custom) return custom;
      if (url.endsWith("/auth/session")) {
        return json({
          enabled: true,
          authenticated: true,
          username: "admin",
          role: "operator",
          csrfToken: CSRF,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });
      }
      if (url.endsWith("/admin/media-keys") && method === "GET") return json(mediaView());
      if (url.endsWith("/admin/media-keys") && method === "PUT") {
        const parsed = JSON.parse(body ?? "{}") as { slot?: string; secretAction?: string };
        const slots = mediaView().slots.map((slot) =>
          slot.slot === parsed.slot
            ? {
                ...slot,
                managed: true,
                keyConfigured: parsed.secretAction !== "clear",
                status: parsed.secretAction === "clear" ? ("empty" as const) : ("saved" as const),
                source: parsed.secretAction === "clear" ? ("none" as const) : ("managed" as const),
                serviceState: parsed.secretAction === "clear" ? ("unconfigured" as const) : ("saved_not_ready" as const),
                priceConfigured: false,
              }
            : slot,
        );
        return json(mediaView({ savedRevision: 1, source: "managed", slots }));
      }
      return json({ error: { code: "NOT_FOUND" } }, 404);
    }),
  );
  return calls;
}

async function ready() {
  await waitFor(() => expect(screen.getByTestId("media-key-editor")).toBeTruthy());
}

let assign: ReturnType<typeof vi.fn<(url: string | URL) => void>>;
beforeEach(async () => {
  vi.resetModules();
  ({ AdminMediaKeys } = await import("./admin-media-keys"));
  window.history.replaceState(null, "", "/admin/media-keys");
  document.cookie = `ads_csrf=${CSRF}; Path=/`;
  assign = vi.fn<(url: string | URL) => void>();
  vi.spyOn(window.location, "assign").mockImplementation(assign);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.cookie = "ads_csrf=; Max-Age=0; Path=/";
});

describe("admin media keys console V2", () => {
  it("sends guests to login", async () => {
    const calls = server((call) => call.url.endsWith("/auth/session") ? json({ error: { code: "AUTH_REQUIRED" } }, 401) : undefined);
    render(<AdminMediaKeys />);
    expect(await screen.findByRole("link", { name: /前往登录/ })).toBeTruthy();
    expect(calls.map((call) => call.url)).toEqual(["/api/v1/auth/session"]);
  });

  it("rejects creator sessions client-side", async () => {
    server((call) => call.url.endsWith("/auth/session")
      ? json({ enabled: true, authenticated: true, role: "creator", csrfToken: CSRF, expiresAt: new Date(Date.now() + 3600_000).toISOString() })
      : undefined);
    render(<AdminMediaKeys />);
    expect(await screen.findByText(/当前账号不是管理员/)).toBeTruthy();
    expect(screen.queryByTestId("media-key-editor")).toBeNull();
  });

  it("defaults to MiniMax, shows masked key, and derives status from the server", async () => {
    const calls = server();
    render(<AdminMediaKeys />);
    await ready();
    expect(calls.map((call) => call.url)).toEqual(["/api/v1/auth/session", "/api/v1/admin/media-keys"]);
    expect(screen.getByRole("tab", { name: /角色配音/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("配置还不完整")).toBeTruthy();
    expect(screen.getByLabelText("已保存的密钥（掩码）").textContent).toMatch(/••••/);
    expect(document.body.textContent).not.toContain("密钥已保存，请在服务端设置每字单价");
    expect(screen.getByTestId("media-key-checks").textContent).toMatch(/单价：待核验/);
  });

  it("clears unsubmitted key input when switching vendors", async () => {
    server();
    render(<AdminMediaKeys />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "更换密钥" }));
    fireEvent.change(screen.getByTestId("media-key-input"), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("tab", { name: /图像生成/ }));
    expect(screen.queryByDisplayValue(KEY)).toBeNull();
    expect(screen.getByRole("heading", { name: "OpenAI 服务密钥" })).toBeTruthy();
  });

  it("replaces a key and reports save success without echoing plaintext", async () => {
    const calls = server();
    render(<AdminMediaKeys />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "更换密钥" }));
    fireEvent.change(screen.getByTestId("media-key-input"), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: "保存密钥" }));
    expect(await screen.findByText("设置已保存")).toBeTruthy();
    const put = calls.find((call) => call.method === "PUT")!;
    expect(JSON.parse(put.body ?? "{}")).toMatchObject({
      slot: "MINIMAX_API_KEY",
      secretAction: "replace",
      apiKey: KEY,
    });
    expect(screen.queryByDisplayValue(KEY)).toBeNull();
    expect(document.body.textContent).not.toContain(KEY);
  });

  it("requires confirmation before clear and cancels back to the prior state", async () => {
    const calls = server();
    render(<AdminMediaKeys />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "清除密钥" }));
    expect(screen.getByRole("heading", { name: "清除 MiniMax 密钥" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "确认清除" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByRole("heading", { name: "MiniMax 服务密钥" })).toBeTruthy();
    expect(screen.getByLabelText("已保存的密钥（掩码）")).toBeTruthy();
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("clears a key after confirmation", async () => {
    const calls = server();
    render(<AdminMediaKeys />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "清除密钥" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /我确认清除这项服务的密钥/ }));
    fireEvent.click(screen.getByRole("button", { name: "确认清除" }));
    expect(await screen.findByText("设置已保存")).toBeTruthy();
    const put = calls.find((call) => call.method === "PUT")!;
    expect(JSON.parse(put.body ?? "{}")).toMatchObject({ slot: "MINIMAX_API_KEY", secretAction: "clear" });
  });

  it("re-reads status without changing the key", async () => {
    const calls = server();
    render(<AdminMediaKeys />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    expect(await screen.findByText("已重新读取当前配置")).toBeTruthy();
    expect(calls.filter((call) => call.url.endsWith("/admin/media-keys") && call.method === "GET")).toHaveLength(2);
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("shows empty OpenAI state without faking success", async () => {
    server();
    render(<AdminMediaKeys />);
    await ready();
    fireEvent.click(screen.getByRole("tab", { name: /图像生成/ }));
    expect(screen.getByText("尚未配置密钥")).toBeTruthy();
    expect(screen.getByRole("button", { name: "填写密钥" })).toBeTruthy();
    expect(screen.queryByText("可以用于当前用途")).toBeNull();
  });
});

describe("mediaKeyStatus", () => {
  it("never hardcodes the Figma voiceover example and marks unknown gaps as 待核验", () => {
    const saved = mediaView().slots.find((slot) => slot.slot === "MINIMAX_API_KEY")!;
    const status = mediaKeyStatus(saved);
    expect(status.detail).not.toContain("请在服务端设置每字单价");
    expect(status.detail).toMatch(/单价尚未配置|未就绪|待核验/);
    expect(mediaKeyStatus(undefined).title).toBe("尚未配置密钥");
    expect(mediaKeyStatus({ ...saved, serviceState: "ready", priceConfigured: true, status: "saved" }).tone).toBe("success");
  });
});
