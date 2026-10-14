import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { TitleRunKind } from "@ai-drama/contracts";
import { InMemoryTitleWritingStore, TitleWritingEngine, newTitleRun } from "./title-writing-engine";
import { newScriptBreakdownRun } from "./script-breakdown-run";
import { fixtureChatTransport, type FixtureExchange } from "./title-writing-fixtures";
import { titleWritingProviderConfigs } from "./text-writing";

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "22222222-2222-4222-8222-222222222222";
const TITLE = "夜班证词";
const providers = titleWritingProviderConfigs({ DASHSCOPE_API_KEY: "test-only-key", TITLE_WRITING_QWEN_MODELS: "q-1",
  BAILIAN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1" });

function setup(allowedRunKinds?: readonly TitleRunKind[]) {
  const store = new InMemoryTitleWritingStore();
  const seen: FixtureExchange[] = [];
  const engine = new TitleWritingEngine({ workspaceId: WS, store, providers, maxCallsPerDay: 100,
    transport: fixtureChatTransport(TITLE, { seen }), ...(allowedRunKinds === undefined ? {} : { allowedRunKinds }) });
  const claim = vi.spyOn(store, "claimRun");
  const reserve = vi.spyOn(store, "reserveCall");
  return { store, seen, engine, claim, reserve };
}

async function title(store: InMemoryTitleWritingStore, workspaceId = WS) {
  const projectId = randomUUID();
  store.addProject(workspaceId, projectId);
  const run = newTitleRun({ workspaceId, projectId, actorId: "owner", idempotencyKey: randomUUID(), title: TITLE,
    settings: { episodeCount: 3, episodeSeconds: 90, style: "" }, providerKey: "qwen", model: "q-1", now: new Date() });
  expect((await store.createRun(run, { maxActiveRuns: 10 })).kind).toBe("created");
  return run;
}

async function breakdown(store: InMemoryTitleWritingStore) {
  const projectId = randomUUID();
  const episode = store.addBreakdownEpisode({ workspaceId: WS, projectId, episodeNo: 1,
    text: "第 1 集\n场 1 便利店 夜\n林夏盯着监控。\n林夏：这不是我。" });
  const source = await store.breakdownSource(WS, projectId, episode.episodeId);
  if (source.kind !== "ok") throw new Error(source.kind);
  const run = newScriptBreakdownRun({ workspaceId: WS, projectId, actorId: "owner", idempotencyKey: randomUUID(),
    requestHash: "f".repeat(64), now: new Date(), input: {
      episodeId: episode.episodeId, episodeNo: 1, scriptRevisionId: source.scriptRevisionId, scriptRevisionNo: source.scriptRevisionNo,
      scriptContentHash: source.scriptContentHash, scriptText: (source.scriptContent as { text: string }).text,
      targetEpisodeSeconds: source.targetEpisodeSeconds, characters: [], replace: { scenes: [], shots: [] }, providerKey: "qwen", model: "q-1",
    } });
  expect((await store.createRun(run, { maxActiveRuns: 10 })).kind).toBe("created");
  return run;
}

describe("shared writing engine run-kind authorization", () => {
  it("refuses a disabled breakdown before claiming, reserving or sending, including maintenance", async () => {
    const { store, seen, engine, claim, reserve } = setup(["title"]);
    const run = await breakdown(store);
    const before = await store.getRunById(WS, run.id);
    await engine.drive(run.id);
    await engine.maintain();
    expect(claim).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
    expect(await store.getRunById(WS, run.id)).toEqual(before);
  });

  it("filters disabled runs before the maintenance limit so a later title still completes", async () => {
    const { store, seen, engine, claim, reserve } = setup(["title"]);
    const blocked = [];
    for (let index = 0; index < 6; index += 1) blocked.push(await breakdown(store));
    const allowed = await title(store);
    await engine.maintain(5);
    expect(seen.map((item) => item.step)).toEqual(["concept", "outline", "episode:1", "episode:2", "episode:3"]);
    expect(claim.mock.calls.map((args) => args[1])).toEqual([allowed.id]);
    expect(reserve.mock.calls.every(([call]) => call.runId === allowed.id)).toBe(true);
    expect((await store.getRunById(WS, allowed.id))!.run.state).toBe("completed");
    for (const run of blocked) expect((await store.getRunById(WS, run.id))!.run).toMatchObject({ executorId: null, callsUsed: 0, state: "running" });
  });

  it("an empty policy blocks both kinds, including direct execution", async () => {
    const { store, seen, engine, claim, reserve } = setup([]);
    const titleRun = await title(store);
    const breakdownRun = await breakdown(store);
    await engine.drive(titleRun.id);
    await engine.drive(breakdownRun.id);
    await engine.maintain();
    expect(claim).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it("an omitted policy preserves execution of both kinds", async () => {
    const { store, seen, engine } = setup();
    const breakdownRun = await breakdown(store);
    const titleRun = await title(store);
    await engine.maintain();
    expect(seen).toHaveLength(6);
    expect((await store.getRunById(WS, breakdownRun.id))!.run.state).toBe("completed");
    expect((await store.getRunById(WS, titleRun.id))!.run.state).toBe("completed");
  });

  it("an allowed kind still cannot execute another workspace's run", async () => {
    const { store, seen, engine, claim, reserve } = setup(["title"]);
    const run = await title(store, OTHER_WS);
    const before = await store.getRunById(OTHER_WS, run.id);
    await engine.drive(run.id);
    await engine.maintain();
    expect(claim).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
    expect(await store.getRunById(OTHER_WS, run.id)).toEqual(before);
  });
});
