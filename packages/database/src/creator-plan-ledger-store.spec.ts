import { describe, expect, it, vi } from "vitest";
import { CreatorPlanLedgerStore } from "./creator-plan-ledger-store";

describe("CreatorPlanLedgerStore", () => {
  it("writes nothing when confirmed is false", async () => {
    const query = vi.fn();
    const store = new CreatorPlanLedgerStore({
      connect: async () => ({ query, release: () => undefined }),
    });
    const result = await store.postLedgerEntry({
      workspaceId: "11111111-1111-4111-8111-111111111111",
      accountId: "22222222-2222-4222-8222-222222222222",
      entryKind: "debit",
      idempotencyKey: "key-1",
      confirmed: false,
      usageJson: { calls: 1 },
    });
    expect(result).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("posts a pending_price row when confirmed and amount is unknown", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("to_regclass")) return { rows: [{ present: true }] };
      if (sql.startsWith("INSERT INTO creator_usage_ledger")) {
        return {
          rows: [{
            id: "33333333-3333-4333-8333-333333333333",
            workspace_id: "11111111-1111-4111-8111-111111111111",
            account_id: "22222222-2222-4222-8222-222222222222",
            project_id: "44444444-4444-4444-8444-444444444444",
            task_key: "run-1",
            entry_kind: "debit",
            status: "pending_price",
            usage_json: { calls: 1 },
            amount_decimal: null,
            currency: null,
            idempotency_key: "key-2",
            occurred_at: new Date("2026-11-18T08:00:00.000Z"),
          }],
        };
      }
      return { rows: [] };
    });
    const store = new CreatorPlanLedgerStore({
      connect: async () => ({ query, release: () => undefined }),
    });
    const entry = await store.postLedgerEntry({
      workspaceId: "11111111-1111-4111-8111-111111111111",
      accountId: "22222222-2222-4222-8222-222222222222",
      projectId: "44444444-4444-4444-8444-444444444444",
      taskKey: "run-1",
      entryKind: "debit",
      idempotencyKey: "key-2",
      confirmed: true,
      usageJson: { calls: 1 },
    });
    expect(entry?.status).toBe("pending_price");
    expect(entry?.amountDecimal).toBeNull();
    expect(entry?.projectId).toBe("44444444-4444-4444-8444-444444444444");
    expect(entry?.taskKey).toBe("run-1");
  });
});
