// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  FEATURE_CAPABILITIES,
  FEATURE_KEYS,
  FEATURE_LABELS,
  FEATURE_PROBE_COST_NOTE,
  FEATURE_PROBE_SCALE,
  FEATURE_VENDOR_LABELS,
  type FeatureConfigView,
  type FeatureKey,
} from "@ai-drama/contracts";
import { FeatureConfig } from "./feature-config";

const CSRF = "c".repeat(43);
const SECRET = "synthetic-storyboard-key";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function operatorSession() {
  return {
    enabled: true,
    authenticated: true,
    role: "operator",
    username: "admin",
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
        model: null,
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

function install(
  session: unknown,
  config?: FeatureConfigView,
  write?: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/auth/session")) return json(session);
      if (write && init?.method && init.method !== "GET") return write(url, init);
      return json(config ?? view());
    }),
  );
}

function tab(label: string) {
  return within(screen.getByRole("tablist", { name: "功能" })).getByRole("tab", { name: label });
}

function expectFeatureSelected(label: string) {
  const tabs = within(screen.getByRole("tablist", { name: "功能" }));
  for (const name of ["编剧", "生图", "视频", "配音"]) {
    expect(tabs.getByRole("tab", { name }).getAttribute("aria-selected")).toBe(
      name === label ? "true" : "false",
    );
  }
}

function currentCard() {
  return screen.getByRole("region", { name: "当前生效配置" });
}

async function openEditor() {
  fireEvent.click(await screen.findByRole("button", { name: "修改配置" }));
  return within(screen.getByRole("dialog", { name: "修改配置" }));
}

function liveWritingView() {
  return view((next) => {
    const writing = card(next, "writing");
    writing.firstTime = false;
    writing.live = {
      source: "legacy",
      vendor: "deepseek",
      vendorLabel: "DeepSeek",
      model: "deepseek-flash",
      modelLabel: "DeepSeek Flash",
      version: null,
    };
  });
}

it("shows a loading state with no primary actions while the session is unread", () => {
  vi.stubGlobal("fetch", () => new Promise(() => undefined));
  render(<FeatureConfig />);
  expect(screen.getByRole("heading", { name: "正在加载配置" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "模型与密钥" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "检测连接" })).toBeNull();
  expect(screen.queryByRole("button", { name: "保存草稿" })).toBeNull();
  expect(screen.queryByRole("button", { name: "修改配置" })).toBeNull();
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

it("opens the qwen-plus editor from a first-time writing tab and keeps the feature tabs", async () => {
  window.history.replaceState(null, "", "/admin/features?feature=writing");
  install(operatorSession(), view());
  render(<FeatureConfig />);
  expect(await screen.findByRole("button", { name: "修改配置" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "模型与密钥" })).toBeTruthy();
  expectFeatureSelected("编剧");
  expect(within(currentCard()).getByText("尚未配置")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "修改配置" }));
  expect(await screen.findByRole("dialog", { name: "修改配置" })).toBeTruthy();
  const picker = screen.getByRole("combobox", { name: "模型" });
  expect(picker.textContent).toBe("请选择模型");
  fireEvent.click(picker);
  expect(screen.getByRole("option", { name: FEATURE_CAPABILITIES.writing.find(({ vendor }) => vendor === "bailian")!.models[0]!.label })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("heading", { name: "该服务商尚未接入" })).toBeNull();
  expectFeatureSelected("编剧");
  fireEvent.click(tab("视频"));
  expect(screen.getByRole("heading", { name: "视频尚未接入" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "保存草稿" })).toBeNull();
  expect(screen.queryByRole("button", { name: "检测连接" })).toBeNull();
  expect(screen.queryByRole("button", { name: "确认启用" })).toBeNull();
});

