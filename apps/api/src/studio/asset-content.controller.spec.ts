import { describe, expect, it, vi } from "vitest";
import { StreamableFile } from "@nestjs/common";
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
