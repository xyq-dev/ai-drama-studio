// @vitest-environment happy-dom
// Simulated interface tests. fetch is mocked; the real step panes are mounted. No browser or backend runs here.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  /** Holds every episode media read until released. */
  mediaHold?: Promise<void>;
  runs?: unknown[];
  composites?: Record<string, Array<{ status: string; reviewStatus: string }>>;
  candidates?: Record<string, unknown[]>;
  /** Fail the project read this many times first. */
  projectFailures?: number;
  scenesFail?: () => boolean;
  characters?: unknown[];
  locations?: unknown[];
  /** Revisions answered for a character or location id. */
  revisions?: Record<string, unknown>;
  scenes?: unknown[];
}

/** GET /providers/capabilities: a compose switch object, a failure status, or the default (both on). */
let capabilities: { compose: { shot: boolean; episode: boolean } } | number = { compose: { shot: true, episode: true } };
/** Capability answers taken in order before the default; each is awaited (to hold or answer late). */
let capabilityQueue: Array<() => Promise<Response>> = [];
let capabilityReads = 0;
/** The abort signal of each capability read, in order. */
let capabilitySignals: Array<AbortSignal | undefined> = [];

function capabilityAnswer(value: { shot: boolean; episode: boolean } | number): Response {
  return typeof value === "number"
    ? json({ error: { code: "UNAVAILABLE", message: "暂时不可用" } }, value)
    : json({ providerKey: "mock", capability: "mock.generate", outcomes: [], compose: value });
}

function install(worlds: Record<string, World>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input).split("?")[0] ?? "";
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    if (path === "/api/v1/providers/capabilities") {
      capabilityReads += 1;
      capabilitySignals.push(init?.signal ?? undefined);
      const queued = capabilityQueue.shift();
      if (queued) return queued();
      return typeof capabilities === "number"
        ? json({ error: { code: "UNAVAILABLE", message: "暂时不可用" } }, capabilities)
        : json({ providerKey: "mock", capability: "mock.generate", outcomes: [], ...capabilities });
    }
    const id = Object.keys(worlds).find((key) => path.includes(key));
    const world = id ? worlds[id] : undefined;
    if (world?.hold && path === `/api/v1/projects/${id}`) await world.hold;
    if (!world) return json({ items: [], nextCursor: null });
    if (path === `/api/v1/projects/${id}`) {
      if (world.projectFailures && world.projectFailures > 0) {
        world.projectFailures -= 1;
        return json({ error: { code: "INTERNAL", message: "暂时失败" } }, 500);
      }
      return json({ id, title: world.title, premise: "梗概", version: 3, status: "ACTIVE" });
    }
    if (path.endsWith("/episodes")) return json({ items: world.episodes });
    if (path.endsWith("/stories")) return json({ items: world.story ? [world.story] : [], nextCursor: null });
    if (path.endsWith("/workflow-runs")) return json(world.runs ?? []);
    const episodeId = path.split("/episodes/")[1]?.split("/")[0] ?? "";
    if (path.endsWith("/compose-candidates")) {
      if (world.mediaHold) await world.mediaHold;
      return json({ items: world.candidates?.[episodeId] ?? [], nextCursor: null });
    }
    if (path.endsWith("/composites")) {
      if (world.mediaHold) await world.mediaHold;
      return json({ items: world.composites?.[episodeId] ?? [], nextCursor: null });
    }
    if (path.endsWith("/scenes") && world.scenesFail?.()) return json({ error: { code: "INTERNAL", message: "boom" } }, 500);
    if (path.endsWith("/scenes") && world.scenes) return json({ items: world.scenes, nextCursor: null });
    const revisionOf = /\/(?:characters|locations|scenes)\/([^/]+)\/revisions$/.exec(path)?.[1];
    if (revisionOf && world.revisions?.[revisionOf]) return json(world.revisions[revisionOf]);
    if (path.endsWith("/characters")) return json({ items: world.characters ?? [], nextCursor: null });
    if (path.endsWith("/locations")) return pageOf(world.locations ?? [], String(input));
    return json({ items: [], nextCursor: null });
  }));
  return calls;
}

/** Twenty items a page, like the API default; readPages asks for 50. */
function pageOf(items: unknown[], url: string): Response {
  const query = new URL(url, "http://local").searchParams;
  const limit = Number(query.get("limit") ?? 20);
  const start = Number(query.get("cursor") ?? 0);
  const next = start + limit < items.length ? String(start + limit) : null;
  return json({ items: items.slice(start, start + limit), nextCursor: next });
}

beforeEach(() => {
  capabilities = { compose: { shot: true, episode: true } };
  capabilityQueue = [];
  capabilityReads = 0;
  capabilitySignals = [];
  window.history.replaceState(null, "", `/projects/${P1}/create`);
  Element.prototype.scrollIntoView = vi.fn();
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
});

