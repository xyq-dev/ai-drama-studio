import { TITLE_WRITING_DEFAULT_MODELS, anthropicKeyProblem, type TitleWritingProviderKey } from "@ai-drama/contracts";
import {
  ResponseBodyError,
  decodeResponseBytes,
  redactSecret,
  type WritingTransport,
} from "./http-transport";

/**
 * Provider-neutral text generation for the title-driven writing run. Business code sees one request shape, one
 * result shape and one error classification; every vendor difference (endpoint, authentication headers, body,
 * structured-output format, thinking, stop reasons and usage) stays inside its adapter.
 *
 * Only two providers are active: OpenAI and Claude (Anthropic). Runs stored with the retired qwen or deepseek keys stay
 * readable, but no adapter, endpoint or configuration exists for them any more, so nothing can be sent for them.
 *
 * Checked against the official documentation:
 * - OpenAI (2026-10-08): POST https://api.openai.com/v1/responses, Bearer key, text.format json_schema (name, schema,
 *   strict), max_output_tokens, status completed/incomplete with incomplete_details.reason, refusal content items,
 *   usage input/output/total_tokens, 429 insufficient_quota for an exhausted balance.
 * - Claude (2026-10-16): POST https://api.anthropic.com/v1/messages with x-api-key and anthropic-version 2023-06-01;
 *   system, messages, max_tokens (a hard limit on thinking plus text); output_config.format json_schema (no beta header;
 *   no minLength/maxLength, minimum/maximum, maxItems or minItems above 1; additionalProperties false);
 *   output_config.effort; thinking {type: "adaptive", display: "omitted"} (current models think adaptively and Claude
 *   Opus 5.5 cannot turn thinking off); stop_reason end_turn/max_tokens/refusal/tool_use/pause_turn/stop_sequence/
 *   model_context_window_exceeded; content blocks text/thinking/redacted_thinking/tool_use/server_tool_use; usage
 *   input_tokens + cache_creation_input_tokens + cache_read_input_tokens is the total input and output_tokens already
 *   includes thinking; 402 billing_error, 429 rate_limit_error, 500 api_error, 504 timeout_error, 529 overloaded_error;
 *   request-id response header.
 */
export type { WritingTransport } from "./http-transport";

export const TEXT_WRITING_MAX_OUTPUT_TOKENS = 4_096;
export const TEXT_WRITING_TIMEOUT_MS = 120_000;
export const TEXT_WRITING_MAX_RESPONSE_BYTES = 1_048_576;

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
/**
 * Thinking counts toward Claude's max_tokens, so a Claude call gets the shared visible-output budget plus this much
 * room to think. Effort "low" keeps the thinking short; the call still ends within the shared 120 s timeout.
 */
export const ANTHROPIC_THINKING_HEADROOM_TOKENS = 4_096;
export const ANTHROPIC_EFFORT = "low";

export type WritingErrorCode =
  | "auth"
  | "quota"
  | "rate_limited"
  | "bad_request"
  | "refusal"
  | "truncated"
  | "invalid_output"
  | "timeout"
  | "disconnected"
  | "server_error"
  | "redirect_rejected"
  | "response_too_large"
  | "provider_error";

/**
 * answered: the provider returned content (still unvalidated). rejected: the provider definitely answered without
 * usable content. unknown: the request may have been processed and charged; it is never resent automatically.
 */
export type WritingOutcome = "answered" | "rejected" | "unknown";

export interface WritingUsage {
  status: "present" | "unknown";
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface WritingExchange {
  outcome: WritingOutcome;
  errorCode: WritingErrorCode | null;
  content: string | null;
  responseModel: string | null;
  providerRequestId: string | null;
  usage: WritingUsage;
}

export interface WritingRequest {
  model: string;
  system: string;
  user: string;
  schemaName: string;
  jsonSchema: Record<string, unknown>;
  maxOutputTokens: number;
}

interface ParsedAnswer {
  errorCode: WritingErrorCode | null;
  content: string | null;
  responseModel: string | null;
  bodyRequestId: string | null;
  usage: WritingUsage;
}

export interface WritingAdapter {
  readonly providerKey: TitleWritingProviderKey;
  readonly label: string;
  /** The one official endpoint. sendWriting refuses any other URL before sending. */
  readonly url: string;
  /** Authentication and protocol headers. The key appears only here, never in the body or a result. */
  headers(apiKey: string): Record<string, string>;
  buildBody(request: WritingRequest): string;
  parseAnswer(raw: string, secret: string): ParsedAnswer;
  classifyStatus(status: number, bodyText: string): { code: WritingErrorCode; outcome: "rejected" | "unknown" };
  /** Response headers that may carry the provider's request id, in order of preference. */
  readonly requestIdHeaders: readonly string[];
}

const UNKNOWN_USAGE: WritingUsage = { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null };

function safeId(value: unknown, secret: string): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[\w.:-]{1,128}$/.test(trimmed) || (secret.length > 0 && trimmed.includes(secret))) return null;
  return trimmed;
}

