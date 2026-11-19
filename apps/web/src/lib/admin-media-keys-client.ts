import type { AdminMediaKeyUpdate, AdminMediaKeysView } from "@ai-drama/contracts";
import { withSession } from "./site-session";
import { AdminApiError } from "./admin-models-client";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Media-key console client. Same site session / CSRF path as writing-model admin.
 * Response bodies are never treated as secret carriers; only status codes and codes matter.
 */
export function createAdminMediaKeysClient(fetchImpl?: FetchLike) {
  const send = withSession(fetchImpl ?? globalThis.fetch.bind(globalThis));
  async function request<T>(path: string, method: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await send(`/api/v1/admin${path}`, {
        method,
        cache: "no-store",
        headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new AdminApiError(0, "NETWORK_ERROR");
    }
    let payload: unknown = null;
    if (response.status !== 204) {
      try {
        payload = await response.json();
      } catch {
        /* A broken receipt is not success. */
      }
    }
    if (!response.ok) {
      const value = payload as { error?: { code?: unknown } } | null;
      const code = value?.error?.code;
      throw new AdminApiError(
        response.status,
        typeof code === "string" && /^[A-Z0-9_]{1,100}$/.test(code) ? code : "REQUEST_FAILED",
      );
    }
    if (response.status !== 204 && (!payload || typeof payload !== "object")) throw new AdminApiError(0, "INVALID_RESPONSE");
    return payload as T;
  }
  return {
    view: () => request<AdminMediaKeysView>("/media-keys", "GET"),
    update: (body: AdminMediaKeyUpdate) => request<AdminMediaKeysView>("/media-keys", "PUT", body),
  };
}

export { AdminApiError };
