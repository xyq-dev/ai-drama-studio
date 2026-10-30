import {
  VIMAX_PLATFORM_PREVIEW_MAX_BYTES,
  vimaxPlatformPreviewRequestSchema,
  vimaxPlatformPreviewResponseSchema,
  vimaxPlatformSourceSnapshotSchema,
  type VimaxPlatformPreviewRequest,
  type VimaxPlatformPreviewResponse,
  type VimaxPlatformSourceSnapshot,
} from "@ai-drama/contracts";
import { withSession } from "./site-session";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class VimaxPreviewError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "VimaxPreviewError";
  }
}

const unconfirmed = () => new VimaxPreviewError(200, "PREVIEW_UNCONFIRMED", "未收到与当前作品、剧集和方案一致的完整回应，请重新校验。");
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** JSON is kept in page memory only. An E1 evaluation report is never a platform request or a save credential. */
export function parseVimaxPreviewImport(text: string): VimaxPlatformPreviewRequest {
  if (new TextEncoder().encode(text).byteLength > VIMAX_PLATFORM_PREVIEW_MAX_BYTES) {
    throw new VimaxPreviewError(413, "PREVIEW_IMPORT_TOO_LARGE", "分镜方案不能超过 300 KB。");
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch {
    throw new VimaxPreviewError(400, "PREVIEW_IMPORT_INVALID_JSON", "无法读取 JSON，请检查文件或粘贴内容。");
  }
  const parsed = vimaxPlatformPreviewRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new VimaxPreviewError(400, "PREVIEW_IMPORT_INVALID", "方案格式不完整或版本不匹配。请导入平台分镜方案，离线评估报告不能直接导入。");
  }
  return parsed.data;
}

export function vimaxPreviewSourceMatches(source: VimaxPlatformSourceSnapshot, request: VimaxPlatformPreviewRequest): boolean {
  return source.scriptRevisionId === request.source.scriptRevisionId
    && source.scriptContentHash === request.source.scriptContentHash
    && same(source.characters, request.source.characters);
}

/** Read-only preview: the POST carries CSRF protection but never starts a model or saves a business record. */
export class VimaxPreviewClient {
  constructor(private readonly fetchImpl?: FetchLike, private readonly prefix = "/api/v1") {}

  private path(projectId: string, episodeId: string): string {
    return `/projects/${projectId}/episodes/${episodeId}/vimax-preview`;
  }

  private async call(path: string, init: RequestInit): Promise<unknown> {
    const response = await withSession(this.fetchImpl ?? globalThis.fetch.bind(globalThis))(`${this.prefix}${path}`, {
      ...init, cache: "no-store", credentials: "same-origin",
    });
    let body: unknown;
    try { body = JSON.parse(await response.text()); } catch { body = null; }
    if (!response.ok) {
      const error = body && typeof body === "object" && "error" in body ? (body as { error?: unknown }).error : null;
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "PREVIEW_REQUEST_FAILED";
      // Imported or server-rejected prose is not echoed into an error message.
      throw new VimaxPreviewError(response.status, code,
        response.status === 409 ? "剧本或角色来源已变化，或当前版本尚未批准。请重新读取来源，再准备对应版本的方案。"
          : response.status === 404 ? "当前环境暂未开放单场景分镜预览。"
            : response.status === 401 || response.status === 403 ? "没有读取或预览权限，请检查登录状态。"
              : response.status === 413 ? "分镜方案不能超过 300 KB。"
                : response.status === 400 ? "方案内容未通过校验，请检查场景、角色、对白和字段格式。"
                  : "暂时无法校验分镜方案，请稍后重试。");
    }
    return body;
  }

  async source(projectId: string, episodeId: string, signal?: AbortSignal): Promise<VimaxPlatformSourceSnapshot> {
    const body = await this.call(`${this.path(projectId, episodeId)}/source`, {
      method: "GET", headers: { Accept: "application/json" }, signal,
    });
    const parsed = vimaxPlatformSourceSnapshotSchema.safeParse(body);
    if (!parsed.success || parsed.data.projectId !== projectId || parsed.data.episodeId !== episodeId) throw unconfirmed();
    return parsed.data;
  }

  async preview(projectId: string, episodeId: string, request: VimaxPlatformPreviewRequest, signal?: AbortSignal): Promise<VimaxPlatformPreviewResponse> {
    const parsedRequest = vimaxPlatformPreviewRequestSchema.safeParse(request);
    if (!parsedRequest.success) throw new VimaxPreviewError(400, "PREVIEW_IMPORT_INVALID", "方案格式不完整，请重新导入。");
    const normalizedRequest = parsedRequest.data;
    const body = JSON.stringify(normalizedRequest);
    if (new TextEncoder().encode(body).byteLength > VIMAX_PLATFORM_PREVIEW_MAX_BYTES) {
      throw new VimaxPreviewError(413, "PREVIEW_IMPORT_TOO_LARGE", "分镜方案不能超过 300 KB。");
    }
    const received = await this.call(this.path(projectId, episodeId), {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body, signal,
    });
    const parsed = vimaxPlatformPreviewResponseSchema.safeParse(received);
    if (!parsed.success) throw unconfirmed();
    const response = parsed.data;
    const { source, report } = response;
    if (source.projectId !== projectId || source.episodeId !== episodeId || !vimaxPreviewSourceMatches(source, normalizedRequest)) throw unconfirmed();
    const provenance = report.provenance;
    if (provenance && (provenance.projectId !== projectId || provenance.episodeId !== episodeId
      || provenance.episodeNo !== source.episodeNo || provenance.scriptRevisionId !== source.scriptRevisionId
      || provenance.scriptContentHash !== source.scriptContentHash || provenance.selectedSceneKey !== normalizedRequest.selectedSceneKeys[0])) throw unconfirmed();
    if (report.status === "ready_for_review") {
      const selected = normalizedRequest.sceneSpans.find((scene) => scene.key === normalizedRequest.selectedSceneKeys[0]);
      if (!provenance || !selected || !same(report.review.scene, selected)
        || report.review.sourceSceneText !== source.scriptText.slice(selected.start, selected.end)
        || !same(report.review.requirements, normalizedRequest.requirements)
        || !same(report.review.candidate, normalizedRequest.candidate)
        || !same(report.review.shots, normalizedRequest.supplements.shots)) throw unconfirmed();
    }
    return response;
  }
}
