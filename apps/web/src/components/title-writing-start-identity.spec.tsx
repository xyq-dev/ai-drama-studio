// @vitest-environment happy-dom
// Start identity of "AI 一键创作" across late answers and incomplete receipts. Simulated interface tests: fetch is
// mocked (the "server" below is an in-memory model of idempotent project and run creation); no browser, API or model.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TitleWritingOptionsView } from "@ai-drama/contracts";
import { TitleWritingStart } from "./title-writing-start";

const P_A = "22222222-2222-4222-8222-22222222000a";
const P_B = "22222222-2222-4222-8222-22222222000b";
const P_OTHER = "22222222-2222-4222-8222-2222222200ff";
const RUN_A = "66666666-6666-4666-8666-66666666000a";
const TOKEN = "operator-token-0123456789";
const DRAFT_KEY = "title-writing:start";
const UNSURE = "没有确认是否已经启动";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

const OPTIONS: TitleWritingOptionsView = {
  enabled: true, code: "TITLE_WRITING_READY", storageReady: true, operatorTokenRequired: true, defaultProvider: "qwen",
  providers: [{ providerKey: "qwen", label: "千问", ready: true, models: ["q-1"], defaultModel: "q-1", missing: [] }],
  maxCallsPerDay: 30, maxActiveRuns: 1, callCapPerRun: 8, billing: "unknown", defaults: { episodeCount: 3, episodeSeconds: 90, style: "" },
};

interface Call { method: string; url: string; key: string; body: unknown }
interface Held { call: Call; resolve: (response: Response) => void; reject: (error: unknown) => void }

/**
 * handler answers each POST; returning "hold" keeps it open until the test settles it through `held`. Options GETs
 * answer at once.
 */
function server(handler: (call: Call) => Response | Promise<Response> | "hold") {
  const calls: Call[] = [];
  const held: Held[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (input.endsWith("/writing/title-runs/options")) return json(OPTIONS);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = { method: init?.method ?? "GET", url: input, key: headers["Idempotency-Key"] ?? "",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null };
    calls.push(call);
    const answer = handler(call);
    if (answer !== "hold") return answer;
    return new Promise<Response>((resolve, reject) => { held.push({ call, resolve, reject }); });
  }));
  return { calls, held };
}

const projectPosts = (calls: Call[]) => calls.filter((call) => call.method === "POST" && call.url === "/api/v1/projects");
const runPosts = (calls: Call[]) => calls.filter((call) => call.method === "POST" && call.url.endsWith("/title-runs"));
const stored = () => {
  const raw = window.sessionStorage.getItem(DRAFT_KEY);
  return raw ? JSON.parse(raw) as { projectKey: string; projectId: string | null; runKey: string; request: { title: string } } : null;
};

async function mount() {
  const view = render(<TitleWritingStart />);
  const button = await screen.findByRole("button", { name: /AI 一键创作|重试上次请求/ });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText("操作者令牌"), { target: { value: TOKEN } });
  return { view, button };
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  assign = vi.fn();
  Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, assign, search: "" } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

/** Leaves the page while start A is open, comes back, abandons A and starts B. Returns the open A write and B's record. */
async function abandonAThenStartB(server: { calls: Call[]; held: Held[] }) {
  const first = await mount();
  fireEvent.change(screen.getByLabelText("剧名"), { target: { value: "甲" } });
  fireEvent.click(first.button);
  await waitFor(() => expect(server.held).toHaveLength(1));
  const openA = server.held[0]!;
  first.view.unmount();

  // Back on the page: A is restored, the person explicitly gives it up and starts B.
  await mount();
  expect((screen.getByLabelText("剧名") as HTMLInputElement).value).toBe("甲");
  fireEvent.click(screen.getByRole("button", { name: "放弃上次请求，重新填写" }));
  fireEvent.change(screen.getByLabelText("剧名"), { target: { value: "乙" } });
  fireEvent.click(screen.getByRole("button", { name: "AI 一键创作" }));
  await waitFor(() => expect(server.held).toHaveLength(2));
  await waitFor(() => expect(stored()?.request.title).toBe("乙"));
  return { openA, recordB: stored()! };
}

