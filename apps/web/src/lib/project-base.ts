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
    // A successful load supersedes an earlier failure.
    setError(null);
    setProject(nextProject);
    setEpisodes(episodePage.items);
    setStories(applyPage(null, { scope: projectId, items: storyPage.items, nextCursor: storyPage.nextCursor, append: false }));
    setCharacters(applyPage(null, { scope: projectId, items: characterPage.items, nextCursor: characterPage.nextCursor, append: false }));
    setLocations(applyPage(null, { scope: projectId, items: locationPage.items, nextCursor: locationPage.nextCursor, append: false }));
    setWorkflows(tracked);
    setAllRuns(runs);
    if (transition.mediaBecameTerminal) setImageEpoch((value) => value + 1);
    if (transition.textBecameTerminal) setRefreshEpoch((value) => value + 1);
  }, [projectId]);

  useEffect(() => {
    setLoading(true);
    void reloadBase().catch((caught: unknown) => {
      setError(caught instanceof ApiError ? caught.detail : failureText);
    }).finally(() => setLoading(false));
  }, [reloadBase, failureText]);

  // One workflow-runs read at a time while something runs; paused while hidden; a return to the page rereads.
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
        setAllRuns(runs);
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
    imageEpoch, reloadBase, more, keepScopedPages };
}
