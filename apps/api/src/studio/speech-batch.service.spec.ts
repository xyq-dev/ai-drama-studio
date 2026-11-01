import { describe, expect, it, vi } from "vitest";
import type { SpeechBatchClaim, SpeechBatchFrozenOperation, SpeechBatchInventory, SpeechBatchView, SpeechGenerationInput } from "@ai-drama/contracts";
import type { SpeechBatchPersistence, SpeechPersistence } from "@ai-drama/database";
import { PersistenceError } from "@ai-drama/database";
import { SpeechBatchService } from "./speech-batch.service";

const id = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222", hash = "a".repeat(64);
const ctx = { actorId: "owner", traceId: "batch-test", idempotencyKey: "permanent-request" };
const input = { workspaceId: id, projectId: id, shotRevisionId: id, planRevisionId: id, lineId: id, lineInputRevisionId: id, inputHash: hash,
  displayText: "你好", spokenText: "你好" } as SpeechGenerationInput;
const operation: SpeechBatchFrozenOperation = { id, input, idempotencyKey: "fixed-operation-key", quote: { quoteId: "quote", inputHash: hash,
  currency: "CNY", estimatedAmount: "0.01", maximumAmount: "0.02", expiresAt: "2099-01-01T00:00:00Z", providerConfigurationId: id,
  providerConfigurationVersion: "v1", priceVersion: "price-v1", uncertainJobIds: [other] } };
const confirmation = { frozenHash: hash, maximumJobs: 1, budgets: [{ currency: "CNY" as const, maximumAmount: "0.02" }],
  confirmPossibleCharges: true as const, confirmedUncertainJobIds: [other] };
