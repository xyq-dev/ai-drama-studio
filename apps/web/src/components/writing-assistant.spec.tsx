// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoryPlanCandidate, WritingTargetSnapshot } from "@ai-drama/domain/writing-assistant";
import { Workbench } from "./workbench";
import { WritingAssistant } from "./writing-assistant";

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
    expect(screen.getByText("本轮通过外部 AI 创作，网页不会自动调用模型。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "向工作区请求候选" })).toBeNull();
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

  it("requests one workspace candidate after the instruction is frozen and does not save it", async () => {
    const requestCandidate = vi.fn(async (_input: { idempotencyKey: string }) => ({
      candidateJson: JSON.stringify(STORY_PLAN),
      billingStatus: "unknown" as const,
    }));
    const onAdopt = vi.fn(() => true);
    render(createElement(WritingAssistant, { ...storyProps({ onAdopt }), requestCandidate }));
    fireEvent.click(screen.getByRole("button", { name: "编剧助手" }));
    fireEvent.click(screen.getByRole("button", { name: "向工作区请求候选" }));
    expect(await screen.findByText("请先准备创作指令")).toBeTruthy();
    expect(requestCandidate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "准备创作指令" }));
    fireEvent.click(screen.getByRole("button", { name: "向工作区请求候选" }));
    await waitFor(() => expect(requestCandidate).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("候选已放进预览。费用未知。还要人工比较、采纳到草稿，再手动保存。")).toBeTruthy();
    expect((screen.getByLabelText("候选正文") as HTMLTextAreaElement).value).toContain("手写测试候选");
    expect(onAdopt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "向工作区请求候选" }));
    await waitFor(() => expect(requestCandidate).toHaveBeenCalledTimes(2));
    const first = requestCandidate.mock.calls[0]?.[0]?.idempotencyKey;
    const second = requestCandidate.mock.calls[1]?.[0]?.idempotencyKey;
    expect(second).toBe(first);
  });

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
