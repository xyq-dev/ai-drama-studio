import { expect, it, vi } from "vitest";
import { PersistenceError, type AdminOpsStore, type JobSignalRow } from "@ai-drama/database";
import { AdminDirectoryService } from "./admin-directory.service";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";

function job(overrides: Partial<JobSignalRow> = {}): JobSignalRow {
  return {
    id: "00000000-0000-4000-8000-000000002169",
    code: "JOB-2169",
    source: "generation",
    kind: "MEDIA_IMAGE",
    state: "FAILED",
    errorCode: "LEASE_EXPIRED",
    updatedAt: "2026-11-21T10:16:41.000Z",
    projectTitle: "旧巷灯火",
    episodeNo: 2,
    ...overrides,
  };
}

function service(row: JobSignalRow, retry = vi.fn(async () => ({ id: "new" }))) {
  const store = {
    getJob: vi.fn(async () => row),
  } as unknown as AdminOpsStore;
  return {
    retry,
    directory: new AdminDirectoryService({
      store,
      creators: null,
      workspaceId: WORKSPACE,
      logs: null,
      retry,
      readContent: vi.fn(),
    }),
  };
}

it("does not call retry unless the operator confirmed a failed, retryable media job", async () => {
  const failed = service(job());
  await expect(failed.directory.retryJob(
    { username: "admin", accountId: "a0000000-0000-4000-8000-000000000001" },
    job().id,
    { confirmed: false, idempotencyKey: "idem-key-1" },
  )).rejects.toMatchObject({ code: "RETRY_UNCONFIRMED" });
  expect(failed.retry).not.toHaveBeenCalled();

  const unknown = service(job({ errorCode: "MOCK_REQUEST_UNKNOWN", state: "FAILED" }));
  await expect(unknown.directory.retryJob(
    { username: "admin", accountId: "a0000000-0000-4000-8000-000000000001" },
    job().id,
    { confirmed: true, idempotencyKey: "idem-key-2" },
  )).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME" });
  expect(unknown.retry).not.toHaveBeenCalled();

  const writing = service(job({ source: "writing", kind: "WRITING", state: "failed", errorCode: "timeout" }));
  await expect(writing.directory.retryJob(
    { username: "admin", accountId: "a0000000-0000-4000-8000-000000000001" },
    job().id,
    { confirmed: true, idempotencyKey: "idem-key-3" },
  )).rejects.toMatchObject({ code: "NOT_MEDIA" });
  expect(writing.retry).not.toHaveBeenCalled();

  const allowed = service(job());
  await allowed.directory.retryJob(
    { username: "admin", accountId: "a0000000-0000-4000-8000-000000000001" },
    job().id,
    { confirmed: true, idempotencyKey: "idem-key-4" },
  );
  expect(allowed.retry).toHaveBeenCalledOnce();
});

it("lists the operator without a password and keeps public registration closed", async () => {
  const creators = {
    listManaged: vi.fn(async () => [{
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      workspaceId: WORKSPACE,
      username: "linxia",
      status: "ACTIVE" as const,
      createdAt: "2026-11-21T10:00:00.000Z",
      updatedAt: "2026-11-21T10:18:24.000Z",
    }]),
  };
  const directory = new AdminDirectoryService({
    store: {} as AdminOpsStore,
    creators: creators as never,
    workspaceId: WORKSPACE,
    logs: null,
    retry: vi.fn(),
    readContent: vi.fn(),
  });
  const page = await directory.users({ username: "admin", accountId: "a0000000-0000-4000-8000-000000000001" }, {});
  expect(page.publicRegistrationEnabled).toBe(false);
  expect(page.displayNamePersisted).toBe(false);
  expect(page.items.map((item) => item.username)).toEqual(["admin", "linxia"]);
  expect(JSON.stringify(page)).not.toMatch(/password/i);
});

it("revokes sessions only after a creator is disabled", async () => {
  const accountId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const revokeSessions = vi.fn();
  const creators = {
    setStatus: vi.fn(async (_workspace: string, id: string, status: "ACTIVE" | "DISABLED") => ({
      id, username: "linxia", status,
    })),
  };
  const directory = new AdminDirectoryService({
    store: {} as AdminOpsStore,
    creators: creators as never,
    workspaceId: WORKSPACE,
    logs: null,
    retry: vi.fn(),
    readContent: vi.fn(),
    revokeSessions,
  });
  await directory.setUserStatus(accountId, { confirmed: true, status: "DISABLED" });
  expect(revokeSessions).toHaveBeenCalledWith(accountId);
  revokeSessions.mockClear();
  await directory.setUserStatus(accountId, { confirmed: true, status: "ACTIVE" });
  expect(revokeSessions).not.toHaveBeenCalled();
});

it("keeps the all-time log range and defaults a missing range to seven days", async () => {
  const now = Date.now();
  const records = [
    logRecord("recent", new Date(now - 86_400_000).toISOString()),
    logRecord("old", new Date(now - 40 * 86_400_000).toISOString()),
  ];
  const directory = new AdminDirectoryService({
    store: { listAdminWorkLogs: async () => [] } as unknown as AdminOpsStore,
    creators: null,
    workspaceId: WORKSPACE,
    logs: { list: async () => records, get: async () => null } as never,
    retry: vi.fn(),
    readContent: vi.fn(),
  });
  expect((await directory.logs({}, true)).items.map((item) => item.target)).toEqual(["recent"]);
  expect((await directory.logs({ range: "7d" }, true)).items.map((item) => item.target)).toEqual(["recent"]);
  expect((await directory.logs({ range: "all" }, true)).items.map((item) => item.target)).toEqual(["recent", "old"]);
});

