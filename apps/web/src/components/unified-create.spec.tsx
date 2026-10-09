// @vitest-environment happy-dom
// Simulated interface tests. fetch is mocked; this file does not start a browser or a backend.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CategoriesPage from "../app/categories/page";
import { premiseBlock } from "../lib/creative-direction-link";
import { CATEGORIES, DIRECTION_STORAGE_KEY, TAGS, type Category } from "../lib/creative-taxonomy";
import { BeginnerStart } from "./beginner-start";

const PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const [FIRST, SECOND] = [CATEGORIES[0]!, CATEGORIES[1]!];
/** A direction as the page stores it: its tags in taxonomy order. */
const directionOf = (category: Category) => ({ version: 1 as const, categoryId: category.id,
  tagIds: TAGS.map((tag) => tag.id).filter((id) => (category.recommended as readonly string[]).includes(id)) });
const FIRST_DIRECTION = directionOf(FIRST);
const SECOND_DIRECTION = directionOf(SECOND);

interface Call { method: string; url: string; body: string | null }
let calls: Call[];
let releaseCreate: (() => void) | null;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function serve(options: { aiCode?: string; holdCreate?: boolean } = {}) {
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url: String(input), body: typeof init?.body === "string" ? init.body : null });
    if (String(input).endsWith("/writing/title-runs/options")) {
      return json({ enabled: options.aiCode === undefined, code: options.aiCode ?? "TITLE_WRITING_READY", storageReady: true,
        operatorTokenRequired: true, defaultProvider: null, providers: [], maxCallsPerDay: 0, maxActiveRuns: 1, callCapPerRun: 0,
        billing: "unknown", defaults: null });
    }
    if (init?.method === "POST") {
      if (options.holdCreate) await new Promise<void>((resolve) => { releaseCreate = resolve; });
      return json({ id: PROJECT_ID, title: "夜班", premise: "", version: 1, status: "ACTIVE" }, 201);
    }
    return json({ items: [], nextCursor: null });
  }));
}

const writes = () => calls.filter((call) => call.method !== "GET");
const idea = () => screen.getByLabelText("你想拍一个什么样的故事？") as HTMLTextAreaElement;
const picker = () => within(document.getElementById("inspiration")!);

function openCard(name: string) {
  fireEvent.click(picker().getByRole("button", { name: new RegExp(`^${name}`) }));
}

function use(name: string) {
  openCard(name);
  fireEvent.click(picker().getByRole("button", { name: /用这个方向|已在使用这个方向/ }));
}

