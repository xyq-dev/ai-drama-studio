import { currentStoryRevision } from "./studio-model";
import { ApiError, type StudioClient } from "./studio-client";
import type { Aggregate, EpisodeRecord, StoryRevision, WorkflowRun } from "./project-base";
import { scriptState, type BeginnerFacts, type EpisodeMediaFacts } from "./beginner-steps";

/**
 * Read-only facts for the beginner views, from existing endpoints only. Candidate and composite reads are made only
 * for episodes whose script is approved and current; before that the server could not have any.
 */
export async function loadEpisodeMedia(
  client: Pick<StudioClient, "get">,
  projectId: string,
  episodes: readonly EpisodeRecord[],
): Promise<Record<number, EpisodeMediaFacts>> {
  const result: Record<number, EpisodeMediaFacts> = {};
  for (const episode of episodes) {
    if (scriptState(episode) !== "done") {
      result[episode.episodeNo] = { candidates: 0, composites: [] };
      continue;
    }
    const base = `/projects/${projectId}/episodes/${episode.id}`;
    // Sequential per episode: a project page makes at most two reads per approved episode.
    let candidates: { items: unknown[]; nextCursor: string | null };
    let composites: { items: Array<{ status: string; reviewStatus: string }> };
    try {
      candidates = await client.get<{ items: unknown[]; nextCursor: string | null }>(`${base}/compose-candidates`);
      composites = await client.get<{ items: Array<{ status: string; reviewStatus: string }> }>(`${base}/composites?limit=10`);
    } catch (caught) {
      // Local compose is off in this environment: nothing can be composed, and that is not a read failure.
      if (caught instanceof ApiError && caught.code === "CONFIGURATION_ERROR") {
        result[episode.episodeNo] = { candidates: null, composites: null, composeUnavailable: true };
        continue;
      }
      throw caught;
    }
    result[episode.episodeNo] = {
      candidates: candidates.items.length + (candidates.nextCursor ? 1 : 0),
      composites: composites.items.map((item) => ({ status: item.status, reviewStatus: item.reviewStatus })),
    };
  }
  return result;
}

/** Everything one project card needs to name its stage. */
export async function loadProjectFacts(client: Pick<StudioClient, "get">, projectId: string): Promise<BeginnerFacts> {
  const [stories, episodes, characters, locations, runs] = await Promise.all([
    client.get<{ items: StoryRevision[] }>(`/projects/${projectId}/stories`),
    client.get<{ items: EpisodeRecord[] }>(`/projects/${projectId}/episodes`),
    client.get<{ items: Aggregate[] }>(`/projects/${projectId}/characters`),
    client.get<{ items: Aggregate[] }>(`/projects/${projectId}/locations`),
    client.get<WorkflowRun[]>(`/projects/${projectId}/workflow-runs`),
  ]);
  const media = await loadEpisodeMedia(client, projectId, episodes.items);
  return { story: currentStoryRevision(stories.items), episodes: episodes.items, characters: characters.items,
    locations: locations.items, runs, media };
}
