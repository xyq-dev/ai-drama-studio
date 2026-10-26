import { z } from "zod";
import {
  DEEPSEEK_PROVIDER_ADAPTER,
  TITLE_WRITING_EPISODE_SECONDS_CHOICES,
  TITLE_WRITING_MAX_EPISODES,
  TITLE_WRITING_MIN_EPISODES,
  TITLE_WRITING_STORED_PROVIDER_KEYS,
  type TitleWritingCallState,
  type TitleWritingProviderKey,
  type TitleWritingRunState,
  type TitleWritingStoredProviderKey,
  type TitleWritingUsageView,
} from "./title-writing";

/**
 * AI automatic creation (docs/AI_AUTO_CREATION.md): one click runs research → audience and structure analysis →
 * original directions with a rule-based choice → story bible (story, ending, characters, places, props) → episode
 * outline → every episode → machine quality review → at most two targeted revision rounds → save and export.
 *
 * Runs live in their own tables (auto_creation_*), never in title_writing_*; they share the provider adapters, the
 * single-send rule, the workspace call lock and the workspace daily cap with title writing and online candidates.
 * Every version below is frozen into a run's input; a stored run keeps the meaning it was created with.
 */
export const AUTO_CREATION_INPUT_SCHEMA = "ads.auto-creation.input.v1" as const;
/**
 * v2: the research contract says which fields may carry a number and which never do (no dates, counts or plans).
 * v3: numbers by meaning: story quantities and future plans may be written, market statistics only from cited excerpts.
 * v4: a content structure is a quoted method (reference) apart from this work's own design (application), research v2.
 * v5: the research answer no longer restates the settings or the source gaps (the server records them), research v3.
 * v6: the research prompt follows the run's saved source snapshot: limited asks for creative positioning and hypotheses
 * only (no findings, no audience sources), sourced keeps the cited findings; research v4.
 * v7: the number rules say how to write the work's own length (本剧 60 秒的故事) and that a viewing time is never written.
 * v8: both research prompts name every field of one hypothesis (id, statement, howToVerify, nothing else) and show one
 * example object; the answer contract and the checks are unchanged (research v4, checks v7). Shared by series research.
 * v9: a content structure's method is chosen from the server's catalog of quotable passages (referenceId or null),
 * never quoted by the model; the answer is research.answer.catalog.v1 and is stored as research v4. Shared.
 */
export const AUTO_CREATION_PROMPT_VERSION = "ads.auto-creation.prompt.v9" as const;
/** Every prompt version a stored run may carry. A resumed run is sent with the current prompts. */
export type AutoCreationPromptVersion = "ads.auto-creation.prompt.v1" | "ads.auto-creation.prompt.v2" | "ads.auto-creation.prompt.v3"
  | "ads.auto-creation.prompt.v4" | "ads.auto-creation.prompt.v5" | "ads.auto-creation.prompt.v6" | "ads.auto-creation.prompt.v7"
  | "ads.auto-creation.prompt.v8" | typeof AUTO_CREATION_PROMPT_VERSION;
export const AUTO_CREATION_SELECTION_RULES = "ads.auto-creation.selection-rules.v1" as const;
/**
 * v2: the applied constraints and a direction's audience fit are number-checked; spaced ordinals are not claims.
 * v3: an uncited number is judged by what it counts (story, plan, frozen setting or statistic); a direction's notes
 * are checked too; refusals name what the number was taken for and the sub-rule.
 * v4: a structure's quote must be found whole in the one source it cites; its application is checked as uncited text,
 * whatever it cites.
 * v5: in uncited creative text (a hypothesis, its plan, a structure's application, an opportunity, a direction's notes)
 * a number the code cannot place (unclassified, no_role) is kept as an unverified notice instead of refusing the answer;
 * every other refusal stands, and the rest of the answer is still checked.
 * v6: a research answer is parsed with the contract of the run's saved research mode (limited or sourced); a limited
 * answer carrying a finding or an audience source field is refused whole, and a direction cites only research ids that exist.
 * v7: a duration in a clause about viewers is judged by what it measures: the work's own length (本剧60秒) against the
 * frozen setting, a viewing time (通常观看60秒后退出) refused as before, and a pending question whose duration names
 * neither (观众能否在60秒内理解人物冲突) kept in creative text as an unverified notice (duration_unconfirmed).
 * v8: in a hypothesis' howToVerify only, a plan's sample of the work (计划制作三集样稿进行试读, 计划试读前三集样稿) is
 * read as a sample, not the work's total: it must lie within 1 and the frozen episode count (sample_out_of_range); a
 * total, a viewing habit, a rate, a share or a measured result beside it is refused as before. Prompt v8, research v4.
 * v9: that sample is read only when its own sample verb takes the count, right before it (制作三集样稿, 试读前三集样稿),
 * after the plan word; a sample verb elsewhere in the clause (计划选取观众看完三集样稿后都弃剧的案例, 计划把本剧缩至三集
 * 样稿后试读) exempts nothing, and the count is read as before. Prompt v8, research v4.
 * v10: a research answer's referenceId must name an entry of the run's reference catalog or be null; an id the catalog
 * lacks (another catalog's, made up) and a model-written reference, sourceId or quote refuse the answer whole. The
 * server fills the reference in from the catalog, and the quote and application checks then run as before. Prompt v9.
 */
export const AUTO_CREATION_CHECKS_VERSION = "ads.auto-creation.checks.v10" as const;
/** Every checks version a stored run or review may carry. */
export type AutoCreationChecksVersion = "ads.auto-creation.checks.v1" | "ads.auto-creation.checks.v2" | "ads.auto-creation.checks.v3"
  | "ads.auto-creation.checks.v4" | "ads.auto-creation.checks.v5" | "ads.auto-creation.checks.v6" | "ads.auto-creation.checks.v7"
  | "ads.auto-creation.checks.v8" | "ads.auto-creation.checks.v9" | typeof AUTO_CREATION_CHECKS_VERSION;
/**
 * v4: the answer contract follows the run's saved research mode. limited: the model writes hypotheses, the audience as
 * text, content structures and opportunities only; the server assembles the rest (no facts, no observations, the
 * audience a hypothesis with no sources) and records that market evidence is unavailable. sourced: v3's answer.
 */
export const AUTO_CREATION_RESEARCH_SCHEMA = "ads.auto-creation.research.v4" as const;
/**
 * The research answer a model writes from prompt v9 on: research v4's answer, but a content structure names a passage of
 * the run's reference catalog by its id (or null) instead of quoting one. Never stored: the server maps it to research v4.
 */
export const AUTO_CREATION_RESEARCH_ANSWER_SCHEMA = "ads.auto-creation.research.answer.catalog.v1" as const;
/**
 * How the server cuts a source snapshot into quotable passages (see the catalog limits below). A new algorithm is a new
 * version: the version is part of every entry's id, so an id from another algorithm never names a passage of this one.
 */
export const AUTO_REFERENCE_CATALOG_VERSION = "ads.auto-creation.reference-catalog.v1" as const;
/** Most catalog entries one source gives. */
export const AUTO_REFERENCE_CATALOG_PER_SOURCE = 8;
/** Most catalog entries in all. */
export const AUTO_REFERENCE_CATALOG_MAX_ENTRIES = 24;
/** Most characters of the whole catalog as JSON (its entries as the prompt carries them). */
export const AUTO_REFERENCE_CATALOG_MAX_CHARS = 4_000;
/**
 * Research stored by research v3 (one answer contract whatever the mode; the server's record and notices apart from it):
 * read, shown and exported as it was, never sent.
 */
export const AUTO_CREATION_RESEARCH_SCHEMA_V3 = "ads.auto-creation.research.v3" as const;
/** Research stored before v3 (the model restated the settings and gaps): read, shown and exported as it was, never sent. */
export const AUTO_CREATION_RESEARCH_SCHEMA_V2 = "ads.auto-creation.research.v2" as const;
/** Research stored before v2 (pattern, why and sourceIds in one item): read, shown and exported as it was, never sent. */
export const AUTO_CREATION_RESEARCH_SCHEMA_V1 = "ads.auto-creation.research.v1" as const;
export const AUTO_CREATION_DIRECTIONS_SCHEMA = "ads.auto-creation.directions.v1" as const;
export const AUTO_CREATION_BIBLE_SCHEMA = "ads.auto-creation.bible.v1" as const;
export const AUTO_CREATION_OUTLINE_SCHEMA = "ads.auto-creation.outline.v1" as const;
export const AUTO_CREATION_EPISODE_SCHEMA = "ads.auto-creation.episode.v1" as const;
export const AUTO_CREATION_REVIEW_SCHEMA = "ads.auto-creation.review.v1" as const;
export const AUTO_CREATION_PACKAGE_SCHEMA = "ads.auto-creation.package.v1" as const;

