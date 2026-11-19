import { z } from "zod";

/** The three official media key slots. Writing / ElevenLabs / Bailian TTS keys are never substitutes. */
export const MEDIA_KEY_SLOTS = ["OPENAI_MEDIA_API_KEY", "DASHSCOPE_MEDIA_API_KEY", "MINIMAX_API_KEY"] as const;
export type MediaKeySlot = (typeof MEDIA_KEY_SLOTS)[number];

export const mediaKeySlotSchema = z.enum(MEDIA_KEY_SLOTS);

export const MEDIA_KEY_SLOT_LABELS: Readonly<Record<MediaKeySlot, string>> = {
  OPENAI_MEDIA_API_KEY: "OpenAI 生图",
  DASHSCOPE_MEDIA_API_KEY: "百炼生图 / 视频",
  MINIMAX_API_KEY: "MiniMax 正式配音",
};

export const MEDIA_KEY_SLOT_HINTS: Readonly<Record<MediaKeySlot, string>> = {
  OPENAI_MEDIA_API_KEY:
    "仅用于正式生图 openai-media / gpt-image-2.5-sunburst。不得用写作 OPENAI_API_KEY 替补。可一直留空。",
  DASHSCOPE_MEDIA_API_KEY:
    "百炼正式生图 qwen-image-3.0 与正式视频 wan2.6-i2v-flash 同源，只这一把媒体密钥。不得用百炼 TTS 或其他密钥替补。",
  MINIMAX_API_KEY:
    "仅用于正式配音 MiniMax speech-2.8-hd（minimax-tts）。不得用 ELEVENLABS_TTS_API_KEY、写作 OPENAI_API_KEY 或百炼 TTS 替补。",
};

const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const adminMediaKeyUpdateSchema = z
  .object({
    expectedRevision: revision,
    slot: mediaKeySlotSchema,
    secretAction: z.enum(["keep", "replace", "clear"]),
    apiKey: z.string().min(8).max(512).regex(/^\S+$/u).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.secretAction === "replace") !== (value.apiKey !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["apiKey"], message: "Secret action and value do not match" });
    }
  });

export type AdminMediaKeyUpdate = z.infer<typeof adminMediaKeyUpdateSchema>;

/**
 * Read-only service readiness for a media-key slot (Figma state board).
 * 「密钥已保存」 is not the same as 「服务可用」.
 * - unconfigured: no key
 * - saved_not_ready: key saved, but unit price missing / service not ready
 * - ready: key saved and service available (price snapshot present)
 * - single_failure: service still available; a one-off generation failed (retry allowed)
 * Derived from real config + price env snapshots only — never vendor calls, never sample data.
 */
export type MediaKeyServiceState = "unconfigured" | "saved_not_ready" | "ready" | "single_failure";

/** Public slot view. Secret values, prefixes and fingerprints must never be added. */
export interface AdminMediaKeySlotView {
  slot: MediaKeySlot;
  label: string;
  hint: string;
  /** Whether a usable key is currently available for this slot (managed or unmanaged env). */
  keyConfigured: boolean;
  /** Redacted status only: 已保存 / 未填写 / 等待重启. Never a secret. */
  status: "saved" | "empty" | "pending_restart";
  /** True once the admin UI has ever managed this slot (including clear). */
  managed: boolean;
  /** Where the effective key comes from for probes and generation. */
  source: "managed" | "environment" | "none";
  /** Whether a positive unit-price snapshot is present for this slot's official capability. */
  priceConfigured: boolean;
  /** Combined key + price readiness (and optional single-failure overlay). */
  serviceState: MediaKeyServiceState;
}

export interface AdminMediaKeysView {
  savedRevision: number;
  /** True when a saved key has not yet been loaded into this API process (should be rare with hot reload). */
  pendingRestart: boolean;
  source: "environment" | "managed";
  slots: AdminMediaKeySlotView[];
  validation: "local_only";
  /** Reminder: filling keys does not lock prices, enable payments, or start paid generation. */
  notices: string[];
}
