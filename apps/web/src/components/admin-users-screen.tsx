"use client";

import { useEffect, useState } from "react";
import { AdminDirectory } from "./admin-directory";
import { AdminStaffPanel } from "./admin-staff-panel";
import styles from "./admin-directory.module.css";

export function AdminUsersScreen() {
  const [tab, setTab] = useState<"creators" | "staff">("creators");
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("tab");
    if (requested === "staff") setTab("staff");
  }, []);
  return <div>
    <div className={styles.toolbar} role="tablist" aria-label="用户与权限">
      <button type="button" className={tab === "creators" ? styles.primary : styles.secondary} onClick={() => setTab("creators")}>创作者</button>
      <button type="button" className={tab === "staff" ? styles.primary : styles.secondary} onClick={() => setTab("staff")}>管理员</button>
    </div>
    {tab === "creators" ? <AdminDirectory kind="users" /> : <AdminStaffPanel />}
  </div>;
}
