// @vitest-environment happy-dom
// useProjectBase against a stubbed fetch with controllable answers and fake timers. No browser or server.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectBase, type WorkflowRun } from "./project-base";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function composeRun(state: string): WorkflowRun {
  return { id: "run-compose", type: "MEDIA_COMPOSE", status: state, createdAt: "2026-10-07T00:00:00.000Z",
    jobs: [{ id: "job-compose", kind: "MEDIA_COMPOSE", state, errorCode: null, errorMessage: null, sourceShotRevisionId: null,
      composeEpisodeId: "e1" }] };
}

interface Server {
  runs: WorkflowRun[];
  /** Answers for /projects/:id, consumed in order; a function is awaited (to hold or fail a request). */
  project: Array<() => Promise<Response>>;
  runsHold?: Promise<void>;
  /** How many of the next workflow-runs reads answer 503. */
  runsFail?: number;
  calls: string[];
}

function install(server: Server) {
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const path = String(input).split("?")[0] ?? "";
    server.calls.push(path);
    if (/^\/api\/v1\/projects\/[^/]+$/.test(path)) {
      const next = server.project.shift();
      if (next) return next();
      const id = path.split("/").at(-1);
      return json({ id, title: `作品 ${id?.slice(0, 2)}`, premise: "", version: 1, status: "ACTIVE" });
    }
    if (path.endsWith("/workflow-runs")) {
      if (server.runsHold) await server.runsHold;
      if (server.runsFail) {
        server.runsFail -= 1;
        return json({ error: { code: "UNAVAILABLE", message: "暂时不可用" } }, 503);
      }
      return json(server.runs);
    }
    if (path.endsWith("/episodes")) return json({ items: [] });
    return json({ items: [], nextCursor: null });
  }));
}

const projectReads = (server: Server) => server.calls.filter((path) => /^\/api\/v1\/projects\/[^/]+$/.test(path)).length;

let visibility: "visible" | "hidden" = "visible";

function setVisibility(next: "visible" | "hidden") {
  visibility = next;
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
}

const runsReads = (server: Server) => server.calls.filter((path) => path.endsWith("/workflow-runs")).length;

async function settle() {
  await act(async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); });
}

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useProjectBase follows compose runs it did not submit (final review 1)", () => {
  it("keeps reading a RUNNING compose found on entry, and stops once it is SUCCEEDED", async () => {
    const server: Server = { runs: [composeRun("RUNNING")], project: [], calls: [] };
    install(server);
    const { result } = renderHook(() => useProjectBase(P1, "失败"));
    await settle();
    expect(result.current.allRuns[0]?.status).toBe("RUNNING");
    const epoch = result.current.imageEpoch;
    expect(runsReads(server)).toBe(1);
    await advance(2000);
    expect(runsReads(server)).toBe(2);
    server.runs = [composeRun("SUCCEEDED")];
    await advance(2000);
    expect(runsReads(server)).toBe(3);
    expect(result.current.allRuns[0]?.status).toBe("SUCCEEDED");
    // The compose finishing rereads the media and progress facts.
    expect(result.current.imageEpoch).toBe(epoch + 1);
    await advance(20_000);
    expect(runsReads(server)).toBe(3);
  });

  it.each(["FAILED", "CANCELED"])("leaves 处理中 when the compose is %s and stops reading", async (state) => {
    const server: Server = { runs: [composeRun("RUNNING")], project: [], calls: [] };
    install(server);
    const { result } = renderHook(() => useProjectBase(P1, "失败"));
    await settle();
    server.runs = [composeRun(state)];
    await advance(2000);
    expect(result.current.allRuns[0]?.status).toBe(state);
    const reads = runsReads(server);
    await advance(20_000);
    expect(runsReads(server)).toBe(reads);
  });

  it("never overlaps reads while one is slow", async () => {
    const server: Server = { runs: [composeRun("RUNNING")], project: [], calls: [] };
    install(server);
    renderHook(() => useProjectBase(P1, "失败"));
    await settle();
    let release!: () => void;
    server.runsHold = new Promise<void>((done) => { release = done; });
    await advance(2000);
    expect(runsReads(server)).toBe(2);
    await advance(20_000);
    // Still the one slow read: nothing was scheduled while it was in flight.
    expect(runsReads(server)).toBe(2);
    server.runsHold = undefined;
    await act(async () => { release(); await Promise.resolve(); });
    await settle();
    await advance(2000);
    expect(runsReads(server)).toBe(3);
  });
});

