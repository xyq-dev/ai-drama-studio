import { describe, expect, it } from "vitest";
import type { Aggregate, EpisodeRecord, StoryRevision, WorkflowRun } from "./project-base";
import {
  combine,
  currentStep,
  entityState,
  episodeFinalState,
  episodeForAction,
  episodeForStep,
  episodeNeedingWork,
  episodeSampleState,
  primaryAction,
  revisionState,
  sampleState,
  scriptState,
  stepStates,
  type BeginnerFacts,
  type CompositeSummary,
  type EpisodeMediaFacts,
} from "./beginner-steps";
import { suggestTitle } from "./beginner-start";

function story(reviewStatus: string, freshnessStatus = "CURRENT"): StoryRevision {
  return { id: "s1", revisionNo: 1, content: { text: "故事" }, reviewStatus, freshnessStatus, reviewVersion: 1,
    staleReason: null, staleFromRef: null, reviewNote: null };
}

function episode(episodeNo: number, review: string | null, freshness = "CURRENT", approved = review === "APPROVED"): EpisodeRecord {
  const current = review ? `script-${episodeNo}` : null;
  return { id: `e${episodeNo}`, episodeNo, title: "", rowVersion: 1, currentScriptRevisionId: current,
    approvedScriptRevisionId: approved ? current : null, currentScriptReviewStatus: review,
    currentScriptFreshnessStatus: review ? freshness : null };
}

function entity(id: string, review: string | null, freshness = "CURRENT"): Aggregate {
  return { entityId: id, rowVersion: 1, currentRevisionId: review ? `${id}-r` : null,
    approvedRevisionId: review === "APPROVED" ? `${id}-r` : null,
    currentRevision: review ? { reviewStatus: review, freshnessStatus: freshness, reviewVersion: 1 } : null };
}

function run(kind: string, state: string, options: { shot?: string | null; episodeId?: string | null; createdAt?: string } = {}): WorkflowRun {
  return { id: `${kind}-${state}-${options.createdAt ?? "t"}-${options.episodeId ?? ""}`, type: kind, status: state,
    createdAt: options.createdAt ?? "2026-10-07T00:00:00.000Z",
    jobs: [{ id: "j", kind, state, errorCode: null, errorMessage: null, sourceShotRevisionId: options.shot === undefined ? "shot-r" : options.shot,
      composeEpisodeId: options.episodeId ?? null }] };
}

const NO_COMPOSITES: CompositeSummary = { read: "ok", approvedActive: false, draftActive: false, rejectedActive: false, staleApproved: false };

function media(count: number, composites: Partial<CompositeSummary> = {}, candidatesRead: EpisodeMediaFacts["candidates"]["read"] = "ok"): EpisodeMediaFacts {
  return { candidates: { read: candidatesRead, count }, composites: { ...NO_COMPOSITES, ...composites } };
}

function facts(overrides: Partial<BeginnerFacts> = {}): BeginnerFacts {
  return { story: null, episodes: [], characters: { items: [], read: "ok" }, locations: { items: [], read: "ok" }, runs: [],
    media: {}, ...overrides };
}

const approvedEpisodes = [episode(1, "APPROVED"), episode(2, "APPROVED"), episode(3, "APPROVED")];

