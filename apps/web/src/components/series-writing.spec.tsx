// @vitest-environment happy-dom
// Series writing page and start card. Simulated interface tests: fetch is mocked with a view the domain computed from the
// in-process store after a model-double run; no browser, API or model.
import { randomUUID } from "node:crypto";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { seriesConstraintsSchema, seriesPlanCalls } from "@ai-drama/contracts";
import { admitSeriesGrant, seriesView, type SeriesView } from "@ai-drama/domain";
import { InMemorySeriesWritingStore, SeriesWritingEngine, newSeries, newSeriesGrant, titleWritingProviderConfigs } from "@ai-drama/providers";
import { seriesFixtureTransport } from "@ai-drama/providers/title-writing-fixtures";
import { SeriesWritingPage } from "./series-writing-page";
import { SeriesWritingStart } from "./series-writing-start";
import { savePendingSeries } from "../lib/series-writing-client";

const WS = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222222";
let view: SeriesView;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

const OPTIONS = {
  enabled: true, code: "SERIES_WRITING_READY", storageReady: true, operatorTokenRequired: false, defaultProvider: "deepseek",
  providers: [{ providerKey: "deepseek", label: "DeepSeek", ready: true, models: ["deepseek-flash"], defaultModel: "deepseek-flash", missing: [] }],
  configurationPending: false, maxCallsPerDay: 200, maxActiveRuns: 1, billing: "unknown",
  episodes: { min: 1, max: 60, secondsChoices: [60, 90], defaultSeconds: 60, batchSize: 3, outlineChunk: 6 },
  formula: "6 + ceil(N/6) + N + ceil(N/3)", maxCallsPerJob: 60, maxResendAllowance: 2, maxOutputTokensPerCall: 4096, maxPromptChars: 40000,
  reviewContentChars: 28000, research: { fetchEnabled: false, expectedMode: "limited", visualAnalysis: false }, media: { enabled: false, note: "" },
};

beforeAll(async () => {
  const store = new InMemorySeriesWritingStore();
  const now = new Date("2026-10-22T00:00:00Z");
  const series = newSeries({ workspaceId: WS, projectId: P1, actorId: "server-owner", idempotencyKey: "k", title: "替身样例系列", idea: "", constraints: seriesConstraintsSchema.parse({}),
    materials: [], referenceUrls: [], researchFetch: false, episodeCount: 60, episodeSeconds: 60, now });
  await store.createSeries(series, { title: series.title, premise: "" });
  const grant = newSeriesGrant({ series, actorId: "server-owner", idempotencyKey: "g", scope: { plan: true, batchFrom: 1, batchTo: 1, final: false }, normalCalls: 19,
    resendAllowance: 0, callBudget: 19, providerKey: "deepseek", model: "m-1", basePlanRevisionId: null,
    authorization: { mode: "series", proof: "site_session", initiatedBy: "server-owner", executor: "series-writing-engine" }, now });
  const created = await store.createGrant(grant, { sinceIso: "2026-10-21T00:00:00Z", maxCallsPerDay: 100, maxActiveRuns: 2 },
    (snapshot) => admitSeriesGrant(snapshot, grant, { jobId: randomUUID(), nowIso: now.toISOString() }));
  if (created.kind !== "created") throw new Error(created.kind);
  const providers = titleWritingProviderConfigs({ DEEPSEEK_API_KEY: "sk-deepseek-test-0123456789", TITLE_WRITING_DEEPSEEK_MODELS: "m-1" });
  await new SeriesWritingEngine({ workspaceId: WS, store, providers, transport: seriesFixtureTransport(), maxCallsPerDay: 100, maxActiveRuns: 2, clock: () => now }).drive(created.jobId);
  view = JSON.parse(JSON.stringify(seriesView((await store.snapshot(WS, P1))!))) as SeriesView;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

function server(handler: (method: string, url: string, body: unknown) => Response | undefined = () => undefined) {
  const calls: Array<{ method: string; url: string; body: unknown; key: string | null }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null;
    const headers = new Headers(init?.headers);
    calls.push({ method, url: input, body, key: headers.get("Idempotency-Key") });
    const custom = handler(method, input, body);
    if (custom) return custom;
    if (input.endsWith("/writing/series/options")) return json(OPTIONS);
    if (input.endsWith(`/projects/${P1}/series`)) return json({ series: view });
    return json({ error: { code: "X", message: "x" } }, 500);
  }));
  return calls;
}

