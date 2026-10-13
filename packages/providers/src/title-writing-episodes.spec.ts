import { describe, expect, it } from "vitest";
import { TITLE_WRITING_INPUT_SCHEMA_V2, type TitleWritingProviderKey } from "@ai-drama/contracts";
import { titleWritingProviderConfigs, type WritingProviderConfig, type WritingTransport } from "./text-writing";
import { InMemoryTitleWritingStore, TitleWritingEngine, initialSteps, newTitleRun, titleRunView } from "./title-writing-engine";
import { fixtureChatTransport, type FixtureExchange } from "./title-writing-fixtures";

/** The run engine with v2 inputs: the same lease, fencing and recovery rules, for exactly N episodes. */
const WS = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222222";
const TITLE = "夜班证词";

function providers(): Record<TitleWritingProviderKey, WritingProviderConfig> {
  return titleWritingProviderConfigs({
    DASHSCOPE_API_KEY: "sk-test-secret-0123456789", BAILIAN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1", TITLE_WRITING_QWEN_MODELS: "q-1",
  });
}

const v2Run = (episodeCount: number, now: Date) => newTitleRun({ workspaceId: WS, projectId: P1, actorId: "a", idempotencyKey: "k", title: TITLE,
  settings: { episodeCount, episodeSeconds: 60, style: "" }, providerKey: "qwen", model: "q-1", now, version: 2 });

describe("v2 runs in the engine", () => {
  it("freeze the v2 input, N+2 steps and the cap N+5; the view reports version 2 and N", () => {
    const record = v2Run(6, new Date());
    expect(record.input.schema).toBe(TITLE_WRITING_INPUT_SCHEMA_V2);
    expect(record.callCap).toBe(11);
    expect(initialSteps(record).map((step) => [step.stepKey, step.ordinal, step.scriptSave])).toEqual([
      ["concept", 0, null], ["outline", 1, null],
      ...Array.from({ length: 6 }, (_, index) => [`episode:${String(index + 1)}`, index + 2, "pending"]),
    ]);
    const view = titleRunView({ run: record, steps: initialSteps(record), calls: [] });
    expect([view.inputVersion, view.episodeCount]).toEqual([2, 6]);
  });

  it("a fenced executor's late answer for episode 4 cannot overwrite recovery, and nothing after it is sent", async () => {
    let now = Date.parse("2026-10-11T00:00:00Z");
    const clock = () => new Date(now);
    const store = new InMemoryTitleWritingStore();
    store.addProject(WS, P1, 5);
    const record = v2Run(5, clock());
    await store.createRun(record, { maxActiveRuns: 1 });
    const seen: FixtureExchange[] = [];
    const inner = fixtureChatTransport(TITLE, { seen });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let parked = false;
    const transport: WritingTransport = async (request) => {
      const answer = await inner(request);
      if (seen.at(-1)?.step === "episode:4") { parked = true; await gate; }
      return answer;
    };
    const engine = new TitleWritingEngine({ workspaceId: WS, store, providers: providers(), transport, maxCallsPerDay: 30, clock, leaseMs: 1000 });
    const driving = engine.drive(record.id);
    while (!parked) await new Promise((resolve) => setTimeout(resolve, 1));
    now += 5000;
    expect(await store.recoverExpired(WS, clock().toISOString())).toBe(1);
    release();
    await driving;
    const view = titleRunView((await store.getRunById(WS, record.id))!);
    expect(view.state).toBe("needs_attention");
    expect(view.steps.map((step) => step.state)).toEqual(["completed", "completed", "completed", "completed", "completed", "unknown", "pending"]);
    expect(view.steps[5]).toMatchObject({ stepKey: "episode:4", output: null, errorCode: "executor_lost" });
    expect(seen.map((item) => item.step)).toEqual(["concept", "outline", "episode:1", "episode:2", "episode:3", "episode:4"]);
    // A later maintenance pass never resends the uncertain step without a person's confirmation.
    now += 5000;
    await engine.maintain();
    expect(seen).toHaveLength(6);
  });
});
