import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AUTO_CREATION_RESEARCH_ANSWER_SCHEMA,
  AUTO_CREATION_RESEARCH_SCHEMA,
  AUTO_CREATION_RESEARCH_SCHEMA_V1,
  AUTO_CREATION_RESEARCH_SCHEMA_V2,
  AUTO_CREATION_RESEARCH_SCHEMA_V3,
  AUTO_RESEARCH_LIMITED_FORBIDDEN,
  AUTO_RESEARCH_SERVER_KEYS,
  AUTO_RESEARCH_STRUCTURE_SERVER_KEYS,
  autoAssembleLimitedResearch,
  autoCreationJsonSchema,
  autoResearchAnswerSchema,
  autoResearchAnswerSchemaFor,
  autoResearchCatalogAnswerSchema,
  autoResearchCatalogAnswerSchemaFor,
  autoResearchHasServerRecord,
  autoResearchLimitedCatalogAnswerSchema,
  autoResearchLimitedAnswerSchema,
  autoResearchMarketEvidence,
  type AutoReferenceCatalog,
  type AutoStoredResearch,
} from "./auto-creation";

/**
 * Research v4: the answer contract follows the run's saved research mode. limited is AI creative planning (hypotheses,
 * the proposed audience as text, structures, opportunities); sourced keeps v3's cited findings. The provider's JSON
 * Schema and the zod check are built from the same mode. Every sample is synthetic.
 */

type Json = { type?: string | string[]; properties?: Record<string, Json>; required?: string[]; items?: Json; anyOf?: Json[]; enum?: unknown[];
  additionalProperties?: boolean };

function zodShape(schema: z.ZodType): unknown {
  if (schema instanceof z.ZodNullable) return { nullable: zodShape(schema.unwrap() as z.ZodType) };
  if (schema instanceof z.ZodObject) {
    return Object.fromEntries(Object.entries(schema.shape as Record<string, z.ZodType>).map(([key, value]) => [key, zodShape(value)]));
  }
  if (schema instanceof z.ZodArray) return [zodShape(schema.element as z.ZodType)];
  return "leaf";
}

function jsonShape(schema: Json): unknown {
  if (schema.anyOf) return { nullable: jsonShape(schema.anyOf.find((item) => item.type !== "null")!) };
  if (schema.type === "object") {
    expect(schema.additionalProperties).toBe(false);
    expect([...schema.required!].sort()).toEqual(Object.keys(schema.properties!).sort());
    return Object.fromEntries(Object.entries(schema.properties!).map(([key, value]) => [key, jsonShape(value)]));
  }
  if (schema.type === "array") return [jsonShape(schema.items!)];
  return "leaf";
}

/** Every key path of a JSON Schema's objects (audience.basis, contentStructure[].reference.quote). */
function jsonPaths(schema: Json, at = ""): string[] {
  if (schema.anyOf) return schema.anyOf.flatMap((item) => jsonPaths(item, at));
  if (schema.type === "array") return jsonPaths(schema.items!, `${at}[]`);
  if (schema.type !== "object") return [];
  return Object.entries(schema.properties!).flatMap(([key, value]) => {
    const path = at ? `${at}.${key}` : key;
    return [path, ...jsonPaths(value, path)];
  });
}

/** A legal limited answer (synthetic). */
const limited = {
  schema: AUTO_CREATION_RESEARCH_SCHEMA,
  hypotheses: [{ id: "H1", statement: "碎片时间的观众可能偏爱一集内兑现。", howToVerify: "计划上线后观察七天。" }],
  audience: { primary: "拟面向通勤时刷剧的成年观众（待验证）", viewingNeeds: ["一集内看到结果"], emotionalAppeals: ["扳回一局"] },
  contentStructure: [
    { reference: { sourceId: "S-KB-CRAFT", quote: "关键结果来自主角的选择和行动" }, application: { pattern: "计划用两次反转推动主角主动选择。", why: "创作设计。" } },
    { reference: null, application: { pattern: "三名骑手被迫合作。", why: "自主设计。" } },
  ],
  opportunities: ["小人物反击"],
};

/** A synthetic reference catalog (the domain cuts real ones from a run's snapshot). */
const CATALOG: AutoReferenceCatalog = { version: "ads.auto-creation.reference-catalog.v1", hash: "h", entries: [
  { referenceId: "R-0a1b2c3d4e", sourceId: "S-KB-CRAFT", quote: "关键结果来自主角的选择和行动，不靠旁人突然解围。" },
  { referenceId: "R-5f6a7b8c9d", sourceId: "S-KB-CRAFT", quote: "反转要有前文依据；" },
] };

