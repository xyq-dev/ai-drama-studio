import { createHash } from "node:crypto";
import type { RealMediaConfiguration, RealMediaSnapshot } from "@ai-drama/contracts";
import {
  MediaSubmissionUnknownError,
  type MediaCapability, type MediaGenerationRequest, type MediaProviderAdapter,
  type MediaProviderObservation, type MediaProviderOutput, type MediaResolvedOutput, type MediaSubmitResult,
} from "./media-adapter";

const DASH = "https://dashscope.aliyuncs.com";
const IMAGE = "/api/v1/services/aigc/image-generation/generation";
const VIDEO = "/api/v1/services/aigc/video-generation/video-synthesis";
const TTS = "/api/v1/services/aigc/multimodal-generation/generation";
const TASK = "/api/v1/tasks/";
const ID = /^[A-Za-z0-9_-]{1,200}$/;
const MAX_JSON = 1024 * 1024;
export const REAL_MUSIC_MAX_BYTES = 4 * 1024 * 1024;
export const DASHSCOPE_MEDIA_PROVIDER_KEY = "dashscope-media";
export const ELEVENLABS_MEDIA_PROVIDER_KEY = "elevenlabs-media";
export interface RealMediaHttpRequest {
  method: "GET" | "POST"; url: string; headers: Record<string, string>;
  body?: string; timeoutMs: number; maxResponseBytes: number;
}
export interface RealMediaHttpResponse { status: number; headers: Record<string, string>; bytes: Uint8Array }
export type RealMediaHttpTransport = (request: RealMediaHttpRequest) => Promise<RealMediaHttpResponse>;