/** Revision rounds a run may take: default 2, the most allowed. A round is new, budgeted generation, never a resend. */
export const AUTO_CREATION_MAX_REVISION_ROUNDS = 2;
/** Episodes one revision round may rewrite. More flagged episodes stay as open issues of the run. */
export const AUTO_CREATION_MAX_REVISIONS_PER_ROUND = 3;
/** Resends a person may confirm (rejected or uncertain stages) on top of the worst-case plan. Never automatic. */
export const AUTO_CREATION_RESEND_ALLOWANCE = 2;
/** The largest prompt sent: a stage whose prompt would be longer stops before any reservation. */
export const AUTO_CREATION_PROMPT_MAX_CHARS = 40_000;
/** Directions generated per run (the rule picks one of them). */
export const AUTO_CREATION_MAX_DIRECTIONS = 3;
export const AUTO_CREATION_DEFAULT_EPISODES = 1;
export const AUTO_CREATION_DEFAULT_SECONDS = 60;
/** A source the snapshot calls recent: market facts older than this never make a run "sourced". */
export const AUTO_CREATION_RECENT_DAYS = 365;

/** Calls when every stage succeeds the first time: research, directions, bible, outline, N episodes, one review. */
export function autoCreationNormalCalls(episodeCount: number): number {
  return episodeCount + 5;
}

/** Episodes one revision round may rewrite for a run of N episodes. */
export function autoCreationRevisionsPerRound(episodeCount: number): number {
  return Math.min(episodeCount, AUTO_CREATION_MAX_REVISIONS_PER_ROUND);
}

/** The normal calls plus every allowed revision round (each rewrites at most its per-round episodes and reviews again). */
export function autoCreationWorstCalls(episodeCount: number, revisionRounds: number): number {
  return autoCreationNormalCalls(episodeCount) + revisionRounds * (autoCreationRevisionsPerRound(episodeCount) + 1);
}

/** The hard per-run cap: the worst case plus the resends a person may confirm. No call is ever reserved past it. */
export function autoCreationHardCap(episodeCount: number, revisionRounds: number): number {
  return autoCreationWorstCalls(episodeCount, revisionRounds) + AUTO_CREATION_RESEND_ALLOWANCE;
}

export const AUTO_CREATION_STAGE_KEY = /^(sources|research|directions|bible|outline|episode:[1-6]|review:[1-3]|revise:[1-2]:episode:[1-6])$/;
export type AutoCreationStageKey = string;
export type AutoCreationStageKind = "sources" | "research" | "directions" | "bible" | "outline" | "episode" | "review" | "revise";

export function autoStageKind(stageKey: string): AutoCreationStageKind {
  if (stageKey.startsWith("episode:")) return "episode";
  if (stageKey.startsWith("review:")) return "review";
  if (stageKey.startsWith("revise:")) return "revise";
  return stageKey as AutoCreationStageKind;
}

/** Episode number of an episode or revise stage, else null. */
export function autoStageEpisodeNo(stageKey: string): number | null {
  const match = /^(?:episode|revise:[1-2]:episode):([1-6])$/.exec(stageKey);
  return match ? Number(match[1]) : null;
}

/** Round number of a review or revise stage, else null. */
export function autoStageRound(stageKey: string): number | null {
  const match = /^(?:review|revise):([1-3])/.exec(stageKey);
  return match ? Number(match[1]) : null;
}

/** The stages a run starts with. Revision rounds are appended by the engine only after a review asks for them. */
export function autoCreationInitialStageKeys(episodeCount: number): string[] {
  return ["sources", "research", "directions", "bible", "outline",
    ...Array.from({ length: episodeCount }, (_, index) => `episode:${String(index + 1)}`), "review:1"];
}

function text(min: number, max: number) {
  return z.string().max(max)
    .refine((value) => value.trim().length >= min, "必填内容不能为空白")
    // eslint-disable-next-line no-control-regex
    .refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), "文本含有控制字符");
}

function shortList(maxItems: number, maxChars: number) {
  return z.array(text(1, maxChars)).max(maxItems);
}

/** The user's hard constraints. Every one outranks an AI recommendation; empty fields are left to the AI. */
export const autoCreationConstraintsSchema = z.object({
  genre: z.string().trim().max(20).default(""),
  audience: z.string().trim().max(40).default(""),
  /** Most characters on screen. */
  maxCharacters: z.number().int().min(1).max(8).nullable().default(null),
  /** Most distinct locations. */
  maxLocations: z.number().int().min(1).max(6).nullable().default(null),
  forbiddenThemes: z.array(z.string().trim().min(1).max(20)).max(5).default([]),
  endingRequirement: z.string().trim().max(100).default(""),
}).strict();
export type AutoCreationConstraints = z.infer<typeof autoCreationConstraintsSchema>;

/** A text the person owns or may use (their script, subtitles, notes), declared as such. Never fetched by the server. */
export const autoCreationMaterialSchema = z.object({
  title: z.string().trim().min(1).max(60),
  kind: z.enum(["script", "subtitles", "notes"]),
  text: z.string().min(1).max(6_000).refine((value) => value.trim().length > 0, "资料内容不能为空白"),
  rightsConfirmed: z.literal(true),
}).strict();
export type AutoCreationMaterial = z.infer<typeof autoCreationMaterialSchema>;

const MODEL_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Start body. Idea, constraints and materials are all optional: an empty body lets the AI plan everything. The
 * episode count and seconds come from the work's plan (sent values must equal it). The client can never send a
 * provider adapter, role, review result, research source or call identity: the schema is strict.
 */
export const autoCreationStartSchema = z.object({
  idea: z.string().trim().max(300).default(""),
  constraints: autoCreationConstraintsSchema.default(autoCreationConstraintsSchema.parse({})),
  materials: z.array(autoCreationMaterialSchema).max(3).default([]),
  /** Public pages to read, only when the server enables reading them; every address is checked server side. */
  referenceUrls: z.array(z.string().url().max(500)).max(3).default([]),
  episodeCount: z.number().int().min(TITLE_WRITING_MIN_EPISODES).max(TITLE_WRITING_MAX_EPISODES).optional(),
  episodeSeconds: z.number().int().optional(),
  revisionRounds: z.number().int().min(0).max(AUTO_CREATION_MAX_REVISION_ROUNDS).default(AUTO_CREATION_MAX_REVISION_ROUNDS),
  /** The person's own call budget for this run; at least the normal calls and at most the hard cap. Default: hard cap. */
  callBudget: z.number().int().min(1).max(60).optional(),
  providerKey: z.enum(TITLE_WRITING_STORED_PROVIDER_KEYS).optional(),
  model: z.string().regex(MODEL_ID).optional(),
}).strict();
export type AutoCreationStart = z.infer<typeof autoCreationStartSchema>;

/** How the run was authorized; written by the server only. */
export interface AutoCreationAuthorization {
  mode: "auto";
  /** The signed-in site administrator, or the server operator token without the site login. */
  proof: "site_session" | "operator_token";
  initiatedBy: string;
  /** Machine identity that executes the stages and saves the draft. Never a person. */
  executor: "auto-creation-engine";
}

/** One research source of a run's snapshot. Unreadable entries are kept with what was (not) read. */
export interface AutoCreationSource {
  sourceId: string;
  kind: "official_page" | "public_page" | "knowledge_base" | "user_material";
  title: string;
  /** URL, or the identifier of an authorized file or knowledge entry. */
  locator: string;
  publishedAt: string | null;
  fetchedAt: string;
  /** What was actually read. */
  readScope: "full_text" | "summary" | "subtitles" | "none";
  status: "read" | "unreadable" | "login_required" | "directory_only" | "blocked" | "disabled";
  /** Market data (audience, viewing, revenue) or craft knowledge (structure, pacing). User materials are references. */
  topic: "market" | "craft" | "reference";
  /** Text that conclusions may quote. Empty when nothing was read. Untrusted data, never instructions. */
  excerpt: string;
  contentHash: string | null;
  limitations: string;
}

/** The frozen, hashed input of one run. */
export interface AutoCreationFrozenInput {
  schema: typeof AUTO_CREATION_INPUT_SCHEMA;
  promptVersion: AutoCreationPromptVersion;
  selectionRules: typeof AUTO_CREATION_SELECTION_RULES;
  checksVersion: AutoCreationChecksVersion;
  idea: string;
  constraints: AutoCreationConstraints;
  materials: AutoCreationMaterial[];
  referenceUrls: string[];
  /** Whether the server read public pages for this run (fixed at start). */
  researchFetch: boolean;
  episodeCount: number;
  episodeSeconds: number;
  revisionRounds: number;
  callBudget: number;
  maxOutputTokens: number;
  providerKey: TitleWritingStoredProviderKey;
  model: string;
  providerAdapter?: typeof DEEPSEEK_PROVIDER_ADAPTER;
  authorization: AutoCreationAuthorization;
}

// ---------------------------------------------------------------------------------------------------------------
// Stage outputs. The zod schemas are the authority; the JSON Schemas below only steer providers that enforce one.