afterEach(async () => {
  cleanup();
  // Sequential reads started before unmount finish against the stub, not the network.
  await new Promise((done) => setTimeout(done, 30));
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
    // Step buttons keep their title in the accessible name even where the title text is hidden (390px).
    expect(screen.getByRole("button", { name: "第 1 步 定故事：待确认" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "第 4 步 试一段：未开始" })).toBeTruthy();
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

  it("reports a draft restored from this tab as unsaved and warns before leaving (review)", async () => {
    window.sessionStorage.setItem(`ads-draft:${P1}:story:story-1`, JSON.stringify({ fingerprint: "f", idempotencyKey: "k",
      payload: { text: "上次没保存的故事" }, ifMatch: 3 }));
    install({ [P1]: { title: "夜班", story: story("DRAFT"), episodes: [] } });
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...original, assign, search: original.search } });
    try {
      render(<BeginnerFlow projectId={P1} />);
      expect(await screen.findByText("保存状态：有未保存修改（本标签页草稿）：故事")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "稍后继续" }));
      expect(screen.getByRole("alert").textContent).toContain("还有未保存的修改");
      expect(assign).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: original });
    }
  });

  it("waits for every progress fact before choosing the first step and episode (review)", async () => {
    let release!: () => void;
    const mediaHold = new Promise<void>((done) => { release = done; });
    const approved = [episode(1, "APPROVED"), episode(2, "APPROVED"), episode(3, "APPROVED")];
    install({ [P1]: { title: "夜班", story: story("APPROVED"), episodes: approved, mediaHold,
      candidates: { "episode-1": [{}, {}], "episode-2": [{}, {}], "episode-3": [{}, {}] },
      composites: { "episode-1": [{ status: "ACTIVE", reviewStatus: "APPROVED" }], "episode-2": [{ status: "ACTIVE", reviewStatus: "DRAFT" }] } } });
    render(<BeginnerFlow projectId={P1} />);
    await screen.findByRole("heading", { name: "夜班" });
    // Before the media facts arrive no step is chosen, so nothing can be pinned to the wrong one.
    expect(screen.queryByRole("heading", { name: /第 \d 步/ })).toBeNull();
    await act(async () => { release(); await mediaHold; });
    // Cast has no characters yet, so step 3 is first; switching to 出成片 opens episode 2, the one waiting for review.
    expect(await screen.findByRole("heading", { name: "第 3 步 · 定人物" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /第 5 步 出成片/ }));
    expect(await screen.findByRole("tab", { name: /第 2 集 · ？ 待确认/, selected: true })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /第 1 集 · ✓ 已完成/ })).toBeTruthy();
  });

  it("shows only the episode whose compose is running as 处理中 and lists compose jobs in the task drawer (review)", async () => {
    window.history.replaceState(null, "", `/projects/${P1}/create?step=final`);
    const approved = [episode(1, "APPROVED"), episode(2, "APPROVED"), episode(3, "APPROVED")];
    install({ [P1]: { title: "夜班", story: story("APPROVED"), episodes: approved,
      runs: [{ id: "run-1", type: "MEDIA_COMPOSE", status: "RUNNING", createdAt: "2026-10-07T00:00:00.000Z",
        jobs: [{ id: "job-1", kind: "MEDIA_COMPOSE", state: "RUNNING", errorCode: null, errorMessage: null,
          sourceShotRevisionId: null, composeEpisodeId: "episode-1", attempts: [] }] },
      { id: "run-2", type: "MEDIA_VIDEO", status: "RUNNING", createdAt: "2026-10-07T00:00:00.000Z",
        jobs: [{ id: "job-2", kind: "MEDIA_VIDEO", state: "RUNNING", errorCode: null, errorMessage: null,
          sourceShotRevisionId: "shot-r", attempts: [] }] }] } });
    render(<BeginnerFlow projectId={P1} />);
    expect(await screen.findByRole("tab", { name: /第 1 集 · … 处理中/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /第 2 集 · ○ 未开始/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /第 3 集 · ○ 未开始/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "查看合成进度" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /第 4 步 试一段/ }));
    fireEvent.click(await screen.findByRole("button", { name: "查看任务进度" }));
    expect(await screen.findByText(/本地合成 · /)).toBeTruthy();
  });

  it("clears a project-load error once a later load succeeds (review)", async () => {
    install({ [P1]: { title: "夜班", story: story("DRAFT"), episodes: [], projectFailures: 1 } });
    render(<BeginnerFlow projectId={P1} />);
    expect(await screen.findByText(/作品读取失败/)).toBeTruthy();
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(await screen.findByRole("heading", { name: "第 1 步 · 定故事" })).toBeTruthy();
    expect(screen.queryByText(/作品读取失败/)).toBeNull();
  });

  it("tells a failed scene read apart from an episode without scenes (review)", async () => {
    window.history.replaceState(null, "", `/projects/${P1}/create?step=sample`);
    let fail = true;
    install({ [P1]: { title: "夜班", story: story("APPROVED"), episodes: [episode(1, "APPROVED"), episode(2, null), episode(3, null)],
      scenesFail: () => fail } });
    render(<BeginnerFlow projectId={P1} />);
    expect(await screen.findByText(/场景列表读取失败，不能确定这一集有没有场景/)).toBeTruthy();
    expect(screen.queryByText(/这一集还没有场景/)).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "重新读取场景" }));
    expect(await screen.findByText(/这一集还没有场景/)).toBeTruthy();
  });

  it("opens the episode whose script still needs work (review)", async () => {
    window.history.replaceState(null, "", `/projects/${P1}/create?step=script`);
    install({ [P1]: { title: "夜班", story: story("APPROVED"), episodes: [episode(1, "APPROVED"), episode(2, "DRAFT"), episode(3, null)] } });
    render(<BeginnerFlow projectId={P1} />);
    expect(await screen.findByRole("tab", { name: /第 2 集/, selected: true })).toBeTruthy();
    expect(screen.getByRole("link", { name: "高级编辑" }).getAttribute("href")).toBe(`/projects/${P1}?focus=script&episode=2`);
  });
});