describe("beginner step states come from server facts", () => {
  it("maps one revision's review and freshness", () => {
    expect(revisionState(null)).toBe("needs_input");
    expect(revisionState({ reviewStatus: "DRAFT", freshnessStatus: "CURRENT" })).toBe("needs_confirmation");
    expect(revisionState({ reviewStatus: "REJECTED", freshnessStatus: "CURRENT" })).toBe("needs_attention");
    expect(revisionState({ reviewStatus: "APPROVED", freshnessStatus: "CURRENT" })).toBe("done");
    expect(revisionState({ reviewStatus: "APPROVED", freshnessStatus: "STALE" })).toBe("source_updated");
  });

  it("does not count a script approved under an older revision as done", () => {
    expect(scriptState(episode(1, "APPROVED", "CURRENT", false))).toBe("needs_confirmation");
    expect(scriptState(undefined)).toBe("needs_input");
    expect(entityState(entity("c", "APPROVED"))).toBe("done");
    expect(entityState({ ...entity("c", "APPROVED"), approvedRevisionId: "older" })).toBe("needs_confirmation");
  });

  it("shows the worst state first and never calls an unread fact done", () => {
    expect(combine(["done", "needs_confirmation", "source_updated"])).toBe("source_updated");
    expect(combine(["done", "unknown"])).toBe("unknown");
    expect(combine(["done", "done"])).toBe("done");
  });

  it("starts a new project at 定故事 and walks forward only as the server confirms", () => {
    expect(currentStep(stepStates(facts()))).toBe("story");
    const approved = stepStates(facts({ story: story("APPROVED"), episodes: [episode(1, null), episode(2, null), episode(3, null)] }));
    expect(approved).toMatchObject({ story: "done", script: "needs_input", cast: "not_started" });
  });

  it("reads characters and locations completely: the 21st character being REJECTED is not hidden (review)", () => {
    const base = { story: story("APPROVED"), episodes: approvedEpisodes };
    const twenty = Array.from({ length: 20 }, (_, index) => entity(`c${index}`, "APPROVED"));
    expect(stepStates(facts({ ...base, characters: { items: [...twenty, entity("c20", "REJECTED")], read: "ok" } })).cast)
      .toBe("needs_attention");
    // A list whose later pages were not read is not "done".
    expect(stepStates(facts({ ...base, characters: { items: twenty, read: "incomplete" } })).cast).toBe("unknown");
    expect(stepStates(facts({ ...base, characters: { items: twenty, read: "failed" } })).cast).toBe("unknown");
  });

  it("keeps location problems visible before the first character exists (review)", () => {
    const base = { story: story("APPROVED"), episodes: approvedEpisodes };
    expect(stepStates(facts({ ...base, locations: { items: [entity("l", "REJECTED")], read: "ok" } })).cast).toBe("needs_attention");
    expect(stepStates(facts({ ...base, locations: { items: [entity("l", "APPROVED", "STALE")], read: "ok" } })).cast).toBe("source_updated");
    expect(stepStates(facts(base)).cast).toBe("needs_input");
  });

  it("calls 试一段 done only with a real approved current single-shot composite", () => {
    const base = { story: story("APPROVED"), episodes: approvedEpisodes };
    const none = { 1: media(0), 2: media(0), 3: media(0) };
    expect(sampleState(facts({ ...base, media: none }))).toBe("needs_input");
    expect(sampleState(facts({ ...base, media: { ...none, 2: media(1) } }))).toBe("done");
    expect(sampleState(facts({ ...base, media: none, runs: [run("MEDIA_VIDEO", "RUNNING")] }))).toBe("in_progress");
    // Finished history is not a current sample: an old SUCCEEDED or FAILED compose job says nothing now (review).
    expect(sampleState(facts({ ...base, media: none, runs: [run("MEDIA_COMPOSE", "SUCCEEDED")] }))).toBe("needs_input");
    expect(sampleState(facts({ ...base, media: none, runs: [run("MEDIA_COMPOSE", "FAILED")] }))).toBe("needs_input");
    // An unread or switched-off candidate list is not "nothing there".
    expect(episodeSampleState(facts({ ...base, media: { ...none, 1: media(0, {}, "failed") } }), 1)).toBe("unknown");
    expect(episodeSampleState(facts({ ...base, media: { ...none, 1: media(0, {}, "unavailable") } }), 1)).toBe("unknown");
  });

  it("finishes 出成片 per episode on an approved current composite, wherever it was in the list (review)", () => {
    const base = { story: story("APPROVED"), episodes: approvedEpisodes };
    expect(episodeFinalState(facts({ ...base, media: { 1: media(2) } }), 1)).toBe("needs_input");
    expect(episodeFinalState(facts({ ...base, media: { 1: media(1) } }), 1)).toBe("not_started");
    expect(episodeFinalState(facts({ ...base, media: { 1: media(2, { draftActive: true }) } }), 1)).toBe("needs_confirmation");
    expect(episodeFinalState(facts({ ...base, media: { 1: media(2, { approvedActive: true, draftActive: true }) } }), 1)).toBe("done");
    // A rejected current composite needs the user; a stale approved one says the source changed.
    expect(episodeFinalState(facts({ ...base, media: { 1: media(2, { rejectedActive: true }) } }), 1)).toBe("needs_attention");
    expect(episodeFinalState(facts({ ...base, media: { 1: media(2, { staleApproved: true }) } }), 1)).toBe("source_updated");
    // Not read to the end and nothing decisive yet: unknown, never "needs_input".
    expect(episodeFinalState(facts({ ...base, media: { 1: media(2, { read: "incomplete" }) } }), 1)).toBe("unknown");
    expect(episodeFinalState(facts({ ...base, media: { 1: media(2, { read: "unavailable" }) } }), 1)).toBe("unknown");
  });

  it("keeps history after a script change: STALE + APPROVED is 来源已更新 even when the script is DRAFT (review)", () => {
    const changed = [episode(1, "DRAFT", "CURRENT", false), episode(2, "APPROVED"), episode(3, "APPROVED")];
    const state = episodeFinalState(facts({ story: story("APPROVED"), episodes: changed, media: { 1: media(0, { staleApproved: true }) } }), 1);
    expect(state).toBe("source_updated");
    expect(primaryAction("final", state)).toEqual({ label: "重新编排合成", target: "compose" });
  });

  it("marks only the episode whose compose is running (review)", () => {
    const base = { story: story("APPROVED"), episodes: approvedEpisodes, media: { 1: media(2), 2: media(0), 3: media(0) } };
    const running = facts({ ...base, runs: [run("MEDIA_COMPOSE", "RUNNING", { shot: null, episodeId: "e1" })] });
    expect(episodeFinalState(running, 1)).toBe("in_progress");
    expect(episodeFinalState(running, 2)).toBe("not_started");
    expect(episodeFinalState(running, 3)).toBe("not_started");
    // A job whose episode is not known is never attributed to any episode.
    const unknownEpisode = facts({ ...base, runs: [run("MEDIA_COMPOSE", "RUNNING", { shot: null, episodeId: null })] });
    expect([1, 2, 3].map((no) => episodeFinalState(unknownEpisode, no))).toEqual(["needs_input", "not_started", "not_started"]);
  });

  it("does not mark other episodes' 试一段 as running from a shot job whose episode is unknown (final review)", () => {
    // All three scripts approved and current, no approved sample anywhere; only a shot of episode 1 is generating.
    const base = { story: story("APPROVED"), episodes: approvedEpisodes, media: { 1: media(0), 2: media(0), 3: media(0) } };
    for (const job of [run("MEDIA_VIDEO", "RUNNING", { shot: "ep1-shot-r" }), run("MEDIA_COMPOSE", "RUNNING", { shot: "ep1-shot-r" })]) {
      const running = facts({ ...base, runs: [job] });
      expect([1, 2, 3].map((no) => episodeSampleState(running, no))).toEqual(["needs_input", "needs_input", "needs_input"]);
      // The project-level step still says work is running, without naming an episode.
      expect(sampleState(running)).toBe("in_progress");
      // A single-shot compose is not an episode compose: no episode's final step changes.
      expect([1, 2, 3].map((no) => episodeFinalState(running, no))).toEqual(["not_started", "not_started", "not_started"]);
    }
    // An episode compose for episode 1 changes only episode 1's final step and never the sample step.
    const episodeCompose = facts({ ...base, media: { 1: media(2), 2: media(0), 3: media(0) },
      runs: [run("MEDIA_COMPOSE", "RUNNING", { shot: null, episodeId: "e1" })] });
    expect([1, 2, 3].map((no) => episodeFinalState(episodeCompose, no))).toEqual(["in_progress", "not_started", "not_started"]);
    // Episode 1 has two approved samples (that is why it can compose); the running episode compose adds nothing here.
    expect([1, 2, 3].map((no) => episodeSampleState(episodeCompose, no))).toEqual(["done", "needs_input", "needs_input"]);
    expect(sampleState(episodeCompose)).toBe("done");
  });

  it("opens the episode that needs the step's work, not always episode 1 (review)", () => {
    const scripts = facts({ story: story("APPROVED"), episodes: [episode(1, "APPROVED"), episode(2, "DRAFT"), episode(3, null)] });
    expect(episodeForStep("script", scripts)).toBe(2);
    const finals = facts({ story: story("APPROVED"), episodes: approvedEpisodes,
      media: { 1: media(2, { approvedActive: true }), 2: media(2, { draftActive: true }), 3: media(0) } });
    expect(episodeForStep("final", finals)).toBe(2);
    expect(episodeForStep("story", finals)).toBe(1);
  });

  it("gives every state an action with a real destination (review)", () => {
    expect(primaryAction("final", "done")).toEqual({ label: "查看并下载成片", target: "compose" });
    expect(primaryAction("cast", "done")).toEqual({ label: "继续下一步", target: "next" });
    // A stale text revision cannot be approved again: edit and save a new version.
    expect(primaryAction("script", "source_updated")).toEqual({ label: "修改并保存新版本", target: "editor" });
    expect(primaryAction("sample", "source_updated").target).toBe("candidates");
    expect(primaryAction("final", "in_progress")).toEqual({ label: "查看合成进度", target: "compose" });
    expect(primaryAction("story", "unknown")).toEqual({ label: "重新读取进度", target: "reload" });
  });
});

