import type { ReactNode } from "react";

const LINKS = [
  { href: "/studio", label: "我的作品" },
  { href: "/categories", label: "灵感中心" },
  { href: "/create", label: "开始创作" },
  { href: "/help", label: "帮助" },
] as const;

/** The 红果创作 frame: brand, the four default entries and a light page. No drawer: the links wrap on a phone. */
export function BeginnerShell({ children, active }: { children: ReactNode; active?: (typeof LINKS)[number]["href"] }) {
  return (
    <div className="beginner">
      <a className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2" href="#main">跳到正文</a>
      <header className="border-b border-[#E7E5E0] bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <a className="flex items-center gap-2 text-lg font-semibold text-[#24232A]" href="/">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[#D34846] text-sm text-white" aria-hidden="true">红</span>
            红果创作
          </a>
          <nav aria-label="主导航" className="min-w-0">
            <ul className="flex flex-wrap gap-1">
              {LINKS.map((link) => (
                <li key={link.href}>
                  <a
                    className={`block rounded-[12px] px-3 py-1.5 text-[15px] ${active === link.href ? "bg-[#FBE7E4] font-medium text-[#B8322F]" : "text-[#24232A] hover:bg-[#F7F6F2]"}`}
                    href={link.href}
                    aria-current={active === link.href ? "page" : undefined}
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>
      <div id="main">{children}</div>
    </div>
  );
}
