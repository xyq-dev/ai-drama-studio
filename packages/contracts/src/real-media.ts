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
export interface RealMediaSnapshot {
  schema: typeof REAL_MEDIA_SCHEMA; shotRevisionId: string; capability: RealMediaCapability;
  sourceText: string; sourceHash: string; configuration: RealMediaConfiguration;
  sourceImage?: { assetId: string; checksumSha256: string };
  speech?: import("./speech").SpeechGenerationInput;
  characterReferenceGate?:"legacy"|"strict";
  budget: { authorizationId: string; quoteId: string; currency: "CNY" | "USD"; estimatedAmount: string;
    maximumAmount: string; priceVersion: string; authorizedBy: string; authorizedAt: string; expiresAt: string;
    confirmedUncertainJobIds?: string[] };
}
export interface RealMediaAvailability { readAvailable?:boolean; available: boolean; reasonCode: string | null; capabilities: RealMediaCapability[] }
