import type { WritingQuotaTransaction } from "@ai-drama/contracts";
import { createHash, randomUUID } from "node:crypto";
import {
  MEMBERSHIP_FEATURES,
  decideReserve,
  membershipDenialMessage,
  type MembershipFeature,
  type QuotaHoldStatus,
} from "@ai-drama/domain";
import type { DatabasePool } from "@ai-drama/database";

export interface PlanFeatureInput {
  feature: MembershipFeature;
  enabled: boolean;
  includedUnits: number | null;
}

export interface MembershipPlanRecord {
  id: string;
  code: string;
  name: string;
  description: string;
  unitPriceAmount: string | null;
  unitPriceCurrency: string | null;
  active: boolean;
  features: PlanFeatureInput[];
}

export interface MembershipRecord {
  id: string;
  accountId: string;
  planId: string;
  planName: string;
  status: "active" | "disabled";
  startsAt: string;
  endsAt: string;
  source: "manual";
  reason: string;
  grantedBy: string | null;
}

export interface MembershipLedgerRecord {
  id: string;
  accountId: string;
  feature: MembershipFeature | null;
  kind: "debit" | "credit" | "adjustment";
  units: string;
  status: QuotaHoldStatus | "posted";
  reason: string;
  taskKey: string | null;
  actorId: string | null;
  occurredAt: string;
}

export type ReserveResult =
  | { ok: true; holdId: string; replay: boolean }
  | { ok: true; skipped: true }
  | { ok: false; code: string; message: string };

export const MEMBERSHIP_STORE = "MEMBERSHIP_STORE";

export interface MembershipReservation {
  accountId: string;
  feature: MembershipFeature;
  idempotencyKey: string;
  operation?: string;
  projectId?: string | null;
  taskKey?: string | null;
  units?: number;
  now?: Date;
  /** Retry of an already accepted task: do not create a hold when none exists. */
  replayOnly?: boolean;
}

export interface MembershipStore {
  ready(): Promise<boolean>;
  listPlans(workspaceId: string): Promise<MembershipPlanRecord[]>;
  savePlan(workspaceId: string, input: {
    id?: string;
    code: string;
    name: string;
    description: string;
    unitPriceAmount: string | null;
    unitPriceCurrency: string | null;
    active: boolean;
    features: PlanFeatureInput[];
  }): Promise<MembershipPlanRecord>;
  listMemberships(workspaceId: string): Promise<MembershipRecord[]>;
  currentMembership(workspaceId: string, accountId: string, now: Date): Promise<MembershipRecord | null>;
  grant(workspaceId: string, input: {
    accountId: string;
    planId: string;
    startsAt: Date;
    endsAt: Date;
    reason: string;
    grantedBy: string | null;
  }): Promise<MembershipRecord>;
  setStatus(workspaceId: string, membershipId: string, status: "active" | "disabled"): Promise<void>;
  adjust(workspaceId: string, input: {
    accountId: string;
    feature: MembershipFeature;
    delta: number;
    reason: string;
    actorId: string;
  }): Promise<number>;
  balances(workspaceId: string, accountId: string): Promise<Record<MembershipFeature, number>>;
  ledger(workspaceId: string, accountId: string): Promise<MembershipLedgerRecord[]>;
  reserve(workspaceId: string, input: MembershipReservation, transaction?: WritingQuotaTransaction): Promise<ReserveResult>;
  release(holdId: string): Promise<void>;
  bindTask(holdId: string, taskKey: string): Promise<void>;
  noteRun(input: { runId: string; outcome: "unsent" | "unknown" | "sent" }): Promise<void>;
}

interface HoldRow {
  id: string;
  workspaceId: string;
  accountId: string;
  feature: MembershipFeature;
  idempotencyKey: string;
  taskKey: string | null;
  units: number;
  status: QuotaHoldStatus;
  projectId: string | null;
}

function emptyBalances(): Record<MembershipFeature, number> {
  return { writing: 0, image: 0, voice: 0, video: 0 };
}

export class MemoryMembershipStore implements MembershipStore {
  private plans: MembershipPlanRecord[] = [];
  private memberships: MembershipRecord[] = [];
  private balance = new Map<string, number>();
  private holds: HoldRow[] = [];
  private rows: MembershipLedgerRecord[] = [];
  private tail: Promise<unknown> = Promise.resolve();

