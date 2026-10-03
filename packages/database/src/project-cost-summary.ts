import type { QueryResultRow } from "pg";
import { buildProjectCostSummary, type ProjectCostSummary } from "@ai-drama/domain";
import type { DatabasePool } from "./job-service";
import { PersistenceError } from "./job-service";

const AMOUNT_FORMAT = "999999999999999999999999999999999990.00000000";

export const PROJECT_COST_SUMMARY_TRANSACTION = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";

export const PROJECT_COST_SUMMARY_SQL = `
WITH ledger AS (
  SELECT id, btrim(currency::text) AS currency, amount_decimal, kind, job_attempt_id, generation_job_id, supersedes_cost_id
    FROM cost_ledger
   WHERE workspace_id = $1 AND project_id = $2
),
actual_refs AS (
  SELECT supersedes_cost_id
    FROM ledger
   WHERE kind = 'ACTUAL' AND supersedes_cost_id IS NOT NULL
),
currency_rows AS (
  SELECT currency,
         btrim(to_char(COALESCE(SUM(amount_decimal) FILTER (WHERE kind = 'ACTUAL'), 0), '${AMOUNT_FORMAT}')) AS actual_amount,
         btrim(to_char(COALESCE(SUM(amount_decimal) FILTER (
           WHERE kind = 'ESTIMATED'
             AND NOT EXISTS (SELECT 1 FROM actual_refs ref WHERE ref.supersedes_cost_id = ledger.id)
         ), 0), '${AMOUNT_FORMAT}')) AS outstanding_estimated_amount,
         COUNT(*) FILTER (WHERE kind = 'ACTUAL')::int AS actual_entry_count,
         COUNT(*) FILTER (
           WHERE kind = 'ESTIMATED'
             AND NOT EXISTS (SELECT 1 FROM actual_refs ref WHERE ref.supersedes_cost_id = ledger.id)
         )::int AS outstanding_estimated_entry_count,
         COUNT(*) FILTER (
           WHERE kind = 'ESTIMATED'
             AND EXISTS (SELECT 1 FROM actual_refs ref WHERE ref.supersedes_cost_id = ledger.id)
         )::int AS superseded_estimated_entry_count
    FROM ledger
   GROUP BY currency
)
SELECT
  EXISTS(SELECT 1 FROM project WHERE id = $2 AND workspace_id = $1) AS project_found,
  statement_timestamp() AS snapshot_at,
  (SELECT COUNT(*)::int FROM ledger) AS ledger_row_count,
  COALESCE((SELECT jsonb_agg(to_jsonb(currency_rows) ORDER BY currency_rows.currency) FROM currency_rows), '[]'::jsonb) AS currencies,
  (SELECT COUNT(*)::int FROM generation_job WHERE workspace_id = $1 AND project_id = $2) AS job_count,
  (SELECT COUNT(*)::int
     FROM job_attempt attempt
     JOIN generation_job job
       ON job.id = attempt.generation_job_id
      AND job.workspace_id = attempt.workspace_id
    WHERE job.workspace_id = $1 AND job.project_id = $2) AS attempt_count,
  (SELECT COUNT(*)::int
     FROM generation_job job
    WHERE job.workspace_id = $1
      AND job.project_id = $2
      AND NOT EXISTS (SELECT 1 FROM ledger WHERE ledger.generation_job_id = job.id)) AS jobs_without_ledger_count,
  (SELECT COUNT(*)::int
     FROM job_attempt attempt
     JOIN generation_job job
       ON job.id = attempt.generation_job_id
      AND job.workspace_id = attempt.workspace_id
    WHERE job.workspace_id = $1
      AND job.project_id = $2
      AND attempt.provider_request_id IS NOT NULL
      AND attempt.provider_configuration_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM ledger WHERE ledger.job_attempt_id = attempt.id)) AS provider_bound_attempts_without_ledger_count,
  (SELECT COUNT(*)::int
     FROM job_attempt attempt
     JOIN generation_job job
       ON job.id = attempt.generation_job_id
      AND job.workspace_id = attempt.workspace_id
    WHERE job.workspace_id = $1
      AND job.project_id = $2
      AND job.input_snapshot->>'schema' IN ('m4.shot.compose.v1', 'm4.episode.compose.v1')) AS local_compose_attempt_count,
  (SELECT COUNT(*)::int FROM ledger WHERE job_attempt_id IS NULL) AS ledger_rows_without_attempt_count
`;

export async function readProjectCostSummary(pool: DatabasePool, workspaceId: string, projectId: string): Promise<ProjectCostSummary> {
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query(PROJECT_COST_SUMMARY_TRANSACTION);
    const result = await client.query<QueryResultRow>(PROJECT_COST_SUMMARY_SQL, [workspaceId, projectId]);
    await client.query("COMMIT");
    committed = true;
    const row = result.rows[0];
    if (!row?.project_found) throw new PersistenceError("NOT_FOUND", "Project not found");
    const snapshotAt = row.snapshot_at instanceof Date ? row.snapshot_at.toISOString() : String(row.snapshot_at);
    return buildProjectCostSummary({
      projectId,
      snapshotAt,
      ledgerRowCount: integer(row.ledger_row_count),
      currencies: currencies(row.currencies).map((item) => ({
        currency: String(item.currency),
        actualAmount: String(item.actual_amount),
        outstandingEstimatedAmount: String(item.outstanding_estimated_amount),
        actualEntryCount: integer(item.actual_entry_count),
        outstandingEstimatedEntryCount: integer(item.outstanding_estimated_entry_count),
        supersededEstimatedEntryCount: integer(item.superseded_estimated_entry_count),
      })),
      coverage: {
        jobCount: integer(row.job_count),
        attemptCount: integer(row.attempt_count),
        jobsWithoutLedgerCount: integer(row.jobs_without_ledger_count),
        providerBoundAttemptsWithoutLedgerCount: integer(row.provider_bound_attempts_without_ledger_count),
        localComposeAttemptCount: integer(row.local_compose_attempt_count),
        ledgerRowsWithoutAttemptCount: integer(row.ledger_rows_without_attempt_count),
      },
    });
  } catch (error) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function currencies(value: unknown): QueryResultRow[] {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed)) throw new PersistenceError("VALIDATION_ERROR", "Cost currency aggregate is invalid");
  return parsed as QueryResultRow[];
}

function integer(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && String(parsed) === value) return parsed;
  }
  throw new PersistenceError("VALIDATION_ERROR", "Cost count is invalid");
}
