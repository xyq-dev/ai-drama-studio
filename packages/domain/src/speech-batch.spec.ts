import { describe, expect, it } from "vitest";
import { speechBatchConfirmSchema, speechBatchPreflightSchema,
  type SpeechBatchConfirmation, type SpeechBatchFrozenOperation, type SpeechQuote } from "@ai-drama/contracts";
import { assertSpeechBatchConfirmation, speechBatchBudgets } from "./speech-batch";

const hash = "a".repeat(64);
const id = (value: number) => `${value.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
function operation(value: number, quote: Partial<SpeechQuote> = {}): SpeechBatchFrozenOperation {
  return { id: id(value), idempotencyKey: `permanent-operation-${value}`, input: {
    workspaceId: id(1), projectId: id(2), shotRevisionId: id(3), planRevisionId: id(4),
    lineId: id(value + 100), lineInputRevisionId: id(value + 200), inputHash: hash,
    displayText: "精确原文。", spokenText: "精确原文。", emotion: "neutral", speed: 1,
    voice: { id: id(5), bindingId: id(6), contentHash: hash, catalogVoiceId: "Cherry", name: "Cherry",
      providerConfigurationId: id(7), providerConfigurationVersion: "v1", providerKey: "dashscope-media",
      model: "qwen3-tts-flash", modelVersion: "v1", voiceId: "Cherry", locale: "zh-CN", rightsRef: "authorized-preset",
      capabilities: { emotions: ["neutral"], speedMin: 1, speedMax: 1 } },
  }, quote: { quoteId: `quote-${value}`, inputHash: hash, currency: "CNY", estimatedAmount: "0.10",
    maximumAmount: "0.20", expiresAt: "2026-11-01T01:00:00.000Z", providerConfigurationId: id(7),
    providerConfigurationVersion: "v1", priceVersion: "v1", uncertainJobIds: [], ...quote } };
}
function confirmation(operations: SpeechBatchFrozenOperation[], patch: Partial<SpeechBatchConfirmation> = {}): SpeechBatchConfirmation {
  return { frozenHash: hash, maximumJobs: operations.length,
    budgets: speechBatchBudgets(operations).map(({ currency, maximumAmount }) => ({ currency, maximumAmount })),
    confirmPossibleCharges: true, confirmedUncertainJobIds: [], ...patch };
}
const code = (value: string) => expect.objectContaining({ code: value });

describe("speech batch fixed decimal budget", () => {
  it("adds every eighth-decimal unit exactly without floating point rounding", () => {
    const operations = [operation(1, { estimatedAmount: "0.1", maximumAmount: "0.1" }),
      operation(2, { estimatedAmount: "0.2", maximumAmount: "0.2" }),
      operation(3, { estimatedAmount: "0.00000001", maximumAmount: "0.00000001" })];
    expect(speechBatchBudgets(operations)).toEqual([{ currency: "CNY", estimatedAmount: "0.30000001", maximumAmount: "0.30000001" }]);
  });
  it("keeps currencies separate, deterministically ordered, and unknown estimates null only in their currency", () => {
    const operations = [operation(1, { currency: "USD", estimatedAmount: "0.10", maximumAmount: "0.12" }),
      operation(2, { estimatedAmount: null, maximumAmount: "0.20" }),
      operation(3, { estimatedAmount: "0.02", maximumAmount: "0.03" }),
      operation(4, { currency: "USD", estimatedAmount: "0.20", maximumAmount: "0.25" })];
    const expected = [{ currency: "CNY", estimatedAmount: null, maximumAmount: "0.23000000" },
      { currency: "USD", estimatedAmount: "0.30000000", maximumAmount: "0.37000000" }];
    expect(speechBatchBudgets(operations)).toEqual(expected);
    expect(speechBatchBudgets([...operations].reverse())).toEqual(expected);
  });
  it("supports exactly 100 operations and refuses an empty or larger batch", () => {
    const operations = Array.from({ length: 100 }, (_, index) => operation(index + 1));
    expect(speechBatchBudgets(operations)).toEqual([{ currency: "CNY", estimatedAmount: "10.00000000", maximumAmount: "20.00000000" }]);
    expect(() => assertSpeechBatchConfirmation(operations, hash, confirmation(operations))).not.toThrow();
    for (const invalid of [[], [...operations, operation(101)]]) {
      expect(() => speechBatchBudgets(invalid)).toThrow(code("SPEECH_BATCH_LIMIT"));
    }
    expect(speechBatchPreflightSchema.safeParse({ sourceHash: hash, lineInputRevisionIds: operations.map((o) => o.input.lineInputRevisionId) }).success).toBe(true);
    expect(speechBatchPreflightSchema.safeParse({ sourceHash: hash, lineInputRevisionIds: [...operations, operation(101)].map((o) => o.input.lineInputRevisionId) }).success).toBe(false);
  });
  it("rejects a mismatched quote input before adding or confirming its budget", () => {
    const operations = [operation(1, { inputHash: "b".repeat(64) })];
    expect(() => speechBatchBudgets(operations)).toThrow(code("SPEECH_BATCH_INVALID"));
    expect(() => assertSpeechBatchConfirmation(operations, hash, { frozenHash: hash, maximumJobs: 1,
      budgets: [{ currency: "CNY", maximumAmount: "0.2" }], confirmPossibleCharges: true, confirmedUncertainJobIds: [] })).toThrow(code("SPEECH_BATCH_INVALID"));
  });
  it("rejects zero ceilings, estimates above the ceiling, and malformed amounts", () => {
    for (const quote of [{ estimatedAmount: "0", maximumAmount: "0" }, { estimatedAmount: "0.20000001", maximumAmount: "0.2" }]) {
      expect(() => speechBatchBudgets([operation(1, quote)])).toThrow(code("SPEECH_BATCH_INVALID"));
    }
    for (const maximumAmount of ["0.000000001", "1e2", "-1", "NaN"]) {
      expect(() => speechBatchBudgets([operation(1, { maximumAmount })])).toThrow(code("VALIDATION_ERROR"));
    }
  });
  it("confirms an aggregate beyond a single-operation amount without weakening the individual ceiling", () => {
    const operations = [operation(1, { estimatedAmount: "50000000", maximumAmount: "50000000" }),
      operation(2, { estimatedAmount: "50000000.00000001", maximumAmount: "50000000.00000001" })];
    expect(speechBatchBudgets(operations)).toEqual([{ currency: "CNY", estimatedAmount: "100000000.00000001", maximumAmount: "100000000.00000001" }]);
    expect(() => assertSpeechBatchConfirmation(operations, hash, confirmation(operations))).not.toThrow();
    expect(() => speechBatchBudgets([operation(3, { maximumAmount: "100000000" })])).toThrow(code("VALIDATION_ERROR"));
  });
});

describe("speech batch explicit confirmation", () => {
  it("binds confirmation to the frozen hash and the exact maximum job count", () => {
    const operations = [operation(1), operation(2)];
    for (const patch of [{ frozenHash: "b".repeat(64) }, { maximumJobs: 1 }, { maximumJobs: 3 }]) {
      expect(() => assertSpeechBatchConfirmation(operations, hash, confirmation(operations, patch))).toThrow(code("SPEECH_BATCH_CONFIRMATION_CHANGED"));
    }
  });
  it("requires each exact currency total, permitting only equivalent decimal notation", () => {
    const operations = [operation(1), operation(2, { currency: "USD" })];
    expect(() => assertSpeechBatchConfirmation(operations, hash, confirmation(operations, { budgets: [
      { currency: "USD", maximumAmount: "0.2" }, { currency: "CNY", maximumAmount: "0.20000000" },
    ] }))).not.toThrow();
    for (const budgets of [[], [{ currency: "CNY" as const, maximumAmount: "0.2" }],
      [{ currency: "CNY" as const, maximumAmount: "0.2" }, { currency: "USD" as const, maximumAmount: "0.20000001" }],
      [{ currency: "CNY" as const, maximumAmount: "0.2" }, { currency: "USD" as const, maximumAmount: "0.19999999" }],
      [{ currency: "CNY" as const, maximumAmount: "0.2" }, { currency: "CNY" as const, maximumAmount: "0.2" }]]) {
      expect(() => assertSpeechBatchConfirmation(operations, hash, confirmation(operations, { budgets }))).toThrow(code("SPEECH_BATCH_BUDGET_CHANGED"));
    }
    const single = [operation(3)];
    expect(() => assertSpeechBatchConfirmation(single, hash, confirmation(single, { budgets: [
      { currency: "CNY", maximumAmount: "0.2" }, { currency: "USD", maximumAmount: "0.2" },
    ] }))).toThrow(code("SPEECH_BATCH_BUDGET_CHANGED"));
  });
  it("requires the exact explicit unknown-job union across all quotes", () => {
    const operations = [operation(1, { uncertainJobIds: [id(901), id(902)] }),
      operation(2, { uncertainJobIds: [id(902), id(903)] }), operation(3, { uncertainJobIds: undefined })];
    const original = operations.map((o) => o.quote.uncertainJobIds && [...o.quote.uncertainJobIds]);
    for (const confirmedUncertainJobIds of [[], [id(901), id(902)], [id(901), id(902), id(903), id(904)]]) {
      expect(() => assertSpeechBatchConfirmation(operations, hash, confirmation(operations, { confirmedUncertainJobIds }))).toThrow(code("REAL_MEDIA_UNCERTAIN_CHANGED"));
    }
    expect(() => assertSpeechBatchConfirmation(operations, hash, confirmation(operations, {
      confirmedUncertainJobIds: [id(903), id(901), id(902), id(902)],
    }))).not.toThrow();
    expect(operations.map((o) => o.quote.uncertainJobIds)).toEqual(original);
  });
  it("never treats an omitted unknown confirmation or an unchecked charge consent as approval", () => {
    const operations = [operation(1, { uncertainJobIds: [id(901)] })];
    const { confirmedUncertainJobIds: _unknown, ...withoutUnknown } = confirmation(operations);
    const parsed = speechBatchConfirmSchema.parse(withoutUnknown);
    expect(parsed.confirmedUncertainJobIds).toEqual([]);
    expect(() => assertSpeechBatchConfirmation(operations, hash, parsed)).toThrow(code("REAL_MEDIA_UNCERTAIN_CHANGED"));
    const full = confirmation(operations, { confirmedUncertainJobIds: [id(901)] });
    expect(speechBatchConfirmSchema.safeParse({ ...full, confirmPossibleCharges: false }).success).toBe(false);
    const { confirmPossibleCharges: _consent, ...withoutConsent } = full;
    expect(speechBatchConfirmSchema.safeParse(withoutConsent).success).toBe(false);
  });
});
