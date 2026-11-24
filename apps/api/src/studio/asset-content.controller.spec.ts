import { describe, expect, it, vi } from "vitest";
import { StreamableFile } from "@nestjs/common";
import { buffer } from "node:stream/consumers";
import type { StudioService } from "./studio.service";
import { StudioController } from "./studio.controller";

describe("asset content response", () => {
  it("returns the full fixture for GET and an empty HEAD while ignoring Range", async () => {
    const bytes = Buffer.from("canonical-bytes");
    const studio = {
      readMockAssetContent: vi.fn(async () => ({ mimeType: "video/mp4", bytes })),
    };
    const controller = new StudioController(studio as unknown as StudioService);
    const headers: Record<string, string> = {};
    const response = {
      status: vi.fn(),
      setHeader(name: string, value: string) { headers[name] = value; },
    };
    const assetId = "33333333-3333-4333-8333-333333333333";
    const getResult = await controller.readAssetContent(assetId, {
      method: "GET",
    }, response);
    expect(getResult).toBeInstanceOf(StreamableFile);
    expect(headers["Content-Type"]).toBe("video/mp4");
    expect(headers["Content-Length"]).toBe(String(bytes.length));
    expect(headers["Cache-Control"]).toBe("private, no-store");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Accept-Ranges"]).toBeUndefined();
    expect(response.status).toHaveBeenCalledWith(200);

    const headResult = await controller.readAssetContent(assetId, { method: "HEAD" }, response);
    expect(headResult).toBeUndefined();
    expect(studio.readMockAssetContent).toHaveBeenCalledTimes(2);
  });

  it("serves bounded, open and suffix ranges of verified composites after authorization", async () => {
    const bytes = Buffer.from("0123456789");
    const etag = '"verified-hash"';
    const read = vi.fn(async () => ({ bytes, mimeType: "video/mp4", etag }));
    const controller = new StudioController({ readMockAssetContent: read } as unknown as StudioService);
    async function get(range: string, ifRange?: string, method = "GET") {
      const headers = new Headers();
      const response = { status: vi.fn(), setHeader: (name: string, value: string) => headers.set(name, value) };
      const file = await controller.readAssetContent("asset", { method, headers: { range, "if-range": ifRange } }, response);
      return { status: response.status.mock.calls[0]?.[0], headers, bytes: file ? (await buffer(file.getStream())).toString() : "" };
    }
    for (const [request, bounds, expected] of [
      ["bytes=0-0", "0-0", "0"], ["bytes=2-4", "2-4", "234"], ["bytes=7-", "7-9", "789"],
      ["bytes=8-23", "8-9", "89"], ["bytes=-3", "7-9", "789"], ["bytes=-25", "0-9", "0123456789"],
    ] as const) {
      const result = await get(request, etag);
      expect(result).toMatchObject({ status: 206, bytes: expected });
      expect(result.headers.get("content-range")).toBe(`bytes ${bounds}/10`);
      expect(result.headers.get("content-length")).toBe(String(expected.length));
      expect(result.headers.get("accept-ranges")).toBe("bytes");
      expect(result.headers.get("etag")).toBe(etag);
    }
    for (const request of ["bytes=10-", "bytes=7-3", "bytes=-0"]) {
      const result = await get(request);
      expect(result).toMatchObject({ status: 416, bytes: "" });
      expect(result.headers.get("content-range")).toBe("bytes */10");
    }
    expect(await get("bytes=2-3", '"earlier"')).toMatchObject({ status: 200, bytes: "0123456789" });
    expect(await get("bytes=1-2,4-", etag)).toMatchObject({ status: 200, bytes: "0123456789" });
    const head = await get("bytes=2-3", etag, "HEAD");
    expect(head).toMatchObject({ status: 200, bytes: "" });
    expect(head.headers.get("content-length")).toBe("10");
    read.mockRejectedValueOnce(new Error("asset not found"));
    await expect(get("bytes=100-")).rejects.toThrow("asset not found");
  });

  it("downloads the verified MP4 and manifest with one filename stem, and leaves errors without attachment headers", async () => {
    const bytes = Buffer.from("episode-mp4");
    const hash = "ab".repeat(32);
    const assetId = "33333333-3333-4333-8333-333333333333";
    const projectId = "22222222-2222-4222-8222-222222222222";
    const episodeId = "44444444-4444-4444-8444-444444444444";
    const manifest = { schema: "m4.episode.export.manifest.v1", asset: { checksumSha256: hash } };
    const studio = {
      exportEpisodeComposite: vi.fn(async () => ({ filenameStem: `episode-01-${assetId}`, bytes, manifest })),
    };
    const controller = new StudioController(studio as unknown as StudioService);
    const headers: Record<string, string> = {};
    const response = {
      status: vi.fn(),
      setHeader(name: string, value: string) { headers[name] = value; },
    };
    const query = { expectedContentHash: hash };
    const downloaded = await controller.downloadEpisodeComposite(projectId, episodeId, assetId, query, { method: "GET" }, response);
    expect(downloaded).toBeInstanceOf(StreamableFile);
    expect(headers["Content-Type"]).toBe("video/mp4");
    expect(headers["Content-Disposition"]).toBe(`attachment; filename="episode-01-${assetId}.mp4"`);
    expect(headers["Content-Length"]).toBe(String(bytes.length));
    expect(headers["Cache-Control"]).toBe("private, no-store");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(response.status).toHaveBeenCalledWith(200);
    const head = await controller.downloadEpisodeComposite(projectId, episodeId, assetId, query, { method: "HEAD" }, response);
    expect(head).toBeUndefined();
    const listed = await controller.exportEpisodeManifest(projectId, episodeId, assetId, query, response);
    expect(listed).toBeInstanceOf(StreamableFile);
    expect(headers["Content-Type"]).toBe("application/json; charset=utf-8");
    expect(headers["Content-Disposition"]).toBe(`attachment; filename="episode-01-${assetId}.json"`);
    studio.exportEpisodeComposite.mockRejectedValueOnce(Object.assign(new Error("refused"), { code: "COMPOSE_INPUT_INVALID" }));
    const failed: Record<string, string> = {};
    await expect(controller.downloadEpisodeComposite(projectId, episodeId, assetId, query, { method: "GET" }, {
      status: vi.fn(),
      setHeader(name: string, value: string) { failed[name] = value; },
    })).rejects.toThrow(/refused/);
    expect(failed["Content-Disposition"]).toBeUndefined();
  });
});
