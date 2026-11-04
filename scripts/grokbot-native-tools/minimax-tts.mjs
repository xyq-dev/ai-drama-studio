/**
 * Independent MiniMax t2a_v2 speech flow (model speech-2.8-hd).
 * Quote → human authorize → one receipt. UNKNOWN / INTENT are not resent.
 * ElevenLabs, DashScope, and music credentials are not fallbacks.
 * Unpaid tests inject a transport or pass --mock. This module does not open a socket by itself.
 */
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const MINIMAX_TTS_PROVIDER = "minimax-tts";
export const MINIMAX_TTS_MODEL = "speech-2.8-hd";
export const MINIMAX_TTS_DEFAULT_BASE_URL = "https://api.minimaxi.com";
const SCALE = 100_000_000n;
const VOICE = /^[A-Za-z0-9_:-]{1,256}$/;
const SSML = /<\s*\/?\s*(speak|break|prosody|phoneme|emphasis|lang)\b/i;
const BLOCKED_HOST = /(^|\.)((elevenlabs\.io)|(dashscope\.com)|(aliyuncs\.com)|(openai\.com))$/i;
const DEFINITE_HTTP = new Set([400, 401, 402, 403, 404, 413, 422, 429]);
const DEFINITE_STATUS = new Set([1004, 1026, 1027, 1039, 1042, 2013]);

export function canonicalMiniMaxBaseUrl(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error("MINIMAX_TTS_BASE_URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("MINIMAX_TTS_BASE_URL");
  if (url.pathname !== "/" && url.pathname !== "") throw new Error("MINIMAX_TTS_BASE_URL");
  if (url.port && url.port !== "443") throw new Error("MINIMAX_TTS_BASE_URL");
  if (BLOCKED_HOST.test(url.hostname)) throw new Error("MINIMAX_TTS_BASE_URL");
  return url.origin;
}

export function resolveMiniMaxSettings(env = {}) {
  const model = env.MINIMAX_TTS_MODEL || MINIMAX_TTS_MODEL;
  if (model !== MINIMAX_TTS_MODEL) throw new Error("MINIMAX_TTS_MODEL: only speech-2.8-hd; another model is not a fallback");
  const outputFormat = env.MINIMAX_TTS_OUTPUT_FORMAT || "wav";
  if (outputFormat !== "wav" && outputFormat !== "pcm") throw new Error("MINIMAX_TTS_OUTPUT_FORMAT: only wav or pcm");
  const sampleRate = env.MINIMAX_TTS_SAMPLE_RATE || "44100";
  if (sampleRate !== "44100") throw new Error("MINIMAX_TTS_SAMPLE_RATE: only 44100");
  const baseUrl = canonicalMiniMaxBaseUrl(env.MINIMAX_TTS_BASE_URL || MINIMAX_TTS_DEFAULT_BASE_URL);
  return { model, outputFormat, sampleRate: 44100, baseUrl };
}

export function resolveMiniMaxUnitPrice(env, explicit) {
  if (explicit) return String(explicit);
  if (env?.MINIMAX_TTS_PRICE_CHARACTER) return String(env.MINIMAX_TTS_PRICE_CHARACTER);
  throw new Error("MINIMAX_TTS_PRICE_UNCONFIGURED: set MINIMAX_TTS_PRICE_CHARACTER. ELEVENLABS_TTS_PRICE_CHARACTER and ELEVENLABS_MEDIA_PRICE_MUSIC_SECOND are not MiniMax prices");
}

export function resolveMiniMaxApiKey(env) {
  const key = env?.MINIMAX_API_KEY;
  if (!key) throw new Error("MINIMAX_API_KEY_MISSING: speech uses MINIMAX_API_KEY only; ELEVENLABS_TTS_API_KEY is not a MiniMax credential");
  if (typeof key !== "string" || key.length < 8 || key.length > 512 || /\s/.test(key)) throw new Error("MINIMAX_API_KEY_INVALID");
  return key;
}

export function parseSpokenTurns(text) {
  const turns = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^([^：:]{1,20})[：:](.+)$/);
    if (!match) continue;
    const speaker = match[1].trim();
    const spoken = match[2].trim();
    if (!spoken || speaker.startsWith("场景") || speaker.startsWith("角色")) continue;
    turns.push({ speaker, text: spoken });
  }
  return turns;
}

