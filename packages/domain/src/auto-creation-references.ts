import { createHash } from "node:crypto";
import {
  AUTO_CREATION_RESEARCH_SCHEMA,
  AUTO_REFERENCE_CATALOG_MAX_CHARS,
  AUTO_REFERENCE_CATALOG_MAX_ENTRIES,
  AUTO_REFERENCE_CATALOG_PER_SOURCE,
  AUTO_REFERENCE_CATALOG_VERSION,
  AUTO_STRUCTURE_QUOTE_MAX,
  AUTO_STRUCTURE_QUOTE_MIN,
  type AutoCatalogContentStructure,
  type AutoContentStructure,
  type AutoReferenceCatalog,
  type AutoReferenceEntry,
  type AutoResearchAnswer,
  type AutoResearchCatalogAnswer,
  type AutoResearchLimitedAnswer,
  type AutoResearchLimitedCatalogAnswer,
  type AutoSourcesOutput,
} from "@ai-drama/contracts";
import { numberTokens } from "./auto-creation-numbers";
import { AUTO_SOURCE_EXCERPT_MAX, readableSources } from "./auto-creation-sources";
import { canonicalInputHash } from "./text-chain";

/**
 * The reference catalog (prompt v9, checks v10): the passages a research may cite as a method, cut by code from the
 * run's saved source snapshot, so a model picks a passage by its id instead of copying one out. Nothing is fetched or
 * read but the snapshot; only the sources a research could already cite (readableSources) give passages, and a passage
 * is a method quote only: it sources no number or finding of the work's own design.
 */

export function withoutWhitespace(value: string): string {
  return value.replace(/\s+/g, "");
}

/** Characters a written number is made of: a quote that starts or ends next to one of them cuts that number. */
const NUMERAL_CHAR = /[0-9０-９零〇一二两三四五六七八九十百千万亿.．]/u;
/** What may stand right after a quote that ends on a numeral: the end of a sentence or clause, never more of it. */
const AFTER_NUMBER_OK = /[。；;！？!?、：:）)」”"'\s]/u;
/**
 * A separator that may join two numerals into one number (1,800, 25-35, 25－35, 1/3, 3：1, 25至35, 3比1): any symbol
 * or punctuation but a sentence or clause end, and 至, 到 or 比.
 */
