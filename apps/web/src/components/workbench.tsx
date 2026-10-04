"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ComposePreflight } from "./compose-preflight";
import { EpisodeComposePreflight } from "./episode-compose-preflight";
import { ProjectCostSummary } from "./project-cost-summary";
import { ApiError, StudioClient } from "../lib/studio-client";
import {
  LIMITS,
  TEXT_WORKFLOW_TYPES,
  aggregateVersion,
  applyPage,
  applyTextContent,
  clearActiveDraft,
  confirmConflictDraft,
  currentStoryRevision,
  describeRevision,
  attachSeenBaseline,
  diffJson,
  displayedConflict,
  draftStorageKey,
  type DraftRecord,
  isSimpleContent,
  nextDraft,
  parseContentObject,
  readActiveDraftKey,
  readDraft,
  releaseSubmittedDraft,
  rememberActiveDraft,
  reviewActions,
  reviewRequest,
  shouldPoll,
  shouldApplyLoad,
  sourceUsable,
  stableJson,
  textOf,
  writeDraft,
  type PageState,
} from "../lib/studio-model";

const client = new StudioClient();
const EMPTY_CONTENT: Record<string, unknown> = { text: "" };
const BODY_FIELD = "mt-1 w-full min-h-48 max-h-[70vh] resize-y rounded border border-neutral-300 px-3 py-2";

function mediaTaskLabel(type: string): string {
  if (type === "MEDIA_VIDEO") return "Mock 视频";
  if (type === "MEDIA_TTS") return "Mock 配音";
  if (type === "MEDIA_SUBTITLE") return "Mock 字幕";
  if (type === "MEDIA_MUSIC") return "Mock 音乐";
  return "Mock 图片";
}

function taskStatusLabel(state: string): string {
  if (state === "SUCCEEDED") return "成功 SUCCEEDED";
  if (state === "FAILED" || state === "PARTIAL_FAILED") return `失败 ${state}`;
  if (state === "CANCELED") return "已取消 CANCELED";
  return `进行中 ${state}`;
}

const MEDIA_WORKFLOW_TYPES = new Set(["MEDIA_IMAGE", "MEDIA_VIDEO", "MEDIA_TTS", "MEDIA_SUBTITLE", "MEDIA_MUSIC"]);

function trackedWorkflow(run: { type: string }): boolean {
  return TEXT_WORKFLOW_TYPES.has(run.type) || MEDIA_WORKFLOW_TYPES.has(run.type);
}

function noteWorkflowTransitions(
  runs: readonly WorkflowRun[],
  known: Map<string, string>,
): { mediaBecameTerminal: boolean; textBecameTerminal: boolean } {
  let mediaBecameTerminal = false;
  let textBecameTerminal = false;
  for (const run of runs) {
    const previous = known.get(run.id);
    const terminal = !shouldPoll(run.status, false);
    const becameTerminal = previous !== undefined && shouldPoll(previous, false) && terminal;
    const media = MEDIA_WORKFLOW_TYPES.has(run.type);
    const firstTerminalMedia = previous === undefined && media && terminal;
    if ((becameTerminal || firstTerminalMedia) && media) mediaBecameTerminal = true;
    if (becameTerminal && !media) textBecameTerminal = true;
    known.set(run.id, run.status);
  }
  return { mediaBecameTerminal, textBecameTerminal };
}

interface ProjectRecord {
  id: string;
  title: string;
  premise: string;
  version: number;
  status: string;
}

interface EpisodeRecord {
  id: string;
  episodeNo: number;
  title: string;
  rowVersion: number;
  currentScriptRevisionId: string | null;
  approvedScriptRevisionId: string | null;
  currentScriptReviewStatus: string | null;
  currentScriptFreshnessStatus: string | null;
}

interface StoryRevision {
  id: string;
  revisionNo: number;
  content: unknown;
  reviewStatus: string;
  freshnessStatus: string;
  reviewVersion: number;
  staleReason: string | null;
  staleFromRef: string | null;
  reviewNote: string | null;
}

interface ScriptRevision {
  id: string;
  revisionNo: number;
  sourceStoryRevisionId: string;
  content: unknown;
  reviewStatus: string;
  freshnessStatus: string;
  reviewVersion: number;
}

interface Aggregate {
  entityId: string;
  rowVersion: number;
  currentRevisionId: string | null;
  approvedRevisionId: string | null;
  currentRevision: { reviewStatus: string; freshnessStatus: string; reviewVersion: number } | null;
}

interface EntityRevision {
  id: string;
  revisionNo: number;
  content: unknown;
  sourceScriptRevisionId: string;
  reviewStatus: string;
  freshnessStatus: string;
  reviewVersion: number;
}

interface SceneRevision {
  id: string;
  revisionNo: number;
  sourceScriptRevisionId: string;
  locationRevisionId: string | null;
  ordinal: number;
  heading: string;
  timeOfDay: string | null;
  summary: string;
  reviewStatus: string;
  freshnessStatus: string;
  reviewVersion: number;
}

interface ShotRevision {
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
}

interface WorkflowJob {
  id: string;
  kind: string;
  state: string;
  errorCode: string | null;
  errorMessage: string | null;
  sourceShotRevisionId?: string | null;
}

interface WorkflowRun {
  id: string;
  type: string;
  status: string;
  createdAt: string;
  jobs: WorkflowJob[];
}

type Focus =
  | { kind: "story" }
  | { kind: "script"; episodeNo: number }
  | { kind: "episode-compose"; episodeNo: number }
  | { kind: "character" }
  | { kind: "location" }
  | { kind: "scene"; episodeNo: number; sceneId: string }
  | { kind: "shot"; episodeNo: number; sceneId: string; shotId: string };

const REVIEW_TEXT: Record<string, string> = {
  DRAFT: "草稿 DRAFT",
  IN_REVIEW: "审核中 IN_REVIEW",
  APPROVED: "已通过 APPROVED",
  REJECTED: "已退回 REJECTED",
};

const FRESH_TEXT: Record<string, string> = {
  CURRENT: "新鲜 CURRENT",
  STALE: "已过期 STALE",
};

function focusLabel(focus: Focus): string {
  switch (focus.kind) {
    case "story": return "故事";
    case "script": return `第 ${focus.episodeNo} 集剧本`;
    case "episode-compose": return `第 ${focus.episodeNo} 集多镜编排`;
    case "character": return "角色";
    case "location": return "场地";
    case "scene": return `第 ${focus.episodeNo} 集场景`;
    case "shot": return `第 ${focus.episodeNo} 集镜头`;
    default: return "对象";
  }
}

function focusQuery(focus: Focus): string {
  const params = new URLSearchParams();
  params.set("focus", focus.kind);
  if ("episodeNo" in focus) params.set("episode", String(focus.episodeNo));
  if ("sceneId" in focus) params.set("scene", focus.sceneId);
  if ("shotId" in focus) params.set("shot", focus.shotId);
  return params.toString();
}

export function Workbench({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [episodes, setEpisodes] = useState<EpisodeRecord[]>([]);
  const [stories, setStories] = useState<PageState<StoryRevision> | null>(null);
  const [characters, setCharacters] = useState<PageState<Aggregate> | null>(null);
  const [locations, setLocations] = useState<PageState<Aggregate> | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowRun[]>([]);
  const [focus, setFocus] = useState<Focus>({ kind: "story" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    if (window.matchMedia("(min-width: 1024px)").matches) setSideOpen(true);
  }, []);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [saveState, setSaveState] = useState("尚未修改");
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const [imageEpoch, setImageEpoch] = useState(0);
  const baseToken = useRef(0);
  const workflowStatus = useRef(new Map<string, string>());

  const reloadBase = useCallback(async () => {
    const request = ++baseToken.current;
    const [nextProject, episodePage, storyPage, characterPage, locationPage, runs] = await Promise.all([
      client.get<ProjectRecord>(`/projects/${projectId}`),
      client.get<{ items: EpisodeRecord[] }>(`/projects/${projectId}/episodes`),
      client.get<{ items: StoryRevision[]; nextCursor: string | null }>(`/projects/${projectId}/stories`),
      client.get<{ items: Aggregate[]; nextCursor: string | null }>(`/projects/${projectId}/characters`),
      client.get<{ items: Aggregate[]; nextCursor: string | null }>(`/projects/${projectId}/locations`),
      client.get<WorkflowRun[]>(`/projects/${projectId}/workflow-runs`),
    ]);
    if (!shouldApplyLoad(request, baseToken.current)) return;
    const tracked = runs.filter(trackedWorkflow);
    const transition = noteWorkflowTransitions(tracked, workflowStatus.current);
    setProject(nextProject);
    setEpisodes(episodePage.items);
    setStories(applyPage(null, { scope: projectId, items: storyPage.items, nextCursor: storyPage.nextCursor, append: false }));
    setCharacters(applyPage(null, { scope: projectId, items: characterPage.items, nextCursor: characterPage.nextCursor, append: false }));
    setLocations(applyPage(null, { scope: projectId, items: locationPage.items, nextCursor: locationPage.nextCursor, append: false }));
    setWorkflows(tracked);
    if (transition.mediaBecameTerminal) setImageEpoch((value) => value + 1);
    if (transition.textBecameTerminal) setRefreshEpoch((value) => value + 1);
  }, [projectId]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const kind = params.get("focus");
    const episodeNo = Number(params.get("episode") ?? "1");
    const sceneId = params.get("scene") ?? "";
    const shotId = params.get("shot") ?? "";
    if (kind === "script") setFocus({ kind, episodeNo });
    else if (kind === "episode-compose") setFocus({ kind, episodeNo });
    else if (kind === "scene" && sceneId) setFocus({ kind, episodeNo, sceneId });
    else if (kind === "shot" && sceneId && shotId) setFocus({ kind, episodeNo, sceneId, shotId });
    else if (kind === "character" || kind === "location" || kind === "story") setFocus({ kind });
    setLoading(true);
    void reloadBase().catch((caught: unknown) => {
      setError(caught instanceof ApiError ? caught.detail : "工作台加载失败");
    }).finally(() => setLoading(false));
  }, [reloadBase]);

  useEffect(() => {
    const query = focusQuery(focus);
    window.history.replaceState(null, "", `/projects/${projectId}?${query}`);
  }, [focus, projectId]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const hidden = document.visibilityState === "hidden";
      const active = workflows.some((run) => shouldPoll(run.status, hidden));
      if (!active) return;
      const request = baseToken.current;
      void client.get<WorkflowRun[]>(`/projects/${projectId}/workflow-runs`).then((runs) => {
        if (!shouldApplyLoad(request, baseToken.current)) return;
        const tracked = runs.filter(trackedWorkflow);
        const transition = noteWorkflowTransitions(tracked, workflowStatus.current);
        setWorkflows(tracked);
        if (transition.mediaBecameTerminal) setImageEpoch((value) => value + 1);
        if (transition.textBecameTerminal) {
          setRefreshEpoch((value) => value + 1);
          void reloadBase().catch(() => undefined);
        }
      }).catch(() => undefined);
      timer = setTimeout(tick, 2000);
    };
    timer = setTimeout(tick, 2000);
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      setRefreshEpoch((value) => value + 1);
      void reloadBase().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [projectId, reloadBase, workflows]);

  function choose(next: Focus) {
    setFocus(next);
    setNavOpen(false);
    setCharacters((current) => current && current.scope === projectId ? current : null);
    setLocations((current) => current && current.scope === projectId ? current : null);
  }

  async function more(kind: "stories" | "characters" | "locations") {
    const current = kind === "stories" ? stories : kind === "characters" ? characters : locations;
    if (!current?.nextCursor) return;
    const request = baseToken.current;
    const path = kind === "stories"
      ? `/projects/${projectId}/stories?cursor=${encodeURIComponent(current.nextCursor)}`
      : `/projects/${projectId}/${kind}?cursor=${encodeURIComponent(current.nextCursor)}`;
    const body = await client.get<{ items: never[]; nextCursor: string | null }>(path);
    if (!shouldApplyLoad(request, baseToken.current)) return;
    const incoming = { scope: projectId, items: body.items, nextCursor: body.nextCursor, append: true };
    if (kind === "stories") setStories((page) => applyPage(page, incoming));
    if (kind === "characters") setCharacters((page) => applyPage(page, incoming));
    if (kind === "locations") setLocations((page) => applyPage(page, incoming));
  }

  const storyCurrent = currentStoryRevision(stories?.items ?? []);
  const textWorkflows = workflows;

  return (
    <div className="min-h-screen bg-neutral-100 text-neutral-900">
      <header className="flex flex-wrap items-center gap-3 border-b border-neutral-200 bg-white px-4 py-3">
        <a className="text-sm underline" href="/studio">创作中心</a>
        <div className="min-w-0">
          <p className="text-xs text-neutral-600">作品</p>
          <h1 className="text-lg font-semibold">{project?.title ?? "加载中"}</h1>
        </div>
        <p className="text-sm text-neutral-600">当前内容：<span>{focusLabel(focus)}</span></p>
        <p className="text-sm">保存状态：<span>{saveState}</span></p>
        <button className="ml-auto rounded border border-neutral-300 px-3 py-1 text-sm lg:hidden" type="button" onClick={() => setNavOpen(true)}>目录</button>
        <button className="rounded border border-neutral-300 px-3 py-1 text-sm" type="button" aria-expanded={sideOpen} onClick={() => setSideOpen((open) => !open)}>检查</button>
        <button className="rounded bg-red-700 px-3 py-1 text-sm text-white" type="button" onClick={() => setTasksOpen(true)}>任务</button>
      </header>
      {error ? <p className="px-4 py-2 text-sm" role="alert">{error}</p> : null}
      {loading ? <p className="px-4 py-6 text-sm">正在加载工作台</p> : null}
      <div className={`grid ${sideOpen ? "lg:grid-cols-[16rem_minmax(0,1fr)_22rem]" : "lg:grid-cols-[16rem_minmax(0,1fr)]"}`}>
        <nav className={`${navOpen ? "fixed inset-y-0 left-0 z-20 w-72 overflow-auto bg-white p-4 shadow-xl" : "hidden"} lg:static lg:block lg:bg-transparent lg:p-4 lg:shadow-none`} aria-label="创作步骤">
          <button className="mb-3 text-sm underline lg:hidden" type="button" onClick={() => setNavOpen(false)}>关闭目录</button>
          <p className="px-2 pt-2 text-xs text-neutral-600">故事与剧本</p>
          <button className="block w-full rounded px-2 py-2 text-left hover:bg-white" type="button" onClick={() => choose({ kind: "story" })}>故事</button>
          <p className="px-2 pt-3 text-xs text-neutral-600">当前试制范围固定为三集</p>
          {[1, 2, 3].map((episodeNo) => {
            const episode = episodes.find((item) => item.episodeNo === episodeNo);
            return (
              <div key={episodeNo}>
                <button
                  className="block w-full rounded px-2 py-2 text-left hover:bg-white disabled:text-neutral-400"
                  type="button"
                  disabled={!episode}
                  onClick={() => choose({ kind: "script", episodeNo })}
                >
                  {episode ? `第 ${episodeNo} 集` : `第 ${episodeNo} 集（故事通过后出现）`}
                </button>
              </div>
            );
          })}
          <p className="mt-4 px-2 text-xs text-neutral-600">角色与场地</p>
          <button className="block w-full rounded px-2 py-2 text-left hover:bg-white" type="button" onClick={() => choose({ kind: "character" })}>角色</button>
          <button className="block w-full rounded px-2 py-2 text-left hover:bg-white" type="button" onClick={() => choose({ kind: "location" })}>场地</button>
          <p className="mt-4 px-2 text-xs text-neutral-600">分镜与素材</p>
          <p className="px-2 py-2 text-sm text-neutral-600">打开某一集后，在正文里进入场景和镜头。这里不提供可保存的集数、风格或时长选项。</p>
          <p className="mt-4 px-2 text-xs text-neutral-600">合成与导出</p>
          {[1, 2, 3].map((episodeNo) => {
            const episode = episodes.find((item) => item.episodeNo === episodeNo);
            if (!episode) return null;
            return (
              <button
                key={`compose-${episodeNo}`}
                className="block w-full rounded px-2 py-2 text-left hover:bg-white"
                type="button"
                onClick={() => choose({ kind: "episode-compose", episodeNo })}
              >
                多镜编排 · 第 {episodeNo} 集
              </button>
            );
          })}
        </nav>
        <section className="min-w-0 p-4">
          {project ? (
            <article className="mb-4 rounded-lg bg-white p-4">
              <h2 className="font-medium">作品</h2>
              <p className="mt-2 text-sm">标题：{project.title}</p>
              <p className="text-sm">梗概：{project.premise || "无"}</p>
              <details className="mt-2 text-sm text-neutral-600">
                <summary>标题和梗概的保存范围</summary>
                <p className="mt-2">当前接口没有项目更新路由，标题和梗概只在创建时写入。</p>
              </details>
              <ProjectCostSummary projectId={projectId} />
            </article>
          ) : null}
          {project && focus.kind === "story" ? (
            <StoryPane
              project={project}
              stories={stories}
              onMore={() => void more("stories")}
              onSaved={reloadBase}
              onStatus={setSaveState}
              onOpenSide={() => setSideOpen(true)}
            />
          ) : null}
          {project && focus.kind === "episode-compose" ? (
            <EpisodeComposePreflight
              projectId={projectId}
              episodeNo={focus.episodeNo}
              episodeId={episodes.find((item) => item.episodeNo === focus.episodeNo)?.id ?? null}
            />
          ) : null}
          {project && focus.kind === "script" ? (
            <ScriptPane
              projectId={projectId}
              projectVersion={project.version}
              episode={episodes.find((item) => item.episodeNo === focus.episodeNo) ?? null}
              storyCurrent={storyCurrent}
              refreshEpoch={refreshEpoch}
              onSaved={reloadBase}
              onStatus={setSaveState}
              onOpenScene={(sceneId) => setFocus({ kind: "scene", episodeNo: focus.episodeNo, sceneId })}
            />
          ) : null}
          {project && (focus.kind === "character" || focus.kind === "location") ? (
            <EntityPane
              project={project}
              kind={focus.kind}
              page={focus.kind === "character" ? characters : locations}
              episodes={episodes}
              onMore={() => void more(focus.kind === "character" ? "characters" : "locations")}
              onSaved={reloadBase}
              onStatus={setSaveState}
            />
          ) : null}
          {project && (focus.kind === "scene" || focus.kind === "shot") ? (
            <ScenePane
              projectId={projectId}
              episode={episodes.find((item) => item.episodeNo === focus.episodeNo) ?? null}
              sceneId={focus.sceneId}
              shotId={focus.kind === "shot" ? focus.shotId : null}
              refreshEpoch={refreshEpoch}
              imageEpoch={imageEpoch}
              locations={locations?.items ?? []}
              onSaved={reloadBase}
              onStatus={setSaveState}
              onOpenShot={(shotId) => setFocus({ kind: "shot", episodeNo: focus.episodeNo, sceneId: focus.sceneId, shotId })}
            />
          ) : null}
        </section>
        <aside className={`${sideOpen ? "fixed inset-y-0 right-0 z-20 w-full max-w-md overflow-auto bg-white p-4 shadow-xl lg:static lg:shadow-none" : "hidden"} lg:p-4`} aria-label="检查面板">
          <button className="mb-3 text-sm underline lg:hidden" type="button" onClick={() => setSideOpen(false)}>关闭检查</button>
          <h2 className="font-medium">检查</h2>
          <p className="mt-2 text-sm text-neutral-600">版本、比较、来源和审核仍在当前正文旁。打开检查面板查看说明；窄屏从「检查」进入。已记录成本不是余额，也不是应付费用。</p>
        </aside>
      </div>
      {tasksOpen ? (
        <TaskDrawer
          projectId={projectId}
          runs={textWorkflows}
          onClose={() => setTasksOpen(false)}
          onChanged={reloadBase}
        />
      ) : null}
    </div>
  );
}

