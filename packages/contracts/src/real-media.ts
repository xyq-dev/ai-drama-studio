import { z } from "zod";

export const REAL_MEDIA_SCHEMA = "real-media.v1" as const;
export const realMediaCapabilitySchema = z.enum(["image.generate", "video.generate", "audio.tts", "audio.music"]);
export type RealMediaCapability = z.infer<typeof realMediaCapabilitySchema>;
export const realMediaAmountSchema = z.string().regex(/^(0|[1-9]\d{0,7})(\.\d{1,8})?$/);
export const realMediaQuoteRequestSchema = z.object({
  capability: realMediaCapabilitySchema,
  sourceImageAssetId: z.string().uuid().optional(),
}).strict();
export const realMediaAuthorizationSchema = z.object({
  quoteId: z.string().uuid(), maximumAmount: realMediaAmountSchema,
  confirmSinglePaidOperation: z.literal(true),
  confirmedUncertainJobIds: z.array(z.string().uuid()).max(20).optional().default([]),
}).strict();
export const realMediaGenerateSchema = z.object({ quoteId: z.string().uuid(), budgetAuthorizationId: z.string().uuid() }).strict();

/** Server-owned, versioned configuration. It contains references, never credential values. */
export interface RealMediaConfiguration {
  id: string; version: string; providerKey: string; capability: RealMediaCapability;
  model: string; region: string; credentialRef: string; credentialVersion: string;
  enabled: boolean; queryAllowed: boolean; priceVersion: string;
  currency: "CNY" | "USD"; unitPrice: string; unitType: "image" | "second" | "character" | "request";
  parameters: Record<string, unknown>;
  maximumOperationAmount?: string;
}
export interface RealMediaQuote {
  quoteId: string; inputHash: string; capability: RealMediaCapability;
  currency: "CNY" | "USD"; estimatedAmount: string; maximumAmount: string; expiresAt: string;
  providerConfigurationId: string; providerConfigurationVersion: string; priceVersion: string;
  actualCost: "unknown"; singleOperation: true;
  uncertainJobIds: string[];
}
/** One text-to-dialogue turn. Spoken `text` is sent as-is; performance notes stay outside this field. */
export interface ElevenLabsDialogueInput {
  speaker: string; text: string; voiceId: string;
}
/**
 * Frozen scene dialogue for ElevenLabs `eleven_v4`.
 * `previousText` / `futureText` map to the dialogue API's `previous_text` / `future_text` (not TTS `next_text`).
 */
export interface ElevenLabsDialogueBlock {
  schema: "elevenlabs-tts.dialogue.v1";
  languageCode: string;
  inputs: ElevenLabsDialogueInput[];
  previousText?: string;
  futureText?: string;
}
/**
 * One MiniMax `t2a_v2` utterance for `speech-2.8-hd`.
 * Spoken `text` is sent as-is. This is not an ElevenLabs dialogue block and not a qwen line.
 */
export interface MiniMaxSpeechBlock {
  schema: "minimax-tts.speech.v1";
  text: string;
  voiceId: string;
}
export interface RealMediaSnapshot {
  schema: typeof REAL_MEDIA_SCHEMA; shotRevisionId: string; capability: RealMediaCapability;
  sourceText: string; sourceHash: string; configuration: RealMediaConfiguration;
  sourceImage?: { assetId: string; checksumSha256: string };
  speech?: import("./speech").SpeechGenerationInput;
  /** Scene-level ElevenLabs speech. Absent on image, video, music, and per-line qwen snapshots. */
  dialogue?: ElevenLabsDialogueBlock;
  /** Single MiniMax `t2a_v2` utterance. Absent unless the provider is `minimax-tts`. */
  minimaxSpeech?: MiniMaxSpeechBlock;
  characterReferenceGate?:"legacy"|"strict";
  budget: { authorizationId: string; quoteId: string; currency: "CNY" | "USD"; estimatedAmount: string;
    maximumAmount: string; priceVersion: string; authorizedBy: string; authorizedAt: string; expiresAt: string;
    confirmedUncertainJobIds?: string[] };
}
export interface RealMediaAvailability { readAvailable?:boolean; available: boolean; reasonCode: string | null; capabilities: RealMediaCapability[] }
