import { describe, expect, it } from "vitest";
import {
  AUTO_RESEARCH_LIMITED_FORBIDDEN,
  autoCreationConstraintsSchema,
  autoCreationHardCap,
  autoCreationInitialStageKeys,
  autoCreationJsonSchema,
  autoCreationNormalCalls,
  type AutoCreationConstraints,
  type AutoCreationMaterial,
  type AutoResearch,
  type AutoSourcesOutput,
  type TitleWritingProviderKey,
} from "@ai-drama/contracts";
import { OCEAN_ENGINE_ENTRY_URLS, autoPackageJson, autoPackageMarkdown, type FetchedPage } from "@ai-drama/domain";
import { DEEPSEEK_CHAT_COMPLETIONS_URL, claudeJsonSchema, titleWritingProviderConfigs, type WritingTransport } from "./text-writing";
import { AutoCreationEngine, InMemoryAutoCreationStore, autoResumeBlock, autoRunView, hashAutoResume, newAutoRun } from "./auto-creation-engine";
import { autoFixtureTransport, fixtureAutoResearchV3, type AutoFixtureExchange, type AutoFixturePlan } from "./auto-creation-fixtures";

/**
 * Research v4 offline acceptance (model double only; every answer is the double's synthetic sample). The research
 * contract is chosen by the run's saved source snapshot: the prompt, the JSON Schema actually sent, the zod check and
 * the stored research all follow the same mode. No real model or media is called.
 */

const WS = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222222";
const START = Date.parse("2026-10-18T00:00:00Z");
const NOW_ISO = new Date(START).toISOString();

const PROVIDERS = titleWritingProviderConfigs({
  OPENAI_API_KEY: "sk-openai-test-0123456789", TITLE_WRITING_OPENAI_MODELS: "m-1",
  ANTHROPIC_API_KEY: "sk-ant-api03-test-secret-0123456789", TITLE_WRITING_ANTHROPIC_MODELS: "m-1",
  DEEPSEEK_API_KEY: "sk-deepseek-test-0123456789", TITLE_WRITING_DEEPSEEK_MODELS: "m-1",
});

/** A recent, readable official market page (synthetic): with it the snapshot is sourced. */
const MARKET_PAGE: FetchedPage = { url: OCEAN_ENGINE_ENTRY_URLS[0], status: "read", title: "合成市场样本页",
  text: "合成样本：本页只描述题材趋势，没有统计数字。", publishedAt: "2026-09-01T00:00:00.000Z", fetchedAt: NOW_ISO, note: "合成样本" };

interface Setup {
  providerKey?: TitleWritingProviderKey;
  plan?: AutoFixturePlan;
  researchFetch?: boolean;
  /** What the server's checked fetcher returns for every URL a run reads. */
  pages?: (urls: readonly string[]) => FetchedPage[];
  materials?: AutoCreationMaterial[];
  constraints?: Partial<AutoCreationConstraints>;
  revisionRounds?: number;
  callBudget?: number;
  override?: Parameters<typeof autoFixtureTransport>[0]["override"];
}