function StoryPane(props: {
  project: ProjectRecord;
  stories: PageState<StoryRevision> | null;
  onMore: () => void;
  onSaved: () => Promise<void>;
  onStatus: (value: string) => void;
  onOpenSide: () => void;
}) {
  const current = currentStoryRevision(props.stories?.items ?? []);
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <ContentEditor
          title="故事"
          projectId={props.project.id}
          entityKey="story"
          baseRevisionId={current?.id ?? null}
          content={current?.content ?? EMPTY_CONTENT}
          empty={describeRevision(current ? { id: current.id } : null) === "empty"}
          ifMatch={aggregateVersion("story", { projectVersion: props.project.version })}
          readConflict={async () => {
            const [nextProject, page] = await Promise.all([
              client.get<ProjectRecord>(`/projects/${props.project.id}`),
              client.get<{ items: StoryRevision[] }>(`/projects/${props.project.id}/stories`),
            ]);
            return { ifMatch: nextProject.version, server: currentStoryRevision(page.items)?.content ?? { text: "" } };
          }}
        onStatus={props.onStatus}
        onSubmit={async (content, draft) => {
          await client.write({
            path: `/projects/${props.project.id}/stories`,
            body: { content },
            idempotencyKey: draft.idempotencyKey,
            ifMatch: draft.ifMatch ?? undefined,
          });
        }}
        onSaved={props.onSaved}
      />
      <RevisionColumn
        items={(props.stories?.items ?? []).map((item) => ({
          id: item.id,
          revisionNo: item.revisionNo,
          reviewStatus: item.reviewStatus,
          freshnessStatus: item.freshnessStatus,
          reviewVersion: item.reviewVersion,
          source: "",
          note: item.reviewNote,
          staleReason: item.staleReason,
          body: item.content,
        }))}
        currentId={current?.id ?? null}
        nextCursor={props.stories?.nextCursor ?? null}
        onMore={props.onMore}
        ifMatch={props.project.version}
        reviewPath={(revisionId) => `/projects/${props.project.id}/stories/${revisionId}/review`}
        onSaved={props.onSaved}
        onOpen={props.onOpenSide}
      />
    </div>
  );
}

function ScriptPane(props: {
  projectId: string;
  projectVersion: number;
  episode: EpisodeRecord | null;
  storyCurrent: StoryRevision | null;
  refreshEpoch: number;
  onSaved: () => Promise<void>;
  onStatus: (value: string) => void;
  onOpenScene: (sceneId: string) => void;
}) {
  const [scripts, setScripts] = useState<PageState<ScriptRevision> | null>(null);
  const [scenes, setScenes] = useState<PageState<Aggregate> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadToken = useRef(0);
  const episodeId = props.episode?.id ?? "";

  const load = useCallback(async () => {
    if (!props.episode) return;
    const request = ++loadToken.current;
    const episode = props.episode;
    const scope = `${props.projectId}:${episode.id}`;
    const [scriptPage, scenePage] = await Promise.all([
      client.get<{ items: ScriptRevision[]; nextCursor: string | null }>(`/projects/${props.projectId}/episodes/${episode.id}/scripts`),
      client.get<{ items: Aggregate[]; nextCursor: string | null }>(`/projects/${props.projectId}/episodes/${episode.id}/scenes`),
    ]);
    if (!shouldApplyLoad(request, loadToken.current)) return;
    setScripts(applyPage(null, { scope, items: scriptPage.items, nextCursor: scriptPage.nextCursor, append: false }));
    setScenes(applyPage(null, { scope, items: scenePage.items, nextCursor: scenePage.nextCursor, append: false }));
  }, [props.episode, props.projectId, props.refreshEpoch]);

  useEffect(() => {
    setScripts(null);
    setScenes(null);
    void load().catch((caught: unknown) => setError(caught instanceof ApiError ? caught.detail : "剧本加载失败"));
  }, [load]);

  const current = props.episode?.currentScriptRevisionId
    ? (scripts?.items.find((item) => item.id === props.episode?.currentScriptRevisionId) ?? null)
    : null;
  const currentNotLoaded = Boolean(props.episode?.currentScriptRevisionId) && scripts !== null && current === null;
  const source = props.storyCurrent ? sourceUsable({
    reviewStatus: props.storyCurrent.reviewStatus,
    freshnessStatus: props.storyCurrent.freshnessStatus,
    currentId: props.storyCurrent.id,
    approvedId: props.storyCurrent.reviewStatus === "APPROVED" && props.storyCurrent.freshnessStatus === "CURRENT" ? props.storyCurrent.id : null,
    revisionId: props.storyCurrent.id,
  }) : { usable: false, reason: "还没有故事版本" };

  if (!props.episode) return <p>这一集还不存在。请先通过故事审核。</p>;
  const episode = props.episode;

  return (
    <div className="space-y-4">
      {error ? <p role="alert">{error}</p> : null}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <ContentEditor
          title={`第 ${episode.episodeNo} 集剧本`}
          projectId={props.projectId}
          entityKey={`script:${episodeId}`}
          baseRevisionId={current?.id ?? null}
          content={current?.content ?? EMPTY_CONTENT}
          empty={current === null}
          ifMatch={aggregateVersion("script", { episodeRowVersion: episode.rowVersion })}
          readConflict={async () => {
            const [page, scriptsPage] = await Promise.all([
              client.get<{ items: EpisodeRecord[] }>(`/projects/${props.projectId}/episodes`),
              client.get<{ items: ScriptRevision[] }>(`/projects/${props.projectId}/episodes/${episodeId}/scripts`),
            ]);
            const nextEpisode = page.items.find((item) => item.id === episodeId);
            const nextScript = scriptsPage.items.find((item) => item.id === nextEpisode?.currentScriptRevisionId);
            if (!nextEpisode) throw new Error("episode missing");
            return { ifMatch: nextEpisode.rowVersion, server: nextScript?.content ?? { text: "" } };
          }}
          extra={currentNotLoaded ? "当前剧本不在已加载页，请先加载更多版本，不会按序号另建一版。" : source.usable ? null : `来源不可用：${source.reason}`}
          onStatus={props.onStatus}
          onSubmit={async (content, draft) => {
            if (currentNotLoaded) throw new ApiError(400, "REVISION_NOT_LOADED", "当前剧本不在已加载页");
            if (!source.usable || !props.storyCurrent) throw new ApiError(400, "SOURCE_UNAVAILABLE", source.reason);
            await client.write({
              path: `/projects/${props.projectId}/episodes/${episodeId}/scripts`,
              body: { storyRevisionId: props.storyCurrent.id, sourceStoryRevisionId: props.storyCurrent.id, content },
              idempotencyKey: draft.idempotencyKey,
              ifMatch: draft.ifMatch ?? undefined,
            });
          }}
          onSaved={async () => {
            await props.onSaved();
            await load();
          }}
        />
        <RevisionColumn
          items={(scripts?.items ?? []).map((item) => ({
            id: item.id,
            revisionNo: item.revisionNo,
            reviewStatus: item.reviewStatus,
            freshnessStatus: item.freshnessStatus,
            reviewVersion: item.reviewVersion,
            source: item.sourceStoryRevisionId,
            note: null,
            staleReason: null,
            body: item.content,
          }))}
          currentId={current?.id ?? null}
          nextCursor={scripts?.nextCursor ?? null}
          onMore={() => {
            if (!scripts?.nextCursor) return;
            const request = loadToken.current;
            const cursor = scripts.nextCursor;
            void client.get<{ items: ScriptRevision[]; nextCursor: string | null }>(
              `/projects/${props.projectId}/episodes/${episodeId}/scripts?cursor=${encodeURIComponent(cursor)}`,
            ).then((page) => {
              if (!shouldApplyLoad(request, loadToken.current)) return;
              setScripts((currentPage) => applyPage(currentPage, {
                scope: `${props.projectId}:${episodeId}`,
                items: page.items,
                nextCursor: page.nextCursor,
                append: true,
              }));
            });
          }}
          ifMatch={props.episode.rowVersion}
          reviewPath={(revisionId) => `/projects/${props.projectId}/episodes/${episodeId}/scripts/${revisionId}/review`}
          onSaved={async () => {
            await props.onSaved();
            await load();
          }}
        />
      </div>
      <SceneList
        projectId={props.projectId}
        episode={props.episode}
        page={scenes}
        scriptReady={props.episode.currentScriptRevisionId !== null
          && props.episode.currentScriptRevisionId === props.episode.approvedScriptRevisionId
          && props.episode.currentScriptReviewStatus === "APPROVED"
          && props.episode.currentScriptFreshnessStatus === "CURRENT"}
        onOpen={props.onOpenScene}
        onReload={load}
        onMore={async () => {
          if (!scenes?.nextCursor || !props.episode) return;
          const request = loadToken.current;
          const scope = `${props.projectId}:${props.episode.id}`;
          const page = await client.get<{ items: Aggregate[]; nextCursor: string | null }>(
            `/projects/${props.projectId}/episodes/${props.episode.id}/scenes?cursor=${encodeURIComponent(scenes.nextCursor)}`,
          );
          if (!shouldApplyLoad(request, loadToken.current)) return;
          setScenes((current) => applyPage(current, { scope, items: page.items, nextCursor: page.nextCursor, append: true }));
        }}
        onRefreshBaseline={async () => {
          await props.onSaved();
          await load();
        }}
        onStatus={props.onStatus}
      />
    </div>
  );
}

function SceneList(props: {
  projectId: string;
  episode: EpisodeRecord;
  page: PageState<Aggregate> | null;
  scriptReady: boolean;
  onOpen: (sceneId: string) => void;
  onReload: () => Promise<void>;
  onRefreshBaseline: () => Promise<void>;
  onMore: () => Promise<void>;
  onStatus: (value: string) => void;
}) {
  const [ordinal, setOrdinal] = useState("1");
  const [heading, setHeading] = useState("");
  const [summary, setSummary] = useState("");
  const [timeOfDay, setTimeOfDay] = useState("");
  const [error, setError] = useState<string | null>(null);
  const storageKey = draftStorageKey(props.projectId, `scene-new:${props.episode.id}`, null);

  useEffect(() => {
    const draft = readDraft(window.sessionStorage, storageKey);
    const payload = draft?.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      setOrdinal("1");
      setHeading("");
      setSummary("");
      setTimeOfDay("");
      return;
    }
    const record = payload as Record<string, unknown>;
    setHeading(typeof record.heading === "string" ? record.heading : "");
    setSummary(typeof record.summary === "string" ? record.summary : "");
    setTimeOfDay(typeof record.timeOfDay === "string" ? record.timeOfDay : "");
    setOrdinal(typeof record.ordinal === "number" ? String(record.ordinal) : "1");
  }, [storageKey]);

  function remember(next: { ordinal: string; heading: string; summary: string; timeOfDay: string }) {
    const body = {
      ordinal: Number(next.ordinal),
      heading: next.heading,
      summary: next.summary,
      timeOfDay: next.timeOfDay,
    };
    writeDraft(window.sessionStorage, storageKey, nextDraft(readDraft(window.sessionStorage, storageKey), body, props.episode.rowVersion, () => crypto.randomUUID()));
  }

  async function createScene() {
    if (!props.scriptReady || !props.episode.currentScriptRevisionId) {
      setError("需要当前已批准且新鲜度为 CURRENT 的剧本");
      return;
    }
    const body = {
      sourceScriptRevisionId: props.episode.currentScriptRevisionId,
      ordinal: Number(ordinal),
      heading,
      summary,
      timeOfDay: timeOfDay.trim().length > 0 ? timeOfDay : null,
    };
    const draft = nextDraft(readDraft(window.sessionStorage, storageKey), body, props.episode.rowVersion, () => crypto.randomUUID());
    writeDraft(window.sessionStorage, storageKey, draft);
    props.onStatus("保存中");
    try {
      const created = await client.write<{ entityId: string }>({
        path: `/projects/${props.projectId}/episodes/${props.episode.id}/scenes`,
        body,
        idempotencyKey: draft.idempotencyKey,
        ifMatch: props.episode.rowVersion,
      });
      if (releaseSubmittedDraft(window.sessionStorage, storageKey, draft)) {
        setOrdinal("1");
        setHeading("");
        setSummary("");
        setTimeOfDay("");
      }
      props.onStatus("已保存");
      await props.onReload();
      props.onOpen(created.body.entityId);
    } catch (caught) {
      const conflict = caught instanceof ApiError && caught.status === 409;
      props.onStatus(conflict ? "版本冲突，草稿保留" : "保存失败，草稿保留");
      setError(caught instanceof ApiError ? `${caught.code}：${caught.detail}${conflict ? "。草稿保留，确认后再次保存才会使用新基线。" : ""}` : "保存失败，草稿保留");
      if (conflict) await props.onRefreshBaseline().catch(() => undefined);
    }
  }

  return (
    <section className="rounded-lg bg-white p-4">
      <h2 className="font-medium">场景</h2>
      <p className="mt-1 text-sm text-neutral-600">Mock 生成场景处理固定三集。前置条件由服务端判断：来源剧本需已通过且为 CURRENT。不会覆盖已经占用的 ordinal 1，也不是一键重新生成。</p>
      {props.page?.items.length === 0 ? <p className="mt-3 text-sm">这一集还没有场景</p> : null}
      <ul className="mt-3 space-y-2">
        {props.page?.items.map((scene) => (
          <li key={scene.entityId}>
            <button className="text-left underline" type="button" onClick={() => props.onOpen(scene.entityId)}>
              场景 {scene.entityId.slice(0, 8)} · {scene.currentRevision ? REVIEW_TEXT[scene.currentRevision.reviewStatus] : "无当前版本"}
            </button>
          </li>
        ))}
      </ul>
      {props.page?.nextCursor ? (
        <button className="mt-2 text-sm underline" type="button" onClick={() => void props.onMore()}>加载更多场景</button>
      ) : null}
      <form className="mt-4 grid gap-2" onSubmit={(event) => { event.preventDefault(); void createScene(); }}>
        <label htmlFor="scene-ordinal">序号</label>
        <input id="scene-ordinal" className="rounded border px-2 py-1" value={ordinal} onChange={(event) => { setOrdinal(event.target.value); remember({ ordinal: event.target.value, heading, summary, timeOfDay }); }} />
        <label htmlFor="scene-heading">标题</label>
        <input id="scene-heading" className="rounded border px-2 py-1" maxLength={LIMITS.heading} value={heading} onChange={(event) => { setHeading(event.target.value); remember({ ordinal, heading: event.target.value, summary, timeOfDay }); }} required />
        <label htmlFor="scene-time">时间</label>
        <input id="scene-time" className="rounded border px-2 py-1" maxLength={LIMITS.timeOfDay} value={timeOfDay} onChange={(event) => { setTimeOfDay(event.target.value); remember({ ordinal, heading, summary, timeOfDay: event.target.value }); }} />
        <label htmlFor="scene-summary">摘要</label>
        <textarea id="scene-summary" className={BODY_FIELD} maxLength={LIMITS.summary} value={summary} onChange={(event) => { setSummary(event.target.value); remember({ ordinal, heading, summary: event.target.value, timeOfDay }); }} required />
        <button className="w-fit rounded bg-red-700 px-3 py-2 text-white disabled:opacity-50" type="submit" disabled={!props.scriptReady}>保存新版本</button>
        {!props.scriptReady ? <p className="text-sm">来源剧本尚未批准或不是 CURRENT。</p> : null}
        {error ? <p role="alert">{error}</p> : null}
      </form>
    </section>
  );
}

