export const QWEN_CHAT_DEFAULT_MODEL = "qwen3.7-plus-2026-05-26";
export const QWEN_CHAT_MODEL_ENV = "QWEN_TEXT_TRIAL_MODEL";
export const QWEN_CHAT_MAX_TOKENS = 4_096;
export const QWEN_CHAT_TIMEOUT_MS = 60_000;
export const QWEN_CHAT_MAX_RESPONSE_BYTES = 1_048_576;

const OFFICIAL_HOSTS = new Set([
  "dashscope.aliyuncs.com",
  "dashscope-intl.aliyuncs.com",
  "dashscope-us.aliyuncs.com",
  "cn-hongkong.dashscope.aliyuncs.com",
]);

const MAAS_REGIONS = new Set([
  "cn-beijing",
  "ap-southeast-1",
  "eu-central-1",
  "ap-northeast-1",
  "cn-hongkong",
  "us-east-1",
]);

export class QwenChatError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly billingUnknown: boolean,
  ) {
    super(message);
    this.name = "QwenChatError";
  }
}

export interface QwenTransportRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export interface QwenTransportResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: Uint8Array | null;
}

export type QwenTransport = (request: QwenTransportRequest) => Promise<QwenTransportResponse>;

export interface QwenUsage {
  status: "present" | "unknown";
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface QwenParsedCompletion {
  responseModel: string | null;
  serverRequestId: string | null;
  usage: QwenUsage;
  content: string | null;
  errorCode: string | null;
}

export interface QwenChatExchange {
  requestCount: 1;
  errorCode: string | null;
  providerResult: "completed" | "unknown";
  responseModel: string | null;
  serverRequestId: string | null;
  usage: QwenUsage;
  content: string | null;
}

export function qwenFailureMessage(code: string): string {
  const messages: Record<string, string> = {
    missing_api_key: "DASHSCOPE_API_KEY is missing.",
    invalid_api_key: "DASHSCOPE_API_KEY is not a usable process value.",
    missing_base_url: "BAILIAN_BASE_URL is missing.",
    invalid_base_url: "BAILIAN_BASE_URL is not an official HTTPS compatible-mode endpoint.",
    embedded_credentials: "BAILIAN_BASE_URL must not contain credentials.",
    unofficial_host: "BAILIAN_BASE_URL host is not an official Bailian endpoint.",
    invalid_model: "QWEN_TEXT_TRIAL_MODEL is not a single explicit model id.",
    redirect_rejected: "The endpoint returned a redirect. The provider result and billing are unknown. A charge may already exist. The client did not follow it or send another request, and does not recommend an unconditional retry.",
    unauthorized: "The model endpoint rejected the credentials.",
    rate_limited: "The model endpoint rate-limited the request.",
    server_error: "The model endpoint returned a server error. The provider result and billing are unknown. A charge may already exist. The client did not send another request, did not switch models, and does not recommend an unconditional retry.",
    provider_error: "The model endpoint returned an unexpected status.",
    refusal: "The model refused the request.",
    truncated: "The model output was truncated by the token limit.",
    tool_call: "The model response contained a tool call. No tool was executed.",
    invalid_finish: "The model response did not finish with stop.",
    invalid_json: "The model output was not valid JSON.",
    invalid_utf8: "The model response was not strict UTF-8.",
    invalid_response: "The model response did not contain one completion.",
    timeout: "The request timed out. The provider result and billing are unknown. A charge may already exist. The client did not send another request and does not recommend an unconditional retry.",
    disconnected: "The connection failed before a complete response. The provider result and billing are unknown. A charge may already exist. The client did not send another request and does not recommend an unconditional retry.",
    response_too_large: "The response exceeded the size limit and was stopped. The provider result and billing are unknown. A charge may already exist. The client did not send another request and does not recommend an unconditional retry.",
    output_exists: "The output directory already exists. It was not overwritten.",
    invalid_input: "The input JSON failed validation.",
    invalid_candidate: "The model output did not match the writing candidate schema.",
    episode_mismatch: "The model output episode number does not match the request.",
    too_large: "The model output exceeds a writing limit and was not truncated.",
    unsafe_content: "The model output contains unsafe text.",
    save_failed: "Saving the local result failed. A charge may already exist. The client did not call the model again and does not recommend an unconditional retry.",
  };
  return messages[code] ?? "The Qwen request failed.";
}

export function redactSecret(text: string, secret: string | null): string {
  if (!secret || secret.length === 0 || !text.includes(secret)) return text;
  return text.split(secret).join("[redacted]");
}

function officialHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (OFFICIAL_HOSTS.has(host)) return true;
  const parts = host.split(".");
  if (parts.length !== 5 || parts[2] !== "maas" || parts[3] !== "aliyuncs" || parts[4] !== "com") return false;
  const region = parts[1];
  const label = parts[0];
  if (!region || !label || !MAAS_REGIONS.has(region)) return false;
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
}

