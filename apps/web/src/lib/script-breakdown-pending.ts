import type { BreakdownStartBody } from "./script-breakdown-client";
import { isEntityId } from "./title-writing-client";

export interface BreakdownPendingStart { kind: "start"; key: string; body: BreakdownStartBody }
export interface BreakdownPendingResume { kind: "resume"; key: string; runId: string; confirmed: string[] }
export type BreakdownPending = BreakdownPendingStart | BreakdownPendingResume;
const storageKey = (projectId: string, episodeId: string, kind: BreakdownPending["kind"]) => `ads:breakdown:${projectId}:${episodeId}:${kind}:v1`;

/** Only request identity/body are persisted. Never a token, script text or model key. */
export function readBreakdownPending(projectId: string, episodeId: string, kind: "start"): BreakdownPendingStart | null;
export function readBreakdownPending(projectId: string, episodeId: string, kind: "resume"): BreakdownPendingResume | null;
export function readBreakdownPending(projectId: string, episodeId: string, kind: BreakdownPending["kind"]): BreakdownPending | null {
  const raw = window.sessionStorage.getItem(storageKey(projectId, episodeId, kind));
  if (!raw) return null;
  const value = JSON.parse(raw) as Partial<BreakdownPending>;
  if (value.kind !== kind || !isEntityId(value.key)) throw new Error("Invalid pending request");
  if (value.kind === "start" && value.body && typeof value.body.replaceExisting === "boolean"
    && ["qwen", "openai", "deepseek"].includes(value.body.providerKey ?? "") && typeof value.body.model === "string") return value as BreakdownPendingStart;
  if (value.kind === "resume" && isEntityId(value.runId) && Array.isArray(value.confirmed) && value.confirmed.every(isEntityId)) return value as BreakdownPendingResume;
  throw new Error("Invalid pending request");
}

/** Failing persistence blocks the paid action: an uncertain request must survive refresh/navigation. */
export function writeBreakdownPending(projectId: string, episodeId: string, pending: BreakdownPending): void {
  window.sessionStorage.setItem(storageKey(projectId, episodeId, pending.kind), JSON.stringify(pending));
}

/** A late receipt cannot remove a newer action's identity. */
export function clearBreakdownPending(projectId: string, episodeId: string, pending: BreakdownPending): void {
  const current = pending.kind === "start" ? readBreakdownPending(projectId, episodeId, "start") : readBreakdownPending(projectId, episodeId, "resume");
  if (current?.key === pending.key) window.sessionStorage.removeItem(storageKey(projectId, episodeId, pending.kind));
}
