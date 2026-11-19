// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AdminMediaKeysView } from "@ai-drama/contracts";

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
        hint: "仅用于正式配音",
        keyConfigured: false,
        status: "empty",
        managed: false,
        source: "none",
        priceConfigured: false,
        serviceState: "unconfigured",
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
  await waitFor(() => expect(screen.getByTestId("media-keys-overview")).toBeTruthy());
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
  window.localStorage.clear();
  window.sessionStorage.clear();
  document.cookie = "ads_csrf=; Max-Age=0; Path=/";
});

describe("administrator media key settings", () => {
  it("sends a signed-out visitor to login and never shows key inputs", async () => {
    server((call) => (call.url.endsWith("/auth/session") ? json({ error: { code: "AUTH_REQUIRED" } }, 401) : undefined));
    render(<AdminMediaKeys />);
    expect(await screen.findByRole("link", { name: /前往登录/ })).toBeTruthy();
    expect(assign).toHaveBeenCalledWith("/login?returnTo=%2Fadmin%2Fmedia-keys&reason=expired");
    expect(screen.queryByTestId("media-key-input")).toBeNull();
  });

  it("reads only redacted status and never asks to reveal a key", async () => {
    const calls = server();
    render(<AdminMediaKeys />);
    await ready();
    expect(screen.getAllByText("未填写").length).toBeGreaterThan(0);
    expect(screen.getByTestId("media-keys-notices").textContent).toContain("填写密钥不等于自动发起付费生成");
    expect(document.body.textContent).not.toContain(KEY);
    expect(calls.map((call) => call.url)).toEqual(["/api/v1/auth/session", "/api/v1/admin/media-keys"]);
  });

  it("saves replace/clear with keep/replace/clear radios and clears the password input", async () => {
    const calls = server();
    render(<AdminMediaKeys />);
    await ready();
    fireEvent.click(screen.getByTestId("media-key-slot-MINIMAX_API_KEY"));
    fireEvent.click(screen.getByRole("radio", { name: "填写 / 替换" }));
    fireEvent.change(screen.getByTestId("media-key-input"), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: /保存此槽位/ }));
    await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
    const put = calls.find((call) => call.method === "PUT")!;
    expect(JSON.parse(put.body!)).toMatchObject({
      slot: "MINIMAX_API_KEY",
      secretAction: "replace",
      apiKey: KEY,
    });
    await waitFor(() => expect(screen.queryByTestId("media-key-input")).toBeNull());
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("shows waiting-for-restart honestly when the API reports pendingRestart", async () => {
    server((call) => {
      if (call.url.endsWith("/admin/media-keys") && call.method === "GET") {
        return json(
          mediaView({
            pendingRestart: true,
            slots: mediaView().slots.map((slot) =>
              slot.slot === "DASHSCOPE_MEDIA_API_KEY"
                ? { ...slot, managed: true, status: "pending_restart", keyConfigured: false, source: "managed" }
                : slot,
            ),
          }),
        );
      }
      return undefined;
    });
    render(<AdminMediaKeys />);
    await ready();
    expect(screen.getByTestId("media-keys-pending-restart").textContent).toContain("等待进程重启");
    expect(screen.getByTestId("media-key-slot-DASHSCOPE_MEDIA_API_KEY").textContent).toContain("等待重启");
  });

  it("distinguishes key-saved from service-ready using real serviceState fields", async () => {
    server((call) => {
      if (call.url.endsWith("/admin/media-keys") && call.method === "GET") {
        return json(
          mediaView({
            slots: mediaView().slots.map((slot) => {
              if (slot.slot === "MINIMAX_API_KEY") {
                return {
                  ...slot,
                  keyConfigured: true,
                  status: "saved" as const,
                  managed: true,
                  source: "managed" as const,
                  priceConfigured: false,
                  serviceState: "saved_not_ready" as const,
                };
              }
              if (slot.slot === "OPENAI_MEDIA_API_KEY") {
                return {
                  ...slot,
                  keyConfigured: true,
                  status: "saved" as const,
                  managed: true,
                  source: "managed" as const,
                  priceConfigured: true,
                  serviceState: "ready" as const,
                };
              }
              return slot;
            }),
          }),
        );
      }
      return undefined;
    });
    render(<AdminMediaKeys />);
    await ready();
    expect(screen.getByTestId("media-key-slot-MINIMAX_API_KEY").textContent).toContain("服务尚未就绪");
    expect(screen.getByTestId("media-key-slot-OPENAI_MEDIA_API_KEY").textContent).toContain("服务可用");
    fireEvent.click(screen.getByTestId("media-key-slot-MINIMAX_API_KEY"));
    expect(screen.getByText("服务尚未就绪 · 单价尚未配置")).toBeTruthy();
    expect(screen.getByText(/「密钥已保存」不等于「服务可用」/)).toBeTruthy();
  });
});
