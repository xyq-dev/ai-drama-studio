// @vitest-environment happy-dom
// UI and request-contract regressions with simulated fetch; not server or provider acceptance.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminModelsView } from "@ai-drama/contracts";
let AdminModels: typeof import("./admin-models")["AdminModels"];

const KEY = "provider-private-0123456789";
const CSRF = "c".repeat(43);
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }
function session() { return { enabled: true, authenticated: true, username: "admin", csrfToken: CSRF, expiresAt: new Date(Date.now() + 3600_000).toISOString() }; }
function modelView(overrides: Partial<AdminModelsView> = {}): AdminModelsView {
  const settings = { defaultProvider: "anthropic" as const, maxCallsPerDay: 8, maxActiveRuns: 1, providers: [
    { providerKey: "anthropic" as const, label: "Claude", models: ["account-claude-model"], baseUrl: "https://api.anthropic.com/v1/messages", keyConfigured: true, ready: true, missing: [] },
    { providerKey: "openai" as const, label: "OpenAI", models: [], baseUrl: "https://api.openai.com/v1/responses", keyConfigured: false, ready: false, missing: ["apiKey", "models"] },
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
async function ready() {
  await screen.findByRole("heading", { name: "模型配置" }); await screen.findByRole("button", { name: "校验并保存配置" });
  fireEvent.click(screen.getByRole("button", { name: /Claude Anthropic Messages API/ }));
  await screen.findByRole("region", { name: "Claude设置" });
}
function providerForm() { return within(screen.getByRole("region", { name: "Claude设置" })); }
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The ID must not continue, so one ID never also matches a longer one that starts with it.
function modelBox(id: string) { return providerForm().getByRole("checkbox", { name: new RegExp(`${escape(id)}(?![\\w.:-])`) }) as HTMLInputElement; }
function toggleModel(id: string) { fireEvent.click(modelBox(id)); }
function defaultSelect(region = providerForm()) { return region.getByRole("combobox", { name: /^默认模型/ }) as HTMLSelectElement; }
function chooseDefault(id: string) { fireEvent.change(defaultSelect(), { target: { value: id } }); }
function addCustom(id: string, enter = false) {
  const input = providerForm().getByLabelText(/^添加自定义模型 ID/) as HTMLInputElement;
  fireEvent.change(input, { target: { value: id } });
  if (enter) fireEvent.keyDown(input, { key: "Enter" });
  else fireEvent.click(providerForm().getByRole("button", { name: "添加" }));
}
function checkedModels() {
  return providerForm().getAllByRole("checkbox").filter((box) => (box as HTMLInputElement).checked)
    .map((box) => box.closest("label")!.querySelector("strong")!.firstChild!.textContent);
}
function chooseSecret(label: string) { fireEvent.click(screen.getByRole("radio", { name: label })); }
function keyInput() { return screen.getByLabelText(/^新的 API Key/) as HTMLInputElement; }
function save() { fireEvent.click(screen.getByRole("button", { name: "校验并保存配置" })); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

let assign: ReturnType<typeof vi.fn<(url: string | URL) => void>>;
beforeEach(async () => {
  // assign is mocked below; load a fresh document's modules instead of retaining a previous test's logout intent.
  vi.resetModules();
  ({ AdminModels } = await import("./admin-models"));
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
    expect(screen.getByText("account-claude-model")).toBeTruthy(); expect(modelBox("new-model-id").checked).toBe(true);
    expect(defaultSelect().value).toBe("new-model-id");
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
    const audit = () => screen.getByRole("heading", { name: "最近配置活动" }).parentElement!;
    const revisions = () => within(within(audit()).getByRole("list")).getAllByRole("listitem")
      .map((item) => item.lastElementChild?.textContent);
    expect(revisions()).toEqual(["v9", "v8", "v7", "v6", "v5", "v4", "v3", "v2"]);
    fireEvent.click(screen.getByRole("button", { name: /OpenAI Responses API/ }));
    expect(revisions()).toEqual(["v9", "v8", "v7", "v6", "v5", "v4", "v3", "v2"]);
  });
  it("explicitly saves keep without transmitting a key, with the session CSRF token, and preserves unsaved limits", async () => {
    const next = modelView({ savedRevision: 5, pendingRestart: true });
    next.saved.providers[0]!.models = ["claude-opus-5-5", "claude-haiku-5-5"];
    const calls = server((call) => call.method === "PUT" ? json(next) : undefined);
    render(<AdminModels />); await ready();
    toggleModel("claude-haiku-5-5"); toggleModel("claude-opus-5-5"); toggleModel("account-claude-model");
    chooseDefault("claude-opus-5-5");
    const daily = screen.getByLabelText(/^每日最多调用次数/) as HTMLInputElement;
    fireEvent.change(daily, { target: { value: "12" } });
    save(); await screen.findByText(/Claude配置已保存/);
    const write = calls.find((call) => call.method === "PUT")!;
    // The chosen default goes first: the API reads the first entry as the provider's default model.
    expect(write.body).toEqual({ expectedRevision: 4, models: ["claude-opus-5-5", "claude-haiku-5-5"], secretAction: "keep" });
    expect(checkedModels()).toEqual(["Claude Opus 5.5", "Claude Haiku 5.5"]); expect(defaultSelect().value).toBe("claude-opus-5-5");
    expect(csrfOf(write)).toBe(CSRF);
    expect(daily.value).toBe("12");
    expect(calls.some((call) => !call.url.startsWith("/api/v1/admin/") && !call.url.startsWith("/api/v1/auth/"))).toBe(false);
  });
  it("saves replacement only by explicit choice and clears the secret after success", async () => {
    const calls = server((call) => call.method === "PUT" ? json(modelView({ savedRevision: 5, pendingRestart: true })) : undefined);
    render(<AdminModels />); await ready(); chooseSecret("填写 / 替换"); fireEvent.change(keyInput(), { target: { value: KEY } }); save();
    await screen.findByText(/Claude配置已保存/);
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
    await screen.findByText(/Claude配置已保存/);
    expect(calls.find((call) => call.method === "PUT")!.body).toMatchObject({ secretAction: "clear" });
    expect(calls.find((call) => call.method === "PUT")!.body).not.toHaveProperty("apiKey");
  });
  it("preserves non-secret drafts on 409 and never retries the PUT automatically", async () => {
    const calls = server((call) => call.method === "PUT" ? json({ error: { code: "ADMIN_CONFIG_CONFLICT" } }, 409) : undefined);
    render(<AdminModels />); await ready(); addCustom("my-draft-model"); chooseDefault("my-draft-model");
    chooseSecret("填写 / 替换"); fireEvent.change(keyInput(), { target: { value: KEY } }); save();
    await screen.findByText(/配置已被其他管理员修改/);
    expect(modelBox("my-draft-model").checked).toBe(true); expect(defaultSelect().value).toBe("my-draft-model"); expect(keyInput().value).toBe("");
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
    fireEvent.click(screen.getByRole("checkbox", { name: /我确认放弃本页/ })); fireEvent.click(screen.getByRole("button", { name: "重新读取最新配置" }));
    await screen.findByText("已重新读取服务器配置。"); expect(checkedModels()).toEqual(["account-claude-model"]);
    expect(providerForm().queryByRole("checkbox", { name: /my-draft-model/ })).toBeNull();
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
    fireEvent.submit(providerForm().getByRole("button", { name: /正在保存/ }).closest("form")!);
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
    await act(async () => pending.resolve(json(modelView()))); await screen.findByText(/Claude配置已保存/);
  });
  it("saves rules separately, preserving a provider draft and leaving feature switches read-only", async () => {
    const calls = server(); render(<AdminModels />); await ready(); toggleModel("claude-haiku-5-5");
    fireEvent.change(screen.getByRole("combobox", { name: /^默认供应商/ }), { target: { value: "openai" } });
    fireEvent.change(screen.getByLabelText(/^每日最多调用次数/), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "保存调用规则" })); await screen.findByText(/调用规则已保存/);
    const write = calls.find((call) => call.method === "PUT")!;
    expect(write.body).toEqual({ expectedRevision: 4, defaultProvider: "openai", maxCallsPerDay: 20, maxActiveRuns: 1 });
    expect(csrfOf(write)).toBe(CSRF);
    expect(modelBox("claude-haiku-5-5").checked).toBe(true); expect(screen.queryByRole("switch")).toBeNull();
  });
  it("does not show false success after network loss and requires an explicit read before retry", async () => {
    const calls = server((call) => { if (call.method === "PUT") return Promise.reject(new Error("connection lost")); return undefined; });
    render(<AdminModels />); await ready(); save(); await screen.findByText(/操作结果尚未确认/);
    expect(screen.queryByText(/Claude配置已保存/)).toBeNull();
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
  it("rejects invalid custom model IDs locally without sending a PUT", async () => {
    const calls = server(); render(<AdminModels />); await ready(); addCustom("https://proxy/invalid");
    expect((await screen.findByRole("alert")).textContent).toMatch(/模型 ID 只能包含/);
    expect(providerForm().queryByRole("checkbox", { name: /proxy/ })).toBeNull();
    save(); await screen.findByText(/Claude配置已保存/);
    expect(calls.find((call) => call.method === "PUT")!.body).toMatchObject({ models: ["account-claude-model"] });
  });
  it("can recover from a settings read failure without logging in again", async () => {
    let reads = 0;
    const calls = server((call) => { if (call.url.endsWith("/admin/models") && ++reads === 1) return json({}, 503); return undefined; });
    render(<AdminModels />);
    await screen.findByRole("button", { name: "重新检查后台状态" }); fireEvent.click(screen.getByRole("button", { name: "重新检查后台状态" })); await ready();
    expect(calls.filter((call) => call.method !== "GET")).toHaveLength(0);
  });
});

describe("Claude quick setup: only the API key", () => {
  const unconfigured = () => {
    const view = modelView();
    for (const settings of [view.saved, view.active]) {
      settings.defaultProvider = null as never;
      settings.providers[0] = { ...settings.providers[0]!, models: [], keyConfigured: false, ready: false, missing: ["ANTHROPIC_API_KEY"] };
    }
    return view;
  };
  // A personal Console key (sk-ant-usr-), the kind the earlier sk-ant-api-only rule refused. Fake, test only.
  const CLAUDE = "sk-ant-usr-fake-personal-key-for-tests-only";

  it("says the key is missing, refuses a Claude Code token locally, and saves only the key with no model choice", async () => {
    let current = unconfigured();
    const calls = server((call) => {
      if (call.method === "PUT") {
        const saved = structuredClone(current);
        saved.savedRevision = 5; saved.pendingRestart = true; saved.saved.defaultProvider = "anthropic";
        saved.saved.providers[0] = { ...saved.saved.providers[0]!, models: ["claude-opus-5-5"], keyConfigured: true, ready: true, missing: [] };
        current = saved;
        return json(saved);
      }
      return call.url.endsWith("/auth/session") ? json(session()) : json(current);
    });
    render(<AdminModels />);
    const status = await screen.findByTestId("claude-status");
    expect(status.dataset.state).toBe("key_missing");
    expect(status.textContent).toContain("尚未配置 Claude API Key");
    expect(screen.getByText(/模型默认使用 claude-opus-5-5/)).toBeTruthy();
    const input = screen.getByLabelText(/^Claude API Key/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-ant-oat01-claude-code-oauth-token-abcdef" } });
    fireEvent.click(screen.getByRole("button", { name: /保存 Claude API Key/ }));
    expect(await screen.findByText(/不能用于调用 Claude API 的凭据/)).toBeTruthy();
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "sk-proj-openai-like-key-abcdef" } });
    fireEvent.click(screen.getByRole("button", { name: /保存 Claude API Key/ }));
    expect(await screen.findByText(/Claude API Key 的格式不受支持/)).toBeTruthy();
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);
    // The page never claims a Console key must start with sk-ant-api.
    expect(document.body.textContent).not.toMatch(/sk-ant-api 开头/);
    expect(screen.getByTestId("claude-workspace-hint").textContent).toBe("通常只需填写 API Key。若密钥未限定 Workspace，请在高级设置填写 Workspace ID，或创建限定 Workspace 的密钥。");
    fireEvent.change(input, { target: { value: CLAUDE } });
    fireEvent.click(screen.getByRole("button", { name: /保存 Claude API Key/ }));
    await waitFor(() => expect(screen.getByTestId("claude-status").dataset.state).toBe("pending_restart"));
    const put = calls.find((call) => call.method === "PUT")!;
    expect(put.url).toBe("/api/v1/admin/models/providers/anthropic");
    expect(put.body).toEqual({ expectedRevision: 4, models: [], secretAction: "replace", apiKey: CLAUDE });
    expect(csrfOf(put)).toBe(CSRF);
    // Saved is not usable yet: the page says a restart is needed, never READY, and the key is gone from the page.
    expect(screen.getByTestId("claude-status").textContent).toContain("等待 API 重启后生效");
    expect(screen.queryByText(/READY/)).toBeNull();
    expect((screen.getByLabelText(/^Claude API Key/) as HTMLInputElement).value).toBe("");
    expect(document.body.innerHTML).not.toContain(CLAUDE);
    expect(JSON.stringify({ ...window.localStorage, ...window.sessionStorage })).not.toContain(CLAUDE);
  });

  it("accepts a service account key with an optional workspace id, and checks the workspace id locally first", async () => {
    let current = unconfigured();
    const calls = server((call) => {
      if (call.method === "PUT") {
        const saved = structuredClone(current);
        saved.savedRevision = 5; saved.pendingRestart = true;
        saved.saved.providers[0] = { ...saved.saved.providers[0]!, models: ["claude-opus-5-5"], keyConfigured: true, ready: true, missing: [],
          workspaceId: "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ" };
        current = saved;
        return json(saved);
      }
      return call.url.endsWith("/auth/session") ? json(session()) : json(current);
    });
    render(<AdminModels />);
    await screen.findByTestId("claude-status");
    expect(screen.getByTestId("claude-workspace-current").textContent).toContain("未设置");
    const key = "sk-ant-svc-fake-service-key-for-tests-only";
    fireEvent.change(screen.getByLabelText(/^Claude API Key/), { target: { value: key } });
    fireEvent.change(screen.getByLabelText(/^Workspace ID/), { target: { value: "default" } });
    fireEvent.click(screen.getByRole("button", { name: /保存 Claude API Key/ }));
    expect(await screen.findByText(/Workspace ID 格式不正确/)).toBeTruthy();
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);
    fireEvent.change(screen.getByLabelText(/^Workspace ID/), { target: { value: "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ" } });
    fireEvent.click(screen.getByRole("button", { name: /保存 Claude API Key/ }));
    await waitFor(() => expect(screen.getByTestId("claude-status").dataset.state).toBe("pending_restart"));
    expect(calls.find((call) => call.method === "PUT")!.body).toEqual({ expectedRevision: 4, models: [], secretAction: "replace", apiKey: key,
      workspaceAction: "replace", workspaceId: "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ" });
    expect(screen.getByTestId("claude-workspace-current").textContent).toContain("wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ");
    expect(document.body.innerHTML).not.toContain(key);
  });

  it("with a saved key: clears only the workspace id, and shows the server's credential refusals as they are", async () => {
    let current = unconfigured();
    for (const settings of [current.saved, current.active]) {
      settings.providers[0] = { ...settings.providers[0]!, models: ["claude-opus-5-5"], keyConfigured: true, ready: true, missing: [],
        workspaceId: "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ" };
    }
    let refuse = true;
    const calls = server((call) => {
      if (call.method === "PUT" && refuse) return json({ error: { code: "ADMIN_CONFIG_KEY_KIND", message: "x" } }, 400);
      if (call.method === "PUT") {
        const saved = structuredClone(current);
        saved.savedRevision = 5; saved.pendingRestart = true;
        saved.saved.providers[0] = { ...saved.saved.providers[0]!, workspaceId: null };
        current = saved;
        return json(saved);
      }
      return call.url.endsWith("/auth/session") ? json(session()) : json(current);
    });
    render(<AdminModels />);
    await screen.findByTestId("claude-status");
    // A shape the page accepts but the server refuses as the wrong credential kind: its text, not a generic one.
    fireEvent.change(screen.getByLabelText(/^Claude API Key/), { target: { value: "sk-ant-usr-fake-personal-key-for-tests-only" } });
    fireEvent.click(screen.getByRole("button", { name: /保存 Claude API Key/ }));
    expect(await screen.findByText(/服务端拒绝：这是一种不能用于调用 Claude API 的凭据/)).toBeTruthy();
    refuse = false;
    fireEvent.click(screen.getByLabelText("清除已保存的 Workspace ID"));
    fireEvent.click(screen.getByRole("button", { name: /保存 Workspace 设置/ }));
    await waitFor(() => expect(screen.getByTestId("claude-workspace-current").textContent).toContain("未设置"));
    const puts = calls.filter((call) => call.method === "PUT");
    expect(puts.at(-1)!.body).toEqual({ expectedRevision: 4, models: ["claude-opus-5-5"], secretAction: "keep", workspaceAction: "clear" });
  });

  it("keeps saved, applied, feature switch, migrations and ready apart", async () => {
    const applied = modelView({ titleWriting: { enabled: true, productionBlocked: false, operatorConfigured: false, siteOperator: true },
      storage: { titleWriting: true, claude: false, candidates: true } });
    server((call) => call.url.endsWith("/auth/session") ? json(session()) : json(applied));
    render(<AdminModels />);
    const status = await screen.findByTestId("claude-status");
    expect(status.dataset.state).toBe("migration_missing");
    expect(status.textContent).toContain("20261016000100_writing_provider_anthropic");
    cleanup();
    server((call) => call.url.endsWith("/auth/session") ? json(session()) : json({ ...applied, storage: { titleWriting: true, claude: true, candidates: true } }));
    render(<AdminModels />);
    const ready = await screen.findByTestId("claude-status");
    expect(ready.dataset.state).toBe("ready");
    expect(ready.textContent).toContain("不代表已经完成真实调用验证");
  });
});

