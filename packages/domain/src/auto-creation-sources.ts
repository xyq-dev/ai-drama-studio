import { createHash } from "node:crypto";
import {
  AUTO_CREATION_RECENT_DAYS,
  type AutoCreationFrozenInput,
  type AutoCreationSource,
  type AutoSourcesOutput,
} from "@ai-drama/contracts";

/**
 * The research input layer of automatic creation. Every conclusion a run draws must cite one of these entries, and a
 * quoted fact must be found in the entry's excerpt. Nothing here claims more than was read: the official Ocean
 * Engine entries were requested on 2026-10-18 and returned script-rendered shells without a title or body, so they are
 * recorded as unreadable, with no excerpt. No entry carries audience, viewing, completion or revenue numbers.
 */

export const OCEAN_ENGINE_ENTRY_URLS = [
  "https://support.oceanengine.com/support/content/24081408258?mappingType=1&spaceId=467",
  "https://school.oceanengine.com/premium/course/7336028836495424593",
  "https://school.oceanengine.com/premium/course/7336028836495436548",
] as const;

/** Hosts the server may read public pages from when reading is switched on. Every address is still checked. */
export const AUTO_CREATION_DEFAULT_ALLOWED_HOSTS = ["support.oceanengine.com", "school.oceanengine.com"] as const;

const SNAPSHOT_FETCHED_AT = "2026-10-18T00:00:00.000Z";

/**
 * Craft guidance this project adapted from drama-skills (MIT, commit c2426e03c0e7722bebcc6a488b6658dc38c65ac3,
 * docs/DRAMA_SKILLS_SOURCE.md, read 2026-10-04) as it stands in the repository's writing prompts. Structure and
 * pacing knowledge only: it says nothing about any audience or market.
 */
const CRAFT_EXCERPT = [
  "主角要有具体、能通过行动完成的目标；阻碍者出于自己的利益阻止主角。",
  "关键结果来自主角的选择和行动，不靠旁人突然解围。",
  "每集回答：开场局面、本集目标、主角行动、新信息带来的转折、相比开场的变化与兑现给观众的回报、结尾留下的问题。",
  "反转要有前文依据；不凭空新增解围人物或决定性证据。",
  "冲突逐集升级：增加代价、缩短时间或提高选择难度；不同集不重复同一冲突。",
  "不靠重复羞辱或人物故意不沟通拖延剧情。",
  "台词表达人物意图，不重复解释已经演出来的信息。",
  "最后一集写清主线问题如何收束，兑现整部作品承诺的情绪。",
].join("\n");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The built-in snapshot, as of its fetch date. A run may replace the official entries with a fresh read. */
export function builtInSources(): AutoCreationSource[] {
  const official = OCEAN_ENGINE_ENTRY_URLS.map((locator, index): AutoCreationSource => ({
    sourceId: `S-OE-${String(index + 1)}`,
    kind: "official_page",
    title: index === 0 ? "巨量引擎帮助中心条目（标题未能读取）" : "巨量学堂课程页（标题未能读取）",
    locator,
    publishedAt: null,
    fetchedAt: SNAPSHOT_FETCHED_AT,
    readScope: "none",
    status: "unreadable",
    topic: "market",
    excerpt: "",
    contentHash: null,
    limitations: "2026-10-18 请求得到的是前端脚本渲染的空壳，没有标题或正文；课程内容可能需要登录。没有读取任何正文、字幕、音频或画面，不能支持任何结论。",
  }));
  return [
    ...official,
    {
      sourceId: "S-KB-CRAFT",
      kind: "knowledge_base",
      title: "短剧写作方法（项目知识库，改编自 drama-skills MIT 版本）",
      locator: "repo:docs/DRAMA_SKILLS_SOURCE.md#c2426e03c0e7722bebcc6a488b6658dc38c65ac3",
      publishedAt: null,
      fetchedAt: "2026-10-04T00:00:00.000Z",
      readScope: "full_text",
      status: "read",
      topic: "craft",
      excerpt: CRAFT_EXCERPT,
      contentHash: sha256(CRAFT_EXCERPT),
      limitations: "只涉及故事结构、节奏和台词方法，不含任何受众、播放、完播或收入数据；是写作方法，不是平台规则。",
    },
  ];
}