const factSchema = z.object({
  id: z.string().regex(/^F[1-8]$/),
  statement: text(1, 200),
  sourceIds: z.array(z.string().max(40)).min(1).max(3),
  /** A verbatim quote of the cited source's excerpt. */
  evidence: text(1, 200),
}).strict();

const observationSchema = z.object({
  id: z.string().regex(/^O[1-8]$/),
  statement: text(1, 200),
  sourceIds: z.array(z.string().max(40)).min(1).max(3),
}).strict();

const hypothesisSchema = z.object({
  id: z.string().regex(/^H[1-8]$/),
  statement: text(1, 200),
  howToVerify: text(1, 150),
}).strict();

const researchFields = {
  facts: z.array(factSchema).max(8),
  observations: z.array(observationSchema).max(8),
  hypotheses: z.array(hypothesisSchema).min(1).max(8),
  audience: z.object({
    primary: text(1, 120),
    viewingNeeds: shortList(5, 60).min(1),
    emotionalAppeals: shortList(5, 60).min(1),
    /** sourced only when every audience claim is backed by the cited sources. */
    basis: z.enum(["sourced", "hypothesis"]),
    sourceIds: z.array(z.string().max(40)).max(5),
  }).strict(),
  opportunities: shortList(5, 120).min(1),
};

/** What research before v3 had the model write: the gaps of its material and the settings it applied. */
const legacyResearchFields = {
  limitations: shortList(5, 150).min(1),
  appliedConstraints: shortList(8, 120),
};

/** The longest method quote a structure may carry: one short passage, so quotes never crowd out the answer. */
export const AUTO_STRUCTURE_QUOTE_MAX = 80;
/** The shortest: a few words are no passage, they would be found in almost any text. */
export const AUTO_STRUCTURE_QUOTE_MIN = 6;

/**
 * One content structure (research v2). reference: the method as actually read, a verbatim passage of one readable
 * source, or null when the structure is the work's own design. application: how this work uses it, the work's own
 * design: its story quantities are the work's, never something the reference supports.
 */
export const autoContentStructureSchema = z.object({
  reference: z.object({
    sourceId: z.string().max(40),
    // The length a quote is matched with: whitespace does not count.
    quote: text(1, AUTO_STRUCTURE_QUOTE_MAX)
      .refine((value) => value.replace(/\s+/gu, "").length >= AUTO_STRUCTURE_QUOTE_MIN, "引用原文太短"),
  }).strict().nullable(),
  application: z.object({
    pattern: text(1, 120),
    why: text(1, 200),
  }).strict(),
}).strict();
export type AutoContentStructure = z.infer<typeof autoContentStructureSchema>;

/** Which answer contract a research is sent and checked with: the run's saved source snapshot's mode, never a model's or a client's. */
export type AutoResearchMode = "sourced" | "limited";

/** One quotable passage: a contiguous sentence or line of one readable source's excerpt, verbatim. Untrusted data. */
export interface AutoReferenceEntry {
  referenceId: string;
  sourceId: string;
  quote: string;
}

/**
 * The passages a research may cite as a method, cut by the server from the run's saved source snapshot only. The same
 * object builds the prompt, the JSON Schema sent and the answer check; entries may be none (null is then the only
 * choice), which is not the same as having no catalog at all (nothing is then sent).
 */
export interface AutoReferenceCatalog {
  version: typeof AUTO_REFERENCE_CATALOG_VERSION;
  entries: AutoReferenceEntry[];
  /** Canonical hash of the version and the entries. */
  hash: string;
}

/** A content structure as the model writes it (prompt v9): a catalog id or null, and the work's own design. */
const catalogStructureSchema = z.object({
  referenceId: z.string().max(40).nullable(),
  application: z.object({
    pattern: text(1, 120),
    why: text(1, 200),
  }).strict(),
}).strict();
export type AutoCatalogContentStructure = z.infer<typeof catalogStructureSchema>;

/**
 * The model's research answer with recent market material (prompt v9 on), apart from the stored research: the sourced
 * fields as before, but every content structure is a catalog choice. Strict: a reference, sourceId, quote or any other
 * key is refused whole, even empty. Whether the id is in the catalog is the server's mapping (autoMapResearchAnswer):
 * an id it lacks refuses the answer, never dropped, nulled or swapped for another.
 */
export const autoResearchCatalogAnswerSchema = z.object({
  schema: z.literal(AUTO_CREATION_RESEARCH_ANSWER_SCHEMA),
  ...researchFields,
  contentStructure: z.array(catalogStructureSchema).min(1).max(6),
}).strict();
export type AutoResearchCatalogAnswer = z.infer<typeof autoResearchCatalogAnswerSchema>;

/** The limited answer of prompt v9: research v4's limited fields, content structures as catalog choices. */
export const autoResearchLimitedCatalogAnswerSchema = z.object({
  schema: z.literal(AUTO_CREATION_RESEARCH_ANSWER_SCHEMA),
  hypotheses: researchFields.hypotheses,
  audience: z.object({
    primary: text(1, 120),
    viewingNeeds: shortList(5, 60).min(1),
    emotionalAppeals: shortList(5, 60).min(1),
  }).strict(),
  contentStructure: z.array(catalogStructureSchema).min(1).max(6),
  opportunities: researchFields.opportunities,
}).strict();
export type AutoResearchLimitedCatalogAnswer = z.infer<typeof autoResearchLimitedCatalogAnswerSchema>;

/** The model answer schema of a research mode (prompt v9 on): the one the prompt asks for and the JSON Schema enforces. */
export function autoResearchCatalogAnswerSchemaFor(mode: AutoResearchMode) {
  return mode === "limited" ? autoResearchLimitedCatalogAnswerSchema : autoResearchCatalogAnswerSchema;
}

/**
 * The model's research answer when the snapshot has recent market material (research v4 sourced, prompt v6 on): facts,
 * observations, hypotheses with their plans, the audience with its basis and sources, content structures and
 * opportunities. Strict: the server's own fields (the settings, the source gaps, the notices) and the old limitations
 * and appliedConstraints are refused if a model sends them, never dropped.
 */
export const autoResearchAnswerSchema = z.object({
  schema: z.literal(AUTO_CREATION_RESEARCH_SCHEMA),
  ...researchFields,
  contentStructure: z.array(autoContentStructureSchema).min(1).max(6),
}).strict();
export type AutoResearchAnswer = z.infer<typeof autoResearchAnswerSchema>;

/**
 * The model's research answer when the snapshot has no recent market material (research v4 limited): creative
 * hypotheses with their plans, the proposed audience as text, content structures (a method quote may still cite craft
 * or the person's material) and opportunities. Strict: facts, observations, the audience's basis and sources and every
 * server field are refused whole, even empty, never dropped or moved: the server writes them (autoAssembleLimitedResearch).
 */
export const autoResearchLimitedAnswerSchema = z.object({
  schema: z.literal(AUTO_CREATION_RESEARCH_SCHEMA),
  hypotheses: researchFields.hypotheses,
  audience: z.object({
    primary: text(1, 120),
    viewingNeeds: shortList(5, 60).min(1),
    emotionalAppeals: shortList(5, 60).min(1),
  }).strict(),
  contentStructure: z.array(autoContentStructureSchema).min(1).max(6),
  opportunities: researchFields.opportunities,
}).strict();
export type AutoResearchLimitedAnswer = z.infer<typeof autoResearchLimitedAnswerSchema>;

/** The answer schema of a research mode: the one the prompt asks for and the provider's JSON Schema enforces. */
export function autoResearchAnswerSchemaFor(mode: AutoResearchMode) {
  return mode === "limited" ? autoResearchLimitedAnswerSchema : autoResearchAnswerSchema;
}

/** Keys of a stored research the server writes, and the keys v3 took out of the answer: a model sending one is refused. */
export const AUTO_RESEARCH_SERVER_KEYS = ["serverRecord", "unverified", "limitations", "appliedConstraints"] as const;
/** Keys of a content structure the server fills in from the reference catalog (prompt v9): a model sending one is refused. */
export const AUTO_RESEARCH_STRUCTURE_SERVER_KEYS = ["reference", "sourceId", "quote"] as const;
/** Fields a limited answer never carries: the server writes facts, observations and the audience's basis and sources. */
export const AUTO_RESEARCH_LIMITED_FORBIDDEN = ["facts", "observations", "audience.basis", "audience.sourceIds"] as const;

/**
 * The research a limited answer stands for once the strict schema accepted it: the server writes no finding (facts and
 * observations empty) and an audience that is a hypothesis with no sources. Nothing of the answer is dropped or moved.
 */
export function autoAssembleLimitedResearch(answer: AutoResearchLimitedAnswer): AutoResearchAnswer {
  return {
    schema: answer.schema,
    facts: [],
    observations: [],
    hypotheses: answer.hypotheses,
    audience: { ...answer.audience, basis: "hypothesis", sourceIds: [] },
    contentStructure: answer.contentStructure,
    opportunities: answer.opportunities,
  };
}