describe("series writing page", () => {
  it("shows the partial state, 1–60 episodes, every batch, the budget and the downloads from the stored view", async () => {
    server();
    render(<SeriesWritingPage projectId={P1} />);
    await screen.findByTestId("series-page");
    expect(screen.getByTestId("series-completion").textContent).toContain("已完成 3/60 集");
    expect(document.querySelectorAll("[data-testid^=series-episode-]")).toHaveLength(60);
    expect(document.querySelectorAll("[data-testid^=series-batch-]")).toHaveLength(20);
    expect(screen.getByTestId("series-budget").textContent).toContain("全剧 96 次");
    expect(screen.getByTestId("series-calls-used").textContent).toContain("19 次");
    expect(screen.getByTestId("series-status").textContent).toContain("真人读演");
    expect(screen.getByTestId("series-download-json").getAttribute("href")).toBe(`/api/v1/projects/${P1}/series/package?format=json`);
  });

  it("the card shows what it authorizes; nothing is sent until the person confirms; an unanswered grant is replayed unchanged", async () => {
    let fail = true;
    const calls = server((method, url) => {
      if (method === "POST" && url.endsWith("/series/grants")) return fail ? json({ error: { code: "UPSTREAM", message: "x" } }, 502) : json({ grantId: randomUUID(), series: view }, 201);
      return undefined;
    });
    render(<SeriesWritingPage projectId={P1} />);
    await screen.findByTestId("series-card");
    fireEvent.change(screen.getByTestId("series-preset"), { target: { value: "continue" } });
    await waitFor(() => expect(screen.getByTestId("series-card-summary").textContent).toContain("第 4–6 集 4 次"));
    fireEvent.click(screen.getByTestId("series-grant"));
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    fireEvent.click(screen.getByTestId("series-confirm"));
    fireEvent.click(screen.getByTestId("series-grant"));
    await screen.findByTestId("series-error");
    const first = calls.filter((call) => call.method === "POST");
    expect(first).toHaveLength(1);
    expect(first[0]!.body).toMatchObject({ scope: { plan: false, batchFrom: 2, batchTo: 2, final: false }, normalCalls: 4, callBudget: 4, providerKey: "deepseek",
      model: "deepseek-flash", basePlanRevisionId: view.plan!.revisionId });
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "重试授权" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "POST")).toHaveLength(2));
    const [a, b] = calls.filter((call) => call.method === "POST");
    expect(b!.key).toBe(a!.key);
    expect(b!.body).toEqual(a!.body);
  });
});

describe("review findings 9 and 10 on the page", () => {
  it("10. a pending grant shows only its frozen request, keeps the frozen identity when that service is gone, and retries the same body and key", async () => {
    const frozen = { scope: { plan: false, batchFrom: 2, batchTo: 20, final: true }, normalCalls: 77, resendAllowance: 1, callBudget: 78, providerKey: "openai",
      model: "gpt-frozen", basePlanRevisionId: view.plan!.revisionId };
    window.sessionStorage.setItem(`series-writing:grant:${P1}`, JSON.stringify({ version: 1, scope: `grant:${P1}`, key: "frozen-key", body: frozen }));
    const calls = server((method, url) => method === "POST" && url.endsWith("/series/grants") ? json({ error: { code: "UPSTREAM", message: "x" } }, 502) : undefined);
    render(<SeriesWritingPage projectId={P1} />);
    const card = await screen.findByTestId("series-card");
    await waitFor(() => expect(card.textContent).toContain("gpt-frozen"));
    expect(card.textContent).toContain("OpenAI");
    expect(card.textContent).not.toContain("deepseek-flash");
    expect(card.textContent).toContain("第 4–60 集");
    expect(card.textContent).toContain("全剧结构与连续性总检");
    expect(screen.getByTestId("series-card-summary").textContent).toContain("预算 78 次");
    expect(screen.getByTestId("series-card-config-changed").textContent).toContain("不会改用");
    fireEvent.click(screen.getByTestId("series-grant"));
    fireEvent.click(screen.getByTestId("series-grant"));
    await screen.findByTestId("series-error");
    const posts = calls.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual(frozen);
    expect(posts[0]!.key).toBe("frozen-key");
    fireEvent.click(screen.getByRole("button", { name: "放弃这次请求" }));
    await waitFor(() => expect(screen.queryByTestId("series-card-config-changed")).toBeNull());
    expect(screen.getByTestId("series-card").textContent).toContain("deepseek-flash");
  });

  it("9. the final review's findings and scope are shown, and a person can record a final review on the version shown", async () => {
    const finalView = structuredClone(view);
    const basis = { plan: "a".repeat(64), story: "b".repeat(64), ledger: "c".repeat(64), "summary:1": "d".repeat(64) };
    finalView.final = { ...finalView.final, status: "needs_revision", blockers: [], decisionBasis: basis,
      output: { schema: "ads.series-writing.final-review.v1", checksVersion: "ads.series-writing.checks.v1", scope: "final", readsFullText: false, verdict: "revise",
        dimensions: [], reviewed: {}, passed: false,
        deterministic: [{ id: "D1", check: "foreshadowing_unpaid", target: "arc", severity: "high", detail: "伏笔 FS3 没有兑现" }],
        issues: [{ id: "R1", dimension: "ending", severity: "high", target: "summary:60", evidence: "结局", problem: "结局没有兑现主线", suggestion: "补写", evidenceVerified: true },
          { id: "R2", dimension: "pacing", severity: "medium", target: "summary:30", evidence: "无此原文", problem: "节奏拖沓", suggestion: "压缩", evidenceVerified: false }] } } as never;
    const calls = server((method, url) => {
      if (url.endsWith(`/projects/${P1}/series`)) return json({ series: finalView });
      if (method === "POST" && url.endsWith("/series/decisions")) return json({ error: { code: "SERIES_DECISION_STALE", message: "页面上的版本已变化" } }, 409);
      return undefined;
    });
    render(<SeriesWritingPage projectId={P1} />);
    const section = await screen.findByTestId("series-final-review");
    expect(section.textContent).toContain("伏笔 FS3 没有兑现");
    expect(section.textContent).toContain("结局没有兑现主线");
    expect(section.textContent).toContain("不逐字读取");
    fireEvent.change(screen.getByTestId("series-final-note"), { target: { value: "已人工核对结局" } });
    fireEvent.click(screen.getByTestId("series-final-decide"));
    await screen.findByTestId("series-error");
    expect(calls.filter((call) => call.method === "POST")[0]!.body).toEqual({ target: "final", note: "已人工核对结局", expectedBasis: basis });
    expect((screen.getByTestId("series-final-note") as HTMLInputElement).value).toBe("已人工核对结局");
    expect(screen.getByTestId("series-completion").textContent).not.toContain("全剧文本完成");
  });
});

