import {
  VIMAX_PLATFORM_PREVIEW_MAX_BYTES,
  vimaxCandidateCreateResponseSchema, vimaxCandidateCreateSchema, vimaxCandidatePageSchema,
  vimaxCandidatePlaceShotsSchema, vimaxCandidateSaveSceneSchema, vimaxCandidateTargetsSchema,
  vimaxCandidateViewSchema, vimaxCandidateWriteResponseSchema,
  type VimaxCandidateCreate, type VimaxCandidateCreateResponse, type VimaxCandidatePage,
  type VimaxCandidatePlaceShots, type VimaxCandidateReceipt, type VimaxCandidateSaveScene,
  type VimaxCandidateTargets, type VimaxCandidateView, type VimaxCandidateWriteResponse,
} from "@ai-drama/contracts";
import { withSession } from "./site-session";
import { isEntityId } from "./title-writing-client";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export class VimaxCandidateError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "VimaxCandidateError"; }
}
const unconfirmed = () => new VimaxCandidateError(200, "VIMAX_CANDIDATE_UNCONFIRMED", "尚未收到与原保存请求一致的完整回执。请保留原请求并确认保存结果。");
const invalid = () => new VimaxCandidateError(400, "VIMAX_CANDIDATE_INVALID_REQUEST", "保存请求不完整，请重新核对方案。");

function scope(projectId: string, episodeId: string, candidateId?: string) {
  if (!isEntityId(projectId) || !isEntityId(episodeId) || (candidateId !== undefined && !isEntityId(candidateId))) throw invalid();
}
function checkedBody(value: unknown, idempotencyKey: string): string {
  if (!/^[\x21-\x7e]{1,200}$/.test(idempotencyKey)) throw invalid();
  const body = JSON.stringify(value);
  if (new TextEncoder().encode(body).byteLength > VIMAX_PLATFORM_PREVIEW_MAX_BYTES) {
    throw new VimaxCandidateError(413, "VIMAX_CANDIDATE_INPUT_TOO_LARGE", "完整保存请求不能超过 300 KB。");
  }
  return body;
}
function validateShotLinks(receipt: VimaxCandidateReceipt, expectedCount?: number) {
  if (receipt.operation !== "place_shots") return;
  if (receipt.shots.some((shot, index) => shot.index !== index)
    || new Set(receipt.shots.map((shot) => shot.shotId)).size !== receipt.shots.length
    || new Set(receipt.shots.map((shot) => shot.shotRevisionId)).size !== receipt.shots.length
    || (expectedCount !== undefined && receipt.shots.length !== expectedCount)) throw unconfirmed();
}
/** Structural checks are supplemented by the relationships the page uses as write expectations. */
function viewInScope(view: VimaxCandidateView, projectId: string, episodeId: string, candidateId?: string): VimaxCandidateView {
  const frozen = view.frozen;
  const provenance = frozen.evaluation.provenance;
  const selected = frozen.request.sceneSpans.find((scene) => scene.key === frozen.request.selectedSceneKeys[0]);
  if (view.projectId !== projectId || view.episodeId !== episodeId || (candidateId && view.candidateId !== candidateId)
    || frozen.source.projectId !== projectId || frozen.source.episodeId !== episodeId
    || frozen.request.source.scriptRevisionId !== frozen.source.scriptRevisionId
    || frozen.request.source.scriptContentHash !== frozen.source.scriptContentHash
    || !same(frozen.request.source.characters, frozen.source.characters)
    || frozen.target.sourceScriptRevisionId !== frozen.source.scriptRevisionId
    || !selected || !provenance || provenance.projectId !== projectId || provenance.episodeId !== episodeId
    || provenance.episodeNo !== frozen.source.episodeNo || provenance.scriptRevisionId !== frozen.source.scriptRevisionId
    || provenance.scriptContentHash !== frozen.source.scriptContentHash || provenance.selectedSceneKey !== selected.key
    || !same(frozen.evaluation.review.scene, selected)
    || frozen.evaluation.review.sourceSceneText !== frozen.source.scriptText.slice(selected.start, selected.end)
    || !same(frozen.evaluation.review.requirements, frozen.request.requirements)
    || !same(frozen.evaluation.review.shots, frozen.request.supplements.shots)
    || !same(frozen.evaluation.review.candidate, frozen.request.candidate)) throw unconfirmed();
  const scene = view.sceneReceipt;
  const shots = view.shotsReceipt;
  for (const receipt of [scene, shots]) if (receipt && (receipt.candidateId !== view.candidateId
    || receipt.projectId !== projectId || receipt.episodeId !== episodeId || receipt.sceneId !== frozen.target.sceneId)) throw unconfirmed();
  if ((view.state === "stored" && (view.rowVersion !== 1 || scene || shots || view.eligibility.canPlaceShots))
    || (view.state === "scene_saved" && (view.rowVersion !== 2 || !scene || shots || view.eligibility.canSaveScene))
    || (view.state === "shots_saved" && (view.rowVersion !== 3 || !scene || !shots || view.eligibility.canSaveScene || view.eligibility.canPlaceShots))) throw unconfirmed();
  if (scene && (scene.rowVersion !== 2 || scene.sceneRevisionId === frozen.target.sceneRevisionId)) throw unconfirmed();
  if (shots && (!scene || shots.rowVersion !== 3 || shots.sceneRevisionId !== scene.sceneRevisionId)) throw unconfirmed();
  if (shots) validateShotLinks(shots, frozen.request.supplements.shots.length);
  const current = view.eligibility.currentScene;
  if (current && current.sceneId !== frozen.target.sceneId) throw unconfirmed();
  if (view.eligibility.canSaveScene && (!current || current.archived || current.activeShotCount !== 0
    || current.currentRevisionId !== frozen.target.sceneRevisionId || current.rowVersion !== frozen.target.rowVersion)) throw unconfirmed();
  if (view.eligibility.canPlaceShots && (!current || !scene || current.archived || current.activeShotCount !== 0
    || current.currentRevisionId !== scene.sceneRevisionId || current.approvedRevisionId !== scene.sceneRevisionId
    || current.reviewStatus !== "APPROVED" || current.freshnessStatus !== "CURRENT")) throw unconfirmed();
  return view;
}

