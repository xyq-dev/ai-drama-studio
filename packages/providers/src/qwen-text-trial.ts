import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  QWEN_TEXT_TRIAL_DRAFT_SCHEMA,
  QWEN_TEXT_TRIAL_LIMITS,
  QWEN_TEXT_TRIAL_RECEIPT_SCHEMA,
  parseQwenTextTrialDraft,
  parseQwenTextTrialInput,
  qwenTextTrialReceiptSchema,
  type QwenTextTrialDraft,
  type QwenTextTrialInput,
  type QwenTextTrialReceipt,
} from "@ai-drama/contracts";

export const QWEN_TEXT_TRIAL_DEFAULT_MODEL = "qwen3.7-plus-2026-05-26";
export const QWEN_TEXT_TRIAL_MODEL_ENV = "QWEN_TEXT_TRIAL_MODEL";
export const QWEN_TEXT_TRIAL_MAX_TOKENS = 4_096;
export const QWEN_TEXT_TRIAL_TIMEOUT_MS = 60_000;
export const QWEN_TEXT_TRIAL_MAX_RESPONSE_BYTES = 1_048_576;

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

const SYSTEM_PROMPT = [
  "你是中文短剧编剧助手。只输出一个 JSON 对象，不要 Markdown，不要解释。",
  `JSON 的 schema 必须是 ${QWEN_TEXT_TRIAL_DRAFT_SCHEMA}。`,
  "这是待人工审核的候选草稿。不要输出 APPROVED、CURRENT、revisionId、projectId、episodeId 或任何业务资产身份。",
  "targetDurationSeconds 只是写作目标，不要声称成片时长已经达到，也不要输出实际时长字段。",
].join("");

