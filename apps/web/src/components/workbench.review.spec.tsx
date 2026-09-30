// @vitest-environment happy-dom
// Simulated API tests. fetch is mocked; this file does not start the API, database, worker, or a real browser.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Workbench } from "./workbench";

const PROJECT = "project-1";
const CHAR_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHAR_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SHOT_A = "11111111-1111-4111-8111-111111111111";
const SHOT_B = "22222222-2222-4222-8222-222222222222";

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown>;
  ifMatch: string | null;
  key: string | null;
}

interface Sim {
  calls: Call[];
  workflowReads: number;
  scenesAfterWorkflow: boolean;
  storyConflict: boolean;
  failStoryBaseline: boolean;
  sceneConflict: boolean;
  shotConflict: boolean;
  shotUsesOldSource: boolean;
  characterSourceId: string;
  holdGet: Promise<void> | null;
  holdGetPart: string | null;
  failGetPart: string | null;
  characterPostGate: Promise<void> | null;
  scenePostGate: Promise<void> | null;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fail(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

function createSim(): Sim {
  const sim: Sim = {
    calls: [],
    workflowReads: 0,
    scenesAfterWorkflow: false,
    storyConflict: false,
    failStoryBaseline: false,
    sceneConflict: false,
    shotConflict: false,
    shotUsesOldSource: false,
    characterSourceId: "script-new",
    holdGet: null,
    holdGetPart: null,
    failGetPart: null,
    characterPostGate: null,
    scenePostGate: null,
    fetch: () => Promise.resolve(fail(500, "UNINSTALLED", "fetch was not installed")),
  };
  let storyConflictStage = 0;
  let storyConflictGets = 0;
  let sceneConflictGets = 0;
  let sceneConflictArmed = false;
  let sceneServerHeading = "原标题";
  let shotConflictGets = 0;
  let shotConflictArmed = false;
  let characterText = "角色甲";
  let characterRow = 1;
  let characterRevId = "rev-1";
  let characterStatus = "DRAFT";
  let characterReviewVersion = 1;
  let characterHasPrevious = false;

  function storyText(): string {
    if (!sim.storyConflict || storyConflictStage === 0) return "故事正文";
    return storyConflictGets <= 1 ? "服务器版本" : "更新的服务器";
  }

  function characterPayload(id: string) {
    if (id === CHAR_B) {
      return {
        aggregate: aggregate(CHAR_B, 1, "rev-b1", "DRAFT", 1),
        items: [entityRevision("rev-b1", 1, "角色乙", "script-new", "DRAFT", 1)],
      };
    }
    const current = entityRevision(characterRevId, characterHasPrevious ? 2 : 1, characterText, sim.characterSourceId, characterStatus, characterReviewVersion);
    const items = characterHasPrevious
      ? [current, entityRevision("rev-1", 1, "角色甲", "script-new", "DRAFT", 1)]
      : [current];
    return { aggregate: aggregate(CHAR_A, characterRow, characterRevId, characterStatus, characterReviewVersion), items };
  }

  function scenePayload() {
    const heading = sim.sceneConflict && sceneConflictArmed
      ? (sceneConflictGets <= 1 ? "服务端场景" : "更新场景")
      : sceneServerHeading;
    const rowVersion = sim.sceneConflict && sceneConflictArmed ? (sceneConflictGets <= 1 ? 5 : 8) : 2;
    return {
      aggregate: aggregate("scene-1", rowVersion, "scene-rev-new", "APPROVED", 1, "scene-rev-new"),
      items: [
        sceneRevision("scene-rev-new", 2, heading, "APPROVED", "CURRENT"),
        sceneRevision("scene-rev-old", 1, "旧场景", "APPROVED", "STALE"),
      ],
    };
  }

  function shotPayload(id: string) {
    const oldSource = sim.shotUsesOldSource && id === SHOT_A;
    const rowVersion = sim.shotConflict && shotConflictArmed ? (shotConflictGets <= 1 ? 6 : 11) : 4;
    return {
      aggregate: aggregate(id, rowVersion, `${id}-rev`, "DRAFT", 1),
      items: [shotRevision(id, id === SHOT_B ? "动作二" : "动作一", oldSource ? "scene-rev-old" : "scene-rev-new")],
    };
  }

  sim.fetch = async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = (String(input).split("?")[0] ?? String(input));
    const raw = typeof init?.body === "string" ? init.body : "";
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const headers = new Headers(init?.headers);
    sim.calls.push({ url: path, method, body, ifMatch: headers.get("If-Match"), key: headers.get("Idempotency-Key") });
    if (method === "GET" && sim.failGetPart && path.includes(sim.failGetPart)) return fail(500, "LOAD_FAILED", "版本加载失败");
    if (method === "GET" && sim.holdGet && sim.holdGetPart && path.includes(sim.holdGetPart)) await sim.holdGet;

    if (path === `/api/v1/projects/${PROJECT}` && method === "GET") {
      if (sim.storyConflict && storyConflictStage > 0) storyConflictGets += 1;
      if (sim.failStoryBaseline && storyConflictStage > 0) return fail(500, "BASELINE_FAILED", "基线读取失败");
      const version = !sim.storyConflict || storyConflictStage === 0 ? 1 : storyConflictGets <= 1 ? 2 : 9;
      return json({ id: PROJECT, title: "测试项目", premise: "梗概", version, status: "ACTIVE" });
    }
    if (path === `/api/v1/projects/${PROJECT}/episodes` && method === "GET") return json({ items: [episode()] });
    if (path === `/api/v1/projects/${PROJECT}/stories` && method === "GET") {
      return json({ items: [storyRevision(storyText())], nextCursor: null });
    }
    if (path === `/api/v1/projects/${PROJECT}/stories` && method === "POST") {
      if (sim.storyConflict) {
        storyConflictStage += 1;
        if (storyConflictStage <= 2) return fail(409, "CONFLICT", "版本冲突");
      }
      return json({ ok: true });
    }
    if (path === `/api/v1/projects/${PROJECT}/characters` && method === "GET") {
      return json({ items: [listAggregate(CHAR_A), listAggregate(CHAR_B)], nextCursor: null });
    }
    if (path === `/api/v1/projects/${PROJECT}/locations` && method === "GET") return json({ items: [], nextCursor: null });
    if (path === `/api/v1/projects/${PROJECT}/workflow-runs` && method === "GET") {
      sim.workflowReads += 1;
      if (!sim.scenesAfterWorkflow) return json([]);
      const status = sim.workflowReads === 1 ? "RUNNING" : "SUCCEEDED";
      return json([{
        id: "run-1",
        type: "MOCK_TEXT_SCENES",
        status,
        createdAt: "2026-01-01T00:00:00.000Z",
        jobs: [{ id: "job-1", kind: "MOCK_TEXT_SCENES", state: status, errorCode: null, errorMessage: null }],
      }]);
    }
    if (path === `/api/v1/projects/${PROJECT}/episodes/episode-1/scripts` && method === "GET") {
      return json({ items: [scriptRevision()], nextCursor: null });
    }
    if (path === `/api/v1/projects/${PROJECT}/episodes/episode-1/scenes` && method === "GET") {
      const visible = !sim.scenesAfterWorkflow || sim.workflowReads >= 2;
      return json({ items: visible ? [listAggregate("scene-1", "APPROVED")] : [], nextCursor: null });
    }
    if (path.endsWith("/scenes/scene-1/revisions") && method === "GET") {
      if (sim.sceneConflict && sceneConflictArmed) sceneConflictGets += 1;
      return json(scenePayload());
    }
    if (path.endsWith("/scenes/scene-1/revisions") && method === "POST") {
      if (sim.scenePostGate) {
        const heading = String(body.heading ?? "");
        return sim.scenePostGate.then(() => {
          sceneServerHeading = heading;
          return json({ ok: true });
        });
      }
      if (sim.sceneConflict) {
        const count = sim.calls.filter((call) => call.method === "POST" && call.url.endsWith("/scenes/scene-1/revisions")).length;
        if (count <= 2) {
          sceneConflictArmed = true;
          return fail(409, "CONFLICT", "版本冲突");
        }
      }
      sceneServerHeading = String(body.heading ?? sceneServerHeading);
      return json({ ok: true });
    }
    if (path.endsWith("/scenes/scene-1/shots") && method === "GET") {
      return json({ items: [listAggregate(SHOT_A), listAggregate(SHOT_B)], nextCursor: null });
    }
    if (/\/shots\/[^/]+\/revisions$/.test(path) && method === "GET") {
      const id = path.includes(SHOT_B) ? SHOT_B : SHOT_A;
      if (sim.shotConflict && shotConflictArmed && id === SHOT_A) shotConflictGets += 1;
      return json(shotPayload(id));
    }
    if (/\/shots\/[^/]+\/revisions$/.test(path) && method === "POST") {
      if (sim.shotConflict) {
        const count = sim.calls.filter((call) => call.method === "POST" && /\/shots\/[^/]+\/revisions$/.test(call.url)).length;
        if (count <= 2) {
          shotConflictArmed = true;
          return fail(409, "CONFLICT", "版本冲突");
        }
      }
      return json({ ok: true });
    }
    if (/\/characters\/[^/]+\/revisions$/.test(path) && method === "GET") {
      return json(characterPayload(path.includes(CHAR_B) ? CHAR_B : CHAR_A));
    }
    if (path.endsWith(`/characters/${CHAR_A}/revisions`) && method === "POST") {
      const apply = () => {
        const content = body.content as { text?: string } | undefined;
        characterText = content?.text ?? characterText;
        characterRow = 2;
        characterRevId = "rev-2";
        characterStatus = "DRAFT";
        characterReviewVersion = 1;
        characterHasPrevious = true;
        return json({ revisionId: "rev-2" });
      };
      if (sim.characterPostGate) return sim.characterPostGate.then(apply);
      return apply();
    }
    if (path.endsWith(`/characters/${CHAR_B}/revisions`) && method === "POST") return json({ revisionId: "rev-b2" });
    if (path.includes("/review") && method === "POST") {
      const to = String(body.to ?? "");
      if (to === "IN_REVIEW") {
        characterStatus = "IN_REVIEW";
        characterRow = 3;
        characterReviewVersion = 2;
      } else if (to === "APPROVED") {
        characterStatus = "APPROVED";
        characterRow = 4;
        characterReviewVersion = 3;
      }
      return json({ ok: true });
    }
    return fail(404, "NOT_FOUND", path);
  };
  return sim;
}

function aggregate(entityId: string, rowVersion: number, currentRevisionId: string, reviewStatus: string, reviewVersion: number, approvedRevisionId: string | null = null) {
  return {
    entityId,
    rowVersion,
    currentRevisionId,
    approvedRevisionId,
    currentRevision: { reviewStatus, freshnessStatus: "CURRENT", reviewVersion },
  };
}

function listAggregate(entityId: string, reviewStatus = "DRAFT") {
  return aggregate(entityId, 1, `${entityId}-current`, reviewStatus, 1, reviewStatus === "APPROVED" ? `${entityId}-current` : null);
}

function episode() {
  return {
    id: "episode-1",
    episodeNo: 1,
    title: "第一集",
    rowVersion: 3,
    currentScriptRevisionId: "script-new",
    approvedScriptRevisionId: "script-new",
    currentScriptReviewStatus: "APPROVED",
    currentScriptFreshnessStatus: "CURRENT",
  };
}

function storyRevision(text: string) {
  return {
    id: "story-1",
    revisionNo: 1,
    content: { text },
    reviewStatus: "APPROVED",
    freshnessStatus: "CURRENT",
    reviewVersion: 1,
    staleReason: null,
    staleFromRef: null,
    reviewNote: null,
  };
}

function scriptRevision() {
  return {
    id: "script-new",
    revisionNo: 1,
    sourceStoryRevisionId: "story-1",
    content: { text: "剧本" },
    reviewStatus: "APPROVED",
    freshnessStatus: "CURRENT",
    reviewVersion: 1,
  };
}

function entityRevision(id: string, revisionNo: number, text: string, sourceScriptRevisionId: string, reviewStatus: string, reviewVersion: number) {
  return { id, revisionNo, content: { text }, sourceScriptRevisionId, reviewStatus, freshnessStatus: "CURRENT", reviewVersion };
}

function sceneRevision(id: string, revisionNo: number, heading: string, reviewStatus: string, freshnessStatus: string) {
  return {
    id,
    revisionNo,
    sourceScriptRevisionId: "script-new",
    locationRevisionId: null,
    ordinal: revisionNo,
    heading,
    timeOfDay: "白天",
    summary: "场景摘要",
    reviewStatus,
    freshnessStatus,
    reviewVersion: 1,
  };
}

function shotRevision(id: string, action: string, sourceSceneRevisionId: string) {
  return {
    id: `${id}-rev`,
    revisionNo: 1,
    sourceSceneRevisionId,
    ordinal: id === SHOT_B ? 2 : 1,
    shotType: "中景",
    camera: "固定",
    action,
    dialogue: "原对白",
    durationHint: "短",
    promptText: "原提示",
    reviewStatus: "DRAFT",
    freshnessStatus: "CURRENT",
    reviewVersion: 1,
  };
}

function install(sim: Sim): void {
  vi.stubGlobal("fetch", sim.fetch);
}

function renderAt(search: string) {
  window.history.replaceState(null, "", `/projects/${PROJECT}?${search}`);
  return render(createElement(Workbench, { projectId: PROJECT }));
}

function formOf(heading: string): HTMLFormElement {
  const form = screen.getByRole("heading", { name: heading }).closest("form");
  if (!form) throw new Error(`missing form for ${heading}`);
  return form;
}

function field(id: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const node = document.getElementById(id);
  if (!(node instanceof HTMLInputElement) && !(node instanceof HTMLTextAreaElement) && !(node instanceof HTMLSelectElement)) {
    throw new Error(`missing ${id}`);
  }
  return node;
}

function postsEnding(sim: Sim, suffix: string): Call[] {
  return sim.calls.filter((call) => call.method === "POST" && call.url.endsWith(suffix));
}

function draftFor(part: string): { idempotencyKey: string; payload: unknown } | null {
  for (let index = 0; index < sessionStorage.length; index += 1) {
    const key = sessionStorage.key(index);
    if (!key?.startsWith("ads-draft:") || !key.includes(part)) continue;
    return JSON.parse(sessionStorage.getItem(key) ?? "null") as { idempotencyKey: string; payload: unknown };
  }
  return null;
}

async function openCharacter(id: string): Promise<HTMLFormElement> {
  const button = await screen.findByRole("button", { name: new RegExp(id.slice(0, 8)) });
  fireEvent.click(button);
  const heading = await screen.findByRole("heading", { name: "当前版本" });
  const form = heading.closest("form");
  if (!form) throw new Error("missing character editor");
  return form;
}

describe("workbench review interactions against a simulated API", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps the submit path and body on the character selected after a late response", async () => {
    const sim = createSim();
    let release!: () => void;
    sim.holdGetPart = `/characters/${CHAR_A}/revisions`;
    sim.holdGet = new Promise<void>((resolve) => { release = resolve; });
    install(sim);
    renderAt("focus=character");
    await screen.findByRole("button", { name: new RegExp(CHAR_A.slice(0, 8)) });
    fireEvent.click(screen.getByRole("button", { name: new RegExp(CHAR_A.slice(0, 8)) }));
    const editor = await openCharacter(CHAR_B);
    expect((within(editor).getByLabelText("正文") as HTMLTextAreaElement).value).toBe("角色乙");
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((within(formOf("当前版本")).getByLabelText("正文") as HTMLTextAreaElement).value).toBe("角色乙");
    fireEvent.change(within(formOf("当前版本")).getByLabelText("正文"), { target: { value: "只提交乙" } });
    fireEvent.click(within(formOf("当前版本")).getByRole("button", { name: "保存新版本" }));
    await screen.findByText("已保存");
    const saved = postsEnding(sim, `/characters/${CHAR_B}/revisions`);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.url).toContain(CHAR_B);
    expect(saved[0]?.url).not.toContain(CHAR_A);
    expect(saved[0]?.body).toMatchObject({ content: { text: "只提交乙" } });
  });

  it("hides the previous character form when the next history load fails", async () => {
    const sim = createSim();
    install(sim);
    renderAt("focus=character");
    const editor = await openCharacter(CHAR_A);
    expect((within(editor).getByLabelText("正文") as HTMLTextAreaElement).value).toBe("角色甲");
    sim.failGetPart = `/characters/${CHAR_B}/revisions`;
    fireEvent.click(screen.getByRole("button", { name: new RegExp(CHAR_B.slice(0, 8)) }));
    expect(await screen.findByText("版本加载失败")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "当前版本" })).toBeNull();
    expect(screen.queryByDisplayValue("角色甲")).toBeNull();
  });

  it("restores a new-entity draft for its own kind and drops the other kind", async () => {
    const sim = createSim();
    install(sim);
    renderAt("focus=character");
    fireEvent.change(await screen.findByLabelText("名称"), { target: { value: "临时甲" } });
    fireEvent.change(screen.getByLabelText("正文"), { target: { value: "正文甲" } });
    fireEvent.click(screen.getByRole("button", { name: "场地" }));
    await waitFor(() => expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe(""));
    expect((screen.getByLabelText("正文") as HTMLTextAreaElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "角色" }));
    await waitFor(() => expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe("临时甲"));
    expect((screen.getByLabelText("正文") as HTMLTextAreaElement).value).toBe("正文甲");
  });

  it("round-trips advanced JSON and restores an incomplete draft after remount", async () => {
    const sim = createSim();
    install(sim);
    const view = renderAt("focus=character");
    const editor = await openCharacter(CHAR_A);
    fireEvent.change(within(editor).getByLabelText("正文"), { target: { value: "甲乙" } });
    fireEvent.click(within(editor).getByRole("button", { name: "高级 JSON" }));
    expect((within(formOf("当前版本")).getByLabelText("高级 JSON") as HTMLTextAreaElement).value).toContain("甲乙");
    fireEvent.change(within(formOf("当前版本")).getByLabelText("高级 JSON"), { target: { value: '{\n  "note": "保留",\n  "text": "甲乙"\n}' } });
    fireEvent.click(within(formOf("当前版本")).getByRole("button", { name: "返回正文" }));
    expect((within(formOf("当前版本")).getByLabelText("正文") as HTMLTextAreaElement).value).toBe("甲乙");
    fireEvent.click(within(formOf("当前版本")).getByRole("button", { name: "高级 JSON" }));
    expect((within(formOf("当前版本")).getByLabelText("高级 JSON") as HTMLTextAreaElement).value).toContain("保留");
    fireEvent.change(within(formOf("当前版本")).getByLabelText("高级 JSON"), { target: { value: '{ "text": "甲乙", "note":' } });
    view.unmount();
    renderAt("focus=character");
    await openCharacter(CHAR_A);
    await waitFor(() => expect((within(formOf("当前版本")).getByLabelText("高级 JSON") as HTMLTextAreaElement).value).toBe('{ "text": "甲乙", "note":'));
    fireEvent.click(within(formOf("当前版本")).getByRole("button", { name: "返回正文" }));
    expect(await screen.findByText("JSON 尚未完成，不能返回正文")).toBeTruthy();
  });

  it("keeps text typed during an in-flight character save", async () => {
    const sim = createSim();
    let release!: () => void;
    sim.characterPostGate = new Promise<void>((resolve) => { release = resolve; });
    install(sim);
    const view = renderAt("focus=character");
    const editor = await openCharacter(CHAR_A);
    fireEvent.change(within(editor).getByLabelText("正文"), { target: { value: "第一" } });
    fireEvent.click(within(editor).getByRole("button", { name: "保存新版本" }));
    fireEvent.change(within(formOf("当前版本")).getByLabelText("正文"), { target: { value: "第二" } });
    release();
    await screen.findByDisplayValue("第二");
    view.unmount();
    renderAt("focus=character");
    await openCharacter(CHAR_A);
    await waitFor(() => expect((within(formOf("当前版本")).getByLabelText("正文") as HTMLTextAreaElement).value).toBe("第二"));
  });

  it("blocks a normal save after 409 and confirms only the snapshot already shown", async () => {
    const sim = createSim();
    sim.storyConflict = true;
    install(sim);
    renderAt("focus=story");
    fireEvent.change(await screen.findByLabelText("正文"), { target: { value: "我的故事草稿" } });
    fireEvent.click(within(formOf("故事")).getByRole("button", { name: "保存新版本" }));
    expect(await screen.findByText(/已看到的并发版本 2/)).toBeTruthy();
    expect(screen.getByText(/服务器版本/)).toBeTruthy();
    const save = within(formOf("故事")).getByRole("button", { name: "保存新版本" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(save);
    fireEvent.click(screen.getByRole("button", { name: "确认后重新提交" }));
    expect(await screen.findByText(/已看到的并发版本 9/)).toBeTruthy();
    expect(postsEnding(sim, "/stories").map((call) => call.ifMatch)).toEqual(["1", "2"]);
    expect((screen.getByLabelText("正文") as HTMLTextAreaElement).value).toBe("我的故事草稿");
    fireEvent.click(screen.getByRole("button", { name: "确认后重新提交" }));
    await screen.findByText("已保存");
    const storyPosts = postsEnding(sim, "/stories");
    expect(storyPosts.map((call) => call.ifMatch)).toEqual(["1", "2", "9"]);
    expect(storyPosts[2]?.body).toMatchObject({ content: { text: "我的故事草稿" } });
    expect(storyPosts[2]?.key).toBeTruthy();
    expect(storyPosts[2]?.key).not.toBe(storyPosts[1]?.key);
  });

  it("keeps the story draft when the conflict baseline cannot be read", async () => {
    const sim = createSim();
    sim.storyConflict = true;
    sim.failStoryBaseline = true;
    install(sim);
    renderAt("focus=story");
    fireEvent.change(await screen.findByLabelText("正文"), { target: { value: "我的故事草稿" } });
    fireEvent.click(within(formOf("故事")).getByRole("button", { name: "保存新版本" }));
    expect(await screen.findByText(/未能读取新基线，草稿保留/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "确认后重新提交" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("正文") as HTMLTextAreaElement).value).toBe("我的故事草稿");
    expect(postsEnding(sim, "/stories")).toHaveLength(1);
  });

  it("refreshes character history after save and lets review continue on the new baseline", async () => {
    const sim = createSim();
    install(sim);
    renderAt("focus=character");
    const editor = await openCharacter(CHAR_A);
    fireEvent.change(within(editor).getByLabelText("正文"), { target: { value: "角色甲修订" } });
    fireEvent.click(within(editor).getByRole("button", { name: "保存新版本" }));
    expect((await screen.findAllByText(/第 2 版/)).length).toBeGreaterThan(0);
    expect(screen.getByText("左侧版本")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "提交审核" }));
    fireEvent.click(await screen.findByRole("button", { name: "通过" }));
    expect((await screen.findAllByText(/已通过 APPROVED/)).length).toBeGreaterThan(0);
    const reviews = sim.calls.filter((call) => call.method === "POST" && call.url.includes("/review"));
    expect(reviews.map((call) => ({ ifMatch: call.ifMatch, body: call.body }))).toEqual([
      { ifMatch: "2", body: { to: "IN_REVIEW", expectedReviewVersion: 1 } },
      { ifMatch: "3", body: { to: "APPROVED", expectedReviewVersion: 2 } },
    ]);
    expect(reviews[0]?.url).toContain("rev-2");
    fireEvent.change(within(formOf("当前版本")).getByLabelText("正文"), { target: { value: "角色甲再修订" } });
    fireEvent.click(within(formOf("当前版本")).getByRole("button", { name: "保存新版本" }));
    await waitFor(() => expect(postsEnding(sim, `/characters/${CHAR_A}/revisions`).map((call) => call.ifMatch)).toEqual(["1", "4"]));
  });

  it("saves a character revision against the newly approved current script", async () => {
    const sim = createSim();
    sim.characterSourceId = "script-old";
    install(sim);
    renderAt("focus=character");
    const editor = await openCharacter(CHAR_A);
    fireEvent.change(within(editor).getByLabelText("正文"), { target: { value: "换来源后的正文" } });
    const before = draftFor(`character:${CHAR_A}`)?.idempotencyKey;
    const source = within(editor).getByLabelText("来源") as HTMLSelectElement;
    expect(Array.from(source.options).map((option) => option.value)).toEqual(["", "script-new"]);
    expect((within(editor).getByRole("button", { name: "保存新版本" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(source, { target: { value: "script-new" } });
    const after = draftFor(`character:${CHAR_A}`)?.idempotencyKey;
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
    fireEvent.click(within(formOf("当前版本")).getByRole("button", { name: "保存新版本" }));
    await screen.findByText("已保存");
    const saved = postsEnding(sim, `/characters/${CHAR_A}/revisions`);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.body).toMatchObject({ sourceScriptRevisionId: "script-new", content: { text: "换来源后的正文" } });
    expect(saved[0]?.key).toBe(after);
    expect(sim.calls.filter((call) => call.method === "POST" && call.url.includes("/scripts/"))).toHaveLength(0);
  });

  it("restores scene fields and keeps heading typed during an in-flight save", async () => {
    const sim = createSim();
    install(sim);
    const first = renderAt("focus=scene&episode=1&scene=scene-1");
    fireEvent.change(await screen.findByLabelText("标题"), { target: { value: "未提交标题" } });
    fireEvent.change(field("edit-summary"), { target: { value: "未提交摘要" } });
    fireEvent.change(field("edit-time"), { target: { value: "黄昏" } });
    first.unmount();
    const restored = renderAt("focus=scene&episode=1&scene=scene-1");
    await waitFor(() => {
      expect(field("edit-heading").value).toBe("未提交标题");
      expect(field("edit-summary").value).toBe("未提交摘要");
      expect(field("edit-time").value).toBe("黄昏");
    });
    let release!: () => void;
    sim.scenePostGate = new Promise<void>((resolve) => { release = resolve; });
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "场景一" } });
    fireEvent.click(within(formOf("原标题")).getByRole("button", { name: "保存新版本" }));
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "场景二" } });
    release();
    await screen.findByText("已保存");
    expect(draftFor("scene:scene-1")?.payload).toMatchObject({ heading: "场景二", summary: "未提交摘要" });
    restored.unmount();
    renderAt("focus=scene&episode=1&scene=scene-1");
    await waitFor(() => expect(field("edit-heading").value).toBe("场景二"));
    expect(field("edit-summary").value).toBe("未提交摘要");
  });

  it("blocks a scene save after 409 until the shown snapshot is confirmed", async () => {
    const sim = createSim();
    sim.sceneConflict = true;
    install(sim);
    renderAt("focus=scene&episode=1&scene=scene-1");
    fireEvent.change(await screen.findByLabelText("标题"), { target: { value: "我的场景" } });
    fireEvent.click(within(formOf("原标题")).getByRole("button", { name: "保存新版本" }));
    expect(await screen.findByText(/已看到的并发版本 5/)).toBeTruthy();
    expect(screen.getByText(/服务端场景/)).toBeTruthy();
    const save = within(formOf("原标题")).getByRole("button", { name: "保存新版本" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(save);
    fireEvent.click(screen.getByRole("button", { name: "确认后重新提交" }));
    expect(await screen.findByText(/已看到的并发版本 8/)).toBeTruthy();
    expect(postsEnding(sim, "/scenes/scene-1/revisions").map((call) => call.ifMatch)).toEqual(["2", "5"]);
    expect(field("edit-heading").value).toBe("我的场景");
    fireEvent.click(screen.getByRole("button", { name: "确认后重新提交" }));
    await screen.findByText("已保存");
    const scenePosts = postsEnding(sim, "/scenes/scene-1/revisions");
    expect(scenePosts.map((call) => call.ifMatch)).toEqual(["2", "5", "8"]);
    expect(scenePosts[2]?.body).toMatchObject({ heading: "我的场景" });
    expect(scenePosts[2]?.key).not.toBe(scenePosts[1]?.key);
  });

  it("keeps a shot switch on the newly selected shot after a late response", async () => {
    const sim = createSim();
    let release!: () => void;
    sim.holdGetPart = `/shots/${SHOT_A}/revisions`;
    sim.holdGet = new Promise<void>((resolve) => { release = resolve; });
    install(sim);
    renderAt(`focus=shot&episode=1&scene=scene-1&shot=${SHOT_A}`);
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(SHOT_B.slice(0, 8)) }));
    await screen.findByRole("heading", { name: "镜头 2" });
    expect(field("shot-action").value).toBe("动作二");
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(field("shot-action").value).toBe("动作二");
    fireEvent.change(field("shot-action"), { target: { value: "只属于乙" } });
    fireEvent.click(within(formOf("镜头 2")).getByRole("button", { name: "保存新版本" }));
    await screen.findByText("已保存");
    const saved = postsEnding(sim, `/shots/${SHOT_B}/revisions`);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.url).toContain(SHOT_B);
    expect(saved[0]?.url).not.toContain(SHOT_A);
    expect(saved[0]?.body).toMatchObject({ action: "只属于乙" });
    fireEvent.click(screen.getByRole("button", { name: new RegExp(SHOT_A.slice(0, 8)) }));
    await screen.findByRole("heading", { name: "镜头 1" });
    expect(field("shot-action").value).toBe("动作一");
    fireEvent.change(field("shot-dialogue"), { target: { value: "甲的对白" } });
    fireEvent.click(screen.getByRole("button", { name: new RegExp(SHOT_B.slice(0, 8)) }));
    await screen.findByRole("heading", { name: "镜头 2" });
    expect(field("shot-dialogue").value).toBe("原对白");
    fireEvent.click(screen.getByRole("button", { name: new RegExp(SHOT_A.slice(0, 8)) }));
    await screen.findByRole("heading", { name: "镜头 1" });
    expect(field("shot-dialogue").value).toBe("甲的对白");
  });

  it("saves a shot revision against the current approved scene and leaves the stale revision", async () => {
    const sim = createSim();
    sim.shotUsesOldSource = true;
    install(sim);
    renderAt(`focus=shot&episode=1&scene=scene-1&shot=${SHOT_A}`);
    expect(await screen.findByText(/已过期 STALE/)).toBeTruthy();
    await screen.findByRole("heading", { name: "镜头 1" });
    fireEvent.change(field("shot-action"), { target: { value: "换来源动作" } });
    const before = draftFor(`shot:${SHOT_A}`)?.idempotencyKey;
    const source = field("shot-source");
    if (!(source instanceof HTMLSelectElement)) throw new Error("shot-source");
    const stale = Array.from(source.options).find((option) => option.value === "scene-rev-old");
    const current = Array.from(source.options).find((option) => option.value === "scene-rev-new");
    expect(stale?.disabled).toBe(true);
    expect(current?.disabled).toBe(false);
    expect((within(formOf("镜头 1")).getByRole("button", { name: "保存新版本" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(source, { target: { value: "scene-rev-new" } });
    const after = draftFor(`shot:${SHOT_A}`)?.idempotencyKey;
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
    fireEvent.click(within(formOf("镜头 1")).getByRole("button", { name: "保存新版本" }));
    await screen.findByText("已保存");
    const saved = postsEnding(sim, `/shots/${SHOT_A}/revisions`);
    expect(saved[0]?.body).toMatchObject({ sourceSceneRevisionId: "scene-rev-new", action: "换来源动作" });
    expect(saved[0]?.key).toBe(after);
    expect(screen.getByText(/已过期 STALE/)).toBeTruthy();
    expect(postsEnding(sim, "/scenes/scene-1/revisions")).toHaveLength(0);
  });

  it("blocks a shot save after 409 until the shown snapshot is confirmed", async () => {
    const sim = createSim();
    sim.shotConflict = true;
    install(sim);
    renderAt(`focus=shot&episode=1&scene=scene-1&shot=${SHOT_A}`);
    await screen.findByRole("heading", { name: "镜头 1" });
    fireEvent.change(field("shot-action"), { target: { value: "改动作" } });
    fireEvent.click(within(formOf("镜头 1")).getByRole("button", { name: "保存新版本" }));
    expect(await screen.findByText(/已看到的并发版本 6/)).toBeTruthy();
    const save = within(formOf("镜头 1")).getByRole("button", { name: "保存新版本" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(save);
    fireEvent.click(screen.getByRole("button", { name: "确认后重新提交" }));
    expect(await screen.findByText(/已看到的并发版本 11/)).toBeTruthy();
    expect(postsEnding(sim, `/shots/${SHOT_A}/revisions`).map((call) => call.ifMatch)).toEqual(["4", "6"]);
    fireEvent.click(screen.getByRole("button", { name: "确认后重新提交" }));
    await screen.findByText("已保存");
    const shotPosts = postsEnding(sim, `/shots/${SHOT_A}/revisions`);
    expect(shotPosts.map((call) => call.ifMatch)).toEqual(["4", "6", "11"]);
    expect(shotPosts[2]?.body).toMatchObject({ action: "改动作" });
    expect(shotPosts[2]?.key).not.toBe(shotPosts[1]?.key);
  });

  it("reloads scenes when a text task reaches a terminal state and keeps the script draft", async () => {
    const sim = createSim();
    sim.scenesAfterWorkflow = true;
    install(sim);
    const view = renderAt("focus=script&episode=1");
    fireEvent.change(await screen.findByLabelText("正文"), { target: { value: "剧本草稿" } });
    expect(await screen.findByText("这一集还没有场景")).toBeTruthy();
    expect(await screen.findByText(/场景 scene-1/, {}, { timeout: 6000 })).toBeTruthy();
    await waitFor(() => expect(sim.workflowReads).toBeGreaterThanOrEqual(3));
    const reads = sim.workflowReads;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(sim.workflowReads).toBe(reads);
    view.unmount();
    renderAt("focus=script&episode=1");
    await waitFor(() => expect((screen.getByLabelText("正文") as HTMLTextAreaElement).value).toBe("剧本草稿"));
    expect(screen.getByText(/场景 scene-1/)).toBeTruthy();
  }, 15000);

  it("pauses workflow polling while hidden and rereads when the page returns", async () => {
    const sim = createSim();
    sim.scenesAfterWorkflow = true;
    install(sim);
    let hidden = false;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
    try {
      renderAt("focus=script&episode=1");
      fireEvent.change(await screen.findByLabelText("正文"), { target: { value: "剧本草稿" } });
      expect(await screen.findByText("这一集还没有场景")).toBeTruthy();
      expect(sim.workflowReads).toBe(1);
      hidden = true;
      await new Promise((resolve) => setTimeout(resolve, 2500));
      expect(sim.workflowReads).toBe(1);
      expect(screen.getByText("这一集还没有场景")).toBeTruthy();
      hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
      expect(await screen.findByText(/场景 scene-1/)).toBeTruthy();
      expect((screen.getByLabelText("正文") as HTMLTextAreaElement).value).toBe("剧本草稿");
    } finally {
      delete (document as { visibilityState?: string }).visibilityState;
    }
  }, 15000);
});
