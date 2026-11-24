// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AdminWorkReview } from "./admin-work-review";

afterEach(() => cleanup());

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

it("shows a retry when the session check fails and does not leave a blank page", async () => {
  let calls = 0;
  const fetchImpl = vi.fn(async (input: string) => {
    calls += 1;
    if (calls === 1 && String(input).includes("/auth/session")) throw new Error("offline");
    if (String(input).includes("/auth/session")) {
      return json({ enabled: true, authenticated: true, role: "operator", username: "admin" });
    }
    return json({
      id: "11111111-1111-4111-8111-111111111111",
      title: "雨夜来信",
      updatedAt: "2026-11-21T10:24:00.000Z",
      ownerName: "linxia",
      ownerLegacy: false,
      productionLabel: "制作中",
      episodeProgress: "共 3 集，第 1 集制作中",
      recentTask: "分镜生图进行中",
    });
  });
  render(<AdminWorkReview id="11111111-1111-4111-8111-111111111111" fetchImpl={fetchImpl} />);
  expect(await screen.findByRole("heading", { name: "作品加载失败" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
  expect(await screen.findByText("雨夜来信")).toBeTruthy();
  expect(screen.queryByText("这是创作者的作品，已转到作品管理")).toBeNull();
  expect(screen.queryByRole("link", { name: /projects/ })).toBeNull();
});

it("shows the unavailable gate instead of an empty heading", async () => {
  const fetchImpl = vi.fn(async () => json({ enabled: false }));
  render(<AdminWorkReview id="11111111-1111-4111-8111-111111111111" fetchImpl={fetchImpl} />);
  expect(await screen.findByRole("heading", { name: "作品核对尚未就绪" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "重新加载" })).toBeTruthy();
});


it("shows the redirect notice only after an authorized read of the work", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const fetchImpl = vi.fn(async (path: string, _init?: RequestInit) => path.endsWith("/auth/session")
    ? json({ enabled: true, authenticated: true, role: "operator" })
    : json({ id, title: "归还全家福", productionLabel: "制作中" }));
  render(<AdminWorkReview id={id} fromCreator fetchImpl={fetchImpl} />);
  expect((await screen.findByRole("status")).textContent).toBe("这是创作者的作品，已转到作品管理");
  expect(screen.getByText("归还全家福")).toBeTruthy();
  expect(fetchImpl.mock.calls.map(([url, init]) => [url, init?.method ?? "GET"])).toEqual([
    ["/api/v1/auth/session", "GET"], [`/api/v1/admin/works/${id}`, "GET"],
  ]);
});

it("keeps a redirected operator without review permission out of work details", async () => {
  const fetchImpl = vi.fn(async (url: string) => url.endsWith("/auth/session")
    ? json({ enabled: true, authenticated: true, role: "operator" })
    : json({}, 403));
  render(<AdminWorkReview id="11111111-1111-4111-8111-111111111111" fromCreator fetchImpl={fetchImpl} />);
  expect(await screen.findByRole("heading", { name: "没有作品管理权限" })).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
});
