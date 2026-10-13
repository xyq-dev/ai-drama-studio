import type { TitleWritingProviderKey } from "@ai-drama/contracts";
import {
  decodeQwenResponseBytes,
  parseQwenChatCompletion,
  qwenUsageOf,
  readQwenApiKey,
  redactSecret,
  resolveQwenChatEndpoint,
  QwenChatError,
  type QwenTransport,
} from "./qwen-chat";

/**
 * Provider-neutral text generation for the title-driven writing run. Business code sees one request shape, one
 * result shape and one error classification; every vendor difference stays inside its adapter.
 *
 * Checked against the official documentation on 2026-10-08:
 * - Qwen (Bailian compatible mode): POST {base}/chat/completions, response_format json_object, enable_thinking false,
 *   max_completion_tokens, finish_reason stop/length/content_filter.
 * - OpenAI: POST https://api.openai.com/v1/responses, text.format json_schema (name, schema, strict), max_output_tokens,
 *   status completed/incomplete with incomplete_details.reason, refusal content items, usage input/output/total_tokens,
 *   429 insufficient_quota for an exhausted balance.
 * - DeepSeek: POST https://api.deepseek.com/chat/completions, response_format json_object (the prompt must say json and
 *   may still come back empty), thinking {type: disabled}, max_tokens, 402 for an exhausted balance.
 */
export type WritingTransport = QwenTransport;

export const TEXT_WRITING_MAX_OUTPUT_TOKENS = 4_096;
export const TEXT_WRITING_TIMEOUT_MS = 120_000;
export const TEXT_WRITING_MAX_RESPONSE_BYTES = 1_048_576;

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
export const DEEPSEEK_CHAT_URL = "https://api.deepseek.com/chat/completions";

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
  buildBody(request: WritingRequest): string;
  parseAnswer(raw: string, secret: string): ParsedAnswer;
  classifyStatus(status: number, bodyText: string): { code: WritingErrorCode; outcome: "rejected" | "unknown" };
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

function chatUsage(value: unknown): WritingUsage {
  const usage = qwenUsageOf(value);
  return usage.status === "present"
    ? { status: "present", inputTokens: usage.promptTokens, outputTokens: usage.completionTokens, totalTokens: usage.totalTokens }
    : UNKNOWN_USAGE;
}

/** Shared HTTP meaning. A 5xx or redirect may follow a processed request, so the result is unknown. */
function commonStatus(status: number): { code: WritingErrorCode; outcome: "rejected" | "unknown" } {
  if (status === 0 || (status >= 300 && status < 400)) return { code: "redirect_rejected", outcome: "unknown" };
  if (status === 401 || status === 403) return { code: "auth", outcome: "rejected" };
  if (status === 429) return { code: "rate_limited", outcome: "rejected" };
  if (status === 400 || status === 404 || status === 422) return { code: "bad_request", outcome: "rejected" };
  if (status >= 500 && status <= 599) return { code: "server_error", outcome: "unknown" };
  return { code: "provider_error", outcome: "rejected" };
}

function chatAnswer(raw: string, secret: string): ParsedAnswer {
  const parsed = parseQwenChatCompletion(raw, { get: () => null }, secret);
  let usage = UNKNOWN_USAGE;
  let bodyRequestId: string | null = null;
  try {
    const body = JSON.parse(raw) as Record<string, unknown>;
    usage = chatUsage(body.usage);
    bodyRequestId = safeId(body.id, secret);
  } catch {
    // Not JSON: the parser above already reported invalid output and usage stays unknown.
  }
  const map: Record<string, WritingErrorCode> = {
    refusal: "refusal",
    truncated: "truncated",
  };
  const errorCode = parsed.errorCode === null ? null : (map[parsed.errorCode] ?? "invalid_output");
  return { errorCode, content: parsed.content, responseModel: parsed.responseModel, bodyRequestId, usage };
}

export const qwenWritingAdapter: WritingAdapter = {
  providerKey: "qwen",
  label: "千问",
  buildBody(request) {
    return JSON.stringify({
      model: request.model,
      messages: [{ role: "system", content: request.system }, { role: "user", content: request.user }],
      stream: false,
      enable_thinking: false,
      max_completion_tokens: request.maxOutputTokens,
      n: 1,
      response_format: { type: "json_object" },
    });
  },
  parseAnswer: chatAnswer,
  classifyStatus: (status) => commonStatus(status),
};

export const deepseekWritingAdapter: WritingAdapter = {
  providerKey: "deepseek",
  label: "DeepSeek",
  buildBody(request) {
    return JSON.stringify({
      model: request.model,
      messages: [{ role: "system", content: request.system }, { role: "user", content: request.user }],
      stream: false,
      thinking: { type: "disabled" },
      max_tokens: request.maxOutputTokens,
      response_format: { type: "json_object" },
    });
  },
  parseAnswer: chatAnswer,
  classifyStatus(status) {
    if (status === 402) return { code: "quota", outcome: "rejected" };
    return commonStatus(status);
  },
};

function openAiAnswer(raw: string, secret: string): ParsedAnswer {
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return { errorCode: "invalid_output", content: null, responseModel: null, bodyRequestId: null, usage: UNKNOWN_USAGE };
  }
  const usageRecord = body.usage && typeof body.usage === "object" ? body.usage as Record<string, unknown> : null;
  const count = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
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
};

export const WRITING_ADAPTERS: Readonly<Record<TitleWritingProviderKey, WritingAdapter>> = {
  qwen: qwenWritingAdapter,
  openai: openAiWritingAdapter,
  deepseek: deepseekWritingAdapter,
};

function headerRequestId(headers: { get(name: string): string | null }, secret: string): string | null {
  return safeId(headers.get("x-request-id"), secret) ?? safeId(headers.get("x-dashscope-request-id"), secret);
}