describe("round 2: the ledger editor keeps what it was opened on", () => {
  it("a background read with newer versions does not change what the editor submits; a refusal keeps the editor and its text", async () => {
    const basisA = { planRevision: "p", plan: "a".repeat(64), story: "none", "episode:2": "1".repeat(64), "episodeRef:2": "script:a", ledgerRevision: "l1" };
    const basisB = { ...basisA, "episode:2": "2".repeat(64), "episodeRef:2": "script:b" };
    const opened = structuredClone(view);
    opened.activeGrantId = "33333333-3333-4333-8333-333333333333";
    opened.batches[0] = { ...opened.batches[0]!, ledger: { ...opened.batches[0]!.ledger, status: "pending_confirmation" }, ledgerBasis: basisA };
    const later = structuredClone(opened);
    later.batches[0] = { ...later.batches[0]!, ledgerBasis: basisB };
    let reads = 0;
    let editorOpen = false;
    const calls = server((method, url) => {
      if (method === "GET" && url.endsWith(`/projects/${P1}/series`)) {
        reads += 1;
        return json({ series: editorOpen ? later : opened });
      }
      if (method === "POST" && url.endsWith("/series/ledger-revisions")) return json({ error: { code: "SERIES_LEDGER_STALE", message: "打开台账编辑后，正文已经变化" } }, 409);
      return undefined;
    });
    render(<SeriesWritingPage projectId={P1} />);
    const batch1 = await screen.findByTestId("series-batch-1");
    fireEvent.click(within(batch1).getByRole("button", { name: "确认台账" }));
    await screen.findByTestId("series-ledger-editor");
    editorOpen = true;
    const editor = screen.getByLabelText("台账 JSON") as HTMLTextAreaElement;
    const edited = editor.value.replace(/"summary": "[^"]*"/, '"summary": "A 页面写的概要"');
    fireEvent.change(editor, { target: { value: edited } });
    // The page polls while a grant is active: the newer versions arrive, the editor says so and keeps its own basis.
    const before = reads;
    await waitFor(() => expect(reads).toBeGreaterThan(before), { timeout: 5_000 });
    await screen.findByTestId("series-ledger-changed");
    fireEvent.click(screen.getByRole("button", { name: "保存并确认台账" }));
    await screen.findByTestId("series-error");
    const post = calls.find((call) => call.method === "POST")!;
    expect(post.body).toMatchObject({ batchNo: 1, baseLedgerRevisionId: opened.batches[0]!.ledger.revision!.id, expectedBasis: basisA });
    expect(screen.getByTestId("series-ledger-editor")).toBeTruthy();
    expect((screen.getByLabelText("台账 JSON") as HTMLTextAreaElement).value).toBe(edited);
  }, 15_000);
});

