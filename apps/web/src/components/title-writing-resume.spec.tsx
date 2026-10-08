// @vitest-environment happy-dom
// Resume confirmation on the progress page. Simulated interface tests: fetch is mocked; no browser, API or model.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TitleWritingCallView, TitleWritingRunView, TitleWritingStepView } from "@ai-drama/contracts";
import { TitleWritingClient } from "../lib/title-writing-client";
import { TitleWritingRun } from "./title-writing-run";

const P1 = "22222222-2222-4222-8222-222222222222";
const RUN = "66666666-6666-4666-8666-666666666666";
const CALL_1 = "aaaaaaaa-0000-4000-8000-000000000001";
const CALL_2 = "aaaaaaaa-0000-4000-8000-000000000002";
const TOKEN = "operator-token-0123456789";
const KEYS = ["concept", "outline", "episode:1", "episode:2", "episode:3"] as const;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function call(callId: string, attemptNo: number, state: TitleWritingCallView["state"]): TitleWritingCallView {
  return { callId, stepKey: "concept", attemptNo, providerKey: "qwen", model: "q-1", responseModel: null, providerRequestId: null, state,
    errorCode: state === "unknown" ? "timeout" : null, usage: { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null },
    billingStatus: "unknown", createdAt: `2026-10-08T00:00:0${String(attemptNo)}Z`, finishedAt: "2026-10-08T00:01:00Z" };
}

/** The concept step is uncertain at the given attempt; earlier attempts are uncertain too. */
function uncertainRun(attemptNo: number, overrides: Partial<TitleWritingRunView> = {}): TitleWritingRunView {
  const steps: TitleWritingStepView[] = KEYS.map((stepKey, index) => ({ stepKey, state: index === 0 ? "unknown" : "pending",
    attemptNo: index === 0 ? attemptNo : 0, errorCode: index === 0 ? "timeout" : null, output: null, text: null,
    scriptSave: stepKey.startsWith("episode:") ? "pending" : null, scriptRevisionId: null }));
  return {
    runId: RUN, projectId: P1, title: "夜班证词", settings: { episodeCount: 3, episodeSeconds: 90, style: "" }, providerKey: "qwen", model: "q-1",
    state: "needs_attention", errorCode: "timeout", cancelRequested: false, callCap: 8, callsUsed: attemptNo, storySave: "pending",
    storyRevisionId: null, storyText: null, steps, calls: [CALL_1, CALL_2].slice(0, attemptNo).map((id, index) => call(id, index + 1, "unknown")),
    createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z", ...overrides,
  };
}

interface Call { method: string; url: string; headers: Record<string, string>; body: unknown }
function server(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const entry: Call = { method: init?.method ?? "GET", url: input, headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null };
    calls.push(entry);
    return handler(entry);
  }));
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function confirmAndResume() {
  fireEvent.change(screen.getByLabelText("操作者令牌"), { target: { value: TOKEN } });
  const box = screen.getByLabelText(/可能已经产生费用，确认重新发送/) as HTMLInputElement;
  if (!box.checked) fireEvent.click(box);
  fireEvent.click(screen.getByRole("button", { name: "继续创作" }));
}

describe("resume confirmation", () => {
  it("names the uncertain call the person saw, with an idempotency key, and clears the confirmation once accepted", async () => {
    let latest = uncertainRun(1);
    const calls = server((request) => {
      if (request.method === "POST") {
        // Accepted; the resent attempt is uncertain again.
        latest = uncertainRun(2);
        return json({ run: latest });
      }
      return json({ run: latest });
    });
    render(<TitleWritingRun projectId={P1} client={new TitleWritingClient()} />);
    expect(await screen.findByText("需要处理")).toBeTruthy();
    await confirmAndResume();
    await waitFor(() => expect(calls.filter((item) => item.method === "POST")).toHaveLength(1));
    const post = calls.find((item) => item.method === "POST")!;
    expect(post.body).toEqual({ confirmUncertainCallIds: [CALL_1] });
    expect(post.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(post.headers["X-Operator-Token"]).toBe(TOKEN);
    // A new uncertain attempt: the old confirmation does not carry over and the button needs a new one.
    await waitFor(() => expect((screen.getByLabelText(/可能已经产生费用，确认重新发送/) as HTMLInputElement).checked).toBe(false));
    expect((screen.getByRole("button", { name: "继续创作" }) as HTMLButtonElement).disabled).toBe(true);
    await confirmAndResume();
    await waitFor(() => expect(calls.filter((item) => item.method === "POST")).toHaveLength(2));
    const second = calls.filter((item) => item.method === "POST")[1]!;
    expect(second.body).toEqual({ confirmUncertainCallIds: [CALL_2] });
    expect(second.headers["Idempotency-Key"]).not.toBe(post.headers["Idempotency-Key"]);
  });

  it("an unanswered resume is retried with the same key; a refused one is not", async () => {
    let attempt = 0;
    const calls = server((request) => {
      if (request.method !== "POST") return json({ run: uncertainRun(1) });
      attempt += 1;
      if (attempt === 1) return Promise.reject(new TypeError("network"));
      return json({ error: { code: "TITLE_WRITING_CONFIRMATION_STALE", message: "x" } }, 409);
    });
    render(<TitleWritingRun projectId={P1} client={new TitleWritingClient()} />);
    expect(await screen.findByText("需要处理")).toBeTruthy();
    await confirmAndResume();
    expect((await screen.findByRole("alert")).textContent).toContain("没有确认续跑是否已被受理");
    // The confirmation stays for the same uncertain call; the retry replays the same action.
    expect((screen.getByLabelText(/可能已经产生费用，确认重新发送/) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "继续创作" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("之前的确认已作废"));
    const posts = calls.filter((item) => item.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[1]?.headers["Idempotency-Key"]).toBe(posts[0]?.headers["Idempotency-Key"]);
    expect(posts[1]?.body).toEqual(posts[0]?.body);
    // Refused: the confirmation is cleared and the page reads the run again.
    await waitFor(() => expect((screen.getByLabelText(/可能已经产生费用，确认重新发送/) as HTMLInputElement).checked).toBe(false));
    await waitFor(() => expect(calls.filter((item) => item.method === "GET").length).toBeGreaterThanOrEqual(2));
    await confirmAndResume();
    await waitFor(() => expect(calls.filter((item) => item.method === "POST")).toHaveLength(3));
    expect(calls.filter((item) => item.method === "POST")[2]?.headers["Idempotency-Key"]).not.toBe(posts[0]?.headers["Idempotency-Key"]);
  });
});
