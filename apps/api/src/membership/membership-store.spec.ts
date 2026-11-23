import { describe, expect, it } from "vitest";
import { MemoryMembershipStore } from "./membership-store";

const workspace = "11111111-1111-4111-8111-111111111111";
const account = "22222222-2222-4222-8222-222222222222";

describe("membership quota", () => {
  it("charges once for the same task, releases an unsent hold, and keeps an unknown result", async () => {
    const store = new MemoryMembershipStore();
    const plan = await store.savePlan(workspace, {
      code: "month", name: "月会员", description: "", unitPriceAmount: null, unitPriceCurrency: null, active: true,
      features: [
        { feature: "writing", enabled: true, includedUnits: 1 },
        { feature: "image", enabled: false, includedUnits: null },
        { feature: "voice", enabled: false, includedUnits: null },
        { feature: "video", enabled: false, includedUnits: null },
      ],
    });
    const now = new Date("2026-11-23T00:00:00.000Z");
    await store.grant(workspace, {
      accountId: account, planId: plan.id, startsAt: now, endsAt: new Date("2026-12-23T00:00:00.000Z"),
      reason: "人工开通", grantedBy: "admin",
    });
    const first = await store.reserve(workspace, { accountId: account, feature: "writing", idempotencyKey: "task-1", now });
    const second = await store.reserve(workspace, { accountId: account, feature: "writing", idempotencyKey: "task-1", now });
    expect(first.ok && second.ok && !("skipped" in first) && !("skipped" in second) && second.replay).toBe(true);
    expect((await store.balances(workspace, account)).writing).toBe(0);
    if (first.ok && !("skipped" in first)) await store.release(first.holdId);
    expect((await store.balances(workspace, account)).writing).toBe(1);
    const again = await store.reserve(workspace, { accountId: account, feature: "writing", idempotencyKey: "task-2", now });
    expect(again.ok).toBe(true);
    if (again.ok && !("skipped" in again)) {
      await store.bindTask(again.holdId, "run-2");
      await store.noteRun({ runId: "run-2", outcome: "unknown" });
    }
    const replay = await store.reserve(workspace, { accountId: account, feature: "writing", idempotencyKey: "task-2", taskKey: "run-2", now });
    expect(replay.ok && !("skipped" in replay) && replay.replay).toBe(true);
    expect((await store.balances(workspace, account)).writing).toBe(0);
  });

  it("lets only one of two concurrent submits take the last unit", async () => {
    const store = new MemoryMembershipStore();
    const plan = await store.savePlan(workspace, {
      code: "one", name: "一次", description: "", unitPriceAmount: null, unitPriceCurrency: null, active: true,
      features: [
        { feature: "writing", enabled: true, includedUnits: 1 },
        { feature: "image", enabled: true, includedUnits: 0 },
        { feature: "voice", enabled: false, includedUnits: null },
        { feature: "video", enabled: false, includedUnits: null },
      ],
    });
    const now = new Date("2026-11-23T00:00:00.000Z");
    await store.grant(workspace, {
      accountId: account, planId: plan.id, startsAt: now, endsAt: new Date("2026-12-23T00:00:00.000Z"),
      reason: "测试", grantedBy: null,
    });
    const [left, right] = await Promise.all([
      store.reserve(workspace, { accountId: account, feature: "writing", idempotencyKey: "a", now }),
      store.reserve(workspace, { accountId: account, feature: "writing", idempotencyKey: "b", now }),
    ]);
    const oks = [left, right].filter((item) => item.ok);
    expect(oks).toHaveLength(1);
    expect((await store.balances(workspace, account)).writing).toBe(0);
    const denied = [left, right].find((item) => !item.ok);
    expect(denied && !denied.ok && denied.code).toBe("QUOTA_EXHAUSTED");
  });

  it("rejects a new task after expiry without removing history", async () => {
    const store = new MemoryMembershipStore();
    const plan = await store.savePlan(workspace, {
      code: "old", name: "旧套餐", description: "", unitPriceAmount: null, unitPriceCurrency: null, active: true,
      features: [{ feature: "writing", enabled: true, includedUnits: 3 }, { feature: "image", enabled: false, includedUnits: null }, { feature: "voice", enabled: false, includedUnits: null }, { feature: "video", enabled: false, includedUnits: null }],
    });
    await store.grant(workspace, {
      accountId: account, planId: plan.id, startsAt: new Date("2026-01-01T00:00:00.000Z"), endsAt: new Date("2026-02-01T00:00:00.000Z"),
      reason: "人工开通", grantedBy: "admin",
    });
    const denied = await store.reserve(workspace, { accountId: account, feature: "writing", idempotencyKey: "late", now: new Date("2026-03-01T00:00:00.000Z") });
    expect(denied.ok).toBe(false);
    expect(await store.ledger(workspace, account)).toHaveLength(1);
  });
});
