"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import {
  AI_MODELS_CATALOG_HREF,
  AI_MODEL_VENDORS,
  isAiModelsPath,
  isFeatureConfigPath,
} from "../lib/ai-model-vendors";
import { useModalKeyboard } from "../lib/modal-keyboard";
import { loginUrl, logout, readSession } from "../lib/site-session";
import styles from "./admin-shell.module.css";

type LiveLink = { href: string; label: string; icon: string };
type NavGroup = { label: string; items: LiveLink[] };

/** Formal operator navigation. 「AI 大模型」and「功能配置」are sibling top-level entries (NAV-FIX.md). */
const PRIMARY_LINKS: LiveLink[] = [
  {
    href: AI_MODELS_CATALOG_HREF,
    label: "AI 大模型",
    icon: "/design/tailadmin-v2/icon-ai-models.svg",
  },
  {
    href: "/admin/features",
    label: "功能配置",
    icon: "/design/tailadmin-v2/icon-sliders-horizontal.svg",
  },
];

const NAV_GROUPS: NavGroup[] = [
  {
    label: "创作内容",
    items: [
      {
        href: "/admin/works",
        label: "作品管理",
        icon: "/design/tailadmin-v2/icon-clapperboard.svg",
      },
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
      {
        href: "/admin/users",
        label: "用户与权限",
        icon: "/design/tailadmin-v2/icon-users-round.svg",
      },
      {
        href: "/admin/membership",
        label: "会员管理",
        icon: "/design/tailadmin-v2/icon-users-round.svg",
      },
      {
        href: "/admin/logs",
        label: "操作日志",
        icon: "/design/tailadmin-v2/icon-clipboard-list.svg",
      },
    ],
  },
];

function crumbFor(pathname: string): string[] {
  if (isFeatureConfigPath(pathname)) return ["管理后台", "功能配置", "模型与密钥"];
  if (pathname === AI_MODELS_CATALOG_HREF) return ["管理后台", "AI 大模型", "模型供应商"];
  if (isAiModelsPath(pathname)) {
    const vendor = AI_MODEL_VENDORS.find((item) => pathname === item.href);
    return ["管理后台", "AI 大模型", vendor?.shortLabel ?? "模型供应商"];
  }
  if (pathname.startsWith("/admin/works")) return ["管理后台", "创作内容", "作品管理"];
  if (pathname.startsWith("/admin/assets")) return ["管理后台", "创作内容", "素材库"];
  if (pathname.startsWith("/admin/jobs")) return ["管理后台", "任务与用量", "生成任务"];
  if (pathname.startsWith("/admin/usage")) return ["管理后台", "任务与用量", "调用记录"];
  if (pathname.startsWith("/admin/users")) return ["管理后台", "系统管理", "用户与权限"];
  if (pathname.startsWith("/admin/membership")) return ["管理后台", "系统管理", "会员管理"];
  if (pathname.startsWith("/admin/logs")) return ["管理后台", "系统管理", "操作日志"];
  if (pathname.startsWith("/settings/storage")) return ["管理后台", "系统管理", "对象存储"];
  return ["管理后台", "功能配置", "模型与密钥"];
}

function mobileCategory(pathname: string): string {
  if (isAiModelsPath(pathname)) return "AI 大模型";
  if (isFeatureConfigPath(pathname)) return "功能配置";
  const items = crumbFor(pathname);
  return items[1] ?? "功能配置";
}

function isCurrent(pathname: string, href: string): boolean {
  if (href === AI_MODELS_CATALOG_HREF) return isAiModelsPath(pathname);
  if (href === "/admin/features") return isFeatureConfigPath(pathname);
  return pathname === href || pathname.startsWith(`${href}/`);
}

type ShellAccess = "loading" | "operator" | "creator" | "signed-out" | "open" | "failed";

