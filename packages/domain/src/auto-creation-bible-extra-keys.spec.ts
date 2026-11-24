import { describe, expect, it } from "vitest";
import {
  AUTO_CREATION_CHECKS_VERSION,
  AUTO_CREATION_PROMPT_VERSION,
  autoBibleSchema,
  autoCreationConstraintsSchema,
  type AutoBible,
  type AutoCreationFrozenInput,
} from "@ai-drama/contracts";
import { collectSources } from "./auto-creation-sources";
import { autoReferenceCatalogOf } from "./auto-creation-references";
import { validateAutoStageOutput, type AutoCreationContext } from "./auto-creation";

/**
 * checks.v17: bible answers whose only schema problem is unrecognized keys are normalized (keys dropped) and saved
 * when the strict schema and checkBible then pass. Research still refuses extra keys without stripping. Synthetic
 * samples only — the live bible failure (runId ded73174…) did not retain the rejected body or key names.
 */

const NOW = "2026-11-17T00:00:00.000Z";

function input(overrides: Partial<AutoCreationFrozenInput> = {}): AutoCreationFrozenInput {
  return {
    schema: "ads.auto-creation.input.v1",
    promptVersion: AUTO_CREATION_PROMPT_VERSION,
    selectionRules: "ads.auto-creation.selection-rules.v1",
    checksVersion: AUTO_CREATION_CHECKS_VERSION,
    idea: "",
    constraints: autoCreationConstraintsSchema.parse({}),
    materials: [],
    referenceUrls: [],
    researchFetch: false,
    episodeCount: 1,
    episodeSeconds: 60,
    revisionRounds: 0,
    callBudget: 6,
    maxOutputTokens: 4096,
    providerKey: "deepseek",
    model: "deepseek-flash",
    authorization: { mode: "auto", proof: "site_session", initiatedBy: "a", executor: "auto-creation-engine" },
    ...overrides,
  };
}

function context(frozen = input()): AutoCreationContext {
  const sources = collectSources(frozen, [], NOW);
  return { sources, referenceCatalog: autoReferenceCatalogOf(sources), episodes: new Map(), reviews: [] };
}

/** A legal bible matching autoBibleSchema (same shape as the prompt example). */
function legalBible(overrides: Record<string, unknown> = {}): AutoBible {
  return {
    schema: "ads.auto-creation.bible.v1",
    title: "补发回执",
    logline: "维修员发现一张手写回执能证明自己按时交件。",
    synopsis: "客户质疑维修员迟交。维修员找到客户签收的回执，据此补发交件记录，解开误会。",
    story: {
      protagonistId: "C1",
      desire: "守住客户的信任",
      weakness: "怕当面解释",
      goal: "证明自己按时交件",
      stakes: "客户会取消下一单",
      obstacles: ["系统没有交件记录"],
      keyChoices: [{ choice: "翻查旧单据", consequence: "找到客户手写的签收回执" }],
      twist: { reveal: "被当作废纸的回执上有签收时间", setups: ["开场时维修员把一张折角的单据夹进账本"] },
      payoffs: ["维修员主动向客户说明原委"],
      ending: "维修员补发交件记录，客户保留下次预约。",
      causalChain: ["系统缺少交件记录", "维修员翻出签收回执", "客户核对时间并保留预约"],
    },
    characters: [
      { id: "C1", name: "阿宁", identity: "维修员", goal: "证明按时交件", weakness: "怕解释", motivation: "守住信誉", voice: "说话直接", presence: "on_screen" },
      { id: "C2", name: "老陈", identity: "客户", goal: "核对交件时间", weakness: "只信记录", motivation: "怕耽误用货", voice: "先问时间", presence: "mentioned" },
    ],
    relationships: [{ from: "C1", to: "C2", relation: "维修员与客户", change: "从质疑到恢复信任" }],
    locations: [{ id: "L1", name: "修理铺", intExt: "INT", timeOfDay: "日", layout: "账本放在工作台左边", productionNotes: "用窗边自然光" }],
    props: [{ id: "P1", name: "签收回执", ownerId: "C1", purpose: "证明交件时间", change: "从旧单据变成证据" }],
    ...overrides,
  } as AutoBible;
}

