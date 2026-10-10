// @vitest-environment happy-dom
// UI and request-contract regressions with simulated fetch; not server or provider acceptance.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminModelsView } from "@ai-drama/contracts";
import { AdminModels } from "./admin-models";

const KEY = "provider-private-0123456789";
const CSRF = "c".repeat(43);
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }
function session() { return { enabled: true, authenticated: true, username: "admin", csrfToken: CSRF, expiresAt: new Date(Date.now() + 3600_000).toISOString() }; }
function modelView(overrides: Partial<AdminModelsView> = {}): AdminModelsView {
  const settings = { defaultProvider: "qwen" as const, maxCallsPerDay: 8, maxActiveRuns: 1, providers: [
    { providerKey: "qwen" as const, label: "千问", models: ["account-qwen-model"], baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", keyConfigured: true, ready: true, missing: [] },
    { providerKey: "openai" as const, label: "OpenAI", models: [], baseUrl: "https://api.openai.com/v1/responses", keyConfigured: false, ready: false, missing: ["apiKey", "models"] },
    { providerKey: "deepseek" as const, label: "DeepSeek", models: [], baseUrl: "https://api.deepseek.com/chat/completions", keyConfigured: false, ready: false, missing: ["apiKey", "models"] },
  ] };
  return { savedRevision: 4, activeRevision: 4, pendingRestart: false, activationDeferred: false, source: "managed",
    titleWriting: { enabled: false, productionBlocked: false, operatorConfigured: true },
    saved: structuredClone(settings), active: structuredClone(settings), audit: [], validation: "local_only", ...overrides };
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
const csrfOf = (call: Call) => new Headers(call.init.headers).get("X-CSRF-Token");
async function ready() { await screen.findByRole("heading", { name: "模型配置" }); await screen.findByRole("button", { name: "校验并保存配置" }); }
function providerForm() { return within(screen.getByRole("region", { name: "千问设置" })); }
function modelsInput() { return providerForm().getByLabelText(/^允许使用的模型 ID/) as HTMLTextAreaElement; }
function chooseSecret(label: string) { fireEvent.click(screen.getByRole("radio", { name: label })); }
function keyInput() { return screen.getByLabelText(/^新的 API Key/) as HTMLInputElement; }
function save() { fireEvent.click(screen.getByRole("button", { name: "校验并保存配置" })); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

let assign: ReturnType<typeof vi.fn<(url: string | URL) => void>>;
beforeEach(() => {
  window.history.replaceState(null, "", "/admin/models");
  document.cookie = `ads_csrf=${CSRF}; Path=/`;
  assign = vi.fn<(url: string | URL) => void>();
  vi.spyOn(window.location, "assign").mockImplementation(assign);
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.localStorage.clear(); window.sessionStorage.clear();
  document.cookie = "ads_csrf=; Max-Age=0; Path=/";
});

describe("administrator model settings behind the site login", () => {
  it("sends a signed-out visitor to the login page and returns them here, never showing settings", async () => {
    const calls = server((call) => call.url.endsWith("/auth/session") ? json({ error: { code: "AUTH_REQUIRED" } }, 401) : undefined);
    render(<AdminModels />);
    expect(await screen.findByRole("link", { name: /前往登录/ })).toBeTruthy();
    expect(assign).toHaveBeenCalledWith("/login?returnTo=%2Fadmin%2Fmodels&reason=expired");
    expect(calls.map((call) => call.url)).toEqual(["/api/v1/auth/session"]);
    expect(screen.queryByRole("heading", { name: "默认选择与使用限额" })).toBeNull();
    expect(screen.queryByLabelText(/令牌/)).toBeNull();
  });
  it("stays closed when the site login is switched off", async () => {
    const calls = server((call) => call.url.endsWith("/auth/session") ? json({ enabled: false, authenticated: false }) : undefined);
    render(<AdminModels />);
    expect(await screen.findByText(/站点统一登录尚未启用，模型后台保持关闭/)).toBeTruthy();
    expect(calls.some((call) => call.url.includes("/admin/models"))).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });
  it("shows initialization guidance when the console storage is unavailable", async () => {
    server((call) => call.url.endsWith("/admin/models") ? json({ error: { code: "ADMIN_NOT_CONFIGURED" } }, 503) : undefined);
    render(<AdminModels />);
    expect(await screen.findByText(/请联系服务器管理员完成安全存储初始化/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "重新检查后台状态" })).toBeTruthy();
  });
  it("stores neither the session, CSRF nor provider keys in browser storage", async () => {
    const local = vi.spyOn(Storage.prototype, "setItem");
    server();
    render(<AdminModels />); await ready(); chooseSecret("填写 / 替换"); fireEvent.change(keyInput(), { target: { value: KEY } });
    expect(local).not.toHaveBeenCalled(); expect(window.localStorage.length).toBe(0); expect(window.sessionStorage.length).toBe(0);
  });
  it("shows saved/active differences, pending restart, deferred activation and disabled feature honestly", async () => {
    const next = modelView({ savedRevision: 5, pendingRestart: true, activationDeferred: true });
    next.saved.providers[0]!.models = ["new-model-id"];
    server((call) => call.url.endsWith("/models") ? json(next) : undefined);
    render(<AdminModels />); await ready();
    expect(screen.getByText("v5")).toBeTruthy(); expect(screen.getByText("v4")).toBeTruthy();
    expect(screen.getByText("配置已保存，等待 API 重启生效")).toBeTruthy();
    expect(screen.getByText("有创作任务尚未结束，配置应用已推迟")).toBeTruthy();
    expect(screen.getByText("account-qwen-model")).toBeTruthy(); expect(modelsInput().value).toBe("new-model-id");
    expect(screen.getByText("未开启")).toBeTruthy(); expect(screen.queryByRole("button", { name: /启用|测试调用|重启/ })).toBeNull();
  });
  it("reads only redacted settings and never asks to reveal a key", async () => {
    const calls = server(); render(<AdminModels />); await ready();
    expect(screen.getByText("已保存 · 不可读取")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /显示密钥|查看密钥/ })).toBeNull();
    expect(screen.queryByLabelText(/^新的 API Key/)).toBeNull();
    expect(calls.map((call) => call.url)).toEqual(["/api/v1/auth/session", "/api/v1/admin/models"]);
  });
  it("shows the newest eight audit entries first and preserves that order on rerender", async () => {
    const next = modelView({ audit: Array.from({ length: 9 }, (_, index) => ({
      at: `2026-10-10T00:00:0${index}Z`, action: "limits_updated" as const, revision: index + 1,
    })) });
    server((call) => call.url.endsWith("/models") ? json(next) : undefined);
    render(<AdminModels />); await ready();
    const revisions = () => within(screen.getByRole("list")).getAllByRole("listitem")
      .map((item) => item.lastElementChild?.textContent);
    expect(revisions()).toEqual(["v9", "v8", "v7", "v6", "v5", "v4", "v3", "v2"]);
    fireEvent.click(screen.getByRole("button", { name: /OpenAI Responses API/ }));
    expect(revisions()).toEqual(["v9", "v8", "v7", "v6", "v5", "v4", "v3", "v2"]);
  });
  it("explicitly saves keep without transmitting a key, with the session CSRF token, and preserves unsaved limits", async () => {
    const next = modelView({ savedRevision: 5, pendingRestart: true }); next.saved.providers[0]!.models = ["m-1", "m-2"];
    const calls = server((call) => call.method === "PUT" ? json(next) : undefined);
    render(<AdminModels />); await ready();
    fireEvent.change(modelsInput(), { target: { value: "m-1\nm-2, m-1" } });
    const daily = screen.getByLabelText(/^每日最多调用次数/) as HTMLInputElement;
    fireEvent.change(daily, { target: { value: "12" } });
    save(); await screen.findByText(/千问配置已保存/);
    const write = calls.find((call) => call.method === "PUT")!;
    expect(write.body).toEqual({ expectedRevision: 4, models: ["m-1", "m-2"], baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", secretAction: "keep" });
    expect(csrfOf(write)).toBe(CSRF);
    expect(daily.value).toBe("12");
    expect(calls.some((call) => !call.url.startsWith("/api/v1/admin/") && !call.url.startsWith("/api/v1/auth/"))).toBe(false);
  });
  it("saves replacement only by explicit choice and clears the secret after success", async () => {
    const calls = server((call) => call.method === "PUT" ? json(modelView({ savedRevision: 5, pendingRestart: true })) : undefined);
    render(<AdminModels />); await ready(); chooseSecret("填写 / 替换"); fireEvent.change(keyInput(), { target: { value: KEY } }); save();
    await screen.findByText(/千问配置已保存/);
    expect(calls.find((call) => call.method === "PUT")!.body).toMatchObject({ secretAction: "replace", apiKey: KEY });
    expect(screen.queryByLabelText(/^新的 API Key/)).toBeNull(); chooseSecret("填写 / 替换"); expect(keyInput().value).toBe("");
  });
  it("clears replacement after rejection and requires re-entry", async () => {
    const calls = server((call) => call.method === "PUT" ? json({ error: { code: "ADMIN_CONFIG_INVALID", message: KEY } }, 400) : undefined);
    render(<AdminModels />); await ready(); chooseSecret("填写 / 替换"); fireEvent.change(keyInput(), { target: { value: KEY } }); save();
    await screen.findByText(/本次密钥输入已清空/); expect(keyInput().value).toBe(""); expect(document.body.textContent).not.toContain(KEY);
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });
  it("requires deliberate confirmation before clearing a configured key", async () => {
    const calls = server(); render(<AdminModels />); await ready(); chooseSecret("清除密钥");
    expect((screen.getByRole("button", { name: "校验并保存配置" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /我确认清除/ })); save();
    await screen.findByText(/千问配置已保存/);
    expect(calls.find((call) => call.method === "PUT")!.body).toMatchObject({ secretAction: "clear" });
    expect(calls.find((call) => call.method === "PUT")!.body).not.toHaveProperty("apiKey");
  });
  it("preserves non-secret drafts on 409 and never retries the PUT automatically", async () => {
    const calls = server((call) => call.method === "PUT" ? json({ error: { code: "ADMIN_CONFIG_CONFLICT" } }, 409) : undefined);
    render(<AdminModels />); await ready(); fireEvent.change(modelsInput(), { target: { value: "my-draft-model" } });
    chooseSecret("填写 / 替换"); fireEvent.change(keyInput(), { target: { value: KEY } }); save();
    await screen.findByText(/配置已被其他管理员修改/);
    expect(modelsInput().value).toBe("my-draft-model"); expect(keyInput().value).toBe("");
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
    fireEvent.click(screen.getByRole("checkbox", { name: /我确认放弃本页/ })); fireEvent.click(screen.getByRole("button", { name: "重新读取最新配置" }));
    await screen.findByText("已重新读取服务器配置。"); expect(modelsInput().value).toBe("account-qwen-model");
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });
  it("clears the view and all sensitive input and returns to login when a save finds the session expired", async () => {
    server((call) => call.method === "PUT" ? json({ error: { code: "AUTH_SESSION_EXPIRED" } }, 401) : undefined);
    render(<AdminModels />); await ready(); chooseSecret("填写 / 替换"); fireEvent.change(keyInput(), { target: { value: KEY } }); save();
    await screen.findByRole("link", { name: /前往登录/ });
    expect(assign).toHaveBeenCalledWith("/login?returnTo=%2Fadmin%2Fmodels&reason=expired");
    expect(screen.queryByLabelText(/^新的 API Key/)).toBeNull();
    expect(screen.queryByRole("heading", { name: "模型配置" })).toBeNull();
    expect(document.body.textContent).not.toContain(KEY);
  });
  it("freezes supplier switching and double submission while saving", async () => {
    const pending = deferred<Response>();
    const calls = server((call) => call.method === "PUT" ? pending.promise : undefined);
    render(<AdminModels />); await ready(); save();
    const openai = screen.getByRole("button", { name: /OpenAI Responses API/ }) as HTMLButtonElement;
    expect(openai.disabled).toBe(true); fireEvent.click(openai);
    fireEvent.submit(providerForm().getByLabelText(/^允许使用的模型 ID/).closest("form")!);
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
    await act(async () => pending.resolve(json(modelView()))); await screen.findByText(/千问配置已保存/);
  });
  it("saves rules separately, preserving a provider draft and leaving feature switches read-only", async () => {
    const calls = server(); render(<AdminModels />); await ready(); fireEvent.change(modelsInput(), { target: { value: "unsaved-model" } });
    fireEvent.change(screen.getByRole("combobox", { name: /^默认供应商/ }), { target: { value: "deepseek" } });
    fireEvent.change(screen.getByLabelText(/^每日最多调用次数/), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "保存调用规则" })); await screen.findByText(/调用规则已保存/);
    const write = calls.find((call) => call.method === "PUT")!;
    expect(write.body).toEqual({ expectedRevision: 4, defaultProvider: "deepseek", maxCallsPerDay: 20, maxActiveRuns: 1 });
    expect(csrfOf(write)).toBe(CSRF);
    expect(modelsInput().value).toBe("unsaved-model"); expect(screen.queryByRole("switch")).toBeNull();
  });
  it("does not show false success after network loss and requires an explicit read before retry", async () => {
    const calls = server((call) => { if (call.method === "PUT") return Promise.reject(new Error("connection lost")); return undefined; });
    render(<AdminModels />); await ready(); save(); await screen.findByText(/操作结果尚未确认/);
    expect(screen.queryByText(/千问配置已保存/)).toBeNull();
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });
  it("logs out of the whole site with the session CSRF token and goes to the login page", async () => {
    const calls = server();
    render(<AdminModels />); await ready(); fireEvent.click(screen.getByRole("button", { name: "退出" }));
    await screen.findByText("已退出登录。");
    const out = calls.find((call) => call.url === "/api/v1/auth/logout")!;
    expect(out.method).toBe("POST");
    expect(csrfOf(out)).toBe(CSRF);
    expect(assign).toHaveBeenCalledWith("/login?returnTo=%2Fadmin%2Fmodels&reason=signed-out");
    expect(screen.queryByRole("heading", { name: "模型配置" })).toBeNull();
  });
  it("does not claim logout succeeded if its receipt is lost", async () => {
    server((call) => call.url.endsWith("/auth/logout") ? Promise.reject(new Error("network")) : undefined);
    render(<AdminModels />); await ready(); chooseSecret("填写 / 替换"); fireEvent.change(keyInput(), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: "退出" })); await screen.findByText(/退出尚未确认/);
    expect(screen.getByRole("heading", { name: "模型配置" })).toBeTruthy(); expect(screen.queryByLabelText(/^新的 API Key/)).toBeNull();
    expect(assign).not.toHaveBeenCalled();
  });
  it("discards a late successful save from an unmounted session", async () => {
    const pending = deferred<Response>(); server((call) => call.method === "PUT" ? pending.promise : undefined);
    const mount = render(<AdminModels />); await ready(); save(); mount.unmount();
    server((call) => call.url.endsWith("/auth/session") ? json({ error: { code: "AUTH_REQUIRED" } }, 401) : undefined);
    render(<AdminModels />); await screen.findByRole("link", { name: /前往登录/ });
    await act(async () => pending.resolve(json(modelView({ savedRevision: 9 }))));
    expect(screen.queryByRole("heading", { name: "模型配置" })).toBeNull(); expect(screen.queryByText("v9")).toBeNull();
  });
  it("rejects invalid model IDs locally without sending a PUT", async () => {
    const calls = server(); render(<AdminModels />); await ready(); fireEvent.change(modelsInput(), { target: { value: "https://proxy/invalid" } }); save();
    await screen.findByText(/请检查模型 ID/); expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  });
  it("can recover from a settings read failure without logging in again", async () => {
    let reads = 0;
    const calls = server((call) => { if (call.url.endsWith("/admin/models") && ++reads === 1) return json({}, 503); return undefined; });
    render(<AdminModels />);
    await screen.findByRole("button", { name: "重新检查后台状态" }); fireEvent.click(screen.getByRole("button", { name: "重新检查后台状态" })); await ready();
    expect(calls.filter((call) => call.method !== "GET")).toHaveLength(0);
  });
});