/** One of the person's settings as the server restates it from the frozen input. Only settings that were set. */
export interface AutoSettingRecord {
  key: "episodes" | "seconds" | "genre" | "audience" | "maxCharacters" | "maxLocations" | "forbiddenThemes" | "endingRequirement";
  label: string;
  value: string;
}

/**
 * What the server itself records with a research (v3 on): the person's settings from the frozen input and the material
 * from the run's source snapshot (mode, what was read and how far, what could not be read, what is missing). Written
 * by code from trusted data, never by the model and never number-checked; not a finding of the research.
 */
export interface AutoResearchServerRecordV3 {
  origin: "server_record";
  /** The versions this research was actually produced with (a resumed older run records the versions it ran with). */
  executedWith: { promptVersion: string; checksVersion: string; researchSchema: typeof AUTO_CREATION_RESEARCH_SCHEMA_V3 };
  /** From the frozen input: the person's settings, not an AI conclusion. */
  settings: { origin: "user_setting"; items: AutoSettingRecord[] };
  /** From the source snapshot. */
  material: {
    origin: "source_snapshot";
    researchMode: "sourced" | "limited";
    read: Array<{ sourceId: string; title: string; readScope: AutoCreationSource["readScope"]; topic: AutoCreationSource["topic"]; note: string }>;
    unread: Array<{ sourceId: string; title: string; status: AutoCreationSource["status"]; note: string }>;
    gaps: string[];
  };
}

/** What a market evidence record says, by status. */
export const AUTO_MARKET_EVIDENCE_NOTES = {
  unavailable: "市场证据不可用：本次资料快照没有符合条件的近期市场资料。受众、题材与创作建议是 AI 创作策划和待验证假设，验证计划尚未执行，不是市场验证结论。",
  available: "有可读取的市场资料：事实与观察逐条引用所读资料的原文。",
} as const;

/**
 * The server's record of research v4: v3's record, the answer contract it was produced with (the snapshot's mode) and
 * whether market evidence was available. A limited research says so here; its material still lists the craft and the
 * person's materials actually read, and what could not be read.
 */
export interface AutoResearchServerRecord extends Omit<AutoResearchServerRecordV3, "executedWith"> {
  executedWith: { promptVersion: string; checksVersion: string; researchSchema: typeof AUTO_CREATION_RESEARCH_SCHEMA; answerContract: AutoResearchMode;
    /** Prompt v9 on: the schema the model's answer was checked with and the reference catalog it chose from. Absent before. */
    answerSchema?: typeof AUTO_CREATION_RESEARCH_ANSWER_SCHEMA;
    referenceCatalogVersion?: typeof AUTO_REFERENCE_CATALOG_VERSION;
    referenceCatalogHash?: string };
  marketEvidence: { origin: "source_snapshot"; status: "unavailable" | "available"; note: string };
}

/** What a no_role notice says (checks v5 on). */
export const AUTO_UNVERIFIED_NOTE = "程序未能判定数字含义，未核实";
/** What a duration_unconfirmed notice says (checks v7 on): not a viewing statistic, not checked true either. */
export const AUTO_UNVERIFIED_DURATION_NOTE = "程序无法确认时长含义（不是已判定的观看统计），未核实";
/** What every kind of notice is, for a heading over them all. */
export const AUTO_UNVERIFIED_SUMMARY = "程序未能判定数字或时长含义，未核实";

/**
 * A server notice on uncited creative text (a hypothesis, its plan, a structure's application, an opportunity, a
 * direction's notes): a number the checks could not give a role (unclassified, no_role), or a duration in a pending
 * question the checks could not tie to the work or to a viewing time (unclassified, duration_unconfirmed, checks v7).
 * The text stays as written; the notice says it is unverified and keeps it a hypothesis or design, never a market
 * finding. Never written by a model or a client. A stored notice is read as it was written.
 */
export type AutoUnverifiedNotice = {
  origin: "server_check";
  /** Schema keys and indexes, e.g. hypotheses[0].statement or candidates[1].differentiation. */
  field: string;
  /** The number as written in that field. */
  token: string;
  semantic: "unclassified";
} & ({ rule: "no_role"; note: typeof AUTO_UNVERIFIED_NOTE } | { rule: "duration_unconfirmed"; note: typeof AUTO_UNVERIFIED_DURATION_NOTE });

/** The heading over a list of notices: as before when every one is no_role, so an older run reads and exports as it did. */
export function autoUnverifiedHeading(notices: readonly AutoUnverifiedNotice[]): string {
  return notices.some((notice) => notice.rule === "duration_unconfirmed") ? AUTO_UNVERIFIED_SUMMARY : AUTO_UNVERIFIED_NOTE;
}

/**
 * Research v4 as stored: the answer (a limited one as the server assembled it), the server's record and the server's
 * notices, each apart.
 */
export type AutoResearch = AutoResearchAnswer & { serverRecord: AutoResearchServerRecord; unverified: AutoUnverifiedNotice[] };

/** Research v3 as stored before v4: never accepted from a provider any more, only read back. */
export type AutoResearchV3 = Omit<AutoResearchAnswer, "schema"> & { schema: typeof AUTO_CREATION_RESEARCH_SCHEMA_V3;
  serverRecord: AutoResearchServerRecordV3; unverified: AutoUnverifiedNotice[] };

/** Research v2 as stored before v3: never accepted from a provider any more, only read back. */
export const autoResearchV2Schema = z.object({
  schema: z.literal(AUTO_CREATION_RESEARCH_SCHEMA_V2),
  ...researchFields,
  ...legacyResearchFields,
  contentStructure: z.array(autoContentStructureSchema).min(1).max(6),
}).strict();
export type AutoResearchV2 = z.infer<typeof autoResearchV2Schema>;

/** Research v1 as stored before v2: never accepted from a provider any more, only read back. */
export const autoResearchV1Schema = z.object({
  schema: z.literal(AUTO_CREATION_RESEARCH_SCHEMA_V1),
  ...researchFields,
  ...legacyResearchFields,
  contentStructure: z.array(z.object({
    pattern: text(1, 120),
    why: text(1, 200),
    sourceIds: z.array(z.string().max(40)).max(3),
  }).strict()).min(1).max(6),
}).strict();
export type AutoResearchV1 = z.infer<typeof autoResearchV1Schema>;

/** A research stage's stored output, whichever version wrote it. */
export type AutoStoredResearch = AutoResearch | AutoResearchV3 | AutoResearchV2 | AutoResearchV1;

/** Research the server recorded apart from the answer (v3 and v4): its record is never the AI's restatement. v1 and v2 are. */
export function autoResearchHasServerRecord(research: AutoStoredResearch): research is AutoResearch | AutoResearchV3 {
  return research.schema === AUTO_CREATION_RESEARCH_SCHEMA || research.schema === AUTO_CREATION_RESEARCH_SCHEMA_V3;
}

/** The market evidence record of a stored research: v4 only; older research never recorded it apart. */
export function autoResearchMarketEvidence(research: AutoStoredResearch): AutoResearchServerRecord["marketEvidence"] | null {
  return research.schema === AUTO_CREATION_RESEARCH_SCHEMA ? research.serverRecord.marketEvidence : null;
}

/** The notices of a stored research or directions output: none before checks v5. */
export function autoUnverifiedOf(output: object | null | undefined): AutoUnverifiedNotice[] {
  const notices = output && "unverified" in output ? output.unverified : undefined;
  return Array.isArray(notices) ? notices as AutoUnverifiedNotice[] : [];
}

/**
 * Where a notice is, as a person reads it: by the item's position (第1条假设, 第1条假设的验证计划, 第2条内容结构的本剧应用设计,
 * 第1条机会), never an id made from the index: a research needs unique ids, not ids in order, so the model's own id is
 * added when the research is given (第1条假设（H3）). A direction keeps its id, which the directions check holds to D1, D2…
 * in order.
 */
export function autoNoticePlace(field: string, research?: { hypotheses?: ReadonlyArray<{ id: string }> } | null): string {
  const index = Number(/\[(\d+)\]/u.exec(field)?.[1] ?? "0");
  const nth = `第${String(index + 1)}条`;
  if (field.startsWith("hypotheses[")) {
    const id = research?.hypotheses?.[index]?.id;
    return `${nth}假设${id ? `（${id}）` : ""}${field.endsWith("howToVerify") ? "的验证计划" : ""}`;
  }
  if (field.startsWith("contentStructure[")) return `${nth}内容结构的本剧应用设计`;
  if (field.startsWith("opportunities[")) return `${nth}机会`;
  if (field.startsWith("candidates[")) return `方向 D${String(index + 1)} 的${field.endsWith("difficultyNote") ? "难度说明" : "差异点"}`;
  return field;
}

/** A notice as one line: where, the number, and that it is unverified. Give the research to name a hypothesis by its id too. */
export function autoNoticeText(notice: AutoUnverifiedNotice, research?: { hypotheses?: ReadonlyArray<{ id: string }> } | null): string {
  return `${autoNoticePlace(notice.field, research)}中的「${notice.token}」：${notice.note}；只属于创作假设或设计，不是有来源的事实或市场结论。`;
}