describe("useProjectBase ignores answers of superseded loads (final review 3)", () => {
  it("does not let an old load's late failure overwrite a newer success", async () => {
    let failOld!: () => void;
    const server: Server = { runs: [], calls: [], project: [
      () => new Promise<Response>((done) => { failOld = () => done(json({ error: { code: "INTERNAL", message: "旧请求失败" } }, 500)); }),
    ] };
    install(server);
    const { result } = renderHook(() => useProjectBase(P1, "失败"));
    await settle();
    expect(result.current.loading).toBe(true);
    await act(async () => { await result.current.reloadBase(); });
    expect(result.current.project?.id).toBe(P1);
    await act(async () => { failOld(); });
    await settle();
    expect(result.current.error).toBeNull();
    expect(result.current.project?.id).toBe(P1);
  });

  it("keeps loading on while the current load runs, whatever an older load's finally does", async () => {
    let failOld!: () => void;
    let finishNew!: () => void;
    const server: Server = { runs: [], calls: [], project: [
      () => new Promise<Response>((done) => { failOld = () => done(json({ error: { code: "INTERNAL", message: "旧" } }, 500)); }),
      () => new Promise<Response>((done) => { finishNew = () => done(json({ id: P2, title: "新作品", premise: "", version: 1, status: "ACTIVE" })); }),
    ] };
    install(server);
    const { result, rerender } = renderHook(({ id }) => useProjectBase(id, "失败"), { initialProps: { id: P1 } });
    await settle();
    rerender({ id: P2 });
    await settle();
    await act(async () => { failOld(); });
    await settle();
    // The old project's failure neither closes the new load nor shows as the new project's error.
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();
    await act(async () => { finishNew(); });
    await settle();
    expect(result.current.loading).toBe(false);
    expect(result.current.project?.id).toBe(P2);
    expect(result.current.error).toBeNull();
  });

  it("shows a real failure of the current load, and clears it after a later success", async () => {
    const server: Server = { runs: [], calls: [], project: [
      async () => json({ error: { code: "INTERNAL", message: "当前失败" } }, 500),
    ] };
    install(server);
    const { result } = renderHook(() => useProjectBase(P1, "失败"));
    await settle();
    expect(result.current.error).toBe("当前失败");
    expect(result.current.loading).toBe(false);
    // reloadBase still rejects for the current request, so callers do not mistake a failure for success.
    server.project.push(async () => json({ error: { code: "INTERNAL", message: "再次失败" } }, 500));
    await act(async () => { await expect(result.current.reloadBase()).rejects.toMatchObject({ detail: "再次失败" }); });
    await act(async () => { await result.current.reloadBase(); });
    expect(result.current.error).toBeNull();
    expect(result.current.project?.id).toBe(P1);
  });
});

describe("useProjectBase keeps one loading identity per project (Issue #52 item 9)", () => {
  it("does not let the superseded initial load end a same-project reload still in flight", async () => {
    let finishOld!: () => void;
    let finishNew!: () => void;
    const answer = () => json({ id: P1, title: "作品", premise: "", version: 1, status: "ACTIVE" });
    const server: Server = { runs: [], calls: [], project: [
      () => new Promise<Response>((done) => { finishOld = () => done(answer()); }),
      () => new Promise<Response>((done) => { finishNew = () => done(answer()); }),
    ] };
    install(server);
    const { result } = renderHook(() => useProjectBase(P1, "失败"));
    await settle();
    let manual!: Promise<void>;
    act(() => { manual = result.current.reloadBase(); });
    await settle();
    await act(async () => { finishOld(); });
    await settle();
    // The initial request was superseded: it writes nothing, and its end does not end the newer read.
    expect(result.current.loading).toBe(true);
    expect(result.current.project).toBeNull();
    await act(async () => { finishNew(); await manual; });
    await settle();
    expect(result.current.loading).toBe(false);
    expect(result.current.project?.id).toBe(P1);
  });

  it("shows the failure of the reload that superseded the initial load", async () => {
    let finishOld!: () => void;
    const server: Server = { runs: [], calls: [], project: [
      () => new Promise<Response>((done) => { finishOld = () => done(json({ id: P1, title: "旧", premise: "", version: 1, status: "ACTIVE" })); }),
      async () => json({ error: { code: "INTERNAL", message: "新读取失败" } }, 500),
    ] };
    install(server);
    const { result } = renderHook(() => useProjectBase(P1, "失败"));
    await settle();
    await act(async () => { await result.current.reloadBase().catch(() => undefined); });
    await act(async () => { finishOld(); });
    await settle();
    expect(result.current.loading).toBe(false);
    expect(result.current.project).toBeNull();
    expect(result.current.error).toBe("新读取失败");
  });

  it("a background reload never turns loading back on or clears what is shown", async () => {
    let finish!: () => void;
    const server: Server = { runs: [], calls: [], project: [] };
    install(server);
    const { result } = renderHook(() => useProjectBase(P1, "失败"));
    await settle();
    expect(result.current.project?.id).toBe(P1);
    server.project.push(() => new Promise<Response>((done) => { finish = () => done(json({ id: P1, title: "改名", premise: "", version: 2, status: "ACTIVE" })); }));
    let manual!: Promise<void>;
    act(() => { manual = result.current.reloadBase(); });
    await settle();
    expect(result.current.loading).toBe(false);
    expect(result.current.project?.id).toBe(P1);
    await act(async () => { finish(); await manual; });
    expect(result.current.project?.title).toBe("改名");
  });
});

