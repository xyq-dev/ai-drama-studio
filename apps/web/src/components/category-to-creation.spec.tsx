// @vitest-environment happy-dom
// Simulated interface tests. fetch is mocked; this file does not start a browser or a backend.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WritingTargetSnapshot } from "@ai-drama/domain/writing-assistant";
import { CATEGORIES, DIRECTION_STORAGE_KEY, TAGS } from "../lib/creative-taxonomy";
import { premiseBlock, projectDirectionKey } from "../lib/creative-direction-link";
import { LIMITS } from "../lib/studio-model";
import { ProjectHome } from "./project-home";
import { WritingAssistant } from "./writing-assistant";

const DIRECTION = { version: 1 as const, categoryId: CATEGORIES[0]!.id, tagIds: [TAGS[0]!.id] };
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function stubProjects(posts: string[]) {
  vi.stubGlobal("fetch", vi.fn((_input: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push(String(init.body));
      return Promise.resolve(json({ id: PROJECT_ID, title: "夜班", premise: "", version: 1, status: "ACTIVE" }, 201));
    }
    return Promise.resolve(json({ items: [], nextCursor: null }));
  }));
}

describe("category direction into a new work", () => {
  it("opens the composer from the flag, adds the direction once and binds it to the created project", async () => {
    window.localStorage.setItem(DIRECTION_STORAGE_KEY, JSON.stringify(DIRECTION));
    window.history.replaceState(null, "", "/studio?direction=1");
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    const posts: string[] = [];
    stubProjects(posts);
    render(<ProjectHome />);
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/只保存在本浏览器/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "夜班" } });
    fireEvent.change(screen.getByLabelText("故事梗概"), { target: { value: "原有梗概" } });
    fireEvent.click(screen.getByRole("button", { name: "把创作方向加入梗概" }));
    const premise = screen.getByLabelText("故事梗概") as HTMLTextAreaElement;
    expect(premise.value).toBe(`原有梗概\n\n${premiseBlock(DIRECTION)}`);
    fireEvent.click(screen.getByRole("button", { name: "把创作方向加入梗概" }));
    expect(await screen.findByText("梗概里已经有这段创作方向，没有重复加入。")).toBeTruthy();
    expect(premise.value.split(premiseBlock(DIRECTION)).length).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/projects/${PROJECT_ID}`));
    expect(JSON.parse(posts[0] ?? "{}")).toEqual({ title: "夜班", premise: `原有梗概\n\n${premiseBlock(DIRECTION)}` });
    expect(JSON.parse(window.localStorage.getItem(projectDirectionKey(PROJECT_ID)) ?? "null"))
      .toEqual({ version: 1, projectId: PROJECT_ID, direction: DIRECTION });
    expect(window.location.search).not.toContain(CATEGORIES[0]!.name);
  });

  it("does not bind a direction that was never added, and refuses a premise that would overflow", async () => {
    window.localStorage.setItem(DIRECTION_STORAGE_KEY, JSON.stringify(DIRECTION));
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    const posts: string[] = [];
    stubProjects(posts);
    render(<ProjectHome />);
    await screen.findByText(/还没有项目/);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "新建作品" }));
    fireEvent.change(await screen.findByLabelText("标题"), { target: { value: "夜班" } });
    const full = "满".repeat(LIMITS.premise - 5);
    fireEvent.change(screen.getByLabelText("故事梗概"), { target: { value: full } });
    fireEvent.click(screen.getByRole("button", { name: "把创作方向加入梗概" }));
    expect(await screen.findByText(/超过梗概长度上限/)).toBeTruthy();
    expect((screen.getByLabelText("故事梗概") as HTMLTextAreaElement).value).toBe(full);
    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(window.localStorage.getItem(projectDirectionKey(PROJECT_ID))).toBeNull();
  });

  it("offers the bound direction only to its own project's story assistant", async () => {
    window.localStorage.setItem(projectDirectionKey(PROJECT_ID), JSON.stringify({ version: 1, projectId: PROJECT_ID, direction: DIRECTION }));
    const view = render(createElement(WritingAssistant, assistantProps("other-project")));
    fireEvent.click(screen.getByRole("button", { name: "编剧助手" }));
    expect(screen.queryByRole("button", { name: "带入分类方向" })).toBeNull();
    view.unmount();
    render(createElement(WritingAssistant, assistantProps(PROJECT_ID)));
    fireEvent.click(screen.getByRole("button", { name: "编剧助手" }));
    fireEvent.change(screen.getByLabelText("题材"), { target: { value: "悬疑" } });
    fireEvent.click(screen.getByRole("button", { name: "准备创作指令" }));
    fireEvent.click(await screen.findByRole("button", { name: "带入分类方向" }));
    const genre = screen.getByLabelText("题材") as HTMLInputElement;
    expect(genre.value).toContain("悬疑");
    expect(genre.value).toContain(CATEGORIES[0]!.name);
    expect(await screen.findByText(/之前准备的指令和候选不能直接采纳，请重新准备创作指令/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "带入分类方向" }));
    expect(await screen.findByText("题材里已经有这条分类方向，没有重复加入。")).toBeTruthy();
    expect(genre.value.split(CATEGORIES[0]!.name).length).toBe(2);
  });
});

function assistantProps(projectId: string) {
  const target: WritingTargetSnapshot = {
    projectId, entityKey: "story", mode: "story", episodeNo: null, sourceRevisionId: "rev-1", ifMatch: 1,
    draftFingerprint: "same", currentText: "原文", loaded: true,
  };
  return {
    mode: "story" as const, projectId, entityKey: "story", episodeNo: null, premise: "夜班", confirmedMaterials: "",
    loaded: true, capture: () => target, onAdopt: () => true,
  };
}
