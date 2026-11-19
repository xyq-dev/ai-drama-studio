"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useModalKeyboard } from "../lib/modal-keyboard";
import { loginUrl, logout } from "../lib/site-session";
import styles from "./admin-shell.module.css";

/** Phase-1 admin sidebar only. No Pro demo routes, recharge, membership, or storage nav. */
const LINKS = [
  { href: "/admin/models", label: "文本模型", icon: "document" },
  { href: "/admin/media-keys", label: "媒体密钥", icon: "key" },
] as const;

function Brand() {
  return (
    <a className={styles.brand} href="/admin/models">
      <span className={styles.brandMark} aria-hidden="true">红</span>
      <span>红果创作<small>管理员控制台</small></span>
    </a>
  );
}

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/admin/models";
  const [open, setOpen] = useState(false);
  const [wide, setWide] = useState(true);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const opener = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const wasOpen = useRef(false);
  const sidebarId = useId();
  const drawerOpen = open && !wide;

  useModalKeyboard(drawerOpen, panel, () => setOpen(false));

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(min-width: 1024px)");
    const sync = () => {
      setWide(query.matches);
      if (query.matches) setOpen(false);
    };
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
      opener.current?.focus();
    }
  }, [drawerOpen]);

  async function signOut() {
    if (busy) return;
    setBusy(true);
    try {
      await logout();
      window.location.assign(loginUrl("/admin/models", "signed-out"));
    } catch {
      setBusy(false);
    }
  }

  const filtered = LINKS.filter((link) => !search.trim() || link.label.includes(search.trim()));

  const navigation = (
    <nav aria-label="管理菜单" className={styles.navigation} onClick={(event) => {
      if (drawerOpen && event.target instanceof Element && event.target.closest("a[href]")) setOpen(false);
    }}>
      <span className={styles.navSection}>菜单</span>
      <ul>
        {filtered.map((link) => (
          <li key={link.href}>
            <a
              className={styles.navLink}
              href={link.href}
              aria-current={pathname === link.href || (link.href === "/admin/models" && pathname === "/admin") ? "page" : undefined}
            >
              <img
                src={link.icon === "key" ? "/design/tailadmin-v2/icon-settings.svg" : "/design/tailadmin-v2/icon-script-ai.svg"}
                width={20}
                height={20}
                alt=""
              />
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );

  return (
    <div className={styles.shell} data-ui="hongguo-admin">
      {drawerOpen ? <div className={styles.backdrop} aria-hidden="true" onClick={() => setOpen(false)} /> : null}
      <aside
        ref={panel}
        id={sidebarId}
        className={`${styles.sidebar} ${drawerOpen ? styles.drawer : ""}`}
        hidden={!wide && !open}
        role={drawerOpen ? "dialog" : undefined}
        aria-modal={drawerOpen ? true : undefined}
        aria-label={drawerOpen ? "管理导航" : undefined}
      >
        {drawerOpen ? (
          <button className={styles.close} type="button" onClick={() => setOpen(false)}>
            关闭菜单 <span aria-hidden="true">×</span>
          </button>
        ) : null}
        <Brand />
        {navigation}
      </aside>
      <div className={styles.page}>
        <header className={styles.topbar} aria-label="管理控制台页眉">
          <div className={styles.headerMain}>
            <button
              ref={opener}
              type="button"
              className={styles.menu}
              aria-controls={sidebarId}
              aria-label={wide ? "导航" : "打开导航"}
              aria-expanded={wide ? true : open}
              onClick={() => { if (!wide) setOpen(true); }}
            >
              <img src="/design/tailadmin-v2/icon-menu.svg" width={20} height={20} alt="" />
            </button>
            <label className={styles.search}>
              <img src="/design/tailadmin-v2/icon-search.svg" width={16} height={16} alt="" />
              <input
                type="search"
                placeholder="搜索设置…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                aria-label="搜索设置"
              />
            </label>
          </div>
          <div className={styles.topbarActions}>
            <a className={styles.secondary} href="/studio">返回创作中心</a>
            {/* Always render 退出 so SSR markup matches the client (do not gate on document.cookie / csrfToken). */}
            <button type="button" className={styles.secondary} onClick={() => void signOut()} disabled={busy}>
              {busy ? "正在退出…" : "退出"}
            </button>
            <span className={styles.sessionBadge}>
              <span className={styles.sessionDot} aria-hidden="true" />
              <span>管理员会话有效</span>
            </span>
          </div>
        </header>
        <div className={styles.content}>{children}</div>
      </div>
    </div>
  );
}
