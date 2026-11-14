// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShortSequelEntry } from "./short-sequel-entry";

const PROJECT = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("续写下一集", () => {
  it("waits for confirmation, retries the same requested episode, and opens its editor", async () => {
    const assign = vi.fn();
    const posts: { key: string | null; body: unknown }[] = [];
    vi.stubGlobal("location", { ...window.location, assign });
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method !== "POST") return Response.json({ episodeCount: 1, nextEpisodeNo: 2, continuations: [] });
      posts.push({ key: new Headers(init.headers).get("Idempotency-Key"), body: JSON.parse(String(init.body)) });
      if (posts.length === 1) throw new TypeError("network");
      return Response.json({ episodeNo: 2, episodeId: "existing", episodeCount: 2 });
    }));
    render(<ShortSequelEntry projectId={PROJECT} afterEpisodeNo={1} />);

    fireEvent.click(await screen.findByRole("button", { name: "续写下一集" }));
    expect(posts).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "在本作品新增第 2 集" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "在本作品新增第 2 集" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/projects/${PROJECT}/script?episode=2`));
    expect(posts).toHaveLength(2);
    expect(posts[0]).toEqual(posts[1]);
    expect(posts[1]?.body).toEqual({ episodeNo: 2 });
  });

  it("opens the existing continuation without offering another expansion for the original episode", async () => {
    const fetch = vi.fn(async () => Response.json({
      episodeCount: 2, nextEpisodeNo: 3, continuations: [{ episodeNo: 2, episodeId: "existing" }],
    }));
    vi.stubGlobal("fetch", fetch);
    render(<ShortSequelEntry projectId={PROJECT} afterEpisodeNo={1} />);
    const existing = await screen.findByRole("link", { name: "打开第 2 集" });
    expect(existing.getAttribute("href")).toBe(`/projects/${PROJECT}/script?episode=2`);
    expect(screen.queryByRole("button", { name: "续写下一集" })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
