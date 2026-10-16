import {
  TITLE_WRITING_PROVIDER_KEYS,
  type TitleWritingStoredProviderKey,
  scriptBreakdownOutputSchema,
  type ScriptBreakdownOutput,
  type ScriptBreakdownOptionsView,
  type ScriptBreakdownPlacementOutcome,
  type ScriptBreakdownRunView,
} from "@ai-drama/contracts";
import { withSession } from "./site-session";
import { TitleWritingError, TitleWritingUnconfirmedError, isEntityId, operatorHeader } from "./title-writing-client";

export type { ScriptBreakdownOptionsView, ScriptBreakdownPlacementOutcome, ScriptBreakdownRunView };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const nullableString = (value: unknown) => value === null || typeof value === "string";
const nullableNumber = (value: unknown) => value === null || typeof value === "number";

/** A receipt must identify this scope and contain the snapshot the panel actually renders. */
export function breakdownReceiptRun(body: unknown, projectId: string, episodeId: string, runId?: string): ScriptBreakdownRunView | null {
  if (!record(body) || !record(body.run)) return null;
  const view = body.run;
  if (!isEntityId(view.runId) || view.projectId !== projectId || view.episodeId !== episodeId || (runId && view.runId !== runId)) return null;
  if (!record(view.step) || !record(view.episodeScript) || !Array.isArray(view.scenes) || !Array.isArray(view.characters) || !Array.isArray(view.calls)) return null;
  if (typeof view.state !== "string" || !["running", "completed", "partial", "needs_attention", "canceled", "failed"].includes(view.state)
    || typeof view.model !== "string" || !isEntityId(view.scriptRevisionId) || typeof view.scriptRevisionNo !== "number"
    || typeof view.episodeNo !== "number" || typeof view.callsUsed !== "number" || typeof view.callCap !== "number"
    || typeof view.cancelRequested !== "boolean" || typeof view.save !== "string" || !["pending", "saved", "source_changed", "conflict"].includes(view.save) || !nullableString(view.errorCode)
    || !nullableNumber(view.plannedTotalSeconds) || !nullableNumber(view.targetEpisodeSeconds)
    || typeof view.step.state !== "string" || typeof view.step.attemptNo !== "number" || !nullableString(view.step.errorCode)
    || !nullableString(view.episodeScript.currentRevisionId) || !nullableNumber(view.episodeScript.currentRevisionNo) || typeof view.episodeScript.approved !== "boolean") return null;
  if (!view.characters.every((item) => record(item) && typeof item.key === "string" && typeof item.name === "string")) return null;
  if (!view.calls.every((item) => record(item) && typeof item.callId === "string" && typeof item.stepKey === "string"
    && typeof item.attemptNo === "number" && typeof item.state === "string")) return null;
  if (!view.scenes.every((item) => record(item) && typeof item.key === "string" && isEntityId(item.sceneId)
    && isEntityId(item.sceneRevisionId) && ["pending", "saved"].includes(String(item.shotSave)) && record(item.current)
    && typeof item.current.archived === "boolean" && nullableString(item.current.currentRevisionId)
    && nullableString(item.current.reviewStatus) && nullableString(item.current.freshnessStatus))) return null;
  let output: ScriptBreakdownOutput | null = null;
  if (view.output !== null) {
    const parsed = scriptBreakdownOutputSchema.safeParse(view.output);
    if (!parsed.success || parsed.data.episodeNo !== view.episodeNo) return null;
    output = parsed.data;
  }
  return { ...view, output } as unknown as ScriptBreakdownRunView;
}

/** Options only when the body has the shape the page reads; anything else is treated as not loaded. */
export function optionsOf(body: unknown): ScriptBreakdownOptionsView | null {
  if (!record(body) || !record(body.limits) || !Array.isArray(body.providers)) return null;
  if (typeof body.code !== "string" || typeof body.callCapPerRun !== "number" || typeof body.maxCallsPerDay !== "number") return null;
  if (!["scriptMaxChars", "minScenes", "maxScenes", "minShots", "maxShots", "maxShotsPerScene", "minShotSeconds", "maxShotSeconds", "minTotalSeconds", "maxTotalSeconds", "maxCharacters"]
    .every((key) => typeof (body.limits as Record<string, unknown>)[key] === "number")) return null;
  if (!body.providers.every((item) => record(item) && typeof item.providerKey === "string" && (TITLE_WRITING_PROVIDER_KEYS as readonly string[]).includes(item.providerKey)
    && typeof item.ready === "boolean" && Array.isArray(item.models) && item.models.every((model) => typeof model === "string")
    && nullableString(item.defaultModel))) return null;
  return body as unknown as ScriptBreakdownOptionsView;
}

export interface BreakdownStartBody {
  providerKey?: TitleWritingStoredProviderKey;
  model?: string;
  replaceExisting: boolean;
}

/**
 * Browser side of script breakdown: it only starts, reads, asks to stop or resume, and asks to write approved scenes'
 * shots. The operator token lives in page memory and goes only in the X-Operator-Token header of start and resume.
 */
export class ScriptBreakdownClient {
  constructor(private readonly fetchImpl?: FetchLike, private readonly prefix = "/api/v1") {}