function logRecord(label: string, at: string) {
  return {
    id: label === "recent" ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222",
    at, actor: "平台管理员", action: "登录后台", target: label, result: "success" as const,
    secretStatus: null, secretMask: null, source: "管理后台", detail: "",
  };
}

const selectedIds = [
  "00aaaaaa-1111-4111-8111-111111111111",
  "00aaaaaa-2222-4222-8222-222222222222",
  "00aaaaaa-3333-4333-8333-333333333333",
];
const operator = { accountId: "operator-id", username: "operator-name" };

function management(store: Partial<AdminOpsStore>) {
  return new AdminDirectoryService({
    store: store as AdminOpsStore, creators: null, workspaceId: WORKSPACE, logs: null,
    retry: vi.fn(), readContent: vi.fn(),
  });
}

it("refuses the entire change before writing on duplicate IDs, missing approval, invalid reasons, or spoofed attribution", async () => {
  const trash = vi.fn(), restore = vi.fn(), preview = vi.fn();
  const directory = management({ adminTrashWork: trash, adminRestoreWork: restore, previewAdminWorkTrash: preview });
  const item = { id: selectedIds[0]!, version: 1 };
  for (const body of [
    { confirmed: true, reason: "清理", items: [item, { ...item, id: item.id.toUpperCase() }] },
    { confirmed: true, reason: "清理", items: [item, { ...item, version: -1 }] },
    { confirmed: false, reason: "清理", items: [item] },
    { confirmed: true, reason: "  ", items: [item] },
    { confirmed: true, reason: "长".repeat(301), items: [item] },
    { confirmed: true, reason: "清理", items: [item], actor: "pretend-admin" },
    { confirmed: true, reason: "清理", items: [] },
    { confirmed: true, reason: "清理", items: Array(51).fill(item) },
  ]) await expect(directory.changeWorkTrash(operator, "trash", body)).rejects.toMatchObject({ status: 400 });
  await expect(directory.changeWorkTrash(operator, "restore", { confirmed: true, reason: "清理", items: [item] })).rejects.toMatchObject({ status: 400 });
  await expect(directory.previewWorkTrash({ ids: [item.id, item.id] })).rejects.toMatchObject({ status: 400 });
  expect(preview).not.toHaveBeenCalled();
  expect(trash).not.toHaveBeenCalled();
  expect(restore).not.toHaveBeenCalled();
});

it("attributes successful changes to the server session and preserves per-item conflicts and uncertain results", async () => {
  const trash = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new PersistenceError("REVISION_CONFLICT", "conflict")).mockRejectedValueOnce(new Error("private DB error"));
  const restore = vi.fn();
  const directory = management({ adminTrashWork: trash, adminRestoreWork: restore });
  const items = selectedIds.map((id) => ({ id, version: 2 }));
  const page = await directory.changeWorkTrash(operator, "trash", { confirmed: true, reason: " 清理测试 ", items });
  expect(trash).toHaveBeenCalledTimes(3);
  expect(trash).toHaveBeenCalledWith(WORKSPACE, selectedIds[0], { expectedVersion: 2, actor: operator.username, reason: "清理测试" });
  expect(page.items.map((item) => item.status)).toEqual(["succeeded", "skipped", "unknown"]);
  expect(JSON.stringify(page)).not.toContain("private DB error");
  const back = await directory.changeWorkTrash(operator, "restore", { confirmed: true, items: [items[0]] });
  expect(restore).toHaveBeenCalledWith(WORKSPACE, selectedIds[0], { expectedVersion: 2, actor: operator.username });
  expect(back.items[0]).toEqual({ id: selectedIds[0], status: "succeeded", message: null });
});

it("retains the readable works list when the management schema is unavailable", async () => {
  const directory = management({ listWorks: vi.fn().mockResolvedValue({ items: [], owners: [], total: 0, nextCursor: null, workManagementReady: false }) });
  expect(await directory.works({}, true)).toMatchObject({ items: [], canManageWorks: false });
});

it("reads the authoritative work log without the optional file journal", async () => {
  const row = { id: selectedIds[1]!, projectId: selectedIds[0]!, title: "作品", at: new Date().toISOString(),
    actor: "值班员", action: "trash" as const, reason: "清理测试" };
  const directory = management({ listAdminWorkLogs: vi.fn().mockResolvedValue([row]), getAdminWorkLog: vi.fn().mockResolvedValue(row) });
  const log = await directory.logDetail(row.id, true);
  expect(log).toMatchObject({ id: row.id, actor: row.actor, action: "作品移入回收站", detail: row.reason });
  expect(await directory.logs({ actor: row.actor, q: "回收站" }, true)).toMatchObject({ storage: "ready", items: [log] });
  expect(await directory.logs({ actor: "另一个人" }, true)).toMatchObject({ items: [] });
});
