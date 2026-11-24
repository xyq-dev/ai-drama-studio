import {
  runWithStoreCreatorAccess,
  storeActorId,
  storeOwnerAccountFilter,
  type StoreCreatorAccess,
} from "@ai-drama/database";
import {
  LEGACY_OWNER_ACCOUNT_ID, creatorAccountIdFromActor,
  type CreatorAccountRole,
} from "@ai-drama/domain";

/**
 * Per-request creator / operator access scope (phase 4).
 * Bridges site-auth sessions into database store ownership filters.
 */
export type CreatorAccessScope =
  | { kind: "open" }
  | {
    kind: "scoped";
    role: CreatorAccountRole;
    accountId: string;
    username: string;
    /** Operator-only: list/get every work in the workspace. Never used for a normal creator 「我的作品」. */
    opsView: boolean;
  };

export function runWithCreatorAccess<T>(scope: CreatorAccessScope, work: () => T): T {
  const storeAccess: StoreCreatorAccess = scope.kind === "open"
    ? { kind: "open" }
    : {
      kind: "scoped",
      ownerAccountId: scope.role === "operator" && scope.opsView ? null : scope.accountId,
      actorId: scope.role === "operator" ? "server-owner" : `creator:${scope.accountId}`,
    };
  return runWithStoreCreatorAccess(storeAccess, work);
}

export function ownerAccountFilter(): string | null {
  return storeOwnerAccountFilter();
}

export function isCreatorRequest(): boolean {
  return creatorAccountIdFromActor(storeActorId()) !== null;
}

export function actorIdForAccess(): string {
  return storeActorId();
}

export function requireOperatorAccess(scope: CreatorAccessScope): boolean {
  return scope.kind === "open" || scope.role === "operator";
}

export function legacyOwnerAccountId(): string {
  return LEGACY_OWNER_ACCOUNT_ID;
}

export function ownerAccountIdForCreate(scope: CreatorAccessScope): string | null {
  if (scope.kind === "open") return null;
  return scope.accountId;
}
