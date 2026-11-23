"use client";

import { useCallback, useEffect, useState } from "react";
import { STAFF_PERMISSIONS, STAFF_PERMISSION_LABELS, type StaffPermission } from "@ai-drama/domain/staff-access";
import { withSession } from "../lib/site-session";
import styles from "./admin-directory.module.css";

interface Role { id: string; code: string; name: string; builtIn: boolean; permissions: StaffPermission[] }
interface StaffRow {
  id: string; username: string; displayName: string; status: "pending" | "active" | "disabled";
  statusLabel: string; roleId: string; roleName: string; lastLoginAt: string | null;
}
interface SessionRow { publicId: string; createdAt: string; lastSeenAt: string }

const fetchJson = withSession(globalThis.fetch.bind(globalThis));

async function api(path: string, init?: RequestInit) {
  const response = await fetchJson(path, { credentials: "same-origin", cache: "no-store", ...init });
  const body = await response.json().catch(() => ({})) as { error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? "请求没有完成。");
  return body;
}

export function AdminStaffPanel() {
  const [section, setSection] = useState<"accounts" | "roles" | "security" | "logs">("accounts");
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [roleId, setRoleId] = useState("");
  const [password, setPassword] = useState("");
  const [selected, setSelected] = useState<StaffRow | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [totp, setTotp] = useState<{ secret: string; uri: string; codes?: string[] } | null>(null);
  const [logs, setLogs] = useState<Array<{ id: string; at: string; actor: string; action: string; target: string; result: string }>>([]);

  const load = useCallback(async () => {
    const body = await api("/api/v1/admin/staff") as { staff: StaffRow[]; roles: Role[] };
    setStaff(body.staff);
    setRoles(body.roles);
    setRoleId((current) => current || body.roles.find((role) => role.code === "ops_admin")?.id || body.roles[0]?.id || "");
  }, []);

  useEffect(() => { void load().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "没有读到管理员。")); }, [load]);

  const visible = staff.filter((row) => {
    const text = `${row.username} ${row.displayName}`.toLowerCase();
    if (query && !text.includes(query.trim().toLowerCase())) return false;
    if (roleFilter && row.roleId !== roleFilter) return false;
    if (statusFilter && row.status !== statusFilter) return false;
    return true;
  });

  async function invite() {
    setError("");
    setInviteUrl("");
    const body = await api("/api/v1/admin/staff/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, displayName, roleId, currentPassword: password || undefined }),
    }) as { inviteUrl: string };
    setInviteUrl(body.inviteUrl);
    setNotice("邀请已生成。链接 24 小时内有效，只能使用一次。把链接发给对方，由对方设置密码。");
    setUsername("");
    setDisplayName("");
    setPassword("");
    await load();
  }

  async function copyLink() {
    await navigator.clipboard.writeText(inviteUrl);
    setNotice("邀请链接已复制，可以粘贴到微信或飞书。");
  }

  return <section className={styles.page}>
    <div className={styles.intro}>
      <div>
        <h1>管理员</h1>
        <p>邀请同事、按岗位授权，并查看谁做了哪一次操作。</p>
      </div>
    </div>
    <div className={styles.filters} role="tablist" aria-label="管理员分区">
      <button type="button" className={section === "accounts" ? styles.primary : styles.secondary} onClick={() => setSection("accounts")}>账号管理</button>
      <button type="button" className={section === "roles" ? styles.primary : styles.secondary} onClick={() => setSection("roles")}>角色与权限</button>
      <button type="button" className={section === "security" ? styles.primary : styles.secondary} onClick={() => setSection("security")}>登录与安全</button>
      <button type="button" className={section === "logs" ? styles.primary : styles.secondary} onClick={() => { setSection("logs"); void api("/api/v1/admin/logs").then((body) => setLogs((body as { items?: typeof logs }).items ?? [])).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "没有读到日志。")); }}>管理日志</button>
    </div>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
    {section === "accounts" ? <div className={styles.panel}>
      <div className={styles.toolbar}>
        <label className={styles.search}>搜索<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="账号或显示名" /></label>
        <select className={styles.select} value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)} aria-label="按角色筛选">
          <option value="">全部角色</option>
          {roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
        </select>
        <select className={styles.select} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="按状态筛选">
          <option value="">全部状态</option>
          <option value="pending">待激活</option>
          <option value="active">已启用</option>
          <option value="disabled">已停用</option>
        </select>
      </div>
      <form className={styles.field} onSubmit={(event) => { event.preventDefault(); void invite().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "邀请没有发出。")); }}>
        <span>邀请管理员</span>
        <input aria-label="账号" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="账号" />
        <input aria-label="显示名" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="显示名" />
        <select aria-label="岗位" value={roleId} onChange={(event) => setRoleId(event.target.value)}>
          {roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
        </select>
        <input aria-label="当前密码" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="邀请超级管理员时填写当前密码" />
        <button className={styles.primary} type="submit">生成邀请链接</button>
      </form>
      {inviteUrl ? <p>邀请链接 <button type="button" className={styles.linkish} onClick={() => void copyLink()}>复制到微信或飞书</button><br /><code>{inviteUrl}</code></p> : null}
      <table className={styles.table}>
        <thead><tr><th>账号</th><th>岗位</th><th>状态</th><th>最近登录</th><th></th></tr></thead>
        <tbody>
          {visible.map((row) => <tr key={row.id}>
            <td>{row.displayName}<br /><small>{row.username}</small></td>
            <td>{row.roleName}</td>
            <td>{row.statusLabel}</td>
            <td>{row.lastLoginAt ? new Date(row.lastLoginAt).toLocaleString("zh-CN") : "尚未登录"}</td>
            <td>
              <button type="button" className={styles.linkish} onClick={() => setSelected(row)}>编辑</button>
              {row.status === "pending" ? <button type="button" className={styles.linkish} onClick={() => void api(`/api/v1/admin/staff/${row.id}/revoke-invite`, { method: "POST" }).then(load)}>撤销邀请</button> : null}
              {row.status === "pending" ? <button type="button" className={styles.linkish} onClick={() => void api(`/api/v1/admin/staff/${row.id}/resend-invite`, { method: "POST" }).then((body) => setInviteUrl((body as { inviteUrl: string }).inviteUrl))}>重新邀请</button> : null}
              {row.status === "active" ? <button type="button" className={styles.linkish} onClick={() => void api(`/api/v1/admin/staff/${row.id}/status`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "disabled", currentPassword: password || undefined }) }).then(load)}>停用</button> : null}
              {row.status === "disabled" ? <button type="button" className={styles.linkish} onClick={() => void api(`/api/v1/admin/staff/${row.id}/status`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "active", currentPassword: password || undefined }) }).then(load)}>重新启用</button> : null}
            </td>
          </tr>)}
        </tbody>
      </table>
      <div className={styles.cards}>
        {visible.map((row) => <article key={row.id} className={styles.card}>
          <strong>{row.displayName}</strong>
          <span>{row.username}</span>
          <span>{row.roleName}</span>
          <span>{row.statusLabel}</span>
          <span>{row.lastLoginAt ? new Date(row.lastLoginAt).toLocaleString("zh-CN") : "尚未登录"}</span>
        </article>)}
      </div>
      {selected ? <form className={styles.dialog} onSubmit={(event) => { event.preventDefault(); void api(`/api/v1/admin/staff/${selected.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: selected.displayName, roleId: selected.roleId, currentPassword: password || undefined }) }).then(() => { setSelected(null); return load(); }); }}>
        <h2>编辑管理员</h2>
        <label className={styles.field}>显示名<input value={selected.displayName} onChange={(event) => setSelected({ ...selected, displayName: event.target.value })} /></label>
        <label className={styles.field}>岗位<select value={selected.roleId} onChange={(event) => setSelected({ ...selected, roleId: event.target.value })}>{roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label>
        <p>改成或取消超级管理员前，需要填写上方的当前密码。</p>
        <button className={styles.primary} type="submit">保存</button>
        <button className={styles.secondary} type="button" onClick={() => setSelected(null)}>关闭</button>
      </form> : null}
    </div> : null}
    {section === "roles" ? <RoleEditor roles={roles} onSaved={() => void load()} onError={setError} /> : null}
    {section === "security" ? <div className={styles.panel}>
      <h2>登录与安全</h2>
      <form className={styles.field} onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); void api("/api/v1/admin/staff/password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ currentPassword: form.get("current"), nextPassword: form.get("next") }) }).then(() => setNotice("密码已修改。")).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "没有修改密码。")); }}>
        <span>修改密码</span>
        <input name="current" type="password" aria-label="当前密码" />
        <input name="next" type="password" aria-label="新密码" />
        <button className={styles.primary} type="submit">保存新密码</button>
      </form>
      <button type="button" className={styles.secondary} onClick={() => void api("/api/v1/admin/staff/totp/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ currentPassword: password }) }).then((body) => setTotp(body as { secret: string; uri: string }))}>开启验证器</button>
      {totp ? <form className={styles.field} onSubmit={(event) => { event.preventDefault(); const code = new FormData(event.currentTarget).get("code"); void api("/api/v1/admin/staff/totp/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) }).then((body) => setTotp({ ...totp, codes: (body as { recoveryCodes: string[] }).recoveryCodes })); }}>
        <p>密钥 {totp.secret}</p>
        <p>把密钥加入验证器后，填写 6 位动态码。</p>
        <input name="code" aria-label="动态码" inputMode="numeric" />
        <button className={styles.primary} type="submit">确认开启</button>
        {totp.codes ? <p>恢复码只显示这一次：{totp.codes.join("、")}</p> : null}
      </form> : null}
      <label className={styles.field}>查看会话的账号
        <select onChange={(event) => { const id = event.target.value; if (id) void api(`/api/v1/admin/staff/${id}/sessions`).then((body) => setSessions((body as { items: SessionRow[] }).items)); }}>
          <option value="">选择管理员</option>
          {staff.map((row) => <option key={row.id} value={row.id}>{row.displayName}</option>)}
        </select>
      </label>
      <ul>{sessions.map((session) => <li key={session.publicId}>{new Date(session.lastSeenAt).toLocaleString("zh-CN")} <button type="button" className={styles.linkish} onClick={() => void api(`/api/v1/admin/staff/${staff.find((row) => true)?.id}/sessions/${session.publicId}/revoke`, { method: "POST" })}>撤销</button></li>)}</ul>
    </div> : null}
    {section === "logs" ? <div className={styles.panel}>
      <h2>管理日志</h2>
      <p>记录真实操作者、对象、动作和时间。密码、邀请链接、恢复码和完整密钥不会写入日志。</p>
      <table className={styles.table}><thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>对象</th><th>结果</th></tr></thead>
        <tbody>{logs.map((row) => <tr key={row.id}><td>{row.at}</td><td>{row.actor}</td><td>{row.action}</td><td>{row.target}</td><td>{row.result === "success" ? "成功" : "失败"}</td></tr>)}</tbody>
      </table>
    </div> : null}
  </section>;
}

function RoleEditor({ roles, onSaved, onError }: { roles: Role[]; onSaved: () => void; onError: (message: string) => void }) {
  const [name, setName] = useState("");
  const [permissions, setPermissions] = useState<StaffPermission[]>([]);
  function toggle(permission: StaffPermission) {
    setPermissions((current) => current.includes(permission) ? current.filter((item) => item !== permission) : [...current, permission]);
  }
  return <form className={styles.panel} onSubmit={(event) => { event.preventDefault(); void fetchJson("/api/v1/admin/staff/roles", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, permissions }) }).then(async (response) => { if (!response.ok) throw new Error("没有保存岗位。"); setName(""); onSaved(); }).catch((cause: unknown) => onError(cause instanceof Error ? cause.message : "没有保存岗位。")); }}>
    <h2>按岗位创建角色</h2>
    <p>超级管理员承接现有平台管理员，权限保持完整。运营管理员默认可审核作品、管理创作者和查看用量。</p>
    <ul>{roles.map((role) => <li key={role.id}>{role.name}：{role.permissions.map((permission) => STAFF_PERMISSION_LABELS[permission]).join("、")}</li>)}</ul>
    <label className={styles.field}>岗位名称<input value={name} onChange={(event) => setName(event.target.value)} /></label>
    {STAFF_PERMISSIONS.map((permission) => <label key={permission}><input type="checkbox" checked={permissions.includes(permission)} onChange={() => toggle(permission)} />{STAFF_PERMISSION_LABELS[permission]}</label>)}
    <button className={styles.primary} type="submit">创建岗位</button>
  </form>;
}