function aggregate(id: string, review: string, options: { name?: string; freshness?: string; approved?: boolean } = {}) {
  return { entityId: id, name: options.name, rowVersion: 2, currentRevisionId: `${id}-r`,
    approvedRevisionId: options.approved ?? review === "APPROVED" ? `${id}-r` : null,
    currentRevision: { reviewStatus: review, freshnessStatus: options.freshness ?? "CURRENT", reviewVersion: 2 } };
}

function entityRevisions(id: string, review: string, note: string | null) {
  return { aggregate: aggregate(id, review), items: [{ id: `${id}-r`, revisionNo: 1, content: { text: `${id} 的设定` },
    sourceScriptRevisionId: "script-1", reviewStatus: review, freshnessStatus: "CURRENT", reviewVersion: 2, reviewNote: note }] };
}

function sceneWorld(overrides: Partial<World> = {}): World {
  return { title: "夜班", story: story("APPROVED"), episodes: [episode(1, "APPROVED"), episode(2, null), episode(3, null)],
    scenes: [{ ...aggregate("scene-1", "APPROVED") }], ...overrides,
    revisions: { "scene-1": sceneRevisions(), ...overrides.revisions } };
}

function sceneRevisions() {
  return { aggregate: aggregate("scene-1", "APPROVED"), items: [{ id: "scene-1-r", revisionNo: 1, sourceScriptRevisionId: "script-1",
    locationRevisionId: "loc-03-r", ordinal: 1, heading: "雨夜", timeOfDay: null, summary: "", reviewStatus: "APPROVED",
    freshnessStatus: "CURRENT", reviewVersion: 2 }] };
}