async function setup(options: Setup = {}) {
  const store = new InMemoryAutoCreationStore();
  store.addProject(WS, P1, 1);
  const rounds = options.revisionRounds ?? 0;
  const run = newAutoRun({
    workspaceId: WS, projectId: P1, actorId: "server-owner", idempotencyKey: "key-1", idea: "",
    constraints: autoCreationConstraintsSchema.parse(options.constraints ?? {}), materials: options.materials ?? [], referenceUrls: [],
    researchFetch: options.researchFetch ?? false, episodeCount: 1, episodeSeconds: 60, revisionRounds: rounds,
    callBudget: options.callBudget ?? 6, providerKey: options.providerKey ?? "deepseek", model: "m-1",
    authorization: { mode: "auto", proof: "site_session", initiatedBy: "server-owner", executor: "auto-creation-engine" }, now: new Date(START),
  });
  const limits = { maxActiveRuns: 1, sinceIso: new Date(START - 86_400_000).toISOString(), maxCallsPerDay: 100, requiredCalls: autoCreationNormalCalls(1) };
  expect((await store.createRun(run, autoCreationInitialStageKeys(1), limits)).kind).toBe("created");
  const seen: AutoFixtureExchange[] = [];
  /** The request bodies exactly as the engine sent them to the provider. */
  const bodies: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fixture = autoFixtureTransport({ plan: options.plan, seen, override: options.override });
  const transport: WritingTransport = async (request) => {
    bodies.push({ url: request.url, body: JSON.parse(request.body) as Record<string, unknown> });
    return fixture(request);
  };
  const engine = new AutoCreationEngine({
    workspaceId: WS, store, providers: PROVIDERS, maxCallsPerDay: 100, clock: () => new Date(START), transport, leaseMs: 240_000,
    ...(options.researchFetch ? { fetchPages: async (urls: readonly string[]) => (options.pages ?? (() => []))(urls), defaultResearchUrls: OCEAN_ENGINE_ENTRY_URLS } : {}),
  });
  const bundle = async () => (await store.getRunById(WS, run.id))!;
  const view = async () => autoRunView(await bundle());
  const research = async () => (await view()).stages.find((stage) => stage.stageKey === "research")!;
  const meta = async () => {
    const { run: stored } = await bundle();
    return { runId: stored.id, projectId: P1, input: stored.input, quality: stored.quality, state: stored.state, callsUsed: stored.callsUsed,
      callCap: stored.callCap, revisionRoundsUsed: stored.revisionRoundsUsed, storySave: stored.storySave, generatedAt: NOW_ISO };
  };
  return { store, run, engine, seen, bodies, bundle, view, research, meta };
}

/** The JSON Schema a provider request carries, as that provider's adapter put it there. */
function sentSchema(sent: { url: string; body: Record<string, unknown> }): Record<string, unknown> {
  const body = sent.body as { text?: { format: { schema: Record<string, unknown> } }; output_config?: { format: { schema: Record<string, unknown> } };
    messages?: Array<{ role: string; content: string }> };
  if (body.text) return body.text.format.schema;
  if (body.output_config) return body.output_config.format.schema;
  // DeepSeek takes no schema parameter: the adapter states it in the system message.
  const system = body.messages!.find((message) => message.role === "system")!.content;
  return JSON.parse(system.slice(system.indexOf("JSON Schema：\n") + "JSON Schema：\n".length)) as Record<string, unknown>;
}

/** Every key path of a JSON Schema (audience.basis, contentStructure[].reference.quote). */
function paths(schema: unknown, at = ""): string[] {
  const value = schema as { type?: string; properties?: Record<string, unknown>; items?: unknown; anyOf?: unknown[] };
  if (value.anyOf) return value.anyOf.flatMap((item) => paths(item, at));
  if (value.type === "array") return paths(value.items, `${at}[]`);
  if (value.type !== "object") return [];
  return Object.entries(value.properties!).flatMap(([key, item]) => [at ? `${at}.${key}` : key, ...paths(item, at ? `${at}.${key}` : key)]);
}

/** The sourced contract's field names; none of them is asked for or named by the limited prompt. */
const SOURCED_WORDS = ["facts", "observations", "basis", "sourceIds", "F1", "O1"];