/** One HTTP operation, no redirects or implicit retries. Keys never accompany output downloads. */
export const fetchRealMediaHttp: RealMediaHttpTransport = async (request) => {
  const response = await fetch(request.url, {
    method: request.method, headers: request.headers, ...(request.body === undefined ? {} : { body: request.body }),
    redirect: "error", signal: AbortSignal.timeout(request.timeoutMs),
  });
  const chunks: Uint8Array[] = [];
  let length = 0;
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > request.maxResponseBytes)) {
    await response.body?.cancel();
    throw new Error("MEDIA_RESPONSE_LIMIT");
  }
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > request.maxResponseBytes) {
          await reader.cancel();
          throw new Error("MEDIA_RESPONSE_LIMIT");
        }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
  }
  return { status: response.status, headers: Object.fromEntries(response.headers.entries()), bytes: Buffer.concat(chunks) };
};
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function json(response: RealMediaHttpResponse): Record<string, unknown> {
  if (response.bytes.byteLength > MAX_JSON) throw new Error("MEDIA_RESPONSE_LIMIT");
  return record(JSON.parse(Buffer.from(response.bytes).toString("utf8")));
}
function requestId(value: unknown, secret?: string): string | undefined {
  return typeof value === "string" && ID.test(value) && (!secret || !value.includes(secret)) ? value : undefined;
}
function usage(value: unknown): Record<string, number> {
  const allowed = new Set(["image_count", "input_image_count", "output_image_count", "image_tokens", "input_tokens",
    "output_tokens", "total_tokens", "video_duration", "output_video_duration", "duration", "seconds", "characters"]);
  return Object.fromEntries(Object.entries(record(value)).filter(([key, number]) =>
    allowed.has(key) && typeof number === "number" && Number.isFinite(number) && number >= 0)) as Record<string, number>;
}
function checkedSecret(value: string): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 512 || /\s/.test(value)) throw new Error("MEDIA_CREDENTIAL_UNAVAILABLE");
  return value;
}
function rejected(response: RealMediaHttpResponse, id?: string): MediaSubmitResult | null {
  // A timeout/409/5xx is not proof that the provider did not accept an operation.
  if (![400, 401, 402, 403, 404, 413, 422, 429].includes(response.status)) return null;
  return { kind: "failed", retryable: false, errorCode: "MEDIA_PROVIDER_REJECTED",
    errorMessage: "媒体服务拒绝了本次请求，请检查账号、输入或配额。", ...(id ? { providerRequestId: id } : {}) };
}
function snapshot(input: MediaGenerationRequest, configuration: RealMediaConfiguration): RealMediaSnapshot {
  const value = record(input.inputSnapshot);
  const frozen = record(value.configuration);
  if (value.schema !== "real-media.v1" || value.capability !== input.capability || input.capability !== configuration.capability
    || input.providerConfigurationId !== configuration.id || frozen.id !== configuration.id
    || frozen.version !== configuration.version || frozen.providerKey !== configuration.providerKey
    || frozen.model !== configuration.model || frozen.credentialVersion !== configuration.credentialVersion
    || frozen.region !== configuration.region || frozen.credentialRef !== configuration.credentialRef
    || typeof value.sourceText !== "string" || value.sourceText.length === 0) throw new Error("MEDIA_SNAPSHOT_MISMATCH");
  return value as unknown as RealMediaSnapshot;
}
function observation(id: string, state: "ACTIVE" | "UNKNOWN" | "CANCELED", providerKey: string, model: string): MediaProviderObservation {
  const responseHash = createHash("sha256").update(JSON.stringify({ id, state, providerKey, model })).digest("hex");
  return { state, responseHash, normalizedEventKey: "poll:" + responseHash, observedAt: new Date().toISOString(),
    metadata: { source: providerKey, model } };
}
function withOutputs(id: string, outputs: [MediaProviderOutput, ...MediaProviderOutput[]], providerKey: string, model: string,
  reportedUsage: Record<string, number>): MediaProviderObservation {
  const responseHash = createHash("sha256").update(JSON.stringify({ id, outputs, reportedUsage })).digest("hex");
  return { state: "SUCCEEDED", outputs, responseHash, normalizedEventKey: "poll:" + responseHash,
    observedAt: new Date().toISOString(), accounting: { provider: providerKey, model, usage: reportedUsage, costs: [] } };
}
/** Only the official result-bucket namespace. HTTP is upgraded before any request; never followed as plaintext. */
export function safeDashScopeMediaOutputUrl(value: unknown, secret?: string): string {
  if (typeof value !== "string" || value.length > 16_384) throw new Error("MEDIA_OUTPUT_URL_INVALID");
  if (secret && (value.includes(secret) || decodeURIComponent(value).includes(secret))) throw new Error("MEDIA_OUTPUT_URL_INVALID");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || (url.port && url.port !== "443")
    || !/^dashscope-result-[a-z0-9-]+\.oss-cn-[a-z0-9-]+\.aliyuncs\.com$/.test(url.hostname) || url.pathname === "/") {
    throw new Error("MEDIA_OUTPUT_URL_INVALID");
  }
  url.protocol = "https:";
  return url.toString();
}
function dashOutputs(capability: MediaCapability, value: Record<string, unknown>, secret: string): [MediaProviderOutput, ...MediaProviderOutput[]] {
  const output = record(value.output);
  if (capability === "audio.tts") return [{ kind: "AUDIO", mimeTypeHint: "audio/wav",
    retrieval: { kind: "URI", uri: safeDashScopeMediaOutputUrl(record(output.audio).url, secret) } }];
  if (capability === "video.generate") return [{ kind: "VIDEO", mimeTypeHint: "video/mp4",
    retrieval: { kind: "URI", uri: safeDashScopeMediaOutputUrl(output.video_url, secret) } }];
  const choices = output.choices;
  if (!Array.isArray(choices) || choices.length !== 1) throw new Error("MEDIA_IMAGE_OUTPUT_INVALID");
  const choice = record(choices[0]);
  if (choice.finish_reason !== "stop") throw new Error("MEDIA_IMAGE_OUTPUT_INVALID");
  const content = record(choice.message).content;
  if (!Array.isArray(content) || content.length !== 1) throw new Error("MEDIA_IMAGE_OUTPUT_INVALID");
  return [{ kind: "IMAGE", mimeTypeHint: "image/png", retrieval: { kind: "URI", uri: safeDashScopeMediaOutputUrl(record(content[0]).image, secret) } }];
}

