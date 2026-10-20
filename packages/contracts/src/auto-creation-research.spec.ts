import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AUTO_CREATION_RESEARCH_SCHEMA,
  AUTO_CREATION_RESEARCH_SCHEMA_V1,
  AUTO_CREATION_RESEARCH_SCHEMA_V2,
  AUTO_RESEARCH_SERVER_KEYS,
  AUTO_STRUCTURE_QUOTE_MAX,
  AUTO_UNVERIFIED_NOTE,
  autoCreationJsonSchema,
  autoNoticePlace,
  autoNoticeText,
  autoResearchAnswerSchema,
  autoResearchV1Schema,
  autoResearchV2Schema,
  autoStructureViews,
  autoUnverifiedOf,
} from "./auto-creation";

type Json = { type?: string | string[]; properties?: Record<string, Json>; required?: string[]; items?: Json; anyOf?: Json[]; enum?: unknown[];
  maxLength?: number; minItems?: number; maxItems?: number; additionalProperties?: boolean };

/** The keys, nesting and nullability of a zod schema, as the provider JSON Schema must have them. */
function zodShape(schema: z.ZodType): unknown {
  if (schema instanceof z.ZodNullable) return { nullable: zodShape(schema.unwrap() as z.ZodType) };
  if (schema instanceof z.ZodObject) {
    return Object.fromEntries(Object.entries(schema.shape as Record<string, z.ZodType>).map(([key, value]) => [key, zodShape(value)]));
  }
  if (schema instanceof z.ZodArray) return [zodShape(schema.element as z.ZodType)];
  return "leaf";
}

function jsonShape(schema: Json): unknown {
  if (schema.anyOf) {
    const object = schema.anyOf.find((item) => item.type !== "null")!;
    expect(schema.anyOf.some((item) => item.type === "null")).toBe(true);
    return { nullable: jsonShape(object) };
  }
  if (schema.type === "object") {
    expect(schema.additionalProperties).toBe(false);
    expect([...schema.required!].sort()).toEqual(Object.keys(schema.properties!).sort());
    return Object.fromEntries(Object.entries(schema.properties!).map(([key, value]) => [key, jsonShape(value)]));
  }
  if (schema.type === "array") return [jsonShape(schema.items!)];
  return "leaf";
}

/** A research v3 answer: what a model sends from prompt v5 on. */
const v3 = {
  schema: AUTO_CREATION_RESEARCH_SCHEMA,
  facts: [], observations: [],
  hypotheses: [{ id: "H1", statement: "观众可能偏爱一集内兑现。", howToVerify: "计划上线后观察七天。" }],
  audience: { primary: "成年观众（假设）", viewingNeeds: ["看到结果"], emotionalAppeals: ["扳回一局"], basis: "hypothesis", sourceIds: [] },
  contentStructure: [
    { reference: { sourceId: "S-KB-CRAFT", quote: "关键结果来自主角的选择和行动" }, application: { pattern: "计划用两次反转推动主角主动选择。", why: "创作设计。" } },
    { reference: null, application: { pattern: "三名骑手被迫合作。", why: "自主设计。" } },
  ],
  opportunities: ["小人物反击"],
};
/** The same research as v2 stored it: the model also wrote the gaps and the settings. */
const v2 = { ...v3, schema: AUTO_CREATION_RESEARCH_SCHEMA_V2, limitations: ["没有市场数据"], appliedConstraints: [] };

