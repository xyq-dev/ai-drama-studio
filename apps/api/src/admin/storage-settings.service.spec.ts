import { describe, expect, it, vi } from "vitest";
import { StorageSettingsError, type StorageSettingsStore } from "@ai-drama/database";
import { StorageSettingsService } from "./storage-settings.service";
const draft = { id: "synthetic-revision", source: "managed" as const, configuration: { provider: "oss" as const, endpoint: "https://oss-cn-hangzhou.aliyuncs.com", region: "cn-hangzhou", bucket: "synthetic-bucket", prefix: "", forcePathStyle: false, accessKeyId: "synthetic-id", secretAccessKey: "synthetic-secret" } };
describe("storage settings probe workflow", () => {
  function fixture(test: () => Promise<void>) {
    const store = { draftForTest: vi.fn(async () => draft), recordTest: vi.fn(async () => undefined), view: vi.fn(async () => ({ revision: 2 })) };
    const client = { put: vi.fn(), get: vi.fn(), test, destroy: vi.fn() }, factory = vi.fn(() => client);
    return { store, client, factory, service: new StorageSettingsService(store as unknown as StorageSettingsStore, {}, factory) };
  }
  it("marks success only after the full probe workflow and closes transport", async () => {
    const f = fixture(async () => undefined); await f.service.test(1);
    expect(f.store.recordTest).toHaveBeenCalledExactlyOnceWith(1, draft.id, true); expect(f.client.destroy).toHaveBeenCalledOnce();
  });
  it("marks failed cleanup/transport safely without returning provider errors and does not activate", async () => {
    const f = fixture(async () => { throw new Error("https://signed.test?secret=must-not-return"); });
    await expect(f.service.test(1)).resolves.toEqual({ revision: 2 }); expect(f.store.recordTest).toHaveBeenCalledExactlyOnceWith(1, draft.id, false); expect(f.client.destroy).toHaveBeenCalledOnce();
  });
  it("keeps a concurrent-save conflict after the probe instead of reporting a newer draft as tested", async () => {
    const f = fixture(async () => undefined); f.store.recordTest.mockRejectedValueOnce(new StorageSettingsError(409, "STORAGE_SETTINGS_CONFLICT"));
    await expect(f.service.test(1)).rejects.toMatchObject({ code: "STORAGE_SETTINGS_CONFLICT" }); expect(f.store.view).not.toHaveBeenCalled();
  });
});