function safeModel(value: unknown): string | null {
  return typeof value === "string" && /^[\w.:/-]{1,128}$/.test(value.trim()) ? value.trim() : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Shared HTTP meaning. A 5xx or redirect may follow a processed request, so the result is unknown. */
function commonStatus(status: number): { code: WritingErrorCode; outcome: "rejected" | "unknown" } {
  if (status === 0 || (status >= 300 && status < 400)) return { code: "redirect_rejected", outcome: "unknown" };
  if (status === 401 || status === 403) return { code: "auth", outcome: "rejected" };
  if (status === 429) return { code: "rate_limited", outcome: "rejected" };
  if (status === 400 || status === 404 || status === 413 || status === 422) return { code: "bad_request", outcome: "rejected" };
  if (status >= 500 && status <= 599) return { code: "server_error", outcome: "unknown" };
  return { code: "provider_error", outcome: "rejected" };
}

function jsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function openAiAnswer(raw: string, secret: string): ParsedAnswer {
  const body = jsonObject(raw);
  if (!body) return { errorCode: "invalid_output", content: null, responseModel: null, bodyRequestId: null, usage: UNKNOWN_USAGE };
  const usageRecord = body.usage && typeof body.usage === "object" ? body.usage as Record<string, unknown> : null;
  const inputTokens = count(usageRecord?.input_tokens);
  const outputTokens = count(usageRecord?.output_tokens);
  const totalTokens = count(usageRecord?.total_tokens);
  const usage: WritingUsage = inputTokens !== null && outputTokens !== null && totalTokens !== null
    ? { status: "present", inputTokens, outputTokens, totalTokens }
    : UNKNOWN_USAGE;
  const base = { responseModel: safeModel(body.model), bodyRequestId: safeId(body.id, secret), usage };
  if (body.status === "incomplete") {
    const reason = body.incomplete_details && typeof body.incomplete_details === "object"
      ? (body.incomplete_details as Record<string, unknown>).reason
      : undefined;
    return { ...base, errorCode: reason === "content_filter" ? "refusal" : "truncated", content: null };
  }
  if (body.status !== "completed") return { ...base, errorCode: "invalid_output", content: null };
  const output = Array.isArray(body.output) ? body.output : [];
  const messages = output.filter((item) => item && typeof item === "object" && (item as Record<string, unknown>).type === "message");
  const others = output.filter((item) => !(item && typeof item === "object"
    && ["message", "reasoning"].includes(String((item as Record<string, unknown>).type))));
  if (messages.length !== 1 || others.length > 0) return { ...base, errorCode: "invalid_output", content: null };
  const parts = (messages[0] as Record<string, unknown>).content;
  if (!Array.isArray(parts)) return { ...base, errorCode: "invalid_output", content: null };
  let text = "";
  for (const part of parts) {
    const record = part && typeof part === "object" ? part as Record<string, unknown> : {};
    if (record.type === "refusal") return { ...base, errorCode: "refusal", content: null };
    if (record.type !== "output_text" || typeof record.text !== "string") return { ...base, errorCode: "invalid_output", content: null };
    text += record.text;
  }
  if (text.length === 0) return { ...base, errorCode: "invalid_output", content: null };
  return { ...base, errorCode: null, content: text };
}

export const openAiWritingAdapter: WritingAdapter = {
  providerKey: "openai",
  label: "OpenAI",
  url: OPENAI_RESPONSES_URL,
  headers: (apiKey) => ({ Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }),
  buildBody(request) {
    return JSON.stringify({
      model: request.model,
      instructions: request.system,
      input: request.user,
      store: false,
      max_output_tokens: request.maxOutputTokens,
      text: { format: { type: "json_schema", name: request.schemaName, schema: request.jsonSchema, strict: true } },
    });
  },
  parseAnswer: openAiAnswer,
  classifyStatus(status, bodyText) {
    if (status === 429 && /insufficient_quota/.test(bodyText)) return { code: "quota", outcome: "rejected" };
    return commonStatus(status);
  },
  requestIdHeaders: ["x-request-id"],
};

/** Keywords Claude's structured outputs reject. The local zod schemas and domain checks still enforce every limit. */
const CLAUDE_UNSUPPORTED_KEYWORDS = new Set(["minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum",
  "exclusiveMaximum", "multipleOf", "maxItems", "minProperties", "maxProperties", "uniqueItems"]);

/**
 * The same schema in the subset Claude compiles: unsupported bounds are dropped and minItems above 1 becomes 1. The
 * shape, required fields, enums and additionalProperties false are kept. A copy; the shared schema is never changed.
 */
export function claudeJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(claudeJsonSchema);
  if (!schema || typeof schema !== "object") return schema;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (CLAUDE_UNSUPPORTED_KEYWORDS.has(key)) continue;
    if (key === "minItems") {
      output.minItems = typeof value === "number" && value >= 1 ? 1 : 0;
      continue;
    }
    // Property maps and enum lists hold names and values, not schemas, except properties whose values are schemas.
    if (key === "enum" || key === "required" || key === "const") {
      output[key] = value;
      continue;
    }
    if (key === "properties" && value && typeof value === "object") {
      output.properties = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, item]) => [name, claudeJsonSchema(item)]));
      continue;
    }
    output[key] = claudeJsonSchema(value);
  }
  return output;
}