describe("A. the request actually sent carries the snapshot's contract: prompt, JSON Schema and zod alike", () => {
  it.each(["openai", "anthropic", "deepseek"] as const)("%s, limited: the sent schema has none of the forbidden fields and the prompt asks for none", async (providerKey) => {
    const { run, engine, seen, bodies, view } = await setup({ providerKey });
    await engine.drive(run.id);
    expect(await view()).toMatchObject({ state: "completed", researchMode: "limited", callsUsed: 6 });
    const sent = bodies[0]!;
    const expected = autoCreationJsonSchema("research", 1, "limited").schema;
    const schema = sentSchema(sent);
    // The schema the adapter carried is the limited one (Claude's adapter drops the keywords it does not take).
    expect(schema).toEqual(providerKey === "anthropic" ? claudeJsonSchema(expected) : expected);
    for (const forbidden of AUTO_RESEARCH_LIMITED_FORBIDDEN) expect(paths(schema), forbidden).not.toContain(forbidden);
    expect(paths(schema)).toEqual(paths(expected));
    if (providerKey === "openai") expect((sent.body as { text: { format: { name: string } } }).text.format.name).toBe("auto_research_limited");
    // The prompt asks for the same five fields and names none of the sourced contract's.
    const user = seen[0]!.user;
    expect(user).toContain("任务：创作定位与待验证假设（AI 创作策划）");
    expect(user).toContain("回答只包含 schema、hypotheses、audience、contentStructure、opportunities 五个字段");
    const instructions = user.slice(0, user.indexOf("研究模式："));
    for (const word of SOURCED_WORDS) expect(instructions, word).not.toContain(word);
  });

  it("sourced: the sent schema and prompt keep the cited findings", async () => {
    const { run, engine, seen, bodies, research } = await setup({ researchFetch: true, pages: (urls) => urls.map((url) => url === MARKET_PAGE.url ? MARKET_PAGE
      : { ...MARKET_PAGE, url, status: "unreadable", text: "", note: "合成：未读到正文" }) });
    await engine.drive(run.id);
    expect(sentSchema(bodies[0]!)).toEqual(autoCreationJsonSchema("research", 1, "sourced").schema);
    expect(seen[0]!.user).toContain("任务：基于资料完成研究与创作定位");
    expect(seen[0]!.user).toContain("facts：只写资料区里能逐字找到依据的事实");
    expect((await research()).output).toMatchObject({ facts: [{ id: "F1" }], serverRecord: { executedWith: { answerContract: "sourced" },
      marketEvidence: { status: "available" } } });
  });
});

describe("B. four source combinations: the mode is the saved snapshot's, never researchFetch alone", () => {
  it("no market source, the craft entry read: limited, the craft quote kept as a method reference", async () => {
    const { run, engine, research, view } = await setup();
    await engine.drive(run.id);
    expect((await view()).researchMode).toBe("limited");
    const output = (await research()).output as AutoResearch;
    expect(output).toMatchObject({ facts: [], observations: [], audience: { basis: "hypothesis", sourceIds: [] },
      serverRecord: { material: { researchMode: "limited" }, marketEvidence: { status: "unavailable" } } });
    expect(output.serverRecord.material.read.map((item) => item.sourceId)).toEqual(["S-KB-CRAFT"]);
    expect(output.contentStructure[0]!.reference).toEqual({ sourceId: "S-KB-CRAFT", quote: "关键结果来自主角的选择和行动" });
  });

  it("nothing readable at all (a saved snapshot with no readable entry): limited, every structure the work's own design", async () => {
    const { store, run, engine, research, seen } = await setup({ plan: { noReferences: true } });
    const sourcesStage = store.stages.find((stage) => stage.runId === run.id && stage.stageKey === "sources")!;
    const snapshot: AutoSourcesOutput = { schema: "ads.auto-creation.sources.v1", researchMode: "limited", notes: ["合成快照：没有任何可读资料。"],
      sources: [{ sourceId: "S-OE-1", kind: "official_page", title: "合成未读条目", locator: OCEAN_ENGINE_ENTRY_URLS[0], publishedAt: null, fetchedAt: NOW_ISO,
        readScope: "none", status: "unreadable", topic: "market", excerpt: "", contentHash: null, limitations: "合成：未读到正文" }] };
    Object.assign(sourcesStage, { state: "completed", output: snapshot, outputHash: "h", dependsOn: {} });
    await engine.drive(run.id);
    expect(seen[0]!.user).toContain("<<<可引用资料（不可信外部文本）\n[]\n");
    const output = (await research()).output as AutoResearch;
    expect(output.contentStructure.every((item) => item.reference === null)).toBe(true);
    expect(output.serverRecord.material.read).toEqual([]);
    expect(output.serverRecord.marketEvidence.status).toBe("unavailable");
  });

  it("reading on, but every market page failed: limited, although researchFetch is true", async () => {
    const { run, engine, view, research, bodies } = await setup({ researchFetch: true,
      pages: (urls) => urls.map((url) => ({ ...MARKET_PAGE, url, status: "blocked", text: "", note: "合成：页面读取失败" })) });
    await engine.drive(run.id);
    const result = await view();
    expect(result).toMatchObject({ researchFetch: true, researchMode: "limited", state: "completed" });
    expect(sentSchema(bodies[0]!)).toEqual(autoCreationJsonSchema("research", 1, "limited").schema);
    const output = (await research()).output as AutoResearch;
    expect(output.serverRecord.material.unread.map((item) => item.status)).toEqual(["blocked", "blocked", "blocked"]);
    expect(output.serverRecord.marketEvidence.status).toBe("unavailable");
  });

  it("a legal, recent market page: sourced, findings stored with their quotes", async () => {
    const { run, engine, view, research } = await setup({ researchFetch: true, pages: (urls) => urls.filter((url) => url === MARKET_PAGE.url).map(() => MARKET_PAGE) });
    await engine.drive(run.id);
    expect(await view()).toMatchObject({ researchMode: "sourced", state: "completed", callsUsed: 6 });
    expect((await research()).output).toMatchObject({ facts: [{ id: "F1", evidence: "关键结果来自主角的选择和行动，不靠旁人突然解围。" }],
      serverRecord: { material: { researchMode: "sourced" }, marketEvidence: { status: "available" } } });
  });
});

