import type {
  AdminLimitsUpdate, AdminModelsView, AdminProviderUpdate, AdminSessionView, TitleWritingProviderKey,
} from "@ai-drama/contracts";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class AdminApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    // Response messages are intentionally not rendered: provider secrets must never be reflected.
    super("Administrator request failed");
  }
}

export function createAdminModelsClient(fetchImpl?: FetchLike) {
  async function request<T>(path: string, method: string, body?: unknown, csrfToken?: string): Promise<T> {
    let response: Response;
    try {
      response = await (fetchImpl ?? globalThis.fetch)(`/api/v1/admin${path}`, {
        method, credentials: "same-origin", cache: "no-store",
        headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(csrfToken ? { "X-Admin-CSRF": csrfToken } : {}) },
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
    session: () => request<AdminSessionView>("/session", "GET"),
    login: (token: string) => request<AdminSessionView>("/session", "POST", { token }),
    logout: (csrf: string) => request<void>("/session", "DELETE", undefined, csrf),
    models: () => request<AdminModelsView>("/models", "GET"),
    provider: (key: TitleWritingProviderKey, update: AdminProviderUpdate, csrf: string) =>
      request<AdminModelsView>(`/models/providers/${key}`, "PUT", update, csrf),
    limits: (update: AdminLimitsUpdate, csrf: string) => request<AdminModelsView>("/models/limits", "PUT", update, csrf),
  };
}
