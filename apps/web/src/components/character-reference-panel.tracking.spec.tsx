// @vitest-environment happy-dom
// Simulated interface tests. fetch is mocked and timers are faked; this file does not start a browser or a backend.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CharacterReferencePanel } from "./character-reference-panel";

const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHARACTER = "11111111-1111-4111-8111-111111111111";
const OTHER_CHARACTER = "99999999-9999-4999-8999-999999999999";
const CURRENT = "22222222-2222-4222-8222-222222222222";
const JOB = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const HASH = "ab".repeat(32);

function asset(id: string, overrides: Record<string, unknown> = {}) {
  return { id, characterRevisionId: CURRENT, checksumSha256: HASH, status: "ACTIVE", reviewStatus: "APPROVED",
    reviewNote: null, rowVersion: 2, createdAt: "2026-10-06T00:00:00.000Z", selectable: true, ...overrides };
}

function listing(characterId: string, items: unknown[], extra: Record<string, unknown> = {}) {
  return { characterId, currentRevisionId: CURRENT, selection: null,
    videoReadiness: { usable: false, blockers: ["REFERENCE_NOT_SELECTED"] }, items, hasMore: false, ...extra };
}

interface Pending { resolve: (body: unknown, status?: number) => void }

/** Every request waits until the test answers it, so ordering and staleness are explicit. */
function controlledFetch() {
  const queue: Array<{ method: string; url: string } & Pending> = [];
  vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => new Promise<Response>((resolve) => {
    queue.push({ method: init?.method ?? "GET", url: String(input), resolve: (body, status = 200) => resolve(
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) });
  })));
  const take = async (match: (request: { method: string; url: string }) => boolean) => {
    for (let round = 0; round < 50; round += 1) {
      const index = queue.findIndex(match);
      if (index >= 0) return queue.splice(index, 1)[0]!;
      await act(async () => { await Promise.resolve(); });
    }
    throw new Error(`no matching request; queued: ${queue.map((item) => `${item.method} ${item.url}`).join(", ")}`);
  };
  return {
    queue,
    list: (characterId = CHARACTER) => take((request) => request.method === "GET" && request.url.endsWith(`/characters/${characterId}/reference-images`)),
    job: () => take((request) => request.method === "GET" && request.url.endsWith(`/generation-jobs/${JOB}`)),
    generate: () => take((request) => request.method === "POST" && request.url.endsWith("/reference-images/generate")),
    reads: () => queue.filter((request) => request.url.includes("/generation-jobs/")).length,
  };
}

async function answer(request: Pending, body: unknown, status = 200) {
  await act(async () => {
    request.resolve(body, status);
    await Promise.resolve();
  });
}

async function flush() {
  await act(async () => { for (let index = 0; index < 10; index += 1) await Promise.resolve(); });
}

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  setVisibility("visible");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function job(state: string, errorCode: string | null = null) {
  return { id: JOB, state, errorCode, errorMessage: null };
}

