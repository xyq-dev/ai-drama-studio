// Resume confirmation and resume idempotency. In-memory store and controllable provider double; the PostgreSQL
// counterpart is in packages/database/src/title-writing-store.acceptance.spec.ts and runs only on an authorized database.
import { describe, expect, it } from "vitest";
import type { TitleResumePreparation } from "@ai-drama/contracts";
import { titleWritingProviderConfigs, type WritingTransport } from "./text-writing";
import {
  InMemoryTitleWritingStore,
  TitleWritingEngine,
  hashTitleResume,
  newTitleRun,
  titleRunView,
  uncertainCallIdsOf,
} from "./title-writing-engine";
import { fixtureChatTransport, type FixtureExchange, type FixtureStep } from "./title-writing-fixtures";

const WS = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222222";

function setup(override?: (step: FixtureStep, attempt: number) => "hang" | { status: number; body: unknown } | undefined, transport?: WritingTransport) {
  const store = new InMemoryTitleWritingStore();
  store.addProject(WS, P1);
  const seen: FixtureExchange[] = [];
  const providers = titleWritingProviderConfigs({
    DASHSCOPE_API_KEY: "sk-test-secret-0123456789", BAILIAN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1", TITLE_WRITING_QWEN_MODELS: "q-1",
  });
  const engine = new TitleWritingEngine({ workspaceId: WS, store, providers, maxCallsPerDay: 30, timeoutMs: 20,
    transport: transport ?? fixtureChatTransport("夜班证词", { seen, ...(override ? { override } : {}) }) });
  const run = newTitleRun({ workspaceId: WS, projectId: P1, actorId: "a", idempotencyKey: "k", title: "夜班证词",
    settings: { episodeCount: 3, episodeSeconds: 90, style: "" }, providerKey: "qwen", model: "q-1", now: new Date() });
  return { store, engine, seen, run };
}

function resume(store: InMemoryTitleWritingStore, runId: string, key: string, confirmed: readonly string[]): Promise<TitleResumePreparation> {
  return store.prepareResume(WS, P1, runId, { resumeKey: key, requestHash: hashTitleResume(runId, confirmed), confirmedCallIds: confirmed,
    maxActiveRuns: 1 }, new Date().toISOString());
}

async function uncertain(store: InMemoryTitleWritingStore, runId: string): Promise<string[]> {
  const bundle = (await store.getRunById(WS, runId))!;
  return uncertainCallIdsOf(bundle.steps, bundle.calls);
}

