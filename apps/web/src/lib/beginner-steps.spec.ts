import { describe, expect, it } from "vitest";
import type { Aggregate, EpisodeRecord, StoryRevision, WorkflowRun } from "./project-base";
import {
  combine,
  currentStep,
  entityState,
  episodeFinalState,
  primaryAction,
  revisionState,
  sampleState,
  scriptState,
  stepStates,
  type BeginnerFacts,
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

function run(kind: string, state: string, createdAt = "2026-10-07T00:00:00.000Z", shot: string | null = "shot-r"): WorkflowRun {
  return { id: `${kind}-${state}-${createdAt}`, type: kind, status: state, createdAt,
    jobs: [{ id: "j", kind, state, errorCode: null, errorMessage: null, sourceShotRevisionId: shot }] };
}

function facts(overrides: Partial<BeginnerFacts> = {}): BeginnerFacts {
  return { story: null, episodes: [], characters: [], locations: [], runs: [], media: {}, ...overrides };
}

const approvedEpisodes = [episode(1, "APPROVED"), episode(2, "APPROVED"), episode(3, "APPROVED")];

describe("beginner step states come from server facts", () => {
  it("maps one revision's review and freshness", () => {
    expect(revisionState(null)).toBe("needs_input");
    expect(revisionState({ reviewStatus: "DRAFT", freshnessStatus: "CURRENT" })).toBe("needs_confirmation");
    expect(revisionState({ reviewStatus: "IN_REVIEW", freshnessStatus: "CURRENT" })).toBe("needs_confirmation");
    expect(revisionState({ reviewStatus: "REJECTED", freshnessStatus: "CURRENT" })).toBe("needs_attention");
    expect(revisionState({ reviewStatus: "APPROVED", freshnessStatus: "CURRENT" })).toBe("done");
    // Approved but stale is not done: the source changed.
    expect(revisionState({ reviewStatus: "APPROVED", freshnessStatus: "STALE" })).toBe("source_updated");
  });

  it("does not count a script approved under an older revision as done", () => {
    expect(scriptState(episode(1, "APPROVED", "CURRENT", false))).toBe("needs_confirmation");
    expect(scriptState(undefined)).toBe("needs_input");
    expect(entityState(entity("c", "APPROVED"))).toBe("done");
    expect(entityState({ ...entity("c", "APPROVED"), approvedRevisionId: "older" })).toBe("needs_confirmation");
  });

  it("shows the worst state first", () => {
    expect(combine(["done", "needs_confirmation", "source_updated"])).toBe("source_updated");
    expect(combine(["done", "done"])).toBe("done");
    expect(combine([])).toBe("needs_input");
  });

  it("starts a new project at 定故事 and walks forward only as the server confirms", () => {
    expect(stepStates(facts())).toEqual({ story: "not_started", script: "not_started", cast: "not_started",
      sample: "not_started", final: "not_started" });
    expect(currentStep(stepStates(facts()))).toBe("story");
    const drafted = stepStates(facts({ story: story("DRAFT") }));
    expect(drafted.story).toBe("needs_confirmation");
    expect(currentStep(drafted)).toBe("story");
    const approved = stepStates(facts({ story: story("APPROVED"), episodes: [episode(1, null), episode(2, null), episode(3, null)] }));
    expect(approved).toMatchObject({ story: "done", script: "needs_input", cast: "not_started" });
    expect(currentStep(approved)).toBe("script");
  });

  it("asks for characters once a script is approved and confirms them by review", () => {
    const base = { story: story("APPROVED"), episodes: approvedEpisodes, media: { 1: { candidates: 0, composites: [] } } };
    expect(stepStates(facts(base)).cast).toBe("needs_input");
    expect(stepStates(facts({ ...base, characters: [entity("a", "APPROVED"), entity("b", "DRAFT")] })).cast).toBe("needs_confirmation");
    expect(stepStates(facts({ ...base, characters: [entity("a", "APPROVED")], locations: [entity("l", "APPROVED", "STALE")] })).cast)
      .toBe("source_updated");
  });

  it("calls 试一段 done only with a real approved single-shot composite, and reads tasks for the rest", () => {
    const base = { story: story("APPROVED"), episodes: approvedEpisodes };
    expect(sampleState(facts({ ...base, media: { 1: { candidates: 0, composites: [] } } }))).toBe("needs_input");
    expect(sampleState(facts({ ...base, runs: [run("MEDIA_VIDEO", "RUNNING")] }))).toBe("in_progress");
    expect(sampleState(facts({ ...base, runs: [run("MEDIA_COMPOSE", "SUCCEEDED")] }))).toBe("needs_confirmation");
    expect(sampleState(facts({ ...base, runs: [run("MEDIA_COMPOSE", "SUCCEEDED", "2026-10-07T00:00:00.000Z"),
      run("MEDIA_COMPOSE", "FAILED", "2026-10-07T01:00:00.000Z")] }))).toBe("needs_attention");
    expect(sampleState(facts({ ...base, media: { 2: { candidates: 1, composites: [] } } }))).toBe("done");
    // An episode compose job has no shot revision and is not a sample.
    expect(sampleState(facts({ ...base, runs: [run("MEDIA_COMPOSE", "RUNNING", undefined, null)] }))).toBe("needs_input");
  });

  it("finishes 出成片 per episode only on an approved current composite and keeps history visible", () => {
    const base = { story: story("APPROVED"), episodes: approvedEpisodes };
    expect(episodeFinalState(facts({ ...base, media: { 1: { candidates: 1, composites: [] } } }), 1)).toBe("not_started");
    expect(episodeFinalState(facts({ ...base, media: { 1: { candidates: 2, composites: [] } } }), 1)).toBe("needs_input");
    expect(episodeFinalState(facts({ ...base, media: { 1: { candidates: 2, composites: [{ status: "ACTIVE", reviewStatus: "DRAFT" }] } } }), 1))
      .toBe("needs_confirmation");
    expect(episodeFinalState(facts({ ...base, media: { 1: { candidates: 2, composites: [{ status: "STALE", reviewStatus: "APPROVED" }] } } }), 1))
      .toBe("source_updated");
    expect(episodeFinalState(facts({ ...base, media: { 1: { candidates: 2, composites: [{ status: "ACTIVE", reviewStatus: "APPROVED" }] } } }), 1))
      .toBe("done");
    expect(episodeFinalState(facts({ ...base, runs: [run("MEDIA_COMPOSE", "RUNNING", undefined, null)],
      media: { 1: { candidates: 2, composites: [] } } }), 1)).toBe("in_progress");
    const oneDone = stepStates(facts({ ...base, media: {
      1: { candidates: 2, composites: [{ status: "ACTIVE", reviewStatus: "APPROVED" }] },
      2: { candidates: 0, composites: [] }, 3: { candidates: 0, composites: [] } } }));
    expect(oneDone.final).toBe("needs_input");
  });

  it("names one primary action per state without claiming it ran", () => {
    expect(primaryAction("story", "needs_input")).toEqual({ label: "写下故事并保存", target: "editor" });
    expect(primaryAction("script", "needs_confirmation")).toEqual({ label: "检查并确认当前版本", target: "review" });
    expect(primaryAction("sample", "needs_confirmation")).toEqual({ label: "播放并检查", target: "review" });
    expect(primaryAction("final", "in_progress").target).toBe("tasks");
    expect(primaryAction("cast", "done")).toEqual({ label: "继续下一步", target: "next" });
  });
});

describe("suggestTitle", () => {
  it("cuts the first clause of the user's own words, at most 12 characters", () => {
    expect(suggestTitle("夜班便利店店员发现班次记录被人改过，所有证据都指向她自己。")).toBe("夜班便利店店员发现班次记…");
    expect(suggestTitle("  回家  ")).toBe("回家");
    expect(suggestTitle("😀😀😀😀😀😀😀😀😀😀😀😀😀")).toBe(`${"😀".repeat(12)}…`);
    expect(suggestTitle("")).toBe("");
  });
});