describe("suggestTitle", () => {
  it("cuts the first clause of the user's own words, at most 12 characters", () => {
    expect(suggestTitle("夜班便利店店员发现班次记录被人改过，所有证据都指向她自己。")).toBe("夜班便利店店员发现班次记…");
    expect(suggestTitle("  回家  ")).toBe("回家");
    expect(suggestTitle("😀😀😀😀😀😀😀😀😀😀😀😀😀")).toBe(`${"😀".repeat(12)}…`);
  });
});

describe("which episode a step and its actions open (Issue #52 items 1 and 5)", () => {
  const twoDone = facts({ episodes: approvedEpisodes, media: { 1: media(0), 2: media(1), 3: media(0) } });

  it("a completed 试一段 opens the episode that has the approved sample", () => {
    expect(stepStates(twoDone).sample).toBe("done");
    expect(episodeForStep("sample", twoDone)).toBe(2);
    // Continuing work goes to an episode that still needs a sample.
    expect(episodeNeedingWork("sample", twoDone)).toBe(1);
  });

  it("an action on a finished episode moves to the episode that now needs the user", () => {
    const scripts = facts({ episodes: [episode(1, "APPROVED"), episode(2, null), episode(3, "DRAFT")] });
    expect(episodeForAction("script", scripts, 1)).toBe(2);
    // Issue #54: episode 3 waits for review, which is not what 补齐剧本 (needs input) is for, so the action goes
    // to episode 2, the episode that supplies the step state.
    expect(stepStates(scripts).script).toBe("needs_input");
    expect(episodeForAction("script", scripts, 3)).toBe(2);
    expect(episodeForAction("story", scripts, 2)).toBe(2);
  });

  it("all episodes done: the action stays on a finished episode to view and download", () => {
    const allDone = facts({ episodes: approvedEpisodes,
      media: { 1: media(2, { approvedActive: true }), 2: media(2, { approvedActive: true }), 3: media(2, { approvedActive: true }) } });
    expect(stepStates(allDone).final).toBe("done");
    expect(episodeForAction("final", allDone, 3)).toBe(3);
    expect(episodeNeedingWork("final", allDone)).toBeNull();
  });
});

