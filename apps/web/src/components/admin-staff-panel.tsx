"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { STAFF_PERMISSIONS, STAFF_PERMISSION_LABELS, SUPER_ADMIN_ROLE_CODE, type StaffPermission } from "@ai-drama/domain/staff-access";
import { withSession } from "../lib/site-session";
import { useModalKeyboard } from "../lib/modal-keyboard";
import styles from "./admin-directory.module.css";

interface Role { id: string; code: string; name: string; builtIn: boolean; permissions: StaffPermission[] }
interface StaffRow {
  id: string; username: string; displayName: string; status: "pending" | "active" | "disabled";
  statusLabel: string; roleId: string; roleName: string; lastLoginAt: string | null;
}
type StaffSection = "accounts" | "roles" | "security" | "logs";
interface SessionRow { publicId: string; createdAt: string; lastSeenAt: string }

const fetchJson = withSession(globalThis.fetch.bind(globalThis));

async function api(path: string, init?: RequestInit) {
  const response = await fetchJson(path, { credentials: "same-origin", cache: "no-store", ...init });
  const body = await response.json().catch(() => ({})) as { error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? "请求没有完成。");
  return body;
}

function post(path: string, data: object) {
  return api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
}

function authentication(form: HTMLFormElement) {
  const data = new FormData(form);
  const currentPassword = data.get("currentPassword")?.toString();
  const totpCode = data.get("totpCode")?.toString().trim();
  for (const field of form.querySelectorAll<HTMLInputElement>('input[type="password"]')) field.value = "";
  return { currentPassword, totpCode };
}

function AuthenticationFields({ secondFactor, codeLabel = "动态码或恢复码" }: { secondFactor: boolean; codeLabel?: string }) {
  return <>
    <label className={styles.field}>当前密码<input required type="password" name="currentPassword" autoComplete="current-password" /></label>
    {secondFactor && <label className={styles.field}>{codeLabel}<input required type="password" name="totpCode" autoComplete="one-time-code" /></label>}
  </>;
}

