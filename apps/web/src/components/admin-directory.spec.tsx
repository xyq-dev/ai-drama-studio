// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AdminDirectory } from "./admin-directory";

const WORK = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "雨夜来信",
  updatedAt: "2026-11-21T10:24:00.000Z",
  ownerName: "linxia",
  ownerLegacy: false,
  productionLabel: "制作中",
  episodeProgress: "共 3 集，第 1 集制作中",
  recentTask: "分镜生图进行中",
  reviewHref: "/admin/works/11111111-1111-4111-8111-111111111111/review",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function session(role: "operator" | "creator") {
  return json({ enabled: true, authenticated: true, role, username: role === "operator" ? "admin" : "linxia" });
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
    matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows works for an operator and keeps 打开核对 on the read-only review route", async () => {
  const fetchImpl = vi.fn(async (input: string) => {
    if (String(input).includes("/auth/session")) return session("operator");
    return json({ items: [WORK], total: 1, owners: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "linxia" }] });
  });
  render(<AdminDirectory kind="works" fetchImpl={fetchImpl} />);
  expect(await screen.findByText("雨夜来信")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "发布" })).toBeNull();
  expect(screen.queryByRole("button", { name: /删除/ })).toBeNull();
  expect(screen.getByText(/不提供批量删除或平台发布/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "查看" }));
  const open = screen.getByRole("link", { name: "打开核对" });
  expect(open.getAttribute("href")).toBe(WORK.reviewHref);
  expect(open.getAttribute("href")).not.toContain("/projects/");
  expect(screen.getByText(/不会发布到抖音或红果平台/)).toBeTruthy();
});

it("shows the no-permission card to a creator and does not request the works list", async () => {
  const fetchImpl = vi.fn(async (input: string) => session(String(input).includes("creator") ? "creator" : "creator"));
  render(<AdminDirectory kind="works" fetchImpl={fetchImpl} />);
  expect(await screen.findByRole("heading", { name: "没有作品管理权限" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "返回创作中心" }).getAttribute("href")).toBe("/studio");
  expect(fetchImpl.mock.calls.map((call) => String(call[0]))).toEqual(["/api/v1/auth/session"]);
  expect(screen.queryByText("雨夜来信")).toBeNull();
});

it("renders empty, loading, and failure states for the works list", async () => {
  const empty = vi.fn(async (input: string) => String(input).includes("/auth/session") ? session("operator") : json({ items: [], total: 0 }));
  const { unmount } = render(<AdminDirectory kind="works" fetchImpl={empty} />);
  expect(await screen.findByRole("heading", { name: "还没有作品" })).toBeTruthy();
  unmount();

  let release: ((value: Response) => void) | undefined;
  const pending = vi.fn(async (input: string) => {
    if (String(input).includes("/auth/session")) return session("operator");
    return new Promise<Response>((resolve) => { release = resolve; });
  });
  render(<AdminDirectory kind="works" fetchImpl={pending} />);
  expect(await screen.findByRole("heading", { name: "正在加载作品列表" })).toBeTruthy();
  release?.(json({ items: [], total: 0 }));
  unmount();

  const failed = vi.fn(async (input: string) => String(input).includes("/auth/session") ? session("operator") : json({}, 503));
  render(<AdminDirectory kind="works" fetchImpl={failed} />);
  expect(await screen.findByRole("heading", { name: "作品列表加载失败" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "重新加载" })).toBeTruthy();
});

