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
  shotPostGate: Promise<void> | null;
  withLocation: boolean;
  sceneStale: boolean;
  sceneStaleReads: number;
  blankPrompt: boolean;
  blankDialogue: boolean;
  imageReady: boolean;
  imageHistory: boolean;
  imageFailures: number;
  imagePostGate: Promise<void> | null;
  imageAssets: Record<string, Array<Record<string, unknown>>>;
  mediaImage: boolean;
  mediaTask: boolean;
  failWorkflowRead: number | null;
  failAssetRead: number | null;
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
    shotPostGate: null,
    withLocation: false,
    sceneStale: false,
    sceneStaleReads: 0,
    blankPrompt: false,
    blankDialogue: false,
    imageReady: false,
    imageHistory: false,
    imageFailures: 0,
    imagePostGate: null,
    imageAssets: {},
    mediaImage: false,
    mediaTask: false,
    failWorkflowRead: null,
    failAssetRead: null,
    fetch: () => Promise.resolve(fail(500, "UNINSTALLED", "fetch was not installed")),
  };
  let assetReads = 0;
  let storyConflictStage = 0;
  let storyConflictGets = 0;
  let sceneConflictGets = 0;
  let sceneConflictArmed = false;
  let shotConflictGets = 0;
  let shotConflictArmed = false;
  let sceneRow = 2;
  let sceneCurrentId = "scene-rev-new";
  let sceneItems: ReturnType<typeof sceneRevision>[] | null = null;
  const shotStates = new Map<string, { row: number; currentId: string; items: Array<ReturnType<typeof shotRevision>> }>();
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

  function ensureSceneItems() {
    if (!sceneItems) {
      sceneItems = [
        sceneRevision("scene-rev-new", 2, "原标题", "APPROVED", "CURRENT", "白天", sim.withLocation ? "loc-rev-1" : null),
        sceneRevision("scene-rev-old", 1, "旧场景", "APPROVED", "STALE", "夜晚", null),
      ];
    }
    return sceneItems;
  }

  function commitScene(body: Record<string, unknown>) {
    const items = ensureSceneItems();
    const previous = items[0];
    sceneRow += 1;
    sceneCurrentId = `scene-rev-${sceneRow}`;
    const heading = typeof body.heading === "string" ? body.heading : (previous?.heading ?? "");
    const summary = typeof body.summary === "string" ? body.summary : "场景摘要";
    const timeOfDay = "timeOfDay" in body ? (typeof body.timeOfDay === "string" ? body.timeOfDay : null) : "白天";
    const locationRevisionId = "locationRevisionId" in body
      ? (typeof body.locationRevisionId === "string" ? body.locationRevisionId : null)
      : null;
    sceneItems = [
      sceneRevision(sceneCurrentId, (previous?.revisionNo ?? 1) + 1, heading, "APPROVED", "CURRENT", timeOfDay, locationRevisionId, summary),
      ...items,
    ];
  }

  function scenePayload() {
    const items = ensureSceneItems();
    if (sim.sceneStale) {
      const row = sim.sceneStaleReads <= 1 ? 5 : 9;
      const heading = row === 5 ? "后台标题" : "更新的后台";
      const id = `scene-rev-stale-${row}`;
      return {
        aggregate: aggregate("scene-1", row, id, "APPROVED", 1, id),
        items: [sceneRevision(id, row, heading, "APPROVED", "CURRENT"), ...items],
      };
    }
    if (sim.sceneConflict && sceneConflictArmed) {
      const row = sceneConflictGets <= 1 ? 5 : sceneConflictGets === 2 ? 8 : 11;
      const heading = row === 5 ? "服务端场景" : row === 8 ? "更新场景" : "陷阱场景";
      const id = `scene-rev-${row}`;
      return {
        aggregate: aggregate("scene-1", row, id, "APPROVED", 1, id),
        items: [sceneRevision(id, row, heading, "APPROVED", "CURRENT"), ...items],
      };
    }
    return {
      aggregate: aggregate("scene-1", sceneRow, sceneCurrentId, "APPROVED", 1, sceneCurrentId),
      items,
    };
  }

  function ensureShot(id: string) {
    const existing = shotStates.get(id);
    if (existing) return existing;
    const source = sim.shotUsesOldSource && id === SHOT_A ? "scene-rev-old" : "scene-rev-new";
    const current = shotRevision(id, id === SHOT_B ? "动作二" : "动作一", source);
    if (sim.blankPrompt) current.promptText = "";
    if (sim.blankDialogue) current.dialogue = null;
    const created = { row: 4, currentId: current.id, items: [current] };
    shotStates.set(id, created);
    return created;
  }

  function commitShot(id: string, body: Record<string, unknown>) {
    const state = ensureShot(id);
    const previous = state.items[0];
    if (!previous) return;
    state.row += 1;
    const revision = {
      ...previous,
      id: `${id}-rev-${state.row}`,
      revisionNo: previous.revisionNo + 1,
      sourceSceneRevisionId: typeof body.sourceSceneRevisionId === "string" ? body.sourceSceneRevisionId : previous.sourceSceneRevisionId,
      ordinal: typeof body.ordinal === "number" ? body.ordinal : previous.ordinal,
      shotType: typeof body.shotType === "string" ? body.shotType : previous.shotType,
      camera: typeof body.camera === "string" ? body.camera : previous.camera,
      action: typeof body.action === "string" ? body.action : previous.action,
      dialogue: "dialogue" in body ? (typeof body.dialogue === "string" ? body.dialogue : null) : previous.dialogue,
      durationHint: "durationHint" in body ? (typeof body.durationHint === "string" ? body.durationHint : null) : previous.durationHint,
      promptText: typeof body.promptText === "string" ? body.promptText : previous.promptText,
    };
    state.currentId = revision.id;
    state.items = [revision, ...state.items];
  }

  function shotPayload(id: string) {
    const state = ensureShot(id);
    if (sim.shotConflict && shotConflictArmed && id === SHOT_A) {
      const row = shotConflictGets <= 1 ? 6 : shotConflictGets === 2 ? 11 : 15;
      const action = row === 6 ? "服务端动作" : row === 11 ? "更新动作" : "陷阱动作";
      const current = { ...state.items[0], id: `${id}-rev-${row}`, action };
      return {
        aggregate: aggregate(id, row, current.id, "DRAFT", 1),
        items: [current, ...state.items],
      };
    }
    const ready = sim.imageReady && id === SHOT_A;
    const items = ready
      ? state.items.map((item) => item.id === state.currentId
        ? { ...item, reviewStatus: "APPROVED", freshnessStatus: "CURRENT" }
        : item)
      : state.items;
    const older = sim.imageHistory && ready && items[0]
      ? [{ ...items[0], id: `${id}-rev-old`, revisionNo: 0, reviewStatus: "DRAFT" }]
      : [];
    return {
      aggregate: aggregate(id, state.row, state.currentId, ready ? "APPROVED" : "DRAFT", 1, ready ? state.currentId : null),
      items: [...items, ...older],
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
    if (path === `/api/v1/projects/${PROJECT}/locations` && method === "GET") {
      return json({
        items: sim.withLocation ? [aggregate("location-1", 1, "loc-rev-1", "APPROVED", 1, "loc-rev-1")] : [],
        nextCursor: null,
      });
    }
    if (path === `/api/v1/projects/${PROJECT}/workflow-runs` && method === "GET") {
      sim.workflowReads += 1;
      if (sim.failWorkflowRead === sim.workflowReads) return fail(500, "REFRESH_FAILED", "任务刷新失败");
      if (sim.mediaTask) {
        return json([{
          id: "media-run",
          type: "MEDIA_IMAGE",
          status: "FAILED",
          createdAt: "2026-09-30T00:00:00.000Z",
          jobs: [{
            id: "media-job",
            kind: "MEDIA_IMAGE",
            state: "FAILED",
            errorCode: "JOB_NOT_RETRYABLE",
            errorMessage: "Media image retry is unavailable",
            sourceShotRevisionId: `${SHOT_A}-rev`,
          }],
        }]);
      }
      if (sim.mediaImage) {
        const status = sim.workflowReads === 1 ? "RUNNING" : "SUCCEEDED";
        const revisionId = `${SHOT_A}-rev`;
        if (status === "SUCCEEDED") {
          sim.imageAssets[revisionId] = [imageRecord(revisionId, "ACTIVE", "cccccccc-cccc-4ccc-8ccc-cccccccccccc")];
        }
        return json([{
          id: "media-run",
          type: "MEDIA_IMAGE",
          status,
          createdAt: "2026-09-30T00:00:00.000Z",
          jobs: [{
            id: "media-job",
            kind: "MEDIA_IMAGE",
            state: status,
            errorCode: null,
            errorMessage: null,
            sourceShotRevisionId: revisionId,
          }],
        }]);
      }
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
      if (sim.sceneStale) sim.sceneStaleReads += 1;
      else if (sim.sceneConflict && sceneConflictArmed) sceneConflictGets += 1;
      return json(scenePayload());
    }
    if (path.endsWith("/scenes/scene-1/revisions") && method === "POST") {
      const finish = () => {
        if (sim.sceneConflict) {
          const count = sim.calls.filter((call) => call.method === "POST" && call.url.endsWith("/scenes/scene-1/revisions")).length;
          if (count <= 2) {
            sceneConflictArmed = true;
            return fail(409, "CONFLICT", "版本冲突");
          }
        }
        commitScene(body);
        const saved = ensureSceneItems()[0];
        return json({
          revisionId: sceneCurrentId,
          currentRevisionId: sceneCurrentId,
          revisionNo: saved?.revisionNo ?? sceneRow,
          rowVersion: sceneRow,
        });
      };
      if (sim.scenePostGate) return sim.scenePostGate.then(finish);
      return finish();
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
      const id = path.includes(SHOT_B) ? SHOT_B : SHOT_A;
      const finish = () => {
        if (sim.shotConflict && id === SHOT_A) {
          const count = sim.calls.filter((call) => call.method === "POST" && /\/shots\/[^/]+\/revisions$/.test(call.url)).length;
          if (count <= 2) {
            shotConflictArmed = true;
            return fail(409, "CONFLICT", "版本冲突");
          }
        }
        commitShot(id, body);
        const saved = ensureShot(id);
        return json({
          revisionId: saved.currentId,
          currentRevisionId: saved.currentId,
          revisionNo: saved.items[0]?.revisionNo ?? 1,
          rowVersion: saved.row,
        });
      };
      if (sim.shotPostGate && id === SHOT_A) return sim.shotPostGate.then(finish);
      return finish();
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
    if (/\/shot-revisions\/[^/]+\/assets$/.test(path) && method === "GET") {
      const revisionId = path.split("/").at(-2) ?? "";
      assetReads += 1;
      if (sim.failAssetRead === assetReads) return fail(500, "ASSET_REFRESH_FAILED", "图片刷新失败");
      return json({ items: sim.imageAssets[revisionId] ?? [] });
    }
    if (/\/shot-revisions\/[^/]+\/generate-(video|tts)$/.test(path) && method === "POST") {
      return json({ workflowRunId: "av-run", jobId: "av-job" }, 202);
    }
    if (/\/shot-revisions\/[^/]+\/generate-image$/.test(path) && method === "POST") {
      if (sim.imagePostGate) await sim.imagePostGate;
      if (sim.imageFailures > 0) {
        sim.imageFailures -= 1;
        return fail(409, "CONFLICT", "受理失败");
      }
      return json({ workflowRunId: "media-run", jobId: "media-job" }, 202);
    }
    return fail(404, "NOT_FOUND", path);
  };
  return sim;
}

function imageRecord(revisionId: string, status: string, id: string) {
  return {
    id,
    kind: "IMAGE",
    mimeType: "image/png",
    status,
    reviewStatus: "DRAFT",
    width: 1,
    height: 1,
    byteSize: 68,
    checksumSha256: `${status.toLowerCase()}${"a".repeat(64)}`.slice(0, 64),
    sourceShotRevisionId: revisionId,
    sourceGenerationJobId: "job-image",
    createdAt: "2026-09-30T00:00:00.000Z",
  };
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

function sceneRevision(
  id: string,
  revisionNo: number,
  heading: string,
  reviewStatus: string,
  freshnessStatus: string,
  timeOfDay: string | null = "白天",
  locationRevisionId: string | null = null,
  summary = "场景摘要",
) {
  return {
    id,
    revisionNo,
    sourceScriptRevisionId: "script-new",
    locationRevisionId,
    ordinal: revisionNo,
    heading,
    timeOfDay,
    summary,
    reviewStatus,
    freshnessStatus,
    reviewVersion: 1,
  };
}

function shotRevision(id: string, action: string, sourceSceneRevisionId: string): {
  id: string;
  revisionNo: number;
  sourceSceneRevisionId: string;
  ordinal: number;
  shotType: string;
  camera: string;
  action: string;
  dialogue: string | null;
  durationHint: string | null;
  promptText: string;
  reviewStatus: string;
  freshnessStatus: string;
  reviewVersion: number;
} {
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

function draftFor(part: string): { idempotencyKey: string; ifMatch: number | null; payload: unknown } | null {
  for (let index = 0; index < sessionStorage.length; index += 1) {
    const key = sessionStorage.key(index);
    if (!key?.startsWith("ads-draft:") || !key.includes(part)) continue;
    return JSON.parse(sessionStorage.getItem(key) ?? "null") as { idempotencyKey: string; ifMatch: number | null; payload: unknown };
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
    expect(draftFor("scene:scene-1")).toMatchObject({ ifMatch: 2, payload: { heading: "场景二", summary: "未提交摘要" } });
    expect(postsEnding(sim, "/scenes/scene-1/revisions")[0]?.ifMatch).toBe("2");
    restored.unmount();
    renderAt("focus=scene&episode=1&scene=scene-1");
    await waitFor(() => expect(field("edit-heading").value).toBe("场景二"));
    expect(field("edit-summary").value).toBe("未提交摘要");
    expect(screen.getAllByText(/第 3 版/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/第 2 版/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/第 1 版/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/原标题/).length).toBeGreaterThan(0);
    const sceneSave = within(formOf("场景一")).getByRole("button", { name: "保存新版本" });
    expect((sceneSave as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/已看到的并发版本 3/)).toBeTruthy();
    fireEvent.change(field("edit-heading"), { target: { value: "场景三" } });
    expect(draftFor("scene:scene-1")?.ifMatch).toBe(2);
    expect((field("edit-heading") as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "故事" }));
    await screen.findByRole("heading", { name: "故事" });
    fireEvent.click(screen.getByRole("button", { name: "第 1 集" }));
    fireEvent.click(await screen.findByRole("button", { name: /场景 scene-1/ }));
    await waitFor(() => expect(field("edit-heading").value).toBe("场景三"));
    expect((within(formOf("场景一")).getByRole("button", { name: "保存新版本" }) as HTMLButtonElement).disabled).toBe(true);
    expect(draftFor("scene:scene-1")?.ifMatch).toBe(2);
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

  it("blocks a refreshed scene draft on the baseline it displays and does not chase a later read", async () => {
    const sim = createSim();
    install(sim);
    const view = renderAt("focus=scene&episode=1&scene=scene-1");
    fireEvent.change(await screen.findByLabelText("标题"), { target: { value: "过期草稿" } });
    view.unmount();
    sim.sceneStale = true;
    sim.sceneStaleReads = 0;
    renderAt("focus=scene&episode=1&scene=scene-1");
    await waitFor(() => expect(field("edit-heading").value).toBe("过期草稿"));
    expect(screen.getAllByText(/已看到的并发版本 5/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/后台标题/).length).toBeGreaterThan(0);
    expect(draftFor("scene:scene-1")?.ifMatch).toBe(2);
    const save = within(formOf("后台标题")).getByRole("button", { name: "保存新版本" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field("edit-heading"), { target: { value: "过期草稿续" } });
    expect(draftFor("scene:scene-1")?.ifMatch).toBe(2);
    const postsBefore = postsEnding(sim, "/scenes/scene-1/revisions").length;
    fireEvent.click(save);
    expect(postsEnding(sim, "/scenes/scene-1/revisions")).toHaveLength(postsBefore);
    fireEvent.click(screen.getByRole("button", { name: "确认后重新提交" }));
    await waitFor(() => expect(postsEnding(sim, "/scenes/scene-1/revisions").map((call) => call.ifMatch)).toEqual(["5"]));
    const confirmPost = postsEnding(sim, "/scenes/scene-1/revisions")[0];
    const postIndex = sim.calls.indexOf(confirmPost!);
    const readsBeforeConfirm = sim.calls.slice(0, postIndex).filter((call) => call.method === "GET" && call.url.endsWith("/scenes/scene-1/revisions"));
    expect(readsBeforeConfirm).toHaveLength(2);
    expect(confirmPost?.body).toMatchObject({ heading: "过期草稿续" });
  });

  it("restores a scene conflict after leaving and blocks confirmation to the displayed version", async () => {
    const sim = createSim();
    sim.sceneConflict = true;
    install(sim);
    renderAt("focus=scene&episode=1&scene=scene-1");
    fireEvent.change(await screen.findByLabelText("标题"), { target: { value: "我的场景" } });
    fireEvent.click(within(formOf("原标题")).getByRole("button", { name: "保存新版本" }));
    expect(await screen.findByText(/已看到的并发版本 5/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "故事" }));
    await screen.findByRole("heading", { name: "故事" });
    fireEvent.click(screen.getByRole("button", { name: "第 1 集" }));
    fireEvent.click(await screen.findByRole("button", { name: /场景 scene-1/ }));
    await waitFor(() => expect(field("edit-heading").value).toBe("我的场景"));
    expect(screen.getAllByText(/已看到的并发版本 8/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/更新场景/).length).toBeGreaterThan(0);
    const save = within(formOf("更新场景")).getByRole("button", { name: "保存新版本" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(save);
    expect(postsEnding(sim, "/scenes/scene-1/revisions").map((call) => call.ifMatch)).toEqual(["2"]);
    fireEvent.click(screen.getByRole("button", { name: "确认后重新提交" }));
    await waitFor(() => expect(postsEnding(sim, "/scenes/scene-1/revisions").map((call) => call.ifMatch)).toEqual(["2", "8"]));
    expect(await screen.findByText(/已看到的并发版本 11/)).toBeTruthy();
    expect(field("edit-heading").value).toBe("我的场景");
    expect(postsEnding(sim, "/scenes/scene-1/revisions").map((call) => call.ifMatch)).toEqual(["2", "8"]);
  });

  it("keeps shot text typed during a save after the new revision is loaded", async () => {
    const sim = createSim();
    let release!: () => void;
    sim.shotPostGate = new Promise<void>((resolve) => { release = resolve; });
    install(sim);
    const view = renderAt(`focus=shot&episode=1&scene=scene-1&shot=${SHOT_A}`);
    await screen.findByRole("heading", { name: "镜头 1" });
    fireEvent.change(field("shot-action"), { target: { value: "动作甲" } });
    fireEvent.click(within(formOf("镜头 1")).getByRole("button", { name: "保存新版本" }));
    fireEvent.change(field("shot-action"), { target: { value: "动作乙" } });
    release();
    await screen.findByText("已保存");
    await waitFor(() => expect(field("shot-action").value).toBe("动作乙"));
    expect(draftFor(`shot:${SHOT_A}`)?.ifMatch).toBe(4);
    expect(screen.getAllByText(/动作一/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/第 2 版/).length).toBeGreaterThan(0);
    expect((within(formOf("镜头 1")).getByRole("button", { name: "保存新版本" }) as HTMLButtonElement).disabled).toBe(true);
    expect((field("shot-action") as HTMLTextAreaElement).disabled).toBe(false);
    fireEvent.change(field("shot-action"), { target: { value: "动作丙" } });
    expect(draftFor(`shot:${SHOT_A}`)?.ifMatch).toBe(4);
    view.unmount();
    renderAt(`focus=shot&episode=1&scene=scene-1&shot=${SHOT_A}`);
    await waitFor(() => expect(field("shot-action").value).toBe("动作丙"));
    expect((within(formOf("镜头 1")).getByRole("button", { name: "保存新版本" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "故事" }));
    await screen.findByRole("heading", { name: "故事" });
    fireEvent.click(screen.getByRole("button", { name: "第 1 集" }));
    fireEvent.click(await screen.findByRole("button", { name: /场景 scene-1/ }));
    fireEvent.click(await screen.findByRole("button", { name: /镜头 11111111/ }));
    await waitFor(() => expect(field("shot-action").value).toBe("动作丙"));
    expect(draftFor(`shot:${SHOT_A}`)?.ifMatch).toBe(4);
  });

  it("restores a cleared optional field and keeps a missing field on the server value", async () => {
    const sim = createSim();
    sim.withLocation = true;
    install(sim);
    const sceneKey = `ads-draft:${PROJECT}:scene:scene-1:scene-rev-new`;
    sessionStorage.setItem(sceneKey, JSON.stringify({
      fingerprint: "seed-scene",
      idempotencyKey: "seed-scene",
      ifMatch: 2,
      payload: { heading: "只改标题", summary: "场景摘要", ordinal: 2, sourceScriptRevisionId: "script-new" },
    }));
    sessionStorage.setItem(`ads-active:${PROJECT}:scene:scene-1`, sceneKey);
    const sceneView = renderAt("focus=scene&episode=1&scene=scene-1");
    await waitFor(() => {
      expect(field("edit-heading").value).toBe("只改标题");
      expect(field("edit-time").value).toBe("白天");
      expect(field("edit-location").value).toBe("loc-rev-1");
    });
    fireEvent.change(field("edit-time"), { target: { value: "" } });
    fireEvent.change(field("edit-location"), { target: { value: "" } });
    sceneView.unmount();
    renderAt("focus=scene&episode=1&scene=scene-1");
    await waitFor(() => {
      expect(field("edit-heading").value).toBe("只改标题");
      expect(field("edit-time").value).toBe("");
      expect(field("edit-location").value).toBe("");
    });
    expect(draftFor("scene:scene-1")?.payload).toMatchObject({ timeOfDay: null, locationRevisionId: null });
    cleanup();

    const shotKey = `ads-draft:${PROJECT}:shot:${SHOT_A}:${SHOT_A}-rev`;
    sessionStorage.setItem(shotKey, JSON.stringify({
      fingerprint: "seed-shot",
      idempotencyKey: "seed-shot",
      ifMatch: 4,
      payload: {
        sourceSceneRevisionId: "scene-rev-new",
        ordinal: 1,
        shotType: "中景",
        camera: "固定",
        action: "只改动作",
        promptText: "原提示",
      },
    }));
    sessionStorage.setItem(`ads-active:${PROJECT}:shot:${SHOT_A}`, shotKey);
    const shotView = renderAt(`focus=shot&episode=1&scene=scene-1&shot=${SHOT_A}`);
    await waitFor(() => {
      expect(field("shot-action").value).toBe("只改动作");
      expect(field("shot-dialogue").value).toBe("原对白");
      expect(field("shot-duration").value).toBe("短");
    });
    fireEvent.change(field("shot-dialogue"), { target: { value: "" } });
    fireEvent.change(field("shot-duration"), { target: { value: "" } });
    shotView.unmount();
    renderAt(`focus=shot&episode=1&scene=scene-1&shot=${SHOT_A}`);
    await waitFor(() => {
      expect(field("shot-action").value).toBe("只改动作");
      expect(field("shot-dialogue").value).toBe("");
      expect(field("shot-duration").value).toBe("");
    });
    expect(draftFor(`shot:${SHOT_A}`)?.payload).toMatchObject({ dialogue: null, durationHint: null });
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

  it("keeps mock image generation disabled until the loaded shot and its source are usable", async () => {
    const sim = createSim();
    install(sim);
    renderAt(`focus=shot&episode=1&scene=scene-1&shot=${SHOT_A}`);
    const button = await screen.findByRole("button", { name: /生成 Mock 图片/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.textContent).toContain("尚未批准，不能当作可用来源");
    fireEvent.click(button);
    expect(sim.calls.filter((call) => call.url.includes("/generate-image"))).toHaveLength(0);
  });

  it("accepts an explicit mock image request without treating 202 as a finished asset", async () => {
    const sim = createSim();
    sim.imageReady = true;
    install(sim);
    renderAt(`focus=shot&episode=1&scene=scene-1&shot=${SHOT_A}`);
    fireEvent.click(await screen.findByRole("button", { name: "生成 Mock 图片" }));
    expect(await screen.findByText(/已受理，结果以任务和图片列表为准/)).toBeTruthy();
    expect(screen.queryByText("生成成功")).toBeNull();
    const posts = sim.calls.filter((call) => call.method === "POST" && call.url.endsWith("/generate-image"));
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({});
    fireEvent.click(screen.getByRole("button", { name: "生成 Mock 图片" }));
    await waitFor(() => expect(sim.calls.filter((call) => call.url.endsWith("/generate-image"))).toHaveLength(2));
    const again = sim.calls.filter((call) => call.url.endsWith("/generate-image"));
    expect(again[0]?.key).not.toBe(again[1]?.key);
  });

  it("reuses the image idempotency key after failure and changes it when the seed changes", async () => {
    const sim = createSim();
    sim.imageReady = true;
    sim.imageFailures = 1;
    install(sim);
    renderAt(`focus=shot&episode=1&scene=scene-1&shot=${SHOT_A}`);
    const button = await screen.findByRole("button", { name: "生成 Mock 图片" });
    fireEvent.click(button);
    expect(await screen.findByText(/再次提交将复用同一幂等键/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "生成 Mock 图片" }));
    expect(await screen.findByText(/已受理/)).toBeTruthy();
    const failed = sim.calls.filter((call) => call.url.endsWith("/generate-image"));
    expect(failed[0]?.key).toBe(failed[1]?.key);
    fireEvent.change(field("mock-image-seed"), { target: { value: "seed-b" } });
    fireEvent.click(screen.getByRole("button", { name: "生成 Mock 图片" }));
    await waitFor(() => expect(sim.calls.filter((call) => call.url.endsWith("/generate-image"))).toHaveLength(3));
    const seeded = sim.calls.filter((call) => call.url.endsWith("/generate-image"));
    expect(seeded[2]?.key).not.toBe(seeded[1]?.key);
    expect(seeded[2]?.body).toEqual({ seed: "seed-b" });
  });

  it("ignores a second click while image generation is in flight", async () => {
    const sim = createSim();
    sim.imageReady = true;
    let release!: () => void;
    sim.imagePostGate = new Promise<void>((resolve) => { release = resolve; });
    install(sim);
    renderAt(`focus=shot&episode=1&scene=scene-1&shot=${SHOT_A}`);
    fireEvent.click(await screen.findByRole("button", { name: "生成 Mock 图片" }));
    const pending = await screen.findByRole("button", { name: "正在提交" });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(pending);
    release();
    expect(await screen.findByText(/已受理/)).toBeTruthy();
    expect(sim.calls.filter((call) => call.url.endsWith("/generate-image"))).toHaveLength(1);
  });

  it("keeps a late asset response on the shot that requested it", async () => {
    const sim = createSim();
    sim.imageReady = true;
    const revisionId = `${SHOT_A}-rev`;
    sim.imageAssets[revisionId] = [imageRecord(revisionId, "ACTIVE", "dddddddd-dddd-4ddd-8ddd-dddddddddddd")];
    let release!: () => void;
    sim.holdGetPart = `/shot-revisions/${revisionId}/assets`;
    sim.holdGet = new Promise<void>((resolve) => { release = resolve; });
    install(sim);
    renderAt(`focus=shot&episode=1&scene=scene-1&shot=${SHOT_A}`);
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(SHOT_B.slice(0, 8)) }));
    await screen.findByRole("heading", { name: "镜头 2" });
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByText("dddddddd-dddd-4ddd-8ddd-dddddddddddd")).toBeNull();
    expect(field("shot-action").value).toBe("动作二");
  });

  it("shows current and historical images separately and previews only readable statuses", async () => {
    const sim = createSim();
    sim.imageReady = true;
    sim.imageHistory = true;
    const currentId = `${SHOT_A}-rev`;
    const historyId = `${SHOT_A}-rev-old`;
    sim.imageAssets[currentId] = [
      imageRecord(currentId, "STALE", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"),
      imageRecord(currentId, "FAILED", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1"),
      { ...imageRecord(currentId, "DELETED", "cccccccc-cccc-4ccc-8ccc-ccccccccccc1"), sourceShotRevisionId: "other-shot" },
    ];
    sim.imageAssets[historyId] = [imageRecord(historyId, "SUPERSEDED", "dddddddd-dddd-4ddd-8ddd-ddddddddddd1")];
    install(sim);
    renderAt(`focus=shot&episode=1&scene=scene-1&shot=${SHOT_A}`);
    expect(await screen.findByRole("heading", { name: "当前版本图片" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "历史版本图片" })).toBeTruthy();
    const image = await screen.findByRole("img", { name: /aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1/ });
    expect(image.getAttribute("src")).toBe("/api/v1/assets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1/content");
    expect(screen.queryByRole("img", { name: /bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1/ })).toBeNull();
    expect(screen.queryByText(/cccccccc-cccc-4ccc-8ccc-ccccccccccc1/)).toBeNull();
    expect(screen.getByText(/dddddddd-dddd-4ddd-8ddd-ddddddddddd1/)).toBeTruthy();
    const current = screen.getByRole("heading", { name: "当前版本图片" }).parentElement;
    const history = screen.getByRole("heading", { name: "历史版本图片" }).parentElement;
    expect(current?.textContent).toContain("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1");
    expect(current?.textContent).not.toContain("dddddddd-dddd-4ddd-8ddd-ddddddddddd1");
    expect(history?.textContent).toContain(historyId);
    expect(history?.textContent).not.toContain("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1");
  });

  it("shows the shot revision on a media task and keeps manual retry disabled", async () => {
    const sim = createSim();
    sim.mediaTask = true;
    install(sim);
    renderAt(`focus=shot&episode=1&scene=scene-1&shot=${SHOT_A}`);
    fireEvent.click(await screen.findByRole("button", { name: "任务" }));
    expect(await screen.findByText(new RegExp(`${SHOT_A}-rev`))).toBeTruthy();
    const retry = screen.getByRole("button", { name: /媒体手工重试不可用/ });
    expect((retry as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(retry);
    expect(sim.calls.filter((call) => call.url.endsWith("/retry"))).toHaveLength(0);
  });

  it("reloads shot images when a media task finishes and keeps the in-progress draft", async () => {
    const sim = createSim();
    sim.imageReady = true;
    sim.mediaImage = true;
    install(sim);
    renderAt(`focus=shot&episode=1&scene=scene-1&shot=${SHOT_A}`);
    await screen.findByRole("heading", { name: "镜头 1" });
    fireEvent.change(field("shot-action"), { target: { value: "图片刷新时保留" } });
    expect(await screen.findByText(/cccccccc-cccc-4ccc-8ccc-cccccccccccc/, {}, { timeout: 6000 })).toBeTruthy();
    expect(field("shot-action").value).toBe("图片刷新时保留");
    await waitFor(() => expect(sim.workflowReads).toBeGreaterThanOrEqual(2));
    const reads = sim.workflowReads;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(sim.workflowReads).toBe(reads);
  }, 15000);

  it("rereads images when a hidden media task finishes and then stops polling", async () => {
    const sim = createSim();
    sim.imageReady = true;
    sim.mediaImage = true;
    install(sim);
    let hidden = false;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
    try {
      renderAt(`focus=shot&episode=1&scene=scene-1&shot=${SHOT_A}`);
      await screen.findByRole("heading", { name: "镜头 1" });
      fireEvent.change(field("shot-action"), { target: { value: "隐藏期间保留" } });
      expect(sim.workflowReads).toBe(1);
      hidden = true;
      await new Promise((resolve) => setTimeout(resolve, 2500));
      expect(sim.workflowReads).toBe(1);
      expect(screen.queryByText(/cccccccc-cccc-4ccc-8ccc-cccccccccccc/)).toBeNull();
      hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
      expect(await screen.findByText(/cccccccc-cccc-4ccc-8ccc-cccccccccccc/)).toBeTruthy();
      expect(field("shot-action").value).toBe("隐藏期间保留");
      const reads = sim.workflowReads;
      await new Promise((resolve) => setTimeout(resolve, 2500));
      expect(sim.workflowReads).toBe(reads);
    } finally {
      delete (document as { visibilityState?: string }).visibilityState;
    }
  }, 15000);

  it("clears the previous revision images before the new revision assets arrive", async () => {
    const sim = createSim();
    sim.imageReady = true;
    const oldId = `${SHOT_A}-rev`;
    const oldAsset = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    sim.imageAssets[oldId] = [imageRecord(oldId, "ACTIVE", oldAsset)];
    install(sim);
    renderAt(`focus=shot&episode=1&scene=scene-1&shot=${SHOT_A}`);
    expect(await screen.findByText(new RegExp(oldAsset))).toBeTruthy();
    const newId = `${SHOT_A}-rev-5`;
    let release!: () => void;
    sim.holdGetPart = `/shot-revisions/${newId}/assets`;
    sim.holdGet = new Promise<void>((resolve) => { release = resolve; });
    fireEvent.change(field("shot-action"), { target: { value: "新版本动作" } });
    fireEvent.click(within(formOf("镜头 1")).getByRole("button", { name: "保存新版本" }));
    await screen.findByText("已保存");
    expect(screen.queryByText(new RegExp(oldAsset))).toBeNull();
    release();
    expect(await screen.findByText(new RegExp(oldAsset))).toBeTruthy();
    const current = screen.getByRole("heading", { name: "当前版本图片" }).parentElement;
    const history = screen.getByRole("heading", { name: "历史版本图片" }).parentElement;
    expect(current?.textContent).not.toContain(oldAsset);
    expect(history?.textContent).toContain(oldAsset);
    expect(history?.textContent).toContain(oldId);
  });

  it("ignores a late asset response from the revision that was just replaced", async () => {
    const sim = createSim();
    sim.imageReady = true;
    const oldId = `${SHOT_A}-rev`;
    const oldAsset = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    sim.imageAssets[oldId] = [imageRecord(oldId, "ACTIVE", oldAsset)];
    let release!: () => void;
    sim.holdGetPart = `/shot-revisions/${oldId}/assets`;
    sim.holdGet = new Promise<void>((resolve) => { release = resolve; });
    install(sim);
    renderAt(`focus=shot&episode=1&scene=scene-1&shot=${SHOT_A}`);
    await screen.findByRole("heading", { name: "镜头 1" });
    fireEvent.change(field("shot-action"), { target: { value: "先保存" } });
    fireEvent.click(within(formOf("镜头 1")).getByRole("button", { name: "保存新版本" }));
    await screen.findByText("已保存");
    release();
    expect(await screen.findByText(new RegExp(oldAsset))).toBeTruthy();
    const current = screen.getByRole("heading", { name: "当前版本图片" }).parentElement;
    const history = screen.getByRole("heading", { name: "历史版本图片" }).parentElement;
    expect(current?.textContent).not.toContain(oldAsset);
    expect(history?.textContent).toContain(oldId);
  });

  it("keeps an accepted image request when the following refresh fails", async () => {
    const sim = createSim();
    sim.imageReady = true;
    sim.failWorkflowRead = 2;
    install(sim);
    renderAt(`focus=shot&episode=1&scene=scene-1&shot=${SHOT_A}`);
    fireEvent.click(await screen.findByRole("button", { name: "生成 Mock 图片" }));
    expect(await screen.findByText(/已受理，结果以任务和图片列表为准/)).toBeTruthy();
    expect(await screen.findByRole("button", { name: "重新查询" })).toBeTruthy();
    expect(screen.queryByText(/复用同一幂等键/)).toBeNull();
    expect(screen.queryByText(/再次生成/)).toBeNull();
    expect(sim.calls.filter((call) => call.url.endsWith("/generate-image"))).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "重新查询" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "重新查询" })).toBeNull());
    expect(screen.getByText(/已受理，结果以任务和图片列表为准/)).toBeTruthy();
    expect(sim.calls.filter((call) => call.url.endsWith("/generate-image"))).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "生成 Mock 图片" }));
    await waitFor(() => expect(sim.calls.filter((call) => call.url.endsWith("/generate-image"))).toHaveLength(2));
    const posts = sim.calls.filter((call) => call.url.endsWith("/generate-image"));
    expect(posts[0]?.key).not.toBe(posts[1]?.key);
  });

  it("retries an asset list query without reusing or replacing the generate key", async () => {
    const sim = createSim();
    sim.imageReady = true;
    sim.failAssetRead = 1;
    install(sim);
    renderAt(`focus=shot&episode=1&scene=scene-1&shot=${SHOT_A}`);
    expect(await screen.findByText(/图片列表刷新失败，可以重新查询/)).toBeTruthy();
    expect(screen.queryByText(/复用同一幂等键/)).toBeNull();
    expect(screen.queryByText(/再次生成/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重新查询" }));
    await waitFor(() => expect(screen.queryByText(/图片列表刷新失败/)).toBeNull());
    expect(sim.calls.filter((call) => call.url.endsWith("/generate-image"))).toHaveLength(0);
  });

  it("disables video and speech until the saved approved text exists", async () => {
    const sim = createSim();
    sim.imageReady = true;
    sim.blankPrompt = true;
    sim.blankDialogue = true;
    install(sim);
    renderAt(`focus=shot&episode=1&scene=scene-1&shot=${SHOT_A}`);
    expect(await screen.findByRole("button", { name: "生成 Mock 视频（先保存并审核提示词）" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "生成 Mock 配音（先保存并审核对白）" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "生成 Mock 图片" })).toBeTruthy();
  });

  it("keeps an accepted video request independent of image keys and shows decode failure", async () => {
    const sim = createSim();
    sim.imageReady = true;
    const revisionId = `${SHOT_A}-rev`;
    sim.imageAssets[revisionId] = [{
      ...imageRecord(revisionId, "ACTIVE", "dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
      kind: "VIDEO",
      mimeType: "video/mp4",
      width: 16,
      height: 16,
      durationMs: 1000,
    }];
    install(sim);
    renderAt(`focus=shot&episode=1&scene=scene-1&shot=${SHOT_A}`);
    fireEvent.click(await screen.findByRole("button", { name: "生成 Mock 视频" }));
    expect(await screen.findByText(/结果以任务和视频列表为准。这不是生成成功/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "生成 Mock 图片" }));
    await waitFor(() => expect(sim.calls.filter((call) => call.url.endsWith("/generate-image"))).toHaveLength(1));
    const videoPost = sim.calls.find((call) => call.url.endsWith("/generate-video"));
    const imagePost = sim.calls.find((call) => call.url.endsWith("/generate-image"));
    expect(videoPost?.key).toBeTruthy();
    expect(videoPost?.key).not.toBe(imagePost?.key);
    const video = document.querySelector("video");
    if (!video) throw new Error("video element missing");
    fireEvent.error(video);
    expect(await screen.findByText("读取或解码失败")).toBeTruthy();
  });
});
