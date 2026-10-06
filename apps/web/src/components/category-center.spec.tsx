// @vitest-environment happy-dom
// Local UI/storage tests; no API, database, or model is invoked.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CategoryCenter } from "./category-center";
import { DIRECTION_STORAGE_KEY } from "../lib/creative-taxonomy";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.localStorage.clear(); });

function selectCategory(name: string) {
  fireEvent.click(screen.getByRole("button", { name: `查看${name}分类` }));
  fireEvent.click(screen.getByRole("button", { name: "选为我的题材" }));
}

describe("category center", () => {
  it("searches classifications and groups without contacting the API", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    render(<CategoryCenter />);
    expect(screen.getAllByRole("button", { name: /^查看.+分类$/ })).toHaveLength(12);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "科幻" } });
    expect(screen.getAllByRole("button", { name: /^查看.+分类$/ })).toHaveLength(1);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "没有这个题材xyz" } });
    expect(screen.getByText("没有找到对应分类")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(screen.getAllByRole("button", { name: /^查看.+分类$/ })).toHaveLength(12);
    fireEvent.click(screen.getByRole("button", { name: "剧情机制" }));
    expect(screen.getByRole("button", { name: "剧情机制" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "重生" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "现代都市" })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("selects one category, preserves tags when switching, and restores the browser draft", () => {
    render(<CategoryCenter />);
    fireEvent.click(screen.getByRole("button", { name: "现代都市" }));
    selectCategory("爱情情感");
    selectCategory("悬疑罪案");
    const saved = JSON.parse(window.localStorage.getItem(DIRECTION_STORAGE_KEY) ?? "{}");
    expect(saved).toEqual({ version: 1, categoryId: "SUSPENSE_CRIME", tagIds: ["background-0"] });
    cleanup(); render(<CategoryCenter />);
    expect(screen.getByRole("button", { name: "移除现代都市" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "复制创作方向" }) as HTMLButtonElement).disabled).toBe(false);
    const start = screen.getByRole("link", { name: "用这个方向新建作品" });
    expect(start.getAttribute("href")).toBe("/studio?direction=1");
    fireEvent.click(screen.getByRole("button", { name: "移除现代都市" }));
    expect(JSON.parse(window.localStorage.getItem(DIRECTION_STORAGE_KEY) ?? "{}").tagIds).toEqual([]);
    window.localStorage.setItem("unrelated-draft", "keep");
    fireEvent.click(screen.getByRole("button", { name: "清空选择" }));
    expect(window.localStorage.getItem("unrelated-draft")).toBe("keep");
    expect((screen.getByRole("button", { name: "复制创作方向" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("link", { name: "用这个方向新建作品" })).toBeNull();
  });

  it("keeps modal focus contained and returns it to the category card", () => {
    render(<CategoryCenter />);
    const opener = screen.getByRole("button", { name: "查看爱情情感分类" });
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "爱情情感" });
    const close = within(dialog).getByRole("button", { name: "关闭分类详情" });
    const select = within(dialog).getByRole("button", { name: "选为我的题材" });
    expect(document.activeElement).toBe(close);
    select.focus(); fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(document.querySelector("[inert]")).toBeNull();
  });

  it("preserves unreadable storage until an explicit edit and reports write failure", () => {
    window.localStorage.setItem(DIRECTION_STORAGE_KEY, '{"version":999}');
    render(<CategoryCenter />);
    expect(screen.getByText(/旧的创作方向无法恢复/)).toBeTruthy();
    expect(window.localStorage.getItem(DIRECTION_STORAGE_KEY)).toBe('{"version":999}');
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("quota"); });
    selectCategory("喜剧轻喜");
    expect(screen.getByText(/保存失败，当前选择仅在本页保留/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "复制创作方向" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("provides manual copying when clipboard is unavailable", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    render(<CategoryCenter />);
    selectCategory("青春校园");
    fireEvent.click(screen.getByRole("button", { name: "友情陪伴" }));
    fireEvent.click(screen.getByRole("button", { name: "复制创作方向" }));
    const field = await screen.findByRole("textbox", { name: "手动复制创作方向" }) as HTMLTextAreaElement;
    expect(field.value).toContain("创作方向：青春校园");
    expect(field.value).toContain("关系情感：友情陪伴");
    expect(document.activeElement).toBe(field);
  });

  it("does not report a previous copy as the current edited direction", async () => {
    let resolve: () => void = () => undefined;
    const copy = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    vi.stubGlobal("navigator", { clipboard: { writeText: copy } });
    render(<CategoryCenter />); selectCategory("科幻未来");
    fireEvent.click(screen.getByRole("button", { name: "复制创作方向" }));
    fireEvent.click(screen.getByRole("button", { name: "未来世界" }));
    await act(async () => { resolve(); });
    expect(screen.queryByRole("button", { name: "已复制创作方向" })).toBeNull();
    expect(copy.mock.calls).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "复制创作方向" }));
    await act(async () => { resolve(); });
    await waitFor(() => expect(screen.getByRole("button", { name: "已复制创作方向" })).toBeTruthy());
  });
});
