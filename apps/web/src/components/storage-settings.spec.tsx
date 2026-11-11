// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { StorageSettingsView } from "@ai-drama/contracts";
import { validateManagedStorageConfiguration } from "@ai-drama/providers";
import { StorageSettings } from "./storage-settings";

const CSRF = "c".repeat(43);
const ID = "11111111-1111-4111-8111-111111111111";
function initial(): StorageSettingsView {
  return { revision: 1, managed: true,
    active: { id: null, provider: "minio", endpoint: "https://legacy.example.com", region: "us-east-1", bucket: "legacy-media", prefix: "", forcePathStyle: true, hasCredentials: true, source: "environment" },
    draft: { id: ID, provider: "cos", endpoint: "https://cos.ap-guangzhou.myqcloud.com", region: "ap-guangzhou", bucket: "new-media-1250000000", prefix: "hongguo/", forcePathStyle: false, hasCredentials: true, source: "managed" },
    test: { status: "not_tested", testedAt: null, expiresAt: null } };
}
type Call = { url: string; method: string; body: Record<string, unknown> | null; init: RequestInit };
function server(handler?: (call: Call, view: StorageSettingsView) => Response | Promise<Response> | undefined) {
  let view = initial();
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const call = { url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null, init };
    calls.push(call);
    if (url.endsWith("/auth/session")) return Response.json({ enabled: true, authenticated: true, username: "admin" });
    const custom = handler?.(call, view);
    if (custom) return custom;
    if (url.endsWith("/draft")) { view = { ...view, revision: view.revision + 1, test: { status: "not_tested", testedAt: null, expiresAt: null } }; }
    if (url.endsWith("/test")) view = { ...view, revision: view.revision + 1, test: { status: "passed", testedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 900000).toISOString() } };
    if (url.endsWith("/activate")) view = { ...view, revision: view.revision + 1, active: view.draft! };
    return Response.json(view);
  }));
  return calls;
}
beforeEach(() => { document.cookie = `ads_csrf=${CSRF}; Path=/`; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); document.cookie = "ads_csrf=; Max-Age=0; Path=/"; });
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
async function ready() { await waitFor(() => expect(button("保存草稿").disabled).toBe(false)); }

it.each([
  { provider: "oss" as const, label: "阿里云 OSS", region: "cn-guangzhou", endpoint: "https://oss-cn-guangzhou.aliyuncs.com" },
  { provider: "s3" as const, label: "Amazon S3", region: "cn-north-1", endpoint: "https://s3.cn-north-1.amazonaws.com.cn" },
])("generates a $provider configuration accepted by the actual backend validator", async ({ provider, label, region, endpoint }) => {
  const calls = server(); render(<StorageSettings />); await ready();
  fireEvent.click(screen.getByRole("radio", { name: label }));
  fireEvent.change(screen.getByLabelText(/所属地域 Region/), { target: { value: region } });
  expect((screen.getByLabelText("服务地址 Endpoint") as HTMLInputElement).value).toBe(endpoint);
  fireEvent.change(screen.getByLabelText(/存储桶 Bucket/), { target: { value: "hongguo-media" } });
  fireEvent.change(screen.getByLabelText(/^Access Key ID/), { target: { value: "synthetic-access-id" } });
  fireEvent.change(screen.getByLabelText(/^Access Key Secret/), { target: { value: "synthetic-secret-key" } });
  fireEvent.click(button("保存草稿")); await screen.findByText(/草稿已保存/);
  const { expectedRevision: _revision, secretAction: _action, ...config } = calls.find(call => call.method === "PUT")!.body!;
  expect(config).toMatchObject({ provider, region, endpoint });
  expect(() => validateManagedStorageConfiguration(config as unknown as Parameters<typeof validateManagedStorageConfiguration>[0])).not.toThrow();
});