describe("beginner flow targets the right object (Issue #52)", () => {
  it("item 1: after episode 1 is approved, 补齐剧本 opens the episode that still needs a script", async () => {
    window.history.replaceState(null, "", `/projects/${P1}/create?step=script`);
    const world: World = { title: "夜班", story: story("APPROVED"), episodes: [episode(1, "DRAFT"), episode(2, null), episode(3, null)] };
    install({ [P1]: world });
    render(<BeginnerFlow projectId={P1} />);
    expect(await screen.findByRole("tab", { name: /第 1 集 · ？ 待确认/, selected: true })).toBeTruthy();
    // Episode 1 is approved elsewhere (same step, no navigation); the page rereads the base.
    world.episodes = [episode(1, "APPROVED"), episode(2, null), episode(3, null)];
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(await screen.findByRole("tab", { name: /第 1 集 · ✓ 已完成/, selected: true })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "补齐剧本并保存" }));
    expect(await screen.findByRole("tab", { name: /第 2 集 · ＋ 待补充/, selected: true })).toBeTruthy();
  });

  it("item 1: with every episode done, the final step still opens a finished episode to view and download", async () => {
    window.history.replaceState(null, "", `/projects/${P1}/create?step=final`);
    const approved = [episode(1, "APPROVED"), episode(2, "APPROVED"), episode(3, "APPROVED")];
    const done = [{ status: "ACTIVE", reviewStatus: "APPROVED" }];
    install({ [P1]: { title: "夜班", story: story("APPROVED"), episodes: approved,
      characters: [aggregate("c1", "APPROVED", { name: "林夏" })], candidates: { "episode-1": [{}, {}], "episode-2": [{}, {}], "episode-3": [{}, {}] },
      composites: { "episode-1": done, "episode-2": done, "episode-3": done } } });
    render(<BeginnerFlow projectId={P1} />);
    fireEvent.click(await screen.findByRole("button", { name: "查看并下载成片" }));
    expect(screen.getByRole("tab", { name: /第 1 集 · ✓ 已完成/, selected: true })).toBeTruthy();
  });

  it("item 2: 查看原因并修改 opens the one returned location with its reason and its draft, not the new form", async () => {
    window.history.replaceState(null, "", `/projects/${P1}/create?step=cast`);
    window.sessionStorage.setItem(`ads-draft:${P1}:location:l1:l1-r`, JSON.stringify({ fingerprint: "f", idempotencyKey: "k",
      payload: { mode: "text", text: "我改到一半的场地", raw: "", parsed: null, sourceId: "script-1" }, ifMatch: 2 }));
    install({ [P1]: sceneWorld({ characters: [aggregate("c1", "APPROVED", { name: "林夏" })],
      locations: [aggregate("l1", "REJECTED", { name: "便利店" })], revisions: { l1: entityRevisions("l1", "REJECTED", "光线描述不够具体") } }) });
    render(<BeginnerFlow projectId={P1} />);
    fireEvent.click(await screen.findByRole("button", { name: "查看原因并修改" }));
    expect(await screen.findByRole("tab", { name: /场地/, selected: true })).toBeTruthy();
    expect(await screen.findByText(/退回原因：光线描述不够具体/)).toBeTruthy();
    const editor = document.querySelector<HTMLElement>("[data-entity-editor='l1'] textarea") as HTMLTextAreaElement;
    expect(editor.value).toBe("我改到一半的场地");
    await waitFor(() => expect(document.activeElement).toBe(editor));
    expect(document.activeElement?.id).not.toBe("entity-name");
  });

  it("item 2: several returned objects are offered as a choice, each opening its own editor", async () => {
    window.history.replaceState(null, "", `/projects/${P1}/create?step=cast`);
    install({ [P1]: sceneWorld({ characters: [aggregate("c1", "REJECTED", { name: "林夏" })],
      locations: [aggregate("l1", "APPROVED", { name: "便利店", freshness: "STALE" })],
      revisions: { c1: entityRevisions("c1", "REJECTED", "年龄不对"), l1: entityRevisions("l1", "APPROVED", null) } }) });
    render(<BeginnerFlow projectId={P1} />);
    fireEvent.click(await screen.findByRole("button", { name: /查看原因并修改|修改并保存新版本/ }));
    const group = await screen.findByRole("group", { name: "需要处理的人物与场地" });
    expect(group.textContent).toContain("角色 · 林夏");
    expect(group.textContent).toContain("场地 · 便利店");
    fireEvent.click(screen.getByRole("button", { name: /角色 · 林夏/ }));
    expect(await screen.findByText(/退回原因：年龄不对/)).toBeTruthy();
    expect(document.querySelector("[data-entity-editor='c1']")).toBeTruthy();
  });

  it("item 3: single-shot compose switched off shows the closed state and no action the server would reject", async () => {
    window.history.replaceState(null, "", `/projects/${P1}/create?step=sample`);
    capabilities = { compose: { shot: false, episode: false } };
    install({ [P1]: sceneWorld() });
    render(<BeginnerFlow projectId={P1} />);
    expect(await screen.findByText(/当前环境没有开启单镜成片所需的功能/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "选一个镜头试做" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "重新检查功能状态" })[0]!).toBeTruthy();
  });

  it("item 3: a failed capability read is neither closed nor open, and a recheck recovers", async () => {
    window.history.replaceState(null, "", `/projects/${P1}/create?step=sample`);
    capabilities = 503;
    install({ [P1]: sceneWorld() });
    render(<BeginnerFlow projectId={P1} />);
    expect(await screen.findByText(/没能读取服务端的合成功能状态/)).toBeTruthy();
    expect(screen.queryByText(/当前环境没有开启单镜成片所需的功能/)).toBeNull();
    capabilities = { compose: { shot: true, episode: true } };
    fireEvent.click(screen.getAllByRole("button", { name: "重新检查功能状态" })[0]!);
    // Switched on with no approved sample yet: the ordinary first action, and no feature notice.
    expect(await screen.findByRole("button", { name: "选一个镜头试做" })).toBeTruthy();
    expect(screen.queryByText(/没能读取服务端的合成功能状态/)).toBeNull();
    expect(screen.queryByText(/当前环境没有开启单镜成片所需的功能/)).toBeNull();
  });

  it("item 4: a new script revision of the same episode closes the open scene; approving again lets it be chosen anew", async () => {
    window.history.replaceState(null, "", `/projects/${P1}/create?step=sample`);
    const world = sceneWorld();
    install({ [P1]: world });
    render(<BeginnerFlow projectId={P1} />);
    fireEvent.click(await screen.findByRole("button", { name: /场景 1/ }));
    expect(await screen.findByLabelText("场地")).toBeTruthy();
    expect(screen.getByText(/在下方场景里打开一个镜头/)).toBeTruthy();
    // Same episode id, new current script revision awaiting review.
    world.episodes = [{ ...episode(1, "DRAFT"), currentScriptRevisionId: "script-1b" }, episode(2, null), episode(3, null)];
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(await screen.findByText("这一集的剧本还没有确认通过。请先在「看剧本」里完成审核。")).toBeTruthy();
    expect(screen.queryByText(/在下方场景里打开一个镜头/)).toBeNull();
    // The stale scene editor and its media controls are closed.
    expect(document.getElementById("edit-location")).toBeNull();
    // Approved again: nothing is restored by itself; the user picks a scene again.
    world.episodes = [{ ...episode(1, "APPROVED"), currentScriptRevisionId: "script-1b", approvedScriptRevisionId: "script-1b" }, episode(2, null), episode(3, null)];
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(await screen.findByRole("button", { name: /场景 1/, pressed: false })).toBeTruthy();
    expect(screen.queryByText(/在下方场景里打开一个镜头/)).toBeNull();
    expect(document.getElementById("edit-location")).toBeNull();
  });

  it("item 5: a completed 试一段 opens the episode that has the approved sample, and 继续制作 opens one that still needs it", async () => {
    window.history.replaceState(null, "", `/projects/${P1}/create?step=sample`);
    const approved = [episode(1, "APPROVED"), episode(2, "APPROVED"), episode(3, "APPROVED")];
    install({ [P1]: sceneWorld({ episodes: approved, candidates: { "episode-2": [{}] } }) });
    render(<BeginnerFlow projectId={P1} />);
    expect(await screen.findByRole("tab", { name: /第 2 集 · ✓ 已完成/, selected: true })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "继续制作第 1 集" }));
    expect(await screen.findByRole("tab", { name: /第 1 集 · ＋ 待补充/, selected: true })).toBeTruthy();
  });
});

