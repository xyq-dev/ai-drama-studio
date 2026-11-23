// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  WRITING_MODEL_CHANNELS,
  type AdminVendorKey,
  type AdminVendorView,
} from "@ai-drama/contracts";
import { AiModelCatalog, AiModelVendorSettings } from "./ai-model-vendors";

const CSRF = "c".repeat(43);
const session = { enabled: true, authenticated: true, role: "operator" };
function view(vendor: AdminVendorKey, options: Partial<AdminVendorView> = {}): AdminVendorView {
  const channel = WRITING_MODEL_CHANNELS[vendor];
  return {
    vendor,
    channel: channel.id,
    model: null,
    models: channel.models,
    keyConfigured: false,
    revision: 2,
    ...options,
  };
}
type Request = (url: string, init?: RequestInit) => Response | Promise<Response>;
function install(request: Request) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) =>
    url.endsWith("/auth/session") ? Response.json(session) : request(url, init),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const edit = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "编辑设置" }));
  return within(screen.getByRole("dialog", { name: "编辑设置" }));
};

beforeEach(() => {
  document.cookie = `ads_csrf=${CSRF}; Path=/`;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.cookie = "ads_csrf=; Max-Age=0; Path=/";
});

it("loads one local catalog and shows the saved model even before a key is bound", async () => {
  const rows = (Object.keys(WRITING_MODEL_CHANNELS) as AdminVendorKey[]).map((key) => view(key));
  rows.find((v) => v.vendor === "openai")!.model = "gpt-6-luna";
  const fetch = install((url) => {
    expect(url).toBe("/api/v1/admin/models/vendors");
    return Response.json(rows);
  });
  render(<AiModelCatalog />);
  expect(await screen.findByText("GPT-6 Luna")).toBeTruthy();
  expect(screen.getAllByRole("link", { name: "进入设置" })).toHaveLength(4);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("can save only a secret without picking any default or changing a feature", async () => {
  const original = view("openai");
  const fetch = install((url, init) => {
    expect(url).toBe("/api/v1/admin/models/vendors/openai");
    if (init?.method !== "PUT") return Response.json(original);
    expect(JSON.parse(String(init.body))).toEqual({
      expectedRevision: 2,
      channel: "openai-direct",
      model: null,
      secretAction: "replace",
      apiKey: "local-fixture-key",
    });
    return Response.json({ ...original, revision: 3, keyConfigured: true });
  });
  render(<AiModelVendorSettings vendorId="openai" />);
  const dialog = await edit();
  expect(dialog.getByRole("combobox", { name: "模型" }).textContent).toBe("请选择模型");
  fireEvent.change(dialog.getByLabelText("API Key"), { target: { value: "local-fixture-key" } });
  fireEvent.click(dialog.getByRole("button", { name: "保存设置" }));
  expect(await screen.findByText("密钥已保存 · 连接待测试")).toBeTruthy();
  expect(screen.queryByDisplayValue("local-fixture-key")).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("shows a retired model and permits key rotation without rewriting that ID", async () => {
  const original = view("deepseek", { keyConfigured: true, model: "old-model" });
  let saveBody: unknown;
  install((_url, init) => {
    if (init?.method === "PUT") saveBody = JSON.parse(String(init.body));
    return Response.json(original);
  });
  render(<AiModelVendorSettings vendorId="deepseek" />);
  expect(await screen.findByText("当前列表不可用")).toBeTruthy();
  expect((screen.getByRole("button", { name: "检测连接" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  const dialog = await edit();
  expect(dialog.getByRole("combobox", { name: "模型" }).textContent).toBe("old-model");
  fireEvent.click(dialog.getByRole("button", { name: "更换" }));
  fireEvent.change(dialog.getByLabelText("API Key"), { target: { value: "local-replacement" } });
  fireEvent.click(dialog.getByRole("button", { name: "保存设置" }));
  await screen.findByText("请更换模型后再检测");
  expect(saveBody).toMatchObject({ model: "old-model", secretAction: "replace" });
});

it("clears model and secret on vendor change and ignores an earlier vendor detail returning late", async () => {
  let release!: (value: Response) => void;
  const late = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const fetch = install((url) => {
    if (url.endsWith("/openai")) return late;
    return Response.json(
      url.endsWith("/bailian") ? view("bailian", { model: "qwen-plus" }) : view("deepseek"),
    );
  });
  render(<AiModelVendorSettings vendorId="deepseek" />);
  const dialog = await edit();
  fireEvent.click(dialog.getByRole("combobox", { name: "模型" }));
  fireEvent.click(
    dialog.getByRole("option", { name: WRITING_MODEL_CHANNELS.deepseek.models[0].label }),
  );
  fireEvent.change(dialog.getByLabelText("API Key"), { target: { value: "discard-on-switch" } });
  const vendor = dialog.getByRole("combobox", { name: "供应商" });
  fireEvent.change(vendor, { target: { value: "openai" } });
  fireEvent.change(vendor, { target: { value: "bailian" } });
  await dialog.findByText(WRITING_MODEL_CHANNELS.bailian.label);
  await act(async () => {
    release(Response.json(view("openai", { model: "gpt-6-astra" })));
  });
  expect((dialog.getByLabelText("API Key") as HTMLInputElement).value).toBe("");
  expect(dialog.getByRole("combobox", { name: "模型" }).textContent).toBe("请选择模型");
  fireEvent.click(dialog.getByRole("combobox", { name: "模型" }));
  expect(
    dialog
      .getAllByRole("option")
      .filter((el) => el.tagName === "LI")
      .map((el) => el.textContent),
  ).toEqual([WRITING_MODEL_CHANNELS.bailian.models[0].label]);
  expect(fetch.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
});

it("filters by ID, accepts one keyboard selection and sends the saved ID and channel", async () => {
  let saved = view("openai", { keyConfigured: true });
  let putBody: unknown;
  install((_url, init) => {
    if (init?.method === "PUT") {
      putBody = JSON.parse(String(init.body));
      saved = { ...saved, model: "gpt-6.1-sol", revision: 3 };
    }
    return Response.json(saved);
  });
  render(<AiModelVendorSettings vendorId="openai" />);
  const dialog = await edit();
  fireEvent.click(dialog.getByRole("combobox", { name: "模型" }));
  const search = dialog.getByRole("searchbox", { name: "搜索模型" });
  fireEvent.change(search, { target: { value: "6.1-sol" } });
  expect(dialog.getByRole("listbox").children).toHaveLength(1);
  fireEvent.keyDown(search, { key: "Enter", isComposing: true });
  expect(dialog.getByRole("listbox")).toBeTruthy();
  fireEvent.keyDown(search, { key: "Enter" });
  fireEvent.click(dialog.getByRole("button", { name: "保存设置" }));
  await screen.findByRole("button", { name: "检测连接" });
  expect(putBody).toEqual({
    expectedRevision: 2,
    channel: "openai-direct",
    model: "gpt-6.1-sol",
    secretAction: "keep",
  });
});

it("does not issue duplicate checks or let a late receipt override a changed draft", async () => {
  const saved = view("deepseek", { keyConfigured: true, model: "deepseek-flash" });
  const evidence = {
    vendor: "deepseek",
    channel: saved.channel,
    model: saved.model,
    revision: 2,
    status: "listed",
    message: "已读取模型列表",
  };
  let finish!: (response: Response) => void;
  const wait = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  let probes = 0;
  install((url, init) => {
    if (!url.endsWith("/check")) return Response.json(saved);
    probes++;
    expect(JSON.parse(String(init?.body))).toEqual({
      expectedRevision: 2,
      channel: saved.channel,
      model: saved.model,
    });
    return wait;
  });
  render(<AiModelVendorSettings vendorId="deepseek" />);
  const check = await screen.findByRole("button", { name: "检测连接" });
  fireEvent.click(check);
  fireEvent.click(check);
  expect(probes).toBe(1);
  const dialog = await edit();
  fireEvent.click(dialog.getByRole("combobox", { name: "模型" }));
  fireEvent.click(
    dialog.getByRole("option", { name: WRITING_MODEL_CHANNELS.deepseek.models[1].label }),
  );
  await act(async () => {
    finish(Response.json(evidence));
  });
  expect(screen.queryByText("已读取模型列表")).toBeNull();
});

it.each([
  ["listed", "已读取模型列表"],
  ["unknown", "结果未知"],
])("labels the actual %s evidence and does not retry", async (status, expected) => {
  const saved = view("openai", { keyConfigured: true, model: "gpt-6-luna" });
  const fetch = install((url) =>
    Response.json(
      url.endsWith("/check")
        ? {
            ...saved,
            status,
            message: expected,
          }
        : saved,
    ),
  );
  render(<AiModelVendorSettings vendorId="openai" />);
  fireEvent.click(await screen.findByRole("button", { name: "检测连接" }));
  expect(await screen.findByText(expected)).toBeTruthy();
  expect(screen.queryByText("检测通过")).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("explains the empty project allowlist at the picker", async () => {
  install(() => Response.json(view("openai", { models: [] })));
  render(<AiModelVendorSettings vendorId="openai" />);
  const dialog = await edit();
  expect(dialog.getByText(/配置可用模型白名单/)).toBeTruthy();
  expect((dialog.getByRole("combobox", { name: "模型" }) as HTMLButtonElement).disabled).toBe(true);
});

it("allows a new saved revision to be checked while the old revision's result is outstanding", async () => {
  let saved = view("openai", { keyConfigured: true, model: "gpt-6-astra" });
  let release!: (response: Response) => void;
  const late = new Promise<Response>((resolve) => {
    release = resolve;
  });
  let checks = 0;
  install((url, init) => {
    if (url.endsWith("/check")) {
      checks++;
      if (checks === 1) return late;
      return Response.json({ ...saved, status: "listed", message: "已读取模型列表" });
    }
    if (init?.method === "PUT") saved = { ...saved, model: "gpt-6-luna", revision: 3 };
    return Response.json(saved);
  });
  render(<AiModelVendorSettings vendorId="openai" />);
  fireEvent.click(await screen.findByRole("button", { name: "检测连接" }));
  const dialog = await edit();
  fireEvent.click(dialog.getByRole("combobox", { name: "模型" }));
  fireEvent.click(dialog.getByRole("option", { name: "GPT-6 Luna" }));
  fireEvent.click(dialog.getByRole("button", { name: "保存设置" }));
  fireEvent.click(await screen.findByRole("button", { name: "检测连接" }));
  expect(await screen.findByText("已读取模型列表")).toBeTruthy();
  await act(async () => {
    release(
      Response.json({
        ...saved,
        revision: 2,
        model: "gpt-6-astra",
        status: "unknown",
        message: "结果未知",
      }),
    );
  });
  expect(screen.getByText("已读取模型列表")).toBeTruthy();
  expect(checks).toBe(2);
});