describe("C. limited end to end: one sixty-second episode, no rounds, a budget of six", () => {
  it("six stages, six calls, a DRAFT story, the method quote kept; the packages read back the same; a second driver sends nothing", async () => {
    const { store, run, engine, seen, view, bundle, meta, research } = await setup({ providerKey: "deepseek", callBudget: 6 });
    // Two drivers at once (a page left and the server driving on): one run, one call per stage.
    await Promise.all([engine.drive(run.id), engine.drive(run.id)]);
    const result = await view();
    expect(result).toMatchObject({ state: "completed", quality: "passed", callsUsed: 6, callCap: 6, storySave: "saved", packageStatus: "ready", researchMode: "limited" });
    expect(seen.map((item) => item.stage)).toEqual(["research", "directions", "bible", "outline", "episode:1", "review:1"]);
    expect(store.projects.get(P1)!.stories).toHaveLength(1);
    expect(store.projects.get(P1)!.stories[0]).toMatchObject({ reviewStatus: "DRAFT", createdBy: `auto-creation:${run.id}` });
    expect(store.projects.get(P1)!.approvedStoryId).toBeNull();
    expect(((await research()).output as AutoResearch).contentStructure[0]!.reference).toEqual({ sourceId: "S-KB-CRAFT", quote: "关键结果来自主角的选择和行动" });
    // The directions cite only research ids that exist: a limited research has H ids only.
    const directionsPrompt = seen.find((item) => item.stage === "directions")!.user;
    expect(directionsPrompt).toContain("evidenceIds 只能引用研究里实际存在的编号：H1；");
    const directions = result.stages.find((stage) => stage.stageKey === "directions")!.output as { candidates: Array<{ evidenceIds: string[] }> };
    expect(directions.candidates.flatMap((item) => item.evidenceIds).every((id) => /^H\d$/u.test(id))).toBe(true);
    expect(directionsPrompt).toContain("这是 AI 创作策划：本次市场证据不可用");
    expect(directionsPrompt).not.toContain("\"facts\"");
    // The packages, built twice from what the store returns, are the same; the limited wording is there.
    const first = autoPackageMarkdown(await meta(), (await bundle()).stages);
    const again = autoPackageMarkdown(await meta(), (await bundle()).stages);
    expect(again).toBe(first);
    for (const text of ["## AI 创作策划（受众待验证·市场证据不可用）", "**市场证据**：不可用（服务端记录）", "受众待验证", "文本剧本包完成不代表做过市场验证",
      "参考方法原文：S-KB-CRAFT「关键结果来自主角的选择和行动」", "- 市场证据：不可用"]) expect(first).toContain(text);
    expect(first).not.toContain("**有来源的事实**");
    expect(JSON.stringify(autoPackageJson(await meta(), (await bundle()).stages))).toBe(JSON.stringify(autoPackageJson(await meta(), (await bundle()).stages)));
    await engine.maintain();
    expect(seen).toHaveLength(6);
  });
});

