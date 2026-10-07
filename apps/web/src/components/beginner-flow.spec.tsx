// @vitest-environment happy-dom
// Simulated interface tests. fetch is mocked; the real step panes are mounted. No browser or backend runs here.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BeginnerFlow } from "./beginner-flow";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function story(reviewStatus: string) {
  return { id: "story-1", revisionNo: 1, content: { text: "夜班店员守住记录" }, reviewStatus, freshnessStatus: "CURRENT",
    reviewVersion: 1, staleReason: null, staleFromRef: null, reviewNote: null };
}

function episode(no: number, review: string | null) {
  return { id: `episode-${no}`, episodeNo: no, title: `第${no}集`, rowVersion: 1, currentScriptRevisionId: review ? `script-${no}` : null,
    approvedScriptRevisionId: review === "APPROVED" ? `script-${no}` : null, currentScriptReviewStatus: review,
    currentScriptFreshnessStatus: review ? "CURRENT" : null };
}

interface World {
  title: string;
  story: ReturnType<typeof story> | null;
  episodes: ReturnType<typeof episode>[];
  hold?: Promise<void>;
}

function install(worlds: Record<string, World>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input).split("?")[0] ?? "";
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    const id = Object.keys(worlds).find((key) => path.includes(key));
    const world = id ? worlds[id] : undefined;
    if (world?.hold && path === `/api/v1/projects/${id}`) await world.hold;
    if (!world) return json({ items: [], nextCursor: null });
    if (path === `/api/v1/projects/${id}`) return json({ id, title: world.title, premise: "梗概", version: 3, status: "ACTIVE" });
    if (path.endsWith("/episodes")) return json({ items: world.episodes });
    if (path.endsWith("/stories")) return json({ items: world.story ? [world.story] : [], nextCursor: null });
    if (path.endsWith("/workflow-runs")) return json([]);
    if (path.endsWith("/compose-candidates")) return json({ items: [], nextCursor: null });
    if (path.endsWith("/composites")) return json({ items: [], nextCursor: null });
    return json({ items: [], nextCursor: null });
  }));
  return calls;
}

beforeEach(() => {
  window.history.replaceState(null, "", `/projects/${P1}/create`);
  Element.prototype.scrollIntoView = vi.fn();
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe("beginner flow", () => {
  it("opens the first step that needs the user and explains it", async () => {
    install({ [P1]: { title: "夜班", story: story("DRAFT"), episodes: [] } });
    render(<BeginnerFlow projectId={P1} />);
    expect(await screen.findByRole("heading", { name: "第 1 步 · 定故事" })).toBeTruthy();
    expect(screen.getByText("你需要决定")).toBeTruthy();
    expect(screen.getAllByText(/待确认/).length).toBeGreaterThan(0);
    expect(window.location.search).toBe("?step=story");
    // The existing story editor is mounted, not a copy.
    expect(await screen.findByRole("heading", { name: "故事" })).toBeTruthy();
    const primary = screen.getByRole("button", { name: "检查并确认当前版本" });
    fireEvent.click(primary);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "高级编辑" }).getAttribute("href")).toBe(`/projects/${P1}?focus=story`);
  });

  it("shows each episode's real state and keeps review to the shown episode", async () => {
    install({ [P1]: { title: "夜班", story: story("APPROVED"), episodes: [episode(1, "APPROVED"), episode(2, "DRAFT"), episode(3, null)] } });
    render(<BeginnerFlow projectId={P1} />);
    expect(await screen.findByRole("heading", { name: "第 2 步 · 看剧本" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /第 1 集 · ✓ 已完成/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /第 2 集 · ？ 待确认/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /第 3 集 · ＋ 待补充/ })).toBeTruthy();
    expect(screen.getByText(/审核只针对当前展示的这一集、这一个版本/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /第 2 集/ }));
    expect(screen.getByRole("link", { name: "高级编辑" }).getAttribute("href")).toBe(`/projects/${P1}?focus=script&episode=2`);
  });

  it("reopens the step named in the URL after a refresh and moves on only when the server says done", async () => {
    window.history.replaceState(null, "", `/projects/${P1}/create?step=story`);
    install({ [P1]: { title: "夜班", story: story("APPROVED"), episodes: [episode(1, null), episode(2, null), episode(3, null)] } });
    render(<BeginnerFlow projectId={P1} />);
    expect(await screen.findByRole("heading", { name: "第 1 步 · 定故事" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "继续下一步" }));
    expect(await screen.findByRole("heading", { name: "第 2 步 · 看剧本" })).toBeTruthy();
    expect(window.location.search).toBe("?step=script");
  });

  it("explains the sample step's demo media and blocks it until the episode script is approved", async () => {
    window.history.replaceState(null, "", `/projects/${P1}/create?step=sample`);
    install({ [P1]: { title: "夜班", story: story("APPROVED"), episodes: [episode(1, "DRAFT"), episode(2, null), episode(3, null)] } });
    render(<BeginnerFlow projectId={P1} />);
    expect(await screen.findByRole("heading", { name: "第 4 步 · 试一段" })).toBeTruthy();
    expect(screen.getByText(/演示视频约 1 秒/)).toBeTruthy();
    expect(screen.getByText(/时长提示.*不等于视频的实际时长/)).toBeTruthy();
    expect(screen.getByText("这一集的剧本还没有确认通过。请先在「看剧本」里完成审核。")).toBeTruthy();
  });

  it("asks before leaving with unsaved edits and says where the draft lives", async () => {
    install({ [P1]: { title: "夜班", story: story("DRAFT"), episodes: [] } });
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...original, assign, search: original.search } });
    try {
      render(<BeginnerFlow projectId={P1} />);
      const editor = await screen.findByLabelText("正文");
      fireEvent.change(editor, { target: { value: "改过的故事" } });
      await waitFor(() => expect(screen.getByText(/有未保存修改/, { selector: "p" })).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "稍后继续" }));
      expect(screen.getByRole("alert").textContent).toContain("关闭浏览器或换设备后不保证能恢复");
      expect(assign).not.toHaveBeenCalled();
      expect(screen.getByRole("link", { name: "保留本标签页草稿并离开" }).getAttribute("href")).toBe("/studio");
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: original });
    }
  });

  it("drops a late answer for the previous project", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    install({ [P1]: { title: "旧作品", story: story("DRAFT"), episodes: [], hold },
      [P2]: { title: "新作品", story: story("DRAFT"), episodes: [] } });
    const view = render(<BeginnerFlow projectId={P1} />);
    view.rerender(<BeginnerFlow projectId={P2} />);
    expect(await screen.findByRole("heading", { name: "新作品" })).toBeTruthy();
    await act(async () => { release(); await hold; });
    expect(screen.queryByRole("heading", { name: "旧作品" })).toBeNull();
  });
});