describe("series start card", () => {
  it("reads nothing until opened, then creates the work without any model call", async () => {
    const calls = server((method, url) => method === "POST" && url.endsWith("/writing/series") ? json({ series: view }, 201) : undefined);
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    render(<SeriesWritingStart />);
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByTestId("series-start-open"));
    await waitFor(() => expect(screen.getByTestId("series-start-calls").textContent).toContain("全部正文及检查 96 次"));
    fireEvent.change(screen.getByLabelText("系列作品名称"), { target: { value: "替身样例" } });
    fireEvent.click(screen.getByRole("button", { name: "创建系列作品" }));
    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
    const post = calls.find((call) => call.method === "POST")!;
    expect(post.url).toBe("/api/v1/writing/series");
    expect(post.body).toMatchObject({ title: "替身样例", episodeCount: 60, episodeSeconds: 60 });
    expect(post.key).toBeTruthy();
  });
});

describe("round 3 on the page: resume idempotency and placement", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  function stoppedView(): SeriesView {
    const copy = structuredClone(view);
    copy.grants = copy.grants.map((item) => ({ ...item, state: "stopped" as const, stopReason: "grant_budget_exhausted" }));
    copy.activeGrantId = null;
    return copy;
  }

  it("6. a resume whose request cannot be saved is not sent at all", async () => {
    const stopped = stoppedView();
    const calls = server((method, url) => url.endsWith(`/projects/${P1}/series`) && method === "GET" ? json({ series: stopped }) : undefined);
    const full = vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
    try {
      render(<SeriesWritingPage projectId={P1} />);
      const panel = await screen.findByTestId("series-resume");
      fireEvent.click(within(panel).getByRole("button", { name: "继续这次授权" }));
      expect((await screen.findByTestId("series-error")).textContent).toContain("没能保存这次请求的标识");
      fireEvent.click(within(panel).getByRole("button", { name: "继续这次授权" }));
      expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    } finally {
      full.mockRestore();
    }
  });

  it("6. with storage working, a resume whose answer was lost is sent again with the same key and body, never a new one", async () => {
    const stopped = stoppedView();
    let lose = true;
    const calls = server((method, url) => {
      if (method === "GET" && url.endsWith(`/projects/${P1}/series`)) return json({ series: stopped });
      if (method === "POST" && url.includes("/resume")) {
        if (lose) { lose = false; throw new TypeError("fetch failed"); }
        return json({ series: stopped });
      }
      return undefined;
    });
    render(<SeriesWritingPage projectId={P1} />);
    const panel = await screen.findByTestId("series-resume");
    fireEvent.click(within(panel).getByRole("button", { name: "继续这次授权" }));
    await screen.findByTestId("series-error");
    fireEvent.click(within(panel).getByRole("button", { name: "继续这次授权" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "POST")).toHaveLength(2));
    const [a, b] = calls.filter((call) => call.method === "POST");
    expect(b!.key).toBe(a!.key);
    expect(b!.body).toEqual(a!.body);
  });

  it("4. a batch whose every episode was placed or recorded as a conflict offers no placement; the person's script is shown as kept", async () => {
    const done = structuredClone(view);
    done.batches[0] = { ...done.batches[0]!, placed: 2, conflicts: 1, placement: "nothing_to_place" };
    done.episodes[1] = { ...done.episodes[1]!, placed: "conflict", version: { kind: "script", hash: "h", source: "工作台人工修改稿" } };
    server((method, url) => method === "GET" && url.endsWith(`/projects/${P1}/series`) ? json({ series: done }) : undefined);
    render(<SeriesWritingPage projectId={P1} />);
    const row = await screen.findByTestId("series-batch-1");
    expect(within(row).queryByRole("button", { name: "写入正式分集" })).toBeNull();
    expect(row.textContent).toContain("2/3，1 集已有剧本未覆盖");
    expect(screen.getByTestId("series-episode-2").textContent).toContain("工作台人工修改稿");
  });

  it("5. a batch whose dependencies are stale offers no placement and says why", async () => {
    const stale = structuredClone(view);
    stale.batches[0] = { ...stale.batches[0]!, placement: "ledger_stale" };
    server((method, url) => method === "GET" && url.endsWith(`/projects/${P1}/series`) ? json({ series: stale }) : undefined);
    render(<SeriesWritingPage projectId={P1} />);
    const row = await screen.findByTestId("series-batch-1");
    expect(within(row).queryByRole("button", { name: "写入正式分集" })).toBeNull();
    expect(row.textContent).toContain("暂不能写入");
  });
});

