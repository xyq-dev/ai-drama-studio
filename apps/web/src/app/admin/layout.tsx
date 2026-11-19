import type { ReactNode } from "react";
import { AdminShell } from "../../components/admin-shell";

/**
 * Operator-only admin console shell (phase 1).
 * Page-level role gate lives in proxy.ts; APIs enforce operator separately.
 * Sidebar: 文本模型 · 媒体密钥 only. No Pro / demo / recharge / membership routes.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}