describe("D. a limited answer breaking its contract is refused whole, once; nothing is stored or sent after it", () => {
  const refusedOnce = async (plan: AutoFixturePlan, code: string, extra: Partial<Setup> = {}) => {
    const { run, engine, seen, view } = await setup({ plan, ...extra });
    await engine.drive(run.id);
    const result = await view();
    expect(result).toMatchObject({ state: "failed", callsUsed: 1 });
    expect(result.stages.find((stage) => stage.stageKey === "research")).toMatchObject({ state: "rejected", errorCode: code, output: null });
    expect(result.calls.map((call) => call.errorCode)).toEqual([code]);
    // The refused answer is kept nowhere: none of its text is in the run.
    expect(JSON.stringify(result)).not.toContain("模型替身样例");
    await engine.maintain();
    expect(seen.map((item) => item.stage)).toEqual(["research"]);
  };

  it.each([
    ["facts", "invalid_output@facts:unrecognized_keys+limited_contract+forbidden_field"],
    ["observations", "invalid_output@observations:unrecognized_keys+limited_contract+forbidden_field"],
    ["audience.basis", "invalid_output@audience.basis:unrecognized_keys+limited_contract+forbidden_field"],
    ["audience.sourceIds", "invalid_output@audience.sourceIds:unrecognized_keys+limited_contract+forbidden_field"],
  ] as const)("%s, even empty or default", async (field, code) => {
    await refusedOnce({ limitedInjection: [field] }, code);
  });

  it("the whole sourced-shape answer (a craft fact and all) is refused at its first forbidden field", async () => {
    await refusedOnce({ ignoreLimitedContract: true }, "invalid_output@facts:unrecognized_keys+limited_contract+forbidden_field");
  });

  it.each([
    [{ forgedQuote: true }, "evidence_not_in_source@contentStructure[0].reference.quote"],
    [{ fabricatedNumber: true }, "unsourced_number@hypotheses[0].statement:percent+market_statistic+proportion"],
    [{ hiddenStatistic: true }, "unsourced_number@hypotheses[0].howToVerify:percent+market_statistic+proportion"],
  ] as const)("the checks stand in limited mode: %o", async (plan, code) => {
    await refusedOnce(plan, code);
  });

  it("a story count over the frozen cast limit is still a frozen conflict", async () => {
    await refusedOnce({ creativeQuantities: true }, "constraint_violation@contentStructure[1].application.pattern:chinese_numeral+frozen_conflict+cast_over_limit",
      { constraints: { maxCharacters: 2 } });
  });
});

describe("E. sourced: legal and illegal findings, as before", () => {
  const sourced: Partial<Setup> = { researchFetch: true, pages: (urls) => urls.filter((url) => url === MARKET_PAGE.url).map(() => MARKET_PAGE) };

  it("a legal fact quoting its source is stored", async () => {
    const { run, engine, research } = await setup(sourced);
    await engine.drive(run.id);
    expect((await research()).output).toMatchObject({ facts: [{ id: "F1", sourceIds: ["S-KB-CRAFT"] }] });
  });

  it.each([
    [{ forgedFactEvidence: true }, "evidence_not_in_source@facts[0].evidence"],
    [{ unsourcedFactNumber: true }, "unsourced_number@facts[0].statement:percent+unsourced+not_in_cited_excerpt"],
  ] as const)("an illegal fact is refused once: %o", async (plan, code) => {
    const { run, engine, seen, view } = await setup({ ...sourced, plan });
    await engine.drive(run.id);
    const result = await view();
    expect(result.stages.find((stage) => stage.stageKey === "research")).toMatchObject({ state: "rejected", errorCode: code, output: null });
    await engine.maintain();
    expect(seen).toHaveLength(1);
  });
});

