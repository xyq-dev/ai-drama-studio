import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseQwenTextTrialArgs, runQwenTextTrialCli } from "./qwen-text-trial-cli";
import {
  QWEN_TEXT_TRIAL_DEFAULT_MODEL,
  QWEN_TEXT_TRIAL_MAX_TOKENS,
  createFetchTransport,
  runQwenTextTrial,
  type QwenTransport,
  type QwenTransportResponse,
} from "./qwen-text-trial";

const SECRET = "sk-qwen-trial-test-key-9f3a";
const BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const IDEA = "试用创意哨兵雨夜饭团";

const input = {
  schema: "qwen.text.trial.input.v1",
  idea: IDEA,
  tone: "克制",
  targetDurationSeconds: 75,
};

function draft() {
  return {
    schema: "qwen.text.trial.draft.v1",
    title: "末班饭团",
    logline: "店员把最后一只饭团让给了赶车的人。",
    characters: [{ name: "小林", summary: "夜班店员" }],
    scenes: [{
      ordinal: 1,
      title: "柜台",
      action: "小林把饭团推过柜台。",
      dialogue: [{ character: "小林", line: "还热着。" }],
    }],
  };
}

function headers(values: Record<string, string> = {}) {
  return { get: (name: string) => values[name.toLowerCase()] ?? null };
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function completion(content: unknown, extra: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl-server-1",
    model: QWEN_TEXT_TRIAL_DEFAULT_MODEL,
    choices: [{ finish_reason: "stop", message: { content: typeof content === "string" ? content : JSON.stringify(content) } }],
    usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
    ...extra,
  };
}

async function freshOutput(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "qwen-trial-"));
  return join(parent, "run");
}

function once(response: QwenTransportResponse | ((signal: AbortSignal) => Promise<QwenTransportResponse>)) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const transport: QwenTransport = async (request) => {
    calls.push({ url: request.url, headers: request.headers, body: request.body });
    if (calls.length > 1) throw new Error("retry");
    return typeof response === "function" ? response(request.signal) : response;
  };
  return { calls, transport };
}

async function execute(options: {
  transport: QwenTransport;
  env?: NodeJS.ProcessEnv;
  outputDir?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  runId?: string;
  writeFileImpl?: (path: string, data: string) => Promise<void>;
}) {
  const outputDir = options.outputDir ?? await freshOutput();
  const result = await runQwenTextTrial({
    mode: "execute",
    input,
    outputDir,
    env: { DASHSCOPE_API_KEY: SECRET, BAILIAN_BASE_URL: BASE, ...(options.env ?? {}) },
    transport: options.transport,
    timeoutMs: options.timeoutMs,
    maxResponseBytes: options.maxResponseBytes,
    runId: options.runId ?? "11111111-1111-4111-8111-111111111111",
    now: () => new Date("2026-10-04T00:00:00.000Z"),
    writeFileImpl: options.writeFileImpl,
  });
  return { result, outputDir };
}

function okResponse(body: unknown, responseHeaders = headers({ "x-request-id": "req-server-7" })): QwenTransportResponse {
  return { status: 200, headers: responseHeaders, body: encode(body) };
}

