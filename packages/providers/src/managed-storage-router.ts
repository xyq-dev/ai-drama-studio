import { MediaS3Client } from "./media-object-client";
import { createManagedStorageClient, type ManagedStorageConfiguration, type ManagedStorageClientOptions, type ManagedStoragePut } from "./managed-storage-client";

export interface StorageRoutingRevision { source: "environment" | "managed"; configuration: ManagedStorageConfiguration }
export interface StorageRoutingAuthority {
  reserve(key: string): Promise<StorageRoutingRevision>;
  resolve(key: string): Promise<StorageRoutingRevision>;
}
interface ObjectClient {
  put(input: ManagedStoragePut): Promise<"created" | "exists">;
  get(key: string): Promise<AsyncIterable<Uint8Array>>;
  destroy(): void;
}

/** Same logical keys/provenance on API and worker; immutable database bindings choose the physical destination. */
export class ManagedStorageRouter implements ObjectClient {
  private closed = false;
  private readonly clients = new Set<ObjectClient>();
  constructor(private readonly authority: StorageRoutingAuthority, private readonly options: Pick<ManagedStorageClientOptions, "allowedEndpoints"> = {},
    private readonly factory: (revision: StorageRoutingRevision) => ObjectClient = revision => revision.source === "environment"
      ? new MediaS3Client(revision.configuration) : createManagedStorageClient(revision.configuration, options)) {}
  private client(revision: StorageRoutingRevision): ObjectClient {
    if (this.closed) throw new Error("MANAGED_STORAGE_UNAVAILABLE");
    const client = this.factory(revision); this.clients.add(client); return client;
  }
  private close(client: ObjectClient): void { client.destroy(); this.clients.delete(client); }
  async put(input: ManagedStoragePut): Promise<"created" | "exists"> {
    if (this.closed) throw new Error("MANAGED_STORAGE_UNAVAILABLE");
    const client = this.client(await this.authority.reserve(input.key));
    try { return await client.put(input); } finally { this.close(client); }
  }
  async get(key: string): Promise<AsyncIterable<Uint8Array>> {
    if (this.closed) throw new Error("MANAGED_STORAGE_UNAVAILABLE");
    const client = this.client(await this.authority.resolve(key));
    try {
      const stream = await client.get(key), close = () => this.close(client);
      return (async function* () { try { yield* stream; } finally { close(); } })();
    } catch (error) { this.close(client); throw error; }
  }
  destroy(): void { this.closed = true; for (const client of this.clients) client.destroy(); this.clients.clear(); }
}
