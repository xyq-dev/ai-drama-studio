import { expect, it, vi } from "vitest";
import type { AdminOpsStore, JobSignalRow } from "@ai-drama/database";
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