it("selects live writing when the feature query is absent", async () => {
  install(operatorSession(), liveWritingView());
  render(<FeatureConfig />);
  expect(await screen.findByRole("heading", { name: "当前生效配置" })).toBeTruthy();
  expect(within(currentCard()).getByText("DeepSeek")).toBeTruthy();
  expect(within(currentCard()).getByText("DeepSeek Flash")).toBeTruthy();
  expect(within(currentCard()).getByText("已生效")).toBeTruthy();
  expect(screen.queryByText("暂无草稿")).toBeNull();
  expectFeatureSelected("编剧");
  expect(window.location.pathname).toBe("/admin/features");
  expect(window.location.search).toBe("");
});

it("keeps a subscription key out of a Bailian writing draft and clears the error after correction", async () => {
  window.history.replaceState(null, "", "/admin/features?feature=writing&vendor=bailian");
  install(operatorSession(), view());
  render(<FeatureConfig />);
  const editor = await openEditor();
  fireEvent.click(editor.getByRole("combobox", { name: "模型" }));
  fireEvent.click(editor.getByRole("option", { name: /通义千问-Plus/ }));
  const key = editor.getByLabelText("API Key");
  const save = editor.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement;
  fireEvent.change(key, { target: { value: "sk-sp-browser-fixture" } });
  expect(editor.getByRole("alert").textContent).toBe("这是套餐密钥，请使用百炼按量付费 API Key");
  expect(save.disabled).toBe(true);
  fireEvent.click(save);
  expect(calls.filter(({ init }) => init?.method && init.method !== "GET")).toHaveLength(0);
  fireEvent.change(key, { target: { value: "normal-fake-key" } });
  expect(editor.queryByRole("alert")).toBeNull();
  expect(save.disabled).toBe(false);
});

it("preserves live writing and explains the activation block beside the passed Bailian draft", async () => {
  const config = liveWritingView();
  const slot = card(config, "writing").slots.find((item) => item.vendor === "bailian")!;
  Object.assign(slot, { model: "qwen-plus", keyConfigured: true, draftStatus: "passed",
    testToken: "tt_fixture_passed", enableBlockReason: "编剧存储尚未就绪，请联系运维" });
  window.history.replaceState(null, "", "/admin/features?feature=writing&vendor=bailian");
  install(operatorSession(), config);
  render(<FeatureConfig />);
  const editor = await openEditor();
  expect(editor.getByText("检测通过")).toBeTruthy();
  const enable = editor.getByRole("button", { name: "确认启用", description: "编剧存储尚未就绪，请联系运维" }) as HTMLButtonElement;
  expect(enable.disabled).toBe(true);
  fireEvent.click(enable);
  expect(within(currentCard()).getByText("DeepSeek")).toBeTruthy();
  expect(calls.filter(({ init }) => init?.method && init.method !== "GET")).toHaveLength(0);
});

