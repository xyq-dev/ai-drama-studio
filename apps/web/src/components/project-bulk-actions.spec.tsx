// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectBulkActions } from "./project-bulk-actions";

const works = [
  { id: "one", title: "夜班", categoryId: null, categoryRevision: 3 },
  { id: "two", title: "雨夜", categoryId: null, categoryRevision: 7 },
];
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }
function preview(id: string, canDelete = true) { return { projectId: id, title: id === "one" ? "夜班" : "雨夜", version: id === "one" ? 4 : 8,
  episodeCount: 3, canDelete, blockedReason: canDelete ? null : "作品仍有任务运行中",
  dependencies: { scenes: 1, shots: 2, speech: 3, video: 4, other: 0, total: 10 } }; }
function setup() {
  const onComplete = vi.fn(async () => undefined), onBusyChange = vi.fn();
  const view = render(<ProjectBulkActions selected={works} categories={[{ id: "category", name: "悬疑" }]} categoriesReady disabled={false} onBusyChange={onBusyChange} onComplete={onComplete} />);
  return { ...view, onComplete, onBusyChange };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("classifies each selected work with its own revision and reports partial conflicts", async () => {
  const writes: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    writes.push([url, JSON.parse(String(init.body))]);
    return url.includes("/one/") ? json({}) : json({ error: { code: "CONFLICT", message: "分类已变更，请刷新" } }, 409);
  }));
  const { onComplete } = setup();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "category" } });
  await waitFor(() => expect(onComplete).toHaveBeenCalledWith(["one"], "归类完成 1 部，未确认 1 部。", ["《雨夜》：分类已变更，请刷新"]));
  expect(writes).toEqual([
    ["/api/v1/library/projects/one/category", { categoryId: "category", expectedRevision: 3 }],
    ["/api/v1/library/projects/two/category", { categoryId: "category", expectedRevision: 7 }],
  ]);
});

it("previews all works, skips active work, and confirms only eligible versions", async () => {
  const writes: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === "POST") { writes.push({ url, init }); return json({}); }
    return json(preview(url.includes("/one/") ? "one" : "two", url.includes("/one/")));
  }));
  const { onComplete } = setup();
  fireEvent.click(screen.getByRole("button", { name: "移入回收站" }));
  await screen.findByText("可移入 1 部；跳过 1 部。");
  expect(screen.getByText("作品仍有任务运行中")).toBeTruthy();
  expect(writes).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "确认移入 1 部" }));
  await waitFor(() => expect(onComplete).toHaveBeenCalledWith(["one"], "已移入回收站 1 部，未完成 1 部。", ["《雨夜》：作品仍有任务运行中"]));
  expect(writes).toHaveLength(1);
  expect(writes[0]!.url).toBe("/api/v1/projects/one/script-workbench/trash");
  expect(JSON.parse(String(writes[0]!.init.body))).toEqual({ expectedVersion: 4 });
  expect(new Headers(writes[0]!.init.headers).get("If-Match")).toBe("4");
});

it("does not retry uncertain writes or double-submit and keeps success separate", async () => {
  let release!: () => void;
  const writes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (init.method !== "POST") return json(preview(url.includes("/one/") ? "one" : "two"));
    writes.push(url);
    if (url.includes("/one/")) { await new Promise<void>((resolve) => { release = resolve; }); throw new TypeError("lost response"); }
    return json({});
  }));
  const { onComplete } = setup();
  fireEvent.click(screen.getByRole("button", { name: "移入回收站" }));
  const confirm = await screen.findByRole("button", { name: "确认移入 2 部" });
  await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(confirm); fireEvent.click(confirm);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.getByRole("dialog")).toBeTruthy();
  await act(async () => release());
  await waitFor(() => expect(onComplete).toHaveBeenCalledWith(["two"], "已移入回收站 1 部，未完成 1 部。", [expect.stringContaining("结果未确认")]));
  expect(writes).toHaveLength(2);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("cancels a preview without writes and ignores its late response", async () => {
  let release!: (response: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
  vi.stubGlobal("fetch", fetch);
  const { onComplete, onBusyChange } = setup();
  const opener = screen.getByRole("button", { name: "移入回收站" });
  fireEvent.click(opener);
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "取消" }));
  await act(async () => release(json(preview("one"))));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(onComplete).not.toHaveBeenCalled();
  expect(onBusyChange).toHaveBeenLastCalledWith(false);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(opener);
});

it("prevents deletion when every preview is blocked or unreadable", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/one/")) return json(preview("one", false));
    throw new TypeError("unavailable");
  }));
  setup();
  fireEvent.click(screen.getByRole("button", { name: "移入回收站" }));
  await screen.findByText("可移入 0 部；跳过 2 部。");
  expect((screen.getByRole("button", { name: "确认移入 0 部" }) as HTMLButtonElement).disabled).toBe(true);
});

it("checks the server revision even when the old category already matches", async () => {
  const fetch = vi.fn(async () => json({ error: { message: "分类已被其他页面修改" } }, 409));
  vi.stubGlobal("fetch", fetch);
  const complete = vi.fn(async () => undefined);
  render(<ProjectBulkActions selected={[{ ...works[0]!, categoryId: "category" }]} categories={[{ id: "category", name: "悬疑" }]} categoriesReady disabled={false} onBusyChange={() => undefined} onComplete={complete} />);
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "category" } });
  await waitFor(() => expect(complete).toHaveBeenCalledWith([], "归类完成 0 部，未确认 1 部。", ["《夜班》：分类已被其他页面修改"]));
  expect(fetch).toHaveBeenCalledOnce();
});