beforeEach(() => {
  calls = [];
  releaseCreate = null;
  window.history.replaceState(null, "", "/create");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("one creation page with an inline inspiration section", () => {
  it("shows the form first and the directions on the same page, and browsing sends no create or generate request", async () => {
    serve();
    render(<BeginnerStart active="/create" />);
    expect(screen.getByRole("heading", { level: 1, name: "你的故事，从这里开始" })).toBeTruthy();
    expect(screen.getByText("有想法直接写，没想法也可以先选一个方向。")).toBeTruthy();
    expect(screen.getByRole("link", { name: "还没想法？选一个故事方向" }).getAttribute("href")).toBe("#inspiration");
    expect(screen.getByRole("heading", { name: "还没想法？选一个故事方向" })).toBeTruthy();

    expect(picker().getAllByRole("listitem")).toHaveLength(4);
    const more = picker().getByRole("button", { name: `查看更多方向（共 ${CATEGORIES.length} 个）` });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(picker().getAllByRole("listitem")).toHaveLength(CATEGORIES.length);
    fireEvent.click(picker().getByRole("button", { name: "收起方向" }));
    expect(picker().getAllByRole("listitem")).toHaveLength(4);

    fireEvent.change(idea(), { target: { value: "我写的想法" } });
    openCard(FIRST.name);
    const detail = within(screen.getByRole("region", { name: FIRST.name }));
    expect(detail.getByText(FIRST.description)).toBeTruthy();
    expect(detail.getByText(FIRST.prompt)).toBeTruthy();
    expect(idea().value).toBe("我写的想法");
    fireEvent.click(detail.getByRole("button", { name: "收起说明" }));
    expect(idea().value).toBe("我写的想法");

    use(FIRST.name);
    expect(idea().value).toContain(premiseBlock(FIRST_DIRECTION));
    await waitFor(() => expect(calls.some((call) => call.url.endsWith("/writing/title-runs/options"))).toBe(true));
    expect(writes()).toEqual([]);
  });

  it("keeps the written idea and title, and adds the same direction only once", () => {
    serve();
    render(<BeginnerStart active="/create" />);
    fireEvent.change(idea(), { target: { value: "原有正文" } });
    fireEvent.click(screen.getByRole("button", { name: "开始构思" }));
    fireEvent.change(screen.getByLabelText("作品名称"), { target: { value: "我的剧名" } });

    use(FIRST.name);
    expect(idea().value).toBe(`原有正文\n\n${premiseBlock(FIRST_DIRECTION)}`);
    expect((screen.getByLabelText("作品名称") as HTMLInputElement).value).toBe("我的剧名");
    expect(picker().getByText("已加在「故事想法」末尾")).toBeTruthy();
    expect(screen.getByText(`已选方向：${FIRST.name}`)).toBeTruthy();

    use(FIRST.name);
    expect(screen.getByText("想法里已经有这段创作方向。")).toBeTruthy();
    expect(idea().value.split(premiseBlock(FIRST_DIRECTION))).toHaveLength(2);
    expect(window.localStorage.getItem(DIRECTION_STORAGE_KEY)).toBe(JSON.stringify(FIRST_DIRECTION));
  });

  it("switches and removes only the block it added, keeping text written before and after it", () => {
    serve();
    render(<BeginnerStart active="/create" />);
    fireEvent.change(idea(), { target: { value: "开头" } });
    use(FIRST.name);
    fireEvent.change(idea(), { target: { value: `${idea().value}\n\n结尾补充` } });

    use(SECOND.name);
    expect(idea().value).toBe(`开头\n\n结尾补充\n\n${premiseBlock(SECOND_DIRECTION)}`);
    expect(screen.getByText(/已换成新的方向/)).toBeTruthy();

    fireEvent.click(picker().getByRole("button", { name: "移除方向" }));
    expect(idea().value).toBe("开头\n\n结尾补充");
    expect(picker().queryByText("已选方向")).toBeNull();
  });

  it("leaves an edited direction text alone when switching or removing, and says so", () => {
    serve();
    render(<BeginnerStart active="/create" />);
    fireEvent.change(idea(), { target: { value: "开头" } });
    use(FIRST.name);
    const edited = idea().value.replace("请围绕", "我改过：请围绕");
    fireEvent.change(idea(), { target: { value: edited } });
    expect(picker().getByText(/方向文字已被你修改/)).toBeTruthy();

    use(SECOND.name);
    expect(idea().value).toBe(edited);
    expect(screen.getByText(/为避免误删你写的内容，正文保持不变/)).toBeTruthy();
    fireEvent.click(picker().getByRole("button", { name: `保留原文字，另外加入「${SECOND.name}」` }));
    expect(idea().value).toBe(`${edited}\n\n${premiseBlock(SECOND_DIRECTION)}`);

    fireEvent.change(idea(), { target: { value: idea().value.replace(`创作方向：${SECOND.name}`, `创作方向：${SECOND.name}（我改的）`) } });
    const before = idea().value;
    fireEvent.click(picker().getByRole("button", { name: "移除方向" }));
    expect(idea().value).toBe(before);
    expect(screen.getByText(/方向已取消选择/)).toBeTruthy();
  });

  it("does not take ownership of a direction text the user already wrote (PR #60 review)", () => {
    serve();
    render(<BeginnerStart active="/create" />);
    const pasted = `我贴进来的：\n\n${premiseBlock(FIRST_DIRECTION)}`;
    fireEvent.change(idea(), { target: { value: pasted } });
    use(FIRST.name);
    expect(idea().value).toBe(pasted);
    expect(picker().getByText(/你写的，移除时不会删除/)).toBeTruthy();
    fireEvent.click(picker().getByRole("button", { name: "移除方向" }));
    expect(idea().value).toBe(pasted);
    expect(screen.getByText(/不是本页加入的，没有删除/)).toBeTruthy();
  });

  it("does not top up an edited direction with a second copy when the same direction is used again (PR #60 review)", () => {
    serve();
    render(<BeginnerStart active="/create" />);
    use(FIRST.name);
    const edited = idea().value.replace("请围绕", "我改过：请围绕");
    fireEvent.change(idea(), { target: { value: edited } });
    use(FIRST.name);
    expect(idea().value).toBe(edited);
    expect(screen.getByText(/为避免误删你写的内容，正文保持不变/)).toBeTruthy();
  });

  it("leaves the confirm step when removing the direction empties the idea (PR #60 review)", () => {
    serve();
    render(<BeginnerStart active="/create" />);
    use(FIRST.name);
    fireEvent.click(screen.getByRole("button", { name: "开始构思" }));
    expect(screen.getByRole("button", { name: "确认创建作品" })).toBeTruthy();
    fireEvent.click(picker().getByRole("button", { name: "移除方向" }));
    expect(idea().value).toBe("");
    expect(screen.queryByRole("button", { name: "确认创建作品" })).toBeNull();
    expect(writes()).toEqual([]);
  });

  it("refuses to change the frozen draft from the inspiration section while a create is in flight", async () => {
    serve({ holdCreate: true });
    vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    render(<BeginnerStart active="/create" />);
    fireEvent.change(idea(), { target: { value: "提交中的想法" } });
    use(FIRST.name);
    fireEvent.click(screen.getByRole("button", { name: "开始构思" }));
    fireEvent.click(screen.getByRole("button", { name: "确认创建作品" }));
    await screen.findByText("正在创建，内容已锁定，完成前不能修改。");
    const frozen = idea().value;

    openCard(SECOND.name);
    const useButton = picker().getByRole("button", { name: "用这个方向" }) as HTMLButtonElement;
    expect(useButton.disabled).toBe(true);
    fireEvent.click(useButton);
    expect((picker().getByRole("button", { name: "移除方向" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(picker().getByRole("button", { name: "移除方向" }));
    expect((picker().getByRole("button", { name: "更换方向" }) as HTMLButtonElement).disabled).toBe(true);
    expect(idea().value).toBe(frozen);

    releaseCreate?.();
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0]!.body ?? "{}").premise).toBe(frozen);
  });

  it("does not take ownership of a replacement the user already wrote (PR #60 review 2)", () => {
    serve();
    render(<BeginnerStart active="/create" />);
    const userCopy = premiseBlock(SECOND_DIRECTION);
    fireEvent.change(idea(), { target: { value: userCopy } });
    use(FIRST.name);
    use(SECOND.name);
    expect(idea().value).toBe(userCopy);
    expect(picker().getByText(/你写的，移除时不会删除/)).toBeTruthy();
    fireEvent.click(picker().getByRole("button", { name: "移除方向" }));
    expect(idea().value).toBe(userCopy);
  });

  it("does not reopen confirmation for a blank restored idea, and never sends one (PR #60 review 2)", async () => {
    window.sessionStorage.setItem("ads-draft:new:project:new", JSON.stringify({ fingerprint: "x", idempotencyKey: "k", ifMatch: null,
      payload: { title: "夜班", premise: "" }, seenBaseline: null }));
    serve();
    render(<BeginnerStart active="/create" />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(screen.queryByRole("button", { name: "确认创建作品" })).toBeNull();
    expect(writes()).toEqual([]);
  });

  it("reaches every tag of the taxonomy from a direction's details", () => {
    serve();
    render(<BeginnerStart active="/create" />);
    openCard(FIRST.name);
    const detail = within(screen.getByRole("region", { name: FIRST.name }));
    expect(detail.getAllByRole("button", { pressed: true }).length + detail.getAllByRole("button", { pressed: false }).length).toBe(TAGS.length);
    const extra = TAGS.find((tag) => !(FIRST.recommended as readonly string[]).includes(tag.id))!;
    fireEvent.click(detail.getByRole("button", { name: new RegExp(extra.name) }));
    fireEvent.click(detail.getByRole("button", { name: "用这个方向" }));
    expect(idea().value).toContain(extra.name);
  });

  it("keeps the idempotency key while browsing, and after a reload treats the direction text as the user's own", async () => {
    serve();
    const view = render(<BeginnerStart active="/create" />);
    fireEvent.change(idea(), { target: { value: "刷新前的想法" } });
    use(FIRST.name);
    const key = JSON.parse(window.sessionStorage.getItem("ads-draft:new:project:new") ?? "{}").idempotencyKey as string;
    expect(key).toBeTruthy();
    fireEvent.click(picker().getByRole("button", { name: /查看更多方向/ }));
    openCard(SECOND.name);
    fireEvent.click(picker().getByRole("button", { name: "收起说明" }));
    expect(JSON.parse(window.sessionStorage.getItem("ads-draft:new:project:new") ?? "{}").idempotencyKey).toBe(key);

    view.unmount();
    render(<BeginnerStart active="/create" />);
    await waitFor(() => {
      expect(idea().value).toBe(`刷新前的想法\n\n${premiseBlock(FIRST_DIRECTION)}`);
      expect(picker().getByText(/你写的，移除时不会删除/)).toBeTruthy();
    });
    // Ownership is not inferred from matching text after a reload: nothing is removed.
    fireEvent.click(picker().getByRole("button", { name: "移除方向" }));
    expect(idea().value).toBe(`刷新前的想法\n\n${premiseBlock(FIRST_DIRECTION)}`);
  });

  it("keeps the manual path when AI writing is not enabled", async () => {
    serve({ aiCode: "TITLE_WRITING_DISABLED" });
    vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    render(<BeginnerStart active="/create" />);
    expect(await screen.findByText(/AI 一键创作没有在服务端开启/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "改为手动写想法" }).getAttribute("href")).toBe("#manual-start");
    use(FIRST.name);
    fireEvent.click(screen.getByRole("button", { name: "开始构思" }));
    fireEvent.change(screen.getByLabelText("作品名称"), { target: { value: "手动作品" } });
    fireEvent.click(screen.getByRole("button", { name: "确认创建作品" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.url).toMatch(/\/projects$/);
    expect(calls.some((call) => call.url.includes("/title-runs") && call.method === "POST")).toBe(false);
  });
});

describe("old inspiration centre entry", () => {
  it("sends /categories to the inspiration section of /create with the direction flag", () => {
    let thrown: unknown;
    try {
      CategoriesPage();
    } catch (caught) {
      thrown = caught;
    }
    expect(String((thrown as { digest?: string }).digest)).toContain(";/create?direction=1#inspiration;");
  });

  it("offers the direction saved by the old centre on the flagged link, without adding it", async () => {
    window.localStorage.setItem(DIRECTION_STORAGE_KEY, JSON.stringify(FIRST_DIRECTION));
    window.history.replaceState(null, "", "/create?direction=1#inspiration");
    serve();
    render(<BeginnerStart active="/create" />);
    expect(await picker().findByText("还没有加入想法，点「用这个方向」才会加入")).toBeTruthy();
    expect(idea().value).toBe("");
    fireEvent.click(picker().getByRole("button", { name: "用这个方向" }));
    expect(idea().value).toBe(premiseBlock(FIRST_DIRECTION));
    expect(writes()).toEqual([]);
  });
});