it("shows a fresh storage rejection if readiness changed after the page loaded", async () => {
  const config = liveWritingView();
  const slot = card(config, "writing").slots.find((item) => item.vendor === "bailian")!;
  Object.assign(slot, { model: "qwen-plus", keyConfigured: true, draftStatus: "passed", testToken: "tt_fixture_passed" });
  window.history.replaceState(null, "", "/admin/features?feature=writing&vendor=bailian");
  install(operatorSession(), config, () => json({ error: { code: "FEATURE_WRITING_STORAGE_UNAVAILABLE" } }, 503));
  render(<FeatureConfig />);
  const editor = await openEditor();
  fireEvent.click(editor.getByRole("button", { name: "确认启用" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "确认启用" })).getByRole("button", { name: "确认启用" }));
  await editor.findByText("编剧存储尚未就绪，请联系运维");
  expect((editor.getByRole("button", { name: "确认启用" }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(currentCard()).getByText("DeepSeek")).toBeTruthy();
  expect(calls.filter(({ url }) => url.endsWith("/enable"))).toHaveLength(1);
});

it("keeps the feature tabs on a first-time storyboard or voice empty state and returns to writing", async () => {
  install(operatorSession(), liveWritingView());
  render(<FeatureConfig />);
  expect(await screen.findByRole("heading", { name: "当前生效配置" })).toBeTruthy();

  fireEvent.click(tab("生图"));
  expect(within(currentCard()).getByText("尚未配置")).toBeTruthy();
  expect(screen.getByRole("button", { name: "修改配置" })).toBeTruthy();
  expectFeatureSelected("生图");

  fireEvent.click(tab("编剧"));
  expect(within(currentCard()).getByText("DeepSeek")).toBeTruthy();
  expect(within(currentCard()).getByText("DeepSeek Flash")).toBeTruthy();
  expectFeatureSelected("编剧");

  fireEvent.click(tab("配音"));
  expect(within(currentCard()).getByText("尚未配置")).toBeTruthy();
  expectFeatureSelected("配音");

  fireEvent.click(tab("编剧"));
  expect(within(currentCard()).getByText("DeepSeek")).toBeTruthy();
  expectFeatureSelected("编剧");
  expect(window.location.search).toBe("?feature=writing");
});

it("keeps an explicit storyboard query instead of switching to live writing", async () => {
  window.history.replaceState(null, "", "/admin/features?feature=storyboard");
  install(operatorSession(), liveWritingView());
  render(<FeatureConfig />);
  expect(await screen.findByRole("heading", { name: "当前生效配置" })).toBeTruthy();
  expect(within(currentCard()).getByText("尚未配置")).toBeTruthy();
  expectFeatureSelected("生图");
  expect(window.location.search).toBe("?feature=storyboard");
});

it("defaults to writing when no feature is live and the query is absent", async () => {
  install(operatorSession(), view());
  render(<FeatureConfig />);
  expect(await screen.findByRole("button", { name: "修改配置" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "模型与密钥" })).toBeTruthy();
  expect(within(currentCard()).getByText("尚未配置")).toBeTruthy();
  expectFeatureSelected("编剧");
  expect(window.location.search).toBe("");
});

it("selects the live feature when writing is still unconfigured", async () => {
  const config = view((next) => {
    const storyboard = card(next, "storyboard");
    storyboard.firstTime = false;
    storyboard.live = {
      source: "enabled",
      vendor: "bailian",
      vendorLabel: "阿里云",
      model: "qwen-image-3.0",
      modelLabel: "Qwen Image",
      version: "ver_live",
    };
  });
  install(operatorSession(), config);
  render(<FeatureConfig />);
  expect(await screen.findByRole("heading", { name: "当前生效配置" })).toBeTruthy();
  expect(within(currentCard()).getByText("阿里云")).toBeTruthy();
  expect(within(currentCard()).getByText("Qwen Image")).toBeTruthy();
  expectFeatureSelected("生图");
  expect(window.location.search).toBe("");
});

it("keeps a typed key on its own vendor and cancels a test without calling the vendor", async () => {
  window.history.replaceState(null, "", "/admin/features?feature=storyboard");
  const config = view((next) => {
    const storyboard = card(next, "storyboard");
    storyboard.firstTime = false;
    storyboard.live = {
      source: "enabled",
      vendor: "bailian",
      vendorLabel: "阿里云",
      model: "qwen-image-3.0",
      modelLabel: "Qwen Image",
      version: "ver_live",
    };
    const bailian = storyboard.slots.find((item) => item.vendor === "bailian")!;
    bailian.keyConfigured = true;
    bailian.draftStatus = "saved";
    bailian.model = "qwen-image-3.0";
  });
  install(operatorSession(), config);
  render(<FeatureConfig />);
  const draft = await openEditor();
  expect(draft.getByText("草稿未启用")).toBeTruthy();
  const probe = draft.getByRole("button", { name: "验证草稿" });
  probe.focus();
  fireEvent.click(probe);
  const confirmation = within(screen.getByRole("dialog", { name: "确认测试费用" }));
  expect(confirmation.getByText(FEATURE_PROBE_COST_NOTE)).toBeTruthy();
  expect(document.activeElement).toBe(confirmation.getByRole("button", { name: "取消" }));
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "确认测试费用" })).toBeNull();
  expect(document.activeElement).toBe(probe);
  expect(calls.some((call) => call.url.includes("/test"))).toBe(false);
  const editor = screen.getByRole("dialog", { name: "修改配置" });
  fireEvent.click(within(editor).getByRole("button", { name: "更换" }));
  fireEvent.change(screen.getByLabelText("API Key"), { target: { value: SECRET } });
  fireEvent.change(within(editor).getByLabelText("供应商"), { target: { value: "openai" } });
  expect((screen.getByLabelText("API Key") as HTMLInputElement).value).toBe("");
  fireEvent.change(within(editor).getByLabelText("供应商"), { target: { value: "bailian" } });
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
  install(operatorSession(), config, () =>
    json({ view: failed, probe: { ok: false, message: "测试没有通过，草稿已保留，可以重试。" } }),
  );
  render(<FeatureConfig />);
  const editor = await openEditor();
  fireEvent.click(editor.getByRole("button", { name: "验证草稿" }));
  expect(calls.filter((call) => call.url.endsWith("/test"))).toHaveLength(0);
  const confirm = screen.getByRole("button", { name: "确认测试" });
  act(() => {
    fireEvent.click(confirm);
    fireEvent.click(confirm);
  });
  const draft = within(await screen.findByRole("dialog", { name: "修改配置" }));
  expect(await draft.findByText("检测未通过")).toBeTruthy();
  expect(draft.getByRole("status").dataset.outcome).toBe("failed");
  expect(calls.filter((call) => call.url.endsWith("/test"))).toHaveLength(1);
  expect(screen.getByText("测试没有通过，草稿已保留，可以重试。")).toBeTruthy();
  const testCall = calls.find((call) => call.url.includes("/test"));
  expect(testCall?.init?.method).toBe("POST");
  expect(JSON.parse(String(testCall?.init?.body))).toMatchObject({
    confirmCost: true,
    vendor: "bailian",
  });
  expect(JSON.stringify(testCall)).not.toContain("apiKey");
});

