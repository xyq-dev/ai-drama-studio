/**
 * GrokBot director flow for ElevenLabs scene dialogue.
 * One external text-to-dialogue call per scene (model_id eleven_v4).
 * Music credentials and qwen per-line submits are not used.
 * Unpaid tests inject a transport or pass --mock. This module does not open a socket by itself.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const TTS_PROVIDER = "elevenlabs-tts";
export const TTS_MODEL = "eleven_v4";
export const TTS_ENDPOINT = "https://api.elevenlabs.io/v1/text-to-dialogue/with-timestamps";
const SCALE = 100_000_000n;
const SAMPLE_RATE = 44100;
const ROLE_DIRECTION = {
  阿岚: "young female, slightly tense, clear",
  老周: "middle-aged male, low, short phrases",
};
const SCENE_CONTEXT = "rain-night bus stop";

export const DEFAULT_VOICE_CATALOG = {
  schema: "elevenlabs-tts.voice-candidates.v1",
  note: "Placeholders until a live catalog is fetched with ELEVENLABS_TTS_API_KEY. Not music voices and not qwen presets.",
  roles: {
    阿岚: [
      { candidateId: "alan-clear", voiceId: "placeholder-alan-clear", label: "年轻女声·清晰", delivery: "略紧、吐字清楚" },
      { candidateId: "alan-tense", voiceId: "placeholder-alan-tense", label: "年轻女声·更紧", delivery: "压低、短促" },
      { candidateId: "alan-soft", voiceId: "placeholder-alan-soft", label: "年轻女声·偏柔", delivery: "仍保持清晰" },
    ],
    老周: [
      { candidateId: "zhou-low", voiceId: "placeholder-zhou-low", label: "中年男声·低", delivery: "短句、少起伏" },
      { candidateId: "zhou-dry", voiceId: "placeholder-zhou-dry", label: "中年男声·干", delivery: "平、不改语速参数" },
      { candidateId: "zhou-firm", voiceId: "placeholder-zhou-firm", label: "中年男声·硬", delivery: "收住字尾" },
    ],
  },
};

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

export function loadVoiceCatalog(file) {
  if (!file) return structuredClone(DEFAULT_VOICE_CATALOG);
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || !parsed.roles) throw new Error("TTS_VOICE_CATALOG_INVALID");
  return parsed;
}

function bucket(project) {
  if (!project.elevenLabsTts) {
    project.elevenLabsTts = { quotes: {}, authorizations: {}, jobs: {}, idempotency: {}, voicePicks: {}, selectedJobId: null };
  }
  return project.elevenLabsTts;
}

function approvedScript(project, episodeNo) {
  const episode = project.episodes.find((item) => item.episodeNo === Number(episodeNo));
  if (!episode) throw new Error(`Unknown episodeNo: ${episodeNo}`);
  const script = [...episode.scripts].reverse().find((item) => item.reviewStatus === "APPROVED");
  if (!script) throw new Error("approve-script before the ElevenLabs performance plan");
  return { episode, script };
}

function approvedScene(project, episodeNo) {
  const scene = (project.scenes || []).find((item) => item.episodeNo === Number(episodeNo) && item.status === "APPROVED");
  if (!scene) throw new Error("approve-scene before the ElevenLabs performance plan");
  return scene;
}

export function spokenCharacterCount(lines) {
  return lines.reduce((total, line) => total + [...line.text].length, 0);
}

function amountUnits(value) {
  if (!/^(0|[1-9]\d{0,7})(\.\d{1,8})?$/.test(String(value))) throw new Error("TTS_PRICE_INVALID");
  const [whole = "0", fraction = ""] = String(value).split(".");
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(8, "0"));
}

function formatAmount(units) {
  return `${units / SCALE}.${(units % SCALE).toString().padStart(8, "0")}`;
}

export function estimateSpokenAmount(unitPrice, characters) {
  if (!Number.isInteger(characters) || characters < 1 || characters > 100_000) throw new Error("TTS_PRICE_INVALID");
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

export function instructionHash(parts) {
  return sha256(canonical(parts));
}

function outputFormatOf(value) {
  const format = value || "pcm_44100";
  if (format !== "pcm_44100" && format !== "wav_44100") throw new Error("ELEVENLABS_TTS_OUTPUT_FORMAT: only pcm_44100 or wav_44100; mp3 is not a fallback");
  return format;
}

function contextText(value, field) {
  if (!value) return undefined;
  if ([...String(value)].length > 100) throw new Error(`ELEVENLABS_TTS_${field}_LIMIT`);
  if (/<\s*\/?\s*(speak|break|prosody|phoneme|emphasis)\b/i.test(String(value))) throw new Error("ELEVENLABS_TTS_UNSUPPORTED_CONTROL");
  return String(value);
}

export function buildPerformancePlan(project, { episodeNo = 1, outputFormat, previousText, futureText } = {}) {
  const { script } = approvedScript(project, episodeNo);
  const scene = approvedScene(project, episodeNo);
  if (!project.characters?.length) throw new Error("set-characters before the performance plan");
  const lines = parseSpokenTurns(script.text);
  if (lines.length === 0) throw new Error("TTS_NO_SPOKEN_LINES");
  const known = new Set(project.characters.map((item) => item.name));
  for (const line of lines) {
    if (!known.has(line.speaker)) throw new Error(`TTS_SPEAKER_UNKNOWN: ${line.speaker}`);
  }
  const exactSample = lines.map((line) => `${line.speaker}：${line.text}`).join("\n")
    === ["阿岚：师傅，末班车……还会开吗？", "老周：暗号对了，就开。", "阿岚：雨声里藏着站名。", "老周：那你上车。说错了，你只能等天亮。"].join("\n");
  const plan = {
    schema: "elevenlabs-tts.performance.v1",
    provider: TTS_PROVIDER,
    model: TTS_MODEL,
    languageCode: "zh",
    languageLabel: "Mandarin",
    sceneContext: exactSample ? SCENE_CONTEXT : scene.title,
    continuity: "dialogue-multi-turn",
    singleExternalOperation: true,
    dryDialogue: true,
    outputFormat: outputFormatOf(outputFormat),
    previousText: contextText(previousText, "PREVIOUS_TEXT") ?? null,
    futureText: contextText(futureText, "FUTURE_TEXT") ?? null,
    scriptRevisionId: script.id,
    scriptContentHash: script.contentHash,
    sceneId: scene.id,
    roles: Object.fromEntries(project.characters.map((item) => [item.name, {
      characterId: item.id,
      delivery: ROLE_DIRECTION[item.name] || item.voiceIntent || "",
      tagsStayOutOfSubtitle: true,
    }])),
    lines: lines.map((line, index) => ({ index, speaker: line.speaker, text: line.text })),
    spokenCharacters: spokenCharacterCount(lines),
  };
  bucket(project).performancePlan = plan;
  project.stage = "performance_plan";
  return plan;
}

export function listVoiceCandidates(project, catalog = DEFAULT_VOICE_CATALOG) {
  const plan = bucket(project).performancePlan;
  if (!plan) throw new Error("performance-plan before voice candidates");
  const speakers = [...new Set(plan.lines.map((line) => line.speaker))];
  return speakers.map((speaker) => ({
    speaker,
    candidates: (catalog.roles?.[speaker] || []).slice(0, 3),
    placeholder: true,
  }));
}

export function pickVoice(project, { character, candidateId, catalog = DEFAULT_VOICE_CATALOG }) {
  const role = catalog.roles?.[character];
  const candidate = role?.find((item) => item.candidateId === candidateId);
  if (!candidate) throw new Error("TTS_VOICE_CANDIDATE_UNKNOWN");
  const state = bucket(project);
  state.voicePicks[character] = { character, ...candidate, catalog: "placeholder" };
  project.stage = "voice_picked";
  return state.voicePicks[character];
}

function picksFor(project, lines) {
  const picks = bucket(project).voicePicks;
  return lines.map((line) => {
    const pick = picks[line.speaker];
    if (!pick?.voiceId) throw new Error(`TTS_VOICE_UNPICKED: ${line.speaker}`);
    return pick;
  });
}

function currentInstruction(project) {
  const state = bucket(project);
  const plan = state.performancePlan;
  if (!plan) throw new Error("performance-plan required");
  const { script } = approvedScript(project, 1);
  if (script.id !== plan.scriptRevisionId || script.contentHash !== plan.scriptContentHash) throw new Error("TTS_SOURCE_STALE");
  const picks = picksFor(project, plan.lines);
  const hash = instructionHash({
    provider: TTS_PROVIDER,
    model: TTS_MODEL,
    outputFormat: plan.outputFormat,
    languageCode: plan.languageCode,
    previousText: plan.previousText,
    futureText: plan.futureText,
    scriptContentHash: plan.scriptContentHash,
    sceneId: plan.sceneId,
    lines: plan.lines.map((line, index) => ({ index, speaker: line.speaker, text: line.text, voiceId: picks[index].voiceId })),
  });
  return { plan, picks, hash, script };
}

export function resolveUnitPrice(env, explicit) {
  if (explicit) return String(explicit);
  if (env?.ELEVENLABS_TTS_PRICE_CHARACTER) return String(env.ELEVENLABS_TTS_PRICE_CHARACTER);
  throw new Error("TTS_PRICE_UNCONFIGURED: set ELEVENLABS_TTS_PRICE_CHARACTER. ELEVENLABS_MEDIA_PRICE_MUSIC_SECOND is music and is not a speech price");
}

export function resolveTtsApiKey(env) {
  const key = env?.ELEVENLABS_TTS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_TTS_API_KEY_MISSING: speech uses ELEVENLABS_TTS_API_KEY only; ELEVENLABS_MEDIA_API_KEY is music and is not a speech credential");
  if (typeof key !== "string" || key.length < 8 || key.length > 512 || /\s/.test(key)) throw new Error("ELEVENLABS_TTS_API_KEY_INVALID");
  return key;
}

export function quoteScene(project, { unitPrice, maximumAmount, now = Date.now(), currency = "USD" } = {}) {
  if (currency !== "USD") throw new Error("TTS_CURRENCY_UNSUPPORTED");
  const { plan, hash } = currentInstruction(project);
  const characters = spokenCharacterCount(plan.lines);
  const estimatedAmount = estimateSpokenAmount(unitPrice, characters);
  if (amountUnits(estimatedAmount) > amountUnits(maximumAmount)) throw new Error("TTS_QUOTE_EXCEEDS_MAXIMUM");
  const quote = {
    quoteId: randomUUID(),
    provider: TTS_PROVIDER,
    model: TTS_MODEL,
    capability: "audio.tts",
    currency: "USD",
    unitType: "character",
    unitPrice: String(unitPrice),
    spokenCharacters: characters,
    lineCount: plan.lines.length,
    separateLineFees: false,
    singleOperation: true,
    estimatedAmount,
    maximumAmount: String(maximumAmount),
    actualCost: "unknown",
    outputFormat: plan.outputFormat,
    inputHash: hash,
    priceSource: "ELEVENLABS_TTS_PRICE_CHARACTER",
    expiresAt: new Date(now + 15 * 60 * 1000).toISOString(),
  };
  bucket(project).quotes[quote.quoteId] = quote;
  project.stage = "tts_quoted";
  return quote;
}

export function authorizeQuote(project, { quoteId, authorizedBy, now = Date.now() }) {
  if (!authorizedBy || !String(authorizedBy).trim()) throw new Error("authorizedBy is required (human gate)");
  const quote = bucket(project).quotes[quoteId];
  if (!quote) throw new Error("TTS_QUOTE_UNKNOWN");
  if (Date.parse(quote.expiresAt) <= now) throw new Error("TTS_QUOTE_EXPIRED");
  const authorization = {
    authorizationId: randomUUID(),
    quoteId,
    authorizedBy: String(authorizedBy).trim(),
    authorizedAt: new Date(now).toISOString(),
    maximumAmount: quote.maximumAmount,
    inputHash: quote.inputHash,
  };
  bucket(project).authorizations[authorization.authorizationId] = authorization;
  project.stage = "tts_authorized";
  return authorization;
}

export function buildDialogueRequest(plan, picks) {
  const format = outputFormatOf(plan.outputFormat);
  const inputs = plan.lines.map((line, index) => {
    const text = line.text;
    if (/<\s*\/?\s*(speak|break|prosody|phoneme|emphasis)\b/i.test(text)) throw new Error("ELEVENLABS_TTS_UNSUPPORTED_CONTROL");
    return { text, voice_id: picks[index].voiceId };
  });
  const body = {
    inputs,
    model_id: "eleven_v4",
    language_code: "zh",
    apply_text_normalization: "auto",
  };
  if (plan.previousText) body.previous_text = plan.previousText;
  if (plan.futureText) body.future_text = plan.futureText;
  return {
    method: "POST",
    url: `${TTS_ENDPOINT}?output_format=${format}`,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  };
}

function numberArray(value, size) {
  if (!Array.isArray(value) || value.length !== size) return null;
  const numbers = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item) || item < 0) return null;
    numbers.push(item);
  }
  return numbers;
}

export function assessAlignment(inputs, payload) {
  const alignment = payload?.alignment;
  const characters = alignment?.characters;
  if (!Array.isArray(characters) || characters.length === 0 || characters.some((item) => typeof item !== "string")) {
    throw new Error("TTS_ALIGNMENT_INSUFFICIENT");
  }
  const starts = numberArray(alignment.character_start_times_seconds, characters.length);
  const ends = numberArray(alignment.character_end_times_seconds, characters.length);
  if (!starts || !ends) throw new Error("TTS_ALIGNMENT_INSUFFICIENT");
  for (let index = 0; index < characters.length; index += 1) {
    if (ends[index] < starts[index] || (index > 0 && starts[index] < starts[index - 1])) throw new Error("TTS_ALIGNMENT_INSUFFICIENT");
  }
  const segments = payload.voice_segments;
  if (!Array.isArray(segments) || segments.length === 0) throw new Error("TTS_ALIGNMENT_INSUFFICIENT");
  const covered = new Set();
  for (const segment of segments) {
    const inputIndex = segment?.dialogue_input_index;
    const start = segment?.start_time_seconds;
    const end = segment?.end_time_seconds;
    const characterStart = segment?.character_start_index;
    const characterEnd = segment?.character_end_index;
    if (typeof segment?.voice_id !== "string" || !Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= inputs.length
      || typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 0
      || !Number.isInteger(characterStart) || !Number.isInteger(characterEnd) || characterStart < 0 || characterEnd <= characterStart
      || characterEnd > characters.length) throw new Error("TTS_ALIGNMENT_INSUFFICIENT");
    covered.add(inputIndex);
  }
  if (covered.size !== inputs.length) throw new Error("TTS_ALIGNMENT_INSUFFICIENT");
  return { voiceSegments: segments, alignment };
}

export function mockDialogueResponse(requestBody) {
  const inputs = requestBody.inputs;
  const characters = [];
  const starts = [];
  const ends = [];
  const voiceSegments = [];
  let cursor = 0;
  inputs.forEach((input, index) => {
    const chars = [...input.text];
    const characterStart = characters.length;
    for (const char of chars) {
      characters.push(char);
      starts.push(Number(cursor.toFixed(4)));
      cursor += 0.01;
      ends.push(Number(cursor.toFixed(4)));
    }
    voiceSegments.push({
      voice_id: input.voice_id,
      start_time_seconds: starts[characterStart],
      end_time_seconds: ends[ends.length - 1],
      character_start_index: characterStart,
      character_end_index: characters.length,
      dialogue_input_index: index,
    });
  });
  const samples = Math.max(1, Math.round(cursor * SAMPLE_RATE) + 8);
  const pcm = Buffer.alloc(samples * 2);
  const payload = {
    audio_base64: pcm.toString("base64"),
    voice_segments: voiceSegments,
    alignment: { characters, character_start_times_seconds: starts, character_end_times_seconds: ends },
    normalized_alignment: { characters, character_start_times_seconds: starts, character_end_times_seconds: ends },
  };
  return { status: 200, headers: { "content-type": "application/json", "request-id": "mock-dialogue-1" }, bytes: Buffer.from(JSON.stringify(payload)) };
}

function jobByKey(project, key) {
  const state = bucket(project);
  const pointer = state.idempotency[key];
  return pointer ? state.jobs[pointer.jobId] : null;
}

function blockingJob(project, hash, confirmed = []) {
  return Object.values(bucket(project).jobs).find((job) => job.inputHash === hash
    && ["UNKNOWN", "INTENT", "ALIGNMENT_INSUFFICIENT"].includes(job.state)
    && !confirmed.includes(job.id));
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
    component: "scene-dialogue",
    separateLineFees: false,
  }];
}

function writeAudio(assetDir, jobId, format, bytes) {
  mkdirSync(assetDir, { recursive: true });
  const path = join(assetDir, `${jobId}.${format === "wav_44100" ? "wav" : "pcm"}`);
  writeFileSync(path, bytes);
  return { path, sha256: sha256(bytes), bytes: bytes.length, mimeType: format === "wav_44100" ? "audio/wav" : "audio/L16" };
}

function decodeAudio(payload, format) {
  const encoded = payload?.audio_base64;
  if (typeof encoded !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("ELEVENLABS_TTS_AUDIO_INVALID");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== encoded) throw new Error("ELEVENLABS_TTS_AUDIO_INVALID");
  if (format === "wav_44100" && bytes.subarray(0, 4).toString("ascii") !== "RIFF") throw new Error("ELEVENLABS_TTS_AUDIO_INVALID");
  return bytes;
}

function providerRequestId(headers) {
  const value = headers?.["request-id"] || headers?.["xi-request-id"];
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value) ? value : undefined;
}

function rejectionStatuses(status) {
  return [400, 401, 402, 403, 404, 413, 422, 429].includes(status);
}

export async function generateScene(project, {
  quoteId, idempotencyKey, transport, assetDir, settlement = "UNPAID_MOCK", persist, confirmedUncertainJobIds = [], now = Date.now(),
} = {}) {
  if (!idempotencyKey || !/^[\x21-\x7e]{1,200}$/.test(idempotencyKey)) throw new Error("TTS_IDEMPOTENCY_KEY_INVALID");
  if (typeof transport !== "function") throw new Error("TTS_TRANSPORT_REQUIRED");
  if (typeof persist !== "function") throw new Error("TTS_PERSIST_REQUIRED");
  if (!assetDir) throw new Error("TTS_ASSET_DIR_REQUIRED");
  const { plan, picks, hash } = currentInstruction(project);
  const state = bucket(project);
  const existing = jobByKey(project, idempotencyKey);
  if (existing) {
    if (existing.inputHash !== hash) throw new Error("IDEMPOTENCY_KEY_REUSED");
    return { job: existing, reused: true, submitted: false };
  }
  const blocked = blockingJob(project, hash, confirmedUncertainJobIds);
  if (blocked) throw new Error(`TTS_UNCERTAIN_BLOCKING: ${blocked.id}`);
  const authorization = Object.values(state.authorizations).find((item) => item.quoteId === quoteId && item.inputHash === hash);
  const quote = state.quotes[quoteId];
  if (!quote || quote.inputHash !== hash) throw new Error("TTS_QUOTE_MISMATCH");
  if (!authorization) throw new Error("TTS_NOT_AUTHORIZED");
  if (Date.parse(quote.expiresAt) <= now) throw new Error("TTS_QUOTE_EXPIRED");
  const request = buildDialogueRequest(plan, picks);
  const parsedBody = JSON.parse(request.body);
  if (parsedBody.model_id !== "eleven_v4") throw new Error("ELEVENLABS_TTS_MODEL_MISMATCH");
  const job = {
    id: randomUUID(),
    provider: TTS_PROVIDER,
    model: TTS_MODEL,
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
    },
    voices: plan.lines.map((line, index) => ({ speaker: line.speaker, voiceId: picks[index].voiceId, candidateId: picks[index].candidateId })),
    outputFormat: plan.outputFormat,
    requestUrl: request.url,
    externalSubmitCount: 0,
    separateLineFees: false,
    settlement,
    derivedStems: [],
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
    job.state = "UNKNOWN";
    job.externalSubmitCount = 1;
    job.unknownReason = "TRANSPORT";
    project.stage = "tts_unknown";
    persist(project);
    return { job, reused: false, submitted: true };
  }
  const id = providerRequestId(response?.headers);
  if (!response || rejectionStatuses(response.status)) {
    job.state = "FAILED";
    job.retryable = false;
    job.providerRequestId = id || null;
    job.externalSubmitCount = id ? 1 : 0;
    job.errorCode = "ELEVENLABS_TTS_REJECTED";
    const detail = Buffer.from(response?.bytes || []).toString("utf8").slice(0, 400).replace(/\s+/g, " ");
    job.errorMessage = `eleven_v4 ${plan.outputFormat} was rejected (HTTP ${response?.status ?? "none"}) and was not replaced. ${detail}`.trim();
    project.stage = "tts_failed";
    persist(project);
    return { job, reused: false, submitted: true };
  }
  if (response.status !== 200 || !id) {
    job.state = "UNKNOWN";
    job.providerRequestId = id || null;
    job.externalSubmitCount = 1;
    job.unknownReason = `HTTP_${response.status}`;
    project.stage = "tts_unknown";
    persist(project);
    return { job, reused: false, submitted: true };
  }
  let payload;
  try { payload = JSON.parse(Buffer.from(response.bytes).toString("utf8")); }
  catch {
    job.state = "UNKNOWN";
    job.providerRequestId = id;
    job.externalSubmitCount = 1;
    job.unknownReason = "RESPONSE_UNREADABLE";
    project.stage = "tts_unknown";
    persist(project);
    return { job, reused: false, submitted: true };
  }
  let audio;
  try { audio = decodeAudio(payload, plan.outputFormat); }
  catch {
    job.state = "UNKNOWN";
    job.providerRequestId = id;
    job.externalSubmitCount = 1;
    job.unknownReason = "AUDIO_UNREADABLE";
    project.stage = "tts_unknown";
    persist(project);
    return { job, reused: false, submitted: true };
  }
  const audioFile = writeAudio(assetDir, job.id, plan.outputFormat, audio);
  let assessed;
  try { assessed = assessAlignment(parsedBody.inputs, payload); }
  catch {
    job.state = "ALIGNMENT_INSUFFICIENT";
    job.providerRequestId = id;
    job.externalSubmitCount = 1;
    job.retryable = false;
    job.errorCode = "TTS_ALIGNMENT_INSUFFICIENT";
    job.errorMessage = "Alignment cannot time every spoken line. Subtitle timings were not invented.";
    job.receipt = baseReceipt(job, plan, quote, audioFile, payload, null);
    project.stage = "tts_alignment_insufficient";
    persist(project);
    return { job, reused: false, submitted: true };
  }
  job.state = "SUCCEEDED";
  job.providerRequestId = id;
  job.externalSubmitCount = 1;
  job.receipt = baseReceipt(job, plan, quote, audioFile, payload, assessed);
  job.receipt.costs = sceneCost(quote);
  project.stage = "tts_generated";
  persist(project);
  return { job, reused: false, submitted: true };
}

function baseReceipt(job, plan, quote, audioFile, payload, assessed) {
  return {
    schema: "elevenlabs-tts.receipt.v1",
    provider: TTS_PROVIDER,
    model: TTS_MODEL,
    capability: "audio.tts",
    singleExternalOperation: true,
    separateLineFees: false,
    jobId: job.id,
    providerRequestId: job.providerRequestId,
    inputHash: job.inputHash,
    settlement: job.settlement,
    actualCost: "unknown",
    outputFormat: plan.outputFormat,
    dryDialogue: true,
    source: job.source,
    voices: job.voices,
    inputVersion: { scriptContentHash: plan.scriptContentHash, instructionHash: job.inputHash },
    audio: audioFile,
    voiceSegments: assessed ? assessed.voiceSegments : payload.voice_segments ?? null,
    alignment: assessed ? assessed.alignment : payload.alignment ?? null,
    normalizedAlignment: payload.normalized_alignment ?? null,
    spokenCharacters: quote.spokenCharacters,
    costs: [],
    externalSubmitCount: 1,
    parent: null,
  };
}

export function resumeTask(project, jobId) {
  const state = bucket(project);
  const job = jobId ? state.jobs[jobId] : Object.values(state.jobs).at(-1);
  if (!job) throw new Error("TTS_JOB_UNKNOWN");
  if (job.state === "UNKNOWN" || job.state === "INTENT") {
    return { jobId: job.id, state: job.state, resumed: false, resubmitted: false, providerRequestId: job.providerRequestId || null };
  }
  if (job.state === "SUCCEEDED") {
    const bytes = readFileSync(job.receipt.audio.path);
    if (sha256(bytes) !== job.receipt.audio.sha256) throw new Error("TTS_RECEIPT_AUDIO_MISMATCH");
    return { jobId: job.id, state: job.state, resumed: true, resubmitted: false, sha256: job.receipt.audio.sha256, providerRequestId: job.providerRequestId };
  }
  return { jobId: job.id, state: job.state, resumed: false, resubmitted: false, errorCode: job.errorCode || null };
}

export function previewTake(project, jobId) {
  const job = bucket(project).jobs[jobId] || Object.values(bucket(project).jobs).at(-1);
  if (!job) throw new Error("TTS_JOB_UNKNOWN");
  return {
    jobId: job.id,
    state: job.state,
    provider: job.provider,
    model: job.model,
    voices: job.voices,
    settlement: job.settlement,
    externalSubmitCount: job.externalSubmitCount,
    separateLineFees: false,
    audio: job.receipt?.audio || null,
    selected: job.selected,
  };
}

export function selectTake(project, jobId) {
  const state = bucket(project);
  const job = state.jobs[jobId];
  if (!job || job.state !== "SUCCEEDED") throw new Error("TTS_SELECT_REQUIRES_SUCCEEDED");
  for (const item of Object.values(state.jobs)) item.selected = item.id === jobId;
  state.selectedJobId = jobId;
  project.stage = "tts_selected";
  return { jobId, selected: true };
}

function rangesOverlap(left, right) {
  return left.start < right.end && right.start < left.end;
}

export function lineWindow(receipt, lineIndex) {
  const segments = (receipt.voiceSegments || []).filter((segment) => segment.dialogue_input_index === lineIndex);
  if (!receipt.alignment || segments.length === 0) throw new Error("TTS_ALIGNMENT_INSUFFICIENT");
  const start = Math.min(...segments.map((segment) => segment.start_time_seconds));
  const end = Math.max(...segments.map((segment) => segment.end_time_seconds));
  const overlap = (receipt.voiceSegments || []).some((segment) => segment.dialogue_input_index !== lineIndex
    && rangesOverlap({ start, end }, { start: segment.start_time_seconds, end: segment.end_time_seconds }));
  return { start, end, overlap };
}

export function sliceParentAudio(bytes, format, start, end) {
  if (format === "pcm_44100") return slicePcm(bytes, start, end);
  if (format === "wav_44100") return sliceWav(bytes, start, end);
  throw new Error("TTS_STEM_FORMAT_UNSUPPORTED");
}

function slicePcm(bytes, startSec, endSec) {
  const start = Math.round(startSec * SAMPLE_RATE) * 2;
  const end = Math.round(endSec * SAMPLE_RATE) * 2;
  if (start < 0 || end > bytes.length || end <= start) throw new Error("TTS_STEM_RANGE_INVALID");
  return Buffer.from(bytes.subarray(start, end));
}

function sliceWav(bytes, startSec, endSec) {
  if (bytes.subarray(0, 4).toString("ascii") !== "RIFF" || bytes.subarray(8, 12).toString("ascii") !== "WAVE") throw new Error("TTS_STEM_FORMAT_UNSUPPORTED");
  let offset = 12;
  let dataStart = -1;
  let dataLength = 0;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let audioFormat = 0;
  while (offset + 8 <= bytes.length) {
    const id = bytes.subarray(offset, offset + 4).toString("ascii");
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      audioFormat = bytes.readUInt16LE(body);
      channels = bytes.readUInt16LE(body + 2);
      sampleRate = bytes.readUInt32LE(body + 4);
      bits = bytes.readUInt16LE(body + 14);
    } else if (id === "data") {
      dataStart = body;
      dataLength = size;
      break;
    }
    offset = body + size + (size % 2);
  }
  if (audioFormat !== 1 || channels !== 1 || sampleRate !== SAMPLE_RATE || bits !== 16 || dataStart < 0) throw new Error("TTS_STEM_FORMAT_UNSUPPORTED");
  const pcm = bytes.subarray(dataStart, dataStart + dataLength);
  const sliced = slicePcm(pcm, startSec, endSec);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + sliced.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(sliced.length, 40);
  return Buffer.concat([header, sliced]);
}

export function deriveLineStem(project, { jobId, lineIndex, assetDir }) {
  const job = bucket(project).jobs[jobId];
  if (!job || job.state !== "SUCCEEDED" || !job.receipt) throw new Error("TTS_STEM_REQUIRES_PARENT");
  const line = job.receipt.source.lines[lineIndex];
  if (!line) throw new Error("TTS_LINE_UNKNOWN");
  const window = lineWindow(job.receipt, lineIndex);
  const parent = readFileSync(job.receipt.audio.path);
  if (sha256(parent) !== job.receipt.audio.sha256) throw new Error("TTS_PARENT_AUDIO_MISMATCH");
  const sliced = sliceParentAudio(parent, job.outputFormat, window.start, window.end);
  const id = randomUUID();
  const audio = writeAudio(assetDir, id, job.outputFormat, sliced);
  const stem = {
    schema: "elevenlabs-tts.derived-stem.v1",
    id,
    parentJobId: job.id,
    parentProviderRequestId: job.providerRequestId,
    parentAudioSha256: job.receipt.audio.sha256,
    lineIndex,
    speaker: line.speaker,
    text: line.text,
    startTimeSeconds: window.start,
    endTimeSeconds: window.end,
    overlap: window.overlap,
    cleanSoloStem: false,
    stemKind: "parent-window",
    outputFormat: job.outputFormat,
    audio,
    costs: [],
    externalSubmitCount: 0,
    feeRegistered: false,
    actualCost: "unknown",
    provider: TTS_PROVIDER,
    model: TTS_MODEL,
  };
  job.derivedStems.push(stem);
  return stem;
}

function vttTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("TTS_SUBTITLE_TIME_INVALID");
  const ms = Math.round(seconds * 1000);
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(milli).padStart(3, "0")}`;
}

export function buildSubtitles(receipt) {
  if (!receipt?.alignment || !Array.isArray(receipt.voiceSegments)) throw new Error("TTS_ALIGNMENT_INSUFFICIENT");
  assessAlignment(receipt.source.lines.map((line) => ({ voice_id: "check" })), {
    alignment: receipt.alignment,
    voice_segments: receipt.voiceSegments,
  });
  const cues = receipt.source.lines.map((line) => {
    const window = lineWindow(receipt, line.index);
    return { index: line.index, speaker: line.speaker, text: line.text, start: window.start, end: window.end, overlap: window.overlap };
  });
  const body = cues.map((cue, index) => `${index + 1}\n${vttTime(cue.start)} --> ${vttTime(cue.end)}\n${cue.text}`).join("\n\n");
  return { cues, vtt: `WEBVTT\n\n${body}\n` };
}

export function exportTake(project, { jobId, outDir }) {
  const job = bucket(project).jobs[jobId];
  if (!job || job.state !== "SUCCEEDED") throw new Error("TTS_EXPORT_BLOCKED");
  const subtitles = buildSubtitles(job.receipt);
  mkdirSync(outDir, { recursive: true });
  const extension = job.outputFormat === "wav_44100" ? "wav" : "pcm";
  const audioPath = join(outDir, `dialogue.${extension}`);
  copyFileSync(job.receipt.audio.path, audioPath);
  const vttPath = join(outDir, "dialogue.vtt");
  writeFileSync(vttPath, subtitles.vtt);
  const receiptPath = join(outDir, "receipt.json");
  const publicReceipt = { ...job.receipt, audio: { ...job.receipt.audio } };
  writeFileSync(receiptPath, `${JSON.stringify(publicReceipt, null, 2)}\n`);
  const manifest = {
    schema: "elevenlabs-tts.export.v1",
    provider: TTS_PROVIDER,
    model: TTS_MODEL,
    dryDialogue: true,
    mixedWithMusicOrSfx: false,
    speedAdjusted: false,
    denoised: false,
    externalSubmitCount: job.externalSubmitCount,
    separateLineFees: false,
    files: { audio: audioPath, subtitles: vttPath, receipt: receiptPath },
  };
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function createFetchTransport(apiKey) {
  const key = resolveTtsApiKey({ ELEVENLABS_TTS_API_KEY: apiKey });
  return async (request) => {
    const response = await fetch(request.url, {
      method: "POST",
      headers: { ...request.headers, "xi-api-key": key },
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

export async function handleDirectorCommand(command, values, project, env, { assetDir, persist }) {
  const catalog = loadVoiceCatalog(values["voices-file"]);
  if (command === "voice-candidates") {
    buildPerformancePlan(project, { episodeNo: values.episode || 1, outputFormat: values["output-format"], previousText: values["previous-text"], futureText: values["future-text"] });
    return { save: true, output: { candidates: listVoiceCandidates(project, catalog), placeholder: true } };
  }
  if (command === "performance-plan") {
    const plan = buildPerformancePlan(project, { episodeNo: values.episode || 1, outputFormat: values["output-format"], previousText: values["previous-text"], futureText: values["future-text"] });
    return { save: true, output: { performancePlan: plan } };
  }
  if (command === "pick-voice") {
    const picked = pickVoice(project, { character: values.character, candidateId: values.candidate, catalog });
    return { save: true, output: { voice: picked } };
  }
  if (command === "tts-quote") {
    const quote = quoteScene(project, {
      unitPrice: resolveUnitPrice(env, values["unit-price"]),
      maximumAmount: values["budget-cap"] || env.REAL_MEDIA_MAX_SINGLE_USD || "2",
      currency: values.currency || "USD",
    });
    return { save: true, output: { quote, paidCalls: 0 } };
  }
  if (command === "tts-authorize") {
    const quoteId = values["quote-id"] || latestQuote(project)?.quoteId;
    const authorization = authorizeQuote(project, { quoteId, authorizedBy: values["authorized-by"] });
    return { save: true, output: { authorization } };
  }
  if (command === "tts-generate") {
    const quoteId = values["quote-id"] || latestQuote(project)?.quoteId;
    let transport;
    let settlement = "ESTIMATED_EXTERNAL";
    if (values.mock) {
      if (env.ELEVENLABS_TTS_API_KEY) throw new Error("TTS_MOCK_REFUSED: unset ELEVENLABS_TTS_API_KEY before --mock");
      settlement = "UNPAID_MOCK";
      transport = async (request) => mockDialogueResponse(JSON.parse(request.body));
    } else {
      if (!values.execute) throw new Error("TTS_SUBMIT_REFUSED: pass --mock for an unpaid fixture or --execute with ELEVENLABS_TTS_API_KEY");
      transport = createFetchTransport(resolveTtsApiKey(env));
    }
    const result = await generateScene(project, {
      quoteId, idempotencyKey: values["idempotency-key"], transport, assetDir, settlement, persist,
    });
    return { save: true, output: { job: publicJob(result.job), reused: result.reused, submitted: result.submitted, paidCalls: settlement === "UNPAID_MOCK" ? 0 : result.submitted ? 1 : 0 } };
  }
  if (command === "tts-resume") return { save: false, output: { resume: resumeTask(project, values["job-id"]) } };
  if (command === "tts-preview") return { save: false, output: { preview: previewTake(project, values["job-id"]) } };
  if (command === "tts-select") {
    const selected = selectTake(project, values["job-id"]);
    return { save: true, output: selected };
  }
  if (command === "tts-redo") {
    const stem = deriveLineStem(project, { jobId: values["job-id"], lineIndex: Number(values["line-index"]), assetDir });
    return { save: true, output: { stem, paidCalls: 0 } };
  }
  if (command === "tts-subtitles") {
    const job = bucket(project).jobs[values["job-id"]] || Object.values(bucket(project).jobs).at(-1);
    if (!job?.receipt || job.state !== "SUCCEEDED") throw new Error("TTS_ALIGNMENT_INSUFFICIENT");
    return { save: false, output: buildSubtitles(job.receipt) };
  }
  if (command === "tts-export") {
    const manifest = exportTake(project, { jobId: values["job-id"], outDir: values.out });
    return { save: false, output: { manifest } };
  }
  throw new Error(`Unknown director command: ${command}`);
}

function publicJob(job) {
  return {
    id: job.id,
    state: job.state,
    provider: job.provider,
    model: job.model,
    providerRequestId: job.providerRequestId || null,
    externalSubmitCount: job.externalSubmitCount,
    separateLineFees: job.separateLineFees,
    settlement: job.settlement,
    errorCode: job.errorCode || null,
    errorMessage: job.errorMessage || null,
    costs: job.receipt?.costs || [],
    outputFormat: job.outputFormat,
  };
}

export function assetDirFor(storePath) {
  return join(dirname(storePath), "elevenlabs-tts-audio");
}
