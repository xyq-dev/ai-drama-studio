import type { AdminJobType } from "@ai-drama/database";
import { mediaRetryDecision } from "@ai-drama/domain";

export const PRODUCTION_STATUSES = ["draft", "script_review", "storyboard", "producing", "finished", "unknown"] as const;
export type ProductionStatus = (typeof PRODUCTION_STATUSES)[number];

export const PRODUCTION_LABEL: Record<ProductionStatus, string> = {
  draft: "草稿",
  script_review: "剧本待审",
  storyboard: "分镜中",
  producing: "制作中",
  finished: "已完结",
  unknown: "未知",
};

export interface ProductionSignals {
  title: string;
  episodeCount: number | null;
  completedEpisodeCount: number;
  imageCount: number;
  audioCount: number;
  videoCount: number;
  scriptCount: number;
  openImageJobs: number;
  openVoiceJobs: number;
  openVideoJobs: number;
}

export function deriveProductionStatus(input: ProductionSignals): ProductionStatus {
  const openMedia = input.openImageJobs + input.openVoiceJobs + input.openVideoJobs;
  if (input.episodeCount && input.episodeCount > 0 && input.completedEpisodeCount === input.episodeCount && openMedia === 0) return "finished";
  if (input.openVoiceJobs > 0 || input.openVideoJobs > 0 || input.audioCount > 0 || input.videoCount > 0) {
    return "producing";
  }
  if (input.imageCount > 0 || input.openImageJobs > 0) return "storyboard";
  if (input.scriptCount > 0) return "script_review";
  if (input.title.trim().length > 0) return "draft";
  return "unknown";
}

export function episodeProgress(input: { episodeCount: number | null; episodeNo: number | null; status: ProductionStatus }): string {
  const total = input.episodeCount && input.episodeCount > 0 ? input.episodeCount : null;
  if (!total) return input.status === "draft" ? "尚未分集" : "分集进度未知";
  const current = input.episodeNo && input.episodeNo > 0 ? input.episodeNo : 1;
  if (input.status === "finished") return `共 ${total} 集，已完结`;
  if (input.status === "storyboard") return `共 ${total} 集，第 ${current} 集分镜中`;
  if (input.status === "producing") return `共 ${total} 集，第 ${current} 集制作中`;
  if (input.status === "script_review") return `共 ${total} 集，剧本待审`;
  if (input.status === "draft") return `共 ${total} 集，草稿`;
  return `共 ${total} 集`;
}

const UNKNOWN_ERROR_CODES = new Set(["MOCK_REQUEST_UNKNOWN"]);

export type JobDisplayStatus = "succeeded" | "running" | "failed" | "unknown" | "canceled" | "queued";

export function jobDisplayStatus(state: string, errorCode: string | null): JobDisplayStatus {
  if (errorCode && UNKNOWN_ERROR_CODES.has(errorCode)) return "unknown";
  const normalized = state.toLowerCase();
  if (normalized === "needs_attention" || normalized === "partial") return "unknown";
  if (normalized === "succeeded" || normalized === "completed") return "succeeded";
  if (normalized === "failed") return "failed";
  if (normalized === "canceled" || normalized === "cancelled") return "canceled";
  if (normalized === "queued" || normalized === "pending") return "queued";
  if (normalized === "running" || normalized === "waiting_external") return "running";
  return "unknown";
}

export const JOB_STATUS_LABEL: Record<JobDisplayStatus, string> = {
  succeeded: "成功",
  running: "进行中",
  failed: "失败",
  unknown: "结果未知",
  canceled: "已取消",
  queued: "排队中",
};

const JOB_TYPE_LABEL: Record<AdminJobType, string> = {
  writing: "剧本编写", scene: "场景生成", shot: "镜头生成", image: "分镜生图", voice: "角色配音",
  video: "视频生成", subtitle: "字幕生成", music: "音乐生成", shot_compose: "单镜合成", episode_compose: "集级合成", other: "其他任务",
};

export function jobTypeLabel(type: AdminJobType, demo: boolean): string {
  return demo ? `${JOB_TYPE_LABEL[type]}（演示）` : JOB_TYPE_LABEL[type];
}

export function jobAction(status: JobDisplayStatus): "retry" | "view" {
  return status === "failed" ? "retry" : "view";
}

export function recentTaskLabel(input: {
  type: AdminJobType | null;
  demo: boolean;
  state: string | null;
  errorCode: string | null;
}): string {
  if (!input.type || !input.state) return "尚无生成任务";
  const type = jobTypeLabel(input.type, input.demo);
  const status = JOB_STATUS_LABEL[jobDisplayStatus(input.state, input.errorCode)];
  if (status === "成功" || status === "进行中") return `${type}${status}`;
  return `${type} · ${status}`;
}

