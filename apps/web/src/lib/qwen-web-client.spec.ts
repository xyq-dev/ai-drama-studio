import { describe, expect, it } from "vitest";
import { createQwenWebClient } from "./qwen-web-client";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("qwen web client", () => {
  it("sends the operator token and idempotency key, never a provider key, and parses both error shapes", async () => {
    const seen: Array<{ url: string; headers: Headers; body: string | null; cache: RequestCache | undefined }> = [];
    const responses = [
      json({ code: "QWEN_WEB_STORAGE_UNAVAILABLE", ready: false, model: null, retentionDays: 7 }, 503),
      json({ code: "completed", requestCount: 1, request: { requestId: "r1", state: "completed", billingStatus: "unknown" } }),
      json({ error: { code: "NOT_FOUND", message: "missing" } }, 404),
    ];
    const client = createQwenWebClient(async (url, init) => {
      seen.push({ url, headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : null,
        cache: init?.cache });
      return responses.shift()!;
    });
    expect(await client.status("token-1")).toEqual({ code: "QWEN_WEB_STORAGE_UNAVAILABLE", ready: false, model: null,
      retentionDays: 7 });
    const sent = await client.request("project-1", { schema: "qwen.writing.input.v1" }, "key-1", "token-1");
    expect(sent).toMatchObject({ ok: true, requestCount: 1, request: { requestId: "r1" } });
    expect(await client.get("project-1", "r1", "token-1")).toEqual({ ok: false, httpStatus: 404, code: "NOT_FOUND" });
    expect(seen.map((item) => item.url)).toEqual([
      "/api/v1/writing/qwen-candidates/status",
      "/api/v1/projects/project-1/writing/qwen-candidates",
      "/api/v1/projects/project-1/writing/qwen-candidates/r1",
    ]);
    expect(seen[1]?.headers.get("Idempotency-Key")).toBe("key-1");
    expect(seen.every((item) => item.headers.get("X-Operator-Token") === "token-1")).toBe(true);
    expect(seen.every((item) => item.cache === "no-store")).toBe(true);
    expect(JSON.parse(seen[1]?.body ?? "{}")).toEqual({ input: { schema: "qwen.writing.input.v1" } });
    expect(seen.some((item) => [...item.headers.keys()].some((name) => name.toLowerCase() === "authorization"))).toBe(false);
  });
});