describe("useProjectBase recovers polling after a failed visible refresh (Issue #52 item 7)", () => {
  it("hidden, visible, one 503, and the terminal state still appears by itself", async () => {
    const server: Server = { runs: [composeRun("RUNNING")], project: [], calls: [] };
    install(server);
    const { result } = renderHook(() => useProjectBase(P1, "失败"));
    await settle();
    setVisibility("hidden");
    await advance(2000);
    const hiddenReads = server.calls.length;
    await advance(60_000);
    // Nothing is read while hidden.
    expect(server.calls.length).toBe(hiddenReads);
    // The job finishes meanwhile; the first visible reread hits a transient 503 on the project read, so
    // Promise.all drops the workflow answer too.
    server.runs = [composeRun("SUCCEEDED")];
    server.project.push(async () => json({ error: { code: "UNAVAILABLE", message: "暂时不可用" } }, 503));
    setVisibility("visible");
    await settle();
    expect(result.current.allRuns[0]?.status).toBe("RUNNING");
    expect(result.current.refreshFailed).toBe(true);
    // No click, no reload: the bounded retry rereads the base and reaches the terminal state.
    await advance(10_000);
    expect(result.current.allRuns[0]?.status).toBe("SUCCEEDED");
    expect(result.current.refreshFailed).toBe(false);
    expect(result.current.error).toBeNull();
    const reads = server.calls.length;
    await advance(60_000);
    // Terminal: nothing more is read.
    expect(server.calls.length).toBe(reads);
  });

  it("does not start a second visible refresh while the first is still in flight", async () => {
    const server: Server = { runs: [composeRun("RUNNING")], project: [], calls: [] };
    install(server);
    renderHook(() => useProjectBase(P1, "失败"));
    await settle();
    setVisibility("hidden");
    await advance(2000);
    let release!: () => void;
    server.project.push(() => new Promise<Response>((done) => { release = () => done(json({ id: P1, title: "作品", premise: "", version: 1, status: "ACTIVE" })); }));
    const before = projectReads(server);
    setVisibility("visible");
    setVisibility("hidden");
    setVisibility("visible");
    await settle();
    expect(projectReads(server)).toBe(before + 1);
    await advance(20_000);
    expect(projectReads(server)).toBe(before + 1);
    await act(async () => { release(); });
    await settle();
  });

  it("backs off while workflow reads keep failing instead of retrying every two seconds", async () => {
    const server: Server = { runs: [composeRun("RUNNING")], project: [], calls: [] };
    install(server);
    const { result } = renderHook(() => useProjectBase(P1, "失败"));
    await settle();
    expect(result.current.allRuns[0]?.status).toBe("RUNNING");
    server.runsFail = 1000;
    const before = runsReads(server);
    await advance(60_000);
    // 2 s, 4 s, 8 s, 16 s, 30 s: a bounded rate, never a tight loop.
    expect(runsReads(server) - before).toBeLessThanOrEqual(6);
    expect(runsReads(server) - before).toBeGreaterThanOrEqual(3);
    server.runsFail = 0;
    server.runs = [composeRun("SUCCEEDED")];
    await advance(60_000);
    expect(result.current.allRuns[0]?.status).toBe("SUCCEEDED");
  });
});

