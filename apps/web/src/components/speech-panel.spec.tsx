// @vitest-environment happy-dom
// Offline API simulation: no database, media service, paid generation or real browser is used.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpeechBinding, SpeechMixPreflight, SpeechPlanView, SpeechTakesPage, SpeechVoiceRevision } from "@ai-drama/contracts";
import { clearSpeechPending, createSpeechClient, readSpeechPending, SpeechJournalError, writeSpeechPending,
  type SpeechPendingSubmission } from "../lib/speech-api";
import { createSpeechDraft, SpeechPanel } from "./speech-panel";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const SHOT = "22222222-2222-4222-8222-222222222222";
const SHOT_B = "22222222-2222-4222-8222-222222222223";
const CHARACTER = "33333333-3333-4333-8333-333333333333";
const VOICE = "44444444-4444-4444-8444-444444444444";
const PLAN = "55555555-5555-4555-8555-555555555555";
const LINE = "66666666-6666-4666-8666-666666666666";
const TAKE = "77777777-7777-4777-8777-777777777777";
const OLD_TAKE = "77777777-7777-4777-8777-777777777778";
const VIDEO = "88888888-8888-4888-8888-888888888888";
const BUDGET = "99999999-9999-4999-8999-999999999999";
const HASH = "ab".repeat(32);
const CHARACTERS = [{ id: CHARACTER, name: "林夏" }];
const VOICE_DATA: SpeechVoiceRevision = {
  id: VOICE, bindingId: CHARACTER, contentHash: HASH, catalogVoiceId: "warm", name: "温暖女声",
  providerConfigurationId: PROJECT, providerConfigurationVersion: "1", providerKey: "speech-provider",
  model: "tts", modelVersion: "1", voiceId: "voice-1", locale: "zh-CN", rightsRef: "preset:licensed",
  capabilities: { emotions: ["neutral"], speedMin: 0.8, speedMax: 1.2 },
};
const BINDING: SpeechBinding = { id: CHARACTER, speakerId: CHARACTER, rowVersion: 2, currentRevision: VOICE_DATA };
const PLAN_DATA: SpeechPlanView = {
  shotRevisionId: SHOT, projectId: PROJECT, sourceDialogue: "林夏：这不是我。", sourceDialogueHash: HASH, rowVersion: 3,
  currentRevision: { id: PLAN, contentHash: HASH, timingPolicy: "sequential-reject-overflow", lines: [{ lineId: LINE,
    speakerBindingRevisionId: VOICE, sourceStart: 3, sourceEnd: 8, displayText: "这不是我。", emotion: "neutral", speed: 1,
    pauseAfterMs: 0, lineInputRevisionId: LINE, inputHash: HASH }] },
};
const EMPTY: SpeechTakesPage = { items: [], selected: [], hasMore: false, rowVersion: 3 };
const CANDIDATE = { assetId: TAKE, lineId: LINE, lineInputRevisionId: LINE, checksumSha256: HASH, durationMs: 1200,
  selectable: true, status: "ACTIVE", jobId: TAKE, alignmentVersion: "sentence-duration-v1" as const };
const SELECTION = { id: OLD_TAKE, lineId: LINE, takeAssetId: OLD_TAKE, checksumSha256: HASH, lineInputRevisionId: LINE,
  selectedBy: "author", selectedAt: "2026-11-01T00:00:00.000Z", inheritedFromSelectionId: null };

function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
function fixture(input: string, init?: RequestInit): Response {
  if (input.endsWith("speech-capabilities")) return json({ available: true, reasonCode: null, catalogVersion: "catalog-v1", voices: [VOICE_DATA, { ...VOICE_DATA, catalogVoiceId: "calm", name: "沉稳女声" }] });
  if (input.endsWith("voice-bindings")) return json({ items: [BINDING] });
  if (input.endsWith("speech-plan") && init?.method === "GET") return json(PLAN_DATA);
  if (input.endsWith("/takes")) return json(EMPTY);
  throw new Error(`Unexpected request: ${init?.method} ${input}`);
}
function deferred() { let resolve: (value: Response) => void = () => undefined; const promise = new Promise<Response>((done) => { resolve = done; }); return { promise, resolve }; }
function pending(overrides: Partial<SpeechPendingSubmission> = {}): SpeechPendingSubmission {
  return { schema: "speech.browser-submission.v1", projectId: PROJECT, shotRevisionId: SHOT, planRevisionId: PLAN, lineId: LINE,
    quote: { quoteId: "quote-journal", inputHash: HASH, currency: "CNY", estimatedAmount: "0.50", maximumAmount: "0.50",
      expiresAt: "2099-01-01T00:00:00Z", providerConfigurationId: PROJECT, providerConfigurationVersion: "1", priceVersion: "1" },
    maximumAmount: "0.50", key: "original-permanent-key", authorizationId: null, jobId: null,
    confirmedUncertainJobIds: [], unknown: true, ...overrides };
}