it("does not treat a passed draft as enabled until it matches the live config", async () => {
  const config = view((next) => {
    const writing = card(next, "writing");
    writing.firstTime = false;
    writing.live = {
      source: "enabled",
      vendor: "deepseek",
      vendorLabel: "DeepSeek",
      model: "deepseek-flash",
      modelLabel: "DeepSeek Flash",
      version: "ver_live",
    };
    const bailian = writing.slots.find((item) => item.vendor === "bailian")!;
    bailian.keyConfigured = true;
    bailian.draftStatus = "passed";
    bailian.testToken = "tt_passed-token";
    bailian.model = "qwen-plus";
  });
  install(operatorSession(), config);
  render(<FeatureConfig />);
  await screen.findByRole("heading", { name: "当前生效配置" });
  expect(within(currentCard()).getByText("DeepSeek")).toBeTruthy();
  const editor = await openEditor();
  expect(editor.getByText("检测通过")).toBeTruthy();
  expect(editor.getByRole("status").dataset.outcome).toBe("passed");
  expect(editor.getByRole("button", { name: "确认启用" })).toBeTruthy();
  expect(screen.queryByText("本次变更仅对本功能的新任务生效。")).toBeNull();
});

it("lets a rotated key on the live vendor and model be enabled once it passes", async () => {
  const config = view((next) => {
    const writing = card(next, "writing");
    writing.firstTime = false;
    writing.live = {
      source: "enabled",
      vendor: "deepseek",
      vendorLabel: "DeepSeek",
      model: "deepseek-flash",
      modelLabel: "DeepSeek Flash",
      version: "ver_live",
    };
    const deepseek = writing.slots.find((item) => item.vendor === "deepseek")!;
    deepseek.keyConfigured = true;
    deepseek.draftStatus = "passed";
    deepseek.testToken = "tt_rotated-token";
    deepseek.model = "deepseek-flash";
    deepseek.isLive = false;
  });
  const enabled = structuredClone(config);
  enabled.revision++;
  const enabledCard = card(enabled, "writing");
  enabledCard.slots.find(({ vendor }) => vendor === "deepseek")!.isLive = true;
  enabledCard.canRollback = true;
  const rolledBack = liveWritingView();
  rolledBack.revision = enabled.revision + 1;
  install(operatorSession(), config, (url) => json(url.endsWith("/rollback") ? rolledBack : enabled));
  render(<FeatureConfig />);
  const draft = await openEditor();
  expect(draft.getByText("检测通过")).toBeTruthy();
  fireEvent.click(draft.getByRole("button", { name: "确认启用" }));
  let confirmation = within(screen.getByRole("dialog", { name: "确认启用" }));
  expect(confirmation.getByText(/新的编剧任务/)).toBeTruthy();
  fireEvent.click(confirmation.getByRole("button", { name: "取消" }));
  expect(calls.some(({ url }) => url.endsWith("/enable"))).toBe(false);
  fireEvent.click(within(screen.getByRole("dialog", { name: "修改配置" })).getByRole("button", { name: "确认启用" }));
  confirmation = within(screen.getByRole("dialog", { name: "确认启用" }));
  fireEvent.click(confirmation.getByRole("button", { name: "确认启用" }));
  const rollback = await screen.findByRole("button", { name: "回退到上一配置版本" });
  expect(screen.queryByRole("dialog")).toBeNull();
  const enableCalls = calls.filter(({ url }) => url.endsWith("/writing/enable"));
  expect(enableCalls).toHaveLength(1);
  expect(JSON.parse(String(enableCalls[0]!.init?.body))).toMatchObject({
    expectedRevision: config.revision, vendor: "deepseek", testToken: "tt_rotated-token",
  });
  fireEvent.click(rollback);
  await waitFor(() => expect(screen.queryByRole("button", { name: "回退到上一配置版本" })).toBeNull());
  const rollbackCalls = calls.filter(({ url }) => url.endsWith("/writing/rollback"));
  expect(rollbackCalls).toHaveLength(1);
  expect(JSON.parse(String(rollbackCalls[0]!.init?.body))).toEqual({ expectedRevision: enabled.revision });
});

