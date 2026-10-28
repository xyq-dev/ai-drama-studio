"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useModalKeyboard } from "../lib/modal-keyboard";
import { AccountControl } from "./account-control";
import styles from "./creator-shell.module.css";

const LINKS = [
  { href: "/studio", label: "我的作品", icon: "works" },
  { href: "/create", label: "开始创作", icon: "create" },
  { href: "/preview", label: "界面示例", icon: "preview" },
  { href: "/help", label: "帮助", icon: "help" },
  { href: "/status", label: "服务状态", icon: "status" },
] as const;

function NavIcon({ icon }: { icon: (typeof LINKS)[number]["icon"] }) {
  return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {icon === "works" ? <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m10 9 5 3-5 3Z" /></> : null}
    {icon === "create" ? <><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></> : null}
    {icon === "preview" ? <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m10 8 5 4-5 4Z" /></> : null}
    {icon === "status" ? <><path d="M3 12h4l3-7 4 14 3-7h4" /></> : null}
    {icon === "help" ? <><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 0 1 5 .5c0 1.5-2.5 1.5-2.5 3M12 16h.01" /></> : null}
  </svg>;
}

function Brand() {
  return <a className={styles.brand} href="/"><span className={styles.brandMark} aria-hidden="true"><span /></span><span>红果创作<small>把故事，做成短剧</small></span></a>;
}

/** Presentation frame only. The existing editors own all project state and business actions. */
export function CreatorShell({ children, activePath }: { children: ReactNode; activePath?: string }) {
  const [open, setOpen] = useState(false);
  const [wide, setWide] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  const dialogId = useId();
  const currentSection = LINKS.find((link) => link.href === activePath)?.label ?? "创作中心";
  useModalKeyboard(open && !wide, panel, () => setOpen(false));

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(min-width: 1024px)");
    const sync = () => { setWide(query.matches); if (query.matches) setOpen(false); };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (open && !wide) {
      wasOpen.current = true;
      panel.current?.querySelector<HTMLElement>("button, a")?.focus();
    } else if (wasOpen.current) {
      wasOpen.current = false;
      if (!wide) opener.current?.focus();
    }
  }, [open, wide]);

  const navigation = <nav aria-label="主导航" className={styles.navigation}><ul>
    {LINKS.map((link) => <li key={link.href} className={link.icon === "preview" ? styles.help : undefined}>
      {link.icon === "works" || link.icon === "preview" ? <span className={styles.navSection} aria-hidden="true">{link.icon === "works" ? "创作工作区" : "了解与帮助"}</span> : null}
      <a className={styles.navLink} href={link.href} aria-current={activePath === link.href ? "page" : undefined}>
        <NavIcon icon={link.icon} />{link.label}
      </a>
    </li>)}
  </ul></nav>;

  return <div className={`creator-app ${styles.shell}`} data-ui="hongguo">
    <a className={styles.skip} href="#main">跳到正文</a>
    <aside className={styles.sidebar}><Brand />{navigation}<p className={styles.footer}><span>从一个想法，到一部作品。</span>每个好故事，都值得被看见</p></aside>
    <div className={styles.page}>
      <header className={styles.topbar} aria-label="工作区页眉">
        <p>创作工作区<span aria-hidden="true">/</span><strong>{currentSection}</strong></p>
        <div className={styles.topbarActions}><span className={styles.previewBadge}>开发预览</span><a href="/help">查看创作指南<span aria-hidden="true"> ↗</span></a><AccountControl variant="header" /></div>
      </header>
      <header className={styles.mobileHeader}><Brand /><button ref={opener} type="button" className={styles.menu}
        aria-expanded={open} aria-controls={dialogId} onClick={() => setOpen(true)} hidden={wide}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
        <span className="sr-only">打开导航</span>
      </button></header>
      <div id="main" tabIndex={-1}>{children}</div>
    </div>
    {open ? <div className={styles.backdrop} role="presentation">
      <div ref={panel} id={dialogId} role="dialog" aria-modal="true" aria-label="导航" className={styles.drawer}>
        <button className={styles.close} type="button" onClick={() => setOpen(false)}>关闭导航 <span aria-hidden="true">×</span></button>
        <Brand />{navigation}
        <AccountControl variant="drawer" />
      </div>
    </div> : null}
  </div>;
}
