// @vitest-environment happy-dom
// Exercises confirmation, CAS, uncertain responses and recovery against mocked HTTP responses.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectTrashButton, RecycleBin } from "./recycle-bin";

const P = "11111111-1111-4111-8111-111111111111";
const E = "22222222-2222-4222-8222-222222222222";
const R = "33333333-3333-4333-8333-333333333333";
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function preview(overrides = {}) {
  return { kind: "project", projectId: P, title: "无名碑", version: 7, episodeCount: 3,
    dependencies: { scenes: 2, shots: 4, speech: 2, video: 1, other: 0, total: 9 },
    canDelete: true, blockedReason: null, ...overrides };
}
function projectTrash(overrides = {}) {
  return { kind: "project", id: P, projectId: P, title: "无名碑", version: 8, deletedAt: "2026-11-11T01:00:00Z", ...overrides };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("作品删除确认", () => {
  it("loads exact scope before enabling confirmation and only then sends a versioned deletion", async () => {
    const posts: Array<{ path: string; body: unknown; version: string | null }> = [];
    let answer!: (response: Response) => void;
    const onDeleted = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push({ path, body: JSON.parse(String(init.body)), version: new Headers(init.headers).get("If-Match") });
        return json({ projectId: P, version: 8 });
      }
      expect(path).toBe(`/api/v1/projects/${P}/script-workbench/deletion-preview`);
      return new Promise<Response>((resolve) => { answer = resolve; });
    }));
    render(<ProjectTrashButton projectId={P} title="无名碑" onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole("button", { name: "删除作品：无名碑" }));
    expect((screen.getByRole("button", { name: "移入回收站" }) as HTMLButtonElement).disabled).toBe(true);
    expect(posts).toHaveLength(0);
    await act(async () => answer(json(preview())));
    expect(await screen.findByText("全部 3 集 · 作品版本 7")).toBeTruthy();
    expect(screen.getByText("分镜：4")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "移入回收站" }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
    expect(posts).toEqual([{ path: `/api/v1/projects/${P}/script-workbench/trash`, body: { expectedVersion: 7 }, version: "7" }]);
  });

  it("blocks a changed or busy project and keeps cancellation available", async () => {
    const fetch = vi.fn(async () => json(preview({ canDelete: false, blockedReason: "作品有正在进行的生成任务。" })));
    vi.stubGlobal("fetch", fetch);
    render(<ProjectTrashButton projectId={P} title="无名碑" onDeleted={vi.fn()} />);
    const opener = screen.getByRole("button", { name: "删除作品：无名碑" });
    fireEvent.click(opener);
    expect((await screen.findByRole("alert")).textContent).toContain("正在进行的生成任务");
    expect((screen.getByRole("button", { name: "移入回收站" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("retains its idempotency key after an uncertain response", async () => {
    const keys: Array<string | null> = [];
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        keys.push(new Headers(init.headers).get("Idempotency-Key"));
        if (keys.length === 1) throw new TypeError("connection lost");
        return json({ projectId: P, version: 8 });
      }
      return json(preview());
    }));
    const onDeleted = vi.fn();
    render(<ProjectTrashButton projectId={P} title="无名碑" onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole("button", { name: "删除作品：无名碑" }));
    await screen.findByText("全部 3 集 · 作品版本 7");
    fireEvent.click(screen.getByRole("button", { name: "移入回收站" }));
    expect((await screen.findByRole("alert")).textContent).toContain("删除结果尚未确认");
    expect(onDeleted).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "移入回收站" }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it("requires reading and reviewing a fresh preview after a conflict", async () => {
    let version = 7;
    const writes: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        writes.push(JSON.parse(String(init.body)).expectedVersion);
        if (writes.length === 1) { version = 9; return json({ error: { code: "VERSION_CONFLICT", message: "作品已被更新。" } }, 409); }
        return json({ projectId: P, version: 10 });
      }
      return json(preview({ version }));
    }));
    render(<ProjectTrashButton projectId={P} title="无名碑" onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "删除作品：无名碑" }));
    await screen.findByText("全部 3 集 · 作品版本 7");
    fireEvent.click(screen.getByRole("button", { name: "移入回收站" }));
    await screen.findByRole("alert");
    expect((screen.getByRole("button", { name: "移入回收站" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "重新核对" }));
    await screen.findByText("全部 3 集 · 作品版本 9");
    expect(writes).toEqual([7]);
    fireEvent.click(screen.getByRole("button", { name: "移入回收站" }));
    await waitFor(() => expect(writes).toEqual([7, 9]));
  });
});

describe("回收站恢复", () => {
  it("restores a script revision with its episode version and never auto-approves it", async () => {
    const writes: Array<{ path: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") { writes.push({ path, body: JSON.parse(String(init.body)) }); return json({ revisionId: R, rowVersion: 9, restoredAsHistory: true }); }
      return json({ items: writes.length ? [] : [projectTrash({ kind: "script", id: R, episodeId: E, episodeNo: 2, revisionNo: 3 })], nextCursor: null });
    }));
    render(<RecycleBin />);
    fireEvent.click(await screen.findByRole("button", { name: "恢复第 2 集 v3：无名碑" }));
    expect((await screen.findByRole("status")).textContent).toContain("未自动定稿或开启制作");
    expect(writes).toEqual([{ path: `/api/v1/projects/${P}/episodes/${E}/scripts/${R}/restore`, body: { expectedVersion: 8 } }]);
    expect(await screen.findByRole("heading", { name: "回收站是空的" })).toBeTruthy();
  });

  it("keeps failed restores visible and reuses the request identity on retry", async () => {
    const keys: Array<string | null> = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        expect(path).toBe(`/api/v1/projects/${P}/script-workbench/restore`);
        keys.push(new Headers(init.headers).get("Idempotency-Key"));
        if (keys.length === 1) throw new TypeError("connection lost");
        return json({ projectId: P, version: 9 });
      }
      return json({ items: keys.length > 1 ? [] : [projectTrash()], nextCursor: null });
    }));
    render(<RecycleBin />);
    fireEvent.click(await screen.findByRole("button", { name: "恢复作品：无名碑" }));
    expect((await screen.findByRole("alert")).textContent).toContain("恢复结果尚未确认");
    fireEvent.click(screen.getByRole("button", { name: "恢复作品：无名碑" }));
    expect((await screen.findByRole("status")).textContent).toContain("已恢复《无名碑》");
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it("loads additional deleted content once and preserves earlier entries", async () => {
    const paths: string[] = [];
    let answer!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      paths.push(path);
      if (path.includes("cursor=")) return new Promise<Response>((resolve) => { answer = resolve; });
      return json({ items: [projectTrash()], nextCursor: "page-two" });
    }));
    render(<RecycleBin />);
    const more = await screen.findByRole("button", { name: "加载更多已删除内容" });
    fireEvent.click(more);
    fireEvent.click(more);
    expect(paths.filter((path) => path.includes("cursor="))).toEqual(["/api/v1/script-workbench/trash?cursor=page-two"]);
    await act(async () => answer(json({ items: [projectTrash({ kind: "script", id: R, episodeId: E, episodeNo: 2, revisionNo: 3 })], nextCursor: null })));
    expect(screen.getByRole("button", { name: "恢复作品：无名碑" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "恢复第 2 集 v3：无名碑" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "加载更多已删除内容" })).toBeNull();
  });
});
