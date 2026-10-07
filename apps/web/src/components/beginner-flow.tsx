"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { StudioClient } from "../lib/studio-client";
import { useProjectBase, type Aggregate } from "../lib/project-base";
import { composeOff, loadEntityLists, loadEpisodeMedia, mediaReadFailed, readPages } from "../lib/beginner-facts";
import {
  STEPS,
  STEP_STATE_MARK,
  STEP_STATE_TEXT,
  currentStep,
  entityState,
  episodeFinalState,
  episodeForStep,
  episodeSampleState,
  primaryAction,
  scriptState,
  stepStates,
  type BeginnerFacts,
  type EpisodeMediaFacts,
  type ListFacts,
  type ReadState,
  type StepKey,
  type StepState,
} from "../lib/beginner-steps";
import { safeUnsavedDrafts, saveText } from "../lib/unsaved-drafts";
import { currentStoryRevision } from "../lib/studio-model";
import { BeginnerShell } from "./beginner-shell";
import { EntityPane, ScenePane, ScriptPane, StoryPane, TaskDrawer } from "./workbench";
import { EpisodeComposePreflight } from "./episode-compose-preflight";
import { ProjectCostSummary } from "./project-cost-summary";

const client = new StudioClient();
const STEP_KEYS = STEPS.map((step) => step.key);

function stepFromUrl(): StepKey | null {
  const value = new URLSearchParams(window.location.search).get("step");
  return STEP_KEYS.includes(value as StepKey) ? (value as StepKey) : null;
}

interface Progress {
  projectId: string;
  media: Record<number, EpisodeMediaFacts>;
  characters: ListFacts<Aggregate>;
  locations: ListFacts<Aggregate>;
}

const UNREAD: ListFacts<Aggregate> = { items: [], read: "incomplete" };

