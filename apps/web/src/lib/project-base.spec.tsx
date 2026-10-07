// @vitest-environment happy-dom
// useProjectBase against a stubbed fetch with controllable answers and fake timers. No browser or server.
import { act, renderHook } from "@testing-library/react";
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
      return json(server.runs);
    }
    if (path.endsWith("/episodes")) return json({ items: [] });
    return json({ items: [], nextCursor: null });
  }));
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
});

afterEach(() => {
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
