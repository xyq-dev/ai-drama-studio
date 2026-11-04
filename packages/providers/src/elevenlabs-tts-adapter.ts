import { createHash } from "node:crypto";
import type { ElevenLabsDialogueBlock, RealMediaConfiguration, RealMediaSnapshot } from "@ai-drama/contracts";
import {
  MediaSubmissionUnknownError,
  type MediaCapability, type MediaGenerationRequest, type MediaProviderAdapter,
  type MediaProviderObservation, type MediaProviderOutput, type MediaResolvedOutput, type MediaSubmitResult,
} from "./media-adapter";
import { type RealMediaHttpResponse, type RealMediaHttpTransport, fetchRealMediaHttp } from "./real-media-adapters";

export const ELEVENLABS_TTS_PROVIDER_KEY = "elevenlabs-tts";
export const ELEVENLABS_TTS_MODEL_ID = "eleven_v4";
export const ELEVENLABS_TTS_DIALOGUE_SCHEMA = "elevenlabs-tts.dialogue.v1";
export const ELEVENLABS_TTS_OUTPUT_FORMATS = ["pcm_44100", "wav_44100"] as const;
export type ElevenLabsTtsOutputFormat = (typeof ELEVENLABS_TTS_OUTPUT_FORMATS)[number];
export const ELEVENLABS_TTS_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
export const ELEVENLABS_TTS_MAX_SPOKEN_CHARACTERS = 2000;
const ENDPOINT = "https://api.elevenlabs.io/v1/text-to-dialogue/with-timestamps";
const ID = /^[A-Za-z0-9_-]{1,200}$/;
const VOICE = /^[A-Za-z0-9_:-]{1,80}$/;
const SSML = /<\s*\/?\s*(speak|break|prosody|phoneme|emphasis|lang)\b/i;
const UNSUPPORTED_PARAMETER = ["speed", "style", "similarity_boost", "use_speaker_boost", "ssml", "audioEffects", "audio_effects", "voice"];

export class ElevenLabsTtsAlignmentError extends Error {
  readonly code = "ELEVENLABS_TTS_ALIGNMENT_INSUFFICIENT";
  constructor(message = "Provider audio has no usable voice_segments/alignment; subtitle timings were not invented.") {
    super(message);
    this.name = "ElevenLabsTtsAlignmentError";
  }
}

interface DialogueRequestBody {
  inputs: { text: string; voice_id: string }[];
  model_id: "eleven_v4";
  language_code: string;
  apply_text_normalization: "auto";
  previous_text?: string;
  future_text?: string;
}

function checkedSecret(value: string): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 512 || /\s/.test(value)) throw new Error("MEDIA_CREDENTIAL_UNAVAILABLE");
  return value;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function requestId(value: unknown, secret?: string): string | undefined {
  return typeof value === "string" && ID.test(value) && (!secret || !value.includes(secret)) ? value : undefined;
}
function outputFormatOf(configuration: RealMediaConfiguration): ElevenLabsTtsOutputFormat {
  const format = configuration.parameters.outputFormat;
  if (format !== "pcm_44100" && format !== "wav_44100") throw new Error("MEDIA_CONFIGURATION_UNSUPPORTED");
  return format;
}
function languageOf(configuration: RealMediaConfiguration): string {
  const code = configuration.parameters.languageCode ?? "zh";
  if (typeof code !== "string" || !/^[a-z]{2}$/.test(code)) throw new Error("MEDIA_CONFIGURATION_UNSUPPORTED");
  return code;
}
function unsupportedParameter(configuration: RealMediaConfiguration): void {
  for (const key of UNSUPPORTED_PARAMETER) {
    if (configuration.parameters[key] !== undefined) throw new Error("MEDIA_CONFIGURATION_UNSUPPORTED");
  }
}
function contextText(value: string | undefined, field: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if ([...value].length > 100) throw new Error(`ELEVENLABS_TTS_${field}_LIMIT`);
  if (SSML.test(value)) throw new Error("ELEVENLABS_TTS_UNSUPPORTED_CONTROL");
  return value;
}