describe("round 4 on the page: the plan editor keeps the revision it was opened on", () => {
  function revised(base: SeriesView, revisionNo: number, content: unknown): SeriesView {
    const next = structuredClone(base);
    next.plan = { ...next.plan!, revisionId: `plan-revision-${String(revisionNo)}`, revisionNo, origin: "manual", status: "unreviewed",
      content: content as NonNullable<SeriesView["plan"]>["content"] };
    return next;
  }
  const editor = () => screen.getByLabelText("规划 JSON") as HTMLTextAreaElement;
  const open = () => { fireEvent.focus(editor()); return JSON.parse(editor().value) as NonNullable<SeriesView["plan"]>["content"]; };
  const type = (content: unknown) => fireEvent.change(editor(), { target: { value: JSON.stringify(content, null, 2) } });

  it("A. two saves of one's own edits in a row: the second starts from the saved first revision and keeps its change", async () => {
    let latest = structuredClone(view);
    const posts: Array<{ basePlanRevisionId: string; content: NonNullable<SeriesView["plan"]>["content"] }> = [];
    server((method, url, body) => {
      if (method === "GET" && url.endsWith(`/projects/${P1}/series`)) return json({ series: latest });
      if (method === "POST" && url.endsWith("/series/plan-revisions")) {
        const request = body as (typeof posts)[number];
        posts.push(request);
        latest = revised(latest, latest.plan!.revisionNo + 1, request.content);
        return json({ series: latest }, 201);
      }
      return undefined;
    });
    render(<SeriesWritingPage projectId={P1} />);
    await screen.findByTestId("series-plan");
    const first = open();
    first.setting.logline = "第一次人工修改的一句话故事";
    type(first);
    fireEvent.click(screen.getByRole("button", { name: "保存为新修订" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId("series-plan-status").textContent).toContain("修订 2"));
    const second = open();
    expect(second.setting.logline).toBe("第一次人工修改的一句话故事");
    second.setting.synopsis = "第二次人工修改的梗概";
    type(second);
    fireEvent.click(screen.getByRole("button", { name: "保存为新修订" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[0]!.basePlanRevisionId).toBe(view.plan!.revisionId);
    expect(posts[1]!.basePlanRevisionId).toBe("plan-revision-2");
    expect(posts[1]!.content.setting).toMatchObject({ logline: "第一次人工修改的一句话故事", synopsis: "第二次人工修改的梗概" });
  });

  it("B. another page saves a new plan while the editor is open: the warning shows, the old edit is sent on its own basis and refused, the text is kept", async () => {
    const running = structuredClone(view);
    running.grants = running.grants.map((item) => ({ ...item, state: "running" as const }));
    running.activeGrantId = running.grants[0]!.grantId;
    let latest = running;
    const posts: Array<{ basePlanRevisionId: string; baseStoryRevisionId: string | null }> = [];
    server((method, url, body) => {
      if (method === "GET" && url.endsWith(`/projects/${P1}/series`)) return json({ series: latest });
      if (method === "POST" && url.endsWith("/series/plan-revisions")) {
        posts.push(body as (typeof posts)[number]);
        return json({ error: { code: "SERIES_EDIT_CONFLICT", message: "保存时发现已有更新的修订，没有覆盖。" } }, 409);
      }
      return undefined;
    });
    render(<SeriesWritingPage projectId={P1} />);
    await screen.findByTestId("series-plan");
    const mine = open();
    mine.setting.logline = "我在旧修订上的修改";
    type(mine);
    // Another page saved revision 2 (and the job finished); the next background read brings it.
    const other = structuredClone(view.plan!.content);
    other.setting.logline = "另一页面保存的一句话故事";
    latest = revised(view, 2, other);
    await waitFor(() => expect(screen.getByTestId("series-plan-status").textContent).toContain("修订 2"), { timeout: 5_000 });
    fireEvent.click(screen.getByRole("button", { name: "保存为新修订" }));
    await screen.findByTestId("series-error");
    expect(posts).toHaveLength(1);
    // Sent on the revision the editor was opened on, never on the newer one the person did not see.
    expect(posts[0]!.basePlanRevisionId).toBe(view.plan!.revisionId);
    expect(posts[0]!.baseStoryRevisionId).toBe(view.story.current?.revisionId ?? null);
    expect(screen.getByTestId("series-plan-changed").textContent).toContain("已经变化");
    expect(editor().value).toContain("我在旧修订上的修改");
  });
});

describe("round 5 on the page: a confirmation is bound to the terms the person saw", () => {
  const TWO = { ...OPTIONS, providers: [
    { providerKey: "deepseek", label: "DeepSeek", ready: true, models: ["deepseek-flash", "deepseek-pro"], defaultModel: "deepseek-flash", missing: [] },
    { providerKey: "anthropic", label: "Claude", ready: true, models: ["claude-test"], defaultModel: "claude-test", missing: [] },
  ] };
  const select = (label: string) => within(screen.getByTestId("series-card")).getByLabelText(label) as HTMLSelectElement;
  const confirmBox = () => screen.getByTestId("series-confirm") as HTMLInputElement;
  const posts = (calls: ReturnType<typeof server>) => calls.filter((call) => call.method === "POST" && call.url.endsWith("/series/grants"));

  async function card(handler: Parameters<typeof server>[0] = () => undefined) {
    const calls = server((method, url, body) => url.endsWith("/writing/series/options") ? json(TWO) : handler(method, url, body));
    render(<SeriesWritingPage projectId={P1} />);
    await screen.findByTestId("series-card");
    await waitFor(() => expect(select("模型").value).toBe("deepseek-flash"));
    fireEvent.change(screen.getByTestId("series-preset"), { target: { value: "continue" } });
    await waitFor(() => expect(screen.getByTestId("series-card-summary").textContent).toContain("第 4–6 集 4 次"));
    return calls;
  }

  it("A. confirmed for batch 2, then widened to batch 5 without confirming again: nothing is sent", async () => {
    const calls = await card();
    fireEvent.click(confirmBox());
    expect(confirmBox().checked).toBe(true);
    fireEvent.change(select("写到第几批"), { target: { value: "5" } });
    expect(confirmBox().checked).toBe(false);
    expect(screen.getByTestId("series-confirm-stale").textContent).toContain("重新确认");
    expect((screen.getByTestId("series-grant") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("series-grant"));
    expect(posts(calls)).toHaveLength(0);
  });

  it.each<[string, () => void]>([
    ["the provider", () => fireEvent.change(select("模型服务"), { target: { value: "anthropic" } })],
    ["the model", () => fireEvent.change(select("模型"), { target: { value: "deepseek-pro" } })],
    ["the batch range", () => fireEvent.change(select("写到第几批"), { target: { value: "3" } })],
    ["the resend allowance", () => fireEvent.change(select("允许人工确认的重发次数"), { target: { value: "2" } })],
    ["the scope preset", () => fireEvent.change(screen.getByTestId("series-preset"), { target: { value: "final" } })],
  ])("B. changing %s voids the confirmation", async (_label, change) => {
    const calls = await card();
    fireEvent.click(confirmBox());
    change();
    expect(confirmBox().checked).toBe(false);
    fireEvent.click(screen.getByTestId("series-grant"));
    expect(posts(calls)).toHaveLength(0);
  });

  it("B. turning the final review on or off voids the confirmation", async () => {
    const calls = await card();
    fireEvent.change(select("写到第几批"), { target: { value: "20" } });
    const final = () => within(screen.getByTestId("series-card")).getByLabelText(/写完后做全剧结构与连续性总检/) as HTMLInputElement;
    fireEvent.click(confirmBox());
    fireEvent.click(final());
    expect(confirmBox().checked).toBe(false);
    fireEvent.click(screen.getByTestId("series-grant"));
    expect(posts(calls)).toHaveLength(0);
  });

  it("C. confirmed again after the change: the request is exactly the terms and budget on the card", async () => {
    const calls = await card((method, url) => method === "POST" && url.endsWith("/series/grants") ? json({ grantId: randomUUID(), series: view }, 201) : undefined);
    fireEvent.click(confirmBox());
    fireEvent.change(select("写到第几批"), { target: { value: "3" } });
    fireEvent.change(select("允许人工确认的重发次数"), { target: { value: "1" } });
    fireEvent.change(select("模型"), { target: { value: "deepseek-pro" } });
    expect(screen.getByTestId("series-card-summary").textContent).toContain("正常调用 8 次 + 重发 1 次 = 预算 9 次");
    fireEvent.click(confirmBox());
    fireEvent.click(screen.getByTestId("series-grant"));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]!.body).toEqual({ scope: { plan: false, batchFrom: 2, batchTo: 3, final: false }, normalCalls: 8, resendAllowance: 1, callBudget: 9,
      providerKey: "deepseek", model: "deepseek-pro", basePlanRevisionId: view.plan!.revisionId });
  });

  it("D. a new view with the same terms (another action's answer) keeps the confirmation", async () => {
    const calls = await card((method, url) => method === "POST" && url.includes("/batches/1/scripts") ? json({ placed: 0, conflicts: [], series: JSON.parse(JSON.stringify(view)) as SeriesView }) : undefined);
    fireEvent.click(confirmBox());
    fireEvent.click(within(screen.getByTestId("series-batch-1")).getByRole("button", { name: "写入正式分集" }));
    await waitFor(() => expect(calls.some((call) => call.url.includes("/batches/1/scripts"))).toBe(true));
    await waitFor(() => expect((screen.getByTestId("series-grant") as HTMLButtonElement).disabled).toBe(false));
    expect(confirmBox().checked).toBe(true);
    expect(screen.queryByTestId("series-confirm-stale")).toBeNull();
  });

  it("E. a grant whose answer was lost is replayed with its frozen body and key, whatever the form shows now", async () => {
    let lose = true;
    const calls = await card((method, url) => {
      if (method === "POST" && url.endsWith("/series/grants")) {
        if (lose) { lose = false; throw new TypeError("fetch failed"); }
        return json({ grantId: randomUUID(), series: view }, 201);
      }
      return undefined;
    });
    fireEvent.click(confirmBox());
    fireEvent.click(screen.getByTestId("series-grant"));
    await screen.findByTestId("series-error");
    expect(screen.getByTestId("series-card-frozen")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试授权" }));
    await waitFor(() => expect(posts(calls)).toHaveLength(2));
    const [a, b] = posts(calls);
    expect(b!.key).toBe(a!.key);
    expect(b!.body).toEqual(a!.body);
  });

  it("F. a change and a click in the same moment never send the old confirmation's new terms", async () => {
    const calls = await card();
    fireEvent.click(confirmBox());
    fireEvent.change(select("写到第几批"), { target: { value: "20" } });
    fireEvent.click(screen.getByTestId("series-grant"));
    fireEvent.click(screen.getByTestId("series-grant"));
    expect(posts(calls)).toHaveLength(0);
  });
});

describe("round 8, 4: a create request restored after a reload shows exactly what it will send", () => {
  const FULL = { title: "冻结的系列", episodeCount: 12, episodeSeconds: 90, idea: "夜班便利店",
    constraints: { genre: "悬疑", audience: "通勤上班族", maxCharacters: 5, maxLocations: 3, forbiddenThemes: ["僵尸", "穿越"], endingRequirement: "开放式结局" } };
  const fields = () => ({
    title: (screen.getByLabelText("系列作品名称") as HTMLInputElement),
    genre: (screen.getByLabelText("题材") as HTMLInputElement),
    audience: (screen.getByLabelText("目标观众") as HTMLInputElement),
    maxCharacters: (screen.getByLabelText("人物上限（1–12）") as HTMLInputElement),
    maxLocations: (screen.getByLabelText("地点上限（1–10）") as HTMLInputElement),
    forbidden: (screen.getByLabelText("禁止的题材或元素（逗号分隔）") as HTMLInputElement),
    ending: (screen.getByLabelText("结局要求") as HTMLInputElement),
  });

  it("every frozen constraint is shown in its disabled field; the retry sends the stored body and key unchanged", async () => {
    const key = randomUUID();
    expect(savePendingSeries({ version: 1, scope: "create", key, body: FULL })).toBe(true);
    let fail = true;
    const calls = server((method, url) => method === "POST" && url.endsWith("/writing/series")
      ? (fail ? json({ error: { code: "UPSTREAM", message: "x" } }, 502) : json({ series: view }, 201)) : undefined);
    vi.stubGlobal("location", { ...window.location, assign: vi.fn() });
    render(<SeriesWritingStart />);
    await screen.findByRole("button", { name: "重试创建" });
    const shown = fields();
    expect({ title: shown.title.value, genre: shown.genre.value, audience: shown.audience.value, maxCharacters: shown.maxCharacters.value,
      maxLocations: shown.maxLocations.value, forbidden: shown.forbidden.value, ending: shown.ending.value })
      .toEqual({ title: "冻结的系列", genre: "悬疑", audience: "通勤上班族", maxCharacters: "5", maxLocations: "3", forbidden: "僵尸，穿越", ending: "开放式结局" });
    expect(Object.values(shown).every((input) => input.disabled)).toBe(true);
    // The call counts are the stored request's (12 episodes), not the form's default 60.
    expect(screen.getByTestId("series-start-calls").textContent).toContain("12 集的正常调用");
    // The constraints are visible without opening anything.
    expect(shown.genre.closest("details")!.open).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "重试创建" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "POST")).toHaveLength(1));
    fail = false;
    fireEvent.click(await screen.findByRole("button", { name: "重试创建" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "POST")).toHaveLength(2));
    for (const post of calls.filter((call) => call.method === "POST")) {
      expect(post.body).toEqual(FULL);
      expect(post.key).toBe(key);
    }
  });

  it("constraints left unset are shown empty, never a default limit", async () => {
    const partial = { ...FULL, constraints: { genre: "", audience: "", maxCharacters: null, maxLocations: 4, forbiddenThemes: [], endingRequirement: "" } };
    expect(savePendingSeries({ version: 1, scope: "create", key: randomUUID(), body: partial })).toBe(true);
    server();
    render(<SeriesWritingStart />);
    await screen.findByRole("button", { name: "重试创建" });
    const shown = fields();
    expect([shown.genre.value, shown.audience.value, shown.maxCharacters.value, shown.maxLocations.value, shown.forbidden.value, shown.ending.value])
      .toEqual(["", "", "", "4", "", ""]);
  });

  it("after the person gives the request up, the form is editable again and creates a new request from what it shows", async () => {
    expect(savePendingSeries({ version: 1, scope: "create", key: randomUUID(), body: FULL })).toBe(true);
    const calls = server((method, url) => method === "POST" && url.endsWith("/writing/series") ? json({ series: view }, 201) : undefined);
    vi.stubGlobal("location", { ...window.location, assign: vi.fn() });
    render(<SeriesWritingStart />);
    fireEvent.click(await screen.findByRole("button", { name: "放弃这次请求" }));
    const shown = fields();
    expect(shown.genre.disabled).toBe(false);
    fireEvent.change(shown.title, { target: { value: "新的系列" } });
    fireEvent.change(shown.genre, { target: { value: "喜剧" } });
    fireEvent.click(screen.getByRole("button", { name: "创建系列作品" }));
    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
    expect(calls.find((call) => call.method === "POST")!.body).toMatchObject({ title: "新的系列", constraints: { genre: "喜剧", maxCharacters: null } });
  });
});

