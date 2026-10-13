/** Browser client for the server-side web Qwen writing route. The provider key never reaches the browser. */
import { withSession } from "./site-session";

export interface QwenWebStatus {
  code: string;
  ready: boolean;
  model: string | null;
  retentionDays: number | null;
}

export interface QwenWebRequestView {
  requestId: string;
  projectId: string;
  mode: "story" | "episode";
  episodeNo: 1 | 2 | 3 | null;
  state: "reserved" | "submitted" | "completed" | "rejected" | "unknown";
  errorCode: string | null;
  providerResult: "completed" | "unknown" | null;
  candidateJson: string | null;
  candidateExpiresAt: string | null;
  candidateExpired: boolean;
  billingStatus: "unknown";
}

export type QwenWebOutcome =
  | { ok: true; httpStatus: number; requestCount: number; request: QwenWebRequestView }
  | { ok: false; httpStatus: number; code: string };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface QwenWebClient {
  status(token: string): Promise<QwenWebStatus>;
  request(projectId: string, input: unknown, idempotencyKey: string, token: string): Promise<QwenWebOutcome>;
  get(projectId: string, requestId: string, token: string): Promise<QwenWebOutcome>;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function codeOf(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const record = body as { code?: unknown; error?: { code?: unknown } };
    if (typeof record.code === "string") return record.code;
    if (record.error && typeof record.error.code === "string") return record.error.code;
  }
  return `HTTP_${status}`;
}

/** Statuses that carry this key's own request: 200 settled or pending, 422 rejected, 502 unknown. */
const REQUEST_STATUSES = new Set([200, 422, 502]);

function outcome(response: Response, body: unknown): QwenWebOutcome {
  const record = body as { request?: QwenWebRequestView; requestCount?: unknown } | null;
  // A 409 for a reused key also returns the other request; that record must never be treated as this answer.
  if (REQUEST_STATUSES.has(response.status) && record && record.request && typeof record.request.requestId === "string") {
    return {
      ok: true,
      httpStatus: response.status,
      requestCount: typeof record.requestCount === "number" ? record.requestCount : 0,
      request: record.request,
    };
  }
  return { ok: false, httpStatus: response.status, code: codeOf(body, response.status) };
}

export function createQwenWebClient(fetchImpl?: FetchLike, prefix = "/api/v1"): QwenWebClient {
  const send: FetchLike = (input, init) => withSession(fetchImpl ?? globalThis.fetch.bind(globalThis))(input, { ...init, cache: "no-store" });
  return {
    async status(token) {
      const response = await send(`${prefix}/writing/qwen-candidates/status`, {
        method: "GET", headers: { Accept: "application/json", "X-Operator-Token": token },
      });
      const body = await readJson(response) as { ready?: unknown; model?: unknown; retentionDays?: unknown } | null;
      return {
        code: codeOf(body, response.status),
        ready: response.status === 200 && body?.ready === true,
        model: typeof body?.model === "string" ? body.model : null,
        retentionDays: typeof body?.retentionDays === "number" ? body.retentionDays : null,
      };
    },
    async request(projectId, input, idempotencyKey, token) {
      const response = await send(`${prefix}/projects/${encodeURIComponent(projectId)}/writing/qwen-candidates`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey, "X-Operator-Token": token },
        body: JSON.stringify({ input }),
      });
      return outcome(response, await readJson(response));
    },
    async get(projectId, requestId, token) {
      const response = await send(
        `${prefix}/projects/${encodeURIComponent(projectId)}/writing/qwen-candidates/${encodeURIComponent(requestId)}`,
        { method: "GET", headers: { Accept: "application/json", "X-Operator-Token": token } },
      );
      return outcome(response, await readJson(response));
    },
  };
}
