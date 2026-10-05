import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EPISODE_DRAFT_SCHEMA,
  QWEN_WRITING_RECEIPT_SCHEMA,
  STORY_PLAN_SCHEMA,
  WRITING_BODY_MAX_CHARS,
  WRITING_IMPORT_MAX_BYTES,
  WRITING_PROMPT_VERSION,
  parseQwenWritingInput,
  qwenWritingReceiptSchema,
  type QwenWritingInput,
  type QwenWritingReceipt,
} from "@ai-drama/contracts";
import {
  DomainError,
  buildEpisodeDraftInstruction,
  buildStoryPlanInstruction,
  formatWritingImport,
  parseWritingImport,
} from "@ai-drama/domain";
import {
  QWEN_CHAT_DEFAULT_MODEL,
  QWEN_CHAT_MAX_TOKENS,
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

export const QWEN_WRITING_DEFAULT_MODEL = QWEN_CHAT_DEFAULT_MODEL;

const STORY_LIMITS = [
  "候选字段都是字符串，不要截断来通过校验。",
  "logline、protagonistGoal、opposition 各 1 到 300 字。coreConflict 1 到 400 字。",
  "relationships 为 1 到 6 项对象，name 1 到 40 字，pressure 1 到 200 字。",
  "episodes 必须正好 3 项，episodeNo 正好是 1、2、3 且不重复。",
  "每一集的 entryState、goal、action、turn、result、handoff 各 1 到 400 字。",
  `整个 JSON 不超过 ${WRITING_IMPORT_MAX_BYTES} 字节。整理后的正文不超过 ${WRITING_BODY_MAX_CHARS} 字。`,
].join("\n");

const EPISODE_LIMITS = [
  "候选字段都是字符串，不要截断来通过校验。",
  "title 1 到 80 字。screenplay 1 到 12000 字。",
  "scenes 为 1 到 12 项对象。heading 1 到 80 字，action 1 到 400 字，dialogue 0 到 400 字，sound 0 到 120 字。",
  "handoffFacts 为 1 到 8 条字符串，每条 1 到 200 字。",
  `整个 JSON 不超过 ${WRITING_IMPORT_MAX_BYTES} 字节。整理后的正文不超过 ${WRITING_BODY_MAX_CHARS} 字。`,
].join("\n");

const SYSTEM_PROMPT = [
  "你是中文短剧编剧助手。只输出一个 JSON 对象，不要 Markdown，不要解释。",
  "不要调用工具，不要输出 tool_calls 或 function_call。",
  "这是待人工比较后才能采纳的候选，不是已保存版本。",
  "不要输出 projectId、revisionId、If-Match、reviewStatus、APPROVED 或 CURRENT。",
].join("");

export interface QwenWritingResult {
  ok: boolean;
  exitCode: number;
  status: "dry_run" | "candidate_saved" | "candidate_rejected" | "provider_error" | "billing_unknown" | "save_failed" | "rejected";
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

function finish(status: QwenWritingResult["status"], code: string | null, lines: string[], requestCount: number, secret: string | null): QwenWritingResult {
  const safeLines = lines.map((line) => redactSecret(line, secret));
  const failed = status !== "dry_run" && status !== "candidate_saved";
  return { ok: !failed, exitCode: failed ? 1 : 0, status, code, lines: safeLines, requestCount };
}

function candidateSchema(input: QwenWritingInput): QwenWritingReceipt["candidateSchema"] {
  return input.mode === "story" ? STORY_PLAN_SCHEMA : EPISODE_DRAFT_SCHEMA;
}

function instruction(input: QwenWritingInput): string {
  if (input.mode === "story") {
    return [
      buildStoryPlanInstruction(input),
      "候选类型和上限：",
      STORY_LIMITS,
    ].join("\n");
  }
  return [
    buildEpisodeDraftInstruction(input),
    "候选类型和上限：",
    `episodeNo 必须是数字 ${input.episodeNo}。`,
    EPISODE_LIMITS,
  ].join("\n");
}

function candidateErrorCode(error: unknown): string {
  if (error instanceof DomainError) {
    if (error.code === "WRITING_EPISODE_MISMATCH") return "episode_mismatch";
    if (error.code === "WRITING_TOO_LARGE") return "too_large";
    if (error.code === "WRITING_UNSAFE_CONTENT") return "unsafe_content";
    if (error.code === "WRITING_INVALID_JSON") return "invalid_json";
  }
  return "invalid_candidate";
}

function writingExpected(input: QwenWritingInput): { mode: "story" | "episode"; episodeNo: number | null } {
  return {
    mode: input.mode,
    episodeNo: input.mode === "episode" ? input.episodeNo : null,
  };
}

export function acceptPreparedCandidate(content: string, input: QwenWritingInput, secret: string): { text: string } | { errorCode: string } {
  const expected = writingExpected(input);
  let candidate: unknown;
  try {
    const imported = parseWritingImport(new TextEncoder().encode(content), expected);
    formatWritingImport(imported);
    candidate = imported.mode === "story" ? imported.plan : imported.draft;
  } catch (error) {
    return { errorCode: candidateErrorCode(error) };
  }
  const text = redactSecret(`${JSON.stringify(candidate, null, 2)}\n`, secret);
  try {
    const written = parseWritingImport(new TextEncoder().encode(text), expected);
    formatWritingImport(written);
  } catch (error) {
    return { errorCode: candidateErrorCode(error) };
  }
  return { text };
}

function receipt(input: Omit<QwenWritingReceipt, "schema" | "billing" | "idempotencyNote">): QwenWritingReceipt {
  return qwenWritingReceiptSchema.parse({
    schema: QWEN_WRITING_RECEIPT_SCHEMA,
    billing: { amount: null, currency: null, status: "unknown" },
    idempotencyNote: "local_run_id_is_not_a_provider_guarantee",
    ...input,
  });
}

export async function runQwenWriting(options: RunOptions): Promise<QwenWritingResult> {
  const parsedInput = parseQwenWritingInput(options.input);
  if (!parsedInput.ok) return finish("rejected", "invalid_input", ["status=rejected", "code=invalid_input", qwenFailureMessage("invalid_input")], 0, null);
  const modelChoice = selectedQwenModel(options.env);
  if (!modelChoice.ok) return finish("rejected", modelChoice.code, [`status=rejected`, `code=${modelChoice.code}`, qwenFailureMessage(modelChoice.code)], 0, null);
  let user: string;
  try {
    user = instruction(parsedInput.data);
  } catch (error) {
    const code = candidateErrorCode(error);
    return finish("rejected", code, [`status=rejected`, `code=${code}`, qwenFailureMessage(code)], 0, null);
  }

  if (options.mode === "dry_run") {
    return finish("dry_run", null, [
      "status=dry_run",
      `mode=${parsedInput.data.mode}`,
      `candidate_schema=${candidateSchema(parsedInput.data)}`,
      `prompt_version=${WRITING_PROMPT_VERSION}`,
      `model=${modelChoice.model}`,
      "stream=false",
      "enable_thinking=false",
      `max_completion_tokens=${QWEN_CHAT_MAX_TOKENS}`,
      "response_format=json_object",
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
    user,
    tokenLimitField: "max_completion_tokens",
  });
  const requestHash = createHash("sha256").update(body).digest("hex");
  const runId = options.runId ?? randomUUID();
  const createdAt = (options.now ?? (() => new Date()))().toISOString();
  const transport = options.transport ?? createQwenFetchTransport(globalThis.fetch, options.maxResponseBytes);
  const candidatePath = join(options.outputDir, "candidate.json");
  const receiptPath = join(options.outputDir, "receipt.json");
  const schemaName = candidateSchema(parsedInput.data);

  const persist = async (
    fields: Omit<QwenWritingReceipt, "schema" | "billing" | "idempotencyNote" | "candidateFile">,
    candidateText: string | null,
    requestCount: number,
  ): Promise<QwenWritingResult> => {
    let candidateFile: QwenWritingReceipt["candidateFile"] = "not_written";
    if (candidateText && fields.candidateAccepted) {
      try {
        await write(candidatePath, candidateText);
        candidateFile = "written";
      } catch {
        candidateFile = "failed";
      }
    }
    let value: QwenWritingReceipt;
    try {
      value = receipt({ ...fields, candidateFile });
    } catch {
      return finish("save_failed", "save_failed", ["status=save_failed", "code=save_failed", qwenFailureMessage("save_failed"), `output=${options.outputDir}`], requestCount, apiKey.apiKey);
    }
    try {
      await write(receiptPath, redactSecret(`${JSON.stringify(value, null, 2)}\n`, apiKey.apiKey));
    } catch {
      return finish("save_failed", "save_failed", ["status=save_failed", "code=save_failed", qwenFailureMessage("save_failed"), `output=${options.outputDir}`], requestCount, apiKey.apiKey);
    }
    if (candidateFile === "failed") {
      return finish("save_failed", "save_failed", ["status=save_failed", "code=save_failed", qwenFailureMessage("save_failed"), `receipt=${receiptPath}`], requestCount, apiKey.apiKey);
    }
    if (!fields.candidateAccepted) {
      const validation = value.errorCode === "invalid_candidate" || value.errorCode === "invalid_json" || value.errorCode === "episode_mismatch" || value.errorCode === "too_large" || value.errorCode === "unsafe_content" || value.errorCode === "invalid_finish" || value.errorCode === "tool_call" || value.errorCode === "invalid_utf8" || value.errorCode === "refusal" || value.errorCode === "truncated";
      const status = value.providerResult === "unknown" ? "billing_unknown" : validation ? "candidate_rejected" : "provider_error";
      const code = value.errorCode ?? "provider_error";
      return finish(status, code, [`status=${status}`, `code=${code}`, qwenFailureMessage(code), `receipt=${receiptPath}`], requestCount, apiKey.apiKey);
    }
    return finish("candidate_saved", null, ["status=candidate_saved", `candidate=${candidatePath}`, `receipt=${receiptPath}`], requestCount, apiKey.apiKey);
  };

  const exchange = await sendQwenChat({
    url: endpoint.url,
    apiKey: apiKey.apiKey,
    body,
    transport,
    timeoutMs: options.timeoutMs,
    maxResponseBytes: options.maxResponseBytes,
  });
  let candidateText: string | null = null;
  let errorCode = exchange.errorCode;
  let accepted = false;
  if (exchange.content && errorCode === null) {
    const checked = acceptPreparedCandidate(exchange.content, parsedInput.data, apiKey.apiKey);
    if ("errorCode" in checked) errorCode = checked.errorCode;
    else {
      candidateText = checked.text;
      accepted = true;
    }
  }
  return persist({
    runId,
    createdAt,
    mode: parsedInput.data.mode,
    candidateSchema: schemaName,
    promptVersion: WRITING_PROMPT_VERSION,
    requestContentSha256: requestHash,
    requestedModel: modelChoice.model,
    responseModel: exchange.responseModel,
    serverRequestId: exchange.serverRequestId,
    usage: exchange.usage,
    candidateAccepted: accepted,
    errorCode,
    providerResult: exchange.providerResult,
  }, candidateText, exchange.requestCount);
}