describe("beginner scene editor locations (Issue #52 item 8)", () => {
  it("offers a location past the first page, keeps the old reference and the explicit clear", async () => {
    window.history.replaceState(null, "", `/projects/${P1}/create?step=sample`);
    const locations = Array.from({ length: 25 }, (_, index) => aggregate(`loc-${String(index + 1).padStart(2, "0")}`, "APPROVED", { name: `场地${index + 1}` }));
    const world = sceneWorld({ locations });
    install({ [P1]: world });
    render(<BeginnerFlow projectId={P1} />);
    fireEvent.click(await screen.findByRole("button", { name: /场景 1/ }));
    const select = await screen.findByLabelText("场地") as HTMLSelectElement;
    await waitFor(() => expect(Array.from(select.options).some((option) => option.textContent?.includes("场地25"))).toBe(true));
    expect(select.value).toBe("loc-03-r");
    expect(Array.from(select.options)[0]?.textContent).toBe("不引用场地");
    expect(screen.queryByText(/场地列表没有读全/)).toBeNull();
  });

  it("says when the complete location list failed instead of presenting the first page as all", async () => {
    window.history.replaceState(null, "", `/projects/${P1}/create?step=sample`);
    install({ [P1]: sceneWorld() });
    const realFetch = globalThis.fetch;
    let locationReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      // The base reads the first page; the complete bounded read (limit=50) fails.
      if (url.includes("/locations") && url.includes("limit=50")) {
        locationReads += 1;
        return json({ error: { code: "INTERNAL", message: "boom" } }, 500);
      }
      return realFetch(input, init);
    }));
    render(<BeginnerFlow projectId={P1} />);
    fireEvent.click(await screen.findByRole("button", { name: /场景 1/ }));
    expect(await screen.findByText(/场地列表没有读全（读取失败）/)).toBeTruthy();
    expect(locationReads).toBeGreaterThan(0);
  });
});

function candidate(id: string, ordinal: number) {
  return { assetId: id, shotId: `shot-${id}`, sceneOrdinal: 1, sceneHeading: "雨夜", shotOrdinal: ordinal, durationMs: 1000,
    reviewStatus: "APPROVED" };
}

