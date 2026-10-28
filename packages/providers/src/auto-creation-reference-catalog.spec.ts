import { describe, expect, it } from "vitest";
import {
  AUTO_CREATION_RESEARCH_ANSWER_SCHEMA,
  autoCreationConstraintsSchema,
  autoCreationHardCap,
  autoCreationInitialStageKeys,
  autoCreationJsonSchema,
  autoCreationNormalCalls,
  type AutoReferenceEntry,
  type AutoResearch,
  type AutoSourcesOutput,
  type TitleWritingProviderKey,
} from "@ai-drama/contracts";
import {
  AUTO_REFERENCE_CATALOG_BLOCK, OCEAN_ENGINE_ENTRY_URLS, autoPackageJson, autoPackageMarkdown, autoReferenceCatalog, autoReferenceCatalogOf, autoResearchModeOf, collectSources,
  validateAutoStageOutput, type FetchedPage,
} from "@ai-drama/domain";
import { claudeJsonSchema, titleWritingProviderConfigs, type WritingTransport } from "./text-writing";
import { AutoCreationEngine, InMemoryAutoCreationStore, autoRunView, hashAutoResume, newAutoRun } from "./auto-creation-engine";
import { AUTO_FIXTURE_CRAFT_SENTENCE, AUTO_FIXTURE_UNKNOWN_REFERENCE_ID, autoFixtureBlock, autoFixtureTransport, type AutoFixtureExchange, type AutoFixturePlan } from "./auto-creation-fixtures";
import { seriesSetup } from "./series-writing-test-kit";

/**
 * The reference catalog in the requests the real adapters build (prompt v9, checks v10; model double only, no network,
 * every answer the double's synthetic sample). The prompt, the JSON Schema actually sent and the check of the answer
 * all carry the one catalog of the run's saved snapshot; an id it lacks is sent once and refused whole.
 */

const WS = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222222";
const START = Date.parse("2026-10-26T00:00:00Z");
const NOW_ISO = new Date(START).toISOString();
const PROVIDERS = titleWritingProviderConfigs({
  OPENAI_API_KEY: "sk-openai-test-0123456789", TITLE_WRITING_OPENAI_MODELS: "m-1",
  ANTHROPIC_API_KEY: "sk-ant-api03-test-secret-0123456789", TITLE_WRITING_ANTHROPIC_MODELS: "m-1",
  DEEPSEEK_API_KEY: "sk-deepseek-test-0123456789", TITLE_WRITING_DEEPSEEK_MODELS: "m-1",
});
const MARKET_PAGE: FetchedPage = { url: OCEAN_ENGINE_ENTRY_URLS[0], status: "read", title: "合成市场样本页",
  text: "合成样本：本页只描述题材趋势，没有统计数字。", publishedAt: "2026-09-01T00:00:00.000Z", fetchedAt: NOW_ISO, note: "合成样本" };

