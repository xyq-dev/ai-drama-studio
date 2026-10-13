import { describe, expect, it } from "vitest";
import type { EpisodeOutline, EpisodeOutlineEpisode, TitleConcept } from "@ai-drama/contracts";
import { blankOrPlaceholder, checkEpisodePlan, type EpisodeWritingFinding } from "./episode-writing-check";

const concept: TitleConcept = {
  schema: "ads.writing.title-concept.v1", genre: "家庭", logline: "一句话", synopsis: "梗概", protagonistGoal: "在周五前拿回配方",
  opposition: "表姐想独占面馆，抢先改了租约", coreConflict: "冲突", direction: "观众期待她拿回配方并保住面馆。第一集……",
  characters: [{ name: "林夏", role: "主角", profile: "p" }, { name: "周岩", role: "表姐", profile: "p" }],
  relationships: [{ name: "林夏与周岩", pressure: "租约" }],
};

const complete = (episodeNo: number): EpisodeOutlineEpisode => ({
  episodeNo, title: `第${String(episodeNo)}集名`, entryState: `开场局面${String(episodeNo)}，表姐拦着`, goal: `目标${String(episodeNo)}`,
  action: `行动${String(episodeNo)}`, turn: `转折${String(episodeNo)}`, result: `结果${String(episodeNo)}`, handoff: `问题${String(episodeNo)}`,
});

const outline = (episodes: EpisodeOutlineEpisode[], schema: EpisodeOutline["schema"] = "ads.writing.episode-outline.v2"): EpisodeOutline => ({ schema, episodes });

const of = (findings: EpisodeWritingFinding[], kind: EpisodeWritingFinding["kind"]) => findings.filter((item) => item.kind === kind);
const flat = (check: ReturnType<typeof checkEpisodePlan>) => check.groups.flatMap((group) => group.findings);

describe("objective gaps come from the structured fields", () => {
  it("complete fields give no missing item, and the semantic questions stay for a person", () => {
    const check = checkEpisodePlan(concept, outline([1, 2, 3].map(complete)), 3);
    expect(check.counts.missing).toBe(0);
    expect(check.counts.manual).toBeGreaterThan(0);
    expect(check.groups.map((group) => group.episodeNo)).toEqual([null, 1, 2, 3]);
    // Every episode keeps its human questions: agency, payoff, information, follow-up or closure.
    for (const group of check.groups.slice(1)) {
      const ids = group.findings.map((finding) => finding.id.split(":").slice(1).join(":"));
      expect(ids).toEqual(expect.arrayContaining(["manual:obstacle", "manual:agency", "manual:information", "manual:payoff"]));
      expect(ids).toContain(group.episodeNo === 3 ? "manual:closure" : "manual:followup");
    }
  });

  it("empty and placeholder fields are missing items of exactly that episode, citing the field", () => {
    const episodes = [complete(1), { ...complete(2), goal: "  ", action: "待定", handoff: "……" }, complete(3)];
    const findings = flat(checkEpisodePlan(concept, outline(episodes), 3));
    const missing = of(findings, "missing");
    expect(missing.map((item) => [item.episodeNo, item.id])).toEqual([[2, "2:missing:goal"], [2, "2:missing:action"], [2, "2:missing:handoff"]]);
    expect(missing[0]!.evidence).toContain("第 2 集 goal（目标）：（空）");
    expect(missing[1]!.evidence).toContain("“待定”");
    for (const item of missing) {
      expect(item.why.length).toBeGreaterThan(0);
      expect(item.suggestion.length).toBeGreaterThan(0);
    }
  });

  it("an opening and result written identically is a question for a person, quoting both fields, never a missing item", () => {
    const findings = flat(checkEpisodePlan(concept, outline([{ ...complete(1), result: complete(1).entryState }]), 1));
    expect(of(findings, "missing")).toEqual([]);
    const change = findings.find((item) => item.id === "1:manual:change")!;
    expect(change.kind).toBe("manual");
    expect(change.evidence).toContain("第 1 集 entryState（进入状态）：“开场局面1，表姐拦着”");
    expect(change.evidence).toContain("第 1 集 result（结果）：“开场局面1，表姐拦着”");
  });

  it("an episode the outline does not have is missing for that number; nothing is invented", () => {
    const check = checkEpisodePlan(concept, outline([complete(1), complete(2)]), 3);
    expect(check.groups.at(-1)).toMatchObject({ episodeNo: 3, findings: [{ id: "3:missing:episode", kind: "missing" }] });
    const none = checkEpisodePlan(concept, null, 2);
    expect(none.groups.slice(1).map((group) => group.findings.map((finding) => finding.id))).toEqual([["1:missing:episode"], ["2:missing:episode"]]);
  });

  it("story level: missing goal or opposition is a gap; the emotional promise is a human question", () => {
    const story = checkEpisodePlan({ ...concept, protagonistGoal: "无", opposition: "" }, outline([complete(1)]), 1).groups[0]!;
    expect(story.findings.map((item) => [item.id, item.kind])).toEqual([
      ["story:missing:protagonistGoal", "missing"], ["story:missing:opposition", "missing"], ["story:manual:promise", "manual"],
    ]);
  });
});