describe("compose capability gate (PR #53 review 2 and 3)", () => {
  it("recheck really reads the capability again: closed, enabled on the server, recheck, open", async () => {
    window.history.replaceState(null, "", `/projects/${P1}/create?step=sample`);
    capabilities = { compose: { shot: false, episode: false } };
    install({ [P1]: sceneWorld() });
    render(<BeginnerFlow projectId={P1} />);
    expect(await screen.findByText(/当前环境没有开启单镜成片所需的功能/)).toBeTruthy();
    const before = capabilityReads;
    capabilities = { compose: { shot: true, episode: true } };
    fireEvent.click(screen.getAllByRole("button", { name: "重新检查功能状态" })[0]!);
    expect(await screen.findByRole("button", { name: "选一个镜头试做" })).toBeTruthy();
    expect(capabilityReads).toBe(before + 1);
    expect(screen.queryByText(/当前环境没有开启单镜成片所需的功能/)).toBeNull();
  });

  it("a recheck in flight is not repeated, and a late answer of an older check never overrides a newer one", async () => {
    window.history.replaceState(null, "", `/projects/${P1}/create?step=sample`);
    let lateOld!: () => void;
    capabilityQueue = [() => new Promise<Response>((done) => { lateOld = () => done(capabilityAnswer({ shot: false, episode: false })); })];
    const worlds = { [P1]: sceneWorld(), [P2]: sceneWorld({ title: "第二部" }) };
    install(worlds);
    const view = render(<BeginnerFlow projectId={P1} />);
    expect(await screen.findByText(/正在检查服务端的合成功能状态/)).toBeTruthy();
    const primary = screen.getByRole("button", { name: "正在检查功能状态" });
    fireEvent.click(primary);
    fireEvent.click(primary);
    expect(capabilityReads).toBe(1);
    // Another work opens in the same component: its own check answers "open"; the old check answers "closed" late.
    view.rerender(<BeginnerFlow projectId={P2} />);
    expect(await screen.findByRole("heading", { name: "第二部" })).toBeTruthy();
    await waitFor(() => expect(capabilityReads).toBe(2));
    await act(async () => { lateOld(); });
    await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
    expect(screen.queryByText(/当前环境没有开启单镜成片所需的功能/)).toBeNull();
  });

  it("a failed recheck keeps the chosen scene, says unconfirmed, and a later recheck succeeds", async () => {
    window.history.replaceState(null, "", `/projects/${P1}/create?step=sample`);
    capabilities = 503;
    install({ [P1]: sceneWorld() });
    render(<BeginnerFlow projectId={P1} />);
    expect(await screen.findByText(/没能读取服务端的合成功能状态/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /场景 1/ }));
    expect(await screen.findByLabelText("场地")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "重新检查功能状态" })[0]!);
    expect(await screen.findByText(/没能读取服务端的合成功能状态/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /场景 1/, pressed: true })).toBeTruthy();
    capabilities = { compose: { shot: true, episode: true } };
    fireEvent.click(screen.getAllByRole("button", { name: "重新检查功能状态" })[0]!);
    await waitFor(() => expect(screen.queryByText(/没能读取服务端的合成功能状态/)).toBeNull());
    expect(screen.getByRole("button", { name: /场景 1/, pressed: true })).toBeTruthy();
    expect(screen.getByLabelText("场地")).toBeTruthy();
  });

  it("while the capability is pending, step 4 offers no compose action even though every other fact is ready", async () => {
    window.history.replaceState(null, "", `/projects/${P1}/create?step=sample`);
    let answer!: () => void;
    capabilityQueue = [() => new Promise<Response>((done) => { answer = () => done(capabilityAnswer({ shot: true, episode: true })); })];
    install({ [P1]: sceneWorld() });
    render(<BeginnerFlow projectId={P1} />);
    expect(await screen.findByText(/正在检查服务端的合成功能状态/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "选一个镜头试做" })).toBeNull();
    expect((screen.getByRole("button", { name: "正在检查功能状态" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { answer(); });
    expect(await screen.findByRole("button", { name: "选一个镜头试做" })).toBeTruthy();
  });

  it("step 5 opened directly: the inner preflight and submit stay closed until enabled, the arrangement survives, and an approved cut stays downloadable", async () => {
    window.history.replaceState(null, "", `/projects/${P1}/create?step=final`);
    let answer!: () => void;
    capabilityQueue = [() => new Promise<Response>((done) => { answer = () => done(capabilityAnswer({ shot: true, episode: true })); })];
    install({ [P1]: sceneWorld({
      candidates: { "episode-1": [candidate("cut-a", 1), candidate("cut-b", 2)] },
      composites: { "episode-1": [{ assetId: "episode-cut", status: "ACTIVE", reviewStatus: "APPROVED", rowVersion: 2, durationMs: 2000,
        reviewedContentHash: "h", contentHash: "h", segments: [] } as never] },
    }) });
    render(<BeginnerFlow projectId={P1} />);
    const panel = await screen.findByRole("region", { name: "多镜编排" });
    expect(await screen.findByText(/正在检查服务端的合成功能状态/)).toBeTruthy();
    for (const button of await within(panel).findAllByRole("button", { name: "加入" })) fireEvent.click(button);
    expect(panel.querySelectorAll("[data-selected-asset-id]")).toHaveLength(2);
    expect((within(panel).getByRole("button", { name: "预检编排" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(panel).getByRole("button", { name: "开始多镜合成" }) as HTMLButtonElement).disabled).toBe(true);
    // The approved cut is still listed and downloadable: viewing does not depend on compose.
    expect(await within(panel).findByRole("button", { name: "下载 MP4" })).toBeTruthy();
    await act(async () => { answer(); });
    await waitFor(() => expect((within(panel).getByRole("button", { name: "预检编排" }) as HTMLButtonElement).disabled).toBe(false));
    expect(panel.querySelectorAll("[data-selected-asset-id]")).toHaveLength(2);
  });

  it("step 5 with episode compose closed: inner controls closed, the notice and a recheck shown", async () => {
    window.history.replaceState(null, "", `/projects/${P1}/create?step=final`);
    capabilities = { compose: { shot: true, episode: false } };
    install({ [P1]: sceneWorld({ candidates: { "episode-1": [candidate("cut-a", 1), candidate("cut-b", 2)] } }) });
    render(<BeginnerFlow projectId={P1} />);
    expect(await screen.findByText(/当前环境没有开启集级合成/)).toBeTruthy();
    const panel = await screen.findByRole("region", { name: "多镜编排" });
    for (const button of await within(panel).findAllByRole("button", { name: "加入" })) fireEvent.click(button);
    expect((within(panel).getByRole("button", { name: "预检编排" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByRole("button", { name: "重新检查功能状态" })[0]!).toBeTruthy();
  });
});

describe("refresh banner tells the truth about retries (PR #53 review 1)", () => {
  it("a failed reread while idle shows 正在自动重试 and recovers without a click", async () => {
    window.history.replaceState(null, "", `/projects/${P1}/create?step=story`);
    const world: World = { title: "夜班", story: story("DRAFT"), episodes: [] };
    install({ [P1]: world });
    render(<BeginnerFlow projectId={P1} />);
    expect(await screen.findByRole("heading", { name: "第 1 步 · 定故事" })).toBeTruthy();
    world.projectFailures = 1;
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(await screen.findByText(/正在自动重试/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/正在自动重试/)).toBeNull(), { timeout: 6000 });
  });
});

describe("primary action targets the episode behind the step state (Issue #54 A)", () => {
  it("episode 1 DRAFT shown, episode 2 REJECTED: 查看原因并修改 opens episode 2 and keeps episode 1's draft", async () => {
    window.history.replaceState(null, "", `/projects/${P1}/create?step=script`);
    window.sessionStorage.setItem(`ads-draft:${P1}:script:episode-1:script-1`, JSON.stringify({ fingerprint: "f", idempotencyKey: "k",
      payload: { mode: "text", text: "第一集草稿", raw: "", parsed: null, sourceId: null }, ifMatch: 1 }));
    install({ [P1]: { title: "夜班", story: story("APPROVED"), episodes: [episode(1, "DRAFT"), episode(2, "REJECTED"), episode(3, "APPROVED")] } });
    render(<BeginnerFlow projectId={P1} />);
    expect(await screen.findByRole("tab", { name: /第 1 集/, selected: true })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "查看原因并修改" }));
    expect(await screen.findByRole("tab", { name: /第 2 集 · ！ 需要处理/, selected: true })).toBeTruthy();
    expect(window.sessionStorage.getItem(`ads-draft:${P1}:script:episode-1:script-1`)).toContain("第一集草稿");
  });
});

/** A capability answer that never comes and ignores abort, like a stuck connection. */
const never = () => new Promise<Response>(() => undefined);

describe("a stuck capability read ends with a timeout and a retry (Issue #54 C)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function advance(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }

  it("never answers: after the timeout the page stops waiting, says so, and a retry recovers", async () => {
    window.history.replaceState(null, "", `/projects/${P1}/create?step=sample`);
    capabilityQueue = [never];
    install({ [P1]: sceneWorld() });
    render(<BeginnerFlow projectId={P1} />);
    expect(await screen.findByText(/正在检查服务端的合成功能状态/)).toBeTruthy();
    await advance(14_000);
    expect(screen.queryByText(/功能状态检查超时，请重试/)).toBeNull();
    await advance(1_000);
    expect(await screen.findByText(/功能状态检查超时，请重试/)).toBeTruthy();
    // The stuck read was cancelled; no new read starts by itself.
    expect(capabilitySignals[0]?.aborted).toBe(true);
    expect(capabilityReads).toBe(1);
    await advance(60_000);
    expect(capabilityReads).toBe(1);
    expect(screen.queryByRole("button", { name: "选一个镜头试做" })).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "重新检查功能状态" })[0]!);
    expect(await screen.findByRole("button", { name: "选一个镜头试做" })).toBeTruthy();
    expect(capabilityReads).toBe(2);
  });

  it("an old read answering after its timeout (success or failure) never overrides the retry", async () => {
    window.history.replaceState(null, "", `/projects/${P1}/create?step=sample`);
    let lateClosed!: () => void;
    let lateFailure!: () => void;
    capabilityQueue = [
      () => new Promise<Response>((done) => { lateClosed = () => done(capabilityAnswer({ shot: false, episode: false })); }),
      () => new Promise<Response>((done) => { lateFailure = () => done(capabilityAnswer(503)); }),
    ];
    install({ [P1]: sceneWorld() });
    render(<BeginnerFlow projectId={P1} />);
    await advance(15_000);
    fireEvent.click((await screen.findAllByRole("button", { name: "重新检查功能状态" }))[0]!);
    await advance(15_000);
    expect(await screen.findByText(/功能状态检查超时，请重试/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "重新检查功能状态" })[0]!);
    expect(await screen.findByRole("button", { name: "选一个镜头试做" })).toBeTruthy();
    await act(async () => { lateClosed(); lateFailure(); });
    await advance(100);
    expect(screen.getByRole("button", { name: "选一个镜头试做" })).toBeTruthy();
    expect(screen.queryByText(/当前环境没有开启单镜成片所需的功能/)).toBeNull();
    expect(screen.queryByText(/没能读取服务端的合成功能状态/)).toBeNull();
  });

  it("rapid clicks while a check runs start one read; a quick answer never shows the timeout", async () => {
    window.history.replaceState(null, "", `/projects/${P1}/create?step=sample`);
    capabilities = { compose: { shot: false, episode: false } };
    install({ [P1]: sceneWorld() });
    render(<BeginnerFlow projectId={P1} />);
    expect(await screen.findByText(/当前环境没有开启单镜成片所需的功能/)).toBeTruthy();
    capabilityQueue = [never];
    fireEvent.click(screen.getAllByRole("button", { name: "重新检查功能状态" })[0]!);
    for (const button of screen.queryAllByRole("button", { name: /功能状态/ })) fireEvent.click(button);
    expect(capabilityReads).toBe(2);
    await advance(15_000);
    capabilities = { compose: { shot: true, episode: true } };
    fireEvent.click(screen.getAllByRole("button", { name: "重新检查功能状态" })[0]!);
    expect(await screen.findByRole("button", { name: "选一个镜头试做" })).toBeTruthy();
    await advance(30_000);
    expect(screen.queryByText(/功能状态检查超时/)).toBeNull();
  });

  it("switching works or unmounting cancels the pending read and its timer", async () => {
    window.history.replaceState(null, "", `/projects/${P1}/create?step=sample`);
    capabilityQueue = [never, never];
    install({ [P1]: sceneWorld(), [P2]: sceneWorld({ title: "第二部" }) });
    const view = render(<BeginnerFlow projectId={P1} />);
    await waitFor(() => expect(capabilityReads).toBe(1));
    view.rerender(<BeginnerFlow projectId={P2} />);
    await waitFor(() => expect(capabilityReads).toBe(2));
    expect(capabilitySignals[0]?.aborted).toBe(true);
    view.unmount();
    expect(capabilitySignals[1]?.aborted).toBe(true);
    await advance(30_000);
    expect(capabilityReads).toBe(2);
  });
});

