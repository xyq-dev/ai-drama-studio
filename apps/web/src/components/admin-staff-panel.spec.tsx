// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AdminStaffPanel } from "./admin-staff-panel";

const { request } = vi.hoisted(() => ({ request: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>() }));
vi.mock("../lib/site-session", () => ({ withSession: () => request }));

const base = "/api/v1/admin/staff";
const roles = [
  { id: "super", name: "超级管理员", code: "super_admin", permissions: [] },
  { id: "ops", name: "运营管理员", code: "ops_admin", permissions: [] },
];
const staff = [
  { id: "first", username: "alice", displayName: "甲", status: "active", roleId: "super" },
  { id: "second", username: "bob", displayName: "乙", status: "disabled", roleId: "super" },
  { id: "third", username: "chun", displayName: "丙", status: "active", roleId: "ops" },
].map(row => ({ ...row, statusLabel: row.status, roleName: roles.find(role => role.id === row.roleId)?.name }));

function response(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}
async function setup(secondFactor = true, handle?: (path: string, init?: RequestInit) => Promise<Response> | undefined) {
  request.mockImplementation((path, init) => handle?.(path, init) ?? Promise.resolve(response(
    path === base ? { staff, roles, requiresSecondFactor: secondFactor, currentStaffId: "first" } :
    path === base + "/invites" ? { inviteUrl: "/activate?token=test" } : { items: [] },
  )));
  render(<AdminStaffPanel />);
  await within(screen.getByRole("table")).findByText("alice");
}
function credentials(form: HTMLElement, code?: string) {
  fireEvent.change(within(form).getByLabelText("当前密码"), { target: { value: "test-password" } });
  if (code) fireEvent.change(within(form).getByLabelText("动态码或恢复码"), { target: { value: code } });
}
function payload(path: string) {
  const call = request.mock.calls.find(([url, init]) => url === path && init?.method === "POST");
  return call ? JSON.parse(String(call[1]?.body)) : undefined;
}

afterEach(() => { cleanup(); request.mockReset(); });

it("asks for the operator's factors only for a super invitation and clears credentials after use", async () => {
  await setup();
  const form = screen.getByRole("button", { name: "生成邀请链接" }).closest("form")!;
  expect(within(form).queryByLabelText("当前密码")).toBeNull();
  fireEvent.change(within(form).getByLabelText("岗位"), { target: { value: "super" } });
  credentials(form, "000123");
  fireEvent.change(within(form).getByLabelText("账号"), { target: { value: "new-staff" } });
  fireEvent.change(within(form).getByLabelText("显示名"), { target: { value: "新员工" } });
  fireEvent.submit(form);
  await waitFor(() => expect(payload(base + "/invites")).toEqual({
    username: "new-staff", displayName: "新员工", roleId: "super", currentPassword: "test-password", totpCode: "000123",
  }));
  expect((within(form).getByLabelText("动态码或恢复码") as HTMLInputElement).value).toBe("");
  expect((within(form).getByLabelText("当前密码") as HTMLInputElement).value).toBe("");
});

