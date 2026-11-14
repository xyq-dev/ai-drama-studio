// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ShortSequelAiTaskView, ShortSequelAiView } from "@ai-drama/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyScript } from "../lib/script-workbench-model";
import { ShortSequelAi } from "./short-sequel-ai";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const TASK = "22222222-2222-4222-8222-222222222222";
const ATTEMPT = "33333333-3333-4333-8333-333333333333";
const LATER_ATTEMPT = "44444444-4444-4444-8444-444444444444";

const makeTask = (patch: Partial<ShortSequelAiTaskView> = {}): ShortSequelAiTaskView => ({
  taskId: TASK,
  attemptId: ATTEMPT,
  episodeNo: 2,
  episodeCount: 2,
  targetEpisodeSeconds: 60,
  direction: "",
  source: { storyRevisionId: null, previousRevisionId: null, originalRunId: null, originalEpisodeHash: null },
  state: "unknown",
  script: null,
  stale: false,
  canResume: true,
  providerKey: "deepseek",
  model: "deepseek-example",
  usage: { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null },
  billing: "unknown",
  errorCode: null,
  createdAt: "2026-11-14T00:00:00Z",
  finishedAt: null,
  ...patch,
});

function openPanel() {
  const details = screen.getByText("AI 续写").parentElement as HTMLDetailsElement;
  details.open = true;
  fireEvent(details, new Event("toggle"));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("independent episode AI controls", () => {
  it("needs explicit consent to resume an uncertain attempt and calls only its own resume endpoint", async () => {
    const view: ShortSequelAiView = { enabled: true, operatorTokenRequired: false, hasBody: false, previousTasks: [], nextCursor: null, task: makeTask() };
    const requests: { path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        requests.push({ path, body: JSON.parse(String(init.body)) });
        view.task = makeTask({ state: "completed", canResume: false, script: emptyScript("第二集候选") });
      }
      return Response.json(view);
    }));
    const adopt = vi.fn();
    render(<ShortSequelAi projectId={PROJECT} episodeNo={2} hasBody={false} hasUnsaved={false}
      hasPlan={false} source="" onAdopt={adopt} />);
    openPanel();
    const resume = await screen.findByRole("button", { name: "继续第 2 集 AI 任务" });
    expect((resume as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(resume);
    await waitFor(() => expect(requests).toEqual([{
      path: `/api/v1/projects/${PROJECT}/short-sequels/2/ai/${TASK}/resume`,
      body: { attemptId: ATTEMPT, confirmUncertain: true },
    }]));
    fireEvent.click(await screen.findByRole("button", { name: "载入编辑器" }));
    expect(adopt).toHaveBeenCalledWith(expect.objectContaining({ script: expect.objectContaining({ title: "第二集候选" }) }));
  });

  it("leaves a previously generated candidate viewable when the episode already has saved text", async () => {
    const view: ShortSequelAiView = { enabled: true, operatorTokenRequired: false, hasBody: true, previousTasks: [], nextCursor: null,
      task: makeTask({ stale: true, state: "completed", canResume: false, script: emptyScript("第二集过期稿") }) };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(view)));
    render(<ShortSequelAi projectId={PROJECT} episodeNo={2} hasBody={false} hasUnsaved={false}
      hasPlan source="" onAdopt={vi.fn()} />);
    openPanel();
    expect(await screen.findByText("查看过期 AI 草稿")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "载入编辑器" })).toBeNull();
    expect(screen.queryByRole("button", { name: "重新生成本集草稿" })).toBeNull();
  });

  it("binds regenerate consent to the rendered attempt and requires reconfirmation after refresh", async () => {
    const view: ShortSequelAiView = { enabled: true, operatorTokenRequired: false, hasBody: false,
      previousTasks: [], nextCursor: null, task: makeTask() };
    const writes: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method !== "POST") return Response.json(view);
      writes.push(JSON.parse(String(init.body)));
      view.task = makeTask({ attemptId: LATER_ATTEMPT });
      return Response.json({ error: { code: "SHORT_SEQUEL_AI_NEEDS_CONFIRMATION", message: "请确认当前尝试。" } }, { status: 409 });
    }));
    render(<ShortSequelAi projectId={PROJECT} episodeNo={2} hasBody={false} hasUnsaved={false}
      hasPlan source="" onAdopt={vi.fn()} />);
    openPanel();
    const button = await screen.findByRole<HTMLButtonElement>("button", { name: "重新生成本集草稿" });
    const checkbox = screen.getByRole<HTMLInputElement>("checkbox");
    fireEvent.click(checkbox);
    fireEvent.click(button);
    await waitFor(() => expect(writes).toEqual([{ direction: "", confirmUncertainAttemptId: ATTEMPT }]));
    await waitFor(() => expect(checkbox.checked).toBe(false));
    expect(button.disabled).toBe(true);
    fireEvent.click(checkbox);
    fireEvent.click(button);
    await waitFor(() => expect(writes.at(-1)).toEqual({ direction: "", confirmUncertainAttemptId: LATER_ATTEMPT }));
  });

  it("loads successive pages of older AI drafts without replacing the current task", async () => {
    const view: ShortSequelAiView = { enabled: true, operatorTokenRequired: false, hasBody: true, previousTasks: [],
      nextCursor: "older-page", task: makeTask({ state: "completed", canResume: false, script: emptyScript("当前纸鹤稿") }) };
    const older = makeTask({ taskId: LATER_ATTEMPT, stale: true, state: "completed", canResume: false, script: emptyScript("较早的纸鹤稿") });
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path.endsWith("cursor=older-page")) return Response.json({ items: [older], nextCursor: "oldest-page" });
      if (path.endsWith("cursor=oldest-page")) return Response.json({ items: [{ ...older, taskId: PROJECT, script: emptyScript("最早的纸鹤稿") }], nextCursor: null });
      return Response.json(view);
    }));
    render(<ShortSequelAi projectId={PROJECT} episodeNo={2} hasBody={true} hasUnsaved={false}
      hasPlan source="" onAdopt={vi.fn()} />);
    openPanel();
    fireEvent.click(await screen.findByRole("button", { name: "加载更早的 AI 草稿" }));
    await screen.findByText("较早的纸鹤稿");
    fireEvent.click(screen.getByRole("button", { name: "加载更早的 AI 草稿" }));
    await screen.findByText("最早的纸鹤稿");
    expect(screen.getByText("当前纸鹤稿")).toBeTruthy();
    expect(screen.getByText("较早的纸鹤稿")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "加载更早的 AI 草稿" })).toBeNull();
  });
});
