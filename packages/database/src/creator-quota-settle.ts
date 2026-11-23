import { randomUUID } from "node:crypto";

type Queryable = {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
};

/**
 * Close the membership hold for one media job. Missing membership tables are ignored so older
 * databases keep completing jobs. A second receipt does not debit or credit again.
 */
export async function settleCreatorQuotaHold(
  client: Queryable,
  taskKey: string,
  outcome: "unsent" | "unknown" | "sent",
): Promise<void> {
  await client.query("SAVEPOINT creator_quota_settle");
  try {
    if (outcome === "unsent") {
      const updated = await client.query(
        `UPDATE creator_quota_hold SET status = 'released', updated_at = now()
          WHERE status = 'held' AND (task_key = $1 OR idempotency_key = $1)
          RETURNING id, workspace_id, account_id, feature, units::text`,
        [taskKey],
      );
      const hold = updated.rows[0];
      if (hold) {
        await client.query(
          `UPDATE creator_feature_balance SET remaining_units = remaining_units + $4, updated_at = now()
            WHERE workspace_id = $1 AND account_id = $2 AND feature = $3`,
          [hold.workspace_id, hold.account_id, hold.feature, hold.units],
        );
        await client.query(
          `INSERT INTO creator_usage_ledger (
             id, workspace_id, account_id, project_id, task_key, entry_kind, status, usage_json,
             amount_decimal, currency, idempotency_key
           ) VALUES ($1, $2, $3, NULL, $4, 'credit', 'pending_price', $5::jsonb, NULL, NULL, $6)
           ON CONFLICT (workspace_id, account_id, idempotency_key) DO NOTHING`,
          [
            randomUUID(),
            hold.workspace_id,
            hold.account_id,
            taskKey,
            JSON.stringify({ feature: hold.feature, units: hold.units, reason: "未发出的请求已释放额度", holdStatus: "released" }),
            `hold:${String(hold.id)}:release`,
          ],
        );
      }
    } else {
      const status = outcome === "unknown" ? "unknown" : "committed";
      await client.query(
        `UPDATE creator_quota_hold SET status = $2, updated_at = now()
          WHERE status = 'held' AND (task_key = $1 OR idempotency_key = $1)`,
        [taskKey, status],
      );
    }
    await client.query("RELEASE SAVEPOINT creator_quota_settle");
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT creator_quota_settle");
    const code = (error as { code?: string }).code;
    if (code === "42P01" || code === "42703") return;
    throw error;
  }
}
