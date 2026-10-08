// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { CreatorShell } from "./creator-shell";
import { BeginnerShell } from "./beginner-shell";

afterEach(cleanup);

const destinations = [
  ["/studio", "我的作品"], ["/create", "开始创作"], ["/categories", "灵感中心"],
  ["/preview", "界面示例"], ["/help", "帮助"], ["/status", "服务状态"],
] as const;

it.each(destinations)("keeps the same destinations and marks the current page at %s", (path, label) => {
  render(<CreatorShell activePath={path}><main>内容</main></CreatorShell>);
  const nav = screen.getByRole("navigation", { name: "主导航" });
  expect(within(nav).getAllByRole("link").map((link) => [link.getAttribute("href"), link.textContent])).toEqual(destinations);
  expect(within(nav).getByRole("link", { name: label }).getAttribute("aria-current")).toBe("page");
  expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  expect(document.querySelectorAll('[data-ui="hongguo"]')).toHaveLength(1);
});

it("uses the identical navigation and content frame for guided creation", () => {
  const view = render(<BeginnerShell active="/studio"><main>我的故事</main></BeginnerShell>);
  const navigation = screen.getByRole("navigation", { name: "主导航" }).innerHTML;
  view.rerender(<CreatorShell activePath="/studio"><main>我的故事</main></CreatorShell>);
  expect(screen.getByRole("navigation", { name: "主导航" }).innerHTML).toBe(navigation);
  expect(screen.getByRole("link", { name: "跳到正文" }).getAttribute("href")).toBe("#main");
  expect(document.querySelector("#main")?.textContent).toBe("我的故事");
});
