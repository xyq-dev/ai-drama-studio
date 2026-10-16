// @vitest-environment happy-dom
/**
 * The writing assistant inside the real Workbench, after the workspace Qwen route was retired: a handwritten candidate
 * (not a model result) is imported, previewed and adopted without any POST, and nothing is ever sent to the retired route.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Workbench } from "./workbench";

const SIMULATED_PLAN = {
  schema: "ads.writing.story-plan.v1",
  logline: "手写接线候选，不是模型生成结果",
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

describe("writing assistant wiring in the Workbench", () => {
  it("imports a handwritten candidate, previews it, and adopts it without POST, a new If-Match or any retired route", async () => {
    const candidate = JSON.stringify(SIMULATED_PLAN);
    const calls: Array<{ method: string; ifMatch: string | null; url: string }> = [];
    vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const url = String(input).split("?")[0] ?? String(input);
      const headers = new Headers(init?.headers);
      calls.push({ method, ifMatch: headers.get("If-Match"), url });
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
    expect(screen.queryByRole("button", { name: "向工作区请求候选" })).toBeNull();
    expect(screen.queryByRole("button", { name: "生成" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "准备创作指令" }));
    expect(await screen.findByLabelText("创作指令")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("粘贴 JSON 候选"), { target: { value: candidate } });
    fireEvent.click(screen.getByRole("button", { name: "校验并预览" }));
    expect(await screen.findByLabelText("候选正文")).toBeTruthy();
    expect((screen.getByLabelText("候选正文") as HTMLTextAreaElement).value).toContain("手写接线候选，不是模型生成结果");
    expect((screen.getByLabelText("正文") as HTMLTextAreaElement).value).toBe("故事正文");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "采纳到草稿" }));
    await waitFor(() => expect((screen.getByLabelText("正文") as HTMLTextAreaElement).value).toContain("一句话故事"));
    expect((screen.getByLabelText("正文") as HTMLTextAreaElement).value).toContain("手写接线候选，不是模型生成结果");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    expect(calls.some((call) => call.url.includes("qwen"))).toBe(false);
    const draft = JSON.parse(sessionStorage.getItem("ads-draft:project-1:story:story-1") ?? "null") as { ifMatch: number };
    expect(draft.ifMatch).toBe(4);
  });
});