/** A page read for a run (by the server's checked fetcher). Text is untrusted data. */
export interface FetchedPage {
  url: string;
  status: AutoCreationSource["status"];
  title: string | null;
  text: string;
  publishedAt: string | null;
  fetchedAt: string;
  note: string;
}

const EXCERPT_MAX = 1_500;

/** Removes markup, control characters and long whitespace; the result is quoted as data, never followed. */
export function cleanExcerpt(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, EXCERPT_MAX);
}

function isRecent(publishedAt: string | null, nowIso: string): boolean {
  if (!publishedAt) return false;
  const age = Date.parse(nowIso) - Date.parse(publishedAt);
  return Number.isFinite(age) && age >= 0 && age <= AUTO_CREATION_RECENT_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * The snapshot of one run: built-in entries (official ones replaced by this run's reads when reading was on), pages
 * the run read, and the person's own materials. A run is "sourced" only with a readable, dated, recent market source.
 */
export function collectSources(input: AutoCreationFrozenInput, pages: readonly FetchedPage[], nowIso: string): AutoSourcesOutput {
  const sources = builtInSources().map((source) => {
    const page = pages.find((item) => item.url === source.locator);
    return page ? pageSource(source.sourceId, "official_page", page) : source;
  });
  const extra = pages.filter((page) => !sources.some((source) => source.locator === page.url));
  extra.forEach((page, index) => sources.push(pageSource(`S-WEB-${String(index + 1)}`, "public_page", page)));
  input.materials.forEach((material, index) => {
    const excerpt = cleanExcerpt(material.text);
    sources.push({
      sourceId: `S-USER-${String(index + 1)}`,
      kind: "user_material",
      title: material.title,
      locator: `user-material:${String(index + 1)}:${sha256(material.text).slice(0, 16)}`,
      publishedAt: null,
      fetchedAt: nowIso,
      readScope: material.kind === "subtitles" ? "subtitles" : "full_text",
      status: "read",
      topic: "reference",
      excerpt,
      contentHash: sha256(material.text),
      limitations: `${material.text.length > EXCERPT_MAX ? `只引用前 ${String(EXCERPT_MAX)} 字。` : ""}使用者声明拥有使用权限的文字资料；只分析结构与需求，不复制台词、人物组合或具体情节。没有画面或音频。`,
    });
  });
  const marketReadable = sources.some((source) => source.topic === "market" && source.status === "read" && isRecent(source.publishedAt, nowIso));
  const notes = [
    "没有视频画面或音频理解能力：所有参考内容只按文字（正文、简介或字幕）分析，没有观看任何视频。",
    ...(input.researchFetch ? [] : ["服务端没有开启公开页面读取，本次只使用内置资料快照和你提供的资料。"]),
    ...(marketReadable ? [] : ["没有可读取的近期市场资料：本次为「资料有限策划模式」，受众与市场判断都是待验证假设，不是实时市场验证。"]),
  ];
  return { schema: "ads.auto-creation.sources.v1", sources, researchMode: marketReadable ? "sourced" : "limited", notes };
}

function pageSource(sourceId: string, kind: AutoCreationSource["kind"], page: FetchedPage): AutoCreationSource {
  const excerpt = page.status === "read" ? cleanExcerpt(page.text) : "";
  return {
    sourceId,
    kind,
    title: page.title?.slice(0, 120) || "（页面没有可读标题）",
    locator: page.url,
    publishedAt: page.publishedAt,
    fetchedAt: page.fetchedAt,
    readScope: excerpt.length > 0 ? "full_text" : "none",
    status: excerpt.length > 0 ? page.status : page.status === "read" ? "unreadable" : page.status,
    // Only the known official entries are market material; a page a person named is reference material, so a dated
    // help or craft page can never make a run "sourced".
    topic: kind === "official_page" ? "market" : "reference",
    excerpt,
    contentHash: excerpt.length > 0 ? sha256(excerpt) : null,
    limitations: page.note,
  };
}

/** Readable entries of a snapshot, the only ones a conclusion may cite. */
export function readableSources(output: AutoSourcesOutput): AutoCreationSource[] {
  return output.sources.filter((source) => source.status === "read" && source.excerpt.length > 0);
}
