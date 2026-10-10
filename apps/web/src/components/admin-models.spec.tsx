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
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The ID must not continue, so "qwen3.7-plus" does not also match "qwen3.7-plus-2026-05-26".
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
    expect(screen.getByText("account-qwen-model")).toBeTruthy(); expect(modelBox("new-model-id").checked).toBe(true);
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
    next.saved.providers[0]!.models = ["qwen3.7-plus-2026-05-26", "qwen3.8-flash"];
    const calls = server((call) => call.method === "PUT" ? json(next) : undefined);
    render(<AdminModels />); await ready();
    toggleModel("qwen3.8-flash"); toggleModel("qwen3.7-plus-2026-05-26"); toggleModel("account-qwen-model");
    chooseDefault("qwen3.7-plus-2026-05-26");
    const daily = screen.getByLabelText(/^每日最多调用次数/) as HTMLInputElement;
    fireEvent.change(daily, { target: { value: "12" } });
    save(); await screen.findByText(/千问配置已保存/);
    const write = calls.find((call) => call.method === "PUT")!;
    // The chosen default goes first: the API reads the first entry as the provider's default model.
    expect(write.body).toEqual({ expectedRevision: 4, models: ["qwen3.7-plus-2026-05-26", "qwen3.8-flash"], baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", secretAction: "keep" });
    expect(checkedModels()).toEqual(["Qwen3.7-Plus（固定快照）", "Qwen3.8-Flash"]); expect(defaultSelect().value).toBe("qwen3.7-plus-2026-05-26");
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
    render(<AdminModels />); await ready(); addCustom("my-draft-model"); chooseDefault("my-draft-model");
    chooseSecret("填写 / 替换"); fireEvent.change(keyInput(), { target: { value: KEY } }); save();
    await screen.findByText(/配置已被其他管理员修改/);
    expect(modelBox("my-draft-model").checked).toBe(true); expect(defaultSelect().value).toBe("my-draft-model"); expect(keyInput().value).toBe("");
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
    fireEvent.click(screen.getByRole("checkbox", { name: /我确认放弃本页/ })); fireEvent.click(screen.getByRole("button", { name: "重新读取最新配置" }));
    await screen.findByText("已重新读取服务器配置。"); expect(checkedModels()).toEqual(["account-qwen-model"]);
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
    await act(async () => pending.resolve(json(modelView()))); await screen.findByText(/千问配置已保存/);
  });
  it("saves rules separately, preserving a provider draft and leaving feature switches read-only", async () => {
    const calls = server(); render(<AdminModels />); await ready(); toggleModel("qwen3.8-flash");
    fireEvent.change(screen.getByRole("combobox", { name: /^默认供应商/ }), { target: { value: "deepseek" } });
    fireEvent.change(screen.getByLabelText(/^每日最多调用次数/), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "保存调用规则" })); await screen.findByText(/调用规则已保存/);
    const write = calls.find((call) => call.method === "PUT")!;
    expect(write.body).toEqual({ expectedRevision: 4, defaultProvider: "deepseek", maxCallsPerDay: 20, maxActiveRuns: 1 });
    expect(csrfOf(write)).toBe(CSRF);
    expect(modelBox("qwen3.8-flash").checked).toBe(true); expect(screen.queryByRole("switch")).toBeNull();
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
  it("rejects invalid custom model IDs locally without sending a PUT", async () => {
    const calls = server(); render(<AdminModels />); await ready(); addCustom("https://proxy/invalid");
    expect((await screen.findByRole("alert")).textContent).toMatch(/模型 ID 只能包含/);
    expect(providerForm().queryByRole("checkbox", { name: /proxy/ })).toBeNull();
    save(); await screen.findByText(/千问配置已保存/);
    expect(calls.find((call) => call.method === "PUT")!.body).toMatchObject({ models: ["account-qwen-model"] });
  });
  it("can recover from a settings read failure without logging in again", async () => {
    let reads = 0;
    const calls = server((call) => { if (call.url.endsWith("/admin/models") && ++reads === 1) return json({}, 503); return undefined; });
    render(<AdminModels />);
    await screen.findByRole("button", { name: "重新检查后台状态" }); fireEvent.click(screen.getByRole("button", { name: "重新检查后台状态" })); await ready();
    expect(calls.filter((call) => call.method !== "GET")).toHaveLength(0);
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
    const option = modelBox("qwen3.8-flash").closest("label")!;
    expect(option.textContent).toContain("Qwen3.8-Flash"); expect(option.textContent).toContain("qwen3.8-flash");
    expect(option.textContent).toContain("可关闭思考模式");
    expect(document.body.textContent).not.toMatch(/已验证可用|元\/|￥|\$\d/);
    expect(providerForm().getByText(/不代表账户已开通或已经真实调用验证/)).toBeTruthy();
  });

  it("filters candidates by search without dropping what is selected", async () => {
    server(); render(<AdminModels />); await ready();
    toggleModel("qwen3.8-max");
    fireEvent.change(providerForm().getByRole("searchbox", { name: "搜索可用模型" }), { target: { value: "flash" } });
    expect(codes(providerForm())).toEqual(["qwen3.8-flash"]);
    expect([...defaultSelect().options].map((option) => option.value)).toEqual(["", "account-qwen-model", "qwen3.8-max"]);
    fireEvent.change(providerForm().getByRole("searchbox", { name: "搜索可用模型" }), { target: { value: "nothing-like-this" } });
    expect(providerForm().getByText(/没有匹配的候选模型/)).toBeTruthy();
  });

  it("restores saved models outside the candidate list as custom models, in their saved order, and saves them unchanged", async () => {
    const view = modelView(); view.saved.providers[0]!.models = ["legacy-qwen-model", "qwen3.8-flash", "old-account-model"];
    const calls = server((call) => call.url.endsWith("/admin/models") && call.method === "GET" ? json(view) : undefined);
    render(<AdminModels />); await ready();
    expect(checkedModels()).toEqual(["Qwen3.8-Flash", "legacy-qwen-model", "old-account-model"]);
    for (const id of ["legacy-qwen-model", "old-account-model"]) {
      expect(modelBox(id).checked).toBe(true); expect(modelBox(id).closest("label")!.textContent).toContain("自定义模型");
    }
    expect(defaultSelect().value).toBe("legacy-qwen-model");
    expect(screen.queryByLabelText(/我确认放弃本页/)).toBeNull();
    save(); await screen.findByText(/千问配置已保存/);
    expect(puts(calls)[0]!.body).toMatchObject({ models: ["legacy-qwen-model", "qwen3.8-flash", "old-account-model"] });
  });

  it("keeps an unselected custom model available to choose again", async () => {
    server(); render(<AdminModels />); await ready();
    toggleModel("qwen3.8-flash"); chooseDefault("qwen3.8-flash"); toggleModel("account-qwen-model");
    expect(modelBox("account-qwen-model").checked).toBe(false);
    toggleModel("account-qwen-model"); expect(modelBox("account-qwen-model").checked).toBe(true);
    expect(defaultSelect().value).toBe("qwen3.8-flash");
  });

  it("asks for a new default when the default is unselected, never promoting another model silently", async () => {
    const calls = server(); render(<AdminModels />); await ready();
    toggleModel("qwen3.8-flash"); toggleModel("account-qwen-model");
    expect(defaultSelect().value).toBe("");
    expect(providerForm().getByText(/原默认模型已取消选择，请从已选模型中重新选择默认模型/)).toBeTruthy();
    save();
    expect((await providerForm().findByRole("alert")).textContent).toMatch(/重新选择默认模型/);
    expect(puts(calls)).toHaveLength(0);
    chooseDefault("qwen3.8-flash"); save(); await screen.findByText(/千问配置已保存/);
    expect(puts(calls)[0]!.body).toMatchObject({ models: ["qwen3.8-flash"] });
  });

  it("requires at least one model and says so instead of asking for an ID", async () => {
    const calls = server(); render(<AdminModels />); await ready();
    toggleModel("account-qwen-model");
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
    for (const name of [/千问 阿里云百炼/, /DeepSeek Chat Completions API/]) {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(screen.getAllByRole("checkbox").filter((box) => (box as HTMLInputElement).checked)).toHaveLength(0);
    }
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
    toggleModel("account-qwen-model"); chooseSecret("清除密钥");
    expect(providerForm().getByText(/保存后将清空该供应商的模型列表并清除密钥/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /我确认清除/ })); save();
    await screen.findByText(/千问配置已保存/);
    expect(puts(calls)[0]!.body).toEqual({ expectedRevision: 4, models: [], baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", secretAction: "clear" });
  });

  it("adds a custom ID from advanced settings with Enter, without submitting the form", async () => {
    const calls = server(); render(<AdminModels />); await ready();
    addCustom("  my-account-model  ", true);
    expect(modelBox("my-account-model").checked).toBe(true);
    expect(modelBox("my-account-model").closest("label")!.textContent).toContain("自定义模型");
    expect(puts(calls)).toHaveLength(0);
    addCustom("qwen3.8-max");
    expect(modelBox("qwen3.8-max").checked).toBe(true);
    expect(modelBox("qwen3.8-max").closest("label")!.textContent).not.toContain("自定义模型");
    addCustom("qwen3.8-max"); expect(providerForm().getByRole("alert").textContent).toMatch(/已在可用模型中/);
  });

  it("stops at ten models, matching the server limit", async () => {
    server(); render(<AdminModels />); await ready();
    for (let index = 0; index < 9; index += 1) addCustom(`custom-${index}`);
    expect(checkedModels()).toHaveLength(10);
    expect(modelBox("qwen3.8-flash").disabled).toBe(true);
    addCustom("custom-extra"); expect(providerForm().getByRole("alert").textContent).toMatch(/最多选择 10 个模型/);
    expect(providerForm().getByText(/已选 10 \/ 10/)).toBeTruthy();
  });

  it("keeps the selection, default and draft when the save is rejected", async () => {
    const calls = server((call) => call.method === "PUT" ? json({ error: { code: "ADMIN_CONFIG_INVALID" } }, 400) : undefined);
    render(<AdminModels />); await ready();
    toggleModel("qwen3.7-plus"); chooseDefault("qwen3.7-plus"); addCustom("draft-only-model");
    fireEvent.change(providerForm().getByLabelText(/^服务端点/), { target: { value: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" } });
    save(); await screen.findByText(/配置格式不正确/);
    expect(checkedModels()).toEqual(["Qwen3.7-Plus", "account-qwen-model", "draft-only-model"]);
    expect(defaultSelect().value).toBe("qwen3.7-plus");
    expect((providerForm().getByLabelText(/^服务端点/) as HTMLInputElement).value).toBe("https://dashscope-intl.aliyuncs.com/compatible-mode/v1");
    expect(puts(calls)[0]!.body).toMatchObject({ models: ["qwen3.7-plus", "account-qwen-model", "draft-only-model"] });
  });

  it("keeps each provider's candidates and drafts separate when switching", async () => {
    const calls = server(); render(<AdminModels />); await ready();
    toggleModel("qwen3.8-flash"); addCustom("qwen-only-custom");
    fireEvent.click(screen.getByRole("button", { name: /OpenAI Responses API/ }));
    const openai = within(screen.getByRole("region", { name: "OpenAI设置" }));
    expect(codes(openai)).toEqual(["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"]);
    expect(openai.queryByText(/qwen/i)).toBeNull();
    expect(defaultSelect(openai).disabled).toBe(true);
    fireEvent.click(openai.getByRole("checkbox", { name: /gpt-6-luna/ }));
    fireEvent.change(defaultSelect(openai), { target: { value: "gpt-6-luna" } });
    fireEvent.click(screen.getByRole("button", { name: /DeepSeek Chat Completions API/ }));
    const deepseek = within(screen.getByRole("region", { name: "DeepSeek设置" }));
    expect(codes(deepseek)).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    expect(deepseek.getAllByRole("checkbox").some((box) => (box as HTMLInputElement).checked)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /OpenAI Responses API/ }));
    expect(defaultSelect(within(screen.getByRole("region", { name: "OpenAI设置" }))).value).toBe("gpt-6-luna");
    fireEvent.click(screen.getByRole("button", { name: /千问 阿里云百炼/ }));
    expect(checkedModels()).toEqual(["Qwen3.8-Flash", "account-qwen-model", "qwen-only-custom"]);
    save(); await screen.findByText(/千问配置已保存/);
    expect(puts(calls)).toHaveLength(1);
    expect(puts(calls)[0]!.url).toMatch(/\/qwen$/);
    expect(puts(calls)[0]!.body).toMatchObject({ models: ["account-qwen-model", "qwen3.8-flash", "qwen-only-custom"] });
  });

  it("only filters on Enter in the search box and never submits the provider form", async () => {
    const calls = server(); render(<AdminModels />); await ready();
    chooseSecret("清除密钥"); fireEvent.click(screen.getByRole("checkbox", { name: /我确认清除/ }));
    const search = providerForm().getByRole("searchbox", { name: "搜索可用模型" });
    fireEvent.change(search, { target: { value: "max" } });
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    search.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(codes(within(providerForm().getByRole("list", { name: "候选模型" })))).toEqual(["qwen3.8-max"]);
    expect(puts(calls)).toHaveLength(0);
  });

  it("keeps a typed but unadded custom ID with its provider's draft and clears it on reading the server config", async () => {
    server(); render(<AdminModels />); await ready();
    const customInput = () => providerForm().getByLabelText(/^添加自定义模型 ID/) as HTMLInputElement;
    fireEvent.change(customInput(), { target: { value: "half-typed-qwen" } });
    fireEvent.click(screen.getByRole("button", { name: /OpenAI Responses API/ }));
    const openai = within(screen.getByRole("region", { name: "OpenAI设置" }));
    expect((openai.getByLabelText(/^添加自定义模型 ID/) as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: /千问 阿里云百炼/ }));
    expect(customInput().value).toBe("half-typed-qwen");
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
    toggleModel("qwen3.8-flash");
    expect(screen.getByLabelText(/我确认放弃本页/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "重新读取最新配置" }) as HTMLButtonElement).disabled).toBe(true);
    toggleModel("qwen3.8-flash");
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
    toggleModel("qwen3.8-max"); toggleModel("account-qwen-model");
    chooseSecret("填写 / 替换"); fireEvent.change(keyInput(), { target: { value: KEY } });
    await waitFor(() => expect(passiveCalls(calls)).toHaveLength(1), { timeout: 3000 });
    await act(async () => { await Promise.resolve(); });
    expect(assign).not.toHaveBeenCalled();
    expect(checkedModels()).toEqual(["Qwen3.8-Max"]); expect(defaultSelect().value).toBe("");
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
      toggleModel("qwen3.8-flash");
      await waitFor(() => expect(passiveCalls(calls)).toHaveLength(1), { timeout: 3000 });
      await act(async () => { await Promise.resolve(); });
      expect(assign).not.toHaveBeenCalled();
      expect(screen.getByRole("heading", { name: "模型配置" })).toBeTruthy();
      expect(checkedModels()).toEqual(["Qwen3.8-Flash", "account-qwen-model"]);
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