function isAbort(error: unknown, aborted: boolean): boolean {
  if (aborted) return true;
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * Sends exactly one request. It never retries, never follows a redirect, never switches provider or model, and
 * never returns provider error bodies or the key.
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
  const timeoutMs = Math.min(options.timeoutMs ?? TEXT_WRITING_TIMEOUT_MS, TEXT_WRITING_TIMEOUT_MS);
  const maxBytes = Math.min(options.maxResponseBytes ?? TEXT_WRITING_MAX_RESPONSE_BYTES, TEXT_WRITING_MAX_RESPONSE_BYTES);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const failed = (errorCode: WritingErrorCode, outcome: "rejected" | "unknown", providerRequestId: string | null = null): WritingExchange => ({
    outcome, errorCode, content: null, responseModel: null, providerRequestId, usage: UNKNOWN_USAGE,
  });
  try {
    const response = await options.transport({
      url: options.url,
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: adapter.buildBody(options.request),
      signal: controller.signal,
    });
    const headerId = headerRequestId(response.headers, apiKey);
    if (response.status === 0 || response.status < 200 || response.status >= 300) {
      let bodyText = "";
      try {
        bodyText = redactSecret(decodeQwenResponseBytes(response.body, maxBytes), apiKey);
      } catch {
        bodyText = "";
      }
      const classified = adapter.classifyStatus(response.status, bodyText);
      return failed(classified.code, classified.outcome, headerId);
    }
    let raw: string;
    try {
      raw = redactSecret(decodeQwenResponseBytes(response.body, maxBytes), apiKey);
    } catch (error) {
      const code = error instanceof QwenChatError && error.code === "response_too_large" ? "response_too_large" : "invalid_output";
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
    if (error instanceof QwenChatError && error.code === "response_too_large") return failed("response_too_large", "unknown");
    return failed(isAbort(error, controller.signal.aborted) ? "timeout" : "disconnected", "unknown");
  } finally {
    clearTimeout(timer);
  }
}

export type WritingProviderConfig =
  | { providerKey: TitleWritingProviderKey; ok: true; url: string; apiKey: string; models: string[]; missing: [] }
  | { providerKey: TitleWritingProviderKey; ok: false; models: string[]; missing: string[] };

export interface TitleWritingProviderEnv {
  DASHSCOPE_API_KEY?: string;
  BAILIAN_BASE_URL?: string;
  TITLE_WRITING_QWEN_MODELS?: string;
  OPENAI_API_KEY?: string;
  TITLE_WRITING_OPENAI_MODELS?: string;
  DEEPSEEK_API_KEY?: string;
  TITLE_WRITING_DEEPSEEK_MODELS?: string;
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

/** Resolves keys, controlled endpoints and model allowlists from the API process. Only names of gaps are reported. */
export function titleWritingProviderConfigs(env: TitleWritingProviderEnv): Record<TitleWritingProviderKey, WritingProviderConfig> {
  const qwenMissing: string[] = [];
  const qwenKey = readQwenApiKey({ DASHSCOPE_API_KEY: env.DASHSCOPE_API_KEY });
  if (!qwenKey.ok) qwenMissing.push("DASHSCOPE_API_KEY");
  const qwenEndpoint = env.BAILIAN_BASE_URL ? resolveQwenChatEndpoint(env.BAILIAN_BASE_URL) : { ok: false as const, code: "missing_base_url" };
  if (!qwenEndpoint.ok) qwenMissing.push("BAILIAN_BASE_URL");
  const qwenModels = parseModelList(env.TITLE_WRITING_QWEN_MODELS);
  if (!qwenModels.ok) qwenMissing.push("TITLE_WRITING_QWEN_MODELS");

  const openAiMissing: string[] = [];
  const openAiKey = readKey(env.OPENAI_API_KEY);
  if (!openAiKey) openAiMissing.push("OPENAI_API_KEY");
  const openAiModels = parseModelList(env.TITLE_WRITING_OPENAI_MODELS);
  if (!openAiModels.ok) openAiMissing.push("TITLE_WRITING_OPENAI_MODELS");

  const deepseekMissing: string[] = [];
  const deepseekKey = readKey(env.DEEPSEEK_API_KEY);
  if (!deepseekKey) deepseekMissing.push("DEEPSEEK_API_KEY");
  const deepseekModels = parseModelList(env.TITLE_WRITING_DEEPSEEK_MODELS);
  if (!deepseekModels.ok) deepseekMissing.push("TITLE_WRITING_DEEPSEEK_MODELS");

  return {
    qwen: qwenMissing.length === 0 && qwenKey.ok && qwenEndpoint.ok && qwenModels.ok
      ? { providerKey: "qwen", ok: true, url: qwenEndpoint.url, apiKey: qwenKey.apiKey, models: qwenModels.models, missing: [] }
      : { providerKey: "qwen", ok: false, models: qwenModels.ok ? qwenModels.models : [], missing: qwenMissing },
    openai: openAiKey && openAiModels.ok
      ? { providerKey: "openai", ok: true, url: OPENAI_RESPONSES_URL, apiKey: openAiKey, models: openAiModels.models, missing: [] }
      : { providerKey: "openai", ok: false, models: openAiModels.ok ? openAiModels.models : [], missing: openAiMissing },
    deepseek: deepseekKey && deepseekModels.ok
      ? { providerKey: "deepseek", ok: true, url: DEEPSEEK_CHAT_URL, apiKey: deepseekKey, models: deepseekModels.models, missing: [] }
      : { providerKey: "deepseek", ok: false, models: deepseekModels.ok ? deepseekModels.models : [], missing: deepseekMissing },
  };
}
