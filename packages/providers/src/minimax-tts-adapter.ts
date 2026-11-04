import { createHash } from "node:crypto";
import type { MiniMaxSpeechBlock, RealMediaConfiguration, RealMediaSnapshot } from "@ai-drama/contracts";
import {
  MediaSubmissionUnknownError,
  type MediaCapability, type MediaGenerationRequest, type MediaProviderAdapter,
  type MediaProviderObservation, type MediaProviderOutput, type MediaResolvedOutput, type MediaSubmitResult,
} from "./media-adapter";
import { type RealMediaHttpResponse, type RealMediaHttpTransport, fetchRealMediaHttp } from "./real-media-adapters";

export const MINIMAX_TTS_PROVIDER_KEY = "minimax-tts";
export const MINIMAX_TTS_MODEL_ID = "speech-2.8-hd";
export const MINIMAX_TTS_SPEECH_SCHEMA = "minimax-tts.speech.v1";
export const MINIMAX_TTS_DEFAULT_BASE_URL = "https://api.minimaxi.com";
export const MINIMAX_TTS_OUTPUT_FORMATS = ["wav", "pcm"] as const;
export type MiniMaxTtsOutputFormat = (typeof MINIMAX_TTS_OUTPUT_FORMATS)[number];
export const MINIMAX_TTS_SAMPLE_RATE = 44100;
export const MINIMAX_TTS_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
export const MINIMAX_TTS_MAX_SPOKEN_CHARACTERS = 10_000;
export const MINIMAX_TTS_INSUFFICIENT_BALANCE = "MINIMAX_TTS_INSUFFICIENT_BALANCE";
export const MINIMAX_TTS_INVALID_API_KEY = "MINIMAX_TTS_INVALID_API_KEY";
export const MINIMAX_TTS_REJECTED = "MINIMAX_TTS_REJECTED";

const ID = /^[A-Za-z0-9_-]{1,200}$/;
const VOICE = /^[A-Za-z0-9_:-]{1,256}$/;
const SSML = /<\s*\/?\s*(speak|break|prosody|phoneme|emphasis|lang)\b/i;
const DEFINITE_HTTP = [400, 401, 402, 403, 404, 413, 422, 429];
const DEFINITE_STATUS = new Set([1004, 1026, 1027, 1039, 1042, 2013]);
const BLOCKED_HOST = /(^|\.)((elevenlabs\.io)|(dashscope\.com)|(aliyuncs\.com)|(openai\.com))$/i;

interface T2aRequestBody {
  model: "speech-2.8-hd";
  text: string;
  stream: false;
  output_format: "hex";
  voice_setting: { voice_id: string; speed: 1; vol: 1; pitch: 0 };
  audio_setting: { sample_rate: 44100; format: MiniMaxTtsOutputFormat; channel: 1 };
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
function header(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === wanted) return value;
  return undefined;
}

/** Domestic origin, or another explicit https origin. Other TTS hosts are rejected. */
export function canonicalMiniMaxTtsBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("MINIMAX_TTS_BASE_URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("MINIMAX_TTS_BASE_URL");
  if (url.pathname !== "/" && url.pathname !== "") throw new Error("MINIMAX_TTS_BASE_URL");
  if (url.port && url.port !== "443") throw new Error("MINIMAX_TTS_BASE_URL");
  if (BLOCKED_HOST.test(url.hostname)) throw new Error("MINIMAX_TTS_BASE_URL");
  return url.origin;
}

export function miniMaxT2aUrl(baseUrl: string): string {
  return `${canonicalMiniMaxTtsBaseUrl(baseUrl)}/v1/t2a_v2`;
}

function outputFormatOf(configuration: RealMediaConfiguration): MiniMaxTtsOutputFormat {
  const format = configuration.parameters.outputFormat;
  if (format !== "wav" && format !== "pcm") throw new Error("MEDIA_CONFIGURATION_UNSUPPORTED");
  return format;
}

