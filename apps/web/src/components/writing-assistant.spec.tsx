// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoryPlanCandidate, WritingTargetSnapshot } from "@ai-drama/domain/writing-assistant";
import { Workbench } from "./workbench";
import { WritingAssistant } from "./writing-assistant";
import type { QwenWebClient } from "../lib/qwen-web-client";

/** Handwritten fixture. This is not a model result. */
const STORY_PLAN: StoryPlanCandidate = {
  schema: "ads.writing.story-plan.v1",
  logline: "手写测试候选，不是模型结果",
  protagonistGoal: "守住班次记录",
  opposition: "店长能改时间",
  coreConflict: "解释会被当成承认",
  relationships: [{ name: "店员", pressure: "不能供出同事" }],
  episodes: [1, 2, 3].map((episodeNo) => ({
    episodeNo: episodeNo as 1 | 2 | 3,
    entryState: `进入${episodeNo}`,
    goal: `目标${episodeNo}`,
    action: `行动${episodeNo}`,
    turn: `转折${episodeNo}`,
    result: `结果${episodeNo}`,
    handoff: `交接${episodeNo}`,
  })),
};

const EPISODE_PLAN = {
  schema: "ads.writing.episode-draft.v1",
  episodeNo: 2,
  title: "夜班",
  screenplay: "店员仍然按着记录。",
  scenes: [{ heading: "店内", action: "她没有松手", dialogue: "店长：你自己看时间。", sound: "" }],
  handoffFacts: ["记录还在柜台上"],
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

describe("writing assistant beside the editor", () => {
  it("previews an import without writing, then adopts into the original draft baseline", async () => {
    const calls: Array<{ method: string; url: string; ifMatch: string | null; key: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const url = String(input).split("?")[0] ?? String(input);
      const headers = new Headers(init?.headers);
      calls.push({ method, url, ifMatch: headers.get("If-Match"), key: headers.get("Idempotency-Key") });
      if (url.endsWith("/projects/project-1") && method === "GET") {
        return json({ id: "project-1", title: "夜班", premise: "夜班便利店", version: 4, status: "ACTIVE" });
      }
      if (url.endsWith("/episodes")) return json({ items: [{ id: "episode-1", episodeNo: 1, title: "第一集", rowVersion: 3, currentScriptRevisionId: "script-1", approvedScriptRevisionId: "script-1", currentScriptReviewStatus: "APPROVED", currentScriptFreshnessStatus: "CURRENT" }] });
      if (url.endsWith("/stories") && method === "GET") {
        return json({ items: [{ id: "story-1", revisionNo: 1, content: { text: "故事正文" }, reviewStatus: "APPROVED", freshnessStatus: "CURRENT", reviewVersion: 1, staleReason: null, staleFromRef: null, reviewNote: null }], nextCursor: null });
      }
      if (url.endsWith("/stories") && method === "POST") return json({ ok: true }, init && headers.get("If-Match") === "4" ? 201 : 409);
      if (url.endsWith("/characters") || url.endsWith("/locations")) return json({ items: [], nextCursor: null });
      if (url.endsWith("/workflow-runs")) return json([]);
      if (url.endsWith("/scripts")) {
        return json({ items: [{ id: "script-1", revisionNo: 1, sourceStoryRevisionId: "story-1", content: { text: "剧本正文" }, reviewStatus: "DRAFT", freshnessStatus: "CURRENT", reviewVersion: 1 }], nextCursor: null });
      }
      if (url.endsWith("/scenes")) return json({ items: [], nextCursor: null });
      return json({ error: { code: "NOT_FOUND", message: url } }, 404);
    }));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });
    window.history.replaceState(null, "", "/projects/project-1?focus=story");
    render(createElement(Workbench, { projectId: "project-1" }));
    fireEvent.click(await screen.findByRole("button", { name: "编剧助手" }));
    expect(screen.getByText("可以通过外部 AI 创作后导入；服务端开启时，也可以由操作者向工作区千问请求候选。候选仍须比较、采纳到草稿，再手动保存。费用未知不会被写成 0。")).toBeTruthy();
    expect((screen.getByRole("button", { name: "向工作区请求候选" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "准备创作指令" }));
    const instruction = await screen.findByLabelText("创作指令") as HTMLTextAreaElement;
    expect(instruction.value).toContain("ads.writing.prompt.v1");
    expect(instruction.value).toContain("模式：故事策划");
    fireEvent.click(screen.getByRole("button", { name: "复制创作指令" }));
    expect(await screen.findByText("复制没有完成，请从下面的指令正文手动复制")).toBeTruthy();
    expect(instruction.value).toContain("夜班便利店");
    const editor = screen.getByLabelText("正文") as HTMLTextAreaElement;
    expect(editor.value).toBe("故事正文");
    fireEvent.change(screen.getByLabelText("粘贴 JSON 候选"), { target: { value: JSON.stringify(STORY_PLAN) } });
    fireEvent.click(screen.getByRole("button", { name: "校验并预览" }));
    expect(await screen.findByLabelText("候选正文")).toBeTruthy();
    expect((screen.getByLabelText("正文") as HTMLTextAreaElement).value).toBe("故事正文");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "采纳到草稿" }));
    await waitFor(() => expect((screen.getByLabelText("正文") as HTMLTextAreaElement).value).toContain("一句话故事"));
    expect(screen.getByText("已放入编辑草稿。还没有保存，请使用原来的保存新版本。")).toBeTruthy();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    const draftRaw = sessionStorage.getItem("ads-draft:project-1:story:story-1");
    const draft = JSON.parse(draftRaw ?? "null") as { ifMatch: number; idempotencyKey: string };
    expect(draft.ifMatch).toBe(4);
    fireEvent.click(screen.getByRole("button", { name: "收起编剧助手" }));
    expect((screen.getByLabelText("正文") as HTMLTextAreaElement).value).toContain("一句话故事");
    expect(sessionStorage.getItem("ads-writing:project-1:story")).toContain("手写测试候选");
    fireEvent.click(screen.getByRole("button", { name: "保存新版本" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "POST" && call.url.endsWith("/stories"))).toHaveLength(1));
    expect(calls.find((call) => call.method === "POST")?.ifMatch).toBe("4");
    expect(calls.find((call) => call.method === "POST")?.key).toBe(draft.idempotencyKey);
  });

  it("does not let a later edit or a list retry replace the frozen baseline", async () => {
    vi.stubGlobal("fetch", vi.fn((input: string) => {
      const url = String(input).split("?")[0] ?? String(input);
      if (url.endsWith("/projects/project-1")) return json({ id: "project-1", title: "夜班", premise: "夜班便利店", version: 4, status: "ACTIVE" });
      if (url.endsWith("/episodes")) return json({ items: [] });
      if (url.endsWith("/stories")) return json({ items: [{ id: "story-1", revisionNo: 1, content: { text: "故事正文" }, reviewStatus: "APPROVED", freshnessStatus: "CURRENT", reviewVersion: 1, staleReason: null, staleFromRef: null, reviewNote: null }], nextCursor: null });
      if (url.endsWith("/characters") || url.endsWith("/locations")) return json({ items: [], nextCursor: null });
      if (url.endsWith("/workflow-runs")) return json([]);
      return json({ items: [], nextCursor: null });
    }));
    window.history.replaceState(null, "", "/projects/project-1?focus=story");
    render(createElement(Workbench, { projectId: "project-1" }));
    fireEvent.click(await screen.findByRole("button", { name: "编剧助手" }));
    fireEvent.click(screen.getByRole("button", { name: "准备创作指令" }));
    await screen.findByLabelText("创作指令");
    fireEvent.change(screen.getByLabelText("正文"), { target: { value: "故事正文还没保存" } });
    fireEvent.change(screen.getByLabelText("粘贴 JSON 候选"), { target: { value: JSON.stringify(STORY_PLAN) } });
    fireEvent.click(screen.getByRole("button", { name: "校验并预览" }));
    await screen.findByLabelText("候选正文");
    expect((screen.getByLabelText("正文") as HTMLTextAreaElement).value).toBe("故事正文还没保存");
    fireEvent.click(screen.getByRole("button", { name: "采纳到草稿" }));
    expect(await screen.findByText(/正文草稿已变化/)).toBeTruthy();
    expect((screen.getByLabelText("正文") as HTMLTextAreaElement).value).toBe("故事正文还没保存");
  });
});

