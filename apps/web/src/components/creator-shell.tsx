"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useModalKeyboard } from "../lib/modal-keyboard";
import { AccountControl } from "./account-control";
import styles from "./creator-shell.module.css";

const LINKS = [
  { href: "/studio", label: "我的作品", icon: "works" },
  { href: "/preview", label: "界面示例", icon: "preview" },
  { href: "/status", label: "服务状态", icon: "status" },
  { href: "/settings/storage", label: "设置", icon: "settings" },
] as const;

function NavIcon({ icon }: { icon: (typeof LINKS)[number]["icon"] }) {
  const file = icon === "works" || icon === "preview" ? "nav-icon" : `icon-${icon}`;
  return <img src={`/design/tailadmin-v2/${file}.svg`} width={20} height={20} alt="" />;
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <a className={`${styles.brand} ${compact ? styles.compactBrand : ""}`} href="/">
    <span className={styles.brandMark} aria-hidden="true"><img src="/design/tailadmin-v2/icon-works.svg" width={24} height={24} alt="" /></span>
    <span>红果创作<small>HONGGUO STUDIO</small></span>
  </a>;
}

type CreatorShellProps = {
  children: ReactNode;
  activePath?: string;
  workspaceNavigation?: ReactNode;
  headerContent?: ReactNode;
};

/** Presentation frame only. The existing editors own all project state and business actions. */
export function CreatorShell({ children, activePath, workspaceNavigation, headerContent }: CreatorShellProps) {
  const [open, setOpen] = useState(false);
  const [wide, setWide] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const wasOpen = useRef(false);
  const sidebarId = useId();
  const drawerOpen = open && !wide;
  const sidebarHidden = wide ? collapsed : !open;
  const currentSection = LINKS.find((link) => link.href === activePath)?.label ?? (activePath === "/create" ? "开始创作" : activePath === "/help" ? "创作指南" : "创作中心");
  useModalKeyboard(drawerOpen, panel, () => setOpen(false));

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(min-width: 1024px)");
    const sync = () => { setWide(query.matches); if (query.matches) setOpen(false); };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (drawerOpen) {
      wasOpen.current = true;
      panel.current?.querySelector<HTMLElement>("button, a")?.focus();
    } else if (wasOpen.current) {
      wasOpen.current = false;
      // A category action can replace the drawer with its own dialog in the same
      // render. Let that dialog keep focus instead of returning it to the menu.
      const anotherDialog = document.querySelector('[role="dialog"][aria-modal="true"]');
      if (!anotherDialog) opener.current?.focus();
    }
  }, [drawerOpen]);

  const navigation = <nav aria-label="主导航" className={styles.navigation} onClick={(event) => {
    if (drawerOpen && event.target instanceof Element && event.target.closest("a[href], button:not([disabled])")) setOpen(false);
  }}><ul>
    {LINKS.map((link) => <li key={link.href} className={link.icon === "preview" ? styles.more : undefined}>
      {link.icon === "works" || link.icon === "preview" ? <span className={styles.navSection} aria-hidden="true">{link.icon === "works" ? "创作工作区" : "更多"}</span> : null}
      <a className={styles.navLink} href={link.href} aria-current={activePath === link.href ? "page" : undefined}>
        <NavIcon icon={link.icon} />{link.label}
      </a>
      {link.icon === "works" ? workspaceNavigation : null}
    </li>)}
  </ul></nav>;

  return <div className={`creator-app ${styles.shell} ${collapsed ? styles.collapsed : ""}`} data-ui="hongguo">
    <a className={styles.skip} href="#main">跳到正文</a>
    {drawerOpen ? <div className={styles.backdrop} aria-hidden="true" onClick={() => setOpen(false)} /> : null}
    <aside ref={panel} id={sidebarId} className={`${styles.sidebar} ${drawerOpen ? styles.drawer : ""}`}
      hidden={sidebarHidden} role={drawerOpen ? "dialog" : undefined} aria-modal={drawerOpen ? true : undefined} aria-label={drawerOpen ? "导航" : undefined}>
      {drawerOpen ? <button className={styles.close} type="button" onClick={() => setOpen(false)}>关闭导航 <span aria-hidden="true">×</span></button> : null}
      <Brand />{navigation}
      <p className={styles.footer}><span>把故事，做成短剧</span>每个好故事，都值得被看见。</p>
      {drawerOpen ? <AccountControl variant="drawer" /> : null}
    </aside>
    <div className={styles.page}>
      <header className={styles.topbar} aria-label="工作区页眉">
        <div className={styles.headerMain}>
          <button ref={opener} type="button" className={styles.menu} aria-controls={sidebarId}
            aria-label={wide ? collapsed ? "展开侧栏" : "收起侧栏" : "打开导航"}
            aria-expanded={wide ? !collapsed : open} onClick={() => wide ? setCollapsed((value) => !value) : setOpen(true)}>
            <img src="/design/tailadmin-v2/icon-menu.svg" width={20} height={20} alt="" />
          </button>
          <div className={styles.headerContent}>{headerContent ?? <p className={styles.breadcrumb}>创作工作区<span aria-hidden="true">/</span><strong>{currentSection}</strong></p>}</div>
          <div className={styles.mobileBrand}><Brand compact /></div>
        </div>
        <div className={styles.topbarActions}><a className={styles.guide} href="/help">创作指南<span aria-hidden="true"> ↗</span></a><AccountControl variant="header" /></div>
      </header>
      <div id="main" tabIndex={-1}>{children}</div>
    </div>
  </div>;
}
