// @vitest-environment happy-dom
// Browser interaction tests use a scoped in-memory HTTP fixture; production data and providers are never contacted.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  estimateScriptWorkbench,
  type ScriptWorkbenchPlan,
  type ScriptWorkbenchRevision,
  type ScriptWorkbenchScript,
  type ScriptWorkbenchSnapshot,
} from "@ai-drama/contracts";
import { ScriptWorkbench } from "./script-workbench";
import { emptyScript, estimateScript, workbenchPlan } from "../lib/script-workbench-model";

vi.mock("./creator-shell", () => ({
  CreatorShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
const PROJECT = "11111111-1111-4111-8111-111111111111";
const STORY = "22222222-2222-4222-8222-222222222222";
const E1 = "33333333-3333-4333-8333-333333333333";
const E2 = "44444444-4444-4444-8444-444444444444";
const S1 = "55555555-5555-4555-8555-555555555555";
const S2 = "66666666-6666-4666-8666-666666666666";
const plan: ScriptWorkbenchPlan = {
  brief: {
    genre: "古装悬疑",
    audience: "悬疑爱好者",
    productionConstraints: "室内两名演员",
    logline: "碑铺女子发现旧案暗号",
    targetEpisodeSeconds: 210,
    dialogueQuota: 20,
  },
  bible: {
    ending: "揭开真相",
    openThreads: "谁篡改了碑文",
    characters: [
      {
        id: "R01",
        name: "许照青",
        appearance: "素衣",
        voice: "克制",
        aliases: "照青",
        knownInformation: "父亲失踪",
      },
    ],
  },
  outline: {
    episodes: [1, 2].map((episodeNo) => ({
      episodeNo,
      title: episodeNo === 1 ? "活人认碑" : "差役登门",
      openingHook: "门外敲响",
      change: "发现线索",
      endingHandoff: "手中木牌",
    })),
  },
};
function script(title: string): ScriptWorkbenchScript {
  return {
    ...emptyScript(title),
    previousRevisionId: S1,
    previousHandoff: "手中木牌",
    openingHook: "差役盯住手",
    change: "发现线索",
    endingHandoff: "手中木牌",
    characterKnowledge: "女子知道暗号",
    unresolvedThreads: "是谁来过",
    scenes: [
      {
        id: "scene-1",
        heading: "石铺门口",
        interiorExterior: "INT",
        timeOfDay: "DAY",
        characterIds: ["R01"],
        beats: [
          {
            id: "beat-1",
            kind: "dialogue",
            characterId: "R01",
            text: "你来这里做什么",
            seconds: 2,
          },
          { id: "beat-2", kind: "action", text: "她藏起木牌", seconds: 3 },
        ],
      },
    ],
  };
}
function revision(
  id: string,
  content: Record<string, unknown>,
  status = "DRAFT",
): ScriptWorkbenchRevision {
  return {
    id,
    revisionNo: 1,
    content,
    reviewStatus: status,
    freshnessStatus: "CURRENT",
    reviewVersion: 1,
    createdAt: "2026-11-11T10:00:00Z",
  };
}
function fixture(): ScriptWorkbenchSnapshot {
  const story = revision(
    STORY,
    {
      text: "完整设定",
      workbench: {
        schema: "script-workbench.v1",
        plan,
        documentVersions: { brief: 1, synopsis: 1, bible: 1, outline: 1 },
      },
    },
    "APPROVED",
  );
  const first = revision(
    S1,
    {
      text: "第一集原文",
      workbench: { schema: "script-workbench.v1", script: script("活人认碑") },
    },
    "APPROVED",
  );
  const second = revision(S2, {
    text: "第二集原文",
    workbench: { schema: "script-workbench.v1", script: script("差役登门") },
  });
  return structuredClone({
    project: {
      id: PROJECT,
      title: "无名碑",
      version: 3,
      episodeCount: 2,
      writingMode: "short",
      targetEpisodeSeconds: 60,
    },
    story,
    storyHistory: [story],
    episodes: [
      {
        id: E1,
        episodeNo: 1,
        title: "活人认碑",
        rowVersion: 4,
        currentScriptRevisionId: S1,
        approvedScriptRevisionId: S1,
        script: first,
        history: [first],
      },
      {
        id: E2,
        episodeNo: 2,
        title: "差役登门",
        rowVersion: 2,
        currentScriptRevisionId: S2,
        approvedScriptRevisionId: null,
        script: second,
        history: [second],
      },
    ],
  });
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function api(
  state: ScriptWorkbenchSnapshot,
  override?: (path: string, init?: RequestInit) => Promise<Response | undefined>,
) {
  const writes: Array<{
    path: string;
    body: Record<string, unknown>;
    headers: Record<string, string>;
  }> = [];
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    const overridden = await override?.(path, init);
    if (overridden) return overridden;
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      writes.push({ path, body, headers: init.headers as Record<string, string> });
      const episode = state.episodes.find((item) => path.includes(item.id));
      if (path.endsWith("/script-workbench") && episode) {
        const saved = revision(crypto.randomUUID(), {
          text: "新稿",
          workbench: { schema: "script-workbench.v1", script: body.script },
        });
        saved.revisionNo = (episode.script?.revisionNo ?? 0) + 1;
        episode.script = saved;
        episode.history.unshift(saved);
        episode.currentScriptRevisionId = saved.id;
        episode.rowVersion += 1;
      } else if (path.endsWith("/review") && episode?.script) {
        episode.script.reviewStatus = String(body.to);
        episode.script.reviewVersion += 1;
        episode.rowVersion += 1;
        if (body.to === "APPROVED") episode.approvedScriptRevisionId = episode.script.id;
      } else if (path.endsWith("/review") && state.story) {
        state.story.reviewStatus = String(body.to);
        state.story.reviewVersion += 1;
        state.project.version += 1;
      }
      return json({ ok: true });
    }
    if (path.endsWith("/deletion-preview"))
      return json({
        title: "无名碑",
        episodeNo: 2,
        revisionNo: 1,
        reviewStatus: "DRAFT",
        version: 2,
        dependencies: { scenes: 1, shots: 2, speech: 3, video: 4, other: 0, total: 10 },
        canDelete: false,
        blockedReason: "稿件仍有制作引用，暂不能删除。",
      });
    if (path.endsWith("/script-workbench")) return json(state);
    throw new Error(`Unexpected URL ${path}`);
  });
  vi.stubGlobal("fetch", fetch);
  return { writes, fetch };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("five-stage script workbench", () => {
  it("keeps unsaved episode edits while navigating and counts action, dialogue and pause with the shared estimator", async () => {
    api(fixture());
    render(<ScriptWorkbench projectId={PROJECT} />);
    const field = await screen.findByLabelText("第 1 段对白");
    fireEvent.change(field, { target: { value: "改过的对白仍在这里" } });
    fireEvent.click(screen.getByRole("button", { name: /第1集 活人认碑/ }));
    fireEvent.click(screen.getByRole("button", { name: /第2集 差役登门/ }));
    expect((screen.getByLabelText("第 1 段对白") as HTMLTextAreaElement).value).toBe(
      "改过的对白仍在这里",
    );
    const emptyDialogue = script("test");
    emptyDialogue.scenes[0]!.beats.push(
      { id: "pause", kind: "pause", text: "", seconds: 2.5 },
      { id: "empty", kind: "dialogue", characterId: "R01", text: "", seconds: 0 },
    );
    expect(estimateScript(emptyDialogue)).toEqual(estimateScriptWorkbench(emptyDialogue));
    expect(estimateScript(emptyDialogue).dialogueCount).toBe(2);
  });

  it("records a fresh previous-episode link with the exact locked handoff, and invalidates old human checks on content changes", async () => {
    const state = fixture();
    const second = (
      state.episodes[1]!.script!.content.workbench as { script: ScriptWorkbenchScript }
    ).script;
    second.previousRevisionId = null;
    second.review = {
      identityClear: true,
      goalClear: true,
      obstacleClear: true,
      continuityChecked: true,
      lockedMaterialsChecked: true,
      note: "已审",
    };
    const { writes } = api(state);
    render(<ScriptWorkbench projectId={PROJECT} />);
    fireEvent.click(await screen.findByRole("button", { name: "我已核对前集版本" }));
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(writes.length).toBe(1));
    const saved = writes[0]!.body.script as ScriptWorkbenchScript;
    expect(saved.previousRevisionId).toBe(S1);
    expect(saved.previousHandoff).toBe("手中木牌");
    expect(saved.review?.continuityChecked).toBe(false);
    expect(writes[0]!.headers["If-Match"]).toBe("2");
  });

  it("saves checked manuscript as a new revision, submits it, then requires explicit confirmation of that exact revision", async () => {
    const state = fixture();
    const { writes } = api(state);
    render(<ScriptWorkbench projectId={PROJECT} />);
    await screen.findByLabelText("本集标题");
    fireEvent.click(screen.getByRole("tab", { name: /审稿修订/ }));
    for (const checkbox of screen.getAllByRole("checkbox")) fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: "提交审稿" }));
    await screen.findByText("第 2 集已提交审稿，尚未进入制作。");
    expect(writes.map((item) => item.body.to).filter(Boolean)).toEqual(["IN_REVIEW"]);
    fireEvent.click(screen.getByRole("tab", { name: /定稿交接/ }));
    const buttons = screen.getAllByRole("button", { name: "确认本集定稿" });
    fireEvent.click(buttons[1]!);
    const modal = screen.getByRole("dialog", { name: "确认第 2 集定稿？" });
    expect(writes.some((item) => item.body.to === "APPROVED")).toBe(false);
    fireEvent.click(within(modal).getByRole("button", { name: "确认锁定 v2" }));
    await waitFor(() => expect(writes.at(-1)?.body.to).toBe("APPROVED"));
    expect(writes.at(-1)?.path).toContain(state.episodes[1]!.script!.id);
  });

  it("preserves an uncertain save and reuses the same idempotency key on retry", async () => {
    const state = fixture();
    const keys: string[] = [];
    const { writes } = api(state, async (_path, init) => {
      if (init?.method === "POST") {
        keys.push((init.headers as Record<string, string>)["Idempotency-Key"]!);
        if (keys.length === 1) throw new TypeError("连接中断");
      }
      return undefined;
    });
    render(<ScriptWorkbench projectId={PROJECT} />);
    fireEvent.change(await screen.findByLabelText("本集标题"), {
      target: { value: "仍要保留的修改" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await screen.findByRole("alert");
    expect((screen.getByLabelText("本集标题") as HTMLInputElement).value).toBe("仍要保留的修改");
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(writes.length).toBe(1));
    expect(keys[0]).toBe(keys[1]);
  });

  it("prevents editing during a pending save and keeps all inputs until it settles", async () => {
    let release!: (response: Response) => void;
    api(fixture(), async (_path, init) =>
      init?.method === "POST"
        ? new Promise<Response>((done) => {
            release = done;
          })
        : undefined,
    );
    render(<ScriptWorkbench projectId={PROJECT} />);
    fireEvent.change(await screen.findByLabelText("本集标题"), {
      target: { value: "保存中的修改" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() =>
      expect(screen.getByLabelText("本集标题").closest("fieldset")?.hasAttribute("disabled")).toBe(
        true,
      ),
    );
    await act(async () => release(json({ ok: true })));
  });

  it("shows actual dependencies before deletion and refuses a blocked version", async () => {
    const { writes } = api(fixture());
    render(<ScriptWorkbench projectId={PROJECT} />);
    fireEvent.click(await screen.findByRole("button", { name: "删除第 2 集草稿" }));
    const modal = await screen.findByRole("dialog", { name: "删除第 2 集草稿？" });
    expect(within(modal).getByText("场景 1 · 分镜 2")).toBeTruthy();
    expect(within(modal).getByText("配音 3 · 视频 4")).toBeTruthy();
    expect(within(modal).getByRole("button", { name: "移入回收站" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(writes).toHaveLength(0);
  });

  it("loads a restored historical manuscript as a new editable draft without approving it", async () => {
    const state = fixture();
    const restored = revision("77777777-7777-4777-8777-777777777777", {
      text: "旧版本",
      workbench: { schema: "script-workbench.v1", script: script("从回收站找回的标题") },
    });
    restored.freshnessStatus = "STALE";
    state.episodes[1]!.history.push(restored);
    const { writes } = api(state);
    render(<ScriptWorkbench projectId={PROJECT} />);
    await screen.findByLabelText("本集标题");
    fireEvent.click(screen.getByRole("button", { name: "版本记录" }));
    const load = screen.getAllByRole("button", { name: "载入为修订草稿" });
    fireEvent.click(load[1]!);
    expect((screen.getByLabelText("本集标题") as HTMLInputElement).value).toBe(
      "从回收站找回的标题",
    );
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(writes.length).toBe(1));
    expect((writes[0]!.body.script as ScriptWorkbenchScript).previousRevisionId).toBeNull();
    expect(writes[0]!.body.to).toBeUndefined();
  });

  it("keeps legacy source text visible until the user explicitly converts it", async () => {
    const state = fixture();
    state.story!.content = { text: "必须保留的旧版故事" };
    const { writes } = api(state);
    render(<ScriptWorkbench projectId={PROJECT} />);
    await screen.findByRole("tab", { name: /立项/ });
    fireEvent.click(screen.getByRole("tab", { name: /立项/ }));
    await screen.findByText("必须保留的旧版故事");
    expect(screen.queryByLabelText("制作边界")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "转入结构化草稿" }));
    expect((screen.getByLabelText("制作边界") as HTMLTextAreaElement).value).toContain(
      "必须保留的旧版故事",
    );
    expect(writes).toHaveLength(0);
    expect(
      workbenchPlan({
        ...state.story!,
        content: { workbench: { schema: "script-workbench.v1", plan: null } },
      }),
    ).toBeNull();
  });

  it("keeps series works text-only even when scripts have been approved", async () => {
    const state = fixture();
    state.project.writingMode = "series";
    api(state);
    render(<ScriptWorkbench projectId={PROJECT} />);
    await screen.findByLabelText("本集标题");
    fireEvent.click(screen.getByRole("tab", { name: /定稿交接/ }));
    expect(
      screen.getByText("系列模式当前支持文本写作与定稿，分镜、配音及视频制作暂未开放。"),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "分镜" })).toBeNull();
    expect(screen.queryByRole("link", { name: "配音" })).toBeNull();
  });
});