it("requires confirmation before retry and does not offer retry for an unknown result", async () => {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("/auth/session")) return session("operator");
    if (init?.method === "POST") return json({ ok: true });
    return json({
      items: [
        { id: "j1", code: "JOB-2169", typeLabel: "分镜生图", subject: "旧巷灯火 / 第 2 集", updatedAt: "2026-11-21T10:16:41.000Z", status: "failed", statusLabel: "失败", action: "retry" },
        { id: "j2", code: "JOB-2160", typeLabel: "视频生成", subject: "南风过境 / 第 1 集", updatedAt: "2026-11-21T03:05:00.000Z", status: "unknown", statusLabel: "结果未知", action: "view" },
      ],
      total: 2,
    });
  });
  render(<AdminDirectory kind="jobs" fetchImpl={fetchImpl} />);
  expect(await screen.findByText("JOB-2160")).toBeTruthy();
  const row = screen.getByText("JOB-2160").closest("tr");
  expect(row).toBeTruthy();
  expect(within(row as HTMLElement).getByRole("button", { name: "查看" })).toBeTruthy();
  expect(within(row as HTMLElement).queryByRole("button", { name: "重试" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByRole("heading", { name: "确认重试该任务？" })).toBeTruthy();
  expect(within(dialog).getByText(/可能产生费用/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(calls.some((call) => call.startsWith("POST"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  fireEvent.click(screen.getByRole("button", { name: "确认重试" }));
  await vi.waitFor(() => expect(calls.some((call) => call.includes("/admin/jobs/j1/retry"))).toBe(true));
  const retryCall = fetchImpl.mock.calls.find((call) => String(call[0]).includes("/retry"));
  const init = retryCall?.[1] as RequestInit;
  expect(init.method).toBe("POST");
  expect(String(init.body)).toContain("\"confirmed\":true");
  expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBeTruthy();
});

it("creates a creator only with a password and never prints that password", async () => {
  const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
    if (String(input).includes("/auth/session")) return session("operator");
    if (init?.method === "POST") return json({ id: "u1", username: "linxia", status: "ACTIVE", role: "creator" });
    return json({
      items: [{ id: "operator", displayName: "平台管理员", username: "admin", role: "operator", roleLabel: "平台管理员", status: "ACTIVE", statusLabel: "已启用", activityAt: null, activitySource: "unknown", mutable: false }],
      total: 1,
      publicRegistrationEnabled: false,
    });
  });
  render(<AdminDirectory kind="users" fetchImpl={fetchImpl} />);
  fireEvent.click(await screen.findByRole("button", { name: "创建创作者账号" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText(/公开注册仍关闭/)).toBeTruthy();
  expect(within(dialog).getByText(/不能访问 \/admin/)).toBeTruthy();
  expect((within(dialog).getByLabelText("角色") as HTMLInputElement).value).toContain("创作者");
  fireEvent.change(within(dialog).getByLabelText("登录账号"), { target: { value: "linxia" } });
  fireEvent.change(within(dialog).getByLabelText("密码"), { target: { value: "synthetic-creator-password-A1" } });
  fireEvent.change(within(dialog).getByLabelText("确认密码"), { target: { value: "different-password" } });
  fireEvent.click(screen.getByRole("button", { name: "创建账号" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(fetchImpl.mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === "POST")).toBe(false);
  fireEvent.change(within(dialog).getByLabelText("确认密码"), { target: { value: "synthetic-creator-password-A1" } });
  fireEvent.click(screen.getByRole("button", { name: "创建账号" }));
  expect(await screen.findByText(/密码已提交，不会显示在列表或日志中/)).toBeTruthy();
  expect(document.body.textContent).not.toContain("synthetic-creator-password-A1");
});

it("shows a credential mask in the log detail and no upload control on assets", async () => {
  const logs = vi.fn(async (input: string) => {
    if (String(input).includes("/auth/session")) return session("operator");
    return json({
      storage: "ready",
      items: [{
        id: "log-1", at: "2026-11-21T12:48:00.000Z", actor: "平台管理员", action: "保存媒体密钥",
        target: "MiniMax · 已保存 (sk-***8hd)", result: "success", secretStatus: "已保存", secretMask: "sk-***8hd",
        source: "管理后台 /admin/media-keys", detail: "日志只记录掩码状态和操作结果，完整密钥未写入，也不会在详情中展示。",
      }],
      total: 1,
      actors: ["平台管理员"],
    });
  });
  const { unmount } = render(<AdminDirectory kind="logs" fetchImpl={logs} />);
  expect(await screen.findByText(/sk-\*\*\*8hd/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "详情" }));
  expect(screen.getByText(/完整密钥未写入/)).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
  unmount();

  const assets = vi.fn(async (input: string) => {
    if (String(input).includes("/auth/session")) return session("operator");
    return json({ items: [], total: 0, projects: [] });
  });
  render(<AdminDirectory kind="assets" fetchImpl={assets} />);
  expect(await screen.findByRole("heading", { name: "还没有可预览素材" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /上传/ })).toBeNull();
  expect(screen.getByText(/素材来自制作任务产出，运营不会在此上传原始文件/)).toBeTruthy();
  expect(document.body.textContent).not.toContain("来自制任务");
});

const ASSET = {
  id: "6e251483-f3d5-4031-aa75-878c58300001",
  name: "验收成片",
  type: "video",
  typeLabel: "成片视频",
  projectTitle: "验收-2026-10-08T08-54-22",
  updatedAt: "2026-11-21T02:08:00.000Z",
  sourceTask: "视频生成 · JOB-6190",
  contentHref: "/api/v1/admin/assets/6e251483-f3d5-4031-aa75-878c58300001/content",
};

it("shows a preview error and retries the content request", async () => {
  const content: Array<{ status: number }> = [];
  let fail = true;
  const fetchImpl = vi.fn(async (input: string) => {
    const url = String(input);
    if (url.includes("/auth/session")) return session("operator");
    if (url.includes("/content")) {
      content.push({ status: fail ? 503 : 200 });
      if (fail) {
        return json({ error: { code: "CONTENT_UNAVAILABLE", message: "暂时无法预览这份素材。没有对外发布。" } }, 503);
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "video/mp4" } });
    }
    return json({ items: [ASSET], total: 1, projects: [] });
  });
  render(<AdminDirectory kind="assets" fetchImpl={fetchImpl} />);
  expect(await screen.findByText(/素材来自制作任务产出，不在此页上传原始文件/)).toBeTruthy();
  expect(document.body.textContent).not.toContain("来自制任务");
  fireEvent.click(screen.getByRole("button", { name: "预览" }));
  const dialog = screen.getByRole("dialog");
  expect(await within(dialog).findByRole("alert")).toBeTruthy();
  expect(within(dialog).getByRole("alert").textContent).toContain("暂时无法预览这份素材");
  expect(within(dialog).queryByText("成片视频预览")).toBeNull();
  expect(dialog.querySelector("video")).toBeNull();
  fail = false;
  fireEvent.click(within(dialog).getByRole("button", { name: "重新加载" }));
  await vi.waitFor(() => expect(dialog.querySelector("video")).toBeTruthy());
  expect(within(dialog).queryByRole("alert")).toBeNull();
  expect(within(dialog).queryByRole("button", { name: "重新加载" })).toBeNull();
  expect(content.map((call) => call.status)).toEqual([503, 200]);
});

it("keeps the preview loading state until the content request succeeds", async () => {
  let release: ((value: Response) => void) | undefined;
  const fetchImpl = vi.fn(async (input: string) => {
    const url = String(input);
    if (url.includes("/auth/session")) return session("operator");
    if (url.includes("/content")) return new Promise<Response>((resolve) => { release = resolve; });
    return json({ items: [ASSET], total: 1, projects: [] });
  });
  render(<AdminDirectory kind="assets" fetchImpl={fetchImpl} />);
  fireEvent.click(await screen.findByRole("button", { name: "预览" }));
  const dialog = screen.getByRole("dialog");
  expect(await within(dialog).findByText("正在加载预览")).toBeTruthy();
  expect(within(dialog).queryByRole("alert")).toBeNull();
  expect(dialog.querySelector("video")).toBeNull();
  release?.(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "video/mp4" } }));
  await vi.waitFor(() => expect(dialog.querySelector("video")).toBeTruthy());
  expect(within(dialog).queryByText("正在加载预览")).toBeNull();
  expect(within(dialog).queryByRole("alert")).toBeNull();
});

it("keeps search mounted while the next query loads and pages with the cursor", async () => {
  let release: ((value: Response) => void) | undefined;
  const urls: string[] = [];
  const fetchImpl = vi.fn(async (input: string) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/auth/session")) return session("operator");
    if (url.includes("cursor=")) return json({ items: [{ ...WORK, id: "22222222-2222-4222-8222-222222222222", title: "旧巷灯火" }], total: 2, nextCursor: null });
    if (url.includes("q=")) return new Promise<Response>((resolve) => { release = resolve; });
    return json({ items: [WORK], total: 2, nextCursor: "cursor-2" });
  });
  render(<AdminDirectory kind="works" fetchImpl={fetchImpl} />);
  const input = await screen.findByLabelText("搜索作品标题");
  expect(await screen.findByText("雨夜来信")).toBeTruthy();
  input.focus();
  fireEvent.change(input, { target: { value: "雨" } });
  expect(document.activeElement).toBe(screen.getByLabelText("搜索作品标题"));
  expect(screen.getByText("雨夜来信")).toBeTruthy();
  release?.(json({ items: [WORK], total: 2, nextCursor: "cursor-2" }));
  const more = await screen.findByRole("button", { name: "加载更多" });
  await vi.waitFor(() => expect(more.hasAttribute("disabled")).toBe(false));
  fireEvent.click(more);
  expect(await screen.findByText("旧巷灯火")).toBeTruthy();
  expect(urls.some((url) => url.includes("cursor=cursor-2"))).toBe(true);
});

it("keeps the log time filter when the default window is empty", async () => {
  const urls: string[] = [];
  const fetchImpl = vi.fn(async (input: string) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/auth/session")) return session("operator");
    return json({ storage: "ready", items: [], total: 0, actors: [] });
  });
  render(<AdminDirectory kind="logs" fetchImpl={fetchImpl} />);
  expect(await screen.findByRole("heading", { name: "还没有操作记录" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("时间范围"), { target: { value: "all" } });
  await vi.waitFor(() => expect(urls.some((url) => url.includes("range=all"))).toBe(true));
});

it("uses cards below 1024px", async () => {
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
  const fetchImpl = vi.fn(async (input: string) => String(input).includes("/auth/session") ? session("operator") : json({ items: [WORK], total: 1, owners: [] }));
  render(<AdminDirectory kind="works" fetchImpl={fetchImpl} />);
  expect(await screen.findByText("雨夜来信")).toBeTruthy();
  expect(document.querySelector("[data-layout='cards']")).toBeTruthy();
});
