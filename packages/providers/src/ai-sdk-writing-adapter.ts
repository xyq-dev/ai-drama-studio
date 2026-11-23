import { APICallError, generateText } from "ai";
import { createAlibaba } from "@ai-sdk/alibaba";
import { createDeepSeek } from "@ai-sdk/deepseek";
import {
  BAILIAN_COMPATIBLE_BASE_URL,
  DEEPSEEK_AI_SDK_BASE_URL,
  QWEN_PLUS_MODEL,
} from "@ai-drama/contracts";
import {
  TEXT_WRITING_TIMEOUT_MS,
  deepseekSystemMessage,
  type WritingErrorCode,
  type WritingExchange,
  type WritingRequest,
  type WritingUsage,
} from "./text-writing";

/**
 * Vercel AI SDK writing adapters for Bailian (qwen-plus, China compatible-mode) and DeepSeek.
 * The business layer receives a WritingExchange only. Provider bodies, headers and error text stay here.
 * maxRetries is 0: a timeout or an unclear result is unknown and is never sent again by this function.
 * The production feature probe is a different path and stays networkRefusingFeatureProbe().
 */
export type SdkWritingKind = "bailian" | "deepseek";

const UNKNOWN_USAGE: WritingUsage = { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null };

export function sdkWritingBaseUrl(kind: SdkWritingKind): string {
  return kind === "bailian" ? BAILIAN_COMPATIBLE_BASE_URL : DEEPSEEK_AI_SDK_BASE_URL;
}

export function sdkWritingChatUrl(kind: SdkWritingKind): string {
  return `${sdkWritingBaseUrl(kind)}/chat/completions`;
}

/**
 * Official JSON Output requires response_format type json_object on POST /chat/completions.
 * The AI SDK may omit it; the outbound body is patched so the protocol is explicit and testable.
 */
function withDeepseekJsonFormat(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    let next = init;
    if (init?.body && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body) as unknown;
        if (body && typeof body === "object" && !Array.isArray(body)) {
          (body as Record<string, unknown>).response_format = { type: "json_object" };
          next = { ...init, body: JSON.stringify(body) };
        }
      } catch {
        next = init;
      }
    }
    return fetchImpl(input, next);
  };
}

function exchange(
  outcome: WritingExchange["outcome"],
  errorCode: WritingErrorCode | null,
  extra: Partial<Pick<WritingExchange, "content" | "responseModel" | "providerRequestId" | "usage">> = {},
): WritingExchange {
  return {
    outcome,
    errorCode,
    content: extra.content ?? null,
    responseModel: extra.responseModel ?? null,
    providerRequestId: extra.providerRequestId ?? null,
    usage: extra.usage ?? UNKNOWN_USAGE,
  };
}

function safeToken(value: unknown, secret: string): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[\w.:/-]{1,128}$/.test(trimmed)) return null;
  if (secret.length > 0 && trimmed.includes(secret)) return null;
  return trimmed;
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function usageOf(usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined, secret: string): WritingUsage {
  const inputTokens = tokenCount(usage?.inputTokens);
  const outputTokens = tokenCount(usage?.outputTokens);
  const totalTokens = tokenCount(usage?.totalTokens);
  if (inputTokens === null || outputTokens === null || totalTokens === null) return UNKNOWN_USAGE;
  const packed = `${inputTokens}:${outputTokens}:${totalTokens}`;
  if (secret.length > 0 && packed.includes(secret)) return UNKNOWN_USAGE;
  return { status: "present", inputTokens, outputTokens, totalTokens };
}

function statusClass(status: number | undefined): { code: WritingErrorCode; outcome: "rejected" | "unknown" } {
  if (status === undefined) return { code: "disconnected", outcome: "unknown" };
  if (status === 401 || status === 403) return { code: "auth", outcome: "rejected" };
  if (status === 402) return { code: "quota", outcome: "rejected" };
  if (status === 429) return { code: "rate_limited", outcome: "rejected" };
  if (status === 400 || status === 404 || status === 413 || status === 422) return { code: "bad_request", outcome: "rejected" };
  if (status >= 500 && status <= 599) return { code: "server_error", outcome: "unknown" };
  if (status >= 300 && status < 400) return { code: "redirect_rejected", outcome: "unknown" };
  return { code: "provider_error", outcome: "rejected" };
}

function isAbort(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * One SDK call. fetchImpl is required so a missing test double cannot fall through to the real network.
 * The key is sent only as the provider credential. It is never copied onto the exchange.
 */
export async function sendAiSdkWriting(options: {
  kind: SdkWritingKind;
  apiKey: string;
  request: WritingRequest;
  fetchImpl: typeof fetch | undefined;
  timeoutMs?: number;
}): Promise<WritingExchange> {
  const { kind, apiKey, request } = options;
  if (!options.fetchImpl) return exchange("unknown", "disconnected");
  if (kind === "bailian" && request.model !== QWEN_PLUS_MODEL) return exchange("rejected", "bad_request");
  if (apiKey.length < 8 || /\s/u.test(apiKey)) return exchange("rejected", "auth");
  const timeoutMs = Math.min(options.timeoutMs ?? TEXT_WRITING_TIMEOUT_MS, TEXT_WRITING_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const baseURL = sdkWritingBaseUrl(kind);
  const fetchImpl = kind === "deepseek" ? withDeepseekJsonFormat(options.fetchImpl) : options.fetchImpl;
  try {
    const model = kind === "bailian"
      ? createAlibaba({ apiKey, baseURL, fetch: fetchImpl })(request.model)
      : createDeepSeek({ apiKey, baseURL, fetch: fetchImpl })(request.model);
    const result = await generateText({
      model,
      system: deepseekSystemMessage(request.system, request.schemaName, request.jsonSchema),
      prompt: request.user,
      maxOutputTokens: request.maxOutputTokens,
      maxRetries: 0,
      timeout: timeoutMs,
      abortSignal: controller.signal,
      providerOptions: kind === "bailian"
        ? { alibaba: { enableThinking: false } }
        : { deepseek: { thinking: { type: "disabled" } } },
    });
    const responseModel = safeToken(result.response.modelId, apiKey);
    const providerRequestId = safeToken(result.response.id, apiKey);
    const usage = usageOf(result.usage, apiKey);
    const text = result.text.trim();
    if (apiKey.length > 0 && text.includes(apiKey)) return exchange("rejected", "invalid_output", { responseModel, providerRequestId, usage });
    if (result.finishReason === "length") return exchange("rejected", "truncated", { responseModel, providerRequestId, usage });
    if (result.finishReason === "content-filter") return exchange("rejected", "refusal", { responseModel, providerRequestId, usage });
    if (result.finishReason === "error" || result.finishReason === "other" || result.finishReason === "interrupted") {
      return exchange("unknown", "provider_error", { responseModel, providerRequestId, usage });
    }
    if (result.finishReason !== "stop" || text.length === 0) {
      return exchange("rejected", "invalid_output", { responseModel, providerRequestId, usage });
    }
    return exchange("answered", null, { content: text, responseModel, providerRequestId, usage });
  } catch (error) {
    if (isAbort(error) || controller.signal.aborted) return exchange("unknown", "timeout");
    if (APICallError.isInstance(error)) {
      const classified = statusClass(error.statusCode);
      return exchange(classified.outcome, classified.code);
    }
    return exchange("unknown", "disconnected");
  } finally {
    clearTimeout(timer);
  }
}
