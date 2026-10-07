import type { PoolClient, QueryResultRow } from "pg";
import { CHARACTER_REFERENCE_JOB_KIND, parseCharacterReferenceSnapshot } from "@ai-drama/domain";
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

const FIXED_IMAGE_SNAPSHOT_KEYS = ["outcome", "schema", "seed", "shotRevisionId"];

/** Legal synchronous image jobs are only the frozen v1 success snapshot. */
export function assertFixedMockImageSnapshot(snapshot: unknown, shotRevisionId: string): void {
  if (!isPlainRecord(snapshot)) {
    throw new PersistenceError("COST_CONFLICT", "Mock image accounting snapshot is not a fixed success job");
  }
  const keys = Object.keys(snapshot).sort();
  // v1 originally had four fields. Accept its optional later extension without
  // normalizing persisted snapshots, hashes, or provider request identities.
  const hasBypassCache = Object.prototype.hasOwnProperty.call(snapshot, "bypassCache");
  const expected = [...FIXED_IMAGE_SNAPSHOT_KEYS, ...(hasBypassCache ? ["bypassCache"] : [])].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new PersistenceError("COST_CONFLICT", "Mock image accounting snapshot is not a fixed success job");
  }
  if (snapshot.schema !== "m3.mock.image.v1"
    || snapshot.outcome !== "success"
    || snapshot.shotRevisionId !== shotRevisionId) {
    throw new PersistenceError("COST_CONFLICT", "Mock image accounting snapshot is not a fixed success job");
  }
  if (snapshot.seed !== null && typeof snapshot.seed !== "string") {
    throw new PersistenceError("COST_CONFLICT", "Mock image accounting snapshot is not a fixed success job");
  }
  if (hasBypassCache && typeof snapshot.bypassCache !== "boolean") {
    throw new PersistenceError("COST_CONFLICT", "Mock image accounting snapshot is not a fixed success job");
  }
}

export async function guardSynchronousMockImageCost(
  client: PoolClient,
  asset: {
    workspaceId: string;
    projectId: string;
    generationJobId: string;
    sourceJobAttemptId: string;
    sourceShotRevisionId?: string;
    providerConfigurationId: string;
    providerRequestId: string;
  },
  actualCost: ProviderActualCostInput,
): Promise<void> {
  assertSyncActualCost(actualCost);
  if (!asset.sourceShotRevisionId || !mockActualCostIdentityMatches(asset, actualCost)) {
    throw new PersistenceError("COST_CONFLICT", "Mock image accounting lineage does not match the asset");
  }

  const bound = await client.query<QueryResultRow>(
    `SELECT job.kind,
            job.project_id,
            job.source_shot_revision_id,
            job.input_snapshot,
            (job.input_snapshot = attempt.request_snapshot) AS snapshots_match,
            attempt.attempt_no::int AS attempt_no,
            attempt.provider_client_request_key,
            attempt.provider_request_id,
            attempt.provider_configuration_id,
            provider.provider_key,
            provider.capability
       FROM generation_job job
       JOIN job_attempt attempt
         ON attempt.id = $2
        AND attempt.generation_job_id = job.id
        AND attempt.workspace_id = job.workspace_id
       JOIN provider_configuration provider
         ON provider.id = attempt.provider_configuration_id
        AND provider.workspace_id = attempt.workspace_id
      WHERE job.id = $1
        AND job.workspace_id = $3`,
    [asset.generationJobId, asset.sourceJobAttemptId, asset.workspaceId],
  );
  const row = bound.rows[0];
  const attemptNo = row ? Number(row.attempt_no) : NaN;
  const expectedRequestId = `mock-media|image.generate|${asset.generationJobId}:${attemptNo}`;
  const expectedClientKey = `${asset.generationJobId}:${attemptNo}`;
  if (!row
    || row.kind !== "MEDIA_IMAGE"
    || String(row.project_id) !== asset.projectId
    || String(row.source_shot_revision_id) !== asset.sourceShotRevisionId
    || row.snapshots_match !== true
    || String(row.provider_key) !== "mock-media"
    || String(row.capability) !== "image.generate"
    || String(row.provider_configuration_id) !== asset.providerConfigurationId
    || String(row.provider_request_id) !== asset.providerRequestId
    || String(row.provider_client_request_key) !== expectedClientKey
    || asset.providerRequestId !== expectedRequestId) {
    throw new PersistenceError("COST_CONFLICT", "Mock image accounting lineage does not match the asset");
  }
  assertFixedMockImageSnapshot(row.input_snapshot, asset.sourceShotRevisionId);
  await assertNoSynchronousEstimate(client, asset, "Mock image");
}

/**
 * The ACTUAL row of a synchronous Mock request belongs to exactly that request: same workspace, project, job,
 * attempt, provider configuration and request id, the fixed Mock provider and model, and the request's own
 * actual idempotency key.
 */
