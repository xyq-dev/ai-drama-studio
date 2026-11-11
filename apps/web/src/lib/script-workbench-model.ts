import {
  estimateScriptWorkbench,
  scriptWorkbenchPlanSchema,
  scriptWorkbenchScriptSchema,
  type ScriptWorkbenchPlan,
  type ScriptWorkbenchRevision,
  type ScriptWorkbenchScript,
  type ScriptWorkbenchSnapshot,
} from "@ai-drama/contracts";

export const STAGES = ["立项", "设定与大纲", "逐集编写", "审稿修订", "定稿交接"] as const;
export const REVIEW_CHECKS = [
  ["identityClear", "只看画面、听对白，能分清谁是谁"],
  ["goalClear", "能理解主角这一集要什么"],
  ["obstacleClear", "能理解为什么此刻不能走"],
  ["continuityChecked", "已回查前后集、角色已知信息和未回收悬念"],
  ["lockedMaterialsChecked", "已核对已锁分镜、配音和视频素材的影响"],
] as const;

export function workbenchPlan(
  revision: ScriptWorkbenchRevision | null | undefined,
): ScriptWorkbenchPlan | null {
  const value = revision?.content.workbench;
  if (
    !value ||
    typeof value !== "object" ||
    !("plan" in value) ||
    !("schema" in value) ||
    value.schema !== "script-workbench.v1"
  )
    return null;
  const parsed = scriptWorkbenchPlanSchema.safeParse(value.plan);
  return parsed.success ? parsed.data : null;
}

export function workbenchScript(
  revision: ScriptWorkbenchRevision | null | undefined,
): ScriptWorkbenchScript | null {
  const value = revision?.content.workbench;
  if (
    !value ||
    typeof value !== "object" ||
    !("script" in value) ||
    !("schema" in value) ||
    value.schema !== "script-workbench.v1"
  )
    return null;
  const parsed = scriptWorkbenchScriptSchema.safeParse(value.script);
  return parsed.success ? parsed.data : null;
}

export function documentVersions(
  revision: ScriptWorkbenchRevision | null | undefined,
): { brief: number; synopsis: number; bible: number; outline: number } | null {
  const value = revision?.content.workbench;
  return value && typeof value === "object" && "documentVersions" in value
    ? (value.documentVersions as {
        brief: number;
        synopsis: number;
        bible: number;
        outline: number;
      })
    : null;
}

export function emptyPlan(snapshot: ScriptWorkbenchSnapshot): ScriptWorkbenchPlan {
  return {
    brief: {
      genre: "",
      audience: "",
      productionConstraints: "",
      logline: "",
      targetEpisodeSeconds: snapshot.project.targetEpisodeSeconds ?? 60,
      dialogueQuota: 12,
    },
    bible: { ending: "", characters: [], openThreads: "" },
    outline: {
      episodes: Array.from({ length: snapshot.project.episodeCount }, (_, index) => ({
        episodeNo: index + 1,
        title:
          snapshot.episodes.find(
            (episode) => episode.episodeNo === index + 1 && !/^Episode \d+$/i.test(episode.title),
          )?.title ?? `第${index + 1}集`,
        openingHook: "",
        change: "",
        endingHandoff: "",
      })),
    },
  };
}

export function emptyScript(title: string): ScriptWorkbenchScript {
  return {
    title,
    previousRevisionId: null,
    previousHandoff: "",
    openingHook: "",
    change: "",
    endingHandoff: "",
    characterKnowledge: "",
    unresolvedThreads: "",
    scenes: [],
    review: {
      identityClear: false,
      goalClear: false,
      obstacleClear: false,
      continuityChecked: false,
      lockedMaterialsChecked: false,
      note: "",
    },
  };
}

export function revisionLabel(revision: ScriptWorkbenchRevision | null | undefined): string {
  if (!revision) return "尚未保存";
  const labels: Record<string, string> = {
    DRAFT: "草稿",
    IN_REVIEW: "待审稿",
    APPROVED: "已锁定",
    REJECTED: "待修订",
  };
  return `${revision.freshnessStatus === "STALE" ? "待复核" : (labels[revision.reviewStatus] ?? "待检查")} v${revision.revisionNo}`;
}

/** An estimate only: explicit action/sound/pause time plus no less than 4 dialogue characters per second. */
export const estimateScript = estimateScriptWorkbench;

export function clock(seconds: number): string {
  const rounded = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(rounded / 60)).padStart(2, "0")}:${String(rounded % 60).padStart(2, "0")}`;
}

export function approved(revision: ScriptWorkbenchRevision | null | undefined): boolean {
  return revision?.reviewStatus === "APPROVED" && revision.freshnessStatus === "CURRENT";
}

export function plainText(content: Record<string, unknown>): string {
  return typeof content.text === "string" ? content.text : JSON.stringify(content, null, 2);
}

/** Editing story content requires the human checks to be done again; changing the checklist itself does not. */
export function invalidateChecks(script: ScriptWorkbenchScript): ScriptWorkbenchScript {
  return {
    ...script,
    review: {
      identityClear: false,
      goalClear: false,
      obstacleClear: false,
      continuityChecked: false,
      lockedMaterialsChecked: false,
      note: script.review?.note ?? "",
    },
  };
}
