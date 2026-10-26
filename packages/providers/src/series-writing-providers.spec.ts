import { describe, expect, it } from "vitest";
import {
  AUTO_CREATION_PROMPT_VERSION,
  AUTO_VIEWING_DURATION_REASONS,
  SERIES_PROMPT_MAX_CHARS,
  SERIES_WRITING_CHECKS_VERSION,
  SERIES_WRITING_PROMPT_VERSION,
  AUTO_REFERENCE_CATALOG_VERSION,
  autoCreationJsonSchema,
  autoErrorParts,
  type AutoReferenceEntry,
  type AutoResearch,
  type AutoSourcesOutput,
  seriesJsonSchema,
  seriesNormalCalls,
} from "@ai-drama/contracts";
import { ANTHROPIC_MESSAGES_URL, ANTHROPIC_THINKING_HEADROOM_TOKENS, DEEPSEEK_CHAT_COMPLETIONS_URL, OPENAI_RESPONSES_URL, TEXT_WRITING_MAX_OUTPUT_TOKENS, claudeJsonSchema } from "./text-writing";
import { AUTO_REFERENCE_CATALOG_BLOCK, autoReferenceCatalogOf } from "@ai-drama/domain";
import { autoFixtureBlock } from "./auto-creation-fixtures";
import { ALL, seriesSetup } from "./series-writing-test-kit";
import type { SeriesFixtureExchange } from "./series-writing-fixtures";

/**
 * What OpenAI, Claude and DeepSeek would actually receive, built by the real adapters and intercepted by the transport
 * (no network, no real model service): the schema of each stage, the versions, the scope of each prompt and the limits.
 */

function sentSchema(exchange: SeriesFixtureExchange): Record<string, unknown> {
  const body = exchange.body as { text?: { format: { schema: Record<string, unknown> } }; output_config?: { format: { schema: Record<string, unknown> } };
    messages?: Array<{ role: string; content: string }> };
  if (body.text) return body.text.format.schema;
  if (body.output_config) return body.output_config.format.schema;
  const system = body.messages!.find((message) => message.role === "system")!.content;
  return JSON.parse(system.slice(system.indexOf("JSON Schema：\n") + "JSON Schema：\n".length)) as Record<string, unknown>;
}