function claudeUsage(value: unknown): WritingUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return UNKNOWN_USAGE;
  const record = value as Record<string, unknown>;
  const input = count(record.input_tokens);
  const output = count(record.output_tokens);
  if (input === null || output === null) return UNKNOWN_USAGE;
  // Cache counts may be null or absent (no caching); any other non-count value leaves the usage unknown.
  const cacheOf = (item: unknown): number | null => item === undefined || item === null ? 0 : count(item);
  const created = cacheOf(record.cache_creation_input_tokens);
  const read = cacheOf(record.cache_read_input_tokens);
  if (created === null || read === null) return UNKNOWN_USAGE;
  // Total input is input + cache creation + cache read; output_tokens already includes thinking and is not added twice.
  const inputTokens = input + created + read;
  return { status: "present", inputTokens, outputTokens: output, totalTokens: inputTokens + output };
}

function claudeAnswer(raw: string, secret: string): ParsedAnswer {
  const body = jsonObject(raw);
  if (!body) return { errorCode: "invalid_output", content: null, responseModel: null, bodyRequestId: null, usage: UNKNOWN_USAGE };
  const base = { responseModel: safeModel(body.model), bodyRequestId: safeId(body.id, secret), usage: claudeUsage(body.usage) };
  if (body.type !== "message" || body.role !== "assistant") return { ...base, errorCode: "invalid_output", content: null };
  const stop = body.stop_reason;
  if (stop === "refusal") return { ...base, errorCode: "refusal", content: null };
  if (stop === "max_tokens" || stop === "model_context_window_exceeded" || stop === "pause_turn") {
    return { ...base, errorCode: "truncated", content: null };
  }
  // tool_use, stop_sequence or anything unknown: not a finished answer to this request.
  if (stop !== "end_turn") return { ...base, errorCode: "invalid_output", content: null };
  const blocks = Array.isArray(body.content) ? body.content : null;
  if (!blocks) return { ...base, errorCode: "invalid_output", content: null };
  let text: string | null = null;
  for (const block of blocks) {
    const record = block && typeof block === "object" && !Array.isArray(block) ? block as Record<string, unknown> : null;
    if (!record) return { ...base, errorCode: "invalid_output", content: null };
    // Thinking is never content: it is skipped and never stored or shown.
    if (record.type === "thinking" || record.type === "redacted_thinking") continue;
    // Exactly one text block carries the structured answer. A tool call or a second text block is not an answer.
    if (record.type !== "text" || typeof record.text !== "string" || text !== null) return { ...base, errorCode: "invalid_output", content: null };
    if (Array.isArray(record.citations) && record.citations.length > 0) return { ...base, errorCode: "invalid_output", content: null };
    text = record.text;
  }
  if (text === null || text.trim().length === 0) return { ...base, errorCode: "invalid_output", content: null };
  return { ...base, errorCode: null, content: text };
}