/** Spoken lines only. Performance notes, SSML, speed and style never enter the body. */
export function buildElevenLabsDialogueBody(dialogue: ElevenLabsDialogueBlock, languageCode: string): DialogueRequestBody {
  if (dialogue.schema !== ELEVENLABS_TTS_DIALOGUE_SCHEMA) throw new Error("ELEVENLABS_TTS_DIALOGUE_INVALID");
  if (dialogue.languageCode !== languageCode) throw new Error("ELEVENLABS_TTS_DIALOGUE_INVALID");
  if (!Array.isArray(dialogue.inputs) || dialogue.inputs.length === 0 || dialogue.inputs.length > 50) throw new Error("ELEVENLABS_TTS_DIALOGUE_INVALID");
  const voices = new Set<string>();
  let spoken = 0;
  const inputs = dialogue.inputs.map((line) => {
    if (!line || typeof line.speaker !== "string" || !line.speaker.trim() || typeof line.text !== "string" || !line.text.trim()) {
      throw new Error("ELEVENLABS_TTS_DIALOGUE_INVALID");
    }
    if (!VOICE.test(line.voiceId) || SSML.test(line.text) || SSML.test(line.speaker)) throw new Error("ELEVENLABS_TTS_UNSUPPORTED_CONTROL");
    voices.add(line.voiceId);
    spoken += [...line.text].length;
    return { text: line.text, voice_id: line.voiceId };
  });
  if (voices.size > 10 || spoken < 1 || spoken > ELEVENLABS_TTS_MAX_SPOKEN_CHARACTERS) throw new Error("ELEVENLABS_TTS_DIALOGUE_INVALID");
  const previous = contextText(dialogue.previousText, "PREVIOUS_TEXT");
  const future = contextText(dialogue.futureText, "FUTURE_TEXT");
  return {
    inputs, model_id: "eleven_v4", language_code: languageCode, apply_text_normalization: "auto",
    ...(previous ? { previous_text: previous } : {}),
    ...(future ? { future_text: future } : {}),
  };
}

export function elevenLabsDialogueUrl(format: ElevenLabsTtsOutputFormat): string {
  return `${ENDPOINT}?output_format=${format}`;
}

function numberArray(value: unknown, size: number): number[] | null {
  if (!Array.isArray(value) || value.length !== size) return null;
  const numbers: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item) || item < 0) return null;
    numbers.push(item);
  }
  return numbers;
}

export interface ParsedDialogueAlignment {
  voiceSegments: Record<string, unknown>[];
  alignment: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };
  normalizedAlignment: Record<string, unknown> | null;
}

/** Hard-fail when timestamps cannot cover every dialogue input. Never synthesizes times. */
export function parseDialogueAlignment(inputs: { voice_id: string }[], payload: Record<string, unknown>): ParsedDialogueAlignment {
  const alignment = record(payload.alignment);
  const characters = alignment.characters;
  if (!Array.isArray(characters) || characters.length === 0 || characters.some((item) => typeof item !== "string")) {
    throw new ElevenLabsTtsAlignmentError();
  }
  const starts = numberArray(alignment.character_start_times_seconds, characters.length);
  const ends = numberArray(alignment.character_end_times_seconds, characters.length);
  if (!starts || !ends) throw new ElevenLabsTtsAlignmentError();
  for (let index = 0; index < characters.length; index += 1) {
    if (ends[index]! < starts[index]!) throw new ElevenLabsTtsAlignmentError();
    if (index > 0 && starts[index]! < starts[index - 1]!) throw new ElevenLabsTtsAlignmentError();
  }
  const segments = payload.voice_segments;
  if (!Array.isArray(segments) || segments.length === 0) throw new ElevenLabsTtsAlignmentError();
  const covered = new Set<number>();
  const voiceSegments: Record<string, unknown>[] = [];
  for (const raw of segments) {
    const segment = record(raw);
    const inputIndex = segment.dialogue_input_index;
    const start = segment.start_time_seconds;
    const end = segment.end_time_seconds;
    const characterStart = segment.character_start_index;
    const characterEnd = segment.character_end_index;
    if (typeof segment.voice_id !== "string" || !segment.voice_id || typeof inputIndex !== "number" || !Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= inputs.length
      || typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 0
      || typeof characterStart !== "number" || typeof characterEnd !== "number" || !Number.isInteger(characterStart) || !Number.isInteger(characterEnd)
      || characterStart < 0 || characterEnd <= characterStart || characterEnd > characters.length) throw new ElevenLabsTtsAlignmentError();
    covered.add(inputIndex);
    voiceSegments.push(segment);
  }
  if (covered.size !== inputs.length) throw new ElevenLabsTtsAlignmentError();
  let normalizedAlignment: Record<string, unknown> | null = null;
  if (payload.normalized_alignment != null) {
    const normalized = record(payload.normalized_alignment);
    const normalizedCharacters = normalized.characters;
    if (!Array.isArray(normalizedCharacters) || normalizedCharacters.some((item) => typeof item !== "string")) throw new ElevenLabsTtsAlignmentError();
    if (!numberArray(normalized.character_start_times_seconds, normalizedCharacters.length)
      || !numberArray(normalized.character_end_times_seconds, normalizedCharacters.length)) throw new ElevenLabsTtsAlignmentError();
    normalizedAlignment = normalized;
  }
  return {
    voiceSegments,
    alignment: { characters: characters as string[], character_start_times_seconds: starts, character_end_times_seconds: ends },
    normalizedAlignment,
  };
}