/** The page keeps each request identity until this client verifies its complete scoped receipt. */
export class VimaxCandidateClient {
  constructor(private readonly fetchImpl?: FetchLike, private readonly prefix = "/api/v1") {}
  private base(projectId: string, episodeId: string): string { scope(projectId, episodeId); return `/projects/${projectId}/episodes/${episodeId}/vimax-candidates`; }
  private async call(path: string, init: RequestInit): Promise<unknown> {
    const headers = new Headers(init.headers);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    const response = await withSession(this.fetchImpl ?? globalThis.fetch.bind(globalThis))(`${this.prefix}${path}`, {
      ...init, headers, cache: "no-store", credentials: "same-origin",
    });
    let body: unknown;
    try { body = JSON.parse(await response.text()); } catch { body = null; }
    if (!response.ok) {
      const error = body && typeof body === "object" && "error" in body ? (body as { error?: unknown }).error : null;
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "VIMAX_CANDIDATE_REQUEST_FAILED";
      throw new VimaxCandidateError(response.status, code,
        response.status === 503 && code === "VIMAX_CANDIDATE_STORAGE_UNAVAILABLE" ? "保存功能尚未启用，仍可使用分镜预览。"
          : response.status === 401 || response.status === 403 ? "请检查登录与操作权限。未确认的原保存请求已保留。"
            : response.status === 404 ? "没有找到该候选，或当前环境未开放保存功能。"
              : response.status === 409 ? "来源、目标场景或保存状态已变化。请重新读取候选；未确认的原请求仍保留。"
                : response.status === 413 && code === "VIMAX_CANDIDATE_FROZEN_TOO_LARGE" ? "冻结后的完整候选超出保存范围，请缩小方案后重新保存。"
                  : response.status === 413 ? "完整保存请求不能超过 300 KB。"
                  : response.status === 400 || response.status === 422 ? "保存请求未通过校验，请核对字段、原文与目标场景。"
                    : "暂未确认保存结果，请保留原请求并稍后确认。");
    }
    return body;
  }
  async targets(projectId: string, episodeId: string, signal?: AbortSignal): Promise<VimaxCandidateTargets> {
    const result = vimaxCandidateTargetsSchema.safeParse(await this.call(`${this.base(projectId, episodeId)}/targets`, { method: "GET", signal }));
    if (!result.success || result.data.source.projectId !== projectId || result.data.source.episodeId !== episodeId
      || new Set(result.data.targets.map((target) => target.sceneId)).size !== result.data.targets.length
      || result.data.targets.some((target) => target.eligible && (target.activeShotCount !== 0 || target.sourceScriptRevisionId !== result.data.source.scriptRevisionId))) throw unconfirmed();
    return result.data;
  }
  async list(projectId: string, episodeId: string, options: { limit?: number; cursor?: string } = {}, signal?: AbortSignal): Promise<VimaxCandidatePage> {
    const limit = options.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20 || (options.cursor !== undefined && (options.cursor.length === 0 || options.cursor.length > 1000))) throw invalid();
    const query = new URLSearchParams({ limit: String(limit), ...(options.cursor ? { cursor: options.cursor } : {}) });
    const result = vimaxCandidatePageSchema.safeParse(await this.call(`${this.base(projectId, episodeId)}?${query.toString()}`, { method: "GET", signal }));
    if (!result.success || result.data.items.length > limit || new Set(result.data.items.map((item) => item.candidateId)).size !== result.data.items.length) throw unconfirmed();
    result.data.items.forEach((item) => viewInScope(item, projectId, episodeId));
    return result.data;
  }
  async get(projectId: string, episodeId: string, candidateId: string, signal?: AbortSignal): Promise<VimaxCandidateView> {
    scope(projectId, episodeId, candidateId);
    const result = vimaxCandidateViewSchema.safeParse(await this.call(`${this.base(projectId, episodeId)}/${candidateId}`, { method: "GET", signal }));
    if (!result.success) throw unconfirmed();
    return viewInScope(result.data, projectId, episodeId, candidateId);
  }
  async create(projectId: string, episodeId: string, body: VimaxCandidateCreate, key: string, signal?: AbortSignal): Promise<VimaxCandidateCreateResponse> {
    const parsed = vimaxCandidateCreateSchema.safeParse(body); if (!parsed.success) throw invalid();
    const result = vimaxCandidateCreateResponseSchema.safeParse(await this.call(this.base(projectId, episodeId), {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: checkedBody(parsed.data, key), signal,
    }));
    if (!result.success) throw unconfirmed();
    const view = viewInScope(result.data.candidate, projectId, episodeId);
    if (view.requestKey !== key || !same(view.frozen.request, parsed.data.request)
      || view.frozen.target.sceneId !== parsed.data.target.sceneId || view.frozen.target.sceneRevisionId !== parsed.data.target.sceneRevisionId
      || view.frozen.target.rowVersion !== parsed.data.target.rowVersion) throw unconfirmed();
    return result.data;
  }
  async saveScene(projectId: string, episodeId: string, candidateId: string, body: VimaxCandidateSaveScene, key: string,
    signal?: AbortSignal, expected?: VimaxCandidateView): Promise<VimaxCandidateWriteResponse> {
    const parsed = vimaxCandidateSaveSceneSchema.safeParse(body); if (!parsed.success) throw invalid();
    return this.write(projectId, episodeId, candidateId, "save_scene", parsed.data, key, signal, expected);
  }
  async placeShots(projectId: string, episodeId: string, candidateId: string, body: VimaxCandidatePlaceShots, key: string,
    signal?: AbortSignal, expected?: VimaxCandidateView): Promise<VimaxCandidateWriteResponse> {
    const parsed = vimaxCandidatePlaceShotsSchema.safeParse(body); if (!parsed.success) throw invalid();
    return this.write(projectId, episodeId, candidateId, "place_shots", parsed.data, key, signal, expected);
  }
  private async write(projectId: string, episodeId: string, candidateId: string, operation: "save_scene" | "place_shots",
    body: VimaxCandidateSaveScene | VimaxCandidatePlaceShots, key: string, signal?: AbortSignal, expected?: VimaxCandidateView): Promise<VimaxCandidateWriteResponse> {
    scope(projectId, episodeId, candidateId);
    const result = vimaxCandidateWriteResponseSchema.safeParse(await this.call(`${this.base(projectId, episodeId)}/${candidateId}/${operation === "save_scene" ? "scene" : "shots"}`, {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: checkedBody(body, key), signal,
    }));
    if (!result.success) throw unconfirmed();
    const receipt = result.data.receipt;
    if (receipt.projectId !== projectId || receipt.episodeId !== episodeId || receipt.candidateId !== candidateId
      || receipt.operation !== operation || receipt.idempotencyKey !== key || receipt.rowVersion !== body.expectedVersion + 1) throw unconfirmed();
    if (expected) {
      viewInScope(expected, projectId, episodeId, candidateId);
      if (receipt.sceneId !== expected.frozen.target.sceneId
        || (operation === "place_shots" && !expected.sceneReceipt)
        || (operation === "save_scene" && receipt.sceneRevisionId === expected.frozen.target.sceneRevisionId)
        || (expected.sceneReceipt && receipt.sceneRevisionId !== expected.sceneReceipt.sceneRevisionId)) throw unconfirmed();
    }
    validateShotLinks(receipt, expected?.frozen.request.supplements.shots.length);
    return result.data;
  }
}