describe("writing assistant isolation", () => {
  function target(entityKey: string, episodeNo: number | null): WritingTargetSnapshot {
    return {
      projectId: "project-1",
      entityKey,
      mode: episodeNo === null ? "story" : "episode",
      episodeNo,
      sourceRevisionId: "rev-1",
      ifMatch: 2,
      draftFingerprint: "same",
      currentText: "原文",
      loaded: true,
    };
  }

  it("drops a file read after the episode changes, and keeps assistant drafts apart", async () => {
    let release: (value: ArrayBuffer) => void = () => undefined;
    const pending = new Promise<ArrayBuffer>((resolve) => {
      release = resolve;
    });
    const adopted: string[] = [];
    const view = render(createElement(WritingAssistant, {
      mode: "episode",
      projectId: "project-1",
      entityKey: "script:episode-1",
      episodeNo: 1,
      premise: "夜班",
      confirmedMaterials: "故事",
      loaded: true,
      capture: () => target("script:episode-1", 1),
      onAdopt: (text: string) => {
        adopted.push(text);
        return true;
      },
      readFile: () => pending,
    }));
    fireEvent.click(screen.getByRole("button", { name: "编剧助手" }));
    const input = document.querySelector("input[type='file']");
    if (!(input instanceof HTMLInputElement)) throw new Error("missing file input");
    fireEvent.change(input, { target: { files: [new File(["{"], "candidate.json", { type: "application/json" })] } });
    view.rerender(createElement(WritingAssistant, {
      mode: "episode",
      projectId: "project-1",
      entityKey: "script:episode-2",
      episodeNo: 2,
      premise: "夜班",
      confirmedMaterials: "故事",
      loaded: true,
      capture: () => target("script:episode-2", 2),
      onAdopt: (text: string) => {
        adopted.push(text);
        return true;
      },
      readFile: () => pending,
    }));
    release(new TextEncoder().encode(JSON.stringify({ ...EPISODE_PLAN, episodeNo: 1 })).buffer);
    await waitFor(() => expect(sessionStorage.getItem("ads-writing:project-1:script:episode-2")).toBeNull());
    expect(screen.queryByLabelText("候选正文")).toBeNull();
    expect(adopted).toHaveLength(0);
    view.unmount();
    render(createElement(WritingAssistant, {
      mode: "episode",
      projectId: "project-1",
      entityKey: "script:episode-1",
      episodeNo: 1,
      premise: "夜班",
      confirmedMaterials: "故事",
      loaded: true,
      capture: () => target("script:episode-1", 1),
      onAdopt: () => true,
      readFile: () => Promise.resolve(new ArrayBuffer(0)),
    }));
    fireEvent.click(screen.getByRole("button", { name: "编剧助手" }));
    expect(screen.queryByLabelText("候选正文")).toBeNull();
  });

  it("keeps the faster file when an earlier read finishes later", async () => {
    const slow = deferredBuffer();
    const adopted: string[] = [];
    render(createElement(WritingAssistant, storyProps({
      onAdopt: (text: string) => {
        adopted.push(text);
        return true;
      },
      readFile: (file: File) => file.name === "a.json"
        ? slow.promise
        : Promise.resolve(encoded(storyCandidate("较快的手写候选，不是模型结果"))),
    })));
    fireEvent.click(screen.getByRole("button", { name: "编剧助手" }));
    chooseFile("a.json");
    chooseFile("b.json");
    await waitFor(() => expect(preview()).toContain("较快的手写候选，不是模型结果"));
    slow.release(encoded(storyCandidate("较慢的手写候选，不是模型结果")));
    await slow.promise;
    expect(preview()).toContain("较快的手写候选，不是模型结果");
    expect(preview()).not.toContain("较慢的手写候选");
    expect(adopted).toHaveLength(0);
    expect(storyProps().capture().ifMatch).toBe(2);
  });

  it("does not let an in-flight file replace a pasted candidate or a newer error", async () => {
    const reads: Array<ReturnType<typeof deferredBuffer>> = [];
    const adopted: string[] = [];
    render(createElement(WritingAssistant, storyProps({
      onAdopt: (text: string) => {
        adopted.push(text);
        return true;
      },
      readFile: () => {
        const next = deferredBuffer();
        reads.push(next);
        return next.promise;
      },
    })));
    fireEvent.click(screen.getByRole("button", { name: "编剧助手" }));
    chooseFile("a.json");
    fireEvent.change(screen.getByLabelText("粘贴 JSON 候选"), {
      target: { value: JSON.stringify(storyCandidate("粘贴的手写候选，不是模型结果")) },
    });
    fireEvent.click(screen.getByRole("button", { name: "校验并预览" }));
    await waitFor(() => expect(preview()).toContain("粘贴的手写候选，不是模型结果"));
    reads[0]?.reject(new Error("disk"));
    await reads[0]?.promise.catch(() => undefined);
    expect(screen.queryByText("文件没有读完")).toBeNull();
    expect(preview()).toContain("粘贴的手写候选，不是模型结果");
    chooseFile("c.json");
    fireEvent.change(screen.getByLabelText("粘贴 JSON 候选"), { target: { value: "{" } });
    fireEvent.click(screen.getByRole("button", { name: "校验并预览" }));
    expect(await screen.findByText("导入内容不是合法 JSON")).toBeTruthy();
    reads[1]?.release(encoded(storyCandidate("较慢的手写候选，不是模型结果")));
    await reads[1]?.promise;
    expect(screen.getByText("导入内容不是合法 JSON")).toBeTruthy();
    expect(preview()).toContain("粘贴的手写候选，不是模型结果");
    expect(preview()).not.toContain("较慢的手写候选");
    expect(adopted).toHaveLength(0);
    expect(storyProps().capture().ifMatch).toBe(2);
  });

  it("does not bind an in-flight file to a newly prepared episode instruction", async () => {
    const slow = deferredBuffer();
    const adopted: string[] = [];
    const capture = () => target("script:episode-1", 1);
    render(createElement(WritingAssistant, {
      ...storyProps({
        onAdopt: (text: string) => {
          adopted.push(text);
          return true;
        },
        readFile: () => slow.promise,
      }),
      mode: "episode",
      entityKey: "script:episode-1",
      episodeNo: 1,
      confirmedMaterials: "已保存的故事",
      capture,
    }));
    fireEvent.click(screen.getByRole("button", { name: "编剧助手" }));
    fireEvent.change(screen.getByLabelText("题材"), { target: { value: "悬疑" } });
    fireEvent.change(screen.getByLabelText("目标观众"), { target: { value: "成人" } });
    fireEvent.change(screen.getByLabelText("人物设定"), { target: { value: "店员" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "确认使用当前已加载的故事与分集材料" }));
    fireEvent.change(screen.getByLabelText("修改要求"), { target: { value: "只改开场" } });
    fireEvent.click(screen.getByRole("button", { name: "准备创作指令" }));
    const instruction = screen.getByLabelText("创作指令") as HTMLTextAreaElement;
    expect(instruction.value).toContain("悬疑");
    expect(instruction.value).toContain("成人");
    expect(instruction.value).toContain("店员");
    expect(instruction.value).toContain("只改开场");
    chooseFile("a.json");
    fireEvent.change(screen.getByLabelText("修改要求"), { target: { value: "改结局" } });
    fireEvent.click(screen.getByRole("button", { name: "准备创作指令" }));
    expect((screen.getByLabelText("创作指令") as HTMLTextAreaElement).value).toContain("改结局");
    expect((screen.getByLabelText("创作指令") as HTMLTextAreaElement).value).not.toContain("只改开场");
    slow.release(encoded({ ...EPISODE_PLAN, episodeNo: 1 }));
    await slow.promise;
    expect(screen.queryByLabelText("候选正文")).toBeNull();
    expect(screen.queryByText("文件没有读完")).toBeNull();
    expect(adopted).toHaveLength(0);
    expect(capture().ifMatch).toBe(2);
    for (const label of ["题材", "目标观众", "人物设定"] as const) {
      const field = screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement;
      const original = field.value;
      fireEvent.change(field, { target: { value: `${original}已改` } });
      fireEvent.change(screen.getByLabelText("粘贴 JSON 候选"), {
        target: { value: JSON.stringify({ ...EPISODE_PLAN, episodeNo: 1 }) },
      });
      fireEvent.click(screen.getByRole("button", { name: "校验并预览" }));
      await screen.findByLabelText("候选正文");
      fireEvent.click(screen.getByRole("button", { name: "采纳到草稿" }));
      expect(await screen.findByText(/创作要求已变化/)).toBeTruthy();
      fireEvent.change(field, { target: { value: original } });
    }
    expect(adopted).toHaveLength(0);
    expect(capture().ifMatch).toBe(2);
  });
});

