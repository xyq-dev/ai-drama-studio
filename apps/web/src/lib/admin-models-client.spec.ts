import { describe, expect, it, vi } from "vitest";
import { AdminApiError, createAdminModelsClient } from "./admin-models-client";

describe("administrator browser transport", () => {
  it("uses same-origin uncached cookies and keeps the login token in the POST body", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ authenticated: true, csrfToken: "csrf", expiresAt: "2099-01-01" })));
    await createAdminModelsClient(fetch).login("private-admin-token");
    expect(fetch).toHaveBeenCalledWith("/api/v1/admin/session", expect.objectContaining({
      method: "POST", credentials: "same-origin", cache: "no-store", body: '{"token":"private-admin-token"}',
    }));
  });
  it("sends CSRF only in the mutation header and does not request provider APIs", async () => {
    const fetch = vi.fn(async () => new Response("{}"));
    await createAdminModelsClient(fetch).provider("qwen", { expectedRevision: 4, models: ["account-model"], secretAction: "keep" }, "csrf-secret");
    expect(fetch).toHaveBeenCalledWith("/api/v1/admin/models/providers/qwen", expect.objectContaining({
      method: "PUT", headers: expect.objectContaining({ "X-Admin-CSRF": "csrf-secret", "Content-Type": "application/json" }),
    }));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not accept malformed successful receipts", async () => {
    const client = createAdminModelsClient(async () => new Response("not json", { status: 200 }));
    await expect(client.models()).rejects.toMatchObject({ status: 0, code: "INVALID_RESPONSE" });
  });
  it("never includes a reflected server message in errors and never retries writes", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: "ADMIN_CONFIG_CONFLICT", message: "leaked-provider-secret" } }), { status: 409 }));
    const caught = await createAdminModelsClient(fetch).limits({ expectedRevision: 0, defaultProvider: null, maxCallsPerDay: 1, maxActiveRuns: 1 }, "csrf").catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(AdminApiError);
    expect(caught).toMatchObject({ status: 409, code: "ADMIN_CONFIG_CONFLICT" });
    expect(String(caught)).not.toContain("leaked-provider-secret");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("accepts an empty logout response", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(createAdminModelsClient(fetch).logout("csrf")).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledWith("/api/v1/admin/session", expect.objectContaining({ method: "DELETE", headers: expect.objectContaining({ "X-Admin-CSRF": "csrf" }) }));
  });
});