export function AdminStaffPanel() {
  const [section, setSection] = useState<StaffSection>("accounts");
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
  const [requiresSecondFactor, setRequiresSecondFactor] = useState(false);
  const [statusTarget, setStatusTarget] = useState<StaffRow | null>(null);
  const dialog = useRef<HTMLFormElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [selected, setSelected] = useState<StaffRow | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sessionStaffId, setSessionStaffId] = useState("");
  const [totp, setTotp] = useState<{ secret: string; uri: string; codes?: string[] } | null>(null);
  const [logs, setLogs] = useState<Array<{ id: string; at: string; actor: string; action: string; target: string; result: string }>>([]);

  useModalKeyboard(!!(selected || statusTarget), dialog, closeDialog);
  function closeDialog() {
    if (submitting) return;
    setSelected(null);
    setStatusTarget(null);
    setError("");
  }

  function submit(action: () => Promise<void>) {
    if (submitting) return;
    setSubmitting(true);
    setError("");
    void action().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "请求没有完成。"))
      .finally(() => setSubmitting(false));
  }

  const load = useCallback(async () => {
    const body = await api("/api/v1/admin/staff") as { staff: StaffRow[]; roles: Role[]; requiresSecondFactor: boolean; currentStaffId: string | null };
    setStaff(body.staff);
    setRoles(body.roles);
    setRequiresSecondFactor(body.requiresSecondFactor);
    setSessionStaffId(current => current || body.currentStaffId || "");
    setRoleId((current) => current || body.roles.find((role) => role.code === "ops_admin")?.id || body.roles[0]?.id || "");
  }, []);

  useEffect(() => { void load().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "没有读到管理员。")); }, [load]);

  useEffect(() => {
    if (section !== "security" || !sessionStaffId) return;
    const controller = new AbortController();
    void api(`/api/v1/admin/staff/${sessionStaffId}/sessions`, { signal: controller.signal })
      .then(body => { if (!controller.signal.aborted) setSessions((body as { items: SessionRow[] }).items); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "没有读到登录会话。"); });
    return () => controller.abort();
  }, [section, sessionStaffId]);

  function changeSection(next: StaffSection) {
    if (section === next) return;
    setTotp(null);
    setSessions([]);
    setError("");
    setSection(next);
  }
  const authenticatorAction = requiresSecondFactor ? "更换验证器" : "开启验证器";
  const superRoleId = roles.find(role => role.code === SUPER_ADMIN_ROLE_CODE)?.id;
  const editRequiresAuth = selected && (selected.roleId === superRoleId || staff.find(row => row.id === selected.id)?.roleId === superRoleId);
  const statusAction = (row: StaffRow) => row.status === "active" ? "停用" : "重新启用";
  async function updateStatus(row: StaffRow, credentials: Partial<ReturnType<typeof authentication>> = {}) {
    await post(`/api/v1/admin/staff/${row.id}/status`, { status: row.status === "active" ? "disabled" : "active", ...credentials });
    setStatusTarget(null);
    await load();
  }
  function statusButton(row: StaffRow, className: string | undefined) {
    if (row.status === "pending") return null;
    return <button type="button" className={className} disabled={submitting} onClick={() => {
      if (row.roleId === superRoleId) { setError(""); setStatusTarget(row); }
      else submit(() => updateStatus(row));
    }}>{statusAction(row)}</button>;
  }

  const visible = staff.filter((row) => {
    const text = `${row.username} ${row.displayName}`.toLowerCase();
    if (query && !text.includes(query.trim().toLowerCase())) return false;
    if (roleFilter && row.roleId !== roleFilter) return false;
    if (statusFilter && row.status !== statusFilter) return false;
    return true;
  });

  async function invite(credentials: ReturnType<typeof authentication>) {
    setError("");
    setInviteUrl("");
    const body = await post("/api/v1/admin/staff/invites", { username, displayName, roleId, ...credentials }) as { inviteUrl: string };
    setInviteUrl(body.inviteUrl);
    setNotice("邀请已生成。链接 24 小时内有效，只能使用一次。把链接发给对方，由对方设置密码。");
    setUsername("");
    setDisplayName("");
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
      <button type="button" className={section === "accounts" ? styles.primary : styles.secondary} onClick={() => changeSection("accounts")}>账号管理</button>
      <button type="button" className={section === "roles" ? styles.primary : styles.secondary} onClick={() => changeSection("roles")}>角色与权限</button>
      <button type="button" className={section === "security" ? styles.primary : styles.secondary} onClick={() => changeSection("security")}>登录与安全</button>
      <button type="button" className={section === "logs" ? styles.primary : styles.secondary} onClick={() => { changeSection("logs"); void api("/api/v1/admin/logs").then((body) => setLogs((body as { items?: typeof logs }).items ?? [])).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "没有读到日志。")); }}>管理日志</button>
    </div>
    {error && !selected && !statusTarget ? <p className={styles.error} role="alert">{error}</p> : null}
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
      <form className={styles.field} onSubmit={(event) => { event.preventDefault(); const credentials = authentication(event.currentTarget); submit(() => invite(credentials)); }}>
        <span>邀请管理员</span>
        <input aria-label="账号" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="账号" />
        <input aria-label="显示名" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="显示名" />
        <select aria-label="岗位" value={roleId} onChange={(event) => setRoleId(event.target.value)}>
          {roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
        </select>
        {roleId === superRoleId && <AuthenticationFields secondFactor={requiresSecondFactor} />}
        <button className={styles.primary} type="submit" disabled={submitting}>生成邀请链接</button>
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
              <button type="button" className={styles.linkish} onClick={() => { setError(""); setSelected(row); }}>编辑</button>
              {row.status === "pending" ? <button type="button" className={styles.linkish} onClick={() => void api(`/api/v1/admin/staff/${row.id}/revoke-invite`, { method: "POST" }).then(load)}>撤销邀请</button> : null}
              {row.status === "pending" ? <button type="button" className={styles.linkish} onClick={() => void api(`/api/v1/admin/staff/${row.id}/resend-invite`, { method: "POST" }).then((body) => setInviteUrl((body as { inviteUrl: string }).inviteUrl))}>重新邀请</button> : null}
              {statusButton(row, styles.linkish)}
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
          <button type="button" className={styles.secondary} onClick={() => { setError(""); setSelected(row); }}>编辑</button>
          {row.status === "pending" ? <button type="button" className={styles.secondary} onClick={() => void api(`/api/v1/admin/staff/${row.id}/revoke-invite`, { method: "POST" }).then(load)}>撤销邀请</button> : null}
          {statusButton(row, styles.secondary)}
        </article>)}
      </div>
      {(selected || statusTarget) && <>
        <div className={styles.backdrop} onClick={closeDialog} />
        <form ref={dialog} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="staff-action-title" onSubmit={event => {
          event.preventDefault();
          const credentials = authentication(event.currentTarget);
          submit(async () => {
            if (statusTarget) await updateStatus(statusTarget, credentials);
            else if (selected) {
              await post(`/api/v1/admin/staff/${selected.id}`, { displayName: selected.displayName, roleId: selected.roleId, ...credentials });
              setSelected(null);
              await load();
            }
          });
        }}>
          <h2 id="staff-action-title">{statusTarget ? `${statusAction(statusTarget)}「${statusTarget.displayName}」` : "编辑管理员"}</h2>
          {selected && <>
            <label className={styles.field}>显示名<input value={selected.displayName} onChange={event => setSelected({ ...selected, displayName: event.target.value })} /></label>
            <label className={styles.field}>岗位<select value={selected.roleId} onChange={event => setSelected({ ...selected, roleId: event.target.value })}>{roles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label>
          </>}
          {(statusTarget || editRequiresAuth) && <AuthenticationFields secondFactor={requiresSecondFactor} />}
          {error && <p role="alert" className={styles.error}>{error}</p>}
          <div className={styles.dialogActions}>
            <button className={styles.secondary} type="button" disabled={submitting} onClick={closeDialog}>取消</button>
            <button className={styles.primary} type="submit" disabled={submitting}>{statusTarget ? statusAction(statusTarget) : "保存"}</button>
          </div>
        </form>
      </>}
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
      {(!totp || totp.codes) && <form className={styles.field} aria-label={authenticatorAction} onSubmit={event => {
        event.preventDefault();
        const credentials = authentication(event.currentTarget);
        submit(async () => setTotp(await post("/api/v1/admin/staff/totp/start", credentials) as { secret: string; uri: string }));
      }}>
        <AuthenticationFields secondFactor={requiresSecondFactor} codeLabel="旧验证器动态码或恢复码" />
        <button type="submit" disabled={submitting} className={styles.secondary}>{authenticatorAction}</button>
      </form>}
      {totp && !totp.codes && <form className={styles.field} onSubmit={event => {
        event.preventDefault();
        const code = new FormData(event.currentTarget).get("code");
        submit(async () => {
          const result = await post("/api/v1/admin/staff/totp/confirm", { code }) as { recoveryCodes: string[] };
          setRequiresSecondFactor(true);
          setTotp({ secret: "", uri: "", codes: result.recoveryCodes });
        });
      }}>
        <p>密钥 {totp.secret}</p>
        <p>{requiresSecondFactor ? "把密钥加入新验证器，填写新的 6 位动态码。确认前仍使用旧验证器。" : "把密钥加入验证器后，填写 6 位动态码。"}</p>
        <input name="code" aria-label="动态码" inputMode="numeric" autoComplete="one-time-code" required />
        <button className={styles.primary} type="submit" disabled={submitting}>{requiresSecondFactor ? "确认更换" : "确认开启"}</button>
      </form>}
      {requiresSecondFactor && (!totp || totp.codes) && <p>{totp?.codes ? `请保存恢复码，仅显示一次：${totp.codes.join("、")}` : "验证器已开启"}</p>}
      <label className={styles.field}>查看会话的账号
        <select value={sessionStaffId} onChange={(event) => { const id = event.target.value; setSessionStaffId(id); setSessions([]); setError(""); }}>
          <option value="">选择管理员</option>
          {staff.map((row) => <option key={row.id} value={row.id}>{row.displayName}</option>)}
        </select>
      </label>
      <ul>{sessions.map((session) => <li key={session.publicId}>{new Date(session.lastSeenAt).toLocaleString("zh-CN")} <button type="button" className={styles.linkish} disabled={submitting} onClick={() => submit(async () => {
        await post(`/api/v1/admin/staff/${sessionStaffId}/sessions/${session.publicId}/revoke`, {});
        setSessions(current => current.filter(item => item.publicId !== session.publicId));
      })}>撤销</button></li>)}</ul>
    </div> : null}
    {section === "logs" ? <div className={styles.panel}>
      <h2>管理日志</h2>
      <p>记录真实操作者、对象、动作和时间。密码、邀请链接、恢复码和完整密钥不会写入日志。</p>
      <table className={styles.table}><thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>对象</th><th>结果</th></tr></thead>
        <tbody>{logs.map((row) => <tr key={row.id}><td>{row.at}</td><td>{row.actor}</td><td>{row.action}</td><td>{row.target}</td><td>{row.result === "success" ? "成功" : "失败"}</td></tr>)}</tbody>
      </table>
      <div className={styles.cards}>{logs.map((row) => <article key={row.id} className={styles.card}><strong>{row.action}</strong><span>{row.actor}</span><span>{row.target}</span><span>{row.result === "success" ? "成功" : "失败"}</span><span>{row.at}</span></article>)}</div>
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
