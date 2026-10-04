"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useModalKeyboard } from "../lib/modal-keyboard";

const LINKS = [
  { href: "/", label: "首页" },
  { href: "/studio", label: "创作中心" },
  { href: "/preview", label: "界面示例" },
] as const;

function useWideScreen() {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(min-width: 1024px)");
    const apply = () => setWide(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
  return wide;
}

export function CreatorShell({ children }: { children: ReactNode }) {
  const wide = useWideScreen();
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();

  function close() {
    setOpen(false);
    opener.current?.focus();
  }

  useModalKeyboard(open && !wide, panel, close);

  useEffect(() => {
    if (wide) setOpen(false);
  }, [wide]);

  useEffect(() => {
    if (!open || wide) return;
    panel.current?.querySelector<HTMLElement>("a, button")?.focus();
  }, [open, wide]);

  const nav = (
    <ul className="space-y-1">
      {LINKS.map((link) => (
        <li key={link.href}>
          <a className="block rounded px-3 py-2 hover:bg-[#1c2430]" href={link.href}>{link.label}</a>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="min-h-screen bg-[#0B0E14] text-[#F4F6FA]">
      <div className="lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="hidden border-r border-[#283140] p-4 lg:block" aria-label="主导航">
          <p className="px-3 text-sm font-semibold">AI Drama Studio</p>
          <nav className="mt-4">{nav}</nav>
          <p className="mt-8 px-3 text-xs text-[#AAB3C5]">帮助</p>
          <a className="mt-1 block rounded px-3 py-2 text-sm text-[#AAB3C5] hover:bg-[#1c2430]" href="/status">服务状态</a>
        </aside>
        <div className="min-w-0">
          <div className="flex items-center justify-between border-b border-[#283140] px-4 py-3 lg:hidden">
            <p className="font-semibold">AI Drama Studio</p>
            <button
              ref={opener}
              className="rounded border border-[#283140] px-3 py-1 text-sm"
              type="button"
              aria-expanded={open}
              aria-controls={titleId}
              onClick={() => setOpen(true)}
              hidden={wide}
            >
              打开导航
            </button>
          </div>
          {open ? (
            <div className="fixed inset-0 z-40 bg-black/60 lg:hidden" role="presentation">
              <div
                ref={panel}
                id={titleId}
                role="dialog"
                aria-modal="true"
                aria-label="导航"
                className="h-full w-72 overflow-y-auto border-r border-[#283140] bg-[#141A23] p-4 [overflow-wrap:anywhere]"
              >
                <button className="text-sm underline" type="button" onClick={close}>关闭导航</button>
                <nav className="mt-4">{nav}</nav>
                <p className="mt-8 text-xs text-[#AAB3C5]">帮助</p>
                <a className="mt-1 block rounded px-3 py-2 text-sm text-[#AAB3C5]" href="/status">服务状态</a>
              </div>
            </div>
          ) : null}
          {children}
        </div>
      </div>
    </div>
  );
}
