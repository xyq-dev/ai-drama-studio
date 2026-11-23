// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Workbench } from "./workbench";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

function fixture(episodeCount: number, episodeNo?: number, writingMode: "short" | "series" = "short") {
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input).split("?")[0] ?? String(input);
    const method = init?.method ?? "GET";
    requests.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    let body: unknown = { items: [], nextCursor: null };
    if (path.endsWith("/projects/project-1")) {
      body = { id: "project-1", title: "分集作品", premise: "测试故事", version: 1, status: "ACTIVE", episodeCount, writingMode, targetEpisodeSeconds: 60 };
    } else if (path.endsWith("/episodes")) {
      body = { items: Array.from({ length: episodeCount }, (_, index) => ({
        id: `episode-${index + 1}`, episodeNo: index + 1, title: `第${index + 1}集`, rowVersion: 1,
        currentScriptRevisionId: `script-${index + 1}`, approvedScriptRevisionId: null,
      })) };
    } else if (path.endsWith("/stories")) {
      body = { items: [{ id: "story-1", revisionNo: 1, content: { text: "已批准的故事" }, reviewStatus: "APPROVED", freshnessStatus: "CURRENT", reviewVersion: 1 }], nextCursor: null };
    } else if (path.endsWith("/scripts")) {
      body = { items: [{ id: `script-${episodeNo}`, revisionNo: 1, sourceStoryRevisionId: "story-1", content: { text: "原剧本" }, reviewStatus: "DRAFT", freshnessStatus: "CURRENT", reviewVersion: 1 }], nextCursor: null };
    } else if (path.endsWith("/workflow-runs")) {
      body = [];
    }
    return new Response(JSON.stringify(body), { status: method === "POST" ? 201 : 200, headers: { "content-type": "application/json" } });
  }));
  window.history.replaceState(null, "", `/projects/project-1?focus=${episodeNo ? `script&episode=${episodeNo}` : "story"}`);
  render(<Workbench projectId="project-1" />);
  return requests;
}

describe("writing assistant with variable episode projects", () => {
  it.each([1, 2, 3, 4, 5, 6])("offers the story assistant and manual saves for a %i-episode project", async (episodeCount) => {
    const requests = fixture(episodeCount);
    await screen.findByDisplayValue("已批准的故事");
    expect(screen.getByRole("button", { name: "编剧助手" })).toBeTruthy();
    expect(requests.some((request) => request.path.includes("qwen"))).toBe(false);
    fireEvent.change(screen.getByLabelText("正文"), { target: { value: "手动修改故事" } });
    fireEvent.click(within(screen.getByLabelText("正文").closest("form")!).getByRole("button", { name: "保存新版本" }));
    await waitFor(() => expect(requests.filter((request) => request.method === "POST")).toEqual([
      { path: "/api/v1/projects/project-1/stories", method: "POST", body: { content: { text: "手动修改故事" } } },
    ]));
    await screen.findByText("已保存");
  });

  it.each([1, 2, 3, 4, 5, 6])("offers the episode assistant and preserves saves for episode %i", async (episodeNo) => {
    const requests = fixture(6, episodeNo);
    await screen.findByDisplayValue("原剧本");
    expect(screen.getByRole("button", { name: "编剧助手" })).toBeTruthy();
    expect(requests.some((request) => request.path.includes("qwen"))).toBe(false);
    fireEvent.change(screen.getByLabelText("正文"), { target: { value: "手动修改这一集" } });
    fireEvent.click(within(screen.getByLabelText("正文").closest("form")!).getByRole("button", { name: "保存新版本" }));
    await waitFor(() => expect(requests.filter((request) => request.method === "POST")).toEqual([
      { path: `/api/v1/projects/project-1/episodes/episode-${episodeNo}/scripts`, method: "POST", body: {
        storyRevisionId: "story-1", sourceStoryRevisionId: "story-1", content: { text: "手动修改这一集" },
      } },
    ]));
    await screen.findByText("已保存");
  });

  it("previews one episode of a single-episode story and saves the adopted candidate", async () => {
    const requests = fixture(1);
    await screen.findByDisplayValue("已批准的故事");
    fireEvent.click(screen.getByRole("button", { name: "编剧助手" }));
    fireEvent.click(screen.getByRole("button", { name: "准备创作指令" }));
    const plan = {
      schema: "ads.writing.story-plan.v1", logline: "一个少年追车还照片", protagonistGoal: "找回失主", opposition: "末班车即将离站",
      coreConflict: "赶在发车前还照片", relationships: [{ name: "司机", pressure: "快发车了" }],
      episodes: [{ episodeNo: 1, entryState: "车已启动", goal: "还照片", action: "少年追车", turn: "司机看见少年",
        result: "全家福交还给司机", handoff: "车缓缓驶离" }],
    };
    fireEvent.change(screen.getByLabelText("粘贴 JSON 候选"), { target: { value: JSON.stringify(plan) } });
    fireEvent.click(screen.getByRole("button", { name: "校验并预览" }));
    const preview = (await screen.findByLabelText("候选正文") as HTMLTextAreaElement).value;
    expect(preview).toContain("全家福交还给司机");
    expect(preview).not.toMatch(/第 [23] 集/u);
    fireEvent.click(screen.getByRole("button", { name: "采纳到草稿" }));
    fireEvent.click(within(screen.getByLabelText("正文").closest("form")!).getByRole("button", { name: "保存新版本" }));
    await waitFor(() => expect(requests.filter(({ method }) => method === "POST")).toEqual([
      { path: "/api/v1/projects/project-1/stories", method: "POST", body: { content: { text: preview } } },
    ]));
  });

  it("keeps the separate story entry for a long series", async () => {
    fixture(8, undefined, "series");
    await screen.findByDisplayValue("已批准的故事");
    expect(screen.getByText(/请在系列编剧页生成故事/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "编剧助手" })).toBeNull();
  });

  it.each([3, 4])("retains the legacy episode boundaries for episode %i of a long series", async (episodeNo) => {
    fixture(8, episodeNo, "series");
    await screen.findByDisplayValue("原剧本");
    expect(Boolean(screen.queryByRole("button", { name: "编剧助手" }))).toBe(episodeNo <= 3);
  });
});
