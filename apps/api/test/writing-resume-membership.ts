import { assert, expect, vi } from "vitest";
import * as guard from "../src/membership/creator-task-guard";
import { MemoryMembershipStore } from "../src/membership/membership-store";

export async function oneWritingUnit(workspaceId: string) {
  const membership = new MemoryMembershipStore();
  const accountId = "88888888-8888-4888-8888-888888888888";
  const actor = (idempotencyKey: string) => ({ actorId: `creator:${accountId}`, traceId: "t", idempotencyKey });
  const plan = await membership.savePlan(workspaceId, {
    code: "writer", name: "编剧", description: "", unitPriceAmount: null, unitPriceCurrency: null, active: true,
    features: [{ feature: "writing", enabled: true, includedUnits: 1 }],
  });
  const now = Date.now();
  await membership.grant(workspaceId, {
    accountId, planId: plan.id, startsAt: new Date(now - 60_000), endsAt: new Date(now + 86_400_000), reason: "测试", grantedBy: null,
  });
  return { workspaceId, membership, accountId, actor };
}

export async function withInstalledWritingUnit(workspaceId: string, test: (member: Awaited<ReturnType<typeof oneWritingUnit>>) => Promise<void>) {
  const member = await oneWritingUnit(workspaceId);
  const open = vi.spyOn(guard, "openInstalledHold").mockImplementation((context, feature, projectId, operation) =>
    guard.openCreatorHold(member.membership, workspaceId, context, feature, projectId, operation));
  const installed = vi.spyOn(guard, "installedCreatorMembership").mockReturnValue({ workspaceId, store: member.membership });
  try {
    await test(member);
  } finally {
    open.mockRestore();
    installed.mockRestore();
  }
}

export async function verifyRefundedWritingResume(member: Awaited<ReturnType<typeof oneWritingUnit>>, fixture: {
  runId: string;
  seen: readonly unknown[];
  settle: () => Promise<void>;
  resume: () => Promise<{ status: number; body: unknown }>;
}) {
  const { membership, workspaceId, accountId } = member;
  const { runId, resume, settle, seen } = fixture;
  const initial = await membership.ledger(workspaceId, accountId);
  expect(initial.filter((row) => row.kind === "debit")).toHaveLength(1);
  expect(initial).toContainEqual(expect.objectContaining({ kind: "credit", taskKey: runId, status: "released" }));
  expect((await membership.balances(workspaceId, accountId)).writing).toBe(1);
  expect(seen).toHaveLength(0);

  const other = await membership.reserve(workspaceId, { accountId, feature: "writing", idempotencyKey: "another-task" });
  assert(other.ok && !("skipped" in other));
  expect(await resume()).toMatchObject({ status: 402, body: { error: { code: "QUOTA_EXHAUSTED" } } });
  await settle();
  expect(seen).toHaveLength(0);

  await membership.release(other.holdId);
  expect((await resume()).status).toBe(200);
  const reserved = await membership.ledger(workspaceId, accountId);
  expect((await resume()).status).toBe(200);
  expect(await membership.ledger(workspaceId, accountId)).toEqual(reserved);
  await settle();
  const ledger = await membership.ledger(workspaceId, accountId);
  expect((await membership.balances(workspaceId, accountId)).writing).toBe(0);
  expect(ledger.filter((row) => row.kind === "debit")).toHaveLength(3);
  expect((await resume()).status).toBe(200);
  await settle();
  expect(await membership.ledger(workspaceId, accountId)).toEqual(ledger);
}
