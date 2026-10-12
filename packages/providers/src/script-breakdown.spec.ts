import { describe, expect, it } from "vitest";
import {
  SCRIPT_BREAKDOWN_CALL_CAP,
  type ScriptBreakdownOutput,
  type TitleWritingProviderKey,
} from "@ai-drama/contracts";
import { titleWritingProviderConfigs, type WritingProviderConfig, type WritingTransport } from "./text-writing";
import { InMemoryTitleWritingStore, TitleWritingEngine, initialSteps, type MemoryBreakdownEpisode } from "./title-writing-engine";
import { hashScriptBreakdownRequest, newScriptBreakdownRun, scriptBreakdownRunView } from "./script-breakdown-run";
import { chatAnswer, fixtureChatTransport, type FixtureExchange } from "./title-writing-fixtures";
import { breakdownPromptParts, fixtureBreakdown } from "./script-breakdown-fixtures";

const WS = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222222";

function providers(): Record<TitleWritingProviderKey, WritingProviderConfig> {
  return titleWritingProviderConfigs({
    DASHSCOPE_API_KEY: "sk-test-secret-0123456789", BAILIAN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1", TITLE_WRITING_QWEN_MODELS: "q-1",
  });
}

function scriptOf(episodeNo: number, scenes: number): string {
  const lines = [`第 ${String(episodeNo)} 集`];
  for (let scene = 1; scene <= scenes; scene += 1) {
    lines.push(`场 ${String(scene)} 地点${String(episodeNo)}-${String(scene)} 夜`, `林夏在第 ${String(episodeNo)} 集第 ${String(scene)} 场停下。`, `林夏：第 ${String(episodeNo)} 集第 ${String(scene)} 句。`);
  }
  return lines.join("\n");
}

/** What the API service does at start, against the memory store: freeze the current source, then create the run. */
async function start(store: InMemoryTitleWritingStore, episode: MemoryBreakdownEpisode, options: { key?: string; now?: Date; replaceExisting?: boolean } = {}) {
  const source = await store.breakdownSource(WS, P1, episode.episodeId);
  if (source.kind !== "ok") throw new Error(source.kind);
  const record = newScriptBreakdownRun({
    workspaceId: WS, projectId: P1, actorId: "owner", idempotencyKey: options.key ?? `k-${episode.episodeId}`,
    requestHash: hashScriptBreakdownRequest(P1, { episodeId: episode.episodeId, providerKey: "qwen", model: "q-1", replaceExisting: options.replaceExisting ?? false }),
    now: options.now ?? new Date(),
    input: {
      episodeId: episode.episodeId, episodeNo: source.episodeNo, scriptRevisionId: source.scriptRevisionId,
      scriptRevisionNo: source.scriptRevisionNo, scriptContentHash: source.scriptContentHash,
      scriptText: (source.scriptContent as { text: string }).text, targetEpisodeSeconds: source.targetEpisodeSeconds,
      characters: source.characters.map((item, index) => ({ key: `C${String(index + 1)}`, ...item })),
      replace: { scenes: source.scenes, shots: source.shots }, providerKey: "qwen", model: "q-1",
    },
  });
  const created = await store.createRun(record, { maxActiveRuns: 1, quota: { sinceIso: "2000-01-01T00:00:00.000Z", maxCallsPerDay: 30, requiredCalls: 1 } });
  if (created.kind !== "created") throw new Error(created.kind);
  return record;
}

function engineFor(store: InMemoryTitleWritingStore, transport: WritingTransport, extra: { clock?: () => Date; leaseMs?: number } = {}) {
  return new TitleWritingEngine({ workspaceId: WS, store, providers: providers(), transport, maxCallsPerDay: 30, ...extra });
}

async function view(store: InMemoryTitleWritingStore, runId: string) {
  const bundle = (await store.getRunById(WS, runId))!;
  return scriptBreakdownRunView(bundle, await store.breakdownDetails(WS, bundle.run));
}