export function resolveQwenChatEndpoint(baseUrl: string): { ok: true; url: string; host: string } | { ok: false; code: string } {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { ok: false, code: "invalid_base_url" };
  }
  if (parsed.username || parsed.password) return { ok: false, code: "embedded_credentials" };
  if (parsed.protocol !== "https:") return { ok: false, code: "invalid_base_url" };
  if (parsed.port !== "" && parsed.port !== "443") return { ok: false, code: "invalid_base_url" };
  if (parsed.search || parsed.hash) return { ok: false, code: "invalid_base_url" };
  if (!officialHost(parsed.hostname)) return { ok: false, code: "unofficial_host" };
  const path = parsed.pathname.replace(/\/+$/, "");
  if (path !== "/compatible-mode/v1") return { ok: false, code: "invalid_base_url" };
  return { ok: true, url: `${parsed.origin}/compatible-mode/v1/chat/completions`, host: parsed.hostname.toLowerCase() };
}

export function selectedQwenModel(env: NodeJS.ProcessEnv): { ok: true; model: string } | { ok: false; code: "invalid_model" } {
  const override = env[QWEN_CHAT_MODEL_ENV];
  if (override === undefined) return { ok: true, model: QWEN_CHAT_DEFAULT_MODEL };
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(override)) return { ok: false, code: "invalid_model" };
  return { ok: true, model: override };
}

export function readQwenApiKey(env: NodeJS.ProcessEnv): { ok: true; apiKey: string } | { ok: false; code: string } {
  const apiKey = env.DASHSCOPE_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) return { ok: false, code: "missing_api_key" };
  if (apiKey.length < 8 || apiKey.length > 256 || /\s/u.test(apiKey)) return { ok: false, code: "invalid_api_key" };
  return { ok: true, apiKey };
}

export function buildQwenChatBody(input: {
  model: string;
  system: string;
  user: string;
  tokenLimitField: "max_tokens" | "max_completion_tokens";
}): string {
  return JSON.stringify({
    model: input.model,
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
    stream: false,
    enable_thinking: false,
    [input.tokenLimitField]: QWEN_CHAT_MAX_TOKENS,
    n: 1,
    response_format: { type: "json_object" },
  });
}

function headerValue(headers: { get(name: string): string | null }, name: string): string | null {
  const value = headers.get(name);
  if (!value) return null;
  const trimmed = value.trim();
  return /^[\w.:-]{1,128}$/.test(trimmed) ? trimmed : null;
}

function serverRequestId(headers: { get(name: string): string | null }, bodyId: unknown, secret: string): string | null {
  const fromHeader = headerValue(headers, "x-request-id") ?? headerValue(headers, "x-dashscope-request-id");
  const candidate = fromHeader ?? (typeof bodyId === "string" ? bodyId.trim() : "");
  if (!/^[\w.:-]{1,128}$/.test(candidate) || candidate.includes(secret)) return null;
  return candidate;
}

