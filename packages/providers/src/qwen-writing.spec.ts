import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatWritingImport, parseWritingImport } from "@ai-drama/domain";
import { parseQwenWritingArgs, runQwenWritingCli } from "./qwen-writing-cli";
import { QWEN_WRITING_DEFAULT_MODEL, runQwenWriting } from "./qwen-writing";
import type { QwenTransport, QwenTransportResponse } from "./qwen-chat";

const SECRET = "sk-qwen-writing-test-key-9f3a";
const BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const LONG_STORY = "故".repeat(1_500);
const PREMISE = "夜班便利店的班次记录被改过";

function storyInput(currentText = "") {
  return {
    schema: "qwen.writing.input.v1",
    mode: "story" as const,
    premise: PREMISE,
    genre: "悬疑",
    audience: "成人短剧观众",
    characters: "店员小林，店长周衡",
    mustKeep: "班次记录是真的",
    mustNotChange: "不能改成喜剧",
    currentText,
  };
}

function episodeInput() {
  return {
    schema: "qwen.writing.input.v1",
    mode: "episode" as const,
    episodeNo: 1 as const,
    premise: PREMISE,
    genre: "悬疑",
    audience: "成人短剧观众",
    characters: "店员小林，店长周衡",
    confirmedStory: LONG_STORY,
    currentText: LONG_STORY,
    revisionRequest: "只改开场",
    mustKeep: "班次记录是真的",
    mustKeepDialogue: "还热着",
    mustKeepEnding: "记录留在柜台",
  };
}

function storyPlan() {
  return {
    schema: "ads.writing.story-plan.v1",
    logline: "模拟候选，不是千问真实生成结果",
    protagonistGoal: "守住班次记录",
    opposition: "店长能改时间",
    coreConflict: "解释会被当成承认",
    relationships: [{ name: "店员", pressure: "不能供出同事" }],
    episodes: [1, 2, 3].map((episodeNo) => ({
      episodeNo,
      entryState: `进入${episodeNo}`,
      goal: `目标${episodeNo}`,
      action: `行动${episodeNo}`,
      turn: `转折${episodeNo}`,
      result: `结果${episodeNo}`,
      handoff: `交接${episodeNo}`,
    })),
  };
}

function episodeDraft(episodeNo = 1) {
  return {
    schema: "ads.writing.episode-draft.v1",
    episodeNo,
    title: "夜班",
    screenplay: "店员仍然按着记录。",
    scenes: [{ heading: "店内", action: "她没有松手", dialogue: "店长：你自己看时间。", sound: "" }],
    handoffFacts: ["记录还在柜台上"],
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
    model: QWEN_WRITING_DEFAULT_MODEL,
    choices: [{ finish_reason: "stop", message: { content: typeof content === "string" ? content : JSON.stringify(content) } }],
    usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
    ...extra,
  };
}

async function freshOutput(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "qwen-writing-"));
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
  input?: unknown;
  transport: QwenTransport;
  env?: NodeJS.ProcessEnv;
  outputDir?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  writeFileImpl?: (path: string, data: string) => Promise<void>;
}) {
  const outputDir = options.outputDir ?? await freshOutput();
  const result = await runQwenWriting({
    mode: "execute",
    input: options.input ?? storyInput(),
    outputDir,
    env: { DASHSCOPE_API_KEY: SECRET, BAILIAN_BASE_URL: BASE, ...(options.env ?? {}) },
    transport: options.transport,
    timeoutMs: options.timeoutMs,
    maxResponseBytes: options.maxResponseBytes,
    runId: "22222222-2222-4222-8222-222222222222",
    now: () => new Date("2026-10-04T00:00:00.000Z"),
    writeFileImpl: options.writeFileImpl,
  });
  return { result, outputDir };
}

function okResponse(body: unknown): QwenTransportResponse {
  return { status: 200, headers: headers({ "x-request-id": "req-writing-7" }), body: encode(body) };
}

function repoRoot(): string {
  let dir = process.cwd();
  for (let depth = 0; depth < 4; depth += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = join(dir, "..");
  }
  throw new Error("repo root not found");
}

