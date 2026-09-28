import { Pool, type QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "./migrations";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for PostgreSQL integration tests");

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const hash = "ab".repeat(32);

beforeAll(async () => {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await runMigrations(pool);
});

beforeEach(async () => {
  await pool.query(`
    TRUNCATE TABLE
      asset,
      provider_event,
      cost_ledger,
      dispatch_outbox,
      job_attempt,
      generation_job_dependency,
      generation_job,
      domain_event,
      idempotency_record,
      workflow_run,
      provider_configuration,
      project,
      workspace
    RESTART IDENTITY CASCADE
  `);
});

afterAll(async () => {
  await pool.end();
});

async function seedMediaAttempt(label = "primary") {
  const workspace = await pool.query<{ id: string } & QueryResultRow>(
    "INSERT INTO workspace (name) VALUES ($1) RETURNING id",
    [`m3-${label}`],
  );
  const workspaceId = workspace.rows[0]?.id;
  if (!workspaceId) throw new Error("workspace missing");

  const project = await pool.query<{ id: string } & QueryResultRow>(
    "INSERT INTO project (workspace_id, title) VALUES ($1, $2) RETURNING id",
    [workspaceId, `project-${label}`],
  );
  const projectId = project.rows[0]?.id;
  if (!projectId) throw new Error("project missing");

  const provider = await pool.query<{ id: string } & QueryResultRow>(
    `INSERT INTO provider_configuration
      (workspace_id, provider_key, capability, default_timeout_ms)
     VALUES ($1, 'mock-media', 'image.generate', 30000)
     RETURNING id`,
    [workspaceId],
  );
  const providerConfigurationId = provider.rows[0]?.id;
  if (!providerConfigurationId) throw new Error("provider missing");

  const workflow = await pool.query<{ id: string } & QueryResultRow>(
    `INSERT INTO workflow_run
      (workspace_id, project_id, type, requested_by, input_snapshot)
     VALUES ($1, $2, 'MEDIA_IMAGE', 'test', '{}'::jsonb)
     RETURNING id`,
    [workspaceId, projectId],
  );
  const workflowRunId = workflow.rows[0]?.id;
  if (!workflowRunId) throw new Error("workflow missing");

  const job = await pool.query<{ id: string } & QueryResultRow>(
    `INSERT INTO generation_job
      (workspace_id, project_id, workflow_run_id, kind, input_hash, input_snapshot)
     VALUES ($1, $2, $3, 'MEDIA_IMAGE', $4, '{}'::jsonb)
     RETURNING id`,
    [workspaceId, projectId, workflowRunId, hash],
  );
  const generationJobId = job.rows[0]?.id;
  if (!generationJobId) throw new Error("job missing");

  const providerRequestId = `mock-media|image.generate|${label}`;
  const attempt = await pool.query<{ id: string } & QueryResultRow>(
    `INSERT INTO job_attempt
      (workspace_id, generation_job_id, attempt_no, provider_configuration_id,
       provider_request_id, provider_client_request_key, request_snapshot)
     VALUES ($1, $2, 1, $3, $4, $5, '{}'::jsonb)
     RETURNING id`,
    [workspaceId, generationJobId, providerConfigurationId, providerRequestId, `client-${label}`],
  );
  const jobAttemptId = attempt.rows[0]?.id;
  if (!jobAttemptId) throw new Error("attempt missing");

  return { workspaceId, projectId, providerConfigurationId, providerRequestId, generationJobId, jobAttemptId };
}

describe("M3-A media asset schema", () => {
  it("stores immutable assets bound to the exact provider attempt", async () => {
    const seeded = await seedMediaAttempt();

    const asset = await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO asset
        (workspace_id, project_id, kind, storage_provider, object_key, mime_type,
         byte_size, checksum_sha256, source_job_attempt_id,
         provider_configuration_id, provider_request_id, metadata_json)
       VALUES ($1,$2,'IMAGE','minio','assets/frame.png','image/png',1,$3,$4,$5,$6,'{}'::jsonb)
       RETURNING id`,
      [
        seeded.workspaceId,
        seeded.projectId,
        hash,
        seeded.jobAttemptId,
        seeded.providerConfigurationId,
        seeded.providerRequestId,
      ],
    );
    expect(asset.rows[0]?.id).toBeTruthy();

    await expect(
      pool.query("UPDATE asset SET mime_type = 'image/jpeg' WHERE id = $1", [asset.rows[0]?.id]),
    ).rejects.toThrow(/asset records are immutable/i);

    await expect(
      pool.query("DELETE FROM asset WHERE id = $1", [asset.rows[0]?.id]),
    ).rejects.toThrow(/asset records are immutable/i);
  });

  it("rejects an asset whose provider lineage does not match the attempt", async () => {
    const first = await seedMediaAttempt("first");
    const second = await seedMediaAttempt("second");

    await expect(
      pool.query(
        `INSERT INTO asset
          (workspace_id, project_id, kind, storage_provider, object_key, mime_type,
           byte_size, checksum_sha256, source_job_attempt_id,
           provider_configuration_id, provider_request_id, metadata_json)
         VALUES ($1,$2,'IMAGE','minio','assets/bad.png','image/png',1,$3,$4,$5,$6,'{}'::jsonb)`,
        [
          first.workspaceId,
          first.projectId,
          hash,
          first.jobAttemptId,
          second.providerConfigurationId,
          first.providerRequestId,
        ],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("deduplicates costs and only lets actual costs supersede matching estimates", async () => {
    const seeded = await seedMediaAttempt("cost");

    await expect(
      pool.query(
        `INSERT INTO cost_ledger
          (workspace_id, project_id, generation_job_id, job_attempt_id,
           provider_configuration_id, provider_request_id, currency, amount_decimal,
           kind, basis, provider, model)
         VALUES ($1,$2,$3,$4,$5,$6,'USD',0.01,'ACTUAL',
                 'PROVIDER_REPORTED','mock-media','mock')`,
        [
          seeded.workspaceId,
          seeded.projectId,
          seeded.generationJobId,
          seeded.jobAttemptId,
          seeded.providerConfigurationId,
          seeded.providerRequestId,
        ],
      ),
    ).rejects.toThrow(/cost_ledger_provider_lineage_check/i);

    const estimate = await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO cost_ledger
        (workspace_id, project_id, generation_job_id, job_attempt_id,
         idempotency_key, provider_configuration_id, provider_request_id, currency, amount_decimal,
         kind, basis, provider, model)
       VALUES ($1,$2,$3,$4,'cost:estimate',$5,$6,'USD',0.10,'ESTIMATED',
               'LOCALLY_CALCULATED','mock-media','mock')
       RETURNING id`,
      [
        seeded.workspaceId,
        seeded.projectId,
        seeded.generationJobId,
        seeded.jobAttemptId,
        seeded.providerConfigurationId,
        seeded.providerRequestId,
      ],
    );
    const estimateId = estimate.rows[0]?.id;
    if (!estimateId) throw new Error("estimate missing");

    await expect(
      pool.query(
        `INSERT INTO cost_ledger
          (workspace_id, project_id, generation_job_id, job_attempt_id,
           idempotency_key, provider_configuration_id, provider_request_id, currency, amount_decimal,
           kind, basis, provider, model)
         VALUES ($1,$2,$3,$4,'cost:estimate',$5,$6,'USD',0.10,'ESTIMATED',
                 'LOCALLY_CALCULATED','mock-media','mock')`,
        [
          seeded.workspaceId,
          seeded.projectId,
          seeded.generationJobId,
          seeded.jobAttemptId,
          seeded.providerConfigurationId,
          seeded.providerRequestId,
        ],
      ),
    ).rejects.toThrow(/duplicate key/i);

    await expect(
      pool.query(
        `INSERT INTO cost_ledger
          (workspace_id, project_id, generation_job_id, job_attempt_id,
           idempotency_key, provider_configuration_id, provider_request_id, supersedes_cost_id,
           currency, amount_decimal, kind, basis, provider, model)
         VALUES ($1,$2,$3,$4,'cost:actual',$5,$6,$7,'USD',0.08,'ACTUAL',
                 'PROVIDER_REPORTED','mock-media','mock')`,
        [
          seeded.workspaceId,
          seeded.projectId,
          seeded.generationJobId,
          seeded.jobAttemptId,
          seeded.providerConfigurationId,
          seeded.providerRequestId,
          estimateId,
        ],
      ),
    ).resolves.toBeTruthy();

    const other = await seedMediaAttempt("other-cost");
    await expect(
      pool.query(
        `INSERT INTO cost_ledger
          (workspace_id, project_id, generation_job_id, job_attempt_id,
           idempotency_key, provider_configuration_id, provider_request_id, supersedes_cost_id,
           currency, amount_decimal, kind, basis, provider, model)
         VALUES ($1,$2,$3,$4,'cost:bad',$5,$6,$7,'USD',0.09,'ACTUAL',
                 'PROVIDER_REPORTED','mock-media','mock')`,
        [
          other.workspaceId,
          other.projectId,
          other.generationJobId,
          other.jobAttemptId,
          other.providerConfigurationId,
          other.providerRequestId,
          estimateId,
        ],
      ),
    ).rejects.toThrow(/matching lineage/i);
  });
});
