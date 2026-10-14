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

  it("a missing handoff asks the last episode to close the story and an earlier one to set up the next episode", () => {
    for (const handoff of ["", "待定"]) {
      const findings = flat(checkEpisodePlan(concept, outline([{ ...complete(1), handoff }, { ...complete(2), handoff }]), 2));
      const earlier = findings.find((item) => item.id === "1:missing:handoff")!;
      const last = findings.find((item) => item.id === "2:missing:handoff")!;
      expect(earlier.question).toBe("结尾留下什么与主线相关的问题？");
      expect(earlier.evidence).toContain("第 1 集 handoff（交给下一集）");
      expect(`${earlier.why}${earlier.suggestion}`).toContain("下一集");
      expect(last.question).toBe("最后一集怎样收束主线、回应整部期待？");
      expect(last.evidence).toContain("第 2 集 handoff（全剧收尾）");
      for (const text of [last.question, last.why, last.suggestion, last.evidence]) expect(text).not.toMatch(/下一集|续看|留下.*问题/);
      expect(`${last.why}${last.suggestion}`).toMatch(/收束|整部期待/);
    }
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

  it("a placeholder story direction leaves the emotional promise undetermined, not a question for a person", () => {
    const story = checkEpisodePlan({ ...concept, direction: "待定" }, outline([complete(1)]), 1).groups[0]!;
    expect(story.findings.map((item) => [item.id, item.kind])).toEqual([["story:undetermined:promise", "undetermined"]]);
    expect(story.findings[0]!.evidence).toBe("故事策划 direction（故事走向）：“待定”");
  });

  it("adjacent episodes with different goals and placeholder turns leave the escalation undetermined", () => {
    const findings = flat(checkEpisodePlan(concept, outline([{ ...complete(1), turn: "…" }, { ...complete(2), turn: "…" }]), 2));
    expect(findings.some((item) => item.id === "2:manual:escalation")).toBe(false);
    const escalation = findings.find((item) => item.id === "2:undetermined:escalation")!;
    expect(escalation.kind).toBe("undetermined");
    expect(escalation.evidence).toBe("第 1 集 turn（转折）：“…”；第 2 集 turn（转折）：“…”");
  });

  it("agency needs a written action and result: either one empty or a placeholder leaves it undetermined, citing both", () => {
    for (const [changed, expected] of [[{ result: "待定" }, "第 1 集 result（结果）：“待定”"], [{ action: "…" }, "第 1 集 action（行动）：“…”"],
      [{ result: "" }, "第 1 集 result（结果）：（空）"]] as const) {
      const findings = flat(checkEpisodePlan(concept, outline([{ ...complete(1), ...changed }]), 1));
      expect(findings.some((item) => item.id === "1:manual:agency")).toBe(false);
      const agency = findings.find((item) => item.id === "1:undetermined:agency")!;
      expect(agency.evidence).toContain("第 1 集 action（行动）");
      expect(agency.evidence).toContain("第 1 集 result（结果）");
      expect(agency.evidence).toContain(expected);
    }
  });

  it("follow-up needs this handoff and the next opening: a placeholder or an absent next episode leaves it undetermined", () => {
    const placeholderNext = flat(checkEpisodePlan(concept, outline([complete(1), { ...complete(2), entryState: "待定" }]), 2));
    expect(placeholderNext.some((item) => item.id === "1:manual:followup")).toBe(false);
    expect(placeholderNext.find((item) => item.id === "1:undetermined:followup")?.evidence)
      .toBe("第 1 集 handoff（交给下一集）：“问题1”；第 2 集 entryState（进入状态）：“待定”");
    const placeholderHandoff = flat(checkEpisodePlan(concept, outline([{ ...complete(1), handoff: "无" }, complete(2)]), 2));
    expect(placeholderHandoff.find((item) => item.id === "1:undetermined:followup")?.evidence)
      .toBe("第 1 集 handoff（交给下一集）：“无”；第 2 集 entryState（进入状态）：“开场局面2，表姐拦着”");
    const absentNext = flat(checkEpisodePlan(concept, outline([complete(1)]), 2));
    expect(absentNext.find((item) => item.id === "1:undetermined:followup")?.evidence).toBe("第 1 集 handoff（交给下一集）：“问题1”；分集大纲里没有第 2 集。");
  });

  it("closure needs the last handoff and the story direction: a placeholder or no concept leaves it undetermined", () => {
    const placeholderDirection = flat(checkEpisodePlan({ ...concept, direction: "待定" }, outline([complete(1)]), 1));
    expect(placeholderDirection.some((item) => item.id === "1:manual:closure")).toBe(false);
    expect(placeholderDirection.find((item) => item.id === "1:undetermined:closure")?.evidence)
      .toBe("第 1 集 handoff（全剧收尾）：“问题1”；故事策划 direction（故事走向）：“待定”");
    const placeholderHandoff = flat(checkEpisodePlan(concept, outline([{ ...complete(1), handoff: "TBD" }]), 1));
    expect(placeholderHandoff.find((item) => item.id === "1:undetermined:closure")?.evidence).toContain("第 1 集 handoff（全剧收尾）：“TBD”");
    const noConcept = flat(checkEpisodePlan(null, outline([complete(1)]), 1));
    expect(noConcept.find((item) => item.id === "1:undetermined:closure")?.evidence).toBe("第 1 集 handoff（全剧收尾）：“问题1”；这次创作没有可读的故事策划。");
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

  it("written agency, follow-up and closure stay questions for a person, citing every field they compare", () => {
    const findings = flat(checkEpisodePlan(concept, outline([1, 2].map(complete)), 2));
    expect(findings.find((item) => item.id === "1:manual:agency")?.evidence).toBe("第 1 集 action（行动）：“行动1”；第 1 集 result（结果）：“结果1”");
    expect(findings.find((item) => item.id === "1:manual:followup")?.evidence).toBe("第 1 集 handoff（交给下一集）：“问题1”；第 2 集 entryState（进入状态）：“开场局面2，表姐拦着”");
    expect(findings.find((item) => item.id === "2:manual:closure")?.evidence).toBe("第 2 集 handoff（全剧收尾）：“问题2”；故事策划 direction（故事走向）：“观众期待她拿回配方并保住面馆。第一集……”");
  });

  it("a repeated goal is checked for repetition and, independently, for escalation", () => {
    const repeated = (turn: string) => flat(checkEpisodePlan(concept, outline([complete(1), { ...complete(2), goal: complete(1).goal, turn }]), 2))
      .filter((item) => item.episodeNo === 2);
    const written = repeated("对方拿出第二份录音");
    expect(written.find((item) => item.id === "2:manual:repeat")?.evidence).toBe("第 1 集 goal（目标）：“目标1”；第 2 集 goal（目标）：“目标1”（两集目标文字相同）");
    expect(written.find((item) => item.id === "2:manual:escalation")?.evidence).toBe("第 1 集 turn（转折）：“转折1”；第 2 集 turn（转折）：“对方拿出第二份录音”");
    const placeholder = repeated("待定");
    expect(placeholder.find((item) => item.id === "2:manual:repeat")?.kind).toBe("manual");
    expect(placeholder.find((item) => item.id === "2:undetermined:escalation")?.kind).toBe("undetermined");
    expect(placeholder.some((item) => item.id === "2:manual:escalation")).toBe(false);
    for (const findings of [written, placeholder]) expect(new Set(findings.map((item) => item.id)).size).toBe(findings.length);
  });

  it("with valid turns on both sides the escalation stays a question for a person", () => {
    const findings = flat(checkEpisodePlan(concept, outline([1, 2].map(complete)), 2));
    expect(findings.find((item) => item.id === "2:manual:escalation")?.evidence).toBe("第 1 集 turn（转折）：“转折1”；第 2 集 turn（转折）：“转折2”");
  });

  it("an obstacle read from the turn cites that turn, with the episode, field and text", () => {
    const placeholderStory = { ...concept, opposition: "待定" };
    const episode = { ...complete(2), entryState: "待定", turn: "房东突然收回钥匙，要求林夏当天搬走" };
    const obstacle = flat(checkEpisodePlan(placeholderStory, outline([complete(1), episode]), 2)).find((item) => item.id === "2:manual:obstacle")!;
    expect(obstacle.kind).toBe("manual");
    expect(obstacle.evidence).toContain("第 2 集 turn（转折）：“房东突然收回钥匙，要求林夏当天搬走”");
    expect(obstacle.evidence).not.toContain("整部阻力");
    // Valid evidence is kept: a written opening and the story's opposition stay next to the turn.
    const full = flat(checkEpisodePlan(concept, outline([complete(1)]), 1)).find((item) => item.id === "1:manual:obstacle")!;
    expect(full.evidence).toBe("第 1 集 entryState（进入状态）：“开场局面1，表姐拦着”；第 1 集 turn（转折）：“转折1”；整部阻力：“表姐想独占面馆，抢先改了租约”");
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


it("recognizes punctuated placeholders without discarding meaningful surrounding sentences", () => {
  for (const text of ["待定。", "TBD!", "（待补充）", "“暂无”", " N/A! ", "【TODO】", "？！", "“”"]) {
    expect(blankOrPlaceholder(text), text).toBe(true);
  }
  for (const text of ["待定后再商议。", "“找到配方”", "结果是：待定。", "100%", "T.B.D 是人物代号"]) {
    expect(blankOrPlaceholder(text), text).toBe(false);
  }
});

it("punctuated placeholders are gaps or undetermined comparisons, with original evidence preserved", () => {
  const findings = flat(checkEpisodePlan({ ...concept, direction: "“待定。”" },
    outline([{ ...complete(1), action: "TBD!", result: "（待补充）", turn: "待定。", handoff: "N/A!" }]), 1));
  expect(findings.some((item) => item.id === "1:missing:action")).toBe(true);
  expect(findings.some((item) => item.id === "1:missing:result")).toBe(true);
  expect(findings.some((item) => item.id === "1:missing:handoff")).toBe(true);
  expect(findings.find((item) => item.id === "1:undetermined:agency")?.evidence).toContain("TBD!");
  expect(findings.some((item) => item.id === "1:undetermined:information")).toBe(true);
  expect(findings.some((item) => item.id === "1:undetermined:closure")).toBe(true);
  expect(findings.some((item) => item.id === "story:undetermined:promise")).toBe(true);
});
