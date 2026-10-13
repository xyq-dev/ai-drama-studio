// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Workbench } from "./workbench";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

function fixture(episodeCount: number, episodeNo?: number) {
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input).split("?")[0] ?? String(input);
    const method = init?.method ?? "GET";
    requests.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    let body: unknown = { items: [], nextCursor: null };
    if (path.endsWith("/projects/project-1")) {
      body = { id: "project-1", title: "分集作品", premise: "测试故事", version: 1, status: "ACTIVE", episodeCount, targetEpisodeSeconds: 60 };
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

describe("legacy writing assistant with variable episode projects", () => {
  it.each([1, 2, 4, 5, 6])("does not offer a three-episode story assistant for a %i-episode project", async (episodeCount) => {
    const requests = fixture(episodeCount);
    await screen.findByDisplayValue("已批准的故事");
    expect(screen.getByText(/故事编剧助手目前仅支持三集作品/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "编剧助手" })).toBeNull();
    expect(requests.some((request) => request.path.includes("qwen"))).toBe(false);
    fireEvent.change(screen.getByLabelText("正文"), { target: { value: "手动修改故事" } });
    fireEvent.click(within(screen.getByLabelText("正文").closest("form")!).getByRole("button", { name: "保存新版本" }));
    await waitFor(() => expect(requests.filter((request) => request.method === "POST")).toEqual([
      { path: "/api/v1/projects/project-1/stories", method: "POST", body: { content: { text: "手动修改故事" } } },
    ]));
    await screen.findByText("已保存");
  });

  it.each([4, 5, 6])("keeps episode %i manually editable without an unsupported assistant", async (episodeNo) => {
    const requests = fixture(6, episodeNo);
    await screen.findByDisplayValue("原剧本");
    expect(screen.getByText(/分集编剧助手目前仅支持第 1–3 集/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "编剧助手" })).toBeNull();
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

  it("retains the three-episode story assistant", async () => {
    fixture(3);
    expect(await screen.findByRole("button", { name: "编剧助手" })).toBeTruthy();
  });

  it.each([1, 2, 3])("retains the assistant for episode %i of a six-episode project", async (episodeNo) => {
    fixture(6, episodeNo);
    await screen.findByDisplayValue("原剧本");
    expect(screen.getByRole("button", { name: "编剧助手" })).toBeTruthy();
  });
});
