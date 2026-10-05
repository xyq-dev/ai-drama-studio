import { describe, expect, it } from "vitest";
import { assertFixedMockImageSnapshot, assertSyncActualCost, providerCostMatches, type ProviderActualCostInput, type StoredProviderCost } from "./mock-media-cost";

const incoming: ProviderActualCostInput = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  generationJobId: "33333333-3333-4333-8333-333333333333",
  jobAttemptId: "44444444-4444-4444-8444-444444444444",
  providerConfigurationId: "55555555-5555-4555-8555-555555555555",
  providerRequestId: "mock-media|sync|video.generate|job:1",
  idempotencyKey: "mock-media|sync|video.generate|job:1:request:actual",
  currency: "USD",
  amountDecimal: "0.00000000",
  kind: "ACTUAL",
  basis: "PROVIDER_REPORTED",
  unitType: "request",
  unitQuantity: "1.00000000",
  unitPriceSnapshot: "0.00000000",
  provider: "mock-media",
  model: "mock-v1",
};

const stored: StoredProviderCost = {
  projectId: incoming.projectId,
  generationJobId: incoming.generationJobId,
  jobAttemptId: incoming.jobAttemptId,
  providerConfigurationId: incoming.providerConfigurationId,
  providerRequestId: incoming.providerRequestId,
  idempotencyKey: incoming.idempotencyKey,
  currency: "USD",
  amountDecimal: "0.00000000",
  kind: "ACTUAL",
  basis: "PROVIDER_REPORTED",
  unitType: "request",
  unitQuantity: "1",
  unitPriceSnapshot: "0",
  provider: "mock-media",
  model: "mock-v1",
  supersedesEstimateKey: null,
};

describe("synchronous mock media cost", () => {
  it("accepts an exact zero-dollar actual replay and rejects a different ledger", () => {
    expect(providerCostMatches(stored, incoming)).toBe(true);
    expect(providerCostMatches(stored, { ...incoming, amountDecimal: "0" })).toBe(true);
    expect(providerCostMatches({ ...stored, amountDecimal: "1.00000000" }, incoming)).toBe(false);
    expect(providerCostMatches({ ...stored, generationJobId: "99999999-9999-4999-8999-999999999999" }, incoming)).toBe(false);
    expect(providerCostMatches({ ...stored, kind: "ESTIMATED" }, incoming)).toBe(false);
    expect(providerCostMatches({ ...stored, supersedesEstimateKey: "estimate" }, incoming)).toBe(false);
    expect(providerCostMatches(stored, { ...incoming, currency: "EUR" })).toBe(false);
  });

  it("accepts only the fixed synchronous image snapshot", () => {
    const shotRevisionId = "33333333-3333-4333-8333-333333333333";
    const legal = Object.freeze({
      schema: "m3.mock.image.v1",
      shotRevisionId,
      seed: null,
      outcome: "success",
    });
    const persistedJson = JSON.stringify(legal);
    expect(() => assertFixedMockImageSnapshot(legal, shotRevisionId)).not.toThrow();
    expect(JSON.stringify(legal)).toBe(persistedJson);
    expect(Object.keys(legal)).toHaveLength(4);
    for (const bypassCache of [false, true]) {
      expect(() => assertFixedMockImageSnapshot({ ...legal, bypassCache }, shotRevisionId)).not.toThrow();
    }
    for (const bypassCache of [undefined, null, "false", 0]) {
      expect(() => assertFixedMockImageSnapshot({ ...legal, bypassCache }, shotRevisionId)).toThrow(/fixed success job/);
    }
    expect(() => assertFixedMockImageSnapshot({ ...legal, seed: "same" }, shotRevisionId)).not.toThrow();
    expect(() => assertFixedMockImageSnapshot({ ...legal, executionMode: "delayed" }, shotRevisionId))
      .toThrow(/fixed success job/);
    expect(() => assertFixedMockImageSnapshot({ ...legal, bypassCache: false, extra: true }, shotRevisionId))
      .toThrow(/fixed success job/);
    expect(() => assertFixedMockImageSnapshot({ ...legal, outcome: "delayed" }, shotRevisionId))
      .toThrow(/fixed success job/);
    expect(() => assertFixedMockImageSnapshot({ ...legal, shotRevisionId: "other" }, shotRevisionId))
      .toThrow(/fixed success job/);
    expect(() => assertFixedMockImageSnapshot({}, shotRevisionId)).toThrow(/fixed success job/);
  });

  it("rejects an actual that invents a missing estimate", () => {
    expect(() => assertSyncActualCost({ ...incoming, supersedesEstimateKey: "missing-estimate" }))
      .toThrow(/cannot reference an estimate/);
    expect(() => assertSyncActualCost({ ...incoming, amountDecimal: "0.01000000" }))
      .toThrow(/zero-dollar/);
  });
});
