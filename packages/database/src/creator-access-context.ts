import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Request-scoped creator ownership filter for stores (phase 4).
 * API middleware sets this after site-auth succeeds. When unset, stores stay open (auth disabled / unit tests).
 */
export type StoreCreatorAccess =
  | { kind: "open" }
  | { kind: "scoped"; ownerAccountId: string | null; actorId: string };

const storage = new AsyncLocalStorage<StoreCreatorAccess>();

export function runWithStoreCreatorAccess<T>(access: StoreCreatorAccess, work: () => T): T {
  return storage.run(access, work);
}

export function storeOwnerAccountFilter(explicit?: string | null): string | null {
  if (explicit !== undefined) return explicit;
  const access = storage.getStore();
  if (!access || access.kind === "open") return null;
  return access.ownerAccountId;
}

export function storeActorId(): string {
  const access = storage.getStore();
  if (!access || access.kind === "open") return "server-owner";
  return access.actorId;
}