  private async call<T>(path: string, init: RequestInit): Promise<{ status: number; body: T }> {
    const response = await withSession(this.fetchImpl ?? globalThis.fetch.bind(globalThis))(`${this.prefix}${path}`, init);
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text.length === 0 ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const error = parsed && typeof parsed === "object" && "error" in parsed
        ? (parsed as { error?: { code?: string; message?: string; details?: Record<string, unknown> } }).error
        : undefined;
      throw new TitleWritingError(response.status, error?.code ?? "REQUEST_FAILED", error?.message ?? `HTTP ${response.status}`, error?.details ?? null);
    }
    return { status: response.status, body: parsed as T };
  }

  private base(projectId: string, episodeId: string): string {
    return `/projects/${projectId}/episodes/${episodeId}/script-breakdowns`;
  }

  async options(): Promise<ScriptBreakdownOptionsView> {
    const result = await this.call<unknown>("/writing/script-breakdowns/options", { method: "GET", headers: { Accept: "application/json" } });
    const view = optionsOf(result.body);
    if (!view) throw new TitleWritingUnconfirmedError(result.status);
    return view;
  }

  /** Resolves only with a receipt naming a breakdown of this episode; any other success body throws TitleWritingUnconfirmedError. */
  async start(projectId: string, episodeId: string, body: BreakdownStartBody, options: { token: string; idempotencyKey: string }): Promise<ScriptBreakdownRunView> {
    const result = await this.call<unknown>(this.base(projectId, episodeId), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": options.idempotencyKey,
        ...operatorHeader(options.token) },
      body: JSON.stringify(body),
    });
    const run = breakdownReceiptRun(result.body, projectId, episodeId);
    if (!run) throw new TitleWritingUnconfirmedError(result.status);
    return run;
  }

  /** Null only for an explicit empty result. An unreadable/foreign snapshot is not evidence of no task. */
  async latest(projectId: string, episodeId: string, signal?: AbortSignal): Promise<ScriptBreakdownRunView | null> {
    const result = await this.call<unknown>(`${this.base(projectId, episodeId)}/latest`,
      { method: "GET", headers: { Accept: "application/json" }, ...(signal ? { signal } : {}) });
    if (record(result.body) && result.body.run === null) return null;
    const run = breakdownReceiptRun(result.body, projectId, episodeId);
    if (!run) throw new TitleWritingUnconfirmedError(result.status);
    return run;
  }

  /**
   * The newest saved breakdown of this episode (it may be older than latest), or null only for an explicit empty result.
   * Anything that is not a saved run of this episode is not evidence of none.
   */
  async latestSaved(projectId: string, episodeId: string): Promise<ScriptBreakdownRunView | null> {
    const result = await this.call<unknown>(`${this.base(projectId, episodeId)}/latest-saved`, { method: "GET", headers: { Accept: "application/json" } });
    if (record(result.body) && result.body.run === null) return null;
    const run = breakdownReceiptRun(result.body, projectId, episodeId);
    if (!run || run.save !== "saved") throw new TitleWritingUnconfirmedError(result.status);
    return run;
  }

  async cancel(projectId: string, episodeId: string, runId: string): Promise<ScriptBreakdownRunView> {
    const result = await this.call<unknown>(`${this.base(projectId, episodeId)}/${runId}/cancel`, { method: "POST", headers: { Accept: "application/json" } });
    const run = breakdownReceiptRun(result.body, projectId, episodeId, runId);
    if (!run) throw new TitleWritingUnconfirmedError(result.status);
    return run;
  }

  async resume(projectId: string, episodeId: string, runId: string,
    options: { confirmUncertainCallIds: readonly string[]; token: string; idempotencyKey: string }): Promise<ScriptBreakdownRunView> {
    const result = await this.call<unknown>(`${this.base(projectId, episodeId)}/${runId}/resume`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", ...operatorHeader(options.token),
        "Idempotency-Key": options.idempotencyKey },
      body: JSON.stringify({ confirmUncertainCallIds: options.confirmUncertainCallIds }),
    });
    const run = breakdownReceiptRun(result.body, projectId, episodeId, runId);
    if (!run) throw new TitleWritingUnconfirmedError(result.status);
    return run;
  }

  async placeShots(projectId: string, episodeId: string, runId: string, acceptSceneChanged: boolean):
    Promise<{ run: ScriptBreakdownRunView; placement: ScriptBreakdownPlacementOutcome }> {
    const result = await this.call<unknown>(`${this.base(projectId, episodeId)}/${runId}/shots`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ acceptSceneChanged }),
    });
    const run = breakdownReceiptRun(result.body, projectId, episodeId, runId);
    const placement = (result.body as { placement?: unknown } | null)?.placement;
    if (!run || !record(placement) || !["placed", "awaitingApproval", "sceneChanged", "charactersChanged", "unavailable"].every((key) => Array.isArray(placement[key]) && placement[key].every((item: unknown) => typeof item === "string"))) throw new TitleWritingUnconfirmedError(result.status);
    return { run, placement: placement as unknown as ScriptBreakdownPlacementOutcome };
  }
}
