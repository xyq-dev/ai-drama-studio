import { describe, expect, it } from "vitest";
import { ApiError } from "./studio-client";
import type { Aggregate, EpisodeRecord } from "./project-base";
import { MAX_PAGES, loadEntityLists, loadEpisodeMedia, readPages } from "./beginner-facts";
import { episodeFinalState, episodeSampleState, stepStates, type BeginnerFacts } from "./beginner-steps";

/**
 * A fake client answering paged GETs from fixed pages: each path has a list of pages; a page's cursor names the
 * next page. It records every URL so tests can see what was read. No browser or server.
 */
function pagedClient(pages: Record<string, Array<{ items: unknown[]; nextCursor: string | null }>>, failures: Record<string, Error> = {}) {
  const urls: string[] = [];
  return {
    urls,
    get: async <T,>(url: string): Promise<T> => {
      urls.push(url);
      const [path, query = ""] = url.split("?");
      const failure = failures[path!];
      if (failure) throw failure;
      const cursor = new URLSearchParams(query).get("cursor");
      const list = pages[path!] ?? [{ items: [], nextCursor: null }];
      const index = cursor === null ? 0 : Number(cursor.replace("c", ""));
      return (list[index] ?? { items: [], nextCursor: null }) as T;
    },
  };
}

const EPISODE: EpisodeRecord = { id: "e1", episodeNo: 1, title: "", rowVersion: 1, currentScriptRevisionId: "s",
  approvedScriptRevisionId: "s", currentScriptReviewStatus: "APPROVED", currentScriptFreshnessStatus: "CURRENT" };
const BASE = "/projects/p/episodes/e1";

function composite(status: string, reviewStatus: string) {
  return { status, reviewStatus };
}

function facts(media: BeginnerFacts["media"], episodes = [EPISODE]): BeginnerFacts {
  return { story: null, episodes, characters: { items: [], read: "ok" }, locations: { items: [], read: "ok" }, runs: [], media };
}

