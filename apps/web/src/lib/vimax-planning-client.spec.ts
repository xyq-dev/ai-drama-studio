import { describe, expect, it, vi } from "vitest";
import { VimaxPlanningClient } from "./vimax-planning-client";
import { vimaxPlanningFixture } from "./vimax-planning-test-fixtures";
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
describe("ViMax planning HTTP receipts", () => {
  it("uses private same-origin GET history without starting anything", async () => {
    const f = vimaxPlanningFixture(); const fetch = vi.fn(async (_input: string, _init?: RequestInit) => reply({ schema: "ads.vimax-planning.page.v1", items: [f.view] }));
    const client = new VimaxPlanningClient(fetch); await client.list(f.source.projectId, f.source.episodeId);
    expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store" });
  });
  it("binds successful POST to the exact key, request and scope", async () => {
    const f = vimaxPlanningFixture(); const fetch = vi.fn(async (_input: string, _init?: RequestInit) => reply({ schema: "ads.vimax-planning.response.v1", replayed: false, request: f.view }));
    const client = new VimaxPlanningClient(fetch);
    await client.start(f.source.projectId, f.source.episodeId, f.body, f.view.requestKey);
    const init = fetch.mock.calls[0]![1]!; expect(init.method).toBe("POST"); expect(new Headers(init.headers).get("Idempotency-Key")).toBe(f.view.requestKey);
    expect(JSON.parse(init.body as string)).toEqual(f.body);
    for (const request of [ { ...f.view, requestKey: "another-key" }, { ...f.view, episodeId: "e0000000-0000-4000-8000-000000000001" },
      { ...f.view, input: { ...f.view.input, request: { ...f.body, requirements: { ...f.body.requirements, style: "different" } } } } ]) {
      fetch.mockResolvedValueOnce(reply({ schema: "ads.vimax-planning.response.v1", replayed: true, request }));
      await expect(client.start(f.source.projectId, f.source.episodeId, f.body, f.view.requestKey)).rejects.toMatchObject({ code: "VIMAX_PLANNING_UNCONFIRMED" });
    }
  });
  it("rejects malformed output lineage and duplicate history identities", async () => {
    const f = vimaxPlanningFixture(); const fetch = vi.fn(async (_input: string, _init?: RequestInit) => reply({ schema: "ads.vimax-planning.response.v1", replayed: false,
      request: { ...f.completed, output: { ...f.create, target: { ...f.create.target, rowVersion: 99 } } } }));
    const client = new VimaxPlanningClient(fetch);
    await expect(client.get(f.source.projectId, f.source.episodeId, f.view.requestId)).rejects.toMatchObject({ code: "VIMAX_PLANNING_UNCONFIRMED" });
    fetch.mockResolvedValueOnce(reply({ schema: "ads.vimax-planning.page.v1", items: [f.view, f.view] }));
    await expect(client.list(f.source.projectId, f.source.episodeId)).rejects.toMatchObject({ code: "VIMAX_PLANNING_UNCONFIRMED" });
  });
  it("preserves server business refusal codes and never retries a failed request", async () => {
    const f = vimaxPlanningFixture(); const fetch = vi.fn(async (_input: string, _init?: RequestInit) => reply({ error: { code: "VIMAX_PLANNING_NEEDS_CONFIRMATION", message: "可能已收费" } }, 409));
    const client = new VimaxPlanningClient(fetch);
    await expect(client.start(f.source.projectId, f.source.episodeId, f.body, "key")).rejects.toMatchObject({ status: 409, code: "VIMAX_PLANNING_NEEDS_CONFIRMATION" });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
