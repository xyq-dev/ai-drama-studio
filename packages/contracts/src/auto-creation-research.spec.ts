import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AUTO_CREATION_RESEARCH_SCHEMA,
  AUTO_CREATION_RESEARCH_SCHEMA_V1,
  AUTO_STRUCTURE_QUOTE_MAX,
  autoCreationJsonSchema,
  autoResearchSchema,
  autoResearchV1Schema,
  autoStructureViews,
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

const v2 = {
  schema: AUTO_CREATION_RESEARCH_SCHEMA,
  facts: [], observations: [],
  hypotheses: [{ id: "H1", statement: "观众可能偏爱一集内兑现。", howToVerify: "计划上线后观察七天。" }],
  audience: { primary: "成年观众（假设）", viewingNeeds: ["看到结果"], emotionalAppeals: ["扳回一局"], basis: "hypothesis", sourceIds: [] },
  contentStructure: [
    { reference: { sourceId: "S-KB-CRAFT", quote: "关键结果来自主角的选择和行动" }, application: { pattern: "计划用两次反转推动主角主动选择。", why: "创作设计。" } },
    { reference: null, application: { pattern: "三名骑手被迫合作。", why: "自主设计。" } },
  ],
  opportunities: ["小人物反击"], limitations: ["没有市场数据"], appliedConstraints: [],
};

describe("research v2 contract", () => {
  it("the provider JSON Schema has the zod schema's keys, nesting and nullable reference, every object closed", () => {
    const json = autoCreationJsonSchema("research", 1).schema as Json;
    expect(jsonShape(json)).toEqual(zodShape(autoResearchSchema));
    expect(json.properties!.schema!.enum).toEqual([AUTO_CREATION_RESEARCH_SCHEMA]);
    const item = json.properties!.contentStructure!;
    expect([item.minItems, item.maxItems]).toEqual([1, 6]);
    expect(item.items!.properties!.reference!.anyOf![0]!.properties!.quote!.maxLength).toBe(AUTO_STRUCTURE_QUOTE_MAX);
  });

  it("a v2 answer parses; the v1 item shape, a missing reference or a mixed item does not", () => {
    expect(autoResearchSchema.safeParse(v2).success).toBe(true);
    const item = (value: unknown) => autoResearchSchema.safeParse({ ...v2, contentStructure: [value] }).success;
    expect(item({ pattern: "p", why: "w", sourceIds: ["S-KB-CRAFT"] })).toBe(false);
    expect(item({ application: { pattern: "p", why: "w" } })).toBe(false);
    expect(item({ reference: null, application: { pattern: "p", why: "w" }, sourceIds: [] })).toBe(false);
    expect(item({ reference: { sourceId: "S-KB-CRAFT", quote: "关键结果来自主角的选择和行动", why: "w" }, application: { pattern: "p", why: "w" } })).toBe(false);
    expect(autoResearchSchema.safeParse({ ...v2, schema: AUTO_CREATION_RESEARCH_SCHEMA_V1 }).success).toBe(false);
  });

  it("stored v1 research still parses as v1 and is viewed as stored, with no quote made up", () => {
    const v1 = { ...v2, schema: AUTO_CREATION_RESEARCH_SCHEMA_V1, contentStructure: [{ pattern: "主角主动", why: "知识库要求", sourceIds: ["S-KB-CRAFT"] }] };
    expect(autoResearchV1Schema.parse(v1)).toEqual(v1);
    expect(autoStructureViews(autoResearchV1Schema.parse(v1))).toEqual([{ version: "v1", pattern: "主角主动", why: "知识库要求", sourceIds: ["S-KB-CRAFT"] }]);
    expect(autoStructureViews(autoResearchSchema.parse(v2)).map((view) => view.version === "v2" && view.reference)).toEqual([
      { sourceId: "S-KB-CRAFT", quote: "关键结果来自主角的选择和行动" }, null]);
  });
});