interface SourceChoice {
  id: string;
  label: string;
  usable: boolean;
  reason: string;
}

interface SeenBaseline {
  ifMatch: number;
  server: unknown;
}

function payloadRecord(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
}

function keptText(record: Record<string, unknown> | null, key: string, fallback: string): string {
  if (!record || !Object.prototype.hasOwnProperty.call(record, key)) return fallback;
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function activeStorageKey(projectId: string, entityKey: string, revisionId: string | null): string {
  return readActiveDraftKey(window.sessionStorage, projectId, entityKey) ?? draftStorageKey(projectId, entityKey, revisionId);
}

function persistSeen(storageKey: string, seen: SeenBaseline | null): void {
  const existing = readDraft(window.sessionStorage, storageKey);
  if (!existing) return;
  writeDraft(window.sessionStorage, storageKey, attachSeenBaseline(existing, seen));
}

function isSceneRevision(value: unknown): value is SceneRevision {
  return Boolean(value && typeof value === "object" && "heading" in value && "summary" in value);
}

function isShotRevision(value: unknown): value is ShotRevision {
  return Boolean(value && typeof value === "object" && "action" in value && "shotType" in value);
}

interface EditorDraft {
  mode: "text" | "json";
  text: string;
  raw: string;
  parsed: Record<string, unknown> | null;
  sourceId: string | null;
}

function editorDraftFrom(payload: unknown, fallback: unknown, sourceId: string | null): EditorDraft {
  if (payload && typeof payload === "object" && !Array.isArray(payload) && "mode" in payload) {
    const record = payload as Partial<EditorDraft>;
    return {
      mode: record.mode === "json" ? "json" : "text",
      text: typeof record.text === "string" ? record.text : "",
      raw: typeof record.raw === "string" ? record.raw : "",
      parsed: record.parsed && typeof record.parsed === "object" && !Array.isArray(record.parsed) ? record.parsed : null,
      sourceId: typeof record.sourceId === "string" ? record.sourceId : sourceId,
    };
  }
  const parsed = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : (fallback && typeof fallback === "object" && !Array.isArray(fallback) ? { ...(fallback as Record<string, unknown>) } : { text: "" });
  return {
    mode: isSimpleContent(parsed) ? "text" : "json",
    text: textOf(parsed),
    raw: JSON.stringify(parsed, null, 2),
    parsed,
    sourceId,
  };
}

function contentFromDraft(draft: EditorDraft, fallback: unknown): Record<string, unknown> {
  if (draft.mode === "json") {
    if (!draft.parsed) throw new Error("JSON 尚未完成");
    return draft.parsed;
  }
  return applyTextContent(draft.parsed ?? fallback, draft.text);
}

function ContentEditor(props: {
  title: string;
  projectId: string;
  entityKey: string;
  baseRevisionId: string | null;
  content: unknown;
  empty: boolean;
  ifMatch: number;
  extra?: string | null;
  sources?: SourceChoice[];
  initialSourceId?: string | null;
  readConflict: () => Promise<SeenBaseline>;
  onStatus: (value: string) => void;
  onSubmit: (content: Record<string, unknown>, draft: { idempotencyKey: string; ifMatch: number | null }, sourceId: string | null) => Promise<void>;
  onSaved: () => Promise<void>;
}) {
  const scope = `${props.projectId}:${props.entityKey}:${props.baseRevisionId ?? "new"}`;
  const storageKey = activeStorageKey(props.projectId, props.entityKey, props.baseRevisionId);
  const initial = editorDraftFrom(readDraft(window.sessionStorage, storageKey)?.payload ?? null, props.content, props.initialSourceId ?? null);
  const [advanced, setAdvanced] = useState(initial.mode === "json");
  const [text, setText] = useState(initial.text);
  const [raw, setRaw] = useState(initial.raw);
  const [parsed, setParsed] = useState<Record<string, unknown> | null>(initial.parsed);
  const [sourceId, setSourceId] = useState<string | null>(initial.sourceId);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [seen, setSeen] = useState<SeenBaseline | null>(null);
  const [conflictEntity, setConflictEntity] = useState(props.entityKey);
  const scopeRef = useRef("");
  if (conflictEntity !== props.entityKey) {
    setConflictEntity(props.entityKey);
    setConflict(null);
    setSeen(null);
    setError(null);
  }
  const complex = !isSimpleContent(props.content);
  const contentStamp = stableJson(props.content);
  const selectedSource = props.sources?.find((item) => item.id === sourceId) ?? null;
  const sourceBlocked = Boolean(props.sources) && !selectedSource?.usable;

  function currentDraft(next?: Partial<EditorDraft>): EditorDraft {
    return {
      mode: next?.mode ?? (advanced ? "json" : "text"),
      text: next?.text ?? text,
      raw: next?.raw ?? raw,
      parsed: next?.parsed === undefined ? parsed : next.parsed,
      sourceId: next?.sourceId === undefined ? sourceId : next.sourceId,
    };
  }

  function remember(next: EditorDraft) {
    const existing = readDraft(window.sessionStorage, storageKey);
    const baseline = existing ? existing.ifMatch : props.ifMatch;
    const draft = nextDraft(existing, next, baseline, () => crypto.randomUUID());
    writeDraft(window.sessionStorage, storageKey, draft);
    rememberActiveDraft(window.sessionStorage, props.projectId, props.entityKey, storageKey);
    props.onStatus("未保存");
  }

  useEffect(() => {
    const key = activeStorageKey(props.projectId, props.entityKey, props.baseRevisionId);
    const stored = readDraft(window.sessionStorage, key);
    const draft = editorDraftFrom(stored?.payload, props.content, props.initialSourceId ?? null);
    setAdvanced(draft.mode === "json");
    setText(draft.text);
    setRaw(draft.raw);
    setParsed(draft.parsed);
    setSourceId(draft.sourceId);
    const identity = `${props.projectId}:${props.entityKey}`;
    if (scopeRef.current !== identity) {
      scopeRef.current = identity;
      setConflict(null);
      setSeen(null);
      setError(null);
    }
  }, [contentStamp, props.baseRevisionId, props.content, props.entityKey, props.initialSourceId, props.projectId, scope]);

  async function beginConflict(message: string) {
    setConflict(message);
    props.onStatus("版本冲突，草稿保留");
    try {
      const snap = await props.readConflict();
      setSeen(snap);
      persistSeen(storageKey, snap);
    } catch {
      setSeen(null);
      persistSeen(storageKey, null);
      setConflict(`${message} 未能读取新基线，草稿保留。`);
    }
  }

  async function save(force: boolean) {
    const existing = readDraft(window.sessionStorage, storageKey);
    const drift = displayedConflict(existing, props.ifMatch, props.content);
    const shown = drift.blocked && drift.seen ? drift.seen : seen;
    if (!force && (conflict || drift.blocked)) return;
    if (sourceBlocked) {
      setError(selectedSource ? selectedSource.reason : "没有已批准且 CURRENT 的来源");
      return;
    }
    const snapshot = currentDraft();
    let body: Record<string, unknown>;
    try {
      body = contentFromDraft(snapshot, props.content);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "JSON 无效");
      return;
    }
    const ifMatch = force ? shown?.ifMatch : (existing ? existing.ifMatch : props.ifMatch);
    if (ifMatch === undefined || ifMatch === null) return;
    const draft = force
      ? attachSeenBaseline(confirmConflictDraft(existing ?? nextDraft(null, snapshot, ifMatch, () => crypto.randomUUID()), ifMatch, () => crypto.randomUUID()), null)
      : nextDraft(existing, snapshot, ifMatch, () => crypto.randomUUID());
    writeDraft(window.sessionStorage, storageKey, draft);
    rememberActiveDraft(window.sessionStorage, props.projectId, props.entityKey, storageKey);
    props.onStatus("保存中");
    try {
      await props.onSubmit(body, draft, snapshot.sourceId);
      if (releaseSubmittedDraft(window.sessionStorage, storageKey, draft)) {
        clearActiveDraft(window.sessionStorage, props.projectId, props.entityKey);
      }
      setConflict(null);
      setSeen(null);
      setError(null);
      props.onStatus("已保存");
      await props.onSaved();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        await beginConflict(`${caught.code}：${caught.detail}`);
        return;
      }
      setError(caught instanceof ApiError ? `${caught.code}：${caught.detail}` : "保存失败，草稿保留");
      props.onStatus("保存失败，草稿保留");
    }
  }

  const editorDrift = displayedConflict(readDraft(window.sessionStorage, storageKey), props.ifMatch, props.content);
  const shownSeen = editorDrift.blocked && editorDrift.seen ? editorDrift.seen : seen;
  const shownConflict = editorDrift.blocked ? (conflict ?? "编辑基线已变化，草稿保留") : conflict;
  let serverDiff: ReturnType<typeof diffJson> = [];
  if (shownSeen) {
    try {
      serverDiff = diffJson(shownSeen.server, contentFromDraft(currentDraft(), props.content));
    } catch {
      serverDiff = [];
    }
  }

  return (
    <form className="rounded-lg bg-white p-4" onSubmit={(event) => { event.preventDefault(); void save(false); }}>
      <h2 className="font-medium">{props.title}</h2>
      {props.empty ? <p className="mt-2 text-sm">尚无版本。保存将创建第一版。</p> : null}
      {props.extra ? <p className="mt-2 text-sm">{props.extra}</p> : null}
      {props.sources ? (
        <>
          <label className="mt-3 block text-sm" htmlFor="editor-source">来源</label>
          <select id="editor-source" className="mt-1 w-full rounded border px-2 py-1" value={sourceId ?? ""} onChange={(event) => {
            const nextSource = event.target.value || null;
            setSourceId(nextSource);
            remember(currentDraft({ sourceId: nextSource }));
          }}>
            <option value="">选择已批准且 CURRENT 的来源</option>
            {props.sources.map((item) => (
              <option key={item.id} value={item.id} disabled={!item.usable}>{item.label}{item.usable ? "" : ` ${item.reason}`}</option>
            ))}
          </select>
        </>
      ) : null}
      {complex || advanced ? (
        <>
          <label className="mt-3 block text-sm" htmlFor={`${storageKey}-json`}>高级 JSON</label>
          <textarea id={`${storageKey}-json`} className={`${BODY_FIELD} font-mono text-sm`} rows={12} value={raw} onChange={(event) => {
            const nextRaw = event.target.value;
            setRaw(nextRaw);
            try {
              const next = parseContentObject(nextRaw);
              setParsed(next);
              setText(textOf(next));
              remember(currentDraft({ mode: "json", raw: nextRaw, text: textOf(next), parsed: next }));
            } catch {
              setParsed(null);
              remember(currentDraft({ mode: "json", raw: nextRaw, parsed: null }));
              props.onStatus("JSON 尚未完成");
            }
          }} />
        </>
      ) : (
        <>
          <label className="mt-3 block text-sm" htmlFor={`${storageKey}-text`}>正文</label>
          <textarea id={`${storageKey}-text`} className={BODY_FIELD} rows={12} value={text} onChange={(event) => {
            const nextText = event.target.value;
            const next = applyTextContent(parsed ?? props.content, nextText);
            setText(nextText);
            setParsed(next);
            setRaw(JSON.stringify(next, null, 2));
            remember(currentDraft({ mode: "text", text: nextText, raw: JSON.stringify(next, null, 2), parsed: next }));
          }} />
        </>
      )}
      {complex ? <p className="mt-2 text-sm">已有字段会原样保留，不会改成纯文本。</p> : (
        <button className="mt-2 text-sm underline" type="button" onClick={() => {
          if (advanced) {
            try {
              const next = parseContentObject(raw);
              setParsed(next);
              setText(textOf(next));
              setRaw(JSON.stringify(next, null, 2));
              setAdvanced(false);
              remember(currentDraft({ mode: "text", text: textOf(next), raw: JSON.stringify(next, null, 2), parsed: next }));
            } catch {
              setError("JSON 尚未完成，不能返回正文");
            }
            return;
          }
          const next = applyTextContent(parsed ?? props.content, text);
          const nextRaw = JSON.stringify(next, null, 2);
          setParsed(next);
          setRaw(nextRaw);
          setAdvanced(true);
          remember(currentDraft({ mode: "json", text: textOf(next), raw: nextRaw, parsed: next }));
        }}>{advanced ? "返回正文" : "高级 JSON"}</button>
      )}
      <button className="mt-3 rounded bg-red-700 px-4 py-2 text-white disabled:opacity-50" type="submit" disabled={Boolean(shownConflict) || sourceBlocked}>保存新版本</button>
      {sourceBlocked ? <p className="mt-2 text-sm">{selectedSource?.reason || "来源需要是当前、已批准且 CURRENT。"}</p> : null}
      {error ? <p className="mt-2 text-sm" role="alert">{error}</p> : null}
      {shownConflict ? (
        <div className="mt-3 rounded border border-neutral-300 p-3" role="alert">
          <p>{shownConflict}</p>
          <p className="mt-1 text-sm">{shownSeen ? `已看到的并发版本 ${shownSeen.ifMatch}。确认后只按这个版本和新的幂等键提交。` : "草稿已保留。还没有可读的新基线，不能确认提交。"}</p>
          {shownSeen ? <DiffList rows={serverDiff} /> : null}
          <button className="mt-2 rounded border px-3 py-1 disabled:opacity-50" type="button" disabled={!shownSeen} onClick={() => void save(true)}>确认后重新提交</button>
        </div>
      ) : null}
    </form>
  );
}