async function setup(options: { providerKey?: TitleWritingProviderKey; plan?: AutoFixturePlan; sourced?: boolean; callBudget?: number;
  override?: NonNullable<Parameters<typeof autoFixtureTransport>[0]>["override"] } = {}) {
  const store = new InMemoryAutoCreationStore();
  store.addProject(WS, P1, 1);
  const run = newAutoRun({
    workspaceId: WS, projectId: P1, actorId: "server-owner", idempotencyKey: "key-1", idea: "", constraints: autoCreationConstraintsSchema.parse({}),
    materials: [{ title: "拍摄笔记", kind: "notes", text: "主角每一场都要主动出手。反派从不解释动机。", rightsConfirmed: true }], referenceUrls: [],
    researchFetch: options.sourced ?? false, episodeCount: 1, episodeSeconds: 60, revisionRounds: 0, callBudget: options.callBudget ?? 6, providerKey: options.providerKey ?? "deepseek",
    model: "m-1", authorization: { mode: "auto", proof: "site_session", initiatedBy: "server-owner", executor: "auto-creation-engine" }, now: new Date(START),
  });
  expect((await store.createRun(run, autoCreationInitialStageKeys(1), { maxActiveRuns: 1, sinceIso: new Date(START - 86_400_000).toISOString(),
    maxCallsPerDay: 100, requiredCalls: autoCreationNormalCalls(1) })).kind).toBe("created");
  const seen: AutoFixtureExchange[] = [];
  const bodies: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fixture = autoFixtureTransport({ plan: options.plan, seen, override: options.override });
  const transport: WritingTransport = async (request) => {
    bodies.push({ url: request.url, body: JSON.parse(request.body) as Record<string, unknown> });
    return fixture(request);
  };
  const engine = new AutoCreationEngine({ workspaceId: WS, store, providers: PROVIDERS, maxCallsPerDay: 100, clock: () => new Date(START), transport, leaseMs: 240_000,
    ...(options.sourced ? { fetchPages: async (urls: readonly string[]) => urls.filter((url) => url === MARKET_PAGE.url).map(() => MARKET_PAGE),
      defaultResearchUrls: OCEAN_ENGINE_ENTRY_URLS } : {}) });
  const bundle = async () => (await store.getRunById(WS, run.id))!;
  const sources = async () => (await bundle()).stages.find((stage) => stage.stageKey === "sources")!.output as AutoSourcesOutput;
  return { store, run, engine, seen, bodies, bundle, sources, view: async () => autoRunView(await bundle()) };
}

function sentSchema(sent: { body: Record<string, unknown> }): Record<string, unknown> {
  const body = sent.body as { text?: { format: { schema: Record<string, unknown> } }; output_config?: { format: { schema: Record<string, unknown> } };
    messages?: Array<{ role: string; content: string }> };
  if (body.text) return body.text.format.schema;
  if (body.output_config) return body.output_config.format.schema;
  const system = body.messages!.find((message) => message.role === "system")!.content;
  return JSON.parse(system.slice(system.indexOf("JSON Schema：\n") + "JSON Schema：\n".length)) as Record<string, unknown>;
}

describe("A. OpenAI, Claude and DeepSeek: the prompt, the JSON Schema sent and the check carry one catalog", () => {
  it.each([
    ["openai", false], ["anthropic", false], ["deepseek", false], ["openai", true], ["anthropic", true], ["deepseek", true],
  ] as const)("%s (sourced: %s): the request carries the saved snapshot's catalog; the legal answer completes the six-call run", async (providerKey, sourced) => {
    const { run, engine, seen, bodies, sources, view } = await setup({ providerKey, sourced });
    await engine.drive(run.id);
    const mode = sourced ? "sourced" : "limited";
    expect(await view()).toMatchObject({ state: "completed", researchMode: mode, callsUsed: 6 });
    const catalog = autoReferenceCatalogOf(await sources())!;
    expect(catalog.entries.map((entry) => entry.sourceId)).toEqual(expect.arrayContaining(["S-KB-CRAFT", "S-USER-1"]));
    // The prompt: exactly the catalog's entries.
    expect(autoFixtureBlock(seen[0]!.user, AUTO_REFERENCE_CATALOG_BLOCK)).toEqual(catalog.entries);
    expect(seen[0]!.user).toContain(`schema 固定为 "${AUTO_CREATION_RESEARCH_ANSWER_SCHEMA}"`);
    // The JSON Schema the adapter actually carried: built from the same catalog (Claude's adapter drops what it does not take).
    const expected = autoCreationJsonSchema("research", 1, mode, catalog).schema;
    expect(sentSchema(bodies[0]!)).toEqual(providerKey === "anthropic" ? claudeJsonSchema(expected) : expected);
    const referenceId = (sentSchema(bodies[0]!) as { properties: { contentStructure: { items: { properties: { referenceId: { anyOf: Array<{ enum?: string[] }> } } } } } })
      .properties.contentStructure.items.properties.referenceId;
    expect(referenceId.anyOf[0]!.enum).toEqual(catalog.entries.map((entry) => entry.referenceId));
    // The check: the stored research names the same catalog and holds the passage word for word.
    const research = (await view()).stages.find((stage) => stage.stageKey === "research")!.output as AutoResearch;
    expect(research.contentStructure[0]!.reference).toEqual({ sourceId: "S-KB-CRAFT", quote: AUTO_FIXTURE_CRAFT_SENTENCE });
    expect(research.serverRecord.executedWith).toMatchObject({ answerSchema: AUTO_CREATION_RESEARCH_ANSWER_SCHEMA, referenceCatalogHash: catalog.hash });
  });
});

