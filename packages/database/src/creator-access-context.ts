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

/** True once the phase-4 migration has added project.owner_account_id. */
export async function projectOwnerColumnReady(
  client: { query(sql: string, values?: unknown[]): Promise<{ rows: Array<{ present?: boolean }> }> },
): Promise<boolean> {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'project' AND column_name = 'owner_account_id'
     ) AS present`,
  );
  return result.rows[0]?.present === true;
}

/**
 * Contiguous ownership bind for a SQL fragment that joins/filters through project.
 * When ownership is inactive (open/ops/pre-migration), returns empty sql and no param.
 */
export async function ownedProjectBind(
  client: { query(sql: string, values?: unknown[]): Promise<{ rows: Array<{ present?: boolean }> }> },
  ownerAccountId: string | null | undefined,
  paramIndex: number,
  projectAlias = "p",
): Promise<{ sql: string; params: string[] }> {
  const owner = storeOwnerAccountFilter(ownerAccountId);
  if (!owner || !(await projectOwnerColumnReady(client))) return { sql: "", params: [] };
  return {
    sql: `AND ${projectAlias}.owner_account_id = $${String(paramIndex)}::uuid`,
    params: [owner],
  };
}
