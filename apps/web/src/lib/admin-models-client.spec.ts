// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminApiError, createAdminModelsClient } from "./admin-models-client";

const CSRF = "c".repeat(43);

afterEach(() => { document.cookie = "ads_csrf=; Max-Age=0; Path=/"; vi.restoreAllMocks(); });

describe("administrator browser transport (site login)", () => {
  it("has no token login: the console only reads and writes settings", () => {
    const client = createAdminModelsClient(vi.fn()) as Record<string, unknown>;
    expect(Object.keys(client).sort()).toEqual(["limits", "models", "provider"]);
  });
  it("sends the site session CSRF token only in the mutation header and does not request provider APIs", async () => {
    document.cookie = `ads_csrf=${CSRF}; Path=/`;
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => new Response("{}"));
    await createAdminModelsClient(fetch).provider("qwen", { expectedRevision: 4, models: ["account-model"], secretAction: "keep" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/api/v1/admin/models/providers/qwen");
    expect(init).toMatchObject({ method: "PUT", cache: "no-store" });
    const headers = new Headers(init!.headers);
    expect(headers.get("X-CSRF-Token")).toBe(CSRF);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.has("X-Admin-CSRF")).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not add a CSRF header to reads", async () => {
    document.cookie = `ads_csrf=${CSRF}; Path=/`;
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => new Response("{}"));
    await createAdminModelsClient(fetch).models();
    expect(new Headers(fetch.mock.calls[0]![1]!.headers).has("X-CSRF-Token")).toBe(false);
  });
  it("does not accept malformed successful receipts", async () => {
    const client = createAdminModelsClient(async () => new Response("not json", { status: 200 }));
    await expect(client.models()).rejects.toMatchObject({ status: 0, code: "INVALID_RESPONSE" });
  });
  it("never includes a reflected server message in errors and never retries writes", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: "ADMIN_CONFIG_CONFLICT", message: "leaked-provider-secret" } }), { status: 409 }));
    const caught = await createAdminModelsClient(fetch).limits({ expectedRevision: 0, defaultProvider: null, maxCallsPerDay: 1, maxActiveRuns: 1 }).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(AdminApiError);
    expect(caught).toMatchObject({ status: 409, code: "ADMIN_CONFIG_CONFLICT" });
    expect(String(caught)).not.toContain("leaked-provider-secret");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