export class QwenTextTrialError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly billingUnknown: boolean,
  ) {
    super(message);
    this.name = "QwenTextTrialError";
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

export interface QwenTextTrialResult {
  ok: boolean;
  exitCode: number;
  status: "dry_run" | "draft_saved" | "draft_rejected" | "provider_error" | "billing_unknown" | "save_failed" | "rejected";
  code: string | null;
  lines: string[];
  requestCount: number;
}

interface RunOptions {
  mode: "dry_run" | "execute";
  input: unknown;
  outputDir: string;
  env: NodeJS.ProcessEnv;
  transport?: QwenTransport;
  timeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => Date;
  runId?: string;
  mkdirImpl?: (path: string) => Promise<void>;
  writeFileImpl?: (path: string, data: string) => Promise<void>;
}

function message(code: string): string {
  const messages: Record<string, string> = {
    missing_api_key: "DASHSCOPE_API_KEY is missing.",
    invalid_api_key: "DASHSCOPE_API_KEY is not a usable process value.",
    missing_base_url: "BAILIAN_BASE_URL is missing.",
    invalid_base_url: "BAILIAN_BASE_URL is not an official HTTPS compatible-mode endpoint.",
    embedded_credentials: "BAILIAN_BASE_URL must not contain credentials.",
    unofficial_host: "BAILIAN_BASE_URL host is not an official Bailian endpoint.",
    invalid_model: "QWEN_TEXT_TRIAL_MODEL is not a single explicit model id.",
    redirect_rejected: "The endpoint returned a redirect. The provider result and billing are unknown. The client did not follow it or send another request.",
    unauthorized: "The model endpoint rejected the credentials.",
    rate_limited: "The model endpoint rate-limited the request.",
    server_error: "The model endpoint returned a server error.",
    provider_error: "The model endpoint returned an unexpected status.",
    refusal: "The model refused the draft request.",
    truncated: "The model output was truncated by the token limit.",
    invalid_json: "The model output was not valid JSON.",
    invalid_draft: "The model JSON failed the draft schema.",
    invalid_response: "The model response did not contain a completion.",
    timeout: "The request timed out. The provider result and billing are unknown. The client did not send another request.",
    disconnected: "The connection failed before a complete response. The provider result and billing are unknown. The client did not send another request.",
    response_too_large: "The response exceeded the size limit and was stopped. The provider result and billing are unknown. The client did not send another request.",
    output_exists: "The output directory already exists. It was not overwritten.",
    invalid_input: "The input JSON failed validation.",
    save_failed: "Saving the local result failed. The client did not call the model again.",
  };
  return messages[code] ?? "The Qwen text trial failed.";
}

function redact(text: string, secret: string | null): string {
  if (!secret || secret.length === 0 || !text.includes(secret)) return text;
  return text.split(secret).join("[redacted]");
}

function finish(status: QwenTextTrialResult["status"], code: string | null, lines: string[], requestCount: number, secret: string | null): QwenTextTrialResult {
  const safeLines = lines.map((line) => redact(line, secret));
  const failed = status !== "dry_run" && status !== "draft_saved";
  return { ok: !failed, exitCode: failed ? 1 : 0, status, code, lines: safeLines, requestCount };
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

export function resolveQwenTextTrialEndpoint(baseUrl: string): { ok: true; url: string; host: string } | { ok: false; code: string } {
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

function selectedModel(env: NodeJS.ProcessEnv): { ok: true; model: string } | { ok: false; code: "invalid_model" } {
  const override = env[QWEN_TEXT_TRIAL_MODEL_ENV];
  if (override === undefined) return { ok: true, model: QWEN_TEXT_TRIAL_DEFAULT_MODEL };
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(override)) return { ok: false, code: "invalid_model" };
  return { ok: true, model: override };
}

function readApiKey(env: NodeJS.ProcessEnv): { ok: true; apiKey: string } | { ok: false; code: string } {
  const apiKey = env.DASHSCOPE_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) return { ok: false, code: "missing_api_key" };
  if (apiKey.length < 8 || apiKey.length > 256 || /\s/u.test(apiKey)) return { ok: false, code: "invalid_api_key" };
  return { ok: true, apiKey };
}

function userPrompt(input: QwenTextTrialInput): string {
  const tone = input.tone ? `语气：${input.tone}\n` : "";
  return [
    `请写一集中文短剧候选剧本。写作目标时长 ${input.targetDurationSeconds} 秒，这只是写作目标。`,
    tone,
    `创意：${input.idea}`,
    "输出字段：title、logline、characters[{name, summary}]、scenes[{ordinal, title, action, dialogue[{character, line}]}]。",
    "场景 ordinal 从 1 连续递增。人物名称不能重复。对白角色必须出现在人物表中。",
  ].filter((line) => line.length > 0).join("\n");
}

function requestBody(model: string, input: QwenTextTrialInput): string {
  return JSON.stringify({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt(input) },
    ],
    stream: false,
    enable_thinking: false,
    max_tokens: QWEN_TEXT_TRIAL_MAX_TOKENS,
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

function usageOf(value: unknown): QwenTextTrialReceipt["usage"] {
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

function receipt(input: Omit<QwenTextTrialReceipt, "schema" | "billing" | "durationNote" | "reviewNote">): QwenTextTrialReceipt {
  return qwenTextTrialReceiptSchema.parse({
    schema: QWEN_TEXT_TRIAL_RECEIPT_SCHEMA,
    billing: { amount: null, currency: null, status: "unknown" },
    durationNote: "writing_target_only",
    reviewNote: "candidate_draft_pending_human_review",
    ...input,
  });
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
        throw new QwenTextTrialError("response_too_large", message("response_too_large"), true);
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

export function createFetchTransport(fetchImpl: typeof fetch = globalThis.fetch, maxBytes = QWEN_TEXT_TRIAL_MAX_RESPONSE_BYTES): QwenTransport {
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

function decodeBody(bytes: Uint8Array | null, maxBytes: number, secret: string): string {
  if (!bytes || bytes.byteLength === 0) return "";
  if (bytes.byteLength > maxBytes) throw new QwenTextTrialError("response_too_large", message("response_too_large"), true);
  return redact(new TextDecoder().decode(bytes), secret);
}

interface Completion {
  responseModel: string | null;
  serverRequestId: string | null;
  usage: QwenTextTrialReceipt["usage"];
  draft: QwenTextTrialDraft | null;
  errorCode: string | null;
}

function parseCompletion(raw: string, headers: { get(name: string): string | null }, secret: string): Completion {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { responseModel: null, serverRequestId: serverRequestId(headers, null, secret), usage: usageOf(null), draft: null, errorCode: "invalid_json" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { responseModel: null, serverRequestId: serverRequestId(headers, null, secret), usage: usageOf(null), draft: null, errorCode: "invalid_response" };
  }
  const record = parsed as Record<string, unknown>;
  const modelText = typeof record.model === "string" ? record.model.trim() : "";
  const responseModel = /^[\w.:-]{1,128}$/.test(modelText) ? modelText : null;
  const id = serverRequestId(headers, record.id, secret);
  const usage = usageOf(record.usage);
  const choices = record.choices;
  const choice = Array.isArray(choices) ? choices[0] as Record<string, unknown> | undefined : undefined;
  if (!choice || typeof choice !== "object") {
    return { responseModel, serverRequestId: id, usage, draft: null, errorCode: "invalid_response" };
  }
  const finish = choice.finish_reason;
  const messageRecord = choice.message;
  const content = messageRecord && typeof messageRecord === "object" ? (messageRecord as Record<string, unknown>).content : undefined;
  const refusal = messageRecord && typeof messageRecord === "object" ? (messageRecord as Record<string, unknown>).refusal : undefined;
  if (finish === "content_filter" || (typeof refusal === "string" && refusal.trim().length > 0)) {
    return { responseModel, serverRequestId: id, usage, draft: null, errorCode: "refusal" };
  }
  if (finish === "length") {
    return { responseModel, serverRequestId: id, usage, draft: null, errorCode: "truncated" };
  }
  if (typeof content !== "string") {
    return { responseModel, serverRequestId: id, usage, draft: null, errorCode: "invalid_response" };
  }
  let draftValue: unknown;
  try {
    draftValue = JSON.parse(content) as unknown;
  } catch {
    return { responseModel, serverRequestId: id, usage, draft: null, errorCode: "invalid_json" };
  }
  const draft = parseQwenTextTrialDraft(draftValue);
  if (!draft.ok) return { responseModel, serverRequestId: id, usage, draft: null, errorCode: "invalid_draft" };
  return { responseModel, serverRequestId: id, usage, draft: draft.data, errorCode: null };
}

function statusForHttp(status: number): string {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limited";
  if (status >= 500 && status <= 599) return "server_error";
  if (status === 0 || (status >= 300 && status < 400)) return "redirect_rejected";
  return "provider_error";
}

function isTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  return name === "TimeoutError" || name === "AbortError";
}

export async function runQwenTextTrial(options: RunOptions): Promise<QwenTextTrialResult> {
  const parsedInput = parseQwenTextTrialInput(options.input);
  if (!parsedInput.ok) return finish("rejected", "invalid_input", [`status=rejected`, `code=invalid_input`, message("invalid_input")], 0, null);
  const modelChoice = selectedModel(options.env);
  if (!modelChoice.ok) return finish("rejected", modelChoice.code, [`status=rejected`, `code=${modelChoice.code}`, message(modelChoice.code)], 0, null);

  if (options.mode === "dry_run") {
    return finish("dry_run", null, [
      "status=dry_run",
      `model=${modelChoice.model}`,
      "stream=false",
      "enable_thinking=false",
      `max_tokens=${QWEN_TEXT_TRIAL_MAX_TOKENS}`,
      "response_format=json_object",
      `target_duration_seconds=${parsedInput.data.targetDurationSeconds}`,
      "duration_claim=writing_target_only",
      `output=${options.outputDir}`,
      "network=not_sent",
      "api_key=not_read",
    ], 0, null);
  }

  const apiKey = readApiKey(options.env);
  if (!apiKey.ok) return finish("rejected", apiKey.code, [`status=rejected`, `code=${apiKey.code}`, message(apiKey.code)], 0, null);
  const baseUrl = options.env.BAILIAN_BASE_URL;
  if (baseUrl === undefined || baseUrl.length === 0) {
    return finish("rejected", "missing_base_url", ["status=rejected", "code=missing_base_url", message("missing_base_url")], 0, apiKey.apiKey);
  }
  const endpoint = resolveQwenTextTrialEndpoint(baseUrl);
  if (!endpoint.ok) return finish("rejected", endpoint.code, [`status=rejected`, `code=${endpoint.code}`, message(endpoint.code)], 0, apiKey.apiKey);

  const makeDir = options.mkdirImpl ?? ((path: string) => mkdir(path));
  const write = options.writeFileImpl ?? ((path: string, data: string) => writeFile(path, data, { flag: "wx" }));
  try {
    await makeDir(options.outputDir);
  } catch {
    return finish("rejected", "output_exists", ["status=rejected", "code=output_exists", message("output_exists"), `output=${options.outputDir}`], 0, apiKey.apiKey);
  }

  const body = requestBody(modelChoice.model, parsedInput.data);
  const requestHash = createHash("sha256").update(body).digest("hex");
  const runId = options.runId ?? randomUUID();
  const createdAt = (options.now ?? (() => new Date()))().toISOString();
  const timeoutMs = Math.min(options.timeoutMs ?? QWEN_TEXT_TRIAL_TIMEOUT_MS, QWEN_TEXT_TRIAL_TIMEOUT_MS);
  const maxBytes = Math.min(options.maxResponseBytes ?? QWEN_TEXT_TRIAL_MAX_RESPONSE_BYTES, QWEN_TEXT_TRIAL_MAX_RESPONSE_BYTES);
  const transport = options.transport ?? createFetchTransport(globalThis.fetch, maxBytes);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let requestCount = 0;
  const draftPath = join(options.outputDir, "draft.json");
  const receiptPath = join(options.outputDir, "receipt.json");

  const persist = async (
    fields: Omit<QwenTextTrialReceipt, "schema" | "billing" | "durationNote" | "reviewNote" | "draftFile">,
    draft: QwenTextTrialDraft | null,
  ): Promise<QwenTextTrialResult> => {
    let draftFile: QwenTextTrialReceipt["draftFile"] = "not_written";
    if (draft) {
      try {
        await write(draftPath, redact(`${JSON.stringify(draft, null, 2)}\n`, apiKey.apiKey));
        draftFile = "written";
      } catch {
        draftFile = "failed";
      }
    }
    let value: QwenTextTrialReceipt;
    try {
      value = receipt({ ...fields, draftFile });
    } catch {
      return finish("save_failed", "save_failed", ["status=save_failed", "code=save_failed", message("save_failed"), `output=${options.outputDir}`], requestCount, apiKey.apiKey);
    }
    try {
      await write(receiptPath, redact(`${JSON.stringify(value, null, 2)}\n`, apiKey.apiKey));
    } catch {
      return finish("save_failed", "save_failed", ["status=save_failed", "code=save_failed", message("save_failed"), `output=${options.outputDir}`], requestCount, apiKey.apiKey);
    }
    if (draftFile === "failed") {
      return finish("save_failed", "save_failed", ["status=save_failed", "code=save_failed", message("save_failed"), `receipt=${receiptPath}`], requestCount, apiKey.apiKey);
    }
    if (!draft) {
      const status = value.providerResult === "unknown" ? "billing_unknown" : value.errorCode === "invalid_draft" || value.errorCode === "invalid_json" ? "draft_rejected" : "provider_error";
      const code = value.errorCode ?? "provider_error";
      return finish(status, code, [`status=${status}`, `code=${code}`, message(code), `receipt=${receiptPath}`], requestCount, apiKey.apiKey);
    }
    return finish("draft_saved", null, ["status=draft_saved", `draft=${draftPath}`, `receipt=${receiptPath}`], requestCount, apiKey.apiKey);
  };

  try {
    requestCount += 1;
    const response = await transport({
      url: endpoint.url,
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey.apiKey}`, "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    if (response.status === 0 || response.status < 200 || response.status >= 300) {
      const code = statusForHttp(response.status);
      const unknown = code === "redirect_rejected";
      return await persist({
        runId, createdAt, requestContentSha256: requestHash, requestedModel: modelChoice.model,
        responseModel: null, serverRequestId: null, usage: usageOf(null), draftAccepted: false,
        errorCode: code, providerResult: unknown ? "unknown" : "completed",
      }, null);
    }
    const raw = decodeBody(response.body, maxBytes, apiKey.apiKey);
    const completion = parseCompletion(raw, response.headers, apiKey.apiKey);
    return await persist({
      runId, createdAt, requestContentSha256: requestHash, requestedModel: modelChoice.model,
      responseModel: completion.responseModel, serverRequestId: completion.serverRequestId,
      usage: completion.usage, draftAccepted: completion.draft !== null,
      errorCode: completion.errorCode, providerResult: "completed",
    }, completion.draft);
  } catch (error) {
    const code = error instanceof QwenTextTrialError ? error.code : isTimeout(error) || controller.signal.aborted ? "timeout" : "disconnected";
    return await persist({
      runId, createdAt, requestContentSha256: requestHash, requestedModel: modelChoice.model,
      responseModel: null, serverRequestId: null, usage: usageOf(null), draftAccepted: false,
      errorCode: code, providerResult: "unknown",
    }, null);
  } finally {
    clearTimeout(timer);
  }
}

export function inputWithinLimit(bytes: number): boolean {
  return bytes <= QWEN_TEXT_TRIAL_LIMITS.inputFileMaxBytes;
}