describe("DeepSeek quick setup: only the API key", () => {
  // Clearly fake, test only. DeepSeek documents no key prefix, so none is required.
  const DEEPSEEK = "fake-deepseek-console-test-key-0123456789";
  const deepseekEntry = (configured: boolean) => ({ providerKey: "deepseek" as const, label: "DeepSeek", models: configured ? ["deepseek-flash"] : [],
    baseUrl: "https://api.deepseek.com/chat/completions", keyConfigured: configured, ready: configured, missing: configured ? [] : ["DEEPSEEK_API_KEY"] });
  const withDeepseek = (configured: boolean) => {
    const view = modelView();
    for (const settings of [view.saved, view.active]) settings.providers.push(deepseekEntry(configured));
    return view;
  };

  it("asks only for the key, says saving makes it the default for new requests, refuses impossible keys locally and saves only the key", async () => {
    let current = withDeepseek(false);
    const calls = server((call) => {
      if (call.method === "PUT") {
        const saved = structuredClone(current);
        saved.savedRevision = 5; saved.pendingRestart = true; saved.saved.defaultProvider = "deepseek";
        saved.saved.providers[2] = deepseekEntry(true);
        current = saved;
        return json(saved);
      }
      return call.url.endsWith("/auth/session") ? json(session()) : json(current);
    });
    render(<AdminModels />);
    const status = await screen.findByTestId("deepseek-status");
    expect(status.dataset.state).toBe("key_missing");
    expect(status.textContent).toContain("尚未配置 DeepSeek API Key");
    const section = within(screen.getByRole("region", { name: "DeepSeek 快速配置" }));
    expect(section.getByText(/模型默认使用 deepseek-flash/)).toBeTruthy();
    expect(screen.getByTestId("deepseek-default-notice").textContent).toContain("保存 DeepSeek 快速配置会将 DeepSeek 设为新创作的默认供应商；只影响新发起的请求，不改变已有任务");
    // Only the key: no URL, workspace, operator token or model list to fill in.
    expect(section.queryAllByRole("textbox")).toHaveLength(0);
    expect(section.queryByLabelText(/Workspace|URL|令牌|模型/)).toBeNull();
    const input = section.getByLabelText(/^DeepSeek API Key/) as HTMLInputElement;
    expect(input.type).toBe("password");
    for (const bad of ["short-key", "fake deepseek key with spaces 0123", `${"x".repeat(15)}`]) {
      fireEvent.change(input, { target: { value: bad } });
      fireEvent.click(section.getByRole("button", { name: /保存 DeepSeek API Key/ }));
      expect(await section.findByText(/DeepSeek API Key 的格式不受支持/)).toBeTruthy();
      expect(input.value).toBe("");
    }
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);
    fireEvent.change(input, { target: { value: DEEPSEEK } });
    fireEvent.click(section.getByRole("button", { name: /保存 DeepSeek API Key/ }));
    await waitFor(() => expect(screen.getByTestId("deepseek-status").dataset.state).toBe("pending_restart"));
    const put = calls.find((call) => call.method === "PUT")!;
    expect(put.url).toBe("/api/v1/admin/models/providers/deepseek");
    expect(put.body).toEqual({ expectedRevision: 4, models: [], secretAction: "replace", apiKey: DEEPSEEK });
    expect(csrfOf(put)).toBe(CSRF);
    expect(document.body.textContent).toContain("DeepSeek 已设为新创作的默认供应商");
    expect(screen.getByTestId("deepseek-status").textContent).toContain("等待 API 重启后生效");
    expect(document.body.textContent).toContain("没有发起模型调用，格式检查不代表密钥有效或余额充足");
    expect((screen.getByLabelText(/^DeepSeek API Key/) as HTMLInputElement).value).toBe("");
    expect(document.body.innerHTML).not.toContain(DEEPSEEK);
    expect(JSON.stringify({ ...window.localStorage, ...window.sessionStorage })).not.toContain(DEEPSEEK);
    // Claude's quick setup and its key are untouched.
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });

  it("shows the server's refusal as it is and keeps nothing typed", async () => {
    const calls = server((call) => {
      if (call.method === "PUT") return json({ error: { code: "ADMIN_CONFIG_DEEPSEEK_KEY_FORMAT", message: "x" } }, 400);
      return call.url.endsWith("/auth/session") ? json(session()) : json(withDeepseek(false));
    });
    render(<AdminModels />);
    const section = within(await screen.findByRole("region", { name: "DeepSeek 快速配置" }));
    const input = section.getByLabelText(/^DeepSeek API Key/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: DEEPSEEK } });
    fireEvent.click(section.getByRole("button", { name: /保存 DeepSeek API Key/ }));
    expect(await section.findByText(/服务端拒绝：DeepSeek API Key 的格式不受支持/)).toBeTruthy();
    expect(input.value).toBe("");
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
    expect(document.body.innerHTML).not.toContain(DEEPSEEK);
  });

  it("keeps saved, applied, migration and ready apart, and names only the DeepSeek candidate migration", async () => {
    const view = withDeepseek(true);
    view.titleWriting = { enabled: true, productionBlocked: false, operatorConfigured: false, siteOperator: true };
    view.storage = { titleWriting: true, claude: true, candidates: true, deepseek: false };
    server((call) => call.url.endsWith("/auth/session") ? json(session()) : json(view));
    render(<AdminModels />);
    const status = await screen.findByTestId("deepseek-status");
    expect(status.dataset.state).toBe("migration_missing");
    expect(status.textContent).toContain("20261017000100_writing_candidate_deepseek");
    expect(status.textContent).not.toContain("20261016000100_writing_provider_anthropic");
    expect(screen.getByTestId("claude-status").dataset.state).toBe("ready");
    cleanup();
    view.storage = { titleWriting: true, claude: true, candidates: true, deepseek: true };
    server((call) => call.url.endsWith("/auth/session") ? json(session()) : json(view));
    render(<AdminModels />);
    const ready = await screen.findByTestId("deepseek-status");
    expect(ready.dataset.state).toBe("ready");
    expect(ready.textContent).toContain("这不代表已经完成真实调用验证；费用以 DeepSeek 账单为准");
  });

  it("lists exactly DeepSeek, Claude and OpenAI, and will not make DeepSeek the default before it has a key", async () => {
    const calls = server((call) => call.url.endsWith("/auth/session") ? json(session()) : json(withDeepseek(false)));
    render(<AdminModels />);
    await screen.findByRole("heading", { name: "模型配置" });
    const rail = within(screen.getByRole("complementary", { name: "模型供应商" }));
    expect(rail.getAllByRole("button").map((button) => button.querySelector("strong")?.textContent)).toEqual(["DeepSeek", "Claude", "OpenAI"]);
    expect(document.body.textContent).not.toMatch(/千问/);
    const select = screen.getByRole("combobox", { name: /^默认供应商/ }) as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(["", "deepseek", "anthropic", "openai"]);
    fireEvent.change(select, { target: { value: "deepseek" } });
    fireEvent.click(screen.getByRole("button", { name: "保存调用规则" }));
    expect(await screen.findByText(/DeepSeek 还没有保存 API Key，不能设为默认供应商/)).toBeTruthy();
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  });
});

