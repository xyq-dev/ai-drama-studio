// @vitest-environment happy-dom
// Keyboard/navigation tests only; no API or server is started.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BeginnerShell } from "./beginner-shell";

let resize: (wide: boolean) => void;
beforeEach(() => {
  let changed: (() => void) | undefined;
  const query = { matches: false, media: "(min-width: 1024px)", onchange: null,
    addEventListener: (_event: string, listener: () => void) => { changed = listener; },
    removeEventListener: () => { changed = undefined; }, dispatchEvent: () => false,
    addListener: () => undefined, removeListener: () => undefined };
  vi.stubGlobal("matchMedia", () => query);
  resize = (wide) => { query.matches = wide; changed?.(); };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("keeps keyboard focus in the mobile menu, restores focus on Escape and makes the editor available again", async () => {
  render(<BeginnerShell active="/create"><main><input aria-label="故事草稿" defaultValue="我的故事" /></main></BeginnerShell>);
  const opener = screen.getByRole("button", { name: "打开导航" });
  fireEvent.click(opener);
  const dialog = screen.getByRole("dialog", { name: "导航" });
  const close = within(dialog).getByRole("button", { name: "关闭导航" });
  await waitFor(() => expect(document.activeElement).toBe(close));
  expect(document.querySelector("main")?.closest("[inert]")).toBeTruthy();
  const last = within(dialog).getByRole("link", { name: "服务状态" });
  last.focus();
  fireEvent.keyDown(window, { key: "Tab" });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(opener);
  expect(document.querySelector("main")?.closest("[inert]")).toBeNull();
  expect((screen.getByRole("textbox", { name: "故事草稿" }) as HTMLInputElement).value).toBe("我的故事");
});

it("closes the mobile dialog when the desktop layout becomes active", async () => {
  render(<BeginnerShell><main>内容</main></BeginnerShell>);
  fireEvent.click(screen.getByRole("button", { name: "打开导航" }));
  act(() => resize(true));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.querySelector("main")?.closest("[inert]")).toBeNull();
  expect(screen.queryByRole("button", { name: "打开导航" })).toBeNull();
});

it("cleans up the menu's background lock when the page unmounts", () => {
  const background = document.createElement("button");
  document.body.append(background);
  const view = render(<BeginnerShell><main>内容</main></BeginnerShell>);
  fireEvent.click(screen.getByRole("button", { name: "打开导航" }));
  expect(background.hasAttribute("inert")).toBe(true);
  view.unmount();
  expect(background.hasAttribute("inert")).toBe(false);
  background.remove();
});