function setup() {
  const view = { id, projectId: id, episodeId: id, frozenHash: hash, state: "quoted", confirmation: null, cancelRequested: false,
    operations: [], frozen: { operations: [operation] } } as unknown as SpeechBatchView;
  const inventory: SpeechBatchInventory = { projectId: id, episodeId: id, sourceHash: hash, operationLimit: 100, blockers: [], lines: [{
    shotRevisionId: id, planRevisionId: id, lineId: id, lineInputRevisionId: id, displayText: "你好", voiceName: "Cherry", status: "missing", jobIds: [] }] };
  const claim: SpeechBatchClaim = { ref: { batchId: id, operationId: id, dispatchToken: other }, operation, authorizationId: null };
  const store = { storageReady: vi.fn(async () => true), inventory: vi.fn(async () => inventory), findPreflight: vi.fn(async (): Promise<SpeechBatchView | null> => null),
    create: vi.fn(async () => view), read: vi.fn(async () => view), list: vi.fn(async () => ({ items: [view] })),
    confirm: vi.fn(async () => ({ ...view, state: "dispatching" as const, confirmation })), cancel: vi.fn(async () => ({ ...view, state: "canceled" as const })),
    claim: vi.fn<(...args: unknown[]) => Promise<SpeechBatchClaim | null>>().mockResolvedValueOnce(claim).mockResolvedValue(null),
    recordAuthorization: vi.fn(async () => undefined), failOperation: vi.fn(async () => undefined), finish: vi.fn(async () => view) };
  const speech = { generationInput: vi.fn(async () => input) };
  const generation = { capabilities: vi.fn(async () => ({ available: true, reasonCode: null, voices: [], catalogVersion: "v1" })),
    quote: vi.fn(async () => operation.quote), authorize: vi.fn(async () => ({ budgetAuthorizationId: other })),
    generate: vi.fn(async () => ({ jobId: id, workflowRunId: other, reused: false })) };
  const service = new SpeechBatchService({ workspaceId: id, store: store as unknown as SpeechBatchPersistence,
    speech: speech as unknown as SpeechPersistence, generation });
  return { service, store, speech, generation, view, inventory, claim };
}
describe("bounded episode speech orchestration", () => {
  it("returns the original preflight receipt before disabled configuration or changed current sources", async () => {
    const s = setup(); s.store.findPreflight.mockResolvedValue(s.view);
    s.generation.capabilities.mockResolvedValue({ available: false, reasonCode: "disabled", voices: [], catalogVersion: "off" });
    expect(await s.service.preflight(id, id, { sourceHash: hash, lineInputRevisionIds: [id] }, ctx)).toBe(s.view);
    expect(s.store.inventory).not.toHaveBeenCalled(); expect(s.generation.quote).not.toHaveBeenCalled();
  });
  it("quotes only explicitly selected missing lines and persists frozen exact totals without sending", async () => {
    const s = setup(); await s.service.preflight(id, id, { sourceHash: hash, lineInputRevisionIds: [id] }, ctx);
    expect(s.store.create).toHaveBeenCalledWith(id, id, id, { sourceHash: hash, lineInputRevisionIds: [id] }, expect.objectContaining({
      budgets: [{ currency: "CNY", estimatedAmount: "0.01000000", maximumAmount: "0.02000000" }], operations: [expect.objectContaining({ input, quote: operation.quote })] }), ctx);
    expect(s.generation.authorize).not.toHaveBeenCalled(); expect(s.generation.generate).not.toHaveBeenCalled();
  });
  it.each(["selected", "awaiting_selection", "in_progress"] as const)("does not pay for an already %s line", async (status) => {
    const s = setup(); s.inventory.lines[0]!.status = status;
    await expect(s.service.preflight(id, id, { sourceHash: hash, lineInputRevisionIds: [id] }, ctx)).rejects.toMatchObject({ code: "SPEECH_BATCH_LINE_AVAILABLE" });
    expect(s.generation.quote).not.toHaveBeenCalled();
  });
  it("confirms fixed authorization then passes the durable operation fence to existing Job generation", async () => {
    const s = setup(); await s.service.confirm(id, confirmation, ctx);
    expect(s.generation.authorize).toHaveBeenCalledExactlyOnceWith({ workspaceId: id, projectId: id, actorId: "owner", quoteId: "quote",
      maximumAmount: "0.02", confirmedUncertainJobIds: [other], idempotencyKey: "fixed-operation-key:authorize" });
    expect(s.store.recordAuthorization).toHaveBeenCalledWith(id, s.claim.ref, other);
    expect(s.generation.generate).toHaveBeenCalledExactlyOnceWith({ ...input, quoteId: "quote", budgetAuthorizationId: other,
      idempotencyKey: "fixed-operation-key", actorId: "owner", traceId: "batch-test", batchOperation: s.claim.ref });
  });
  it("does not automatically dispatch when replaying an already confirmed receipt", async () => {
    const s = setup(); s.view.state = "needs_attention"; s.view.confirmation = confirmation;
    await s.service.confirm(id, confirmation, ctx);
    expect(s.store.claim).not.toHaveBeenCalled(); expect(s.generation.generate).not.toHaveBeenCalled();
  });
  it("stops immediately on an ambiguous response and explicit resume reuses original authorization and key", async () => {
    const s = setup(); s.generation.generate.mockRejectedValueOnce(new Error("response lost"));
    await s.service.confirm(id, confirmation, ctx);
    expect(s.store.failOperation).toHaveBeenCalledWith(id, s.claim.ref, "SPEECH_BATCH_REQUEST_UNKNOWN", true);
    expect(s.store.claim).toHaveBeenCalledTimes(1);
    s.view.state = "needs_attention"; s.view.confirmation = confirmation;
    s.store.claim.mockReset().mockResolvedValueOnce({ ...s.claim, authorizationId: other }).mockResolvedValue(null);
    await s.service.resume(id, {}, ctx);
    expect(s.generation.authorize).toHaveBeenCalledTimes(1);
    expect(s.generation.generate.mock.calls[1]![0]).toMatchObject({ idempotencyKey: "fixed-operation-key", budgetAuthorizationId: other });
    expect(s.generation.quote).not.toHaveBeenCalled();
  });
  it("blocks changed source/quote without re-quoting and cancel never touches an existing Job", async () => {
    const s = setup(); s.generation.generate.mockRejectedValue(new PersistenceError("REAL_MEDIA_QUOTE_EXPIRED", "expired"));
    await s.service.confirm(id, confirmation, ctx);
    expect(s.store.failOperation).toHaveBeenCalledWith(id, s.claim.ref, "REAL_MEDIA_QUOTE_EXPIRED", false);
    await s.service.cancel(id, {}, ctx); expect(s.store.cancel).toHaveBeenCalledWith(id, id, ctx);
    expect(s.generation.quote).not.toHaveBeenCalled(); expect(s.generation.generate).toHaveBeenCalledTimes(1);
  });
});