function bucket(project) {
  if (!project.minimaxTts) {
    project.minimaxTts = { quotes: {}, authorizations: {}, jobs: {}, idempotency: {}, plan: null };
  }
  return project.minimaxTts;
}

function approvedScript(project, episodeNo) {
  const episode = project.episodes.find((item) => item.episodeNo === Number(episodeNo));
  if (!episode) throw new Error(`Unknown episodeNo: ${episodeNo}`);
  const script = [...episode.scripts].reverse().find((item) => item.reviewStatus === "APPROVED");
  if (!script) throw new Error("approve-script before the MiniMax quote");
  return { episode, script };
}

function approvedScene(project, episodeNo) {
  const scene = (project.scenes || []).find((item) => item.episodeNo === Number(episodeNo) && item.status === "APPROVED");
  if (!scene) throw new Error("approve-scene before the MiniMax quote");
  return scene;
}

function amountUnits(value) {
  if (!/^(0|[1-9]\d{0,7})(\.\d{1,8})?$/.test(String(value))) throw new Error("MINIMAX_TTS_PRICE_INVALID");
  const [whole = "0", fraction = ""] = String(value).split(".");
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(8, "0"));
}

function formatAmount(units) {
  return `${units / SCALE}.${(units % SCALE).toString().padStart(8, "0")}`;
}

