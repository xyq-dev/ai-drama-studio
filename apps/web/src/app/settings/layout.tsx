import type { ReactNode } from "react";
import { AdminShell } from "../../components/admin-shell";

/**
 * Operator-only object-storage settings share the admin console shell.
 * The shell shows operator navigation only after the session role is operator.
 * This route is reached by URL, not creator nav. proxy.ts redirects other roles to /studio.
 * Storage APIs enforce operator separately.
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}