describe("the requests the real adapters build for a series", () => {
  it.each([
    ["openai", OPENAI_RESPONSES_URL],
    ["anthropic", ANTHROPIC_MESSAGES_URL],
    ["deepseek", DEEPSEEK_CHAT_COMPLETIONS_URL],
  ] as const)("%s: every stage carries its own schema, the frozen model, the series versions and the output limit", async (providerKey, url) => {
    const { seen, view, grant, snapshot } = await seriesSetup({ episodes: 7, providerKey });
    await grant(ALL(7));
    expect((await view()).completion).toBe("text_complete");
    expect(seen).toHaveLength(seriesNormalCalls(7));
    // The borrowed research's catalog: the one of the plan job's saved snapshot, and the one its prompt carried.
    const plan = (await snapshot()).jobs.find((job) => job.run.kind === "plan")!;
    const saved = autoReferenceCatalogOf(plan.stages.find((stage) => stage.stageKey === "sources")!.output as unknown as AutoSourcesOutput)!;
    expect(saved.entries.length).toBeGreaterThan(0);
    for (const exchange of seen) {
      expect(exchange.url).toBe(url);
      const research = exchange.stage === "research" || exchange.stage === "directions";
      if (exchange.stage === "research") {
        const entries = autoFixtureBlock(exchange.user, AUTO_REFERENCE_CATALOG_BLOCK) as AutoReferenceEntry[];
        expect(entries).toEqual(saved.entries);
        expect({ version: AUTO_REFERENCE_CATALOG_VERSION, entries, hash: saved.hash }).toEqual(saved);
      }
      const expected = research
        ? autoCreationJsonSchema(exchange.stage as "research" | "directions", 7, exchange.stage === "research" ? "limited" : null,
          exchange.stage === "research" ? saved : null).schema
        : seriesJsonSchema(exchange.stage, 7).schema;
      expect(sentSchema(exchange)).toEqual(providerKey === "anthropic" ? claudeJsonSchema(expected) : expected);
      const body = exchange.body as Record<string, unknown>;
      expect(body.model).toBe("m-1");
      if (providerKey === "openai") expect(body).toMatchObject({ max_output_tokens: TEXT_WRITING_MAX_OUTPUT_TOKENS, store: false, text: { format: { strict: true } } });
      if (providerKey === "anthropic") expect(body.max_tokens).toBe(TEXT_WRITING_MAX_OUTPUT_TOKENS + ANTHROPIC_THINKING_HEADROOM_TOKENS);
      if (providerKey === "deepseek") expect(body).toMatchObject({ max_tokens: TEXT_WRITING_MAX_OUTPUT_TOKENS, response_format: { type: "json_object" }, stream: false });
      expect(exchange.user.length + exchange.system.length).toBeLessThanOrEqual(SERIES_PROMPT_MAX_CHARS);
      if (research) expect(exchange.user).toContain(`提示版本：${AUTO_CREATION_PROMPT_VERSION}`);
      else if (exchange.stage.includes("review")) expect(exchange.user).toContain(SERIES_WRITING_CHECKS_VERSION);
      else expect(exchange.user).toContain(`提示版本：${SERIES_WRITING_PROMPT_VERSION}`);
      // No key, token or connection string ever enters a prompt.
      expect(exchange.user + exchange.system).not.toMatch(/sk-|postgres:\/\/|Bearer/u);
    }
  });

  it("each prompt reads only its own scope: one episode's neighbours, one batch's texts, and no episode text in the final review", async () => {
    const { seen, grant } = await seriesSetup({ episodes: 12 });
    await grant(ALL(12));
    const episode5 = seen.find((item) => item.stage === "episode:5")!.user;
    expect(episode5).toContain("第4集《");
    expect(episode5).toContain("第6集《");
    expect(episode5).not.toContain("第7集《");
    expect(episode5).not.toContain("第1集《");
    expect(episode5).toContain("全剧共 12 集");
    expect(episode5).toContain("每集计划篇幅约 60 秒");
    const batch2 = seen.find((item) => item.stage === "batch_review:2")!.user;
    expect([4, 5, 6].every((number) => batch2.includes(`<<<待审：episode:${String(number)}`))).toBe(true);
    expect(batch2).not.toContain("<<<待审：episode:3");
    expect(batch2).toContain("完整阅读本批每一集的当前正文");
    const final = seen.find((item) => item.stage === "final_review")!.user;
    expect(final).toContain("不读取各集正文");
    expect(final).not.toContain("<<<待审：episode:");
    expect(final).toContain("第12集：");
    const plan = seen.find((item) => item.stage === "plan_review")!.user;
    expect(Array.from({ length: 12 }, (_, index) => plan.includes(`第${String(index + 1)}集《`)).every(Boolean)).toBe(true);
  });
});

