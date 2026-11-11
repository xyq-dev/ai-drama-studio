import { storageSettingsViewSchema, type StorageSettingsView, type StorageDraftUpdate } from "@ai-drama/contracts";
import { withSession } from "./site-session";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export class StorageSettingsError extends Error {
  constructor(readonly status: number, readonly code: string) { super("Storage settings request failed"); }
}

/** All secrets travel only in authenticated JSON writes; responses must match the redacted contract. */
export function createStorageSettingsClient(fetchImpl: FetchLike = globalThis.fetch.bind(globalThis)) {
  const send = withSession(fetchImpl);
  async function request(method: string, suffix = "", body?: unknown): Promise<StorageSettingsView> {
    let response: Response;
    try {
      response = await send(`/api/v1/admin/storage${suffix}`, { method, cache: "no-store", credentials: "same-origin",
        headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new StorageSettingsError(0, "NETWORK_ERROR"); }
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new StorageSettingsError(response.ok ? 0 : response.status, "INVALID_RESPONSE"); }
    if (!response.ok) {
      const code = (payload as { error?: { code?: unknown } } | null)?.error?.code;
      throw new StorageSettingsError(response.status, typeof code === "string" && /^[A-Z0-9_]{1,100}$/.test(code) ? code : "REQUEST_FAILED");
    }
    const parsed = storageSettingsViewSchema.safeParse(payload);
    if (!parsed.success) throw new StorageSettingsError(0, "INVALID_RESPONSE");
    return parsed.data;
  }
  return {
    read: () => request("GET"),
    save: (body: StorageDraftUpdate) => request("PUT", "/draft", body),
    test: (expectedRevision: number) => request("POST", "/test", { expectedRevision, confirmProbe: true }),
    activate: (expectedRevision: number) => request("POST", "/activate", { expectedRevision }),
  };
}