describe("research v3 answer contract", () => {
  it("the answer carries no settings, gaps or notices: a model sending any server key is refused, never stripped", () => {
    expect(autoResearchAnswerSchema.parse(v3)).toEqual(v3);
    for (const key of AUTO_RESEARCH_SERVER_KEYS) {
      const result = autoResearchAnswerSchema.safeParse({ ...v3, [key]: key === "serverRecord" ? { origin: "server_record" } : [] });
      expect(result.success, key).toBe(false);
      expect(result.error?.issues[0]).toMatchObject({ code: "unrecognized_keys", keys: [key] });
    }
    // A stored v2 research is no answer either, and a v3 answer is no stored v2.
    expect(autoResearchAnswerSchema.safeParse(v2).success).toBe(false);
    expect(autoResearchV2Schema.safeParse(v3).success).toBe(false);
    const json = autoCreationJsonSchema("research", 1).schema as Json;
    expect(Object.keys(json.properties!)).not.toContain("limitations");
    expect(Object.keys(json.properties!)).not.toContain("appliedConstraints");
  });

  it("a notice is named by its place for a reader; outputs before checks v5 have none", () => {
    // By position; never an id made from the index (a research needs unique ids, not ids in order).
    expect(autoNoticePlace("hypotheses[0].statement")).toBe("第1条假设");
    expect(autoNoticePlace("hypotheses[1].howToVerify")).toBe("第2条假设的验证计划");
    // With the research, the model's own id is kept beside the position.
    const research = { hypotheses: [{ id: "H3" }, { id: "H1" }] };
    expect(autoNoticePlace("hypotheses[0].statement", research)).toBe("第1条假设（H3）");
    expect(autoNoticePlace("hypotheses[1].howToVerify", research)).toBe("第2条假设（H1）的验证计划");
    expect(autoNoticePlace("contentStructure[2].application.why")).toBe("第3条内容结构的本剧应用设计");
    expect(autoNoticePlace("opportunities[0]")).toBe("第1条机会");
    // A direction keeps its id: the directions check holds the ids to D1, D2… in order.
    expect(autoNoticePlace("candidates[1].difficultyNote")).toBe("方向 D2 的难度说明");
    const notice = { origin: "server_check", field: "opportunities[0]", token: "五十元", semantic: "unclassified", rule: "no_role", note: AUTO_UNVERIFIED_NOTE } as const;
    expect(autoNoticeText(notice)).toBe("第1条机会中的「五十元」：程序未能判定数字含义，未核实；只属于创作假设或设计，不是有来源的事实或市场结论。");
    expect(autoUnverifiedOf({ ...v3, unverified: [notice] })).toEqual([notice]);
    expect(autoUnverifiedOf(v2)).toEqual([]);
    expect(autoUnverifiedOf(null)).toEqual([]);
  });
});

describe("research v2 structure contract (kept by v3)", () => {
  it("the provider JSON Schema has the zod schema's keys, nesting and nullable reference, every object closed", () => {
    const json = autoCreationJsonSchema("research", 1).schema as Json;
    expect(jsonShape(json)).toEqual(zodShape(autoResearchAnswerSchema));
    expect(json.properties!.schema!.enum).toEqual([AUTO_CREATION_RESEARCH_SCHEMA]);
    const item = json.properties!.contentStructure!;
    expect([item.minItems, item.maxItems]).toEqual([1, 6]);
    expect(item.items!.properties!.reference!.anyOf![0]!.properties!.quote!.maxLength).toBe(AUTO_STRUCTURE_QUOTE_MAX);
  });

  it("a v3 answer parses; the v1 item shape, a missing reference or a mixed item does not", () => {
    expect(autoResearchAnswerSchema.safeParse(v3).success).toBe(true);
    const item = (value: unknown) => autoResearchAnswerSchema.safeParse({ ...v3, contentStructure: [value] }).success;
    expect(item({ pattern: "p", why: "w", sourceIds: ["S-KB-CRAFT"] })).toBe(false);
    expect(item({ application: { pattern: "p", why: "w" } })).toBe(false);
    expect(item({ reference: null, application: { pattern: "p", why: "w" }, sourceIds: [] })).toBe(false);
    expect(item({ reference: { sourceId: "S-KB-CRAFT", quote: "关键结果来自主角的选择和行动", why: "w" }, application: { pattern: "p", why: "w" } })).toBe(false);
    expect(autoResearchAnswerSchema.safeParse({ ...v3, schema: AUTO_CREATION_RESEARCH_SCHEMA_V1 }).success).toBe(false);
  });

  it("stored v1 and v2 research still parse as stored and are viewed as stored, with no quote made up", () => {
    expect(autoResearchV2Schema.parse(v2)).toEqual(v2);
    const v1 = { ...v2, schema: AUTO_CREATION_RESEARCH_SCHEMA_V1, contentStructure: [{ pattern: "主角主动", why: "知识库要求", sourceIds: ["S-KB-CRAFT"] }] };
    expect(autoResearchV1Schema.parse(v1)).toEqual(v1);
    expect(autoStructureViews(autoResearchV1Schema.parse(v1))).toEqual([{ version: "v1", pattern: "主角主动", why: "知识库要求", sourceIds: ["S-KB-CRAFT"] }]);
    expect(autoStructureViews(autoResearchV2Schema.parse(v2)).map((view) => view.version === "v2" && view.reference)).toEqual([
      { sourceId: "S-KB-CRAFT", quote: "关键结果来自主角的选择和行动" }, null]);
  });
});