/**
 * A content structure as shown and exported. A v1 item keeps its pattern, why and source ids as stored: it never had
 * a quote, and none is made up for it.
 */
export type AutoStructureView =
  | { version: "v2"; reference: { sourceId: string; quote: string } | null; application: { pattern: string; why: string } }
  | { version: "v1"; pattern: string; why: string; sourceIds: string[] };

export function autoStructureViews(research: AutoStoredResearch): AutoStructureView[] {
  if (research.schema === AUTO_CREATION_RESEARCH_SCHEMA_V1) {
    return research.contentStructure.map((item) => ({ version: "v1", pattern: item.pattern, why: item.why, sourceIds: item.sourceIds }));
  }
  return research.contentStructure.map((item) => ({ version: "v2", reference: item.reference, application: item.application }));
}

const RATING = z.number().int().min(1).max(5);
export const AUTO_RATING_KEYS = ["audienceFit", "conflictStrength", "originality", "feasibility", "constraintFit"] as const;

const directionSchema = z.object({
  id: z.string().regex(/^D[1-3]$/),
  title: text(1, 30),
  logline: text(1, 120),
  protagonist: text(1, 60),
  goal: text(1, 120),
  obstacle: text(1, 120),
  stakes: text(1, 120),
  coreEmotion: text(1, 40),
  differentiation: text(1, 150),
  productionDifficulty: z.enum(["low", "medium", "high"]),
  difficultyNote: text(1, 100),
  audienceFit: text(1, 150),
  evidenceIds: z.array(z.string().regex(/^[FOH][1-8]$/)).max(6),
  ratings: z.object(Object.fromEntries(AUTO_RATING_KEYS.map((key) => [key, RATING])) as Record<(typeof AUTO_RATING_KEYS)[number], typeof RATING>).strict(),
}).strict();
export type AutoDirection = z.infer<typeof directionSchema>;

export const autoDirectionsSchema = z.object({
  schema: z.literal(AUTO_CREATION_DIRECTIONS_SCHEMA),
  candidates: z.array(directionSchema).min(2).max(AUTO_CREATION_MAX_DIRECTIONS),
}).strict();
export type AutoDirections = z.infer<typeof autoDirectionsSchema>;

/** The rule-based choice recorded with the directions. Internal scores, never a market success probability. */
export interface AutoSelection {
  rules: typeof AUTO_CREATION_SELECTION_RULES;
  chosenId: string;
  scores: Array<{ id: string; score: number; excluded: string | null }>;
  reasons: string[];
}

export interface AutoDirectionsOutput extends AutoDirections {
  selection: AutoSelection;
  /** The server's unverified notices on the directions' notes (checks v5); absent before. */
  unverified?: AutoUnverifiedNotice[];
}

const ID_C = z.string().regex(/^C[1-8]$/);
const ID_L = z.string().regex(/^L[1-6]$/);
const ID_P = z.string().regex(/^P[1-6]$/);

export const autoBibleSchema = z.object({
  schema: z.literal(AUTO_CREATION_BIBLE_SCHEMA),
  title: text(1, 30),
  logline: text(1, 150),
  synopsis: text(1, 900),
  story: z.object({
    protagonistId: ID_C,
    desire: text(1, 150),
    weakness: text(1, 150),
    goal: text(1, 150),
    stakes: text(1, 150),
    obstacles: shortList(4, 150).min(1),
    keyChoices: z.array(z.object({ choice: text(1, 150), consequence: text(1, 150) }).strict()).min(1).max(4),
    twist: z.object({ reveal: text(1, 200), setups: shortList(3, 150).min(1) }).strict(),
    payoffs: shortList(4, 150).min(1),
    ending: text(1, 300),
    causalChain: shortList(8, 150).min(3),
  }).strict(),
  characters: z.array(z.object({
    id: ID_C,
    name: text(1, 12),
    identity: text(1, 60),
    goal: text(1, 100),
    weakness: text(1, 100),
    motivation: text(1, 120),
    voice: text(1, 80),
    presence: z.enum(["on_screen", "mentioned"]),
  }).strict()).min(1).max(8),
  relationships: z.array(z.object({ from: ID_C, to: ID_C, relation: text(1, 40), change: text(1, 120) }).strict()).max(10),
  locations: z.array(z.object({
    id: ID_L,
    name: text(1, 20),
    intExt: z.enum(["INT", "EXT"]),
    timeOfDay: text(1, 20),
    layout: text(1, 120),
    productionNotes: text(1, 120),
  }).strict()).min(1).max(6),
  props: z.array(z.object({ id: ID_P, name: text(1, 20), ownerId: ID_C.nullable(), purpose: text(1, 100), change: text(1, 100) }).strict()).max(6),
}).strict();
export type AutoBible = z.infer<typeof autoBibleSchema>;

export function autoOutlineSchema(episodeCount: number) {
  return z.object({
    schema: z.literal(AUTO_CREATION_OUTLINE_SCHEMA),
    episodes: z.array(z.object({
      episodeNo: z.number().int().min(1).max(episodeCount),
      title: text(1, 30),
      opening: text(1, 150),
      goal: text(1, 120),
      obstacle: text(1, 120),
      action: text(1, 150),
      turn: text(1, 150),
      result: text(1, 150),
      newInformation: text(1, 150),
      emotionShift: text(1, 80),
      handoff: text(1, 150),
      characterIds: z.array(ID_C).min(1).max(8),
      locationIds: z.array(ID_L).min(1).max(6),
    }).strict()).length(episodeCount),
    resolution: text(1, 300),
  }).strict();
}
export type AutoOutline = z.infer<ReturnType<typeof autoOutlineSchema>>;

const sceneSchema = z.object({
  sceneNo: z.number().int().min(1).max(10),
  locationId: ID_L,
  timeOfDay: text(1, 20),
  characterIds: z.array(ID_C).min(1).max(8),
  action: text(1, 300),
  dialogue: z.array(z.object({ characterId: ID_C, line: text(1, 80), delivery: z.string().max(20) }).strict()).max(8),
  sound: z.string().max(80),
  shots: z.array(z.object({
    shotNo: z.number().int().min(1).max(8),
    framing: text(1, 20),
    description: text(1, 120),
    seconds: z.number().int().min(1).max(15),
  }).strict()).min(1).max(6),
  assetNeeds: shortList(4, 60),
}).strict();

export function autoEpisodeSchema(episodeCount: number) {
  return z.object({
    schema: z.literal(AUTO_CREATION_EPISODE_SCHEMA),
    episodeNo: z.number().int().min(1).max(episodeCount),
    title: text(1, 30),
    scenes: z.array(sceneSchema).min(1).max(10),
    handoffFacts: shortList(6, 150).min(1),
  }).strict();
}
export type AutoEpisode = z.infer<ReturnType<typeof autoEpisodeSchema>>;

export function autoRevisionSchema(episodeCount: number) {
  return autoEpisodeSchema(episodeCount).extend({
    // R1–R10 from the AI review; K1… from the deterministic checks, which have no fixed count.
    changes: z.array(z.object({ issueId: z.string().regex(/^(R[1-9]|R10|K[1-9][0-9]{0,3})$/), change: text(1, 150) }).strict()).min(1).max(10),
  }).strict();
}
export type AutoRevision = z.infer<ReturnType<typeof autoRevisionSchema>>;

export const AUTO_REVIEW_DIMENSIONS = [
  "characters", "motivation", "goalStakes", "conflictAction", "causality", "twistSetup", "payoffEnding", "dialogue",
  "feasibility", "originality",
] as const;
export type AutoReviewDimension = (typeof AUTO_REVIEW_DIMENSIONS)[number];
export const AUTO_REVIEW_DIMENSION_LABELS: Readonly<Record<AutoReviewDimension, string>> = {
  characters: "人物是否值得关心",
  motivation: "动机是否成立",
  goalStakes: "目标与失败代价是否清楚",
  conflictAction: "冲突是否由人物行动推进",
  causality: "因果、人物认知与时间线是否一致",
  twistSetup: "反转是否有铺垫",
  payoffEnding: "情绪兑现与结局完整",
  dialogue: "台词是否自然",
  feasibility: "场面是否可执行",
  originality: "是否重复、注水或照搬参考",
};

const reviewTarget = z.string().regex(/^(bible|outline|episode:[1-6])$/);

