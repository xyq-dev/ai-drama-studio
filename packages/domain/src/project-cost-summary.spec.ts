import { describe, expect, it } from "vitest";
import { DomainError } from "./errors";
import { addLedgerAmounts, assertLedgerAmount, buildProjectCostSummary, summarizeRecordedLedger, type RecordedLedgerFact } from "./project-cost-summary";

const projectId = "22222222-2222-4222-8222-222222222222";

describe("project cost summary amounts", () => {
  it("keeps a real zero actual distinct from a missing amount", () => {
    expect(assertLedgerAmount("0.00000000")).toBe("0.00000000");
    expect(() => assertLedgerAmount("0")).toThrow(DomainError);
    const summary = buildProjectCostSummary({
      projectId,
      snapshotAt: "2026-10-03T02:00:00.000Z",
      ledgerRowCount: 0,
      currencies: [],
      coverage: emptyCoverage(),
    });
    expect(summary.currencies).toEqual([]);
    expect(summary.ledgerRowCount).toBe(0);
    expect(summary.boundary).toEqual({ localEncodeCostMetered: false, totalProductionCostKnown: false });
  });

  it("accepts a total larger than one numeric(20,8) row and preserves eight decimals", () => {
    const summary = buildProjectCostSummary({
      projectId,
      snapshotAt: "2026-10-03T02:00:00.000Z",
      ledgerRowCount: 10,
      currencies: [
        currency("USD", "1200000000010.00000001", "0.00000000", 7, 0, 0),
        currency("CNY", "0.00000000", "3.25000000", 0, 1, 1),
        currency("EUR", "0.00000000", "8.00000000", 0, 1, 0),
      ],
      coverage: emptyCoverage(),
    });
    expect(summary.schema).toBe("m4.project.cost-summary.v1");
    expect(summary.currencies.map((row) => row.currency)).toEqual(["CNY", "EUR", "USD"]);
    expect(summary.currencies[2]?.actualAmount).toBe("1200000000010.00000001");
    expect(summary.currencies[0]?.actualEntryCount).toBe(0);
    expect(summary.currencies[2]?.actualEntryCount).toBe(7);
  });

  it("keeps actuals, outstanding estimates, supersession, currencies, and empty attempts", () => {
    const rows: RecordedLedgerFact[] = [
      fact("a1", "USD", "600000000000.00000000", "ACTUAL", null, "attempt-old"),
      fact("a2", "USD", "600000000000.00000000", "ACTUAL", null, "attempt-old"),
      fact("a3", "USD", "0.00000000", "ACTUAL", null, "attempt-canceled"),
      fact("a4", "USD", "0.00000001", "ACTUAL", null, null),
      fact("e1", "CNY", "10.50000000", "ESTIMATED", null, "attempt-new"),
      fact("a5", "USD", "4.25000000", "ACTUAL", "e1", "attempt-new"),
      fact("a6", "USD", "4.25000000", "ACTUAL", "e1", "attempt-new"),
      fact("a7", "USD", "1.50000000", "ACTUAL", null, "attempt-failed"),
      fact("e2", "CNY", "3.25000000", "ESTIMATED", null, "attempt-failed"),
      fact("e3", "EUR", "8.00000000", "ESTIMATED", null, "attempt-old"),
    ];
    expect(addLedgerAmounts("600000000000.00000000", "600000000000.00000000")).toBe("1200000000000.00000000");
    expect(summarizeRecordedLedger(rows)).toEqual([
      currency("CNY", "0.00000000", "3.25000000", 0, 1, 1),
      currency("EUR", "0.00000000", "8.00000000", 0, 1, 0),
      currency("USD", "1200000000010.00000001", "0.00000000", 7, 0, 0),
    ]);
    expect(summarizeRecordedLedger([])).toEqual([]);
  });

  it("rejects parsed floats and duplicate currencies", () => {
    expect(() => assertLedgerAmount("1e2")).toThrow(DomainError);
    expect(() => assertLedgerAmount("1.5")).toThrow(DomainError);
    expect(() => buildProjectCostSummary({
      projectId,
      snapshotAt: "2026-10-03T02:00:00.000Z",
      ledgerRowCount: 2,
      currencies: [
        currency("USD", "1.00000000", "0.00000000", 1, 0, 0),
        currency("USD", "1.00000000", "0.00000000", 1, 0, 0),
      ],
      coverage: emptyCoverage(),
    })).toThrow(DomainError);
  });
});

function currency(
  code: string,
  actualAmount: string,
  outstandingEstimatedAmount: string,
  actualEntryCount: number,
  outstandingEstimatedEntryCount: number,
  supersededEstimatedEntryCount: number,
) {
  return {
    currency: code,
    actualAmount,
    outstandingEstimatedAmount,
    actualEntryCount,
    outstandingEstimatedEntryCount,
    supersededEstimatedEntryCount,
  };
}

function fact(
  id: string,
  code: string,
  amount: string,
  kind: "ACTUAL" | "ESTIMATED",
  supersedesCostId: string | null,
  jobAttemptId: string | null,
): RecordedLedgerFact {
  return { id, currency: code, amount, kind, supersedesCostId, jobAttemptId };
}

function emptyCoverage() {
  return {
    jobCount: 0,
    attemptCount: 0,
    jobsWithoutLedgerCount: 0,
    providerBoundAttemptsWithoutLedgerCount: 0,
    localComposeAttemptCount: 0,
    ledgerRowsWithoutAttemptCount: 0,
  };
}