it("shows the saved failure only in the drawer for the vendor with the pending draft", async () => {
  const config = view((next) => {
    const writing = card(next, "writing");
    writing.firstTime = false;
    const deepseek = writing.slots.find((item) => item.vendor === "deepseek")!;
    deepseek.keyConfigured = true;
    deepseek.draftStatus = "failed";
    deepseek.failureMessage = "供应商拒绝了这次检测。";
    deepseek.model = "deepseek-flash";
  });
  install(operatorSession(), config);
  render(<FeatureConfig />);
  await screen.findByRole("heading", { name: "当前生效配置" });
  expect(screen.queryByRole("heading", { name: "配置变更" })).toBeNull();
  expect(screen.queryByRole("button", { name: /验证草稿|检测连接/ })).toBeNull();
  expect(screen.queryByText("检测未通过")).toBeNull();
  expect(screen.queryByText("供应商拒绝了这次检测。")).toBeNull();
  const draft = await openEditor();
  expect((draft.getByLabelText("供应商") as HTMLSelectElement).value).toBe("deepseek");
  expect(draft.getByText("检测未通过")).toBeTruthy();
  expect(draft.getByText("供应商拒绝了这次检测。")).toBeTruthy();
  expect(screen.queryByText("演示")).toBeNull();
  expect(document.body.textContent).not.toMatch(/演示|模拟/);
});