const check = (body: unknown, frozen = input()) => validateAutoStageOutput("bible", JSON.stringify(body), frozen, context(frozen));

describe("checks.v17 bible unrecognized top-level keys", () => {
  it("names the current checks version", () => {
    expect(AUTO_CREATION_CHECKS_VERSION).toBe("ads.auto-creation.checks.v19");
  });

  it("a legal bible still passes and is saved as written", () => {
    const bible = legalBible();
    const result = check(bible);
    expect(result).toMatchObject({ ok: true, output: bible });
    expect(result.ok && result.output).not.toHaveProperty("ending");
  });

  it("a synthetic top-level ending beside story.ending is stripped, then saved without that key", () => {
    const bible = legalBible();
    const withExtra = { ...bible, ending: "合成顶层结局字段，契约不允许。" };
    expect(autoBibleSchema.safeParse(withExtra).success).toBe(false);
    expect(autoBibleSchema.safeParse(withExtra).error?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "unrecognized_keys", keys: ["ending"] })]),
    );

    const result = check(withExtra);
    expect(result).toMatchObject({ ok: true, output: bible });
    expect(result.ok && result.output).not.toHaveProperty("ending");
    // Values of dropped keys are not echoed on the validation result.
    expect(JSON.stringify(result)).not.toContain("合成顶层结局字段");
  });

  it("several top-level extras alone are stripped together and saved", () => {
    const bible = legalBible();
    const withExtra = { ...bible, ending: "多余结局", notes: "多余备注", selectedDirection: "D1" };
    const result = check(withExtra);
    expect(result).toMatchObject({ ok: true, output: bible });
    expect(result.ok && result.output).toEqual(bible);
  });

  it("a nested unrecognized key alone is stripped and saved", () => {
    const bible = legalBible();
    const withExtra = {
      ...bible,
      story: { ...bible.story, epilogue: "合成 story 内多余字段" },
    };
    const result = check(withExtra);
    expect(result).toMatchObject({ ok: true, output: bible });
    expect(result.ok && (result.output as AutoBible).story).not.toHaveProperty("epilogue");
  });

  it("missing required fields are still refused (not repaired by stripping)", () => {
    const { title: _title, ...missingTitle } = legalBible();
    expect(check(missingTitle)).toMatchObject({ ok: false, code: "invalid_output", category: "invalid_type" });
  });

  it("a type error is still refused even when an extra key is also present", () => {
    const bible = legalBible();
    const bad = { ...bible, title: 12, ending: "多余" };
    expect(check(bad)).toMatchObject({ ok: false, code: "invalid_output" });
    expect(check(bad).ok).toBe(false);
  });

  it("checkBible failures still refuse after extras are stripped", () => {
    const frozen = input({ constraints: autoCreationConstraintsSchema.parse({ maxCharacters: 1 }) });
    const bible = legalBible();
    // Two on_screen characters exceed maxCharacters=1; top-level ending is only an extra key.
    const overCast = {
      ...bible,
      ending: "多余结局",
      characters: bible.characters.map((item) => ({ ...item, presence: "on_screen" as const })),
    };
    expect(check(overCast, frozen)).toMatchObject({ ok: false, code: "constraint_violation", detail: "maxCharacters" });
  });

  it("research still refuses unrecognized keys without stripping (no regression)", () => {
    const research = {
      schema: "ads.auto-creation.research.answer.catalog.v1",
      hypotheses: [{ id: "H1", statement: "碎片时间的观众可能更愿意看一集内有明确兑现的故事。", howToVerify: "计划上线后观察七天再判断。" }],
      audience: { primary: "拟面向通勤时刷剧的成年观众（待验证）", viewingNeeds: ["一集内看到结果"], emotionalAppeals: ["扳回一局"] },
      contentStructure: [{ referenceId: null, application: { pattern: "主角主动选择推动结果", why: "自主创作设计。" } }],
      opportunities: ["小人物在一个夜晚完成一次反击"],
      ending: "研究阶段不允许的顶层字段",
    };
    const result = validateAutoStageOutput("research", JSON.stringify(research), input(), context());
    expect(result).toMatchObject({ ok: false, code: "invalid_output", category: "unrecognized_keys" });
    expect(result).not.toHaveProperty("output");
  });
});