/** One non-streaming t2a_v2 body. Neutral voice settings are fixed; the model cannot be swapped. */
export function buildMiniMaxT2aBody(speech: MiniMaxSpeechBlock, format: MiniMaxTtsOutputFormat): T2aRequestBody {
  if (speech.schema !== MINIMAX_TTS_SPEECH_SCHEMA) throw new Error("MINIMAX_TTS_SPEECH_INVALID");
  if (typeof speech.text !== "string" || !speech.text.trim()) throw new Error("MINIMAX_TTS_SPEECH_INVALID");
  if ([...speech.text].length > MINIMAX_TTS_MAX_SPOKEN_CHARACTERS) throw new Error("MINIMAX_TTS_TEXT_LIMIT");
  if (SSML.test(speech.text) || !VOICE.test(speech.voiceId)) throw new Error("MINIMAX_TTS_UNSUPPORTED_CONTROL");
  return {
    model: "speech-2.8-hd",
    text: speech.text,
    stream: false,
    output_format: "hex",
    voice_setting: { voice_id: speech.voiceId, speed: 1, vol: 1, pitch: 0 },
    audio_setting: { sample_rate: MINIMAX_TTS_SAMPLE_RATE, format, channel: 1 },
  };
}

function frozenSnapshot(input: MediaGenerationRequest, configuration: RealMediaConfiguration, baseUrl: string, format: MiniMaxTtsOutputFormat): RealMediaSnapshot {
  const value = record(input.inputSnapshot);
  const frozen = record(value.configuration);
  const frozenParameters = record(frozen.parameters);
  if (value.schema !== "real-media.v1" || value.capability !== "audio.tts" || input.capability !== "audio.tts"
    || input.providerConfigurationId !== configuration.id || frozen.id !== configuration.id
    || frozen.version !== configuration.version || frozen.providerKey !== MINIMAX_TTS_PROVIDER_KEY
    || frozen.model !== MINIMAX_TTS_MODEL_ID || frozen.credentialVersion !== configuration.credentialVersion
    || frozen.region !== configuration.region || frozen.credentialRef !== configuration.credentialRef
    || frozenParameters.outputFormat !== format || frozenParameters.sampleRate !== MINIMAX_TTS_SAMPLE_RATE
    || frozenParameters.baseUrl !== baseUrl
    || typeof value.sourceText !== "string" || value.sourceText.length === 0) throw new Error("MEDIA_SNAPSHOT_MISMATCH");
  if (value.dialogue !== undefined) throw new Error("MEDIA_SNAPSHOT_MISMATCH");
  const speech = value.minimaxSpeech;
  if (!speech || typeof speech !== "object") throw new Error("MINIMAX_TTS_SPEECH_INVALID");
  return value as unknown as RealMediaSnapshot;
}

function sanitize(text: string, secret: string): string {
  const clipped = text.length > 400 ? text.slice(0, 400) : text;
  return clipped.split(secret).join("[redacted]").replace(/\s+/g, " ").trim();
}

function observation(id: string): MediaProviderObservation {
  const responseHash = createHash("sha256").update(JSON.stringify({ id, state: "UNKNOWN", provider: MINIMAX_TTS_PROVIDER_KEY, model: MINIMAX_TTS_MODEL_ID })).digest("hex");
  return {
    state: "UNKNOWN", responseHash, normalizedEventKey: "poll:" + responseHash, observedAt: new Date().toISOString(),
    metadata: { source: MINIMAX_TTS_PROVIDER_KEY, model: MINIMAX_TTS_MODEL_ID },
  };
}