describe("F. history: research v3 is read as it was; an old run's next research uses v4; the snapshot is the one saved", () => {
  it("a run whose research completed as v3 continues without resending it; prompts and packages show its server record, not v1/v2 limits", async () => {
    let failDirections = true;
    // The hard cap: the refused directions call took one of the budget, the resend needs one more.
    const { store, run, engine, seen, bundle, meta } = await setup({ callBudget: autoCreationHardCap(1, 0),
      override: (stage) => stage === "directions" && failDirections ? { status: 400, body: { error: "bad" } } : undefined });
    await engine.drive(run.id);
    const stored = store.runs.find((item) => item.id === run.id)!;
    Object.assign(stored.input, { promptVersion: "ads.auto-creation.prompt.v5", checksVersion: "ads.auto-creation.checks.v5" });
    store.stages.find((stage) => stage.runId === run.id && stage.stageKey === "research")!.output = fixtureAutoResearchV3();
    const frozen = JSON.stringify(stored.input);
    const hash = stored.inputHash;
    failDirections = false;
    const sent = seen.length;
    expect((await store.prepareResume(WS, P1, run.id, { resumeKey: "r", requestHash: hashAutoResume(run.id, []), confirmedCallIds: [], maxActiveRuns: 5,
      providerReady: true, blocked: false }, NOW_ISO)).kind).toBe("ok");
    await engine.drive(run.id);
    expect(seen.slice(sent).map((item) => item.stage)).toEqual(["directions", "bible", "outline", "episode:1", "review:1"]);
    const directionsPrompt = seen.slice(sent)[0]!.user;
    expect(directionsPrompt).toContain("\"资料记录\":{\"说明\":\"服务端按本次资料快照记录，不是 AI 调研结论\"");
    expect(directionsPrompt).toContain("evidenceIds 只能引用研究里实际存在的编号：F1、H1；");
    expect(directionsPrompt).not.toContain("\"市场证据\"");
    const after = await bundle();
    expect(after.stages.find((stage) => stage.stageKey === "research")!.output).toEqual(fixtureAutoResearchV3());
    expect(JSON.stringify(after.run.input)).toBe(frozen);
    expect(after.run.inputHash).toBe(hash);
    const markdown = autoPackageMarkdown(await meta(), after.stages);
    expect(markdown).toContain("**用户设定与资料记录**（来自用户设定和服务端记录，不是 AI 调研结论）");
    expect(markdown).toContain("**有来源的事实**");
    expect(markdown).not.toContain("**局限**");
    expect(markdown).not.toContain("- 市场证据：");
    expect((autoPackageJson(await meta(), after.stages) as { research: { analysis: unknown } }).research.analysis).toEqual(fixtureAutoResearchV3());
  });

  it("the same key and request again creates nothing and sends nothing", async () => {
    const { store, run, engine, seen } = await setup();
    await engine.drive(run.id);
    const again = await store.createRun({ ...run, id: crypto.randomUUID() }, autoCreationInitialStageKeys(1),
      { maxActiveRuns: 1, sinceIso: new Date(START - 86_400_000).toISOString(), maxCallsPerDay: 100, requiredCalls: 6 });
    expect(again).toMatchObject({ kind: "existing", bundle: { run: { id: run.id } } });
    expect(store.runs).toHaveLength(1);
    await engine.maintain();
    expect(seen).toHaveLength(6);
  });

  it("an old run's unfinished research continues on the saved snapshot, whatever the server reads now", async () => {
    let failResearch = true;
    // The run read a market page when it started; this engine now reads nothing (no fetcher at all).
    const first = await setup({ researchFetch: true, pages: (urls) => urls.filter((url) => url === MARKET_PAGE.url).map(() => MARKET_PAGE),
      callBudget: autoCreationHardCap(1, 0), override: (stage) => stage === "research" && failResearch ? { status: 400, body: { error: "bad" } } : undefined });
    await first.engine.drive(first.run.id);
    expect((await first.research()).state).toBe("rejected");
    failResearch = false;
    expect((await first.store.prepareResume(WS, P1, first.run.id, { resumeKey: "r", requestHash: hashAutoResume(first.run.id, []), confirmedCallIds: [],
      maxActiveRuns: 5, providerReady: true, blocked: false }, NOW_ISO)).kind).toBe("ok");
    const later = new AutoCreationEngine({ workspaceId: WS, store: first.store, providers: PROVIDERS, maxCallsPerDay: 100, clock: () => new Date(START),
      transport: autoFixtureTransport({ seen: first.seen }), leaseMs: 240_000 });
    await later.drive(first.run.id);
    expect(first.seen.at(-6)!.user).toContain("任务：基于资料完成研究与创作定位");
    expect((await first.research()).output).toMatchObject({ serverRecord: { executedWith: { promptVersion: "ads.auto-creation.prompt.v8", answerContract: "sourced" } } });
  });

  it("an old run whose budget is spent is not resumed: nothing reset, nothing sent", async () => {
    const { store, run, engine, seen } = await setup({ callBudget: 6, override: (stage) => stage === "review:1" ? { status: 400, body: { error: "bad" } } : undefined });
    await engine.drive(run.id);
    const before = JSON.stringify(store.stages.filter((stage) => stage.runId === run.id));
    expect((await store.prepareResume(WS, P1, run.id, { resumeKey: "r", requestHash: hashAutoResume(run.id, []), confirmedCallIds: [], maxActiveRuns: 5,
      providerReady: true, blocked: false }, NOW_ISO)).kind).toBe("budget_exhausted");
    expect(JSON.stringify(store.stages.filter((stage) => stage.runId === run.id))).toBe(before);
    expect(seen).toHaveLength(6);
  });

  it("a research with no valid saved snapshot is stopped before any reservation; no mode is assumed", async () => {
    const { store, run, engine, seen, view, bundle } = await setup();
    const sourcesStage = store.stages.find((stage) => stage.runId === run.id && stage.stageKey === "sources")!;
    Object.assign(sourcesStage, { state: "completed", output: { schema: "ads.auto-creation.sources.v1", sources: [], notes: [] }, outputHash: "h", dependsOn: {} });
    await engine.drive(run.id);
    expect(await view()).toMatchObject({ state: "needs_attention", errorCode: "research_sources_missing", callsUsed: 0, calls: [] });
    expect(seen).toHaveLength(0);
    expect(autoResumeBlock(await bundle(), { researchFetch: true })).toBe("research_sources_missing");
  });
});