beforeEach(() => {
  // A fresh standards-shaped storage fake avoids leaking Happy DOM Storage proxy spies between tests.
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(String(key), String(value)); },
  };
  vi.stubGlobal("sessionStorage", storage);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("speech panel", () => {
  it("keeps unsaved dialogue and its original source/CAS basis across background refresh", async () => {
    let latest = false;
    const writes: RequestInit[] = [];
    const newer = { ...PLAN_DATA, sourceDialogue: "林夏：这是后台的新对白。", sourceDialogueHash: "cd".repeat(32), rowVersion: 90,
      currentRevision: { ...PLAN_DATA.currentRevision!, id: OLD_TAKE } };
    const client = createSpeechClient(async (input, init) => {
      if (input.endsWith("speech-plan") && init?.method === "GET") return json(latest ? newer : PLAN_DATA);
      if (input.endsWith("speech-plan") && init?.method === "PUT") { writes.push(init); return json(PLAN_DATA); }
      return fixture(input, init);
    });
    const props = { projectId: PROJECT, shotRevisionId: SHOT, client, characters: CHARACTERS };
    const view = render(createElement(SpeechPanel, { ...props, refreshEpoch: 0 }));
    fireEvent.change(await screen.findByLabelText("第 1 句句后停顿"), { target: { value: "300" } });
    latest = true; view.rerender(createElement(SpeechPanel, { ...props, refreshEpoch: 1 }));
    expect(await screen.findByText(/未保存草稿及打开时版本仍保留/)).toBeTruthy();
    expect((screen.getByLabelText("第 1 句句后停顿") as HTMLInputElement).value).toBe("300");
    expect(screen.getByLabelText("已保存的对白原文").textContent).toBe(PLAN_DATA.sourceDialogue);
    fireEvent.click(screen.getByRole("button", { name: "保存并确认台词计划" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.headers).toMatchObject({ "If-Match": "3" });
    expect(JSON.parse(String(writes[0]!.body))).toMatchObject({ sourceDialogueHash: HASH, lines: [{ displayText: "这不是我。", pauseAfterMs: 300 }] });
  });

  it("keeps an unsaved voice choice and original binding basis until explicit discard", async () => {
    let latest = false;
    const client = createSpeechClient(async (input, init) => {
      if (input.endsWith("voice-bindings") && latest) return json({ items: [{ ...BINDING, rowVersion: 9,
        currentRevision: { ...VOICE_DATA, catalogVoiceId: "calm", name: "后台选声" } }] });
      return fixture(input, init);
    });
    const props = { projectId: PROJECT, shotRevisionId: SHOT, client, characters: CHARACTERS };
    const view = render(createElement(SpeechPanel, { ...props, refreshEpoch: 0 }));
    fireEvent.change(await screen.findByLabelText("林夏的声音"), { target: { value: "calm" } });
    latest = true; view.rerender(createElement(SpeechPanel, { ...props, refreshEpoch: 1 }));
    expect(await screen.findByText(/未保存草稿及打开时版本仍保留/)).toBeTruthy();
    expect((screen.getByLabelText("林夏的声音") as HTMLSelectElement).value).toBe("calm");
    expect(screen.getByText("已保存：温暖女声")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "放弃未保存草稿并重新读取" }));
    expect(await screen.findByText("已保存：后台选声")).toBeTruthy();
    expect(screen.queryByText(/未保存草稿及打开时版本仍保留/)).toBeNull();
  });

  it("lets a silent shot explicitly save an empty plan without generating speech", async () => {
    const writes: RequestInit[] = [];
    const empty = { ...PLAN_DATA, sourceDialogue: "", currentRevision: null };
    const client = createSpeechClient(async (input, init) => {
      if (input.endsWith("speech-plan") && init?.method === "GET") return json(empty);
      if (input.endsWith("speech-plan") && init?.method === "PUT") { writes.push(init); return json({ ...empty,
        currentRevision: { ...PLAN_DATA.currentRevision!, lines: [] } }); }
      return fixture(input, init);
    });
    render(createElement(SpeechPanel, { projectId: PROJECT, shotRevisionId: SHOT, client }));
    fireEvent.click(await screen.findByRole("button", { name: "确认本镜头无对白" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(JSON.parse(String(writes[0]!.body))).toMatchObject({ lines: [], sourceDialogueHash: HASH });
  });

  it("keeps unconfigured generation disabled and does not invent a finished voice", async () => {
    const requests: string[] = [];
    const client = createSpeechClient(async (input, init) => {
      requests.push(input);
      if (input.endsWith("speech-capabilities")) return json({ available: false, reasonCode: "SPEECH_PROVIDER_UNCONFIGURED", catalogVersion: "disabled", voices: [] });
      return fixture(input, init);
    });
    render(createElement(SpeechPanel, { projectId: PROJECT, shotRevisionId: SHOT, client, characters: CHARACTERS }));
    expect(await screen.findByText(/配音服务尚未开启/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "生成本句：先查看费用" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText("生成完成，请试听后选用")).toBeNull();
    expect(requests.some((url) => url.endsWith("/generate"))).toBe(false);
  });

  it("keeps saved selections, audition and local mix available when new paid generation is disabled", async () => {
    const paid: string[] = [];
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const preflight = { inputHash: HASH, manifest: { totalSpeechMs: 1200, videoDurationMs: 2000,
      subtitles: { cues: [{ lineId: LINE, startMs: 0, endMs: 1200, text: "这不是我。" }] } },
      subtitleVtt: "WEBVTT\n\n00:00:00.000 --> 00:00:01.200\n这不是我。\n", guards: { planRowVersion: 3, assets: [] } };
    const client = createSpeechClient(async (input, init) => {
      if (input.endsWith("speech-capabilities")) return json({ available: false, reasonCode: "REAL_MEDIA_NOT_READY", catalogVersion: "disabled", voices: [] });
      if (input.endsWith("/takes")) return json({ ...EMPTY, items: [CANDIDATE], selected: [{ ...SELECTION, usable: true }] });
      if (input.endsWith("/quote") || input.endsWith("/generate")) { paid.push(input); throw new Error("New paid generation must remain closed"); }
      if (input.endsWith("mix-preflight")) return json(preflight);
      return fixture(input, init);
    });
    render(createElement(SpeechPanel, { projectId: PROJECT, shotRevisionId: SHOT, client, videoAssetId: VIDEO, characters: CHARACTERS }));
    const audition = await screen.findByRole("button", { name: "试听第 1 句已选配音" });
    expect(screen.getByText("已选用此句配音")).toBeTruthy();
    expect(screen.getByLabelText("第 1 句台词").textContent).toBe("这不是我。");
    expect(screen.getByRole("button", { name: "再试一版：先查看费用" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "确认费用并生成本句" })).toBeNull();
    fireEvent.click(audition);
    expect(screen.getByLabelText("配音试听播放器").getAttribute("src")).toBe(`/api/v1/assets/${OLD_TAKE}/content`);
    const mix = screen.getByRole("button", { name: "检查声音与字幕" });
    expect(mix.hasAttribute("disabled")).toBe(false);
    fireEvent.click(mix);
    expect(await screen.findByText(/预检通过 · 配音 1.20 秒 · 视频 2.00 秒/)).toBeTruthy();
    expect(paid).toEqual([]);
  });

  it("keeps the explicit disabled capability when speech storage is unavailable", async () => {
    const client = createSpeechClient(async (input) => input.endsWith("speech-capabilities")
      ? json({ available: false, reasonCode: "SPEECH_STORAGE_UNAVAILABLE", catalogVersion: "catalog-v1", voices: [VOICE_DATA] })
      : json({ error: { code: "SPEECH_STORAGE_UNAVAILABLE", message: "配音存储尚未启用，未创建生成任务。" } }, 503));
    render(createElement(SpeechPanel, { projectId: PROJECT, shotRevisionId: SHOT, client, characters: CHARACTERS }));
    expect(await screen.findByText(/配音存储尚未启用/)).toBeTruthy();
    expect(screen.getByText(/SPEECH_STORAGE_UNAVAILABLE/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("林夏的声音"), { target: { value: "warm" } });
    expect(screen.getAllByRole("button", { name: "保存角色声音" })[0]?.hasAttribute("disabled")).toBe(true);
  });

  it("requires an explicit bounded fee confirmation, authorizes locally, then generates without automatically selecting", async () => {
    const writes: Array<{ input: string; init?: RequestInit }> = [];
    const accepted = vi.fn();
    const client = createSpeechClient(async (input, init) => {
      if (input.endsWith("/quote")) { writes.push({ input, init }); return json({ quoteId: "quote-1", inputHash: HASH, currency: "CNY", estimatedAmount: null, maximumAmount: "0.50", expiresAt: "2099-01-01T00:00:00Z", providerConfigurationId: PROJECT, providerConfigurationVersion: "1", priceVersion: "1" }); }
      if (input.endsWith("/authorize")) { writes.push({ input, init }); return json({ budgetAuthorizationId: BUDGET, quoteId: "quote-1" }); }
      if (input.endsWith("/generate")) { writes.push({ input, init }); return json({ jobId: TAKE, workflowRunId: PLAN, reused: false }, 202); }
      return fixture(input, init);
    });
    render(createElement(SpeechPanel, { projectId: PROJECT, shotRevisionId: SHOT, client, characters: CHARACTERS, onJobAccepted: accepted }));
    fireEvent.click(await screen.findByRole("button", { name: "生成本句：先查看费用" }));
    expect(await screen.findByText(/预计费用尚不明确/)).toBeTruthy();
    const generate = screen.getByRole("button", { name: "确认费用并生成本句" });
    expect(generate.hasAttribute("disabled")).toBe(true);
    expect(screen.queryByLabelText("调用预算授权编号")).toBeNull();
    expect((screen.getByLabelText("第 1 句费用上限") as HTMLInputElement).value).toBe("0.50");
    fireEvent.click(screen.getByLabelText("确认第 1 句可能产生一次费用"));
    expect(generate.hasAttribute("disabled")).toBe(false);
    fireEvent.change(screen.getByLabelText("第 1 句费用上限"), { target: { value: "0.60" } });
    expect((screen.getByLabelText("确认第 1 句可能产生一次费用") as HTMLInputElement).checked).toBe(false);
    expect(generate.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByLabelText("确认第 1 句可能产生一次费用"));
    fireEvent.click(generate);
    expect(await screen.findByText("已受理，等待配音；完成后请试听并选用")).toBeTruthy();
    expect(writes.map((item) => item.input.split("/").at(-1))).toEqual(["quote", "authorize", "generate"]);
    const authorization = writes.find((item) => item.input.endsWith("/authorize"));
    expect(JSON.parse(String(authorization?.init?.body))).toEqual({ quoteId: "quote-1", maximumAmount: "0.60", confirmSinglePaidOperation: true, confirmedUncertainJobIds: [] });
    const request = writes.find((item) => item.input.endsWith("/generate"));
    expect(request?.init?.headers).toMatchObject({ "Idempotency-Key": expect.any(String) });
    expect(new Headers(request?.init?.headers).get("Idempotency-Key")).toBe(new Headers(authorization?.init?.headers).get("Idempotency-Key"));
    expect(JSON.parse(String(request?.init?.body))).toEqual({ quoteId: "quote-1", budgetAuthorizationId: BUDGET });
    expect(accepted).toHaveBeenCalledWith(PROJECT);
    expect(writes.some((item) => item.input.includes("/selections/"))).toBe(false);
    expect(screen.getByText("尚未选用配音")).toBeTruthy();
  });

  it("clears fee confirmation when the quote, line, or voice changes", async () => {
    let quotes = 0;
    const secondLine = { ...PLAN_DATA.currentRevision!.lines[0]!, lineId: OLD_TAKE, displayText: "第二句。", inputHash: "cd".repeat(32) };
    const client = createSpeechClient(async (input, init) => {
      if (input.endsWith("speech-plan") && init?.method === "GET") return json({ ...PLAN_DATA, currentRevision: { ...PLAN_DATA.currentRevision, lines: [PLAN_DATA.currentRevision!.lines[0], secondLine] } });
      if (input.endsWith("/quote")) {
        quotes += 1;
        return json({ quoteId: `quote-${quotes}`, inputHash: input.includes(OLD_TAKE) ? secondLine.inputHash : HASH, currency: "CNY", estimatedAmount: "0.50", maximumAmount: "0.50", expiresAt: "2099-01-01T00:00:00Z" });
      }
      return fixture(input, init);
    });
    render(createElement(SpeechPanel, { projectId: PROJECT, shotRevisionId: SHOT, client, characters: CHARACTERS }));
    fireEvent.click((await screen.findAllByRole("button", { name: "生成本句：先查看费用" }))[0]!);
    fireEvent.click(await screen.findByLabelText("确认第 1 句可能产生一次费用"));
    expect(screen.getByRole("button", { name: "确认费用并生成本句" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getAllByRole("button", { name: "生成本句：先查看费用" })[0]!);
    await waitFor(() => expect((screen.getByLabelText("确认第 1 句可能产生一次费用") as HTMLInputElement).checked).toBe(false));
    fireEvent.click(screen.getByLabelText("确认第 1 句可能产生一次费用"));
    fireEvent.click(screen.getAllByRole("button", { name: "生成本句：先查看费用" })[1]!);
    expect(await screen.findByLabelText("确认第 2 句可能产生一次费用")).toBeTruthy();
    expect(screen.queryByLabelText("确认第 1 句可能产生一次费用")).toBeNull();
    expect(screen.getByRole("button", { name: "确认费用并生成本句" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByLabelText("确认第 2 句可能产生一次费用"));
    fireEvent.change(screen.getByLabelText("林夏的声音"), { target: { value: "calm" } });
    expect(screen.queryByLabelText("确认第 2 句可能产生一次费用")).toBeNull();
    expect(screen.queryByRole("button", { name: "确认费用并生成本句" })).toBeNull();
  });

  it.each(["authorize", "generate", "malformed-generate"])("keeps the frozen request and permanent key after an uncertain %s response", async (lostMode) => {
    const lostStage = lostMode === "malformed-generate" ? "generate" : lostMode;
    const requests: Array<{ stage: string; init?: RequestInit }> = [];
    let lost = false;
    const client = createSpeechClient(async (input, init) => {
      const stage = input.split("/").at(-1)!;
      if (stage === "quote") {
        requests.push({ stage, init });
        return json({ quoteId: "quote-1", inputHash: HASH, currency: "CNY", estimatedAmount: "0.50", maximumAmount: "0.50", expiresAt: "2099-01-01T00:00:00Z" });
      }
      if (stage === "authorize" || stage === "generate") {
        requests.push({ stage, init });
        if (stage === lostStage && !lost) {
          lost = true;
          if (lostMode === "malformed-generate") return json({});
          throw new TypeError("Transport receipt lost");
        }
        return stage === "authorize" ? json({ budgetAuthorizationId: BUDGET, quoteId: "quote-1" }) : json({ jobId: TAKE, workflowRunId: PLAN, reused: true }, 202);
      }
      return fixture(input, init);
    });
    render(createElement(SpeechPanel, { projectId: PROJECT, shotRevisionId: SHOT, client, characters: CHARACTERS }));
    fireEvent.click(await screen.findByRole("button", { name: "生成本句：先查看费用" }));
    fireEvent.click(await screen.findByLabelText("确认第 1 句可能产生一次费用"));
    fireEvent.click(screen.getByRole("button", { name: "确认费用并生成本句" }));
    const retry = await screen.findByRole("button", { name: "继续确认原配音任务" });
    expect(screen.getByLabelText("第 1 句费用上限").hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "生成本句：先查看费用" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(retry);
    expect(await screen.findByText("已受理，等待配音；完成后请试听并选用")).toBeTruthy();
    expect(requests.filter((request) => request.stage === "quote")).toHaveLength(1);
    expect(requests.filter((request) => request.stage === "authorize")).toHaveLength(lostStage === "authorize" ? 2 : 1);
    const submitted = requests.filter((request) => request.stage === lostStage);
    expect(submitted).toHaveLength(2);
    expect(submitted[0]?.init?.body).toBe(submitted[1]?.init?.body);
    const keys = requests.filter((request) => request.stage !== "quote").map((request) => new Headers(request.init?.headers).get("Idempotency-Key"));
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBeTruthy();
    expect(screen.queryByRole("button", { name: "继续确认原配音任务" })).toBeNull();
  });

  it("restores a lost generation receipt after a full remount and replays only the original request despite unavailable current inputs", async () => {
    let restores = false;
    let generated = 0;
    const writes: Array<{ stage: string; input: string; init?: RequestInit }> = [];
    const client = createSpeechClient(async (input, init) => {
      const stage = input.split("/").at(-1)!;
      if (["quote", "authorize", "generate"].includes(stage)) writes.push({ stage, input, init });
      if (stage === "quote") return json(pending().quote);
      if (stage === "authorize") return json({ quoteId: "quote-journal", budgetAuthorizationId: BUDGET });
      if (stage === "generate") {
        generated += 1;
        if (generated === 1) throw new TypeError("Lost generation response");
        return json({ jobId: TAKE, workflowRunId: PLAN, reused: true }, 202);
      }
      if (restores && input.endsWith("speech-capabilities")) return json({ available: false, reasonCode: "SPEECH_DISABLED", catalogVersion: "none", voices: [] });
      if (restores && (input.endsWith("speech-plan") || input.endsWith("voice-bindings"))) return json({ error: { code: "SPEECH_PLAN_STALE", message: "当前计划已变化" } }, 409);
      return fixture(input, init);
    });
    const first = render(createElement(SpeechPanel, { projectId: PROJECT, shotRevisionId: SHOT, client }));
    fireEvent.click(await screen.findByRole("button", { name: "生成本句：先查看费用" }));
    fireEvent.click(await screen.findByLabelText("确认第 1 句可能产生一次费用"));
    fireEvent.click(screen.getByRole("button", { name: "确认费用并生成本句" }));
    expect(await screen.findByRole("button", { name: "继续确认原配音任务" })).toBeTruthy();
    expect(readSpeechPending(PROJECT, SHOT)?.authorizationId).toBe(BUDGET);
    first.unmount();
    restores = true;
    render(createElement(SpeechPanel, { projectId: PROJECT, shotRevisionId: SHOT, client }));
    expect(await screen.findByText("当前计划已变化")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "继续确认原配音任务" }));
    expect(await screen.findByText("已受理，等待配音；完成后请试听并选用")).toBeTruthy();
    expect(writes.filter((request) => request.stage === "quote")).toHaveLength(1);
    expect(writes.filter((request) => request.stage === "authorize")).toHaveLength(1);
    const generations = writes.filter((request) => request.stage === "generate");
    expect(generations).toHaveLength(2);
    expect(generations[1]?.input).toContain(`/speech-plans/${PLAN}/lines/${LINE}/generate`);
    expect(generations[1]?.init?.body).toBe(generations[0]?.init?.body);
    expect(new Headers(generations[1]?.init?.headers).get("Idempotency-Key")).toBe(new Headers(generations[0]?.init?.headers).get("Idempotency-Key"));
    expect(readSpeechPending(PROJECT, SHOT)).toBeNull();
  });

  it.each(["write", "readback"])("sends no authorize or generate request when journal %s verification fails", async (mode) => {
    const paid: string[] = [];
    const client = createSpeechClient(async (input, init) => {
      if (input.endsWith("/quote")) return json(pending().quote);
      if (input.endsWith("/authorize") || input.endsWith("/generate")) paid.push(input);
      return fixture(input, init);
    });
    render(createElement(SpeechPanel, { projectId: PROJECT, shotRevisionId: SHOT, client }));
    fireEvent.click(await screen.findByRole("button", { name: "生成本句：先查看费用" }));
    fireEvent.click(await screen.findByLabelText("确认第 1 句可能产生一次费用"));
    const storage = sessionStorage;
    if (mode === "write") vi.spyOn(storage, "setItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    else vi.spyOn(storage, "getItem").mockReturnValue(null);
    fireEvent.click(screen.getByRole("button", { name: "确认费用并生成本句" }));
    expect((await screen.findAllByText(/无法安全保存或核对本次配音请求/)).length).toBeGreaterThan(0);
    expect(paid).toHaveLength(0);
  });

  it("refuses new paid operations when session storage is unavailable", async () => {
    vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("storage unavailable"); } });
    const paid: string[] = [];
    const client = createSpeechClient(async (input, init) => {
      if (input.endsWith("/authorize") || input.endsWith("/generate")) paid.push(input);
      return fixture(input, init);
    });
    render(createElement(SpeechPanel, { projectId: PROJECT, shotRevisionId: SHOT, client }));
    expect(await screen.findByText(/无法安全保存或核对本次配音请求/)).toBeTruthy();
    expect((await screen.findByRole("button", { name: "生成本句：先查看费用" })).hasAttribute("disabled")).toBe(true);
    expect(paid).toHaveLength(0);
  });

  it("restores an acknowledged journal only by reading its original Job and never resends generation", async () => {
    writeSpeechPending(pending({ authorizationId: BUDGET, jobId: TAKE, unknown: false }));
    const writes: string[] = [];
    const reads: string[] = [];
    const client = createSpeechClient(async (input, init) => {
      if (init?.method !== "GET") writes.push(input);
      if (input.endsWith(`/generation-jobs/${TAKE}`)) { reads.push(input); return json({ id: TAKE, state: "SUCCEEDED", errorMessage: null }); }
      return fixture(input, init);
    });
    render(createElement(SpeechPanel, { projectId: PROJECT, shotRevisionId: SHOT, client }));
    expect(await screen.findByText("生成完成，请试听后选用")).toBeTruthy();
    expect(reads).toHaveLength(1);
    expect(writes).toHaveLength(0);
    expect(readSpeechPending(PROJECT, SHOT)).toBeNull();
  });

  it("requires a separate explicit confirmation of the exact quoted historical uncertain tasks", async () => {
    const authorizations: RequestInit[] = [];
    const client = createSpeechClient(async (input, init) => {
      if (input.endsWith("/quote")) return json({ ...pending().quote, uncertainJobIds: [OLD_TAKE, TAKE] });
      if (input.endsWith("/authorize")) { authorizations.push(init!); return json({ quoteId: "quote-journal", budgetAuthorizationId: BUDGET }); }
      if (input.endsWith("/generate")) return json({ jobId: TAKE, workflowRunId: PLAN, reused: false }, 202);
      return fixture(input, init);
    });
    render(createElement(SpeechPanel, { projectId: PROJECT, shotRevisionId: SHOT, client }));
    fireEvent.click(await screen.findByRole("button", { name: "生成本句：先查看费用" }));
    expect(await screen.findByText(/发现 2 个历史待核实任务。新请求可能重复收费，旧预算仍占用/)).toBeTruthy();
    expect(screen.queryByText(TAKE)).toBeNull();
    fireEvent.click(screen.getByLabelText("确认第 1 句可能产生一次费用"));
    const generate = screen.getByRole("button", { name: "确认费用并生成本句" });
    expect(generate.hasAttribute("disabled")).toBe(true);
    expect(authorizations).toHaveLength(0);
    fireEvent.click(screen.getByLabelText("确认第 1 句历史待核实任务费用风险"));
    expect(generate.hasAttribute("disabled")).toBe(false);
    fireEvent.click(generate);
    expect(await screen.findByText("已受理，等待配音；完成后请试听并选用")).toBeTruthy();
    expect(JSON.parse(String(authorizations[0]?.body))).toMatchObject({ confirmedUncertainJobIds: [TAKE, OLD_TAKE] });
  });

  it("reads selected takes independently of candidate pagination and selects an exact checksum with CAS", async () => {
    let selected = false;
    const writes: RequestInit[] = [];
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const client = createSpeechClient(async (input, init) => {
      if (input.endsWith("/takes")) return json({ items: [CANDIDATE], selected: [{ ...SELECTION, takeAssetId: selected ? TAKE : OLD_TAKE }], hasMore: true, rowVersion: selected ? 4 : 3 });
      if (input.includes("/selections/")) { writes.push(init!); selected = true; return json({ rowVersion: 4, selection: { ...SELECTION, takeAssetId: TAKE } }); }
      return fixture(input, init);
    });
    render(createElement(SpeechPanel, { projectId: PROJECT, shotRevisionId: SHOT, client, characters: CHARACTERS }));
    fireEvent.click(await screen.findByRole("button", { name: "试听第 1 句已选配音" }));
    expect(screen.getByLabelText("配音试听播放器").getAttribute("src")).toBe(`/api/v1/assets/${OLD_TAKE}/content`);
    fireEvent.click(screen.getByRole("button", { name: "试听第 1 句候选 1" }));
    expect(screen.getByLabelText("配音试听播放器").getAttribute("src")).toBe(`/api/v1/assets/${TAKE}/content`);
    expect(document.querySelectorAll("audio").length).toBe(1);
    expect(play).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "使用第 1 句候选 1" }));
    expect(await screen.findByText(/已使用这一版/)).toBeTruthy();
    expect(writes[0]?.method).toBe("PUT");
    expect(writes[0]?.headers).toMatchObject({ "If-Match": "3", "Idempotency-Key": expect.any(String) });
    expect(JSON.parse(String(writes[0]?.body))).toEqual({ takeAssetId: TAKE, expectedTakeChecksumSha256: HASH });
    expect(screen.getByRole("button", { name: "使用第 1 句候选 1" }).hasAttribute("disabled")).toBe(true);
  });

  it("can reselect A after B with a new idempotency identity for the new CAS version", async () => {
    let selectedId: string | null = null;
    let version = 3;
    const writes: RequestInit[] = [];
    const client = createSpeechClient(async (input, init) => {
      if (input.endsWith("/takes")) return json({ items: [CANDIDATE, { ...CANDIDATE, assetId: OLD_TAKE }], selected: selectedId ? [{ ...SELECTION, takeAssetId: selectedId }] : [], hasMore: false, rowVersion: version });
      if (input.includes("/selections/")) {
        writes.push(init!);
        selectedId = (JSON.parse(String(init?.body)) as { takeAssetId: string }).takeAssetId;
        version += 1;
        return json({ rowVersion: version, selection: { ...SELECTION, takeAssetId: selectedId } });
      }
      return fixture(input, init);
    });
    render(createElement(SpeechPanel, { projectId: PROJECT, shotRevisionId: SHOT, client }));
    fireEvent.click(await screen.findByRole("button", { name: "使用第 1 句候选 1" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "使用第 1 句候选 1" }).hasAttribute("disabled")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "使用第 1 句候选 2" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "使用第 1 句候选 2" }).hasAttribute("disabled")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "使用第 1 句候选 1" }));
    await waitFor(() => expect(writes).toHaveLength(3));
    const headers = writes.map((request) => new Headers(request.headers));
    expect(headers.map((header) => header.get("If-Match"))).toEqual(["3", "4", "5"]);
    expect(headers[0]?.get("Idempotency-Key")).not.toBe(headers[2]?.get("Idempotency-Key"));
    expect(JSON.parse(String(writes[0]?.body))).toEqual(JSON.parse(String(writes[2]?.body)));
  });

  it("appends unique paginated candidates and refreshes independently selected state", async () => {
    const requests: string[] = [];
    const client = createSpeechClient(async (input, init) => {
      requests.push(input);
      if (input.endsWith(`/takes?cursor=${TAKE}`)) return json({ items: [CANDIDATE, { ...CANDIDATE, assetId: OLD_TAKE }], selected: [{ ...SELECTION, usable: false, durationMs: 1400 }], hasMore: false, nextCursor: null, rowVersion: 4 });
      if (input.endsWith("/takes")) return json({ items: [CANDIDATE], selected: [], hasMore: true, nextCursor: TAKE, rowVersion: 3 });
      return fixture(input, init);
    });
    render(createElement(SpeechPanel, { projectId: PROJECT, shotRevisionId: SHOT, client }));
    fireEvent.click(await screen.findByRole("button", { name: "加载更多候选" }));
    expect(await screen.findByRole("button", { name: "试听第 1 句候选 2" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "试听第 1 句候选 3" })).toBeNull();
    expect(screen.queryByRole("button", { name: "加载更多候选" })).toBeNull();
    expect(screen.getByText(/历史选用已失效，请重新确认 · 1.40 秒/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "试听第 1 句已选配音" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "使用第 1 句候选 2" }).hasAttribute("disabled")).toBe(false);
    expect(requests).toContain(`/api/v1/speech-plans/${PLAN}/takes?cursor=${TAKE}`);
  });

  it("aborts a page read and ignores its candidates after switching shots", async () => {
    const late = deferred();
    let pageSignal: AbortSignal | null | undefined;
    const client = createSpeechClient(async (input, init) => {
      if (input.includes("/takes?cursor=")) { pageSignal = init?.signal; return late.promise; }
      if (input.endsWith("/takes")) return json({ ...EMPTY, items: [CANDIDATE], hasMore: true, nextCursor: TAKE });
      return fixture(input, init);
    });
    const view = render(createElement(SpeechPanel, { projectId: PROJECT, shotRevisionId: SHOT, client }));
    fireEvent.click(await screen.findByRole("button", { name: "加载更多候选" }));
    await waitFor(() => expect(pageSignal).toBeTruthy());
    view.rerender(createElement(SpeechPanel, { projectId: PROJECT, shotRevisionId: SHOT_B, client }));
    expect(pageSignal?.aborted).toBe(true);
    late.resolve(json({ ...EMPTY, items: [{ ...CANDIDATE, assetId: OLD_TAKE }], nextCursor: null }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "试听第 1 句候选 2" })).toBeNull());
  });

  it("keeps historical audition available while marking an invalid selection", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const client = createSpeechClient(async (input, init) => input.endsWith("/takes")
      ? json({ ...EMPTY, selected: [{ ...SELECTION, usable: false }] }) : fixture(input, init));
    render(createElement(SpeechPanel, { projectId: PROJECT, shotRevisionId: SHOT, client }));
    expect(await screen.findByText("历史选用已失效，请重新确认")).toBeTruthy();
    expect(screen.queryByText("已选用此句配音")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "试听第 1 句已选配音" }));
    expect(screen.getByLabelText("配音试听播放器").getAttribute("src")).toBe(`/api/v1/assets/${OLD_TAKE}/content`);
  });

  it("saves faithful source spans and presents voice replacement impact before writing", async () => {
    const writes: Array<{ input: string; init?: RequestInit }> = [];
    const client = createSpeechClient(async (input, init) => {
      if (input.endsWith("/impact")) return json({ inputHash: HASH, affectedLines: 2, affectedShots: 1, affectedAssets: 3 });
      if (input.includes("voice-bindings/") && init?.method === "PUT") { writes.push({ input, init }); return json(BINDING); }
      if (input.endsWith("speech-plan") && init?.method === "GET") return json({ ...PLAN_DATA, currentRevision: null });
      if (input.endsWith("speech-plan") && init?.method === "PUT") { writes.push({ input, init }); return json(PLAN_DATA); }
      return fixture(input, init);
    });
    render(createElement(SpeechPanel, { projectId: PROJECT, shotRevisionId: SHOT, client, characters: CHARACTERS }));
    fireEvent.change(await screen.findByLabelText("林夏的声音"), { target: { value: "calm" } });
    fireEvent.click(screen.getByRole("button", { name: "查看换声影响" }));
    expect(await screen.findByText(/影响 2 句台词、1 个镜头、3 个下游作品/)).toBeTruthy();
    expect(writes.length).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "确认更换声音" }));
    await waitFor(() => expect(writes.length).toBe(1));
    expect(JSON.parse(String(writes[0]?.init?.body))).toEqual({ catalogVersion: "catalog-v1", catalogVoiceId: "calm", expectedImpactHash: HASH });
    fireEvent.click(await screen.findByRole("button", { name: "按原文建立待确认草稿" }));
    expect(screen.getByLabelText("第 1 句台词").textContent).toBe("这不是我。");
    fireEvent.click(screen.getByRole("button", { name: "保存并确认台词计划" }));
    await waitFor(() => expect(writes.length).toBe(2));
    const body = JSON.parse(String(writes[1]?.init?.body));
    expect(body.lines[0]).toMatchObject({ sourceStart: 3, sourceEnd: 8, displayText: "这不是我。", speakerBindingRevisionId: VOICE });
    expect(body.lines[0].inputHash).toBeUndefined();
    expect(writes[1]?.init?.headers).toMatchObject({ "If-Match": "3" });
  });

  it("discards delayed reads across A → B → A and aborts the old read", async () => {
    const late = deferred();
    let aReads = 0;
    let oldSignal: AbortSignal | null | undefined;
    const client = createSpeechClient(async (input, init) => {
      if (input.includes(SHOT) && input.endsWith("speech-plan") && ++aReads === 1) { oldSignal = init?.signal; return late.promise; }
      if (input.includes(SHOT_B) && input.endsWith("speech-plan")) return json({ ...PLAN_DATA, shotRevisionId: SHOT_B, sourceDialogue: "新镜头" });
      return fixture(input, init);
    });
    const view = render(createElement(SpeechPanel, { projectId: PROJECT, shotRevisionId: SHOT, client }));
    await waitFor(() => expect(aReads).toBe(1));
    view.rerender(createElement(SpeechPanel, { projectId: PROJECT, shotRevisionId: SHOT_B, client }));
    view.rerender(createElement(SpeechPanel, { projectId: PROJECT, shotRevisionId: SHOT, client }));
    expect(await screen.findByLabelText("已保存的对白原文")).toBeTruthy();
    expect(oldSignal?.aborted).toBe(true);
    late.resolve(json({ ...PLAN_DATA, sourceDialogue: "不应出现的旧回执" }));
    await waitFor(() => expect(screen.queryByText("不应出现的旧回执")).toBeNull());
    expect(screen.getByLabelText("已保存的对白原文").textContent).toBe("林夏：这不是我。");
  });

  it("shows actual sentence subtitles from preflight and clears them when the plan changes", async () => {
    const preflight = { inputHash: HASH, manifest: { totalSpeechMs: 1200, videoDurationMs: 2000,
      subtitles: { cues: [{ lineId: LINE, startMs: 0, endMs: 1200, text: "这不是我。" }] } },
      subtitleVtt: "WEBVTT\n\n00:00:00.000 --> 00:00:01.200\n这不是我。\n", guards: { planRowVersion: 3, assets: [] } } as unknown as SpeechMixPreflight;
    const result = vi.fn();
    const client = createSpeechClient(async (input, init) => input.endsWith("mix-preflight") ? json(preflight) : fixture(input, init));
    render(createElement(SpeechPanel, { projectId: PROJECT, shotRevisionId: SHOT, client, videoAssetId: VIDEO, onPreflight: result }));
    fireEvent.click(await screen.findByRole("button", { name: "检查声音与字幕" }));
    expect(await screen.findByText(/预检通过 · 配音 1.20 秒 · 视频 2.00 秒/)).toBeTruthy();
    expect(screen.getByText(/00:00:00.000 --> 00:00:01.200/)).toBeTruthy();
    expect(result).toHaveBeenCalledWith(preflight);
    fireEvent.change(screen.getByLabelText("第 1 句句后停顿"), { target: { value: "300" } });
    expect(screen.queryByText(/预检通过/)).toBeNull();
    expect(screen.getByRole("button", { name: "检查声音与字幕" }).hasAttribute("disabled")).toBe(true);
    expect(result).toHaveBeenLastCalledWith(null);
  });

  it("discards a preflight response for the previous video and reports measured overflow", async () => {
    const late = deferred();
    let calls = 0;
    const result = vi.fn();
    const client = createSpeechClient(async (input, init) => {
      if (input.endsWith("mix-preflight")) {
        calls += 1;
        if (calls === 1) return late.promise;
        return json({ error: { code: "SPEECH_AUDIO_OVERFLOW", message: "配音超过画面时长。", details: { overflowMs: 1250 } } }, 422);
      }
      return fixture(input, init);
    });
    const props = { projectId: PROJECT, shotRevisionId: SHOT, client, videoAssetId: VIDEO, onPreflight: result };
    const view = render(createElement(SpeechPanel, props));
    fireEvent.click(await screen.findByRole("button", { name: "检查声音与字幕" }));
    view.rerender(createElement(SpeechPanel, { ...props, videoAssetId: OLD_TAKE }));
    late.resolve(json({ inputHash: HASH, manifest: { totalSpeechMs: 1200, videoDurationMs: 2000, subtitles: { cues: [] } }, subtitleVtt: "WEBVTT", guards: { planRowVersion: 3, assets: [] } }));
    await waitFor(() => expect(screen.getByRole("button", { name: "检查声音与字幕" }).hasAttribute("disabled")).toBe(false));
    expect(screen.queryByText(/预检通过/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "检查声音与字幕" }));
    expect(await screen.findByText(/实际超出 1.25 秒/)).toBeTruthy();
    expect(result.mock.calls.every(([value]) => value === null)).toBe(true);
  });

  it("invalidates a late preflight when music changes and requests a new server manifest with the new music", async () => {
    const late = deferred();
    const requests: Array<{ musicAssetId: string | null }> = [];
    const result = vi.fn();
    const preflight = { inputHash: HASH, manifest: { totalSpeechMs: 1200, videoDurationMs: 2000, subtitles: { cues: [] } }, subtitleVtt: "WEBVTT", guards: { planRowVersion: 3, assets: [] } };
    const client = createSpeechClient(async (input, init) => {
      if (input.endsWith("mix-preflight")) {
        requests.push(JSON.parse(String(init?.body)) as { musicAssetId: string | null });
        return requests.length === 1 ? late.promise : json(preflight);
      }
      return fixture(input, init);
    });
    const props = { projectId: PROJECT, shotRevisionId: SHOT, client, videoAssetId: VIDEO, musicAssetId: TAKE, onPreflight: result };
    const view = render(createElement(SpeechPanel, props));
    fireEvent.click(await screen.findByRole("button", { name: "检查声音与字幕" }));
    expect(requests[0]?.musicAssetId).toBe(TAKE);
    view.rerender(createElement(SpeechPanel, { ...props, musicAssetId: OLD_TAKE }));
    late.resolve(json(preflight));
    await waitFor(() => expect(screen.getByRole("button", { name: "检查声音与字幕" }).hasAttribute("disabled")).toBe(false));
    expect(screen.queryByText(/预检通过/)).toBeNull();
    expect(result.mock.calls.every(([value]) => value === null)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "检查声音与字幕" }));
    expect(await screen.findByText(/预检通过/)).toBeTruthy();
    expect(requests[1]?.musicAssetId).toBe(OLD_TAKE);
    expect(result).toHaveBeenLastCalledWith(preflight);
  });
});

