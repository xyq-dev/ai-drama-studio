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
});