  async ready(): Promise<boolean> {
    return true;
  }

  async listPlans(): Promise<MembershipPlanRecord[]> {
    return this.plans.map((plan) => ({ ...plan, features: plan.features.map((feature) => ({ ...feature })) }));
  }

  async savePlan(_workspaceId: string, input: {
    id?: string;
    code: string;
    name: string;
    description: string;
    unitPriceAmount: string | null;
    unitPriceCurrency: string | null;
    active: boolean;
    features: PlanFeatureInput[];
  }): Promise<MembershipPlanRecord> {
    const id = input.id ?? randomUUID();
    const next: MembershipPlanRecord = {
      id,
      code: input.code,
      name: input.name,
      description: input.description,
      unitPriceAmount: input.unitPriceAmount,
      unitPriceCurrency: input.unitPriceCurrency,
      active: input.active,
      features: input.features.map((feature) => ({ ...feature })),
    };
    const index = this.plans.findIndex((plan) => plan.id === id || plan.code === input.code);
    if (index >= 0) this.plans[index] = next;
    else this.plans.push(next);
    return next;
  }

  async listMemberships(): Promise<MembershipRecord[]> {
    return [...this.memberships];
  }

  async currentMembership(_workspaceId: string, accountId: string, now: Date): Promise<MembershipRecord | null> {
    const stamp = now.getTime();
    const rows = this.memberships.filter((row) => row.accountId === accountId);
    return rows.find((row) => row.status === "active" && Date.parse(row.startsAt) <= stamp && Date.parse(row.endsAt) > stamp)
      ?? rows.sort((left, right) => Date.parse(right.endsAt) - Date.parse(left.endsAt))[0]
      ?? null;
  }

  async grant(_workspaceId: string, input: {
    accountId: string;
    planId: string;
    startsAt: Date;
    endsAt: Date;
    reason: string;
    grantedBy: string | null;
  }): Promise<MembershipRecord> {
    const plan = this.plans.find((item) => item.id === input.planId);
    if (!plan) throw new Error("PLAN_NOT_FOUND");
    const record: MembershipRecord = {
      id: randomUUID(),
      accountId: input.accountId,
      planId: plan.id,
      planName: plan.name,
      status: "active",
      startsAt: input.startsAt.toISOString(),
      endsAt: input.endsAt.toISOString(),
      source: "manual",
      reason: input.reason,
      grantedBy: input.grantedBy,
    };
    this.memberships.push(record);
    for (const feature of plan.features) {
      if (!feature.enabled || feature.includedUnits == null) continue;
      this.balance.set(`${input.accountId}:${feature.feature}`, feature.includedUnits);
      this.rows.push({
        id: randomUUID(),
        accountId: input.accountId,
        feature: feature.feature,
        kind: "adjustment",
        units: String(feature.includedUnits),
        status: "posted",
        reason: input.reason,
        taskKey: null,
        actorId: input.grantedBy,
        occurredAt: input.startsAt.toISOString(),
      });
    }
    return record;
  }

  async setStatus(_workspaceId: string, membershipId: string, status: "active" | "disabled"): Promise<void> {
    const row = this.memberships.find((item) => item.id === membershipId);
    if (!row) throw new Error("MEMBERSHIP_NOT_FOUND");
    row.status = status;
  }

  async adjust(_workspaceId: string, input: {
    accountId: string;
    feature: MembershipFeature;
    delta: number;
    reason: string;
    actorId: string;
  }): Promise<number> {
    const key = `${input.accountId}:${input.feature}`;
    const next = Math.max(0, (this.balance.get(key) ?? 0) + input.delta);
    this.balance.set(key, next);
    this.rows.push({
      id: randomUUID(),
      accountId: input.accountId,
      feature: input.feature,
      kind: "adjustment",
      units: String(input.delta),
      status: "posted",
      reason: input.reason,
      taskKey: null,
      actorId: input.actorId,
      occurredAt: new Date().toISOString(),
    });
    return next;
  }

