"use client";

import { useEffect, useState } from "react";
import { MEMBERSHIP_FEATURES, MEMBERSHIP_FEATURE_LABELS, type MembershipFeature } from "@ai-drama/domain/creator-membership";
import { withSession } from "../lib/site-session";
import styles from "./admin-directory.module.css";

interface Plan {
  id: string; code: string; name: string; description: string;
  unitPriceAmount: string | null; unitPriceCurrency: string | null;
  features: Array<{ feature: MembershipFeature; enabled: boolean; includedUnits: number | null }>;
}
interface Member { id: string; accountId: string; planName: string; status: string; startsAt: string; endsAt: string; reason: string; source: string }

const fetchJson = withSession(globalThis.fetch.bind(globalThis));

export function AdminMembershipPanel() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState("");
  const [features, setFeatures] = useState<Record<MembershipFeature, { enabled: boolean; includedUnits: string }>>({
    writing: { enabled: false, includedUnits: "" },
    image: { enabled: false, includedUnits: "" },
    voice: { enabled: false, includedUnits: "" },
    video: { enabled: false, includedUnits: "" },
  });
  const [accountId, setAccountId] = useState("");
  const [planId, setPlanId] = useState("");
  const [months, setMonths] = useState("1");
  const [reason, setReason] = useState("");
  const [delta, setDelta] = useState("");
  const [adjustFeature, setAdjustFeature] = useState<MembershipFeature>("writing");
  const [adjustAccountId, setAdjustAccountId] = useState("");
  const [adjustReason, setAdjustReason] = useState("");

  function fillPlan(plan: Plan) {
    setCode(plan.code);
    setName(plan.name);
    setPrice(plan.unitPriceAmount ?? "");
    setCurrency(plan.unitPriceCurrency ?? "");
    const next = { ...features };
    for (const feature of MEMBERSHIP_FEATURES) {
      const row = plan.features.find((item) => item.feature === feature);
      next[feature] = { enabled: row?.enabled === true, includedUnits: row?.includedUnits == null ? "" : String(row.includedUnits) };
    }
    setFeatures(next);
  }

  function memberLabel(member: Member): string {
    if (member.status === "disabled") return "已停用";
    if (Date.parse(member.endsAt) <= Date.now()) return "已到期";
    return "生效中";
  }

  async function load() {
    const [planBody, memberBody] = await Promise.all([
      fetchJson("/api/v1/admin/membership/plans", { credentials: "same-origin", cache: "no-store" }),
      fetchJson("/api/v1/admin/membership/members", { credentials: "same-origin", cache: "no-store" }),
    ]);
    if (!planBody.ok || !memberBody.ok) throw new Error("没有读到会员资料。");
    const planJson = await planBody.json() as { items: Plan[] };
    const memberJson = await memberBody.json() as { items: Member[] };
    setPlans(planJson.items);
    setMembers(memberJson.items);
    setPlanId((current) => current || planJson.items[0]?.id || "");
  }

  useEffect(() => { void load().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "没有读到会员资料。")); }, []);

  return <section className={styles.page}>
    <div className={styles.intro}><div><h1>会员管理</h1><p>手动开通按月会员。价格和额度由这里填写，不在系统里写死。本页不收款、不续费、不退款。</p></div></div>
    {plans.length > 0 ? <div className={styles.toolbar}>{plans.map((plan) => <button key={plan.id} type="button" className={styles.secondary} onClick={() => fillPlan(plan)}>编辑{plan.name}</button>)}</div> : null}
    {error ? <p role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <form className={styles.panel} onSubmit={(event) => { event.preventDefault(); void fetchJson("/api/v1/admin/membership/plans", { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name, unitPriceAmount: price, unitPriceCurrency: currency, features: Object.fromEntries(MEMBERSHIP_FEATURES.map((feature) => [feature, { enabled: features[feature].enabled, includedUnits: features[feature].includedUnits }])) }) }).then(async (response) => { if (!response.ok) throw new Error((await response.json() as { error?: { message?: string } }).error?.message ?? "没有保存套餐。"); setNotice("套餐已保存。"); await load(); }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "没有保存套餐。")); }}>
      <h2>套餐</h2>
      <label className={styles.field}>代号<input value={code} onChange={(event) => setCode(event.target.value)} /></label>
      <label className={styles.field}>名称<input value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label className={styles.field}>单价（可留空）<input value={price} onChange={(event) => setPrice(event.target.value)} /></label>
      <label className={styles.field}>币种（可留空）<input value={currency} onChange={(event) => setCurrency(event.target.value)} maxLength={3} /></label>
      {MEMBERSHIP_FEATURES.map((feature) => <label key={feature} className={styles.field}>{MEMBERSHIP_FEATURE_LABELS[feature]}
        <input type="checkbox" checked={features[feature].enabled} onChange={(event) => setFeatures({ ...features, [feature]: { ...features[feature], enabled: event.target.checked } })} />
        <input aria-label={`${MEMBERSHIP_FEATURE_LABELS[feature]}额度`} value={features[feature].includedUnits} onChange={(event) => setFeatures({ ...features, [feature]: { ...features[feature], includedUnits: event.target.value } })} placeholder="额度，留空表示未配置" />
      </label>)}
      <button className={styles.primary} type="submit">保存套餐</button>
      <ul>{plans.map((plan) => <li key={plan.id}>{plan.name}（{plan.code}）{plan.unitPriceAmount ? `${plan.unitPriceAmount} ${plan.unitPriceCurrency ?? ""}` : "尚未计价"}</li>)}</ul>
    </form>
    <form className={styles.panel} onSubmit={(event) => { event.preventDefault(); void fetchJson("/api/v1/admin/membership/grants", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId, planId, months: Number(months), reason }) }).then(async (response) => { const body = await response.json() as { error?: { message?: string }; sourceLabel?: string }; if (!response.ok) throw new Error(body.error?.message ?? "没有开通。"); setNotice(`已${body.sourceLabel ?? "人工开通"}。没有生成支付订单。`); await load(); }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "没有开通。")); }}>
      <h2>手动开通</h2>
      <label className={styles.field}>创作者账号 ID<input value={accountId} onChange={(event) => setAccountId(event.target.value)} /></label>
      <label className={styles.field}>套餐<select value={planId} onChange={(event) => setPlanId(event.target.value)}>{plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</select></label>
      <label className={styles.field}>开通月数<input value={months} onChange={(event) => setMonths(event.target.value)} inputMode="numeric" /></label>
      <label className={styles.field}>原因<input value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      <button className={styles.primary} type="submit">开通会员</button>
    </form>
    <form className={styles.panel} onSubmit={(event) => { event.preventDefault(); void fetchJson("/api/v1/admin/membership/adjust", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId: adjustAccountId, feature: adjustFeature, delta: Number(delta), reason: adjustReason }) }).then(async (response) => { if (!response.ok) throw new Error((await response.json() as { error?: { message?: string } }).error?.message ?? "没有调整额度。"); setNotice("额度已调整，并记下了原因。"); await load(); }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "没有调整额度。")); }}>
      <h2>调整额度</h2>
      <label className={styles.field}>账号<select aria-label="调整额度的账号" value={adjustAccountId} onChange={(event) => setAdjustAccountId(event.target.value)}><option value="">选择账号</option>{members.map((member) => <option key={member.accountId} value={member.accountId}>{member.accountId}</option>)}</select></label>
      <label className={styles.field}>功能<select aria-label="调整的功能" value={adjustFeature} onChange={(event) => setAdjustFeature(event.target.value as MembershipFeature)}>{MEMBERSHIP_FEATURES.map((feature) => <option key={feature} value={feature}>{MEMBERSHIP_FEATURE_LABELS[feature]}</option>)}</select></label>
      <label className={styles.field}>调整数量<input aria-label="调整数量" value={delta} onChange={(event) => setDelta(event.target.value)} placeholder="正数增加，负数减少" /></label>
      <label className={styles.field}>原因<input aria-label="调整原因" value={adjustReason} onChange={(event) => setAdjustReason(event.target.value)} /></label>
      {adjustAccountId && delta ? <p>将把 {adjustAccountId} 的{MEMBERSHIP_FEATURE_LABELS[adjustFeature]}额度调整 {delta}。{adjustReason ? `原因：${adjustReason}。` : "请填写原因。"}</p> : null}
      <button className={styles.secondary} type="submit" disabled={!adjustAccountId || !delta || !adjustReason}>保存调整</button>
    </form>
    <div className={styles.panel}>
      <h2>会员</h2>
      <table className={styles.table}><thead><tr><th>账号</th><th>套餐</th><th>状态</th><th>起止</th><th>来源</th><th></th></tr></thead>
        <tbody>{members.map((member) => <tr key={member.id}><td>{member.accountId}</td><td>{member.planName}</td><td>{memberLabel(member)}</td><td>{member.startsAt.slice(0, 10)} 至 {member.endsAt.slice(0, 10)}</td><td>人工开通</td><td><button type="button" className={styles.linkish} onClick={() => void fetchJson(`/api/v1/admin/membership/${member.id}/status`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: member.status === "disabled" ? "active" : "disabled" }) }).then(load)}>{member.status === "disabled" ? "重新启用" : "停用"}</button></td></tr>)}</tbody>
      </table>
      <div className={styles.cards}>{members.map((member) => <article key={member.id} className={styles.card}><strong>{member.planName}</strong><span>{member.accountId}</span><span>{memberLabel(member)}</span><button type="button" className={styles.secondary} onClick={() => void fetchJson(`/api/v1/admin/membership/${member.id}/status`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: member.status === "disabled" ? "active" : "disabled" }) }).then(load)}>{member.status === "disabled" ? "重新启用" : "停用"}</button></article>)}</div>
    </div>
  </section>;
}
