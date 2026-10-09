// Cancel against submission, in both commit orders. In-memory store and controllable provider double; the PostgreSQL
// counterpart is in packages/database/src/title-writing-store.acceptance.spec.ts and runs only on an authorized database.
import { describe, expect, it } from "vitest";
import { TITLE_WRITING_CANCELED_BEFORE_SEND, type TitleCallSubmission } from "@ai-drama/contracts";
import { titleWritingProviderConfigs, type WritingTransport } from "./text-writing";
import { InMemoryTitleWritingStore, TitleWritingEngine, newTitleRun, titleRunView } from "./title-writing-engine";
import { fixtureChatTransport, type FixtureExchange } from "./title-writing-fixtures";

const WS = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222222";
const providers = () => titleWritingProviderConfigs({
  DASHSCOPE_API_KEY: "sk-test-secret-0123456789", BAILIAN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1", TITLE_WRITING_QWEN_MODELS: "q-1",
});
const record = () => newTitleRun({ workspaceId: WS, projectId: P1, actorId: "a", idempotencyKey: "k", title: "夜班证词",
  settings: { episodeCount: 3, episodeSeconds: 90, style: "" }, providerKey: "qwen", model: "q-1", now: new Date() });

/** Commits a cancel after the reservation and before the submission, as a concurrent request would. */
class CancelBetweenReserveAndSubmit extends InMemoryTitleWritingStore {
  override async markCallSubmitted(workspaceId: string, callId: string, executorId: string, nowIso: string, leaseUntil: string): Promise<TitleCallSubmission> {
    const call = this.calls.find((item) => item.id === callId)!;
    const run = this.runs.find((item) => item.id === call.runId)!;
    await this.requestCancel(run.workspaceId, run.projectId, run.id, nowIso);
    return super.markCallSubmitted(workspaceId, callId, executorId, nowIso, leaseUntil);
  }
}

describe("cancel and submission", () => {
  it("cancel committed first: the reservation is closed as never sent, nothing is sent, nothing stays reserved", async () => {
    const store = new CancelBetweenReserveAndSubmit();
    store.addProject(WS, P1);
    const seen: FixtureExchange[] = [];
    const engine = new TitleWritingEngine({ workspaceId: WS, store, providers: providers(), maxCallsPerDay: 30, transport: fixtureChatTransport("夜班证词", { seen }) });
    const run = record();
    await store.createRun(run, { maxActiveRuns: 1 });
    await engine.drive(run.id);
    expect(seen).toHaveLength(0);
    const view = titleRunView((await store.getRunById(WS, run.id))!);
    expect(view.state).toBe("canceled");
    expect(view.steps.map((step) => step.state)).toEqual(["canceled", "canceled", "canceled", "canceled", "canceled"]);
    expect(view.calls).toEqual([expect.objectContaining({ stepKey: "concept", state: "rejected", errorCode: TITLE_WRITING_CANCELED_BEFORE_SEND,
      billingStatus: "unknown", usage: { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null } })]);
    expect(store.calls.filter((call) => call.state === "reserved" || call.state === "submitted")).toHaveLength(0);
    // Nothing is left for recovery to treat as sent.
    expect(await store.recoverExpired(WS, new Date(Date.now() + 3_600_000).toISOString())).toBe(0);
  });

  it("submission committed first: the call is sent once and its real outcome is recorded, then the run stops", async () => {
    const store = new InMemoryTitleWritingStore();
    store.addProject(WS, P1);
    const seen: FixtureExchange[] = [];
    const run = record();
    const inner = fixtureChatTransport("夜班证词", { seen });
    // The cancel lands while the request is on the wire, after the submitted state was persisted.
    const transport: WritingTransport = async (request) => {
      expect(store.calls.at(-1)?.state).toBe("submitted");
      await store.requestCancel(WS, P1, run.id, new Date().toISOString());
      return inner(request);
    };
    const engine = new TitleWritingEngine({ workspaceId: WS, store, providers: providers(), maxCallsPerDay: 30, transport });
    await store.createRun(run, { maxActiveRuns: 1 });
    await engine.drive(run.id);
    expect(seen.map((item) => item.step)).toEqual(["concept"]);
    const view = titleRunView((await store.getRunById(WS, run.id))!);
    expect(view.state).toBe("canceled");
    expect(view.steps.map((step) => step.state)).toEqual(["completed", "canceled", "canceled", "canceled", "canceled"]);
    // The sent call is not described as free or revoked: its outcome and unknown billing stay on record.
    expect(view.calls).toEqual([expect.objectContaining({ stepKey: "concept", state: "completed", billingStatus: "unknown",
      usage: expect.objectContaining({ status: "present" }) })]);
  });

  it("a cancel that lands while a sent call times out keeps that call uncertain", async () => {
    const store = new InMemoryTitleWritingStore();
    store.addProject(WS, P1);
    const run = record();
    const transport: WritingTransport = async (request) => {
      await store.requestCancel(WS, P1, run.id, new Date().toISOString());
      return new Promise((_, reject) => { request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))); });
    };
    const engine = new TitleWritingEngine({ workspaceId: WS, store, providers: providers(), maxCallsPerDay: 30, transport, timeoutMs: 20 });
    await store.createRun(run, { maxActiveRuns: 1 });
    await engine.drive(run.id);
    const view = titleRunView((await store.getRunById(WS, run.id))!);
    expect(view.calls).toEqual([expect.objectContaining({ state: "unknown", errorCode: "timeout", billingStatus: "unknown" })]);
    expect(view.steps[0]).toMatchObject({ state: "unknown" });
  });
});
