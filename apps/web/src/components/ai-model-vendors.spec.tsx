// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AdminModelsView, FeatureConfigView } from "@ai-drama/contracts";
import { AiModelCatalog, AiModelVendorSettings, preservedModels } from "./ai-model-vendors";

const CSRF = "c".repeat(43);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const session = {
  enabled: true,
  authenticated: true,
  role: "operator",
  username: "admin",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

function modelsView(keyConfigured = false): AdminModelsView {
  return {
    savedRevision: 2,
    activeRevision: 2,
    pendingRestart: false,
    activationDeferred: false,
    source: "managed",
    saved: {
      defaultProvider: keyConfigured ? "openai" : null,
      maxCallsPerDay: 20,
      maxActiveRuns: 2,
      providers: [
        {
          providerKey: "openai",
          label: "OpenAI",
          models: keyConfigured ? ["gpt-6-astra"] : [],
          baseUrl: "https://example.invalid",
          keyConfigured,
          ready: keyConfigured,
          missing: keyConfigured ? [] : ["apiKey"],
        },
        {
          providerKey: "anthropic",
          label: "Claude",
          models: [],
          baseUrl: "https://example.invalid",
          keyConfigured: false,
          ready: false,
          missing: ["apiKey"],
          workspaceId: null,
        },
        {
          providerKey: "deepseek",
          label: "DeepSeek",
          models: [],
          baseUrl: "https://example.invalid",
          keyConfigured: false,
          ready: false,
          missing: ["apiKey"],
        },
      ],
    },
    active: {
      defaultProvider: null,
      maxCallsPerDay: 20,
      maxActiveRuns: 2,
      providers: [],
    },
    titleWriting: { enabled: false, productionBlocked: true, operatorConfigured: false },
    audit: [],
    validation: "local_only",
    storage: null,
  };
}

function featuresView(): FeatureConfigView {
  return { revision: 1, validation: "local_only", features: [] };
}

beforeEach(() => {
  document.cookie = `ads_csrf=${CSRF}; Path=/`;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.cookie = "ads_csrf=; Max-Age=0; Path=/";
});

function install(
  models: AdminModelsView,
  features: FeatureConfigView = featuresView(),
  write?: (url: string, init?: RequestInit) => Response,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/auth/session")) return json(session);
      if (write && init?.method && init.method !== "GET") return write(url, init);
      if (url.includes("/admin/models")) return json(models);
      return json(features);
    }),
  );
}

it("lists the four vendors and does not paint an unconfigured vendor as connected", async () => {
  install(modelsView(false));
  render(<AiModelCatalog />);
  expect((await screen.findAllByRole("link", { name: "进入设置" })).length).toBe(4);
  expect(screen.getByRole("heading", { name: "模型供应商" })).toBeTruthy();
  expect(screen.getByText("按厂商管理模型、密钥和 SDK 接入。")).toBeTruthy();
  expect(screen.getByText("DeepSeek")).toBeTruthy();
  expect(screen.getByText("OpenAI")).toBeTruthy();
  expect(screen.getByText("阿里云百炼")).toBeTruthy();
  expect(screen.getByText("Anthropic (Claude)")).toBeTruthy();
  expect(screen.getAllByText("未绑定").length).toBeGreaterThan(0);
  expect(screen.queryByText("连接正常")).toBeNull();
  expect(screen.queryByText("演示")).toBeNull();
  const settings = screen.getAllByRole("link", { name: "进入设置" });
  expect(settings.map((link) => link.getAttribute("href"))).toEqual([
    "/admin/ai-models/deepseek",
    "/admin/ai-models/openai",
    "/admin/ai-models/bailian",
    "/admin/ai-models/anthropic",
  ]);
});