function storyCandidate(logline: string) {
  return { ...STORY_PLAN, logline };
}

function encoded(value: unknown): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify(value)).buffer;
}

function deferredBuffer() {
  let release: (value: ArrayBuffer) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<ArrayBuffer>((resolve, rejectPromise) => {
    release = resolve;
    reject = rejectPromise;
  });
  return { promise, release, reject };
}

function chooseFile(name: string) {
  const input = document.querySelector("input[type='file']");
  if (!(input instanceof HTMLInputElement)) throw new Error("missing file input");
  fireEvent.change(input, { target: { files: [new File(["{"], name, { type: "application/json" })] } });
}

function preview(): string {
  return (screen.getByLabelText("候选正文") as HTMLTextAreaElement).value;
}

function storyTarget(): WritingTargetSnapshot {
  return {
    projectId: "project-1",
    entityKey: "story",
    mode: "story",
    episodeNo: null,
    sourceRevisionId: "rev-1",
    ifMatch: 2,
    draftFingerprint: "same",
    currentText: "原文",
    loaded: true,
  };
}

describe("workspace Qwen requests", () => {
  it("keeps the workspace button disabled until the server reports the route ready", async () => {
    const client = fakeQwen({ statusCode: "QWEN_WEB_STORAGE_UNAVAILABLE" });
    render(createElement(WritingAssistant, { ...storyProps(), workspaceQwen: client }));
    fireEvent.click(screen.getByRole("button", { name: "编剧助手" }));
    const button = screen.getByRole("button", { name: "向工作区请求候选" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "检查工作区调用" }));
    expect(await screen.findByText("操作者令牌不正确")).toBeTruthy();
    expect(client.status).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("操作者令牌"), { target: { value: "token-1234567890ab" } });
    fireEvent.click(screen.getByRole("button", { name: "检查工作区调用" }));
    expect(await screen.findByText("请求存储尚未就绪，服务端拒绝调用")).toBeTruthy();
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(client.request).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("ads-writing:project-1:story") ?? "").not.toContain("token-1234567890ab");
  });

  it("requests one candidate for the frozen input, replays the same key and does not save it", async () => {
    const client = fakeQwen({ outcomes: [completed(), completed()] });
    const onAdopt = vi.fn(() => true);
    render(createElement(WritingAssistant, { ...storyProps({ onAdopt }), workspaceQwen: client }));
    await readyAssistant();
    fireEvent.click(screen.getByRole("button", { name: "向工作区请求候选" }));
    expect(await screen.findByText("请先准备创作指令")).toBeTruthy();
    expect(client.request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "准备创作指令" }));
    fireEvent.click(screen.getByRole("button", { name: "向工作区请求候选" }));
    expect(await screen.findByText("候选已放进预览。费用未知。还要人工比较、采纳到草稿，再手动保存。")).toBeTruthy();
    expect((screen.getByLabelText("候选正文") as HTMLTextAreaElement).value).toContain("手写测试候选");
    expect(onAdopt).not.toHaveBeenCalled();
    const [projectId, input, key, token] = client.request.mock.calls[0]!;
    expect(projectId).toBe("project-1");
    expect(input).toMatchObject({ schema: "qwen.writing.input.v1", mode: "story", premise: "夜班" });
    expect(token).toBe("token-1234567890ab");
    fireEvent.click(screen.getByRole("button", { name: "向工作区请求候选" }));
    await waitFor(() => expect(client.request).toHaveBeenCalledTimes(2));
    expect(client.request.mock.calls[1]?.[2]).toBe(key);
  });

  it("refuses a request after the input drifted from the frozen instruction", async () => {
    const client = fakeQwen({ outcomes: [completed()] });
    render(createElement(WritingAssistant, { ...storyProps(), workspaceQwen: client }));
    await readyAssistant();
    fireEvent.click(screen.getByRole("button", { name: "准备创作指令" }));
    fireEvent.change(screen.getByLabelText("题材"), { target: { value: "改成喜剧" } });
    fireEvent.click(screen.getByRole("button", { name: "向工作区请求候选" }));
    expect(await screen.findByText("输入已变化，请重新准备创作指令")).toBeTruthy();
    expect(client.request).not.toHaveBeenCalled();
  });

  it("keeps an unknown result without resending and needs an explicit confirmation for a new key", async () => {
    const client = fakeQwen({ outcomes: [result("unknown"), completed()] });
    render(createElement(WritingAssistant, { ...storyProps(), workspaceQwen: client }));
    await readyAssistant();
    fireEvent.click(screen.getByRole("button", { name: "准备创作指令" }));
    fireEvent.click(screen.getByRole("button", { name: "向工作区请求候选" }));
    expect(await screen.findByText(/结果未知：服务商可能已经处理并产生费用/)).toBeTruthy();
    const fresh = screen.getByRole("button", { name: "发起新的调用" }) as HTMLButtonElement;
    expect(fresh.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("我确认发起一次新的调用，可能另外产生费用"));
    fireEvent.click(screen.getByRole("button", { name: "发起新的调用" }));
    await waitFor(() => expect(client.request).toHaveBeenCalledTimes(2));
    expect(client.request.mock.calls[1]?.[2]).not.toBe(client.request.mock.calls[0]?.[2]);
    expect(await screen.findByText("候选已放进预览。费用未知。还要人工比较、采纳到草稿，再手动保存。")).toBeTruthy();
  });

  it("queries a request that is still running instead of sending again", async () => {
    const client = fakeQwen({ outcomes: [result("submitted")], lookups: [completed()] });
    render(createElement(WritingAssistant, { ...storyProps(), workspaceQwen: client }));
    await readyAssistant();
    fireEvent.click(screen.getByRole("button", { name: "准备创作指令" }));
    fireEvent.click(screen.getByRole("button", { name: "向工作区请求候选" }));
    expect(await screen.findByText("请求仍在处理。可以稍后查询，不会重复调用。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "查询请求状态" }));
    expect(await screen.findByText("候选已放进预览。费用未知。还要人工比较、采纳到草稿，再手动保存。")).toBeTruthy();
    expect(client.get).toHaveBeenCalledWith("project-1", "request-1", "token-1234567890ab");
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it("drops a late response after the project changed", async () => {
    let release!: (value: unknown) => void;
    const client = fakeQwen({ outcomes: [] });
    client.request.mockImplementation(() => new Promise((resolve) => { release = resolve; }) as never);
    const view = render(createElement(WritingAssistant, { ...storyProps(), workspaceQwen: client }));
    await readyAssistant();
    fireEvent.click(screen.getByRole("button", { name: "准备创作指令" }));
    fireEvent.click(screen.getByRole("button", { name: "向工作区请求候选" }));
    await waitFor(() => expect(client.request).toHaveBeenCalledTimes(1));
    view.rerender(createElement(WritingAssistant, { ...storyProps(), projectId: "project-2", workspaceQwen: client }));
    release(await completed());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("候选已放进预览。费用未知。还要人工比较、采纳到草稿，再手动保存。")).toBeNull();
    expect(screen.queryByLabelText("候选正文")).toBeNull();
  });

  it("does not import an old request's candidate into a newly prepared instruction (review P1)", async () => {
    const client = fakeQwen({ outcomes: [result("submitted")], lookups: [completed()] });
    const onAdopt = vi.fn(() => true);
    render(createElement(WritingAssistant, { ...storyProps({ onAdopt }), workspaceQwen: client }));
    await readyAssistant();
    fireEvent.click(screen.getByRole("button", { name: "准备创作指令" }));
    fireEvent.click(screen.getByRole("button", { name: "向工作区请求候选" }));
    expect(await screen.findByText("请求仍在处理。可以稍后查询，不会重复调用。")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("题材"), { target: { value: "改成温情" } });
    fireEvent.click(screen.getByRole("button", { name: "准备创作指令" }));
    fireEvent.click(screen.getByRole("button", { name: "查询请求状态" }));
    expect(await screen.findByText(/这个请求属于之前准备的指令/)).toBeTruthy();
    expect(client.get).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("候选正文")).toBeNull();
    expect(screen.queryByRole("button", { name: "采纳到草稿" })).toBeNull();
    expect(onAdopt).not.toHaveBeenCalled();
  });

  it("keeps an unknown request's key across a remount and needs confirmation to rotate it (review P1)", async () => {
    const client = fakeQwen({ outcomes: [result("unknown"), result("unknown"), completed()] });
    const first = render(createElement(WritingAssistant, { ...storyProps(), workspaceQwen: client }));
    await readyAssistant();
    fireEvent.click(screen.getByRole("button", { name: "准备创作指令" }));
    fireEvent.click(screen.getByRole("button", { name: "向工作区请求候选" }));
    expect(await screen.findByText(/结果未知：服务商可能已经处理并产生费用/)).toBeTruthy();
    const firstKey = client.request.mock.calls[0]?.[2];
    first.unmount();

    render(createElement(WritingAssistant, { ...storyProps(), workspaceQwen: client }));
    await readyAssistant();
    expect(screen.getByText(/上次请求结果未知/)).toBeTruthy();
    expect(screen.getByLabelText("我确认发起一次新的调用，可能另外产生费用")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "向工作区请求候选" }));
    await waitFor(() => expect(client.request).toHaveBeenCalledTimes(2));
    expect(client.request.mock.calls[1]?.[2]).toBe(firstKey);
    expect(client.request.mock.calls[1]?.[1]).toEqual(client.request.mock.calls[0]?.[1]);

    fireEvent.change(screen.getByLabelText("题材"), { target: { value: "改成温情" } });
    fireEvent.click(screen.getByRole("button", { name: "准备创作指令" }));
    fireEvent.click(screen.getByRole("button", { name: "向工作区请求候选" }));
    expect(await screen.findByText(/上一次请求的结果还没有确定/)).toBeTruthy();
    expect(client.request).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByLabelText("我确认发起一次新的调用，可能另外产生费用"));
    fireEvent.click(screen.getByRole("button", { name: "发起新的调用" }));
    await waitFor(() => expect(client.request).toHaveBeenCalledTimes(3));
    expect(client.request.mock.calls[2]?.[2]).not.toBe(firstKey);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain("token-1234567890ab");
  });

  it("replays a lost answer with the persisted key and body after a refresh (review P1)", async () => {
    const client = fakeQwen({ outcomes: [] });
    client.request.mockImplementationOnce(() => Promise.reject(new TypeError("network down")));
    const first = render(createElement(WritingAssistant, { ...storyProps(), workspaceQwen: client }));
    await readyAssistant();
    fireEvent.click(screen.getByRole("button", { name: "准备创作指令" }));
    fireEvent.click(screen.getByRole("button", { name: "向工作区请求候选" }));
    expect(await screen.findByText(/连接中断，结果未知/)).toBeTruthy();
    const lostKey = client.request.mock.calls[0]?.[2];
    const stored = JSON.parse(sessionStorage.getItem("ads-writing-qwen:project-1:story") ?? "null") as { key: string; state: string };
    expect(stored).toMatchObject({ key: lostKey, state: "sending" });
    first.unmount();

    render(createElement(WritingAssistant, { ...storyProps(), workspaceQwen: client }));
    await readyAssistant();
    expect(screen.getByText(/上次请求没有收到回执/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "用原请求标识重新读取" }));
    expect(await screen.findByText("候选已放进预览。费用未知。还要人工比较、采纳到草稿，再手动保存。")).toBeTruthy();
    expect(client.request.mock.calls[1]?.[2]).toBe(lostKey);
    expect(client.request.mock.calls[1]?.[1]).toEqual(client.request.mock.calls[0]?.[1]);
  });

  it("does not send when the request identity cannot be saved first", async () => {
    const client = fakeQwen({ outcomes: [completed()] });
    render(createElement(WritingAssistant, { ...storyProps(), workspaceQwen: client }));
    await readyAssistant();
    fireEvent.click(screen.getByRole("button", { name: "准备创作指令" }));
    const original = window.sessionStorage.setItem.bind(window.sessionStorage);
    const setItem = vi.spyOn(window.sessionStorage, "setItem").mockImplementation((name: string, value: string) => {
      if (name.startsWith("ads-writing-qwen:")) throw new Error("quota");
      original(name, value);
    });
    fireEvent.click(screen.getByRole("button", { name: "向工作区请求候选" }));
    expect(await screen.findByText("无法在本页保存请求标识，没有发送请求。")).toBeTruthy();
    expect(client.request).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it("warns before sending and never creates a request identity for an input over 256,000 UTF-8 bytes", async () => {
    // Every field within its character limit (20,000 per body, 1,000 per note), 45,000 characters in all, but
    // \u0001 serializes to six bytes: about 270,000 UTF-8 bytes. String length would have let it through.
    const control = (count: number) => "\u0001".repeat(count);
    const client = fakeQwen({ outcomes: [completed()] });
    render(createElement(WritingAssistant, {
      ...storyProps(), mode: "episode", entityKey: "script:episode-1", episodeNo: 1, premise: control(1_000),
      confirmedMaterials: control(20_000), capture: () => ({ ...storyTarget(), entityKey: "script:episode-1", mode: "episode" as const, episodeNo: 1,
        currentText: control(20_000) }),
      workspaceQwen: client,
    }));
    await readyAssistant();
    for (const label of ["题材", "目标观众", "人物设定", "修改要求"]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value: control(1_000) } });
    }
    fireEvent.click(screen.getByRole("checkbox", { name: "确认使用当前已加载的故事与分集材料" }));
    fireEvent.click(screen.getByRole("button", { name: "准备创作指令" }));
    const alert = await screen.findByText(/字节（按 UTF-8 计），超过 256,000 字节上限/);
    expect(alert.textContent).toMatch(/输入为 27\d,\d{3} 字节/);
    const button = screen.getByRole("button", { name: "向工作区请求候选" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(client.request).not.toHaveBeenCalled();
    expect(Object.keys(sessionStorage).some((name) => name.startsWith("ads-writing-qwen:"))).toBe(false);
  });

  it("shows the server's byte-cap refusal without changing the request record", async () => {
    const client = fakeQwen({ outcomes: [Promise.resolve({ ok: false, httpStatus: 413, code: "QWEN_WEB_INPUT_TOO_LARGE" } as Outcome)] });
    render(createElement(WritingAssistant, { ...storyProps(), workspaceQwen: client }));
    await readyAssistant();
    fireEvent.click(screen.getByRole("button", { name: "准备创作指令" }));
    fireEvent.click(screen.getByRole("button", { name: "向工作区请求候选" }));
    expect(await screen.findByText("输入超过 256,000 字节上限，服务端没有预约或发送")).toBeTruthy();
    expect(client.request).toHaveBeenCalledTimes(1);
  });
});