function mockActualCostIdentityMatches(
  asset: { workspaceId: string; projectId: string; generationJobId: string; sourceJobAttemptId: string;
    providerConfigurationId: string; providerRequestId: string },
  actualCost: ProviderActualCostInput,
): boolean {
  return actualCost.workspaceId === asset.workspaceId
    && actualCost.projectId === asset.projectId
    && actualCost.generationJobId === asset.generationJobId
    && actualCost.jobAttemptId === asset.sourceJobAttemptId
    && actualCost.providerConfigurationId === asset.providerConfigurationId
    && actualCost.providerRequestId === asset.providerRequestId
    && actualCost.provider === "mock-media"
    && actualCost.model === "mock-v1"
    && actualCost.idempotencyKey === `${asset.providerRequestId}:request:actual`;
}

/** A synchronous request never has an estimate: none for this attempt or request, and its estimate key is free. */
async function assertNoSynchronousEstimate(
  client: PoolClient,
  asset: { workspaceId: string; sourceJobAttemptId: string; providerConfigurationId: string; providerRequestId: string },
  label: string,
): Promise<void> {
  const estimated = await client.query(
    `SELECT 1
       FROM cost_ledger
      WHERE workspace_id = $1
        AND kind = 'ESTIMATED'
        AND (job_attempt_id = $2 OR provider_request_id = $3)
      LIMIT 1`,
    [asset.workspaceId, asset.sourceJobAttemptId, asset.providerRequestId],
  );
  if (estimated.rows[0]) {
    throw new PersistenceError("COST_CONFLICT", `${label} accounting estimate already exists`);
  }
  const occupied = await client.query(
    `SELECT 1
       FROM cost_ledger
      WHERE workspace_id = $1
        AND provider_configuration_id = $2
        AND idempotency_key = $3
      LIMIT 1`,
    [asset.workspaceId, asset.providerConfigurationId, `${asset.providerRequestId}:request:estimated`],
  );
  if (occupied.rows[0]) {
    throw new PersistenceError("COST_CONFLICT", `${label} accounting estimate key is occupied`);
  }
}

/**
 * Character reference counterpart of guardSynchronousMockImageCost. The cost must carry the identity of the frozen
 * reference request: the reference job and attempt, the attempt's snapshot equal to the job's frozen
 * m3.mock.character-reference.v1 snapshot for this character revision, the mock-media image.generate
 * configuration, the synchronous request id and client key of that attempt, and the Mock zero-dollar actual.
 * Read-only; a refusal is thrown before any write so the caller's transaction leaves nothing behind.
 */
export async function guardSynchronousMockReferenceCost(
  client: PoolClient,
  asset: {
    workspaceId: string;
    projectId: string;
    generationJobId: string;
    sourceJobAttemptId: string;
    characterRevisionId: string;
    providerConfigurationId: string;
    providerRequestId: string;
  },
  actualCost: ProviderActualCostInput,
): Promise<void> {
  assertSyncActualCost(actualCost);
  if (!mockActualCostIdentityMatches(asset, actualCost)) {
    throw new PersistenceError("COST_CONFLICT", "Mock reference accounting lineage does not match the asset");
  }
  const bound = await client.query<QueryResultRow>(
    `SELECT job.kind,
            job.project_id,
            job.input_snapshot,
            (job.input_snapshot = attempt.request_snapshot) AS snapshots_match,
            attempt.attempt_no::int AS attempt_no,
            attempt.provider_client_request_key,
            attempt.provider_request_id,
            attempt.provider_configuration_id,
            provider.provider_key,
            provider.capability
       FROM generation_job job
       JOIN job_attempt attempt
         ON attempt.id = $2
        AND attempt.generation_job_id = job.id
        AND attempt.workspace_id = job.workspace_id
       JOIN provider_configuration provider
         ON provider.id = attempt.provider_configuration_id
        AND provider.workspace_id = attempt.workspace_id
      WHERE job.id = $1
        AND job.workspace_id = $3`,
    [asset.generationJobId, asset.sourceJobAttemptId, asset.workspaceId],
  );
  const row = bound.rows[0];
  const attemptNo = row ? Number(row.attempt_no) : NaN;
  if (!row
    || row.kind !== CHARACTER_REFERENCE_JOB_KIND
    || String(row.project_id) !== asset.projectId
    || row.snapshots_match !== true
    || String(row.provider_key) !== "mock-media"
    || String(row.capability) !== "image.generate"
    || String(row.provider_configuration_id) !== asset.providerConfigurationId
    || String(row.provider_request_id) !== asset.providerRequestId
    || String(row.provider_client_request_key) !== `${asset.generationJobId}:${attemptNo}`
    || asset.providerRequestId !== `mock-media|sync|image.generate|${asset.generationJobId}:${attemptNo}`) {
    throw new PersistenceError("COST_CONFLICT", "Mock reference accounting lineage does not match the asset");
  }
  let frozenRevisionId: string;
  try {
    frozenRevisionId = parseCharacterReferenceSnapshot(row.input_snapshot).characterRevisionId;
  } catch {
    throw new PersistenceError("COST_CONFLICT", "Mock reference accounting snapshot is not a fixed reference job");
  }
  if (frozenRevisionId !== asset.characterRevisionId) {
    throw new PersistenceError("COST_CONFLICT", "Mock reference accounting snapshot is not a fixed reference job");
  }
  await assertNoSynchronousEstimate(client, asset, "Mock reference");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
