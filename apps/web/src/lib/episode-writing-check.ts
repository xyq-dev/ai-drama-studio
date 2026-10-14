import type { EpisodeOutline, EpisodeOutlineEpisode, TitleConcept } from "@ai-drama/contracts";

/**
 * The writing check of an episode plan (the run's story concept and episode outline). It reads the structured fields
 * that are already on the page: no model request, no network, nothing written or rewritten.
 *
 * Three kinds of findings, never a score and never a "pass":
 * - missing: only a structural gap (an episode or field that is not there) or an unmistakable placeholder;
 * - manual: a question only a person can judge (protagonist agency, payoff, cause, escalation, and textual hints such
 *   as an opening and result written identically or a goal repeated from the previous episode), shown with the field
 *   text it should be judged on;
 * - undetermined: the fields that would answer it are not there to read (empty or a placeholder). A question is only
 *   manual when it has written text to judge.
 * Complete fields do not mean a good story.
 */
export type EpisodeWritingFindingKind = "missing" | "manual" | "undetermined";

export interface EpisodeWritingFinding {
  id: string;
  /** null for the whole story (the concept), otherwise the episode number. */
  episodeNo: number | null;
  kind: EpisodeWritingFindingKind;
  question: string;
  /** The field and the text the finding is based on. */
  evidence: string;
  why: string;
  suggestion: string;
}

export interface EpisodeWritingGroup {
  episodeNo: number | null;
  label: string;
  findings: EpisodeWritingFinding[];
}

export interface EpisodeWritingCheck {
  groups: EpisodeWritingGroup[];
  counts: Record<EpisodeWritingFindingKind, number>;
}

export const EPISODE_WRITING_KIND_LABELS: Record<EpisodeWritingFindingKind, string> = {
  missing: "明确缺项",
  manual: "待人工判断",
  undetermined: "当前无法判断",
};

const FIELD_LABELS: Record<keyof Omit<EpisodeOutlineEpisode, "episodeNo">, string> = {
  title: "标题",
  entryState: "进入状态",
  goal: "目标",
  action: "行动",
  turn: "转折",
  result: "结果",
  handoff: "交给下一集",
};

const EXCERPT_CHARS = 60;
const PLACEHOLDERS = new Set(["待定", "待补充", "无", "暂无", "略", "同上", "未定", "tbd", "todo", "n/a", "na", "null", "none"]);

function normalized(value: string | undefined | null): string {
  return (value ?? "").replace(/\s+/g, "").toLowerCase();
}

/** Empty, only punctuation, or a word that stands for "not written yet". */
export function blankOrPlaceholder(value: string | undefined | null): boolean {
  const text = normalized(value);
  if (text.length === 0) return true;
  if (/^[.。…·\-—_?？!！,，、~～*]+$/.test(text)) return true;
  return PLACEHOLDERS.has(text);
}

