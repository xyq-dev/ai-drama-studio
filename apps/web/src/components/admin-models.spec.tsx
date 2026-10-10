// @vitest-environment happy-dom
// UI and request-contract regressions with simulated fetch; not server or provider acceptance.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminModelsView, AdminSessionView } from "@ai-drama/contracts";
import { AdminModels } from "./admin-models";

const TOKEN = "admin-private-0123456789";
const KEY = "provider-private-0123456789";
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }
function session(): AdminSessionView { return { authenticated: true, csrfToken: "csrf-for-this-session", expiresAt: new Date(Date.now() + 3600_000).toISOString() }; }
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
    return handler?.(call) ?? (url.endsWith("/session") ? json(session()) : json(modelView()));
  }));
  return calls;
}
async function ready() { await screen.findByRole("heading", { name: "模型配置" }); await screen.findByRole("button", { name: "校验并保存配置" }); }
function providerForm() { return within(screen.getByRole("region", { name: "千问设置" })); }
function modelsInput() { return providerForm().getByLabelText(/^允许使用的模型 ID/) as HTMLTextAreaElement; }
function chooseSecret(label: string) { fireEvent.click(screen.getByRole("radio", { name: label })); }
function keyInput() { return screen.getByLabelText(/^新的 API Key/) as HTMLInputElement; }
function save() { fireEvent.click(screen.getByRole("button", { name: "校验并保存配置" })); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.localStorage.clear(); window.sessionStorage.clear(); });

