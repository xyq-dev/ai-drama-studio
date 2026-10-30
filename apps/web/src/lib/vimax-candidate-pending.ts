import {
  VIMAX_PLATFORM_PREVIEW_MAX_BYTES, vimaxCandidateCreateSchema, vimaxCandidatePlaceShotsSchema, vimaxCandidateSaveSceneSchema,
  type VimaxCandidateCreate, type VimaxCandidatePlaceShots, type VimaxCandidateSaveScene,
} from "@ai-drama/contracts";
import { isEntityId } from "./title-writing-client";

export type VimaxCandidatePending =
  | { kind: "create"; key: string; body: VimaxCandidateCreate }
  | { kind: "save_scene"; key: string; candidateId: string; body: VimaxCandidateSaveScene }
  | { kind: "place_shots"; key: string; candidateId: string; body: VimaxCandidatePlaceShots };
const storageKey = (projectId: string, episodeId: string) => `ads:vimax-candidate:${projectId}:${episodeId}:v1`;

function checked(value: unknown): VimaxCandidatePending {
  const fail = () => new Error("无法读取原保存请求；请保留该标签页并重新核对候选。");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  const item = value as Record<string, unknown>;
  if (!isEntityId(item.key)) throw fail();
  const keys = Object.keys(item);
  if (item.kind === "create") {
    const body = vimaxCandidateCreateSchema.safeParse(item.body);
    if (!body.success || keys.length !== 3 || keys.some((key) => !["kind", "key", "body"].includes(key))
      || new TextEncoder().encode(JSON.stringify(body.data)).byteLength > VIMAX_PLATFORM_PREVIEW_MAX_BYTES) throw fail();
    return { kind: "create", key: item.key, body: body.data };
  }
  if (!isEntityId(item.candidateId) || keys.length !== 4 || keys.some((key) => !["kind", "key", "candidateId", "body"].includes(key))) throw fail();
  if (item.kind === "save_scene") {
    const body = vimaxCandidateSaveSceneSchema.safeParse(item.body);
    if (body.success) return { kind: "save_scene", key: item.key, candidateId: item.candidateId, body: body.data };
  }
  if (item.kind === "place_shots") {
    const body = vimaxCandidatePlaceShotsSchema.safeParse(item.body);
    if (body.success) return { kind: "place_shots", key: item.key, candidateId: item.candidateId, body: body.data };
  }
  throw fail();
}

/** Only the unconfirmed creative request is retained in this tab; never a login token or model credential. */
export function readVimaxCandidatePending(projectId: string, episodeId: string): VimaxCandidatePending | null {
  const raw = window.sessionStorage.getItem(storageKey(projectId, episodeId));
  if (raw === null) return null;
  if (new TextEncoder().encode(raw).byteLength > VIMAX_PLATFORM_PREVIEW_MAX_BYTES + 1000) throw new Error("原保存请求超过恢复范围。");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("无法读取原保存请求，请保留该标签页并重新核对候选。"); }
  return checked(value);
}

/** Persistence and its readback must both succeed before a mutation may be sent. */
export function writeVimaxCandidatePending(projectId: string, episodeId: string, pending: VimaxCandidatePending): void {
  const value = checked(pending);
  const previous = readVimaxCandidatePending(projectId, episodeId);
  if (previous && JSON.stringify(previous) !== JSON.stringify(value)) throw new Error("仍有未确认的原保存请求，请先确认其结果。");
  window.sessionStorage.setItem(storageKey(projectId, episodeId), JSON.stringify(value));
  const stored = readVimaxCandidatePending(projectId, episodeId);
  if (!stored || JSON.stringify(stored) !== JSON.stringify(value)) throw new Error("无法保留原保存请求，尚未发送。");
}

/** A late receipt is only allowed to clear the complete identity and original body that produced it. */
export function clearVimaxCandidatePending(projectId: string, episodeId: string, pending: VimaxCandidatePending): void {
  const current = readVimaxCandidatePending(projectId, episodeId);
  if (current && JSON.stringify(current) === JSON.stringify(checked(pending))) window.sessionStorage.removeItem(storageKey(projectId, episodeId));
}