function frozenSnapshot(input: MediaGenerationRequest, configuration: RealMediaConfiguration): RealMediaSnapshot {
  const value = record(input.inputSnapshot);
  const frozen = record(value.configuration);
  if (value.schema !== "real-media.v1" || value.capability !== "audio.tts" || input.capability !== "audio.tts"
    || input.providerConfigurationId !== configuration.id || frozen.id !== configuration.id
    || frozen.version !== configuration.version || frozen.providerKey !== ELEVENLABS_TTS_PROVIDER_KEY
    || frozen.model !== ELEVENLABS_TTS_MODEL_ID || frozen.credentialVersion !== configuration.credentialVersion
    || frozen.region !== configuration.region || frozen.credentialRef !== configuration.credentialRef
    || typeof value.sourceText !== "string" || value.sourceText.length === 0) throw new Error("MEDIA_SNAPSHOT_MISMATCH");
  const dialogue = value.dialogue;
  if (!dialogue || typeof dialogue !== "object") throw new Error("ELEVENLABS_TTS_DIALOGUE_INVALID");
  return value as unknown as RealMediaSnapshot;
}

function sanitize(text: string, secret: string): string {
  const clipped = text.length > 400 ? text.slice(0, 400) : text;
  return clipped.split(secret).join("[redacted]").replace(/\s+/g, " ").trim();
}

function observation(id: string): MediaProviderObservation {
  const responseHash = createHash("sha256").update(JSON.stringify({ id, state: "UNKNOWN", provider: ELEVENLABS_TTS_PROVIDER_KEY, model: ELEVENLABS_TTS_MODEL_ID })).digest("hex");
  return { state: "UNKNOWN", responseHash, normalizedEventKey: "poll:" + responseHash, observedAt: new Date().toISOString(),
    metadata: { source: ELEVENLABS_TTS_PROVIDER_KEY, model: ELEVENLABS_TTS_MODEL_ID } };
}