  async balances(_workspaceId: string, accountId: string): Promise<Record<MembershipFeature, number>> {
    const result = emptyBalances();
    for (const feature of MEMBERSHIP_FEATURES) result[feature] = this.balance.get(`${accountId}:${feature}`) ?? 0;
    return result;
  }

  async ledger(_workspaceId: string, accountId: string): Promise<MembershipLedgerRecord[]> {
    return this.rows.filter((row) => row.accountId === accountId).slice().reverse();
  }

  async reserve(workspaceId: string, input: MembershipReservation): Promise<ReserveResult> {
    return this.exclusive(() => this.reserveUnlocked(workspaceId, input));
  }

  async release(holdId: string): Promise<void> {
    await this.exclusive(async () => {
      const hold = this.holds.find((item) => item.id === holdId);
      if (!hold || hold.status !== "held") return;
      hold.status = "released";
      const key = `${hold.accountId}:${hold.feature}`;
      this.balance.set(key, (this.balance.get(key) ?? 0) + hold.units);
      this.rows.push(this.ledgerFromHold(hold, "credit", "未发出的请求已释放额度"));
    });
  }

  async bindTask(holdId: string, taskKey: string): Promise<void> {
    const hold = this.holds.find((item) => item.id === holdId);
    if (hold) hold.taskKey = taskKey;
  }

  async noteRun(input: { runId: string; outcome: "unsent" | "unknown" | "sent" }): Promise<void> {
    const hold = this.holds.find((item) => item.taskKey === input.runId || item.idempotencyKey === input.runId);
    if (!hold) return;
    if (input.outcome === "unsent") await this.release(hold.id);
    else if (input.outcome === "unknown" && hold.status === "held") hold.status = "unknown";
    else if (input.outcome === "sent" && hold.status === "held") hold.status = "committed";
  }

  private async reserveUnlocked(workspaceId: string, input: MembershipReservation): Promise<ReserveResult> {
    const now = input.now ?? new Date();
    const units = input.units ?? 1;
    const scopedKey = scopeHoldKey(input.feature, input.projectId, input.idempotencyKey, input.operation);
    const existing = this.holds.find((hold) => hold.workspaceId === workspaceId && hold.accountId === input.accountId
      && hold.feature === input.feature
      && (hold.projectId ?? null) === (input.projectId ?? null)
      && (hold.idempotencyKey === scopedKey || (input.taskKey != null && hold.taskKey === input.taskKey)));
    if (!existing && input.replayOnly) return { ok: true, skipped: true };
    const membership = await this.currentMembership(workspaceId, input.accountId, now);
    const plan = membership ? this.plans.find((item) => item.id === membership.planId) : undefined;
    const feature = plan?.features.find((item) => item.feature === input.feature);
    const decision = decideReserve({
      now: now.getTime(),
      membership: membership
        ? { status: membership.status, startsAt: Date.parse(membership.startsAt), endsAt: Date.parse(membership.endsAt) }
        : null,
      featureEnabled: feature?.enabled === true,
      remaining: this.balance.get(`${input.accountId}:${input.feature}`) ?? 0,
      units,
      existing: existing ? { status: existing.status } : null,
    });
    if (decision.action === "deny") {
      return { ok: false, code: decision.code, message: membershipDenialMessage(decision.code, input.feature) };
    }
    if (decision.action === "replay" && existing) return { ok: true, holdId: existing.id, replay: true };
    const key = `${input.accountId}:${input.feature}`;
    this.balance.set(key, (this.balance.get(key) ?? 0) - units);
    if (decision.action === "rehold" && existing) {
      existing.status = "held";
      existing.units = units;
      this.rows.push(this.ledgerFromHold(existing, "debit", "重新占用额度"));
      return { ok: true, holdId: existing.id, replay: false };
    }
    const hold: HoldRow = {
      id: randomUUID(),
      workspaceId,
      accountId: input.accountId,
      feature: input.feature,
      idempotencyKey: scopedKey,
      taskKey: input.taskKey ?? null,
      units,
      status: "held",
      projectId: input.projectId ?? null,
    };
    this.holds.push(hold);
    this.rows.push(this.ledgerFromHold(hold, "debit", "提交任务占用额度"));
    return { ok: true, holdId: hold.id, replay: false };
  }

