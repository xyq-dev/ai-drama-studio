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
import {
  QWEN_CHAT_DEFAULT_MODEL,
  QWEN_CHAT_MAX_RESPONSE_BYTES,
  QWEN_CHAT_MAX_TOKENS,
  QWEN_CHAT_MODEL_ENV,
  QWEN_CHAT_TIMEOUT_MS,
  QwenChatError,
  buildQwenChatBody,
  createQwenFetchTransport,
  qwenFailureMessage,
  readQwenApiKey,
  redactSecret,
  resolveQwenChatEndpoint,
  selectedQwenModel,
  sendQwenChat,
  type QwenTransport,
} from "./qwen-chat";

export type { QwenTransport };

export const QWEN_TEXT_TRIAL_DEFAULT_MODEL = QWEN_CHAT_DEFAULT_MODEL;
export const QWEN_TEXT_TRIAL_MODEL_ENV = QWEN_CHAT_MODEL_ENV;
export const QWEN_TEXT_TRIAL_MAX_TOKENS = QWEN_CHAT_MAX_TOKENS;
export const QWEN_TEXT_TRIAL_TIMEOUT_MS = QWEN_CHAT_TIMEOUT_MS;
export const QWEN_TEXT_TRIAL_MAX_RESPONSE_BYTES = QWEN_CHAT_MAX_RESPONSE_BYTES;
export const QwenTextTrialError = QwenChatError;
export const createFetchTransport = createQwenFetchTransport;
export const resolveQwenTextTrialEndpoint = resolveQwenChatEndpoint;

const SYSTEM_PROMPT = [
  "你是中文短剧编剧助手。只输出一个 JSON 对象，不要 Markdown，不要解释。",
  `JSON 的 schema 必须是 ${QWEN_TEXT_TRIAL_DRAFT_SCHEMA}。`,
  "这是待人工审核的候选草稿。不要输出 APPROVED、CURRENT、revisionId、projectId、episodeId 或任何业务资产身份。",
  "targetDurationSeconds 只是写作目标，不要声称成片时长已经达到，也不要输出实际时长字段。",
].join("");

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

