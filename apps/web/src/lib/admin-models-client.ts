import type {
  AdminLimitsUpdate, AdminModelsView, AdminProviderUpdate, TitleWritingProviderKey,
} from "@ai-drama/contracts";
import { withSession } from "./site-session";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class AdminApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    // Response messages are intentionally not rendered: provider secrets must never be reflected.
    super("Administrator request failed");
  }
}

/**
 * The model console's API. Signing in and out is the site login (lib/site-session.ts); writes carry the site session's
 * CSRF token through withSession. There is no administrator token any more.
 */
export function createAdminModelsClient(fetchImpl?: FetchLike) {
  const send = withSession(fetchImpl ?? globalThis.fetch.bind(globalThis));
  async function request<T>(path: string, method: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await send(`/api/v1/admin${path}`, {
        method, cache: "no-store",
        headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new AdminApiError(0, "NETWORK_ERROR"); }
    let payload: unknown = null;
    if (response.status !== 204) {
      try { payload = await response.json(); } catch { /* A broken receipt is not success. */ }
    }
    if (!response.ok) {
      const value = payload as { error?: { code?: unknown } } | null;
      const code = value?.error?.code;
      throw new AdminApiError(response.status, typeof code === "string" && /^[A-Z0-9_]{1,100}$/.test(code) ? code : "REQUEST_FAILED");
    }
    if (response.status !== 204 && (!payload || typeof payload !== "object")) throw new AdminApiError(0, "INVALID_RESPONSE");
    return payload as T;
  }
  return {
    models: () => request<AdminModelsView>("/models", "GET"),
    provider: (key: TitleWritingProviderKey, update: AdminProviderUpdate) =>
      request<AdminModelsView>(`/models/providers/${key}`, "PUT", update),
    limits: (update: AdminLimitsUpdate) => request<AdminModelsView>("/models/limits", "PUT", update),
  };
}