describe("B. an id the catalog lacks, or a model-written quote: sent once, refused whole, kept nowhere, nothing after it", () => {
  const other = autoReferenceCatalog(collectSources({ ...newAutoRun({
    workspaceId: WS, projectId: P1, actorId: "a", idempotencyKey: "k", idea: "", constraints: autoCreationConstraintsSchema.parse({}),
    materials: [{ title: "另一份笔记", kind: "notes", text: "另一份笔记里的方法：反派每次出场都要逼主角做选择。", rightsConfirmed: true }], referenceUrls: [],
    researchFetch: false, episodeCount: 1, episodeSeconds: 60, revisionRounds: 0, callBudget: 6, providerKey: "deepseek", model: "m-1",
    authorization: { mode: "auto", proof: "site_session", initiatedBy: "a", executor: "auto-creation-engine" }, now: new Date(START) }).input }, [], NOW_ISO))
    .entries.find((entry) => entry.sourceId === "S-USER-1")!.referenceId;

  it.each([
    ["a made-up id", { referenceId: AUTO_FIXTURE_UNKNOWN_REFERENCE_ID }, "unknown_reference@contentStructure[0].referenceId", AUTO_FIXTURE_UNKNOWN_REFERENCE_ID],
    ["another catalog's id", { referenceId: other }, "unknown_reference@contentStructure[0].referenceId", other],
    ["its own quote beside a valid id", { structureServerField: "quote" }, "invalid_output@contentStructure[0].quote:unrecognized_keys", null],
    ["its own source beside a valid id", { structureServerField: "sourceId" }, "invalid_output@contentStructure[0].sourceId:unrecognized_keys", null],
    ["a quote of its own in the old shape", { forgedQuote: true }, "invalid_output@contentStructure[0].reference:unrecognized_keys", "反转次数以两次为最佳"],
  ] as const)("%s", async (_label, plan, code, text) => {
    for (const sourced of [false, true]) {
      const { run, engine, seen, view } = await setup({ plan, sourced });
      await engine.drive(run.id);
      const result = await view();
      expect(result).toMatchObject({ state: "failed", callsUsed: 1 });
      expect(result.stages.find((stage) => stage.stageKey === "research")).toMatchObject({ state: "rejected", errorCode: code, output: null });
      expect(result.calls.map((call) => call.errorCode)).toEqual([code]);
      // Neither the answer's text nor the refused id (a detail) is stored anywhere.
      expect(JSON.stringify(result)).not.toContain("模型替身样例");
      if (text) expect(JSON.stringify(result)).not.toContain(text);
      await engine.maintain();
      await engine.drive(run.id);
      expect(seen.map((item) => item.stage)).toEqual(["research"]);
    }
  });

  it("the stored error keeps the earlier diagnostics' shape: the rule and the field only", async () => {
    const { run, engine, view } = await setup({ plan: { referenceId: AUTO_FIXTURE_UNKNOWN_REFERENCE_ID } });
    await engine.drive(run.id);
    expect((await view()).errorCode).toBe("unknown_reference");
  });
});