function finish(status: QwenTextTrialResult["status"], code: string | null, lines: string[], requestCount: number, secret: string | null): QwenTextTrialResult {
  const safeLines = lines.map((line) => redactSecret(line, secret));
  const failed = status !== "dry_run" && status !== "draft_saved";
  return { ok: !failed, exitCode: failed ? 1 : 0, status, code, lines: safeLines, requestCount };
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

function receipt(input: Omit<QwenTextTrialReceipt, "schema" | "billing" | "durationNote" | "reviewNote">): QwenTextTrialReceipt {
  return qwenTextTrialReceiptSchema.parse({
    schema: QWEN_TEXT_TRIAL_RECEIPT_SCHEMA,
    billing: { amount: null, currency: null, status: "unknown" },
    durationNote: "writing_target_only",
    reviewNote: "candidate_draft_pending_human_review",
    ...input,
  });
}

export async function runQwenTextTrial(options: RunOptions): Promise<QwenTextTrialResult> {
  const parsedInput = parseQwenTextTrialInput(options.input);
  if (!parsedInput.ok) return finish("rejected", "invalid_input", ["status=rejected", "code=invalid_input", qwenFailureMessage("invalid_input")], 0, null);
  const modelChoice = selectedQwenModel(options.env);
  if (!modelChoice.ok) return finish("rejected", modelChoice.code, [`status=rejected`, `code=${modelChoice.code}`, qwenFailureMessage(modelChoice.code)], 0, null);

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

  const apiKey = readQwenApiKey(options.env);
  if (!apiKey.ok) return finish("rejected", apiKey.code, [`status=rejected`, `code=${apiKey.code}`, qwenFailureMessage(apiKey.code)], 0, null);
  const baseUrl = options.env.BAILIAN_BASE_URL;
  if (baseUrl === undefined || baseUrl.length === 0) {
    return finish("rejected", "missing_base_url", ["status=rejected", "code=missing_base_url", qwenFailureMessage("missing_base_url")], 0, apiKey.apiKey);
  }
  const endpoint = resolveQwenChatEndpoint(baseUrl);
  if (!endpoint.ok) return finish("rejected", endpoint.code, [`status=rejected`, `code=${endpoint.code}`, qwenFailureMessage(endpoint.code)], 0, apiKey.apiKey);

  const makeDir = options.mkdirImpl ?? ((path: string) => mkdir(path));
  const write = options.writeFileImpl ?? ((path: string, data: string) => writeFile(path, data, { flag: "wx" }));
  try {
    await makeDir(options.outputDir);
  } catch {
    return finish("rejected", "output_exists", ["status=rejected", "code=output_exists", qwenFailureMessage("output_exists"), `output=${options.outputDir}`], 0, apiKey.apiKey);
  }

  const body = buildQwenChatBody({
    model: modelChoice.model,
    system: SYSTEM_PROMPT,
    user: userPrompt(parsedInput.data),
    tokenLimitField: "max_tokens",
  });
  const requestHash = createHash("sha256").update(body).digest("hex");
  const runId = options.runId ?? randomUUID();
  const createdAt = (options.now ?? (() => new Date()))().toISOString();
  const transport = options.transport ?? createQwenFetchTransport(globalThis.fetch, options.maxResponseBytes);
  const draftPath = join(options.outputDir, "draft.json");
  const receiptPath = join(options.outputDir, "receipt.json");

  const persist = async (
    fields: Omit<QwenTextTrialReceipt, "schema" | "billing" | "durationNote" | "reviewNote" | "draftFile">,
    draft: QwenTextTrialDraft | null,
    requestCount: number,
  ): Promise<QwenTextTrialResult> => {
    let draftFile: QwenTextTrialReceipt["draftFile"] = "not_written";
    if (draft) {
      try {
        await write(draftPath, redactSecret(`${JSON.stringify(draft, null, 2)}\n`, apiKey.apiKey));
        draftFile = "written";
      } catch {
        draftFile = "failed";
      }
    }
    let value: QwenTextTrialReceipt;
    try {
      value = receipt({ ...fields, draftFile });
    } catch {
      return finish("save_failed", "save_failed", ["status=save_failed", "code=save_failed", qwenFailureMessage("save_failed"), `output=${options.outputDir}`], requestCount, apiKey.apiKey);
    }
    try {
      await write(receiptPath, redactSecret(`${JSON.stringify(value, null, 2)}\n`, apiKey.apiKey));
    } catch {
      return finish("save_failed", "save_failed", ["status=save_failed", "code=save_failed", qwenFailureMessage("save_failed"), `output=${options.outputDir}`], requestCount, apiKey.apiKey);
    }
    if (draftFile === "failed") {
      return finish("save_failed", "save_failed", ["status=save_failed", "code=save_failed", qwenFailureMessage("save_failed"), `receipt=${receiptPath}`], requestCount, apiKey.apiKey);
    }
    if (!draft) {
      const rejected = value.errorCode === "invalid_draft" || value.errorCode === "invalid_json" || value.errorCode === "invalid_finish" || value.errorCode === "tool_call" || value.errorCode === "invalid_utf8" || value.errorCode === "refusal" || value.errorCode === "truncated";
      const status = value.providerResult === "unknown" ? "billing_unknown" : rejected ? "draft_rejected" : "provider_error";
      const code = value.errorCode ?? "provider_error";
      return finish(status, code, [`status=${status}`, `code=${code}`, qwenFailureMessage(code), `receipt=${receiptPath}`], requestCount, apiKey.apiKey);
    }
    return finish("draft_saved", null, ["status=draft_saved", `draft=${draftPath}`, `receipt=${receiptPath}`], requestCount, apiKey.apiKey);
  };

  const exchange = await sendQwenChat({
    url: endpoint.url,
    apiKey: apiKey.apiKey,
    body,
    transport,
    timeoutMs: options.timeoutMs,
    maxResponseBytes: options.maxResponseBytes,
  });
  let draft: QwenTextTrialDraft | null = null;
  let errorCode = exchange.errorCode;
  if (exchange.content) {
    let draftValue: unknown;
    try {
      draftValue = JSON.parse(exchange.content) as unknown;
    } catch {
      errorCode = "invalid_json";
    }
    if (errorCode === null) {
      const parsed = parseQwenTextTrialDraft(draftValue);
      if (!parsed.ok) errorCode = "invalid_draft";
      else draft = parsed.data;
    }
  }
  return persist({
    runId,
    createdAt,
    requestContentSha256: requestHash,
    requestedModel: modelChoice.model,
    responseModel: exchange.responseModel,
    serverRequestId: exchange.serverRequestId,
    usage: exchange.usage,
    draftAccepted: draft !== null,
    errorCode,
    providerResult: exchange.providerResult,
  }, draft, exchange.requestCount);
}

export function inputWithinLimit(bytes: number): boolean {
  return bytes <= QWEN_TEXT_TRIAL_LIMITS.inputFileMaxBytes;
}
