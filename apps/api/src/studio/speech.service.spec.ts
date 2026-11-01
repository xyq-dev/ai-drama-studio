import { describe, expect, it, vi } from "vitest";
import { SpeechAudioOverflowError } from "@ai-drama/domain";
import type { SpeechGenerationInput, SpeechGenerationPort } from "@ai-drama/contracts";
import { PersistenceError, type SpeechPersistence } from "@ai-drama/database";
import { SpeechService } from "./speech.service";
const id = "11111111-1111-4111-8111-111111111111";
const context = { actorId: "owner", traceId: "trace", idempotencyKey: "permanent-key" };
function setup(options: { ready?: boolean; generation?: boolean } = {}) {
  const frozen = { workspaceId: id, projectId: id, planRevisionId: id, lineId: id, inputHash: "a".repeat(64) } as SpeechGenerationInput;
  const store = { storageReady: vi.fn(async () => options.ready ?? true), requireProject: vi.fn(async () => undefined),
    generationInput: vi.fn(async () => frozen), putPlan: vi.fn(), select: vi.fn(), mixPreflight: vi.fn(), bindings: vi.fn(),
    plan: vi.fn(), bindingImpact: vi.fn(), putBinding: vi.fn() };
  const port = { capabilities: vi.fn(async () => ({ available: true, reasonCode: null, catalogVersion: "catalog-v1", voices: [] })),
    quote: vi.fn(async () => ({ quoteId: "quote" })), generate: vi.fn(async () => ({ jobId: id, workflowRunId: id, reused: false })) };
  const service = new SpeechService({ workspaceId: id, store: store as unknown as SpeechPersistence,
    generation: options.generation === false ? null : port as unknown as SpeechGenerationPort });
  return { service, store, port, frozen };
}
describe("speech API service", () => {
  it("admits the bounded 2000-ID batch confirmation while rejecting payloads above 128 KB", async () => {
    const current = { id, state: "dispatched" };
    const batchStore = { storageReady: vi.fn(async () => true), read: vi.fn(async () => current), confirm: vi.fn(async () => current) };
    const service = new SpeechService({ workspaceId: id, store: { storageReady: async () => true } as unknown as SpeechPersistence,
      generation: null, batchStore: batchStore as unknown as import("@ai-drama/database").SpeechBatchPersistence });
    const request = { frozenHash: "a".repeat(64), maximumJobs: 100, budgets: [{ currency: "CNY", maximumAmount: "100" }], confirmPossibleCharges: true,
      confirmedUncertainJobIds: Array.from({ length: 2000 }, (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`) };
    expect(Buffer.byteLength(JSON.stringify(request))).toBeGreaterThan(64 * 1024);
    expect(await service.batchConfirm(id, request, context)).toMatchObject({ status: 202 });
    expect(batchStore.confirm).toHaveBeenCalledOnce();
    expect(await service.batchConfirm(id, { ...request, extra: "x".repeat(128 * 1024) }, context)).toMatchObject({ status: 413,
      body: { error: { code: "SPEECH_BATCH_REQUEST_TOO_LARGE" } } });
    expect(batchStore.confirm).toHaveBeenCalledOnce();
  });
  it("exposes explicit unavailable storage/configuration without fabricating quotes or jobs", async () => {
    const missing = setup({ ready: false });
    expect(await missing.service.capabilities(id)).toMatchObject({ status: 200, body: { available: false, reasonCode: "SPEECH_STORAGE_UNAVAILABLE" } });
    expect(await missing.service.generate(id, id, { quoteId: "q", budgetAuthorizationId: id }, context)).toMatchObject({ status: 503, body: { error: { code: "SPEECH_STORAGE_UNAVAILABLE" } } });
    expect(missing.port.generate).not.toHaveBeenCalled();
    const disabled = setup({ generation: false });
    expect(await disabled.service.quote(id, id, {})).toMatchObject({ status: 409, body: { error: { code: "SPEECH_DISABLED" } } });
    expect(disabled.port.quote).not.toHaveBeenCalled();
  });
  it("delegates exactly one frozen line and its explicit authorization to the existing-Job port", async () => {
    const { service, port, frozen } = setup();
    expect(await service.generate(id, id, { quoteId: "quote", budgetAuthorizationId: id }, context)).toMatchObject({ status: 202, body: { jobId: id } });
    expect(port.generate).toHaveBeenCalledExactlyOnceWith({ ...frozen, quoteId: "quote", budgetAuthorizationId: id, ...context });
    expect(port.quote).not.toHaveBeenCalled();
  });
  it("allows the port to recover a permanent-key receipt before applying current configuration gates", async () => {
    const { service, port, store } = setup();
    port.capabilities.mockResolvedValue({ available: false, reasonCode: "SPEECH_DISABLED", catalogVersion: "none", voices: [] });
    expect(await service.generate(id, id, { quoteId: "original-quote", budgetAuthorizationId: id }, context)).toMatchObject({ status: 202 });
    expect(store.generationInput).toHaveBeenCalledWith(id, id, id, true);
    expect(port.capabilities).not.toHaveBeenCalled();
    // The injected real-media port still validates current sources in its new-Job transaction after replay lookup.
    expect(port.generate).toHaveBeenCalledOnce();
  });
  it("reports a changed server-side uncertain task set without retrying or granting a new quote", async () => {
    const { service, port } = setup();
    port.generate.mockRejectedValue(new PersistenceError("REAL_MEDIA_UNCERTAIN_CHANGED", "changed"));
    expect(await service.generate(id, id, { quoteId: "original-quote", budgetAuthorizationId: id }, context))
      .toMatchObject({ status: 409, body: { error: { code: "REAL_MEDIA_UNCERTAIN_CHANGED" } } });
    expect(port.generate).toHaveBeenCalledOnce(); expect(port.quote).not.toHaveBeenCalled();
  });
  it("rejects missing authorization, unknown fields and missing permanent identity before creating a task", async () => {
    const { service, port } = setup();
    expect(await service.generate(id, id, { quoteId: "q" }, context)).toMatchObject({ status: 400 });
    expect(await service.generate(id, id, { quoteId: "q", budgetAuthorizationId: id, outcome: "success" }, context)).toMatchObject({ status: 400 });
    expect(await service.generate(id, id, { quoteId: "q", budgetAuthorizationId: id }, { ...context, idempotencyKey: undefined })).toMatchObject({ status: 400 });
    expect(port.generate).not.toHaveBeenCalled();
  });
  it("uses If-Match CAS for selection and never sends audio approval", async () => {
    const { service, store, port } = setup();
    store.select.mockResolvedValue({ rowVersion: 5, selection: { takeAssetId: id } });
    const body = { takeAssetId: id, expectedTakeChecksumSha256: "a".repeat(64) };
    expect(await service.select(id, id, body, '"4"', context)).toMatchObject({ status: 200, body: { rowVersion: 5 } });
    expect(store.select).toHaveBeenCalledExactlyOnceWith(id, id, id, body, 4, context);
    expect(port.generate).not.toHaveBeenCalled();
    expect(await service.select(id, id, body, undefined, context)).toMatchObject({ status: 400 });
  });
  it("reports numeric measured overflow and propagates storage failures instead of treating them as cache misses", async () => {
    const { service, store, port } = setup();
    store.mixPreflight.mockRejectedValue(new SpeechAudioOverflowError(1250));
    expect(await service.mixPreflight(id, { videoAssetId: id })).toMatchObject({ status: 422, body: { error: { code: "SPEECH_AUDIO_OVERFLOW", details: { overflowMs: 1250 } } } });
    store.generationInput.mockRejectedValue(new Error("EIO"));
    await expect(service.quote(id, id, {})).rejects.toThrow("EIO");
    expect(port.quote).not.toHaveBeenCalled();
    store.generationInput.mockRejectedValue(new PersistenceError("SPEECH_SOURCE_CHANGED", "changed"));
    expect(await service.quote(id, id, {})).toMatchObject({ status: 409, body: { error: { code: "SPEECH_SOURCE_CHANGED" } } });
  });
});
