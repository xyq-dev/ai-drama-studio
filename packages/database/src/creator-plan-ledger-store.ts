import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import { PersistenceError, type DatabasePool } from "./job-service";

export interface UsagePlanCatalogRecord {
  id: string;
  workspaceId: string;
  code: string;
  name: string;
  description: string;
  includedUnits: string | null;
  unitLabel: string;
  unitPriceAmount: string | null;
  unitPriceCurrency: string | null;
  active: boolean;
}

export interface CreatorPlanStatus {
  accountId: string;
  plan: UsagePlanCatalogRecord | null;
  entitlementStatus: "active" | "exhausted" | "unpriced" | null;
  remainingUnits: string | null;
}

export interface CreatorLedgerEntry {
  id: string;
  workspaceId: string;
  accountId: string;
  projectId: string | null;
  taskKey: string | null;
  entryKind: "debit" | "credit" | "adjustment";
  status: "pending_price" | "posted";
  usageJson: unknown;
  amountDecimal: string | null;
  currency: string | null;
  idempotencyKey: string;
  occurredAt: string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapPlan(row: QueryResultRow): UsagePlanCatalogRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    code: String(row.code),
    name: String(row.name),
    description: String(row.description ?? ""),
    includedUnits: row.included_units == null ? null : String(row.included_units),
    unitLabel: String(row.unit_label ?? "unit"),
    unitPriceAmount: row.unit_price_amount == null ? null : String(row.unit_price_amount),
    unitPriceCurrency: row.unit_price_currency == null ? null : String(row.unit_price_currency),
    active: row.active === true,
  };
}

function mapLedger(row: QueryResultRow): CreatorLedgerEntry {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    accountId: String(row.account_id),
    projectId: row.project_id == null ? null : String(row.project_id),
    taskKey: row.task_key == null ? null : String(row.task_key),
    entryKind: String(row.entry_kind) as CreatorLedgerEntry["entryKind"],
    status: String(row.status) as CreatorLedgerEntry["status"],
    usageJson: row.usage_json,
    amountDecimal: row.amount_decimal == null ? null : String(row.amount_decimal),
    currency: row.currency == null ? null : String(row.currency),
    idempotencyKey: String(row.idempotency_key),
    occurredAt: iso(row.occurred_at as Date),
  };
}

/**
 * Configurable usage-plan + auditable creator ledger skeleton.
 * Does not charge, top up, or talk to any payment channel. Unconfirmed posts are refused in application code.
 */
export class CreatorPlanLedgerStore {
  constructor(private readonly pool: DatabasePool) {}

