import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { CharacterReferenceStore } from "./character-reference-store";
import type { JobPersistenceService } from "./job-service";
import type { ProviderActualCostInput } from "./mock-media-cost";

/**
 * completeGeneration against a fake client: which statements run, in which order. Commit and rollback belong to
 * succeedJobWithArtifact and PostgreSQL; the real-database cases are in character-reference-store.integration.spec.ts.
 */
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const REVISION = "33333333-3333-4333-8333-333333333333";
const JOB = "44444444-4444-4444-8444-444444444444";
const ATTEMPT = "55555555-5555-4555-8555-555555555555";
const PROVIDER = "66666666-6666-4666-8666-666666666666";
const REQUEST = `mock-media|sync|image.generate|${JOB}:1`;
const SNAPSHOT = { schema: "m3.mock.character-reference.v1", characterRevisionId: REVISION, characterContentHash: "cd".repeat(32),
  seed: null, bypassCache: false, outcome: "success", executionMode: "sync", capability: "image.generate" };

const COST: ProviderActualCostInput = { workspaceId: WORKSPACE, projectId: PROJECT, generationJobId: JOB, jobAttemptId: ATTEMPT,
  providerConfigurationId: PROVIDER, providerRequestId: REQUEST, idempotencyKey: `${REQUEST}:request:actual`, currency: "USD",
  amountDecimal: "0.00000000", kind: "ACTUAL", basis: "PROVIDER_REPORTED", unitType: "request", unitQuantity: "1.00000000",
  unitPriceSnapshot: "0.00000000", provider: "mock-media", model: "mock-v1" };

function harness(binding: Record<string, unknown> = {}) {
  const statements: string[] = [];
  const query = async (sql: string) => {
    statements.push(sql);
    if (sql.includes("information_schema.columns")) {
      return { rows: Array.from({ length: 9 }, (_, index) => ({ table_name: "t", column_name: `c${index}` })) };
    }
    if (sql.includes("pg_constraint")) return { rows: [{ definition: "reference_role = 'character_reference'" }] };
    if (sql.includes("SELECT project_id, character_id, content_hash")) {
      return { rows: [{ project_id: PROJECT, character_id: "c", content_hash: "cd".repeat(32) }] };
    }
    if (sql.includes("FROM stale_recalculation")) return { rows: [] };
    if (sql.includes("AS current, revision.freshness_status")) return { rows: [{ current: true, fresh: true }] };
    if (sql.includes("m2_script_source_is_usable")) return { rows: [{ usable: true }] };
    if (sql.includes("FROM provider_configuration\n")) return { rows: [{ id: PROVIDER }] };
    if (sql.includes("FROM job_attempt attempt")) return { rows: [{ "?column?": 1 }] };
    if (sql.includes("(job.input_snapshot = attempt.request_snapshot)")) {
      return { rows: [{ kind: "MEDIA_CHARACTER_REFERENCE", project_id: PROJECT, input_snapshot: SNAPSHOT, snapshots_match: true,
        attempt_no: 1, provider_client_request_key: `${JOB}:1`, provider_request_id: REQUEST, provider_configuration_id: PROVIDER,
        provider_key: "mock-media", capability: "image.generate", ...binding }] };
    }
    if (sql.includes("FROM cost_ledger")) return { rows: [] };
    if (sql.includes("SELECT id FROM project")) return { rows: [{ id: PROJECT }] };
    if (sql.includes("INSERT INTO asset\n")) {
      return { rows: [{ id: "77777777-7777-4777-8777-777777777777", project_id: PROJECT, source_character_revision_id: REVISION,
        source_generation_job_id: JOB, object_key: "k", mime_type: "image/png", byte_size: 1, checksum_sha256: "ab".repeat(32),
        width: 1, height: 1, status: "ACTIVE", review_status: "DRAFT", reviewed_content_hash: null, review_note: null,
        row_version: 1, created_at: new Date() }] };
    }
    return { rows: [{ id: "x" }] };
  };
  const client = { query } as unknown as PoolClient;
  const jobs = { succeedJobWithArtifact: async (input: { persistArtifact: (client: PoolClient) => Promise<unknown> }) =>
    input.persistArtifact(client) } as unknown as JobPersistenceService;
  const store = new CharacterReferenceStore({ connect: async () => client });
  const complete = (actualCost: ProviderActualCostInput) => store.completeGeneration(jobs, { workspaceId: WORKSPACE,
    projectId: PROJECT, jobId: JOB, attemptId: ATTEMPT, characterRevisionId: REVISION, providerConfigurationId: PROVIDER,
    providerRequestId: REQUEST, objectKey: "k", byteSize: 1, checksumSha256: "ab".repeat(32), width: 1, height: 1,
    traceId: "t", actualCost });
  const writes = () => statements.filter((sql) => /^\s*(INSERT|UPDATE)/.test(sql));
  return { complete, writes, statements };
}

describe("character reference completion checks the ACTUAL cost identity before writing (closeout item 7)", () => {
  it("writes the asset, its revision dependency and the cost once the identity matches", async () => {
    const { complete, writes } = harness();
    await complete(COST);
    expect(writes().map((sql) => sql.trim().split(/\s+/).slice(0, 3).join(" "))).toEqual([
      "INSERT INTO asset", "INSERT INTO asset_revision_dependency", "INSERT INTO cost_ledger"]);
  });

  it.each([
    ["another request", { providerRequestId: `mock-media|sync|image.generate|${JOB}:2`, idempotencyKey: `mock-media|sync|image.generate|${JOB}:2:request:actual` }],
    ["another attempt", { jobAttemptId: "99999999-9999-4999-8999-999999999999" }],
    ["another job", { generationJobId: "99999999-9999-4999-8999-999999999999" }],
    ["another project", { projectId: "99999999-9999-4999-8999-999999999999" }],
    ["another provider configuration", { providerConfigurationId: "99999999-9999-4999-8999-999999999999" }],
    ["another provider", { provider: "other" }],
    ["another model", { model: "mock-v2" }],
    ["another idempotency key", { idempotencyKey: "free-form" }],
    ["an estimate", { kind: "ESTIMATED" }],
    ["another currency", { currency: "CNY" }],
    ["a non-zero amount", { amountDecimal: "1" }],
  ])("refuses a cost naming %s and writes nothing", async (_label, change) => {
    const { complete, writes } = harness();
    await expect(complete({ ...COST, ...change })).rejects.toMatchObject({ code: "COST_CONFLICT" });
    expect(writes()).toEqual([]);
  });

  it.each([
    ["a shot image job", { kind: "MEDIA_IMAGE" }],
    ["a drifted attempt snapshot", { snapshots_match: false }],
    ["another character revision", { input_snapshot: { ...SNAPSHOT, characterRevisionId: "88888888-8888-4888-8888-888888888888" } }],
    ["another capability", { capability: "video.generate" }],
    ["another client key", { provider_client_request_key: "other" }],
  ])("refuses when the bound request is %s and writes nothing", async (_label, binding) => {
    const { complete, writes } = harness(binding);
    await expect(complete(COST)).rejects.toMatchObject({ code: "COST_CONFLICT" });
    expect(writes()).toEqual([]);
  });
});