describe("qwen text trial", () => {
  it("dry-run validates input, does not read the key, and does not send a request", async () => {
    const outputDir = await freshOutput();
    let keyReads = 0;
    const env = new Proxy({} as NodeJS.ProcessEnv, {
      get(target, property) {
        if (property === "DASHSCOPE_API_KEY") keyReads += 1;
        return target[property as keyof NodeJS.ProcessEnv];
      },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error("network"));
    try {
      const transport: QwenTransport = () => Promise.reject(new Error("network"));
      const result = await runQwenTextTrial({ mode: "dry_run", input, outputDir, env, transport });
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.requestCount).toBe(0);
      expect(keyReads).toBe(0);
      expect(result.lines.join("\n")).toContain("status=dry_run");
      expect(result.lines.join("\n")).toContain("network=not_sent");
      expect(result.lines.join("\n")).toContain("api_key=not_read");
      expect(result.lines.join("\n")).toContain(`model=${QWEN_TEXT_TRIAL_DEFAULT_MODEL}`);
      expect(result.lines.join("\n")).not.toContain(IDEA);
      expect(existsSync(outputDir)).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects missing configuration, unofficial addresses, embedded credentials, and redirects without a second request", async () => {
    const blocked: QwenTransport = () => Promise.reject(new Error("network"));
    const missingKey = await execute({ transport: blocked, env: { DASHSCOPE_API_KEY: "" } });
    expect(missingKey.result.code).toBe("missing_api_key");
    expect(missingKey.result.requestCount).toBe(0);
    const missingUrl = await execute({ transport: blocked, env: { BAILIAN_BASE_URL: "" } });
    expect(missingUrl.result.code).toBe("missing_base_url");
    expect(missingUrl.result.requestCount).toBe(0);
    for (const baseUrl of [
      "http://dashscope.aliyuncs.com/compatible-mode/v1",
      "https://dashscope.aliyuncs.com/api/v1",
      "https://dashscope.aliyuncs.com.evil.com/compatible-mode/v1",
      "https://127.0.0.1/compatible-mode/v1",
    ]) {
      const rejected = await execute({ transport: blocked, env: { BAILIAN_BASE_URL: baseUrl } });
      expect(rejected.result.requestCount).toBe(0);
      expect(["invalid_base_url", "unofficial_host"]).toContain(rejected.result.code);
    }
    const embedded = await execute({
      transport: blocked,
      env: { BAILIAN_BASE_URL: `https://user:${SECRET}@dashscope.aliyuncs.com/compatible-mode/v1` },
    });
    expect(embedded.result.code).toBe("embedded_credentials");
    expect(embedded.result.lines.join("\n")).not.toContain(SECRET);
    expect(embedded.result.requestCount).toBe(0);
    const redirect = once({ status: 302, headers: headers({ location: "https://example.invalid/next" }), body: null });
    const redirected = await execute({ transport: redirect.transport });
    expect(redirected.result.code).toBe("redirect_rejected");
    expect(redirect.calls).toHaveLength(1);
    expect(redirected.result.lines.join("\n")).toContain("billing are unknown");
  });

  it("sends one non-streaming request for the selected model and the output limit", async () => {
    const sent = once(okResponse(completion(draft())));
    const result = await execute({ transport: sent.transport, env: { QWEN_TEXT_TRIAL_MODEL: "qwen3.7-plus-explicit" } });
    expect(result.result.status).toBe("draft_saved");
    expect(sent.calls).toHaveLength(1);
    const body = JSON.parse(sent.calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body.model).toBe("qwen3.7-plus-explicit");
    expect(body.stream).toBe(false);
    expect(body.enable_thinking).toBe(false);
    expect(body.max_tokens).toBe(QWEN_TEXT_TRIAL_MAX_TOKENS);
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.n).toBe(1);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(sent.calls[0]?.url).toBe(`${BASE}/chat/completions`);
    expect(sent.calls[0]?.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(Object.keys(sent.calls[0]?.headers ?? {}).sort()).toEqual(["Authorization", "Content-Type"]);
    expect(sent.calls[0]?.body).not.toContain(result.result.lines.join(""));
    expect(sent.calls[0]?.body).not.toContain("11111111-1111-4111-8111-111111111111");
  });

  it("saves a validated draft and a redacted receipt, including a different server model and token usage", async () => {
    const sent = once(okResponse(completion(draft(), { model: "qwen3.7-plus-2026-05-26" })));
    const saved = await execute({ transport: sent.transport });
    expect(saved.result.exitCode).toBe(0);
    const draftText = await readFile(join(saved.outputDir, "draft.json"), "utf8");
    const receiptText = await readFile(join(saved.outputDir, "receipt.json"), "utf8");
    const parsedDraft = JSON.parse(draftText) as { schema: string; scenes: Array<{ ordinal: number }> };
    const parsedReceipt = JSON.parse(receiptText) as {
      requestedModel: string;
      responseModel: string;
      serverRequestId: string;
      usage: { status: string; totalTokens: number };
      billing: { amount: null; status: string };
      draftAccepted: boolean;
      durationNote: string;
      reviewNote: string;
      requestContentSha256: string;
    };
    expect(parsedDraft.schema).toBe("qwen.text.trial.draft.v1");
    expect(parsedDraft.scenes[0]?.ordinal).toBe(1);
    expect(parsedReceipt.requestedModel).toBe(QWEN_TEXT_TRIAL_DEFAULT_MODEL);
    expect(parsedReceipt.responseModel).toBe(QWEN_TEXT_TRIAL_DEFAULT_MODEL);
    expect(parsedReceipt.serverRequestId).toBe("req-server-7");
    expect(parsedReceipt.usage).toEqual({ status: "present", promptTokens: 11, completionTokens: 22, totalTokens: 33 });
    expect(parsedReceipt.billing).toEqual({ amount: null, currency: null, status: "unknown" });
    expect(parsedReceipt.draftAccepted).toBe(true);
    expect(parsedReceipt.durationNote).toBe("writing_target_only");
    expect(parsedReceipt.reviewNote).toBe("candidate_draft_pending_human_review");
    expect(parsedReceipt.requestContentSha256).toBe(createHash("sha256").update(sent.calls[0]?.body ?? "").digest("hex"));
    expect(draftText).not.toContain(SECRET);
    expect(receiptText).not.toContain(SECRET);
    expect(receiptText).not.toContain(IDEA);
    expect(receiptText).not.toContain("\"amount\": 0");
    expect(saved.result.lines.join("\n")).not.toContain(SECRET);
  });

  it("keeps the receipt when the draft is refused, truncated, invalid, or missing usage", async () => {
    const cases = [
      { name: "refusal", body: completion("", { choices: [{ finish_reason: "content_filter", message: { content: "" } }] }), code: "refusal" },
      { name: "refusal-field", body: completion("{}", { choices: [{ finish_reason: "stop", message: { content: "{}", refusal: "no" } }] }), code: "refusal" },
      { name: "truncated", body: completion("{", { choices: [{ finish_reason: "length", message: { content: "{" } }] }), code: "truncated" },
      { name: "invalid-json", body: completion("not-json"), code: "invalid_json" },
      { name: "invalid-draft", body: completion({ schema: "qwen.text.trial.draft.v1", title: "短", logline: "短句。", characters: [], scenes: [] }), code: "invalid_draft" },
      { name: "non-stop-json", body: completion(draft(), { choices: [{ finish_reason: null, message: { content: JSON.stringify(draft()) } }] }), code: "invalid_finish" },
      { name: "tool-call", body: completion(draft(), { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(draft()), tool_calls: [{ id: "call-1", type: "function" }] } }] }), code: "tool_call" },
    ];
    for (const item of cases) {
      const sent = once(okResponse(item.body));
      const failed = await execute({ transport: sent.transport });
      expect(sent.calls).toHaveLength(1);
      expect(failed.result.code).toBe(item.code);
      expect(existsSync(join(failed.outputDir, "draft.json"))).toBe(false);
      const receiptText = await readFile(join(failed.outputDir, "receipt.json"), "utf8");
      expect(receiptText).toContain(`"errorCode": "${item.code}"`);
      expect(receiptText).not.toContain(SECRET);
    }
    const missingUsage = once(okResponse(completion(draft(), { usage: undefined })));
    const saved = await execute({ transport: missingUsage.transport });
    expect(saved.result.status).toBe("draft_saved");
    const receipt = JSON.parse(await readFile(join(saved.outputDir, "receipt.json"), "utf8")) as { usage: { status: string; promptTokens: null } };
    expect(receipt.usage).toEqual({ status: "unknown", promptTokens: null, completionTokens: null, totalTokens: null });
  });

  it("reports credential, rate, server, disconnect, timeout, and size failures once", async () => {
    for (const status of [401, 403, 429, 500, 502]) {
      const sent = once({ status, headers: headers(), body: encode({ error: { message: SECRET } }) });
      const failed = await execute({ transport: sent.transport });
      expect(sent.calls).toHaveLength(1);
      expect(failed.result.requestCount).toBe(1);
      expect(failed.result.lines.join("\n")).not.toContain(SECRET);
      const receiptText = await readFile(join(failed.outputDir, "receipt.json"), "utf8");
      expect(receiptText).not.toContain(SECRET);
      expect(existsSync(join(failed.outputDir, "draft.json"))).toBe(false);
    }
    const disconnected = once(() => Promise.reject(new TypeError("socket hang up")));
    const disconnect = await execute({ transport: disconnected.transport });
    expect(disconnected.calls).toHaveLength(1);
    expect(disconnect.result.code).toBe("disconnected");
    expect(disconnect.result.lines.join("\n")).toContain("billing are unknown");
    const timed = once((signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("timed out");
        error.name = "TimeoutError";
        reject(error);
      });
    }));
    const timeout = await execute({ transport: timed.transport, timeoutMs: 20 });
    expect(timed.calls).toHaveLength(1);
    expect(timeout.result.code).toBe("timeout");
    const oversized = once({ status: 200, headers: headers(), body: new Uint8Array(64) });
    const tooLarge = await execute({ transport: oversized.transport, maxResponseBytes: 16 });
    expect(oversized.calls).toHaveLength(1);
    expect(tooLarge.result.code).toBe("response_too_large");
  });

  it("stops reading a response stream at the hard size limit", async () => {
    const pulled: number[] = [];
    let fetches = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled.reduce((sum, size) => sum + size, 0) >= 1_000) {
          controller.close();
          return;
        }
        pulled.push(100);
        controller.enqueue(new Uint8Array(100));
      },
    });
    const fetchImpl: typeof fetch = () => {
      fetches += 1;
      return Promise.resolve(new Response(stream, { status: 200 }));
    };
    const transport = createFetchTransport(fetchImpl, 250);
    await expect(transport({
      url: `${BASE}/chat/completions`,
      method: "POST",
      headers: {},
      body: "{}",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "response_too_large" });
    expect(fetches).toBe(1);
    expect(pulled.reduce((sum, size) => sum + size, 0)).toBeLessThan(1_000);
    const init = { redirect: "", body: "" };
    const observingFetch: typeof fetch = (_url, options) => {
      init.redirect = String(options?.redirect);
      init.body = String(options?.body);
      return Promise.resolve(new Response(null, { status: 302, headers: { location: "https://example.invalid" } }));
    };
    const redirecting = createFetchTransport(observingFetch, 250);
    const response = await redirecting({
      url: `${BASE}/chat/completions`,
      method: "POST",
      headers: {},
      body: "{}",
      signal: new AbortController().signal,
    });
    expect(init.redirect).toBe("manual");
    expect(response.status).toBe(302);
  });

  it("does not overwrite an existing output directory or retry after a save failure", async () => {
    const outputDir = await freshOutput();
    await mkdir(outputDir);
    await writeFile(join(outputDir, "marker.txt"), "keep");
    const sent = once(okResponse(completion(draft())));
    const blocked = await execute({ transport: sent.transport, outputDir });
    expect(sent.calls).toHaveLength(0);
    expect(blocked.result.code).toBe("output_exists");
    expect(await readFile(join(outputDir, "marker.txt"), "utf8")).toBe("keep");
    const failingWrite = once(okResponse(completion(draft())));
    const failedSave = await execute({
      transport: failingWrite.transport,
      writeFileImpl: () => Promise.reject(new Error("disk full")),
    });
    expect(failingWrite.calls).toHaveLength(1);
    expect(failedSave.result.code).toBe("save_failed");
    expect(failedSave.result.lines.join("\n")).toContain("did not call the model again");
  });

  it("runs the CLI dry-run in a subprocess and keeps the exit code aligned", async () => {
    const root = repoRoot();
    const parent = await mkdtemp(join(tmpdir(), "qwen-cli-"));
    const inputPath = join(parent, "input.json");
    const outputDir = join(parent, "out");
    await writeFile(inputPath, JSON.stringify(input));
    const dry = spawnSync("pnpm", ["qwen:trial", "--", "--input", inputPath, "--output", outputDir], {
      cwd: root,
      encoding: "utf8",
      shell: process.platform === "win32",
      env: { ...process.env, DASHSCOPE_API_KEY: SECRET, BAILIAN_BASE_URL: "https://example.invalid/compatible-mode/v1" },
    });
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("status=dry_run");
    expect(dry.stdout).toContain("network=not_sent");
    expect(`${dry.stdout}${dry.stderr}`).not.toContain(SECRET);
    expect(`${dry.stdout}${dry.stderr}`).not.toContain(IDEA);
    expect(existsSync(outputDir)).toBe(false);
    const env = { ...process.env };
    delete env.DASHSCOPE_API_KEY;
    const refused = spawnSync("pnpm", ["qwen:trial", "--", "--input", inputPath, "--output", join(parent, "execute"), "--execute"], {
      cwd: root,
      encoding: "utf8",
      shell: process.platform === "win32",
      env,
    });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("code=missing_api_key");
    expect(`${refused.stdout}${refused.stderr}`).not.toContain(SECRET);
    expect(parseQwenTextTrialArgs(["--api-key", SECRET]).ok).toBe(false);
    const lines: string[] = [];
    const code = await runQwenTextTrialCli(["--input", inputPath, "--output", join(parent, "direct")], {}, (line) => lines.push(line), (line) => lines.push(line));
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("status=dry_run");
  });
});

function repoRoot(): string {
  let dir = process.cwd();
  for (let depth = 0; depth < 4; depth += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = join(dir, "..");
  }
  throw new Error("repo root not found");
}