  private ledgerFromHold(hold: HoldRow, kind: "debit" | "credit", reason: string): MembershipLedgerRecord {
    return {
      id: randomUUID(),
      accountId: hold.accountId,
      feature: hold.feature,
      kind,
      units: String(hold.units),
      status: hold.status,
      reason,
      taskKey: hold.taskKey,
      actorId: null,
      occurredAt: new Date().toISOString(),
    };
  }

  private exclusive<T>(work: () => Promise<T> | T): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

async function membershipStorageReady(client: WritingQuotaTransaction): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass('creator_membership') IS NOT NULL
        AND to_regclass('creator_quota_hold') IS NOT NULL
        AND to_regclass('usage_plan_feature') IS NOT NULL AS present`,
  );
  return result.rows[0]?.present === true;
}

export class PostgresMembershipStore implements MembershipStore {
  constructor(private readonly pool: DatabasePool) {}

  async ready(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      return await membershipStorageReady(client);
    } finally {
      client.release();
    }
  }

  async listPlans(workspaceId: string): Promise<MembershipPlanRecord[]> {
    if (!await this.ready()) return [];
    const client = await this.pool.connect();
    try {
      const plans = await client.query<{
        id: string; code: string; name: string; description: string;
        unit_price_amount: string | null; unit_price_currency: string | null; active: boolean;
      }>(
        `SELECT id, code, name, description, unit_price_amount::text, unit_price_currency, active
           FROM usage_plan_catalog WHERE workspace_id = $1 ORDER BY created_at ASC`,
        [workspaceId],
      );
      const features = await client.query<{ plan_id: string; feature: MembershipFeature; enabled: boolean; included_units: string | null }>(
        `SELECT plan_id, feature, enabled, included_units::text FROM usage_plan_feature WHERE workspace_id = $1`,
        [workspaceId],
      );
      return plans.rows.map((plan) => ({
        id: plan.id,
        code: plan.code,
        name: plan.name,
        description: plan.description,
        unitPriceAmount: plan.unit_price_amount,
        unitPriceCurrency: plan.unit_price_currency,
        active: plan.active,
        features: features.rows.filter((feature) => feature.plan_id === plan.id).map((feature) => ({
          feature: feature.feature,
          enabled: feature.enabled,
          includedUnits: feature.included_units == null ? null : Number(feature.included_units),
        })),
      }));
    } finally {
      client.release();
    }
  }

  async savePlan(workspaceId: string, input: {
    id?: string;
    code: string;
    name: string;
    description: string;
    unitPriceAmount: string | null;
    unitPriceCurrency: string | null;
    active: boolean;
    features: PlanFeatureInput[];
  }): Promise<MembershipPlanRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const id = input.id ?? randomUUID();
      await client.query(
        `INSERT INTO usage_plan_catalog (
           id, workspace_id, code, name, description, included_units, unit_label,
           unit_price_amount, unit_price_currency, active
         ) VALUES ($1, $2, $3, $4, $5, NULL, '次', $6, $7, $8)
         ON CONFLICT (workspace_id, code) DO UPDATE SET
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           unit_price_amount = EXCLUDED.unit_price_amount,
           unit_price_currency = EXCLUDED.unit_price_currency,
           active = EXCLUDED.active,
           updated_at = now()`,
        [id, workspaceId, input.code, input.name, input.description, input.unitPriceAmount, input.unitPriceCurrency, input.active],
      );
      const saved = await client.query<{ id: string }>(
        `SELECT id FROM usage_plan_catalog WHERE workspace_id = $1 AND code = $2`,
        [workspaceId, input.code],
      );
      const planId = String(saved.rows[0]?.id ?? id);
      await client.query(`DELETE FROM usage_plan_feature WHERE workspace_id = $1 AND plan_id = $2`, [workspaceId, planId]);
      for (const feature of input.features) {
        await client.query(
          `INSERT INTO usage_plan_feature (id, workspace_id, plan_id, feature, enabled, included_units)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [randomUUID(), workspaceId, planId, feature.feature, feature.enabled, feature.includedUnits],
        );
      }
      await client.query("COMMIT");
      const plans = await this.listPlans(workspaceId);
      const plan = plans.find((item) => item.id === planId);
      if (!plan) throw new Error("PLAN_NOT_FOUND");
      return plan;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listMemberships(workspaceId: string): Promise<MembershipRecord[]> {
    if (!await this.ready()) return [];
    const client = await this.pool.connect();
    try {
      const result = await client.query<{
        id: string; account_id: string; plan_id: string; name: string; status: "active" | "disabled";
        starts_at: Date; ends_at: Date; source: "manual"; reason: string; granted_by: string | null;
      }>(
        `SELECT m.id, m.account_id, m.plan_id, p.name, m.status, m.starts_at, m.ends_at, m.source, m.reason, m.granted_by
           FROM creator_membership m
           JOIN usage_plan_catalog p ON p.id = m.plan_id
          WHERE m.workspace_id = $1
          ORDER BY m.created_at DESC`,
        [workspaceId],
      );
      return result.rows.map(mapMembership);
    } finally {
      client.release();
    }
  }

  async currentMembership(workspaceId: string, accountId: string, now: Date): Promise<MembershipRecord | null> {
    if (!await this.ready()) return null;
    const client = await this.pool.connect();
    try {
      const result = await client.query<{
        id: string; account_id: string; plan_id: string; name: string; status: "active" | "disabled";
        starts_at: Date; ends_at: Date; source: "manual"; reason: string; granted_by: string | null;
      }>(
        `SELECT m.id, m.account_id, m.plan_id, p.name, m.status, m.starts_at, m.ends_at, m.source, m.reason, m.granted_by
           FROM creator_membership m
           JOIN usage_plan_catalog p ON p.id = m.plan_id
          WHERE m.workspace_id = $1 AND m.account_id = $2
          ORDER BY (m.status = 'active' AND m.starts_at <= $3 AND m.ends_at > $3) DESC, m.ends_at DESC
          LIMIT 1`,
        [workspaceId, accountId, now],
      );
      const row = result.rows[0];
      return row ? mapMembership(row) : null;
    } finally {
      client.release();
    }
  }

  async grant(workspaceId: string, input: {
    accountId: string;
    planId: string;
    startsAt: Date;
    endsAt: Date;
    reason: string;
    grantedBy: string | null;
  }): Promise<MembershipRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const id = randomUUID();
      await client.query(
        `INSERT INTO creator_membership (
           id, workspace_id, account_id, plan_id, status, starts_at, ends_at, source, granted_by, reason
         ) VALUES ($1, $2, $3, $4, 'active', $5, $6, 'manual', $7, $8)`,
        [id, workspaceId, input.accountId, input.planId, input.startsAt, input.endsAt, input.grantedBy, input.reason],
      );
      const features = await client.query<{ feature: MembershipFeature; included_units: string | null }>(
        `SELECT feature, included_units::text FROM usage_plan_feature
          WHERE workspace_id = $1 AND plan_id = $2 AND enabled = true AND included_units IS NOT NULL`,
        [workspaceId, input.planId],
      );
      for (const feature of features.rows) {
        await client.query(
          `INSERT INTO creator_feature_balance (workspace_id, account_id, feature, remaining_units)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (workspace_id, account_id, feature) DO UPDATE SET remaining_units = EXCLUDED.remaining_units, updated_at = now()`,
          [workspaceId, input.accountId, feature.feature, feature.included_units],
        );
        await insertLedger(client, {
          workspaceId,
          accountId: input.accountId,
          feature: feature.feature,
          kind: "adjustment",
          units: feature.included_units ?? "0",
          reason: input.reason,
          idempotencyKey: `grant:${id}:${feature.feature}`,
          actorId: input.grantedBy,
        });
      }
      await client.query("COMMIT");
      const current = await this.currentMembership(workspaceId, input.accountId, input.startsAt);
      if (!current) throw new Error("MEMBERSHIP_NOT_FOUND");
      return current;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async setStatus(workspaceId: string, membershipId: string, status: "active" | "disabled"): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `UPDATE creator_membership SET status = $3 WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, membershipId, status],
      );
    } finally {
      client.release();
    }
  }

  async adjust(workspaceId: string, input: {
    accountId: string;
    feature: MembershipFeature;
    delta: number;
    reason: string;
    actorId: string;
  }): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO creator_feature_balance (workspace_id, account_id, feature, remaining_units)
         VALUES ($1, $2, $3, 0)
         ON CONFLICT (workspace_id, account_id, feature) DO NOTHING`,
        [workspaceId, input.accountId, input.feature],
      );
      const updated = await client.query<{ remaining_units: string }>(
        `UPDATE creator_feature_balance
            SET remaining_units = GREATEST(0, remaining_units + $4), updated_at = now()
          WHERE workspace_id = $1 AND account_id = $2 AND feature = $3
          RETURNING remaining_units::text`,
        [workspaceId, input.accountId, input.feature, input.delta],
      );
      const remaining = Number(updated.rows[0]?.remaining_units ?? 0);
      await insertLedger(client, {
        workspaceId,
        accountId: input.accountId,
        feature: input.feature,
        kind: "adjustment",
        units: String(input.delta),
        reason: input.reason,
        idempotencyKey: `adjust:${randomUUID()}`,
        actorId: input.actorId,
      });
      await client.query("COMMIT");
      return remaining;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async balances(workspaceId: string, accountId: string): Promise<Record<MembershipFeature, number>> {
    const result = emptyBalances();
    if (!await this.ready()) return result;
    const client = await this.pool.connect();
    try {
      const rows = await client.query<{ feature: MembershipFeature; remaining_units: string }>(
        `SELECT feature, remaining_units::text FROM creator_feature_balance WHERE workspace_id = $1 AND account_id = $2`,
        [workspaceId, accountId],
      );
      for (const row of rows.rows) result[row.feature] = Number(row.remaining_units);
      return result;
    } finally {
      client.release();
    }
  }

  async ledger(workspaceId: string, accountId: string): Promise<MembershipLedgerRecord[]> {
    if (!await this.ready()) return [];
    const client = await this.pool.connect();
    try {
      const rows = await client.query<{
        id: string; entry_kind: "debit" | "credit" | "adjustment"; usage_json: { feature?: MembershipFeature; units?: string; reason?: string; actorId?: string; taskKey?: string; holdStatus?: QuotaHoldStatus };
        occurred_at: Date;
      }>(
        `SELECT id, entry_kind, usage_json, occurred_at FROM creator_usage_ledger
          WHERE workspace_id = $1 AND account_id = $2
          ORDER BY occurred_at DESC LIMIT 50`,
        [workspaceId, accountId],
      );
      return rows.rows.map((row) => ({
        id: row.id,
        accountId,
        feature: row.usage_json.feature ?? null,
        kind: row.entry_kind,
        units: String(row.usage_json.units ?? ""),
        status: row.usage_json.holdStatus ?? "posted",
        reason: String(row.usage_json.reason ?? ""),
        taskKey: row.usage_json.taskKey ?? null,
        actorId: row.usage_json.actorId ?? null,
        occurredAt: row.occurred_at.toISOString(),
      }));
    } finally {
      client.release();
    }
  }

  async reserve(workspaceId: string, input: MembershipReservation, transaction?: WritingQuotaTransaction): Promise<ReserveResult> {
    if (transaction) return this.reserveInTransaction(transaction, workspaceId, input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this.reserveInTransaction(client, workspaceId, input);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async reserveInTransaction(client: WritingQuotaTransaction, workspaceId: string, input: MembershipReservation): Promise<ReserveResult> {
    if (!await membershipStorageReady(client)) return { ok: true, skipped: true };
    const now = input.now ?? new Date();
    const units = input.units ?? 1;
    const scopedKey = scopeHoldKey(input.feature, input.projectId, input.idempotencyKey, input.operation);
    // A new hold has no row to lock. Serialize reservations before the replay lookup.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `membership-quota:${workspaceId}:${input.accountId}:${input.feature}`,
    ]);
    const existing = await client.query<{ id: string; status: QuotaHoldStatus }>(
      `SELECT id, status FROM creator_quota_hold
        WHERE workspace_id = $1 AND account_id = $2 AND feature = $5
          AND project_id IS NOT DISTINCT FROM $6::uuid
          AND (idempotency_key = $3 OR ($4::text IS NOT NULL AND task_key = $4))
        FOR UPDATE`,
      [workspaceId, input.accountId, scopedKey, input.taskKey ?? null, input.feature, input.projectId ?? null],
    );
    if (existing.rows.length === 0 && input.replayOnly) {
      return { ok: true, skipped: true };
    }
    const membership = await client.query<{ status: "active" | "disabled"; starts_at: Date; ends_at: Date; plan_id: string }>(
      `SELECT status, starts_at, ends_at, plan_id FROM creator_membership
        WHERE workspace_id = $1 AND account_id = $2
        ORDER BY (status = 'active' AND starts_at <= $3 AND ends_at > $3) DESC, ends_at DESC
        LIMIT 1`,
      [workspaceId, input.accountId, now],
    );
    const planId = membership.rows[0]?.plan_id;
    const feature = planId
      ? await client.query<{ enabled: boolean }>(
        `SELECT enabled FROM usage_plan_feature WHERE workspace_id = $1 AND plan_id = $2 AND feature = $3`,
        [workspaceId, planId, input.feature],
      )
      : { rows: [] as { enabled: boolean }[] };
    const balance = await client.query<{ remaining_units: string }>(
      `SELECT remaining_units::text FROM creator_feature_balance
        WHERE workspace_id = $1 AND account_id = $2 AND feature = $3 FOR UPDATE`,
      [workspaceId, input.accountId, input.feature],
    );
    const row = membership.rows[0];
    const decision = decideReserve({
      now: now.getTime(),
      membership: row ? { status: row.status, startsAt: row.starts_at.getTime(), endsAt: row.ends_at.getTime() } : null,
      featureEnabled: feature.rows[0]?.enabled === true,
      remaining: Number(balance.rows[0]?.remaining_units ?? 0),
      units,
      existing: existing.rows[0] ? { status: existing.rows[0].status } : null,
    });
    if (decision.action === "deny") {
      return { ok: false, code: decision.code, message: membershipDenialMessage(decision.code, input.feature) };
    }
    if (decision.action === "replay") {
      return { ok: true, holdId: String(existing.rows[0]?.id), replay: true };
    }
    await client.query(
      `UPDATE creator_feature_balance SET remaining_units = remaining_units - $4, updated_at = now()
        WHERE workspace_id = $1 AND account_id = $2 AND feature = $3`,
      [workspaceId, input.accountId, input.feature, units],
    );
    let holdId = existing.rows[0]?.id;
    if (decision.action === "rehold" && holdId) {
      await client.query(
        `UPDATE creator_quota_hold SET status = 'held', units = $2, updated_at = now() WHERE id = $1`,
        [holdId, units],
      );
    } else {
      holdId = randomUUID();
      await client.query(
        `INSERT INTO creator_quota_hold (
           id, workspace_id, account_id, feature, project_id, task_key, idempotency_key, units, status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'held')`,
        [holdId, workspaceId, input.accountId, input.feature, input.projectId ?? null, input.taskKey ?? null, scopedKey, units],
      );
    }
    await insertLedger(client, {
      workspaceId,
      accountId: input.accountId,
      feature: input.feature,
      kind: "debit",
      units: String(units),
      reason: decision.action === "rehold" ? "重新占用额度" : "提交任务占用额度",
      idempotencyKey: `hold:${holdId}:debit:${randomUUID()}`,
      actorId: null,
      taskKey: input.taskKey ?? null,
      holdStatus: "held",
    });
    return { ok: true, holdId: String(holdId), replay: false };
  }

  async release(holdId: string): Promise<void> {
    if (!await this.ready()) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query<{ workspace_id: string; account_id: string; feature: MembershipFeature; units: string }>(
        `UPDATE creator_quota_hold SET status = 'released', updated_at = now()
          WHERE id = $1 AND status = 'held'
          RETURNING workspace_id, account_id, feature, units::text`,
        [holdId],
      );
      const hold = updated.rows[0];
      if (hold) {
        await client.query(
          `UPDATE creator_feature_balance SET remaining_units = remaining_units + $4, updated_at = now()
            WHERE workspace_id = $1 AND account_id = $2 AND feature = $3`,
          [hold.workspace_id, hold.account_id, hold.feature, hold.units],
        );
        await insertLedger(client, {
          workspaceId: hold.workspace_id,
          accountId: hold.account_id,
          feature: hold.feature,
          kind: "credit",
          units: hold.units,
          reason: "未发出的请求已释放额度",
          idempotencyKey: `hold:${holdId}:release:${randomUUID()}`,
          actorId: null,
          holdStatus: "released",
        });
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async bindTask(holdId: string, taskKey: string): Promise<void> {
    if (!await this.ready()) return;
    const client = await this.pool.connect();
    try {
      await client.query(`UPDATE creator_quota_hold SET task_key = $2, updated_at = now() WHERE id = $1`, [holdId, taskKey]);
    } finally {
      client.release();
    }
  }

  async noteRun(input: { runId: string; outcome: "unsent" | "unknown" | "sent" }): Promise<void> {
    if (!await this.ready()) return;
    const client = await this.pool.connect();
    let releaseId: string | null = null;
    try {
      const found = await client.query<{ id: string; status: QuotaHoldStatus }>(
        `SELECT id, status FROM creator_quota_hold WHERE task_key = $1 OR idempotency_key = $1 ORDER BY created_at DESC LIMIT 1`,
        [input.runId],
      );
      const hold = found.rows[0];
      if (!hold || hold.status !== "held") return;
      if (input.outcome === "unsent") releaseId = hold.id;
      else {
        const status = input.outcome === "unknown" ? "unknown" : "committed";
        await client.query(`UPDATE creator_quota_hold SET status = $2, updated_at = now() WHERE id = $1 AND status = 'held'`, [hold.id, status]);
      }
    } finally {
      client.release();
    }
    if (releaseId) await this.release(releaseId);
  }
}

function scopeHoldKey(feature: MembershipFeature, projectId: string | null | undefined, key: string, operation?: string): string {
  if (operation !== undefined) {
    // Legacy keys start with a feature name or are bare hashes; even an arbitrary old client key cannot alias a new hold.
    const identity = JSON.stringify([feature, projectId ?? null, operation, key]);
    return `task:${createHash("sha256").update(identity).digest("hex")}`;
  }
  const scoped = `${feature}:${projectId ?? "-"}:${key}`;
  return scoped.length <= 200 ? scoped : createHash("sha256").update(scoped).digest("hex");
}

function mapMembership(row: {
  id: string; account_id: string; plan_id: string; name: string; status: "active" | "disabled";
  starts_at: Date; ends_at: Date; source: "manual"; reason: string; granted_by: string | null;
}): MembershipRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    planId: row.plan_id,
    planName: row.name,
    status: row.status,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    source: "manual",
    reason: row.reason,
    grantedBy: row.granted_by,
  };
}