export function qwenUsageOf(value: unknown): QwenUsage {
  if (!value || typeof value !== "object") {
    return { status: "unknown", promptTokens: null, completionTokens: null, totalTokens: null };
  }
  const record = value as Record<string, unknown>;
  const prompt = record.prompt_tokens;
  const completion = record.completion_tokens;
  const total = record.total_tokens;
  const valid = (item: unknown): item is number => typeof item === "number" && Number.isInteger(item) && item >= 0;
  if (!valid(prompt) || !valid(completion) || !valid(total)) {
    return { status: "unknown", promptTokens: null, completionTokens: null, totalTokens: null };
  }
  return { status: "present", promptTokens: prompt, completionTokens: completion, totalTokens: total };
}

function emptyCompletion(headers: { get(name: string): string | null }, secret: string, errorCode: string): QwenParsedCompletion {
  return {
    responseModel: null,
    serverRequestId: serverRequestId(headers, null, secret),
    usage: qwenUsageOf(null),
    content: null,
    errorCode,
  };
}

function hasToolCall(message: Record<string, unknown>): boolean {
  const tools = message.tool_calls;
  if (Array.isArray(tools) && tools.length > 0) return true;
  const call = message.function_call;
  if (typeof call === "string" && call.trim().length > 0) return true;
  return Boolean(call) && typeof call === "object";
}

export function parseQwenChatCompletion(raw: string, headers: { get(name: string): string | null }, secret: string): QwenParsedCompletion {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return emptyCompletion(headers, secret, "invalid_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return emptyCompletion(headers, secret, "invalid_response");
  }
  const record = parsed as Record<string, unknown>;
  const modelText = typeof record.model === "string" ? record.model.trim() : "";
  const responseModel = /^[\w.:-]{1,128}$/.test(modelText) ? modelText : null;
  const id = serverRequestId(headers, record.id, secret);
  const usage = qwenUsageOf(record.usage);
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length !== 1) {
    return { responseModel, serverRequestId: id, usage, content: null, errorCode: "invalid_response" };
  }
  const choice = choices[0];
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
    return { responseModel, serverRequestId: id, usage, content: null, errorCode: "invalid_response" };
  }
  const choiceRecord = choice as Record<string, unknown>;
  const message = choiceRecord.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { responseModel, serverRequestId: id, usage, content: null, errorCode: "invalid_response" };
  }
  const messageRecord = message as Record<string, unknown>;
  if (hasToolCall(messageRecord)) {
    return { responseModel, serverRequestId: id, usage, content: null, errorCode: "tool_call" };
  }
  const refusal = messageRecord.refusal;
  const finish = choiceRecord.finish_reason;
  if (finish === "content_filter" || (typeof refusal === "string" && refusal.trim().length > 0)) {
    return { responseModel, serverRequestId: id, usage, content: null, errorCode: "refusal" };
  }
  if (finish === "length") {
    return { responseModel, serverRequestId: id, usage, content: null, errorCode: "truncated" };
  }
  if (finish !== "stop") {
    return { responseModel, serverRequestId: id, usage, content: null, errorCode: "invalid_finish" };
  }
  const content = messageRecord.content;
  if (typeof content !== "string" || content.length === 0) {
    return { responseModel, serverRequestId: id, usage, content: null, errorCode: "invalid_response" };
  }
  return { responseModel, serverRequestId: id, usage, content, errorCode: null };
}

export function decodeQwenResponseBytes(bytes: Uint8Array | null, maxBytes: number): string {
  if (!bytes || bytes.byteLength === 0) return "";
  if (bytes.byteLength > maxBytes) {
    throw new QwenChatError("response_too_large", qwenFailureMessage("response_too_large"), true);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new QwenChatError("invalid_utf8", qwenFailureMessage("invalid_utf8"), false);
  }
}