describe("what cannot be read is not judged", () => {
  it("without a concept the story questions are undetermined, not passed or failed", () => {
    const story = checkEpisodePlan(null, outline([complete(1)]), 1).groups[0]!;
    expect(story.findings).toEqual([expect.objectContaining({ kind: "undetermined", episodeNo: null })]);
  });

  it("empty opening and turn leave the obstacle and the new information undetermined", () => {
    const findings = flat(checkEpisodePlan(concept, outline([{ ...complete(1), entryState: "", turn: "" }]), 1));
    expect(of(findings, "undetermined").map((item) => item.id)).toEqual(["1:undetermined:obstacle", "1:undetermined:information"]);
  });

  it("findings are only missing, manual or undetermined; there is no pass state and no score", () => {
    const check = checkEpisodePlan(concept, outline([1, 2].map(complete)), 2);
    expect(new Set(flat(check).map((item) => item.kind))).toEqual(new Set(["manual"]));
    expect(Object.keys(check)).toEqual(["groups", "counts"]);
    expect(Object.keys(check.counts).sort()).toEqual(["manual", "missing", "undetermined"]);
  });
});

describe("semantic hints stay human questions", () => {
  it("the same goal as the previous episode is a repeated-conflict question with both fields as evidence", () => {
    const findings = flat(checkEpisodePlan(concept, outline([complete(1), { ...complete(2), goal: complete(1).goal }]), 2));
    const repeat = findings.find((item) => item.id === "2:manual:repeat")!;
    expect(repeat.kind).toBe("manual");
    expect(repeat.evidence).toContain("第 1 集 goal");
    expect(repeat.evidence).toContain("第 2 集 goal");
  });
});

describe("old plans and the original content", () => {
  it("reads a v1 three-episode outline", () => {
    const check = checkEpisodePlan(concept, outline([1, 2, 3].map(complete), "ads.writing.episode-outline.v1"), 3);
    expect(check.counts.missing).toBe(0);
  });

  it("never changes the concept or outline it reads", () => {
    const plan = outline([complete(1), { ...complete(2), goal: "" }]);
    const before = JSON.stringify([concept, plan]);
    checkEpisodePlan(Object.freeze(concept), Object.freeze(plan), 2);
    expect(JSON.stringify([concept, plan])).toBe(before);
  });

  it("recognizes placeholders without flagging real short text", () => {
    expect(["", " ", "待定", "TBD", "…", "-"].every(blankOrPlaceholder)).toBe(true);
    expect(["报警", "他走了"].some(blankOrPlaceholder)).toBe(false);
  });
});
