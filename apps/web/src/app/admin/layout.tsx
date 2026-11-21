import type { ReactNode } from "react";
import { AdminShell } from "../../components/admin-shell";

/**
 * Operator-only admin console shell (phase 1).
 * Page-level role gate lives in proxy.ts; APIs enforce operator separately.
 * Sidebar: 功能配置 and 调用记录. Planned groups stay collapsed lists. No Pro / recharge / membership routes.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}