it("saves an OpenAI key through the existing models API and keeps a mask after save", async () => {
  const empty = modelsView(false);
  const saved = modelsView(true);
  install(empty, featuresView(), () => json(saved));
  render(<AiModelVendorSettings vendorId="openai" />);
  expect(await screen.findByRole("button", { name: "编辑设置" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "OpenAI" })).toBeTruthy();
  expect(screen.getByText("供应商设置")).toBeTruthy();
  expect(screen.getAllByText("未绑定").length).toBeGreaterThan(0);
  expect(screen.queryByText("连接正常")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "编辑设置" }));
  const dialog = screen.getByRole("dialog", { name: "编辑设置" });
  fireEvent.change(within(dialog).getByLabelText("API Key"), {
    target: { value: "sk-test-isolated-openai-key-not-real" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存凭证" }));
  expect((await screen.findAllByText("密钥已保存 · 连接待测试")).length).toBeGreaterThan(0);
  expect(screen.getByText(/OpenAI 项目密钥/)).toBeTruthy();
  expect(screen.queryByText("连接正常")).toBeNull();
  expect(screen.queryByDisplayValue("sk-test-isolated-openai-key-not-real")).toBeNull();
});

it("does not offer a vendor-level save for Bailian and explains the feature-bound gap", async () => {
  install(modelsView(false));
  render(<AiModelVendorSettings vendorId="bailian" />);
  expect(await screen.findByText(/没有供应商级凭证仓/)).toBeTruthy();
  expect(screen.getByRole("heading", { name: "阿里云百炼" })).toBeTruthy();
  expect((screen.getByRole("button", { name: "编辑设置" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(screen.getByText(/没有供应商级凭证仓/)).toBeTruthy();
  expect(screen.getByRole("link", { name: /功能配置/ })).toBeTruthy();
  expect(screen.queryByText("连接正常")).toBeNull();
});

function withOpenAiModels(view: AdminModelsView, models: string[]): AdminModelsView {
  return {
    ...view,
    saved: {
      ...view.saved,
      providers: view.saved.providers.map((provider) =>
        provider.providerKey === "openai" ? { ...provider, models } : provider,
      ),
    },
  };
}

it("keeps every configured model when a vendor key is saved, only moving the chosen default first", async () => {
  expect(preservedModels(["gpt-6-astra", "gpt-6-luna"], "gpt-6-luna")).toEqual(["gpt-6-luna", "gpt-6-astra"]);
  expect(preservedModels(["gpt-6-astra", "gpt-6-luna"], "")).toEqual(["gpt-6-astra", "gpt-6-luna"]);
  const configured = withOpenAiModels(modelsView(true), ["gpt-6-astra", "gpt-6-luna", "gpt-6.1-sol"]);
  const bodies: Array<{ models: string[]; secretAction: string }> = [];
  install(configured, featuresView(), (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return json(configured);
  });
  render(<AiModelVendorSettings vendorId="openai" />);
  fireEvent.click(await screen.findByRole("button", { name: "编辑设置" }));
  const dialog = screen.getByRole("dialog", { name: "编辑设置" });
  fireEvent.click(within(dialog).getByRole("button", { name: "更换" }));
  fireEvent.change(within(dialog).getByLabelText("API Key"), {
    target: { value: "sk-test-isolated-rotated-key-not-real" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存凭证" }));
  expect((await screen.findAllByText("密钥已保存 · 连接待测试")).length).toBeGreaterThan(0);
  expect(bodies).toHaveLength(1);
  expect(bodies[0]!.secretAction).toBe("replace");
  expect(bodies[0]!.models).toEqual(["gpt-6-astra", "gpt-6-luna", "gpt-6.1-sol"]);
});

it("says the running API still uses the previous credential while a restart is pending, never 连接正常", async () => {
  const before = modelsView(true);
  const pending = { ...modelsView(true), savedRevision: 3, activeRevision: 2, pendingRestart: true };
  install(before, featuresView(), () => json(pending));
  render(<AiModelVendorSettings vendorId="openai" />);
  fireEvent.click(await screen.findByRole("button", { name: "编辑设置" }));
  const dialog = screen.getByRole("dialog", { name: "编辑设置" });
  fireEvent.click(within(dialog).getByRole("button", { name: "更换" }));
  fireEvent.change(within(dialog).getByLabelText("API Key"), {
    target: { value: "sk-test-isolated-rotated-key-not-real" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存凭证" }));
  expect(await screen.findByText(/运行中的服务仍使用原有凭证/)).toBeTruthy();
  expect(screen.queryByText("连接正常")).toBeNull();
  expect(screen.queryByText(/演示|模拟/)).toBeNull();
});

it("says the change is deferred while creative runs finish", async () => {
  install({ ...modelsView(true), activationDeferred: true });
  render(<AiModelVendorSettings vendorId="openai" />);
  expect(await screen.findByText(/应用已推迟/)).toBeTruthy();
  expect(screen.queryByText("连接正常")).toBeNull();
});

it("shows no activation note when the saved config is already in use", async () => {
  install(modelsView(true));
  render(<AiModelVendorSettings vendorId="openai" />);
  expect(await screen.findByRole("button", { name: "编辑设置" })).toBeTruthy();
  expect(screen.queryByText(/尚未生效|应用已推迟/)).toBeNull();
});