describe("durations (checks v7): the work's own length passes, an unplaced duration is a notice, a viewing time is refused", () => {
  it("one sixty-second episode, no rounds, a budget of six: six calls, a DRAFT story; the notice keeps its identity in prompts and packages", async () => {
    const { store, run, engine, seen, view, bundle, meta, research } = await setup({ plan: { durations: "creative" }, callBudget: 6 });
    await engine.drive(run.id);
    const result = await view();
    expect(result).toMatchObject({ state: "completed", quality: "passed", callsUsed: 6, callCap: 6, storySave: "saved", researchMode: "limited" });
    expect(seen.map((item) => item.stage)).toEqual(["research", "directions", "bible", "outline", "episode:1", "review:1"]);
    expect(store.projects.get(P1)!.stories[0]).toMatchObject({ reviewStatus: "DRAFT" });
    expect(store.projects.get(P1)!.approvedStoryId).toBeNull();
    const stored = (await research()).output as AutoResearch;
    // Kept as written: nothing cut, rewritten or moved; the work's length has no notice, the unplaced duration has one.
    expect(stored.hypotheses.map((item) => item.statement)).toEqual(["待验证观众是否喜欢本剧60秒的紧凑叙事。", "待验证：观众能否在60秒内理解人物冲突。"]);
    expect(stored.unverified).toEqual([{ origin: "server_check", field: "hypotheses[1].statement", token: "60", semantic: "unclassified",
      rule: "duration_unconfirmed", note: "程序无法确认时长含义（不是已判定的观看统计），未核实" }]);
    expect(stored).toMatchObject({ facts: [], observations: [], audience: { basis: "hypothesis", sourceIds: [] },
      serverRecord: { executedWith: { promptVersion: "ads.auto-creation.prompt.v8", checksVersion: "ads.auto-creation.checks.v9", answerContract: "limited" },
        marketEvidence: { status: "unavailable" } } });
    const notice = "第2条假设（H2）中的「60」：程序无法确认时长含义（不是已判定的观看统计），未核实；只属于创作假设或设计，不是有来源的事实或市场结论。";
    // Later prompts carry it as a notice beside a hypothesis, never as a finding.
    for (const stage of ["directions"]) {
      const user = seen.find((item) => item.stage === stage)!.user;
      expect(user).toContain(notice);
      expect(user).toContain("“未核实提示”标出的数字或时长程序未能判定含义，未核实");
    }
    const first = autoPackageMarkdown(await meta(), (await bundle()).stages);
    expect(autoPackageMarkdown(await meta(), (await bundle()).stages)).toBe(first);
    expect(first).toContain(`- ${notice}`);
    expect(first).toContain("**未核实提示**（程序未能判定数字或时长含义，未核实；");
    expect(first).toContain("H2 假设：待验证：观众能否在60秒内理解人物冲突。〔含未核实数字，见下方未核实提示〕");
    expect(first).not.toContain("**有来源的事实**");
    const json = autoPackageJson(await meta(), (await bundle()).stages) as { research: { analysis: AutoResearch; identity: Record<string, string> } };
    expect(json.research.analysis).toEqual(stored);
    expect(json.research.identity.unverified).toContain("duration_unconfirmed：时长含义，不是已判定的观看统计");
    expect(JSON.stringify(autoPackageJson(await meta(), (await bundle()).stages))).toBe(JSON.stringify(json));
    await engine.maintain();
    expect(seen).toHaveLength(6);
  });

  it("an actual viewing time is refused at research: sent once, nothing after it, the refused text stored nowhere", async () => {
    const { run, engine, seen, view } = await setup({ plan: { durations: "viewing" } });
    await engine.drive(run.id);
    const result = await view();
    const code = "unsourced_number@hypotheses[0].statement:digits+market_statistic+viewing_duration";
    expect(result).toMatchObject({ state: "failed", callsUsed: 1 });
    expect(result.stages.find((stage) => stage.stageKey === "research")).toMatchObject({ state: "rejected", errorCode: code, output: null });
    expect(result.calls.map((call) => call.errorCode)).toEqual([code]);
    expect(JSON.stringify(result)).not.toContain("模型替身样例");
    await engine.maintain();
    await engine.drive(run.id);
    expect(seen.map((item) => item.stage)).toEqual(["research"]);
  });
});