describe("useProjectBase wakes the retry after an idle read failure (PR #53 review 1)", () => {
  it("idle, callback reread gets a 503, the server recovers: the page reads again by itself and finds the new job", async () => {
    const server: Server = { runs: [], project: [], calls: [] };
    install(server);
    const { result } = renderHook(() => useProjectBase(P1, "失败"));
    await settle();
    // Nothing runs: the poll chain has ended.
    await advance(30_000);
    const idle = projectReads(server);
    // A save or compose callback rereads; that read fails once, and a job was accepted meanwhile.
    server.project.push(async () => json({ error: { code: "UNAVAILABLE", message: "暂时不可用" } }, 503));
    server.runs = [composeRun("QUEUED")];
    await act(async () => { await result.current.reloadBase().catch(() => undefined); });
    expect(result.current.refreshFailed).toBe(true);
    // No click: the retry runs, reads the new job, and keeps following it to its end.
    await advance(2000);
    expect(projectReads(server)).toBe(idle + 2);
    expect(result.current.refreshPaused).toBe(false);
    expect(result.current.refreshFailed).toBe(false);
    expect(result.current.allRuns[0]?.status).toBe("QUEUED");
    server.runs = [composeRun("SUCCEEDED")];
    await advance(2000);
    expect(result.current.allRuns[0]?.status).toBe("SUCCEEDED");
    const reads = server.calls.length;
    await advance(120_000);
    expect(server.calls.length).toBe(reads);
  });

  it("one retry chain only: repeated failed callbacks do not stack timers, and slow retries never overlap", async () => {
    const server: Server = { runs: [], project: [], calls: [] };
    install(server);
    const { result } = renderHook(() => useProjectBase(P1, "失败"));
    await settle();
    await advance(30_000);
    const idle = projectReads(server);
    for (let index = 0; index < 3; index += 1) {
      server.project.push(async () => json({ error: { code: "UNAVAILABLE", message: "x" } }, 503));
      await act(async () => { await result.current.reloadBase().catch(() => undefined); });
    }
    expect(projectReads(server)).toBe(idle + 3);
    let release!: () => void;
    server.project.push(() => new Promise<Response>((done) => { release = () => done(json({ id: P1, title: "作品", premise: "", version: 1, status: "ACTIVE" })); }));
    await advance(2000);
    expect(projectReads(server)).toBe(idle + 4);
    await advance(60_000);
    // Still the one slow retry: nothing else was started.
    expect(projectReads(server)).toBe(idle + 4);
    await act(async () => { release(); });
    await settle();
    expect(result.current.refreshFailed).toBe(false);
    await advance(60_000);
    expect(projectReads(server)).toBe(idle + 4);
  });

  it("pauses while hidden and resumes the pending retry when visible", async () => {
    const server: Server = { runs: [], project: [], calls: [] };
    install(server);
    const { result } = renderHook(() => useProjectBase(P1, "失败"));
    await settle();
    server.project.push(async () => json({ error: { code: "UNAVAILABLE", message: "x" } }, 503));
    await act(async () => { await result.current.reloadBase().catch(() => undefined); });
    setVisibility("hidden");
    const hidden = server.calls.length;
    await advance(60_000);
    expect(server.calls.length).toBe(hidden);
    setVisibility("visible");
    await settle();
    expect(result.current.refreshFailed).toBe(false);
  });

  it("a switched or unmounted project never wakes its old retry", async () => {
    const server: Server = { runs: [], project: [], calls: [] };
    install(server);
    const { result, rerender, unmount } = renderHook(({ id }) => useProjectBase(id, "失败"), { initialProps: { id: P1 } });
    await settle();
    let failOld!: () => void;
    server.project.push(() => new Promise<Response>((done) => { failOld = () => done(json({ error: { code: "UNAVAILABLE", message: "x" } }, 503)); }));
    let pending!: Promise<void>;
    act(() => { pending = result.current.reloadBase().catch(() => undefined); });
    rerender({ id: P2 });
    await settle();
    await act(async () => { failOld(); await pending; });
    expect(result.current.refreshFailed).toBe(false);
    const after = server.calls.filter((path) => path.includes(P1)).length;
    await advance(60_000);
    expect(server.calls.filter((path) => path.includes(P1)).length).toBe(after);
    unmount();
    const total = server.calls.length;
    await advance(60_000);
    expect(server.calls.length).toBe(total);
  });

  it("after the automatic retries are used up it says so, and a manual retry recovers", async () => {
    const server: Server = { runs: [], project: [], calls: [] };
    install(server);
    const { result } = renderHook(() => useProjectBase(P1, "失败"));
    await settle();
    const fail = async () => json({ error: { code: "UNAVAILABLE", message: "x" } }, 503);
    server.project.push(fail, fail, fail, fail, fail, fail, fail, fail);
    await act(async () => { await result.current.reloadBase().catch(() => undefined); });
    await advance(600_000);
    expect(result.current.refreshFailed).toBe(true);
    expect(result.current.refreshPaused).toBe(true);
    const reads = projectReads(server);
    await advance(600_000);
    expect(projectReads(server)).toBe(reads);
    server.project.length = 0;
    await act(async () => { await result.current.retryNow(); });
    expect(result.current.refreshFailed).toBe(false);
    expect(result.current.refreshPaused).toBe(false);
  });
});