describe("resume after an uncertain call", () => {
  it("an old confirmation cannot authorize a newer uncertain attempt, and replaying the accepted action sends nothing", async () => {
    // The concept times out twice, then answers.
    const { store, engine, seen, run } = setup((step, attempt) => step === "concept" && attempt <= 2 ? "hang" : undefined);
    await store.createRun(run, { maxActiveRuns: 1 });
    await engine.drive(run.id);
    const first = await uncertain(store, run.id);
    expect(first).toHaveLength(1);
    expect(await resume(store, run.id, "resume-1", first)).toMatchObject({ kind: "ok" });
    await engine.drive(run.id);
    expect(seen).toHaveLength(2);
    const second = await uncertain(store, run.id);
    expect(second).toHaveLength(1);
    expect(second).not.toEqual(first);

    // The same action again (lost receipt): the current run comes back, nothing is reset, nothing is sent.
    const replay = await resume(store, run.id, "resume-1", first);
    expect(replay.kind).toBe("replayed");
    await engine.drive(run.id);
    expect(seen).toHaveLength(2);
    expect((await store.getRunById(WS, run.id))!.run.state).toBe("needs_attention");
    expect((await store.getRunById(WS, run.id))!.steps[0]).toMatchObject({ state: "unknown", attemptNo: 2 });

    // A new action carrying the old confirmation is stale; so is an empty one asked to resend.
    expect(await resume(store, run.id, "resume-2", first)).toEqual({ kind: "stale_confirmation" });
    expect(await resume(store, run.id, "resume-3", [])).toEqual({ kind: "needs_confirmation" });
    expect(seen).toHaveLength(2);

    // A fresh confirmation of what is uncertain now continues.
    expect(await resume(store, run.id, "resume-4", second)).toMatchObject({ kind: "ok" });
    await engine.drive(run.id);
    const view = titleRunView((await store.getRunById(WS, run.id))!);
    expect(view.state).toBe("completed");
    expect(seen.map((item) => item.step)).toEqual(["concept", "concept", "concept", "outline", "episode:1", "episode:2", "episode:3"]);
    // Uncertain calls stay uncertain with unknown billing; none is rewritten as free.
    expect(view.calls.filter((call) => call.stepKey === "concept").map((call) => [call.state, call.billingStatus, call.usage.status]))
      .toEqual([["unknown", "unknown", "unknown"], ["unknown", "unknown", "unknown"], ["completed", "unknown", "present"]]);
  });

  it("concurrent requests of one resume action apply it once", async () => {
    const { store, engine, seen, run } = setup((step, attempt) => step === "outline" && attempt === 1 ? "hang" : undefined);
    await store.createRun(run, { maxActiveRuns: 1 });
    await engine.drive(run.id);
    const ids = await uncertain(store, run.id);
    const results = await Promise.all([resume(store, run.id, "same", ids), resume(store, run.id, "same", ids), resume(store, run.id, "same", ids)]);
    expect(results.map((result) => result.kind).sort()).toEqual(["ok", "replayed", "replayed"]);
    expect(store.resumes).toHaveLength(1);
    await Promise.all([engine.drive(run.id), engine.drive(run.id)]);
    expect(seen.map((item) => item.step)).toEqual(["concept", "outline", "outline", "episode:1", "episode:2", "episode:3"]);
  });

  it("one resume key cannot carry a different confirmation", async () => {
    const { store, engine, run } = setup((step, attempt) => step === "concept" && attempt === 1 ? "hang" : undefined);
    await store.createRun(run, { maxActiveRuns: 1 });
    await engine.drive(run.id);
    const ids = await uncertain(store, run.id);
    expect(await resume(store, run.id, "k1", [])).toEqual({ kind: "needs_confirmation" });
    expect(await resume(store, run.id, "k1", ids)).toMatchObject({ kind: "ok" });
    expect(await resume(store, run.id, "k1", [])).toEqual({ kind: "key_conflict" });
  });

  it("a rejected step resumes without confirmation; an old confirmation on it is stale", async () => {
    const { store, engine, run } = setup((step, attempt) => step === "outline" && attempt === 1 ? { status: 401, body: {} } : undefined);
    await store.createRun(run, { maxActiveRuns: 1 });
    await engine.drive(run.id);
    expect(await resume(store, run.id, "k1", ["44444444-4444-4444-8444-444444444444"])).toEqual({ kind: "stale_confirmation" });
    expect(await resume(store, run.id, "k2", [])).toMatchObject({ kind: "ok" });
  });

  it("a canceled run that still holds an uncertain call needs a confirmation of that call", async () => {
    let cancel: (() => Promise<void>) | null = null;
    const inner = fixtureChatTransport("夜班证词");
    const transport: WritingTransport = async (request) => {
      const body = JSON.parse(request.body) as { messages: Array<{ role: string; content: string }> };
      if (body.messages.some((message) => message.content.includes("写分集大纲")) && cancel) {
        await cancel();
        return new Promise((_, reject) => { request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))); });
      }
      return inner(request);
    };
    const { store, engine, run } = setup(undefined, transport);
    await store.createRun(run, { maxActiveRuns: 1 });
    cancel = async () => { cancel = null; await store.requestCancel(WS, P1, run.id, new Date().toISOString()); };
    await engine.drive(run.id);
    const stopped = titleRunView((await store.getRunById(WS, run.id))!);
    expect(stopped.state).toBe("canceled");
    expect(stopped.steps.map((step) => step.state)).toEqual(["completed", "unknown", "canceled", "canceled", "canceled"]);
    expect(await resume(store, run.id, "k1", [])).toEqual({ kind: "needs_confirmation" });
    expect(await resume(store, run.id, "k2", await uncertain(store, run.id))).toMatchObject({ kind: "ok" });
    await engine.drive(run.id);
    const view = titleRunView((await store.getRunById(WS, run.id))!);
    expect(view.state).toBe("completed");
    // The completed concept was not called again.
    expect(view.calls.filter((call) => call.stepKey === "concept")).toHaveLength(1);
  });
});
