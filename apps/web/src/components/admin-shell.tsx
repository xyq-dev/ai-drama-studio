"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useModalKeyboard } from "../lib/modal-keyboard";
import { loginUrl, logout, readSession } from "../lib/site-session";
import styles from "./admin-shell.module.css";

type LiveLink = { href: string; label: string; icon: string };
type NavGroup = { label: string; items: LiveLink[] };

/** Formal operator navigation. Order matches board 37:6162. */
const NAV_GROUPS: NavGroup[] = [
  {
    label: "模型与 API",
    items: [
      { href: "/admin/features", label: "功能配置", icon: "/design/tailadmin-v2/icon-sliders-horizontal.svg" },
    ],
  },
  {
    label: "创作内容",
    items: [
      { href: "/admin/works", label: "作品管理", icon: "/design/tailadmin-v2/icon-clapperboard.svg" },
      { href: "/admin/assets", label: "素材库", icon: "/design/tailadmin-v2/icon-images.svg" },
    ],
  },
  {
    label: "任务与用量",
    items: [
      { href: "/admin/jobs", label: "生成任务", icon: "/design/tailadmin-v2/icon-list-video.svg" },
      { href: "/admin/usage", label: "调用记录", icon: "/design/tailadmin-v2/icon-chart.svg" },
    ],
  },
  {
    label: "系统管理",
    items: [
      { href: "/admin/users", label: "用户与权限", icon: "/design/tailadmin-v2/icon-users-round.svg" },
      { href: "/admin/logs", label: "操作日志", icon: "/design/tailadmin-v2/icon-clipboard-list.svg" },
    ],
  },
];

function crumbFor(pathname: string): { group: string; page: string } {
  if (pathname.startsWith("/admin/works")) return { group: "创作内容", page: "作品管理" };
  if (pathname.startsWith("/admin/assets")) return { group: "创作内容", page: "素材库" };
  if (pathname.startsWith("/admin/jobs")) return { group: "任务与用量", page: "生成任务" };
  if (pathname.startsWith("/admin/usage")) return { group: "任务与用量", page: "调用记录" };
  if (pathname.startsWith("/admin/users")) return { group: "系统管理", page: "用户与权限" };
  if (pathname.startsWith("/admin/logs")) return { group: "系统管理", page: "操作日志" };
  if (pathname.startsWith("/settings/storage")) return { group: "系统管理", page: "对象存储" };
  return { group: "模型与 API", page: "功能配置" };
}

function isCurrent(pathname: string, href: string): boolean {
  if (pathname === href || pathname.startsWith(`${href}/`)) return true;
  if (href === "/admin/features" && (pathname === "/admin" || pathname.startsWith("/admin/models") || pathname.startsWith("/admin/media-keys"))) return true;
  return false;
}

type ShellAccess = "loading" | "operator" | "creator" | "signed-out" | "open" | "failed";

/** Shown outside the operator chrome. Never names the visitor as 平台管理员. */
function AccessHold({ access, pathname }: { access: Exclude<ShellAccess, "operator" | "open">; pathname: string }) {
  const loginHref = loginUrl(pathname, "signed-out");
  useEffect(() => {
    if (access === "creator") window.location.assign("/studio");
    if (access === "signed-out") window.location.assign(loginHref);
  }, [access, loginHref]);
  const copy = access === "creator"
    ? { title: "没有后台权限", body: "当前账号不能进入运营管理后台。请返回创作中心。", href: "/studio", action: "返回创作中心" }
    : access === "signed-out"
      ? { title: "请先登录", body: "进入运营管理后台前需要先登录。", href: loginHref, action: "前往登录" }
      : access === "failed"
        ? { title: "暂时无法确认身份", body: "没有读到登录状态。请刷新后再试。", href: "", action: "" }
        : { title: "正在确认身份", body: "正在核对登录身份，请稍候。", href: "", action: "" };
  return (
    <main className={styles.hold} data-ui="admin-access-hold" data-access={access}>
      <div className={styles.holdCard}>
        <h1>{copy.title}</h1>
        <p>{copy.body}</p>
        {copy.href ? <a href={copy.href}>{copy.action}</a> : null}
      </div>
    </main>
  );
}

function Brand() {
  return (
    <a className={styles.brand} href="/admin/features">
      <img className={styles.brandMark} src="/design/tailadmin-v2/brand-hongguo.svg" width={42} height={42} alt="" />
      <span>
        红果
        <small>运营管理后台</small>
      </span>
    </a>
  );
}

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/admin/features";
  const crumb = crumbFor(pathname);
  const [open, setOpen] = useState(false);
  const [wide, setWide] = useState(true);
  const [busy, setBusy] = useState(false);
  const [access, setAccess] = useState<ShellAccess>("loading");
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
    let live = true;
    setAccess("loading");
    readSession()
      .then((session) => {
        if (!live) return;
        if (!session.enabled) setAccess("open");
        else if (!session.authenticated) setAccess("signed-out");
        else if (session.role === "operator") setAccess("operator");
        else setAccess("creator");
      })
      .catch(() => { if (live) setAccess("failed"); });
    return () => { live = false; };
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
      window.location.assign(loginUrl("/admin/features", "signed-out"));
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
      {NAV_GROUPS.map((group) => (
        <div key={group.label}>
          <span className={styles.navSection}>{group.label}</span>
          <ul className={styles.navList}>
            {group.items.map((link) => {
              const current = isCurrent(pathname, link.href);
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
        </div>
      ))}
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

  if (access !== "operator" && access !== "open") {
    return <AccessHold access={access} pathname={pathname} />;
  }

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
          <Brand />
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
            {wide ? (
              <nav className={styles.breadcrumbs} aria-label="面包屑">
                <img src="/design/tailadmin-v2/icon-panels-top-left.svg" width={20} height={20} alt="" />
                <span>管理后台</span>
                <img src="/design/tailadmin-v2/icon-chevron-right.svg" width={14} height={14} alt="" />
                <span>{crumb.group}</span>
                <img src="/design/tailadmin-v2/icon-chevron-right.svg" width={14} height={14} alt="" />
                <strong>{crumb.page}</strong>
              </nav>
            ) : (
              <a className={styles.mobileBrand} href="/admin/features">
                <img src="/design/tailadmin-v2/brand-hongguo.svg" width={28} height={28} alt="" />
                <span>红果运营后台</span>
              </a>
            )}
          </div>
          {wide ? <span className={styles.sampleBadge}>运营示例</span> : (
            <button
              ref={opener}
              type="button"
              className={styles.directory}
              aria-controls={sidebarId}
              aria-label="目录"
              aria-expanded={open}
              onClick={() => setOpen(true)}
            >
              目录
              <img src="/design/tailadmin-v2/icon-chevron-right.svg" width={14} height={14} alt="" />
            </button>
          )}
        </header>
        <div className={styles.content}>{children}</div>
      </div>
    </div>
  );
}
