import type { StorageDraftUpdate, StorageSettingsView } from "@ai-drama/contracts";
import { StorageSettingsError, type StorageSettingsStore } from "@ai-drama/database";
import { createManagedStorageClient, validateManagedStorageConfiguration, type ManagedStorageClientOptions } from "@ai-drama/providers";

export class StorageSettingsService {
  constructor(private readonly store: StorageSettingsStore,
    private readonly options: Pick<ManagedStorageClientOptions, "allowedEndpoints"> = {},
    private readonly clientFactory = createManagedStorageClient) {}
  view(): Promise<StorageSettingsView> { return this.store.view(); }
  async save(input: StorageDraftUpdate): Promise<StorageSettingsView> {
    await this.store.save(input, configuration => {
      try { validateManagedStorageConfiguration(configuration, this.options); }
      catch { throw new StorageSettingsError(400, "STORAGE_SETTINGS_INVALID"); }
    });
    return this.store.view();
  }
  async test(expectedRevision: number): Promise<StorageSettingsView> {
    const draft = await this.store.draftForTest(expectedRevision);
    if (!draft.id) throw new StorageSettingsError(409, "STORAGE_SETTINGS_CONFLICT");
    let passed = false;
    let client: ReturnType<typeof createManagedStorageClient> | undefined;
    try { client = this.clientFactory(draft.configuration, this.options); await client.test(); passed = true; }
    catch { /* Never expose SDK messages, endpoints, signatures or credentials in an HTTP error. */ }
    finally { client?.destroy(); }
    await this.store.recordTest(expectedRevision, draft.id, passed);
    return this.store.view();
  }
  async activate(expectedRevision: number): Promise<StorageSettingsView> {
    await this.store.activate(expectedRevision); return this.store.view();
  }
}