type Outcome = Awaited<ReturnType<QwenWebClient["request"]>>;

function result(state: "completed" | "unknown" | "submitted" | "rejected", candidateJson: string | null = null): Promise<Outcome> {
  return Promise.resolve({
    ok: true, httpStatus: state === "unknown" ? 502 : 200, requestCount: 1,
    request: { requestId: "request-1", projectId: "project-1", mode: "story", episodeNo: null, state,
      errorCode: state === "unknown" ? "timeout" : null, providerResult: state === "unknown" ? "unknown" : "completed",
      candidateJson, candidateExpiresAt: null, candidateExpired: false, billingStatus: "unknown" },
  } as Outcome);
}

function completed(): Promise<Outcome> {
  return result("completed", JSON.stringify(STORY_PLAN));
}

function fakeQwen(options: { statusCode?: string; outcomes?: Array<Promise<Outcome>>; lookups?: Array<Promise<Outcome>> }) {
  const outcomes = [...(options.outcomes ?? [])];
  const lookups = [...(options.lookups ?? [])];
  const code = options.statusCode ?? "QWEN_WEB_READY";
  return {
    status: vi.fn(async (_token: string) => ({ code, ready: code === "QWEN_WEB_READY", model: "qwen-test", retentionDays: 7 })),
    request: vi.fn((_projectId: string, _input: unknown, _key: string, _token: string) => outcomes.shift() ?? completed()),
    get: vi.fn((_projectId: string, _requestId: string, _token: string) => lookups.shift() ?? completed()),
  };
}

async function readyAssistant() {
  fireEvent.click(screen.getByRole("button", { name: "编剧助手" }));
  fireEvent.change(screen.getByLabelText("操作者令牌"), { target: { value: "token-1234567890ab" } });
  fireEvent.click(screen.getByRole("button", { name: "检查工作区调用" }));
  expect(await screen.findByText("工作区调用可用，模型 qwen-test")).toBeTruthy();
}

function storyProps(extra?: Partial<{ onAdopt: (text: string) => boolean; readFile: (file: File) => Promise<ArrayBuffer> }>) {
  return {
    mode: "story" as const,
    projectId: "project-1",
    entityKey: "story",
    episodeNo: null,
    premise: "夜班",
    confirmedMaterials: "",
    loaded: true,
    capture: () => storyTarget(),
    onAdopt: extra?.onAdopt ?? (() => true),
    readFile: extra?.readFile,
  };
}
