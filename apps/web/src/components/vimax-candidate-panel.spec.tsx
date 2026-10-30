// @vitest-environment happy-dom
// Synthetic component tests with a local client double; no API, database, provider or migration is started.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VIMAX_CANDIDATE_CREATE_SCHEMA, type VimaxCandidatePage, type VimaxCandidateView } from "@ai-drama/contracts";
import { VimaxCandidateError } from "../lib/vimax-candidate-client";
import { readVimaxCandidatePending, writeVimaxCandidatePending, type VimaxCandidatePending } from "../lib/vimax-candidate-pending";
import { vimaxCandidateFixture } from "../lib/vimax-candidate-test-fixtures";
import { VimaxCandidatePanel, type VimaxCandidatePanelProps } from "./vimax-candidate-panel";

afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.restoreAllMocks(); });
const checkName = "我已人工核对原文、角色、对白与目标场景";
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { resolve, promise }; }
function harness(initial?: VimaxCandidateView) {
  const f = vimaxCandidateFixture();
  let current = initial ?? f.stored;
  const client = {
    list: vi.fn(async () => ({ ...f.page, items: [current] })),
    targets: vi.fn(async () => f.targets), get: vi.fn(async () => current),
    create: vi.fn(async (_p: string, _e: string, _body: unknown, key: string, _signal?: AbortSignal) => {
      current = { ...f.stored, requestKey: key }; return { schema: "ads.vimax-candidate.create-response.v1" as const, replayed: false, candidate: current };
    }),
    saveScene: vi.fn(async (_p: string, _e: string, _id: string, _body: unknown, key: string, _signal?: AbortSignal, _expected?: VimaxCandidateView) => {
      current = { ...f.sceneSaved, sceneReceipt: { ...f.sceneReceipt, idempotencyKey: key } };
      return { schema: "ads.vimax-candidate.write-response.v1" as const, replayed: false, receipt: current.sceneReceipt! };
    }),
    placeShots: vi.fn(async (_p: string, _e: string, _id: string, _body: unknown, key: string, _signal?: AbortSignal, _expected?: VimaxCandidateView) => {
      current = { ...f.shotsSaved, shotsReceipt: { ...f.shotsReceipt, idempotencyKey: key } };
      return { schema: "ads.vimax-candidate.write-response.v1" as const, replayed: false, receipt: current.shotsReceipt! };
    }),
  };
  const props: VimaxCandidatePanelProps = {
    projectId: f.source.projectId, episodeId: f.source.episodeId, scriptReady: true, refreshEpoch: 0,
    preview: { request: f.request, response: f.previewResponse }, client, onChanged: vi.fn(), onOpenScene: vi.fn(),
  };
  return { ...f, client, props, setCurrent: (value: VimaxCandidateView) => { current = value; } };
}
async function open() { fireEvent.click(screen.getByRole("button", { name: "保存与审核分镜候选" })); await screen.findByRole("article", { name: "当前候选" }); }
function confirm() { fireEvent.click(screen.getByLabelText(checkName)); }
async function selectTarget(id: string) { await waitFor(() => expect(screen.getByRole("option", { name: /第 1 场/ })).toBeTruthy()); fireEvent.change(screen.getByLabelText("目标场景"), { target: { value: id } }); }
function button(name: string) { return screen.getByRole("button", { name }) as HTMLButtonElement; }

