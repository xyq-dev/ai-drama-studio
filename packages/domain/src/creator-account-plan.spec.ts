import { describe, expect, it } from "vitest";
import {
  creatorCrossAccountAccessStatus,
  formatCreatorLedgerAmount,
  formatCreatorLedgerRecord,
  formatCreatorPlanRemaining,
  formatCreatorPlanUnitPrice,
  formatCreatorPlanUnpricedAmount,
  mayAutoResendCreatorBillingWhenUnconfirmedOrUnpriced,
  mayPostCreatorLedgerEntry,
  unconfirmedCreatorBillingIsBilledFailure,
} from "./creator-account-plan";

describe("creator-account-plan (phase 4)", () => {
  it("shows 尚未计价 when unit price or remaining quota is unpriced", () => {
    expect(formatCreatorPlanUnpricedAmount()).toBe("尚未计价");
    expect(formatCreatorPlanUnitPrice({ unitPriceAmount: null })).toBe("尚未计价");
    expect(formatCreatorPlanUnitPrice({ unitPriceAmount: undefined })).toBe("尚未计价");
    expect(formatCreatorPlanRemaining({
      remainingUnits: null, entitlementStatus: "unpriced", unitPriceAmount: null,
    })).toContain("尚未计价");
    expect(formatCreatorPlanRemaining({
      remainingUnits: 10, unitLabel: "次", entitlementStatus: "unpriced", unitPriceAmount: null,
    })).toContain("尚未计价");
  });

  it("never invents a zero fee for an unpriced ledger row", () => {
    expect(formatCreatorLedgerAmount({ status: "pending_price" })).toBe("尚未计价");
    expect(formatCreatorLedgerAmount({ status: "posted", amountDecimal: null })).toBe("尚未计价");
    const line = formatCreatorLedgerRecord({
      accountId: "acct-1",
      projectId: "proj-1",
      taskKey: "run-1",
      occurredAt: "2026-11-18T08:00:00.000Z",
      usageSummary: "1 call",
      status: "pending_price",
      entryKind: "debit",
    });
    expect(line).toContain("账户 acct-1");
    expect(line).toContain("作品 proj-1");
    expect(line).toContain("任务 run-1");
    expect(line).toContain("待计价");
    expect(line).toContain("尚未计价");
    expect(line).not.toMatch(/(?:金额|计费)\s*0/);
  });

  it("refuses ledger posts without confirmation and does not treat that as a billed failure", () => {
    expect(mayPostCreatorLedgerEntry({ confirmed: false })).toBe(false);
    expect(mayPostCreatorLedgerEntry({ confirmed: true })).toBe(true);
    expect(unconfirmedCreatorBillingIsBilledFailure()).toBe(false);
    expect(mayAutoResendCreatorBillingWhenUnconfirmedOrUnpriced()).toBe(false);
  });

  it("uses opaque 404 for cross-account access", () => {
    expect(creatorCrossAccountAccessStatus()).toBe(404);
  });
});
