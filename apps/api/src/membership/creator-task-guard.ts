import { creatorAccountIdFromActor, type MembershipFeature } from "@ai-drama/domain";
import type { MembershipStore, ReserveResult } from "./membership-store";

interface CreatorTaskContext {
  actorId: string;
  idempotencyKey?: string;
}

export interface OpenCreatorHold {
  denied: { code: string; message: string } | null;
  holdId: string | null;
  keep(): void;
  release(): Promise<void>;
}

let installed: { store: MembershipStore; workspaceId: string } | null = null;

/** Studio startup installs the store used by every creator task entry. */
export function installCreatorMembership(store: MembershipStore, workspaceId: string): void {
  installed = { store, workspaceId };
}

export function installedCreatorMembership(): { store: MembershipStore; workspaceId: string } | null {
  return installed;
}

const noopHold = (): OpenCreatorHold => ({ denied: null, holdId: null, keep() {}, async release() {} });

export async function openInstalledHold(
  context: CreatorTaskContext,
  feature: MembershipFeature,
  projectId: string,
): Promise<OpenCreatorHold> {
  if (!installed) return noopHold();
  return openCreatorHold(installed.store, installed.workspaceId, context, feature, projectId);
}

/** Reserve and keep the hold. Call only when a new task is about to be sent. */
export async function acceptCreatorTask(
  context: CreatorTaskContext,
  feature: MembershipFeature,
  projectId: string,
): Promise<{ code: string; message: string } | null> {
  const hold = await openInstalledHold(context, feature, projectId);
  if (hold.denied) return hold.denied;
  hold.keep();
  return null;
}

export async function openCreatorHold(
  store: MembershipStore | undefined,
  workspaceId: string,
  context: CreatorTaskContext,
  feature: MembershipFeature,
  projectId: string,
): Promise<OpenCreatorHold> {
  const accountId = creatorAccountIdFromActor(context.actorId);
  const key = context.idempotencyKey;
  if (!store || !accountId || !key) {
    return { denied: null, holdId: null, keep() {}, async release() {} };
  }
  const reserved: ReserveResult = await store.reserve(workspaceId, {
    accountId,
    feature,
    idempotencyKey: key,
    projectId,
    taskKey: key,
  });
  if (!reserved.ok) return { denied: { code: reserved.code, message: reserved.message }, holdId: null, keep() {}, async release() {} };
  if ("skipped" in reserved) return { denied: null, holdId: null, keep() {}, async release() {} };
  let kept = reserved.replay;
  return {
    denied: null,
    holdId: reserved.holdId,
    keep() { kept = true; },
    async release() {
      if (!kept) await store.release(reserved.holdId);
    },
  };
}