function EntityPane(props: {
  project: ProjectRecord;
  kind: "character" | "location";
  page: PageState<Aggregate> | null;
  episodes: EpisodeRecord[];
  onMore: () => void;
  onSaved: () => Promise<void>;
  onStatus: (value: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [history, setHistory] = useState<{ aggregate: Aggregate; items: EntityRevision[] } | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyToken, setHistoryToken] = useState(0);
  const historyRequest = useRef(0);
  const sources = props.episodes.flatMap((episode) => {
    const usable = sourceUsable({
      reviewStatus: episode.currentScriptReviewStatus,
      freshnessStatus: episode.currentScriptFreshnessStatus,
      currentId: episode.currentScriptRevisionId,
      approvedId: episode.approvedScriptRevisionId,
      revisionId: episode.currentScriptRevisionId ?? "",
    });
    return episode.currentScriptRevisionId ? [{ id: episode.currentScriptRevisionId, label: `第 ${episode.episodeNo} 集`, ...usable }] : [];
  });
  const usableSource = sources.find((source) => source.usable) ?? null;

  useEffect(() => {
    setSelected(null);
  }, [props.kind, props.project.id]);

  useEffect(() => {
    setHistory(null);
    setHistoryError(null);
  }, [props.kind, props.project.id, selected]);

  useEffect(() => {
    if (!selected) return;
    const request = ++historyRequest.current;
    const entityId = selected;
    void client.get<{ aggregate: Aggregate; items: EntityRevision[] }>(`/projects/${props.project.id}/${props.kind}s/${entityId}/revisions`).then((next) => {
      if (request !== historyRequest.current) return;
      setHistory(next);
      setHistoryError(null);
    }).catch((caught: unknown) => {
      if (request !== historyRequest.current) return;
      setHistory(null);
      setHistoryError(caught instanceof ApiError ? caught.detail : "版本加载失败");
    });
  }, [historyToken, props.kind, props.project.id, selected]);

  const current = history?.items.find((item) => item.id === history.aggregate.currentRevisionId) ?? null;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="space-y-4">
        <section className="rounded-lg bg-white p-4">
          <h2 className="font-medium">{props.kind === "character" ? "角色" : "场地"}</h2>
          {describeRevision(props.page?.items.length ? { id: "list" } : null) === "empty" ? <p className="mt-2 text-sm">列表为空</p> : null}
          <ul className="mt-2 space-y-2">
            {props.page?.items.map((item) => (
              <li key={item.entityId}>
                <button className="underline" type="button" onClick={() => setSelected(item.entityId)}>
                  {item.entityId.slice(0, 8)} · {item.currentRevision ? REVIEW_TEXT[item.currentRevision.reviewStatus] ?? item.currentRevision.reviewStatus : "currentRevision 为空"} · {item.currentRevision ? FRESH_TEXT[item.currentRevision.freshnessStatus] ?? item.currentRevision.freshnessStatus : "无新鲜度"}
                </button>
              </li>
            ))}
          </ul>
          {props.page?.nextCursor ? <button className="mt-2 text-sm underline" type="button" onClick={props.onMore}>加载更多</button> : null}
        </section>
        {historyError ? <p role="alert">{historyError}</p> : null}
        {selected && !history && !historyError ? <p className="text-sm">正在加载版本</p> : null}
        {selected && history?.aggregate.entityId === selected && current ? (
          <ContentEditor
            title="当前版本"
            projectId={props.project.id}
            entityKey={`${props.kind}:${selected}`}
            baseRevisionId={current.id}
            content={current.content}
            empty={false}
            ifMatch={aggregateVersion(props.kind, { entityRowVersion: history.aggregate.rowVersion })}
            sources={sources}
            initialSourceId={current.sourceScriptRevisionId}
            readConflict={async () => {
              const next = await client.get<{ aggregate: Aggregate; items: EntityRevision[] }>(`/projects/${props.project.id}/${props.kind}s/${selected}/revisions`);
              const latest = next.items.find((item) => item.id === next.aggregate.currentRevisionId);
              if (!latest) throw new Error("current revision missing");
              return { ifMatch: next.aggregate.rowVersion, server: latest.content };
            }}
            onStatus={props.onStatus}
            onSubmit={async (content, draft, sourceId) => {
              if (!sourceId) throw new ApiError(400, "SOURCE_UNAVAILABLE", "没有已批准且 CURRENT 的来源");
              await client.write({
                path: `/projects/${props.project.id}/${props.kind}s/${selected}/revisions`,
                body: { sourceScriptRevisionId: sourceId, content },
                idempotencyKey: draft.idempotencyKey,
                ifMatch: draft.ifMatch ?? undefined,
              });
            }}
            onSaved={async () => {
              await props.onSaved();
              setHistoryToken((value) => value + 1);
            }}
          />
        ) : null}
        <NewEntityForm
          project={props.project}
          kind={props.kind}
          source={usableSource}
          onStatus={props.onStatus}
          onSaved={props.onSaved}
        />
      </div>
      {history?.aggregate.entityId === selected ? (
        <RevisionColumn
          items={history.items.map((item) => ({
            id: item.id,
            revisionNo: item.revisionNo,
            reviewStatus: item.reviewStatus,
            freshnessStatus: item.freshnessStatus,
            reviewVersion: item.reviewVersion,
            source: item.sourceScriptRevisionId,
            note: null,
            staleReason: null,
            body: item.content,
          }))}
          currentId={history.aggregate.currentRevisionId}
          nextCursor={null}
          onMore={() => undefined}
          ifMatch={history.aggregate.rowVersion}
          reviewPath={(revisionId) => `/projects/${props.project.id}/${props.kind}s/${history.aggregate.entityId}/revisions/${revisionId}/review`}
          onSaved={async () => {
            await props.onSaved();
            setHistoryToken((value) => value + 1);
          }}
        />
      ) : <p className="text-sm">选择一个对象后显示版本。</p>}
    </div>
  );
}

function NewEntityForm(props: {
  project: ProjectRecord;
  kind: "character" | "location";
  source: { id: string; label: string } | null;
  onStatus: (value: string) => void;
  onSaved: () => Promise<void>;
}) {
  const storageKey = draftStorageKey(props.project.id, `${props.kind}:new`, null);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  function remember(nextName: string, nextText: string) {
    const body = { name: nextName, sourceScriptRevisionId: props.source?.id ?? null, content: applyTextContent({}, nextText) };
    writeDraft(window.sessionStorage, storageKey, nextDraft(readDraft(window.sessionStorage, storageKey), body, props.project.version, () => crypto.randomUUID()));
  }
  useEffect(() => {
    const draft = readDraft(window.sessionStorage, storageKey);
    const payload = draft?.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      setName("");
      setText("");
      return;
    }
    const record = payload as { name?: unknown; content?: unknown };
    setName(typeof record.name === "string" ? record.name : "");
    setText(textOf(record.content));
  }, [storageKey]);

  async function save() {
    if (!props.source) {
      setError("没有已批准且新鲜的剧本来源");
      return;
    }
    const body = { name, sourceScriptRevisionId: props.source.id, content: applyTextContent({}, text) };
    const draft = nextDraft(readDraft(window.sessionStorage, storageKey), body, props.project.version, () => crypto.randomUUID());
    writeDraft(window.sessionStorage, storageKey, draft);
    props.onStatus("保存中");
    try {
      await client.write({
        path: `/projects/${props.project.id}/${props.kind}s`,
        body,
        idempotencyKey: draft.idempotencyKey,
        ifMatch: aggregateVersion(props.kind === "character" ? "character-create" : "location-create", { projectVersion: props.project.version }),
      });
      if (releaseSubmittedDraft(window.sessionStorage, storageKey, draft)) {
        setName("");
        setText("");
      }
      props.onStatus("已保存");
      await props.onSaved();
    } catch (caught) {
      setError(caught instanceof ApiError ? `${caught.code}：${caught.detail}` : "保存失败，草稿保留");
      props.onStatus("保存失败，草稿保留");
    }
  }

  return (
    <form className="rounded-lg bg-white p-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <h2 className="font-medium">新建{props.kind === "character" ? "角色" : "场地"}</h2>
      <label className="mt-2 block text-sm" htmlFor="entity-name">名称</label>
      <input id="entity-name" className="w-full rounded border px-2 py-1" maxLength={LIMITS.name} value={name} onChange={(event) => { setName(event.target.value); remember(event.target.value, text); }} required />
      <label className="mt-2 block text-sm" htmlFor="entity-text">正文</label>
      <textarea id="entity-text" className="w-full rounded border px-2 py-1" rows={6} value={text} onChange={(event) => { setText(event.target.value); remember(name, event.target.value); }} />
      <p className="mt-2 text-sm">来源：{props.source ? props.source.label : "没有可用来源"}</p>
      <button className="mt-3 rounded bg-red-700 px-3 py-2 text-white disabled:opacity-50" disabled={!props.source} type="submit">保存新版本</button>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}