describe("model picker on the provider settings", () => {
  const puts = (calls: Call[]) => calls.filter((call) => call.method === "PUT");
  const codes = (region: ReturnType<typeof within>) => region.getAllByRole("checkbox")
    .map((box: HTMLElement) => box.closest("label")!.querySelector("code")?.textContent);

  it("lists each candidate by name, exact ID and purpose, labelled 可用模型 and 默认模型 instead of a free text box", async () => {
    server(); render(<AdminModels />); await ready();
    expect(providerForm().queryByRole("textbox", { name: /允许使用的模型 ID/ })).toBeNull();
    expect(providerForm().getByRole("group", { name: "可用模型" })).toBeTruthy();
    const option = modelBox("claude-haiku-5-5").closest("label")!;
    expect(option.textContent).toContain("Claude Haiku 5.5"); expect(option.textContent).toContain("claude-haiku-5-5");
    expect(option.textContent).toContain("适合大批量、对延迟敏感的任务");
    expect(document.body.textContent).not.toMatch(/已验证可用|元\/|￥|\$\d/);
    expect(providerForm().getByText(/不代表账户已开通或已经真实调用验证/)).toBeTruthy();
  });

  it("filters candidates by search without dropping what is selected", async () => {
    server(); render(<AdminModels />); await ready();
    toggleModel("claude-fable-5-1");
    fireEvent.change(providerForm().getByRole("searchbox", { name: "搜索可用模型" }), { target: { value: "haiku" } });
    expect(codes(providerForm())).toEqual(["claude-haiku-5-5"]);
    expect([...defaultSelect().options].map((option) => option.value)).toEqual(["", "account-claude-model", "claude-fable-5-1"]);
    fireEvent.change(providerForm().getByRole("searchbox", { name: "搜索可用模型" }), { target: { value: "nothing-like-this" } });
    expect(providerForm().getByText(/没有匹配的候选模型/)).toBeTruthy();
  });

  it("restores saved models outside the candidate list as custom models, in their saved order, and saves them unchanged", async () => {
    const view = modelView(); view.saved.providers[0]!.models = ["legacy-claude-model", "claude-haiku-5-5", "old-account-model"];
    const calls = server((call) => call.url.endsWith("/admin/models") && call.method === "GET" ? json(view) : undefined);
    render(<AdminModels />); await ready();
    expect(checkedModels()).toEqual(["Claude Haiku 5.5", "legacy-claude-model", "old-account-model"]);
    for (const id of ["legacy-claude-model", "old-account-model"]) {
      expect(modelBox(id).checked).toBe(true); expect(modelBox(id).closest("label")!.textContent).toContain("自定义模型");
    }
    expect(defaultSelect().value).toBe("legacy-claude-model");
    expect(screen.queryByLabelText(/我确认放弃本页/)).toBeNull();
    save(); await screen.findByText(/Claude配置已保存/);
    expect(puts(calls)[0]!.body).toMatchObject({ models: ["legacy-claude-model", "claude-haiku-5-5", "old-account-model"] });
  });

  it("shows each saved ID once when the saved list repeats IDs, keeping the first as default", async () => {
    const view = modelView(); view.saved.providers[0]!.models = ["dup-model", "claude-haiku-5-5", "dup-model", "claude-haiku-5-5"];
    const calls = server((call) => call.url.endsWith("/admin/models") && call.method === "GET" ? json(view) : undefined);
    render(<AdminModels />); await ready();
    expect(providerForm().getAllByRole("checkbox", { name: /dup-model/ })).toHaveLength(1);
    expect(checkedModels()).toEqual(["Claude Haiku 5.5", "dup-model"]);
    expect(providerForm().getByText(/已选 2 \/ 10/)).toBeTruthy();
    expect(defaultSelect().value).toBe("dup-model");
    expect([...defaultSelect().options].map((option) => option.value)).toEqual(["", "dup-model", "claude-haiku-5-5"]);
    save(); await screen.findByText(/Claude配置已保存/);
    expect(puts(calls)[0]!.body).toMatchObject({ models: ["dup-model", "claude-haiku-5-5"] });
  });

  it("keeps an unselected custom model available to choose again", async () => {
    server(); render(<AdminModels />); await ready();
    toggleModel("claude-haiku-5-5"); chooseDefault("claude-haiku-5-5"); toggleModel("account-claude-model");
    expect(modelBox("account-claude-model").checked).toBe(false);
    toggleModel("account-claude-model"); expect(modelBox("account-claude-model").checked).toBe(true);
    expect(defaultSelect().value).toBe("claude-haiku-5-5");
  });

  it("asks for a new default when the default is unselected, never promoting another model silently", async () => {
    const calls = server(); render(<AdminModels />); await ready();
    toggleModel("claude-haiku-5-5"); toggleModel("account-claude-model");
    expect(defaultSelect().value).toBe("");
    expect(providerForm().getByText(/原默认模型已取消选择，请从已选模型中重新选择默认模型/)).toBeTruthy();
    save();
    expect((await providerForm().findByRole("alert")).textContent).toMatch(/重新选择默认模型/);
    expect(puts(calls)).toHaveLength(0);
    chooseDefault("claude-haiku-5-5"); save(); await screen.findByText(/Claude配置已保存/);
    expect(puts(calls)[0]!.body).toMatchObject({ models: ["claude-haiku-5-5"] });
  });

  it("requires at least one model and says so instead of asking for an ID", async () => {
    const calls = server(); render(<AdminModels />); await ready();
    toggleModel("account-claude-model");
    expect(providerForm().getByText(/^请选择至少一个模型。/)).toBeTruthy();
    expect(defaultSelect().disabled).toBe(true);
    save(); expect((await providerForm().findByRole("alert")).textContent).toMatch(/^请选择至少一个模型。如需清空该供应商的配置，请同时选择“清除密钥”/);
    expect(puts(calls)).toHaveLength(0);
  });

  it("configures a single provider on first use while the other two stay empty", async () => {
    const empty = modelView({ savedRevision: 0, activeRevision: 0 });
    for (const settings of [empty.saved, empty.active]) {
      settings.defaultProvider = null;
      for (const item of settings.providers) Object.assign(item, { models: [], keyConfigured: false, ready: false, missing: ["apiKey", "models"] });
    }
    const after = structuredClone(empty); after.savedRevision = 1; after.pendingRestart = true;
    Object.assign(after.saved.providers[1]!, { models: ["gpt-6-luna"], keyConfigured: true, ready: true, missing: [] });
    const calls = server((call) => call.method === "PUT" ? json(after) : call.url.endsWith("/admin/models") ? json(empty) : undefined);
    render(<AdminModels />); await ready();
    expect(checkedModels()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: /OpenAI Responses API/ }));
    const openai = within(screen.getByRole("region", { name: "OpenAI设置" }));
    chooseSecret("填写 / 替换"); fireEvent.change(keyInput(), { target: { value: KEY } });
    fireEvent.click(openai.getByRole("checkbox", { name: /gpt-6-luna/ }));
    fireEvent.change(defaultSelect(openai), { target: { value: "gpt-6-luna" } });
    save(); await screen.findByText(/OpenAI配置已保存/);
    expect(puts(calls)).toHaveLength(1);
    expect(puts(calls)[0]!.url).toBe("/api/v1/admin/models/providers/openai");
    expect(puts(calls)[0]!.body).toEqual({ expectedRevision: 0, models: ["gpt-6-luna"], secretAction: "replace", apiKey: KEY });
    expect(openai.queryByRole("alert")).toBeNull();
    // The other provider stays empty.
    fireEvent.click(screen.getByRole("button", { name: /Claude Anthropic Messages API/ }));
    expect(screen.getAllByRole("checkbox").filter((box) => (box as HTMLInputElement).checked)).toHaveLength(0);
  });

  it("still clears a key on a provider whose model list is empty", async () => {
    const view = modelView(); Object.assign(view.saved.providers[1]!, { keyConfigured: true });
    const calls = server((call) => call.method === "PUT" ? json(modelView({ savedRevision: 5 })) : call.url.endsWith("/admin/models") ? json(view) : undefined);
    render(<AdminModels />); await ready();
    fireEvent.click(screen.getByRole("button", { name: /OpenAI Responses API/ }));
    chooseSecret("清除密钥"); fireEvent.click(screen.getByRole("checkbox", { name: /我确认清除/ })); save();
    await screen.findByText(/OpenAI配置已保存/);
    expect(puts(calls)[0]!.body).toEqual({ expectedRevision: 4, models: [], secretAction: "clear" });
  });

  it("clears a whole provider by unselecting every model together with clearing the key", async () => {
    const calls = server((call) => call.method === "PUT" ? json(modelView({ savedRevision: 5 })) : undefined);
    render(<AdminModels />); await ready();
    toggleModel("account-claude-model"); chooseSecret("清除密钥");
    expect(providerForm().getByText(/保存后将清空该供应商的模型列表并清除密钥/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /我确认清除/ })); save();
    await screen.findByText(/Claude配置已保存/);
    expect(puts(calls)[0]!.body).toEqual({ expectedRevision: 4, models: [], secretAction: "clear" });
  });

  it("adds a custom ID from advanced settings with Enter, without submitting the form", async () => {
    const calls = server(); render(<AdminModels />); await ready();
    addCustom("  my-account-model  ", true);
    expect(modelBox("my-account-model").checked).toBe(true);
    expect(modelBox("my-account-model").closest("label")!.textContent).toContain("自定义模型");
    expect(puts(calls)).toHaveLength(0);
    addCustom("claude-fable-5-1");
    expect(modelBox("claude-fable-5-1").checked).toBe(true);
    expect(modelBox("claude-fable-5-1").closest("label")!.textContent).not.toContain("自定义模型");
    addCustom("claude-fable-5-1"); expect(providerForm().getByRole("alert").textContent).toMatch(/已在可用模型中/);
  });

  it("stops at ten models, matching the server limit", async () => {
    server(); render(<AdminModels />); await ready();
    for (let index = 0; index < 9; index += 1) addCustom(`custom-${index}`);
    expect(checkedModels()).toHaveLength(10);
    expect(modelBox("claude-haiku-5-5").disabled).toBe(true);
    addCustom("custom-extra"); expect(providerForm().getByRole("alert").textContent).toMatch(/最多选择 10 个模型/);
    expect(providerForm().getByText(/已选 10 \/ 10/)).toBeTruthy();
  });

  it("keeps the selection, default and draft when the save is rejected", async () => {
    const calls = server((call) => call.method === "PUT" ? json({ error: { code: "ADMIN_CONFIG_INVALID" } }, 400) : undefined);
    render(<AdminModels />); await ready();
    toggleModel("claude-sonnet-5-5"); chooseDefault("claude-sonnet-5-5"); addCustom("draft-only-model");
    save(); await screen.findByText(/配置格式不正确/);
    expect(checkedModels()).toEqual(["Claude Sonnet 5.5", "account-claude-model", "draft-only-model"]);
    expect(defaultSelect().value).toBe("claude-sonnet-5-5");
    // The endpoint is fixed to the official Messages API and cannot be edited or sent.
    expect((providerForm().getByLabelText(/^服务端点/) as HTMLInputElement).readOnly).toBe(true);
    expect((providerForm().getByLabelText(/^服务端点/) as HTMLInputElement).value).toBe("https://api.anthropic.com/v1/messages");
    expect(puts(calls)[0]!.body).not.toHaveProperty("baseUrl");
    expect(puts(calls)[0]!.body).toMatchObject({ models: ["claude-sonnet-5-5", "account-claude-model", "draft-only-model"] });
  });

  it("keeps each provider's candidates and drafts separate when switching", async () => {
    const calls = server(); render(<AdminModels />); await ready();
    toggleModel("claude-haiku-5-5"); addCustom("claude-only-custom");
    fireEvent.click(screen.getByRole("button", { name: /OpenAI Responses API/ }));
    const openai = within(screen.getByRole("region", { name: "OpenAI设置" }));
    expect(codes(openai)).toEqual(["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"]);
    expect(openai.queryByText(/claude/i)).toBeNull();
    expect(defaultSelect(openai).disabled).toBe(true);
    fireEvent.click(openai.getByRole("checkbox", { name: /gpt-6-luna/ }));
    fireEvent.change(defaultSelect(openai), { target: { value: "gpt-6-luna" } });
    fireEvent.click(screen.getByRole("button", { name: /Claude Anthropic Messages API/ }));
    fireEvent.click(screen.getByRole("button", { name: /OpenAI Responses API/ }));
    expect(defaultSelect(within(screen.getByRole("region", { name: "OpenAI设置" }))).value).toBe("gpt-6-luna");
    fireEvent.click(screen.getByRole("button", { name: /Claude Anthropic Messages API/ }));
    expect(checkedModels()).toEqual(["Claude Haiku 5.5", "account-claude-model", "claude-only-custom"]);
    save(); await screen.findByText(/Claude配置已保存/);
    expect(puts(calls)).toHaveLength(1);
    expect(puts(calls)[0]!.url).toMatch(/\/anthropic$/);
    expect(puts(calls)[0]!.body).toMatchObject({ models: ["account-claude-model", "claude-haiku-5-5", "claude-only-custom"] });
  });

  it("only filters on Enter in the search box and never submits the provider form", async () => {
    const calls = server(); render(<AdminModels />); await ready();
    chooseSecret("清除密钥"); fireEvent.click(screen.getByRole("checkbox", { name: /我确认清除/ }));
    const search = providerForm().getByRole("searchbox", { name: "搜索可用模型" });
    fireEvent.change(search, { target: { value: "fable" } });
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    search.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(codes(within(providerForm().getByRole("list", { name: "候选模型" })))).toEqual(["claude-fable-5-1"]);
    expect(puts(calls)).toHaveLength(0);
  });

  it("keeps a typed but unadded custom ID with its provider's draft and clears it on reading the server config", async () => {
    server(); render(<AdminModels />); await ready();
    const customInput = () => providerForm().getByLabelText(/^添加自定义模型 ID/) as HTMLInputElement;
    fireEvent.change(customInput(), { target: { value: "half-typed-claude" } });
    fireEvent.click(screen.getByRole("button", { name: /OpenAI Responses API/ }));
    const openai = within(screen.getByRole("region", { name: "OpenAI设置" }));
    expect((openai.getByLabelText(/^添加自定义模型 ID/) as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: /Claude Anthropic Messages API/ }));
    expect(customInput().value).toBe("half-typed-claude");
    expect(screen.queryByLabelText(/我确认放弃本页/)).toBeNull();
    fireEvent.change(providerForm().getByRole("searchbox", { name: "搜索可用模型" }), { target: { value: "flash" } });
    fireEvent.click(screen.getByRole("button", { name: "重新读取最新配置" }));
    await screen.findByText("已重新读取服务器配置。");
    expect(customInput().value).toBe("");
    expect((providerForm().getByRole("searchbox", { name: "搜索可用模型" }) as HTMLInputElement).value).toBe("");
  });

  it("counts a picker change as unsaved, so reading the server config asks first", async () => {
    server(); render(<AdminModels />); await ready();
    expect(screen.queryByLabelText(/我确认放弃本页/)).toBeNull();
    toggleModel("claude-haiku-5-5");
    expect(screen.getByLabelText(/我确认放弃本页/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "重新读取最新配置" }) as HTMLButtonElement).disabled).toBe(true);
    toggleModel("claude-haiku-5-5");
    expect(screen.queryByLabelText(/我确认放弃本页/)).toBeNull();
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
    toggleModel("claude-fable-5-1"); toggleModel("account-claude-model");
    chooseSecret("填写 / 替换"); fireEvent.change(keyInput(), { target: { value: KEY } });
    await waitFor(() => expect(passiveCalls(calls)).toHaveLength(1), { timeout: 3000 });
    await act(async () => { await Promise.resolve(); });
    expect(assign).not.toHaveBeenCalled();
    expect(checkedModels()).toEqual(["Claude Fable 5.1"]); expect(defaultSelect().value).toBe("");
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
      toggleModel("claude-haiku-5-5");
      await waitFor(() => expect(passiveCalls(calls)).toHaveLength(1), { timeout: 3000 });
      await act(async () => { await Promise.resolve(); });
      expect(assign).not.toHaveBeenCalled();
      expect(screen.getByRole("heading", { name: "模型配置" })).toBeTruthy();
      expect(checkedModels()).toEqual(["Claude Haiku 5.5", "account-claude-model"]);
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