export class MiniMaxTtsAdapter implements MediaProviderAdapter {
  readonly providerKey = MINIMAX_TTS_PROVIDER_KEY;
  readonly #key: string;
  readonly #format: MiniMaxTtsOutputFormat;
  readonly #baseUrl: string;
  constructor(readonly configuration: RealMediaConfiguration, key: string, private readonly transport: RealMediaHttpTransport = fetchRealMediaHttp) {
    this.#key = checkedSecret(key);
    this.configuration = Object.freeze({ ...structuredClone(configuration), parameters: Object.freeze(structuredClone(configuration.parameters)) });
    if (configuration.providerKey !== MINIMAX_TTS_PROVIDER_KEY || configuration.capability !== "audio.tts"
      || configuration.model !== MINIMAX_TTS_MODEL_ID) throw new Error("MEDIA_CONFIGURATION_UNSUPPORTED");
    this.#format = outputFormatOf(configuration);
    if (configuration.parameters.sampleRate !== MINIMAX_TTS_SAMPLE_RATE) throw new Error("MEDIA_CONFIGURATION_UNSUPPORTED");
    const baseUrl = configuration.parameters.baseUrl;
    if (typeof baseUrl !== "string") throw new Error("MEDIA_CONFIGURATION_UNSUPPORTED");
    this.#baseUrl = canonicalMiniMaxTtsBaseUrl(baseUrl);
    if (baseUrl !== this.#baseUrl || configuration.region !== new URL(this.#baseUrl).hostname) throw new Error("MEDIA_CONFIGURATION_UNSUPPORTED");
  }
  capabilities(): readonly MediaCapability[] { return ["audio.tts"]; }
  async submit(input: MediaGenerationRequest): Promise<MediaSubmitResult> {
    if (!this.configuration.enabled) throw new Error("MEDIA_SUBMIT_DISABLED");
    const snapshot = frozenSnapshot(input, this.configuration, this.#baseUrl, this.#format);
    if (!snapshot.minimaxSpeech) throw new Error("MINIMAX_TTS_SPEECH_INVALID");
    if (snapshot.minimaxSpeech.text !== snapshot.sourceText) throw new Error("MEDIA_SNAPSHOT_MISMATCH");
    const body = buildMiniMaxT2aBody(snapshot.minimaxSpeech, this.#format);
    if (body.model !== "speech-2.8-hd") throw new Error("MINIMAX_TTS_MODEL_MISMATCH");
    const url = miniMaxT2aUrl(this.#baseUrl);
    let id: string | undefined;
    try {
      const response = await this.transport({
        method: "POST", url, timeoutMs: 180_000, maxResponseBytes: MINIMAX_TTS_MAX_RESPONSE_BYTES,
        headers: { Authorization: `Bearer ${this.#key}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      const payload = parseJson(response);
      id = payload ? traceOf(payload, response.headers, this.#key) : undefined;
      const refusal = definiteRefusal(response, payload, id, this.#key, this.#format, new URL(this.#baseUrl).hostname);
      if (refusal) return refusal;
      if (response.status !== 200 || !payload || statusCode(payload) !== 0 || !id) throw new MediaSubmissionUnknownError(id);
      const data = record(payload.data);
      if (data.status !== 2) throw new MediaSubmissionUnknownError(id);
      const extra = payload.extra_info == null ? null : record(payload.extra_info);
      if (extra && ((extra.audio_format !== undefined && extra.audio_format !== this.#format)
        || (extra.audio_sample_rate !== undefined && extra.audio_sample_rate !== MINIMAX_TTS_SAMPLE_RATE))) {
        throw new MediaSubmissionUnknownError(id);
      }
      const audio = decodeHexAudio(data.audio, this.#format);
      const mime = this.#format === "wav" ? "audio/wav" : "audio/L16";
      const output: MediaProviderOutput = {
        kind: "AUDIO", mimeTypeHint: mime,
        retrieval: { kind: "URI", uri: `data:${mime};rate=44100;base64,${Buffer.from(audio).toString("base64")}` },
        metadata: {
          provider: MINIMAX_TTS_PROVIDER_KEY, model: MINIMAX_TTS_MODEL_ID, outputFormat: this.#format,
          sampleRate: MINIMAX_TTS_SAMPLE_RATE, baseHost: new URL(this.#baseUrl).hostname,
          voiceId: body.voice_setting.voice_id, singleExternalOperation: true, fallbackProvider: null,
        },
      };
      const characters = usageCharacters(extra);
      return {
        kind: "succeeded", providerRequestId: id, outputs: [output],
        accounting: {
          provider: MINIMAX_TTS_PROVIDER_KEY, model: MINIMAX_TTS_MODEL_ID,
          ...(characters === undefined ? {} : { usage: { characters } }), costs: [],
        },
      };
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
    const mime = this.#format === "wav" ? "audio/wav" : "audio/L16";
    if (output.kind !== "AUDIO" || output.retrieval.kind !== "URI"
      || !output.retrieval.uri.startsWith(`data:${mime};rate=44100;base64,`)) throw new Error("MEDIA_OUTPUT_INVALID");
    const encoded = output.retrieval.uri.slice(`data:${mime};rate=44100;base64,`.length);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > Math.ceil(MINIMAX_TTS_MAX_RESPONSE_BYTES / 3) * 4) {
      throw new Error("MEDIA_OUTPUT_INVALID");
    }
    return { uri: output.retrieval.uri };
  }
}

function parseJson(response: RealMediaHttpResponse): Record<string, unknown> | null {
  try {
    const value = JSON.parse(Buffer.from(response.bytes).toString("utf8")) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
function statusCode(payload: Record<string, unknown>): number | undefined {
  const code = record(payload.base_resp).status_code;
  if (typeof code === "number" && Number.isInteger(code)) return code;
  if (typeof code === "string" && /^\d+$/.test(code)) return Number(code);
  return undefined;
}
function traceOf(payload: Record<string, unknown>, headers: Record<string, string>, secret: string): string | undefined {
  return requestId(payload.trace_id, secret) ?? requestId(header(headers, "trace-id"), secret);
}
function usageCharacters(extra: Record<string, unknown> | null): number | undefined {
  if (!extra) return undefined;
  const value = extra.usage_characters;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function decodeHexAudio(value: unknown, format: MiniMaxTtsOutputFormat): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(value)) throw new Error("MINIMAX_TTS_AUDIO_INVALID");
  const bytes = Buffer.from(value, "hex");
  if (bytes.length === 0 || bytes.toString("hex") !== value.toLowerCase()) throw new Error("MINIMAX_TTS_AUDIO_INVALID");
  if (format === "wav" && (bytes.length < 44 || bytes.subarray(0, 4).toString("ascii") !== "RIFF" || bytes.subarray(8, 12).toString("ascii") !== "WAVE")) {
    throw new Error("MINIMAX_TTS_AUDIO_INVALID");
  }
  return bytes;
}
function definiteRefusal(
  response: RealMediaHttpResponse, payload: Record<string, unknown> | null, id: string | undefined,
  secret: string, format: MiniMaxTtsOutputFormat, host: string,
): MediaSubmitResult | null {
  const code = payload ? statusCode(payload) : undefined;
  if (code !== 1008 && code !== 2049 && !DEFINITE_HTTP.includes(response.status) && (code === undefined || !DEFINITE_STATUS.has(code))) return null;
  const detail = sanitize(Buffer.from(response.bytes).toString("utf8"), secret);
  const errorCode = code === 1008 ? MINIMAX_TTS_INSUFFICIENT_BALANCE : code === 2049 ? MINIMAX_TTS_INVALID_API_KEY : MINIMAX_TTS_REJECTED;
  const errorMessage = code === 1008
    ? "MiniMax speech-2.8-hd was refused: insufficient balance (base_resp 1008). Payment is required before another synthesis. This call was not retried and was not sent to ElevenLabs or any other TTS provider."
    : code === 2049
      ? `MiniMax speech-2.8-hd was refused: invalid API key or wrong host (base_resp 2049). Use MINIMAX_API_KEY with https://api.minimaxi.com (configured host: ${host}). This call was not retried and was not sent to another TTS provider.`
      : `MiniMax speech-2.8-hd ${format} was rejected (HTTP ${response.status}, base_resp ${code ?? "none"}) and was not replaced. ${detail}`.trim();
  return { kind: "failed", retryable: false, errorCode, errorMessage: sanitize(errorMessage, secret), ...(id ? { providerRequestId: id } : {}) };
}
