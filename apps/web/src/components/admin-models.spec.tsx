// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminModelsView } from "@ai-drama/contracts";
import { deepseekStatusText, claudeStatusText } from "./admin-models";

let AdminModels: typeof import("./admin-models")["AdminModels"];

const KEY = "provider-private-0123456789";
const CSRF = "c".repeat(43);
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }
function session() {
  return { enabled: true, authenticated: true, username: "admin", role: "operator", csrfToken: CSRF, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
}
function modelView(overrides: Partial<AdminModelsView> = {}): AdminModelsView {
  const settings = {
    defaultProvider: "deepseek" as const,
    maxCallsPerDay: 30,
    maxActiveRuns: 1,
    providers: [
      { providerKey: "deepseek" as const, label: "DeepSeek", models: ["deepseek-flash"], baseUrl: "https://api.deepseek.com/chat/completions", keyConfigured: true, ready: true, missing: [] },
      { providerKey: "anthropic" as const, label: "Claude", models: ["claude-opus-5-5"], baseUrl: "https://api.anthropic.com/v1/messages", keyConfigured: true, ready: true, missing: [] },
      { providerKey: "openai" as const, label: "OpenAI", models: [], baseUrl: "https://api.openai.com/v1/responses", keyConfigured: false, ready: false, missing: ["apiKey", "models"] },
    ],
  };
  return {
    savedRevision: 4, activeRevision: 4, pendingRestart: false, activationDeferred: false, source: "managed",
    titleWriting: { enabled: true, productionBlocked: false, operatorConfigured: true, siteOperator: true },
    storage: { titleWriting: true, claude: true, candidates: true, deepseek: true },
    saved: structuredClone(settings), active: structuredClone(settings), audit: [], validation: "local_only", ...overrides,
  };
}
type Call = { url: string; init: RequestInit; method: string; body: Record<string, unknown> | null };
function server(handler?: (call: Call) => Response | Promise<Response> | undefined) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const call: Call = { url, init, method: init.method ?? "GET", body: typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null };
    calls.push(call);
    return handler?.(call) ?? (url.endsWith("/auth/session") ? json(session())
      : url.endsWith("/auth/logout") ? new Response(null, { status: 204 }) : json(modelView()));
  }));
  return calls;
}
async function ready() {
  await screen.findByRole("heading", { name: "文本模型" });
  await screen.findByRole("button", { name: "保存设置" });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let assign: ReturnType<typeof vi.fn<(url: string | URL) => void>>;
beforeEach(async () => {
  vi.resetModules();
  ({ AdminModels } = await import("./admin-models"));
  window.history.replaceState(null, "", "/admin/models");
  document.cookie = `ads_csrf=${CSRF}; Path=/`;
  assign = vi.fn<(url: string | URL) => void>();
  vi.spyOn(window.location, "assign").mockImplementation(assign);
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  window.localStorage.clear(); window.sessionStorage.clear();
  document.cookie = "ads_csrf=; Max-Age=0; Path=/";
});

describe("admin models console V2", () => {
  it("sends signed-out visitors to login and never shows settings", async () => {
    const calls = server((call) => call.url.endsWith("/auth/session") ? json({ error: { code: "AUTH_REQUIRED" } }, 401) : undefined);
    render(<AdminModels />);
    expect(await screen.findByRole("link", { name: /前往登录/ })).toBeTruthy();
    expect(assign).toHaveBeenCalledWith("/login?returnTo=%2Fadmin%2Fmodels&reason=expired");
    expect(calls.map((call) => call.url)).toEqual(["/api/v1/auth/session"]);
    expect(screen.queryByRole("button", { name: "保存设置" })).toBeNull();
  });

  it("stays closed when site login is off", async () => {
    const calls = server((call) => call.url.endsWith("/auth/session") ? json({ enabled: false, authenticated: false }) : undefined);
    render(<AdminModels />);
    expect(await screen.findByText(/站点统一登录尚未启用，模型后台保持关闭/)).toBeTruthy();
    expect(calls.some((call) => call.url.includes("/admin/models"))).toBe(false);
  });

  it("shows initialization guidance when storage is unavailable", async () => {
    server((call) => call.url.endsWith("/admin/models") ? json({ error: { code: "ADMIN_NOT_CONFIGURED" } }, 503) : undefined);
    render(<AdminModels />);
    expect(await screen.findByText(/请联系服务器管理员完成安全存储初始化/)).toBeTruthy();
  });

  it("loads providers, shows masked keys, and never persists secrets in browser storage", async () => {
    const local = vi.spyOn(Storage.prototype, "setItem");
    const calls = server();
    render(<AdminModels />);
    await ready();
    expect(calls.map((call) => call.url)).toEqual(["/api/v1/auth/session", "/api/v1/admin/models"]);
    expect(screen.getByText("可以用于写作")).toBeTruthy();
    expect(screen.getByText(/新任务将使用默认模型/)).toBeTruthy();
    expect(screen.getByLabelText("更换服务密钥").textContent).toMatch(/••••/);
    expect(document.body.textContent).not.toContain(KEY);
    expect(local).not.toHaveBeenCalled();
  });

  it("switches provider and clears unsubmitted key input", async () => {
    server();
    render(<AdminModels />);
    await ready();
    fireEvent.click(screen.getByLabelText("更换服务密钥"));
    fireEvent.change(screen.getByTestId("writing-key-input"), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("tab", { name: /Claude/ }));
    expect(screen.queryByDisplayValue(KEY)).toBeNull();
    expect(screen.getByRole("heading", { name: "Claude 写作设置" })).toBeTruthy();
  });

  it("saves provider settings and reports success without calling vendors", async () => {
    const calls = server((call) => {
      if (call.method === "PUT") return json(modelView({ savedRevision: 5 }));
      return undefined;
    });
    render(<AdminModels />);
    await ready();
    fireEvent.click(screen.getByLabelText("更换服务密钥"));
    fireEvent.change(screen.getByTestId("writing-key-input"), { target: { value: "sk-deepseek-valid-key-123456" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    expect(await screen.findByText("设置已保存")).toBeTruthy();
    const put = calls.find((call) => call.method === "PUT")!;
    expect(put.url).toBe("/api/v1/admin/models/providers/deepseek");
    expect(put.body).toMatchObject({ secretAction: "replace", expectedRevision: 4 });
    expect(JSON.stringify(put.body)).not.toMatch(/sk-deepseek-valid-key-123456$/); // still in body for the request, but:
    expect((put.body as { apiKey: string }).apiKey).toBe("sk-deepseek-valid-key-123456");
    expect(screen.queryByDisplayValue("sk-deepseek-valid-key-123456")).toBeNull();
  });

  it("disables double-submit while saving", async () => {
    const pending = deferred<Response>();
    server((call) => call.method === "PUT" ? pending.promise : undefined);
    render(<AdminModels />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    expect((await screen.findByRole("button", { name: "正在保存…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("tab", { name: /OpenAI/ }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => pending.resolve(json(modelView({ savedRevision: 5 }))));
    await screen.findByText("设置已保存");
  });

  it("keeps the draft and prompts re-read on version conflict", async () => {
    server((call) => call.method === "PUT" ? json({ error: { code: "ADMIN_CONFIG_CONFLICT" } }, 409) : undefined);
    render(<AdminModels />);
    await ready();
    fireEvent.click(screen.getByLabelText("更换服务密钥"));
    fireEvent.change(screen.getByTestId("writing-key-input"), { target: { value: "sk-deepseek-valid-key-123456" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    expect(await screen.findByText(/配置已被其他管理员修改/)).toBeTruthy();
    expect(screen.getAllByText(/请重新读取最新配置/).length).toBeGreaterThan(0);
  });

  it("re-reads current config with clear feedback", async () => {
    const calls = server();
    render(<AdminModels />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    expect(await screen.findByText("已重新读取当前配置")).toBeTruthy();
    expect(calls.filter((call) => call.url.endsWith("/admin/models") && call.method === "GET")).toHaveLength(2);
  });

  it("expands call limits and saves without inventing ready values", async () => {
    const calls = server((call) => {
      if (call.url.endsWith("/admin/models/limits")) return json(modelView({
        saved: { ...modelView().saved, maxCallsPerDay: 40, maxActiveRuns: 2 },
        active: { ...modelView().active, maxCallsPerDay: 40, maxActiveRuns: 2 },
        savedRevision: 5,
      }));
      return undefined;
    });
    render(<AdminModels />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "调用限制" }));
    const panel = screen.getByTestId("limits-panel");
    fireEvent.change(within(panel).getByLabelText("每天最多调用"), { target: { value: "40" } });
    fireEvent.change(within(panel).getByLabelText("同时运行任务数"), { target: { value: "2" } });
    fireEvent.click(within(panel).getByRole("button", { name: "保存限制" }));
    expect(await screen.findByText("设置已保存")).toBeTruthy();
    const put = calls.find((call) => call.url.endsWith("/admin/models/limits"))!;
    expect(put.body).toMatchObject({ maxCallsPerDay: 40, maxActiveRuns: 2, expectedRevision: 4 });
  });

  it("keeps a retryable form after save failure", async () => {
    server((call) => call.method === "PUT" ? json({ error: { code: "NETWORK" } }, 0) : undefined);
    render(<AdminModels />);
    await ready();
    fireEvent.click(screen.getByLabelText("更换服务密钥"));
    fireEvent.change(screen.getByTestId("writing-key-input"), { target: { value: "sk-deepseek-valid-key-123456" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    expect(await screen.findByText(/操作结果尚未确认/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "保存设置" })).toBeTruthy();
  });
});

describe("writing status copy", () => {
  it("maps ready to the product rule, never inventing vendor readiness", () => {
    expect(deepseekStatusText("ready", []).title).toBe("可以用于写作");
    expect(deepseekStatusText("ready", []).detail).toContain("新任务将使用默认模型");
    expect(claudeStatusText("key_missing", []).tone).toBe("warning");
    expect(claudeStatusText("pending_restart", []).title).toMatch(/等待生效/);
  });
});
