import { describe, expect, it, vi } from "vitest";
import { proxyEpisodeExport } from "./episode-export-proxy";

const projectId = "22222222-2222-4222-8222-222222222222";
const episodeId = "33333333-3333-4333-8333-333333333333";
const assetId = "44444444-4444-4444-8444-444444444444";
const hash = "ab".repeat(32);

describe("same-origin episode export proxy", () => {
  it("forwards the attachment headers and does not turn an error JSON into a download", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("expectedContentHash=cd")) {
        return new Response(JSON.stringify({ error: { code: "COMPOSE_INPUT_INVALID", message: "refused" } }), {
          status: 400,
          headers: { "content-type": "application/json", "content-disposition": "attachment; filename=\"bad.mp4\"" },
        });
      }
      return new Response(init?.method === "HEAD" ? null : bytes, {
        status: 200,
        headers: {
          "content-type": "video/mp4",
          "content-length": "3",
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "content-disposition": `attachment; filename="episode-01-${assetId}.mp4"`,
        },
      });
    });
    const params = Promise.resolve({ projectId, episodeId, assetId });
    const request = new Request(`http://studio.local/download?expectedContentHash=${hash}`);
    const got = await proxyEpisodeExport(request, params, "download", fetchImpl as typeof fetch);
    expect(got.headers.get("content-disposition")).toContain("attachment");
    expect(got.headers.get("content-type")).toBe("video/mp4");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
    const called = String(fetchImpl.mock.calls[0]?.[0]);
    expect(called).toContain(`/projects/${projectId}/episodes/${episodeId}/composites/${assetId}/download?expectedContentHash=${hash}`);
    expect(called).not.toContain("workspaceId");
    const head = await proxyEpisodeExport(new Request(request.url, { method: "HEAD" }), params, "download", fetchImpl as typeof fetch);
    expect(head.status).toBe(200);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    expect(head.headers.get("content-disposition")).toContain(".mp4");
    const refused = await proxyEpisodeExport(new Request("http://studio.local/download?expectedContentHash=" + "cd".repeat(32)), params, "download", fetchImpl as typeof fetch);
    expect(refused.status).toBe(400);
    expect(refused.headers.get("content-disposition")).toBeNull();
    expect(await refused.json()).toMatchObject({ error: { code: "COMPOSE_INPUT_INVALID" } });
    const invalid = await proxyEpisodeExport(new Request("http://studio.local/download?expectedContentHash=nope&objectKey=secret"), params, "download", fetchImpl as typeof fetch);
    expect(invalid.status).toBe(400);
  });
});
