"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useModalKeyboard } from "../lib/modal-keyboard";
import styles from "./creator-shell.module.css";

const LINKS = [
  { href: "/", label: "首页" },
  { href: "/studio", label: "创作中心" },
  { href: "/categories", label: "分类中心" },
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

export function CreatorShell({ children, appearance = "dark", activePath }: { children: ReactNode; appearance?: "dark" | "light"; activePath?: string }) {
  const light = appearance === "light";
  const wide = useWideScreen();
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const openedRef = useRef(false);
  const titleId = useId();

  function close() {
    setOpen(false);
  }

  useModalKeyboard(open && !wide, panel, close);

  useEffect(() => {
    if (wide) setOpen(false);
  }, [wide]);

  useEffect(() => {
    if (open && !wide) {
      openedRef.current = true;
      panel.current?.querySelector<HTMLElement>("a, button")?.focus();
    } else if (openedRef.current) {
      openedRef.current = false;
      // The modal hook has removed inert before restoring focus.
      if (!wide) opener.current?.focus();
    }
  }, [open, wide]);

  const nav = (
    <ul className="space-y-1">
      {LINKS.map((link) => (
        <li key={link.href}>
          <a className={light ? styles.navLink : "block rounded px-3 py-2 hover:bg-[#1c2430]"} href={link.href} aria-current={activePath === link.href ? "page" : undefined}>
            {light ? <span className={styles.navIcon} aria-hidden="true">{link.href === "/categories" ? "▦" : link.href === "/studio" ? "▱" : link.href === "/preview" ? "▷" : "⌂"}</span> : null}
            {link.label}
          </a>
        </li>
      ))}
    </ul>
  );

  return (
    <div className={light ? styles.shell : "min-h-screen bg-[#0B0E14] text-[#F4F6FA]"}>
      <div className={light ? styles.layout : "lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]"}>
        <aside className={light ? styles.sidebar : "hidden border-r border-[#283140] p-4 lg:block"} aria-label="主导航">
          {light ? <a className={styles.brand} href="/"><span className={styles.brandMark} aria-hidden="true">▶</span><span>AI Drama Studio<small>让好故事，被看见</small></span></a> : <p className="px-3 text-sm font-semibold">AI Drama Studio</p>}
          <nav className="mt-4">{nav}</nav>
          <p className="mt-8 px-3 text-xs text-[#AAB3C5]">帮助</p>
          <a className={light ? styles.helpLink : "mt-1 block rounded px-3 py-2 text-sm text-[#AAB3C5] hover:bg-[#1c2430]"} href="/status">服务状态 <span aria-hidden="true">↗</span></a>
          {light ? <div className={styles.sidebarBottom}><div className={styles.promo}><strong>用好故事<br />连接更多人</strong><span>从一个灵感开始创作</span><i aria-hidden="true">▶</i></div><p>AI Drama Studio · 创作工具</p></div> : null}
        </aside>
        <div className="min-w-0">
          <div className={light ? styles.mobileHeader : "flex items-center justify-between border-b border-[#283140] px-4 py-3 lg:hidden"}>
            <p className="font-semibold">AI Drama Studio</p>
            <button
              ref={opener}
              className={light ? styles.menuButton : "rounded border border-[#283140] px-3 py-1 text-sm"}
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
                className={light ? styles.drawer : "h-full w-72 overflow-y-auto border-r border-[#283140] bg-[#141A23] p-4 [overflow-wrap:anywhere]"}
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
