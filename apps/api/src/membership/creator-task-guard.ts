import type { TitleRunRecord, WritingQuotaTransaction, WritingResumeQuotaCheck } from "@ai-drama/contracts";
import { creatorAccountIdFromActor, type MembershipFeature } from "@ai-drama/domain";
import type { MembershipStore, ReserveResult } from "./membership-store";

interface CreatorTaskContext {
  actorId: string;
  idempotencyKey?: string;
}

interface TaskBinding {
  taskKey: string;
  transaction: WritingQuotaTransaction;
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
  operation: string,
  binding?: TaskBinding,
): Promise<OpenCreatorHold> {
  if (!installed) return noopHold();
  return openCreatorHold(installed.store, installed.workspaceId, context, feature, projectId, operation, binding);
}

/** Reserve and keep the hold. Call only when a new task is about to be sent. */
export async function acceptCreatorTask(
  context: CreatorTaskContext,
  feature: MembershipFeature,
  projectId: string,
  operation: string,
): Promise<{ code: string; message: string } | null> {
  const hold = await openInstalledHold(context, feature, projectId, operation);
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
  operation: string,
  binding?: TaskBinding,
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
    operation,
    projectId,
    ...(binding && { taskKey: binding.taskKey }),
  }, binding?.transaction);
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

/** A resumed run uses its original creator and reservation, including holds created before operation names were stored. */
export function writingResumeQuotaCheck(
  store: MembershipStore | undefined,
  run: Pick<TitleRunRecord, "id" | "workspaceId" | "projectId" | "actorId" | "idempotencyKey">,
  operation: "title-writing" | "auto-creation" | "script-breakdown",
): WritingResumeQuotaCheck | undefined {
  const accountId = creatorAccountIdFromActor(run.actorId);
  if (!store || !accountId) return undefined;
  return async transaction => {
    const result = await store.reserve(run.workspaceId, {
      accountId, feature: "writing", projectId: run.projectId, taskKey: run.id, idempotencyKey: run.idempotencyKey, operation,
    }, transaction);
    return result.ok ? null : { code: result.code, message: result.message };
  };
}
