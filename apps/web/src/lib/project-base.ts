"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, StudioClient } from "./studio-client";
import { TEXT_WORKFLOW_TYPES, applyPage, shouldApplyLoad, shouldPoll, type PageState } from "./studio-model";

/**
 * The project data both the advanced workbench and the beginner flow read: project, episodes, story revisions,
 * characters, locations and tracked workflow runs. Loading, stale-answer dropping and workflow polling live here once
 * so the two views cannot drift apart.
 */
export interface ProjectRecord {
  id: string;
  title: string;
  premise: string;
  version: number;
  status: string;
}

export interface EpisodeRecord {
  id: string;
  episodeNo: number;
  title: string;
  rowVersion: number;
  currentScriptRevisionId: string | null;
  approvedScriptRevisionId: string | null;
  currentScriptReviewStatus: string | null;
  currentScriptFreshnessStatus: string | null;
}

export interface StoryRevision {
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

export interface Aggregate {
  entityId: string;
  /** Characters and locations: the display name (read-only, from the list). */
  name?: string;
  rowVersion: number;
  currentRevisionId: string | null;
  approvedRevisionId: string | null;
  currentRevision: { reviewStatus: string; freshnessStatus: string; reviewVersion: number } | null;
}

export interface WorkflowAttempt {
  attemptNo: number;
  providerKey: string | null;
  model: string | null;
  status: "running" | "finished";
  errorCode: string | null;
  durationMs: number | null;
  inputHash: string | null;
  cost: { status: "recorded"; amount: string; currency: string; kind: string }
    | { status: "unknown"; amount: null; currency: null; kind: null };
}

export interface WorkflowJob {
  id: string;
  kind: string;
  state: string;
  errorCode: string | null;
  errorMessage: string | null;
  sourceShotRevisionId?: string | null;
  /** Episode-level compose jobs only: the episode frozen in the job input. */
  composeEpisodeId?: string | null;
  attempts?: WorkflowAttempt[];
}

export interface WorkflowRun {
  id: string;
  type: string;
  status: string;
  createdAt: string;
  jobs: WorkflowJob[];
}

export const MEDIA_WORKFLOW_TYPES = new Set(["MEDIA_IMAGE", "MEDIA_VIDEO", "MEDIA_TTS", "MEDIA_SUBTITLE", "MEDIA_MUSIC"]);

export function trackedWorkflow(run: { type: string }): boolean {
  return TEXT_WORKFLOW_TYPES.has(run.type) || MEDIA_WORKFLOW_TYPES.has(run.type);
}

export function noteWorkflowTransitions(
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

const client = new StudioClient();

/** Polling interval while something runs, and the cap the interval backs off to after consecutive failed reads. */
export const POLL_MS = 2000;
export const MAX_BACKOFF_MS = 30_000;
/** A failed base reread with nothing running is retried this many times, then waits for the user or a return. */
const IDLE_BASE_RETRIES = 5;

export type EntityPageKind = "stories" | "characters" | "locations";

export function useProjectBase(projectId: string, failureText: string) {
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [episodes, setEpisodes] = useState<EpisodeRecord[]>([]);
  const [stories, setStories] = useState<PageState<StoryRevision> | null>(null);
  const [characters, setCharacters] = useState<PageState<Aggregate> | null>(null);
  const [locations, setLocations] = useState<PageState<Aggregate> | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowRun[]>([]);
  /** Every run, including compose runs the tracked list leaves out. */
  const [allRuns, setAllRuns] = useState<WorkflowRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const [imageEpoch, setImageEpoch] = useState(0);
  const baseToken = useRef(0);
  /** True from a project's first request until the current request settles; only then does loading end. */
  const initialPending = useRef(false);
  const failureTextRef = useRef(failureText);
  failureTextRef.current = failureText;
  /** A background reread failed: the next poll tick rereads the whole base instead of only the runs. */
  const baseRetry = useRef(false);
  const failures = useRef(0);
  const [refreshFailed, setRefreshFailed] = useState(false);
  /** The automatic rereads after a failure are used up; only a manual retry or a return to the page reads again. */
  const [refreshPaused, setRefreshPaused] = useState(false);
  /** The latest runs, for the scheduler, which outlives any one render. */
  const runsRef = useRef<WorkflowRun[]>([]);
  /** Wakes this project's single poll and retry chain; a no-op while no chain exists (unmounted or switching). */
  const wakeRef = useRef<() => void>(() => undefined);
  const retryRef = useRef<() => Promise<void>>(async () => undefined);
  /** Tells the chain a current full reread succeeded: the failure run is over and any backoff timer is replaced. */
  const succeededRef = useRef<() => void>(() => undefined);
  const workflowStatus = useRef(new Map<string, string>());
  const composeStatus = useRef(new Map<string, string>());

  // Leaving this project (route change or unmount) invalidates every request still in flight for it.
  useEffect(() => () => { baseToken.current += 1; }, [projectId]);

  /** Applies a workflow-runs answer; a compose job reaching a terminal state rereads media and progress facts. */
  const applyRuns = useCallback((runs: WorkflowRun[]) => {
    const tracked = runs.filter(trackedWorkflow);
    const transition = noteWorkflowTransitions(tracked, workflowStatus.current);
    let composeFinished = false;
    for (const run of runs) {
      if (run.type !== "MEDIA_COMPOSE") continue;
      const previous = composeStatus.current.get(run.id);
      if (previous !== undefined && shouldPoll(previous, false) && !shouldPoll(run.status, false)) composeFinished = true;
      composeStatus.current.set(run.id, run.status);
    }
    setWorkflows(tracked);
    setAllRuns(runs);
    runsRef.current = runs;
    return { ...transition, composeFinished };
  }, []);

  /**
   * Rereads the project base. Only the latest request may write: a superseded request resolves without touching
   * state, while a failure of the latest request still rejects so callers see it. Loading belongs to the latest
   * request too: while a project's first data is pending, only the request that is current when it settles ends
   * the loading, so a superseded request's end never closes a newer read. A reread after data is shown never turns
   * loading on and never clears what is shown. Resolves true when this read was applied, false when superseded.
   */
  const loadBase = useCallback(async (): Promise<boolean> => {
    const request = ++baseToken.current;
    let loaded;
    try {
      loaded = await Promise.all([
        client.get<ProjectRecord>(`/projects/${projectId}`),
        client.get<{ items: EpisodeRecord[] }>(`/projects/${projectId}/episodes`),
        client.get<{ items: StoryRevision[]; nextCursor: string | null }>(`/projects/${projectId}/stories`),
        client.get<{ items: Aggregate[]; nextCursor: string | null }>(`/projects/${projectId}/characters`),
        client.get<{ items: Aggregate[]; nextCursor: string | null }>(`/projects/${projectId}/locations`),
        client.get<WorkflowRun[]>(`/projects/${projectId}/workflow-runs`),
      ]);
    } catch (caught) {
      if (!shouldApplyLoad(request, baseToken.current)) return false;
      if (initialPending.current) {
        initialPending.current = false;
        setError(caught instanceof ApiError ? caught.detail : failureTextRef.current);
        setLoading(false);
      } else {
        // Shown data stays; the one poll chain retries the whole base with a growing interval, even if it had
        // already stopped because nothing was running.
        baseRetry.current = true;
        setRefreshFailed(true);
        wakeRef.current();
      }
      throw caught;
    }
    if (!shouldApplyLoad(request, baseToken.current)) return false;
    const [nextProject, episodePage, storyPage, characterPage, locationPage, runs] = loaded;
    initialPending.current = false;
    baseRetry.current = false;
    setLoading(false);
    setRefreshFailed(false);
    setRefreshPaused(false);
    // A successful load supersedes an earlier failure.
    setError(null);
    setProject(nextProject);
    setEpisodes(episodePage.items);
    setStories(applyPage(null, { scope: projectId, items: storyPage.items, nextCursor: storyPage.nextCursor, append: false }));
    setCharacters(applyPage(null, { scope: projectId, items: characterPage.items, nextCursor: characterPage.nextCursor, append: false }));
    setLocations(applyPage(null, { scope: projectId, items: locationPage.items, nextCursor: locationPage.nextCursor, append: false }));
    const transition = applyRuns(runs);
    if (transition.mediaBecameTerminal || transition.composeFinished) setImageEpoch((value) => value + 1);
    if (transition.textBecameTerminal) setRefreshEpoch((value) => value + 1);
    // The failure run is over (whoever asked for this read), and a newly accepted job may need following although the
    // chain had stopped. A superseded read never gets here, so an old success cannot end a newer failure run.
    succeededRef.current();
    return true;
  }, [projectId, applyRuns]);

  /** The public reread: same rules as loadBase, without the applied flag callers do not need. */
  const reloadBase = useCallback(async () => { await loadBase(); }, [loadBase]);

  // The initial load of a project (a project change or mount). Its loading and error are settled by reloadBase for
  // whichever request is current at the time; a project change or an unmount invalidates requests in flight.
  useEffect(() => {
    initialPending.current = true;
    baseRetry.current = false;
    failures.current = 0;
    runsRef.current = [];
    setLoading(true);
    setError(null);
    setRefreshFailed(false);
    setRefreshPaused(false);
    void reloadBase().catch(() => undefined);
    return () => { initialPending.current = false; };
  }, [reloadBase]);

  // One chain per project, woken by new runs, by a failed reread from anywhere (callback, button or the chain itself)
  // and by a return to the page. While any run is in flight (including compose runs, whoever submitted them), or
  // after a background reread failed: one read at a time, the next scheduled only after the previous answer.
  // Consecutive failures stretch the interval up to MAX_BACKOFF_MS; with nothing running, a failed reread is retried
  // IDLE_BASE_RETRIES times and then reported as paused. Stops when nothing runs and nothing needs rereading; nothing
  // starts while hidden; a return to the page rereads and then restarts the chain whatever that reread's outcome.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let reading = false;
    const active = () => runsRef.current.some((run) => shouldPoll(run.status, false));
    const schedule = () => {
      if (stopped || reading || timer) return;
      if (!active() && baseRetry.current && failures.current >= IDLE_BASE_RETRIES) {
        setRefreshPaused(true);
        return;
      }
      if (!active() && !baseRetry.current) return;
      timer = setTimeout(tick, Math.min(POLL_MS * 2 ** failures.current, MAX_BACKOFF_MS));
    };
    // A superseded read (applied === false) is neither a success nor a failure of the current run.
    const settle = (ok: boolean, applied = true) => {
      if (!applied) return;
      failures.current = ok ? 0 : failures.current + 1;
    };
    const readRuns = async () => {
      const request = baseToken.current;
      const runs = await client.get<WorkflowRun[]>(`/projects/${projectId}/workflow-runs`);
      if (stopped || !shouldApplyLoad(request, baseToken.current)) return false;
      const transition = applyRuns(runs);
      if (transition.mediaBecameTerminal || transition.composeFinished) setImageEpoch((value) => value + 1);
      if (transition.textBecameTerminal) {
        setRefreshEpoch((value) => value + 1);
        void reloadBase().catch(() => undefined);
      }
      return true;
    };
    const tick = () => {
      timer = undefined;
      if (stopped || reading || document.visibilityState === "hidden") return;
      const running = active();
      const rereadBase = baseRetry.current && (running || failures.current < IDLE_BASE_RETRIES);
      if (!running && !rereadBase) return;
      reading = true;
      void (rereadBase ? loadBase() : readRuns()).then((applied) => settle(true, applied), () => settle(false)).finally(() => {
        reading = false;
        schedule();
      });
    };
    wakeRef.current = schedule;
    succeededRef.current = () => {
      failures.current = 0;
      // A backoff timer from the failure run is replaced by the normal interval (or dropped if nothing needs it).
      if (timer) clearTimeout(timer);
      timer = undefined;
      schedule();
    };
    schedule();
    const onVisible = () => {
      if (document.visibilityState !== "visible" || stopped || reading) return;
      if (timer) clearTimeout(timer);
      timer = undefined;
      setRefreshEpoch((value) => value + 1);
      reading = true;
      void loadBase().then((applied) => settle(true, applied), () => settle(false)).finally(() => {
        reading = false;
        schedule();
      });
    };
    document.addEventListener("visibilitychange", onVisible);
    retryRef.current = async () => {
      // The user asked: a fresh set of automatic retries, starting with this read.
      failures.current = 0;
      setRefreshPaused(false);
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (reading) return;
      reading = true;
      try {
        settle(true, await loadBase());
      } catch {
        settle(false);
      } finally {
        reading = false;
        schedule();
      }
    };
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      wakeRef.current = () => undefined;
      succeededRef.current = () => undefined;
      retryRef.current = async () => undefined;
    };
  }, [projectId, loadBase, reloadBase, applyRuns]);

  /** Manual retry after the automatic ones paused (or any time): one read now, then the usual schedule. */
  const retryNow = useCallback(() => retryRef.current(), []);

  const more = useCallback(async (kind: EntityPageKind) => {
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
  }, [projectId, stories, characters, locations]);

  /** Drops entity pages that belong to another project (a navigation inside the same component). */
  const keepScopedPages = useCallback(() => {
    setCharacters((current) => current && current.scope === projectId ? current : null);
    setLocations((current) => current && current.scope === projectId ? current : null);
  }, [projectId]);

  return { project, episodes, stories, characters, locations, workflows, allRuns, loading, error, setError, refreshEpoch,
    imageEpoch, reloadBase, more, keepScopedPages, refreshFailed, refreshPaused, retryNow };
}