function liveScenes(store: InMemoryTitleWritingStore, episode: MemoryBreakdownEpisode) {
  return store.scenes.filter((scene) => scene.episodeId === episode.episodeId && !scene.archived);
}

describe("script breakdown runs", () => {
  it("have one breakdown step, three calls at most and a request hash that leaves the frozen source out", () => {
    const store = new InMemoryTitleWritingStore();
    const episode = store.addBreakdownEpisode({ workspaceId: WS, projectId: P1, episodeNo: 1, text: scriptOf(1, 2) });
    const record = newScriptBreakdownRun({ workspaceId: WS, projectId: P1, actorId: "a", idempotencyKey: "k", requestHash: "f".repeat(64), now: new Date(),
      input: { episodeId: episode.episodeId, episodeNo: 1, scriptRevisionId: episode.currentScriptId!, scriptRevisionNo: 1, scriptContentHash: "0".repeat(64),
        scriptText: "x", targetEpisodeSeconds: null, characters: [], replace: { scenes: [], shots: [] }, providerKey: "qwen", model: "q-1" } });
    expect(record.callCap).toBe(SCRIPT_BREAKDOWN_CALL_CAP);
    expect(record.breakdownSave).toBe("pending");
    expect(initialSteps(record).map((step) => [step.stepKey, step.ordinal, step.scriptSave])).toEqual([["breakdown", 0, null]]);
    const a = hashScriptBreakdownRequest(P1, { episodeId: episode.episodeId, providerKey: "qwen", model: "q-1", replaceExisting: false });
    expect(hashScriptBreakdownRequest(P1, { episodeId: episode.episodeId, providerKey: "qwen", model: "q-1", replaceExisting: true })).not.toBe(a);
  });

  for (const count of [1, 3, 6]) {
    it(`in a ${String(count)}-episode work break down only the chosen episode, from its own script`, async () => {
      const store = new InMemoryTitleWritingStore();
      const episodes = Array.from({ length: count }, (_, index) =>
        store.addBreakdownEpisode({ workspaceId: WS, projectId: P1, episodeNo: index + 1, text: scriptOf(index + 1, index + 1), targetEpisodeSeconds: 60 }));
      const chosen = episodes[count - 1]!;
      const seen: FixtureExchange[] = [];
      const record = await start(store, chosen);
      await engineFor(store, fixtureChatTransport("t", { seen })).drive(record.id);
      const result = await view(store, record.id);
      expect(result.state).toBe("completed");
      expect(result.save).toBe("saved");
      expect(seen).toHaveLength(1);
      expect(breakdownPromptParts(seen[0]!.user)).toMatchObject({ episodeNo: count, script: scriptOf(count, count) });
      // Scene count follows the script: episode N has N scenes, each with its own two shots.
      expect(result.output!.scenes).toHaveLength(count);
      expect(result.output!.shots).toHaveLength(count * 2);
      expect(result.output!.scenes.map((scene) => scene.heading)).toEqual(Array.from({ length: count }, (_, index) => `地点${String(count)}-${String(index + 1)} 夜`));
      expect(liveScenes(store, chosen)).toHaveLength(count);
      for (const other of episodes.slice(0, -1)) expect(liveScenes(store, other)).toHaveLength(0);
      expect(result.scenes.map((scene) => [scene.key, scene.ordinal, scene.shotSave])).toEqual(
        Array.from({ length: count }, (_, index) => [`S${String(index + 1)}`, index + 1, "pending"]));
      // Draft scenes only: nothing is reviewed and no shot exists until a person approves a scene.
      expect(liveScenes(store, chosen).every((scene) => scene.approvedRevisionId === null)).toBe(true);
      expect(store.shots).toHaveLength(0);
    });
  }

  it("send the script frozen at start; a script saved while the call is out keeps the result out of the episode (source_changed)", async () => {
    const store = new InMemoryTitleWritingStore();
    const episode = store.addBreakdownEpisode({ workspaceId: WS, projectId: P1, episodeNo: 2, text: scriptOf(2, 2) });
    const record = await start(store, episode);
    const seen: FixtureExchange[] = [];
    const inner = fixtureChatTransport("t", { seen });
    // The reservation found the frozen script current; the newer script is saved after the send, before the answer.
    const transport: WritingTransport = async (request) => {
      store.writeScript(episode.episodeId, scriptOf(2, 5));
      return inner(request);
    };
    await engineFor(store, transport).drive(record.id);
    expect(seen).toHaveLength(1);
    expect(breakdownPromptParts(seen[0]!.user).script).toBe(scriptOf(2, 2));
    const result = await view(store, record.id);
    expect([result.state, result.errorCode, result.save]).toEqual(["needs_attention", "breakdown_source_changed", "source_changed"]);
    expect(result.output!.scenes).toHaveLength(2);
    expect(liveScenes(store, episode)).toHaveLength(0);
    expect(result.episodeScript).toMatchObject({ currentRevisionNo: 2, approved: true });
    expect(result.scriptRevisionNo).toBe(1);
  });

  it("send nothing when a script was saved after the start and before the call is reserved (breakdown_source_changed)", async () => {
    const store = new InMemoryTitleWritingStore();
    const episode = store.addBreakdownEpisode({ workspaceId: WS, projectId: P1, episodeNo: 2, text: scriptOf(2, 2) });
    const record = await start(store, episode);
    store.writeScript(episode.episodeId, scriptOf(2, 5));
    const seen: FixtureExchange[] = [];
    await engineFor(store, fixtureChatTransport("t", { seen })).drive(record.id);
    const result = await view(store, record.id);
    expect([result.state, result.errorCode, result.save, result.callsUsed, result.output]).toEqual(["needs_attention", "breakdown_source_changed", "pending", 0, null]);
    expect([seen.length, store.calls.length, liveScenes(store, episode).length]).toEqual([0, 0, 0]);
    expect(result.scriptRevisionNo).toBe(1);
  });

  it("never overwrite a person's scene edit made while the call was out (conflict); the old scene stays current", async () => {
    const store = new InMemoryTitleWritingStore();
    const episode = store.addBreakdownEpisode({ workspaceId: WS, projectId: P1, episodeNo: 1, text: scriptOf(1, 3) });
    const manual = store.addManualScene(episode.episodeId, "人工场景");
    const record = await start(store, episode, { replaceExisting: true });
    const inner = fixtureChatTransport("t");
    const transport: WritingTransport = async (request) => {
      store.editScene(manual.sceneId, "人工改过的描述");
      return inner(request);
    };
    await engineFor(store, transport).drive(record.id);
    const result = await view(store, record.id);
    expect([result.state, result.errorCode, result.save]).toEqual(["needs_attention", "breakdown_conflict", "conflict"]);
    expect(liveScenes(store, episode).map((scene) => scene.sceneId)).toEqual([manual.sceneId]);
    expect(manual.revisions.at(-1)!.summary).toBe("人工改过的描述");
  });

  it("replace the frozen scenes and shots when nothing changed: old ones are archived, never deleted", async () => {
    const store = new InMemoryTitleWritingStore();
    const episode = store.addBreakdownEpisode({ workspaceId: WS, projectId: P1, episodeNo: 1, text: scriptOf(1, 2) });
    const manual = store.addManualScene(episode.episodeId, "模板场景");
    const record = await start(store, episode, { replaceExisting: true });
    await engineFor(store, fixtureChatTransport("t")).drive(record.id);
    expect((await view(store, record.id)).save).toBe("saved");
    expect(store.scenes.find((scene) => scene.sceneId === manual.sceneId)).toMatchObject({ archived: true });
    expect(liveScenes(store, episode)).toHaveLength(2);
  });

  const bad: Array<[string, (output: ScriptBreakdownOutput) => unknown, string]> = [
    ["invalid JSON", () => "{\"schema\":", "invalid_json"],
    ["a wrong episode number", (output) => ({ ...output, episodeNo: 5 }), "episode_mismatch"],
    ["a duplicate scene key", (output) => ({ ...output, scenes: [output.scenes[0], { ...output.scenes[1], key: "S1" }] }), "duplicate_key"],
    ["a shot of an unknown scene", (output) => ({ ...output, shots: [...output.shots.slice(0, -1), { ...output.shots.at(-1), sceneKey: "S8" }] }), "missing_reference"],
    ["an invented line", (output) => ({ ...output, shots: output.shots.map((shot) => shot.dialogue.length > 0 ? { ...shot, dialogue: [{ speaker: "林夏", line: "没写过的台词" }] } : shot) }), "dialogue_not_in_script"],
  ];
  for (const [name, mutate, code] of bad) {
    it(`fail on ${name} with ${code}: one call, nothing written, no template, no automatic resend`, async () => {
      const store = new InMemoryTitleWritingStore();
      const episode = store.addBreakdownEpisode({ workspaceId: WS, projectId: P1, episodeNo: 1, text: scriptOf(1, 2) });
      const record = await start(store, episode);
      const seen: FixtureExchange[] = [];
      const answer = mutate(fixtureBreakdown(1, scriptOf(1, 2)));
      await engineFor(store, fixtureChatTransport("t", { seen, override: () => ({ status: 200, body: chatAnswer(answer) }) })).drive(record.id);
      const result = await view(store, record.id);
      expect([result.state, result.step.state, result.step.errorCode, result.save]).toEqual(["failed", "rejected", code, "pending"]);
      expect(result.output).toBeNull();
      expect(seen).toHaveLength(1);
      expect(liveScenes(store, episode)).toHaveLength(0);
    });
  }

  it("fail on a truncated answer without continuing it", async () => {
    const store = new InMemoryTitleWritingStore();
    const episode = store.addBreakdownEpisode({ workspaceId: WS, projectId: P1, episodeNo: 1, text: scriptOf(1, 2) });
    const record = await start(store, episode);
    const seen: FixtureExchange[] = [];
    const truncated = JSON.stringify(fixtureBreakdown(1, scriptOf(1, 2))).slice(0, 80);
    await engineFor(store, fixtureChatTransport("t", { seen, override: () => ({ status: 200, body: chatAnswer(truncated, "length") }) })).drive(record.id);
    const result = await view(store, record.id);
    expect([result.state, result.step.errorCode]).toEqual(["failed", "truncated"]);
    expect(seen).toHaveLength(1);
  });

  it("stop on an unknown outcome; maintenance never resends; resume needs the person's confirmation of that call", async () => {
    const store = new InMemoryTitleWritingStore();
    const episode = store.addBreakdownEpisode({ workspaceId: WS, projectId: P1, episodeNo: 1, text: scriptOf(1, 2) });
    const record = await start(store, episode);
    const seen: FixtureExchange[] = [];
    const engine = engineFor(store, fixtureChatTransport("t", { seen, override: (_step, attempt) => attempt === 1 ? "throw" : undefined }));
    await engine.drive(record.id);
    let result = await view(store, record.id);
    expect([result.state, result.step.state]).toEqual(["needs_attention", "unknown"]);
    await engine.maintain();
    expect(seen).toHaveLength(1);
    const uncertain = result.calls.filter((call) => call.state === "unknown").map((call) => call.callId);
    expect(await store.prepareResume(WS, P1, record.id, { resumeKey: "r1", requestHash: "a".repeat(64), confirmedCallIds: [], maxActiveRuns: 1 }, new Date().toISOString()))
      .toEqual({ kind: "needs_confirmation" });
    expect((await store.prepareResume(WS, P1, record.id, { resumeKey: "r2", requestHash: "b".repeat(64), confirmedCallIds: uncertain, maxActiveRuns: 1 }, new Date().toISOString())).kind).toBe("ok");
    await engine.drive(record.id);
    result = await view(store, record.id);
    expect([result.state, result.save, result.callsUsed]).toEqual(["completed", "saved", 2]);
    expect(seen).toHaveLength(2);
  });

  it("send nothing when cancelled before sending", async () => {
    const store = new InMemoryTitleWritingStore();
    const episode = store.addBreakdownEpisode({ workspaceId: WS, projectId: P1, episodeNo: 1, text: scriptOf(1, 2) });
    const record = await start(store, episode);
    await store.requestCancel(WS, P1, record.id, new Date().toISOString());
    const seen: FixtureExchange[] = [];
    await engineFor(store, fixtureChatTransport("t", { seen })).drive(record.id);
    expect((await view(store, record.id)).state).toBe("canceled");
    expect(seen).toHaveLength(0);
  });

  it("drop a fenced executor's late answer: recovery recorded it as unknown and nothing is saved", async () => {
    let now = Date.parse("2026-10-12T00:00:00Z");
    const clock = () => new Date(now);
    const store = new InMemoryTitleWritingStore();
    const episode = store.addBreakdownEpisode({ workspaceId: WS, projectId: P1, episodeNo: 1, text: scriptOf(1, 2) });
    const record = await start(store, episode, { now: clock() });
    const inner = fixtureChatTransport("t");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let parked = false;
    const transport: WritingTransport = async (request) => {
      const answer = await inner(request);
      parked = true;
      await gate;
      return answer;
    };
    const driving = engineFor(store, transport, { clock, leaseMs: 1000 }).drive(record.id);
    while (!parked) await new Promise((resolve) => setTimeout(resolve, 1));
    now += 5000;
    expect(await store.recoverExpired(WS, clock().toISOString())).toBe(1);
    release();
    await driving;
    const result = await view(store, record.id);
    expect([result.state, result.step.state, result.save]).toEqual(["needs_attention", "unknown", "pending"]);
    expect(liveScenes(store, episode)).toHaveLength(0);
  });

  it("are not a project's latest title run", async () => {
    const store = new InMemoryTitleWritingStore();
    const episode = store.addBreakdownEpisode({ workspaceId: WS, projectId: P1, episodeNo: 1, text: scriptOf(1, 1) });
    await start(store, episode);
    expect(await store.latestRun(WS, P1)).toBeNull();
    expect(await store.latestBreakdown(WS, P1, episode.episodeId)).not.toBeNull();
  });
});