describe("a closed compose notice always offers a recheck (Issue #54 D)", () => {
  it("试一段 done on episode 1, episode 2 unfinished, shot compose closed: the notice rechecks and reopens", async () => {
    window.history.replaceState(null, "", `/projects/${P1}/create?step=sample`);
    capabilities = { compose: { shot: false, episode: false } };
    const approved = [episode(1, "APPROVED"), episode(2, "APPROVED"), episode(3, null)];
    install({ [P1]: sceneWorld({ episodes: approved, candidates: { "episode-1": [{}] } }) });
    render(<BeginnerFlow projectId={P1} />);
    const notice = await screen.findByText(/当前环境没有开启单镜成片所需的功能/);
    // The step is done, so the primary action continues; the recheck lives in the notice.
    expect(screen.getByRole("button", { name: "继续下一步" })).toBeTruthy();
    const box = notice.closest("[role='status']") as HTMLElement;
    capabilities = { compose: { shot: true, episode: true } };
    const before = capabilityReads;
    fireEvent.click(within(box).getByRole("button", { name: "重新检查功能状态" }));
    await waitFor(() => expect(screen.queryByText(/当前环境没有开启单镜成片所需的功能/)).toBeNull());
    expect(capabilityReads).toBe(before + 1);
    expect(screen.getByRole("button", { name: "继续下一步" })).toBeTruthy();
  });

  it("every episode cut done and episode compose closed: recheck is offered, the approved cut stays downloadable and the arrangement stays", async () => {
    window.history.replaceState(null, "", `/projects/${P1}/create?step=final`);
    capabilities = { compose: { shot: true, episode: false } };
    const approved = [episode(1, "APPROVED"), episode(2, "APPROVED"), episode(3, "APPROVED")];
    const cut = (id: string) => ({ assetId: id, status: "ACTIVE", reviewStatus: "APPROVED", rowVersion: 2, durationMs: 2000,
      reviewedContentHash: "h", contentHash: "h", segments: [] }) as never;
    install({ [P1]: sceneWorld({ episodes: approved,
      candidates: { "episode-1": [candidate("cut-a", 1), candidate("cut-b", 2)], "episode-2": [{}, {}], "episode-3": [{}, {}] },
      composites: { "episode-1": [cut("e1-cut")], "episode-2": [cut("e2-cut")], "episode-3": [cut("e3-cut")] } }) });
    render(<BeginnerFlow projectId={P1} />);
    expect(await screen.findByRole("button", { name: "查看并下载成片" })).toBeTruthy();
    const notice = await screen.findByText(/当前环境没有开启集级合成/);
    const panel = await screen.findByRole("region", { name: "多镜编排" });
    for (const button of await within(panel).findAllByRole("button", { name: "加入" })) fireEvent.click(button);
    expect(await within(panel).findByRole("button", { name: "下载 MP4" })).toBeTruthy();
    capabilities = { compose: { shot: true, episode: true } };
    fireEvent.click(within(notice.closest("[role='status']") as HTMLElement).getByRole("button", { name: "重新检查功能状态" }));
    await waitFor(() => expect((within(panel).getByRole("button", { name: "预检编排" }) as HTMLButtonElement).disabled).toBe(false));
    expect(panel.querySelectorAll("[data-selected-asset-id]")).toHaveLength(2);
    expect(within(panel).getByRole("button", { name: "下载 MP4" })).toBeTruthy();
    // Single-shot compose is open, so the sample step has no closed notice.
    fireEvent.click(screen.getByRole("button", { name: /第 4 步 试一段/ }));
    expect(screen.queryByText(/当前环境没有开启单镜成片所需的功能/)).toBeNull();
  });
});
