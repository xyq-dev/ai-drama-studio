"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { StudioClient } from "../lib/studio-client";
import { useProjectBase, type Aggregate } from "../lib/project-base";
import {
  CAPABILITY_TIMEOUT_MS,
  composeBlockedReason,
  composeGates,
  loadComposeCapability,
  loadEntityLists,
  loadEpisodeMedia,
  mediaReadFailed,
  readPages,
  type ComposeCapability,
  type ComposeGate,
} from "../lib/beginner-facts";
import {
  STEPS,
  STEP_STATE_MARK,
  STEP_STATE_TEXT,
  currentStep,
  entityState,
  episodeFinalState,
  episodeForAction,
  episodeForStep,
  episodeNeedingWork,
  episodeSampleState,
  primaryAction,
  scriptState,
  stepStates,
  type BeginnerFacts,
  type EpisodeMediaFacts,
  type ListFacts,
  type PrimaryTarget,
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

type CastKind = "character" | "location";

interface CastProblem {
  kind: CastKind;
  entity: Aggregate;
  state: StepState;
}

/** The characters and locations a cast action is about, from the complete lists. */
function castProblems(facts: BeginnerFacts, wanted: readonly StepState[]): CastProblem[] {
  const pick = (kind: CastKind, list: ListFacts<Aggregate>) => list.items.flatMap((entity) => {
    const state = entityState(entity);
    return wanted.includes(state) ? [{ kind, entity, state }] : [];
  });
  return [...pick("character", facts.characters), ...pick("location", facts.locations)];
}

function castLabel(problem: CastProblem): string {
  return `${problem.kind === "character" ? "角色" : "场地"} · ${problem.entity.name ?? problem.entity.entityId.slice(0, 8)} · ${STEP_STATE_TEXT[problem.state]}`;
}

function StatePill({ state }: { state: StepState }) {
  const tone = state === "done" ? "bg-[#E8F3EA] text-[#1F6B33]"
    : state === "needs_attention" || state === "source_updated" ? "bg-[#FBE7E4] text-[#9E2A27]"
      : "bg-[#F1EFEA] text-[#45434B]";
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-sm ${tone}`}><span aria-hidden="true">{STEP_STATE_MARK[state]}</span>{STEP_STATE_TEXT[state]}</span>;
}

function EpisodeTabs(props: { value: number; onChange: (episodeNo: number) => void; state: (episodeNo: number) => StepState; label: string }) {
  return (
    <div role="tablist" aria-label={props.label} className="creator-episode-tabs flex flex-wrap gap-2">
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
  const [castKind, setCastKind] = useState<CastKind>("character");
  /** The cast entity a primary action opened, and the choice offered when several need the user. */
  const [castFocus, setCastFocus] = useState<{ kind: CastKind; entityId: string; nonce: number } | null>(null);
  const [castChoices, setCastChoices] = useState<CastProblem[] | null>(null);
  /** null while a capability read is in flight (first read or recheck). */
  const [capability, setCapability] = useState<ComposeCapability | null>(null);
  const capabilityToken = useRef(0);
  const capabilityChecking = useRef(false);
  /** The read in flight: its abort controller and its timeout, cleared on answer, timeout, work switch or unmount. */
  const capabilityRead = useRef<{ controller: AbortController; timer: ReturnType<typeof setTimeout> } | null>(null);
  /** A primary action waiting for the next render (after its episode or object was selected). */
  const [pendingFocus, setPendingFocus] = useState<{ target: PrimaryTarget | "choices"; nonce: number } | null>(null);
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
  const nonce = useRef(0);

  // Facts of another project never mix with this one.
  useEffect(() => {
    setProgress(null);
    setCastFocus(null);
    setCastChoices(null);
  }, [projectId]);

  /** Ends the read in flight (if any): its timer is cleared and its request cancelled; its answer can no longer write. */
  const dropCapabilityRead = useCallback(() => {
    capabilityToken.current += 1;
    capabilityChecking.current = false;
    const read = capabilityRead.current;
    capabilityRead.current = null;
    if (read) {
      clearTimeout(read.timer);
      read.controller.abort();
    }
  }, []);

  /**
   * Reads GET /providers/capabilities again, whatever the last answer was. One read at a time; only the latest read
   * may write, so a late answer of an older read (or of another work) never replaces a newer one. While it runs the
   * gates are "pending": nothing new can be composed, and nothing chosen or arranged is cleared. A read without an
   * answer after CAPABILITY_TIMEOUT_MS is cancelled and reported as a timeout by the page's own timer, so the wait
   * ends on time even if the network layer ignores the cancel; the user can then check again.
   */
  const checkCapability = useCallback(() => {
    if (capabilityChecking.current) return;
    const token = ++capabilityToken.current;
    capabilityChecking.current = true;
    setCapability(null);
    // Each read settles once: whichever comes first of answer, failure or timeout decides; anything after it (such as
    // the rejection the timeout's own abort causes) is ignored. The token still drops reads of a previous check, work
    // or mount.
    let settled = false;
    const finish = (value: ComposeCapability) => {
      if (settled || token !== capabilityToken.current) return;
      settled = true;
      const read = capabilityRead.current;
      capabilityRead.current = null;
      if (read) clearTimeout(read.timer);
      capabilityChecking.current = false;
      setCapability(value);
    };
    const controller = new AbortController();
    const timer = setTimeout(() => {
      // Decide the timeout first, then cancel: the cancelled request's rejection can no longer replace it.
      finish({ read: "failed", reason: "timeout" });
      controller.abort();
    }, CAPABILITY_TIMEOUT_MS);
    capabilityRead.current = { controller, timer };
    void loadComposeCapability(client, controller.signal).then(finish);
  }, []);

  // Whether single-shot and episode compose are switched on comes from the server capability, not from whether a
  // list read happened to fail. Each work starts its own read; leaving it (or unmounting) cancels the old one.
  useEffect(() => {
    dropCapabilityRead();
    checkCapability();
    return dropCapabilityRead;
  }, [projectId, checkCapability, dropCapabilityRead]);

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
  const gates = composeGates(capability);

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

  /** The user asked to read progress again: also recheck the compose switches unless both are known open. */
  function rereadAll() {
    refreshFacts();
    if (gates.shot !== "enabled" || gates.episode !== "enabled") checkCapability();
  }

  /** 重新检查功能状态: always a new capability read, plus the progress facts. */
  function recheck() {
    checkCapability();
    refreshFacts();
  }

  useEffect(() => {
    if (!step) return;
    window.history.replaceState(null, "", `/projects/${projectId}/create?step=${step}`);
  }, [step, projectId]);

  const episode = episodes.find((item) => item.episodeNo === episodeNo) ?? null;

  // The scene selection belongs to one approved script revision of one episode. Another episode, a new script
  // revision, or a script that is no longer approved drops it (drafts stay in their own storage); the pane only
  // mounts while that prerequisite holds.
  const sceneScope = episode && scriptState(episode) === "done" ? `${episode.id}:${episode.currentScriptRevisionId}` : null;
  useEffect(() => {
    setSceneId(null);
    setShotId(null);
  }, [sceneScope]);

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
    setCastChoices(null);
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
  // A compose step whose channel is not confirmed open offers no action the server would reject: while the
  // capability is read it waits, otherwise it offers a recheck.
  const gate = info.key === "sample" ? gates.shot : info.key === "final" ? gates.episode : "enabled";
  const closed = state !== "done" && gate !== "enabled";
  const action = closed
    ? { label: gate === "pending" ? "正在检查功能状态" : "重新检查功能状态", target: "reload" as const }
    : primaryAction(info.key, state);
  const save = saveText(drafts, lastEvent);
  /** On a completed step, the episode that still needs work, so the user can go on from there. */
  const unfinished = state === "done" ? episodeNeedingWork(info.key, facts) : null;

  function openCast(problem: CastProblem) {
    setCastKind(problem.kind);
    setCastChoices(null);
    setCastFocus({ kind: problem.kind, entityId: problem.entity.entityId, nonce: ++nonce.current });
  }

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
      if (closed) recheck();
      else rereadAll();
      return;
    }
    // A returned, outdated or waiting character or location: open that object, not the new-entity form.
    if (info.key === "cast" && (action.target === "editor" || action.target === "review")) {
      const problems = castProblems(facts, action.target === "review" ? ["needs_confirmation"] : ["needs_attention", "source_updated"]);
      if (problems.length === 1) {
        openCast(problems[0]!);
        return;
      }
      if (problems.length > 1) {
        setCastChoices(problems);
        setPendingFocus({ target: "choices", nonce: ++nonce.current });
        return;
      }
    }
    // Decided from the facts at click time: a finished episode hands the action to the one that needs it.
    const target = episodeForAction(info.key, facts, episodeNo);
    if (target !== episodeNo) setEpisodeNo(target);
    setPendingFocus({ target: action.target, nonce: ++nonce.current });
  }

  // Focus runs after the render that shows the chosen episode or object.
  useEffect(() => {
    if (!pendingFocus) return;
    setPendingFocus(null);
    // focusTarget reads the DOM only.
    focusTarget(pendingFocus.target);
  }, [pendingFocus]);

  function focusTarget(kind: PrimaryTarget | "choices") {
    const root = body.current;
    if (!root) return;
    const target = kind === "choices"
      ? root.querySelector<HTMLElement>("[data-cast-choices]")
      : kind === "review"
      ? root.querySelector<HTMLElement>("[data-beginner-review], aside[aria-label='检查面板'], [data-review-status]")
      : kind === "candidates"
        ? root.querySelector<HTMLElement>("[aria-label='Mock 单镜合成预检'], [data-beginner-picker]")
        : kind === "compose"
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
      <main className="creator-flow mx-auto max-w-6xl px-4 pb-28 pt-6 lg:pb-10">
        <div className="creator-project-heading flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <a className="creator-back" href="/studio"><span aria-hidden="true">← </span>我的作品</a>
            <h1 className="text-2xl font-semibold [overflow-wrap:anywhere]">{project?.title ?? (loading ? "正在读取作品" : "作品")}</h1>
            <p className="creator-save-status mt-1 text-sm" role="status">保存状态：{save.text}</p>
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
        {!error && base.refreshFailed ? (
          <div className="mt-3 rounded-[12px] border border-[#D34846] bg-white p-3 text-[15px]" role="status">
            <p>{base.refreshPaused
              ? "最新进度多次没有读到，自动重试已暂停；页面上的内容可能不是最新。可以手动重试。"
              : "最新进度暂时没有读到，正在自动重试；页面上的内容可能不是最新。"}</p>
            <button className="mt-2 rounded-[12px] border px-3 py-1.5" type="button" onClick={() => void base.retryNow()}>立即重新读取</button>
          </div>
        ) : null}

        <nav aria-label="创作步骤" className="creator-steps mt-5">
          <ol className="grid grid-cols-5 gap-1 sm:gap-2">
            {STEPS.map((item) => (
              <li key={item.key} className="min-w-0">
                <button type="button" aria-current={item.key === step ? "step" : undefined}
                  aria-label={`第 ${item.no} 步 ${item.title}：${STEP_STATE_TEXT[states[item.key]]}`}
                  className="creator-step-button" data-state={states[item.key]}
                  onClick={() => choose(item.key)}>
                  <span className="creator-step-number" aria-hidden="true">{states[item.key] === "done" ? "✓" : item.no}</span>
                  <span className="creator-step-title">{item.title}</span>
                  <span className="creator-step-state"><span aria-hidden="true">{STEP_STATE_MARK[states[item.key]]}</span><span className="creator-step-state-text"> {STEP_STATE_TEXT[states[item.key]]}</span></span>
                </button>
              </li>
            ))}
          </ol>
        </nav>

        {step ? (
          <section className="creator-step-overview mt-5 rounded-[12px] border border-[#E7E5E0] bg-white p-5 shadow-sm" aria-labelledby="step-title">
            <div className="flex flex-wrap items-center gap-3">
              <h2 id="step-title" className="text-xl font-semibold">第 {info.no} 步 · {info.title}</h2>
              <StatePill state={state} />
            </div>
            <dl className="creator-step-facts mt-3 grid gap-2 text-[15px] sm:grid-cols-3">
              <div><dt className="text-[#5F5D66]">现在在做</dt><dd>{info.doing}</dd></div>
              <div><dt className="text-[#5F5D66]">你需要决定</dt><dd>{info.decide}</dd></div>
              <div><dt className="text-[#5F5D66]">完成后得到</dt><dd>{info.result}</dd></div>
            </dl>
            <StepGuide step={info.key} state={state} />
            {unfinished !== null ? (
              <button className="mt-3 rounded-[12px] border bg-white px-4 py-2 text-[15px]" type="button"
                onClick={() => { setEpisodeNo(unfinished); setPendingFocus({ target: info.key === "sample" ? "candidates" : info.key === "final" ? "compose" : "editor", nonce: ++nonce.current }); }}>
                继续制作第 {unfinished} 集
              </button>
            ) : null}
            <div className="creator-primary-bar fixed inset-x-0 bottom-0 z-10 border-t border-[#E7E5E0] bg-white p-3 lg:static lg:mt-4 lg:border-0 lg:p-0">
              <button className="w-full rounded-[12px] bg-[#D34846] px-5 py-3 font-medium text-white lg:w-auto"
                type="button" onClick={runPrimary} disabled={closed && gate === "pending"}>
                {action.label}
              </button>
            </div>
          </section>
        ) : null}

        <div ref={body} className="creator-flow-body mt-5 space-y-4" data-step={step ?? undefined}>
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
              <div role="tablist" aria-label="人物与场地" className="creator-cast-tabs flex gap-2">
                {(["character", "location"] as const).map((kind) => {
                  // Counts come from the complete lists, not the first page the editor shows.
                  const list = kind === "character" ? facts.characters : facts.locations;
                  return (
                    <button key={kind} role="tab" type="button" aria-selected={castKind === kind}
                      className={`rounded-[12px] border px-3 py-1.5 ${castKind === kind ? "border-[#D34846] bg-[#FBE7E4]" : "bg-white"}`}
                      onClick={() => { setCastKind(kind); setCastFocus(null); }}>
                      {kind === "character" ? "角色" : "场地"} · {list.read !== "ok" ? "尚未确认" : list.items.length === 0 ? "还没有" : `${list.items.filter((item) => entityState(item) === "done").length}/${list.items.length} 已确认`}
                    </button>
                  );
                })}
              </div>
              <p className="text-[15px] text-[#5F5D66]">用文字描述人物的外貌、性格和关系。角色参考图在打开角色后出现；参考图存储尚未启用时会写明，不会拿普通图片代替。项目没有单独的画风字段，想统一画风时请写进描述，并在保存前确认。</p>
              {castChoices ? (
                <div className="rounded-[12px] border border-[#D34846] bg-white p-4 text-[15px]" role="group" aria-label="需要处理的人物与场地" data-cast-choices tabIndex={-1}>
                  <p className="font-medium">有 {castChoices.length} 个对象需要处理，请选一个打开：</p>
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {castChoices.map((problem) => (
                      <li key={`${problem.kind}:${problem.entity.entityId}`}>
                        <button className="rounded-[12px] border px-3 py-1.5" type="button" onClick={() => openCast(problem)}>{castLabel(problem)}</button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <EntityPane project={project} kind={castKind} page={castKind === "character" ? characters : locations} episodes={episodes}
                focus={castFocus && castFocus.kind === castKind ? castFocus : null}
                onMore={() => void base.more(castKind === "character" ? "characters" : "locations")} onSaved={reloadBase} onStatus={onStatus} />
            </>
          ) : null}

          {project && step === "sample" ? (
            <>
              <EpisodeTabs label="选择剧集" value={episodeNo} onChange={setEpisodeNo}
                state={(no) => episodeSampleState(facts, no)} />
              <GateNotice gate={gates.shot} onRetry={recheck}>当前环境没有开启单镜成片所需的功能（Mock 媒体或本地合成），样片暂时不能生成，这一步不会显示为完成。需要管理员在服务端开启后才能继续；其余步骤可以照常进行。</GateNotice>
              {ready && mediaReadFailed(media) ? <ReadFailed onRetry={rereadAll} /> : null}
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
              {sceneId && episode && sceneScope ? (
                <>
                  <LocationNote list={ready ? progress.locations : null} onRetry={rereadAll} />
                  <ScenePane projectId={projectId} episode={episode} sceneId={sceneId} shotId={shotId} refreshEpoch={refreshEpoch}
                    imageEpoch={imageEpoch} locations={sceneLocations(ready ? progress.locations : null, locations?.items ?? [])}
                    onSaved={reloadBase} onStatus={onStatus} onOpenShot={setShotId} onMediaChanged={refreshFacts}
                    shotComposeBlocked={composeBlockedReason(gates.shot, "shot")} />
                </>
              ) : null}
            </>
          ) : null}

          {project && step === "final" ? (
            <>
              <EpisodeTabs label="选择剧集" value={episodeNo} onChange={setEpisodeNo} state={(no) => episodeFinalState(facts, no)} />
              <p className="text-[15px] text-[#5F5D66]">本集至少要有 2 个已确认的单镜成片才能编排，最多 30 个。合成完成后请播放检查，确认通过的当前成片才能下载 MP4 和来源清单；上游内容变化后，旧成片会保留为历史，不能再下载。</p>
              <GateNotice gate={gates.episode} onRetry={recheck}>当前环境没有开启集级合成，单集成片暂时不能生成，这一步不会显示为完成。需要管理员在服务端开启后才能继续。</GateNotice>
              {ready && mediaReadFailed(media) ? <ReadFailed onRetry={rereadAll} /> : null}
              {episode && scriptState(episode) === "done" ? (
                <EpisodeComposePreflight projectId={projectId} episodeNo={episodeNo} episodeId={episode.id} onChanged={refreshFacts}
                  composeBlocked={composeBlockedReason(gates.episode, "episode")} />
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

/**
 * The capability state of one compose channel; nothing for an enabled one. Every state the user can act on carries
 * its own 重新检查功能状态, also when the step is done and the primary action continues or downloads instead.
 */
function GateNotice({ gate, onRetry, children }: { gate: ComposeGate; onRetry: () => void; children: ReactNode }) {
  if (gate === "pending") {
    return <p className="rounded-[12px] border bg-white p-4 text-[15px]" role="status">正在检查服务端的合成功能状态，检查完成前不能开始新的合成。已有成片仍可查看。</p>;
  }
  if (gate === "enabled") return null;
  const text = gate === "disabled" ? children
    : gate === "timeout" ? "功能状态检查超时，请重试。服务端没有在限定时间内回答，暂时无法确认这一步能不能进行；这不代表功能已关闭。"
      : "没能读取服务端的合成功能状态（网络或服务暂时不可用），暂时无法确认这一步能不能进行。这不代表功能已关闭，也不代表还没有候选镜头。";
  return (
    <div className="rounded-[12px] border border-[#D34846] bg-white p-4 text-[15px]" role={gate === "disabled" ? "status" : "alert"}>
      <p>{gate === "disabled" ? <span aria-hidden="true">！ </span> : null}{text}</p>
      <button className="mt-2 rounded-[12px] border px-3 py-1.5" type="button" onClick={onRetry}>重新检查功能状态</button>
    </div>
  );
}

/**
 * Location choices for the scene editor: the complete bounded list when it was read, so a location past the first
 * page can be chosen; the first page only while the complete list is not there.
 */
function sceneLocations(complete: ListFacts<Aggregate> | null, firstPage: Aggregate[]): Aggregate[] {
  if (!complete) return firstPage;
  const known = new Set(complete.items.map((item) => item.entityId));
  return [...complete.items, ...firstPage.filter((item) => !known.has(item.entityId))];
}

function LocationNote({ list, onRetry }: { list: ListFacts<Aggregate> | null; onRetry: () => void }) {
  if (list === null) return <p className="text-[15px] text-[#5F5D66]" role="status">正在读取全部场地，场景里的场地选项暂时只有第一页。</p>;
  if (list.read === "ok") return null;
  if (list.read === "incomplete") {
    return <p className="text-[15px] text-[#5F5D66]" role="status">场地很多，场景里的场地选项只列出已读到的 {list.items.length} 个，不代表全部；其余请在高级编辑中选择。</p>;
  }
  return (
    <div className="rounded-[12px] border border-[#D34846] bg-white p-3 text-[15px]" role="alert">
      <p>场地列表没有读全（读取失败），场景里的场地选项可能不完整。这不代表项目没有其他场地。</p>
      <button className="mt-2 rounded-[12px] border px-3 py-1.5" type="button" onClick={onRetry}>重新读取</button>
    </div>
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
  return <p className="creator-step-guide mt-3 rounded-[12px] bg-[#F7F6F2] p-3 text-[15px]">{text[state]}</p>;
}