/** Shown outside the operator chrome. Never names the visitor as 平台管理员. */
function AccessHold({
  access,
  pathname,
}: {
  access: Exclude<ShellAccess, "operator" | "open">;
  pathname: string;
}) {
  const loginHref = loginUrl(pathname, "signed-out");
  useEffect(() => {
    if (access === "creator") window.location.assign("/studio");
    if (access === "signed-out") window.location.assign(loginHref);
  }, [access, loginHref]);
  const copy =
    access === "creator"
      ? {
          title: "没有后台权限",
          body: "当前账号不能进入运营管理后台。请返回创作中心。",
          href: "/studio",
          action: "返回创作中心",
        }
      : access === "signed-out"
        ? {
            title: "请先登录",
            body: "进入运营管理后台前需要先登录。",
            href: loginHref,
            action: "前往登录",
          }
        : access === "failed"
          ? {
              title: "暂时无法确认身份",
              body: "没有读到登录状态。请刷新后再试。",
              href: "",
              action: "",
            }
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
      <img
        className={styles.brandMark}
        src="/design/tailadmin-v2/brand-hongguo.svg"
        width={42}
        height={42}
        alt=""
      />
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
      .catch(() => {
        if (live) setAccess("failed");
      });
    return () => {
      live = false;
    };
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
        if (drawerOpen && event.target instanceof Element && event.target.closest("a[href]"))
          setOpen(false);
      }}
    >
      <ul className={styles.navList}>
        {PRIMARY_LINKS.map((link) => {
          const current = isCurrent(pathname, link.href);
          const expandVendors = link.href === AI_MODELS_CATALOG_HREF && isAiModelsPath(pathname);
          return (
            <li key={link.href}>
              <a
                className={styles.navLink}
                href={link.href}
                aria-current={current ? "page" : undefined}
              >
                <img src={link.icon} width={20} height={20} alt="" />
                {link.label}
              </a>
              {expandVendors ? (
                <ul className={styles.subnav} aria-label="供应商">
                  {AI_MODEL_VENDORS.map((vendor) => {
                    const selected = pathname === vendor.href;
                    return (
                      <li key={vendor.id}>
                        <a
                          className={styles.subnavLink}
                          href={vendor.href}
                          aria-current={selected ? "page" : undefined}
                        >
                          {vendor.label}
                        </a>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
      {NAV_GROUPS.map((group) => (
        <div key={group.label}>
          <span className={styles.navSection}>{group.label}</span>
          <ul className={styles.navList}>
            {group.items.map((link) => {
              const current = isCurrent(pathname, link.href);
              return (
                <li key={link.href}>
                  <a
                    className={styles.navLink}
                    href={link.href}
                    aria-current={current ? "page" : undefined}
                  >
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
            <span className={styles.adminAvatar} aria-hidden="true">
              管
            </span>
            <span>
              <strong>平台管理员</strong>
              <small>已登录</small>
            </span>
          </>
        ) : null}
      </div>
      <div className={styles.adminActions}>
        <a className={styles.footerLink} href="/studio">
          返回创作中心
        </a>
        <button
          type="button"
          className={styles.footerLink}
          onClick={() => void signOut()}
          disabled={busy}
        >
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
      {drawerOpen ? (
        <div className={styles.backdrop} aria-hidden="true" onClick={() => setOpen(false)} />
      ) : null}
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
            <button
              className={styles.close}
              type="button"
              aria-label="关闭菜单"
              onClick={() => setOpen(false)}
            >
              关闭
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
                <img
                  src="/design/tailadmin-v2/icon-panels-top-left.svg"
                  width={20}
                  height={20}
                  alt=""
                />
                {crumb.map((item, index) => (
                  <span key={`${item}-${index}`} className={styles.crumbItem}>
                    {index > 0 ? (
                      <span className={styles.crumbSlash} aria-hidden="true">
                        /
                      </span>
                    ) : null}
                    {index === crumb.length - 1 ? <strong>{item}</strong> : item}
                  </span>
                ))}
              </nav>
            ) : (
              <a className={styles.mobileBrand} href="/admin/features">
                <img src="/design/tailadmin-v2/brand-hongguo.svg" width={28} height={28} alt="" />
                <span>红果运营后台</span>
              </a>
            )}
          </div>
          {wide ? (
            <span className={styles.sampleBadge}>运营示例</span>
          ) : (
            <button
              ref={opener}
              type="button"
              className={styles.directory}
              aria-controls={sidebarId}
              aria-label={`打开${mobileCategory(pathname)}目录`}
              aria-expanded={open}
              onClick={() => setOpen(true)}
            >
              <img src="/design/tailadmin-v2/icon-menu.svg" width={18} height={18} alt="" />
              {mobileCategory(pathname)}
            </button>
          )}
        </header>
        <div className={styles.content}>{children}</div>
      </div>
    </div>
  );
}