  async ready(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ present: boolean }>(
        `SELECT to_regclass('usage_plan_catalog') IS NOT NULL
            AND to_regclass('creator_usage_ledger') IS NOT NULL AS present`,
      );
      return result.rows[0]?.present === true;
    } finally {
      client.release();
    }
  }

  async getPlanStatus(workspaceId: string, accountId: string): Promise<CreatorPlanStatus> {
    const client = await this.pool.connect();
    try {
      if (!await this.tablesPresent(client)) {
        return { accountId, plan: null, entitlementStatus: null, remainingUnits: null };
      }
      const result = await client.query<QueryResultRow>(
        `SELECT e.status AS entitlement_status, e.remaining_units,
                p.id, p.workspace_id, p.code, p.name, p.description, p.included_units, p.unit_label,
                p.unit_price_amount, p.unit_price_currency, p.active
           FROM creator_plan_entitlement e
           JOIN usage_plan_catalog p ON p.id = e.plan_id AND p.workspace_id = e.workspace_id
          WHERE e.workspace_id = $1 AND e.account_id = $2`,
        [workspaceId, accountId],
      );
      const row = result.rows[0];
      if (!row) return { accountId, plan: null, entitlementStatus: null, remainingUnits: null };
      return {
        accountId,
        plan: mapPlan(row),
        entitlementStatus: String(row.entitlement_status) as CreatorPlanStatus["entitlementStatus"],
        remainingUnits: row.remaining_units == null ? null : String(row.remaining_units),
      };
    } finally {
      client.release();
    }
  }

  async ensureDefaultEntitlement(workspaceId: string, accountId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      if (!await this.tablesPresent(client)) return;
      await client.query(
        `INSERT INTO creator_plan_entitlement (id, workspace_id, account_id, plan_id, remaining_units, status)
         SELECT $3, $1, $2, p.id, NULL, 'unpriced'
           FROM usage_plan_catalog p
          WHERE p.workspace_id = $1 AND p.code = 'default'
         ON CONFLICT (workspace_id, account_id) DO NOTHING`,
        [workspaceId, accountId, randomUUID()],
      );
    } finally {
      client.release();
    }
  }

  async listLedger(workspaceId: string, accountId: string, limit = 50): Promise<CreatorLedgerEntry[]> {
    const client = await this.pool.connect();
    try {
      if (!await this.tablesPresent(client)) return [];
      const result = await client.query<QueryResultRow>(
        `SELECT id, workspace_id, account_id, project_id, task_key, entry_kind, status, usage_json,
                amount_decimal, currency, idempotency_key, occurred_at
           FROM creator_usage_ledger
          WHERE workspace_id = $1 AND account_id = $2
          ORDER BY occurred_at DESC, id DESC
          LIMIT $3`,
        [workspaceId, accountId, Math.min(Math.max(limit, 1), 100)],
      );
      return result.rows.map(mapLedger);
    } finally {
      client.release();
    }
  }

  /**
   * Posts a ledger row only when confirmed === true. Unconfirmed clicks must call this with confirmed false
   * (or not call it); this method then writes nothing.
   */
  async postLedgerEntry(input: {
    workspaceId: string;
    accountId: string;
    projectId?: string | null;
    taskKey?: string | null;
    entryKind: CreatorLedgerEntry["entryKind"];
    usageJson?: unknown;
    idempotencyKey: string;
    confirmed: boolean;
    /** When amount is omitted/null, status is pending_price (尚未计价). */
    amountDecimal?: string | null;
    currency?: string | null;
    occurredAt?: Date;
  }): Promise<CreatorLedgerEntry | null> {
    if (input.confirmed !== true) return null;
    const priced = input.amountDecimal != null && input.currency != null && input.currency.length === 3;
    const status = priced ? "posted" : "pending_price";
    const client = await this.pool.connect();
    try {
      if (!await this.tablesPresent(client)) {
        throw new PersistenceError("NOT_FOUND", "Creator ledger is not migrated");
      }
      const result = await client.query<QueryResultRow>(
        `INSERT INTO creator_usage_ledger (
           id, workspace_id, account_id, project_id, task_key, entry_kind, status, usage_json,
           amount_decimal, currency, idempotency_key, occurred_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::jsonb,
           $9, $10, $11, $12
         )
         ON CONFLICT (workspace_id, account_id, idempotency_key) DO UPDATE
           SET idempotency_key = EXCLUDED.idempotency_key
         RETURNING id, workspace_id, account_id, project_id, task_key, entry_kind, status, usage_json,
                   amount_decimal, currency, idempotency_key, occurred_at`,
        [
          randomUUID(), input.workspaceId, input.accountId, input.projectId ?? null, input.taskKey ?? null,
          input.entryKind, status, JSON.stringify(input.usageJson ?? {}),
          priced ? input.amountDecimal : null, priced ? input.currency : null,
          input.idempotencyKey, input.occurredAt ?? new Date(),
        ],
      );
      const row = result.rows[0];
      if (!row) throw new PersistenceError("VALIDATION_ERROR", "Ledger entry was not created");
      return mapLedger(row);
    } finally {
      client.release();
    }
  }

  private async tablesPresent(client: { query(sql: string, values?: unknown[]): Promise<{ rows: QueryResultRow[] }> }): Promise<boolean> {
    const result = await client.query(
      `SELECT to_regclass('usage_plan_catalog') IS NOT NULL
          AND to_regclass('creator_usage_ledger') IS NOT NULL AS present`,
    );
    return result.rows[0]?.present === true;
  }
}
