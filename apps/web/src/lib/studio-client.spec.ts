import { describe, expect, it } from "vitest";
import { ApiError, StudioClient } from "./studio-client";
import { clearDraft, draftStorageKey, readDraft, writeDraft, type DraftRecord, type JsonStorage } from "./studio-model";

function memory(): JsonStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

describe("StudioClient", () => {
  it("sends idempotency and aggregate version headers without a client workspace", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new StudioClient(async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "project" }), { status: 201 });
    });
    await client.write({
      path: "/projects",
      body: { title: "标题", premise: "梗概", workspaceId: "client" },
      idempotencyKey: "same-key",
    });
    await client.write({
      path: "/projects/p/stories",
      body: { content: { text: "正文" } },
      idempotencyKey: "same-key",
      ifMatch: 4,
    });
    const first = calls[0]?.init;
    const second = calls[1]?.init;
    expect(JSON.parse(String(first?.body))).toEqual({ title: "标题", premise: "梗概" });
    expect(new Headers(first?.headers).get("Idempotency-Key")).toBe("same-key");
    expect(new Headers(first?.headers).has("If-Match")).toBe(false);
    expect(new Headers(second?.headers).get("If-Match")).toBe("4");
    expect(new Headers(second?.headers).get("Idempotency-Key")).toBe("same-key");
  });

  it("keeps the stored draft when the server returns 409", async () => {
    const storage = memory();
    const key = draftStorageKey("p", "story", "base");
    const draft: DraftRecord = {
      fingerprint: "fp",
      idempotencyKey: "key-1",
      ifMatch: 3,
      payload: { content: { text: "未提交", keep: true } },
    };
    writeDraft(storage, key, draft);
    const client = new StudioClient(async () => new Response(JSON.stringify({
      error: { code: "REVISION_CONFLICT", message: "version mismatch" },
    }), { status: 409 }));
    await expect(client.write({
      path: "/projects/p/stories",
      body: draft.payload,
      idempotencyKey: draft.idempotencyKey,
      ifMatch: 3,
    })).rejects.toMatchObject({ status: 409, code: "REVISION_CONFLICT" });
    expect(readDraft(storage, key)).toEqual(draft);
    clearDraft(storage, key);
    expect(readDraft(storage, key)).toBeNull();
  });

  it("does not treat an error payload as success", async () => {
    const client = new StudioClient(async () => new Response("{}", { status: 500 }));
    await expect(client.get("/projects")).rejects.toBeInstanceOf(ApiError);
  });
});