function StatePill({ state }: { state: StepState }) {
  const tone = state === "done" ? "bg-[#E8F3EA] text-[#1F6B33]"
    : state === "needs_attention" || state === "source_updated" ? "bg-[#FBE7E4] text-[#9E2A27]"
      : "bg-[#F1EFEA] text-[#45434B]";
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-sm ${tone}`}><span aria-hidden="true">{STEP_STATE_MARK[state]}</span>{STEP_STATE_TEXT[state]}</span>;
}

function EpisodeTabs(props: { value: number; onChange: (episodeNo: number) => void; state: (episodeNo: number) => StepState; label: string }) {
  return (
    <div role="tablist" aria-label={props.label} className="flex flex-wrap gap-2">
      {[1, 2, 3].map((episodeNo) => (
        <button key={episodeNo} role="tab" type="button" aria-selected={props.value === episodeNo}
          className={`rounded-[12px] border px-3 py-1.5 text-[15px] ${props.value === episodeNo ? "border-[#D34846] bg-[#FBE7E4]" : "bg-white"}`}
          onClick={() => props.onChange(episodeNo)}>
          第 {episodeNo} 集 · <span>{STEP_STATE_MARK[props.state(episodeNo)]} {STEP_STATE_TEXT[props.state(episodeNo)]}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * The beginner flow for one project: 定故事 → 看剧本 → 定人物 → 试一段 → 出成片. Each step mounts the same editors,
 * review columns, task drawer and compose panels the advanced workbench uses; this page adds explanation, the step
 * states derived from server facts and one primary action. It never approves, saves or retries by itself.
 */
export function BeginnerFlow({ projectId }: { projectId: string }) {
  const base = useProjectBase(projectId, "作品读取失败");
  const { project, episodes, stories, characters, locations, allRuns, loading, error, refreshEpoch, imageEpoch,
    reloadBase } = base;
  const [step, setStep] = useState<StepKey | null>(null);
  const [episodeNo, setEpisodeNo] = useState(1);
  const [castKind, setCastKind] = useState<"character" | "location">("character");
  const [sceneId, setSceneId] = useState<string | null>(null);
  const [shotId, setShotId] = useState<string | null>(null);
  const [scenes, setScenes] = useState<{ items: Aggregate[]; read: ReadState } | null>(null);
  const [scenesEpoch, setScenesEpoch] = useState(0);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [lastEvent, setLastEvent] = useState("尚未修改");
  const [draftTick, setDraftTick] = useState(0);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const tasksReturn = useRef<HTMLElement | null>(null);
  const mediaToken = useRef(0);
  const scenesToken = useRef(0);

  // Facts of another project never mix with this one.
  useEffect(() => {
    setProgress(null);
  }, [projectId]);

  // Progress facts (complete entity lists, episode media) follow every base reload, which compose panels trigger
  // when a compose is accepted, finishes or is reviewed. Every read reports how complete it was; an older answer
  // is dropped.
  useEffect(() => {
    if (!project || project.id !== projectId) return;
    const token = ++mediaToken.current;
    void Promise.all([loadEntityLists(client, projectId), loadEpisodeMedia(client, projectId, episodes)]).then(([entities, media]) => {
      if (token !== mediaToken.current) return;
      setProgress({ projectId, media, ...entities });
    });
  }, [project, projectId, episodes, refreshEpoch, imageEpoch]);

  const ready = progress !== null && progress.projectId === projectId;
  const media = ready ? progress.media : {};
  const facts: BeginnerFacts = useMemo(() => ({
    story: currentStoryRevision(stories?.items ?? []), episodes,
    characters: ready ? progress.characters : UNREAD, locations: ready ? progress.locations : UNREAD,
    runs: allRuns, media: ready ? progress.media : {},
  }), [stories, episodes, ready, progress, allRuns]);
  const states = useMemo(() => stepStates(facts), [facts]);
  const off = composeOff(media);

  // First visit waits for every fact, then opens the first step (and episode) that still needs the user;
  // ?step= reopens a chosen step after a refresh.
  useEffect(() => {
    if (step !== null || loading || !project || !ready) return;
    const chosen = stepFromUrl() ?? currentStep(states);
    setStep(chosen);
    setEpisodeNo(episodeForStep(chosen, facts));
  }, [step, loading, project, ready, states, facts]);

  /** Unsaved work in this tab, per object, from the editors' stored drafts. */
  const drafts = useMemo(() => (project ? safeUnsavedDrafts(projectId, episodes) : []),
    // draftTick and lastEvent change whenever an editor reports, so the stored drafts are read again.
    [project, projectId, episodes, draftTick, lastEvent]);

  function onStatus(value: string) {
    setLastEvent(value);
    setDraftTick((tick) => tick + 1);
  }

  /** A compose panel changed facts: reread the base, which rereads the progress facts once. */
  function refreshFacts() {
    void reloadBase().catch(() => undefined);
  }

  useEffect(() => {
    if (!step) return;
    window.history.replaceState(null, "", `/projects/${projectId}/create?step=${step}`);
  }, [step, projectId]);

  const episode = episodes.find((item) => item.episodeNo === episodeNo) ?? null;

  // A different episode means a different scene list: drop the selection that belonged to the old one.
  const episodeId = episode?.id ?? null;
  useEffect(() => {
    setSceneId(null);
    setShotId(null);
  }, [episodeId]);

  // Every scene of the chosen episode for 试一段, page by page; a failed read is not an empty episode.
  // Switching episodes or projects drops a late list.
  useEffect(() => {
    setScenes(null);
    if (step !== "sample" || !episode || scriptState(episode) !== "done") return;
    const token = ++scenesToken.current;
    void readPages<Aggregate>(client, `/projects/${projectId}/episodes/${episode.id}/scenes`).then((list) => {
      if (token === scenesToken.current) setScenes(list);
    });
  }, [step, episode, projectId, refreshEpoch, scenesEpoch]);

  function choose(next: StepKey) {
    setStep(next);
    setEpisodeNo(episodeForStep(next, facts));
    setDraftTick((tick) => tick + 1);
    base.keepScopedPages();
    window.scrollTo({ top: 0 });
  }

  function openTasks() {
    tasksReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTasksOpen(true);
  }

  const stepIndex = STEPS.findIndex((item) => item.key === step);
  const info = STEPS[stepIndex] ?? STEPS[0]!;
  const state = step ? states[step] : "not_started";
  const action = primaryAction(info.key, state);
  const save = saveText(drafts, lastEvent);

  function runPrimary() {
    if (action.target === "next") {
      const next = STEPS[stepIndex + 1];
      if (next) choose(next.key);
      return;
    }
    if (action.target === "tasks") {
      openTasks();
      return;
    }
    if (action.target === "reload") {
      refreshFacts();
      return;
    }
    const root = body.current;
    if (!root) return;
    const target = action.target === "review"
      ? root.querySelector<HTMLElement>("[data-beginner-review], aside[aria-label='检查面板'], [data-review-status]")
      : action.target === "candidates"
        ? root.querySelector<HTMLElement>("[aria-label='Mock 单镜合成预检'], [data-beginner-picker]")
        : action.target === "compose"
          ? root.querySelector<HTMLElement>("[aria-label='多镜编排']")
          : root.querySelector<HTMLElement>("textarea, input:not([type='hidden'])");
    (target ?? root).scrollIntoView({ block: "start" });
    const focusable = target?.matches("textarea, input, button, select") ? target
      : target?.querySelector<HTMLElement>("textarea, button, select, input");
    focusable?.focus();
  }

  function advancedHref(): string {
    switch (info.key) {
      case "story": return `/projects/${projectId}?focus=story`;
      case "script": return `/projects/${projectId}?focus=script&episode=${episodeNo}`;
      case "cast": return `/projects/${projectId}?focus=${castKind}`;
      case "sample": return sceneId
        ? `/projects/${projectId}?focus=${shotId ? "shot" : "scene"}&episode=${episodeNo}&scene=${sceneId}${shotId ? `&shot=${shotId}` : ""}`
        : `/projects/${projectId}?focus=script&episode=${episodeNo}`;
      default: return `/projects/${projectId}?focus=episode-compose&episode=${episodeNo}`;
    }
  }

  function later() {
    if (safeUnsavedDrafts(projectId, episodes).length > 0) {
      setLeaving(true);
      return;
    }
    window.location.assign("/studio");
  }

  return (
    <BeginnerShell>
      <main className="mx-auto max-w-6xl px-4 pb-28 pt-6 lg:pb-10">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-[#5F5D66]">我的作品</p>
            <h1 className="text-2xl font-semibold [overflow-wrap:anywhere]">{project?.title ?? (loading ? "正在读取作品" : "作品")}</h1>
            <p className="mt-1 text-sm" role="status">保存状态：{save.text}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-[15px]">
            <button className="rounded-[12px] border bg-white px-3 py-1.5" type="button" onClick={later}>稍后继续</button>
            <a className="text-[#5F5D66] underline" href={advancedHref()}>高级编辑</a>
          </div>
        </div>
        {leaving ? (
          <div className="mt-3 rounded-[12px] border border-[#D34846] bg-white p-4" role="alert">
            <p className="font-medium">还有未保存的修改</p>
            <p className="mt-1 text-[15px]">草稿只保存在当前浏览器标签页。关闭浏览器或换设备后不保证能恢复。</p>
            <div className="mt-3 flex flex-wrap gap-3">
              <button className="rounded-[12px] bg-[#D34846] px-4 py-2 text-white" type="button" onClick={() => { setLeaving(false); runPrimary(); }}>回到编辑去保存</button>
              <a className="rounded-[12px] border px-4 py-2" href="/studio">保留本标签页草稿并离开</a>
            </div>
          </div>
        ) : null}
        {error ? <p className="mt-3 rounded-[12px] border border-[#D34846] bg-white p-3" role="alert">作品读取失败：{error}</p> : null}

        <nav aria-label="创作步骤" className="mt-5">
          <ol className="grid grid-cols-5 gap-1 sm:gap-2">
            {STEPS.map((item) => (
              <li key={item.key} className="min-w-0">
                <button type="button" aria-current={item.key === step ? "step" : undefined}
                  aria-label={`第 ${item.no} 步 ${item.title}：${STEP_STATE_TEXT[states[item.key]]}`}
                  className={`flex w-full min-w-0 flex-col items-start rounded-[12px] border px-2 py-2 text-left sm:px-3 ${item.key === step ? "border-[#D34846] bg-[#FBE7E4]" : "bg-white"}`}
                  onClick={() => choose(item.key)}>
                  <span className="text-sm font-medium">{item.no}<span className="hidden sm:inline"> {item.title}</span></span>
                  <span className="sr-only sm:not-sr-only text-xs text-[#5F5D66]">{STEP_STATE_MARK[states[item.key]]} {STEP_STATE_TEXT[states[item.key]]}</span>
                  <span className="text-xs sm:hidden" aria-hidden="true">{STEP_STATE_MARK[states[item.key]]}</span>
                </button>
              </li>
            ))}
          </ol>
        </nav>

        {step ? (
          <section className="mt-5 rounded-[12px] border border-[#E7E5E0] bg-white p-5 shadow-sm" aria-labelledby="step-title">
            <div className="flex flex-wrap items-center gap-3">
              <h2 id="step-title" className="text-xl font-semibold">第 {info.no} 步 · {info.title}</h2>
              <StatePill state={state} />
            </div>
            <dl className="mt-3 grid gap-2 text-[15px] sm:grid-cols-3">
              <div><dt className="text-[#5F5D66]">现在在做</dt><dd>{info.doing}</dd></div>
              <div><dt className="text-[#5F5D66]">你需要决定</dt><dd>{info.decide}</dd></div>
              <div><dt className="text-[#5F5D66]">完成后得到</dt><dd>{info.result}</dd></div>
            </dl>
            <StepGuide step={info.key} state={state} />
            <div className="fixed inset-x-0 bottom-0 z-10 border-t border-[#E7E5E0] bg-white p-3 lg:static lg:mt-4 lg:border-0 lg:p-0">
              <button className="w-full rounded-[12px] bg-[#D34846] px-5 py-3 font-medium text-white lg:w-auto"
                type="button" onClick={runPrimary}>
                {action.label}
              </button>
            </div>
          </section>
        ) : null}

        <div ref={body} className="mt-5 space-y-4">
          {project && step === "story" ? (
            <StoryPane project={project} stories={stories} onMore={() => void base.more("stories")} onSaved={reloadBase} onStatus={onStatus} />
          ) : null}

          {project && step === "script" ? (
            episodes.length === 0 ? (
              <p className="rounded-[12px] border bg-white p-4">故事确认通过后，服务器会建立固定的三集。请先完成第 1 步。</p>
            ) : (
              <>
                <EpisodeTabs label="选择剧集" value={episodeNo} onChange={setEpisodeNo}
                  state={(no) => scriptState(episodes.find((item) => item.episodeNo === no))} />
                <p className="text-[15px] text-[#5F5D66]">审核只针对当前展示的这一集、这一个版本；其他集要分别打开检查。剧本里写到的场面还不是场景或镜头记录，它们在「试一段」里单独建立。</p>
                <ScriptPane projectId={projectId} projectVersion={project.version} episode={episode}
                  storyCurrent={currentStoryRevision(stories?.items ?? [])} premise={project.premise} refreshEpoch={refreshEpoch}
                  onSaved={reloadBase} onStatus={onStatus}
                  onOpenScene={(id) => { setSceneId(id); setStep("sample"); }} />
              </>
            )
          ) : null}

          {project && step === "cast" ? (
            <>
              <div role="tablist" aria-label="人物与场地" className="flex gap-2">
                {(["character", "location"] as const).map((kind) => {
                  // Counts come from the complete lists, not the first page the editor shows.
                  const list = kind === "character" ? facts.characters : facts.locations;
                  return (
                    <button key={kind} role="tab" type="button" aria-selected={castKind === kind}
                      className={`rounded-[12px] border px-3 py-1.5 ${castKind === kind ? "border-[#D34846] bg-[#FBE7E4]" : "bg-white"}`}
                      onClick={() => setCastKind(kind)}>
                      {kind === "character" ? "角色" : "场地"} · {list.read !== "ok" ? "尚未确认" : list.items.length === 0 ? "还没有" : `${list.items.filter((item) => entityState(item) === "done").length}/${list.items.length} 已确认`}
                    </button>
                  );
                })}
              </div>
              <p className="text-[15px] text-[#5F5D66]">用文字描述人物的外貌、性格和关系。角色参考图在打开角色后出现；参考图存储尚未启用时会写明，不会拿普通图片代替。项目没有单独的画风字段，想统一画风时请写进描述，并在保存前确认。</p>
              <EntityPane project={project} kind={castKind} page={castKind === "character" ? characters : locations} episodes={episodes}
                onMore={() => void base.more(castKind === "character" ? "characters" : "locations")} onSaved={reloadBase} onStatus={onStatus} />
            </>
          ) : null}

          {project && step === "sample" ? (
            <>
              <EpisodeTabs label="选择剧集" value={episodeNo} onChange={setEpisodeNo}
                state={(no) => episodeSampleState(facts, no)} />
              {off.sample ? <Notice>当前环境没有开启单镜成片所需的功能（Mock 媒体或本地合成），样片暂时不能生成，这一步不会显示为完成。需要管理员在服务端开启后才能继续；其余步骤可以照常进行。</Notice> : null}
              {ready && mediaReadFailed(media) ? <ReadFailed onRetry={refreshFacts} /> : null}
              <div className="rounded-[12px] border border-[#E7E5E0] bg-white p-4 text-[15px]">
                <p className="font-medium">样片说明</p>
                <ul className="mt-1 list-disc pl-5">
                  <li>画面、视频、配音、字幕、音乐都是<strong>演示素材</strong>，不是真实 AI 拍摄。演示视频约 1 秒。</li>
                  <li>镜头里的「时长提示」是写给拍摄的建议，不等于视频的实际时长；实际时长以成片播放为准。</li>
                  <li>检查人物是否对、声音和字幕是否对得上、节奏是否合适。确认样片只审核这一个单镜成片，不会顺带批准其他镜头或全剧。</li>
                  <li>想改画面内容时，修改镜头的动作、对白或提示词并保存新版本，再重新生成；用一句话描述的修改不会自动执行。</li>
                </ul>
              </div>
              {!episode || scriptState(episode) !== "done" ? (
                <p className="rounded-[12px] border bg-white p-4">这一集的剧本还没有确认通过。请先在「看剧本」里完成审核。</p>
              ) : (
                <div className="rounded-[12px] border border-[#E7E5E0] bg-white p-4" data-beginner-picker>
                  <h3 className="font-medium">选一个代表性镜头</h3>
                  {scenes === null ? <p className="mt-2" role="status">正在读取场景</p> : null}
                  {scenes && scenes.read !== "ok" && scenes.read !== "incomplete" ? (
                    <div className="mt-2 text-[15px]" role="alert">
                      <p>场景列表读取失败，不能确定这一集有没有场景。请重试，不要因此重复添加场景。</p>
                      <button className="mt-2 rounded-[12px] border px-3 py-1.5" type="button" onClick={() => setScenesEpoch((value) => value + 1)}>重新读取场景</button>
                    </div>
                  ) : null}
                  {scenes && scenes.read === "incomplete" ? <p className="mt-2 text-[15px]">场景很多，这里只列出前 {scenes.items.length} 个；其余请在高级编辑中打开。</p> : null}
                  {scenes && scenes.read === "ok" && scenes.items.length === 0 ? (
                    <div className="mt-2 text-[15px]">
                      <p>这一集还没有场景。场景和镜头是单独的记录，需要先建立：</p>
                      <ol className="mt-1 list-decimal pl-5">
                        <li>在任务面板用「Mock 生成场景」，再用「Mock 生成镜头」（需要三集剧本都已通过）；或</li>
                        <li>到高级编辑手动添加场景。</li>
                      </ol>
                      <button className="mt-2 rounded-[12px] border px-3 py-1.5" type="button" onClick={openTasks}>打开任务面板</button>
                    </div>
                  ) : null}
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {scenes?.items.map((scene, index) => (
                      <li key={scene.entityId}>
                        <button type="button" aria-pressed={sceneId === scene.entityId}
                          className={`rounded-[12px] border px-3 py-1.5 ${sceneId === scene.entityId ? "border-[#D34846] bg-[#FBE7E4]" : ""}`}
                          onClick={() => { setSceneId(scene.entityId); setShotId(null); }}>
                          场景 {index + 1} · {STEP_STATE_TEXT[entityState(scene)]}
                        </button>
                      </li>
                    ))}
                  </ul>
                  {sceneId && !shotId ? <p className="mt-2 text-[15px] text-[#5F5D66]">在下方场景里打开一个镜头，就会看到它的素材生成和单镜合成。</p> : null}
                </div>
              )}
              {sceneId && episode ? (
                <ScenePane projectId={projectId} episode={episode} sceneId={sceneId} shotId={shotId} refreshEpoch={refreshEpoch}
                  imageEpoch={imageEpoch} locations={locations?.items ?? []} onSaved={reloadBase} onStatus={onStatus}
                  onOpenShot={setShotId} onMediaChanged={refreshFacts} />
              ) : null}
            </>
          ) : null}

          {project && step === "final" ? (
            <>
              <EpisodeTabs label="选择剧集" value={episodeNo} onChange={setEpisodeNo} state={(no) => episodeFinalState(facts, no)} />
              <p className="text-[15px] text-[#5F5D66]">本集至少要有 2 个已确认的单镜成片才能编排，最多 30 个。合成完成后请播放检查，确认通过的当前成片才能下载 MP4 和来源清单；上游内容变化后，旧成片会保留为历史，不能再下载。</p>
              {off.final ? <Notice>当前环境没有开启集级合成，单集成片暂时不能生成，已有成片也无法在这里确认，这一步不会显示为完成。需要管理员在服务端开启后才能继续。</Notice> : null}
              {ready && mediaReadFailed(media) ? <ReadFailed onRetry={refreshFacts} /> : null}
              {episode && scriptState(episode) === "done" ? (
                <EpisodeComposePreflight projectId={projectId} episodeNo={episodeNo} episodeId={episode.id} onChanged={refreshFacts} />
              ) : (
                <p className="rounded-[12px] border bg-white p-4">
                  {episodeFinalState(facts, episodeNo) === "source_updated"
                    ? "这一集的剧本改过了，原来批准的成片已标为历史（来源已更新）。请先在「看剧本」确认新版本，再重新试做样片和编排。"
                    : "这一集的剧本还没有确认通过，暂时不能编排成片。"}
                </p>
              )}
              <section className="rounded-[12px] border border-[#E7E5E0] bg-white p-4" aria-label="费用">
                <h3 className="font-medium">费用</h3>
                <p className="mt-1 text-[15px] text-[#5F5D66]">只显示已经记录的费用：实际、估算和未知分开列出。本地编码没有计量，不代表免费。</p>
                <ProjectCostSummary projectId={projectId} />
              </section>
            </>
          ) : null}
        </div>
      </main>
      {tasksOpen ? (
        <TaskDrawer projectId={projectId} runs={allRuns} onClose={() => { setTasksOpen(false); tasksReturn.current?.focus(); }} onChanged={reloadBase} />
      ) : null}
    </BeginnerShell>
  );
}

/** A server-reported closed feature; nothing here pretends a result exists. */
function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-[12px] border border-[#D34846] bg-white p-4 text-[15px]" role="status">
      <span aria-hidden="true">！</span> {children}
    </p>
  );
}

function ReadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-[12px] border border-[#D34846] bg-white p-4 text-[15px]" role="alert">
      <p>部分进度读取失败，相关剧集显示为「尚未确认」，不会据此判断为完成。</p>
      <button className="mt-2 rounded-[12px] border px-3 py-1.5" type="button" onClick={onRetry}>重新读取进度</button>
    </div>
  );
}

/** One plain sentence on what to do now, from the step's real state. */
function StepGuide({ step, state }: { step: StepKey; state: StepState }) {
  const text: Record<StepState, string> = {
    not_started: "上一步还没有完成，完成后这里就能开始。",
    needs_input: step === "story" ? "在下方写下故事并「保存新版本」。没有思路时可以用编剧助手：先准备创作要求，再把外部 AI 或站内千问的候选导入预览、比较后采纳到草稿。"
      : step === "script" ? "这一集还没有剧本。可以自己写，也可以用编剧助手生成候选后采纳，再保存。"
        : step === "cast" ? "添加主要角色，写下外貌、性格和关系，然后保存并提交审核。"
          : step === "sample" ? "选一个场景里的镜头，为它生成演示视频，再做单镜合成。"
            : "在下方选择已确认的单镜成片，排好顺序，预检后提交合成。",
    needs_confirmation: "有内容等你检查。请读完当前展示的版本，在版本栏里提交审核或确认通过；审核只针对你看到的这个版本。",
    in_progress: "任务正在处理，结果出来后这里会自动刷新。可以先去做别的。",
    needs_attention: "有内容被退回或任务失败。看清原因后修改并保存新版本；只有符合规则的任务才提供重试。",
    done: "这一步已经完成。可以回看，也可以继续下一步。",
    source_updated: step === "sample" || step === "final"
      ? "上游内容改过了，原来批准的成片已成为历史（审核记录保留，但不能再下载或用于编排）。请重新试做样片或重新编排合成。"
      : "上游内容改过了，这里的已确认版本已过期，不能再次批准。原来的审核记录会保留；请修改后保存新版本，再提交审核。",
    unknown: "这一步的部分进度没有读到（读取失败、功能未开启或列表还没读完），暂时不能确认是否完成。",
  };
  return <p className="mt-3 rounded-[12px] bg-[#F7F6F2] p-3 text-[15px]">{text[state]}</p>;
}
