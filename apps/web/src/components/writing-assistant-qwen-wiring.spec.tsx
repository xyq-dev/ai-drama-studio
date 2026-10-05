// @vitest-environment happy-dom
/**
 * 模拟 Provider 接线验证。
 * 候选来自可注入 transport 返回的手写完成结果，不是千问真实生成。
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { runQwenWriting } from "@ai-drama/providers";
import { Workbench } from "./workbench";

const SECRET = "sk-qwen-wiring-test-key-9f3a";

const SIMULATED_PLAN = {
  schema: "ads.writing.story-plan.v1",
  logline: "模拟 Provider 接线候选，不是千问真实生成结果",
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

function json(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  }));
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("模拟 Provider 接线验证", () => {
  it("imports a simulated candidate, previews it, and adopts it without POST or a new If-Match", async () => {
    const outputDir = join(await mkdtemp(join(tmpdir(), "qwen-wiring-")), "run");
    let requests = 0;
    const generated = await runQwenWriting({
      mode: "execute",
      input: {
        schema: "qwen.writing.input.v1",
        mode: "story",
        premise: "夜班便利店",
        genre: "悬疑",
        audience: "成人",
        characters: "店员",
        mustKeep: "班次记录是真的",
        mustNotChange: "",
        currentText: "",
      },
      outputDir,
      env: {
        NODE_ENV: "test",
        DASHSCOPE_API_KEY: SECRET,
        BAILIAN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      },
      transport: async () => {
        requests += 1;
        return {
          status: 200,
          headers: { get: () => null },
          body: new TextEncoder().encode(JSON.stringify({
            id: "sim-1",
            model: "qwen3.7-plus-2026-05-26",
            choices: [{ finish_reason: "stop", message: { content: JSON.stringify(SIMULATED_PLAN) } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })),
        };
      },
      runId: "33333333-3333-4333-8333-333333333333",
      now: () => new Date("2026-10-04T00:00:00.000Z"),
    });
    expect(requests).toBe(1);
    expect(generated.status).toBe("candidate_saved");
    const candidate = await readFile(join(outputDir, "candidate.json"), "utf8");
    expect(candidate).toContain("模拟 Provider 接线候选，不是千问真实生成结果");
    expect(candidate).not.toContain(SECRET);

    const calls: Array<{ method: string; ifMatch: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const url = String(input).split("?")[0] ?? String(input);
      const headers = new Headers(init?.headers);
      calls.push({ method, ifMatch: headers.get("If-Match") });
      if (url.endsWith("/projects/project-1") && method === "GET") {
        return json({ id: "project-1", title: "夜班", premise: "夜班便利店", version: 4, status: "ACTIVE" });
      }
      if (url.endsWith("/episodes")) return json({ items: [] });
      if (url.endsWith("/stories") && method === "GET") {
        return json({ items: [{ id: "story-1", revisionNo: 1, content: { text: "故事正文" }, reviewStatus: "APPROVED", freshnessStatus: "CURRENT", reviewVersion: 1, staleReason: null, staleFromRef: null, reviewNote: null }], nextCursor: null });
      }
      if (url.endsWith("/characters") || url.endsWith("/locations")) return json({ items: [], nextCursor: null });
      if (url.endsWith("/workflow-runs")) return json([]);
      return json({ error: { code: "NOT_FOUND", message: url } }, 404);
    }));
    window.history.replaceState(null, "", "/projects/project-1?focus=story");
    render(createElement(Workbench, { projectId: "project-1" }));
    fireEvent.click(await screen.findByRole("button", { name: "编剧助手" }));
    expect(screen.getByText("本轮通过外部 AI 创作，网页不会自动调用模型。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "生成" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "准备创作指令" }));
    expect(await screen.findByLabelText("创作指令")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("粘贴 JSON 候选"), { target: { value: candidate } });
    fireEvent.click(screen.getByRole("button", { name: "校验并预览" }));
    expect(await screen.findByLabelText("候选正文")).toBeTruthy();
    expect((screen.getByLabelText("候选正文") as HTMLTextAreaElement).value).toContain("模拟 Provider 接线候选，不是千问真实生成结果");
    expect((screen.getByLabelText("正文") as HTMLTextAreaElement).value).toBe("故事正文");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "采纳到草稿" }));
    await waitFor(() => expect((screen.getByLabelText("正文") as HTMLTextAreaElement).value).toContain("一句话故事"));
    expect((screen.getByLabelText("正文") as HTMLTextAreaElement).value).toContain("模拟 Provider 接线候选，不是千问真实生成结果");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    const draft = JSON.parse(sessionStorage.getItem("ads-draft:project-1:story:story-1") ?? "null") as { ifMatch: number };
    expect(draft.ifMatch).toBe(4);
  });
});
