import type { RealMediaCapability, RealMediaQuote, SpeechMixPreflight } from "@ai-drama/contracts";
import { ApiError, StudioClient } from "./studio-client";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const AMOUNT = /^(0|[1-9]\d{0,7})(\.\d{1,8})?$/;
const CAPS = new Set(["image.generate", "video.generate", "audio.tts", "audio.music"]);
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function invalid(): never { throw new ApiError(502, "INVALID_RESPONSE", "服务回执无法核对，请保留原请求并继续确认。"); }
export function checkedRealMediaQuote(value: unknown): RealMediaQuote {
  const q = object(value);
  if (typeof q.quoteId !== "string" || !UUID.test(q.quoteId) || typeof q.inputHash !== "string" || !/^[a-f0-9]{64}$/.test(q.inputHash)
    || typeof q.capability !== "string" || !CAPS.has(q.capability)
    || !["CNY", "USD"].includes(String(q.currency)) || typeof q.estimatedAmount !== "string" || !AMOUNT.test(q.estimatedAmount)
    || typeof q.maximumAmount !== "string" || !AMOUNT.test(q.maximumAmount) || typeof q.providerConfigurationId !== "string" || !UUID.test(q.providerConfigurationId)
    || typeof q.providerConfigurationVersion !== "string" || !q.providerConfigurationVersion || typeof q.priceVersion !== "string" || !q.priceVersion
    || typeof q.expiresAt !== "string" || !Number.isFinite(Date.parse(q.expiresAt))
    || q.actualCost !== "unknown" || q.singleOperation !== true
    || (q.uncertainJobIds !== undefined && (!Array.isArray(q.uncertainJobIds) || q.uncertainJobIds.length > 20
      || !q.uncertainJobIds.every(id => typeof id === "string" && UUID.test(id))))) return invalid();
  return value as RealMediaQuote;
}
export interface RealMediaAccepted { jobId: string; workflowRunId: string }
export interface RealMediaAsset {
  id: string; kind: "IMAGE" | "VIDEO" | "AUDIO" | "MUSIC"; status: string; sourceShotRevisionId: string;
  checksumSha256: string; durationMs: number | null; storageProvider: "s3";
}
export interface RealMediaCapabilities { available: boolean; readAvailable?: boolean; reasonCode: string | null; capabilities: RealMediaCapability[] }
function accepted(value: unknown): RealMediaAccepted {
  const result = object(value);
  if (!UUID.test(String(result.jobId)) || !UUID.test(String(result.workflowRunId))) return invalid();
  return { jobId: String(result.jobId), workflowRunId: String(result.workflowRunId) };
}
export function createRealMediaClient(studio = new StudioClient()) {
  return {
    async capabilities(projectId: string, signal?: AbortSignal): Promise<RealMediaCapabilities> {
      const value = object(await studio.get("/projects/" + projectId + "/real-media/capabilities", { signal }));
      if (typeof value.available !== "boolean" || !Array.isArray(value.capabilities)
        || !value.capabilities.every(v => typeof v === "string" && CAPS.has(v))) return invalid();
      if (value.readAvailable !== undefined && typeof value.readAvailable !== "boolean") return invalid();
      return { available: value.available, ...(value.readAvailable !== undefined ? { readAvailable: value.readAvailable as boolean } : {}), reasonCode: typeof value.reasonCode === "string" ? value.reasonCode : null,
        capabilities: value.capabilities as RealMediaCapability[] };
    },
    async assets(shotRevisionId: string, cursor?: string, signal?: AbortSignal): Promise<{ items: RealMediaAsset[]; nextCursor: string | null }> {
      const value = object(await studio.get("/shot-revisions/" + shotRevisionId + "/assets?limit=100"
        + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""), { signal }));
      if (!Array.isArray(value.items) || (value.nextCursor !== null && typeof value.nextCursor !== "string")) return invalid();
      const items = value.items.filter(a => object(a).storageProvider === "s3").map(a => {
        const v = object(a);
        if (!UUID.test(String(v.id)) || v.sourceShotRevisionId !== shotRevisionId
          || !["IMAGE", "VIDEO", "AUDIO", "MUSIC"].includes(String(v.kind)) || typeof v.status !== "string"
          || !/^[a-f0-9]{64}$/.test(String(v.checksumSha256))
          || (v.durationMs !== null && (!Number.isSafeInteger(v.durationMs) || Number(v.durationMs) <= 0))) return invalid();
        return v as unknown as RealMediaAsset;
      });
      return { items, nextCursor: value.nextCursor as string | null };
    },
    async characters(projectId: string, signal?: AbortSignal): Promise<Array<{ id: string; name: string }>> {
      const value = object(await studio.get("/projects/" + projectId + "/characters?limit=100", { signal }));
      if (!Array.isArray(value.items)) return invalid();
      return value.items.map(item => {
        const c = object(item);
        if (!UUID.test(String(c.entityId))) return invalid();
        return { id: String(c.entityId), name: typeof c.name === "string" && c.name ? c.name : "角色 " + String(c.entityId).slice(0, 8) };
      });
    },
    async quote(projectId: string, shotRevisionId: string, capability: RealMediaCapability, sourceImageAssetId?: string) {
      const quote = checkedRealMediaQuote(await studio.postJson("/projects/" + projectId + "/shot-revisions/" + shotRevisionId + "/real-media/quote",
        { capability, ...(sourceImageAssetId ? { sourceImageAssetId } : {}) }));
      if (quote.capability !== capability) return invalid();
      return quote;
    },
    async authorize(projectId: string, quote: RealMediaQuote, maximumAmount: string, key: string) {
      const result = await studio.write<unknown>({ path: "/projects/" + projectId + "/real-media/authorize", idempotencyKey: key,
        body: { quoteId: quote.quoteId, maximumAmount, confirmSinglePaidOperation: true, confirmedUncertainJobIds: quote.uncertainJobIds ?? [] } });
      const value = object(result.body);
      if (value.quoteId !== quote.quoteId || !UUID.test(String(value.budgetAuthorizationId))) return invalid();
      return String(value.budgetAuthorizationId);
    },
    async generate(projectId: string, shotRevisionId: string, quoteId: string, budgetAuthorizationId: string, key: string) {
      return accepted((await studio.write({ path: "/projects/" + projectId + "/shot-revisions/" + shotRevisionId + "/real-media/generate",
        body: { quoteId, budgetAuthorizationId }, idempotencyKey: key })).body);
    },
    async job(jobId: string, signal?: AbortSignal) {
      const value = object(await studio.get("/generation-jobs/" + jobId, { signal }));
      if (value.id !== jobId || !["PENDING", "QUEUED", "RUNNING", "WAITING_EXTERNAL", "SUCCEEDED", "FAILED", "CANCELED"].includes(String(value.state))) return invalid();
      return { id: jobId, state: String(value.state), errorCode: typeof value.errorCode === "string" ? value.errorCode : null };
    },
    async compose(shotRevisionId: string, preflight: SpeechMixPreflight, key: string) {
      const m = preflight.manifest;
      return accepted((await studio.write({ path: "/shot-revisions/" + shotRevisionId + "/voice-compose", idempotencyKey: key,
        body: { planRevisionId: m.planRevisionId, videoAssetId: m.videoAssetId, musicAssetId: m.mix.musicAssetId,
          originalAudio: m.mix.originalAudio, musicGain: m.mix.musicGain, ducking: m.mix.ducking, expectedInputHash: preflight.inputHash } })).body);
    },
  };
}
export type RealMediaClient = ReturnType<typeof createRealMediaClient>;
export interface RealMediaPending {
  schema: "ads.real-media.pending.v1"; projectId: string; shotRevisionId: string; key: string;
  quote: RealMediaQuote; maximumAmount: string; authorizationId: string | null;
}
export function realMediaPendingKey(projectId: string, shotRevisionId: string): string { return "ads.real-media.pending.v1:" + projectId + ":" + shotRevisionId; }
export function readRealMediaPending(projectId: string, shotRevisionId: string): RealMediaPending | null {
  const raw = sessionStorage.getItem(realMediaPendingKey(projectId, shotRevisionId));
  if (raw === null) return null;
  try {
    const p = JSON.parse(raw) as RealMediaPending;
    if (p.schema !== "ads.real-media.pending.v1" || p.projectId !== projectId || p.shotRevisionId !== shotRevisionId
      || !UUID.test(p.key) || !AMOUNT.test(p.maximumAmount) || (p.authorizationId !== null && !UUID.test(p.authorizationId))) throw new Error();
    checkedRealMediaQuote(p.quote);
    return p;
  } catch { throw new Error("原媒体请求记录无法核对，请先核查任务，尚未发送新请求。"); }
}
export function rememberRealMediaPending(p: RealMediaPending): void {
  const key = realMediaPendingKey(p.projectId, p.shotRevisionId), before = readRealMediaPending(p.projectId, p.shotRevisionId);
  if (before && (before.key !== p.key || JSON.stringify(before.quote) !== JSON.stringify(p.quote) || before.maximumAmount !== p.maximumAmount
    || (before.authorizationId !== null && before.authorizationId !== p.authorizationId))) throw new Error("原媒体请求尚未确认，不能替换。");
  const text = JSON.stringify(p);
  sessionStorage.setItem(key, text);
  if (sessionStorage.getItem(key) !== text) throw new Error("无法保留原媒体请求，尚未发送。");
}
export function clearRealMediaPending(p: RealMediaPending): boolean {
  const current = readRealMediaPending(p.projectId, p.shotRevisionId);
  if (!current || JSON.stringify(current) !== JSON.stringify(p)) return false;
  sessionStorage.removeItem(realMediaPendingKey(p.projectId, p.shotRevisionId));
  return sessionStorage.getItem(realMediaPendingKey(p.projectId, p.shotRevisionId)) === null;
}
export interface RealMediaComposePending {
  schema: "ads.voice-compose.pending.v1"; projectId: string; shotRevisionId: string; key: string; value: SpeechMixPreflight;
}
export function readRealMediaComposePending(projectId: string, shotRevisionId: string): RealMediaComposePending | null {
  const raw = sessionStorage.getItem(realMediaPendingKey(projectId, shotRevisionId) + ":compose");
  if (raw === null) return null;
  try {
    const p = JSON.parse(raw) as RealMediaComposePending, m = p.value?.manifest;
    if (p.schema !== "ads.voice-compose.pending.v1" || p.projectId !== projectId || p.shotRevisionId !== shotRevisionId
      || typeof p.key !== "string" || !UUID.test(p.key) || !/^[a-f0-9]{64}$/.test(p.value.inputHash)
      || m?.schema !== "voice.shot.mix.v1" || m.projectId !== projectId || m.shotRevisionId !== shotRevisionId
      || !UUID.test(m.planRevisionId) || !UUID.test(m.videoAssetId) || !m.mix
      || (m.mix.musicAssetId !== null && !UUID.test(m.mix.musicAssetId))) throw new Error();
    return p;
  } catch { throw new Error("原合成请求记录无法核对，请先核查任务。"); }
}
export function rememberRealMediaComposePending(p: RealMediaComposePending): void {
  const key = realMediaPendingKey(p.projectId, p.shotRevisionId) + ":compose", before = readRealMediaComposePending(p.projectId, p.shotRevisionId);
  if (before && JSON.stringify(before) !== JSON.stringify(p)) throw new Error("原合成请求尚未确认，请先继续确认原请求。");
  const raw = JSON.stringify(p);
  sessionStorage.setItem(key, raw);
  if (sessionStorage.getItem(key) !== raw) throw new Error("无法保留原合成请求，尚未发送。");
}
export function clearRealMediaComposePending(p: RealMediaComposePending): boolean {
  if (JSON.stringify(readRealMediaComposePending(p.projectId, p.shotRevisionId)) !== JSON.stringify(p)) return false;
  const key = realMediaPendingKey(p.projectId, p.shotRevisionId) + ":compose";
  sessionStorage.removeItem(key);
  return sessionStorage.getItem(key) === null;
}