describe("writing proposed shots", () => {
  async function saved(characters = false) {
    const store = new InMemoryTitleWritingStore();
    if (characters) store.addCharacter(P1, "林夏");
    const episode = store.addBreakdownEpisode({ workspaceId: WS, projectId: P1, episodeNo: 1, text: scriptOf(1, 2) });
    const record = await start(store, episode);
    await engineFor(store, fixtureChatTransport("t")).drive(record.id);
    return { store, episode, record };
  }

  it.each((["scene_edit", "scene_added", "scene_archived", "shot_edit", "shot_added", "shot_archived"] as const)
    .flatMap((change) => [false, true].map((resume) => ({ change, resume }))))(
    "does not reserve or resume after frozen $change changes (resume=$resume)",
    async ({ change, resume }) => {
      const { store, episode, record: savedRun } = await saved();
      for (const scene of liveScenes(store, episode)) store.approveScene(scene.sceneId);
      await store.placeBreakdownShots(WS, P1, episode.episodeId, savedRun.id,
        { acceptSceneChanged: false }, "owner", new Date().toISOString());
      const run = await start(store, episode, { key: "replacement", replaceExisting: true });
      if (resume) await engineFor(store, fixtureChatTransport("t", { override: () => ({ status: 200, body: chatAnswer("not json") }) })).drive(run.id);
      const beforeCalls = structuredClone(store.calls);
      const beforeResumes = structuredClone(store.resumes);
      const beforeCallsUsed = (await store.getRunById(WS, run.id))!.run.callsUsed;
      const scene = liveScenes(store, episode)[0]!;
      const shot = store.shots.find((item) => item.sceneId === scene.sceneId)!;
      if (change === "scene_edit") store.editScene(scene.sceneId, "人工修改");
      if (change === "scene_added") store.addManualScene(episode.episodeId, "新增场景");
      if (change === "scene_archived") scene.archived = true;
      if (change === "shot_edit") shot.rowVersion += 1;
      if (change === "shot_added") store.shots.push({ ...structuredClone(shot), shotId: "new-manual-shot" });
      if (change === "shot_archived") shot.archived = true;
      const beforeScenes = structuredClone(store.scenes);
      const beforeShots = structuredClone(store.shots);
      const seen: FixtureExchange[] = [];
      if (resume) {
        expect(await store.prepareResume(WS, P1, run.id, { resumeKey: "conflicting-resume", requestHash: "a".repeat(64),
          confirmedCallIds: [], maxActiveRuns: 1 }, new Date().toISOString())).toEqual({ kind: "conflict" });
      } else {
        await engineFor(store, fixtureChatTransport("t", { seen })).drive(run.id);
        expect(await view(store, run.id)).toMatchObject({ state: "needs_attention", errorCode: "breakdown_conflict", save: "pending" });
      }
      expect(seen).toHaveLength(0);
      expect(store.calls).toEqual(beforeCalls);
      expect(store.resumes).toEqual(beforeResumes);
      expect((await store.getRunById(WS, run.id))!.run.callsUsed).toBe(beforeCallsUsed);
      expect(store.scenes).toEqual(beforeScenes);
      expect(store.shots).toEqual(beforeShots);
    },
  );

  it("rechecks the frozen scene set again after a successful resume and before reservation", async () => {
    const { store, episode } = await saved();
    const run = await start(store, episode, { key: "replacement", replaceExisting: true });
    await engineFor(store, fixtureChatTransport("t", { override: () => ({ status: 200, body: chatAnswer("not json") }) })).drive(run.id);
    expect((await store.prepareResume(WS, P1, run.id, { resumeKey: "accepted-resume", requestHash: "a".repeat(64),
      confirmedCallIds: [], maxActiveRuns: 1 }, new Date().toISOString())).kind).toBe("ok");
    const callsBefore = structuredClone(store.calls);
    store.editScene(liveScenes(store, episode)[0]!.sceneId, "续跑后人工修改");
    const seen: FixtureExchange[] = [];
    await engineFor(store, fixtureChatTransport("t", { seen })).drive(run.id);
    expect(await view(store, run.id)).toMatchObject({ state: "needs_attention", errorCode: "breakdown_conflict", save: "pending" });
    expect(store.calls).toEqual(callsBefore);
    expect(seen).toHaveLength(0);
  });

  it("blocks pending placement during another running breakdown of the same episode, allowing stopped and other-episode runs", async () => {
    const { store, episode, record } = await saved();
    for (const scene of liveScenes(store, episode)) store.approveScene(scene.sceneId);
    const later = await start(store, episode, { key: "replacement", replaceExisting: true });
    const place = () => store.placeBreakdownShots(WS, P1, episode.episodeId, record.id,
      { acceptSceneChanged: false }, "owner", new Date().toISOString());
    expect(await place()).toEqual({ kind: "active" });
    expect(store.shots).toHaveLength(0);
    store.runs.find((run) => run.id === later.id)!.state = "canceled";
    const otherEpisode = store.addBreakdownEpisode({ workspaceId: WS, projectId: P1, episodeNo: 2, text: scriptOf(2, 1) });
    await start(store, otherEpisode, { key: "other-episode" });
    expect(await place()).toMatchObject({ kind: "ok", outcome: { placed: ["S1", "S2"] } });
    const shotsBefore = structuredClone(store.shots);
    store.runs.find((run) => run.id === later.id)!.state = "running";
    expect(await place()).toMatchObject({ kind: "ok", outcome: { placed: [] } });
    expect(store.shots).toEqual(shotsBefore);
  });

  it("waits for a person's scene approval, then writes each approved scene's shots once, with the plan kept apart", async () => {
    const { store, episode, record } = await saved(true);
    const place = (accept = false) => store.placeBreakdownShots(WS, P1, episode.episodeId, record.id, { acceptSceneChanged: accept }, "owner", new Date().toISOString());
    let placed = await place();
    expect(placed).toMatchObject({ kind: "ok", outcome: { placed: [], awaitingApproval: ["S1", "S2"] } });
    expect(store.shots).toHaveLength(0);
    const [first, second] = liveScenes(store, episode);
    store.approveScene(first!.sceneId);
    placed = await place();
    expect(placed).toMatchObject({ kind: "ok", outcome: { placed: ["S1"], awaitingApproval: ["S2"] } });
    expect(store.shots.map((shot) => [shot.sceneId, shot.ordinal, shot.plannedDurationMs, shot.dialogue])).toEqual([
      [first!.sceneId, 1, 3000, null],
      [first!.sceneId, 2, 4000, "林夏：第 1 集第 1 句。"],
    ]);
    expect(store.shots[1]!.characterRevisionIds).toEqual([store.characters[0]!.revisionId]);
    // Repeating writes nothing twice.
    await place();
    expect(store.shots).toHaveLength(2);
    // A scene a person changed and approved needs an explicit confirmation.
    store.editScene(second!.sceneId, "人工改写");
    store.approveScene(second!.sceneId);
    expect(await place()).toMatchObject({ outcome: { sceneChanged: ["S2"] } });
    expect(store.shots).toHaveLength(2);
    expect(await place(true)).toMatchObject({ outcome: { placed: ["S2"] } });
    expect(store.shots.filter((shot) => shot.sceneId === second!.sceneId).map((shot) => shot.sourceSceneRevisionId))
      .toEqual([second!.currentRevisionId, second!.currentRevisionId]);
  });

  it("does not write shots that reference a character revised since the breakdown", async () => {
    const { store, episode, record } = await saved(true);
    for (const scene of liveScenes(store, episode)) store.approveScene(scene.sceneId);
    store.reviseCharacter(store.characters[0]!.characterId);
    const placed = await store.placeBreakdownShots(WS, P1, episode.episodeId, record.id, { acceptSceneChanged: false }, "owner", new Date().toISOString());
    expect(placed).toMatchObject({ outcome: { placed: [], charactersChanged: ["S1", "S2"] } });
    expect(store.shots).toHaveLength(0);
  });

  it("never attaches the old proposal to a scene rebased onto a newer script, even with scene-change consent", async () => {
    const { store, episode, record } = await saved();
    const [first, second] = liveScenes(store, episode);
    store.approveScene(first!.sceneId);
    const place = () => store.placeBreakdownShots(WS, P1, episode.episodeId, record.id,
      { acceptSceneChanged: true }, "owner", new Date().toISOString());
    await place();
    const alreadyPlaced = structuredClone(store.shots);
    expect(alreadyPlaced).toHaveLength(2);

    const newScript = store.writeScript(episode.episodeId, `${scriptOf(1, 2)}\n林夏：新的对白。`);
    const revisionId = store.editScene(second!.sceneId, "基于第二版剧本人工重写");
    second!.revisions.find((revision) => revision.id === revisionId)!.sourceScriptRevisionId = newScript;
    store.approveScene(second!.sceneId);
    const afterScriptChange = structuredClone(store.shots);
    expect(await place()).toEqual({ kind: "not_ready" });
    expect(await place()).toEqual({ kind: "not_ready" });
    expect(store.shots).toEqual(afterScriptChange);
    expect(store.shots.map((shot) => shot.shotId)).toEqual(alreadyPlaced.map((shot) => shot.shotId));
  });

  it.each(["approval_revoked", "script_stale", "scene_source_changed"] as const)(
    "refuses pending shots after %s without sending another model request",
    async (change) => {
      const { store, episode, record } = await saved();
      for (const scene of liveScenes(store, episode)) store.approveScene(scene.sceneId);
      if (change === "approval_revoked") episode.approvedScriptId = null;
      if (change === "script_stale") episode.scripts.find((script) => script.id === episode.currentScriptId)!.freshnessStatus = "STALE";
      if (change === "scene_source_changed") {
        for (const scene of liveScenes(store, episode)) {
          scene.revisions.find((revision) => revision.id === scene.currentRevisionId)!.sourceScriptRevisionId = "another-script-revision";
        }
      }
      const beforeCalls = store.calls.length;
      const placed = await store.placeBreakdownShots(WS, P1, episode.episodeId, record.id,
        { acceptSceneChanged: true }, "owner", new Date().toISOString());
      if (change === "scene_source_changed") {
        expect(placed).toMatchObject({ kind: "ok", outcome: { placed: [], unavailable: ["S1", "S2"] } });
      } else expect(placed).toEqual({ kind: "not_ready" });
      expect(store.shots).toHaveLength(0);
      expect(store.calls).toHaveLength(beforeCalls);
    },
  );

  it("does not add AI shots to a pending scene that now contains a manual shot", async () => {
    const { store, episode, record } = await saved();
    const [first, second] = liveScenes(store, episode);
    store.approveScene(first!.sceneId);
    const place = () => store.placeBreakdownShots(WS, P1, episode.episodeId, record.id,
      { acceptSceneChanged: true }, "owner", new Date().toISOString());
    await place();
    store.approveScene(second!.sceneId);
    store.shots.push({ ...structuredClone(store.shots[0]!), shotId: "manual-shot", revisionId: "manual-revision",
      sceneId: second!.sceneId, sourceSceneRevisionId: second!.currentRevisionId!, dialogue: "人工对白" });
    const before = structuredClone(store.shots);
    expect(await place()).toMatchObject({ kind: "ok", outcome: { placed: [], unavailable: ["S2"] } });
    expect(store.shots).toEqual(before);
  });

  it("replays an already completed placement after a script change without rewriting any shots", async () => {
    const { store, episode, record } = await saved();
    for (const scene of liveScenes(store, episode)) store.approveScene(scene.sceneId);
    const place = () => store.placeBreakdownShots(WS, P1, episode.episodeId, record.id,
      { acceptSceneChanged: true }, "owner", new Date().toISOString());
    await place();
    store.writeScript(episode.episodeId, `${scriptOf(1, 2)}\n林夏：下一版。`);
    const before = structuredClone(store.shots);
    expect(await place()).toMatchObject({ kind: "ok", outcome: { placed: [], unavailable: [] } });
    expect(store.shots).toEqual(before);
  });

  it("refuses before the result is saved and for another episode", async () => {
    const store = new InMemoryTitleWritingStore();
    const episode = store.addBreakdownEpisode({ workspaceId: WS, projectId: P1, episodeNo: 1, text: scriptOf(1, 2) });
    const other = store.addBreakdownEpisode({ workspaceId: WS, projectId: P1, episodeNo: 2, text: scriptOf(2, 2) });
    const record = await start(store, episode);
    expect(await store.placeBreakdownShots(WS, P1, episode.episodeId, record.id, { acceptSceneChanged: false }, "o", new Date().toISOString())).toEqual({ kind: "not_ready" });
    expect(await store.placeBreakdownShots(WS, P1, other.episodeId, record.id, { acceptSceneChanged: false }, "o", new Date().toISOString())).toEqual({ kind: "not_found" });
  });
});
