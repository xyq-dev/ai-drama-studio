// @vitest-environment happy-dom
import { useState } from "react";
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
  fireEvent.click(screen.getByRole("button", { name: "归类所选作品" }));
  fireEvent.click(screen.getByRole("radio", { name: "悬疑" }));
  fireEvent.click(screen.getByRole("button", { name: "确认归类" }));
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
  fireEvent.click(screen.getByRole("button", { name: "归类所选作品" }));
  fireEvent.click(screen.getByRole("radio", { name: "悬疑" }));
  fireEvent.click(screen.getByRole("button", { name: "确认归类" }));
  await waitFor(() => expect(complete).toHaveBeenCalledWith([], "归类完成 0 部，未确认 1 部。", ["《夜班》：分类已被其他页面修改"]));
  expect(fetch).toHaveBeenCalledOnce();
});


it("does not write on opening or choosing a category, and cancel restores focus", () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const { onComplete, onBusyChange } = setup();
  const opener = screen.getByRole("button", { name: "归类所选作品" });
  fireEvent.click(opener);
  expect(onBusyChange).toHaveBeenLastCalledWith(true);
  expect((screen.getByRole("button", { name: "确认归类" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "悬疑" }));
  expect((screen.getByRole("button", { name: "确认归类" }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole("radio", { name: "未分类" }));
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(onComplete).not.toHaveBeenCalled();
  expect(onBusyChange).toHaveBeenLastCalledWith(false);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(opener);
  fireEvent.click(opener);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(opener);
});

it("confirms a frozen selection and revisions even when its own busy callback disables the toolbar", async () => {
  const writes: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    writes.push([url, JSON.parse(String(init.body))]);
    return json({});
  }));
  const onComplete = vi.fn(async () => undefined), onBusyChange = vi.fn();
  const selected = works.map((work) => ({ ...work }));
  const view = render(<ProjectBulkActions selected={selected} categories={[]} categoriesReady disabled={false} onBusyChange={onBusyChange} onComplete={onComplete} />);
  fireEvent.click(screen.getByRole("button", { name: "归类所选作品" }));
  selected[0]!.categoryRevision = 999;
  view.rerender(<ProjectBulkActions selected={[{ ...works[1]!, categoryRevision: 999 }]} categories={[]} categoriesReady disabled onBusyChange={onBusyChange} onComplete={onComplete} />);
  expect(screen.getByText("将已选的 2 部作品归入同一分类。确认后生效。")).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "未分类" }));
  fireEvent.click(screen.getByRole("button", { name: "确认归类" }));
  await waitFor(() => expect(onComplete).toHaveBeenCalledWith(["one", "two"], "归类完成 2 部，未确认 0 部。", []));
  expect(writes).toEqual([
    ["/api/v1/library/projects/one/category", { categoryId: null, expectedRevision: 3 }],
    ["/api/v1/library/projects/two/category", { categoryId: null, expectedRevision: 7 }],
  ]);
});

it("keeps classification open while writing and never retries an uncertain result", async () => {
  let release!: () => void;
  const writes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    writes.push(url);
    if (url.includes("/one/")) {
      await new Promise<void>((resolve) => { release = resolve; });
      throw new TypeError("lost response");
    }
    return json({});
  }));
  const { onComplete } = setup();
  fireEvent.click(screen.getByRole("button", { name: "归类所选作品" }));
  fireEvent.click(screen.getByRole("radio", { name: "悬疑" }));
  const confirm = screen.getByRole("button", { name: "确认归类" });
  fireEvent.click(confirm); fireEvent.click(confirm);
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect((screen.getByRole("radio", { name: "未分类" }) as HTMLInputElement).disabled).toBe(true);
  await act(async () => release());
  await waitFor(() => expect(onComplete).toHaveBeenCalledWith(["two"], "归类完成 1 部，未确认 1 部。", [expect.stringContaining("结果未确认")]));
  expect(writes).toHaveLength(2);
  expect(screen.queryByRole("dialog")).toBeNull();
});


function CompletingBulkActions() {
  const [selected, setSelected] = useState(works);
  const [busy, setBusy] = useState(false);
  return <main id="main" tabIndex={-1}>
    <ProjectBulkActions selected={selected} categories={[]} categoriesReady disabled={busy}
      onBusyChange={setBusy} onComplete={async () => { setSelected([]); }} />
  </main>;
}

it.each(["category", "delete"] as const)("returns focus to main after %s completion clears the selection", async (mode) => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => init.method === "POST" ? json({}) : json(preview(url.includes("/one/") ? "one" : "two"))));
  render(<CompletingBulkActions />);
  const opener = screen.getByRole("button", { name: mode === "category" ? "归类所选作品" : "移入回收站" });
  fireEvent.click(opener);
  if (mode === "category") fireEvent.click(screen.getByRole("radio", { name: "未分类" }));
  const confirm = await screen.findByRole("button", { name: mode === "category" ? "确认归类" : "确认移入 2 部" });
  await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(confirm);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect((opener as HTMLButtonElement).disabled).toBe(true);
  expect(document.activeElement).toBe(screen.getByRole("main"));
});

it("returns focus to the enabled trigger when canceling while the parent owns busy state", () => {
  render(<CompletingBulkActions />);
  const opener = screen.getByRole("button", { name: "归类所选作品" });
  fireEvent.click(opener);
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect((opener as HTMLButtonElement).disabled).toBe(false);
  expect(document.activeElement).toBe(opener);
});
