import { describe, expect, it, vi } from "vitest";
import { EnvValidationError, loadAdapterEnv } from "../config/env";
import { buildAdapterHealth } from "./adapter-health";

describe("adapter health", () => {
  it("stays in stub mode and does not call the network", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const body = buildAdapterHealth("http://127.0.0.1:8188", new Date("2026-09-23T00:00:00.000Z"));
    expect(body).toEqual({
      service: "comfyui-adapter",
      status: "ok",
      mode: "stub",
      comfyuiConfigured: true,
      timestamp: "2026-09-23T00:00:00.000Z",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("reports an unconfigured stub and a degraded invalid URL", () => {
    expect(buildAdapterHealth("").comfyuiConfigured).toBe(false);
    expect(buildAdapterHealth("").status).toBe("ok");
    expect(buildAdapterHealth("not a url").status).toBe("degraded");
    expect(buildAdapterHealth("not a url").comfyuiConfigured).toBe(false);
  });

  it("rejects an invalid configured ComfyUI URL without exposing it", () => {
    expect(() => loadAdapterEnv({ COMFYUI_BASE_URL: "not a url" })).toThrow(EnvValidationError);
    try {
      loadAdapterEnv({ COMFYUI_BASE_URL: "not a url" });
    } catch (error) {
      expect(error).toMatchObject({ fields: ["COMFYUI_BASE_URL"] });
      expect(String(error)).not.toContain("not a url");
    }
  });
});
