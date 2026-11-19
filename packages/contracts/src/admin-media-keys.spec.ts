import { describe, expect, it } from "vitest";
import {
  MEDIA_KEY_SLOTS,
  adminMediaKeyUpdateSchema,
  mediaKeySlotSchema,
} from "./admin-media-keys";

const base = { expectedRevision: 0, slot: "DASHSCOPE_MEDIA_API_KEY" as const, secretAction: "keep" as const };

describe("admin media key contracts", () => {
  it("exposes exactly the three official media slots", () => {
    expect([...MEDIA_KEY_SLOTS]).toEqual(["OPENAI_MEDIA_API_KEY", "DASHSCOPE_MEDIA_API_KEY", "MINIMAX_API_KEY"]);
    expect(mediaKeySlotSchema.safeParse("OPENAI_API_KEY").success).toBe(false);
    expect(mediaKeySlotSchema.safeParse("ELEVENLABS_TTS_API_KEY").success).toBe(false);
  });

  it("requires explicit keep/replace/clear pairing", () => {
    expect(adminMediaKeyUpdateSchema.safeParse(base).success).toBe(true);
    expect(adminMediaKeyUpdateSchema.safeParse({ ...base, secretAction: "replace", apiKey: "synthetic-media-key-01" }).success).toBe(true);
    expect(adminMediaKeyUpdateSchema.safeParse({ ...base, secretAction: "clear" }).success).toBe(true);
    expect(adminMediaKeyUpdateSchema.safeParse({ ...base, secretAction: "replace" }).success).toBe(false);
    expect(adminMediaKeyUpdateSchema.safeParse({ ...base, secretAction: "keep", apiKey: "synthetic-media-key-01" }).success).toBe(false);
    expect(adminMediaKeyUpdateSchema.safeParse({ ...base, secretAction: "clear", apiKey: "synthetic-media-key-01" }).success).toBe(false);
  });

  it("rejects unsafe keys and unknown slots", () => {
    for (const apiKey of ["", "short", "has space", "has\nnewline", "x".repeat(513)]) {
      expect(adminMediaKeyUpdateSchema.safeParse({ ...base, secretAction: "replace", apiKey }).success).toBe(false);
    }
    expect(adminMediaKeyUpdateSchema.safeParse({ ...base, slot: "OPENAI_API_KEY" }).success).toBe(false);
    expect(adminMediaKeyUpdateSchema.safeParse({ ...base, expectedRevision: -1 }).success).toBe(false);
    expect(adminMediaKeyUpdateSchema.safeParse({ ...base, enabled: true }).success).toBe(false);
  });
});
