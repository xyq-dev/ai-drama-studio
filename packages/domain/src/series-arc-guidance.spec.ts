import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SERIES_ARC_SCHEMA,
  SERIES_PROMPT_MAX_CHARS,
  SERIES_RESEARCH_CONTRACT,
  SERIES_SETTING_SCHEMA,
  SERIES_WRITING_CHECKS_VERSION,
  SERIES_WRITING_INPUT_SCHEMA,
  SERIES_WRITING_PROMPT_VERSION,
  type SeriesArc,
  type SeriesFrozenInput,
  type SeriesSetting,
} from "@ai-drama/contracts";
import { buildSeriesPrompt, seriesAutoInput, seriesPlanContext, validateSeriesStageOutput } from "./index";

// Synthetic plans only: none of these samples is the rejected live model answer.
function fixture(n: number) {
  const input: SeriesFrozenInput = {
    schema: SERIES_WRITING_INPUT_SCHEMA,
    promptVersion: SERIES_WRITING_PROMPT_VERSION,
    checksVersion: SERIES_WRITING_CHECKS_VERSION,
    researchContract: SERIES_RESEARCH_CONTRACT,
    idea: "", constraints: { genre: "", audience: "", maxCharacters: null, maxLocations: null, forbiddenThemes: [], endingRequirement: "" },
    materials: [], referenceUrls: [], researchFetch: false,
    episodeCount: n, episodeSeconds: 60, batchSize: 3, outlineChunk: 6,
  };
  const setting: SeriesSetting = {
    schema: SERIES_SETTING_SCHEMA, title: "旧信", logline: "主角找到旧信", synopsis: "主角找到旧信并化解误会",
    core: { protagonistId: "C1", desire: "找到真相", weakness: "多疑", goal: "化解误会", coreConflict: "信件被隐瞒",
      keyChoices: [{ choice: "交出旧信", consequence: "化解误会" }], failureCost: "失去信任", ending: "双方和解", majorTurns: [{ episodeNo: n, turn: "读懂信件" }] },
    characters: [{ id: "C1", name: "小林", identity: "店员", goal: "找到真相", weakness: "多疑", arc: "学会信任", voice: "直接", initialWhereabouts: "店内" }],
    relationships: [], secrets: [], locations: [{ id: "L1", name: "旧店", intExt: "INT", description: "旧店内" }], props: [],
  };
  const context = { ...seriesPlanContext(input, []), setting };
  const autoInput = seriesAutoInput(input, { providerKey: "deepseek", model: "synthetic", maxOutputTokens: 4096 });
  const arc = (foreshadowing: SeriesArc["foreshadowing"]): SeriesArc => ({
    schema: SERIES_ARC_SCHEMA,
    phases: [{ phaseNo: 1, title: "解开误会", episodeFrom: 1, episodeTo: n, goal: "找到旧信", turningPoint: "读懂信件" }],
    foreshadowing,
    finale: { episodeNo: n, resolution: "双方和解" },
  });
  const validate = (foreshadowing: SeriesArc["foreshadowing"]) => validateSeriesStageOutput("arc", JSON.stringify(arc(foreshadowing)), input, context, autoInput);
  return { input, context, autoInput, arc, validate };
}

function exampleFrom(user: string): SeriesArc["foreshadowing"] {
  const match = /<<<合法伏笔结构示例\n([^\n]+)\n合法伏笔结构示例>>>/u.exec(user);
  expect(match, "the actual prompt must carry a complete JSON example").not.toBeNull();
  return JSON.parse(match![1]!) as SeriesArc["foreshadowing"];
}