async function insertLedger(client: { query(sql: string, values?: unknown[]): Promise<unknown> }, input: {
  workspaceId: string;
  accountId: string;
  feature: MembershipFeature;
  kind: "debit" | "credit" | "adjustment";
  units: string;
  reason: string;
  idempotencyKey: string;
  actorId: string | null;
  taskKey?: string | null;
  holdStatus?: QuotaHoldStatus;
}): Promise<void> {
  await client.query(
    `INSERT INTO creator_usage_ledger (
       id, workspace_id, account_id, project_id, task_key, entry_kind, status, usage_json,
       amount_decimal, currency, idempotency_key
     ) VALUES ($1, $2, $3, NULL, $4, $5, 'pending_price', $6::jsonb, NULL, NULL, $7)
     ON CONFLICT (workspace_id, account_id, idempotency_key) DO NOTHING`,
    [
      randomUUID(),
      input.workspaceId,
      input.accountId,
      input.taskKey ?? null,
      input.kind,
      JSON.stringify({
        feature: input.feature,
        units: input.units,
        reason: input.reason,
        actorId: input.actorId,
        taskKey: input.taskKey ?? null,
        holdStatus: input.holdStatus ?? "posted",
        source: "manual",
      }),
      input.idempotencyKey,
    ],
  );
}