function ScenePane(props: {
  projectId: string;
  episode: EpisodeRecord | null;
  sceneId: string;
  shotId: string | null;
  refreshEpoch: number;
  imageEpoch: number;
  locations: Aggregate[];
  onSaved: () => Promise<void>;
  onStatus: (value: string) => void;
  onOpenShot: (shotId: string) => void;
}) {
  const [history, setHistory] = useState<{ aggregate: Aggregate; items: SceneRevision[] } | null>(null);
  const [shots, setShots] = useState<PageState<Aggregate> | null>(null);
  const [shotHistory, setShotHistory] = useState<{ aggregate: Aggregate; items: ShotRevision[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadToken = useRef(0);

  const load = useCallback(async () => {
    if (!props.episode) return;
    const request = ++loadToken.current;
    const episode = props.episode;
    try {
      const scene = await client.get<{ aggregate: Aggregate; items: SceneRevision[] }>(
        `/projects/${props.projectId}/episodes/${episode.id}/scenes/${props.sceneId}/revisions`,
      );
      const shotPage = await client.get<{ items: Aggregate[]; nextCursor: string | null }>(
        `/projects/${props.projectId}/episodes/${episode.id}/scenes/${props.sceneId}/shots`,
      );
      if (!shouldApplyLoad(request, loadToken.current)) return;
      setHistory(scene);
      setShots(applyPage(null, {
        scope: props.sceneId,
        items: shotPage.items,
        nextCursor: shotPage.nextCursor,
        append: false,
      }));
      if (props.shotId) {
        const nextShot = await client.get<{ aggregate: Aggregate; items: ShotRevision[] }>(`/projects/${props.projectId}/episodes/${episode.id}/scenes/${props.sceneId}/shots/${props.shotId}/revisions`);
        if (!shouldApplyLoad(request, loadToken.current)) return;
        setShotHistory(nextShot);
      } else {
        setShotHistory(null);
      }
      setError(null);
    } catch (caught) {
      if (!shouldApplyLoad(request, loadToken.current)) return;
      setHistory(null);
      setShotHistory(null);
      setError(caught instanceof ApiError ? caught.detail : "场景加载失败");
    }
  }, [props.episode, props.projectId, props.refreshEpoch, props.sceneId, props.shotId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function moreShots() {
    if (!shots?.nextCursor || !props.episode) return;
    const request = loadToken.current;
    const page = await client.get<{ items: Aggregate[]; nextCursor: string | null }>(
      `/projects/${props.projectId}/episodes/${props.episode.id}/scenes/${props.sceneId}/shots?cursor=${encodeURIComponent(shots.nextCursor)}`,
    );
    if (!shouldApplyLoad(request, loadToken.current)) return;
    setShots((currentPage) => applyPage(currentPage, {
      scope: props.sceneId,
      items: page.items,
      nextCursor: page.nextCursor,
      append: true,
    }));
  }

  if (!props.episode) return <p>缺少集数。</p>;
  const visibleHistory = history?.aggregate.entityId === props.sceneId ? history : null;
  const current = visibleHistory?.items.find((item) => item.id === visibleHistory.aggregate.currentRevisionId) ?? null;
  const visibleShot = props.shotId && shotHistory?.aggregate.entityId === props.shotId ? shotHistory : null;
  const shotCurrent = visibleShot ? visibleShot.items.find((item) => item.id === visibleShot.aggregate.currentRevisionId) ?? null : null;
  const shotGate = visibleShot && shotCurrent ? sourceUsable({
    reviewStatus: shotCurrent.reviewStatus,
    freshnessStatus: shotCurrent.freshnessStatus,
    currentId: visibleShot.aggregate.currentRevisionId,
    approvedId: visibleShot.aggregate.approvedRevisionId,
    revisionId: shotCurrent.id,
  }) : { usable: false, reason: "没有当前镜头版本" };
  const sceneSources = (visibleHistory?.items ?? []).map((item) => ({
    id: item.id,
    label: `第 ${item.revisionNo} 版`,
    ...sourceUsable({
      reviewStatus: item.reviewStatus,
      freshnessStatus: item.freshnessStatus,
      currentId: visibleHistory?.aggregate.currentRevisionId ?? null,
      approvedId: visibleHistory?.aggregate.approvedRevisionId ?? null,
      revisionId: item.id,
    }),
  }));
  const sourceScene = shotCurrent ? sceneSources.find((item) => item.id === shotCurrent.sourceSceneRevisionId) : undefined;
  const imageGate = !shotGate.usable
    ? shotGate
    : sourceScene?.usable
      ? { usable: true, reason: "" }
      : { usable: false, reason: sourceScene?.reason ?? "来源场景不可用" };
  const savedPrompt = shotCurrent?.promptText.trim() ?? "";
  const savedDialogue = shotCurrent?.dialogue?.trim() ?? "";
  const videoGate = !imageGate.usable
    ? imageGate
    : savedPrompt.length > 0
      ? { usable: true, reason: "" }
      : { usable: false, reason: "先保存并审核提示词" };
  const speechGate = !imageGate.usable
    ? imageGate
    : savedDialogue.length > 0
      ? { usable: true, reason: "" }
      : { usable: false, reason: "先保存并审核对白" };
  const subtitleGate = speechGate;
  const musicGate = videoGate;
  const locationChoices = props.locations.flatMap((location) => {
    const usable = sourceUsable({
      reviewStatus: location.currentRevision?.reviewStatus ?? null,
      freshnessStatus: location.currentRevision?.freshnessStatus ?? null,
      currentId: location.currentRevisionId,
      approvedId: location.approvedRevisionId,
      revisionId: location.currentRevisionId ?? "",
    });
    return location.currentRevisionId ? [{ id: location.currentRevisionId, label: location.entityId.slice(0, 8), ...usable }] : [];
  });

  return (
    <div className="space-y-4">
      {error ? <p role="alert">{error}</p> : null}
      {visibleHistory && current ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <SceneForm
            projectId={props.projectId}
            episode={props.episode}
            scene={visibleHistory.aggregate}
            current={current}
            locations={locationChoices}
            onStatus={props.onStatus}
            onSubmit={async (body, key, ifMatch) => {
              await client.write({
                path: `/projects/${props.projectId}/episodes/${props.episode?.id}/scenes/${props.sceneId}/revisions`,
                body,
                idempotencyKey: key,
                ifMatch,
              });
            }}
            onSaved={async () => { await props.onSaved(); await load(); }}
          />
          <RevisionColumn
            items={visibleHistory.items.map((item) => ({
              id: item.id,
              revisionNo: item.revisionNo,
              reviewStatus: item.reviewStatus,
              freshnessStatus: item.freshnessStatus,
              reviewVersion: item.reviewVersion,
              source: item.sourceScriptRevisionId,
              note: null,
              staleReason: null,
              body: item,
            }))}
            currentId={visibleHistory.aggregate.currentRevisionId}
            nextCursor={null}
            onMore={() => undefined}
            ifMatch={visibleHistory.aggregate.rowVersion}
            reviewPath={(revisionId) => `/projects/${props.projectId}/episodes/${props.episode?.id}/scenes/${props.sceneId}/revisions/${revisionId}/review`}
            onSaved={async () => { await props.onSaved(); await load(); }}
          />
        </div>
      ) : <p>场景没有当前版本</p>}
      <section className="rounded-lg bg-white p-4">
        <h2 className="font-medium">镜头</h2>
        {shots?.items.length === 0 ? <p className="mt-2 text-sm">还没有镜头</p> : null}
        <ul className="mt-2 space-y-2">
          {shots?.items.map((shot) => (
            <li key={shot.entityId}>
              <button className="underline" type="button" onClick={() => props.onOpenShot(shot.entityId)}>镜头 {shot.entityId.slice(0, 8)}</button>
            </li>
          ))}
        </ul>
        {shots?.nextCursor ? (
          <button className="mt-2 text-sm underline" type="button" onClick={() => void moreShots()}>加载更多镜头</button>
        ) : null}
        {current && visibleHistory ? (
          <ShotCreateForm
            scene={visibleHistory.aggregate}
            source={current}
            projectId={props.projectId}
            episodeId={props.episode.id}
            sceneId={props.sceneId}
            onStatus={props.onStatus}
            onSaved={async () => { await props.onSaved(); await load(); }}
          />
        ) : null}
      </section>
      {props.shotId && visibleShot && shotCurrent ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0 space-y-4">
          <ShotForm
            shot={visibleShot.aggregate}
            current={shotCurrent}
            sources={sceneSources}
            projectId={props.projectId}
            readConflict={async () => {
              const fresh = await client.get<{ aggregate: Aggregate; items: ShotRevision[] }>(`/projects/${props.projectId}/episodes/${props.episode?.id}/scenes/${props.sceneId}/shots/${props.shotId}/revisions`);
              const latest = fresh.items.find((item) => item.id === fresh.aggregate.currentRevisionId);
              if (!latest) throw new Error("current shot missing");
              return { ifMatch: fresh.aggregate.rowVersion, server: latest };
            }}
            onStatus={props.onStatus}
            onSubmit={async (body, key, ifMatch) => {
              await client.write({
                path: `/projects/${props.projectId}/episodes/${props.episode?.id}/scenes/${props.sceneId}/shots/${props.shotId}/revisions`,
                body,
                idempotencyKey: key,
                ifMatch,
              });
            }}
            onSaved={async () => { await props.onSaved(); await load(); }}
          />
          <ShotImagePanel
            currentRevisionId={shotCurrent.id}
            historyKey={visibleShot.items.map((item) => item.id).join("|")}
            usable={imageGate.usable}
            reason={imageGate.reason}
            videoUsable={videoGate.usable}
            videoReason={videoGate.reason}
            speechUsable={speechGate.usable}
            speechReason={speechGate.reason}
            subtitleUsable={subtitleGate.usable}
            subtitleReason={subtitleGate.reason}
            musicUsable={musicGate.usable}
            musicReason={musicGate.reason}
            imageEpoch={props.imageEpoch}
            onAccepted={props.onSaved}
          />
          <ComposePreflight revisionId={shotCurrent.id} refreshEpoch={props.imageEpoch} />
          </div>
          <RevisionColumn
            items={visibleShot.items.map((item) => ({
              id: item.id,
              revisionNo: item.revisionNo,
              reviewStatus: item.reviewStatus,
              freshnessStatus: item.freshnessStatus,
              reviewVersion: item.reviewVersion,
              source: item.sourceSceneRevisionId,
              note: null,
              staleReason: null,
              body: item,
            }))}
            currentId={visibleShot.aggregate.currentRevisionId}
            nextCursor={null}
            onMore={() => undefined}
            ifMatch={visibleShot.aggregate.rowVersion}
            reviewPath={(revisionId) => `/projects/${props.projectId}/episodes/${props.episode?.id}/scenes/${props.sceneId}/shots/${props.shotId}/revisions/${revisionId}/review`}
            onSaved={async () => { await props.onSaved(); await load(); }}
          />
        </div>
      ) : null}
    </div>
  );
}

function SceneForm(props: {
  projectId: string;
  episode: EpisodeRecord;
  scene: Aggregate;
  current: SceneRevision;
  locations: Array<{ id: string; label: string; usable: boolean; reason: string }>;
  onStatus: (value: string) => void;
  onSubmit: (body: unknown, key: string, ifMatch: number) => Promise<void>;
  onSaved: () => Promise<void>;
}) {
  const sceneEntityKey = `scene:${props.scene.entityId}`;
  const storageKey = activeStorageKey(props.projectId, sceneEntityKey, props.current.id);
  const seeded = payloadRecord(readDraft(window.sessionStorage, storageKey)?.payload);
  const [heading, setHeading] = useState(typeof seeded?.heading === "string" ? seeded.heading : props.current.heading);
  const [summary, setSummary] = useState(typeof seeded?.summary === "string" ? seeded.summary : props.current.summary);
  const [timeOfDay, setTimeOfDay] = useState(keptText(seeded, "timeOfDay", props.current.timeOfDay ?? ""));
  const [ordinal, setOrdinal] = useState(typeof seeded?.ordinal === "number" ? String(seeded.ordinal) : String(props.current.ordinal));
  const [locationId, setLocationId] = useState(keptText(seeded, "locationRevisionId", props.current.locationRevisionId ?? ""));
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [serverScene, setServerScene] = useState<SceneRevision | null>(null);
  const [seenVersion, setSeenVersion] = useState<number | null>(null);
  const [conflictEntity, setConflictEntity] = useState(props.scene.entityId);
  if (conflictEntity !== props.scene.entityId) {
    setConflictEntity(props.scene.entityId);
    setConflict(null);
    setServerScene(null);
    setSeenVersion(null);
    setError(null);
  }
  const scriptUsable = sourceUsable({
    reviewStatus: props.episode.currentScriptReviewStatus,
    freshnessStatus: props.episode.currentScriptFreshnessStatus,
    currentId: props.episode.currentScriptRevisionId,
    approvedId: props.episode.approvedScriptRevisionId,
    revisionId: props.episode.currentScriptRevisionId ?? "",
  });

  function body() {
    return {
      sourceScriptRevisionId: props.episode.currentScriptRevisionId,
      locationRevisionId: locationId.length > 0 ? locationId : null,
      ordinal: Number(ordinal),
      heading,
      timeOfDay: timeOfDay.trim().length > 0 ? timeOfDay : null,
      summary,
    };
  }

  function remember(next = body()) {
    const existing = readDraft(window.sessionStorage, storageKey);
    const baseline = existing ? existing.ifMatch : props.scene.rowVersion;
    const draft = nextDraft(existing, next, baseline, () => crypto.randomUUID());
    writeDraft(window.sessionStorage, storageKey, draft);
    rememberActiveDraft(window.sessionStorage, props.projectId, sceneEntityKey, storageKey);
    props.onStatus("未保存");
    return draft;
  }

  useEffect(() => {
    const key = activeStorageKey(props.projectId, sceneEntityKey, props.current.id);
    const record = payloadRecord(readDraft(window.sessionStorage, key)?.payload);
    setHeading(typeof record?.heading === "string" ? record.heading : props.current.heading);
    setSummary(typeof record?.summary === "string" ? record.summary : props.current.summary);
    setTimeOfDay(keptText(record, "timeOfDay", props.current.timeOfDay ?? ""));
    setOrdinal(typeof record?.ordinal === "number" ? String(record.ordinal) : String(props.current.ordinal));
    setLocationId(keptText(record, "locationRevisionId", props.current.locationRevisionId ?? ""));
  }, [props.current.heading, props.current.id, props.current.locationRevisionId, props.current.ordinal, props.current.summary, props.current.timeOfDay, props.projectId, props.scene.entityId, props.scene.rowVersion, sceneEntityKey]);

  async function beginConflict(message: string) {
    setConflict(message);
    props.onStatus("版本冲突，草稿保留");
    try {
      const fresh = await client.get<{ aggregate: Aggregate; items: SceneRevision[] }>(
        `/projects/${props.projectId}/episodes/${props.episode.id}/scenes/${props.scene.entityId}/revisions`,
      );
      const latest = fresh.items.find((item) => item.id === fresh.aggregate.currentRevisionId) ?? null;
      if (!latest) throw new Error("current scene missing");
      const snap = { ifMatch: fresh.aggregate.rowVersion, server: latest };
      setServerScene(latest);
      setSeenVersion(snap.ifMatch);
      persistSeen(storageKey, snap);
    } catch {
      setServerScene(null);
      setSeenVersion(null);
      persistSeen(storageKey, null);
      setConflict(`${message} 未能读取新基线，草稿保留。`);
    }
  }

  async function save(force: boolean) {
    const existing = readDraft(window.sessionStorage, storageKey);
    const drift = displayedConflict(existing, props.scene.rowVersion, props.current);
    const shownVersion = drift.blocked && drift.seen ? drift.seen.ifMatch : seenVersion;
    if (!force && (conflict || drift.blocked)) return;
    const nextBody = body();
    const ifMatch = force ? shownVersion : (existing ? existing.ifMatch : props.scene.rowVersion);
    if (ifMatch === null) return;
    const draft = force
      ? attachSeenBaseline(confirmConflictDraft(existing ?? nextDraft(null, nextBody, ifMatch, () => crypto.randomUUID()), ifMatch, () => crypto.randomUUID()), null)
      : nextDraft(existing, nextBody, ifMatch, () => crypto.randomUUID());
    writeDraft(window.sessionStorage, storageKey, draft);
    rememberActiveDraft(window.sessionStorage, props.projectId, sceneEntityKey, storageKey);
    props.onStatus("保存中");
    try {
      await props.onSubmit(nextBody, draft.idempotencyKey, ifMatch);
      if (releaseSubmittedDraft(window.sessionStorage, storageKey, draft)) {
        clearActiveDraft(window.sessionStorage, props.projectId, `scene:${props.scene.entityId}`);
      }
      setConflict(null);
      setSeenVersion(null);
      setServerScene(null);
      props.onStatus("已保存");
      await props.onSaved();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        await beginConflict(caught.detail);
        return;
      }
      setError(caught instanceof ApiError ? caught.detail : "保存失败，草稿保留");
      props.onStatus("保存失败，草稿保留");
    }
  }

  const sceneDrift = displayedConflict(readDraft(window.sessionStorage, storageKey), props.scene.rowVersion, props.current);
  const shownScene = sceneDrift.blocked && isSceneRevision(sceneDrift.seen?.server) ? sceneDrift.seen.server : serverScene;
  const shownSceneVersion = sceneDrift.blocked && sceneDrift.seen ? sceneDrift.seen.ifMatch : seenVersion;
  const shownSceneConflict = sceneDrift.blocked ? (conflict ?? "编辑基线已变化，草稿保留") : conflict;
  const sceneDiff = shownScene ? diffJson({
    heading: shownScene.heading,
    summary: shownScene.summary,
    timeOfDay: shownScene.timeOfDay,
    ordinal: shownScene.ordinal,
    locationRevisionId: shownScene.locationRevisionId,
  }, body()) : [];

  return (
    <form className="rounded-lg bg-white p-4" onSubmit={(event) => { event.preventDefault(); void save(false); }}>
      <h2 className="font-medium">{props.current.heading}</h2>
      <label className="mt-2 block" htmlFor="edit-heading">标题</label>
      <input id="edit-heading" className="w-full rounded border px-2 py-1" maxLength={LIMITS.heading} value={heading} onChange={(event) => { setHeading(event.target.value); remember({ ...body(), heading: event.target.value }); }} />
      <label className="mt-2 block" htmlFor="edit-ordinal">序号</label>
      <input id="edit-ordinal" className="w-full rounded border px-2 py-1" value={ordinal} onChange={(event) => { setOrdinal(event.target.value); remember({ ...body(), ordinal: Number(event.target.value) }); }} />
      <label className="mt-2 block" htmlFor="edit-time">时间</label>
      <input id="edit-time" className="w-full rounded border px-2 py-1" maxLength={LIMITS.timeOfDay} value={timeOfDay} onChange={(event) => { setTimeOfDay(event.target.value); remember({ ...body(), timeOfDay: event.target.value.trim().length > 0 ? event.target.value : null }); }} />
      <label className="mt-2 block" htmlFor="edit-summary">摘要</label>
      <textarea id="edit-summary" className={BODY_FIELD} maxLength={LIMITS.summary} value={summary} onChange={(event) => { setSummary(event.target.value); remember({ ...body(), summary: event.target.value }); }} />
      <label className="mt-2 block" htmlFor="edit-location">场地</label>
      <select id="edit-location" className="w-full rounded border px-2 py-1" value={locationId} onChange={(event) => { setLocationId(event.target.value); remember({ ...body(), locationRevisionId: event.target.value.length > 0 ? event.target.value : null }); }}>
        <option value="">不引用场地</option>
        {props.locations.map((location) => (
          <option key={location.id} value={location.id} disabled={!location.usable}>{location.label} {location.usable ? "" : location.reason}</option>
        ))}
      </select>
      {!scriptUsable.usable ? <p className="mt-2 text-sm">来源剧本不可用：{scriptUsable.reason}</p> : <p className="mt-2 text-sm">来源剧本 {props.episode.currentScriptRevisionId}</p>}
      <button className="mt-3 rounded bg-red-700 px-3 py-2 text-white disabled:opacity-50" type="submit" disabled={!scriptUsable.usable || Boolean(shownSceneConflict)}>保存新版本</button>
      {error ? <p role="alert">{error}</p> : null}
      {shownSceneConflict ? (
        <div role="alert">
          <p>{shownSceneConflict} 草稿保留。</p>
          <p className="text-sm">{shownSceneVersion !== null ? `已看到的并发版本 ${shownSceneVersion}。确认后只按这个版本提交。` : "还没有可读的新基线，不能确认提交。"}</p>
          {shownScene ? <DiffList rows={sceneDiff} /> : null}
          <button type="button" disabled={shownSceneVersion === null} onClick={() => void save(true)}>确认后重新提交</button>
        </div>
      ) : null}
    </form>
  );
}

function ShotCreateForm(props: {
  scene: Aggregate;
  source: SceneRevision;
  projectId: string;
  episodeId: string;
  sceneId: string;
  onStatus: (value: string) => void;
  onSaved: () => Promise<void>;
}) {
  const usable = sourceUsable({
    reviewStatus: props.source.reviewStatus,
    freshnessStatus: props.source.freshnessStatus,
    currentId: props.scene.currentRevisionId,
    approvedId: props.scene.approvedRevisionId,
    revisionId: props.source.id,
  });
  const [ordinal, setOrdinal] = useState("1");
  const [shotType, setShotType] = useState("中景");
  const [camera, setCamera] = useState("");
  const [action, setAction] = useState("");
  const [dialogue, setDialogue] = useState("");
  const [durationHint, setDurationHint] = useState("");
  const [promptText, setPromptText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const storageKey = draftStorageKey(props.projectId, `shot-new:${props.sceneId}`, null);
  function remember(next: { ordinal: string; shotType: string; camera: string; action: string; dialogue: string; durationHint: string; promptText: string }) {
    const body = {
      sourceSceneRevisionId: props.source.id,
      ordinal: Number(next.ordinal),
      shotType: next.shotType,
      camera: next.camera,
      action: next.action,
      dialogue: next.dialogue.trim().length > 0 ? next.dialogue : null,
      durationHint: next.durationHint.trim().length > 0 ? next.durationHint : null,
      promptText: next.promptText,
    };
    writeDraft(window.sessionStorage, storageKey, nextDraft(readDraft(window.sessionStorage, storageKey), body, props.scene.rowVersion, () => crypto.randomUUID()));
  }
  useEffect(() => {
    const payload = readDraft(window.sessionStorage, storageKey)?.payload;
    const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
    setOrdinal(typeof record?.ordinal === "number" ? String(record.ordinal) : "1");
    setShotType(typeof record?.shotType === "string" ? record.shotType : "中景");
    setCamera(typeof record?.camera === "string" ? record.camera : "");
    setAction(typeof record?.action === "string" ? record.action : "");
    setDialogue(keptText(record, "dialogue", ""));
    setDurationHint(keptText(record, "durationHint", ""));
    setPromptText(typeof record?.promptText === "string" ? record.promptText : "");
  }, [storageKey]);

  async function save() {
    const body = {
      sourceSceneRevisionId: props.source.id,
      ordinal: Number(ordinal),
      shotType,
      camera,
      action,
      dialogue: dialogue.trim().length > 0 ? dialogue : null,
      durationHint: durationHint.trim().length > 0 ? durationHint : null,
      promptText,
    };
    const draft = nextDraft(readDraft(window.sessionStorage, storageKey), body, props.scene.rowVersion, () => crypto.randomUUID());
    writeDraft(window.sessionStorage, storageKey, draft);
    props.onStatus("保存中");
    try {
      await client.write({
        path: `/projects/${props.projectId}/episodes/${props.episodeId}/scenes/${props.sceneId}/shots`,
        body,
        idempotencyKey: draft.idempotencyKey,
        ifMatch: aggregateVersion("shot-create", { entityRowVersion: props.scene.rowVersion }),
      });
      if (releaseSubmittedDraft(window.sessionStorage, storageKey, draft)) {
        setOrdinal("1");
        setShotType("中景");
        setCamera("");
        setAction("");
        setDialogue("");
        setDurationHint("");
        setPromptText("");
      }
      props.onStatus("已保存");
      await props.onSaved();
    } catch (caught) {
      const conflict = caught instanceof ApiError && caught.status === 409;
      setError(caught instanceof ApiError ? `${caught.code}：${caught.detail}${conflict ? "。草稿保留，确认后再次保存才会使用新基线。" : ""}` : "保存失败，草稿保留");
      props.onStatus(conflict ? "版本冲突，草稿保留" : "保存失败，草稿保留");
      if (conflict) await props.onSaved().catch(() => undefined);
    }
  }

  return (
    <form className="mt-4 grid gap-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <h3 className="font-medium">新建镜头</h3>
      {!usable.usable ? <p className="text-sm">来源场景不可用：{usable.reason}</p> : null}
      <label htmlFor="new-shot-ordinal">序号</label>
      <input id="new-shot-ordinal" className="rounded border px-2 py-1" value={ordinal} onChange={(event) => { setOrdinal(event.target.value); remember({ ordinal: event.target.value, shotType, camera, action, dialogue, durationHint, promptText }); }} />
      <label htmlFor="new-shot-type">景别</label>
      <input id="new-shot-type" className="rounded border px-2 py-1" maxLength={LIMITS.shotType} value={shotType} onChange={(event) => { setShotType(event.target.value); remember({ ordinal, shotType: event.target.value, camera, action, dialogue, durationHint, promptText }); }} />
      <label htmlFor="new-shot-camera">镜头</label>
      <input id="new-shot-camera" className="rounded border px-2 py-1" maxLength={LIMITS.camera} value={camera} onChange={(event) => { setCamera(event.target.value); remember({ ordinal, shotType, camera: event.target.value, action, dialogue, durationHint, promptText }); }} />
      <label htmlFor="new-shot-action">动作</label>
      <textarea id="new-shot-action" className={BODY_FIELD} maxLength={LIMITS.action} value={action} onChange={(event) => { setAction(event.target.value); remember({ ordinal, shotType, camera, action: event.target.value, dialogue, durationHint, promptText }); }} />
      <label htmlFor="new-shot-dialogue">对白</label>
      <textarea id="new-shot-dialogue" className={BODY_FIELD} maxLength={LIMITS.dialogue} value={dialogue} onChange={(event) => { setDialogue(event.target.value); remember({ ordinal, shotType, camera, action, dialogue: event.target.value, durationHint, promptText }); }} />
      <label htmlFor="new-shot-duration">时长提示</label>
      <input id="new-shot-duration" className="rounded border px-2 py-1" maxLength={LIMITS.durationHint} value={durationHint} onChange={(event) => { setDurationHint(event.target.value); remember({ ordinal, shotType, camera, action, dialogue, durationHint: event.target.value, promptText }); }} />
      <label htmlFor="new-shot-prompt">提示词</label>
      <textarea id="new-shot-prompt" className={BODY_FIELD} maxLength={LIMITS.promptText} value={promptText} onChange={(event) => { setPromptText(event.target.value); remember({ ordinal, shotType, camera, action, dialogue, durationHint, promptText: event.target.value }); }} />
      <button className="w-fit rounded bg-red-700 px-3 py-2 text-white disabled:opacity-50" type="submit" disabled={!usable.usable}>保存新版本</button>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}

function ShotForm(props: {
  shot: Aggregate;
  current: ShotRevision;
  sources: SourceChoice[];
  projectId: string;
  readConflict: () => Promise<{ ifMatch: number; server: ShotRevision }>;
  onStatus: (value: string) => void;
  onSubmit: (body: unknown, key: string, ifMatch: number) => Promise<void>;
  onSaved: () => Promise<void>;
}) {
  const shotEntityKey = `shot:${props.shot.entityId}`;
  const storageKey = activeStorageKey(props.projectId, shotEntityKey, props.current.id);
  const seeded = payloadRecord(readDraft(window.sessionStorage, storageKey)?.payload);
  const seededSource = keptText(seeded, "sourceSceneRevisionId", props.current.sourceSceneRevisionId);
  const initialSource = props.sources.find((item) => item.id === seededSource && item.usable)?.id ?? "";
  const [shotType, setShotType] = useState(typeof seeded?.shotType === "string" ? seeded.shotType : props.current.shotType);
  const [camera, setCamera] = useState(typeof seeded?.camera === "string" ? seeded.camera : props.current.camera);
  const [action, setAction] = useState(typeof seeded?.action === "string" ? seeded.action : props.current.action);
  const [dialogue, setDialogue] = useState(keptText(seeded, "dialogue", props.current.dialogue ?? ""));
  const [durationHint, setDurationHint] = useState(keptText(seeded, "durationHint", props.current.durationHint ?? ""));
  const [promptText, setPromptText] = useState(typeof seeded?.promptText === "string" ? seeded.promptText : props.current.promptText);
  const [ordinal, setOrdinal] = useState(typeof seeded?.ordinal === "number" ? String(seeded.ordinal) : String(props.current.ordinal));
  const [sourceId, setSourceId] = useState(initialSource);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [serverShot, setServerShot] = useState<ShotRevision | null>(null);
  const [seenVersion, setSeenVersion] = useState<number | null>(null);
  const [conflictEntity, setConflictEntity] = useState(props.shot.entityId);
  if (conflictEntity !== props.shot.entityId) {
    setConflictEntity(props.shot.entityId);
    setConflict(null);
    setServerShot(null);
    setSeenVersion(null);
    setError(null);
  }
  const selectedSource = props.sources.find((item) => item.id === sourceId) ?? null;

  function body(nextSource = sourceId) {
    return {
      sourceSceneRevisionId: nextSource,
      ordinal: Number(ordinal),
      shotType,
      camera,
      action,
      dialogue: dialogue.trim().length > 0 ? dialogue : null,
      durationHint: durationHint.trim().length > 0 ? durationHint : null,
      promptText,
    };
  }

  function remember(next = body()) {
    const existing = readDraft(window.sessionStorage, storageKey);
    const baseline = existing ? existing.ifMatch : props.shot.rowVersion;
    const draft = nextDraft(existing, next, baseline, () => crypto.randomUUID());
    writeDraft(window.sessionStorage, storageKey, draft);
    rememberActiveDraft(window.sessionStorage, props.projectId, shotEntityKey, storageKey);
    props.onStatus("未保存");
  }

  useEffect(() => {
    const key = activeStorageKey(props.projectId, shotEntityKey, props.current.id);
    const record = payloadRecord(readDraft(window.sessionStorage, key)?.payload);
    setShotType(typeof record?.shotType === "string" ? record.shotType : props.current.shotType);
    setCamera(typeof record?.camera === "string" ? record.camera : props.current.camera);
    setAction(typeof record?.action === "string" ? record.action : props.current.action);
    setDialogue(keptText(record, "dialogue", props.current.dialogue ?? ""));
    setDurationHint(keptText(record, "durationHint", props.current.durationHint ?? ""));
    setPromptText(typeof record?.promptText === "string" ? record.promptText : props.current.promptText);
    setOrdinal(typeof record?.ordinal === "number" ? String(record.ordinal) : String(props.current.ordinal));
    const storedSource = keptText(record, "sourceSceneRevisionId", props.current.sourceSceneRevisionId);
    const usable = props.sources.find((item) => item.id === storedSource && item.usable);
    setSourceId(usable?.id ?? "");
  }, [props.current.action, props.current.camera, props.current.dialogue, props.current.durationHint, props.current.id, props.current.ordinal, props.current.promptText, props.current.shotType, props.current.sourceSceneRevisionId, props.projectId, props.shot.entityId, props.shot.rowVersion, props.sources, shotEntityKey]);

  async function beginConflict(message: string) {
    setConflict(message);
    props.onStatus("版本冲突，草稿保留");
    try {
      const snap = await props.readConflict();
      setServerShot(snap.server);
      setSeenVersion(snap.ifMatch);
      persistSeen(storageKey, snap);
    } catch {
      setServerShot(null);
      setSeenVersion(null);
      persistSeen(storageKey, null);
      setConflict(`${message} 未能读取新基线，草稿保留。`);
    }
  }

  async function save(force: boolean) {
    const existing = readDraft(window.sessionStorage, storageKey);
    const drift = displayedConflict(existing, props.shot.rowVersion, props.current);
    const shownVersion = drift.blocked && drift.seen ? drift.seen.ifMatch : seenVersion;
    if (!force && (conflict || drift.blocked)) return;
    if (!selectedSource?.usable) {
      setError(selectedSource?.reason || "来源需要是当前、已批准且 CURRENT。");
      return;
    }
    const nextBody = body();
    const ifMatch = force ? shownVersion : (existing ? existing.ifMatch : props.shot.rowVersion);
    if (ifMatch === null) return;
    const draft = force
      ? attachSeenBaseline(confirmConflictDraft(existing ?? nextDraft(null, nextBody, ifMatch, () => crypto.randomUUID()), ifMatch, () => crypto.randomUUID()), null)
      : nextDraft(existing, nextBody, ifMatch, () => crypto.randomUUID());
    writeDraft(window.sessionStorage, storageKey, draft);
    rememberActiveDraft(window.sessionStorage, props.projectId, shotEntityKey, storageKey);
    try {
      await props.onSubmit(nextBody, draft.idempotencyKey, ifMatch);
      if (releaseSubmittedDraft(window.sessionStorage, storageKey, draft)) {
        clearActiveDraft(window.sessionStorage, props.projectId, `shot:${props.shot.entityId}`);
      }
      setConflict(null);
      setSeenVersion(null);
      setServerShot(null);
      props.onStatus("已保存");
      await props.onSaved();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        await beginConflict(caught.detail);
        return;
      }
      setError(caught instanceof ApiError ? caught.detail : "保存失败，草稿保留");
      props.onStatus("保存失败，草稿保留");
    }
  }

  return (
    <form className="rounded-lg bg-white p-4" onSubmit={(event) => { event.preventDefault(); void save(false); }}>
      <h2 className="font-medium">镜头 {props.current.ordinal}</h2>
      <label htmlFor="shot-type">景别</label>
      <input id="shot-type" className="w-full rounded border px-2 py-1" maxLength={LIMITS.shotType} value={shotType} onChange={(event) => { setShotType(event.target.value); remember({ ...body(), shotType: event.target.value }); }} />
      <label htmlFor="shot-camera">镜头</label>
      <input id="shot-camera" className="w-full rounded border px-2 py-1" maxLength={LIMITS.camera} value={camera} onChange={(event) => { setCamera(event.target.value); remember({ ...body(), camera: event.target.value }); }} />
      <label htmlFor="shot-action">动作</label>
      <textarea id="shot-action" className={BODY_FIELD} maxLength={LIMITS.action} value={action} onChange={(event) => { setAction(event.target.value); remember({ ...body(), action: event.target.value }); }} />
      <label htmlFor="shot-dialogue">对白</label>
      <textarea id="shot-dialogue" className={BODY_FIELD} maxLength={LIMITS.dialogue} value={dialogue} onChange={(event) => { setDialogue(event.target.value); remember({ ...body(), dialogue: event.target.value.trim().length > 0 ? event.target.value : null }); }} />
      <label htmlFor="shot-duration">时长提示</label>
      <input id="shot-duration" className="w-full rounded border px-2 py-1" maxLength={LIMITS.durationHint} value={durationHint} onChange={(event) => { setDurationHint(event.target.value); remember({ ...body(), durationHint: event.target.value.trim().length > 0 ? event.target.value : null }); }} />
      <label htmlFor="shot-prompt">提示词</label>
      <textarea id="shot-prompt" className={BODY_FIELD} maxLength={LIMITS.promptText} value={promptText} onChange={(event) => { setPromptText(event.target.value); remember({ ...body(), promptText: event.target.value }); }} />
      <label htmlFor="shot-ordinal">序号</label>
      <input id="shot-ordinal" className="w-full rounded border px-2 py-1" value={ordinal} onChange={(event) => { setOrdinal(event.target.value); remember({ ...body(), ordinal: Number(event.target.value) }); }} />
      <label className="mt-2 block" htmlFor="shot-source">来源场景</label>
      <select id="shot-source" className="w-full rounded border px-2 py-1" value={sourceId} onChange={(event) => { setSourceId(event.target.value); remember(body(event.target.value)); }}>
        <option value="">选择已批准且 CURRENT 的场景版本</option>
        {props.sources.map((item) => (
          <option key={item.id} value={item.id} disabled={!item.usable}>{item.label}{item.usable ? "" : ` ${item.reason}`}</option>
        ))}
      </select>
      {(() => {
        const shotDrift = displayedConflict(readDraft(window.sessionStorage, storageKey), props.shot.rowVersion, props.current);
        const shownShot = shotDrift.blocked && isShotRevision(shotDrift.seen?.server) ? shotDrift.seen.server : serverShot;
        const shownShotVersion = shotDrift.blocked && shotDrift.seen ? shotDrift.seen.ifMatch : seenVersion;
        const shownShotConflict = shotDrift.blocked ? (conflict ?? "编辑基线已变化，草稿保留") : conflict;
        return (
          <>
            <button className="mt-3 rounded bg-red-700 px-3 py-2 text-white disabled:opacity-50" type="submit" disabled={Boolean(shownShotConflict) || !selectedSource?.usable}>保存新版本</button>
            {!selectedSource?.usable ? <p className="mt-2 text-sm">{selectedSource?.reason || "来源需要是当前、已批准且 CURRENT。"}</p> : null}
            {error ? <p role="alert">{error}</p> : null}
            {shownShotConflict ? (
              <div role="alert">
                <p>{shownShotConflict} 草稿保留。</p>
                <p className="text-sm">{shownShotVersion !== null ? `已看到的并发版本 ${shownShotVersion}。确认后只按这个版本提交。` : "还没有可读的新基线，不能确认提交。"}</p>
                {shownShot ? <DiffList rows={diffJson(shownShot, readDraft(window.sessionStorage, storageKey)?.payload ?? body())} /> : null}
                <button type="button" disabled={shownShotVersion === null} onClick={() => void save(true)}>确认后重新提交</button>
              </div>
            ) : null}
          </>
        );
      })()}
    </form>
  );
}

interface RevisionItem {
  id: string;
  revisionNo: number;
  reviewStatus: string;
  freshnessStatus: string;
  reviewVersion: number;
  source: string;
  note: string | null;
  staleReason: string | null;
  body: unknown;
}

function RevisionColumn(props: {
  items: RevisionItem[];
  currentId: string | null;
  nextCursor: string | null;
  onMore: () => void;
  ifMatch: number;
  reviewPath: (revisionId: string) => string;
  onSaved: () => Promise<void>;
  onOpen?: () => void;
}) {
  const latest = props.items[0];
  const previous = props.items[1];
  const [leftId, setLeftId] = useState(latest?.id ?? "");
  const [rightId, setRightId] = useState(previous?.id ?? "");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pendingReview = useRef<DraftRecord | null>(null);
  const left = props.items.find((item) => item.id === leftId) ?? latest ?? null;
  const right = props.items.find((item) => item.id === rightId) ?? previous ?? null;
  const current = props.items.find((item) => item.id === props.currentId) ?? null;
  const actions = current ? reviewActions({
    reviewStatus: current.reviewStatus,
    freshnessStatus: current.freshnessStatus,
    isCurrent: true,
  }) : [];

  const latestId = props.items[0]?.id ?? "";
  const previousId = props.items[1]?.id ?? "";
  useEffect(() => {
    setLeftId(latestId);
    setRightId(previousId);
  }, [latestId, previousId]);

  async function review(to: string) {
    if (!current) return;
    const body = reviewRequest(current, to, note);
    const draft = nextDraft(pendingReview.current, body, props.ifMatch, () => crypto.randomUUID());
    pendingReview.current = draft;
    try {
      await client.write({
        path: props.reviewPath(current.id),
        body,
        idempotencyKey: draft.idempotencyKey,
        ifMatch: props.ifMatch,
      });
      pendingReview.current = null;
      setError(null);
      await props.onSaved();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        pendingReview.current = null;
        setError(`${caught.code}：${caught.detail}。备注保留。重新读取后再次提交才会使用新基线和新幂等键。`);
        await props.onSaved();
        return;
      }
      setError(caught instanceof ApiError ? `${caught.code}：${caught.detail}。再次提交将复用同一幂等键。` : "审核失败。再次提交将复用同一幂等键。");
    }
  }

  return (
    <aside className="min-w-0 rounded-lg bg-white p-4 [overflow-wrap:anywhere]">
      <h2 className="font-medium">版本</h2>
      {props.onOpen ? <button className="text-sm underline xl:hidden" type="button" onClick={props.onOpen}>在窄屏打开版本栏</button> : null}
      {props.items.length === 0 ? <p className="mt-2 text-sm">没有历史版本</p> : null}
      <ul className="mt-2 space-y-2 text-sm">
        {props.items.map((item) => (
          <li key={item.id} className={item.id === props.currentId ? "font-medium" : ""}>
            第 {item.revisionNo} 版 · {REVIEW_TEXT[item.reviewStatus] ?? item.reviewStatus} · {FRESH_TEXT[item.freshnessStatus] ?? item.freshnessStatus}
            {item.id === props.currentId ? " · 当前" : " · 历史只读"}
          </li>
        ))}
      </ul>
      {props.nextCursor ? <button className="mt-2 text-sm underline" type="button" onClick={props.onMore}>加载更多版本</button> : null}
      <h3 className="mt-4 font-medium">比较</h3>
      {props.items.length < 2 || !left || !right ? <p className="mt-2 text-sm">只有一个版本，无法比较。</p> : (
        <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-2">
          <label>左侧版本
            <select className="mt-1 w-full rounded border px-2 py-1" value={left.id} onChange={(event) => setLeftId(event.target.value)}>
              {props.items.map((item) => <option key={item.id} value={item.id}>第 {item.revisionNo} 版</option>)}
            </select>
          </label>
          <label>右侧版本
            <select className="mt-1 w-full rounded border px-2 py-1" value={right.id} onChange={(event) => setRightId(event.target.value)}>
              {props.items.map((item) => <option key={item.id} value={item.id}>第 {item.revisionNo} 版</option>)}
            </select>
          </label>
          <DiffList rows={diffJson(right.body, left.body)} />
          <p className="text-sm lg:col-span-2">来源 {left.source || "无"} / {right.source || "无"} · 审核 {left.reviewStatus}/{right.reviewStatus} · 新鲜度 {left.freshnessStatus}/{right.freshnessStatus}</p>
        </div>
      )}
      {current ? (
        <div className="mt-4">
          <h3 className="font-medium">审核</h3>
          <p className="text-sm">{REVIEW_TEXT[current.reviewStatus] ?? current.reviewStatus}，新鲜度 {FRESH_TEXT[current.freshnessStatus] ?? current.freshnessStatus}。已通过不等于新鲜。</p>
          {current.staleReason ? <p className="text-sm">过期原因 {current.staleReason}</p> : null}
          {current.source ? <p className="text-sm">来源 {current.source}</p> : null}
          <label className="mt-2 block text-sm" htmlFor={`note-${current.id}`}>备注</label>
          <textarea id={`note-${current.id}`} className="w-full rounded border px-2 py-1" maxLength={LIMITS.reviewNote} value={note} onChange={(event) => setNote(event.target.value)} />
          <div className="mt-2 flex flex-wrap gap-2">
            {actions.map((action) => (
              <button key={action.to} className="rounded border px-2 py-1 disabled:opacity-50" type="button" disabled={!action.enabled} onClick={() => void review(action.to)}>
                {action.label}{action.enabled ? "" : `（${action.reason}）`}
              </button>
            ))}
          </div>
          {error ? <p role="alert">{error}</p> : null}
        </div>
      ) : null}
    </aside>
  );
}

function DiffList({ rows }: { rows: ReturnType<typeof diffJson> }) {
  if (rows.length === 0) return <p className="text-sm">没有内容差异</p>;
  return (
    <ul className="min-w-0 space-y-2 text-sm [overflow-wrap:anywhere] lg:col-span-2">
      {rows.map((row) => (
        <li key={row.path}>
          <p>{row.path} · {row.change === "added" ? "新增" : row.change === "removed" ? "删除" : "修改"}</p>
          {row.lines.length > 0 ? row.lines.map((line, index) => (
            <p key={`${row.path}-${index}`}>{line.kind === "add" ? "+ " : "- "}{line.text}</p>
          )) : <p>{row.before} → {row.after}</p>}
        </li>
      ))}
    </ul>
  );
}

function ShotImagePanel(props: {
  currentRevisionId: string;
  historyKey: string;
  usable: boolean;
  reason: string;
  videoUsable: boolean;
  videoReason: string;
  speechUsable: boolean;
  speechReason: string;
  subtitleUsable: boolean;
  subtitleReason: string;
  musicUsable: boolean;
  musicReason: string;
  imageEpoch: number;
  onAccepted: () => Promise<void>;
}) {
  const [seed, setSeed] = useState("");
  const [videoSeed, setVideoSeed] = useState("");
  const [speechSeed, setSpeechSeed] = useState("");
  const [subtitleSeed, setSubtitleSeed] = useState("");
  const [musicSeed, setMusicSeed] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [videoNotice, setVideoNotice] = useState<string | null>(null);
  const [speechNotice, setSpeechNotice] = useState<string | null>(null);
  const [subtitleNotice, setSubtitleNotice] = useState<string | null>(null);
  const [musicNotice, setMusicNotice] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [videoAcceptError, setVideoAcceptError] = useState<string | null>(null);
  const [speechAcceptError, setSpeechAcceptError] = useState<string | null>(null);
  const [subtitleAcceptError, setSubtitleAcceptError] = useState<string | null>(null);
  const [musicAcceptError, setMusicAcceptError] = useState<string | null>(null);
  const [currentAssets, setCurrentAssets] = useState<ShotAsset[]>([]);
  const [historyAssets, setHistoryAssets] = useState<ShotAsset[]>([]);
  const [previewErrors, setPreviewErrors] = useState<Record<string, boolean>>({});
  const [assetRevision, setAssetRevision] = useState(props.currentRevisionId);
  const [listAttempt, setListAttempt] = useState(0);
  const pending = useRef<{ fingerprint: string; key: string } | null>(null);
  const pendingVideo = useRef<{ fingerprint: string; key: string } | null>(null);
  const pendingSpeech = useRef<{ fingerprint: string; key: string } | null>(null);
  const pendingSubtitle = useRef<{ fingerprint: string; key: string } | null>(null);
  const pendingMusic = useRef<{ fingerprint: string; key: string } | null>(null);
  const requestToken = useRef(0);
  const revisionEpoch = useRef(0);
  const acceptedEpoch = useRef<{ image: number; video: number; speech: number; subtitle: number; music: number }>({
    image: -1, video: -1, speech: -1, subtitle: -1, music: -1,
  });
  if (assetRevision !== props.currentRevisionId) {
    revisionEpoch.current += 1;
    setAssetRevision(props.currentRevisionId);
    setCurrentAssets([]);
    setHistoryAssets([]);
    setPreviewErrors({});
    setListError(null);
    setNotice(null);
    setVideoNotice(null);
    setSpeechNotice(null);
    setSubtitleNotice(null);
    setMusicNotice(null);
    setAcceptError(null);
    setVideoAcceptError(null);
    setSpeechAcceptError(null);
    setSubtitleAcceptError(null);
    setMusicAcceptError(null);
    setBusy(null);
    pending.current = null;
    pendingVideo.current = null;
    pendingSpeech.current = null;
    pendingSubtitle.current = null;
    pendingMusic.current = null;
  }

  useEffect(() => {
    const request = ++requestToken.current;
    const currentId = props.currentRevisionId;
    const historyIds = props.historyKey.split("|").filter((id) => id.length > 0 && id !== currentId);
    let cancelled = false;
    void (async () => {
      try {
        const currentPage = await client.get<{ items: ShotAsset[] }>(`/shot-revisions/${currentId}/assets`);
        if (cancelled || request !== requestToken.current) return;
        const historyPages = await Promise.all(historyIds.map(async (id) => {
          const page = await client.get<{ items: ShotAsset[] }>(`/shot-revisions/${id}/assets`);
          return page.items.filter((item) => item.sourceShotRevisionId === id);
        }));
        if (cancelled || request !== requestToken.current) return;
        setCurrentAssets(currentPage.items.filter((item) => item.sourceShotRevisionId === currentId));
        setHistoryAssets(historyPages.flat());
        setListError(null);
      } catch {
        if (cancelled || request !== requestToken.current) return;
        setListError("媒体列表刷新失败，可以重新查询。");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.currentRevisionId, props.historyKey, props.imageEpoch, listAttempt]);

  function showNotice(channel: MediaChannel, text: string) {
    if (channel === "image") setNotice(text);
    if (channel === "video") setVideoNotice(text);
    if (channel === "speech") setSpeechNotice(text);
    if (channel === "subtitle") setSubtitleNotice(text);
    if (channel === "music") setMusicNotice(text);
  }

  function showAcceptError(channel: MediaChannel, text: string | null) {
    if (channel === "image") setAcceptError(text);
    if (channel === "video") setVideoAcceptError(text);
    if (channel === "speech") setSpeechAcceptError(text);
    if (channel === "subtitle") setSubtitleAcceptError(text);
    if (channel === "music") setMusicAcceptError(text);
  }

  async function requery(channel?: MediaChannel) {
    const epoch = revisionEpoch.current;
    setListAttempt((value) => value + 1);
    try {
      await props.onAccepted();
      if (epoch !== revisionEpoch.current) return;
      if (channel) showAcceptError(channel, null);
    } catch {
      if (epoch !== revisionEpoch.current) return;
      if (channel && acceptedEpoch.current[channel] === epoch) {
        showAcceptError(channel, "刷新失败，可以重新查询。已受理的结果仍然有效。");
        return;
      }
      setListError("媒体列表刷新失败，可以重新查询。");
    }
  }

  async function submitMedia(channel: MediaChannel) {
    const usable = channel === "image" ? props.usable
      : channel === "video" ? props.videoUsable
        : channel === "speech" ? props.speechUsable
          : channel === "subtitle" ? props.subtitleUsable
            : props.musicUsable;
    if (!usable || busy) return;
    const epoch = revisionEpoch.current;
    const revisionId = props.currentRevisionId;
    const value = channel === "image" ? seed
      : channel === "video" ? videoSeed
        : channel === "speech" ? speechSeed
          : channel === "subtitle" ? subtitleSeed
            : musicSeed;
    const slot = channel === "image" ? pending
      : channel === "video" ? pendingVideo
        : channel === "speech" ? pendingSpeech
          : channel === "subtitle" ? pendingSubtitle
            : pendingMusic;
    const fingerprint = `${channel}|${revisionId}|${value}`;
    const key = slot.current?.fingerprint === fingerprint ? slot.current.key : crypto.randomUUID();
    slot.current = { fingerprint, key };
    setBusy(channel);
    if (channel === "image") setNotice(null);
    if (channel === "video") setVideoNotice(null);
    if (channel === "speech") setSpeechNotice(null);
    if (channel === "subtitle") setSubtitleNotice(null);
    if (channel === "music") setMusicNotice(null);
    setListError(null);
    showAcceptError(channel, null);
    const path = channel === "image" ? "generate-image"
      : channel === "video" ? "generate-video"
        : channel === "speech" ? "generate-tts"
          : channel === "subtitle" ? "generate-subtitle"
            : "generate-music";
    const accepted = channel === "image"
      ? "已受理，结果以任务和图片列表为准。这不是生成成功。"
      : channel === "video"
        ? "已受理，结果以任务和视频列表为准。这不是生成成功。"
        : channel === "speech"
          ? "已受理，结果以任务和配音列表为准。这不是生成成功。"
          : channel === "subtitle"
            ? "已受理，结果以任务和字幕列表为准。这不是生成成功。"
            : "已受理，结果以任务和音乐列表为准。这不是生成成功。";
    try {
      const result = await client.write<{ workflowRunId: string }>({
        path: `/shot-revisions/${revisionId}/${path}`,
        body: value.trim().length > 0 ? { seed: value.trim() } : {},
        idempotencyKey: key,
      });
      if (epoch !== revisionEpoch.current) {
        void props.onAccepted().catch(() => undefined);
        return;
      }
      if (slot.current?.key === key) slot.current = null;
      const text = result.status === 202 ? accepted : `已返回 ${result.status}，结果以随后的查询为准。`;
      if (result.status === 202) acceptedEpoch.current[channel] = epoch;
      showNotice(channel, text);
      if (result.status !== 202) return;
      try {
        await props.onAccepted();
      } catch {
        if (epoch !== revisionEpoch.current || acceptedEpoch.current[channel] !== epoch) return;
        showAcceptError(channel, "刷新失败，可以重新查询。已受理的结果仍然有效。");
      }
    } catch (caught) {
      if (epoch !== revisionEpoch.current) return;
      const text = caught instanceof ApiError
        ? `${caught.code}：${caught.detail}。再次提交将复用同一幂等键。`
        : "提交失败，再次提交将复用同一幂等键。";
      showNotice(channel, text);
    } finally {
      if (epoch === revisionEpoch.current) setBusy((current) => current === channel ? null : current);
    }
  }

  const previewError = (id: string) => setPreviewErrors((current) => ({ ...current, [id]: true }));
  const imageCurrent = currentAssets.filter((asset) => asset.kind === "IMAGE");
  const imageHistory = historyAssets.filter((asset) => asset.kind === "IMAGE");
  const videoCurrent = currentAssets.filter((asset) => asset.kind === "VIDEO");
  const videoHistory = historyAssets.filter((asset) => asset.kind === "VIDEO");
  const speechCurrent = currentAssets.filter((asset) => asset.kind === "AUDIO");
  const speechHistory = historyAssets.filter((asset) => asset.kind === "AUDIO");
  const subtitleCurrent = currentAssets.filter((asset) => asset.kind === "SUBTITLE");
  const subtitleHistory = historyAssets.filter((asset) => asset.kind === "SUBTITLE");
  const musicCurrent = currentAssets.filter((asset) => asset.kind === "MUSIC");
  const musicHistory = historyAssets.filter((asset) => asset.kind === "MUSIC");

  return (
    <div className="min-w-0 space-y-4">
      <section className="min-w-0 rounded-lg bg-white p-4">
        <h2 className="font-medium">Mock 图片</h2>
        <p className="mt-2 text-sm [overflow-wrap:anywhere]">演示素材。确定性 1×1 Mock 测试图。seed 只写入快照，不改变像素。这不是真实 AI 图片，也不会写入 MinIO。</p>
        <label className="mt-2 block text-sm" htmlFor="mock-image-seed">seed（可选）</label>
        <input id="mock-image-seed" className="w-full rounded border px-2 py-1" maxLength={200} value={seed} onChange={(event) => setSeed(event.target.value)} />
        <button className="mt-3 rounded bg-red-700 px-3 py-2 text-white disabled:opacity-50" type="button" disabled={!props.usable || busy !== null} onClick={() => void submitMedia("image")}>
          {busy === "image" ? "正在提交" : props.usable ? "生成 Mock 图片" : `生成 Mock 图片（${props.reason}）`}
        </button>
        {notice ? <p className="mt-2 text-sm">{notice}</p> : null}
        {acceptError ? (
          <p className="mt-2 text-sm" role="alert">{acceptError}<button className="ml-2 underline" type="button" onClick={() => void requery("image")}>重新查询</button></p>
        ) : null}
        <AssetList title="当前版本图片" empty="没有图片" assets={imageCurrent} previewErrors={previewErrors} onPreviewError={previewError} />
        <AssetList title="历史版本图片" empty="没有图片" assets={imageHistory} previewErrors={previewErrors} onPreviewError={previewError} />
      </section>
      <section className="min-w-0 rounded-lg bg-white p-4">
        <h2 className="font-medium">Mock 视频</h2>
        <p className="mt-2 text-sm [overflow-wrap:anywhere]">演示素材。固定 16×16 黑色 1 秒测试视频。seed 和已保存提示词只进入审计快照，不改变画面。这不是真实 AI 视频，也不会写入 MinIO。</p>
        <label className="mt-2 block text-sm" htmlFor="mock-video-seed">seed（可选）</label>
        <input id="mock-video-seed" className="w-full rounded border px-2 py-1" maxLength={200} value={videoSeed} onChange={(event) => setVideoSeed(event.target.value)} />
        <button className="mt-3 rounded bg-red-700 px-3 py-2 text-white disabled:opacity-50" type="button" disabled={!props.videoUsable || busy !== null} onClick={() => void submitMedia("video")}>
          {busy === "video" ? "正在提交" : props.videoUsable ? "生成 Mock 视频" : `生成 Mock 视频（${props.videoReason}）`}
        </button>
        {videoNotice ? <p className="mt-2 text-sm">{videoNotice}</p> : null}
        {videoAcceptError ? (
          <p className="mt-2 text-sm" role="alert">{videoAcceptError}<button className="ml-2 underline" type="button" onClick={() => void requery("video")}>重新查询</button></p>
        ) : null}
        <AssetList title="当前版本视频" empty="没有视频" assets={videoCurrent} previewErrors={previewErrors} onPreviewError={previewError} />
        <AssetList title="历史版本视频" empty="没有视频" assets={videoHistory} previewErrors={previewErrors} onPreviewError={previewError} />
      </section>
      <section className="min-w-0 rounded-lg bg-white p-4">
        <h2 className="font-medium">Mock 配音</h2>
        <p className="mt-2 text-sm [overflow-wrap:anywhere]">演示素材。固定 100ms 单声道静音。已保存并审核的对白只作为来源审计，fixture 不会朗读它。这不是真实 TTS，也不会写入 MinIO。</p>
        <label className="mt-2 block text-sm" htmlFor="mock-speech-seed">seed（可选）</label>
        <input id="mock-speech-seed" className="w-full rounded border px-2 py-1" maxLength={200} value={speechSeed} onChange={(event) => setSpeechSeed(event.target.value)} />
        <button className="mt-3 rounded bg-red-700 px-3 py-2 text-white disabled:opacity-50" type="button" disabled={!props.speechUsable || busy !== null} onClick={() => void submitMedia("speech")}>
          {busy === "speech" ? "正在提交" : props.speechUsable ? "生成 Mock 配音" : `生成 Mock 配音（${props.speechReason}）`}
        </button>
        {speechNotice ? <p className="mt-2 text-sm">{speechNotice}</p> : null}
        {speechAcceptError ? (
          <p className="mt-2 text-sm" role="alert">{speechAcceptError}<button className="ml-2 underline" type="button" onClick={() => void requery("speech")}>重新查询</button></p>
        ) : null}
        <AssetList title="当前版本配音" empty="没有配音" assets={speechCurrent} previewErrors={previewErrors} onPreviewError={previewError} />
        <AssetList title="历史版本配音" empty="没有配音" assets={speechHistory} previewErrors={previewErrors} onPreviewError={previewError} />
      </section>
      <section className="min-w-0 rounded-lg bg-white p-4">
        <h2 className="font-medium">Mock 字幕</h2>
        <p className="mt-2 text-sm [overflow-wrap:anywhere]">演示素材。固定测试字幕，内容不随已保存对白变化。seed 只写入快照。这不是真实字幕生成，也不会写入 MinIO。</p>
        <label className="mt-2 block text-sm" htmlFor="mock-subtitle-seed">seed（可选）</label>
        <input id="mock-subtitle-seed" className="w-full rounded border px-2 py-1" maxLength={200} value={subtitleSeed} onChange={(event) => setSubtitleSeed(event.target.value)} />
        <button className="mt-3 rounded bg-red-700 px-3 py-2 text-white disabled:opacity-50" type="button" disabled={!props.subtitleUsable || busy !== null} onClick={() => void submitMedia("subtitle")}>
          {busy === "subtitle" ? "正在提交" : props.subtitleUsable ? "生成 Mock 字幕" : `生成 Mock 字幕（${props.subtitleReason}）`}
        </button>
        {subtitleNotice ? <p className="mt-2 text-sm">{subtitleNotice}</p> : null}
        {subtitleAcceptError ? (
          <p className="mt-2 text-sm" role="alert">{subtitleAcceptError}<button className="ml-2 underline" type="button" onClick={() => void requery("subtitle")}>重新查询</button></p>
        ) : null}
        <AssetList title="当前版本字幕" empty="没有字幕" assets={subtitleCurrent} previewErrors={previewErrors} onPreviewError={previewError} />
        <AssetList title="历史版本字幕" empty="没有字幕" assets={subtitleHistory} previewErrors={previewErrors} onPreviewError={previewError} />
      </section>
      <section className="min-w-0 rounded-lg bg-white p-4">
        <h2 className="font-medium">Mock 音乐</h2>
        <p className="mt-2 text-sm [overflow-wrap:anywhere]">演示素材。固定 100ms 静音，kind 为 MUSIC，与配音 AUDIO 分开。已保存提示词只进入审计快照，不会变成音乐。这不是真实音乐生成，也不会写入 MinIO。</p>
        <label className="mt-2 block text-sm" htmlFor="mock-music-seed">seed（可选）</label>
        <input id="mock-music-seed" className="w-full rounded border px-2 py-1" maxLength={200} value={musicSeed} onChange={(event) => setMusicSeed(event.target.value)} />
        <button className="mt-3 rounded bg-red-700 px-3 py-2 text-white disabled:opacity-50" type="button" disabled={!props.musicUsable || busy !== null} onClick={() => void submitMedia("music")}>
          {busy === "music" ? "正在提交" : props.musicUsable ? "生成 Mock 音乐" : `生成 Mock 音乐（${props.musicReason}）`}
        </button>
        {musicNotice ? <p className="mt-2 text-sm">{musicNotice}</p> : null}
        {musicAcceptError ? (
          <p className="mt-2 text-sm" role="alert">{musicAcceptError}<button className="ml-2 underline" type="button" onClick={() => void requery("music")}>重新查询</button></p>
        ) : null}
        <AssetList title="当前版本音乐" empty="没有音乐" assets={musicCurrent} previewErrors={previewErrors} onPreviewError={previewError} />
        <AssetList title="历史版本音乐" empty="没有音乐" assets={musicHistory} previewErrors={previewErrors} onPreviewError={previewError} />
      </section>
      {listError ? (
        <p className="text-sm" role="alert">{listError}<button className="ml-2 underline" type="button" onClick={() => void requery()}>重新查询</button></p>
      ) : null}
    </div>
  );
}

function AssetList(props: {
  title: string;
  empty: string;
  assets: ShotAsset[];
  previewErrors: Record<string, boolean>;
  onPreviewError: (id: string) => void;
}) {
  return (
    <div className="mt-4 min-w-0">
      <h3 className="font-medium">{props.title}</h3>
      {props.assets.length === 0 ? <p className="mt-2 text-sm">{props.empty}</p> : null}
      <ul className="mt-2 space-y-3">
        {props.assets.map((asset) => {
          const preview = canPreviewAsset(asset);
          const src = `/api/v1/assets/${asset.id}/content`;
          return (
            <li key={asset.id} className="min-w-0 rounded border p-3 text-sm [overflow-wrap:anywhere]">
              <p>资产 {asset.id}</p>
              <p>状态 {asset.status} · 审核 {asset.reviewStatus} · {asset.kind} · {asset.width ?? "无"}×{asset.height ?? "无"} · {asset.durationMs ?? "无"} ms · {asset.byteSize} 字节</p>
              <p>来源镜头版本 {asset.sourceShotRevisionId ?? "无"} · 来源任务 {asset.sourceGenerationJobId ?? "无"}</p>
              <p>创建 {asset.createdAt}</p>
              <p className="break-all">{asset.checksumSha256}</p>
              {preview && !props.previewErrors[asset.id] && asset.kind === "IMAGE" ? (
                <img alt={`镜头图片 ${asset.id}`} className="mt-2 max-w-full" src={src} onError={() => props.onPreviewError(asset.id)} />
              ) : null}
              {preview && !props.previewErrors[asset.id] && asset.kind === "VIDEO" ? (
                <video className="mt-2 max-w-full" controls playsInline preload="metadata" src={src} onError={() => props.onPreviewError(asset.id)} />
              ) : null}
              {preview && !props.previewErrors[asset.id] && asset.kind === "AUDIO" ? (
                <audio className="mt-2 max-w-full" controls preload="metadata" src={src} onError={() => props.onPreviewError(asset.id)} />
              ) : null}
              {preview && !props.previewErrors[asset.id] && asset.kind === "MUSIC" ? (
                <audio className="mt-2 max-w-full" controls preload="metadata" src={src} onError={() => props.onPreviewError(asset.id)} />
              ) : null}
              {preview && !props.previewErrors[asset.id] && asset.kind === "SUBTITLE" ? (
                <SubtitlePreview assetId={asset.id} onError={() => props.onPreviewError(asset.id)} />
              ) : null}
              {preview && props.previewErrors[asset.id] ? <p role="alert">读取或解码失败</p> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface ShotAsset {
  id: string;
  kind: string;
  mimeType: string;
  status: string;
  reviewStatus: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  byteSize: number;
  checksumSha256: string;
  sourceShotRevisionId: string | null;
  sourceGenerationJobId: string | null;
  createdAt: string;
}

function canPreviewAsset(asset: ShotAsset): boolean {
  const visible = asset.status === "ACTIVE" || asset.status === "STALE" || asset.status === "SUPERSEDED";
  if (!visible) return false;
  if (asset.kind === "IMAGE") return asset.mimeType === "image/png";
  if (asset.kind === "VIDEO") return asset.mimeType === "video/mp4";
  if (asset.kind === "AUDIO" || asset.kind === "MUSIC") return asset.mimeType === "audio/wav";
  if (asset.kind === "SUBTITLE") return asset.mimeType === "text/vtt";
  return false;
}

function SubtitlePreview(props: { assetId: string; onError: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const onError = useRef(props.onError);
  onError.current = props.onError;
  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/v1/assets/${props.assetId}/content`).then(async (response) => {
      if (!response.ok) throw new Error("subtitle read failed");
      const body = await response.text();
      if (!cancelled) setText(body);
    }).catch(() => {
      if (!cancelled) onError.current();
    });
    return () => {
      cancelled = true;
    };
  }, [props.assetId]);
  if (text === null) return null;
  return <pre className="mt-2 max-w-full overflow-auto whitespace-pre-wrap text-sm">{text}</pre>;
}

type MediaChannel = "image" | "video" | "speech" | "subtitle" | "music";

function TaskDrawer(props: {
  projectId: string;
  runs: WorkflowRun[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const pendingKeys = useRef<Record<string, string>>({});

  async function start(kind: "mock-scenes" | "mock-shots") {
    const key = pendingKeys.current[kind] ?? crypto.randomUUID();
    pendingKeys.current[kind] = key;
    setPending("已受理，正在读取任务状态");
    try {
      const created = await client.write<{ workflowRunId: string; jobId: string }>({
        path: `/projects/${props.projectId}/workflows/${kind}`,
        body: {},
        idempotencyKey: key,
      });
      delete pendingKeys.current[kind];
      setPending(`任务 ${created.body.workflowRunId} 已受理，状态以随后的查询为准`);
      await props.onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? `${caught.code}：${caught.detail}。再次提交将复用同一幂等键。` : "任务提交失败。再次提交将复用同一幂等键。");
      setPending(null);
    }
  }

  async function act(path: string) {
    const key = pendingKeys.current[path] ?? crypto.randomUUID();
    pendingKeys.current[path] = key;
    try {
      await client.write({ path, body: {}, idempotencyKey: key });
      delete pendingKeys.current[path];
      await props.onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? `${caught.code}：${caught.detail}。再次操作将复用同一幂等键。` : "任务操作失败。再次操作将复用同一幂等键。");
    }
  }

  const textRuns = props.runs.filter((run) => TEXT_WORKFLOW_TYPES.has(run.type));
  const mediaRuns = props.runs.filter((run) => MEDIA_WORKFLOW_TYPES.has(run.type));

  return (
    <div className="fixed inset-y-0 right-0 z-30 w-full max-w-md overflow-auto bg-white p-4 shadow-xl">
      <button className="text-sm underline" type="button" onClick={props.onClose}>关闭任务</button>
      <h2 className="mt-3 font-medium">Mock 文本任务</h2>
      <p className="mt-2 text-sm">Mock 生成场景和 Mock 生成镜头都只处理固定三集，不是一键重新生成，也不会覆盖已占用的 ordinal 1。场景要求三集剧本均已通过且为 CURRENT；镜头还要求对应场景已通过且为 CURRENT。服务端拒绝时以返回原因为准。返回 202 只表示受理，结果从任务和实体查询读取。</p>
      <div className="mt-3 flex gap-2">
        <button className="rounded bg-red-700 px-3 py-2 text-white" type="button" onClick={() => void start("mock-scenes")}>Mock 生成场景</button>
        <button className="rounded bg-red-700 px-3 py-2 text-white" type="button" onClick={() => void start("mock-shots")}>Mock 生成镜头</button>
      </div>
      {pending ? <p className="mt-2 text-sm">{pending}</p> : null}
      {error ? <p className="mt-2 text-sm" role="alert">{error}</p> : null}
      <ul className="mt-4 space-y-3">
        {textRuns.length === 0 ? <li className="text-sm">没有文本任务</li> : null}
        {textRuns.map((run) => (
          <li key={run.id} className="rounded border p-3 text-sm">
            <p>{run.type === "MOCK_TEXT_SCENES" ? "Mock 场景" : "Mock 镜头"} · {taskStatusLabel(run.status)}</p>
            {run.jobs.map((job) => {
              const terminal = job.state === "SUCCEEDED" || job.state === "FAILED" || job.state === "CANCELED";
              return (
                <div key={job.id} className="mt-2">
                  <p>任务 {taskStatusLabel(job.state)}{job.errorCode ? ` · ${job.errorCode}` : ""}</p>
                  {job.errorMessage ? <p>{job.errorMessage}</p> : null}
                  <button className="mr-2 underline disabled:opacity-50" type="button" disabled={terminal} onClick={() => void act(`/generation-jobs/${job.id}/cancel`)}>取消{terminal ? "（已结束）" : ""}</button>
                  <button className="underline disabled:opacity-50" type="button" disabled={job.state !== "FAILED" && job.state !== "CANCELED"} onClick={() => void act(`/generation-jobs/${job.id}/retry`)}>重试{job.state === "FAILED" || job.state === "CANCELED" ? "" : "（尚未失败或取消）"}</button>
                </div>
              );
            })}
          </li>
        ))}
      </ul>
      <h2 className="mt-6 font-medium">Mock 媒体任务</h2>
      <p className="mt-2 text-sm">图片、视频、配音、字幕和音乐任务与文本任务分开。媒体手工重试不可用；需要另一份结果时，在镜头页再次生成并使用新的幂等键。</p>
      <ul className="mt-4 space-y-3">
        {mediaRuns.length === 0 ? <li className="text-sm">没有媒体任务</li> : null}
        {mediaRuns.map((run) => (
          <li key={run.id} className="min-w-0 rounded border p-3 text-sm [overflow-wrap:anywhere]">
            <p>{mediaTaskLabel(run.type)} · {taskStatusLabel(run.status)}</p>
            {run.jobs.map((job) => {
              const terminal = job.state === "SUCCEEDED" || job.state === "FAILED" || job.state === "CANCELED";
              return (
                <div key={job.id} className="mt-2">
                  <p>镜头版本 {job.sourceShotRevisionId ?? "未记录"}</p>
                  <p>任务 {taskStatusLabel(job.state)}{job.errorCode ? ` · ${job.errorCode}` : ""}</p>
                  {job.errorMessage ? <p>{job.errorMessage}</p> : null}
                  <button className="mr-2 underline disabled:opacity-50" type="button" disabled={terminal} onClick={() => void act(`/generation-jobs/${job.id}/cancel`)}>取消{terminal ? "（已结束）" : ""}</button>
                  <button className="underline disabled:opacity-50" type="button" disabled>重试（媒体手工重试不可用，请再次生成）</button>
                </div>
              );
            })}
          </li>
        ))}
      </ul>
    </div>
  );
}
