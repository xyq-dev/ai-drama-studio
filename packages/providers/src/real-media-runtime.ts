import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { RealMediaCapability, RealMediaConfiguration, SpeechCapabilities } from "@ai-drama/contracts";
import { ElevenLabsTtsAdapter } from "./elevenlabs-tts-adapter";
import {
  DashScopeMediaAdapter, ElevenLabsMusicAdapter, OpenAiImageAdapter, canonicalOpenAiImageBaseUrl,
  OPENAI_IMAGE_MODEL_ID, OPENAI_IMAGE_QUALITY, OPENAI_IMAGE_SIZE, type RealMediaHttpTransport,
} from "./real-media-adapters";
import type { MediaProviderAdapter, MediaProviderOutput } from "./media-adapter";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const VERSION = /^[A-Za-z0-9_.-]{1,100}$/;
const AMOUNT = /^(0|[1-9]\d{0,7})(\.\d{1,8})?$/;
const LIMIT = 12 * 1024 * 1024;
export const REAL_MEDIA_ENV_KEYS = [
  "REAL_MEDIA_ENABLED", "REAL_MEDIA_ALLOW_PRODUCTION", "REAL_MEDIA_PRICE_VERSION",
  "REAL_MEDIA_RECEIPT_KEY", "REAL_MEDIA_RECEIPT_KEY_VERSION", "REAL_MEDIA_PREVIOUS_RECEIPT_KEY", "REAL_MEDIA_PREVIOUS_RECEIPT_KEY_VERSION",
  "DASHSCOPE_MEDIA_API_KEY", "DASHSCOPE_MEDIA_CREDENTIAL_VERSION", "DASHSCOPE_MEDIA_PREVIOUS_API_KEY", "DASHSCOPE_MEDIA_PREVIOUS_CREDENTIAL_VERSION",
  "DASHSCOPE_MEDIA_PRICE_IMAGE", "DASHSCOPE_MEDIA_PRICE_VIDEO_SECOND", "DASHSCOPE_MEDIA_PRICE_TTS_CHARACTER", "DASHSCOPE_MEDIA_VIDEO_SECONDS",
  "ELEVENLABS_MEDIA_API_KEY", "ELEVENLABS_MEDIA_CREDENTIAL_VERSION", "ELEVENLABS_MEDIA_PREVIOUS_API_KEY", "ELEVENLABS_MEDIA_PREVIOUS_CREDENTIAL_VERSION",
  "ELEVENLABS_MEDIA_PRICE_MUSIC_SECOND", "ELEVENLABS_MEDIA_MUSIC_SECONDS",
  "ELEVENLABS_TTS_API_KEY", "ELEVENLABS_TTS_CREDENTIAL_VERSION", "ELEVENLABS_TTS_PREVIOUS_API_KEY", "ELEVENLABS_TTS_PREVIOUS_CREDENTIAL_VERSION",
  "ELEVENLABS_TTS_PRICE_CHARACTER", "ELEVENLABS_TTS_OUTPUT_FORMAT",
  "OPENAI_MEDIA_API_KEY", "OPENAI_MEDIA_CREDENTIAL_VERSION", "OPENAI_MEDIA_PREVIOUS_API_KEY", "OPENAI_MEDIA_PREVIOUS_CREDENTIAL_VERSION",
  "OPENAI_MEDIA_PRICE_IMAGE", "OPENAI_BASE_URL", "OPENAI_API_BASE", "REAL_MEDIA_IMAGE_PROVIDER",
  "REAL_MEDIA_MAX_SINGLE_CNY", "REAL_MEDIA_MAX_SINGLE_USD",
] as const;
export type RealMediaEnvironment = Partial<Record<(typeof REAL_MEDIA_ENV_KEYS)[number], string>>;
export class RealMediaEnvironmentError extends Error {
  constructor(readonly fields: readonly string[]) { super("Invalid media configuration: " + fields.join(", ")); this.name = "RealMediaEnvironmentError"; }
}
function validKey(value: string | undefined): boolean { return value !== undefined && value.length >= 8 && value.length <= 512 && !/\s/.test(value); }
function decodedKey(value: string | undefined): Buffer | null {
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.length === 32 && bytes.toString("base64") === value ? bytes : null;
}
/** Process wins, including empty values. Production permission and secrets are process-only. */
export function loadRealMediaEnvironment(processEnv: Record<string, string | undefined>, fileEnv: Record<string, string> = {}): RealMediaEnvironment {
  const result: RealMediaEnvironment = {};
  const errors: string[] = [];
  for (const name of REAL_MEDIA_ENV_KEYS) {
    const processOnly = /API_KEY|RECEIPT_KEY/.test(name) || name === "REAL_MEDIA_ALLOW_PRODUCTION"
      || name === "OPENAI_BASE_URL" || name === "OPENAI_API_BASE" || name === "REAL_MEDIA_IMAGE_PROVIDER";
    const value = processEnv[name] !== undefined ? processEnv[name] : processOnly ? undefined : fileEnv[name];
    if (value !== undefined) result[name] = value;
  }
  for (const name of ["REAL_MEDIA_ENABLED", "REAL_MEDIA_ALLOW_PRODUCTION"] as const) {
    if (result[name] !== undefined && !["true", "false"].includes(result[name]!)) errors.push(name);
  }
  for (const name of REAL_MEDIA_ENV_KEYS) {
    const value = result[name]; if (value === undefined) continue;
    if (value === "") {
      if (/VERSION$|MAX_SINGLE/.test(name) || name === "OPENAI_BASE_URL" || name === "OPENAI_API_BASE" || name === "REAL_MEDIA_IMAGE_PROVIDER") errors.push(name);
      continue;
    }
    if (/API_KEY$/.test(name) && !validKey(value)) errors.push(name);
    if (/RECEIPT_KEY$/.test(name) && !decodedKey(value)) errors.push(name);
    if (/VERSION$/.test(name) && !VERSION.test(value)) errors.push(name);
    if ((/PRICE_/.test(name) && name !== "REAL_MEDIA_PRICE_VERSION" || /MAX_SINGLE/.test(name)) && (!AMOUNT.test(value) || Number(value) <= 0)) errors.push(name);
    if (name === "OPENAI_BASE_URL" || name === "OPENAI_API_BASE") {
      try { result[name] = canonicalOpenAiImageBaseUrl(value); }
      catch { errors.push(name); delete result[name]; }
    }
    if (name === "REAL_MEDIA_IMAGE_PROVIDER" && value !== "dashscope-media" && value !== "openai-media") errors.push(name);
  }
  if (result.OPENAI_BASE_URL && result.OPENAI_API_BASE && result.OPENAI_BASE_URL !== result.OPENAI_API_BASE) {
    errors.push("OPENAI_BASE_URL", "OPENAI_API_BASE");
  }
  for (const [name, min, max] of [["DASHSCOPE_MEDIA_VIDEO_SECONDS", 2, 15], ["ELEVENLABS_MEDIA_MUSIC_SECONDS", 3, 90]] as const) {
    const value = result[name];
    if (value !== undefined && (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max)) errors.push(name);
  }
  const speechFormat = result.ELEVENLABS_TTS_OUTPUT_FORMAT;
  if (speechFormat !== undefined && speechFormat !== "pcm_44100" && speechFormat !== "wav_44100") errors.push("ELEVENLABS_TTS_OUTPUT_FORMAT");
  if (errors.length) throw new RealMediaEnvironmentError([...new Set(errors)]);
  return result;
}
export interface RealMediaReceiptCipher { seal(value: unknown): string; open(ciphertext: string): unknown }
export function createRealMediaReceiptCipher(environment: RealMediaEnvironment): RealMediaReceiptCipher | undefined {
  const current = decodedKey(environment.REAL_MEDIA_RECEIPT_KEY);
  if (!current) return undefined;
  const currentVersion = environment.REAL_MEDIA_RECEIPT_KEY_VERSION ?? "v1";
  const keys = new Map<string, Buffer>([[currentVersion, current]]);
  const previous = decodedKey(environment.REAL_MEDIA_PREVIOUS_RECEIPT_KEY), previousVersion = environment.REAL_MEDIA_PREVIOUS_RECEIPT_KEY_VERSION;
  if (previous && previousVersion) {
    if (previousVersion === currentVersion) throw new RealMediaEnvironmentError(["REAL_MEDIA_PREVIOUS_RECEIPT_KEY_VERSION"]);
    keys.set(previousVersion, previous);
  }
  const failure = () => new Error("REAL_MEDIA_RECEIPT_UNAVAILABLE");
  return {
    seal(value) {
      const text = JSON.stringify(value);
      if (typeof text !== "string" || Buffer.byteLength(text) > LIMIT) throw failure();
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", current, iv);
      cipher.setAAD(Buffer.from("ads.real-media.receipt.v1:" + currentVersion));
      const payload = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return JSON.stringify({ schema: "ads.real-media.sealed.v1", keyVersion: currentVersion,
        iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), payload: payload.toString("base64") });
    },
    open(ciphertext) {
      try {
        if (typeof ciphertext !== "string" || Buffer.byteLength(ciphertext) > LIMIT * 1.5 + 1024) throw failure();
        const value = JSON.parse(ciphertext) as Record<string, unknown>;
        if (Object.keys(value).sort().join(",") !== "iv,keyVersion,payload,schema,tag"
          || value.schema !== "ads.real-media.sealed.v1" || typeof value.keyVersion !== "string"
          || typeof value.iv !== "string" || typeof value.tag !== "string" || typeof value.payload !== "string") throw failure();
        const key = keys.get(value.keyVersion); if (!key) throw failure();
        for (const field of ["iv", "tag", "payload"] as const) {
          const text = value[field] as string;
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || Buffer.from(text, "base64").toString("base64") !== text) throw failure();
        }
        const iv = Buffer.from(value.iv, "base64"), tag = Buffer.from(value.tag, "base64");
        if (iv.length !== 12 || tag.length !== 16) throw failure();
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAAD(Buffer.from("ads.real-media.receipt.v1:" + value.keyVersion));
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(Buffer.from(value.payload, "base64")), decipher.final()]);
        if (plaintext.length > LIMIT) throw failure();
        return JSON.parse(plaintext.toString("utf8")) as unknown;
      } catch { throw failure(); }
    },
  };
}
/** Explicit image base. Conflicting aliases fail closed. An absent value does not invent api.openai.com. */
export function openAiImageBaseUrl(environment: Pick<RealMediaEnvironment, "OPENAI_BASE_URL" | "OPENAI_API_BASE">): string | undefined {
  const read = (name: "OPENAI_BASE_URL" | "OPENAI_API_BASE") => {
    const value = environment[name];
    if (!value) return undefined;
    try { return canonicalOpenAiImageBaseUrl(value); }
    catch { throw new RealMediaEnvironmentError([name]); }
  };
  const primary = read("OPENAI_BASE_URL"), alias = read("OPENAI_API_BASE");
  if (primary && alias && primary !== alias) throw new RealMediaEnvironmentError(["OPENAI_BASE_URL", "OPENAI_API_BASE"]);
  return primary || alias;
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function uuidFor(value: unknown): string {
  const hex = digest(value);
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-4" + hex.slice(13, 16) + "-8" + hex.slice(17, 20) + "-" + hex.slice(20, 32);
}
/** Secrets are held only inside this server instance. Public capabilities/quotes never expose this object. */
export class ServerRealMediaRuntime {
  readonly enabled: boolean;
  readonly receiptCipher: RealMediaReceiptCipher | undefined;
  readonly #credentials = new Map<string, string>();
  readonly #environment: RealMediaEnvironment;
  constructor(private readonly workspaceId: string, environment: RealMediaEnvironment,
    allowed: boolean, private readonly transport?: RealMediaHttpTransport) {
    this.#environment = { ...environment };
    if (!UUID.test(workspaceId)) throw new RealMediaEnvironmentError(["APP_WORKSPACE_ID"]);
    this.receiptCipher = createRealMediaReceiptCipher(environment);
    this.enabled = allowed && environment.REAL_MEDIA_ENABLED === "true" && Boolean(this.receiptCipher);
    for (const [provider, prefix] of [["dashscope-media", "DASHSCOPE_MEDIA"], ["elevenlabs-media", "ELEVENLABS_MEDIA"], ["elevenlabs-tts", "ELEVENLABS_TTS"], ["openai-media", "OPENAI_MEDIA"]] as const) {
      const read = (suffix: string) => environment[(prefix + suffix) as keyof RealMediaEnvironment];
      if (validKey(read("_API_KEY"))) this.#credentials.set(provider + ":" + (read("_CREDENTIAL_VERSION") ?? "v1"), read("_API_KEY")!);
      if (validKey(read("_PREVIOUS_API_KEY")) && read("_PREVIOUS_CREDENTIAL_VERSION")) {
        const previousVersion = read("_PREVIOUS_CREDENTIAL_VERSION")!;
        if (previousVersion === (read("_CREDENTIAL_VERSION") ?? "v1")) throw new RealMediaEnvironmentError([prefix + "_PREVIOUS_CREDENTIAL_VERSION"]);
        this.#credentials.set(provider + ":" + previousVersion, read("_PREVIOUS_API_KEY")!);
      }
    }
  }
  async configurationFor(capability: RealMediaCapability): Promise<RealMediaConfiguration | null> {
    if (!this.enabled) return null;
    const imageProvider = this.#environment.REAL_MEDIA_IMAGE_PROVIDER ?? "dashscope-media";
    if (imageProvider !== "dashscope-media" && imageProvider !== "openai-media") throw new RealMediaEnvironmentError(["REAL_MEDIA_IMAGE_PROVIDER"]);
    const openaiImage = capability === "image.generate" && imageProvider === "openai-media";
    const music = capability === "audio.music";
    const providerKey = openaiImage ? "openai-media" : music ? "elevenlabs-media" : "dashscope-media";
    const credentialVersion = (openaiImage ? this.#environment.OPENAI_MEDIA_CREDENTIAL_VERSION
      : music ? this.#environment.ELEVENLABS_MEDIA_CREDENTIAL_VERSION : this.#environment.DASHSCOPE_MEDIA_CREDENTIAL_VERSION) ?? "v1";
    const price = openaiImage ? this.#environment.OPENAI_MEDIA_PRICE_IMAGE
      : ({ "image.generate": this.#environment.DASHSCOPE_MEDIA_PRICE_IMAGE,
        "video.generate": this.#environment.DASHSCOPE_MEDIA_PRICE_VIDEO_SECOND,
        "audio.tts": this.#environment.DASHSCOPE_MEDIA_PRICE_TTS_CHARACTER,
        "audio.music": this.#environment.ELEVENLABS_MEDIA_PRICE_MUSIC_SECOND })[capability];
    const baseUrl = openaiImage ? openAiImageBaseUrl(this.#environment) : undefined;
    // Missing sunburst config closes image.generate. It must not fall through to DashScope.
    if (openaiImage && !baseUrl) return null;
    if (!this.#credentials.has(providerKey + ":" + credentialVersion) || !price || !AMOUNT.test(price) || Number(price) <= 0
      || !this.#environment.REAL_MEDIA_PRICE_VERSION) return null;
    const usd = music || openaiImage;
    const base = { providerKey, capability, region: openaiImage ? new URL(baseUrl!).hostname : music ? "global" : "beijing",
      model: openaiImage ? OPENAI_IMAGE_MODEL_ID : ({ "image.generate": "qwen-image-3.0", "video.generate": "wan2.6-i2v-flash", "audio.tts": "qwen3-tts-flash", "audio.music": "music_v2" })[capability],
      credentialRef: "env:" + providerKey, credentialVersion, priceVersion: this.#environment.REAL_MEDIA_PRICE_VERSION,
      currency: usd ? "USD" as const : "CNY" as const, unitPrice: price,
      maximumOperationAmount: usd ? this.#environment.REAL_MEDIA_MAX_SINGLE_USD ?? "2" : this.#environment.REAL_MEDIA_MAX_SINGLE_CNY ?? "10",
      unitType: capability === "image.generate" ? "image" as const : capability === "audio.tts" ? "character" as const : "second" as const,
      parameters: openaiImage ? { baseUrl: baseUrl!, quality: OPENAI_IMAGE_QUALITY, size: OPENAI_IMAGE_SIZE }
        : { duration: Number(music ? this.#environment.ELEVENLABS_MEDIA_MUSIC_SECONDS ?? 5 : this.#environment.DASHSCOPE_MEDIA_VIDEO_SECONDS ?? 5),
          ...(capability === "audio.tts" ? { voice: "Cherry" } : {}) },
    };
    const version = "media-" + digest(base).slice(0, 24);
    return { ...base, id: uuidFor([this.workspaceId, providerKey, capability]), version, enabled: true, queryAllowed: true };
  }
  /** Scene speech. Independent of dashscope `audio.tts` and of `elevenlabs-media` music price/key. */
  async elevenLabsTtsConfiguration(): Promise<RealMediaConfiguration | null> {
    if (!this.enabled) return null;
    const providerKey = "elevenlabs-tts";
    const credentialVersion = this.#environment.ELEVENLABS_TTS_CREDENTIAL_VERSION ?? "v1";
    const price = this.#environment.ELEVENLABS_TTS_PRICE_CHARACTER;
    const outputFormat = this.#environment.ELEVENLABS_TTS_OUTPUT_FORMAT ?? "pcm_44100";
    if ((outputFormat !== "pcm_44100" && outputFormat !== "wav_44100")
      || !this.#credentials.has(providerKey + ":" + credentialVersion) || !price || !AMOUNT.test(price) || Number(price) <= 0
      || !this.#environment.REAL_MEDIA_PRICE_VERSION) return null;
    const base = { providerKey, capability: "audio.tts" as const, region: "global", model: "eleven_v4",
      credentialRef: "env:elevenlabs-tts", credentialVersion, priceVersion: this.#environment.REAL_MEDIA_PRICE_VERSION,
      currency: "USD" as const, unitPrice: price, maximumOperationAmount: this.#environment.REAL_MEDIA_MAX_SINGLE_USD ?? "2",
      unitType: "character" as const, parameters: { outputFormat, languageCode: "zh", dryDialogue: true } };
    const version = "media-" + digest(base).slice(0, 24);
    return { ...base, id: uuidFor([this.workspaceId, providerKey, "audio.tts"]), version, enabled: true, queryAllowed: true };
  }
  async adapterFor(configuration: RealMediaConfiguration, mode: "submit" | "query"): Promise<MediaProviderAdapter> {
    if (configuration.credentialRef !== "env:" + configuration.providerKey) throw new Error("REAL_MEDIA_CREDENTIAL_REFERENCE_INVALID");
    const key = this.#credentials.get(configuration.providerKey + ":" + configuration.credentialVersion);
    if (!key) throw new Error("REAL_MEDIA_CREDENTIAL_VERSION_UNAVAILABLE");
    if (mode === "submit") {
      const active = configuration.providerKey === "elevenlabs-tts"
        ? await this.elevenLabsTtsConfiguration() : await this.configurationFor(configuration.capability);
      if (!active || digest(active) !== digest(configuration)) throw new Error("REAL_MEDIA_CONFIGURATION_CHANGED");
    } else if (!configuration.queryAllowed) throw new Error("REAL_MEDIA_QUERY_DISABLED");
    const adapterConfiguration = mode === "query" ? { ...configuration, enabled: false } : configuration;
    const adapter = configuration.providerKey === "dashscope-media" ? new DashScopeMediaAdapter(adapterConfiguration, key, this.transport)
      : configuration.providerKey === "elevenlabs-media" ? new ElevenLabsMusicAdapter(adapterConfiguration, key, this.transport)
      : configuration.providerKey === "openai-media" ? new OpenAiImageAdapter(adapterConfiguration, key, this.transport)
      : configuration.providerKey === "elevenlabs-tts" ? new ElevenLabsTtsAdapter(adapterConfiguration, key, this.transport) : null;
    if (!adapter) throw new Error("REAL_MEDIA_PROVIDER_UNSUPPORTED");
    if (mode === "submit") return adapter;
    // Recovery receives an observation capability. It cannot turn a mutable flag back on and submit another job.
    return Object.freeze({ providerKey: adapter.providerKey, capabilities: () => adapter.capabilities(),
      submit: async () => { throw new Error("MEDIA_SUBMIT_DISABLED"); },
      inspect: (id: string) => adapter.inspect(id), resolveOutput: (output: MediaProviderOutput) => adapter.resolveOutput(output) });
  }
  async speechCatalog(): Promise<SpeechCapabilities> {
    const configuration = await this.configurationFor("audio.tts");
    if (!configuration) return { available: false, reasonCode: "SPEECH_PROVIDER_NOT_CONFIGURED", catalogVersion: "none", voices: [] };
    return { available: true, reasonCode: null, catalogVersion: "dashscope-voices.v1:" + configuration.version,
      voices: [["Cherry", "清亮女声"], ["Ethan", "清朗男声"], ["Serena", "活泼女声"]].map(([voiceId, name]) => ({
        catalogVoiceId: "dashscope:" + voiceId, name: name!, providerConfigurationId: configuration.id,
        providerConfigurationVersion: configuration.version, providerKey: configuration.providerKey, model: configuration.model,
        modelVersion: configuration.version, voiceId: voiceId!, locale: "zh-CN",
        rightsRef: "https://help.aliyun.com/zh/model-studio/multimodal-timbre-list",
        capabilities: { emotions: ["neutral"], speedMin: 1, speedMax: 1, maxTextCharacters: 600 },
      })) };
  }
}
