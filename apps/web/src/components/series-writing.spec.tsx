// @vitest-environment happy-dom
// Series writing page and start card. Simulated interface tests: fetch is mocked with a view the domain computed from the
// in-process store after a model-double run; no browser, API or model.
import { randomUUID } from "node:crypto";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { seriesConstraintsSchema } from "@ai-drama/contracts";
import { admitSeriesGrant, seriesView, type SeriesView } from "@ai-drama/domain";
import { InMemorySeriesWritingStore, SeriesWritingEngine, newSeries, newSeriesGrant, titleWritingProviderConfigs } from "@ai-drama/providers";
import { seriesFixtureTransport } from "@ai-drama/providers/title-writing-fixtures";
import { SeriesWritingPage } from "./series-writing-page";
import { SeriesWritingStart } from "./series-writing-start";

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