describe("qwen writing candidates", () => {
  it("dry-run plans both modes without reading the key, sending a request, or creating output", async () => {
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
      for (const input of [storyInput(LONG_STORY), episodeInput()]) {
        const result = await runQwenWriting({ mode: "dry_run", input, outputDir, env, transport });
        expect(result.ok).toBe(true);
        expect(result.requestCount).toBe(0);
        const text = result.lines.join("\n");
        expect(text).toContain("status=dry_run");
        expect(text).toContain("network=not_sent");
        expect(text).toContain("api_key=not_read");
        expect(text).toContain(`model=${QWEN_WRITING_DEFAULT_MODEL}`);
        expect(text).toContain("max_completion_tokens=4096");
        expect(text).toContain("enable_thinking=false");
        expect(text).toContain(input.mode === "story" ? "ads.writing.story-plan.v1" : "ads.writing.episode-draft.v1");
        expect(text).toContain("ads.writing.prompt.v1");
        expect(text).not.toContain(PREMISE);
        expect(text).not.toContain(LONG_STORY);
        expect(text).not.toContain(SECRET);
      }
      expect(keyReads).toBe(0);
      expect(existsSync(outputDir)).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("puts the mainline story instruction, long text, genre, audience, and characters into one request", async () => {
    const sent = once(okResponse(completion(storyPlan())));
    const saved = await execute({ input: storyInput(LONG_STORY), transport: sent.transport });
    expect(sent.calls).toHaveLength(1);
    const body = JSON.parse(sent.calls[0]?.body ?? "{}") as {
      model: string;
      stream: boolean;
      enable_thinking: boolean;
      max_tokens?: number;
      max_completion_tokens?: number;
      n: number;
      messages: Array<{ content: string }>;
    };
    expect(body.model).toBe(QWEN_WRITING_DEFAULT_MODEL);
    expect(body.stream).toBe(false);
    expect(body.enable_thinking).toBe(false);
    expect(body.max_completion_tokens).toBe(4096);
    expect(body.max_tokens).toBeUndefined();
    expect(body.n).toBe(1);
    const user = body.messages[1]?.content ?? "";
    expect(user).toContain("模式：故事策划");
    expect(user).toContain("ads.writing.prompt.v1");
    expect(user).toContain(PREMISE);
    expect(user).toContain("悬疑");
    expect(user).toContain("成人短剧观众");
    expect(user).toContain("店员小林，店长周衡");
    expect(user).toContain("班次记录是真的");
    expect(user).toContain(LONG_STORY);
    expect(user).toContain("1 到 300 字");
    expect(user).toContain("不要截断");
    expect(saved.result.status).toBe("candidate_saved");
    const candidateText = await readFile(join(saved.outputDir, "candidate.json"), "utf8");
    const imported = parseWritingImport(new TextEncoder().encode(candidateText), { mode: "story", episodeNo: null });
    expect(formatWritingImport(imported)).toContain("一句话故事");
    const receipt = JSON.parse(await readFile(join(saved.outputDir, "receipt.json"), "utf8")) as {
      mode: string;
      candidateSchema: string;
      promptVersion: string;
      requestContentSha256: string;
      requestedModel: string;
      responseModel: string;
      serverRequestId: string;
      usage: { status: string; totalTokens: number };
      candidateAccepted: boolean;
      billing: { amount: null; status: string };
      idempotencyNote: string;
      errorCode: null;
    };
    expect(receipt.mode).toBe("story");
    expect(receipt.candidateSchema).toBe("ads.writing.story-plan.v1");
    expect(receipt.promptVersion).toBe("ads.writing.prompt.v1");
    expect(receipt.requestContentSha256).toBe(createHash("sha256").update(sent.calls[0]?.body ?? "").digest("hex"));
    expect(receipt.requestedModel).toBe(QWEN_WRITING_DEFAULT_MODEL);
    expect(receipt.responseModel).toBe(QWEN_WRITING_DEFAULT_MODEL);
    expect(receipt.serverRequestId).toBe("req-writing-7");
    expect(receipt.usage.totalTokens).toBe(33);
    expect(receipt.candidateAccepted).toBe(true);
    expect(receipt.errorCode).toBeNull();
    expect(receipt.billing).toEqual({ amount: null, currency: null, status: "unknown" });
    expect(receipt.idempotencyNote).toBe("local_run_id_is_not_a_provider_guarantee");
    expect(candidateText).not.toContain(SECRET);
    expect(JSON.stringify(receipt)).not.toContain(SECRET);
    expect(JSON.stringify(receipt)).not.toContain(LONG_STORY);
    expect(saved.result.lines.join("\n")).not.toContain(SECRET);
  });

  it("puts the confirmed long story and episode revision material into the episode request", async () => {
    const sent = once(okResponse(completion(episodeDraft())));
    const saved = await execute({ input: episodeInput(), transport: sent.transport });
    expect(sent.calls).toHaveLength(1);
    const body = JSON.parse(sent.calls[0]?.body ?? "{}") as { max_tokens?: number; max_completion_tokens: number; messages: Array<{ content: string }> };
    expect(body.max_completion_tokens).toBe(4096);
    expect(body.max_tokens).toBeUndefined();
    const user = body.messages[1]?.content ?? "";
    expect(user).toContain("模式：单集写作");
    expect(user).toContain("当前集：第 1 集");
    expect(user).toContain(LONG_STORY);
    expect(user).toContain("只改开场");
    expect(user).toContain("还热着");
    expect(user).toContain("记录留在柜台");
    expect(user).toContain("screenplay 1 到 12000 字");
    const candidateText = await readFile(join(saved.outputDir, "candidate.json"), "utf8");
    const imported = parseWritingImport(new TextEncoder().encode(candidateText), { mode: "episode", episodeNo: 1 });
    expect(formatWritingImport(imported)).toContain("店员仍然按着记录");
    expect(saved.result.status).toBe("candidate_saved");
  });

  it("rejects a wrong episode, unknown fields, business identity, and over-limit content without another request", async () => {
    const cases: Array<{ name: string; content: unknown; code: string }> = [
      { name: "episode", content: episodeDraft(2), code: "episode_mismatch" },
      { name: "unknown", content: { ...storyPlan(), extra: "no" }, code: "invalid_candidate" },
      { name: "identity", content: { ...storyPlan(), projectId: "project-1", reviewStatus: "APPROVED" }, code: "invalid_candidate" },
      { name: "screenplay", content: { ...episodeDraft(), screenplay: "字".repeat(12_001) }, code: "invalid_candidate" },
      {
        name: "formatted",
        content: {
          ...episodeDraft(),
          screenplay: "字".repeat(12_000),
          scenes: Array.from({ length: 12 }, () => ({
            heading: "场".repeat(80),
            action: "动".repeat(400),
            dialogue: "白".repeat(400),
            sound: "声".repeat(120),
          })),
        },
        code: "too_large",
      },
    ];
    for (const item of cases) {
      const input = item.name === "episode" || item.name === "screenplay" || item.name === "formatted" ? episodeInput() : storyInput();
      const sent = once(okResponse(completion(item.content)));
      const failed = await execute({ input, transport: sent.transport });
      expect(sent.calls, item.name).toHaveLength(1);
      expect(failed.result.code, item.name).toBe(item.code);
      expect(existsSync(join(failed.outputDir, "candidate.json")), item.name).toBe(false);
      const receipt = JSON.parse(await readFile(join(failed.outputDir, "receipt.json"), "utf8")) as { candidateAccepted: boolean };
      expect(receipt.candidateAccepted, item.name).toBe(false);
    }
  });

  it("rejects non-stop JSON, tool calls, refusal, truncation, corrupt UTF-8, and a malformed completion", async () => {
    const legal = JSON.stringify(storyPlan());
    const cases: Array<{ name: string; response: QwenTransportResponse; code: string }> = [
      { name: "null-finish", response: okResponse(completion(legal, { choices: [{ finish_reason: null, message: { content: legal } }] })), code: "invalid_finish" },
      { name: "unknown-finish", response: okResponse(completion(legal, { choices: [{ finish_reason: "other", message: { content: legal } }] })), code: "invalid_finish" },
      { name: "tools", response: okResponse(completion(legal, { choices: [{ finish_reason: "stop", message: { content: legal, tool_calls: [{ id: "call-1" }] } }] })), code: "tool_call" },
      { name: "function", response: okResponse(completion(legal, { choices: [{ finish_reason: "stop", message: { content: legal, function_call: { name: "save" } } }] })), code: "tool_call" },
      { name: "filter", response: okResponse(completion(legal, { choices: [{ finish_reason: "content_filter", message: { content: legal } }] })), code: "refusal" },
      { name: "refusal", response: okResponse(completion(legal, { choices: [{ finish_reason: "stop", message: { content: legal, refusal: "no" } }] })), code: "refusal" },
      { name: "length", response: okResponse(completion(legal, { choices: [{ finish_reason: "length", message: { content: legal } }] })), code: "truncated" },
      { name: "empty-choices", response: okResponse(completion(legal, { choices: [] })), code: "invalid_response" },
      { name: "two-choices", response: okResponse(completion(legal, { choices: [{ finish_reason: "stop", message: { content: legal } }, { finish_reason: "stop", message: { content: legal } }] })), code: "invalid_response" },
      { name: "utf8", response: { status: 200, headers: headers(), body: Uint8Array.from([0xff, 0xfe]) }, code: "invalid_utf8" },
    ];
    for (const item of cases) {
      const sent = once(item.response);
      const failed = await execute({ transport: sent.transport });
      expect(sent.calls, item.name).toHaveLength(1);
      expect(failed.result.requestCount, item.name).toBe(1);
      expect(failed.result.code, item.name).toBe(item.code);
      expect(existsSync(join(failed.outputDir, "candidate.json")), item.name).toBe(false);
      const receiptText = await readFile(join(failed.outputDir, "receipt.json"), "utf8");
      expect(receiptText).toContain(`"candidateAccepted": false`);
      expect(receiptText).not.toContain(SECRET);
    }
  });

  it("does not send a second request for auth, rate, server, redirect, timeout, disconnect, size, or disk failures", async () => {
    for (const status of [401, 403, 429, 500, 502]) {
      const sent = once({ status, headers: headers(), body: encode({ error: { message: SECRET } }) });
      const failed = await execute({ transport: sent.transport });
      expect(sent.calls).toHaveLength(1);
      expect(failed.result.requestCount).toBe(1);
      const receiptText = await readFile(join(failed.outputDir, "receipt.json"), "utf8");
      expect(receiptText).not.toContain(SECRET);
      expect(existsSync(join(failed.outputDir, "candidate.json"))).toBe(false);
    }
    const redirect = once({ status: 302, headers: headers({ location: "https://example.invalid/next" }), body: null });
    const redirected = await execute({ transport: redirect.transport });
    expect(redirect.calls).toHaveLength(1);
    expect(redirected.result.code).toBe("redirect_rejected");
    expect(redirected.result.lines.join("\n")).toContain("billing are unknown");
    const disconnected = once(() => Promise.reject(new TypeError("socket hang up")));
    const disconnect = await execute({ transport: disconnected.transport });
    expect(disconnected.calls).toHaveLength(1);
    expect(disconnect.result.code).toBe("disconnected");
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
    const failingWrite = once(okResponse(completion(storyPlan())));
    const failedSave = await execute({
      transport: failingWrite.transport,
      writeFileImpl: () => Promise.reject(new Error("disk full")),
    });
    expect(failingWrite.calls).toHaveLength(1);
    expect(failedSave.result.code).toBe("save_failed");
    expect(failedSave.result.lines.join("\n")).toContain("does not recommend an unconditional retry");
  });

  it("does not overwrite an existing output directory or call the model", async () => {
    const outputDir = await freshOutput();
    await mkdir(outputDir);
    await writeFile(join(outputDir, "marker.txt"), "keep");
    const sent = once(okResponse(completion(storyPlan())));
    const blocked = await execute({ transport: sent.transport, outputDir });
    expect(sent.calls).toHaveLength(0);
    expect(blocked.result.requestCount).toBe(0);
    expect(blocked.result.code).toBe("output_exists");
    expect(await readFile(join(outputDir, "marker.txt"), "utf8")).toBe("keep");
  });

  it("runs the writing CLI dry-run in a subprocess", async () => {
    const root = repoRoot();
    const parent = await mkdtemp(join(tmpdir(), "qwen-writing-cli-"));
    const outputDir = join(parent, "out");
    const dry = spawnSync("pnpm", ["qwen:writing", "--", "--input", "packages/providers/examples/qwen-writing-story.input.json", "--output", outputDir], {
      cwd: root,
      encoding: "utf8",
      shell: process.platform === "win32",
      env: { ...process.env, DASHSCOPE_API_KEY: SECRET, BAILIAN_BASE_URL: "https://example.invalid/compatible-mode/v1" },
    });
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("status=dry_run");
    expect(dry.stdout).toContain("mode=story");
    expect(dry.stdout).toContain("network=not_sent");
    expect(dry.stdout).toContain("api_key=not_read");
    expect(`${dry.stdout}${dry.stderr}`).not.toContain(SECRET);
    expect(`${dry.stdout}${dry.stderr}`).not.toContain("夜班便利店");
    expect(existsSync(outputDir)).toBe(false);
    const episode = spawnSync("pnpm", ["qwen:writing", "--", "--input", "packages/providers/examples/qwen-writing-episode.input.json", "--output", join(parent, "episode")], {
      cwd: root,
      encoding: "utf8",
      shell: process.platform === "win32",
      env: { ...process.env, DASHSCOPE_API_KEY: SECRET },
    });
    expect(episode.status).toBe(0);
    expect(episode.stdout).toContain("mode=episode");
    expect(episode.stdout).toContain("ads.writing.episode-draft.v1");
    expect(existsSync(join(parent, "episode"))).toBe(false);
    expect(parseQwenWritingArgs(["--api-key", SECRET]).ok).toBe(false);
    const lines: string[] = [];
    const code = await runQwenWritingCli(
      ["--input", join(root, "packages/providers/examples/qwen-writing-story.input.json"), "--output", join(parent, "direct")],
      {},
      (line) => lines.push(line),
      (line) => lines.push(line),
    );
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("status=dry_run");
  });
});