export const autoReviewSchema = z.object({
  schema: z.literal(AUTO_CREATION_REVIEW_SCHEMA),
  verdict: z.enum(["pass", "revise"]),
  dimensions: z.array(z.object({
    key: z.enum(AUTO_REVIEW_DIMENSIONS),
    assessment: text(1, 150),
    internalScore: RATING,
  }).strict()).length(AUTO_REVIEW_DIMENSIONS.length),
  issues: z.array(z.object({
    id: z.string().regex(/^R([1-9]|10)$/),
    dimension: z.enum(AUTO_REVIEW_DIMENSIONS),
    severity: z.enum(["high", "medium", "low"]),
    target: reviewTarget,
    /** A verbatim quote of the target's text. Issues whose quote is not found are kept but never acted on. */
    evidence: text(1, 120),
    problem: text(1, 150),
    suggestion: text(1, 150),
  }).strict()).max(10),
}).strict();
export type AutoReview = z.infer<typeof autoReviewSchema>;

/** A finding of the deterministic checks (code, not a model). */
export interface AutoCheckFinding {
  id: string;
  check: string;
  target: string;
  severity: "high" | "medium";
  detail: string;
}

export interface AutoReviewIssue {
  id: string;
  dimension: AutoReviewDimension;
  severity: "high" | "medium" | "low";
  target: string;
  evidence: string;
  problem: string;
  suggestion: string;
  /** The quote was found in the target text. Unverified issues are shown but never block or drive a revision. */
  evidenceVerified: boolean;
}

/** A review stage's stored output: the model's review with verified evidence, and the code's own findings. */
export interface AutoReviewOutput {
  schema: typeof AUTO_CREATION_REVIEW_SCHEMA;
  checksVersion: AutoCreationChecksVersion;
  verdict: "pass" | "revise";
  dimensions: AutoReview["dimensions"];
  issues: AutoReviewIssue[];
  deterministic: AutoCheckFinding[];
  /** Episodes and their content hashes the review read. */
  reviewed: Record<string, string>;
  /** Code's decision: no high-severity verified issue and no deterministic finding. */
  passed: boolean;
}

export interface AutoSourcesOutput {
  schema: "ads.auto-creation.sources.v1";
  sources: AutoCreationSource[];
  /** sourced: at least one readable, recent market source; limited: planning on limited material. */
  researchMode: "sourced" | "limited";
  notes: string[];
}

export type AutoStageOutput = AutoSourcesOutput | AutoStoredResearch | AutoDirectionsOutput | AutoBible | AutoOutline | AutoEpisode
  | AutoRevision | AutoReviewOutput;

// ---------------------------------------------------------------------------------------------------------------
// Provider JSON Schemas (strict-mode keywords only). Built from the same limits as the zod schemas.

function str(maxLength: number) {
  return { type: "string", maxLength } as const;
}
function obj(properties: Record<string, unknown>) {
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties } as const;
}
function arr(items: unknown, minItems: number, maxItems: number) {
  return { type: "array", minItems, maxItems, items } as const;
}
const strs = (maxItems: number, maxChars: number, minItems = 0) => arr(str(maxChars), minItems, maxItems);
const int = (minimum: number, maximum: number) => ({ type: "integer", minimum, maximum }) as const;
const enumOf = (values: readonly (string | number)[]) =>
  ({ type: typeof values[0] === "number" ? "integer" : "string", enum: [...values] }) as const;

/**
 * The JSON Schema sent with a stage. A research stage needs the run's saved research mode: the limited schema has no
 * facts, observations or audience basis and sources, so the provider is held to the same contract as the prompt and
 * the zod check. It also needs the run's reference catalog: a structure's referenceId is one of its ids or null (only
 * null when it has none). Without a mode or a catalog no research schema is built (the engine stops before reserving).
 */
