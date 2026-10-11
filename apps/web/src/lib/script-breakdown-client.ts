import type {
  ScriptBreakdownOptionsView,
  ScriptBreakdownPlacementOutcome,
  ScriptBreakdownRunView,
  TitleWritingProviderKey,
} from "@ai-drama/contracts";
import { withSession } from "./site-session";
import { TitleWritingError, TitleWritingUnconfirmedError, isEntityId } from "./title-writing-client";

export type { ScriptBreakdownOptionsView, ScriptBreakdownPlacementOutcome, ScriptBreakdownRunView };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The run in a receipt, only when it names a breakdown of exactly this work and episode. */
export function breakdownReceiptRun(body: unknown, projectId: string, episodeId: string): ScriptBreakdownRunView | null {
  if (!body || typeof body !== "object") return null;
  const run = (body as { run?: unknown }).run;
  if (!run || typeof run !== "object") return null;
  const view = run as Partial<ScriptBreakdownRunView>;
  return isEntityId(view.runId) && view.projectId === projectId && view.episodeId === episodeId ? run as ScriptBreakdownRunView : null;
}

/** Options only when the body has the shape the page reads; anything else is treated as not loaded. */
export function optionsOf(body: unknown): ScriptBreakdownOptionsView | null {
  if (!body || typeof body !== "object") return null;
  const view = body as Partial<ScriptBreakdownOptionsView>;
  return typeof view.code === "string" && typeof view.callCapPerRun === "number" && typeof view.maxCallsPerDay === "number"
    && Boolean(view.limits && typeof view.limits === "object") ? body as ScriptBreakdownOptionsView : null;
}

export interface BreakdownStartBody {
  providerKey?: TitleWritingProviderKey;
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
        "X-Operator-Token": options.token },
      body: JSON.stringify(body),
    });
    const run = breakdownReceiptRun(result.body, projectId, episodeId);
    if (!run) throw new TitleWritingUnconfirmedError(result.status);
    return run;
  }

  /** The episode's latest breakdown; null when there is none or the body does not name a breakdown of this episode. */
  async latest(projectId: string, episodeId: string, signal?: AbortSignal): Promise<ScriptBreakdownRunView | null> {
    const result = await this.call<unknown>(`${this.base(projectId, episodeId)}/latest`,
      { method: "GET", headers: { Accept: "application/json" }, ...(signal ? { signal } : {}) });
    return breakdownReceiptRun(result.body, projectId, episodeId);
  }

  async cancel(projectId: string, episodeId: string, runId: string): Promise<ScriptBreakdownRunView> {
    const result = await this.call<unknown>(`${this.base(projectId, episodeId)}/${runId}/cancel`, { method: "POST", headers: { Accept: "application/json" } });
    const run = breakdownReceiptRun(result.body, projectId, episodeId);
    if (!run) throw new TitleWritingUnconfirmedError(result.status);
    return run;
  }

  async resume(projectId: string, episodeId: string, runId: string,
    options: { confirmUncertainCallIds: readonly string[]; token: string; idempotencyKey: string }): Promise<ScriptBreakdownRunView> {
    const result = await this.call<unknown>(`${this.base(projectId, episodeId)}/${runId}/resume`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-Operator-Token": options.token,
        "Idempotency-Key": options.idempotencyKey },
      body: JSON.stringify({ confirmUncertainCallIds: options.confirmUncertainCallIds }),
    });
    const run = breakdownReceiptRun(result.body, projectId, episodeId);
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
    const run = breakdownReceiptRun(result.body, projectId, episodeId);
    const placement = (result.body as { placement?: unknown } | null)?.placement;
    if (!run || !placement || typeof placement !== "object") throw new TitleWritingUnconfirmedError(result.status);
    return { run, placement: placement as ScriptBreakdownPlacementOutcome };
  }
}
