import { mediaRetryDecision } from "@ai-drama/domain";

/**
 * Derived labels for the operator directory.
 * project.status = ACTIVE is never treated as 已完结. A titled work with no script,
 * storyboard, voice, or video is 草稿.
 *
 * Order: finished, producing, storyboard, script_review, draft, unknown.
 * finished requires a previewable video/composite and no open image/voice/video job.
 * producing is open voice/video work, any previewable audio, or video that still has open jobs.
 */
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
  if (input.videoCount > 0 && openMedia === 0) return "finished";
  if (input.openVoiceJobs > 0 || input.openVideoJobs > 0 || input.audioCount > 0 || (input.videoCount > 0 && openMedia > 0)) {
    return "producing";
  }
  if (input.imageCount > 0 || input.openImageJobs > 0) return "storyboard";
  if (input.scriptCount > 0) return "script_review";
  if (input.title.trim().length > 0) return "draft";
  return "unknown";
}

/** SQL twin of deriveProductionStatus. Keep the two in the same order. */
export function productionStatusSql(column: {
  title: string;
  image: string;
  audio: string;
  video: string;
  script: string;
  openImage: string;
  openVoice: string;
  openVideo: string;
}): string {
  const open = `(${column.openImage} + ${column.openVoice} + ${column.openVideo})`;
  return `CASE
    WHEN ${column.video} > 0 AND ${open} = 0 THEN 'finished'
    WHEN ${column.openVoice} > 0 OR ${column.openVideo} > 0 OR ${column.audio} > 0 OR (${column.video} > 0 AND ${open} > 0) THEN 'producing'
    WHEN ${column.image} > 0 OR ${column.openImage} > 0 THEN 'storyboard'
    WHEN ${column.script} > 0 THEN 'script_review'
    WHEN length(btrim(${column.title})) > 0 THEN 'draft'
    ELSE 'unknown'
  END`;
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

export type JobType = "writing" | "image" | "voice" | "video" | "other";

export function jobType(kind: string, source: "generation" | "writing"): JobType {
  if (source === "writing" || kind === "WRITING") return "writing";
  if (kind === "MEDIA_IMAGE" || kind === "MEDIA_CHARACTER_REFERENCE") return "image";
  if (kind === "MEDIA_TTS") return "voice";
  if (kind === "MEDIA_VIDEO" || kind === "MEDIA_COMPOSE") return "video";
  if (kind === "SCENES" || kind === "SHOTS" || kind === "STORY" || kind === "SCRIPT") return "writing";
  return "other";
}

export const JOB_TYPE_LABEL: Record<JobType, string> = {
  writing: "剧本编写",
  image: "分镜生图",
  voice: "角色配音",
  video: "视频生成",
  other: "其他任务",
};

export function jobAction(status: JobDisplayStatus): "retry" | "view" {
  return status === "failed" ? "retry" : "view";
}

export function recentTaskLabel(input: {
  kind: string | null;
  source: "generation" | "writing" | null;
  state: string | null;
  errorCode: string | null;
}): string {
  if (!input.kind || !input.source || !input.state) return "尚无生成任务";
  const type = JOB_TYPE_LABEL[jobType(input.kind, input.source)];
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
}): string {
  const named = input.metadataName?.trim();
  if (named) return named.slice(0, 80);
  if (input.kind === "IMAGE") {
    const shot = input.shotOrdinal ? `镜号 ${String(input.shotOrdinal).padStart(2, "0")}` : "分镜图";
    return input.episodeNo ? `第 ${input.episodeNo} 集 · ${shot}` : shot;
  }
  if (input.kind === "AUDIO") return input.episodeNo ? `角色配音 · 第 ${input.episodeNo} 集` : "角色配音";
  if (input.kind === "VIDEO" || input.kind === "COMPOSITE") return input.episodeNo ? `第 ${input.episodeNo} 集成片` : "成片视频";
  return "素材";
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