export class DashScopeMediaAdapter implements MediaProviderAdapter {
  readonly providerKey = DASHSCOPE_MEDIA_PROVIDER_KEY;
  readonly #key: string;
  constructor(readonly configuration: RealMediaConfiguration, key: string, private readonly transport: RealMediaHttpTransport = fetchRealMediaHttp) {
    this.#key = checkedSecret(key);
    // A bound adapter must retain the exact budgeted profile even if its caller later edits the source object.
    this.configuration = Object.freeze({ ...structuredClone(configuration), parameters: Object.freeze(structuredClone(configuration.parameters)) });
    const model = { "image.generate": "qwen-image-3.0", "video.generate": "wan2.6-i2v-flash", "audio.tts": "qwen3-tts-flash" } as Record<string, string>;
    if (configuration.providerKey !== this.providerKey || configuration.region !== "beijing" || model[configuration.capability] !== configuration.model) {
      throw new Error("MEDIA_CONFIGURATION_UNSUPPORTED");
    }
  }
  capabilities(): readonly MediaCapability[] { return [this.configuration.capability]; }
  async submit(input: MediaGenerationRequest): Promise<MediaSubmitResult> {
    if (!this.configuration.enabled) throw new Error("MEDIA_SUBMIT_DISABLED");
    const frozen = snapshot(input, this.configuration);
    const parameters = this.configuration.parameters;
    let path: string, body: unknown;
    if (input.capability === "image.generate") {
      if (frozen.sourceText.length > 2000) throw new Error("MEDIA_PROMPT_LIMIT");
      path = IMAGE;
      body = { model: this.configuration.model, input: { messages: [{ role: "user", content: [{ text: frozen.sourceText }] }] },
        parameters: { n: 1, size: "720*1280", watermark: true, seed: 20261101 } };
    } else if (input.capability === "video.generate") {
      const image = input.resolvedSourceImage;
      const duration = Number(parameters.duration ?? 5);
      if (!image || !frozen.sourceImage || !["image/png", "image/jpeg"].includes(image.mimeType)
        || image.bytes.byteLength === 0 || image.bytes.byteLength > 10 * 1024 * 1024 || frozen.sourceText.length > 800
        || !Number.isInteger(duration) || duration < 2 || duration > 15) throw new Error("MEDIA_VIDEO_INPUT_INVALID");
      const digest = createHash("sha256").update(image.bytes).digest("hex");
      if (digest !== image.checksumSha256 || digest !== frozen.sourceImage.checksumSha256) throw new Error("MEDIA_SOURCE_IMAGE_CHANGED");
      path = VIDEO;
      body = { model: this.configuration.model, input: { prompt: frozen.sourceText,
        img_url: "data:" + image.mimeType + ";base64," + Buffer.from(image.bytes).toString("base64") },
        parameters: { resolution: "720P", duration, audio: false, prompt_extend: true, shot_type: "single", watermark: true, seed: 20261101 } };
    } else if (input.capability === "audio.tts") {
      const speech = frozen.speech;
      const text = speech?.spokenText ?? frozen.sourceText;
      const voice = speech?.voice.voiceId ?? parameters.voice ?? "Cherry";
      if (!["Cherry", "Ethan", "Serena"].includes(String(voice)) || [...text].length > 600
        || (speech && (speech.emotion !== "neutral" || speech.speed !== 1))) throw new Error("MEDIA_SPEECH_INPUT_INVALID");
      path = TTS;
      body = { model: this.configuration.model, input: { text, voice, language_type: "Chinese" } };
    } else throw new Error("MEDIA_CAPABILITY_UNSUPPORTED");
    let response: RealMediaHttpResponse, parsed: Record<string, unknown>, id: string | undefined;
    try {
      response = await this.transport({ method: "POST", url: DASH + path, body: JSON.stringify(body), timeoutMs: 120_000,
        maxResponseBytes: MAX_JSON, headers: { Authorization: "Bearer " + this.#key, "Content-Type": "application/json",
          ...(path === TTS ? {} : { "X-DashScope-Async": "enable" }) } });
      parsed = json(response);
      id = requestId(path === TTS ? parsed.request_id : record(parsed.output).task_id, this.#key);
      const refusal = rejected(response, requestId(parsed.request_id, this.#key));
      if (refusal) return refusal;
      if (response.status !== 200 || parsed.code) throw new MediaSubmissionUnknownError(id);
      if (!id) throw new MediaSubmissionUnknownError();
      if (path !== TTS) return { kind: "waiting", providerRequestId: id, nextPollAt: new Date(Date.now() + 5000).toISOString() };
      if (record(parsed.output).finish_reason !== "stop") throw new MediaSubmissionUnknownError(id);
      return { kind: "succeeded", providerRequestId: id, outputs: dashOutputs(input.capability, parsed, this.#key),
        accounting: { provider: this.providerKey, model: this.configuration.model, usage: usage(parsed.usage), costs: [] } };
    } catch { throw new MediaSubmissionUnknownError(id); }
  }
  async inspect(id: string): Promise<MediaProviderObservation> {
    if (!requestId(id, this.#key)) throw new Error("MEDIA_REQUEST_ID_INVALID");
    if (!this.configuration.queryAllowed || this.configuration.capability === "audio.tts") {
      return observation(id, "UNKNOWN", this.providerKey, this.configuration.model);
    }
    try {
      const response = await this.transport({ method: "GET", url: DASH + TASK + id, timeoutMs: 30_000, maxResponseBytes: MAX_JSON,
        headers: { Authorization: "Bearer " + this.#key } });
      const parsed = json(response), output = record(parsed.output);
      if (response.status !== 200 || output.task_id !== id) return observation(id, "UNKNOWN", this.providerKey, this.configuration.model);
      if (["PENDING", "RUNNING"].includes(String(output.task_status))) return observation(id, "ACTIVE", this.providerKey, this.configuration.model);
      if (output.task_status === "SUCCEEDED") return withOutputs(id, dashOutputs(this.configuration.capability, parsed, this.#key),
        this.providerKey, this.configuration.model, usage(parsed.usage));
      if (output.task_status === "CANCELED") return observation(id, "CANCELED", this.providerKey, this.configuration.model);
      if (output.task_status === "FAILED") {
        const responseHash = createHash("sha256").update(id + ":FAILED").digest("hex");
        return { state: "FAILED", retryable: false, errorCode: "MEDIA_REMOTE_FAILED", errorMessage: "媒体服务报告原任务失败。",
          responseHash, normalizedEventKey: "poll:" + responseHash, observedAt: new Date().toISOString() };
      }
    } catch { /* Queries are observations; a failed query never grants another submit. */ }
    return observation(id, "UNKNOWN", this.providerKey, this.configuration.model);
  }
  async resolveOutput(output: MediaProviderOutput): Promise<MediaResolvedOutput> {
    if (output.retrieval.kind !== "URI") throw new Error("MEDIA_OUTPUT_INVALID");
    return { uri: safeDashScopeMediaOutputUrl(output.retrieval.uri, this.#key) };
  }
}

export class ElevenLabsMusicAdapter implements MediaProviderAdapter {
  readonly providerKey = ELEVENLABS_MEDIA_PROVIDER_KEY;
  readonly #key: string;
  constructor(readonly configuration: RealMediaConfiguration, key: string, private readonly transport: RealMediaHttpTransport = fetchRealMediaHttp) {
    this.#key = checkedSecret(key);
    // A bound adapter must retain the exact budgeted profile even if its caller later edits the source object.
    this.configuration = Object.freeze({ ...structuredClone(configuration), parameters: Object.freeze(structuredClone(configuration.parameters)) });
    if (configuration.providerKey !== this.providerKey || configuration.capability !== "audio.music"
      || configuration.region !== "global" || configuration.model !== "music_v2") throw new Error("MEDIA_CONFIGURATION_UNSUPPORTED");
  }
  capabilities(): readonly MediaCapability[] { return ["audio.music"]; }
  async submit(input: MediaGenerationRequest): Promise<MediaSubmitResult> {
    if (!this.configuration.enabled) throw new Error("MEDIA_SUBMIT_DISABLED");
    const frozen = snapshot(input, this.configuration);
    const duration = Number(this.configuration.parameters.duration ?? 5);
    if (!Number.isInteger(duration) || duration < 3 || duration > 90 || frozen.sourceText.length > 4100) throw new Error("MEDIA_MUSIC_INPUT_INVALID");
    let id: string | undefined;
    try {
      const response = await this.transport({ method: "POST",
        url: "https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128", timeoutMs: 180_000,
        maxResponseBytes: REAL_MUSIC_MAX_BYTES, headers: { "xi-api-key": this.#key, "Content-Type": "application/json" },
        body: JSON.stringify({ model_id: "music_v2", prompt: frozen.sourceText, music_length_ms: duration * 1000, force_instrumental: true }) });
      id = requestId(response.headers["song-id"], this.#key) ?? requestId(response.headers["request-id"], this.#key);
      const refusal = rejected(response, id);
      if (refusal) return refusal;
      if (response.status !== 200 || !id || response.bytes.byteLength === 0 || response.bytes.byteLength > REAL_MUSIC_MAX_BYTES
        || !(response.headers["content-type"] ?? "").toLowerCase().startsWith("audio/")) throw new MediaSubmissionUnknownError(id);
      return { kind: "succeeded", providerRequestId: id,
        outputs: [{ kind: "MUSIC", mimeTypeHint: "audio/mpeg", retrieval: { kind: "URI",
          uri: "data:audio/mpeg;base64," + Buffer.from(response.bytes).toString("base64") } }],
        accounting: { provider: this.providerKey, model: "music_v2", costs: [] } };
    } catch { throw new MediaSubmissionUnknownError(id); }
  }
  async inspect(id: string): Promise<MediaProviderObservation> {
    if (!requestId(id, this.#key)) throw new Error("MEDIA_REQUEST_ID_INVALID");
    return observation(id, "UNKNOWN", this.providerKey, "music_v2");
  }
  async resolveOutput(output: MediaProviderOutput): Promise<MediaResolvedOutput> {
    if (output.kind !== "MUSIC" || output.retrieval.kind !== "URI"
      || !/^data:audio\/mpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(output.retrieval.uri)
      || output.retrieval.uri.length > Math.ceil(REAL_MUSIC_MAX_BYTES / 3) * 4 + 32) throw new Error("MEDIA_OUTPUT_INVALID");
    return { uri: output.retrieval.uri };
  }
}
