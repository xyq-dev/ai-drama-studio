import {
  vimaxPlanningOptionsSchema, vimaxPlanningPageSchema, vimaxPlanningResponseSchema, vimaxPlanningStartSchema,
  type VimaxPlanningOptions, type VimaxPlanningPage, type VimaxPlanningResponse, type VimaxPlanningStart, type VimaxPlanningView,
} from "@ai-drama/contracts";
import { withSession } from "./site-session";
import { isEntityId } from "./title-writing-client";
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export class VimaxPlanningError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly requestId?: string) { super(message); this.name = "VimaxPlanningError"; }
}
const invalid = () => new VimaxPlanningError(400, "VIMAX_PLANNING_INVALID_REQUEST", "规划请求不完整，请核对当前场景与原文。");
const unconfirmed = () => new VimaxPlanningError(200, "VIMAX_PLANNING_UNCONFIRMED", "没有收到与原请求一致的完整回执，原请求标识已保留。");
function scoped(v: VimaxPlanningView, p: string, e: string, id?: string): VimaxPlanningView {
  if (v.projectId !== p || v.episodeId !== e || (id !== undefined && v.requestId !== id)
    || v.input.source.projectId !== p || v.input.source.episodeId !== e
    || v.input.source.scriptRevisionId !== v.input.request.source.scriptRevisionId
    || v.input.source.scriptContentHash !== v.input.request.source.scriptContentHash
    || !same(v.input.source.characters, v.input.request.source.characters)
    || v.input.target.sceneId !== v.input.request.target.sceneId
    || v.input.target.sceneRevisionId !== v.input.request.target.sceneRevisionId
    || v.input.target.rowVersion !== v.input.request.target.rowVersion) throw unconfirmed();
  if (v.output && (!same(v.output.target, v.input.request.target)
    || !same(v.output.request.source, v.input.request.source)
    || !same(v.output.request.sceneSpans, v.input.request.sceneSpans)
    || !same(v.output.request.selectedSceneKeys, v.input.request.selectedSceneKeys)
    || !same(v.output.request.sourceDialogue, v.input.request.sourceDialogue)
    || !same(v.output.request.requirements, v.input.request.requirements))) throw unconfirmed();
  return v;
}
export class VimaxPlanningClient {
  constructor(private readonly fetchImpl?: FetchLike, private readonly prefix = "/api/v1") {}
  private base(p: string, e: string): string {
    if (!isEntityId(p) || !isEntityId(e)) throw invalid();
    return `/projects/${p}/episodes/${e}/vimax-planning`;
  }
  private requestPath(p: string, e: string, id: string) {
    if (!isEntityId(id)) throw invalid(); return `${this.base(p, e)}/requests/${id}`;
  }
  private async call(path: string, init: RequestInit): Promise<unknown> {
    const headers = new Headers(init.headers); headers.set("Accept", "application/json");
    const r = await withSession(this.fetchImpl ?? globalThis.fetch.bind(globalThis))(`${this.prefix}${path}`,
      { ...init, headers, credentials: "same-origin", cache: "no-store" });
    let body: unknown; try { body = JSON.parse(await r.text()); } catch { body = null; }
    if (!r.ok) {
      const candidate = body && typeof body === "object" && "error" in body ? body.error : null;
      const error = candidate && typeof candidate === "object" ? candidate as { code?: unknown; message?: unknown; details?: { requestId?: unknown } } : null;
      const code = typeof error?.code === "string" ? error.code : "VIMAX_PLANNING_REQUEST_FAILED";
      throw new VimaxPlanningError(r.status, code,
        r.status === 401 || r.status === 403 ? "请检查登录与操作权限，未确认的原请求已保留。"
          : r.status === 503 ? "在线规划尚不可用，未确认的原请求已保留。"
            : typeof error?.message === "string" ? error.message : "尚未确认规划结果，请保留原请求并稍后确认。",
        typeof error?.details?.requestId === "string" && isEntityId(error.details.requestId) ? error.details.requestId : undefined);
    }
    return body;
  }
  async options(p: string, e: string, signal?: AbortSignal): Promise<VimaxPlanningOptions> {
    const r = vimaxPlanningOptionsSchema.safeParse(await this.call(`${this.base(p, e)}/options`, { method: "GET", signal }));
    if (!r.success) throw unconfirmed(); return r.data;
  }
  async list(p: string, e: string, signal?: AbortSignal): Promise<VimaxPlanningPage> {
    const r = vimaxPlanningPageSchema.safeParse(await this.call(`${this.base(p, e)}/requests`, { method: "GET", signal }));
    if (!r.success || new Set(r.data.items.map((v) => v.requestId)).size !== r.data.items.length) throw unconfirmed();
    r.data.items.forEach((v) => scoped(v, p, e)); return r.data;
  }
  async get(p: string, e: string, id: string, signal?: AbortSignal): Promise<VimaxPlanningResponse> {
    const r = vimaxPlanningResponseSchema.safeParse(await this.call(this.requestPath(p, e, id), { method: "GET", signal }));
    if (!r.success) throw unconfirmed(); scoped(r.data.request, p, e, id); return r.data;
  }
  async start(p: string, e: string, body: VimaxPlanningStart, key: string, signal?: AbortSignal): Promise<VimaxPlanningResponse> {
    if (!/^[\x21-\x7e]{1,200}$/.test(key)) throw invalid();
    const input = vimaxPlanningStartSchema.safeParse(body); if (!input.success) throw invalid();
    const json = JSON.stringify(input.data);
    if (new TextEncoder().encode(json).byteLength > 300 * 1024) throw new VimaxPlanningError(413, "VIMAX_PLANNING_INPUT_TOO_LARGE", "规划请求不能超过 300 KB。");
    const r = vimaxPlanningResponseSchema.safeParse(await this.call(`${this.base(p, e)}/requests`, {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: json, signal,
    }));
    if (!r.success) throw unconfirmed(); scoped(r.data.request, p, e);
    if (!same(r.data.request.input.request, input.data) || r.data.request.requestKey !== key) throw unconfirmed();
    return r.data;
  }
  async cancel(p: string, e: string, id: string, signal?: AbortSignal): Promise<VimaxPlanningResponse> {
    const r = vimaxPlanningResponseSchema.safeParse(await this.call(`${this.requestPath(p, e, id)}/cancel`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal,
    }));
    if (!r.success) throw unconfirmed(); scoped(r.data.request, p, e, id); return r.data;
  }
}