describe("research v4: one mode builds the provider schema and the zod check", () => {
  it("the limited JSON Schema is the limited model answer schema (prompt v9): no facts, observations or audience basis and sources anywhere", () => {
    const sent = autoCreationJsonSchema("research", 1, "limited", CATALOG);
    expect(sent.name).toBe("auto_research_limited");
    expect(jsonShape(sent.schema as Json)).toEqual(zodShape(autoResearchLimitedCatalogAnswerSchema));
    const paths = jsonPaths(sent.schema as Json);
    for (const forbidden of [...AUTO_RESEARCH_LIMITED_FORBIDDEN, ...AUTO_RESEARCH_SERVER_KEYS]) expect(paths, forbidden).not.toContain(forbidden);
    expect(paths).not.toContain("audience.basis");
    expect(paths).toContain("contentStructure[].referenceId");
    for (const key of AUTO_RESEARCH_STRUCTURE_SERVER_KEYS) expect(paths, key).not.toContain(`contentStructure[].${key}`);
    expect(paths).toContain("hypotheses[].howToVerify");
    expect((sent.schema as Json).properties!.schema!.enum).toEqual([AUTO_CREATION_RESEARCH_ANSWER_SCHEMA]);
  });

  it("the sourced JSON Schema is the sourced model answer schema, findings and audience sources kept", () => {
    const sent = autoCreationJsonSchema("research", 1, "sourced", CATALOG);
    expect(sent.name).toBe("auto_research_sourced");
    expect(jsonShape(sent.schema as Json)).toEqual(zodShape(autoResearchCatalogAnswerSchema));
    expect(jsonPaths(sent.schema as Json)).toEqual(expect.arrayContaining(["facts", "observations", "audience.basis", "audience.sourceIds", "facts[].evidence"]));
  });

  it.each(["limited", "sourced"] as const)("%s: a structure's referenceId is one of the catalog's ids or null, nothing else; an empty catalog leaves null only", (mode) => {
    const id = (catalog: AutoReferenceCatalog) => ((autoCreationJsonSchema("research", 1, mode, catalog).schema as Json)
      .properties!.contentStructure!.items!.properties!.referenceId!);
    expect(id(CATALOG)).toEqual({ anyOf: [{ type: "string", enum: ["R-0a1b2c3d4e", "R-5f6a7b8c9d"] }, { type: "null" }] });
    expect(id({ ...CATALOG, entries: [] })).toEqual({ type: "null" });
  });

  it("no research schema is built without a mode or a catalog: none is assumed", () => {
    expect(() => autoCreationJsonSchema("research", 1)).toThrow(/research mode/u);
    expect(() => autoCreationJsonSchema("research", 1, null, CATALOG)).toThrow(/research mode/u);
    expect(() => autoCreationJsonSchema("research", 1, "limited")).toThrow(/reference catalog/u);
    expect(() => autoCreationJsonSchema("research", 1, "sourced", null)).toThrow(/reference catalog/u);
    // Other stages need none.
    expect(autoCreationJsonSchema("directions", 1).name).toBe("auto_directions");
    expect(autoResearchAnswerSchemaFor("limited")).toBe(autoResearchLimitedAnswerSchema);
    expect(autoResearchAnswerSchemaFor("sourced")).toBe(autoResearchAnswerSchema);
    expect(autoResearchCatalogAnswerSchemaFor("limited")).toBe(autoResearchLimitedCatalogAnswerSchema);
    expect(autoResearchCatalogAnswerSchemaFor("sourced")).toBe(autoResearchCatalogAnswerSchema);
  });
});

describe("the model answer of prompt v9 is apart from the stored research v4", () => {
  const answer = { ...limited, schema: AUTO_CREATION_RESEARCH_ANSWER_SCHEMA, contentStructure: [
    { referenceId: "R-0a1b2c3d4e", application: { pattern: "计划用两次反转推动主角主动选择。", why: "创作设计。" } },
    { referenceId: null, application: { pattern: "三名骑手被迫合作。", why: "自主设计。" } },
  ] };

  it("a legal model answer parses as written; it is no stored research, and a stored research is no model answer", () => {
    expect(autoResearchLimitedCatalogAnswerSchema.parse(answer)).toEqual(answer);
    expect(autoResearchLimitedAnswerSchema.safeParse(answer).success).toBe(false);
    expect(autoResearchLimitedCatalogAnswerSchema.safeParse(limited).success).toBe(false);
    expect(autoResearchLimitedCatalogAnswerSchema.safeParse({ ...answer, schema: AUTO_CREATION_RESEARCH_SCHEMA }).success).toBe(false);
  });

  it.each([
    ...AUTO_RESEARCH_STRUCTURE_SERVER_KEYS.map((key) => [key, { [key]: null }] as const),
    ["reference", { reference: { sourceId: "S-KB-CRAFT", quote: "关键结果来自主角的选择和行动，不靠旁人突然解围。" } }],
    ["quote", { quote: "关键结果来自主角的选择和行动，不靠旁人突然解围。" }],
  ] as const)("a model-written %s beside the id is refused whole, even null, never stripped", (key, extra) => {
    for (const schema of [autoResearchLimitedCatalogAnswerSchema, autoResearchCatalogAnswerSchema]) {
      const value = schema === autoResearchCatalogAnswerSchema ? { ...answer, facts: [], observations: [], audience: { ...answer.audience, basis: "hypothesis", sourceIds: [] } } : answer;
      const result = schema.safeParse({ ...value, contentStructure: [{ ...value.contentStructure[0]!, ...extra }] });
      expect(result.success, key).toBe(false);
      expect(result.error?.issues[0]).toMatchObject({ code: "unrecognized_keys", path: ["contentStructure", 0], keys: [key] });
    }
  });

  it("a missing referenceId is refused, never read as null", () => {
    expect(autoResearchLimitedCatalogAnswerSchema.safeParse({ ...answer, contentStructure: [{ application: { pattern: "p", why: "w" } }] }).success).toBe(false);
  });
});