describe("C. a series of 60 × 60 s (plan + episodes 1–3, budget 19): the borrowed research chooses from its own snapshot's catalog", () => {
  it("the legal answer keeps the 19-call flow; the request carries the plan job's catalog", async () => {
    const { seen, grant, store, snapshot } = await seriesSetup({ providerKey: "deepseek" });
    await grant({ plan: true, batchFrom: 1, batchTo: 1, final: false });
    expect(store.calls).toHaveLength(19);
    const plan = (await snapshot()).jobs.find((job) => job.run.kind === "plan")!;
    const saved = plan.stages.find((stage) => stage.stageKey === "sources")!.output as unknown as AutoSourcesOutput;
    expect(autoResearchModeOf(saved)).toBe("limited");
    const catalog = autoReferenceCatalogOf(saved)!;
    const research = seen.find((item) => item.stage === "research")!;
    expect(autoFixtureBlock(research.user, AUTO_REFERENCE_CATALOG_BLOCK) as AutoReferenceEntry[]).toEqual(catalog.entries);
    const stored = store.stages.find((item) => item.stageKey === "research")!.output as unknown as AutoResearch;
    expect(stored.contentStructure[0]!.reference).toEqual({ sourceId: "S-KB-CRAFT", quote: AUTO_FIXTURE_CRAFT_SENTENCE });
    expect(stored.serverRecord.executedWith).toMatchObject({ answerSchema: AUTO_CREATION_RESEARCH_ANSWER_SCHEMA, referenceCatalogHash: catalog.hash });
  });

  it.each([
    ["a made-up id", { referenceId: AUTO_FIXTURE_UNKNOWN_REFERENCE_ID }, "unknown_reference@contentStructure[0].referenceId"],
    ["its own quote beside a valid id", { structureServerField: "quote" as const }, "invalid_output@contentStructure[0].quote:unrecognized_keys"],
  ] as const)("%s is sent once, refused, stored nowhere, nothing after it", async (_label, auto, code) => {
    const { seen, grant, store, main } = await seriesSetup({ providerKey: "deepseek", plan: { auto } });
    await grant({ plan: true, batchFrom: 1, batchTo: 1, final: false });
    expect(store.grants[0]).toMatchObject({ callBudget: 19, callsUsed: 1, input: { resendAllowance: 0 } });
    expect(store.calls.map((call) => call.errorCode)).toEqual([code]);
    expect(store.stages.find((item) => item.stageKey === "research")).toMatchObject({ state: "rejected", errorCode: code, output: null });
    const kept = JSON.stringify({ calls: store.calls, stages: store.stages, grants: store.grants });
    expect(kept).not.toContain(AUTO_FIXTURE_UNKNOWN_REFERENCE_ID);
    expect(kept).not.toContain("模型替身样例");
    await main.maintain();
    expect(seen.map((item) => item.stage)).toEqual(["research"]);
    expect(store.calls).toHaveLength(1);
  });
});

describe("D. the check takes the catalog of the context it is given, never another", () => {
  it("an answer valid for one snapshot's catalog is refused against another's", () => {
    const base = newAutoRun({ workspaceId: WS, projectId: P1, actorId: "a", idempotencyKey: "k", idea: "", constraints: autoCreationConstraintsSchema.parse({}),
      materials: [{ title: "拍摄笔记", kind: "notes", text: "主角每一场都要主动出手。反派从不解释动机。", rightsConfirmed: true }], referenceUrls: [], researchFetch: false,
      episodeCount: 1, episodeSeconds: 60, revisionRounds: 0, callBudget: 6, providerKey: "deepseek", model: "m-1",
      authorization: { mode: "auto", proof: "site_session", initiatedBy: "a", executor: "auto-creation-engine" }, now: new Date(START) }).input;
    const mine = collectSources(base, [], NOW_ISO);
    const theirs = collectSources({ ...base, materials: [] }, [], NOW_ISO);
    const id = autoReferenceCatalog(mine).entries.find((entry) => entry.sourceId === "S-USER-1")!.referenceId;
    const content = JSON.stringify({ schema: AUTO_CREATION_RESEARCH_ANSWER_SCHEMA,
      hypotheses: [{ id: "H1", statement: "合成样本：主角主动出手可能更抓人。", howToVerify: "计划请试看者复述主角的选择。" }],
      audience: { primary: "拟面向通勤时刷剧的成年观众（待验证）", viewingNeeds: ["看到结果"], emotionalAppeals: ["扳回一局"] },
      contentStructure: [{ referenceId: id, application: { pattern: "主角每场主动出手。", why: "方法。" } }], opportunities: ["小人物反击"] });
    const context = (sources: AutoSourcesOutput) => ({ sources, referenceCatalog: autoReferenceCatalog(sources), episodes: new Map(), reviews: [] });
    expect(validateAutoStageOutput("research", content, base, context(mine))).toMatchObject({ ok: true });
    expect(validateAutoStageOutput("research", content, base, context(theirs))).toMatchObject({ ok: false, code: "unknown_reference" });
  });
});