describe("a current successful reread ends the failure backoff (Issue #54 B)", () => {
  const fail = async () => json({ error: { code: "UNAVAILABLE", message: "x" } }, 503);

  it("retries exhausted, an outside reread succeeds, a new 503 gets automatic retries again", async () => {
    const server: Server = { runs: [], project: [], calls: [] };
    install(server);
    const { result } = renderHook(() => useProjectBase(P1, "失败"));
    await settle();
    server.project.push(fail, fail, fail, fail, fail, fail, fail, fail);
    await act(async () => { await result.current.reloadBase().catch(() => undefined); });
    await advance(600_000);
    expect(result.current.refreshPaused).toBe(true);
    server.project.length = 0;
    await act(async () => { await result.current.reloadBase(); });
    expect(result.current.refreshPaused).toBe(false);
    expect(result.current.refreshFailed).toBe(false);
    server.project.push(fail);
    await act(async () => { await result.current.reloadBase().catch(() => undefined); });
    expect(result.current.refreshPaused).toBe(false);
    const reads = projectReads(server);
    await advance(2000);
    expect(projectReads(server)).toBe(reads + 1);
    expect(result.current.refreshFailed).toBe(false);
  });

  it("after failed retries, an outside success that finds a new job follows it at the normal interval", async () => {
    const server: Server = { runs: [], project: [], calls: [] };
    install(server);
    const { result } = renderHook(() => useProjectBase(P1, "失败"));
    await settle();
    server.project.push(fail, fail, fail);
    await act(async () => { await result.current.reloadBase().catch(() => undefined); });
    await advance(2000);
    await advance(4000);
    // Two automatic retries failed: the next one waits 8 s.
    expect(server.project).toHaveLength(0);
    server.runs = [composeRun("QUEUED")];
    await act(async () => { await result.current.reloadBase(); });
    const runs = runsReads(server);
    await advance(2000);
    expect(runsReads(server)).toBe(runs + 1);
    server.runs = [composeRun("SUCCEEDED")];
    await advance(2000);
    expect(result.current.allRuns[0]?.status).toBe("SUCCEEDED");
    const total = server.calls.length;
    await advance(120_000);
    expect(server.calls.length).toBe(total);
  });

  it("an old success arriving after a newer failure does not clear that failure", async () => {
    const server: Server = { runs: [], project: [], calls: [] };
    install(server);
    const { result } = renderHook(() => useProjectBase(P1, "失败"));
    await settle();
    let finishOld!: () => void;
    server.project.push(() => new Promise<Response>((done) => { finishOld = () => done(json({ id: P1, title: "旧", premise: "", version: 1, status: "ACTIVE" })); }), fail);
    let old!: Promise<void>;
    act(() => { old = result.current.reloadBase(); });
    await act(async () => { await result.current.reloadBase().catch(() => undefined); });
    await act(async () => { finishOld(); await old; });
    expect(result.current.refreshFailed).toBe(true);
    expect(result.current.project?.title).not.toBe("旧");
    await advance(2000);
    expect(result.current.refreshFailed).toBe(false);
  });

  it("an old failure arriving after a newer success adds no failure and starts no retry", async () => {
    const server: Server = { runs: [], project: [], calls: [] };
    install(server);
    const { result } = renderHook(() => useProjectBase(P1, "失败"));
    await settle();
    let failOld!: () => void;
    server.project.push(() => new Promise<Response>((done) => { failOld = () => done(json({ error: { code: "UNAVAILABLE", message: "x" } }, 503)); }));
    let old!: Promise<void>;
    act(() => { old = result.current.reloadBase().catch(() => undefined); });
    await act(async () => { await result.current.reloadBase(); });
    await act(async () => { failOld(); await old; });
    expect(result.current.refreshFailed).toBe(false);
    const reads = server.calls.length;
    await advance(60_000);
    expect(server.calls.length).toBe(reads);
  });

  it("several callbacks finishing together leave one chain: no stacked timers, no overlapping reads", async () => {
    const server: Server = { runs: [composeRun("RUNNING")], project: [], calls: [] };
    install(server);
    const { result } = renderHook(() => useProjectBase(P1, "失败"));
    await settle();
    await act(async () => { await Promise.all([result.current.reloadBase(), result.current.reloadBase(), result.current.reloadBase()]); });
    const runs = runsReads(server);
    await advance(2000);
    expect(runsReads(server)).toBe(runs + 1);
    await advance(2000);
    expect(runsReads(server)).toBe(runs + 2);
  });
});