it("hides a saved result while editing and restores it when discarded key edits are reopened", async () => {
  const config = view((next) => {
    const writing = card(next, "writing");
    writing.firstTime = false;
    const deepseek = writing.slots.find((item) => item.vendor === "deepseek")!;
    deepseek.keyConfigured = true;
    deepseek.draftStatus = "passed";
    deepseek.testToken = "tt_passed-token";
    deepseek.model = "deepseek-flash";
  });
  install(operatorSession(), config);
  render(<FeatureConfig />);
  let drawer = await openEditor();
  expect(drawer.getByText("检测通过")).toBeTruthy();
  expect((drawer.getByRole("button", { name: "确认启用" }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(drawer.getByRole("button", { name: "更换" }));
  fireEvent.change(drawer.getByLabelText("API Key"), { target: { value: SECRET } });
  expect(drawer.queryByText("检测通过")).toBeNull();
  expect(drawer.queryByRole("button", { name: "确认启用" })).toBeNull();
  fireEvent.click(drawer.getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByText("检测通过")).toBeNull();
  expect(screen.queryByDisplayValue(SECRET)).toBeNull();

  drawer = await openEditor();
  expect(drawer.getByText("检测通过")).toBeTruthy();
  expect((drawer.getByRole("button", { name: "确认启用" }) as HTMLButtonElement).disabled).toBe(false);
  expect(drawer.getByLabelText("已保存密钥")).toBeTruthy();
  expect(drawer.queryByLabelText("API Key")).toBeNull();
  expect(calls.filter((call) => call.init?.method && call.init.method !== "GET")).toHaveLength(0);
});

it("binds a vendor-saved DeepSeek credential and lists both official writing models", async () => {
  const config = view((next) => {
    const writing = card(next, "writing");
    writing.firstTime = false;
    const deepseek = writing.slots.find((item) => item.vendor === "deepseek")!;
    deepseek.vendorKeyConfigured = true;
    deepseek.model = null;
  });
  install(operatorSession(), config, (url, init) => {
    expect(url).toContain("/features/writing/draft");
    const body = JSON.parse(String(init?.body)) as { vendor: string; model: string; secretAction: string; apiKey?: string };
    expect(body).toMatchObject({ vendor: "deepseek", model: "deepseek-v4-pro", secretAction: "bind_vendor" });
    expect(body).not.toHaveProperty("apiKey");
    const saved = view((next) => {
      const writing = card(next, "writing");
      writing.firstTime = false;
      const deepseek = writing.slots.find((item) => item.vendor === "deepseek")!;
      deepseek.vendorKeyConfigured = true;
      deepseek.keyConfigured = true;
      deepseek.draftStatus = "saved";
      deepseek.model = "deepseek-v4-pro";
    });
    return json(saved);
  });
  window.history.replaceState(null, "", "/admin/features?feature=writing");
  render(<FeatureConfig />);
  fireEvent.click(await screen.findByRole("button", { name: "修改配置" }));
  const drawer = await screen.findByRole("dialog", { name: "修改配置" });
  fireEvent.change(within(drawer).getByLabelText("供应商"), { target: { value: "deepseek" } });
  const picker = within(drawer).getByRole("combobox", { name: "模型" });
  expect(picker.textContent).toBe("请选择模型");
  fireEvent.click(picker);
  expect(within(drawer).getByRole("option", { name: /DeepSeek-V4.1-Flash-1017/ })).toBeTruthy();
  fireEvent.click(within(drawer).getByRole("option", { name: /DeepSeek-V4-Pro-0813/ }));
  expect(within(drawer).getByLabelText("已保存密钥")).toBeTruthy();
  expect(within(drawer).queryByLabelText("API Key")).toBeNull();
  expect(within(drawer).getByText("使用「AI 大模型」已保存的密钥。")).toBeTruthy();
  fireEvent.click(within(drawer).getByRole("button", { name: "保存草稿" }));
  expect(await within(drawer).findByText("草稿未启用")).toBeTruthy();
  expect(within(drawer).getByRole("button", { name: "验证草稿" })).toBeTruthy();
  expect(calls.some(({ url }) => url.endsWith("/test") || url.endsWith("/enable"))).toBe(false);
  expect(JSON.stringify(calls.map((call) => call.init?.body))).not.toContain(SECRET);
});


it("keeps a retired draft ID and requires a new model after every vendor change", async () => {
  const config = view((next) => {
    const writing = card(next, "writing");
    const saved = writing.slots.find((item) => item.vendor === "deepseek")!;
    Object.assign(saved, { model: "old-model", keyConfigured: true, draftStatus: "passed", testToken: "tt_previous-token" });
    const other = writing.slots.find((item) => item.vendor === "openai")!;
    Object.assign(other, { model: "gpt-6-astra", keyConfigured: true, draftStatus: "passed", testToken: "tt_other-token" });
  });
  install(operatorSession(), config);
  window.history.replaceState(null, "", "/admin/features?feature=writing&vendor=deepseek");
  render(<FeatureConfig />);
  const editor = await openEditor();
  expect((editor.getByRole("button", { name: "确认启用" }) as HTMLButtonElement).disabled).toBe(true);
  const model = () => editor.getByRole("combobox", { name: "模型" });
  const vendor = editor.getByLabelText("供应商");
  expect(model().textContent).toBe("old-model");
  expect(editor.getByText("当前列表不可用")).toBeTruthy();
  expect((editor.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(vendor, { target: { value: "openai" } });
  expect(model().textContent).toBe("请选择模型");
  fireEvent.click(model());
  expect(within(editor.getByRole("listbox")).queryByRole("option", { name: /deepseek/i })).toBeNull();
  fireEvent.click(editor.getByRole("option", { name: /GPT-6 Astra/i }));
  expect(editor.queryByText("检测通过")).toBeNull();
  expect(editor.queryByRole("button", { name: "确认启用" })).toBeNull();
  expect((editor.getByRole("button", { name: "保存草稿" }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.change(vendor, { target: { value: "deepseek" } });
  expect(model().textContent).toBe("请选择模型");
  expect(calls.filter(({ init }) => init?.method && init.method !== "GET")).toHaveLength(0);
});

it("keeps a new vendor selection when the previous probe finishes and never enables a timeout", async () => {
  const config = view((next) => {
    const writing = card(next, "writing");
    const saved = writing.slots.find((item) => item.vendor === "deepseek")!;
    Object.assign(saved, { model: "deepseek-v4-pro", keyConfigured: true, draftStatus: "saved" });
  });
  const timedOut = structuredClone(config);
  timedOut.revision++;
  Object.assign(card(timedOut, "writing").slots.find(({ vendor }) => vendor === "deepseek")!, {
    draftStatus: "unknown", failureMessage: "请求超时，请核对供应商调用记录。",
  });
  let finish!: (response: Response) => void;
  install(operatorSession(), config, () => new Promise((resolve) => { finish = resolve; }));
  render(<FeatureConfig />);
  const initial = await openEditor();
  fireEvent.click(initial.getByRole("button", { name: "验证草稿" }));
  fireEvent.click(screen.getByRole("button", { name: "确认测试" }));
  const editor = within(screen.getByRole("dialog", { name: "修改配置" }));
  fireEvent.change(editor.getByLabelText("供应商"), { target: { value: "openai" } });
  await act(async () => { finish(json({ view: timedOut, probe: { ok: false, outcome: "unknown", message: "超时" } })); });
  expect((editor.getByLabelText("供应商") as HTMLSelectElement).value).toBe("openai");
  expect(editor.getByRole("combobox", { name: "模型" }).textContent).toBe("请选择模型");
  expect(editor.queryByText("结果未知")).toBeNull();
  fireEvent.click(editor.getByRole("button", { name: "取消" }));
  const saved = await openEditor();
  expect(saved.getByText("结果未知")).toBeTruthy();
  expect(saved.getByRole("status").dataset.outcome).toBe("unknown");
  expect(screen.queryByText("检测未通过")).toBeNull();
  expect(screen.queryByRole("button", { name: "确认启用" })).toBeNull();
  expect(calls.filter(({ url }) => url.endsWith("/test"))).toHaveLength(1);
});