const NUMBER_JOINER = /[至到比]|[^\p{Script=Han}\p{L}\p{N}。；;！？!?、\s（(「“"'）)」”]/u;

/**
 * Whether a quote (both without whitespace) stands in the excerpt with no number cut at either edge: 一次反转 is no
 * quote of 二十一次反转, nor 60秒 of 160秒, nor …七 of 七成. Every number inside a contiguous quote is then the excerpt's own.
 */
export function quotedWhole(excerpt: string, quote: string): boolean {
  for (let at = excerpt.indexOf(quote); at >= 0; at = excerpt.indexOf(quote, at + 1)) {
    const before = excerpt[at - 1] ?? "";
    // A quote opening on a separator of a number (,800 of 1,800, -35 of 25-35) opens inside that number too.
    const opensOnNumber = NUMERAL_CHAR.test(quote[0]!) || (NUMBER_JOINER.test(quote[0]!) && NUMERAL_CHAR.test(quote[1] ?? ""));
    const cutBefore = opensOnNumber && (NUMERAL_CHAR.test(before) || /[A-Za-z]/u.test(before)
      || (NUMBER_JOINER.test(before) && NUMERAL_CHAR.test(excerpt[at - 2] ?? "")));
    const end = at + quote.length;
    // A quote ending on a numeral must end where the excerpt's sentence or clause does: 10 of 10w, 90 of 90后, 七 of 七成,
    // 1 of 1,800 are all cuts. A comma counts as an end only when no digit follows it.
    const after = excerpt[end] ?? "";
    const last = quote.at(-1)!;
    // Ending on a separator right after a numeral (约1, of 1,800) ends inside the number unless no numeral follows.
    if (NUMBER_JOINER.test(last) && NUMERAL_CHAR.test(quote.at(-2) ?? "") && NUMERAL_CHAR.test(after)) continue;
    const cutAfter = after !== "" && NUMERAL_CHAR.test(last)
      && !(AFTER_NUMBER_OK.test(after) || (/[,，]/u.test(after) && !/[0-9０-９]/u.test(excerpt[end + 1] ?? "")));
    if (!cutBefore && !cutAfter) return true;
  }
  return false;
}

/** A sentence ends at one of these (kept with it); a line ends at a line break. Nothing else cuts a passage. */
const SENTENCE = /[^。！？!?；;\n]+[。！？!?；;]*/gu;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

/**
 * Whether a passage may stand as a structure's quote of this excerpt, by the same rules the research check holds a
 * quote to: the quote's length limits (whitespace does not count toward the shortest), found whole (no number cut at
 * either edge), and every number in it a whole number of the excerpt.
 */
function quotable(excerpt: string, quote: string): boolean {
  if (quote.length > AUTO_STRUCTURE_QUOTE_MAX || withoutWhitespace(quote).length < AUTO_STRUCTURE_QUOTE_MIN || CONTROL.test(quote)) return false;
  if (!quotedWhole(withoutWhitespace(excerpt), withoutWhitespace(quote))) return false;
  const supported = new Set(numberTokens(excerpt).map(withoutWhitespace));
  return numberTokens(quote).every((token) => supported.has(withoutWhitespace(token)));
}

/**
 * The whole sentences or lines of an excerpt, in order, with where each starts; trimmed, never cut or joined. An excerpt
 * kept at its length limit may end inside a sentence (or a number): its last passage is left out unless a sentence end
 * closes it.
 */
function passages(excerpt: string): Array<{ offset: number; quote: string }> {
  const found: Array<{ offset: number; quote: string }> = [];
  for (const match of excerpt.matchAll(SENTENCE)) {
    const raw = match[0];
    const quote = raw.trim();
    const cutShort = excerpt.length >= AUTO_SOURCE_EXCERPT_MAX && match.index + raw.length === excerpt.length && !/[。！？!?；;]$/u.test(quote);
    if (quote.length > 0 && !cutShort) found.push({ offset: match.index + raw.indexOf(quote), quote });
  }
  return found;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * An entry's id: a digest of the catalog version, its source (id and content hash), where the passage starts and the
 * passage itself. The same passage of the same source always has the same id; a passage of another source, another
 * text or another catalog version never has it.
 */
function referenceId(sourceId: string, contentHash: string | null, offset: number, quote: string): string {
  return `R-${sha256([AUTO_REFERENCE_CATALOG_VERSION, sourceId, contentHash ?? "", String(offset), quote].join("\n")).slice(0, 10)}`;
}

/**
 * The catalog of a saved source snapshot: each readable source in snapshot order, its quotable sentences or lines in
 * excerpt order, at most AUTO_REFERENCE_CATALOG_PER_SOURCE from one source and AUTO_REFERENCE_CATALOG_MAX_ENTRIES in all,
 * the entries as JSON at most AUTO_REFERENCE_CATALOG_MAX_CHARS. A passage too long or short, cutting a number, or
 * repeating one already listed is skipped; at a limit whole entries are left out, never a quote cut. Deterministic: no
 * time, no randomness. A snapshot with nothing quotable gives a catalog without entries.
 */
export function autoReferenceCatalog(sources: AutoSourcesOutput): AutoReferenceCatalog {
  const entries: AutoReferenceEntry[] = [];
  let size = 2;
  for (const source of readableSources(sources)) {
    const seen = new Set<string>();
    let fromSource = 0;
    for (const { offset, quote } of passages(source.excerpt)) {
      if (entries.length >= AUTO_REFERENCE_CATALOG_MAX_ENTRIES || fromSource >= AUTO_REFERENCE_CATALOG_PER_SOURCE) break;
      if (seen.has(quote) || !quotable(source.excerpt, quote)) continue;
      const entry = { referenceId: referenceId(source.sourceId, source.contentHash, offset, quote), sourceId: source.sourceId, quote };
      // Ids are unique: a digest already listed (never expected) leaves the later passage out rather than naming two.
      if (entries.some((listed) => listed.referenceId === entry.referenceId)) continue;
      const added = JSON.stringify(entry).length + (entries.length > 0 ? 1 : 0);
      if (size + added > AUTO_REFERENCE_CATALOG_MAX_CHARS) continue;
      seen.add(quote);
      entries.push(entry);
      size += added;
      fromSource += 1;
    }
  }
  return { version: AUTO_REFERENCE_CATALOG_VERSION, entries, hash: canonicalInputHash({ version: AUTO_REFERENCE_CATALOG_VERSION, entries }) };
}

/** The catalog of a snapshot if it is a valid one (the same test that picks the research mode), else none. */
export function autoReferenceCatalogOf(sources: AutoSourcesOutput | undefined): AutoReferenceCatalog | undefined {
  if (!sources || sources.schema !== "ads.auto-creation.sources.v1" || !Array.isArray(sources.sources)) return undefined;
  if (sources.researchMode !== "limited" && sources.researchMode !== "sourced") return undefined;
  return autoReferenceCatalog(sources);
}

export type AutoReferenceMapping<T> = { ok: true; research: T } | { ok: false; code: "unknown_reference"; field: string; detail: string };

/**
 * The content structures of a strictly accepted answer, with each catalog id replaced by its entry's source and quote,
 * and null kept as null (the work's own design). An id the catalog lacks refuses the answer: it is never dropped,
 * nulled or swapped for a near one. The application is kept as written; mapping makes it no finding.
 */
function mapStructures(items: readonly AutoCatalogContentStructure[], catalog: AutoReferenceCatalog): AutoReferenceMapping<AutoContentStructure[]> {
  const byId = new Map(catalog.entries.map((entry) => [entry.referenceId, entry] as const));
  const mapped: AutoContentStructure[] = [];
  for (const [index, item] of items.entries()) {
    if (item.referenceId === null) {
      mapped.push({ reference: null, application: item.application });
      continue;
    }
    const entry = byId.get(item.referenceId);
    if (!entry) return { ok: false, code: "unknown_reference", field: `contentStructure[${String(index)}].referenceId`, detail: item.referenceId };
    mapped.push({ reference: { sourceId: entry.sourceId, quote: entry.quote }, application: item.application });
  }
  return { ok: true, research: mapped };
}

/** A sourced answer (prompt v9) as the research v4 answer it stands for, before the research checks. */
export function autoMapResearchAnswer(answer: AutoResearchCatalogAnswer, catalog: AutoReferenceCatalog): AutoReferenceMapping<AutoResearchAnswer> {
  const structures = mapStructures(answer.contentStructure, catalog);
  if (!structures.ok) return structures;
  return { ok: true, research: { schema: AUTO_CREATION_RESEARCH_SCHEMA, facts: answer.facts, observations: answer.observations, hypotheses: answer.hypotheses,
    audience: answer.audience, contentStructure: structures.research, opportunities: answer.opportunities } };
}

/** A limited answer (prompt v9) as research v4's limited answer, before the server assembles the rest. */
export function autoMapLimitedResearchAnswer(answer: AutoResearchLimitedCatalogAnswer, catalog: AutoReferenceCatalog): AutoReferenceMapping<AutoResearchLimitedAnswer> {
  const structures = mapStructures(answer.contentStructure, catalog);
  if (!structures.ok) return structures;
  return { ok: true, research: { schema: AUTO_CREATION_RESEARCH_SCHEMA, hypotheses: answer.hypotheses, audience: answer.audience,
    contentStructure: structures.research, opportunities: answer.opportunities } };
}
