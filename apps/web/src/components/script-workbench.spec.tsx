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
import { readImportedScript, storeImportedScript, WORKBENCH_DRAFT_PREFIX } from "../lib/script-workbench-drafts";
import { logout } from "../lib/site-session";
import { emptyScript, estimateScript, workbenchPlan } from "../lib/script-workbench-model";
import type { ShortSequelView } from "../lib/short-sequel-client";

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
          workbench: {
            schema: "script-workbench.v1", script: body.script,
            ...(body.continuation ? { continuation: body.continuation, sourceStoryRevisionId: body.sourceStoryRevisionId } : {}),
          },
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
      } else if (path.endsWith("/script-workbench/plan")) {
        const saved = revision(crypto.randomUUID(), { workbench: { schema: "script-workbench.v1", plan: body.plan,
          ...(body.continuationEpisodeNo ? { continuationEpisodeNo: body.continuationEpisodeNo } : {}) } });
        saved.revisionNo = (state.story?.revisionNo ?? 0) + 1;
        state.story = saved;
        state.storyHistory.unshift(saved);
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
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("same-project sequel", () => {
  function sequelSetup() {
    const state = fixture();
    state.episodes[0]!.script!.reviewStatus = "DRAFT";
    state.episodes[0]!.approvedScriptRevisionId = null;
    Object.assign(state.episodes[1]!, { isContinuation: true, script: null, history: [], currentScriptRevisionId: null });
    const context: ShortSequelView = {
      episodeNo: 2, episodeId: E2, episodeCount: 2, targetEpisodeSeconds: 60,
      previousEpisodeNo: 1, previousLocked: false, previousRevisionId: S1, lockedPreviousRevisionId: null,
      previousFreshnessStatus: "CURRENT", previousHandoff: "手中木牌",
      previousScript: { text: "第 1 集结局不动" }, originalRunId: null, originalEpisodeHash: null, placedOriginal: null, lockedOriginal: null,
      storyRevisionId: STORY, currentStoryRevisionId: STORY, currentStoryRevisionNo: 1, storyConfirmed: false,
      confirmedStoryRevisionId: null, lastConfirmedStoryRevisionId: null, lastConfirmedStoryRevisionNo: null,
      lastConfirmedEpisodeCount: null, planConfirmation: 0, original: null,
    };
    const transport = api(state, async (path) => {
      if (path.endsWith("/short-sequels/2")) return json(context);
      if (path.endsWith("/short-sequels/2/ai")) return json({ enabled: false, hasBody: !!state.episodes[1]!.script, task: null, previousTasks: [] });
      if (path.endsWith("/short-sequels")) return json({ episodeCount: 2, nextEpisodeNo: null, continuations: [] });
      return undefined;
    });
    return { state, context, transport };
  }

  it("allows drafting while the old episode is unlocked and saves after the plan and predecessor are confirmed", async () => {
    const { context, state, transport } = sequelSetup();
    const editor = render(<ScriptWorkbench projectId={PROJECT} initialEpisodeNo={2} />);
    expect(await screen.findByText("第 1 集结局不动")).toBeTruthy();
    const draft = screen.getByRole("textbox", { name: "本集改变" });
    fireEvent.change(draft, { target: { value: "新发现" } });
    expect((screen.getByRole("button", { name: "保存本集正文" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "提交审稿" }) as HTMLButtonElement).disabled).toBe(true);
    expect(transport.writes).toHaveLength(0);

    context.storyConfirmed = true;
    context.confirmedStoryRevisionId = STORY;
    context.lastConfirmedStoryRevisionId = STORY;
    editor.unmount();
    render(<ScriptWorkbench projectId={PROJECT} initialEpisodeNo={2} />);
    const save = await screen.findByRole("button", { name: "保存本集正文" });
    expect((screen.getByRole("textbox", { name: "本集改变" }) as HTMLTextAreaElement).value).toBe("新发现");
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "提交审稿" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    context.previousLocked = true;
    context.lockedPreviousRevisionId = S1;
    context.planConfirmation = 1;
    context.lastConfirmedEpisodeCount = 2;
    state.episodes[0]!.script!.reviewStatus = "APPROVED";
    state.episodes[0]!.approvedScriptRevisionId = S1;
    render(<ScriptWorkbench projectId={PROJECT} initialEpisodeNo={2} />);
    fireEvent.click(await screen.findByRole("button", { name: "保存本集正文" }));
    await waitFor(() => expect(transport.writes).toHaveLength(1));
    expect(transport.writes[0]).toMatchObject({
      path: `/api/v1/projects/${PROJECT}/episodes/${E2}/script-workbench`,
      body: { sourceStoryRevisionId: STORY, continuation: { previousRevisionId: S1, originalRunId: null, originalEpisodeHash: null, episodeCount: 2 } },
    });
    expect(state.episodes[0]!.script!.content.text).toBe("第一集原文");
  });

  it("keeps a two-episode draft viewable through expansion and expires it only when the three-episode outline is confirmed", async () => {
    const { context, state, transport } = sequelSetup();
    state.story!.reviewStatus = "DRAFT";
    const editor = render(<ScriptWorkbench projectId={PROJECT} initialEpisodeNo={2} />);
    fireEvent.change(await screen.findByRole("textbox", { name: "本集改变" }), { target: { value: "两集大纲的手稿" } });
    editor.unmount();
    state.project.episodeCount = 3;
    context.episodeCount = 3;
    context.storyRevisionId = null;
    const expanded = render(<ScriptWorkbench projectId={PROJECT} initialEpisodeNo={2} />);
    expect((await screen.findByRole("textbox", { name: "本集改变" }) as HTMLTextAreaElement).value).toBe("两集大纲的手稿");
    expect(screen.queryByText("本集草稿的来源版本已过期。")).toBeNull();
    expanded.unmount();

    context.storyRevisionId = "77777777-7777-4777-8777-777777777776";
    context.currentStoryRevisionId = context.storyRevisionId;
    context.lastConfirmedStoryRevisionId = context.storyRevisionId;
    context.lastConfirmedEpisodeCount = 3;
    context.storyConfirmed = true;
    context.planConfirmation = 1;
    render(<ScriptWorkbench projectId={PROJECT} initialEpisodeNo={2} />);
    expect(await screen.findByText("本集草稿的来源版本已过期。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "已核对新版设定与大纲" })).toBeNull();
    expect(transport.writes).toHaveLength(0);
  });

  it("cannot attach an outline-less two-episode draft to a confirmed three-episode outline", async () => {
    const { context, state } = sequelSetup();
    context.storyRevisionId = null;
    context.currentStoryRevisionId = null;
    const editor = render(<ScriptWorkbench projectId={PROJECT} initialEpisodeNo={2} />);
    fireEvent.change(await screen.findByRole("textbox", { name: "本集改变" }), { target: { value: "草稿只冻结两集" } });
    editor.unmount();
    state.project.episodeCount = 3;
    Object.assign(context, { episodeCount: 3, planConfirmation: 1, storyRevisionId: STORY, currentStoryRevisionId: STORY,
      storyConfirmed: true, lastConfirmedStoryRevisionId: STORY, lastConfirmedEpisodeCount: 3 });
    render(<ScriptWorkbench projectId={PROJECT} initialEpisodeNo={2} />);
    expect(await screen.findByText("本集草稿的来源版本已过期。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "已核对新版设定与大纲" })).toBeNull();
  });

  it("does not treat a same-count replacement as the first confirmation when that count was already approved", async () => {
    const { context } = sequelSetup();
    Object.assign(context, { storyRevisionId: null, lastConfirmedStoryRevisionId: STORY, lastConfirmedEpisodeCount: 2, planConfirmation: 1 });
    const editor = render(<ScriptWorkbench projectId={PROJECT} initialEpisodeNo={2} />);
    fireEvent.change(await screen.findByRole("textbox", { name: "本集改变" }), { target: { value: "写于设定修订期间" } });
    editor.unmount();
    const replacement = "77777777-7777-4777-8777-777777777778";
    Object.assign(context, { storyRevisionId: replacement, currentStoryRevisionId: replacement,
      lastConfirmedStoryRevisionId: replacement, storyConfirmed: true, planConfirmation: 2 });
    render(<ScriptWorkbench projectId={PROJECT} initialEpisodeNo={2} />);
    expect(await screen.findByText("本集草稿的来源版本已过期。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "已核对新版设定与大纲" })).toBeNull();
  });

  it.each([2, 3, 4])("preserves the adopted AI attempt only through the correct confirmation boundary (plan %s)", async (planCase) => {
    const { context, state, transport } = sequelSetup();
    const attemptId = "77777777-7777-4777-8777-777777777779";
    context.storyRevisionId = null;
    context.currentStoryRevisionId = null;
    const existingFetch = transport.fetch.getMockImplementation()!;
    transport.fetch.mockImplementation(async (path, init) => path.endsWith("/short-sequels/2/ai") ? json({
      enabled: true, operatorTokenRequired: false, hasBody: false, previousTasks: [], nextCursor: null,
      task: {
        taskId: "synthetic-task", attemptId, episodeNo: 2, episodeCount: 2, state: "completed", stale: false,
        providerKey: "anthropic", model: "fixture-model", billing: "unknown", usage: { status: "unknown" },
        source: { storyRevisionId: null, previousRevisionId: S1, originalRunId: null,
          originalEpisodeHash: null, planConfirmation: 0, lockedPreviousRevisionId: null, confirmedEpisodeCountAtCapture: null },
        script: script("候选正文"),
      },
    }) : existingFetch(path, init));
    const editor = render(<ScriptWorkbench projectId={PROJECT} initialEpisodeNo={2} />);
    const panel = (await screen.findByText("AI 续写")).parentElement as HTMLDetailsElement;
    panel.open = true;
    fireEvent(panel, new Event("toggle"));
    fireEvent.click(await screen.findByRole("button", { name: "载入编辑器" }));
    await waitFor(() => expect(screen.getByText("有未保存的修改")).toBeTruthy());
    editor.unmount();

    const expandedCount = planCase === 3 ? 3 : 2;
    state.project.episodeCount = expandedCount;
    Object.assign(context, { storyRevisionId: STORY, currentStoryRevisionId: STORY, lastConfirmedStoryRevisionId: STORY,
      episodeCount: expandedCount, lastConfirmedEpisodeCount: expandedCount, storyConfirmed: true, previousLocked: true,
      lockedPreviousRevisionId: S1, planConfirmation: planCase === 4 ? 2 : 1 });
    state.episodes[0]!.script!.reviewStatus = "APPROVED";
    state.episodes[0]!.approvedScriptRevisionId = S1;
    render(<ScriptWorkbench projectId={PROJECT} initialEpisodeNo={2} />);
    if (planCase !== 2) {
      expect(await screen.findByText("本集草稿的来源版本已过期。")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "已核对新版设定与大纲" })).toBeNull();
      expect((screen.getByRole("button", { name: "保存本集正文" }) as HTMLButtonElement).disabled).toBe(true);
      expect(transport.writes).toHaveLength(0);
      return;
    }
    fireEvent.click(await screen.findByRole("button", { name: "已核对新版设定与大纲" }));
    fireEvent.click(screen.getByRole("button", { name: "保存本集正文" }));
    await waitFor(() => expect(transport.writes).toHaveLength(1));
    expect(transport.writes[0]!.body).toMatchObject({ sourceStoryRevisionId: STORY,
      continuation: { previousRevisionId: S1, episodeCount: 2, planConfirmation: 0, aiAttemptId: attemptId } });
  });

  it("locks inherited settings and earlier outlines during sequel planning and after reopening that outline", async () => {
    const { transport } = sequelSetup();
    const editor = render(<ScriptWorkbench projectId={PROJECT} initialEpisodeNo={2} />);
    fireEvent.click(await screen.findByRole("button", { name: "编写新版大纲" }));
    const ending = screen.getByRole("textbox", { name: "故事结局" }) as HTMLTextAreaElement;
    const first = screen.getByRole("textbox", { name: "第 1 集标题" }) as HTMLInputElement;
    const second = screen.getByRole("textbox", { name: "第 2 集标题" }) as HTMLInputElement;
    expect(ending.readOnly).toBe(true);
    expect(first.readOnly).toBe(true);
    expect(second.readOnly).toBe(false);
    expect(screen.queryByRole("button", { name: "＋ 添加角色" })).toBeNull();
    fireEvent.change(second, { target: { value: "信鸽到访" } });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(transport.writes).toHaveLength(1));
    expect(transport.writes[0]!.body).toMatchObject({ continuationEpisodeNo: 2, plan: {
      bible: { ending: "揭开真相" }, outline: { episodes: [{ episodeNo: 1, title: "活人认碑" }, { episodeNo: 2, title: "信鸽到访" }] },
    } });
    await screen.findByText("设定草稿已保存，原有版本保留在版本记录中。");
    editor.unmount();
    render(<ScriptWorkbench projectId={PROJECT} initialEpisodeNo={2} />);
    expect((await screen.findByRole("textbox", { name: "故事结局" }) as HTMLTextAreaElement).readOnly).toBe(true);
  });

  it("shows the frozen predecessor instead of a newly saved unlocked revision", async () => {
    const { context, state } = sequelSetup();
    const editor = render(<ScriptWorkbench projectId={PROJECT} initialEpisodeNo={2} />);
    fireEvent.change(await screen.findByRole("textbox", { name: "本集改变" }), { target: { value: "原版本草稿" } });
    editor.unmount();
    const previous = state.episodes[0]!;
    const replacement = revision("77777777-7777-4777-8777-777777777776", { text: "新的前集正文" });
    replacement.revisionNo = 2;
    previous.history.unshift(replacement);
    previous.script = replacement;
    previous.currentScriptRevisionId = replacement.id;
    context.previousRevisionId = replacement.id;
    context.previousScript = replacement.content;
    render(<ScriptWorkbench projectId={PROJECT} initialEpisodeNo={2} />);
    expect(await screen.findByText("第一集原文")).toBeTruthy();
    expect(screen.queryByText("新的前集正文")).toBeNull();
    expect(screen.queryByText("本集草稿的来源版本已过期。")).toBeNull();
    expect((screen.getByRole("button", { name: "保存本集正文" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the first continuation action for a saved original opened from the work list", async () => {
    const state = fixture();
    state.project.episodeCount = 1;
    state.episodes = state.episodes.slice(0, 1);
    api(state, async (path) => path.endsWith("/short-sequels")
      ? json({ episodeCount: 1, nextEpisodeNo: 2, continuations: [] }) : undefined);
    render(<ScriptWorkbench projectId={PROJECT} initialEpisodes />);
    expect(await screen.findByRole("button", { name: "续写下一集" })).toBeTruthy();
  });

  it("shows a restored draft as read-only when the predecessor gets a new locked version", async () => {
    const { context, state, transport } = sequelSetup();
    context.storyConfirmed = true;
    context.confirmedStoryRevisionId = STORY;
    context.lastConfirmedStoryRevisionId = STORY;
    const editor = render(<ScriptWorkbench projectId={PROJECT} initialEpisodeNo={2} />);
    fireEvent.change(await screen.findByRole("textbox", { name: "本集改变" }), { target: { value: "旧前情" } });
    editor.unmount();

    const replacement = "77777777-7777-4777-8777-777777777777";
    context.previousRevisionId = replacement;
    context.lockedPreviousRevisionId = replacement;
    context.previousLocked = true;
    state.episodes[0]!.script!.id = replacement;
    state.episodes[0]!.script!.reviewStatus = "APPROVED";
    render(<ScriptWorkbench projectId={PROJECT} initialEpisodeNo={2} />);
    expect(await screen.findByText("本集草稿的来源版本已过期。")).toBeTruthy();
    expect((screen.getByRole("button", { name: "保存本集正文" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "提交审稿" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "按当前版本重写" }));
    expect(await screen.findByText("查看过期草稿 1")).toBeTruthy();
    expect(transport.writes).toHaveLength(0);
  });

  it("submits the earlier plain script for review without rewriting its body", async () => {
    const { state, transport } = sequelSetup();
    state.episodes[0]!.script!.content = { text: "第一集锁定原文" };
    render(<ScriptWorkbench projectId={PROJECT} initialEpisodes />);
    fireEvent.click(await screen.findByRole("button", { name: "提交原文审稿" }));
    await waitFor(() => expect(transport.writes).toHaveLength(1));
    expect(transport.writes[0]).toMatchObject({
      path: `/api/v1/projects/${PROJECT}/episodes/${E1}/scripts/${S1}/review`,
      body: { to: "IN_REVIEW", expectedReviewVersion: 1 },
    });
    expect(state.episodes[0]!.script!.content).toEqual({ text: "第一集锁定原文" });
  });
});

describe("five-stage script workbench", () => {
  it("opens the first saved episode from the works list even when the story awaits review", async () => {
    const state = fixture();
    state.story = { ...state.story!, reviewStatus: "DRAFT" };
    Object.assign(state.episodes[0]!, { script: null, history: [], currentScriptRevisionId: null, approvedScriptRevisionId: null });
    const transport = api(state);
    render(<ScriptWorkbench projectId={PROJECT} initialEpisodes />);
    expect(await screen.findByRole("heading", { name: "第2集 差役登门" })).toBeTruthy();
    expect(transport.writes).toHaveLength(0);
  });

  it("opens imported first-episode text as an editable draft and keeps the story approval gate", async () => {
    const initial = fixture();
    initial.story = null;
    Object.assign(initial.episodes[0]!, { script: null, history: [], currentScriptRevisionId: null, approvedScriptRevisionId: null });
    const text = "石铺 · 清晨\n木牌落在石碑上。";
    storeImportedScript(window.sessionStorage, PROJECT, text);
    const transport = api(initial);
    render(<ScriptWorkbench projectId={PROJECT} />);
    const editor = await screen.findByLabelText("第 1 段动作") as HTMLTextAreaElement;
    expect(editor.value).toBe(text);
    expect(screen.getByText(/设定与大纲尚未锁定/)).toBeTruthy();
    expect(transport.writes).toHaveLength(0);
    expect(readImportedScript(window.sessionStorage, PROJECT)).toBeNull();
    expect(window.sessionStorage.getItem(WORKBENCH_DRAFT_PREFIX + PROJECT)).toContain("木牌落在石碑上");
  });
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

function updateRemoteEpisode(state: ScriptWorkbenchSnapshot, title: string, version: number) {
  const episode = state.episodes[1]!;
  const changed = structuredClone(episode.script!);
  changed.id = crypto.randomUUID();
  changed.revisionNo += 1;
  changed.content.text = title;
  (changed.content.workbench as { script: ScriptWorkbenchScript }).script.title = title;
  episode.script = changed;
  episode.currentScriptRevisionId = changed.id;
  episode.history.unshift(changed);
  episode.rowVersion = version;
}
function updateRemotePlan(state: ScriptWorkbenchSnapshot, genre: string, version: number) {
  state.story = structuredClone(state.story!);
  state.story.id = crypto.randomUUID();
  (state.story.content.workbench as { plan: ScriptWorkbenchPlan }).plan.brief.genre = genre;
  state.story.content.text = `服务器设定：${genre}`;
  state.project.version = version;
  state.storyHistory.unshift(state.story);
}

describe("workbench editing baselines and session recovery", () => {
  it("refreshes clean episodes and plan when a different episode is saved", async () => {
    const state = fixture();
    const { writes } = api(state);
    render(<ScriptWorkbench projectId={PROJECT} />);
    await screen.findByLabelText("本集标题");
    updateRemoteEpisode(state, "另一个标签页的新正文", 8);
    updateRemotePlan(state, "服务器新题材", 9);
    fireEvent.click(screen.getByRole("button", { name: /第1集 活人认碑/ }));
    fireEvent.change(screen.getByLabelText("本集标题"), { target: { value: "本标签页第一集" } });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await screen.findByText("第 1 集草稿已保存。");
    fireEvent.click(screen.getByRole("button", { name: /第2集 另一个标签页的新正文/ }));
    expect((screen.getByLabelText("本集标题") as HTMLInputElement).value).toBe(
      "另一个标签页的新正文",
    );
    fireEvent.click(screen.getByRole("tab", { name: /立项/ }));
    expect((screen.getByLabelText("题材") as HTMLInputElement).value).toBe("服务器新题材");
    fireEvent.click(screen.getByRole("tab", { name: /逐集编写/ }));
    fireEvent.change(screen.getByLabelText("本集标题"), { target: { value: "在新正文上继续" } });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(writes.length).toBe(2));
    expect(writes[1]!.headers["If-Match"]).toBe("8");
    expect(writes[1]!.body.sourceStoryRevisionId).toBe(state.story!.id);
  });

  it("keeps dirty scripts and plan on their original CAS/source after aggregate refresh until explicit reconciliation", async () => {
    const state = fixture();
    const attempts: Array<{
      path: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
    }> = [];
    let rejectDirty = false;
    api(state, async (path, init) => {
      if (rejectDirty && init?.method === "POST" && (path.includes(E2) || path.endsWith("/plan"))) {
        attempts.push({
          path,
          headers: init.headers as Record<string, string>,
          body: JSON.parse(String(init.body)),
        });
        return json({ error: { code: "REVISION_CONFLICT", message: "编辑基线已变更" } }, 409);
      }
      return undefined;
    });
    render(<ScriptWorkbench projectId={PROJECT} />);
    fireEvent.change(await screen.findByLabelText("本集标题"), {
      target: { value: "本地第二集修改" },
    });
    fireEvent.click(screen.getByRole("tab", { name: /立项/ }));
    fireEvent.change(screen.getByLabelText("题材"), { target: { value: "本地题材修改" } });
    updateRemoteEpisode(state, "服务器第二集修改", 10);
    updateRemotePlan(state, "服务器题材修改", 20);
    fireEvent.click(screen.getByRole("tab", { name: /逐集编写/ }));
    fireEvent.click(screen.getByRole("button", { name: /第1集 活人认碑/ }));
    fireEvent.change(screen.getByLabelText("本集标题"), { target: { value: "触发跨集刷新" } });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await screen.findByText("第 1 集草稿已保存。");
    rejectDirty = true;
    fireEvent.click(screen.getByRole("button", { name: /第2集 本地第二集修改/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await screen.findByText("编辑基线已变更");
    expect(attempts[0]!.headers["If-Match"]).toBe("2");
    expect(attempts[0]!.body.sourceStoryRevisionId).toBe(STORY);
    fireEvent.click(screen.getByRole("button", { name: "读取最新版本，保留编辑内容" }));
    await screen.findByText(
      "已刷新干净稿件；未保存内容及其原编辑版本保留。发生冲突时，请先对照服务器版本。",
    );
    expect((screen.getByLabelText("本集标题") as HTMLInputElement).value).toBe("本地第二集修改");
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(attempts.length).toBe(2));
    expect(attempts[1]!.headers["If-Match"]).toBe("2");
    fireEvent.click(screen.getByRole("tab", { name: /立项/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(attempts.length).toBe(3));
    expect(attempts[2]!.headers["If-Match"]).toBe("3");
    expect((attempts[2]!.body.plan as ScriptWorkbenchPlan).brief.genre).toBe("本地题材修改");
    fireEvent.click(screen.getByRole("tab", { name: /逐集编写/ }));
    fireEvent.click(screen.getByRole("button", { name: "对照并处理版本冲突" }));
    const dialog = screen.getByRole("dialog", { name: "处理编辑版本冲突" });
    expect(within(dialog).getByText("服务器第二集修改")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "保留我的内容，采用此基线" }));
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(attempts.length).toBe(4));
    expect(attempts[3]!.headers["If-Match"]).toBe("10");
    expect(attempts[3]!.body.sourceStoryRevisionId).toBe(state.story!.id);
  });

  it("restores every episode and plan after a 401 login navigation with original CAS and retry identity", async () => {
    const state = fixture();
    const attempts: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    api(state, async (_path, init) => {
      if (init?.method === "POST") {
        attempts.push({
          headers: init.headers as Record<string, string>,
          body: JSON.parse(String(init.body)),
        });
        return attempts.length === 1
          ? json({ error: { code: "AUTH_SESSION_EXPIRED", message: "请重新登录" } }, 401)
          : json({ error: { code: "REVISION_CONFLICT", message: "旧基线受保护" } }, 409);
      }
      return undefined;
    });
    const first = render(<ScriptWorkbench projectId={PROJECT} />);
    fireEvent.change(await screen.findByLabelText("本集标题"), {
      target: { value: "第二集离线修改" },
    });
    fireEvent.click(screen.getByRole("button", { name: /第1集 活人认碑/ }));
    fireEvent.change(screen.getByLabelText("本集标题"), { target: { value: "第一集离线修改" } });
    fireEvent.click(screen.getByRole("tab", { name: /立项/ }));
    fireEvent.change(screen.getByLabelText("题材"), { target: { value: "未保存的题材" } });
    fireEvent.click(screen.getByRole("tab", { name: /逐集编写/ }));
    fireEvent.click(screen.getByRole("button", { name: /第2集 第二集离线修改/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    first.unmount();
    updateRemoteEpisode(state, "登录期间的服务器正文", 25);
    updateRemotePlan(state, "登录期间的新设定", 30);
    render(<ScriptWorkbench projectId={PROJECT} />);
    expect(((await screen.findByLabelText("本集标题")) as HTMLInputElement).value).toBe(
      "第二集离线修改",
    );
    fireEvent.click(screen.getByRole("button", { name: /第1集 第一集离线修改/ }));
    expect((screen.getByLabelText("本集标题") as HTMLInputElement).value).toBe("第一集离线修改");
    fireEvent.click(screen.getByRole("tab", { name: /立项/ }));
    expect((screen.getByLabelText("题材") as HTMLInputElement).value).toBe("未保存的题材");
    fireEvent.click(screen.getByRole("tab", { name: /逐集编写/ }));
    fireEvent.click(screen.getByRole("button", { name: /第2集 第二集离线修改/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(attempts.length).toBe(2));
    expect(attempts[1]!.headers["Idempotency-Key"]).toBe(attempts[0]!.headers["Idempotency-Key"]);
    expect(attempts[1]!.headers["If-Match"]).toBe("2");
    expect(attempts[1]!.body.sourceStoryRevisionId).toBe(STORY);
    await screen.findByText("旧基线受保护");
  });

  it("isolates project drafts and retains incomplete form edits when reopening the same project", async () => {
    api(fixture());
    const first = render(<ScriptWorkbench projectId={PROJECT} />);
    await screen.findByLabelText("本集标题");
    fireEvent.click(screen.getByRole("tab", { name: /设定与大纲/ }));
    fireEvent.click(screen.getByRole("button", { name: "＋ 添加角色" }));
    fireEvent.change(screen.getByLabelText("角色 2 定妆"), {
      target: { value: "未填姓名但必须恢复的服装设定" },
    });
    first.unmount();
    const otherId = "88888888-8888-4888-8888-888888888888";
    const other = fixture();
    other.project.id = otherId;
    api(other);
    const second = render(<ScriptWorkbench projectId={otherId} />);
    await screen.findByLabelText("本集标题");
    fireEvent.click(screen.getByRole("tab", { name: /设定与大纲/ }));
    expect(screen.queryByLabelText("角色 2 定妆")).toBeNull();
    second.unmount();
    api(fixture());
    render(<ScriptWorkbench projectId={PROJECT} />);
    await screen.findByLabelText("本集标题");
    fireEvent.click(screen.getByRole("tab", { name: /设定与大纲/ }));
    expect((screen.getByLabelText("角色 2 定妆") as HTMLTextAreaElement).value).toBe(
      "未填姓名但必须恢复的服装设定",
    );
  });

  it("shows a recovery warning rather than losing current edits when browser storage is full", async () => {
    api(fixture());
    render(<ScriptWorkbench projectId={PROJECT} />);
    const field = await screen.findByLabelText("本集标题");
    const storage = window.sessionStorage;
    vi.spyOn(window, "sessionStorage", "get").mockReturnValue({
      getItem: storage.getItem.bind(storage),
      removeItem: storage.removeItem.bind(storage),
      clear: storage.clear.bind(storage),
      key: storage.key.bind(storage),
      length: storage.length,
      setItem: () => {
        throw new Error("quota");
      },
    });
    fireEvent.change(field, { target: { value: "当前编辑必须保留" } });
    expect((screen.getByLabelText("本集标题") as HTMLInputElement).value).toBe("当前编辑必须保留");
    expect(screen.getByText(/浏览器未能保存恢复草稿/)).toBeTruthy();
  });
  it("keeps an unreadable recovery record intact while showing server content", async () => {
    const key = WORKBENCH_DRAFT_PREFIX + PROJECT;
    window.sessionStorage.setItem(key, "unreadable but retained");
    api(fixture());
    render(<ScriptWorkbench projectId={PROJECT} />);
    await screen.findByLabelText("本集标题");
    fireEvent.change(screen.getByLabelText("本集标题"), { target: { value: "可以继续编辑" } });
    expect(window.sessionStorage.getItem(key)).toBe("unreadable but retained");
    expect(screen.getByText(/本地恢复草稿无法读取，原记录已保留/)).toBeTruthy();
  });

  it("clears recovery data on confirmed logout and cannot repopulate it from a late read or pagehide", async () => {
    const state = fixture();
    let release: (() => void) | undefined;
    let delayRead = false;
    api(state, async (_path, init) => {
      if (delayRead && (!init?.method || init.method === "GET")) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return json(state);
      }
      return undefined;
    });
    render(<ScriptWorkbench projectId={PROJECT} />);
    fireEvent.change(await screen.findByLabelText("本集标题"), {
      target: { value: "退出时丢弃的未保存稿" },
    });
    const key = WORKBENCH_DRAFT_PREFIX + PROJECT;
    expect(window.sessionStorage.getItem(key)).not.toBeNull();
    delayRead = true;
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(release).toBeDefined());
    await act(async () => {
      await logout(async () => new Response(null, { status: 204 }));
    });
    expect(window.sessionStorage.getItem(key)).toBeNull();
    await act(async () => {
      release!();
    });
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(window.sessionStorage.getItem(key)).toBeNull();
    expect(screen.queryByLabelText("本集标题")).toBeNull();
  });
});

function manyRevisions() {
  const state = fixture();
  const source = state.episodes[1]!.script!;
  const revisionAt = (revisionNo: number) => ({
    ...structuredClone(source),
    id: `99999999-9999-4999-8999-${String(revisionNo).padStart(12, "0")}`,
    revisionNo,
    freshnessStatus: "STALE",
    content: {
      text: `历史正文 ${revisionNo}`,
      workbench: {
        schema: "script-workbench.v1",
        script: { ...emptyScript(`历史标题 ${revisionNo}`), review: undefined },
      },
    },
  });
  state.episodes[1]!.history = Array.from({ length: 100 }, (_, index) => revisionAt(102 - index));
  return { state, revisionAt };
}

describe("bounded workbench revision history", () => {
  it("opens the restored episode history and loads an old revision beyond the first 100 as a new dirty draft", async () => {
    const { state, revisionAt } = manyRevisions();
    const calls: string[] = [];
    api(state, async (path) => {
      if (path.includes("/scripts?")) {
        calls.push(path);
        return json({ items: [revisionAt(2), revisionAt(1)], nextCursor: null });
      }
      return undefined;
    });
    render(<ScriptWorkbench projectId={PROJECT} initialHistory={E2} />);
    const dialog = await screen.findByRole("dialog", { name: "版本记录" });
    expect(within(dialog).queryByText("历史正文 1")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "加载更早版本" }));
    const old = await within(dialog).findByText("历史正文 1");
    expect(calls).toEqual([`/api/v1/projects/${PROJECT}/episodes/${E2}/scripts?cursor=3`]);
    expect(within(dialog).queryByRole("button", { name: "加载更早版本" })).toBeNull();
    const row = old.closest("article")!;
    fireEvent.click(within(row).getByRole("button", { name: "载入为修订草稿" }));
    expect((screen.getByLabelText("本集标题") as HTMLInputElement).value).toBe("历史标题 1");
    expect(screen.getByText(/已载入第 2 集 v1/)).toBeTruthy();
    expect(state.episodes[1]!.currentScriptRevisionId).toBe(S2);
    expect(state.episodes[1]!.script!.id).toBe(S2);
  });

  it("retains loaded history and dirty editing CAS across page failure/retry", async () => {
    const { state, revisionAt } = manyRevisions();
    let attempts = 0;
    const fixtureApi = api(state, async (path) => {
      if (path.includes("/scripts?")) {
        attempts += 1;
        return attempts === 1
          ? json({ error: { code: "READ_FAILED", message: "稍后重试" } }, 503)
          : json({ items: [revisionAt(1)], nextCursor: null });
      }
      return undefined;
    });
    render(<ScriptWorkbench projectId={PROJECT} />);
    fireEvent.change(await screen.findByLabelText("本集标题"), {
      target: { value: "分页期间的未保存稿" },
    });
    fireEvent.click(screen.getByRole("button", { name: "版本记录" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "加载更早版本" }));
    await within(dialog).findByText(/稍后重试/);
    expect(within(dialog).getByText("历史正文 102")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "加载更早版本" }));
    await within(dialog).findByText("历史正文 1");
    expect(
      within(dialog)
        .getAllByRole("button", { name: "载入为修订草稿" })
        .every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭弹窗" }));
    expect((screen.getByLabelText("本集标题") as HTMLInputElement).value).toBe(
      "分页期间的未保存稿",
    );
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await screen.findByText("第 2 集草稿已保存。");
    expect(fixtureApi.writes[0]!.headers["If-Match"]).toBe("2");
    expect(fixtureApi.writes[0]!.body.sourceStoryRevisionId).toBe(STORY);
  });

  it("ignores a late page after switching targets or reopening, and never leaves loading stuck", async () => {
    const { state, revisionAt } = manyRevisions();
    const replies: Array<(response: Response) => void> = [];
    api(state, async (path) =>
      path.includes("/scripts?")
        ? new Promise<Response>((resolve) => {
            replies.push(resolve);
          })
        : undefined,
    );
    render(<ScriptWorkbench projectId={PROJECT} initialHistory={E2} />);
    let dialog = await screen.findByRole("dialog", { name: "版本记录" });
    fireEvent.click(within(dialog).getByRole("button", { name: "加载更早版本" }));
    fireEvent.change(within(dialog).getByLabelText("稿件"), { target: { value: "story" } });
    fireEvent.change(within(dialog).getByLabelText("稿件"), { target: { value: E2 } });
    expect(
      (within(dialog).getByRole("button", { name: "加载更早版本" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "加载更早版本" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭弹窗" }));
    fireEvent.click(screen.getByRole("button", { name: "版本记录" }));
    dialog = screen.getByRole("dialog", { name: "版本记录" });
    expect(
      (within(dialog).getByRole("button", { name: "加载更早版本" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    await act(async () => {
      for (const reply of replies) reply(json({ items: [revisionAt(1)], nextCursor: null }));
    });
    expect(within(dialog).queryByText("历史正文 1")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "加载更早版本" }));
    await act(async () => replies.at(-1)!(json({ items: [revisionAt(1)], nextCursor: null })));
    expect(within(dialog).getByText("历史正文 1")).toBeTruthy();
  });
});