describe("research v4 limited: strict, assembled by the server only after it passed", () => {
  it("a legal limited answer parses as written", () => {
    expect(autoResearchLimitedAnswerSchema.parse(limited)).toEqual(limited);
  });

  it.each([
    ["facts", { ...limited, facts: [] }, [], ["facts"]],
    ["observations", { ...limited, observations: [] }, [], ["observations"]],
    ["audience.basis", { ...limited, audience: { ...limited.audience, basis: "hypothesis" } }, ["audience"], ["basis"]],
    ["audience.sourceIds", { ...limited, audience: { ...limited.audience, sourceIds: [] } }, ["audience"], ["sourceIds"]],
    ...AUTO_RESEARCH_SERVER_KEYS.map((key) => [key, { ...limited, [key]: [] }, [], [key]] as const),
  ] as const)("%s is refused even empty or default, never stripped", (_name, value, path, keys) => {
    const result = autoResearchLimitedAnswerSchema.safeParse(value);
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "unrecognized_keys", path, keys })]));
  });

  it("the server writes what a limited research has none of; nothing of the answer is dropped or moved", () => {
    const stored = autoAssembleLimitedResearch(autoResearchLimitedAnswerSchema.parse(limited));
    expect(stored).toEqual({ ...limited, facts: [], observations: [], audience: { ...limited.audience, basis: "hypothesis", sourceIds: [] } });
    expect(autoResearchAnswerSchema.parse(stored)).toEqual(stored);
  });

  it("a sourced answer is no limited answer, and a limited answer is no sourced one", () => {
    expect(autoResearchLimitedAnswerSchema.safeParse(autoAssembleLimitedResearch(limited as never)).success).toBe(false);
    expect(autoResearchAnswerSchema.safeParse(limited).success).toBe(false);
  });
});

describe("history: v3 is a server-recorded research, v1 and v2 are not; only v4 records market evidence", () => {
  const record = { origin: "server_record", settings: { origin: "user_setting", items: [] },
    material: { origin: "source_snapshot", researchMode: "limited", read: [], unread: [], gaps: [] } };
  const base = autoAssembleLimitedResearch(limited as never);
  const v4 = { ...base, unverified: [], serverRecord: { ...record, executedWith: { promptVersion: "p", checksVersion: "c", researchSchema: AUTO_CREATION_RESEARCH_SCHEMA,
    answerContract: "limited" }, marketEvidence: { origin: "source_snapshot", status: "unavailable", note: "市场证据不可用" } } } as AutoStoredResearch;
  const v3 = { ...base, schema: AUTO_CREATION_RESEARCH_SCHEMA_V3, unverified: [],
    serverRecord: { ...record, executedWith: { promptVersion: "ads.auto-creation.prompt.v5", checksVersion: "ads.auto-creation.checks.v5", researchSchema: AUTO_CREATION_RESEARCH_SCHEMA_V3 } } } as AutoStoredResearch;
  const v2 = { ...base, schema: AUTO_CREATION_RESEARCH_SCHEMA_V2, limitations: ["x"], appliedConstraints: [] } as AutoStoredResearch;
  const v1 = { ...v2, schema: AUTO_CREATION_RESEARCH_SCHEMA_V1 } as AutoStoredResearch;

  it("v3 is never read as v1 or v2 (it has no limitations to show) and its record is the server's", () => {
    expect([v4, v3, v2, v1].map(autoResearchHasServerRecord)).toEqual([true, true, false, false]);
    expect(AUTO_CREATION_RESEARCH_SCHEMA_V3).toBe("ads.auto-creation.research.v3");
    expect(AUTO_CREATION_RESEARCH_SCHEMA).toBe("ads.auto-creation.research.v4");
  });

  it("market evidence is v4's record alone: older research is read as it was, never given one", () => {
    expect(autoResearchMarketEvidence(v4)).toMatchObject({ status: "unavailable" });
    expect([v3, v2, v1].map(autoResearchMarketEvidence)).toEqual([null, null, null]);
  });
});