describe("protected administrator model settings", () => {
  it("requires an administrator session and never exposes settings to a guest", async () => {
    const calls = server((call) => call.url.endsWith("/session") ? json({ error: { code: "ADMIN_UNAUTHORIZED" } }, 401) : undefined);
    render(<AdminModels />);
    expect(await screen.findByRole("heading", { name: "验证管理员身份" })).toBeTruthy();
    await screen.findByRole("button", { name: "进入模型配置" });
    expect(calls).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "默认选择与使用限额" })).toBeNull();
  });
  it("shows initialization guidance on 503 without offering login or a fake settings page", async () => {
    server(() => json({ error: { code: "ADMIN_UNAVAILABLE" } }, 503)); render(<AdminModels />);
    expect(await screen.findByText(/请联系服务器管理员完成认证与安全存储初始化/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "进入模型配置" })).toBeNull();
    expect(screen.getByRole("button", { name: "重新检查后台状态" })).toBeTruthy();
  });
  it("clears a rejected token and shows a safe login error", async () => {
    server((call) => call.url.endsWith("/session") ? json({ error: { code: "ADMIN_UNAUTHORIZED", message: TOKEN } }, call.method === "POST" ? 403 : 401) : undefined);
    render(<AdminModels />); await screen.findByRole("button", { name: "进入模型配置" });
    const input = screen.getByLabelText("管理员访问令牌") as HTMLInputElement;
    fireEvent.change(input, { target: { value: TOKEN } }); fireEvent.click(screen.getByRole("button", { name: "进入模型配置" }));
    await screen.findByText("管理员访问令牌不正确，请重新输入。"); expect(input.value).toBe(""); expect(document.body.textContent).not.toContain(TOKEN);
  });
  it("stores neither administrator tokens, CSRF nor provider keys in browser storage", async () => {
    const local = vi.spyOn(Storage.prototype, "setItem");
    const calls = server((call) => call.url.endsWith("/session") && call.method === "GET" ? json({}, 401) : undefined);
    render(<AdminModels />); await screen.findByRole("button", { name: "进入模型配置" });
    fireEvent.change(screen.getByLabelText("管理员访问令牌"), { target: { value: TOKEN } }); fireEvent.click(screen.getByRole("button", { name: "进入模型配置" }));
    await ready(); chooseSecret("填写 / 替换"); fireEvent.change(keyInput(), { target: { value: KEY } });
    expect(local).not.toHaveBeenCalled(); expect(window.localStorage.length).toBe(0); expect(window.sessionStorage.length).toBe(0);
    expect(screen.queryByLabelText("管理员访问令牌")).toBeNull();
    expect(calls.filter((call) => call.method === "GET").every((call) => !JSON.stringify(call.init).includes(TOKEN))).toBe(true);
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
    expect(calls.map((call) => call.url)).toEqual(["/api/v1/admin/session", "/api/v1/admin/models"]);
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
    expect(within(screen.getByRole("list")).queryByText("v1", { exact: true })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /OpenAI Responses API/ }));
    expect(revisions()).toEqual(["v9", "v8", "v7", "v6", "v5", "v4", "v3", "v2"]);
  });
  it("explicitly saves keep without transmitting a key and preserves unsaved limits", async () => {
    const next = modelView({ savedRevision: 5, pendingRestart: true }); next.saved.providers[0]!.models = ["m-1", "m-2"];
    const calls = server((call) => call.method === "PUT" ? json(next) : undefined);
    render(<AdminModels />); await ready();
    fireEvent.change(modelsInput(), { target: { value: "m-1\nm-2, m-1" } });
    const daily = screen.getByLabelText(/^每日最多调用次数/) as HTMLInputElement;
    fireEvent.change(daily, { target: { value: "12" } });
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);
    save(); await screen.findByText(/千问配置已保存/);
    const write = calls.find((call) => call.method === "PUT")!;
    expect(write.body).toEqual({ expectedRevision: 4, models: ["m-1", "m-2"], baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", secretAction: "keep" });
    expect(write.init.headers).toMatchObject({ "X-Admin-CSRF": "csrf-for-this-session" });
    expect(daily.value).toBe("12");
    expect(calls.some((call) => !call.url.startsWith("/api/v1/admin/"))).toBe(false);
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
    expect((screen.getByRole("button", { name: "校验并保存配置" }) as HTMLButtonElement).disabled).toBe(true);
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
    expect((screen.getByRole("button", { name: "重新读取最新配置" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /我确认放弃本页/ })); fireEvent.click(screen.getByRole("button", { name: "重新读取最新配置" }));
    await screen.findByText("已重新读取服务器配置。"); expect(modelsInput().value).toBe("account-qwen-model");
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });
  it("expires the view and all sensitive input when a mutation returns 401", async () => {
    server((call) => call.method === "PUT" ? json({}, 401) : undefined);
    render(<AdminModels />); await ready(); chooseSecret("填写 / 替换"); fireEvent.change(keyInput(), { target: { value: KEY } }); save();
    await screen.findByRole("button", { name: "进入模型配置" });
    expect(screen.queryByLabelText(/^新的 API Key/)).toBeNull();
    expect((screen.getByLabelText("管理员访问令牌") as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("heading", { name: "模型配置" })).toBeNull();
    expect(screen.getByText("管理员会话已过期，请重新验证。")).toBeTruthy();
  });
  it("freezes supplier switching and double submission while saving", async () => {
    const pending = deferred<Response>();
    const calls = server((call) => call.method === "PUT" ? pending.promise : undefined);
    render(<AdminModels />); await ready(); save();
    const openai = screen.getByRole("button", { name: /OpenAI Responses API/ }) as HTMLButtonElement;
    expect(openai.disabled).toBe(true); fireEvent.click(openai);
    expect(screen.getByRole("region", { name: "千问设置" })).toBeTruthy();
    fireEvent.submit(providerForm().getByLabelText(/^允许使用的模型 ID/).closest("form")!);
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
    await act(async () => pending.resolve(json(modelView()))); await screen.findByText(/千问配置已保存/);
    fireEvent.click(openai); expect(screen.getByRole("region", { name: "OpenAI设置" })).toBeTruthy();
  });
  it("preserves each supplier's non-secret draft and clears secret input when switching", async () => {
    server(); render(<AdminModels />); await ready(); fireEvent.change(modelsInput(), { target: { value: "qwen-unsaved" } });
    chooseSecret("填写 / 替换"); fireEvent.change(keyInput(), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: /OpenAI Responses API/ }));
    expect(screen.queryByLabelText(/^新的 API Key/)).toBeNull();
    expect((screen.getByLabelText(/^服务端点/) as HTMLInputElement).readOnly).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /千问 阿里云百炼/ }));
    expect(modelsInput().value).toBe("qwen-unsaved"); chooseSecret("填写 / 替换"); expect(keyInput().value).toBe("");
  });
  it("saves rules separately, preserving a provider draft and leaving feature switches read-only", async () => {
    const calls = server(); render(<AdminModels />); await ready(); fireEvent.change(modelsInput(), { target: { value: "unsaved-model" } });
    fireEvent.change(screen.getByRole("combobox", { name: /^默认供应商/ }), { target: { value: "deepseek" } });
    fireEvent.change(screen.getByLabelText(/^每日最多调用次数/), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "保存调用规则" })); await screen.findByText(/调用规则已保存/);
    expect(calls.find((call) => call.method === "PUT")!.body).toEqual({ expectedRevision: 4, defaultProvider: "deepseek", maxCallsPerDay: 20, maxActiveRuns: 1 });
    expect(modelsInput().value).toBe("unsaved-model"); expect(screen.queryByRole("switch")).toBeNull();
  });
  it("does not show false success after network loss and requires an explicit read before retry", async () => {
    const calls = server((call) => { if (call.method === "PUT") return Promise.reject(new Error("connection lost")); return undefined; });
    render(<AdminModels />); await ready(); save(); await screen.findByText(/操作结果尚未确认/);
    expect(screen.queryByText(/千问配置已保存/)).toBeNull();
    expect((screen.getByRole("button", { name: "校验并保存配置" }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });
  it("clears a session on successful logout using CSRF", async () => {
    const calls = server((call) => call.method === "DELETE" ? new Response(null, { status: 204 }) : undefined);
    render(<AdminModels />); await ready(); fireEvent.click(screen.getByRole("button", { name: "退出" }));
    await screen.findByText("已退出管理员控制台。"); expect(screen.queryByRole("heading", { name: "模型配置" })).toBeNull();
    expect(calls.find((call) => call.method === "DELETE")!.init.headers).toMatchObject({ "X-Admin-CSRF": "csrf-for-this-session" });
  });
  it("does not claim logout succeeded if its receipt is lost", async () => {
    server((call) => call.method === "DELETE" ? Promise.reject(new Error("network")) : undefined);
    render(<AdminModels />); await ready(); chooseSecret("填写 / 替换"); fireEvent.change(keyInput(), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: "退出" })); await screen.findByText(/退出尚未确认/);
    expect(screen.getByRole("heading", { name: "模型配置" })).toBeTruthy(); expect(screen.queryByLabelText(/^新的 API Key/)).toBeNull();
  });
  it("discards a late successful save from an unmounted session", async () => {
    const pending = deferred<Response>(); server((call) => call.method === "PUT" ? pending.promise : undefined);
    const mount = render(<AdminModels />); await ready(); save(); mount.unmount();
    server((call) => call.url.endsWith("/session") ? json({}, 401) : undefined);
    render(<AdminModels />); await screen.findByRole("button", { name: "进入模型配置" });
    await act(async () => pending.resolve(json(modelView({ savedRevision: 9 }))));
    expect(screen.queryByRole("heading", { name: "模型配置" })).toBeNull(); expect(screen.queryByText("v9")).toBeNull();
  });
  it("rejects invalid model IDs locally without sending a PUT", async () => {
    const calls = server(); render(<AdminModels />); await ready(); fireEvent.change(modelsInput(), { target: { value: "https://proxy/invalid" } }); save();
    await screen.findByText(/请检查模型 ID/); expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  });
  it("can recover from a settings read failure without resubmitting login", async () => {
    let reads = 0;
    const calls = server((call) => { if (call.url.endsWith("/session") && call.method === "GET") return json({}, 401);
      if (call.url.endsWith("/models") && ++reads === 1) return json({}, 503); return undefined; });
    render(<AdminModels />); await screen.findByRole("button", { name: "进入模型配置" });
    fireEvent.change(screen.getByLabelText("管理员访问令牌"), { target: { value: TOKEN } }); fireEvent.click(screen.getByRole("button", { name: "进入模型配置" }));
    await screen.findByRole("button", { name: "重新读取配置" }); fireEvent.click(screen.getByRole("button", { name: "重新读取配置" })); await ready();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });
});