export function estimateSpokenAmount(unitPrice, characters) {
  if (!Number.isInteger(characters) || characters < 1 || characters > 10_000) throw new Error("MINIMAX_TTS_PRICE_INVALID");
  return formatAmount(amountUnits(unitPrice) * BigInt(characters));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function instructionHash(parts) {
  return sha256(canonical(parts));
}

function assertVoice(voiceId) {
  if (!VOICE.test(String(voiceId || ""))) throw new Error("MINIMAX_TTS_VOICE_REQUIRED");
  return String(voiceId);
}

export function buildSpeechPlan(project, { episodeNo = 1, voiceId, settings }) {
  const resolved = settings || resolveMiniMaxSettings({});
  const voice = assertVoice(voiceId);
  const { script } = approvedScript(project, episodeNo);
  const scene = approvedScene(project, episodeNo);
  if (!project.characters?.length) throw new Error("set-characters before the MiniMax quote");
  const lines = parseSpokenTurns(script.text);
  if (lines.length === 0) throw new Error("MINIMAX_TTS_NO_SPOKEN_LINES");
  const known = new Set(project.characters.map((item) => item.name));
  for (const line of lines) {
    if (!known.has(line.speaker)) throw new Error(`MINIMAX_TTS_SPEAKER_UNKNOWN: ${line.speaker}`);
    if (SSML.test(line.text)) throw new Error("MINIMAX_TTS_UNSUPPORTED_CONTROL");
  }
  const text = lines.map((line) => line.text).join("\n");
  if ([...text].length > 10_000) throw new Error("MINIMAX_TTS_TEXT_LIMIT");
  const plan = {
    schema: "minimax-tts.speech-plan.v1",
    provider: MINIMAX_TTS_PROVIDER,
    model: MINIMAX_TTS_MODEL,
    endpoint: "t2a_v2",
    voiceId: voice,
    text,
    lines: lines.map((line, index) => ({ index, speaker: line.speaker, text: line.text })),
    outputFormat: resolved.outputFormat,
    sampleRate: resolved.sampleRate,
    baseUrl: resolved.baseUrl,
    scriptRevisionId: script.id,
    scriptContentHash: script.contentHash,
    sceneId: scene.id,
    spokenCharacters: [...text].length,
    singleExternalOperation: true,
    fallbackProvider: null,
  };
  bucket(project).plan = plan;
  project.stage = "minimax_tts_planned";
  return plan;
}

function currentInstruction(project) {
  const plan = bucket(project).plan;
  if (!plan) throw new Error("mm-tts-quote required");
  const { script } = approvedScript(project, 1);
  if (script.id !== plan.scriptRevisionId || script.contentHash !== plan.scriptContentHash) throw new Error("MINIMAX_TTS_SOURCE_STALE");
  const hash = instructionHash({
    provider: MINIMAX_TTS_PROVIDER,
    model: MINIMAX_TTS_MODEL,
    endpoint: "t2a_v2",
    outputFormat: plan.outputFormat,
    sampleRate: plan.sampleRate,
    baseUrl: plan.baseUrl,
    voiceId: plan.voiceId,
    text: plan.text,
    scriptContentHash: plan.scriptContentHash,
    sceneId: plan.sceneId,
  });
  return { plan, hash, script };
}

export function quoteSpeech(project, { unitPrice, maximumAmount, voiceId, settings, now = Date.now(), currency = "CNY" } = {}) {
  if (currency !== "CNY") throw new Error("MINIMAX_TTS_CURRENCY_UNSUPPORTED");
  const plan = buildSpeechPlan(project, { voiceId, settings: settings || resolveMiniMaxSettings({}) });
  const { hash } = currentInstruction(project);
  const estimatedAmount = estimateSpokenAmount(unitPrice, plan.spokenCharacters);
  if (amountUnits(estimatedAmount) > amountUnits(maximumAmount)) throw new Error("MINIMAX_TTS_QUOTE_EXCEEDS_MAXIMUM");
  const quote = {
    quoteId: randomUUID(),
    provider: MINIMAX_TTS_PROVIDER,
    model: MINIMAX_TTS_MODEL,
    endpoint: "t2a_v2",
    capability: "audio.tts",
    currency: "CNY",
    unitType: "character",
    unitPrice: String(unitPrice),
    spokenCharacters: plan.spokenCharacters,
    lineCount: plan.lines.length,
    separateLineFees: false,
    singleOperation: true,
    fallbackProvider: null,
    estimatedAmount,
    maximumAmount: String(maximumAmount),
    actualCost: "unknown",
    outputFormat: plan.outputFormat,
    sampleRate: plan.sampleRate,
    baseUrl: plan.baseUrl,
    voiceId: plan.voiceId,
    inputHash: hash,
    priceSource: "MINIMAX_TTS_PRICE_CHARACTER",
    expiresAt: new Date(now + 15 * 60 * 1000).toISOString(),
  };
  bucket(project).quotes[quote.quoteId] = quote;
  project.stage = "minimax_tts_quoted";
  return quote;
}

export function authorizeQuote(project, { quoteId, authorizedBy, now = Date.now() }) {
  if (!authorizedBy || !String(authorizedBy).trim()) throw new Error("authorizedBy is required (human gate)");
  const quote = bucket(project).quotes[quoteId];
  if (!quote) throw new Error("MINIMAX_TTS_QUOTE_UNKNOWN");
  if (Date.parse(quote.expiresAt) <= now) throw new Error("MINIMAX_TTS_QUOTE_EXPIRED");
  const authorization = {
    authorizationId: randomUUID(),
    quoteId,
    authorizedBy: String(authorizedBy).trim(),
    authorizedAt: new Date(now).toISOString(),
    maximumAmount: quote.maximumAmount,
    inputHash: quote.inputHash,
    provider: MINIMAX_TTS_PROVIDER,
  };
  bucket(project).authorizations[authorization.authorizationId] = authorization;
  project.stage = "minimax_tts_authorized";
  return authorization;
}

export function buildT2aRequest(plan) {
  if (plan.model !== MINIMAX_TTS_MODEL || plan.provider !== MINIMAX_TTS_PROVIDER) throw new Error("MINIMAX_TTS_MODEL_MISMATCH");
  const baseUrl = canonicalMiniMaxBaseUrl(plan.baseUrl);
  const body = {
    model: "speech-2.8-hd",
    text: plan.text,
    stream: false,
    output_format: "hex",
    voice_setting: { voice_id: plan.voiceId, speed: 1, vol: 1, pitch: 0 },
    audio_setting: { sample_rate: 44100, format: plan.outputFormat, channel: 1 },
  };
  return {
    method: "POST",
    url: `${baseUrl}/v1/t2a_v2`,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  };
}

export function tinyWav(sampleRate = 44100) {
  const data = Buffer.alloc(8);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export function mockT2aResponse(requestBody) {
  const format = requestBody?.audio_setting?.format === "pcm" ? "pcm" : "wav";
  const audio = format === "wav" ? tinyWav() : Buffer.from([0, 1, 2, 3]);
  const payload = {
    data: { audio: audio.toString("hex"), status: 2 },
    extra_info: {
      audio_format: format,
      audio_sample_rate: 44100,
      usage_characters: [...String(requestBody?.text || "")].length,
    },
    trace_id: "mock-mm-trace-1",
    base_resp: { status_code: 0, status_msg: "success" },
  };
  return { status: 200, headers: { "content-type": "application/json", "trace-id": "mock-mm-trace-1" }, bytes: Buffer.from(JSON.stringify(payload)) };
}

function jobByKey(project, key) {
  const pointer = bucket(project).idempotency[key];
  return pointer ? bucket(project).jobs[pointer.jobId] : null;
}

function blockingJob(project, hash, confirmed = []) {
  return Object.values(bucket(project).jobs).find((job) => job.inputHash === hash
    && ["UNKNOWN", "INTENT"].includes(job.state)
    && !confirmed.includes(job.id));
}

function statusCodeOf(payload) {
  const code = payload?.base_resp?.status_code;
  if (typeof code === "number" && Number.isInteger(code)) return code;
  if (typeof code === "string" && /^\d+$/.test(code)) return Number(code);
  return undefined;
}

function traceOf(payload, headers) {
  const value = payload?.trace_id || headers?.["trace-id"] || headers?.["Trace-Id"];
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value) ? value : undefined;
}

function decodeHexAudio(value, format) {
  if (typeof value !== "string" || value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(value)) throw new Error("MINIMAX_TTS_AUDIO_INVALID");
  const bytes = Buffer.from(value, "hex");
  if (bytes.length === 0 || bytes.toString("hex") !== value.toLowerCase()) throw new Error("MINIMAX_TTS_AUDIO_INVALID");
  if (format === "wav" && (bytes.length < 44 || bytes.subarray(0, 4).toString("ascii") !== "RIFF" || bytes.subarray(8, 12).toString("ascii") !== "WAVE")) {
    throw new Error("MINIMAX_TTS_AUDIO_INVALID");
  }
  return bytes;
}

function writeAudio(assetDir, jobId, format, bytes) {
  mkdirSync(assetDir, { recursive: true });
  const path = join(assetDir, `${jobId}.${format === "wav" ? "wav" : "pcm"}`);
  writeFileSync(path, bytes);
  return { path, sha256: sha256(bytes), bytes: bytes.length, mimeType: format === "wav" ? "audio/wav" : "audio/L16" };
}

function failureMessage(code, status, format, host, detail) {
  if (code === 1008) return "MiniMax speech-2.8-hd was refused: insufficient balance (base_resp 1008). Payment is required before another synthesis. This call was not retried and was not sent to ElevenLabs or any other TTS provider.";
  if (code === 2049) return `MiniMax speech-2.8-hd was refused: invalid API key or wrong host (base_resp 2049). Use MINIMAX_API_KEY with https://api.minimaxi.com (configured host: ${host}). This call was not retried and was not sent to another TTS provider.`;
  return `MiniMax speech-2.8-hd ${format} was rejected (HTTP ${status}, base_resp ${code ?? "none"}) and was not replaced. ${detail}`.trim();
}

function sceneCost(quote) {
  return [{
    kind: "ESTIMATED",
    currency: quote.currency,
    amountDecimal: quote.estimatedAmount,
    basis: "LOCALLY_CALCULATED",
    unitType: "character",
    unitQuantity: String(quote.spokenCharacters),
    unitPriceSnapshot: quote.unitPrice,
    component: "t2a_v2",
    separateLineFees: false,
    provider: MINIMAX_TTS_PROVIDER,
  }];
}

function markUnknown(project, job, reason, id, persist) {
  job.state = "UNKNOWN";
  job.providerRequestId = id || null;
  job.externalSubmitCount = 1;
  job.unknownReason = reason;
  job.retryable = false;
  project.stage = "minimax_tts_unknown";
  persist(project);
}

export async function generateSpeech(project, {
  quoteId, idempotencyKey, transport, assetDir, settlement = "UNPAID_MOCK", persist, confirmedUncertainJobIds = [], now = Date.now(),
} = {}) {
  if (!idempotencyKey || !/^[\x21-\x7e]{1,200}$/.test(idempotencyKey)) throw new Error("MINIMAX_TTS_IDEMPOTENCY_KEY_INVALID");
  if (typeof transport !== "function") throw new Error("MINIMAX_TTS_TRANSPORT_REQUIRED");
  if (typeof persist !== "function") throw new Error("MINIMAX_TTS_PERSIST_REQUIRED");
  if (!assetDir) throw new Error("MINIMAX_TTS_ASSET_DIR_REQUIRED");
  const { plan, hash } = currentInstruction(project);
  const state = bucket(project);
  const existing = jobByKey(project, idempotencyKey);
  if (existing) {
    if (existing.inputHash !== hash) throw new Error("MINIMAX_TTS_IDEMPOTENCY_KEY_REUSED");
    return { job: existing, reused: true, submitted: false };
  }
  const blocked = blockingJob(project, hash, confirmedUncertainJobIds);
  if (blocked) throw new Error(`MINIMAX_TTS_UNCERTAIN_BLOCKING: ${blocked.id}`);
  const authorization = Object.values(state.authorizations).find((item) => item.quoteId === quoteId && item.inputHash === hash);
  const quote = state.quotes[quoteId];
  if (!quote || quote.inputHash !== hash || quote.provider !== MINIMAX_TTS_PROVIDER) throw new Error("MINIMAX_TTS_QUOTE_MISMATCH");
  if (!authorization) throw new Error("MINIMAX_TTS_NOT_AUTHORIZED");
  if (Date.parse(quote.expiresAt) <= now) throw new Error("MINIMAX_TTS_QUOTE_EXPIRED");
  const request = buildT2aRequest(plan);
  const parsedBody = JSON.parse(request.body);
  if (parsedBody.model !== "speech-2.8-hd" || !request.url.endsWith("/v1/t2a_v2") || request.url.includes("elevenlabs")) {
    throw new Error("MINIMAX_TTS_MODEL_MISMATCH");
  }
  const job = {
    id: randomUUID(),
    provider: MINIMAX_TTS_PROVIDER,
    model: MINIMAX_TTS_MODEL,
    endpoint: "t2a_v2",
    capability: "audio.tts",
    state: "INTENT",
    idempotencyKey,
    inputHash: hash,
    quoteId,
    authorizationId: authorization.authorizationId,
    source: {
      scriptRevisionId: plan.scriptRevisionId,
      scriptContentHash: plan.scriptContentHash,
      sceneId: plan.sceneId,
      lines: plan.lines.map((line) => ({ ...line })),
      text: plan.text,
    },
    voiceId: plan.voiceId,
    outputFormat: plan.outputFormat,
    sampleRate: plan.sampleRate,
    baseUrl: plan.baseUrl,
    requestUrl: request.url,
    externalSubmitCount: 0,
    separateLineFees: false,
    fallbackProvider: null,
    settlement,
    selected: false,
    createdAt: new Date().toISOString(),
  };
  state.jobs[job.id] = job;
  state.idempotency[idempotencyKey] = { jobId: job.id, inputHash: hash };
  persist(project);
  let response;
  try {
    response = await transport(request);
  } catch {
    markUnknown(project, job, "TRANSPORT", undefined, persist);
    return { job, reused: false, submitted: true };
  }
  let payload = null;
  try { payload = JSON.parse(Buffer.from(response?.bytes || []).toString("utf8")); }
  catch { payload = null; }
  const code = statusCodeOf(payload);
  const id = traceOf(payload, response?.headers);
  const host = new URL(plan.baseUrl).hostname;
  if (code === 1008 || code === 2049 || DEFINITE_HTTP.has(response?.status) || (code !== undefined && DEFINITE_STATUS.has(code))) {
    const detail = Buffer.from(response?.bytes || []).toString("utf8").slice(0, 400).replace(/\s+/g, " ");
    job.state = "FAILED";
    job.retryable = false;
    job.providerRequestId = id || null;
    job.externalSubmitCount = id ? 1 : 0;
    job.errorCode = code === 1008 ? "MINIMAX_TTS_INSUFFICIENT_BALANCE" : code === 2049 ? "MINIMAX_TTS_INVALID_API_KEY" : "MINIMAX_TTS_REJECTED";
    job.errorMessage = failureMessage(code, response?.status ?? "none", plan.outputFormat, host, detail);
    project.stage = "minimax_tts_failed";
    persist(project);
    return { job, reused: false, submitted: true };
  }
  if (!response || response.status !== 200 || code !== 0 || !id) {
    markUnknown(project, job, `HTTP_${response?.status ?? "none"}`, id, persist);
    return { job, reused: false, submitted: true };
  }
  let audio;
  try { audio = decodeHexAudio(payload?.data?.audio, plan.outputFormat); }
  catch {
    markUnknown(project, job, "AUDIO_UNREADABLE", id, persist);
    return { job, reused: false, submitted: true };
  }
  const reportedFormat = payload?.extra_info?.audio_format;
  const reportedRate = payload?.extra_info?.audio_sample_rate;
  if ((reportedFormat !== undefined && reportedFormat !== plan.outputFormat) || (reportedRate !== undefined && reportedRate !== 44100) || payload?.data?.status !== 2) {
    markUnknown(project, job, "AUDIO_MISMATCH", id, persist);
    return { job, reused: false, submitted: true };
  }
  const audioFile = writeAudio(assetDir, job.id, plan.outputFormat, audio);
  job.state = "SUCCEEDED";
  job.providerRequestId = id;
  job.externalSubmitCount = 1;
  job.receipt = {
    schema: "minimax-tts.receipt.v1",
    provider: MINIMAX_TTS_PROVIDER,
    model: MINIMAX_TTS_MODEL,
    endpoint: "t2a_v2",
    capability: "audio.tts",
    singleExternalOperation: true,
    separateLineFees: false,
    fallbackProvider: null,
    subtitleTimingsInvented: false,
    alignment: null,
    jobId: job.id,
    providerRequestId: id,
    inputHash: hash,
    settlement,
    actualCost: "unknown",
    outputFormat: plan.outputFormat,
    sampleRate: 44100,
    baseUrl: plan.baseUrl,
    voiceId: plan.voiceId,
    source: job.source,
    audio: audioFile,
    usageCharacters: Number.isInteger(payload?.extra_info?.usage_characters) ? payload.extra_info.usage_characters : null,
    spokenCharacters: quote.spokenCharacters,
    costs: sceneCost(quote),
    externalSubmitCount: 1,
  };
  project.stage = "minimax_tts_generated";
  persist(project);
  return { job, reused: false, submitted: true };
}

export function resumeSpeech(project, jobId) {
  const state = bucket(project);
  const job = jobId ? state.jobs[jobId] : Object.values(state.jobs).at(-1);
  if (!job) throw new Error("MINIMAX_TTS_JOB_UNKNOWN");
  if (job.state === "UNKNOWN" || job.state === "INTENT") {
    return { jobId: job.id, state: job.state, resumed: false, resubmitted: false, providerRequestId: job.providerRequestId || null };
  }
  if (job.state === "SUCCEEDED") {
    const bytes = readFileSync(job.receipt.audio.path);
    if (sha256(bytes) !== job.receipt.audio.sha256) throw new Error("MINIMAX_TTS_RECEIPT_AUDIO_MISMATCH");
    return { jobId: job.id, state: job.state, resumed: true, resubmitted: false, sha256: job.receipt.audio.sha256, providerRequestId: job.providerRequestId };
  }
  return { jobId: job.id, state: job.state, resumed: false, resubmitted: false, errorCode: job.errorCode || null };
}

export function previewSpeech(project, jobId) {
  const job = bucket(project).jobs[jobId] || Object.values(bucket(project).jobs).at(-1);
  if (!job) throw new Error("MINIMAX_TTS_JOB_UNKNOWN");
  return {
    jobId: job.id,
    state: job.state,
    provider: job.provider,
    model: job.model,
    voiceId: job.voiceId,
    settlement: job.settlement,
    externalSubmitCount: job.externalSubmitCount,
    fallbackProvider: null,
    audio: job.receipt?.audio || null,
    errorCode: job.errorCode || null,
  };
}

export function exportSpeech(project, { jobId, outDir }) {
  const job = bucket(project).jobs[jobId];
  if (!job || job.state !== "SUCCEEDED" || !job.receipt) throw new Error("MINIMAX_TTS_EXPORT_REQUIRES_SUCCEEDED");
  const bytes = readFileSync(job.receipt.audio.path);
  if (sha256(bytes) !== job.receipt.audio.sha256) throw new Error("MINIMAX_TTS_RECEIPT_AUDIO_MISMATCH");
  mkdirSync(outDir, { recursive: true });
  const audioPath = join(outDir, `speech.${job.outputFormat === "wav" ? "wav" : "pcm"}`);
  copyFileSync(job.receipt.audio.path, audioPath);
  const receiptPath = join(outDir, "receipt.json");
  writeFileSync(receiptPath, `${JSON.stringify(job.receipt, null, 2)}\n`);
  const manifest = {
    schema: "minimax-tts.export.v1",
    provider: MINIMAX_TTS_PROVIDER,
    model: MINIMAX_TTS_MODEL,
    fallbackProvider: null,
    subtitleTimingsInvented: false,
    externalSubmitCount: job.externalSubmitCount,
    files: { audio: audioPath, receipt: receiptPath },
  };
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function createFetchTransport(apiKey, baseUrl = MINIMAX_TTS_DEFAULT_BASE_URL) {
  const key = resolveMiniMaxApiKey({ MINIMAX_API_KEY: apiKey });
  const expected = `${canonicalMiniMaxBaseUrl(baseUrl)}/v1/t2a_v2`;
  return async (request) => {
    if (request?.method !== "POST" || request.url !== expected || !String(request.url).endsWith("/v1/t2a_v2")) throw new Error("MINIMAX_TTS_URL_MISMATCH");
    if (/elevenlabs|text-to-dialogue|dashscope|qwen/i.test(request.url)) throw new Error("MINIMAX_TTS_URL_MISMATCH");
    const parsed = JSON.parse(request.body);
    if (parsed.model !== "speech-2.8-hd") throw new Error("MINIMAX_TTS_MODEL_MISMATCH");
    const response = await fetch(request.url, {
      method: "POST",
      headers: { ...request.headers, Authorization: `Bearer ${key}` },
      body: request.body,
      redirect: "error",
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()), bytes };
  };
}

function latestQuote(project) {
  return Object.values(bucket(project).quotes).at(-1) || null;
}

function publicJob(job) {
  return {
    id: job.id,
    state: job.state,
    provider: job.provider,
    model: job.model,
    endpoint: job.endpoint,
    providerRequestId: job.providerRequestId || null,
    externalSubmitCount: job.externalSubmitCount,
    separateLineFees: job.separateLineFees,
    fallbackProvider: null,
    settlement: job.settlement,
    errorCode: job.errorCode || null,
    errorMessage: job.errorMessage || null,
    costs: job.receipt?.costs || [],
    outputFormat: job.outputFormat,
    requestUrl: job.requestUrl,
  };
}

export async function handleMiniMaxCommand(command, values, project, env, { assetDir, persist }) {
  if (command === "mm-tts-quote") {
    const quote = quoteSpeech(project, {
      unitPrice: resolveMiniMaxUnitPrice(env, values["unit-price"]),
      maximumAmount: values["budget-cap"] || env.REAL_MEDIA_MAX_SINGLE_CNY || "10",
      currency: values.currency || "CNY",
      voiceId: values["voice-id"],
      settings: resolveMiniMaxSettings(env),
    });
    return { save: true, output: { quote, paidCalls: 0 } };
  }
  if (command === "mm-tts-authorize") {
    const quoteId = values["quote-id"] || latestQuote(project)?.quoteId;
    const authorization = authorizeQuote(project, { quoteId, authorizedBy: values["authorized-by"] });
    return { save: true, output: { authorization } };
  }
  if (command === "mm-tts-generate") {
    const quoteId = values["quote-id"] || latestQuote(project)?.quoteId;
    let transport;
    let settlement = "ESTIMATED_EXTERNAL";
    if (values.mock) {
      if (values.execute) throw new Error("MINIMAX_TTS_SUBMIT_REFUSED: --mock cannot be combined with --execute");
      if (env.MINIMAX_API_KEY) throw new Error("MINIMAX_TTS_MOCK_REFUSED: unset MINIMAX_API_KEY before --mock");
      settlement = "UNPAID_MOCK";
      transport = async (request) => mockT2aResponse(JSON.parse(request.body));
    } else {
      if (!values.execute) throw new Error("MINIMAX_TTS_SUBMIT_REFUSED: pass --mock for an unpaid fixture or --execute with MINIMAX_API_KEY");
      const settings = resolveMiniMaxSettings(env);
      transport = createFetchTransport(resolveMiniMaxApiKey(env), settings.baseUrl);
    }
    const result = await generateSpeech(project, {
      quoteId, idempotencyKey: values["idempotency-key"], transport, assetDir, settlement, persist,
    });
    return {
      save: true,
      output: {
        job: publicJob(result.job), reused: result.reused, submitted: result.submitted,
        paidCalls: settlement === "UNPAID_MOCK" ? 0 : result.submitted ? 1 : 0,
      },
    };
  }
  if (command === "mm-tts-resume") return { save: false, output: { resume: resumeSpeech(project, values["job-id"]) } };
  if (command === "mm-tts-preview") return { save: false, output: { preview: previewSpeech(project, values["job-id"]) } };
  if (command === "mm-tts-export") {
    const manifest = exportSpeech(project, { jobId: values["job-id"], outDir: values.out });
    return { save: false, output: { manifest } };
  }
  throw new Error(`Unknown MiniMax command: ${command}`);
}

export function minimaxAssetDir(storePath) {
  return join(dirname(storePath), "minimax-tts-audio");
}