async function readLimited(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new QwenChatError("response_too_large", qwenFailureMessage("response_too_large"), true);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function createQwenFetchTransport(fetchImpl: typeof fetch = globalThis.fetch, maxBytes = QWEN_CHAT_MAX_RESPONSE_BYTES): QwenTransport {
  return async (request) => {
    const response = await fetchImpl(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      redirect: "manual",
      signal: request.signal,
    });
    if (response.status === 0 || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      return { status: response.status, headers: response.headers, body: null };
    }
    return { status: response.status, headers: response.headers, body: await readLimited(response.body, maxBytes) };
  };
}

function requestIdFromBody(body: Uint8Array | null, secret: string, maxBytes: number): string | null {
  if (!body || body.byteLength === 0) return null;
  let raw: string;
  try {
    raw = decodeQwenResponseBytes(body, maxBytes);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const nested = record.error;
    const nestedId = nested && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>).request_id
      : undefined;
    return serverRequestId({ get: () => null }, record.request_id ?? record.id ?? nestedId, secret);
  } catch {
    return null;
  }
}

function responseRequestId(
  headers: { get(name: string): string | null },
  body: Uint8Array | null,
  secret: string,
  maxBytes: number,
): string | null {
  return serverRequestId(headers, null, secret) ?? requestIdFromBody(body, secret, maxBytes);
}

function statusForHttp(status: number): string {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limited";
  if (status >= 500 && status <= 599) return "server_error";
  if (status === 0 || (status >= 300 && status < 400)) return "redirect_rejected";
  return "provider_error";
}

function isTimeout(error: unknown, aborted: boolean): boolean {
  if (aborted) return true;
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  return name === "TimeoutError" || name === "AbortError";
}

export async function sendQwenChat(options: {
  url: string;
  apiKey: string;
  body: string;
  transport: QwenTransport;
  timeoutMs?: number;
  maxResponseBytes?: number;
}): Promise<QwenChatExchange> {
  const timeoutMs = Math.min(options.timeoutMs ?? QWEN_CHAT_TIMEOUT_MS, QWEN_CHAT_TIMEOUT_MS);
  const maxBytes = Math.min(options.maxResponseBytes ?? QWEN_CHAT_MAX_RESPONSE_BYTES, QWEN_CHAT_MAX_RESPONSE_BYTES);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const failed = (
    errorCode: string,
    providerResult: "completed" | "unknown",
    requestId: string | null = null,
  ): QwenChatExchange => ({
    requestCount: 1,
    errorCode,
    providerResult,
    responseModel: null,
    serverRequestId: requestId,
    usage: qwenUsageOf(null),
    content: null,
  });
  try {
    const response = await options.transport({
      url: options.url,
      method: "POST",
      headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
      body: options.body,
      signal: controller.signal,
    });
    if (response.status === 0 || response.status < 200 || response.status >= 300) {
      const code = statusForHttp(response.status);
      const uncertain = code === "redirect_rejected" || code === "server_error";
      const requestId = responseRequestId(response.headers, response.body, options.apiKey, maxBytes);
      return failed(code, uncertain ? "unknown" : "completed", requestId);
    }
    let raw: string;
    try {
      raw = redactSecret(decodeQwenResponseBytes(response.body, maxBytes), options.apiKey);
    } catch (error) {
      const code = error instanceof QwenChatError ? error.code : "invalid_response";
      return failed(code, code === "response_too_large" ? "unknown" : "completed");
    }
    const completion = parseQwenChatCompletion(raw, response.headers, options.apiKey);
    return {
      requestCount: 1,
      errorCode: completion.errorCode,
      providerResult: "completed",
      responseModel: completion.responseModel,
      serverRequestId: completion.serverRequestId,
      usage: completion.usage,
      content: completion.content,
    };
  } catch (error) {
    const code = error instanceof QwenChatError
      ? error.code
      : isTimeout(error, controller.signal.aborted) ? "timeout" : "disconnected";
    return failed(code, "unknown");
  } finally {
    clearTimeout(timer);
  }
}
