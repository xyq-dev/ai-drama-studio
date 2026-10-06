// @vitest-environment happy-dom
// Simulated interface tests. fetch is mocked; this file does not start a browser or a backend.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CharacterReferencePanel } from "./character-reference-panel";

const CHARACTER = "11111111-1111-4111-8111-111111111111";
const CURRENT = "22222222-2222-4222-8222-222222222222";
const OLD = "33333333-3333-4333-8333-333333333333";
const HASH = "ab".repeat(32);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function json(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

function asset(id: string, overrides: Record<string, unknown> = {}) {
  return { id, characterRevisionId: CURRENT, checksumSha256: HASH, status: "ACTIVE", reviewStatus: "DRAFT",
    reviewNote: null, rowVersion: 1, createdAt: "2026-10-06T00:00:00.000Z", ...overrides };
}

function stub(listings: unknown[], writes: Array<{ status: number; body: unknown }> = []) {
  const calls: Array<{ method: string; url: string; body: unknown; key: string | null }> = [];
  vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null,
      key: new Headers(init?.headers).get("Idempotency-Key") });
    if (method === "GET") {
      const next = listings.length > 1 ? listings.shift() : listings[0];
      return next === "unavailable"
        ? json({ error: { code: "CHARACTER_REFERENCE_STORAGE_UNAVAILABLE", message: "draft not applied" } }, 503)
        : json(next);
    }
    const reply = writes.shift() ?? { status: 200, body: {} };
    return json(reply.body, reply.status);
  }));
  return calls;
}

describe("character reference panel", () => {
  it("says the storage is not installed and offers no reference actions", async () => {
    const calls = stub(["unavailable"]);
    render(<CharacterReferencePanel characterId={CHARACTER} currentRevisionId={CURRENT} />);
    expect(await screen.findByText(/参考图存储尚未启用/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "为当前版本生成参考图" })).toBeNull();
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("reviews on the exact bytes and selects with the selection it saw", async () => {
    const listing = { characterId: CHARACTER, currentRevisionId: CURRENT, selection: null,
      items: [asset("44444444-4444-4444-8444-444444444444"),
        asset("55555555-5555-4555-8555-555555555555", { reviewStatus: "APPROVED", rowVersion: 2 }),
        asset("66666666-6666-4666-8666-666666666666", { reviewStatus: "APPROVED", characterRevisionId: OLD }),
        asset("77777777-7777-4777-8777-777777777777", { reviewStatus: "APPROVED", status: "STALE" })] };
    const calls = stub([listing]);
    render(<CharacterReferencePanel characterId={CHARACTER} currentRevisionId={CURRENT} />);
    expect(await screen.findByText("尚未选定参考图")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "通过" })[0]!);
    await waitFor(() => expect(calls.some((call) => call.url.endsWith("/review"))).toBe(true));
    expect(calls.find((call) => call.url.endsWith("/review"))).toMatchObject({
      url: "/api/v1/character-reference-images/44444444-4444-4444-8444-444444444444/review",
      body: { decision: "APPROVED", expectedRowVersion: 1, contentHash: HASH } });
    const selectButtons = screen.getAllByRole("button", { name: /选为视频参考|不可选定/ }) as HTMLButtonElement[];
    expect(selectButtons.map((button) => button.disabled)).toEqual([true, false, true, true]);
    fireEvent.click(selectButtons[1]!);
    await waitFor(() => expect(calls.some((call) => call.url.endsWith("/reference-selection"))).toBe(true));
    expect(calls.find((call) => call.url.endsWith("/reference-selection"))).toMatchObject({
      url: `/api/v1/characters/${CHARACTER}/reference-selection`,
      body: { assetId: "55555555-5555-4555-8555-555555555555", expectedSelectedAssetId: null } });
    expect(calls.filter((call) => call.method === "POST").every((call) => call.key)).toBe(true);
  });

  it("re-reads after a selection conflict and needs a note to reject", async () => {
    const before = { characterId: CHARACTER, currentRevisionId: CURRENT, selection: null,
      items: [asset("55555555-5555-4555-8555-555555555555", { reviewStatus: "APPROVED" }),
        asset("99999999-9999-4999-8999-999999999999")] };
    const after = { ...before, selection: { assetId: "88888888-8888-4888-8888-888888888888",
      sourceCharacterRevisionId: CURRENT, usable: true } };
    const calls = stub([before, after], [{ status: 409, body: { error: { code: "REFERENCE_SELECTION_CONFLICT",
      message: "The selected reference changed since it was read" } } }]);
    render(<CharacterReferencePanel characterId={CHARACTER} currentRevisionId={CURRENT} />);
    fireEvent.click(await screen.findByRole("button", { name: "选为视频参考" }));
    expect(await screen.findByText(/REFERENCE_SELECTION_CONFLICT/)).toBeTruthy();
    expect(await screen.findByText(/当前选定：88888888 · 可用于视频/)).toBeTruthy();
    expect(calls.filter((call) => call.method === "GET").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByRole("button", { name: "退回" })).toHaveLength(1);
    expect(screen.queryByLabelText("退回原因 55555555")).toBeNull();
    const reject = screen.getByRole("button", { name: "退回" }) as HTMLButtonElement;
    expect(reject.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("退回原因 99999999"), { target: { value: "脸型不一致" } });
    expect(reject.disabled).toBe(false);
  });
});