export function autoCreationJsonSchema(kind: AutoCreationStageKind, episodeCount: number, researchMode: AutoResearchMode | null = null,
  catalog: AutoReferenceCatalog | null = null): { name: string; schema: Record<string, unknown> } {
  const numbers = Array.from({ length: episodeCount }, (_, index) => index + 1);
  const episode = obj({
    schema: enumOf([AUTO_CREATION_EPISODE_SCHEMA]),
    episodeNo: enumOf(numbers),
    title: str(30),
    scenes: arr(obj({
      sceneNo: int(1, 10), locationId: str(2), timeOfDay: str(20), characterIds: strs(8, 2, 1), action: str(300),
      dialogue: arr(obj({ characterId: str(2), line: str(80), delivery: str(20) }), 0, 8),
      sound: str(80),
      shots: arr(obj({ shotNo: int(1, 8), framing: str(20), description: str(120), seconds: int(1, 15) }), 1, 6),
      assetNeeds: strs(4, 60),
    }), 1, 10),
    handoffFacts: strs(6, 150, 1),
  });
  switch (kind) {
    case "research": {
      if (researchMode !== "limited" && researchMode !== "sourced") throw new Error("a research schema needs the run's saved research mode");
      if (!catalog) throw new Error("a research schema needs the run's reference catalog");
      const ids = catalog.entries.map((entry) => entry.referenceId);
      const hypotheses = arr(obj({ id: str(2), statement: str(200), howToVerify: str(150) }), 1, 8);
      const contentStructure = arr(obj({
        referenceId: ids.length > 0 ? { anyOf: [enumOf(ids), { type: "null" }] } : { type: "null" },
        application: obj({ pattern: str(120), why: str(200) }),
      }), 1, 6);
      const opportunities = strs(5, 120, 1);
      if (researchMode === "limited") {
        return { name: "auto_research_limited", schema: obj({
          schema: enumOf([AUTO_CREATION_RESEARCH_ANSWER_SCHEMA]),
          hypotheses,
          audience: obj({ primary: str(120), viewingNeeds: strs(5, 60, 1), emotionalAppeals: strs(5, 60, 1) }),
          contentStructure,
          opportunities,
        }) };
      }
      return { name: "auto_research_sourced", schema: obj({
        schema: enumOf([AUTO_CREATION_RESEARCH_ANSWER_SCHEMA]),
        facts: arr(obj({ id: str(2), statement: str(200), sourceIds: strs(3, 40, 1), evidence: str(200) }), 0, 8),
        observations: arr(obj({ id: str(2), statement: str(200), sourceIds: strs(3, 40, 1) }), 0, 8),
        hypotheses,
        audience: obj({ primary: str(120), viewingNeeds: strs(5, 60, 1), emotionalAppeals: strs(5, 60, 1),
          basis: enumOf(["sourced", "hypothesis"]), sourceIds: strs(5, 40) }),
        contentStructure,
        opportunities,
      }) };
    }
    case "directions":
      return { name: "auto_directions", schema: obj({
        schema: enumOf([AUTO_CREATION_DIRECTIONS_SCHEMA]),
        candidates: arr(obj({
          id: enumOf(["D1", "D2", "D3"]), title: str(30), logline: str(120), protagonist: str(60), goal: str(120),
          obstacle: str(120), stakes: str(120), coreEmotion: str(40), differentiation: str(150),
          productionDifficulty: enumOf(["low", "medium", "high"]), difficultyNote: str(100), audienceFit: str(150),
          evidenceIds: strs(6, 2),
          ratings: obj(Object.fromEntries(AUTO_RATING_KEYS.map((key) => [key, int(1, 5)]))),
        }), 2, AUTO_CREATION_MAX_DIRECTIONS),
      }) };
    case "bible":
      return { name: "auto_bible", schema: obj({
        schema: enumOf([AUTO_CREATION_BIBLE_SCHEMA]),
        title: str(30), logline: str(150), synopsis: str(900),
        story: obj({
          protagonistId: str(2), desire: str(150), weakness: str(150), goal: str(150), stakes: str(150),
          obstacles: strs(4, 150, 1),
          keyChoices: arr(obj({ choice: str(150), consequence: str(150) }), 1, 4),
          twist: obj({ reveal: str(200), setups: strs(3, 150, 1) }),
          payoffs: strs(4, 150, 1), ending: str(300), causalChain: strs(8, 150, 3),
        }),
        characters: arr(obj({ id: str(2), name: str(12), identity: str(60), goal: str(100), weakness: str(100),
          motivation: str(120), voice: str(80), presence: enumOf(["on_screen", "mentioned"]) }), 1, 8),
        relationships: arr(obj({ from: str(2), to: str(2), relation: str(40), change: str(120) }), 0, 10),
        locations: arr(obj({ id: str(2), name: str(20), intExt: enumOf(["INT", "EXT"]), timeOfDay: str(20), layout: str(120),
          productionNotes: str(120) }), 1, 6),
        props: arr(obj({ id: str(2), name: str(20), ownerId: { type: ["string", "null"], maxLength: 2 }, purpose: str(100),
          change: str(100) }), 0, 6),
      }) };
    case "outline":
      return { name: "auto_outline", schema: obj({
        schema: enumOf([AUTO_CREATION_OUTLINE_SCHEMA]),
        episodes: arr(obj({
          episodeNo: enumOf(numbers), title: str(30), opening: str(150), goal: str(120), obstacle: str(120), action: str(150),
          turn: str(150), result: str(150), newInformation: str(150), emotionShift: str(80), handoff: str(150),
          characterIds: strs(8, 2, 1), locationIds: strs(6, 2, 1),
        }), episodeCount, episodeCount),
        resolution: str(300),
      }) };
    case "episode":
      return { name: "auto_episode", schema: episode };
    case "revise":
      return { name: "auto_revision", schema: { ...episode, required: [...episode.required, "changes"], properties: {
        ...episode.properties, changes: arr(obj({ issueId: str(5), change: str(150) }), 1, 10) } } };
    case "review":
      return { name: "auto_review", schema: obj({
        schema: enumOf([AUTO_CREATION_REVIEW_SCHEMA]),
        verdict: enumOf(["pass", "revise"]),
        dimensions: arr(obj({ key: enumOf(AUTO_REVIEW_DIMENSIONS), assessment: str(150), internalScore: int(1, 5) }),
          AUTO_REVIEW_DIMENSIONS.length, AUTO_REVIEW_DIMENSIONS.length),
        issues: arr(obj({ id: str(3), dimension: enumOf(AUTO_REVIEW_DIMENSIONS), severity: enumOf(["high", "medium", "low"]),
          target: str(9), evidence: str(120), problem: str(150), suggestion: str(150) }), 0, 10),
      }) };
    default:
      throw new Error(`no provider schema for ${kind}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Storage records and views.

export type AutoCreationStageState = "pending" | "reserved" | "submitted" | "completed" | "rejected" | "unknown" | "canceled";
export type AutoCreationQuality = "pending" | "passed" | "needs_work";
export type AutoCreationStorySave = "pending" | "saved" | "conflict";
export type AutoCreationScriptSave = "pending" | "saved" | "conflict";

export interface AutoRunRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  actorId: string;
  idempotencyKey: string;
  inputHash: string;
  input: AutoCreationFrozenInput;
  state: TitleWritingRunState;
  errorCode: string | null;
  cancelRequestedAt: string | null;
  executorId: string | null;
  leaseUntil: string | null;
  callCap: number;
  callsUsed: number;
  revisionRoundsUsed: number;
  quality: AutoCreationQuality;
  storySave: AutoCreationStorySave;
  storyRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutoStageRecord {
  runId: string;
  stageKey: string;
  ordinal: number;
  state: AutoCreationStageState;
  attemptNo: number;
  errorCode: string | null;
  output: AutoStageOutput | null;
  outputHash: string | null;
  /** Output hashes of the stages this one was built from, recorded when it completed. */
  dependsOn: Record<string, string> | null;
  scriptSave: AutoCreationScriptSave | null;
  scriptRevisionId: string | null;
  updatedAt: string;
}

export interface AutoCallRecord {
  id: string;
  runId: string;
  workspaceId: string;
  stageKey: string;
  attemptNo: number;
  providerKey: TitleWritingStoredProviderKey;
  model: string;
  requestHash: string;
  state: TitleWritingCallState;
  executorId: string;
  providerRequestId: string | null;
  responseModel: string | null;
  usage: TitleWritingUsageView;
  errorCode: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface AutoRunBundle {
  run: AutoRunRecord;
  stages: AutoStageRecord[];
  calls: AutoCallRecord[];
}

export type AutoRunCreation =
  | { kind: "created" | "existing" | "conflict"; bundle: AutoRunBundle }
  | { kind: "active"; runKind: "auto" | "title"; runId: string }
  | { kind: "blocked"; code: "AUTO_CREATION_ACTIVE_RUN_CAP" }
  | { kind: "blocked"; code: "AUTO_CREATION_DAILY_QUOTA_LOW"; requiredCalls: number; remainingCalls: number }
  | { kind: "project_not_empty" };

export type AutoCallReservation =
  | { kind: "reserved" }
  | { kind: "lost" }
  | { kind: "canceled" }
  | { kind: "blocked"; code: "AUTO_CREATION_RUN_CAP" | "AUTO_CREATION_DAILY_CAP" };

export interface AutoCallFinish {
  state: "completed" | "rejected" | "unknown";
  errorCode: string | null;
  output: AutoStageOutput | null;
  outputHash: string | null;
  dependsOn: Record<string, string> | null;
  providerRequestId: string | null;
  responseModel: string | null;
  usage: TitleWritingUsageView;
}

/**
 * Stop reasons a resume cannot change: every stage completed and the stored outputs could only end the same way again
 * (the same story is formatted again and is still too large). Such a run is final; its package stays readable.
 */
export const AUTO_CREATION_FINAL_ERROR_CODES: readonly string[] = ["story_too_large"];

/**
 * Which check refused a number as a viewing time (market_statistic + viewing_duration), in the order the checks run:
 * a viewing habit word in its clause; a leaving action right after the duration; a viewing verb taking the work itself;
 * a viewing verb right before the duration; a duration longer than the frozen episode; a duration not marked as pending
 * or planned; a unit no observation period uses (in a clause about viewers); no plan verb for the observation. Fixed
 * slugs set by the server, never model text. They say which branch the program took, not whether the answer or the
 * check was right, and they do not restore the refused sentence.
 */
export const AUTO_VIEWING_DURATION_REASONS = [
  "viewing_habit", "leaving_after", "viewing_the_work", "viewing_verb_before",
  "over_episode_length", "not_pending", "not_observation_unit", "no_plan_verb",
] as const;
export type AutoViewingDurationReason = (typeof AUTO_VIEWING_DURATION_REASONS)[number];

/** A reason only on the rule it details, and only one of the fixed slugs; anything else is no reason. */
function viewingReason(rule: string | null | undefined, reason: string | null | undefined): AutoViewingDurationReason | null {
  return rule === "viewing_duration" && (AUTO_VIEWING_DURATION_REASONS as readonly string[]).includes(reason ?? "")
    ? reason as AutoViewingDurationReason : null;
}

/**
 * A refused answer's stored error: its rule, and where it is, as `code@field:category` (e.g.
 * `unsourced_number@limitations[0]:digits`), and since checks v3 for a number also what it was taken for and the
 * sub-rule: `unsourced_number@hypotheses[0].statement:chinese_numeral+market_statistic+audience_count`. A viewing time
 * also names the branch that refused it as a fourth part (`…:digits+market_statistic+viewing_duration+viewing_habit`),
 * from AUTO_VIEWING_DURATION_REASONS only. Field paths name schema keys and indexes only; the other parts are fixed
 * slugs. No text of the model is ever stored. A run's own error keeps the bare rule.
 */
export function autoErrorCodeWith(code: string, field?: string, category?: string, semantic?: string, rule?: string, reason?: string): string {
  const slug = (value?: string) => value?.replace(/[^a-z_]/g, "").slice(0, 40) ?? "";
  const safeField = field?.replace(/[^A-Za-z0-9_.[\]]/g, "").slice(0, 80);
  const parts = [slug(category), slug(semantic), slug(rule)];
  const branch = parts[0] && parts[1] && parts[2] ? viewingReason(parts[2], reason) : null;
  const tail = parts[0] ? (parts[1] ? [...parts.filter(Boolean), ...(branch ? [branch] : [])].join("+") : parts[0]) : "";
  return `${code}${safeField ? `@${safeField}` : ""}${tail ? `:${tail}` : ""}`;
}

/**
 * The parts of a stored error code. A bare code (every code before checks v2) has no field or category; v2 codes no
 * semantic or rule; a code before the viewing-time branch, or with a part that is not one of its fixed slugs, no reason.
 */
export function autoErrorParts(stored: string): { code: string; field: string | null; category: string | null; semantic: string | null; rule: string | null;
  reason: AutoViewingDurationReason | null } {
  const match = /^([^@:]+)(?:@([^:]+))?(?::(.+))?$/.exec(stored);
  if (!match) return { code: stored, field: null, category: null, semantic: null, rule: null, reason: null };
  const [category, semantic, rule, reason] = (match[3] ?? "").split("+");
  return { code: match[1]!, field: match[2] ?? null, category: category || null, semantic: semantic || null, rule: rule || null, reason: viewingReason(rule, reason) };
}

/** True when nothing is left to redo and the run's stop reason is final: a resume would only stop the same way. */
export function autoRunSettledForGood(run: { errorCode: string | null }, stages: ReadonlyArray<{ state: string }>): boolean {
  return run.errorCode !== null && AUTO_CREATION_FINAL_ERROR_CODES.includes(run.errorCode)
    && stages.length > 0 && stages.every((stage) => stage.state === "completed");
}

export type AutoResumePreparation =
  | { kind: "ok" | "replayed"; bundle: AutoRunBundle }
  | { kind: "not_found" | "active" | "active_cap" | "needs_confirmation" | "stale_confirmation" | "key_conflict" | "not_resumable"
    | "provider_unconfigured" | "budget_exhausted" | "blocked" };

/**
 * Why a stopped run cannot be continued as it stands, or null. prompt_too_large: the next stage's request, built from
 * the frozen input and the saved stages, is over the prompt limit (a resume would stop the same way, so none is
 * accepted); research_fetch_unavailable: the run froze a public page read the server no longer offers (a resume is
 * possible again once the read is back); story_too_large: the final stop of a run whose story cannot be saved;
 * research_sources_missing: the research is next but the run has no valid saved source snapshot to take its contract from.
 */
export type AutoResumeBlock = "prompt_too_large" | "research_fetch_unavailable" | "story_too_large" | "research_sources_missing";

export type AutoScriptPlacement =
  | { kind: "ok"; bundle: AutoRunBundle }
  | { kind: "not_found" | "not_ready" | "story_not_saved" | "story_not_approved" | "story_changed" | "plan_mismatch" };

/**
 * Storage of automatic creation runs. Every method is scoped to one workspace. Calls are reserved under the same
 * workspace call lock as title writing and online candidates and count against the same daily cap.
 */
export interface AutoCreationStore {
  storageReady(): Promise<boolean>;
  /** Whether a run of this provider can be stored (the provider CHECK of the new tables names it). */
  providerStorageReady(providerKey: TitleWritingProviderKey): Promise<boolean>;
  findRunByKey(workspaceId: string, actorId: string, idempotencyKey: string): Promise<AutoRunBundle | null>;
  /**
   * Key lookup, input comparison, the project checks (no current story, no running title or auto run), the shared
   * active-run cap, the start quota check and the insert of the run with its initial stages: one atomic step.
   */
  createRun(run: AutoRunRecord, stageKeys: readonly string[], limits: { maxActiveRuns: number; sinceIso: string; maxCallsPerDay: number; requiredCalls: number }): Promise<AutoRunCreation>;
  getRun(workspaceId: string, projectId: string, runId: string): Promise<AutoRunBundle | null>;
  getRunById(workspaceId: string, runId: string): Promise<AutoRunBundle | null>;
  latestRun(workspaceId: string, projectId: string): Promise<AutoRunBundle | null>;
  claimRun(workspaceId: string, runId: string, executorId: string, nowIso: string, leaseUntil: string): Promise<boolean>;
  /** A stage that sends nothing (the source snapshot): completed under the executor's lease. */
  completeLocalStage(workspaceId: string, runId: string, executorId: string, stageKey: string, output: AutoStageOutput, outputHash: string, nowIso: string): Promise<boolean>;
  /** Appends a revision round's stages after the last one, under the executor's lease, and counts the round. */
  appendRound(workspaceId: string, runId: string, executorId: string, stageKeys: readonly string[], round: number, nowIso: string): Promise<boolean>;
  reserveCall(call: AutoCallRecord, limits: { sinceIso: string; maxCallsPerDay: number }, nowIso: string, leaseUntil: string): Promise<AutoCallReservation>;
  markCallSubmitted(workspaceId: string, callId: string, executorId: string, nowIso: string, leaseUntil: string): Promise<"submitted" | "canceled" | "lost">;
  finishCall(workspaceId: string, callId: string, executorId: string, patch: AutoCallFinish, nowIso: string): Promise<boolean>;
  /** Machine draft only: a DRAFT story revision when the project has no current story, recorded on the run atomically. */
  saveStory(workspaceId: string, runId: string, executorId: string, storyText: string, quality: Exclude<AutoCreationQuality, "pending">, nowIso: string): Promise<"saved" | "conflict" | "lost">;
  /** Ends a run held by this executor. quality, when given, records the final review even though nothing was saved. */
  finishRun(workspaceId: string, runId: string, executorId: string, state: Exclude<TitleWritingRunState, "running">, errorCode: string | null, nowIso: string, quality?: Exclude<AutoCreationQuality, "pending">): Promise<boolean>;
  requestCancel(workspaceId: string, projectId: string, runId: string, nowIso: string): Promise<AutoRunBundle | null>;
  /** blocked: the caller found the run cannot be continued as it stands (AutoResumeBlock); refused before any write. */
  prepareResume(workspaceId: string, projectId: string, runId: string, request: { resumeKey: string; requestHash: string; confirmedCallIds: readonly string[]; maxActiveRuns: number; providerReady: boolean; blocked: boolean }, nowIso: string): Promise<AutoResumePreparation>;
  recoverExpired(workspaceId: string, nowIso: string): Promise<number>;
  listClaimable(workspaceId: string, nowIso: string, limit: number): Promise<string[]>;
  /** After a person approved the story: each episode's current version into an episode without a script. */
  placeScripts(workspaceId: string, projectId: string, runId: string, scripts: ReadonlyArray<{ episodeNo: number; stageKey: string; text: string }>, options: { acceptStoryChanged: boolean }, actorId: string, nowIso: string): Promise<AutoScriptPlacement>;
}

export interface AutoCreationStageView {
  stageKey: string;
  kind: AutoCreationStageKind;
  state: AutoCreationStageState;
  attemptNo: number;
  errorCode: string | null;
  output: AutoStageOutput | null;
  /** The stage was built from an upstream version that a later revision replaced. */
  upstreamChanged: boolean;
  /** A later revision replaced this episode version; the current one is named. */
  supersededBy: string | null;
  scriptSave: AutoCreationScriptSave | null;
  scriptRevisionId: string | null;
}

export interface AutoCreationCallView {
  callId: string;
  stageKey: string;
  attemptNo: number;
  providerKey: TitleWritingStoredProviderKey;
  model: string;
  responseModel: string | null;
  providerRequestId: string | null;
  state: TitleWritingCallState;
  errorCode: string | null;
  usage: TitleWritingUsageView;
  billingStatus: "unknown";
  createdAt: string;
  finishedAt: string | null;
}

/** The plan a run was started with, as the page shows it before and after the start. */
export interface AutoCreationBudgetView {
  normalCalls: number;
  worstCalls: number;
  hardCap: number;
  callBudget: number;
  revisionRounds: number;
  revisionsPerRound: number;
  maxOutputTokensPerCall: number;
  maxPromptChars: number;
  billing: "unknown";
}

export interface AutoCreationRunView {
  runId: string;
  projectId: string;
  inputVersion: typeof AUTO_CREATION_INPUT_SCHEMA;
  promptVersion: string;
  idea: string;
  constraints: AutoCreationConstraints;
  episodeCount: number;
  episodeSeconds: number;
  providerKey: TitleWritingStoredProviderKey;
  model: string;
  authorization: AutoCreationAuthorization;
  researchFetch: boolean;
  researchMode: "sourced" | "limited" | null;
  state: TitleWritingRunState;
  errorCode: string | null;
  cancelRequested: boolean;
  budget: AutoCreationBudgetView;
  callsUsed: number;
  callCap: number;
  revisionRoundsUsed: number;
  quality: AutoCreationQuality;
  /** Open issues of the last review when quality is needs_work. */
  openIssues: Array<{ id: string; target: string; severity: string; detail: string }>;
  storySave: AutoCreationStorySave;
  storyRevisionId: string | null;
  /** The script package is complete (saved, viewable, downloadable). Never says anything about a video. */
  packageStatus: "in_progress" | "ready" | "incomplete";
  /** Video production is a separate chain; this feature never reports a finished video. */
  videoStatus: "not_started";
  /** Current version of each episode (episode:k or its latest revision). */
  currentEpisodes: Record<string, string>;
  stages: AutoCreationStageView[];
  calls: AutoCreationCallView[];
  legacyProviderRun: boolean;
  /** Set when this stopped run cannot be continued as it stands; the page then offers no resume. */
  resumeBlock: AutoResumeBlock | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutoCreationOptionsView {
  enabled: boolean;
  code: string;
  storageReady: boolean;
  operatorTokenRequired: boolean;
  defaultProvider: TitleWritingProviderKey | null;
  providers: Array<{ providerKey: TitleWritingProviderKey; label: string; ready: boolean; models: string[]; defaultModel: string | null; missing: string[] }>;
  configurationPending?: boolean;
  maxCallsPerDay: number;
  maxActiveRuns: number;
  billing: "unknown";
  episodePlan: { minEpisodes: number; maxEpisodes: number; defaultEpisodes: number; secondsChoices: number[]; defaultSeconds: number };
  episodePlanReady: boolean;
  revisionRounds: { max: number; default: number };
  maxOutputTokensPerCall: number;
  maxPromptChars: number;
  research: {
    /** Whether the server reads public pages (the allowlisted hosts only). */
    fetchEnabled: boolean;
    allowedHosts: string[];
    /** The built-in snapshot: how many entries, and how many of them have readable market data. */
    builtInSources: number;
    readableMarketSources: number;
    expectedMode: "sourced" | "limited";
    visualAnalysis: false;
  };
  /** The media chain behind the script package: real providers configured (none in this build) and what is missing. */
  media: { realProviders: string[]; mockOnly: boolean; missing: string[] };
}

export const autoCreationResumeSchema = z.object({
  confirmUncertainCallIds: z.array(z.string().uuid()).max(20).default([]),
}).strict();

export const autoCreationPlaceSchema = z.object({ acceptStoryChanged: z.boolean().default(false) }).strict();

export const AUTO_CREATION_SECONDS_CHOICES = TITLE_WRITING_EPISODE_SECONDS_CHOICES;