function excerpt(value: string): string {
  const text = value.trim().replace(/\s+/g, " ");
  return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}…` : text;
}

function quoted(label: string, value: string | undefined | null): string {
  const text = (value ?? "").trim();
  return text.length === 0 ? `${label}：（空）` : `${label}：“${excerpt(text)}”`;
}

function field(episode: EpisodeOutlineEpisode, key: keyof typeof FIELD_LABELS, isLast = false, finaleClosure = true): string {
  // Only guided prompts define the final handoff as closure; legacy fields keep neutral semantics.
  const label = key === "handoff" && isLast ? (finaleClosure ? "全剧收尾" : "结尾记录") : FIELD_LABELS[key];
  return quoted(`第 ${String(episode.episodeNo)} 集 ${key}（${label}）`, episode[key]);
}

interface Requirement {
  key: keyof typeof FIELD_LABELS;
  question: string;
  why: string;
  suggestion: string;
  /** What the same field is for in the last episode, when that differs. */
  last?: { question: string; why: string; suggestion: string };
}

/** The per-episode questions an existing field answers directly; an empty one is an objective gap. */
const REQUIRED: Requirement[] = [
  { key: "goal", question: "主角本集要完成什么？", why: "没有本集目标，观众不知道这一集在追什么，行动和结果也无从衡量。",
    suggestion: "写一个能通过行动完成的具体目标，例如“在会议开始前拿回被调换的合同原件”。" },
  { key: "action", question: "主角采取什么行动？", why: "没有主角的行动，本集的结果只能靠别人或巧合推动。",
    suggestion: "写主角为目标做的具体选择和行动，例如“主动约见对方，提出用自己的项目做交换”。" },
  { key: "entryState", question: "本集开场是什么局面？", why: "没有开场局面，就无法判断这一集让局面发生了什么变化。",
    suggestion: "写开场时主角的处境，以及本集谁出于什么利益阻止主角。" },
  { key: "result", question: "相比开场，局面发生什么变化？", why: "没有结果，本集给观众的回报和留给下一集的处境都不清楚。",
    suggestion: "写本集结束时局面的变化，并写清本集解决了哪一部分问题。" },
  { key: "handoff", question: "结尾留下什么与主线相关的问题？", why: "没有交接内容，下一集缺少开场依据，观众也缺少续看理由。",
    suggestion: "写一个与主线相关、下一集会回应的问题，例如“对方手里还有第二份录音”。",
    last: { question: "最后一集怎样收束主线、回应整部期待？", why: "最后一集没有收尾内容，主线的结果和整部期待都没有交代。",
      suggestion: "写清主线问题怎样了结、主角最终得到或失去了什么，并回应故事走向里的整部期待。" } },
];

function missing(episodeNo: number, requirement: Requirement, episode: EpisodeOutlineEpisode, isLast: boolean, finaleClosure: boolean): EpisodeWritingFinding {
  const text = isLast && requirement.last ? (finaleClosure ? requirement.last : {
    question: "最后一集的结尾记录是什么？", why: "结尾记录为空，无法核对本集留下的信息。",
    suggestion: "补写本集结尾已经发生的事实；旧版本字段不强制承担全剧收束。",
  }) : requirement;
  return { id: `${String(episodeNo)}:missing:${requirement.key}`, episodeNo, kind: "missing", question: text.question,
    evidence: field(episode, requirement.key, isLast, finaleClosure), why: text.why, suggestion: text.suggestion };
}

function storyFindings(concept: TitleConcept | null): EpisodeWritingFinding[] {
  if (!concept) {
    return [{ id: "story:undetermined:concept", episodeNo: null, kind: "undetermined", question: "整部期待、主角目标和阻力是否明确？",
      evidence: "这次创作没有可读的故事策划。", why: "整部期待和阻力决定各集的方向，没有策划就无法核对。",
      suggestion: "故事策划完成后再检查；也可以在故事草稿里直接补写。" }];
  }
  const findings: EpisodeWritingFinding[] = [];
  if (blankOrPlaceholder(concept.protagonistGoal)) {
    findings.push({ id: "story:missing:protagonistGoal", episodeNo: null, kind: "missing", question: "主角的目标是什么？",
      evidence: quoted("故事策划 protagonistGoal（主角目标）", concept.protagonistGoal), why: "没有主角目标，各集的行动和阻力没有共同方向。",
      suggestion: "写一个具体、可以通过行动完成的目标，例如“在三十天内证明自己没有挪用公款”。" });
  }
  if (blankOrPlaceholder(concept.opposition)) {
    findings.push({ id: "story:missing:opposition", episodeNo: null, kind: "missing", question: "谁出于什么利益阻止主角？",
      evidence: quoted("故事策划 opposition（阻力）", concept.opposition), why: "没有明确的阻力，冲突只能靠误会或巧合维持。",
      suggestion: "写清阻止者是谁、为了保住什么利益，例如“副总怕账目暴露，抢先把责任推给主角”。" });
  }
  const promise = { question: "整部期待是否明确：观众希望主角最终得到什么？", evidence: quoted("故事策划 direction（故事走向）", concept.direction),
    suggestion: "在故事走向开头用一句话写明，例如“观众期待她当众洗清污名，并决定是否原谅家人”。" };
  findings.push(blankOrPlaceholder(concept.direction)
    ? { id: "story:undetermined:promise", episodeNo: null, kind: "undetermined", ...promise, why: "故事走向是空的或只是占位文字，无法核对整部期待。" }
    : { id: "story:manual:promise", episodeNo: null, kind: "manual", ...promise, why: "整部期待决定观众为什么一路看下去，各集回报都应朝它推进。" });
  return findings;
}

function episodeFindings(episode: EpisodeOutlineEpisode, previous: EpisodeOutlineEpisode | undefined, next: EpisodeOutlineEpisode | undefined,
  concept: TitleConcept | null, isLast: boolean, finaleClosure: boolean): EpisodeWritingFinding[] {
  const no = episode.episodeNo;
  const findings: EpisodeWritingFinding[] = [];
  const blank = (key: keyof typeof FIELD_LABELS) => blankOrPlaceholder(episode[key]);
  for (const requirement of REQUIRED) if (blank(requirement.key)) findings.push(missing(no, requirement, episode, isLast, finaleClosure));
  // Identical text is a hint, not proof: the change may be written elsewhere (action, turn) or meant as a reversal.
  if (!blank("entryState") && !blank("result") && normalized(episode.entryState) === normalized(episode.result)) {
    findings.push({ id: `${String(no)}:manual:change`, episodeNo: no, kind: "manual", question: "相比开场，本集是否发生了实质变化？",
      evidence: `${field(episode, "entryState")}；${field(episode, "result")}（两处文字相同）`,
      why: "开场和结果文字相同时，读者可能看不出本集带来了什么变化；文字相同本身不能说明剧情没有推进。",
      suggestion: "核对行动和转折是否已经写出变化；如果没有，改写结果：本集结束时谁的处境、关系或掌握的信息变了。" });
  }

  // Who blocks the protagonist in this episode has no field of its own: a person reads the opening and the turn.
  if (blank("entryState") && blank("turn")) {
    findings.push({ id: `${String(no)}:undetermined:obstacle`, episodeNo: no, kind: "undetermined", question: "本集谁出于什么利益阻止主角？",
      evidence: `${field(episode, "entryState")}；${field(episode, "turn")}`, why: "能写阻力的两处都是空的，无法核对。",
      suggestion: "在进入状态里写明本集的阻止者和他的利益。" });
  } else {
    // The evidence is what the judgment reads: the written opening, the written turn and the story's opposition.
    const read = [
      ...(blank("entryState") ? [] : [field(episode, "entryState")]),
      ...(blank("turn") ? [] : [field(episode, "turn")]),
      ...(concept && !blankOrPlaceholder(concept.opposition) ? [`整部阻力：“${excerpt(concept.opposition)}”`] : []),
    ];
    findings.push({ id: `${String(no)}:manual:obstacle`, episodeNo: no, kind: "manual", question: "本集谁出于什么利益阻止主角？",
      evidence: read.join("；"),
      why: "阻止者的利益越具体，冲突越可信；只有“被刁难”而没有原因时，冲突容易变成重复羞辱。",
      suggestion: "如果读不出阻止者和他的利益，在进入状态里补一句，例如“表姐怕遗嘱公开后失去房子，抢先藏起钥匙”。" });
  }
  // Agency compares the action with the result: without both there is nothing to trace.
  const traceable = !blank("action") && !blank("result");
  findings.push({ id: `${String(no)}:${traceable ? "manual" : "undetermined"}:agency`, episodeNo: no, kind: traceable ? "manual" : "undetermined",
    question: "本集关键结果是否来自主角的选择和行动？", evidence: `${field(episode, "action")}；${field(episode, "result")}`,
    why: traceable ? "结果如果靠旁人解围或巧合，主角显得被动，回报也不够有力。" : "行动和结果没有都写出来，无法判断结果是否来自主角的行动。",
    suggestion: traceable ? "核对结果能否追溯到行动；不能时，把关键一步改成主角自己做出的选择。" : "补写本集主角的行动和结果，再核对两者能否对上。" });
  if (blank("turn")) {
    findings.push({ id: `${String(no)}:undetermined:information`, episodeNo: no, kind: "undetermined", question: "谁获得了什么新信息？反转是否有前置依据？",
      evidence: field(episode, "turn"), why: "转折是空的，无法判断信息差和反转。", suggestion: "在转折里写明谁知道了什么，以及它改变了谁的行动、关系或判断。" });
  } else {
    findings.push({ id: `${String(no)}:manual:information`, episodeNo: no, kind: "manual", question: "谁获得了什么新信息？反转是否有前置依据？",
      evidence: field(episode, "turn"), why: "没有前置依据的反转像临时安排；不改变行动、关系或判断的转折只是信息补充。",
      suggestion: "分别写下观众知道什么、人物知道什么，并指出反转依据出现在哪一集。" });
  }
  if (!blank("result")) {
    findings.push({ id: `${String(no)}:manual:payoff`, episodeNo: no, kind: "manual", question: "本集给观众什么回报？",
      evidence: field(episode, "result"), why: "每集解决一部分问题，观众才会觉得这一集没有白看。",
      suggestion: "核对结果里有没有可感受的回报，例如尊严恢复一步、被人理解、关系修复或一部分真相揭晓。" });
  }
  if (previous && !blank("goal") && !blankOrPlaceholder(previous.goal) && normalized(previous.goal) === normalized(episode.goal)) {
    findings.push({ id: `${String(no)}:manual:repeat`, episodeNo: no, kind: "manual", question: "本集是否在重复上一集的冲突？",
      evidence: `${field(previous, "goal")}；${field(episode, "goal")}（两集目标文字相同）`,
      why: "为凑集数重复同一冲突，会让观众觉得剧情原地踏步。", suggestion: "让本集目标推进一步，或者提高代价、缩短时间、加大选择难度。" });
  }
  if (previous) {
    // Escalation compares the two turns, whether or not the goals repeat: without both there is nothing to compare.
    const comparable = !blank("turn") && !blankOrPlaceholder(previous.turn);
    findings.push({ id: `${String(no)}:${comparable ? "manual" : "undetermined"}:escalation`, episodeNo: no, kind: comparable ? "manual" : "undetermined",
      question: "相比上一集，冲突是否升级？", evidence: `${field(previous, "turn")}；${field(episode, "turn")}`,
      why: comparable ? "冲突不升级时，后面的集数容易重复前面的套路。" : "两集的转折没有都写出来，无法比较冲突是否升级。",
      suggestion: comparable ? "核对本集是否增加了代价、缩短了时间或提高了选择难度；没有时补其中一项。"
        : "在两集的转折里写明各自的代价或压力，再比较是否升级。" });
  }
  if (isLast) {
    // Closure compares the last handoff with the story's promise in the direction.
    const promise = concept ? quoted("故事策划 direction（故事走向）", concept.direction) : "这次创作没有可读的故事策划。";
    const closable = !blank("handoff") && concept !== null && !blankOrPlaceholder(concept.direction);
    findings.push({ id: `${String(no)}:${closable ? "manual" : "undetermined"}:closure`, episodeNo: no, kind: closable ? "manual" : "undetermined",
      question: finaleClosure ? "最后一集是否回应了整部期待和主线问题？" : "结尾记录是否与故事走向一致？", evidence: `${field(episode, "handoff", true, finaleClosure)}；${promise}`,
      why: finaleClosure
        ? (closable ? "结尾不回应整部期待，前面的铺垫就没有兑现。" : "最后一集的结尾或故事走向没有写出来，无法判断结尾是否回应了整部期待。")
        : "旧版本的结尾字段记录后续信息，不强制承担全剧收束；这里只核对记录与故事走向是否一致。",
      suggestion: finaleClosure
        ? (closable ? "对照故事走向里的整部期待，核对结尾是否写清主角最终得到或失去了什么。" : "补写故事走向里的整部期待和最后一集的结尾，再核对两者。")
        : (closable ? "核对结尾记录与故事走向是否矛盾，不要求把旧字段改写成全剧结局。" : "补齐结尾记录和故事走向，再核对两者是否一致。") });
  } else {
    // Follow-up compares this handoff with the next episode's opening.
    const opening = next ? field(next, "entryState") : `分集大纲里没有第 ${String(no + 1)} 集。`;
    const followed = !blank("handoff") && next !== undefined && !blankOrPlaceholder(next.entryState);
    findings.push({ id: `${String(no)}:${followed ? "manual" : "undetermined"}:followup`, episodeNo: no, kind: followed ? "manual" : "undetermined",
      question: "结尾的问题在下一集怎样回应？", evidence: `${field(episode, "handoff")}；${opening}`,
      why: followed ? "下一集接不上结尾问题时，续看理由就落空了。" : "本集结尾或下一集开场没有写出来，无法判断两集是否接上。",
      suggestion: followed ? "核对下一集的进入状态或目标是否承接了这个问题；接不上时改写其中一处。" : "补写本集的结尾问题和下一集的进入状态，再核对两者是否接上。" });
  }
  return findings;
}

/**
 * Checks a plan of expectedCount episodes. An episode the outline does not have is reported as missing for that
 * episode number; nothing is invented for it.
 */
export function checkEpisodePlan(concept: TitleConcept | null, outline: EpisodeOutline | null, expectedCount: number, finaleClosure = true): EpisodeWritingCheck {
  const groups: EpisodeWritingGroup[] = [{ episodeNo: null, label: "整部", findings: storyFindings(concept) }];
  const episodes = outline?.episodes ?? [];
  const byNo = new Map(episodes.map((episode) => [episode.episodeNo, episode]));
  const count = Math.max(expectedCount, ...episodes.map((episode) => episode.episodeNo), 0);
  for (let no = 1; no <= count; no += 1) {
    const episode = byNo.get(no);
    if (!episode) {
      groups.push({ episodeNo: no, label: `第 ${String(no)} 集`, findings: [{ id: `${String(no)}:missing:episode`, episodeNo: no, kind: "missing",
        question: "这一集有分集计划吗？", evidence: outline ? `分集大纲里没有第 ${String(no)} 集。` : "这次创作没有可读的分集大纲。",
        why: "没有分集计划，这一集的目标、行动和结尾都无从核对。", suggestion: no === count
          ? (finaleClosure ? "先补齐这一集的目标、行动、结果，以及主线如何收束、整部期待如何回应。" : "先补齐这一集的目标、行动、结果和结尾记录。")
          : "先补齐这一集的目标、行动、结果和结尾问题。" }] });
      continue;
    }
    const title = blankOrPlaceholder(episode.title) ? "" : ` ${episode.title.trim()}`;
    groups.push({ episodeNo: no, label: `第 ${String(no)} 集${title}`,
      findings: episodeFindings(episode, byNo.get(no - 1), byNo.get(no + 1), concept, no === count, finaleClosure) });
  }
  const counts = { missing: 0, manual: 0, undetermined: 0 };
  for (const group of groups) for (const finding of group.findings) counts[finding.kind] += 1;
  return { groups, counts };
}