describe("progress facts follow pagination (review)", () => {
  it("does not count a scan cursor as a candidate: an empty page with a cursor keeps reading", async () => {
    const client = pagedClient({
      [`${BASE}/compose-candidates`]: [{ items: [], nextCursor: "c1" }, { items: [], nextCursor: "c2" }, { items: [], nextCursor: null }],
    });
    const media = await loadEpisodeMedia(client, "p", [EPISODE]);
    expect(media[1]!.candidates).toEqual({ read: "ok", count: 0 });
    expect(episodeSampleState(facts(media), 1)).toBe("needs_input");
    expect(client.urls.filter((url) => url.includes("compose-candidates"))).toHaveLength(3);
  });

  it("finds a candidate on a later page after empty pages", async () => {
    const client = pagedClient({
      [`${BASE}/compose-candidates`]: [{ items: [], nextCursor: "c1" }, { items: [{ assetId: "a" }], nextCursor: null }],
    });
    const media = await loadEpisodeMedia(client, "p", [EPISODE]);
    expect(media[1]!.candidates).toEqual({ read: "ok", count: 1 });
    expect(episodeSampleState(facts(media), 1)).toBe("done");
  });

  it("finds an ACTIVE + APPROVED composite at position 11, behind ten newer drafts", async () => {
    const drafts = Array.from({ length: 10 }, () => composite("ACTIVE", "DRAFT"));
    const client = pagedClient({
      [`${BASE}/compose-candidates`]: [{ items: [{}, {}], nextCursor: null }],
      [`${BASE}/composites`]: [{ items: drafts, nextCursor: "c1" }, { items: [composite("ACTIVE", "APPROVED")], nextCursor: null }],
    });
    const media = await loadEpisodeMedia(client, "p", [EPISODE]);
    expect(media[1]!.composites.approvedActive).toBe(true);
    expect(episodeFinalState(facts(media), 1)).toBe("done");
  });

  it("stops early once an approved current composite settles the episode", async () => {
    const client = pagedClient({
      [`${BASE}/composites`]: [{ items: [composite("ACTIVE", "APPROVED")], nextCursor: "c1" }, { items: [], nextCursor: null }],
    });
    await loadEpisodeMedia(client, "p", [EPISODE]);
    expect(client.urls.filter((url) => url.includes("/composites"))).toHaveLength(1);
  });

  it("reports a repeated cursor or an exhausted bound as incomplete, not as an empty list", async () => {
    const looping = pagedClient({ "/x": [{ items: [], nextCursor: "c1" }, { items: [], nextCursor: "c1" }] });
    expect((await readPages(looping, "/x")).read).toBe("incomplete");
    expect(looping.urls).toHaveLength(2);
    const endless = pagedClient({ "/y": Array.from({ length: MAX_PAGES + 5 }, (_, index) => ({ items: [], nextCursor: `c${index + 1}` })) });
    expect((await readPages(endless, "/y")).read).toBe("incomplete");
    expect(endless.urls).toHaveLength(MAX_PAGES);
  });

  it("reads every character page, so a REJECTED 21st character counts", async () => {
    const approved = (index: number): Aggregate => ({ entityId: `c${index}`, rowVersion: 1, currentRevisionId: `r${index}`,
      approvedRevisionId: `r${index}`, currentRevision: { reviewStatus: "APPROVED", freshnessStatus: "CURRENT", reviewVersion: 1 } });
    const rejected: Aggregate = { entityId: "c20", rowVersion: 1, currentRevisionId: "r20", approvedRevisionId: null,
      currentRevision: { reviewStatus: "REJECTED", freshnessStatus: "CURRENT", reviewVersion: 1 } };
    const client = pagedClient({
      "/projects/p/characters": [{ items: Array.from({ length: 20 }, (_, index) => approved(index)), nextCursor: "c1" }, { items: [rejected], nextCursor: null }],
    });
    const lists = await loadEntityLists(client, "p");
    expect(lists.characters).toMatchObject({ read: "ok" });
    expect(lists.characters.items).toHaveLength(21);
    expect(stepStates({ ...facts({}), episodes: [EPISODE], ...lists }).cast).toBe("needs_attention");
  });

  it("classifies the two compose reads separately: candidates survive when only episode compose is off", async () => {
    const client = pagedClient(
      { [`${BASE}/compose-candidates`]: [{ items: [{}], nextCursor: null }] },
      { [`${BASE}/composites`]: new ApiError(503, "CONFIGURATION_ERROR", "Episode compose is not enabled") },
    );
    const media = await loadEpisodeMedia(client, "p", [EPISODE]);
    expect(media[1]!.candidates).toEqual({ read: "ok", count: 1 });
    expect(media[1]!.composites.read).toBe("unavailable");
    expect(episodeSampleState(facts(media), 1)).toBe("done");
    expect(episodeFinalState(facts(media), 1)).toBe("unknown");
  });

  it("separates a failed read from a real empty list", async () => {
    const failing = pagedClient({}, { [`${BASE}/composites`]: new ApiError(500, "INTERNAL", "boom") });
    expect((await loadEpisodeMedia(failing, "p", [EPISODE]))[1]!.composites.read).toBe("failed");
    const empty = pagedClient({});
    expect((await loadEpisodeMedia(empty, "p", [EPISODE]))[1]!.composites.read).toBe("ok");
  });

  it("still reads history when the script was replaced: STALE + APPROVED survives a DRAFT script", async () => {
    const draftScript: EpisodeRecord = { ...EPISODE, currentScriptRevisionId: "s2", currentScriptReviewStatus: "DRAFT" };
    const client = pagedClient({ [`${BASE}/composites`]: [{ items: [composite("STALE", "APPROVED")], nextCursor: null }] });
    const media = await loadEpisodeMedia(client, "p", [draftScript]);
    expect(client.urls.some((url) => url.includes("compose-candidates"))).toBe(false);
    expect(media[1]!.composites.staleApproved).toBe(true);
    expect(episodeFinalState(facts(media, [draftScript]), 1)).toBe("source_updated");
  });
});