describe("hypothesis fields (shared prompt v8) in a series: the borrowed research names them; the strict contract still refuses an extra one", () => {
  // The real series run (DeepSeek, 60 × 60 s, plan + episodes 1–3, budget 19) was refused at its first research call as
  // invalid_output@hypotheses[3]:unrecognized_keys; its answer was not kept. The double's `extra` field is SYNTHETIC.
  it("a new series freezes the shared prompt version; DeepSeek gets the limited schema (three fields, no others) and the field lines", async () => {
    const { seen, snapshot, grant, store } = await seriesSetup({ providerKey: "deepseek" });
    expect((await snapshot()).series.input.researchContract.promptVersion).toBe("ads.auto-creation.prompt.v10");
    expect(AUTO_CREATION_PROMPT_VERSION).toBe("ads.auto-creation.prompt.v10");
    await grant({ plan: true, batchFrom: 1, batchTo: 1, final: false });
    // The legal answer keeps the normal flow: plan + episodes 1–3 is 19 calls.
    expect(store.calls).toHaveLength(19);
    const research = seen.find((item) => item.stage === "research")!;
    expect(research.url).toBe(DEEPSEEK_CHAT_COMPLETIONS_URL);
    const schema = sentSchema(research);
    const plan = (await snapshot()).jobs.find((job) => job.run.kind === "plan")!;
    const saved = autoReferenceCatalogOf(plan.stages.find((stage) => stage.stageKey === "sources")!.output as unknown as AutoSourcesOutput)!;
    expect(schema).toEqual(autoCreationJsonSchema("research", 60, "limited", saved).schema);
    expect((schema as { properties: { hypotheses: { items: Record<string, unknown> } } }).properties.hypotheses.items)
      .toMatchObject({ additionalProperties: false, required: ["id", "statement", "howToVerify"] });
    expect(research.user).toContain("提示版本：ads.auto-creation.prompt.v10");
    expect(research.user).toContain("每条假设是一个对象，只包含 id、statement、howToVerify 三个字段，三个都必填");
    expect(research.user).toContain('假设对象示例（只示意格式，内容按本次创作写）：{"id":"H1",');
    const stored = store.stages.find((item) => item.stageKey === "research")!.output as { serverRecord: { executedWith: Record<string, string> } };
    expect(stored.serverRecord.executedWith).toMatchObject({ promptVersion: "ads.auto-creation.prompt.v10", checksVersion: "ads.auto-creation.checks.v11",
      researchSchema: "ads.auto-creation.research.v4" });
  });

  it("60 × 60 s, plan + episodes 1–3, budget 19: a synthetic extra field on hypotheses[3] is sent once, refused whole, stored nowhere, nothing after it", async () => {
    const { seen, grant, store, main } = await seriesSetup({ providerKey: "deepseek", plan: { auto: { extraHypothesisField: true } } });
    await grant({ plan: true, batchFrom: 1, batchTo: 1, final: false });
    const code = "invalid_output@hypotheses[3]:unrecognized_keys";
    expect(store.grants[0]).toMatchObject({ callBudget: 19, callsUsed: 1, input: { resendAllowance: 0 } });
    expect(store.calls.map((call) => call.errorCode)).toEqual([code]);
    expect(store.stages.find((item) => item.stageKey === "research")).toMatchObject({ state: "rejected", errorCode: code, output: null });
    expect(JSON.stringify({ calls: store.calls, stages: store.stages, grants: store.grants })).not.toContain("合成多余字段");
    await main.maintain();
    expect(seen.map((item) => item.stage)).toEqual(["research"]);
    expect(store.calls).toHaveLength(1);
  });
});

describe("a verification plan's sample in a series (checks v8; synthetic plans, not the real refused answer)", () => {
  it("60 × 60 s, plan + episodes 1–3: a plan to read a three-episode sample passes research and the 19-call flow completes", async () => {
    const { grant, store, snapshot } = await seriesSetup({ providerKey: "deepseek", plan: { auto: { verificationSample: "sample" } } });
    expect((await snapshot()).series.input.researchContract.checksVersion).toBe("ads.auto-creation.checks.v11");
    await grant({ plan: true, batchFrom: 1, batchTo: 1, final: false });
    expect(store.calls).toHaveLength(19);
    const stored = store.stages.find((item) => item.stageKey === "research")!.output as { hypotheses: Array<{ howToVerify: string }>; serverRecord: { executedWith: Record<string, string> } };
    expect(stored.hypotheses[0]!.howToVerify).toBe("模型替身样例：计划制作三集样稿进行试读并收集反馈。");
    expect(stored.serverRecord.executedWith).toMatchObject({ checksVersion: "ads.auto-creation.checks.v11" });
  });

  it.each([
    ["a share after the sample", "statistic", "unsourced_number@hypotheses[0].howToVerify:percent+market_statistic+proportion", "七成"],
    ["the work cut to two", "total", "constraint_violation@hypotheses[0].howToVerify:chinese_numeral+frozen_conflict+episode_count", "改为两集"],
  ] as const)("60 × 60 s, budget 19: %s is sent once, refused, stored nowhere, nothing after it", async (_label, sample, code, text) => {
    const { seen, grant, store, main } = await seriesSetup({ providerKey: "deepseek", plan: { auto: { verificationSample: sample } } });
    await grant({ plan: true, batchFrom: 1, batchTo: 1, final: false });
    expect(store.grants[0]).toMatchObject({ callBudget: 19, callsUsed: 1, input: { resendAllowance: 0 } });
    expect(store.calls.map((call) => call.errorCode)).toEqual([code]);
    expect(store.stages.find((item) => item.stageKey === "research")).toMatchObject({ state: "rejected", errorCode: code, output: null });
    expect(JSON.stringify({ calls: store.calls, stages: store.stages, grants: store.grants })).not.toContain(text);
    await main.maintain();
    expect(seen.map((item) => item.stage)).toEqual(["research"]);
    expect(store.calls).toHaveLength(1);
  });
});