describe("character reference generation tracking (closeout item 5)", () => {
  it("shows 202 as accepted, follows the job serially and re-reads the list when it succeeds", async () => {
    const http = controlledFetch();
    render(<CharacterReferencePanel projectId={PROJECT} characterId={CHARACTER} currentRevisionId={CURRENT} />);
    await answer(await http.list(), listing(CHARACTER, []));
    fireEvent.click(screen.getByRole("button", { name: "为当前版本生成参考图" }));
    await answer(await http.generate(), { workflowRunId: "run", jobId: JOB, dispatchSeq: 1 }, 202);
    expect(screen.getByRole("status").textContent).toContain("已受理参考图生成（202）。这不是生成成功");
    expect((screen.getByRole("button", { name: "为当前版本生成参考图" }) as HTMLButtonElement).disabled).toBe(true);

    await answer(await http.job(), job("QUEUED"));
    // Serial: no second read until the first answered and the delay passed.
    expect(http.reads()).toBe(0);
    await advance(1500);
    await answer(await http.job(), job("RUNNING"));
    expect(screen.getByText(/参考图任务 cccccccc · 生成中/)).toBeTruthy();
    await advance(1500);
    await answer(await http.job(), job("SUCCEEDED"));
    await answer(await http.list(), listing(CHARACTER, [asset("55555555-5555-4555-8555-555555555555")]));
    expect(screen.getByRole("status").textContent).toBe("参考图生成成功，列表已重新读取。");
    expect(screen.getByText("55555555")).toBeTruthy();
    // Terminal: no further reads.
    await advance(10_000);
    expect(http.reads()).toBe(0);
  });

  it.each([
    ["FAILED", "MOCK_IMAGE_RUNTIME_FAILED", "参考图生成失败（MOCK_IMAGE_RUNTIME_FAILED），没有新增参考图。"],
    ["CANCELED", null, "参考图生成已取消，没有新增参考图。"],
  ])("shows a %s job as it is and stops", async (state, code, text) => {
    const http = controlledFetch();
    render(<CharacterReferencePanel projectId={PROJECT} characterId={CHARACTER} currentRevisionId={CURRENT} />);
    await answer(await http.list(), listing(CHARACTER, []));
    fireEvent.click(screen.getByRole("button", { name: "为当前版本生成参考图" }));
    await answer(await http.generate(), { workflowRunId: "run", jobId: JOB, dispatchSeq: 1 }, 202);
    await answer(await http.job(), job(state, code));
    expect(screen.getByRole("status").textContent).toBe(text);
    await advance(10_000);
    expect(http.queue).toHaveLength(0);
  });

  it("pauses while hidden and reads again when visible", async () => {
    const http = controlledFetch();
    render(<CharacterReferencePanel projectId={PROJECT} characterId={CHARACTER} currentRevisionId={CURRENT} />);
    await answer(await http.list(), listing(CHARACTER, []));
    fireEvent.click(screen.getByRole("button", { name: "为当前版本生成参考图" }));
    await answer(await http.generate(), { workflowRunId: "run", jobId: JOB, dispatchSeq: 1 }, 202);
    await answer(await http.job(), job("RUNNING"));
    setVisibility("hidden");
    await advance(10_000);
    expect(http.reads()).toBe(0);
    setVisibility("visible");
    await answer(await http.job(), job("SUCCEEDED"));
    await answer(await http.list(), listing(CHARACTER, [asset("55555555-5555-4555-8555-555555555555")]));
    expect(screen.getByText("55555555")).toBeTruthy();
  });

  it("drops a job answer and a generation reply that arrive after the character changed", async () => {
    const http = controlledFetch();
    const view = render(<CharacterReferencePanel projectId={PROJECT} characterId={CHARACTER} currentRevisionId={CURRENT} />);
    await answer(await http.list(), listing(CHARACTER, []));
    fireEvent.click(screen.getByRole("button", { name: "为当前版本生成参考图" }));
    await answer(await http.generate(), { workflowRunId: "run", jobId: JOB, dispatchSeq: 1 }, 202);
    const lateJob = await http.job();

    view.rerender(<CharacterReferencePanel projectId={PROJECT} characterId={OTHER_CHARACTER} currentRevisionId={CURRENT} />);
    await answer(await http.list(OTHER_CHARACTER), listing(OTHER_CHARACTER, [asset("77777777-7777-4777-8777-777777777777")]));
    await answer(lateJob, job("SUCCEEDED"));
    await flush();
    await advance(10_000);
    // The old character's job neither re-read its list nor wrote a note on the new character.
    expect(http.queue).toHaveLength(0);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("77777777")).toBeTruthy();
    expect(screen.queryByText(/参考图任务/)).toBeNull();

    // A generation still in flight when the character changes leaves the new character's busy and note alone.
    fireEvent.click(screen.getByRole("button", { name: "为当前版本生成参考图" }));
    const slowGenerate = await http.generate();
    expect((screen.getByRole("button", { name: "为当前版本生成参考图" }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<CharacterReferencePanel projectId={PROJECT} characterId={CHARACTER} currentRevisionId={CURRENT} />);
    await answer(await http.list(), listing(CHARACTER, []));
    expect((screen.getByRole("button", { name: "为当前版本生成参考图" }) as HTMLButtonElement).disabled).toBe(false);
    await answer(slowGenerate, { workflowRunId: "run", jobId: JOB, dispatchSeq: 2 }, 202);
    await flush();
    await advance(10_000);
    expect(screen.queryByRole("status")).toBeNull();
    expect(http.queue).toHaveLength(0);
  });

  it("drops a list answer for the previous revision", async () => {
    const http = controlledFetch();
    const view = render(<CharacterReferencePanel projectId={PROJECT} characterId={CHARACTER} currentRevisionId={CURRENT} />);
    const first = await http.list();
    view.rerender(<CharacterReferencePanel projectId={PROJECT} characterId={CHARACTER} currentRevisionId="33333333-3333-4333-8333-333333333333" />);
    const second = await http.list();
    await answer(second, listing(CHARACTER, [asset("88888888-8888-4888-8888-888888888888")]));
    await answer(first, listing(CHARACTER, [asset("44444444-4444-4444-8444-444444444444")]));
    expect(screen.getByText("88888888")).toBeTruthy();
    expect(screen.queryByText("44444444")).toBeNull();
  });

  it("stops following the job on unmount", async () => {
    const http = controlledFetch();
    const view = render(<CharacterReferencePanel projectId={PROJECT} characterId={CHARACTER} currentRevisionId={CURRENT} />);
    await answer(await http.list(), listing(CHARACTER, []));
    fireEvent.click(screen.getByRole("button", { name: "为当前版本生成参考图" }));
    await answer(await http.generate(), { workflowRunId: "run", jobId: JOB, dispatchSeq: 1 }, 202);
    await answer(await http.job(), job("RUNNING"));
    view.unmount();
    await advance(10_000);
    expect(http.queue).toHaveLength(0);
  });
});

describe("character reference video readiness (closeout items 1 and 2)", () => {
  it("shows a selection outside the listed page with the server's reasons", async () => {
    const http = controlledFetch();
    render(<CharacterReferencePanel projectId={PROJECT} characterId={CHARACTER} currentRevisionId={CURRENT} />);
    const selected = asset("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    await answer(await http.list(), listing(CHARACTER, [asset("55555555-5555-4555-8555-555555555555")], {
      hasMore: true,
      selection: { assetId: selected.id, sourceCharacterRevisionId: CURRENT, usable: false, asset: selected },
      videoReadiness: { usable: false, blockers: ["CHARACTER_REVISION_NOT_APPROVED"] },
    }));
    expect(screen.getByText(/当前选定：dddddddd（可用 · 已通过） · 暂不可用于视频/)).toBeTruthy();
    expect(screen.getByRole("list", { name: "不可用于视频的原因" }).textContent).toBe("角色当前版本尚未审核通过");
    expect(screen.getByText(/只显示最近 1 张/)).toBeTruthy();
  });

  it("says usable only when the server's gate has no blockers", async () => {
    const http = controlledFetch();
    render(<CharacterReferencePanel projectId={PROJECT} characterId={CHARACTER} currentRevisionId={CURRENT} />);
    const selected = asset("dddddddd-dddd-4ddd-8ddd-dddddddddddd", { selectable: false });
    await answer(await http.list(), listing(CHARACTER, [selected], {
      selection: { assetId: selected.id, sourceCharacterRevisionId: CURRENT, usable: true, asset: selected },
      videoReadiness: { usable: true, blockers: [] },
    }));
    expect(screen.getByText(/· 可用于视频/)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "不可用于视频的原因" })).toBeNull();
  });
});
