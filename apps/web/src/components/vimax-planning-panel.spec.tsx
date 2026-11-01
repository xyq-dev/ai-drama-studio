// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VimaxPlanningStart, VimaxPlanningView } from "@ai-drama/contracts";
import { VimaxPlanningError } from "../lib/vimax-planning-client";
import { vimaxPlanningFixture } from "../lib/vimax-planning-test-fixtures";
import { VimaxPlanningPanel, type VimaxPlanningPanelProps } from "./vimax-planning-panel";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); vi.restoreAllMocks(); });
function setup(initial?: VimaxPlanningView) {
  const f = vimaxPlanningFixture(); let current = initial;
  const client = {
    options: vi.fn(async () => f.options), list: vi.fn(async () => ({ schema: "ads.vimax-planning.page.v1" as const, items: current ? [current] : [] })),
    get: vi.fn(async () => ({ schema: "ads.vimax-planning.response.v1" as const, replayed: false, request: current ?? f.view })),
    start: vi.fn(async (_p: string, _e: string, body: VimaxPlanningStart, key: string) => {
      current = { ...f.view, requestKey: key, input: { ...f.view.input, request: body } };
      return { schema: "ads.vimax-planning.response.v1" as const, replayed: false, request: current };
    }),
    cancel: vi.fn(async () => ({ schema: "ads.vimax-planning.response.v1" as const, replayed: false,
      request: { ...f.view, state: "rejected" as const, errorCode: "canceled_before_send", finishedAt: "2026-11-01T00:00:01.000Z" } })),
  };
  const props: VimaxPlanningPanelProps = { projectId: f.source.projectId, episodeId: f.source.episodeId, draftRequest: f.body,
    onCandidate: vi.fn(), client };
  const storageKey = `ads.vimax-planning.pending.v1:${props.projectId}:${props.episodeId}`;
  return { ...f, client, props, storageKey };
}
async function open() { fireEvent.click(screen.getByRole("button", { name: "在线单场景规划" })); await screen.findByText(/最近 24 小时共享额度/); }
const confirm = () => fireEvent.click(screen.getByLabelText("我确认发送当前单场景文本，接受一次规划费用未知"));
const start = () => fireEvent.click(screen.getByRole("button", { name: "预约并生成分镜规划" }));
describe("ViMax planning panel explicit sends and recovery", () => {
  it("stays collapsed without requests and displays reservation accounting when opened", async () => {
    const h = setup(); render(<VimaxPlanningPanel {...h.props} />); expect(h.client.options).not.toHaveBeenCalled(); await open();
    expect(screen.getByText(/预约占用 24 小时名额，记录不代表实际发送或收费/)).toBeTruthy(); expect(h.client.start).not.toHaveBeenCalled();
  });
  it("saves exact identity before a confirmed send and clears it only for its matching receipt", async () => {
    const h = setup(); const original = h.client.start.getMockImplementation()!;
    h.client.start.mockImplementation(async (p, e, body, key) => {
      expect(JSON.parse(sessionStorage.getItem(h.storageKey)!)).toEqual({ key, body }); return original(p, e, body, key);
    });
    render(<VimaxPlanningPanel {...h.props} />); await open(); start(); expect(h.client.start).not.toHaveBeenCalled();
    confirm(); start(); await screen.findByText(/原请求回执已确认/); expect(h.client.start).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(h.storageKey)).toBeNull(); expect(h.props.onCandidate).not.toHaveBeenCalled();
  });
  it("retains unknown HTTP outcomes across refresh and replays the stored body despite changed draft props", async () => {
    const h = setup(); h.client.start.mockRejectedValueOnce(new VimaxPlanningError(503, "unavailable", "结果未知"));
    const first = render(<VimaxPlanningPanel {...h.props} />); await open(); confirm(); start(); await screen.findByText("结果未知");
    const pending = JSON.parse(sessionStorage.getItem(h.storageKey)!) as { key: string; body: VimaxPlanningStart }; first.unmount();
    render(<VimaxPlanningPanel {...h.props} draftRequest={{ ...h.body, requirements: { ...h.body.requirements, style: "new draft" } }} />); await open();
    expect(h.client.start).toHaveBeenCalledOnce(); fireEvent.click(screen.getByRole("button", { name: "确认原规划请求" }));
    await screen.findByText(/原请求回执已确认/); expect(h.client.start.mock.calls[1]!.slice(2, 4)).toEqual([pending.body, pending.key]);
  });
  it("requires acknowledgement of the specific unknown request before allocating a new key", async () => {
    const h = setup(); h.client.list.mockResolvedValue({ schema: "ads.vimax-planning.page.v1", items: [h.unknown] });
    render(<VimaxPlanningPanel {...h.props} />); await open(); confirm(); start(); expect(h.client.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(new RegExp(`我已知晓请求 ${h.unknown.requestId}`))); start();
    await waitFor(() => expect(h.client.start).toHaveBeenCalledOnce()); expect(h.client.start.mock.calls[0]![2].confirmUncertainRequestId).toBe(h.unknown.requestId);
  });
  it("refuses to send when request identity cannot be persisted", async () => {
    const h = setup(); render(<VimaxPlanningPanel {...h.props} />); await open();
    const originalStorage = sessionStorage;
    vi.stubGlobal("sessionStorage", { getItem: originalStorage.getItem.bind(originalStorage),
      setItem: () => { throw new Error("denied"); }, removeItem: originalStorage.removeItem.bind(originalStorage) });
    confirm(); start();
    await screen.findByText(/无法保存原请求身份/); expect(h.client.start).not.toHaveBeenCalled();
  });
  it("a late receipt preserves a newer stored identity and prevents another new send", async () => {
    const h = setup(); let resolve!: (value: Awaited<ReturnType<typeof h.client.start>>) => void;
    h.client.start.mockImplementationOnce(async () => new Promise((done) => { resolve = done; }));
    render(<VimaxPlanningPanel {...h.props} />); await open(); confirm(); start();
    await waitFor(() => expect(h.client.start).toHaveBeenCalledOnce());
    const original = JSON.parse(sessionStorage.getItem(h.storageKey)!) as { key: string; body: VimaxPlanningStart };
    const newer = { key: "newer-original-key", body: { ...h.body, requirements: { ...h.body.requirements, style: "newer frozen request" } } };
    sessionStorage.setItem(h.storageKey, JSON.stringify(newer));
    resolve({ schema: "ads.vimax-planning.response.v1", replayed: false,
      request: { ...h.view, requestKey: original.key, input: { ...h.view.input, request: original.body } } });
    await screen.findByText(/原请求回执已确认/);
    expect(JSON.parse(sessionStorage.getItem(h.storageKey)!)).toEqual(newer);
    expect(screen.getByRole("button", { name: "确认原规划请求" })).toBeTruthy();
    confirm(); start(); expect(h.client.start).toHaveBeenCalledOnce();
  });
  it("only explicitly imports a completed candidate without saving or approving", async () => {
    const h = setup(); h.client.list.mockResolvedValue({ schema: "ads.vimax-planning.page.v1", items: [h.completed] });
    render(<VimaxPlanningPanel {...h.props} />); await open(); expect(h.props.onCandidate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "导入候选供人工核对" })); expect(h.props.onCandidate).toHaveBeenCalledWith(h.create); expect(h.client.start).not.toHaveBeenCalled();
  });
});