describe("source span drafts", () => {
  it("uses exact UTF-16 positions, strips only a matching speaker prefix, and leaves unknown speakers unassigned", () => {
    const source = "  林夏：你好😀。\n不明角色：第二句。";
    const draft = createSpeechDraft(source, CHARACTERS, [BINDING]);
    expect(draft[0]).toMatchObject({ speakerBindingRevisionId: VOICE, displayText: "你好😀。" });
    expect(source.slice(draft[0]!.sourceStart, draft[0]!.sourceEnd)).toBe(draft[0]!.displayText);
    expect(draft[1]).toMatchObject({ speakerBindingRevisionId: "", displayText: "不明角色：第二句。" });
  });

  it("uses only the selected voice's supported default performance parameters", () => {
    const binding = { ...BINDING, currentRevision: { ...VOICE_DATA, capabilities: { emotions: ["calm"], speedMin: 1.1, speedMax: 1.3 } } };
    expect(createSpeechDraft("林夏：你好。", CHARACTERS, [binding])[0]).toMatchObject({ emotion: "calm", speed: 1.1 });
  });
});

describe("durable speech request journal", () => {
  it("keeps project and shot scopes separate and prevents late writes or acknowledgements from removing a new identity", () => {
    const original = pending();
    const otherShot = pending({ shotRevisionId: SHOT_B, key: "other-shot-key" });
    writeSpeechPending(original);
    writeSpeechPending(otherShot);
    expect(readSpeechPending(PROJECT, SHOT)?.key).toBe(original.key);
    expect(readSpeechPending(PROJECT, SHOT_B)?.key).toBe(otherShot.key);
    expect(clearSpeechPending(original)).toBe(true);
    const newer = pending({ key: "new-permanent-key", quote: { ...original.quote, quoteId: "new-quote" } });
    writeSpeechPending(newer);
    expect(() => writeSpeechPending(original)).toThrow(SpeechJournalError);
    expect(clearSpeechPending(original)).toBe(false);
    expect(readSpeechPending(PROJECT, SHOT)?.key).toBe(newer.key);
    expect(readSpeechPending(PROJECT, SHOT_B)?.key).toBe(otherShot.key);
  });

  it("never rolls back a known authorization or acknowledged Job", () => {
    const initial = pending();
    const authorized = { ...initial, authorizationId: BUDGET };
    writeSpeechPending(initial);
    writeSpeechPending(authorized);
    expect(() => writeSpeechPending(initial)).toThrow(SpeechJournalError);
    const acknowledged = { ...authorized, jobId: TAKE, unknown: false };
    writeSpeechPending(acknowledged);
    expect(() => writeSpeechPending(authorized)).toThrow(SpeechJournalError);
    expect(clearSpeechPending(authorized)).toBe(false);
    expect(readSpeechPending(PROJECT, SHOT)?.jobId).toBe(TAKE);
    expect(clearSpeechPending(acknowledged)).toBe(true);
  });
});
