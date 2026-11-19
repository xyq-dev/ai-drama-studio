import type { ReactNode } from "react";
import { AdminShell } from "../../components/admin-shell";

/**
 * Operator-only object-storage settings share the admin console shell.
 * Sidebar stays phase-1 (文本模型 · 媒体密钥); this route is reached by URL / docs, not creator nav.
 * Page-level role gate lives in proxy.ts; storage APIs enforce operator separately.
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}
