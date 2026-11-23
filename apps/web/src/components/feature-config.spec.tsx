// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  expect(screen.getByText("暂无草稿")).toBeTruthy();
  expectFeatureSelected("编剧");
  expect(window.location.pathname).toBe("/admin/features");
  expect(window.location.search).toBe("");
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
  expect(await screen.findByText("草稿未启用")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "检测连接" }));
  expect(screen.getByRole("dialog", { name: "确认测试费用" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog", { name: "确认测试费用" })).toBeNull();
  expect(calls.some((call) => call.url.includes("/test"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "修改配置" }));
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
  fireEvent.click(await screen.findByRole("button", { name: "检测连接" }));
  fireEvent.click(screen.getByRole("button", { name: "确认测试" }));
  expect(await screen.findByText("检测未通过")).toBeTruthy();
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
  expect(await screen.findByText("检测通过")).toBeTruthy();
  expect(within(currentCard()).getByText("DeepSeek")).toBeTruthy();
  expect(screen.getByRole("button", { name: "确认启用" })).toBeTruthy();
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
  install(operatorSession(), config);
  render(<FeatureConfig />);
  expect(await screen.findByText("检测通过")).toBeTruthy();
  const enable = screen.getByRole("button", { name: "确认启用" }) as HTMLButtonElement;
  expect(enable.disabled).toBe(false);
});

it("shows neutral production copy: no 演示 badge, no 模拟 wording, and a neutral failed state", async () => {
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
  expect(await screen.findByText("检测未通过")).toBeTruthy();
  expect(screen.getByText("供应商拒绝了这次检测。")).toBeTruthy();
  expect(screen.queryByText("演示")).toBeNull();
  expect(document.body.textContent).not.toMatch(/演示|模拟/);
});

it("opens 修改配置 on the vendor shown in 配置变更, not the first vendor", async () => {
  const config = view((next) => {
    const writing = card(next, "writing");
    writing.firstTime = false;
    const deepseek = writing.slots.find((item) => item.vendor === "deepseek")!;
    deepseek.keyConfigured = true;
    deepseek.draftStatus = "failed";
    deepseek.model = "deepseek-flash";
  });
  install(operatorSession(), config);
  render(<FeatureConfig />);
  await screen.findByText("检测未通过");
  fireEvent.click(screen.getByRole("button", { name: "修改配置" }));
  const drawer = screen.getByRole("dialog", { name: "修改配置" });
  expect((within(drawer).getByLabelText("供应商") as HTMLSelectElement).value).toBe("deepseek");
});

it("restores the saved draft when 取消 closes the editor, so 检测连接 and 确认启用 work again", async () => {
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
  expect(await screen.findByText("检测通过")).toBeTruthy();
  const enable = () => screen.getByRole("button", { name: "确认启用" }) as HTMLButtonElement;
  expect(enable().disabled).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "修改配置" }));
  let drawer = screen.getByRole("dialog", { name: "修改配置" });
  fireEvent.click(within(drawer).getByRole("button", { name: "更换" }));
  fireEvent.change(within(drawer).getByLabelText("API Key"), { target: { value: SECRET } });
  fireEvent.click(within(drawer).getByRole("button", { name: "取消" }));

  expect(screen.queryByRole("dialog", { name: "修改配置" })).toBeNull();
  expect(screen.getByText("检测通过")).toBeTruthy();
  expect(enable().disabled).toBe(false);
  expect(screen.queryByDisplayValue(SECRET)).toBeNull();

  // Reopening shows the saved mask again, not the discarded key field.
  fireEvent.click(screen.getByRole("button", { name: "修改配置" }));
  drawer = screen.getByRole("dialog", { name: "修改配置" });
  expect(within(drawer).getByLabelText("已保存密钥")).toBeTruthy();
  expect(within(drawer).queryByLabelText("API Key")).toBeNull();
  expect(calls.filter((call) => call.init?.method && call.init.method !== "GET")).toHaveLength(0);
});

it("keeps 检测连接 usable on a saved draft after a typed key is discarded with 取消", async () => {
  const config = view((next) => {
    const writing = card(next, "writing");
    writing.firstTime = false;
    const deepseek = writing.slots.find((item) => item.vendor === "deepseek")!;
    deepseek.keyConfigured = true;
    deepseek.draftStatus = "saved";
    deepseek.model = "deepseek-flash";
  });
  install(operatorSession(), config);
  render(<FeatureConfig />);
  const test = async () => (await screen.findByRole("button", { name: "检测连接" })) as HTMLButtonElement;
  expect((await test()).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "修改配置" }));
  const drawer = screen.getByRole("dialog", { name: "修改配置" });
  fireEvent.click(within(drawer).getByRole("button", { name: "更换" }));
  fireEvent.change(within(drawer).getByLabelText("API Key"), { target: { value: SECRET } });
  fireEvent.click(within(drawer).getByRole("button", { name: "取消" }));
  expect((await test()).disabled).toBe(false);
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
  expect(await screen.findByText("草稿未启用")).toBeTruthy();
  expect(JSON.stringify(calls.map((call) => call.init?.body))).not.toContain(SECRET);
});


it("keeps a retired draft ID and requires a new model after every vendor change", async () => {
  const config = view((next) => {
    const writing = card(next, "writing");
    const saved = writing.slots.find((item) => item.vendor === "deepseek")!;
    Object.assign(saved, { model: "old-model", keyConfigured: true, draftStatus: "passed", testToken: "tt_previous-token" });
  });
  install(operatorSession(), config);
  render(<FeatureConfig />);
  expect((await screen.findByRole("button", { name: "确认启用" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "修改配置" }));
  const editor = within(screen.getByRole("dialog", { name: "修改配置" }));
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
  fireEvent.click(await screen.findByRole("button", { name: "检测连接" }));
  fireEvent.click(screen.getByRole("button", { name: "确认测试" }));
  fireEvent.click(screen.getByRole("button", { name: "修改配置" }));
  const editor = within(screen.getByRole("dialog", { name: "修改配置" }));
  fireEvent.change(editor.getByLabelText("供应商"), { target: { value: "openai" } });
  await act(async () => { finish(json({ view: timedOut, probe: { ok: false, outcome: "unknown", message: "超时" } })); });
  expect((editor.getByLabelText("供应商") as HTMLSelectElement).value).toBe("openai");
  expect(editor.getByRole("combobox", { name: "模型" }).textContent).toBe("请选择模型");
  fireEvent.click(editor.getByRole("button", { name: "取消" }));
  expect(screen.getByText("结果未知")).toBeTruthy();
  expect(screen.queryByText("检测未通过")).toBeNull();
  expect(screen.queryByRole("button", { name: "确认启用" })).toBeNull();
  expect(calls.filter(({ url }) => url.endsWith("/test"))).toHaveLength(1);
});