describe("series arc prompt v2: explain dependencies without relaxing the checker", () => {
  it.each([1, 2, 3, 60])("N=%i: the actual example passes full arc validation and fits the frozen range", (n) => {
    const { input, context, autoInput, arc, validate } = fixture(n);
    const before = JSON.stringify(input);
    const prompt = buildSeriesPrompt("arc", input, context, autoInput);
    expect(prompt.user).toContain("target.payoffEpisode < item.payoffEpisode");
    expect(prompt.user).toContain("提示版本：ads.series-writing.prompt.v2");
    expect(prompt.user).toContain("编号顺序");
    expect(prompt.user).toContain("埋设顺序");
    expect(prompt.user).toContain("dependsOn: []");
    expect(prompt.user).toContain("仅演示关系");
    expect(prompt.system.length + prompt.user.length).toBeLessThanOrEqual(SERIES_PROMPT_MAX_CHARS);
    const example = exampleFrom(prompt.user);
    expect(example).toHaveLength(n === 1 ? 0 : n === 2 ? 1 : 2);
    expect(validate(example)).toEqual({ ok: true, output: arc(example) });
    expect(example.every((item) => item.plantEpisode >= 1 && item.plantEpisode < item.payoffEpisode && item.payoffEpisode <= n)).toBe(true);
    for (const item of example) {
      for (const dependency of item.dependsOn) {
        const target = example.find((entry) => entry.id === dependency);
        expect(target).toBeDefined();
        expect(target!.payoffEpisode).toBeLessThan(item.payoffEpisode);
      }
    }
    expect(JSON.stringify(input)).toBe(before);
  });

  it("one episode has no valid cross-episode foreshadowing; two episodes allow independent items without a dependency chain", () => {
    const one = fixture(1);
    const two = fixture(2);
    expect(buildSeriesPrompt("arc", one.input, one.context, one.autoInput).user).toContain("foreshadowing 必须为 []");
    expect(buildSeriesPrompt("arc", two.input, two.context, two.autoInput).user).toContain("不能组成严格提前兑现的依赖链");
    const independent = [
      { id: "FS1", content: "旧信", plantEpisode: 1, payoffEpisode: 2, dependsOn: [] },
      { id: "FS2", content: "缺角", plantEpisode: 1, payoffEpisode: 2, dependsOn: [] },
    ];
    expect(two.validate(independent).ok).toBe(true);
    expect(one.validate(independent)).toMatchObject({ ok: false, code: "invalid_output" });
  });

  it("the job prompt version wins over the series creation version, without rewriting that frozen input", () => {
    const { input, context, autoInput } = fixture(60);
    const oldInput: SeriesFrozenInput = { ...input, promptVersion: "ads.series-writing.prompt.v1" };
    const before = JSON.stringify(oldInput);
    const current = buildSeriesPrompt("arc", oldInput, context, autoInput, "ads.series-writing.prompt.v2");
    const legacy = buildSeriesPrompt("arc", input, context, autoInput, "ads.series-writing.prompt.v1");
    expect(current.user).toContain("提示版本：ads.series-writing.prompt.v2");
    expect(current.user).toContain("target.payoffEpisode < item.payoffEpisode");
    expect(legacy.user).toContain("提示版本：ads.series-writing.prompt.v1");
    expect(legacy.user).not.toContain("合法伏笔结构示例");
    expect(legacy.user).not.toContain("target.payoffEpisode < item.payoffEpisode");
    expect(legacy.user).toContain("依赖的伏笔必须严格早于本伏笔兑现");
    expect(JSON.stringify(oldInput)).toBe(before);
  });

  it("retains the exact v1 arc prompt for a frozen old job", () => {
    const { input, context, autoInput } = fixture(60);
    const legacy = buildSeriesPrompt("arc", input, context, autoInput, "ads.series-writing.prompt.v1");
    // Recorded from the unchanged 732c8aac prompt using this synthetic input, not from a live request.
    expect(createHash("sha256").update(JSON.stringify(legacy)).digest("hex")).toBe("e91e8956999e7bd3988254918357231ac009fadb1c28d87eb1b00bddf4de1aea");
  });

  it("adds the dependency guidance only to arc", () => {
    const { input, context, autoInput } = fixture(60);
    const current = buildSeriesPrompt("outline:1", input, { ...context, arc: fixture(60).arc([]) }, autoInput);
    expect(current.user).not.toContain("合法伏笔结构示例");
    expect(current.user).not.toContain("target.payoffEpisode < item.payoffEpisode");
  });
});

describe("the existing arc dependency rules stay strict", () => {
  const base: SeriesArc["foreshadowing"] = [
    { id: "FS1", content: "旧信", plantEpisode: 1, payoffEpisode: 2, dependsOn: [] },
    { id: "FS2", content: "缺角", plantEpisode: 1, payoffEpisode: 3, dependsOn: ["FS1"] },
  ];

  it.each([3, 60])("N=%i: an earlier prerequisite and independent foreshadowing remain valid", (n) => {
    const { validate } = fixture(n);
    expect(validate(base).ok).toBe(true);
    expect(validate(base.map((item) => ({ ...item, dependsOn: [] }))).ok).toBe(true);
    // Array/number order does not determine dependency order.
    expect(validate([...base].reverse()).ok).toBe(true);
    expect(validate([
      { ...base[0]!, id: "FS16" },
      { ...base[1]!, id: "FS1", dependsOn: ["FS16"] },
    ]).ok).toBe(true);
  });

  it.each([
    ["same episode", 2],
    ["later episode", 3],
  ] as const)("refuses a prerequisite paid in the %s", (_label, payoffEpisode) => {
    const foreshadowing = [{ ...base[0]!, payoffEpisode }, { ...base[1]!, payoffEpisode: 2 }];
    expect(fixture(60).validate(foreshadowing)).toMatchObject({
      ok: false, code: "plan_structure", field: "foreshadowing[1].dependsOn", detail: "dependency_not_paid_earlier",
    });
  });

  it.each(["FS2", "FS9"])("still refuses a self or unknown reference %s", (dependency) => {
    expect(fixture(60).validate([base[0]!, { ...base[1]!, dependsOn: [dependency] }])).toMatchObject({
      ok: false, code: "dangling_reference", field: "foreshadowing[1].dependsOn",
    });
  });

  it("a three-item cycle is refused even though every identifier exists", () => {
    expect(fixture(60).validate([
      { ...base[0]!, dependsOn: ["FS3"] },
      base[1]!,
      { id: "FS3", content: "邮戳", plantEpisode: 1, payoffEpisode: 4, dependsOn: ["FS2"] },
    ])).toMatchObject({ ok: false, code: "plan_structure", field: "foreshadowing[0].dependsOn", detail: "dependency_not_paid_earlier" });
  });

  it("reproduces the live error signature with a synthetic fifth item, without claiming to recover the answer", () => {
    const foreshadowing: SeriesArc["foreshadowing"] = Array.from({ length: 5 }, (_, index) => ({
      id: `FS${String(index + 1)}`, content: "合成伏笔", plantEpisode: 1, payoffEpisode: 10, dependsOn: index === 4 ? ["FS1"] : [],
    }));
    expect(fixture(60).validate(foreshadowing)).toMatchObject({
      ok: false, code: "plan_structure", field: "foreshadowing[4].dependsOn", detail: "dependency_not_paid_earlier",
    });
  });
});
