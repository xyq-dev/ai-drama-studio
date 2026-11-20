"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useModalKeyboard } from "../lib/modal-keyboard";
import { loginUrl, logout } from "../lib/site-session";
import styles from "./admin-shell.module.css";

type LiveLink = { href: string; label: string; icon: string };
type PlannedItem = { label: string; icon: string; purpose: string };
type PlannedGroup = { id: string; label: string; icon: string; items: PlannedItem[] };

const LIVE_LINKS: LiveLink[] = [
  { href: "/admin/models", label: "文本模型", icon: "/design/tailadmin-v2/icon-sliders-horizontal.svg" },
  { href: "/admin/media-keys", label: "媒体密钥", icon: "/design/tailadmin-v2/icon-key-round.svg" },
];

/** Planned columns from Figma 12:2717 — expandable purpose list only, not product pages. */
const PLANNED_GROUPS: PlannedGroup[] = [
  {
    id: "creation",
    label: "创作内容",
    icon: "/design/tailadmin-v2/icon-clapperboard.svg",
    items: [
      { label: "作品管理", icon: "/design/tailadmin-v2/icon-clapperboard.svg", purpose: "查看作品及所属工作区，定位剧集和当前制作阶段。" },
      { label: "素材库", icon: "/design/tailadmin-v2/icon-images.svg", purpose: "按作品查找角色参考图、配音、分镜和成片素材。" },
    ],
  },
  {
    id: "tasks",
    label: "任务与用量",
    icon: "/design/tailadmin-v2/icon-list-video.svg",
    items: [
      { label: "生成任务", icon: "/design/tailadmin-v2/icon-list-video.svg", purpose: "查看生成进度和失败原因，定位对应作品及任务。" },
      { label: "调用记录", icon: "/design/tailadmin-v2/icon-chart.svg", purpose: "按供应商或作品查看模型调用记录和用量。" },
    ],
  },
  {
    id: "system",
    label: "系统管理",
    icon: "/design/tailadmin-v2/icon-users-round.svg",
    items: [
      { label: "用户与权限", icon: "/design/tailadmin-v2/icon-users-round.svg", purpose: "管理管理员、创作者及其工作区访问范围。" },
      { label: "操作日志", icon: "/design/tailadmin-v2/icon-clipboard-list.svg", purpose: "追踪后台配置变更，查看操作人、时间与结果。" },
    ],
  },
];

function crumbFor(pathname: string): { group: string; page: string } {
  if (pathname.startsWith("/admin/media-keys")) return { group: "模型与 API", page: "媒体密钥" };
  if (pathname.startsWith("/settings/storage")) return { group: "系统管理", page: "对象存储" };
  if (pathname.startsWith("/admin/works")) return { group: "运维", page: "作品列表" };
  return { group: "模型与 API", page: "文本模型" };
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <a className={styles.brand} href="/admin/models">
      <img className={styles.brandMark} src="/design/tailadmin-v2/brand-hongguo.svg" width={42} height={42} alt="" />
      <span>
        {compact ? "后台导航" : "红果"}
        <small>{compact ? "红果 AI Drama Studio" : "AI DRAMA STUDIO"}</small>
      </span>
    </a>
  );
}

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/admin/models";
  const crumb = crumbFor(pathname);
  const [open, setOpen] = useState(false);
  const [wide, setWide] = useState(true);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
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

  const navigation = (
    <nav
      aria-label="管理菜单"
      className={styles.navigation}
      onClick={(event) => {
        if (drawerOpen && event.target instanceof Element && event.target.closest("a[href]")) setOpen(false);
      }}
    >
      <span className={styles.navSection}>模型与 API</span>
      <ul className={styles.navList}>
        {LIVE_LINKS.map((link) => {
          const current = pathname === link.href || (link.href === "/admin/models" && pathname === "/admin");
          return (
            <li key={link.href}>
              <a className={styles.navLink} href={link.href} aria-current={current ? "page" : undefined}>
                <img src={link.icon} width={20} height={20} alt="" />
                {link.label}
              </a>
            </li>
          );
        })}
      </ul>

      <div className={styles.navDivider} aria-hidden="true" />
      <span className={styles.navSection}>规划中的栏目</span>
      <ul className={styles.navList}>
        {PLANNED_GROUPS.map((group) => {
          const isOpen = expanded === group.id;
          return (
            <li key={group.id}>
              <button
                type="button"
                className={styles.plannedToggle}
                aria-expanded={isOpen}
                onClick={() => setExpanded(isOpen ? null : group.id)}
              >
                <img src={group.icon} width={20} height={20} alt="" />
                <span>{group.label}</span>
                <img
                  className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ""}`}
                  src="/design/tailadmin-v2/icon-chevron-right.svg"
                  width={14}
                  height={14}
                  alt=""
                />
              </button>
              {isOpen ? (
                <ul className={styles.plannedItems}>
                  {group.items.map((item) => (
                    <li key={item.label}>
                      <div className={styles.plannedItem} role="group" aria-label={item.label}>
                        <div className={styles.plannedItemHead}>
                          <img src={item.icon} width={18} height={18} alt="" />
                          <strong>{item.label}</strong>
                        </div>
                        <p>{item.purpose}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </nav>
  );

  const adminFooter = (
    <div className={styles.adminFooter}>
      <div className={styles.adminIdentity}>
        {wide || drawerOpen ? (
          <>
            <span className={styles.adminAvatar} aria-hidden="true">管</span>
            <span>
              <strong>平台管理员</strong>
              <small>已登录</small>
            </span>
          </>
        ) : null}
      </div>
      <div className={styles.adminActions}>
        <a className={styles.footerLink} href="/studio">返回创作中心</a>
        <button type="button" className={styles.footerLink} onClick={() => void signOut()} disabled={busy}>
          {busy ? "正在退出…" : "退出"}
        </button>
      </div>
    </div>
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
        <div className={styles.sidebarHead}>
          <Brand compact={drawerOpen} />
          {drawerOpen ? (
            <button className={styles.close} type="button" aria-label="关闭菜单" onClick={() => setOpen(false)}>
              <img src="/design/tailadmin-v2/icon-x.svg" width={20} height={20} alt="" />
            </button>
          ) : null}
        </div>
        {navigation}
        {adminFooter}
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
            {wide ? (
              <nav className={styles.breadcrumbs} aria-label="面包屑">
                <img src="/design/tailadmin-v2/icon-panels-top-left.svg" width={20} height={20} alt="" />
                <span>管理控制台</span>
                <img src="/design/tailadmin-v2/icon-chevron-right.svg" width={14} height={14} alt="" />
                <span>{crumb.group}</span>
                <img src="/design/tailadmin-v2/icon-chevron-right.svg" width={14} height={14} alt="" />
                <strong>{crumb.page}</strong>
              </nav>
            ) : (
              <a className={styles.mobileBrand} href="/admin/models">
                <img src="/design/tailadmin-v2/brand-hongguo.svg" width={28} height={28} alt="" />
                <span>红果管理控制台</span>
              </a>
            )}
          </div>
        </header>
        <div className={styles.content}>{children}</div>
      </div>
    </div>
  );
}