export class ElevenLabsTtsAdapter implements MediaProviderAdapter {
  readonly providerKey = ELEVENLABS_TTS_PROVIDER_KEY;
  readonly #key: string;
  readonly #format: ElevenLabsTtsOutputFormat;
  readonly #language: string;
  constructor(readonly configuration: RealMediaConfiguration, key: string, private readonly transport: RealMediaHttpTransport = fetchRealMediaHttp) {
    this.#key = checkedSecret(key);
    this.configuration = Object.freeze({ ...structuredClone(configuration), parameters: Object.freeze(structuredClone(configuration.parameters)) });
    unsupportedParameter(configuration);
    if (configuration.providerKey !== ELEVENLABS_TTS_PROVIDER_KEY || configuration.capability !== "audio.tts"
      || configuration.region !== "global" || configuration.model !== ELEVENLABS_TTS_MODEL_ID) throw new Error("MEDIA_CONFIGURATION_UNSUPPORTED");
    this.#format = outputFormatOf(configuration);
    this.#language = languageOf(configuration);
  }
  capabilities(): readonly MediaCapability[] { return ["audio.tts"]; }
  async submit(input: MediaGenerationRequest): Promise<MediaSubmitResult> {
    if (!this.configuration.enabled) throw new Error("MEDIA_SUBMIT_DISABLED");
    const snapshot = frozenSnapshot(input, this.configuration);
    if (!snapshot.dialogue) throw new Error("ELEVENLABS_TTS_DIALOGUE_INVALID");
    const body = buildElevenLabsDialogueBody(snapshot.dialogue, this.#language);
    if (body.model_id !== "eleven_v4") throw new Error("ELEVENLABS_TTS_MODEL_MISMATCH");
    let id: string | undefined;
    try {
      const response = await this.transport({
        method: "POST", url: elevenLabsDialogueUrl(this.#format), timeoutMs: 180_000,
        maxResponseBytes: ELEVENLABS_TTS_MAX_RESPONSE_BYTES,
        headers: { "xi-api-key": this.#key, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      id = requestId(response.headers["request-id"], this.#key) ?? requestId(response.headers["xi-request-id"], this.#key);
      const refusal = definiteRefusal(response, id, this.#key, this.#format);
      if (refusal) return refusal;
      if (response.status !== 200 || !id) throw new MediaSubmissionUnknownError(id);
      const parsed = parseJson(response);
      const audio = decodeAudio(parsed.audio_base64, this.#format);
      let aligned: ParsedDialogueAlignment;
      try { aligned = parseDialogueAlignment(body.inputs, parsed); }
      catch (error) {
        if (error instanceof ElevenLabsTtsAlignmentError) {
          return { kind: "failed", retryable: false, providerRequestId: id, errorCode: error.code,
            errorMessage: "eleven_v4 returned audio without usable alignment; no subtitle timings were invented and the request was not replaced." };
        }
        throw new MediaSubmissionUnknownError(id);
      }
      const mime = this.#format === "wav_44100" ? "audio/wav" : "audio/L16";
      const output: MediaProviderOutput = {
        kind: "AUDIO", mimeTypeHint: mime,
        retrieval: { kind: "URI", uri: `data:${mime};rate=44100;base64,${Buffer.from(audio).toString("base64")}` },
        metadata: {
          provider: ELEVENLABS_TTS_PROVIDER_KEY, model: "eleven_v4", outputFormat: this.#format,
          voiceIds: body.inputs.map((line) => line.voice_id), voiceSegments: aligned.voiceSegments,
          alignment: aligned.alignment, normalizedAlignment: aligned.normalizedAlignment,
          inputCount: body.inputs.length, singleExternalOperation: true, dryDialogue: true,
        },
      };
      const characters = headerCharacters(response.headers["x-character-count"]);
      return { kind: "succeeded", providerRequestId: id, outputs: [output],
        accounting: { provider: ELEVENLABS_TTS_PROVIDER_KEY, model: "eleven_v4",
          ...(characters === undefined ? {} : { usage: { characters } }), costs: [] } };
    } catch (error) {
      if (error instanceof MediaSubmissionUnknownError) throw error;
      throw new MediaSubmissionUnknownError(id);
    }
  }
  async inspect(id: string): Promise<MediaProviderObservation> {
    if (!requestId(id, this.#key)) throw new Error("MEDIA_REQUEST_ID_INVALID");
    return observation(id);
  }
  async resolveOutput(output: MediaProviderOutput): Promise<MediaResolvedOutput> {
    const mime = this.#format === "wav_44100" ? "audio/wav" : "audio/L16";
    if (output.kind !== "AUDIO" || output.retrieval.kind !== "URI"
      || !output.retrieval.uri.startsWith(`data:${mime};rate=44100;base64,`)) throw new Error("MEDIA_OUTPUT_INVALID");
    const encoded = output.retrieval.uri.slice(`data:${mime};rate=44100;base64,`.length);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > Math.ceil(ELEVENLABS_TTS_MAX_RESPONSE_BYTES / 3) * 4) {
      throw new Error("MEDIA_OUTPUT_INVALID");
    }
    return { uri: output.retrieval.uri };
  }
}

function parseJson(response: RealMediaHttpResponse): Record<string, unknown> {
  try { return record(JSON.parse(Buffer.from(response.bytes).toString("utf8"))); }
  catch { throw new Error("ELEVENLABS_TTS_RESPONSE_INVALID"); }
}
function decodeAudio(value: unknown, format: ElevenLabsTtsOutputFormat): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("ELEVENLABS_TTS_AUDIO_INVALID");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== value) throw new Error("ELEVENLABS_TTS_AUDIO_INVALID");
  if (format === "wav_44100" && bytes.subarray(0, 4).toString("ascii") !== "RIFF") throw new Error("ELEVENLABS_TTS_AUDIO_INVALID");
  return bytes;
}
function headerCharacters(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
function definiteRefusal(response: RealMediaHttpResponse, id: string | undefined, secret: string, format: ElevenLabsTtsOutputFormat): MediaSubmitResult | null {
  if (![400, 401, 402, 403, 404, 413, 422, 429].includes(response.status)) return null;
  const detail = sanitize(Buffer.from(response.bytes).toString("utf8"), secret);
  return { kind: "failed", retryable: false, errorCode: "ELEVENLABS_TTS_REJECTED",
    errorMessage: `eleven_v4 ${format} was rejected (HTTP ${response.status}) and was not replaced. ${detail}`.trim(),
    ...(id ? { providerRequestId: id } : {}) };
}