describe("E. history: a research v4 completed under prompt v8 (a quote the model wrote) is read, shown and exported as it was", () => {
  it("the run continues without resending it; its frozen input, hash, quote and record stay; packages read it as stored; a replay sends nothing", async () => {
    let failDirections = true;
    const { store, run, engine, seen, bundle } = await setup({ callBudget: autoCreationHardCap(1, 0),
      override: (stage) => stage === "directions" && failDirections ? { status: 400, body: { error: "bad" } } : undefined });
    await engine.drive(run.id);
    const stored = store.runs.find((item) => item.id === run.id)!;
    Object.assign(stored.input, { promptVersion: "ads.auto-creation.prompt.v8", checksVersion: "ads.auto-creation.checks.v9" });
    const research = store.stages.find((stage) => stage.runId === run.id && stage.stageKey === "research")!;
    // As prompt v8 stored it: a quote the model copied out (no catalog sentence), no answer schema or catalog in the record.
    const old = structuredClone(research.output) as AutoResearch;
    old.contentStructure[0]!.reference = { sourceId: "S-KB-CRAFT", quote: "关键结果来自主角的选择和行动" };
    old.serverRecord.executedWith = { promptVersion: "ads.auto-creation.prompt.v8", checksVersion: "ads.auto-creation.checks.v9",
      researchSchema: "ads.auto-creation.research.v4", answerContract: "limited" };
    research.output = old;
    const frozen = JSON.stringify(stored.input);
    const hash = stored.inputHash;
    failDirections = false;
    const sent = seen.length;
    expect((await store.prepareResume(WS, P1, run.id, { resumeKey: "r", requestHash: hashAutoResume(run.id, []), confirmedCallIds: [], maxActiveRuns: 5,
      providerReady: true, blocked: false }, NOW_ISO)).kind).toBe("ok");
    await engine.drive(run.id);
    expect(seen.slice(sent).map((item) => item.stage)).toEqual(["directions", "bible", "outline", "episode:1", "review:1"]);
    expect(seen.slice(sent)[0]!.user).toContain("\"参考方法原文\":{\"sourceId\":\"S-KB-CRAFT\",\"quote\":\"关键结果来自主角的选择和行动\"}");
    const after = await bundle();
    expect(after.stages.find((stage) => stage.stageKey === "research")!.output).toEqual(old);
    expect(JSON.stringify(after.run.input)).toBe(frozen);
    expect(after.run.inputHash).toBe(hash);
    const meta = { runId: run.id, projectId: P1, input: after.run.input, quality: after.run.quality, state: after.run.state, callsUsed: after.run.callsUsed,
      callCap: after.run.callCap, revisionRoundsUsed: after.run.revisionRoundsUsed, storySave: after.run.storySave, generatedAt: NOW_ISO };
    expect(autoPackageMarkdown(meta, after.stages)).toContain("参考方法原文：S-KB-CRAFT「关键结果来自主角的选择和行动」");
    expect((autoPackageJson(meta, after.stages) as { research: { analysis: unknown } }).research.analysis).toEqual(old);
    // The same key again: nothing created, nothing sent.
    const again = await store.createRun({ ...run, id: crypto.randomUUID() }, autoCreationInitialStageKeys(1),
      { maxActiveRuns: 1, sinceIso: new Date(START - 86_400_000).toISOString(), maxCallsPerDay: 100, requiredCalls: 6 });
    expect(again).toMatchObject({ kind: "existing", bundle: { run: { id: run.id } } });
    const total = seen.length;
    await engine.maintain();
    expect(seen).toHaveLength(total);
  });
});
