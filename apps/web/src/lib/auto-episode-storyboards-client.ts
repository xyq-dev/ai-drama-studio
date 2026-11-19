import type { AutoEpisodeStoryboardShotView, AutoStoryboardImageProviderKey, CreateUploadSessionRequest } from "@ai-drama/contracts";
import { ASSET_UPLOAD_MIME_TYPES } from "@ai-drama/contracts";
import { createRealMediaClient, sha256Hex } from "./real-media-client";
import { ApiError, StudioClient } from "./studio-client";

const ID = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const id = (value: unknown): value is string => typeof value === "string" && ID.test(value);
const nullableId = (value: unknown) => value === null || id(value);

export const storyboardGate = {
  writing_not_finished: "剧本还在创作中。",
  story_not_saved: "请先保存故事。",
  story_review_required: "请先审核通过故事。",
  script_not_placed: "请先把本集剧本写入作品。",
  script_review_required: "请先审核通过本集剧本。",
  shots_not_ready: "请先拆解场景与分镜，审核场景并写入镜头。文字镜头需与当前剧本匹配。",
  shot_source_stale: "镜头的审核版本或剧本来源已变更，请在工作台复核。",
} as const;

export type StoryboardGate = keyof typeof storyboardGate;
export const storyboardShotStatus = {
  ready: "可生成",
  queued: "排队或生成中",
  failed: "生成失败",
  unknown: "结果待核实",
  generated: "已生成",
  kept: "已保留",
} as const;
export type AutoStoryboardShot = AutoEpisodeStoryboardShotView;
export interface AutoStoryboardEpisode {
  episodeNo: number;
  episodeId: string | null;
  blocked: StoryboardGate | null;
  shots: AutoStoryboardShot[];
}
export interface AutoStoryboardView {
  imageAvailable: boolean;
  selectionAvailable: boolean;
  characterReferencesAvailable: boolean;
  episodes: AutoStoryboardEpisode[];
}

function checked(value: AutoStoryboardView): AutoStoryboardView {
  const revisions = new Set<string>();
  const episodeNos = new Set<number>();
  if (!value || typeof value.imageAvailable !== "boolean" || typeof value.selectionAvailable !== "boolean"
    || typeof value.characterReferencesAvailable !== "boolean" || !Array.isArray(value.episodes)
    || !value.episodes.every((episode) => {
      if (!episode || !Number.isSafeInteger(episode.episodeNo) || episode.episodeNo < 1 || episode.episodeNo > 6
        || episodeNos.has(episode.episodeNo) || !nullableId(episode.episodeId)
        || (episode.blocked !== null && !Object.hasOwn(storyboardGate, episode.blocked))
        || !Array.isArray(episode.shots)) return false;
      episodeNos.add(episode.episodeNo);
      return episode.shots.every((shot) => {
        if (!shot || !id(shot.shotRevisionId) || revisions.has(shot.shotRevisionId) || !id(shot.shotId)
          || !nullableId(shot.jobId) || !nullableId(shot.quoteId) || typeof shot.caption !== "string"
          || !Object.hasOwn(storyboardShotStatus, shot.state) || !nullableId(shot.previewAssetId)
          || !nullableId(shot.keptAssetId)) return false;
        revisions.add(shot.shotRevisionId);
        return true;
      });
    })) throw new ApiError(502, "INVALID_RESPONSE", "无法核对分镜图状态。");
  return value;
}

export function createAutoEpisodeStoryboardsClient(studio = new StudioClient()) {
  const media = createRealMediaClient(studio);
  const path = (projectId: string, runId: string) => `/projects/${projectId}/auto-runs/${runId}/storyboards`;
  return {
    async read(projectId: string, runId: string, signal: AbortSignal) {
      return checked(await studio.get<AutoStoryboardView>(path(projectId, runId), { signal }));
    },
    quote(projectId: string, runId: string, shotRevisionId: string, imageProvider?: AutoStoryboardImageProviderKey) {
      return media.quote(projectId, shotRevisionId, "image.generate", undefined, undefined, runId, imageProvider);
    },
    authorize: media.authorize,
    generate: media.generate,
    createUploadSession: media.createUploadSession,
    putUploadObject: media.putUploadObject,
    completeUploadSession: media.completeUploadSession,
    /**
     * Upload one storyboard image for a shot: create session → PUT bytes → complete → assetId.
     * Does not authorize a paid generation and does not mean review approval.
     */
    async uploadShotImage(input: {
      projectId: string;
      runId: string;
      shotRevisionId: string;
      file: File;
    }): Promise<{ assetId: string }> {
      const mimeType = input.file.type;
      if (!(ASSET_UPLOAD_MIME_TYPES as readonly string[]).includes(mimeType)) {
        throw new ApiError(400, "UNSUPPORTED_MEDIA", "仅支持 PNG、JPEG 或 WebP 图片。");
      }
      if (input.file.size < 1 || input.file.size > 8 * 1024 * 1024) {
        throw new ApiError(400, "UPLOAD_LIMIT", "上传文件超过 8 MiB 上限。");
      }
      const buffer = await input.file.arrayBuffer();
      const contentHash = await sha256Hex(buffer);
      const body: CreateUploadSessionRequest = {
        projectId: input.projectId,
        assetType: "IMAGE",
        mimeType: mimeType as CreateUploadSessionRequest["mimeType"],
        byteSize: input.file.size,
        contentHash,
        shotRevisionId: input.shotRevisionId,
        autoStoryboardRunId: input.runId,
      };
      const created = await media.createUploadSession(body);
      await media.putUploadObject(created.uploadUrl, buffer, mimeType, contentHash);
      return media.completeUploadSession(created.uploadSession.id);
    },
    async keep(projectId: string, runId: string, shot: AutoStoryboardShot, assetId: string, idempotencyKey: string) {
      const { body } = await studio.write<{ selectedAssetId: string }>({
        path: `${path(projectId, runId)}/${shot.shotRevisionId}/selection`, method: "PUT", idempotencyKey,
        body: { assetId, expectedSelectedAssetId: shot.keptAssetId },
      });
      if (body?.selectedAssetId !== assetId) throw new ApiError(502, "INVALID_RESPONSE", "图片选用回执待核实，请刷新状态。");
    },
  };
}
