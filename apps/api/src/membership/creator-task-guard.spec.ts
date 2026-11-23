import { describe, expect, it } from "vitest";
import { openCreatorHold } from "./creator-task-guard";
import { MemoryMembershipStore } from "./membership-store";

const workspace = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";
const context = { actorId: `creator:${accountId}`, idempotencyKey: "same-client-key" };

async function writingMembership() {
  const store = new MemoryMembershipStore();
  const plan = await store.savePlan(workspace, {
    code: "writing", name: "编剧", description: "", unitPriceAmount: null, unitPriceCurrency: null, active: true,
    features: [{ feature: "writing", enabled: true, includedUnits: 1 }],
  });
  await store.grant(workspace, {
    accountId, planId: plan.id, startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 60_000),
    reason: "测试", grantedBy: null,
  });
  return store;
}

describe("creator task quota identity", () => {
  it("replays one writing operation but reserves separately for another operation with the same key", async () => {
    const store = await writingMembership();
    const title = await openCreatorHold(store, workspace, context, "writing", projectId, "title-writing");
    expect(title.holdId).toBeTruthy();
    await store.bindTask(title.holdId!, "title-run");
    const replay = await openCreatorHold(store, workspace, context, "writing", projectId, "title-writing");
    expect(replay.holdId).toBe(title.holdId);
    await replay.release();
    const automatic = await openCreatorHold(store, workspace, context, "writing", projectId, "auto-creation");
    expect(automatic.denied?.code).toBe("QUOTA_EXHAUSTED");
    await store.noteRun({ runId: "title-run", outcome: "unsent" });
    expect((await store.balances(workspace, accountId)).writing).toBe(1);
  });

  it.each([
    ["old-client-key", context.idempotencyKey],
    [JSON.stringify(["auto-creation", context.idempotencyKey]), "old-run-id"],
  ])("keeps legacy key %s and bound task %s separate from new requests", async (oldKey, runId) => {
    const store = await writingMembership();
    const legacy = await store.reserve(workspace, {
      accountId, feature: "writing", projectId, idempotencyKey: oldKey, taskKey: oldKey,
    });
    if (!legacy.ok || "skipped" in legacy) throw new Error("expected a legacy hold");
    await store.bindTask(legacy.holdId, runId);
    const automatic = await openCreatorHold(store, workspace, context, "writing", projectId, "auto-creation");
    expect(automatic.denied?.code).toBe("QUOTA_EXHAUSTED");
    const replay = await store.reserve(workspace, {
      accountId, feature: "writing", projectId, idempotencyKey: "retry", taskKey: runId, replayOnly: true,
    });
    expect(replay).toEqual({ ok: true, holdId: legacy.holdId, replay: true });
    await store.noteRun({ runId, outcome: "unsent" });
    expect((await store.balances(workspace, accountId)).writing).toBe(1);
  });
});
