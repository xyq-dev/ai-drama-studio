import { z } from "zod";

export const SPEECH_STORAGE_VERSION = "ads.speech.storage.v1";
export const SPEECH_PLAN_SCHEMA = "voice.shot.plan.v1";
export const SPEECH_MIX_SCHEMA = "voice.shot.mix.v1";
export const SPEECH_MAX_LINES = 100;
export const SPEECH_MAX_REQUEST_BYTES = 64 * 1024;
const id = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const speechVoiceSchema = z.object({
  catalogVoiceId: z.string().min(1).max(200), name: z.string().min(1).max(200),
  providerConfigurationId: id, providerConfigurationVersion: z.string().min(1).max(200),
  providerKey: z.string().min(1).max(100), model: z.string().min(1).max(200), modelVersion: z.string().min(1).max(200),
  voiceId: z.string().min(1).max(200), locale: z.string().min(1).max(30), rightsRef: z.string().min(1).max(500),
  capabilities: z.object({ emotions: z.array(z.string().min(1).max(40)).min(1).max(30),
    speedMin: z.number().min(0.5).max(2), speedMax: z.number().min(0.5).max(2), maxTextCharacters: z.number().int().min(1).max(2000).optional() }).strict(),
}).strict().refine((value) => value.capabilities.speedMin <= value.capabilities.speedMax);
export type SpeechVoice = z.infer<typeof speechVoiceSchema>;
export interface SpeechCapabilities {
  available: boolean; reasonCode: string | null; catalogVersion: string; voices: SpeechVoice[];
}
export interface SpeechVoiceRevision extends SpeechVoice { id: string; bindingId: string; contentHash: string }
export interface SpeechBinding {
  id: string; speakerId: string; rowVersion: number; currentRevision: SpeechVoiceRevision;
}
export const speechBindingPutSchema = z.object({ catalogVersion: z.string().min(1).max(200),
  catalogVoiceId: z.string().min(1).max(200), expectedImpactHash: hash.optional() }).strict();
export type SpeechBindingPut = z.infer<typeof speechBindingPutSchema>;
export const speechPlanLineSchema = z.object({
  lineId: id, speakerBindingRevisionId: id, sourceStart: z.number().int().min(0).max(4000),
  sourceEnd: z.number().int().min(1).max(4000), displayText: z.string().min(1).max(2000),
  emotion: z.string().min(1).max(40).default("neutral"), speed: z.number().min(0.5).max(2).default(1),
  pauseAfterMs: z.number().int().min(0).max(5000).default(0),
}).strict();
export type SpeechPlanLineInput = z.infer<typeof speechPlanLineSchema>;
export interface SpeechPlanLine extends SpeechPlanLineInput { lineInputRevisionId: string; inputHash: string }
export const speechPlanPutSchema = z.object({ sourceDialogueHash: hash,
  lines: z.array(speechPlanLineSchema).max(SPEECH_MAX_LINES),
  timingPolicy: z.literal("sequential-reject-overflow").default("sequential-reject-overflow"),
}).strict();
export type SpeechPlanPut = z.infer<typeof speechPlanPutSchema>;
export interface SpeechPlanView {
  shotRevisionId: string; projectId: string; sourceDialogue: string; sourceDialogueHash: string; rowVersion: number;
  currentRevision: { id: string; contentHash: string; timingPolicy: "sequential-reject-overflow"; lines: SpeechPlanLine[] } | null;
}
export interface SpeechGenerationInput {
  workspaceId: string; projectId: string; shotRevisionId: string; planRevisionId: string;
  lineId: string; lineInputRevisionId: string; inputHash: string; displayText: string; spokenText: string;
  voice: SpeechVoiceRevision; emotion: string; speed: number;
}
export interface SpeechQuote {
  quoteId: string; inputHash: string; currency: "CNY" | "USD"; estimatedAmount: string | null;
  maximumAmount: string; expiresAt: string; providerConfigurationId: string;
  providerConfigurationVersion: string; priceVersion: string;
  /** Every current server quote returns this list; optional for historical quote snapshots. */
  uncertainJobIds?: string[];
}
/** Uses the existing Job/Attempt/Asset chain. This port never grants permission by itself. */
export interface SpeechGenerationPort {
  capabilities(workspaceId: string, projectId: string): Promise<SpeechCapabilities>;
  quote(input: SpeechGenerationInput): Promise<SpeechQuote>;
  generate(input: SpeechGenerationInput & { quoteId: string; budgetAuthorizationId: string;
    idempotencyKey: string; actorId: string; traceId: string }): Promise<{ jobId: string; workflowRunId: string; reused: boolean }>;
}
export const speechGenerateSchema = z.object({ quoteId: z.string().min(1).max(200), budgetAuthorizationId: id }).strict();
export const speechSelectionPutSchema = z.object({ takeAssetId: id, expectedTakeChecksumSha256: hash }).strict();
export type SpeechSelectionPut = z.infer<typeof speechSelectionPutSchema>;
export interface SpeechTake {
  assetId: string; lineId: string; lineInputRevisionId: string; checksumSha256: string; durationMs: number;
  selectable: boolean; status: string; jobId: string; alignmentVersion: "sentence-duration-v1";
}
export interface SpeechSelection {
  id: string; lineId: string; takeAssetId: string; checksumSha256: string; lineInputRevisionId: string;
  selectedBy: string; selectedAt: string; inheritedFromSelectionId: string | null;
  /** Public listing recomputes eligibility independently of the current candidate page. */
  usable?: boolean; durationMs?: number;
}
export interface SpeechTakesPage { items: SpeechTake[]; selected: SpeechSelection[]; hasMore: boolean; rowVersion: number; nextCursor?: string | null }
export const speechMixRequestSchema = z.object({ videoAssetId: id, musicAssetId: id.nullable().optional(),
  originalAudio: z.enum(["mute", "confirmed-ambience"]).default("mute"),
  musicGain: z.number().min(0).max(1).default(0.25), ducking: z.boolean().default(true),
}).strict();
export type SpeechMixRequest = z.infer<typeof speechMixRequestSchema>;
export interface SpeechMixManifest {
  schema: typeof SPEECH_MIX_SCHEMA; workspaceId: string; projectId: string; shotRevisionId: string; planRevisionId: string;
  planHash: string; selectionHash: string; videoAssetId: string; videoChecksumSha256: string; videoDurationMs: number;
  totalSpeechMs: number; lines: Array<{ lineId: string; lineInputRevisionId: string; voiceRevisionId: string;
    selectionId: string; takeAssetId: string; checksumSha256: string; startMs: number; endMs: number; pauseAfterMs: number;
    displayText: string; alignmentVersion: "sentence-duration-v1" }>;
  subtitles: { format: "vtt"; alignmentVersion: "sentence-duration-v1"; checksumSha256: string; cues: Array<{ lineId: string; startMs: number; endMs: number; text: string }> };
  mix: { audioOverflow: "reject"; audioUnderflow: "pad-silence"; sampleRate: 48000; channels: 2;
    originalAudio: "mute" | "confirmed-ambience"; musicAssetId: string | null; musicChecksumSha256: string | null; musicGain: number; ducking: boolean };
}
export interface SpeechMixPreflight { inputHash: string; manifest: SpeechMixManifest; subtitleVtt: string;
  guards: { planRowVersion: number; assets: Array<{ assetId: string; rowVersion: number }> } }
