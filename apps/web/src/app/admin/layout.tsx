import type { ReactNode } from "react";
import { AdminShell } from "../../components/admin-shell";

/**
 * Operator admin console. Creators can open these pages and see the no-permission card.
 * APIs still require role=operator. Noto Sans SC is loaded for this shell only.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700&display=swap" />
      <AdminShell>{children}</AdminShell>
    </>
  );
}
