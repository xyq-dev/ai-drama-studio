import {
  VIMAX_UPSTREAM_REVISION,
  VIMAX_PLATFORM_PREVIEW_MAX_BYTES,
  vimaxPlatformPreviewRequestSchema,
  type VimaxPlatformSourceSnapshot,
} from "@ai-drama/contracts";
import { evaluateVimaxPlatformPreview } from "@ai-drama/domain";
import type { VimaxPreviewSourceStore, VimaxPreviewSourceRead } from "@ai-drama/database";

export interface VimaxPreviewDependencies {
  workspaceId: string;
  nodeEnv: "development" | "test" | "production";
  source: Pick<VimaxPreviewSourceStore, "read">;
  clock?: () => Date;
}
export interface VimaxPreviewResult { status: number; body: unknown }

const MESSAGES: Record<string, string> = {
  VIMAX_PREVIEW_DISABLED: "当前环境未开放分镜候选预览。",
  VIMAX_PREVIEW_SOURCE_NOT_FOUND: "没有找到这部作品或这一集。",
  SERIES_MEDIA_NOT_ENABLED: "系列作品尚未开放分镜候选预览。",
  VIMAX_PREVIEW_SCRIPT_REVIEW_REQUIRED: "请先批准这一集的当前剧本；过期剧本不能用于预览。",
  VIMAX_PREVIEW_SCRIPT_UNSUPPORTED: "当前剧本需要有效的纯文本正文，且不能超过预览范围。",
  VIMAX_PREVIEW_TOO_MANY_CHARACTERS: "当前角色数量超过分镜预览上限。",
  VIMAX_PREVIEW_CHARACTERS_UNSUPPORTED: "角色版本不可用或名称超出预览范围，请先检查角色资料。",
  VIMAX_PREVIEW_SOURCE_CHANGED: "剧本或角色来源已变化，请重新读取来源并核对候选。",
  VIMAX_PREVIEW_INVALID_REQUEST: "分镜候选请求无效。",
  VIMAX_PREVIEW_INPUT_TOO_LARGE: "分镜候选请求超过大小上限。",
};
function failure(status: number, code: string, details?: Record<string, unknown>): VimaxPreviewResult {
  return { status, body: { error: { code, message: MESSAGES[code] ?? "无法读取分镜预览。", ...(details ? { details } : {}) } } };
}

/** No provider, task, idempotency store or write dependency: every request only validates a newly read snapshot. */
export class VimaxPreviewService {
  constructor(private readonly deps: VimaxPreviewDependencies) {}

  private gate(): VimaxPreviewResult | null {
    return this.deps.nodeEnv === "production" ? failure(404, "VIMAX_PREVIEW_DISABLED") : null;
  }

  private async read(projectId: string, episodeId: string): Promise<VimaxPreviewSourceRead> {
    return this.deps.source.read(this.deps.workspaceId, projectId, episodeId);
  }

  private refused(source: Exclude<VimaxPreviewSourceRead, { kind: "ok" }>): VimaxPreviewResult {
    if (source.kind === "not_found") return failure(404, "VIMAX_PREVIEW_SOURCE_NOT_FOUND");
    if (source.kind === "series_not_enabled") return failure(409, "SERIES_MEDIA_NOT_ENABLED");
    const codes = {
      script_review_required: "VIMAX_PREVIEW_SCRIPT_REVIEW_REQUIRED",
      script_unsupported: "VIMAX_PREVIEW_SCRIPT_UNSUPPORTED",
      too_many_characters: "VIMAX_PREVIEW_TOO_MANY_CHARACTERS",
      characters_unsupported: "VIMAX_PREVIEW_CHARACTERS_UNSUPPORTED",
    } as const;
    return failure(409, codes[source.kind]);
  }

  async source(projectId: string, episodeId: string): Promise<VimaxPreviewResult> {
    const gate = this.gate();
    if (gate) return gate;
    const current = await this.read(projectId, episodeId);
    return current.kind === "ok" ? { status: 200, body: current.source } : this.refused(current);
  }

  async preview(projectId: string, episodeId: string, body: unknown): Promise<VimaxPreviewResult> {
    const gate = this.gate();
    if (gate) return gate;
    // The HTTP JSON parser also enforces its unchanged 300kb limit. Cap direct service calls before Zod parsing.
    let bytes: number;
    try { bytes = Buffer.byteLength(JSON.stringify(body) ?? "", "utf8"); }
    catch { return failure(400, "VIMAX_PREVIEW_INVALID_REQUEST"); }
    if (bytes > VIMAX_PLATFORM_PREVIEW_MAX_BYTES) return failure(413, "VIMAX_PREVIEW_INPUT_TOO_LARGE");
    const parsed = vimaxPlatformPreviewRequestSchema.safeParse(body);
    if (!parsed.success) return failure(400, "VIMAX_PREVIEW_INVALID_REQUEST", { field: parsed.error.issues[0]?.path.join(".") ?? "body" });
    const request = parsed.data;
    const current = await this.read(projectId, episodeId);
    if (current.kind !== "ok") return this.refused(current);
    const source = current.source;
    if (!sameSource(source, request.source)) return failure(409, "VIMAX_PREVIEW_SOURCE_CHANGED");
    const report = evaluateVimaxPlatformPreview({
      schema: "ads.vimax-platform-input.v1", upstreamRevision: VIMAX_UPSTREAM_REVISION, sourceKind: "workspace",
      writingMode: "short", projectId: source.projectId, episodeId: source.episodeId, episodeNo: source.episodeNo,
      scriptRevisionId: source.scriptRevisionId, scriptContentHash: source.scriptContentHash, scriptText: source.scriptText,
      reviewStatus: "APPROVED", isCurrent: true, isStale: false, characters: source.characters,
      sceneSpans: request.sceneSpans, selectedSceneKeys: request.selectedSceneKeys, sourceDialogue: request.sourceDialogue,
      requirements: request.requirements,
    }, request.candidate, request.supplements);
    return { status: 200, body: {
      schema: "ads.vimax-platform-preview.response.v1", source, report,
      verifiedAt: (this.deps.clock?.() ?? new Date()).toISOString(), modelCalls: 0, persisted: false,
    } };
  }
}

/** Require the exact ordered server-assigned character keys and identity, including names; names alone prove nothing. */
function sameSource(current: VimaxPlatformSourceSnapshot, submitted: {
  scriptRevisionId: string; scriptContentHash: string; characters: VimaxPlatformSourceSnapshot["characters"];
}): boolean {
  return current.scriptRevisionId === submitted.scriptRevisionId && current.scriptContentHash === submitted.scriptContentHash
    && current.characters.length === submitted.characters.length
    && current.characters.every((character, index) => {
      const other = submitted.characters[index]!;
      return character.key === other.key && character.characterId === other.characterId
        && character.revisionId === other.revisionId && character.name === other.name;
    });
}