describe("saved ViMax candidates preserve review and request identity", () => {
  it("is collapsed and reads neither history nor targets until opened", () => {
    const h = harness(); render(<VimaxCandidatePanel {...h.props} />);
    expect(h.client.list).not.toHaveBeenCalled(); expect(h.client.targets).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "保存候选" })).toBeNull();
  });
  it("retrieves persisted history without reimporting a plan", async () => {
    const h = harness(); render(<VimaxCandidatePanel {...h.props} preview={null} />); await open();
    expect(h.client.list).toHaveBeenCalledOnce(); expect(h.client.targets).not.toHaveBeenCalled();
    expect(screen.getByText(/已有候选无需重新导入/)).toBeTruthy();
    const card = screen.getByRole("article", { name: "当前候选" });
    expect(within(card).getByText(/候选已保存；场景和镜头的审核状态/)).toBeTruthy();
    expect(within(card).queryByText(/尚未保存或批准/)).toBeNull();
    expect(within(card).getByRole("article", { name: "镜头 1" })).toBeTruthy();
  });
  it("persists the exact create request before sending and saves only after review and target selection", async () => {
    const h = harness(); const original = h.client.create.getMockImplementation()!;
    h.client.create.mockImplementation(async (p, e, body, key) => {
      expect(readVimaxCandidatePending(p, e)).toEqual({ kind: "create", key, body });
      return original(p, e, body, key);
    });
    render(<VimaxCandidatePanel {...h.props} />); await open();
    expect(button("保存候选").disabled).toBe(true); await selectTarget(h.target.sceneId);
    expect(button("保存候选").disabled).toBe(true); confirm(); fireEvent.click(button("保存候选"));
    await screen.findByText(/候选已保存，可刷新找回/);
    expect(h.client.create).toHaveBeenCalledOnce();
    expect(h.client.create.mock.calls[0]![2]).toEqual(h.create);
    expect(readVimaxCandidatePending(h.source.projectId, h.source.episodeId)).toBeNull();
    expect(h.client.saveScene).not.toHaveBeenCalled(); expect(h.client.placeShots).not.toHaveBeenCalled();
  });
  it("never offers a mismatched or occupied target", async () => {
    const h = harness(); h.client.targets.mockResolvedValue({ ...h.targets, targets: [
      { ...h.targets.targets[0]!, ordinal: 2 },
      { ...h.targets.targets[0]!, sceneId: "a0000000-0000-4000-8000-000000000099", activeShotCount: 1, eligible: false, reasons: ["target_has_shots"] },
    ] });
    render(<VimaxCandidatePanel {...h.props} />); await open();
    await screen.findByText(/没有可用的匹配空场景/);
    expect(button("保存候选").disabled).toBe(true); expect(h.client.create).not.toHaveBeenCalled();
  });
  it("writes a scene draft only, then routes approval through the existing scene editor", async () => {
    const h = harness(); render(<VimaxCandidatePanel {...h.props} preview={null} />); await open();
    expect(button("保存场景草稿").disabled).toBe(true); confirm(); fireEvent.click(button("保存场景草稿"));
    await screen.findByText(/场景草稿已保存。请打开场景页审核/);
    expect(h.client.saveScene.mock.calls[0]![3]).toMatchObject({ expectedVersion: 1, confirmedReview: true });
    expect(h.client.placeShots).not.toHaveBeenCalled();
    fireEvent.click(button("打开场景审核")); expect(h.props.onOpenScene).toHaveBeenCalledWith(h.target.sceneId);
    expect(button("写入镜头草稿").disabled).toBe(true);
  });
  it("requires the saved scene's exact approval while allowing its review row version to advance", async () => {
    const f = vimaxCandidateFixture(); const h = harness(f.approved);
    render(<VimaxCandidatePanel {...h.props} preview={null} />); await open(); confirm();
    expect(button("写入镜头草稿").disabled).toBe(false); fireEvent.click(button("写入镜头草稿"));
    await screen.findByText(/镜头草稿已写入，请在现有镜头页/);
    expect(h.client.placeShots.mock.calls[0]![3]).toMatchObject({ expectedVersion: 2, confirmedReview: true });
    expect(h.client.placeShots.mock.calls[0]![6]).toEqual(f.approved);
    expect(h.props.onChanged).toHaveBeenCalledOnce();
  });
  it("shows source and manual-shot blockers without allowing writes", async () => {
    const f = vimaxCandidateFixture(); const blocked = { ...f.approved, eligibility: { ...f.approved.eligibility,
      canPlaceShots: false, reasons: ["source_changed", "target_has_shots"] as const } };
    const h = harness(blocked as unknown as VimaxCandidateView);
    render(<VimaxCandidatePanel {...h.props} preview={null} />); await open(); confirm();
    expect(screen.getByText(/目标场景已有镜头/)).toBeTruthy(); expect(button("写入镜头草稿").disabled).toBe(true);
    expect(h.client.placeShots).not.toHaveBeenCalled();
  });
  it("retains unknown create identity after refresh and replays it despite a later unapproved source", async () => {
    const h = harness(); h.client.create.mockRejectedValueOnce(new TypeError("disconnected"));
    const mounted = render(<VimaxCandidatePanel {...h.props} />); await open(); await selectTarget(h.target.sceneId); confirm();
    fireEvent.click(button("保存候选")); await screen.findByText(/上次保存结果尚未确认/);
    const original = readVimaxCandidatePending(h.source.projectId, h.source.episodeId)!;
    mounted.unmount(); render(<VimaxCandidatePanel {...h.props} scriptReady={false} preview={null} />); await open();
    expect(button("确认上次保存结果").disabled).toBe(false); fireEvent.click(button("确认上次保存结果"));
    await screen.findByText(/候选已保存，可刷新找回/);
    expect(h.client.create.mock.calls).toHaveLength(2);
    expect(h.client.create.mock.calls[1]![2]).toEqual(original.body); expect(h.client.create.mock.calls[1]![3]).toBe(original.key);
  });
  it("replays a saved operation with its old body even when live eligibility is now false", async () => {
    const f = vimaxCandidateFixture(); const h = harness(f.shotsSaved);
    const pending: VimaxCandidatePending = { kind: "save_scene", key: f.sceneKey, candidateId: f.candidateId,
      body: { schema: "ads.vimax-candidate.save-scene.v1", expectedVersion: 1, confirmedReview: true } };
    writeVimaxCandidatePending(f.source.projectId, f.source.episodeId, pending);
    render(<VimaxCandidatePanel {...h.props} scriptReady={false} preview={null} />); await open();
    fireEvent.click(button("确认上次保存结果"));
    await screen.findByText(/场景草稿已保存。请打开场景页审核/);
    expect(h.client.get).toHaveBeenCalledWith(f.source.projectId, f.source.episodeId, f.candidateId, expect.any(AbortSignal));
    expect(h.client.saveScene.mock.calls[0]![3]).toEqual(pending.body); expect(h.client.saveScene.mock.calls[0]![4]).toBe(pending.key);
  });
  it("does not send if session storage cannot preserve the request", async () => {
    const h = harness(); render(<VimaxCandidatePanel {...h.props} />); await open(); await selectTarget(h.target.sceneId); confirm();
    const storage = vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => { throw new Error("quota"); });
    fireEvent.click(button("保存候选")); await screen.findByText(/无法保留完整原请求，尚未发送/);
    expect(h.client.create).not.toHaveBeenCalled();
    storage.mockRestore();
  });
  it("does not silently clear a definite refusal, and allows an explicit end before a fresh action", async () => {
    const h = harness(); h.client.create.mockRejectedValueOnce(new VimaxCandidateError(409, "VIMAX_CANDIDATE_SOURCE_CHANGED", "来源已变化"));
    render(<VimaxCandidatePanel {...h.props} />); await open(); await selectTarget(h.target.sceneId); confirm(); fireEvent.click(button("保存候选"));
    await screen.findByText(/此请求已明确拒绝/);
    expect(readVimaxCandidatePending(h.source.projectId, h.source.episodeId)).not.toBeNull();
    fireEvent.click(button("结束这个已拒绝请求"));
    await waitFor(() => expect(readVimaxCandidatePending(h.source.projectId, h.source.episodeId)).toBeNull());
  });
  it.each([401, 403, 500, 200])("keeps the exact request on %i or an unconfirmed receipt", async (status) => {
    const h = harness(); h.client.create.mockRejectedValueOnce(new VimaxCandidateError(status, "UNCONFIRMED", "结果尚未确认"));
    render(<VimaxCandidatePanel {...h.props} />); await open(); await selectTarget(h.target.sceneId); confirm(); fireEvent.click(button("保存候选"));
    await screen.findByText("结果尚未确认");
    expect(readVimaxCandidatePending(h.source.projectId, h.source.episodeId)?.kind).toBe("create");
    expect(screen.queryByRole("button", { name: "结束这个已拒绝请求" })).toBeNull();
  });
  it("marks cached eligibility stale after a refresh and never revives it after false then true approval", async () => {
    const h = harness(); const mounted = render(<VimaxCandidatePanel {...h.props} preview={null} />); await open(); confirm();
    expect(button("保存场景草稿").disabled).toBe(false);
    mounted.rerender(<VimaxCandidatePanel {...h.props} preview={null} scriptReady={false} />);
    mounted.rerender(<VimaxCandidatePanel {...h.props} preview={null} />); confirm();
    expect(button("保存场景草稿").disabled).toBe(true); expect(screen.getByText(/以下是此前读取的候选/)).toBeTruthy();
    fireEvent.click(button("重新读取候选与目标")); await waitFor(() => expect(screen.queryByText(/以下是此前读取的候选/)).toBeNull());
    confirm(); expect(button("保存场景草稿").disabled).toBe(false);
    mounted.rerender(<VimaxCandidatePanel {...h.props} preview={null} refreshEpoch={1} />);
    expect(button("保存场景草稿").disabled).toBe(true);
  });
  it("drops a history response that arrives after switching episodes", async () => {
    const h = harness(); const slow = deferred<VimaxCandidatePage>(); h.client.list.mockReturnValueOnce(slow.promise);
    const mounted = render(<VimaxCandidatePanel {...h.props} preview={null} />);
    fireEvent.click(button("保存与审核分镜候选"));
    mounted.rerender(<VimaxCandidatePanel {...h.props} episodeId="d0000000-0000-4000-8000-000000000001" preview={null} />);
    slow.resolve(h.page); await waitFor(() => expect(screen.queryByRole("article", { name: "当前候选" })).toBeNull());
  });
  it("does not keep earlier write eligibility when a fresh read fails", async () => {
    const h = harness(); render(<VimaxCandidatePanel {...h.props} preview={null} />); await open(); confirm();
    expect(button("保存场景草稿").disabled).toBe(false);
    h.client.list.mockRejectedValueOnce(new VimaxCandidateError(503, "UNAVAILABLE", "重新读取失败"));
    fireEvent.click(button("重新读取候选与目标")); await screen.findByText("重新读取失败"); confirm();
    expect(button("保存场景草稿").disabled).toBe(true);
    expect(h.client.saveScene).not.toHaveBeenCalled();
  });
  it("does not describe a confirmed save as unknown when the parent refresh fails", async () => {
    const h = harness(); h.props.onChanged = vi.fn(async () => { throw new Error("refresh failed"); });
    render(<VimaxCandidatePanel {...h.props} preview={null} />); await open(); confirm(); fireEvent.click(button("保存场景草稿"));
    await screen.findByText("保存已确认，更新页面状态暂时失败。");
    expect(readVimaxCandidatePending(h.source.projectId, h.source.episodeId)).toBeNull();
    expect(h.client.saveScene).toHaveBeenCalledOnce();
  });
  it("discards a late read after folding the history panel", async () => {
    const h = harness(); const slow = deferred<VimaxCandidatePage>(); h.client.list.mockReturnValueOnce(slow.promise);
    render(<VimaxCandidatePanel {...h.props} preview={null} />); fireEvent.click(button("保存与审核分镜候选"));
    fireEvent.click(button("保存与审核分镜候选")); slow.resolve(h.page);
    await waitFor(() => expect(screen.queryByRole("article", { name: "当前候选" })).toBeNull());
    await open(); expect(screen.getByRole("article", { name: "当前候选" })).toBeTruthy();
  });
  it("loads another page without replacing or duplicating earlier candidates", async () => {
    const h = harness();
    const second = { ...h.stored, candidateId: "e0000000-0000-4000-8000-000000000001", requestKey: h.sceneKey };
    h.client.list.mockResolvedValueOnce({ ...h.page, nextCursor: "next-page" })
      .mockResolvedValueOnce({ ...h.page, items: [h.stored, second], nextCursor: null });
    render(<VimaxCandidatePanel {...h.props} preview={null} />); await open(); fireEvent.click(button("加载更多候选"));
    await waitFor(() => expect(within(screen.getByLabelText("已保存候选列表")).getAllByRole("button")).toHaveLength(2));
    expect(h.client.list.mock.calls[1]).toEqual([h.source.projectId, h.source.episodeId, { limit: 10, cursor: "next-page" }, expect.any(AbortSignal)]);
  });
  it("keeps a newer request when an older write receipt arrives late", async () => {
    const h = harness(); const slow = deferred<Awaited<ReturnType<typeof h.client.create>>>(); h.client.create.mockReturnValueOnce(slow.promise);
    render(<VimaxCandidatePanel {...h.props} />); await open(); await selectTarget(h.target.sceneId); confirm(); fireEvent.click(button("保存候选"));
    await waitFor(() => expect(h.client.create).toHaveBeenCalledOnce());
    const key = h.client.create.mock.calls[0]![3];
    const newer: VimaxCandidatePending = { kind: "create", key: h.shotsKey, body: { ...h.create, schema: VIMAX_CANDIDATE_CREATE_SCHEMA } };
    window.sessionStorage.setItem(`ads:vimax-candidate:${h.source.projectId}:${h.source.episodeId}:v1`, JSON.stringify(newer));
    slow.resolve({ schema: "ads.vimax-candidate.create-response.v1", replayed: false, candidate: { ...h.stored, requestKey: key } });
    await waitFor(() => expect(readVimaxCandidatePending(h.source.projectId, h.source.episodeId)?.key).toBe(newer.key));
    expect(button("确认上次保存结果")).toBeTruthy();
  });
});