describe("hypothesis fields (prompt v8): the DeepSeek request names them, the strict contract still refuses an extra one", () => {
  // A real series run was refused at its first research call as invalid_output@hypotheses[3]:unrecognized_keys; its answer
  // was not kept, so the extra key is unknown. The double's `extra` field below is a SYNTHETIC sample, not that answer.
  const sourced: Partial<Setup> = { researchFetch: true, pages: (urls) => urls.filter((url) => url === MARKET_PAGE.url).map(() => MARKET_PAGE) };
  const MODES = [["limited", {}], ["sourced", sourced]] as const;

  it.each(MODES)("%s: the real DeepSeek adapter sends the mode's schema (three required fields, no others) and the field lines", async (mode, extra) => {
    const { run, engine, seen, bodies, view } = await setup({ providerKey: "deepseek", ...extra });
    await engine.drive(run.id);
    // A legal answer keeps the normal flow: six calls, completed.
    expect(await view()).toMatchObject({ state: "completed", researchMode: mode, callsUsed: 6 });
    const sent = bodies[0]!;
    expect(sent.url).toBe(DEEPSEEK_CHAT_COMPLETIONS_URL);
    expect(sent.body).toMatchObject({ response_format: { type: "json_object" }, stream: false });
    const schema = sentSchema(sent);
    expect(schema).toEqual(autoCreationJsonSchema("research", 1, mode).schema);
    const item = (schema as { properties: { hypotheses: { items: Record<string, unknown> } } }).properties.hypotheses.items;
    expect(item).toMatchObject({ type: "object", additionalProperties: false, required: ["id", "statement", "howToVerify"] });
    expect(Object.keys(item.properties as Record<string, unknown>)).toEqual(["id", "statement", "howToVerify"]);
    const user = seen[0]!.user;
    expect(user).toContain("提示版本：ads.auto-creation.prompt.v8");
    expect(user).toContain("每条假设是一个对象，只包含 id、statement、howToVerify 三个字段，三个都必填");
    expect(user).toContain("不要给假设添加任何其他字段");
    expect(user).toContain('假设对象示例（只示意格式，内容按本次创作写）：{"id":"H1",');
  });

  it.each(MODES)("%s: a fourth hypothesis with a synthetic extra field is sent once, refused whole, stored nowhere, nothing after it", async (_mode, extra) => {
    const { run, engine, seen, view } = await setup({ providerKey: "deepseek", plan: { extraHypothesisField: true }, ...extra });
    await engine.drive(run.id);
    const result = await view();
    const code = "invalid_output@hypotheses[3]:unrecognized_keys";
    expect(result).toMatchObject({ state: "failed", callsUsed: 1 });
    expect(result.stages.find((stage) => stage.stageKey === "research")).toMatchObject({ state: "rejected", errorCode: code, output: null });
    expect(result.calls.map((call) => call.errorCode)).toEqual([code]);
    expect(JSON.stringify(result)).not.toContain("模型替身样例");
    await engine.maintain();
    await engine.drive(run.id);
    expect(seen.map((item) => item.stage)).toEqual(["research"]);
  });
});
