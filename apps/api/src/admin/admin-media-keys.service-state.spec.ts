import { describe, expect, it } from "vitest";
import { mediaKeyPriceConfigured, mediaKeyServiceState } from "./admin-media-keys.service";

describe("media key saved vs available states", () => {
  it("maps key + price snapshots without vendor calls", () => {
    expect(mediaKeyServiceState({ keyConfigured: false, priceConfigured: false })).toBe("unconfigured");
    expect(mediaKeyServiceState({ keyConfigured: true, priceConfigured: false })).toBe("saved_not_ready");
    expect(mediaKeyServiceState({ keyConfigured: true, priceConfigured: true })).toBe("ready");
    expect(mediaKeyServiceState({ keyConfigured: true, priceConfigured: true, singleFailure: true })).toBe("single_failure");
  });

  it("reads MiniMax / OpenAI / DashScope price readiness from env snapshots only", () => {
    expect(mediaKeyPriceConfigured("MINIMAX_API_KEY", {
      REAL_MEDIA_PRICE_VERSION: "fixture-v1",
      MINIMAX_TTS_PRICE_CHARACTER: "0.0001",
    })).toBe(true);
    expect(mediaKeyPriceConfigured("MINIMAX_API_KEY", {
      REAL_MEDIA_PRICE_VERSION: "fixture-v1",
    })).toBe(false);
    expect(mediaKeyPriceConfigured("OPENAI_MEDIA_API_KEY", {
      REAL_MEDIA_PRICE_VERSION: "fixture-v1",
      OPENAI_MEDIA_PRICE_IMAGE: "0.04",
    })).toBe(true);
    expect(mediaKeyPriceConfigured("DASHSCOPE_MEDIA_API_KEY", {
      REAL_MEDIA_PRICE_VERSION: "fixture-v1",
      DASHSCOPE_MEDIA_PRICE_VIDEO_SECOND: "0.15",
    })).toBe(true);
  });
});