describe("the primary action goes to the episode that supplies the step state (Issue #54 A)", () => {
  it("DRAFT and REJECTED mixed: 查看原因并修改 opens the returned episode", () => {
    const mixed = facts({ episodes: [episode(1, "DRAFT"), episode(2, "REJECTED"), episode(3, "APPROVED")] });
    expect(stepStates(mixed).script).toBe("needs_attention");
    expect(primaryAction("script", "needs_attention").label).toBe("查看原因并修改");
    expect(episodeForAction("script", mixed, 1)).toBe(2);
    expect(episodeForAction("script", mixed, 3)).toBe(2);
  });

  it("STALE outranks the rest and is opened first", () => {
    const stale = facts({ episodes: [episode(1, "DRAFT"), episode(2, "APPROVED", "STALE"), episode(3, "REJECTED")] });
    expect(stepStates(stale).script).toBe("source_updated");
    expect(episodeForAction("script", stale, 3)).toBe(2);
  });

  it("keeps the shown episode when it already matches, and picks the first match in episode order otherwise", () => {
    const two = facts({ episodes: [episode(1, "DRAFT"), episode(2, "REJECTED"), episode(3, "REJECTED")] });
    expect(episodeForAction("script", two, 3)).toBe(3);
    expect(episodeForAction("script", two, 2)).toBe(2);
    expect(episodeForAction("script", two, 1)).toBe(2);
  });

  it("all done: stays on a done episode", () => {
    const done = facts({ episodes: approvedEpisodes });
    expect(episodeForAction("script", done, 3)).toBe(3);
  });

  it("a running shot job of unknown episode keeps the shown episode instead of inventing one", () => {
    const running = facts({ episodes: approvedEpisodes, media: { 1: media(0), 2: media(0), 3: media(0) },
      runs: [run("MEDIA_VIDEO", "RUNNING")] });
    expect(stepStates(running).sample).toBe("in_progress");
    expect(primaryAction("sample", "in_progress").target).toBe("tasks");
    expect(episodeForAction("sample", running, 2)).toBe(2);
  });
});
