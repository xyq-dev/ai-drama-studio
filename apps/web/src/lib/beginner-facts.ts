import { currentStoryRevision } from "./studio-model";
import { ApiError, type StudioClient } from "./studio-client";
import type { Aggregate, EpisodeRecord, StoryRevision, WorkflowRun } from "./project-base";
import {
  scriptState,
  type BeginnerFacts,
  type CompositeSummary,
  type EpisodeMediaFacts,
  type ListFacts,
  type ReadState,
} from "./beginner-steps";

/**
 * Read-only progress facts from existing endpoints. Every list is read page by page with a fixed bound; a list may
 * stop early once the answer is settled. `nextCursor` is a scan position, never an item: a page may be empty and
 * still carry a cursor. A bound reached with pages left, a repeated cursor or a failed read is reported as such and
 * the step shows "尚未确认" instead of treating a partial list as complete.
 */
type Client = Pick<StudioClient, "get">;

interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export const PAGE_LIMIT = 50;
export const MAX_PAGES = 20;

export async function readPages<T>(
  client: Client,
  path: string,
  settled: (items: readonly T[]) => boolean = () => false,
): Promise<{ items: T[]; read: ReadState }> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const url: string = `${path}${separator}limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const body: Page<T> = await client.get<Page<T>>(url);
      items.push(...body.items);
      if (settled(items)) return { items, read: "ok" };
      if (!body.nextCursor) return { items, read: "ok" };
      // A cursor that comes back again would loop forever: stop and say the list is not confirmed.
      if (seen.has(body.nextCursor)) return { items, read: "incomplete" };
      seen.add(body.nextCursor);
      cursor = body.nextCursor;
    }
    return { items, read: "incomplete" };
  } catch (caught) {
    return { items, read: caught instanceof ApiError && caught.code === "CONFIGURATION_ERROR" ? "unavailable" : "failed" };
  }
}

function summarize(read: ReadState, items: ReadonlyArray<{ status: string; reviewStatus: string }>): CompositeSummary {
  const active = items.filter((item) => item.status === "ACTIVE");
  return {
    read,
    approvedActive: active.some((item) => item.reviewStatus === "APPROVED"),
    draftActive: active.some((item) => item.reviewStatus === "DRAFT"),
    rejectedActive: active.some((item) => item.reviewStatus === "REJECTED"),
    staleApproved: items.some((item) => item.status === "STALE" && item.reviewStatus === "APPROVED"),
  };
}

/**
 * Candidates (what can be composed now) are read only for an approved, current script. Composites (what was
 * composed, including STALE history) are read for every episode: a script change does not erase history.
 */
export async function loadEpisodeMedia(
  client: Client,
  projectId: string,
  episodes: readonly EpisodeRecord[],
): Promise<Record<number, EpisodeMediaFacts>> {
  const result: Record<number, EpisodeMediaFacts> = {};
  for (const episode of episodes) {
    const base = `/projects/${projectId}/episodes/${episode.id}`;
    const candidates = scriptState(episode) === "done"
      ? await readPages<unknown>(client, `${base}/compose-candidates`, (items) => items.length >= 2)
      : { items: [], read: "ok" as ReadState };
    const composites = await readPages<{ status: string; reviewStatus: string }>(client, `${base}/composites`,
      (items) => items.some((item) => item.status === "ACTIVE" && item.reviewStatus === "APPROVED"));
    result[episode.episodeNo] = {
      candidates: { read: candidates.read, count: candidates.items.length },
      composites: summarize(composites.read, composites.items),
    };
  }
  return result;
}

export async function loadEntityLists(client: Client, projectId: string): Promise<{ characters: ListFacts<Aggregate>; locations: ListFacts<Aggregate> }> {
  const characters = await readPages<Aggregate>(client, `/projects/${projectId}/characters`);
  const locations = await readPages<Aggregate>(client, `/projects/${projectId}/locations`);
  return { characters, locations };
}

/** Everything one project card needs to name its stage. */
export async function loadProjectFacts(client: Client, projectId: string): Promise<BeginnerFacts> {
  const [stories, episodes, runs] = await Promise.all([
    client.get<{ items: StoryRevision[] }>(`/projects/${projectId}/stories`),
    client.get<{ items: EpisodeRecord[] }>(`/projects/${projectId}/episodes`),
    client.get<WorkflowRun[]>(`/projects/${projectId}/workflow-runs`),
  ]);
  const entities = await loadEntityLists(client, projectId);
  const media = await loadEpisodeMedia(client, projectId, episodes.items);
  return { story: currentStoryRevision(stories.items), episodes: episodes.items, ...entities, runs, media };
}

/** Which media reads the server reported as switched off, per step. */
export function composeOff(media: Record<number, EpisodeMediaFacts>): { sample: boolean; final: boolean } {
  const values = Object.values(media);
  return {
    sample: values.some((item) => item.candidates.read === "unavailable"),
    final: values.some((item) => item.composites.read === "unavailable"),
  };
}

export function mediaReadFailed(media: Record<number, EpisodeMediaFacts>): boolean {
  return Object.values(media).some((item) => item.candidates.read === "failed" || item.composites.read === "failed");
}