export const anthropicWritingAdapter: WritingAdapter = {
  providerKey: "anthropic",
  label: "Claude",
  url: ANTHROPIC_MESSAGES_URL,
  headers: (apiKey) => ({ "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION, "Content-Type": "application/json" }),
  buildBody(request) {
    return JSON.stringify({
      model: request.model,
      max_tokens: request.maxOutputTokens + ANTHROPIC_THINKING_HEADROOM_TOKENS,
      system: request.system,
      messages: [{ role: "user", content: request.user }],
      thinking: { type: "adaptive", display: "omitted" },
      output_config: { effort: ANTHROPIC_EFFORT, format: { type: "json_schema", schema: claudeJsonSchema(request.jsonSchema) } },
    });
  },
  parseAnswer: claudeAnswer,
  classifyStatus(status) {
    if (status === 402) return { code: "quota", outcome: "rejected" };
    // 529 overloaded and 504 timeout are server errors: the request may have run, so the outcome stays unknown.
    return commonStatus(status);
  },
  requestIdHeaders: ["request-id"],
};

export const WRITING_ADAPTERS: Readonly<Record<TitleWritingProviderKey, WritingAdapter>> = {
  openai: openAiWritingAdapter,
  anthropic: anthropicWritingAdapter,
};

function headerRequestId(adapter: WritingAdapter, headers: { get(name: string): string | null }, secret: string): string | null {
  for (const name of adapter.requestIdHeaders) {
    const id = safeId(headers.get(name), secret);
    if (id) return id;
  }
  return null;
}

/** The request id an error body may carry (Claude: request_id), when no header gave one. */
function errorBodyRequestId(bodyText: string, secret: string): string | null {
  const body = jsonObject(bodyText);
  return body ? safeId(body.request_id, secret) : null;
}

function isAbort(error: unknown, aborted: boolean): boolean {
  if (aborted) return true;
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * Sends exactly one request. It never retries, never follows a redirect, never switches provider or model, never
 * sends to any URL but the adapter's own, and never returns provider error bodies or the key.
 */
export async function sendWriting(options: {
  adapter: WritingAdapter;
  url: string;
  apiKey: string;
  request: WritingRequest;
  transport: WritingTransport;
  timeoutMs?: number;
  maxResponseBytes?: number;
}): Promise<WritingExchange> {
  const { adapter, apiKey } = options;
  const failed = (errorCode: WritingErrorCode, outcome: "rejected" | "unknown", providerRequestId: string | null = null): WritingExchange => ({
    outcome, errorCode, content: null, responseModel: null, providerRequestId, usage: UNKNOWN_USAGE,
  });
  // A configuration that names another endpoint is refused before anything leaves the process.
  if (options.url !== adapter.url) return failed("provider_error", "rejected");
  const timeoutMs = Math.min(options.timeoutMs ?? TEXT_WRITING_TIMEOUT_MS, TEXT_WRITING_TIMEOUT_MS);
  const maxBytes = Math.min(options.maxResponseBytes ?? TEXT_WRITING_MAX_RESPONSE_BYTES, TEXT_WRITING_MAX_RESPONSE_BYTES);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await options.transport({
      url: adapter.url,
      method: "POST",
      headers: adapter.headers(apiKey),
      body: adapter.buildBody(options.request),
      signal: controller.signal,
    });
    const headerId = headerRequestId(adapter, response.headers, apiKey);
    if (response.status === 0 || response.status < 200 || response.status >= 300) {
      let bodyText = "";
      try {
        bodyText = redactSecret(decodeResponseBytes(response.body, maxBytes), apiKey);
      } catch {
        bodyText = "";
      }
      const classified = adapter.classifyStatus(response.status, bodyText);
      return failed(classified.code, classified.outcome, headerId ?? errorBodyRequestId(bodyText, apiKey));
    }
    let raw: string;
    try {
      raw = redactSecret(decodeResponseBytes(response.body, maxBytes), apiKey);
    } catch (error) {
      const code = error instanceof ResponseBodyError && error.code === "response_too_large" ? "response_too_large" : "invalid_output";
      return failed(code, code === "response_too_large" ? "unknown" : "rejected", headerId);
    }
    const answer = adapter.parseAnswer(raw, apiKey);
    const providerRequestId = headerId ?? answer.bodyRequestId;
    if (answer.errorCode !== null || answer.content === null) {
      return { outcome: "rejected", errorCode: answer.errorCode ?? "invalid_output", content: null,
        responseModel: answer.responseModel, providerRequestId, usage: answer.usage };
    }
    return { outcome: "answered", errorCode: null, content: answer.content, responseModel: answer.responseModel,
      providerRequestId, usage: answer.usage };
  } catch (error) {
    if (error instanceof ResponseBodyError && error.code === "response_too_large") return failed("response_too_large", "unknown");
    return failed(isAbort(error, controller.signal.aborted) ? "timeout" : "disconnected", "unknown");
  } finally {
    clearTimeout(timer);
  }
}

export type WritingProviderConfig =
  | { providerKey: TitleWritingProviderKey; ok: true; url: string; apiKey: string; models: string[]; missing: [] }
  | { providerKey: TitleWritingProviderKey; ok: false; models: string[]; missing: string[] };

/** Only the active providers' variables. Retired providers' variables are ignored and never read. */
export interface TitleWritingProviderEnv {
  OPENAI_API_KEY?: string;
  TITLE_WRITING_OPENAI_MODELS?: string;
  ANTHROPIC_API_KEY?: string;
  TITLE_WRITING_ANTHROPIC_MODELS?: string;
}

/** Comma-separated model allowlist. The first entry is the default. Model names are never guessed. */
export function parseModelList(value: string | undefined): { ok: true; models: string[] } | { ok: false } {
  if (value === undefined || value.trim().length === 0) return { ok: false };
  const models = [...new Set(value.split(",").map((item) => item.trim()).filter((item) => item.length > 0))];
  if (models.length === 0 || models.length > 10 || models.some((model) => !/^[A-Za-z0-9._:-]{1,128}$/.test(model))) return { ok: false };
  return { ok: true, models };
}

function readKey(value: string | undefined): string | null {
  if (value === undefined || value.length < 8 || value.length > 256 || /\s/u.test(value)) return null;
  return value;
}

function configOf(providerKey: TitleWritingProviderKey, url: string, key: string | undefined, keyName: string,
  modelList: string | undefined, modelsName: string): WritingProviderConfig {
  const missing: string[] = [];
  let apiKey = readKey(key);
  // Claude takes an Anthropic Console API key only: an Anthropic credential of another kind (a Claude Code / subscription
  // OAuth token, an Admin API key) is never sent, even if configured. The console checks the full key shape on input.
  if (apiKey && providerKey === "anthropic" && anthropicKeyProblem(apiKey) === "not_api_key") apiKey = null;
  if (!apiKey) missing.push(keyName);
  // No model list but a key: the provider's documented default list (Claude only), so a key alone is a full setup.
  const defaults = TITLE_WRITING_DEFAULT_MODELS[providerKey];
  const listed = parseModelList(modelList);
  const models: { ok: true; models: string[] } | { ok: false } = listed.ok || (modelList ?? "").trim().length > 0 || defaults.length === 0
    ? listed : { ok: true, models: [...defaults] };
  if (!models.ok) missing.push(modelsName);
  return apiKey && models.ok
    ? { providerKey, ok: true, url, apiKey, models: models.models, missing: [] }
    : { providerKey, ok: false, models: models.ok ? models.models : [], missing };
}

/** Resolves keys, fixed endpoints and model allowlists from the API process. Only names of gaps are reported. */
export function titleWritingProviderConfigs(env: TitleWritingProviderEnv): Record<TitleWritingProviderKey, WritingProviderConfig> {
  return {
    openai: configOf("openai", OPENAI_RESPONSES_URL, env.OPENAI_API_KEY, "OPENAI_API_KEY",
      env.TITLE_WRITING_OPENAI_MODELS, "TITLE_WRITING_OPENAI_MODELS"),
    anthropic: configOf("anthropic", ANTHROPIC_MESSAGES_URL, env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY",
      env.TITLE_WRITING_ANTHROPIC_MODELS, "TITLE_WRITING_ANTHROPIC_MODELS"),
  };
}

/**
 * The configuration a stored run may send with. A run of a retired provider (or of any key this API has no entry for)
 * gets none, so the caller stops it as provider_unconfigured instead of reading a missing entry.
 */
export function providerConfigFor(
  providers: Readonly<Partial<Record<string, WritingProviderConfig>>>,
  providerKey: string,
): WritingProviderConfig | null {
  if (!Object.prototype.hasOwnProperty.call(WRITING_ADAPTERS, providerKey)) return null;
  return providers[providerKey] ?? null;
}
