// @vitest-environment happy-dom
// Isolated interface tests; no business database or real media provider is contacted.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadProjectFacts } from "../lib/beginner-facts";
import { MyWorks } from "./my-works";

vi.mock("../lib/beginner-facts", () => ({ loadProjectFacts: vi.fn() }));
const P = "11111111-1111-4111-8111-111111111111";
const C = "22222222-2222-4222-8222-222222222222";
const category = { id: C, name: "都市情感", count: 30 };
function project(overrides = {}) {
  return { id: P, title: "夜班", premise: "店员发现记录被改。", episodeCount: 3, writingMode: "short",
    categoryId: null, categoryName: null, categoryRevision: 0, thumbnailAssetId: null, thumbnailUrl: null,
    createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z", ...overrides };
}
function page(overrides = {}) {
  return { items: [project()], nextCursor: null, total: 31, allCount: 31, unclassifiedCount: 1,
    categories: [category], categoriesReady: true, ...overrides };
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.mocked(loadProjectFacts).mockResolvedValue({ story: null, episodes: [], characters: { items: [], read: "ok" },
    locations: { items: [], read: "ok" }, runs: [], media: {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("作品分类列表", () => {
  it("searches all projects through the API and preserves the search when filtering and sorting", async () => {
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      paths.push(input);
      return json(page({ items: input.includes("q=") ? [project({ title: "另一个故事" })] : [project()] }));
    }));
    render(<MyWorks />);
    await screen.findByRole("heading", { name: "夜班" });
    expect(screen.getByText("31 部作品")).toBeTruthy();
    expect(screen.getByText("已显示 1 / 31 部作品")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索作品" }), { target: { value: "  另一个  " } });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    await screen.findByRole("heading", { name: "另一个故事" });
    expect(screen.queryByRole("heading", { name: "夜班" })).toBeNull();
    expect(new URL(paths.at(-1)!, "https://test.invalid").searchParams.get("q")).toBe("另一个");
    fireEvent.click(screen.getByRole("button", { name: "都市情感 30" }));
    await waitFor(() => expect(new URL(paths.at(-1)!, "https://test.invalid").searchParams.get("category")).toBe(C));
    fireEvent.change(screen.getByRole("combobox", { name: "作品排序" }), { target: { value: "created" } });
    await waitFor(() => expect(new URL(paths.at(-1)!, "https://test.invalid").searchParams.get("sort")).toBe("created"));
    expect(new URL(paths.at(-1)!, "https://test.invalid").searchParams.get("q")).toBe("另一个");
  });

  it("ignores a late load-more response after the category has changed", async () => {
    let release!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (input.includes("cursor=")) return new Promise<Response>((done) => { release = done; });
      if (input.includes("category=")) return json(page({ items: [project({ id: "filtered", title: "分类中的作品" })], total: 1 }));
      return json(page({ nextCursor: "page-two" }));
    }));
    render(<MyWorks />);
    fireEvent.click(await screen.findByRole("button", { name: "加载更多作品" }));
    fireEvent.click(screen.getByRole("button", { name: "都市情感 30" }));
    await screen.findByRole("heading", { name: "分类中的作品" });
    await act(async () => release(json(page({ items: [project({ id: "old", title: "旧页面作品" })] }))));
    expect(screen.queryByRole("heading", { name: "旧页面作品" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "夜班" })).toBeNull();
    expect(screen.queryByRole("button", { name: "加载更多作品" })).toBeNull();
  });

  it("reuses the category identity after a lost response and reloads the saved category", async () => {
    const writes: Array<{ id: string; name: string }> = [];
    let created = false;
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        writes.push(body);
        if (writes.length === 1) throw new TypeError("connection lost");
        created = true;
        return json({ ...body, count: 0 });
      }
      return json(page({ categories: created ? [category, { id: writes[1]!.id, name: "悬疑", count: 0 }] : [category] }));
    }));
    render(<MyWorks />);
    await screen.findByRole("heading", { name: "夜班" });
    fireEvent.click(screen.getByRole("button", { name: "新建分类" }));
    fireEvent.change(screen.getByLabelText("分类名称"), { target: { value: "悬疑" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect((await screen.findByRole("alert")).textContent).toContain("分类保存结果未确认");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("button", { name: "悬疑 0" })).toBeTruthy();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    expect(screen.queryByLabelText("分类名称")).toBeNull();
  });

  it("writes the selected category and can return a work to uncategorized with its server revision", async () => {
    let item = project();
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        expect(input).toBe(`/api/v1/library/projects/${P}/category`);
        const body = JSON.parse(String(init.body));
        writes.push(body);
        item = project({ categoryId: body.categoryId, categoryName: body.categoryId ? category.name : null,
          categoryRevision: body.expectedRevision + 1 });
        return json({ projectId: P, categoryId: item.categoryId, categoryName: item.categoryName, categoryRevision: item.categoryRevision });
      }
      return json(page({ items: [item] }));
    }));
    render(<MyWorks />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "选择作品：夜班" }));
    fireEvent.click(screen.getByRole("button", { name: "归类所选作品" }));
    fireEvent.click(screen.getByRole("radio", { name: "都市情感" }));
    fireEvent.click(screen.getByRole("button", { name: "确认归类" }));
    await screen.findByText("归类完成 1 部，未确认 0 部。");
    await waitFor(() => expect((screen.getByRole("checkbox", { name: "选择作品：夜班" }) as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择作品：夜班" }));
    fireEvent.click(screen.getByRole("button", { name: "归类所选作品" }));
    fireEvent.click(screen.getByRole("radio", { name: "未分类" }));
    fireEvent.click(screen.getByRole("button", { name: "确认归类" }));
    await waitFor(() => expect(writes).toEqual([{ categoryId: C, expectedRevision: 0 }, { categoryId: null, expectedRevision: 1 }]));
  });

  it("renders real thumbnail URLs, falls back on a broken image, and never invents a cover", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(page({ items: [project({ thumbnailAssetId: "image", thumbnailUrl: "/api/v1/real-media/assets/image/content" })] }))));
    render(<MyWorks />);
    const image = await screen.findByRole("img", { name: "夜班封面" });
    expect(image.getAttribute("src")).toBe("/api/v1/real-media/assets/image/content");
    fireEvent.error(image);
    expect(screen.queryByRole("img", { name: "夜班封面" })).toBeNull();
    expect(screen.getByText("暂无封面")).toBeTruthy();
    expect(screen.getByRole("link", { name: "继续创作" }).getAttribute("href")).toBe(`/projects/${P}/create`);
    expect(screen.getByRole("link", { name: "剧本工作台" }).getAttribute("href")).toBe(`/projects/${P}/script`);
    expect(screen.getByRole("link", { name: "回收站" }).getAttribute("href")).toBe("/studio/trash");
  });

  it("keeps the library readable without the category draft and disables unavailable writes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(page({ categories: [], categoriesReady: false }))));
    render(<MyWorks />);
    await screen.findByRole("heading", { name: "夜班" });
    expect((screen.getByRole("button", { name: "新建分类" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "归类所选作品" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("分类功能尚未启用，作品仍可正常打开。")).toBeTruthy();
    expect(screen.getByRole("link", { name: "高级编辑" })).toBeTruthy();
  });
});

it("selects only displayed rows, keeps appended rows unselected, and clears selection on filters", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: string) => json(page(input.includes("cursor=")
    ? { items: [project({ id: "second", title: "第二部" })] }
    : { items: [project()], nextCursor: "next" }))));
  render(<MyWorks />);
  await screen.findByRole("heading", { name: "夜班" });
  fireEvent.click(screen.getByRole("checkbox", { name: "全选已显示作品" }));
  expect(screen.getByText("已选 1 部")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "加载更多作品" }));
  await screen.findByRole("heading", { name: "第二部" });
  expect((screen.getByRole("checkbox", { name: "选择作品：第二部" }) as HTMLInputElement).checked).toBe(false);
  expect(screen.getByRole("checkbox", { name: "全选已显示作品" }).getAttribute("aria-checked")).toBe("mixed");
  fireEvent.click(screen.getByRole("checkbox", { name: "全选已显示作品" }));
  expect(screen.getByText("已选 2 部")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "都市情感 30" }));
  await waitFor(() => expect(screen.getByText("已选 0 部")).toBeTruthy());
  expect((screen.getByRole("button", { name: "移入回收站" }) as HTMLButtonElement).disabled).toBe(true);
});
