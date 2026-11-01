import { speechBatchPreflightSchema, speechBatchConfirmSchema, type SpeechBatchInventory, type SpeechBatchView } from "@ai-drama/contracts";
import { ApiError, StudioClient } from "./studio-client";
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const MONEY = /^(0|[1-9]\d{0,9})(\.\d{1,8})?$/;
const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const validId = (v: unknown): v is string => typeof v === "string" && ID.test(v);
const money = (v: unknown): v is string => typeof v === "string" && MONEY.test(v);
function invalid(): never { throw new ApiError(502, "INVALID_RESPONSE", "批次回执无法核对，请保留原请求继续核查。"); }
function units(v: string): bigint { const [whole = "0", fraction = ""] = v.split("."); return BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, "0")); }
function stable(v: unknown, depth = 0): string {
  if (depth > 30) return invalid();
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(item => stable(item, depth + 1)).join(",") + "]";
  const record = v as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map(key => JSON.stringify(key) + ":" + stable(record[key], depth + 1)).join(",") + "}";
}
export function checkedSpeechBatch(value: unknown, projectId: string, episodeId: string): SpeechBatchView {
  const v = obj(value), f = obj(v.frozen);
  if (!validId(v.id) || v.projectId !== projectId || v.episodeId !== episodeId || typeof v.frozenHash !== "string" || !HASH.test(v.frozenHash)
    || !["quoted", "dispatching", "needs_attention", "dispatched", "canceled"].includes(String(v.state))
    || typeof v.cancelRequested !== "boolean" || typeof v.createdAt !== "string" || !Number.isFinite(Date.parse(v.createdAt))
    || f.schema !== "voice.episode.batch.v1" || f.projectId !== projectId || f.episodeId !== episodeId
    || typeof f.expiresAt !== "string" || !Number.isFinite(Date.parse(f.expiresAt)) || !Array.isArray(f.budgets)
    || f.budgets.length < 1 || f.budgets.length > 2 || f.budgets.some(b => {
      const row = obj(b); return !["CNY", "USD"].includes(String(row.currency)) || !money(row.maximumAmount)
        || row.estimatedAmount !== null && !money(row.estimatedAmount);
    }) || !Array.isArray(f.operations) || f.operations.length < 1 || f.operations.length > 100
    || !Array.isArray(v.operations) || v.operations.length !== f.operations.length) return invalid();
  const ids = f.operations.map(operation => obj(operation).id);
  if (!ids.every(validId) || new Set(ids).size !== ids.length || new Set(f.budgets.map(b => obj(b).currency)).size !== f.budgets.length
    || new Set(v.operations.map(o => obj(o).id)).size !== ids.length) return invalid();
  const totals = new Map<string, { maximum: bigint; estimate: bigint | null }>();
  for (const [index, operation] of v.operations.entries()) {
    const o = obj(operation), q = obj(o.quote);
    if (!validId(o.id) || !ids.includes(o.id) || !validId(o.lineId) || !validId(o.lineInputRevisionId) || !validId(o.shotRevisionId)
      || typeof o.displayText !== "string" || !["pending", "working", "job_created", "unknown", "blocked", "canceled"].includes(String(o.state))
      || !money(o.maximumAmount) || !validId(q.quoteId) || typeof q.inputHash !== "string" || !HASH.test(q.inputHash)
      || !money(q.maximumAmount) || (q.estimatedAmount !== null && !money(q.estimatedAmount))
      || !["CNY", "USD"].includes(String(q.currency)) || typeof q.expiresAt !== "string" || !Number.isFinite(Date.parse(q.expiresAt))
      || (q.uncertainJobIds !== undefined && (!Array.isArray(q.uncertainJobIds) || !q.uncertainJobIds.every(validId)))
      || (o.jobId !== null && !validId(o.jobId)) || (o.workflowRunId !== null && !validId(o.workflowRunId))
      || (o.authorizationId !== null && !validId(o.authorizationId))
      || (o.jobId !== null && o.authorizationId === null)
      || (o.state === "job_created") !== (o.jobId !== null && o.workflowRunId !== null && o.authorizationId !== null)
      || (o.jobId === null) !== (o.workflowRunId === null)) return invalid();
    const expected = obj(f.operations[index]), input = obj(expected.input);
    if (expected.id !== o.id || input.projectId !== projectId || input.shotRevisionId !== o.shotRevisionId || input.lineId !== o.lineId
      || input.lineInputRevisionId !== o.lineInputRevisionId || input.displayText !== o.displayText || input.inputHash !== q.inputHash
      || stable(expected.quote) !== stable(q) || o.maximumAmount !== q.maximumAmount || units(q.maximumAmount as string) <= 0n) return invalid();
    const current = totals.get(q.currency as string) ?? { maximum: 0n, estimate: 0n };
    totals.set(q.currency as string, { maximum: current.maximum + units(q.maximumAmount as string), estimate:
      current.estimate === null || q.estimatedAmount === null ? null : current.estimate + units(q.estimatedAmount as string) });
  }
  if (totals.size !== f.budgets.length || f.budgets.some(value => {
    const b = obj(value), total = totals.get(b.currency as string);
    return !total || units(b.maximumAmount as string) !== total.maximum
      || (b.estimatedAmount === null ? total.estimate !== null : total.estimate === null || units(b.estimatedAmount as string) !== total.estimate);
  })) return invalid();
  return value as SpeechBatchView;
}
export function createSpeechBatchClient(studio = new StudioClient()) {
  return {
    async inventory(projectId: string, episodeId: string, signal?: AbortSignal): Promise<SpeechBatchInventory> {
      const v = obj(await studio.get(`/projects/${projectId}/episodes/${episodeId}/speech-batch-plan`, { signal }));
      if (v.projectId !== projectId || v.episodeId !== episodeId || typeof v.sourceHash !== "string" || !HASH.test(v.sourceHash)
        || !Number.isSafeInteger(v.operationLimit) || Number(v.operationLimit) < 1 || Number(v.operationLimit) > 100
        || !Array.isArray(v.lines) || v.lines.length > 3000 || !Array.isArray(v.blockers)) return invalid();
      for (const line of v.lines) {
        const l = obj(line);
        if (!validId(l.shotRevisionId) || !validId(l.planRevisionId) || !validId(l.lineId) || !validId(l.lineInputRevisionId)
          || typeof l.displayText !== "string" || typeof l.voiceName !== "string" || !["selected", "awaiting_selection", "in_progress", "uncertain", "missing"].includes(String(l.status))
          || !Array.isArray(l.jobIds) || !l.jobIds.every(validId)) return invalid();
      }
      if (v.blockers.some(b => typeof obj(b).message !== "string" || typeof obj(b).code !== "string")) return invalid();
      return v as unknown as SpeechBatchInventory;
    },
    async recent(projectId: string, episodeId: string, signal?: AbortSignal): Promise<SpeechBatchView[]> {
      const v = obj(await studio.get(`/projects/${projectId}/episodes/${episodeId}/speech-batches`, { signal }));
      if (!Array.isArray(v.items) || v.items.length > 20) return invalid();
      return v.items.map(item => checkedSpeechBatch(item, projectId, episodeId));
    },
    async read(projectId: string, episodeId: string, batchId: string, signal?: AbortSignal) {
      const result = checkedSpeechBatch(await studio.get(`/speech-batches/${batchId}`, { signal }), projectId, episodeId);
      if (result.id !== batchId) return invalid(); return result;
    },
    async write(request: SpeechBatchPending) {
      const path = request.kind === "quote" ? `/projects/${request.projectId}/episodes/${request.episodeId}/speech-batches`
        : `/speech-batches/${request.batchId}/${request.kind}`;
      const result = checkedSpeechBatch((await studio.write({ path, body: request.body, idempotencyKey: request.key })).body, request.projectId, request.episodeId);
      if (request.kind !== "quote" && result.id !== request.batchId) return invalid();
      if (request.kind === "quote") {
        const parsed = speechBatchPreflightSchema.safeParse(request.body);
        if (!parsed.success || result.frozen.sourceHash !== parsed.data.sourceHash
          || stable([...parsed.data.lineInputRevisionIds].sort()) !== stable(result.frozen.operations.map(o => o.input.lineInputRevisionId).sort())) return invalid();
      }
      if (request.kind === "confirm") {
        const parsed = speechBatchConfirmSchema.safeParse(request.body);
        if (!parsed.success || result.frozenHash !== parsed.data.frozenHash || !result.confirmation
          || stable(result.confirmation) !== stable(parsed.data)) return invalid();
      }
      if (request.kind === "cancel" && !(result.cancelRequested && result.state === "canceled") && result.state !== "dispatched") return invalid();
      if (request.kind === "resume" && !result.confirmation) return invalid();
      return result;
    },
  };
}
export type SpeechBatchClient = ReturnType<typeof createSpeechBatchClient>;
export interface SpeechBatchPending {
  schema: "ads.speech-batch.pending.v1"; projectId: string; episodeId: string; key: string;
  kind: "quote" | "confirm" | "resume" | "cancel"; batchId: string | null; body: Record<string, unknown>;
}
export const speechBatchJournalKey = (p: string, e: string) => `ads.speech-batch.pending.v1:${p}:${e}`;
export function readSpeechBatchPending(p: string, e: string): SpeechBatchPending | null {
  return decodePending(sessionStorage.getItem(speechBatchJournalKey(p, e)), p, e);
}
function decodePending(raw: string | null, p: string, e: string): SpeechBatchPending | null {
  if (raw === null) return null;
  try {
    if (raw.length > 256 * 1024) throw new Error();
    const v = JSON.parse(raw) as SpeechBatchPending;
    if (v.schema !== "ads.speech-batch.pending.v1" || v.projectId !== p || v.episodeId !== e || !validId(v.key)
      || !["quote", "confirm", "resume", "cancel"].includes(v.kind) || (v.kind === "quote" ? v.batchId !== null : !validId(v.batchId))
      || v.body === null || typeof v.body !== "object" || Array.isArray(v.body)) throw new Error();
    if (v.kind === "quote" ? !speechBatchPreflightSchema.safeParse(v.body).success
      : v.kind === "confirm" ? !speechBatchConfirmSchema.safeParse(v.body).success : Object.keys(v.body).length !== 0) throw new Error();
    return v;
  } catch { throw new Error("原配音批次请求无法核对，请先核查原批次，尚未发送新请求。"); }
}
export function rememberSpeechBatchPending(v: SpeechBatchPending): void {
  const before = readSpeechBatchPending(v.projectId, v.episodeId), raw = JSON.stringify(v), key = speechBatchJournalKey(v.projectId, v.episodeId);
  decodePending(raw, v.projectId, v.episodeId);
  if (before && JSON.stringify(before) !== raw) throw new Error("原批次请求尚未确认，不能替换为新请求。");
  sessionStorage.setItem(key, raw); if (sessionStorage.getItem(key) !== raw) throw new Error("无法保留原批次请求，尚未发送。");
}
export function clearSpeechBatchPending(v: SpeechBatchPending): boolean {
  if (JSON.stringify(readSpeechBatchPending(v.projectId, v.episodeId)) !== JSON.stringify(v)) return false;
  const key = speechBatchJournalKey(v.projectId, v.episodeId); sessionStorage.removeItem(key); return sessionStorage.getItem(key) === null;
}
export function readSpeechBatchStop(p: string, e: string): SpeechBatchPending | null {
  const value = decodePending(sessionStorage.getItem(speechBatchJournalKey(p, e) + ":stop"), p, e);
  if (value && value.kind !== "cancel") throw new Error("原停止请求记录无法核对。");
  return value;
}
export function rememberSpeechBatchStop(v: SpeechBatchPending): void {
  if (v.kind !== "cancel") throw new Error("停止请求类型不符。");
  const before = readSpeechBatchStop(v.projectId, v.episodeId), raw = JSON.stringify(v), key = speechBatchJournalKey(v.projectId, v.episodeId) + ":stop";
  decodePending(raw, v.projectId, v.episodeId);
  if (before && JSON.stringify(before) !== raw) throw new Error("原停止请求尚未确认，请先核查。");
  sessionStorage.setItem(key, raw); if (sessionStorage.getItem(key) !== raw) throw new Error("无法保留原停止请求，尚未发送。");
}
export function clearSpeechBatchStop(v: SpeechBatchPending): boolean {
  if (JSON.stringify(readSpeechBatchStop(v.projectId, v.episodeId)) !== JSON.stringify(v)) return false;
  const key = speechBatchJournalKey(v.projectId, v.episodeId) + ":stop"; sessionStorage.removeItem(key); return sessionStorage.getItem(key) === null;
}
