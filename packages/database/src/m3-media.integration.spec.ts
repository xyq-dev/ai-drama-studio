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
      asset_dependency,
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
  it("accepts upload and local-job assets without a provider request", async () => {
    const seeded = await seedMediaAttempt("non-provider");
    const upload = await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO asset (workspace_id, project_id, kind, storage_provider, object_key,
        mime_type, byte_size, checksum_sha256, source_kind)
       VALUES ($1,$2,'IMAGE','minio','manual/source.png','image/png',1,$3,'UPLOAD') RETURNING id`,
      [seeded.workspaceId, seeded.projectId, hash],
    );
    const local = await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO asset (workspace_id, project_id, kind, storage_provider, object_key,
        mime_type, byte_size, checksum_sha256, source_kind, source_job_attempt_id, source_generation_job_id)
       VALUES ($1,$2,'IMAGE','minio','local/result.png','image/png',1,$3,'LOCAL_JOB',$4,$5) RETURNING id`,
      [seeded.workspaceId, seeded.projectId, hash, seeded.jobAttemptId, seeded.generationJobId],
    );
    expect(upload.rows[0]?.id).toBeTruthy();
    expect(local.rows[0]?.id).toBeTruthy();
    await expect(pool.query(
      `INSERT INTO asset (workspace_id, project_id, kind, storage_provider, object_key,
        mime_type, byte_size, checksum_sha256, source_kind)
       VALUES ($1,$2,'IMAGE','minio','manual/invalid.png','image/png',1,$3,'PROVIDER')`,
      [seeded.workspaceId, seeded.projectId, hash],
    )).rejects.toThrow(/asset_source_kind_check/i);
  });

  it("keeps exact asset dependencies immutable and within one project", async () => {
    const seeded = await seedMediaAttempt("dependency");
    const makeAsset = async (key: string, projectId = seeded.projectId) => {
      const result = await pool.query<{ id: string } & QueryResultRow>(
        `INSERT INTO asset (workspace_id, project_id, kind, storage_provider, object_key,
          mime_type, byte_size, checksum_sha256, source_kind)
         VALUES ($1,$2,'IMAGE','minio',$3,'image/png',1,$4,'UPLOAD') RETURNING id`,
        [seeded.workspaceId, projectId, key, hash],
      );
      if (!result.rows[0]?.id) throw new Error("asset missing");
      return result.rows[0].id;
    };
    const source = await makeAsset("dependency/source.png");
    const dependent = await makeAsset("dependency/generated.png");
    const otherProject = await pool.query<{ id: string } & QueryResultRow>(
      "INSERT INTO project (workspace_id, title) VALUES ($1, 'other-dependency-project') RETURNING id",
      [seeded.workspaceId],
    );
    const alien = await makeAsset("dependency/alien.png", otherProject.rows[0]?.id);
    await pool.query(
      `INSERT INTO asset_dependency (workspace_id, project_id, dependent_asset_id, source_asset_id)
       VALUES ($1,$2,$3,$4)`,
      [seeded.workspaceId, seeded.projectId, dependent, source],
    );
    await expect(pool.query(
      `INSERT INTO asset_dependency (workspace_id, project_id, dependent_asset_id, source_asset_id)
       VALUES ($1,$2,$3,$4)`,
      [seeded.workspaceId, seeded.projectId, dependent, alien],
    )).rejects.toThrow(/foreign key/i);
    await expect(pool.query(
      "DELETE FROM asset_dependency WHERE dependent_asset_id = $1", [dependent],
    )).rejects.toThrow(/immutable/i);
  });

  it("stores immutable assets bound to the exact provider attempt", async () => {
    const seeded = await seedMediaAttempt();

    const asset = await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO asset
        (workspace_id, project_id, kind, storage_provider, object_key, mime_type,
         byte_size, checksum_sha256, source_job_attempt_id, source_generation_job_id,
         provider_configuration_id, provider_request_id, metadata_json)
       VALUES ($1,$2,'IMAGE','minio','assets/frame.png','image/png',1,$3,$4,$5,$6,$7,'{}'::jsonb)
       RETURNING id`,
      [
        seeded.workspaceId,
        seeded.projectId,
        hash,
        seeded.jobAttemptId,
        seeded.generationJobId,
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
           byte_size, checksum_sha256, source_job_attempt_id, source_generation_job_id,
           provider_configuration_id, provider_request_id, metadata_json)
         VALUES ($1,$2,'IMAGE','minio','assets/bad.png','image/png',1,$3,$4,$5,$6,$7,'{}'::jsonb)`,
        [
          first.workspaceId,
          first.projectId,
          hash,
          first.jobAttemptId,
          first.generationJobId,
          second.providerConfigurationId,
          first.providerRequestId,
        ],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("rejects a source attempt from another project in the same workspace", async () => {
    const source = await seedMediaAttempt("cross-project-source");
    const otherProject = await pool.query<{ id: string } & QueryResultRow>(
      "INSERT INTO project (workspace_id, title) VALUES ($1, 'other-project') RETURNING id",
      [source.workspaceId],
    );
    const otherProjectId = otherProject.rows[0]?.id;
    if (!otherProjectId) throw new Error("other project missing");

    await expect(
      pool.query(
        `INSERT INTO asset
          (workspace_id, project_id, kind, storage_provider, object_key, mime_type,
           byte_size, checksum_sha256, source_job_attempt_id, source_generation_job_id,
           provider_configuration_id, provider_request_id)
         VALUES ($1,$2,'IMAGE','minio','assets/cross-project.png','image/png',1,$3,$4,$5,$6,$7)`,
        [source.workspaceId, otherProjectId, hash, source.jobAttemptId,
          source.generationJobId, source.providerConfigurationId, source.providerRequestId],
      ),
    ).rejects.toThrow(/foreign key/i);

    const otherJob = await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO workflow_run
        (workspace_id, project_id, type, requested_by, input_snapshot)
       VALUES ($1,$2,'MEDIA_IMAGE','test','{}'::jsonb) RETURNING id`,
      [source.workspaceId, otherProjectId],
    );
    const otherWorkflowId = otherJob.rows[0]?.id;
    const otherGenerationJob = await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO generation_job
        (workspace_id, project_id, workflow_run_id, kind, input_hash, input_snapshot)
       VALUES ($1,$2,$3,'MEDIA_IMAGE',$4,'{}'::jsonb) RETURNING id`,
      [source.workspaceId, otherProjectId, otherWorkflowId, hash],
    );
    await expect(
      pool.query(
        `INSERT INTO asset
          (workspace_id, project_id, kind, storage_provider, object_key, mime_type,
           byte_size, checksum_sha256, source_job_attempt_id, source_generation_job_id,
           provider_configuration_id, provider_request_id)
         VALUES ($1,$2,'IMAGE','minio','assets/wrong-job.png','image/png',1,$3,$4,$5,$6,$7)`,
        [source.workspaceId, otherProjectId, hash, source.jobAttemptId,
          otherGenerationJob.rows[0]?.id, source.providerConfigurationId, source.providerRequestId],
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

    const secondProvider = await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO provider_configuration
        (workspace_id, provider_key, capability, default_timeout_ms)
       VALUES ($1, 'mock-media-secondary', 'image.generate', 30000)
       RETURNING id`,
      [seeded.workspaceId],
    );
    const secondProviderId = secondProvider.rows[0]?.id;
    if (!secondProviderId) throw new Error("second provider missing");

    const secondAttempt = await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO job_attempt
        (workspace_id, generation_job_id, attempt_no, provider_configuration_id,
         provider_request_id, provider_client_request_key, request_snapshot)
       VALUES ($1,$2,2,$3,$4,'m3-cost-second-provider','{}'::jsonb)
       RETURNING id`,
      [
        seeded.workspaceId,
        seeded.generationJobId,
        secondProviderId,
        seeded.providerRequestId,
      ],
    );
    const secondAttemptId = secondAttempt.rows[0]?.id;
    if (!secondAttemptId) throw new Error("second provider attempt missing");

    await expect(
      pool.query(
        `INSERT INTO cost_ledger
          (workspace_id, project_id, generation_job_id, job_attempt_id,
           idempotency_key, provider_configuration_id, provider_request_id, currency, amount_decimal,
           kind, basis, provider, model)
         VALUES ($1,$2,$3,$4,'cost:estimate',$5,$6,'USD',0.10,'ESTIMATED',
                 'LOCALLY_CALCULATED','mock-media-secondary','mock')`,
        [
          seeded.workspaceId,
          seeded.projectId,
          seeded.generationJobId,
          secondAttemptId,
          secondProviderId,
          seeded.providerRequestId,
        ],
      ),
    ).resolves.toBeTruthy();

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

  it("keeps both sides of a cost supersession immutable", async () => {
    const seeded = await seedMediaAttempt("immutable-cost");
    const estimate = await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO cost_ledger
        (workspace_id, project_id, generation_job_id, job_attempt_id,
         idempotency_key, provider_configuration_id, provider_request_id,
         currency, amount_decimal, kind, basis, provider, model)
       VALUES ($1,$2,$3,$4,'immutable:estimate',$5,$6,
               'USD',0.10,'ESTIMATED','LOCALLY_CALCULATED','mock-media','mock') RETURNING id`,
      [seeded.workspaceId, seeded.projectId, seeded.generationJobId, seeded.jobAttemptId,
        seeded.providerConfigurationId, seeded.providerRequestId],
    );
    const estimateId = estimate.rows[0]?.id;
    if (!estimateId) throw new Error("estimate missing");

    const actual = await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO cost_ledger
        (workspace_id, project_id, generation_job_id, job_attempt_id,
         idempotency_key, provider_configuration_id, provider_request_id, supersedes_cost_id,
         currency, amount_decimal, kind, basis, provider, model)
       VALUES ($1,$2,$3,$4,'immutable:actual',$5,$6,$7,
               'USD',0.08,'ACTUAL','PROVIDER_REPORTED','mock-media','mock') RETURNING id`,
      [seeded.workspaceId, seeded.projectId, seeded.generationJobId, seeded.jobAttemptId,
        seeded.providerConfigurationId, seeded.providerRequestId, estimateId],
    );
    const actualId = actual.rows[0]?.id;
    if (!actualId) throw new Error("actual missing");

    for (const [id, statement] of [
      [estimateId, "UPDATE cost_ledger SET kind = 'ACTUAL' WHERE id = $1"],
      [estimateId, "UPDATE cost_ledger SET model = 'changed' WHERE id = $1"],
      [actualId, "UPDATE cost_ledger SET supersedes_cost_id = NULL WHERE id = $1"],
      [estimateId, "DELETE FROM cost_ledger WHERE id = $1"],
      [actualId, "DELETE FROM cost_ledger WHERE id = $1"],
    ]) {
      await expect(pool.query(statement, [id])).rejects.toThrow(/cost_ledger entries are immutable/i);
    }

    const stillLinked = await pool.query<{ kind: string; supersedes_cost_id: string | null } & QueryResultRow>(
      "SELECT kind, supersedes_cost_id FROM cost_ledger WHERE id = $1",
      [actualId],
    );
    expect(stillLinked.rows[0]).toMatchObject({ kind: "ACTUAL", supersedes_cost_id: estimateId });
  });

  it("rejects a cost whose provider request belongs to another attempt in the same workspace", async () => {
    const seeded = await seedMediaAttempt("cost-request-source");
    const secondAttempt = await pool.query<{ id: string } & QueryResultRow>(
      `INSERT INTO job_attempt
        (workspace_id, generation_job_id, attempt_no, provider_configuration_id,
         provider_request_id, provider_client_request_key, request_snapshot)
       VALUES ($1,$2,2,$3,'mock-media|image.generate|cost-request-other',
               'client-cost-request-other','{}'::jsonb) RETURNING id`,
      [seeded.workspaceId, seeded.generationJobId, seeded.providerConfigurationId],
    );
    const secondAttemptId = secondAttempt.rows[0]?.id;
    if (!secondAttemptId) throw new Error("second attempt missing");

    await expect(
      pool.query(
        `INSERT INTO cost_ledger
          (workspace_id, project_id, generation_job_id, job_attempt_id,
           idempotency_key, provider_configuration_id, provider_request_id,
           currency, amount_decimal, kind, basis, provider, model)
         VALUES ($1,$2,$3,$4,'cost:wrong-request',$5,$6,
                 'USD',0.01,'ACTUAL','PROVIDER_REPORTED','mock-media','mock')`,
        [seeded.workspaceId, seeded.projectId, seeded.generationJobId,
          seeded.jobAttemptId, seeded.providerConfigurationId,
          "mock-media|image.generate|cost-request-other"],
      ),
    ).rejects.toThrow(/foreign key/i);

    await expect(
      pool.query(
        `INSERT INTO cost_ledger
          (workspace_id, project_id, generation_job_id, job_attempt_id,
           idempotency_key, provider_configuration_id, provider_request_id,
           currency, amount_decimal, kind, basis, provider, model)
         VALUES ($1,$2,$3,$4,'cost:correct-request',$5,$6,
                 'USD',0.01,'ACTUAL','PROVIDER_REPORTED','mock-media','mock')`,
        [seeded.workspaceId, seeded.projectId, seeded.generationJobId,
          secondAttemptId, seeded.providerConfigurationId,
          "mock-media|image.generate|cost-request-other"],
      ),
    ).resolves.toBeTruthy();
  });
});
