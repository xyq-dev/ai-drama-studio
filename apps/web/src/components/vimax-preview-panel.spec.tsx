// @vitest-environment happy-dom
// Interface tests use synthetic source data and a stub client; no API, database or model is started.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VIMAX_PLATFORM_PREVIEW_MAX_BYTES, vimaxPlatformPreviewResponseSchema, type VimaxPlatformSourceSnapshot } from "@ai-drama/contracts";
import { VimaxPreviewError } from "../lib/vimax-preview-client";
import { vimaxPreviewFixture } from "../lib/vimax-preview-test-fixtures";
import { VimaxPreviewPanel, type VimaxPreviewPanelProps } from "./vimax-preview-panel";

afterEach(cleanup);

function harness() {
  const fixture = vimaxPreviewFixture();
  const client = { source: vi.fn(async () => fixture.source), preview: vi.fn(async () => fixture.response) };
  const props: VimaxPreviewPanelProps = { projectId: fixture.source.projectId, episodeId: fixture.source.episodeId, scriptReady: true, refreshEpoch: 0, client };
  return { ...fixture, client, props };
}
async function expand() {
  fireEvent.click(screen.getByRole("button", { name: "单场景分镜预览" }));
  await screen.findByText(/当前来源：第 1 集/);
}
function paste(value: unknown) {
  fireEvent.change(screen.getByLabelText("或粘贴分镜方案 JSON"), { target: { value: typeof value === "string" ? value : JSON.stringify(value) } });
}
async function preview() { fireEvent.click(screen.getByRole("button", { name: "校验并预览" })); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("single-scene platform preview", () => {
  it("is collapsed and performs no request until explicitly opened", () => {
    const h = harness(); render(<VimaxPreviewPanel {...h.props} />);
    expect(h.client.source).not.toHaveBeenCalled();
    expect(h.client.preview).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("或粘贴分镜方案 JSON")).toBeNull();
  });
  it("keeps the approved-script gate before source or preview requests", async () => {
    const h = harness(); render(<VimaxPreviewPanel {...h.props} scriptReady={false} />);
    fireEvent.click(screen.getByRole("button", { name: "单场景分镜预览" }));
    expect(await screen.findByText(/请先批准本集当前剧本/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "校验并预览" }) as HTMLButtonElement).disabled).toBe(true);
    expect(h.client.source).not.toHaveBeenCalled(); expect(h.client.preview).not.toHaveBeenCalled();
  });
  it("shows the selected source, exact dialogue and per-shot planning text without save or model actions", async () => {
    const h = harness(); render(<VimaxPreviewPanel {...h.props} />); await expand(); paste(h.request); await preview();
    expect(await screen.findByText("结构校验通过，可以人工对照")).toBeTruthy();
    const shot = screen.getByRole("article", { name: "镜头 1" });
    expect(within(shot).getByText(/预计 4 秒/)).toBeTruthy();
    expect(within(shot).getByText("原文对白").nextElementSibling?.textContent).toBe("林晚：这封信是你留下的吗？");
    expect(screen.getByText(/预计 13 秒 \/ 目标/)).toBeTruthy();
    expect(screen.getByText(/机位视觉参考顺序/)).toBeTruthy();
    expect(screen.getByText(/动作语义、对白音轨描述、竖屏构图和风格仍需人工核对/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^(保存候选|保存场景草稿|写入镜头草稿|生成|批准)$/ })).toBeNull();
    expect(h.client.preview).toHaveBeenCalledTimes(1);
    expect(h.client.source).toHaveBeenCalledTimes(1);
  });
  it("explains blocked dialogue without showing a successful review", async () => {
    const h = harness();
    h.client.preview.mockResolvedValueOnce(vimaxPlatformPreviewResponseSchema.parse({ ...h.response,
      report: { ...h.response.report, status: "blocked", diagnostics: [{ code: "dialogue_changed", path: "supplements.shots[0]" }], review: null } }));
    render(<VimaxPreviewPanel {...h.props} />); await expand(); paste(h.request); await preview();
    expect(await screen.findByText("方案未通过校验")).toBeTruthy();
    expect(screen.getByText(/方案改变了对白、说话人或原文顺序/)).toBeTruthy();
    expect(screen.queryByRole("article")).toBeNull();
  });
  it.each(["{", "{}", JSON.stringify({ schema: "ads.vimax-evaluation.report.v1", status: "ready_for_review" })])("refuses a bad import locally without a preview request", async (value) => {
    const h = harness(); render(<VimaxPreviewPanel {...h.props} />); await expand(); paste(value); await preview();
    expect(await screen.findByRole("alert")).toBeTruthy(); expect(h.client.preview).not.toHaveBeenCalled();
  });
  it("bounds pasted UTF-8 data before sending", async () => {
    const h = harness(); render(<VimaxPreviewPanel {...h.props} />); await expand();
    paste("中".repeat(Math.floor(VIMAX_PLATFORM_PREVIEW_MAX_BYTES / 3) + 1)); await preview();
    expect((await screen.findByRole("alert")).textContent).toContain("300 KB"); expect(h.client.preview).not.toHaveBeenCalled();
  });
  it("refuses an oversized file before reading its content", async () => {
    const h = harness(); render(<VimaxPreviewPanel {...h.props} />); await expand();
    const text = vi.fn();
    fireEvent.change(screen.getByLabelText("导入分镜方案 JSON"), { target: { files: [{ size: VIMAX_PLATFORM_PREVIEW_MAX_BYTES + 1, text }] } });
    expect((await screen.findByRole("alert")).textContent).toContain("300 KB"); expect(text).not.toHaveBeenCalled();
  });
  it("reads and validates an imported JSON file before an explicit preview", async () => {
    const h = harness(); render(<VimaxPreviewPanel {...h.props} />); await expand();
    const value = JSON.stringify(h.request);
    fireEvent.change(screen.getByLabelText("导入分镜方案 JSON"), { target: { files: [{ size: value.length, text: async () => value }] } });
    await waitFor(() => expect((screen.getByLabelText("或粘贴分镜方案 JSON") as HTMLTextAreaElement).value).toBe(value));
    expect(h.client.preview).not.toHaveBeenCalled(); await preview(); expect(await screen.findByText("结构校验通过，可以人工对照")).toBeTruthy();
  });
  it("invalidates the old report immediately after editing the imported JSON", async () => {
    const h = harness(); render(<VimaxPreviewPanel {...h.props} />); await expand(); paste(h.request); await preview();
    await screen.findByText("结构校验通过，可以人工对照"); paste("{}");
    expect(screen.queryByText("结构校验通过，可以人工对照")).toBeNull(); expect(screen.queryByRole("article")).toBeNull();
  });
  it("retains the original import after a 409 and requires re-reading the source", async () => {
    const h = harness(); h.client.preview.mockRejectedValueOnce(new VimaxPreviewError(409, "VIMAX_PREVIEW_SOURCE_CHANGED", "来源已变化，请重新读取来源。"));
    render(<VimaxPreviewPanel {...h.props} />); await expand(); paste(h.request); await preview();
    expect((await screen.findByRole("alert")).textContent).toContain("来源已变化");
    expect((screen.getByRole("button", { name: "校验并预览" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("或粘贴分镜方案 JSON") as HTMLTextAreaElement).value).toBe(JSON.stringify(h.request));
    fireEvent.click(screen.getByRole("button", { name: "重新读取来源" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "校验并预览" }) as HTMLButtonElement).disabled).toBe(false));
    expect(h.client.preview).toHaveBeenCalledTimes(1);
  });
  it.each([400, 500])("allows an explicit retry after HTTP %i with the same imported content", async (status) => {
    const h = harness(); h.client.preview.mockRejectedValueOnce(new VimaxPreviewError(status, "REFUSED", "校验未完成。"));
    render(<VimaxPreviewPanel {...h.props} />); await expand(); paste(h.request); await preview();
    await screen.findByRole("alert"); await preview();
    expect(await screen.findByText("结构校验通过，可以人工对照")).toBeTruthy(); expect(h.client.preview).toHaveBeenCalledTimes(2);
  });
  it("shows a source read error and permits a read-only retry", async () => {
    const h = harness(); h.client.source.mockRejectedValueOnce(new Error("offline"));
    render(<VimaxPreviewPanel {...h.props} />); fireEvent.click(screen.getByRole("button", { name: "单场景分镜预览" }));
    await screen.findByRole("alert"); fireEvent.click(screen.getByRole("button", { name: "重新读取来源" }));
    await screen.findByText(/当前来源：第 1 集/); expect(h.client.source).toHaveBeenCalledTimes(2); expect(h.client.preview).not.toHaveBeenCalled();
  });
  it("marks a completed preview historical after refresh without auto-revalidating or changing the import", async () => {
    const h = harness(); const mounted = render(<VimaxPreviewPanel {...h.props} />); await expand(); paste(h.request); await preview();
    await screen.findByText("结构校验通过，可以人工对照"); mounted.rerender(<VimaxPreviewPanel {...h.props} refreshEpoch={1} />);
    expect(await screen.findByText(/以下是此前的预览/)).toBeTruthy();
    expect(screen.queryByText("结构校验通过，可以人工对照")).toBeNull(); expect(screen.getByText("此前的结构校验结果")).toBeTruthy();
    expect((screen.getByRole("button", { name: "校验并预览" }) as HTMLButtonElement).disabled).toBe(true);
    expect(h.client.source).toHaveBeenCalledTimes(1); expect(h.client.preview).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText("或粘贴分镜方案 JSON") as HTMLTextAreaElement).value).toBe(JSON.stringify(h.request));
  });
  it("discards a late source read after the source epoch changes", async () => {
    const h = harness(); const old = deferred<VimaxPlatformSourceSnapshot>(); h.client.source.mockReturnValueOnce(old.promise);
    const mounted = render(<VimaxPreviewPanel {...h.props} />); fireEvent.click(screen.getByRole("button", { name: "单场景分镜预览" }));
    mounted.rerender(<VimaxPreviewPanel {...h.props} refreshEpoch={1} />); old.resolve(h.source);
    await waitFor(() => expect((screen.getByRole("button", { name: "重新读取来源" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText(/当前来源：第 1 集/)).toBeNull();
  });
  it("never revives a preview when approval changes false then true at the same epoch", async () => {
    const h = harness(); const mounted = render(<VimaxPreviewPanel {...h.props} />); await expand(); paste(h.request); await preview();
    await screen.findByText("结构校验通过，可以人工对照");
    mounted.rerender(<VimaxPreviewPanel {...h.props} scriptReady={false} />);
    expect(screen.queryByText("结构校验通过，可以人工对照")).toBeNull();
    mounted.rerender(<VimaxPreviewPanel {...h.props} scriptReady />);
    expect(screen.queryByText("结构校验通过，可以人工对照")).toBeNull();
    expect(screen.getByText("此前的结构校验结果")).toBeTruthy();
    expect((screen.getByRole("button", { name: "校验并预览" }) as HTMLButtonElement).disabled).toBe(true);
    expect(h.client.source).toHaveBeenCalledTimes(1); expect(h.client.preview).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "重新读取来源" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "校验并预览" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText("结构校验通过，可以人工对照")).toBeNull();
  });
  it("discards a pending preview after changing episodes and clears the imported text", async () => {
    const h = harness(); const pending = deferred<typeof h.response>(); h.client.preview.mockReturnValueOnce(pending.promise);
    const mounted = render(<VimaxPreviewPanel {...h.props} />); await expand(); paste(h.request); await preview();
    mounted.rerender(<VimaxPreviewPanel {...h.props} episodeId="11111111-1111-4111-8111-111111111111" />);
    pending.resolve(h.response);
    await waitFor(() => expect(screen.queryByRole("article")).toBeNull());
    expect(screen.queryByLabelText("或粘贴分镜方案 JSON")).toBeNull();
    expect(screen.queryByText("结构校验通过，可以人工对照")).toBeNull();
  });
  it("discards a pending preview after source refresh and never restores its old success", async () => {
    const h = harness(); const pending = deferred<typeof h.response>(); h.client.preview.mockReturnValueOnce(pending.promise);
    const mounted = render(<VimaxPreviewPanel {...h.props} />); await expand(); paste(h.request); await preview();
    mounted.rerender(<VimaxPreviewPanel {...h.props} refreshEpoch={1} />); pending.resolve(h.response);
    await waitFor(() => expect(screen.getByRole("button", { name: "校验并预览" })).toBeTruthy());
    expect(screen.queryByText("结构校验通过，可以人工对照")).toBeNull();
  });
  it("does not let a slow file replace newer pasted content", async () => {
    const h = harness(); const old = deferred<string>(); render(<VimaxPreviewPanel {...h.props} />); await expand();
    fireEvent.change(screen.getByLabelText("导入分镜方案 JSON"), { target: { files: [{ size: 100, text: async () => old.promise }] } });
    paste("newer pasted content"); old.resolve(JSON.stringify(h.request));
    await waitFor(() => expect((screen.getByLabelText("或粘贴分镜方案 JSON") as HTMLTextAreaElement).value).toBe("newer pasted content"));
  });
  it("discards a pending response after the panel is closed", async () => {
    const h = harness(); const pending = deferred<typeof h.response>(); h.client.preview.mockReturnValueOnce(pending.promise);
    render(<VimaxPreviewPanel {...h.props} />); await expand(); paste(h.request); await preview();
    fireEvent.click(screen.getByRole("button", { name: "单场景分镜预览" })); pending.resolve(h.response);
    await waitFor(() => expect(screen.queryByText("结构校验通过，可以人工对照")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "单场景分镜预览" })); await screen.findByText(/当前来源：第 1 集/);
    expect(screen.queryByRole("article")).toBeNull(); expect(h.client.preview).toHaveBeenCalledTimes(1);
  });
});