describe("the scope of a count of episodes in a series' verification plan (checks v11; synthetic plans, not the real refused answer)", () => {
  it.each([
    ["the first three read, no 样稿", "reading", "模型替身样例：计划试读前三集并收集反馈。", []],
    ["testers asked to watch the first three", "unconfirmed", "模型替身样例：计划请试看者看完前三集再收集反馈。", [{ field: "hypotheses[0].howToVerify", rule: "episode_scope_unconfirmed" }]],
  ] as const)("60 × 60 s, plan + episodes 1–3: %s passes research as written and the 19-call flow completes", async (_label, sample, text, notices) => {
    const { grant, store, snapshot } = await seriesSetup({ providerKey: "deepseek", plan: { auto: { verificationSample: sample } } });
    expect((await snapshot()).series.input.researchContract).toMatchObject({ promptVersion: "ads.auto-creation.prompt.v10", checksVersion: "ads.auto-creation.checks.v11" });
    await grant({ plan: true, batchFrom: 1, batchTo: 1, final: false });
    expect(store.calls).toHaveLength(19);
    const stored = store.stages.find((item) => item.stageKey === "research")!.output as AutoResearch;
    expect(stored.hypotheses[0]!.howToVerify).toBe(text);
    expect(stored.unverified).toMatchObject(notices);
    expect(stored.unverified).toHaveLength(notices.length);
  });

  it("60 × 60 s, budget 19: a reading of episode 61 is sent once, refused as out of range, stored nowhere, nothing after it", async () => {
    const code = "constraint_violation@hypotheses[0].howToVerify:chinese_numeral+frozen_conflict+sample_out_of_range";
    const { seen, grant, store, main } = await seriesSetup({ providerKey: "deepseek", plan: { auto: { verificationSample: "outside" } } });
    await grant({ plan: true, batchFrom: 1, batchTo: 1, final: false });
    expect(store.grants[0]).toMatchObject({ callBudget: 19, callsUsed: 1, input: { resendAllowance: 0 } });
    expect(store.calls.map((call) => call.errorCode)).toEqual([code]);
    expect(store.stages.find((item) => item.stageKey === "research")).toMatchObject({ state: "rejected", errorCode: code, output: null });
    expect(JSON.stringify({ calls: store.calls, stages: store.stages, grants: store.grants })).not.toContain("第六十一集");
    await main.maintain();
    expect(seen.map((item) => item.stage)).toEqual(["research"]);
  });
});

describe("which check refused a viewing time, in a series (diagnostics only; synthetic texts, not a real refused answer)", () => {
  it.each(AUTO_VIEWING_DURATION_REASONS)("60 × 60 s, budget 19: viewing time %s in application.why is sent once, its branch kept in the code, no text or detail stored", async (reason) => {
    const { seen, grant, store, main } = await seriesSetup({ providerKey: "deepseek", plan: { auto: { viewingDurationWhy: reason } } });
    await grant({ plan: true, batchFrom: 1, batchTo: 1, final: false });
    const code = `unsourced_number@contentStructure[0].application.why:digits+market_statistic+viewing_duration+${reason}`;
    expect(store.grants[0]).toMatchObject({ callBudget: 19, callsUsed: 1, input: { resendAllowance: 0 } });
    expect(store.calls.map((call) => call.errorCode)).toEqual([code]);
    expect(store.stages.find((item) => item.stageKey === "research")).toMatchObject({ state: "rejected", errorCode: code, output: null });
    expect(autoErrorParts(code).reason).toBe(reason);
    const kept = JSON.stringify({ calls: store.calls, stages: store.stages, grants: store.grants });
    expect(kept).not.toContain("模型替身样例：");
    expect(kept).not.toContain('"detail"');
    await main.maintain();
    expect(seen.map((item) => item.stage)).toEqual(["research"]);
    expect(store.calls).toHaveLength(1);
  });
});
