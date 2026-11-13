// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HoverMediaPreview } from "./hover-media-preview";
import { StoryboardRows, type StoryboardShot } from "./storyboard-rows";

const shot: StoryboardShot = {
  entityId: "shot", rowVersion: 7, currentRevisionId: "revision", approvedRevisionId: "revision",
  currentRevision: { reviewStatus: "APPROVED", freshnessStatus: "CURRENT", reviewVersion: 2 },
  storyboard: {
    ordinal: 1, shotType: "特写", camera: "固定机位", action: "木牌落在碑上", dialogue: "我就是陈长渡。",
    durationHint: null, plannedDurationMs: 8000, promptText: "清晨石铺，木牌特写", sourceScene: "石铺清晨", location: "石铺",
    characters: [{ id: "boatman", name: "陈长渡", assetId: "portrait" }],
    candidates: [{ id: "selected", kind: "IMAGE", storageProvider: "s3", status: "ACTIVE" }], selectedAssetId: "selected",
  },
};

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("storyboard editing overview", () => {
  it("renders bounded server facts and switches views without choosing a candidate", () => {
    const onOpen = vi.fn();
    const onArchive = vi.fn();
    const props = { projectId: "project", items: [shot], loading: false, hasMore: false, onMore: vi.fn(), onOpen, onArchive, onDispatched: vi.fn() };
    const view = render(<StoryboardRows {...props} currentId={null} />);
    expect(screen.getByText("清晨石铺，木牌特写")).toBeTruthy();
    expect(screen.getByRole("button", { name: "陈长渡参考图" })).toBeTruthy();
    expect(screen.getByText("已选用")).toBeTruthy();
    expect(screen.getByText("我就是陈长渡。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "打开单镜" }));
    expect(onOpen).toHaveBeenCalledWith("shot");
    view.rerender(<StoryboardRows {...props} currentId="shot" />);
    fireEvent.click(screen.getByRole("button", { name: "列表" }));
    expect(onOpen).toHaveBeenCalledWith(null);
    expect(onArchive).not.toHaveBeenCalled();
  });

  it("asks before archive and reuses the same write key after an uncertain response", async () => {
    const onArchive = vi.fn().mockRejectedValueOnce(new Error("删除结果暂未确认")).mockResolvedValueOnce(undefined);
    render(<StoryboardRows projectId="project" items={[shot]} currentId={null} loading={false} hasMore={false}
      onMore={vi.fn()} onOpen={vi.fn()} onArchive={onArchive} onDispatched={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "删除镜头 1" }));
    const dialog = screen.getByRole("dialog", { name: "删除镜头 1？" });
    expect(onArchive).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "删除分镜" }));
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "删除分镜" }));
    await act(async () => {});
    expect(onArchive).toHaveBeenCalledTimes(2);
    expect(onArchive.mock.calls[0]).toEqual(onArchive.mock.calls[1]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("candidate preview", () => {
  it("starts a muted inline video on hover, lets the pointer move into the popup, and stops on leave", async () => {
    vi.useFakeTimers();
    render(<HoverMediaPreview kind="video" label="候选镜头" src="/fixture.mp4" />);
    const tile = screen.getByRole("button", { name: "候选镜头" });
    fireEvent.pointerEnter(tile, { pointerType: "mouse" });
    await act(async () => { await vi.advanceTimersByTimeAsync(170); });
    const popup = screen.getByRole("dialog", { name: "候选镜头" });
    const video = popup.querySelector("video")!;
    expect(video.autoplay).toBe(true);
    expect(video.muted).toBe(true);
    expect(video.controls).toBe(true);
    fireEvent.pointerLeave(tile, { pointerType: "mouse" });
    fireEvent.pointerEnter(popup, { pointerType: "mouse" });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.pointerLeave(popup, { pointerType: "mouse" });
    await act(async () => { await vi.advanceTimersByTimeAsync(160); });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector("video")).toBeNull();
  });

  it("keeps a click-opened image available to touch and keyboard until Escape", () => {
    render(<HoverMediaPreview kind="image" label="分镜图" src="/fixture.png" />);
    const tile = screen.getByRole("button", { name: "分镜图" });
    fireEvent.click(tile);
    expect(within(screen.getByRole("dialog")).getByRole("img", { name: "分镜图" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(tile);
  });
});