describe("session expiry check on the model console (S4)", () => {
  const soon = () => ({ ...session(), expiresAt: new Date(Date.now() + 300).toISOString() });
  const later = () => ({ ...session(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  const passiveCalls = (calls: Call[]) => calls.filter((call) => call.url.endsWith("/auth/session")
    && new Headers(call.init.headers).get("X-Session-Check") === "passive");

  it("keeps unsaved edits and only moves its timer when the session was extended meanwhile", async () => {
    let first = true;
    const calls = server((call) => {
      if (!call.url.endsWith("/auth/session")) return undefined;
      if (first) { first = false; return json(soon()); }
      return json(later());
    });
    render(<AdminModels />); await ready();
    fireEvent.change(modelsInput(), { target: { value: "unsaved-draft-model" } });
    chooseSecret("填写 / 替换"); fireEvent.change(keyInput(), { target: { value: KEY } });
    await waitFor(() => expect(passiveCalls(calls)).toHaveLength(1), { timeout: 3000 });
    await act(async () => { await Promise.resolve(); });
    expect(assign).not.toHaveBeenCalled();
    expect(modelsInput().value).toBe("unsaved-draft-model");
    expect(keyInput().value).toBe(KEY);
    // The settings were not read again: a renewal never reinstalls the view.
    expect(calls.filter((call) => call.url.endsWith("/admin/models"))).toHaveLength(1);
  });

  it("clears sensitive input and goes to the login only when the server confirms the session ended", async () => {
    let first = true;
    const calls = server((call) => {
      if (!call.url.endsWith("/auth/session")) return undefined;
      if (first) { first = false; return json(soon()); }
      return json({ error: { code: "AUTH_SESSION_EXPIRED" } }, 401);
    });
    render(<AdminModels />); await ready();
    chooseSecret("填写 / 替换"); fireEvent.change(keyInput(), { target: { value: KEY } });
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login?returnTo=%2Fadmin%2Fmodels&reason=expired"), { timeout: 3000 });
    expect(passiveCalls(calls)).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "模型配置" })).toBeNull();
    expect(screen.queryByLabelText(/^新的 API Key/)).toBeNull();
    expect(document.body.textContent).not.toContain(KEY);
  });

  it("does not treat a failed check as a logout: nothing is cleared and nobody is sent away", async () => {
    for (const failure of [() => Promise.reject(new Error("offline")), () => Promise.resolve(json({ error: { code: "AUTH_NOT_CONFIGURED" } }, 503))]) {
      let first = true;
      const calls = server((call) => {
        if (!call.url.endsWith("/auth/session")) return undefined;
        if (first) { first = false; return json(soon()); }
        return failure();
      });
      render(<AdminModels />); await ready();
      fireEvent.change(modelsInput(), { target: { value: "kept-model" } });
      await waitFor(() => expect(passiveCalls(calls)).toHaveLength(1), { timeout: 3000 });
      await act(async () => { await Promise.resolve(); });
      expect(assign).not.toHaveBeenCalled();
      expect(screen.getByRole("heading", { name: "模型配置" })).toBeTruthy();
      expect(modelsInput().value).toBe("kept-model");
      cleanup();
    }
  });

  it("ignores a late answer that arrives after the page was left", async () => {
    let first = true;
    const pending = deferred<Response>();
    const calls = server((call) => {
      if (!call.url.endsWith("/auth/session")) return undefined;
      if (first) { first = false; return json(soon()); }
      return pending.promise;
    });
    const mount = render(<AdminModels />); await ready();
    await waitFor(() => expect(passiveCalls(calls)).toHaveLength(1), { timeout: 3000 });
    mount.unmount();
    await act(async () => pending.resolve(json({ error: { code: "AUTH_SESSION_EXPIRED" } }, 401)));
    expect(assign).not.toHaveBeenCalled();
  });
});
