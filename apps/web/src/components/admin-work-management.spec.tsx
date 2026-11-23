// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AdminWorkManagement, worksCsv, type WorkItem } from "./admin-work-management";

const base = "/api/v1/admin/works";
const work: WorkItem = { id: "one", title: "最后一班车", ownerName: "林安", ownerLegacy: false,
  updatedAt: "2026-11-23T06:00:00.000Z", productionLabel: "草稿", recentTask: "", episodeProgress: "", reviewHref: "/admin/works/one/review" };
const another: WorkItem = { ...work, id: "two", title: "回到石鼓镇", ownerName: "陈禾" };
function response(body: unknown) { return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }); }
const page = (items = [work, another], nextCursor: string | null = null) =>
  response({ canManageWorks: true, items, total: 2, nextCursor, owners: [] });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([true, false])("keeps reviewing available without recycling or exporting controls (wide=%s)", async wide => {
  const onWork = vi.fn();
  const fetchImpl = vi.fn(async () => response({ canManageWorks: false, items: [work], total: 1, owners: [] }));
  render(<AdminWorkManagement wide={wide} fetchImpl={fetchImpl} onWork={onWork} />);
  fireEvent.click(await screen.findByRole("button", { name: "查看详情" }));
  expect(onWork).toHaveBeenCalledWith(work);
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByLabelText(/更多操作/)).toBeNull();
  expect(screen.queryByText(/回收站|导出清单/)).toBeNull();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it("limits select-all to the current page and forgets it on page, tab and filter changes", async () => {
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.includes("/trash")) return response({ items: [], total: 0, nextCursor: null });
    return url.includes("cursor") ? page([another]) : page([work], "next");
  });
  render(<AdminWorkManagement wide fetchImpl={fetchImpl} onWork={vi.fn()} />);
  fireEvent.click(await screen.findByLabelText("全选当前页"));
  expect(screen.getByText("已选 1 部")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(await screen.findByText(another.title)).toBeTruthy();
  expect(screen.queryByText("已选 1 部")).toBeNull();
  fireEvent.click(screen.getByLabelText("全选当前页"));
  fireEvent.click(screen.getByRole("button", { name: "上一页" }));
  expect(await screen.findByText(work.title)).toBeTruthy();
  expect(screen.queryByText("已选 1 部")).toBeNull();
  fireEvent.click(screen.getByLabelText("全选当前页"));
  fireEvent.change(screen.getByLabelText("制作状态"), { target: { value: "draft" } });
  await screen.findByText(work.title);
  expect(screen.queryByText("已选 1 部")).toBeNull();
  fireEvent.click(screen.getByLabelText("全选当前页"));
  fireEvent.click(screen.getByRole("button", { name: "回收站" }));
  expect(await screen.findByText("回收站是空的")).toBeTruthy();
  expect(screen.queryByText("已选 1 部")).toBeNull();
});

it("shows eligible and skipped titles and writes only confirmed versions with a nonblank reason", async () => {
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === base + "/trash-preview") return response({ items: [
      { id: work.id, eligible: true, version: 4, message: null },
      { id: another.id, eligible: false, version: null, message: "正在生成视频" },
    ] });
    if (init?.method === "POST") return response({ items: [{ id: work.id, status: "succeeded" }] });
    return page();
  });
  render(<AdminWorkManagement wide fetchImpl={fetchImpl} onWork={vi.fn()} />);
  fireEvent.click(await screen.findByLabelText("全选当前页"));
  const bulk = screen.getByText("已选 2 部").parentElement!;
  fireEvent.click(within(bulk).getByRole("button", { name: "移入回收站" }));
  const dialog = within(screen.getByRole("dialog"));
  expect(await dialog.findByText("将跳过 · 1 部")).toBeTruthy();
  expect(dialog.getByText(another.ownerName)).toBeTruthy();
  fireEvent.click(dialog.getByRole("button", { name: "确认移入 1 部" }));
  expect(dialog.getByRole("alert").textContent).toContain("请填写操作原因");
  expect(fetchImpl.mock.calls.filter(([url]) => url === base + "/trash")).toHaveLength(0);
  fireEvent.change(dialog.getByRole("textbox", { name: "操作原因" }), { target: { value: "  清理测试作品  " } });
  fireEvent.click(dialog.getByRole("button", { name: "确认移入 1 部" }));
  expect(await screen.findByText("已移入回收站 1 部，跳过 1 部")).toBeTruthy();
  const writes = fetchImpl.mock.calls.filter(([url]) => url === base + "/trash");
  expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0]![1]!.body as string)).toEqual({ confirmed: true, items: [{ id: "one", version: 4 }], reason: "清理测试作品" });
  expect(screen.getByText(/《回到石鼓镇》 正在生成视频/)).toBeTruthy();
});

it("displays deletion audit, restores a single old entry on mobile and reports an uncertain response without retry", async () => {
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === base + "/restore") throw new Error("lost response");
    if (url === base + "/trash" && !init?.method) return response({ items: [
      { id: work.id, title: work.title, ownerName: work.ownerName, deletedBy: null, deletedAt: work.updatedAt, reason: "清理内部测试", version: 6 },
    ], total: 1 });
    return page();
  });
  render(<AdminWorkManagement wide={false} fetchImpl={fetchImpl} onWork={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "回收站" }));
  expect(await screen.findByText(/操作人 · 未记录/)).toBeTruthy();
  expect(screen.getByText(/操作原因 · 清理内部测试/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "恢复作品" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认恢复 1 部" }));
  expect(await screen.findByText("已恢复 0 部，结果待核对 1 部")).toBeTruthy();
  const writes = fetchImpl.mock.calls.filter(([url]) => url === base + "/restore");
  expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0]![1]!.body as string)).toEqual({ items: [{ id: work.id, version: 6 }], confirmed: true });
});

it("exports only the chosen data with UTF-8 BOM, CSV quotes and neutralized formula prefixes", () => {
  const csv = worksCsv([{ ...work, title: ' \u0001=SUM("x",1)\n二', ownerName: "\t+bad" }, { ...another, ownerName: " ＠test" }]);
  expect(csv.startsWith("\uFEFF")).toBe(true);
  expect(csv).toContain(`"' \u0001=SUM(""x"",1)\n二","'\t+bad"`);
  expect(csv).toContain(`"' ＠test"`);
  expect(csv).toContain('"2026-11-23 14:00"');
  expect(csv).not.toContain("review");
});
