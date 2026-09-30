import type { PoolClient, QueryResultRow } from "pg";
import { PersistenceError } from "./job-service";

export interface ProviderActualCostInput {
  workspaceId: string;
  projectId: string;
  generationJobId: string;
  jobAttemptId: string;
  providerConfigurationId: string;
  providerRequestId: string;
  idempotencyKey: string;
  currency: string;
  amountDecimal: string;
  kind: string;
  basis: string;
  unitType: string;
  unitQuantity: string;
  unitPriceSnapshot: string;
  provider: string;
  model: string;
  supersedesEstimateKey?: string;
}

export interface StoredProviderCost {
  projectId: string;
  generationJobId: string;
  jobAttemptId: string;
  providerConfigurationId: string;
  providerRequestId: string;
  idempotencyKey: string;
  currency: string;
  amountDecimal: string;
  kind: string;
  basis: string;
  unitType: string | null;
  unitQuantity: string | null;
  unitPriceSnapshot: string | null;
  provider: string;
  model: string;
  supersedesEstimateKey: string | null;
}

export function assertSyncActualCost(input: ProviderActualCostInput): void {
  if (input.supersedesEstimateKey) {
    throw new PersistenceError("COST_CONFLICT", "Synchronous actual cost cannot reference an estimate");
  }
  if (input.kind !== "ACTUAL" || input.currency !== "USD" || input.basis !== "PROVIDER_REPORTED") {
    throw new PersistenceError("COST_CONFLICT", "Mock media cost must be a zero-dollar provider actual");
  }
  if (!sameDecimal(input.amountDecimal, "0") || input.unitType !== "request") {
    throw new PersistenceError("COST_CONFLICT", "Mock media cost must be a zero-dollar provider actual");
  }
  if (!sameDecimal(input.unitQuantity, "1") || !sameDecimal(input.unitPriceSnapshot, "0")) {
    throw new PersistenceError("COST_CONFLICT", "Mock media cost must be a zero-dollar provider actual");
  }
  if (!input.idempotencyKey || !input.provider || !input.model) {
    throw new PersistenceError("COST_CONFLICT", "Mock media cost lineage is incomplete");
  }
}

export function providerCostMatches(existing: StoredProviderCost, incoming: ProviderActualCostInput): boolean {
  return existing.projectId === incoming.projectId
    && existing.generationJobId === incoming.generationJobId
    && existing.jobAttemptId === incoming.jobAttemptId
    && existing.providerConfigurationId === incoming.providerConfigurationId
    && existing.providerRequestId === incoming.providerRequestId
    && existing.idempotencyKey === incoming.idempotencyKey
    && existing.currency === incoming.currency
    && sameDecimal(existing.amountDecimal, incoming.amountDecimal)
    && existing.kind === incoming.kind
    && existing.basis === incoming.basis
    && existing.unitType === incoming.unitType
    && existing.unitQuantity !== null
    && sameDecimal(existing.unitQuantity, incoming.unitQuantity)
    && existing.unitPriceSnapshot !== null
    && sameDecimal(existing.unitPriceSnapshot, incoming.unitPriceSnapshot)
    && existing.provider === incoming.provider
    && existing.model === incoming.model
    && existing.supersedesEstimateKey === null
    && !incoming.supersedesEstimateKey;
}

export async function recordProviderActualCost(
  client: PoolClient,
  input: ProviderActualCostInput,
): Promise<void> {
  assertSyncActualCost(input);
  const inserted = await client.query<QueryResultRow>(
    `INSERT INTO cost_ledger
      (workspace_id, project_id, generation_job_id, job_attempt_id,
       idempotency_key, provider_configuration_id, provider_request_id,
       currency, amount_decimal, kind, basis,
       unit_type, unit_quantity, unit_price_snapshot, provider, model)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::numeric,$10,$11,$12,$13::numeric,$14::numeric,$15,$16)
     ON CONFLICT (workspace_id, provider_configuration_id, idempotency_key)
       WHERE provider_configuration_id IS NOT NULL AND idempotency_key IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [
      input.workspaceId, input.projectId, input.generationJobId, input.jobAttemptId,
      input.idempotencyKey, input.providerConfigurationId, input.providerRequestId,
      input.currency, input.amountDecimal, input.kind, input.basis,
      input.unitType, input.unitQuantity, input.unitPriceSnapshot, input.provider, input.model,
    ],
  );
  if (inserted.rows[0]) return;
  const existing = await client.query<QueryResultRow>(
    `SELECT project_id, generation_job_id, job_attempt_id, provider_configuration_id,
            provider_request_id, idempotency_key, currency, amount_decimal::text AS amount_decimal,
            kind, basis, unit_type, unit_quantity::text AS unit_quantity,
            unit_price_snapshot::text AS unit_price_snapshot, provider, model, supersedes_estimate_key
       FROM cost_ledger
      WHERE workspace_id = $1
        AND provider_configuration_id = $2
        AND idempotency_key = $3`,
    [input.workspaceId, input.providerConfigurationId, input.idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row || !providerCostMatches(mapStoredCost(row), input)) {
    throw new PersistenceError("COST_CONFLICT", "Mock media cost does not match the stored ledger row");
  }
}

function mapStoredCost(row: QueryResultRow): StoredProviderCost {
  return {
    projectId: String(row.project_id),
    generationJobId: String(row.generation_job_id),
    jobAttemptId: String(row.job_attempt_id),
    providerConfigurationId: String(row.provider_configuration_id),
    providerRequestId: String(row.provider_request_id),
    idempotencyKey: String(row.idempotency_key),
    currency: String(row.currency).trim(),
    amountDecimal: String(row.amount_decimal),
    kind: String(row.kind),
    basis: String(row.basis),
    unitType: row.unit_type === null ? null : String(row.unit_type),
    unitQuantity: row.unit_quantity === null ? null : String(row.unit_quantity),
    unitPriceSnapshot: row.unit_price_snapshot === null ? null : String(row.unit_price_snapshot),
    provider: String(row.provider),
    model: String(row.model),
    supersedesEstimateKey: row.supersedes_estimate_key === null ? null : String(row.supersedes_estimate_key),
  };
}

function sameDecimal(left: string, right: string): boolean {
  if (!/^\d+(\.\d+)?$/.test(left) || !/^\d+(\.\d+)?$/.test(right)) return false;
  const [leftWhole = "0", leftFraction = ""] = left.split(".");
  const [rightWhole = "0", rightFraction = ""] = right.split(".");
  return BigInt(leftWhole) === BigInt(rightWhole)
    && leftFraction.replace(/0+$/, "") === rightFraction.replace(/0+$/, "");
}