describe("F1: a late answer to an earlier start never touches a newer start", () => {
  it("A's run receipt arrives after leaving, returning, abandoning A and starting B: B keeps its identity", async () => {
    const s = server((call) => {
      if (call.url === "/api/v1/projects") return json({ id: (call.body as { title: string }).title === "甲" ? P_A : P_B }, 201);
      return "hold";
    });
    const { openA, recordB } = await abandonAThenStartB(s);
    expect(openA.call.url).toBe(`/api/v1/projects/${P_A}/title-runs`);
    expect(recordB).toMatchObject({ projectId: P_B });

    await act(async () => { openA.resolve(json({ run: { runId: RUN_A, projectId: P_A, state: "running" } }, 201)); });
    await settle();
    expect(stored()).toEqual(recordB);
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "正在启动…" })).toBeTruthy();

    // B's own receipt is lost: after a reload the same B request is restored and replayed with B's keys.
    await act(async () => { s.held[1]!.reject(new TypeError("network")); });
    expect((await screen.findByRole("alert")).textContent).toContain(UNSURE);
    cleanup();
    expect(stored()).toEqual(recordB);
    const again = await mount();
    expect((screen.getByLabelText("剧名") as HTMLInputElement).value).toBe("乙");
    fireEvent.click(again.button);
    await waitFor(() => expect(s.held).toHaveLength(3));
    expect(s.held[2]!.call).toMatchObject({ url: `/api/v1/projects/${P_B}/title-runs`, key: recordB.runKey });
    expect(runPosts(s.calls)).toHaveLength(3);
    expect(projectPosts(s.calls)).toHaveLength(2);
  });

  it("A's project receipt arrives after B started: no record is overwritten and A starts no run", async () => {
    const s = server((call) => {
      if (call.url === "/api/v1/projects" && (call.body as { title: string }).title === "甲") return "hold";
      if (call.url === "/api/v1/projects") return json({ id: P_B }, 201);
      return "hold";
    });
    const { openA, recordB } = await abandonAThenStartB(s);
    expect(openA.call.url).toBe("/api/v1/projects");
    await act(async () => { openA.resolve(json({ id: P_A }, 201)); });
    await settle();
    expect(stored()).toEqual(recordB);
    expect(runPosts(s.calls).map((call) => call.url)).toEqual([`/api/v1/projects/${P_B}/title-runs`]);
    expect(assign).not.toHaveBeenCalled();
  });

  it("A's late failure and its finally leave B busy, without an error", async () => {
    const s = server((call) => call.url === "/api/v1/projects"
      ? json({ id: (call.body as { title: string }).title === "甲" ? P_A : P_B }, 201) : "hold");
    const { openA, recordB } = await abandonAThenStartB(s);
    await act(async () => { openA.resolve(json({ error: { code: "INTERNAL", message: "x" } }, 500)); });
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: "正在启动…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(stored()).toEqual(recordB);
    // B then succeeds on its own: only B's record is cleared and only B is opened.
    await act(async () => { s.held[1]!.resolve(json({ run: { runId: RUN_A, projectId: P_B, state: "running" } }, 201)); });
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/projects/${P_B}/writing`));
    expect(assign).toHaveBeenCalledTimes(1);
    expect(stored()).toBeNull();
  });

  it("leaving the page does not drop the identity: the late success of the left page changes nothing and the replay is exact", async () => {
    const s = server((call) => call.url === "/api/v1/projects" ? json({ id: P_A }, 201) : "hold");
    const first = await mount();
    fireEvent.change(screen.getByLabelText("剧名"), { target: { value: "甲" } });
    fireEvent.click(first.button);
    await waitFor(() => expect(s.held).toHaveLength(1));
    const recordA = stored()!;
    first.view.unmount();
    await act(async () => { s.held[0]!.resolve(json({ run: { runId: RUN_A, projectId: P_A, state: "running" } }, 201)); });
    await settle();
    expect(stored()).toEqual(recordA);
    expect(assign).not.toHaveBeenCalled();
    expect(runPosts(s.calls)).toHaveLength(1);
  });
});

describe("F2: only a receipt that proves the result confirms a start", () => {
  const incomplete: Array<[string, unknown]> = [
    ["an empty body", {}],
    ["run: null", { run: null }],
    ["a run without an id", { run: { projectId: P_A, state: "running" } }],
    ["an empty run id", { run: { runId: "", projectId: P_A, state: "running" } }],
    ["a run of another work", { run: { runId: RUN_A, projectId: P_OTHER, state: "running" } }],
  ];
  const cases = [200, 201, 202].flatMap((status) => incomplete.map(([label, body]) => ({ status, label, body })));

  it.each(cases)("$status with $label keeps the frozen request, both keys and the project id", async ({ status, body }) => {
    let answered = false;
    const s = server((call) => {
      if (call.url === "/api/v1/projects") return json({ id: P_A }, 201);
      if (!answered) { answered = true; return json(body, status); }
      return json({ run: { runId: RUN_A, projectId: P_A, state: "running" } }, 200);
    });
    const { button } = await mount();
    fireEvent.change(screen.getByLabelText("剧名"), { target: { value: "甲" } });
    fireEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toContain(UNSURE);
    expect(assign).not.toHaveBeenCalled();
    const kept = stored()!;
    expect(kept).toMatchObject({ projectId: P_A, request: { title: "甲" } });
    expect(kept.runKey).toBe(runPosts(s.calls)[0]!.key);
    fireEvent.click(screen.getByRole("button", { name: "重试上次请求" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/projects/${P_A}/writing`));
    expect(runPosts(s.calls).map((call) => call.key)).toEqual([kept.runKey, kept.runKey]);
    expect(runPosts(s.calls)[1]!.body).toEqual(runPosts(s.calls)[0]!.body);
    expect(projectPosts(s.calls)).toHaveLength(1);
    expect(stored()).toBeNull();
  });

  it.each([
    ["an empty body", {}],
    ["an empty id", { id: "" }],
    ["a malformed id", { id: "not-an-id" }],
  ])("a project receipt with %s starts no run and replays the same project key", async (_label, body) => {
    let answered = false;
    const s = server((call) => {
      if (call.url === "/api/v1/projects") {
        if (!answered) { answered = true; return json(body, 201); }
        return json({ id: P_A }, 200);
      }
      return json({ run: { runId: RUN_A, projectId: P_A, state: "running" } }, 201);
    });
    const { button } = await mount();
    fireEvent.change(screen.getByLabelText("剧名"), { target: { value: "甲" } });
    fireEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toContain(UNSURE);
    expect(runPosts(s.calls)).toHaveLength(0);
    expect(stored()).toMatchObject({ projectId: null });
    fireEvent.click(screen.getByRole("button", { name: "重试上次请求" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/projects/${P_A}/writing`));
    const projects = projectPosts(s.calls);
    expect(projects.map((call) => call.key)).toEqual([projects[0]!.key, projects[0]!.key]);
  });

  it.each([
    ["a network failure", () => Promise.reject(new TypeError("network"))],
    ["a 503", () => json({ error: { code: "INTERNAL", message: "x" } }, 503)],
    ["an unreadable 200 body", () => new Response("<html>", { status: 200 })],
  ])("%s keeps the request for an exact replay", async (_label, failure) => {
    let answered = false;
    const s = server((call) => {
      if (call.url === "/api/v1/projects") return json({ id: P_A }, 201);
      if (!answered) { answered = true; return failure(); }
      return json({ run: { runId: RUN_A, projectId: P_A, state: "running" } }, 200);
    });
    const { button } = await mount();
    fireEvent.change(screen.getByLabelText("剧名"), { target: { value: "甲" } });
    fireEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toContain(UNSURE);
    expect(stored()).toMatchObject({ projectId: P_A });
    fireEvent.click(screen.getByRole("button", { name: "重试上次请求" }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(new Set(runPosts(s.calls).map((call) => call.key)).size).toBe(1);
  });

  it("a running start of the same work (TITLE_WRITING_RUN_ACTIVE) opens it; another refusal does not", async () => {
    let code = "IDEMPOTENCY_KEY_REUSED";
    server((call) => call.url === "/api/v1/projects" ? json({ id: P_A }, 201)
      : json({ error: { code, message: "已有请求。", details: { runId: RUN_A } } }, 409));
    const { button } = await mount();
    fireEvent.change(screen.getByLabelText("剧名"), { target: { value: "甲" } });
    fireEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toContain("没有被受理");
    expect(assign).not.toHaveBeenCalled();
    expect(stored()).not.toBeNull();
    code = "TITLE_WRITING_RUN_ACTIVE";
    fireEvent.click(screen.getByRole("button", { name: "重试上次请求" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/projects/${P_A}/writing`));
    expect(stored()).toBeNull();
  });

  it("an in-memory idempotent server: replaying an unconfirmed start creates one project and one run, then a new start gets new keys", async () => {
    // Simulated acceptance only: this models the server's idempotency in memory; it is not the real API or database.
    const projects = new Map<string, string>();
    const runs = new Map<string, { runId: string; projectId: string }>();
    let firstRunAnswer = true;
    const s = server((call) => {
      if (call.url === "/api/v1/projects") {
        if (!projects.has(call.key)) projects.set(call.key, projects.size === 0 ? P_A : P_B);
        return json({ id: projects.get(call.key) }, 201);
      }
      const projectId = call.url.split("/")[4]!;
      const created = !runs.has(call.key);
      if (created) runs.set(call.key, { runId: `66666666-6666-4666-8666-${String(runs.size).padStart(12, "0")}`, projectId });
      // The first answer is accepted work with an empty body: the run exists, the page cannot know it.
      if (firstRunAnswer) { firstRunAnswer = false; return json({}, 202); }
      return json({ run: { ...runs.get(call.key), state: "running" } }, created ? 201 : 200);
    });
    const first = await mount();
    fireEvent.change(screen.getByLabelText("剧名"), { target: { value: "甲" } });
    fireEvent.click(first.button);
    expect((await screen.findByRole("alert")).textContent).toContain(UNSURE);
    fireEvent.click(screen.getByRole("button", { name: "重试上次请求" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/projects/${P_A}/writing`));
    expect(projects.size).toBe(1);
    expect(runs.size).toBe(1);
    expect(runPosts(s.calls)).toHaveLength(2);
    first.view.unmount();

    // Only after a confirmed start does an explicit new creation use new keys.
    const second = await mount();
    fireEvent.change(screen.getByLabelText("剧名"), { target: { value: "乙" } });
    fireEvent.click(second.button);
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/projects/${P_B}/writing`));
    expect(projects.size).toBe(2);
    expect(runs.size).toBe(2);
  });
});