it("keeps save, probe and activation separate and sends authenticated versioned requests", async () => {
  const calls = server(); render(<StorageSettings />); await ready();
  expect(button("启用此配置").disabled).toBe(true);
  fireEvent.click(button("保存草稿")); await screen.findByText("草稿已保存。当前存储未改变，请检测连接。");
  expect(within(screen.getByRole("complementary", { name: "存储状态" })).getByText("legacy-media")).toBeTruthy();
  expect(calls.filter((call) => call.method !== "GET")).toHaveLength(1);
  const save = calls.find((call) => call.method === "PUT")!;
  expect(save.body).toMatchObject({ expectedRevision: 1, secretAction: "keep" });
  expect(save.body).not.toHaveProperty("secretAccessKey");
  expect(new Headers(save.init.headers).get("X-CSRF-Token")).toBe(CSRF);
  fireEvent.click(button("检测连接")); await screen.findByText(/连接检测通过，15 分钟内/);
  expect(calls.find((call) => call.url.endsWith("/test"))!.body).toEqual({ expectedRevision: 2, confirmProbe: true });
  fireEvent.click(button("启用此配置"));
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(calls.some((call) => call.url.endsWith("/activate"))).toBe(false);
  fireEvent.click(button("确认启用")); await screen.findByText(/配置已启用。新文件/);
  expect(calls.find((call) => call.url.endsWith("/activate"))!.body).toEqual({ expectedRevision: 3 });
  expect(button("启用此配置").disabled).toBe(true);
});

it("invalidates eligibility on local edits and never stores credentials in browser storage", async () => {
  const write = vi.spyOn(Storage.prototype, "setItem");
  server((call, view) => call.method === "GET" ? Response.json({ ...view, test: { status: "passed", testedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 900000).toISOString() } }) : undefined);
  render(<StorageSettings />); await ready();
  expect(button("启用此配置").disabled).toBe(false);
  fireEvent.change(screen.getByLabelText("文件目录前缀"), { target: { value: "new/" } });
  expect(button("启用此配置").disabled).toBe(true);
  expect(button("检测连接").disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(/更换已保存的凭据/));
  fireEvent.change(screen.getByLabelText(/^SecretId/), { target: { value: "test-only-id" } });
  fireEvent.change(screen.getByLabelText(/^SecretKey/), { target: { value: "test-only-private-key" } });
  fireEvent.click(button("保存草稿")); await screen.findByText(/草稿已保存/);
  expect((screen.getByLabelText(/^SecretKey/) as HTMLInputElement).value).toBe("");
  expect(write).not.toHaveBeenCalled();
});

it("locks uncertain writes until an explicit reread without reflecting provider errors or retrying", async () => {
  const calls = server((call) => call.method === "PUT" ? Promise.reject(new Error("private-upstream-secret")) : undefined);
  render(<StorageSettings />); await ready();
  fireEvent.click(button("保存草稿")); await screen.findByRole("alert");
  expect(document.body.textContent).not.toContain("private-upstream-secret");
  expect(button("保存草稿").disabled).toBe(true);
  expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  fireEvent.click(button("重新读取配置")); await screen.findByText("已重新读取最新配置。");
  expect(button("保存草稿").disabled).toBe(false);
});

it("does not enable an expired test or a malformed response containing secrets", async () => {
  server((call, view) => call.method === "GET" ? Response.json({ ...view, test: { status: "passed", testedAt: new Date(Date.now() - 900000).toISOString(), expiresAt: new Date(Date.now() - 1).toISOString() } }) : undefined);
  const mounted = render(<StorageSettings />); await ready();
  expect(button("启用此配置").disabled).toBe(true);
  expect(screen.getByText("检测已过期")).toBeTruthy();
  mounted.unmount();
  server((_call, view) => Response.json({ ...view, secretAccessKey: "reflected-secret" }));
  render(<StorageSettings />); await screen.findByRole("alert");
  expect(button("保存草稿").disabled).toBe(true);
  expect(document.body.textContent).not.toContain("reflected-secret");
});

it("renders unavailable state without fictitious active settings or allowing mutations", async () => {
  server(() => Response.json({ error: { code: "STORAGE_SETTINGS_UNAVAILABLE" } }, { status: 503 }));
  render(<StorageSettings />); await screen.findByRole("alert");
  expect(screen.getByText("尚未读取到当前配置。")).toBeTruthy();
  expect(button("保存草稿").disabled).toBe(true);
  expect(button("检测连接").disabled).toBe(true);
  expect(button("启用此配置").disabled).toBe(true);
});