describe("round 8, 5 on the page: a plan blocker is pending work before any episode is written", () => {
  it("a blocking model plan review with 0 episodes shows the plan blocker as 待办, as the domain computed it", async () => {
    const store = new InMemorySeriesWritingStore();
    const now = new Date("2026-10-22T00:00:00Z");
    const series = newSeries({ workspaceId: WS, projectId: P1, actorId: "server-owner", idempotencyKey: "k8", title: "规划待改样例", idea: "", constraints: seriesConstraintsSchema.parse({}),
      materials: [], referenceUrls: [], researchFetch: false, episodeCount: 6, episodeSeconds: 60, now });
    await store.createSeries(series, { title: series.title, premise: "" });
    const grant = newSeriesGrant({ series, actorId: "server-owner", idempotencyKey: "g8", scope: { plan: true, batchFrom: null, batchTo: null, final: false }, normalCalls: seriesPlanCalls(6),
      resendAllowance: 0, callBudget: seriesPlanCalls(6), providerKey: "deepseek", model: "m-1", basePlanRevisionId: null,
      authorization: { mode: "series", proof: "site_session", initiatedBy: "server-owner", executor: "series-writing-engine" }, now });
    const created = await store.createGrant(grant, { sinceIso: "2026-10-21T00:00:00Z", maxCallsPerDay: 100, maxActiveRuns: 2 },
      (snapshot) => admitSeriesGrant(snapshot, grant, { jobId: randomUUID(), nowIso: now.toISOString() }));
    if (created.kind !== "created") throw new Error(created.kind);
    const providers = titleWritingProviderConfigs({ DEEPSEEK_API_KEY: "sk-deepseek-test-0123456789", TITLE_WRITING_DEEPSEEK_MODELS: "m-1" });
    await new SeriesWritingEngine({ workspaceId: WS, store, providers, transport: seriesFixtureTransport({ plan: { blockingPlanReview: true } }), maxCallsPerDay: 100,
      maxActiveRuns: 2, clock: () => now }).drive(created.jobId);
    const blocked = JSON.parse(JSON.stringify(seriesView((await store.snapshot(WS, P1))!))) as SeriesView;
    expect(blocked).toMatchObject({ written: 0, attention: ["plan_review_blocking"] });
    server((method, url) => method === "GET" && url.endsWith(`/projects/${P1}/series`) ? json({ series: blocked }) : undefined);
    render(<SeriesWritingPage projectId={P1} />);
    const attention = await screen.findByTestId("series-attention");
    expect(attention.textContent).toContain("规划审阅发现必须修改的问题");
    expect(attention.textContent).not.toContain("无");
  });
});