export function workEpisodeLabel(title: string, episodeNo: number | null): string {
  return episodeNo && episodeNo > 0 ? `${title} / 第 ${episodeNo} 集` : title;
}

/** Stable short label. The uuid stays the API id. */
export function shortJobCode(id: string): string {
  const hex = id.replace(/-/g, "").slice(-4);
  const parsed = Number.parseInt(hex, 16);
  const value = Number.isFinite(parsed) ? parsed % 10_000 : 0;
  return `JOB-${value.toString().padStart(4, "0")}`;
}

export function shortJobCodeSql(idExpression: string): string {
  return `'JOB-' || lpad(((('x' || right(replace(${idExpression}::text, '-', ''), 4))::bit(16)::int % 10000))::text, 4, '0')`;
}

export function ownerPresentation(input: { username: string | null; status: string | null }): {
  name: string;
  legacy: boolean;
  loginable: boolean;
} {
  if (!input.username || input.status === "LEGACY" || input.username === "legacy-owner") {
    return { name: "历史作品", legacy: true, loginable: false };
  }
  return { name: input.username, legacy: false, loginable: input.status === "ACTIVE" };
}

export type AssetTypeCode = "image" | "voice" | "video" | "other";

export function assetType(kind: string): { code: AssetTypeCode; label: string } {
  if (kind === "IMAGE") return { code: "image", label: "分镜图" };
  if (kind === "AUDIO") return { code: "voice", label: "角色配音" };
  if (kind === "VIDEO" || kind === "COMPOSITE") return { code: "video", label: "成片视频" };
  return { code: "other", label: "其他素材" };
}

export function assetName(input: {
  kind: string;
  episodeNo: number | null;
  shotOrdinal: number | null;
  metadataName: string | null;
  jobType: AdminJobType | null;
  isDemo: boolean;
}): string {
  const ep = input.episodeNo ? `第 ${input.episodeNo} 集` : "";
  const shot = input.shotOrdinal ? `镜头 ${input.shotOrdinal}` : "";
  let name = input.metadataName?.trim().slice(0, 80);
  if (input.kind === "COMPOSITE" && input.jobType === "episode_compose") name = ep ? `${ep}成片` : "集级成片";
  else if (input.kind === "COMPOSITE" && (input.jobType === "shot_compose" || shot)) name = [ep, shot ? `${shot} 单镜成片` : "单镜成片"].filter(Boolean).join(" · ");
  else if (!name) {
    if (input.kind === "IMAGE") name = [ep, shot ? `镜号 ${String(input.shotOrdinal).padStart(2, "0")}` : "分镜图"].filter(Boolean).join(" · ");
    else if (input.kind === "AUDIO") name = ep ? `角色配音 · ${ep}` : "角色配音";
    else if (input.kind === "VIDEO") name = [ep, shot ? `${shot} 视频` : "视频"].filter(Boolean).join(" · ");
    else name = input.kind === "COMPOSITE" ? "合成视频" : "素材";
  }
  return input.isDemo ? `${name}（演示）` : name;
}

/**
 * Operator retry gate. UNKNOWN never passes. Canceled, running, and succeeded stay view-only.
 * mediaRetryDecision still rejects UNKNOWN_OUTCOME; this function does not widen that rule.
 * A failed non-retryable code is refused here, before any manualRetryIdempotent call.
 */
export function adminRetryAllowed(input: { kind: string; state: string; errorCode: string | null }): { ok: true } | { ok: false; reason: string } {
  const status = jobDisplayStatus(input.state, input.errorCode);
  if (status === "unknown") return { ok: false, reason: "UNKNOWN_OUTCOME" };
  if (status !== "failed") return { ok: false, reason: "NOT_RETRYABLE" };
  const decision = mediaRetryDecision({
    kind: input.kind,
    state: "FAILED",
    errorCode: input.errorCode,
  });
  if (!decision.allowed) return { ok: false, reason: decision.reason };
  return { ok: true };
}

/** Mask shown in operation logs. Example: sk-***8hd. The full secret is not returned. */
export function maskCredential(secret: string): string {
  const chars = [...secret];
  const tail = chars.slice(-3).join("");
  return `sk-***${tail}`;
}

export function assertNoCredential(value: unknown, forbidden: readonly string[]): void {
  const text = JSON.stringify(value);
  for (const secret of forbidden) {
    if (secret.length >= 8 && text.includes(secret)) {
      throw new Error("OPERATION_LOG_SECRET");
    }
  }
  if (/passwordHash|apiKey|api_key|"password"\s*:/i.test(text)) throw new Error("OPERATION_LOG_SECRET");
  if (/sk-[A-Za-z0-9]{8,}/.test(text)) throw new Error("OPERATION_LOG_SECRET");
}