it.each([
  ["desktop", "alice", "停用", "first", "disabled"],
  ["mobile", "bob", "重新启用", "second", "active"],
])("confirms the %s status action on the selected employee using a recovery code", async (view, username, action, id, status) => {
  await setup();
  const row = screen.getAllByText(username).find(el => el.closest(view === "mobile" ? "article" : "tr"))!;
  const container = row.closest(view === "mobile" ? "article" : "tr") as HTMLElement;
  fireEvent.click(within(container).getByRole("button", { name: action }));
  const dialog = screen.getByRole("dialog");
  expect(payload(base + "/" + id + "/status")).toBeUndefined();
  credentials(dialog, "a2c9-e5f3");
  fireEvent.click(within(dialog).getByRole("button", { name: action }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(payload(base + "/" + id + "/status")).toEqual({ status, currentPassword: "test-password", totpCode: "a2c9-e5f3" });
});

it.each([["alice", "first", "ops"], ["chun", "third", "super"]])("reauthenticates when changing a super role for %s", async (username, id, roleId) => {
  await setup(false);
  const row = within(screen.getByRole("table")).getByText(username).closest("tr")!;
  fireEvent.click(within(row).getByRole("button", { name: "编辑" }));
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("岗位"), { target: { value: roleId } });
  credentials(dialog);
  expect(within(dialog).queryByLabelText("动态码或恢复码")).toBeNull();
  fireEvent.submit(dialog);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(payload(base + "/" + id)).toMatchObject({ roleId, currentPassword: "test-password" });
  expect(payload(base + "/" + id)).not.toHaveProperty("totpCode");
});

it("starts the authenticator with the password entered in its own form", async () => {
  await setup(false, path => path === base + "/totp/start" ? Promise.resolve(response({ secret: "TEST-SEED", uri: "" })) : undefined);
  fireEvent.click(screen.getByRole("button", { name: "登录与安全" }));
  const form = screen.getByRole("form", { name: "开启验证器" });
  credentials(form);
  fireEvent.submit(form);
  expect(await screen.findByText("密钥 TEST-SEED")).toBeTruthy();
  expect(payload(base + "/totp/start")).toEqual({ currentPassword: "test-password" });
});

it("authenticates a replacement with the old factor and waits for the new code before accepting recovery codes", async () => {
  let attempts = 0;
  await setup(true, path => {
    if (path === base + "/totp/start") {
      if (!attempts++) return Promise.resolve(new Response(JSON.stringify({ error: { message: "原验证器动态码无效。" } }), { status: 403 }));
      return Promise.resolve(response({ secret: "NEW-SEED", uri: "" }));
    }
    if (path === base + "/totp/confirm") return Promise.resolve(response({ recoveryCodes: ["NEXT-RECOVERY"] }));
  });
  fireEvent.click(screen.getByRole("button", { name: "登录与安全" }));
  const form = screen.getByRole("form", { name: "更换验证器" });
  const start = (factor: string) => {
    fireEvent.change(within(form).getByLabelText("当前密码"), { target: { value: "test-password" } });
    fireEvent.change(within(form).getByLabelText("旧验证器动态码或恢复码"), { target: { value: factor } });
    fireEvent.submit(form);
  };
  start("invalid");
  expect((await screen.findByRole("alert")).textContent).toBe("原验证器动态码无效。");
  expect(screen.queryByText("密钥 NEW-SEED")).toBeNull();
  start("OLD-RECOVERY");
  expect(await screen.findByText("密钥 NEW-SEED")).toBeTruthy();
  const starts = request.mock.calls.filter(([url]) => url === base + "/totp/start");
  expect(JSON.parse(String(starts.at(-1)?.[1]?.body))).toEqual({ currentPassword: "test-password", totpCode: "OLD-RECOVERY" });
  expect(payload(base + "/totp/confirm")).toBeUndefined();
  fireEvent.change(screen.getByLabelText("动态码"), { target: { value: "065432" } });
  fireEvent.click(screen.getByRole("button", { name: "确认更换" }));
  expect(await screen.findByText(/NEXT-RECOVERY/)).toBeTruthy();
  expect(payload(base + "/totp/confirm")).toEqual({ code: "065432" });
  expect(screen.queryByText("密钥 NEW-SEED")).toBeNull();
});

it("ignores a late session list after switching accounts and revokes only the displayed account's session", async () => {
  let completeFirst!: (r: Response) => void;
  await setup(true, path => {
    if (path === base + "/first/sessions") return new Promise(resolve => { completeFirst = resolve; });
    if (path === base + "/third/sessions") return Promise.resolve(response({ items: [{ publicId: "current", lastSeenAt: "2026-11-23T12:00:00Z" }] }));
  });
  fireEvent.click(screen.getByRole("button", { name: "登录与安全" }));
  expect(screen.getByLabelText("查看会话的账号")).toHaveProperty("value", "first");
  fireEvent.change(screen.getByLabelText("查看会话的账号"), { target: { value: "third" } });
  const revoke = await screen.findByRole("button", { name: "撤销" });
  completeFirst(response({ items: [{ publicId: "stale", lastSeenAt: "2000-01-01T12:00:00Z" }] }));
  fireEvent.click(revoke);
  await waitFor(() => expect(screen.queryByRole("button", { name: "撤销" })).toBeNull());
  expect(payload(base + "/third/sessions/current/revoke")).toEqual({});
  expect(payload(base + "/third/sessions/stale/revoke")).toBeUndefined();
});
