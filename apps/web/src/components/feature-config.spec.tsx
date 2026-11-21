// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  FEATURE_CAPABILITIES, FEATURE_KEYS, FEATURE_LABELS, FEATURE_PROBE_COST_NOTE, FEATURE_PROBE_SCALE, FEATURE_VENDOR_LABELS,
  type FeatureConfigView, type FeatureKey,
} from "@ai-drama/contracts";
import { FeatureConfig } from "./feature-config";

const CSRF = "c".repeat(43);
const SECRET = "synthetic-storyboard-key";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function operatorSession() {
  return {
    enabled: true, authenticated: true, role: "operator", username: "admin",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

function view(patch: (next: FeatureConfigView) => void = () => undefined): FeatureConfigView {
  const next: FeatureConfigView = {
    revision: 4,
    validation: "local_only",
    features: FEATURE_KEYS.map((feature) => ({
      feature,
      label: FEATURE_LABELS[feature],
      live: null,
      firstTime: true,
      probeScale: FEATURE_PROBE_SCALE,
      probeCostNote: FEATURE_PROBE_COST_NOTE,
      slots: FEATURE_CAPABILITIES[feature].map((capability) => ({
        vendor: capability.vendor,
        label: FEATURE_VENDOR_LABELS[capability.vendor],
        connected: capability.connected,
        gap: capability.gap,
        models: capability.models.map((model) => ({ ...model })),
        model: capability.models[0]?.id ?? null,
        keyConfigured: false,
        draftStatus: "blank" as const,
        testToken: null,
        failureMessage: null,
      })),
    })),
  };
  patch(next);
  return next;
}

function card(config: FeatureConfigView, feature: FeatureKey) {
  return config.features.find((item) => item.feature === feature)!;
}

let calls: Array<{ url: string; init?: RequestInit }>;

beforeEach(() => {
  calls = [];
  document.cookie = `ads_csrf=${CSRF}; Path=/`;
  window.history.replaceState(null, "", "/admin/features");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.cookie = "ads_csrf=; Max-Age=0; Path=/";
});

function install(session: unknown, config?: FeatureConfigView, write?: (url: string, init?: RequestInit) => Response) {
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/auth/session")) return json(session);
    if (write && init?.method && init.method !== "GET") return write(url, init);
    return json(config ?? view());
  }));
}

it("shows a loading state with no primary actions while the session is unread", () => {
  vi.stubGlobal("fetch", () => new Promise(() => undefined));
  render(<FeatureConfig />);
  expect(screen.getByRole("heading", { name: "正在加载配置" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "测试配置" })).toBeNull();
  expect(screen.queryByRole("button", { name: "保存草稿" })).toBeNull();
  expect(screen.queryByRole("button", { name: "配置阿里云编剧" })).toBeNull();
});

it("shows the no-permission state to a creator and does not request configuration", async () => {
  install({ enabled: true, authenticated: true, role: "creator", username: "creator-a" });
  render(<FeatureConfig />);
  expect(await screen.findByRole("heading", { name: "没有配置权限" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "返回创作中心" }).getAttribute("href")).toBe("/studio");
  expect(screen.queryByLabelText("API Key")).toBeNull();
  expect(screen.queryByText("••••••••")).toBeNull();
  expect(calls.some((call) => call.url.includes("/admin/features"))).toBe(false);
});

it("opens the unconnected state from a first-time writing card", async () => {
  window.history.replaceState(null, "", "/admin/features?feature=writing");
  install(operatorSession(), view());
  render(<FeatureConfig />);
  expect(await screen.findByRole("heading", { name: "尚未配置剧本编写" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "配置阿里云编剧" }));
  expect(await screen.findByRole("heading", { name: "该服务商尚未接入" })).toBeTruthy();
  expect(screen.getByText(/阿里云百炼文本适配器已退役/)).toBeTruthy();
});

it("keeps a typed key on its own vendor and cancels a test without calling the vendor", async () => {
  window.history.replaceState(null, "", "/admin/features?feature=storyboard");
  const config = view((next) => {
    const storyboard = card(next, "storyboard");
    storyboard.firstTime = false;
    storyboard.live = { source: "enabled", vendor: "bailian", vendorLabel: "阿里云", model: "qwen-image-3.0", modelLabel: "Qwen Image", version: "ver_live" };
    const bailian = storyboard.slots.find((item) => item.vendor === "bailian")!;
    bailian.keyConfigured = true;
    bailian.draftStatus = "saved";
    bailian.model = "qwen-image-3.0";
  });
  install(operatorSession(), config);
  render(<FeatureConfig />);
  expect(await screen.findByText(/草稿已保存，线上任务仍使用当前生效配置/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "测试配置" }));
  expect(screen.getByRole("dialog", { name: "确认测试费用" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(calls.some((call) => call.url.includes("/test"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "更换" }));
  fireEvent.change(screen.getByLabelText("API Key"), { target: { value: SECRET } });
  fireEvent.click(within(screen.getByRole("group", { name: "服务商" })).getByRole("button", { name: "OpenAI" }));
  expect((screen.getByLabelText("API Key") as HTMLInputElement).value).toBe("");
  fireEvent.click(within(screen.getByRole("group", { name: "服务商" })).getByRole("button", { name: "阿里云" }));
  expect((screen.getByLabelText("API Key") as HTMLInputElement).value).toBe(SECRET);
  expect(JSON.stringify(calls)).not.toContain(SECRET);
});

it("sends confirmCost only after the operator confirms, and keeps a failed draft", async () => {
  window.history.replaceState(null, "", "/admin/features?feature=storyboard");
  const config = view((next) => {
    const storyboard = card(next, "storyboard");
    storyboard.firstTime = false;
    const bailian = storyboard.slots.find((item) => item.vendor === "bailian")!;
    bailian.keyConfigured = true;
    bailian.draftStatus = "saved";
    bailian.model = "qwen-image-3.0";
  });
  const failed = view((next) => {
    const storyboard = card(next, "storyboard");
    storyboard.firstTime = false;
    const bailian = storyboard.slots.find((item) => item.vendor === "bailian")!;
    bailian.keyConfigured = true;
    bailian.draftStatus = "failed";
    bailian.failureMessage = "测试没有通过，草稿已保留，可以重试。";
    bailian.model = "qwen-image-3.0";
  });
  install(operatorSession(), config, () => json({ view: failed, probe: { ok: false, message: "测试没有通过，草稿已保留，可以重试。" } }));
  render(<FeatureConfig />);
  fireEvent.click(await screen.findByRole("button", { name: "测试配置" }));
  fireEvent.click(screen.getByRole("button", { name: "确认测试" }));
  expect(await screen.findByRole("dialog", { name: "测试没有通过" })).toBeTruthy();
  const testCall = calls.find((call) => call.url.includes("/test"));
  expect(testCall?.init?.method).toBe("POST");
  expect(JSON.parse(String(testCall?.init?.body))).toMatchObject({ confirmCost: true, vendor: "bailian" });
  expect(JSON.stringify(testCall)).not.toContain("apiKey");
});
