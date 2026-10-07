import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrations";
import { CharacterReferenceStore, assertFrozenReferencesUsable } from "./character-reference-store";
import { guardSynchronousMockReferenceCost } from "./mock-media-cost";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for PostgreSQL integration tests");

/**
 * The reference columns, the IMAGE approval relaxation and the selection table come from an unapplied draft. Those
 * tests run only on an isolated database where the draft SQL was explicitly authorized; CI does not set this.
 */
const draftAuthorized = process.env.CHARACTER_REFERENCE_DRAFT_SQL_AUTHORIZED === "true";

const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const store = new CharacterReferenceStore(pool);
const hash = "ab".repeat(32);

beforeAll(async () => {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await runMigrations(pool);
});

afterAll(async () => {
  await pool.end();
});

/** Polls until a backend is waiting on a row lock for a statement matching the pattern. No fixed sleep. */
async function waitForLockWaiter(pattern: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const waiting = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`, [pattern]);
    if ((waiting.rows[0]?.count ?? 0) > 0) return;
    if (Date.now() > deadline) throw new Error(`no backend waited on a lock for ${pattern}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function seedProjectAndCharacter(): Promise<{ workspaceId: string; projectId: string; characterId: string; assetId: string }> {
  const one = async (text: string, values: unknown[]) => String((await pool.query<{ id: string }>(text, values)).rows[0]!.id);
  const workspaceId = await one("INSERT INTO workspace (name) VALUES ('lock-order') RETURNING id", []);
  const projectId = await one("INSERT INTO project (workspace_id, title) VALUES ($1, 'lock-order') RETURNING id", [workspaceId]);
  const characterId = await one("INSERT INTO character (workspace_id, project_id, name) VALUES ($1, $2, 'lin') RETURNING id",
    [workspaceId, projectId]);
  const assetId = await one(
    `INSERT INTO asset (workspace_id, project_id, kind, storage_provider, object_key, mime_type, byte_size, checksum_sha256,
       source_kind) VALUES ($1, $2, 'IMAGE', 'mock-object-store', $3, 'image/png', 1, $4, 'UPLOAD') RETURNING id`,
    [workspaceId, projectId, `refs/${projectId}.png`, hash]);
  return { workspaceId, projectId, characterId, assetId };
}

describe("reference writes take the project lock before reading anything", () => {
  it.each(["selection", "review"] as const)("a %s waits for the project lock held by another transaction", async (kind) => {
    const seeded = await seedProjectAndCharacter();
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM project WHERE id = $1 FOR UPDATE", [seeded.projectId]);
      let settled = false;
      const write = (kind === "selection"
        ? store.transaction((client) => store.selectInTransaction(client, { workspaceId: seeded.workspaceId,
          characterId: seeded.characterId, assetId: seeded.assetId, expectedSelectedAssetId: null, selectedBy: "owner", traceId: "t" }))
        : store.transaction((client) => store.reviewInTransaction(client, { workspaceId: seeded.workspaceId,
          assetId: seeded.assetId, reviewedBy: "owner", traceId: "t", decision: "APPROVED", expectedRowVersion: 1,
          contentHash: hash, note: null })))
        .finally(() => { settled = true; });
      write.catch(() => undefined);
      await waitForLockWaiter("SELECT id FROM project WHERE id = $1 AND workspace_id = $2 FOR UPDATE");
      expect(settled).toBe(false);
      await holder.query("COMMIT");
      // Only after the project lock does it reach the structure check; these migrations have no reference draft.
      await expect(write).rejects.toMatchObject({ code: "CHARACTER_REFERENCE_STORAGE_UNAVAILABLE" });
    } finally {
      holder.release();
    }
  });
});

describe("CharacterReferenceStore without the reference draft", () => {
  it("reports storage unavailable and refuses every operation", async () => {
    expect(await store.storageReady()).toBe(false);
    await expect(store.listForCharacter("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"))
      .rejects.toMatchObject({ code: "CHARACTER_REFERENCE_STORAGE_UNAVAILABLE" });
    await expect(store.transaction((client) => store.strictVideoReferencesInTransaction(client,
      "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333")))
      .rejects.toMatchObject({ code: "CHARACTER_REFERENCE_STORAGE_UNAVAILABLE" });
    await expect(store.transaction((client) => assertFrozenReferencesUsable(client, "11111111-1111-4111-8111-111111111111",
      [{ characterRevisionId: "a", assetId: "b", checksumSha256: hash }])))
      .rejects.toMatchObject({ code: "CHARACTER_REFERENCE_STORAGE_UNAVAILABLE" });
  });
});

describe("reference ACTUAL cost identity on applied tables (closeout item 7)", () => {
  const revision = "33333333-3333-4333-8333-333333333333";
  const snapshot = { schema: "m3.mock.character-reference.v1", characterRevisionId: revision,
    characterContentHash: "cd".repeat(32), seed: null, bypassCache: false, outcome: "success", executionMode: "sync",
    capability: "image.generate" };

  async function bound(overrides: { kind?: string; capability?: string; attemptSnapshot?: unknown } = {}) {
    const one = async (text: string, values: unknown[]) => String((await pool.query<{ id: string }>(text, values)).rows[0]!.id);
    const workspaceId = await one("INSERT INTO workspace (name) VALUES ('reference-cost') RETURNING id", []);
    const projectId = await one("INSERT INTO project (workspace_id, title) VALUES ($1, 'reference-cost') RETURNING id", [workspaceId]);
    const providerConfigurationId = await one(
      `INSERT INTO provider_configuration (workspace_id, provider_key, capability, default_timeout_ms)
       VALUES ($1, 'mock-media', $2, 30000) RETURNING id`, [workspaceId, overrides.capability ?? "image.generate"]);
    const workflowRunId = await one(
      `INSERT INTO workflow_run (workspace_id, project_id, type, requested_by, input_snapshot)
       VALUES ($1, $2, 'MEDIA_CHARACTER_REFERENCE', 'test', '{}'::jsonb) RETURNING id`, [workspaceId, projectId]);
    const generationJobId = await one(
      `INSERT INTO generation_job (workspace_id, project_id, workflow_run_id, kind, input_hash, input_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
      [workspaceId, projectId, workflowRunId, overrides.kind ?? "MEDIA_CHARACTER_REFERENCE", hash, JSON.stringify(snapshot)]);
    const providerRequestId = `mock-media|sync|image.generate|${generationJobId}:1`;
    const sourceJobAttemptId = await one(
      `INSERT INTO job_attempt (workspace_id, generation_job_id, attempt_no, provider_configuration_id, provider_request_id,
         provider_client_request_key, request_snapshot)
       VALUES ($1, $2, 1, $3, $4, $5, $6::jsonb) RETURNING id`,
      [workspaceId, generationJobId, providerConfigurationId, providerRequestId, `${generationJobId}:1`,
        JSON.stringify(overrides.attemptSnapshot ?? snapshot)]);
    const asset = { workspaceId, projectId, generationJobId, sourceJobAttemptId, characterRevisionId: revision,
      providerConfigurationId, providerRequestId };
    const cost = { workspaceId, projectId, generationJobId, jobAttemptId: sourceJobAttemptId, providerConfigurationId,
      providerRequestId, idempotencyKey: `${providerRequestId}:request:actual`, currency: "USD", amountDecimal: "0.00000000",
      kind: "ACTUAL", basis: "PROVIDER_REPORTED", unitType: "request", unitQuantity: "1.00000000",
      unitPriceSnapshot: "0.00000000", provider: "mock-media", model: "mock-v1" };
    return { asset, cost };
  }

  const guard = (asset: Parameters<typeof guardSynchronousMockReferenceCost>[1],
    cost: Parameters<typeof guardSynchronousMockReferenceCost>[2]) =>
    store.transaction((client) => guardSynchronousMockReferenceCost(client, asset, cost));

  it("accepts the frozen request's own zero-dollar actual", async () => {
    const { asset, cost } = await bound();
    await expect(guard(asset, cost)).resolves.toBeUndefined();
  });

  it("refuses a cost that names another request, attempt, job, provider, model, key or amount", async () => {
    const { asset, cost } = await bound();
    const other = await bound();
    const variants = [
      { providerRequestId: other.asset.providerRequestId, idempotencyKey: `${other.asset.providerRequestId}:request:actual` },
      { jobAttemptId: other.asset.sourceJobAttemptId },
      { generationJobId: other.asset.generationJobId },
      { projectId: other.asset.projectId },
      { providerConfigurationId: other.asset.providerConfigurationId },
      { provider: "other-media" },
      { model: "mock-v2" },
      { idempotencyKey: `${asset.providerRequestId}:request:estimated` },
      { kind: "ESTIMATED" },
      { currency: "CNY" },
      { amountDecimal: "0.01000000" },
    ];
    for (const variant of variants) {
      await expect(guard(asset, { ...cost, ...variant })).rejects.toMatchObject({ code: "COST_CONFLICT" });
    }
  });

  it("refuses when the stored job, attempt or configuration is not this frozen reference request", async () => {
    for (const overrides of [{ kind: "MEDIA_IMAGE" }, { capability: "video.generate" },
      { attemptSnapshot: { ...snapshot, seed: "drift" } }]) {
      const { asset, cost } = await bound(overrides);
      await expect(guard(asset, cost)).rejects.toMatchObject({ code: "COST_CONFLICT" });
    }
    const { asset, cost } = await bound();
    await expect(guard({ ...asset, characterRevisionId: "44444444-4444-4444-8444-444444444444" }, cost))
      .rejects.toMatchObject({ code: "COST_CONFLICT" });
    await pool.query("UPDATE job_attempt SET provider_client_request_key = 'other' WHERE id = $1", [asset.sourceJobAttemptId]);
    await expect(guard(asset, cost)).rejects.toMatchObject({ code: "COST_CONFLICT" });
  });

  it("refuses when an estimate exists for the request or its estimate key is taken", async () => {
    for (const key of ["other-estimate", "estimated-key"]) {
      const { asset, cost } = await bound();
      await pool.query(
        `INSERT INTO cost_ledger (workspace_id, project_id, generation_job_id, job_attempt_id, idempotency_key,
           provider_configuration_id, provider_request_id, currency, amount_decimal, kind, basis, unit_type, unit_quantity,
           unit_price_snapshot, provider, model)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'USD', 0, $8, 'PROVIDER_REPORTED', 'request', 1, 0, 'mock-media', 'mock-v1')`,
        [asset.workspaceId, asset.projectId, asset.generationJobId, asset.sourceJobAttemptId,
          key === "other-estimate" ? "other-estimate" : `${asset.providerRequestId}:request:estimated`,
          asset.providerConfigurationId, asset.providerRequestId, key === "other-estimate" ? "ESTIMATED" : "ACTUAL"]);
      await expect(guard(asset, cost)).rejects.toMatchObject({ code: "COST_CONFLICT" });
    }
  });
});

describe.runIf(draftAuthorized)("CharacterReferenceStore on the authorized reference draft", () => {
  let workspaceId: string;
  let projectId: string;
  let characterId: string;
  let revisionId: string;

  async function one(sql: string, values: unknown[]): Promise<string> {
    return String((await pool.query<{ id: string }>(sql, values)).rows[0]!.id);
  }

  async function reference(characterRevisionId: string, key: string): Promise<string> {
    return one(
      `INSERT INTO asset (workspace_id, project_id, kind, storage_provider, object_key, mime_type, byte_size,
         checksum_sha256, source_kind, reference_role, source_character_revision_id)
       VALUES ($1, $2, 'IMAGE', 'mock-object-store', $3, 'image/png', 1, $4, 'UPLOAD', 'character_reference', $5)
       RETURNING id`,
      [workspaceId, projectId, key, hash, characterRevisionId],
    );
  }

  const tx = <T>(work: (client: PoolClient) => Promise<T>) => store.transaction(work);

  beforeAll(async () => {
    const draft = await readFile(join(__dirname, "..", "prisma", "drafts", "20261005000200_character_reference_image.sql"), "utf8");
    await pool.query(draft);
    workspaceId = await one("INSERT INTO workspace (name) VALUES ('reference') RETURNING id", []);
    projectId = await one("INSERT INTO project (workspace_id, title) VALUES ($1, 'reference') RETURNING id", [workspaceId]);
    characterId = await one("INSERT INTO character (workspace_id, project_id, name) VALUES ($1, $2, 'lin') RETURNING id",
      [workspaceId, projectId]);
    revisionId = await one(
      `INSERT INTO character_revision (workspace_id, project_id, character_id, revision_no, content_json, content_hash, created_by)
       VALUES ($1, $2, $3, 1, '{}', $4, 'author') RETURNING id`,
      [workspaceId, projectId, characterId, hash],
    );
    await pool.query("UPDATE character SET current_revision_id = $1 WHERE id = $2", [revisionId, characterId]);
  });

  it("approves a reference only on its stored bytes and current row version", async () => {
    expect(await store.storageReady()).toBe(true);
    const assetId = await reference(revisionId, "refs/a.png");
    await expect(tx((client) => store.reviewInTransaction(client, { workspaceId, assetId, reviewedBy: "owner",
      traceId: "t", decision: "APPROVED", expectedRowVersion: 2, contentHash: hash, note: null })))
      .rejects.toMatchObject({ code: "REVIEW_CONFLICT" });
    await expect(tx((client) => store.reviewInTransaction(client, { workspaceId, assetId, reviewedBy: "owner",
      traceId: "t", decision: "APPROVED", expectedRowVersion: 1, contentHash: "cd".repeat(32), note: null })))
      .rejects.toMatchObject({ code: "REVIEW_CONFLICT" });
    const approved = await tx((client) => store.reviewInTransaction(client, { workspaceId, assetId, reviewedBy: "owner",
      traceId: "t", decision: "APPROVED", expectedRowVersion: 1, contentHash: hash, note: null }));
    expect(approved).toMatchObject({ reviewStatus: "APPROVED", reviewedContentHash: hash, rowVersion: 2 });
    await expect(tx((client) => store.reviewInTransaction(client, { workspaceId, assetId, reviewedBy: "owner",
      traceId: "t", decision: "REJECTED", expectedRowVersion: 2, contentHash: hash, note: "again" })))
      .rejects.toMatchObject({ code: "REVIEW_INVALID_TRANSITION" });
  });

  it("selects with compare-and-set and refuses an unapproved or stale reference", async () => {
    const draftAsset = await reference(revisionId, "refs/draft.png");
    await expect(tx((client) => store.selectInTransaction(client, { workspaceId, characterId, assetId: draftAsset,
      expectedSelectedAssetId: null, selectedBy: "owner", traceId: "t" }))).rejects.toMatchObject({ code: "REVIEW_REQUIRED" });
    const good = await reference(revisionId, "refs/good.png");
    await tx((client) => store.reviewInTransaction(client, { workspaceId, assetId: good, reviewedBy: "owner", traceId: "t",
      decision: "APPROVED", expectedRowVersion: 1, contentHash: hash, note: null }));
    await tx((client) => store.selectInTransaction(client, { workspaceId, characterId, assetId: good,
      expectedSelectedAssetId: null, selectedBy: "owner", traceId: "t" }));
    await expect(tx((client) => store.selectInTransaction(client, { workspaceId, characterId, assetId: good,
      expectedSelectedAssetId: null, selectedBy: "owner", traceId: "t" })))
      .rejects.toMatchObject({ code: "REFERENCE_SELECTION_CONFLICT", details: { currentAssetId: good } });
    // The reference is good, but the strict video gate also needs the character revision approved (closeout item 2).
    const selectedListing = await store.listForCharacter(workspaceId, characterId);
    expect(selectedListing.selection).toMatchObject({ assetId: good, usable: false, asset: { id: good } });
    expect(selectedListing.videoReadiness).toEqual({ usable: false, blockers: ["CHARACTER_REVISION_NOT_APPROVED"] });
    await tx((client) => assertFrozenReferencesUsable(client, workspaceId,
      [{ characterRevisionId: revisionId, assetId: good, checksumSha256: hash }]));
    await pool.query("UPDATE asset SET status = 'STALE', row_version = row_version + 1 WHERE id = $1", [good]);
    const staleListing = await store.listForCharacter(workspaceId, characterId);
    expect(staleListing.selection).toMatchObject({ assetId: good, usable: false });
    expect(staleListing.videoReadiness.blockers).toEqual(["CHARACTER_REVISION_NOT_APPROVED", "REFERENCE_NOT_ACTIVE"]);
    await expect(tx((client) => assertFrozenReferencesUsable(client, workspaceId,
      [{ characterRevisionId: revisionId, assetId: good, checksumSha256: hash }])))
      .rejects.toMatchObject({ code: "CHARACTER_REFERENCE_REQUIRED" });
  });

  it("stales the videos and downstream assets made from a replaced selection, and nothing else (review P1)", async () => {
    const approve = (assetId: string) => tx((client) => store.reviewInTransaction(client, { workspaceId, assetId,
      reviewedBy: "owner", traceId: "t", decision: "APPROVED", expectedRowVersion: 1, contentHash: hash, note: null }));
    const a = await reference(revisionId, "refs/replace-a.png");
    const b = await reference(revisionId, "refs/replace-b.png");
    await approve(a);
    await approve(b);
    const current = (await store.listForCharacter(workspaceId, characterId)).selection?.assetId ?? null;
    await tx((client) => store.selectInTransaction(client, { workspaceId, characterId, assetId: a,
      expectedSelectedAssetId: current, selectedBy: "owner", traceId: "t" }));
    const upload = (kind: string, key: string) => one(
      `INSERT INTO asset (workspace_id, project_id, kind, storage_provider, object_key, mime_type, byte_size,
         checksum_sha256, source_kind) VALUES ($1, $2, $3, 'mock-object-store', $4, 'video/mp4', 1, $5, 'UPLOAD') RETURNING id`,
      [workspaceId, projectId, kind, key, hash]);
    const video = await upload("VIDEO", "videos/from-a.mp4");
    const composite = await upload("VIDEO", "videos/composite-of-a.mp4");
    const unrelated = await upload("VIDEO", "videos/unrelated.mp4");
    await pool.query("INSERT INTO asset_dependency (workspace_id, project_id, dependent_asset_id, source_asset_id) VALUES ($1,$2,$3,$4), ($1,$2,$5,$3)",
      [workspaceId, projectId, video, a, composite]);
    const replaced = await tx((client) => store.selectInTransaction(client, { workspaceId, characterId, assetId: b,
      expectedSelectedAssetId: a, selectedBy: "owner", traceId: "t" }));
    expect(replaced.staleAssetIds?.sort()).toEqual([video, composite].sort());
    const rows = (await pool.query<{ id: string; status: string; review_status: string }>(
      "SELECT id, status, review_status FROM asset WHERE id = ANY($1::uuid[])", [[a, b, video, composite, unrelated]])).rows;
    const status = Object.fromEntries(rows.map((row) => [row.id, row.status]));
    expect(status).toMatchObject({ [a]: "ACTIVE", [b]: "ACTIVE", [video]: "STALE", [composite]: "STALE", [unrelated]: "ACTIVE" });
    expect(rows.find((row) => row.id === a)?.review_status).toBe("APPROVED");
  });

  it("reads a selection older than the newest 100 references by id, in scope only (closeout item 1)", async () => {
    const approve = (assetId: string) => tx((client) => store.reviewInTransaction(client, { workspaceId, assetId,
      reviewedBy: "owner", traceId: "t", decision: "APPROVED", expectedRowVersion: 1, contentHash: hash, note: null }));
    const oldest = await reference(revisionId, "refs/page-oldest.png");
    await pool.query("UPDATE asset SET created_at = now() - interval '1 day' WHERE id = $1", [oldest]);
    await approve(oldest);
    const current = (await store.listForCharacter(workspaceId, characterId)).selection?.assetId ?? null;
    await tx((client) => store.selectInTransaction(client, { workspaceId, characterId, assetId: oldest,
      expectedSelectedAssetId: current, selectedBy: "owner", traceId: "t" }));
    for (let index = 0; index < 120; index += 1) await reference(revisionId, `refs/page-${index}.png`);
    const listing = await store.listForCharacter(workspaceId, characterId);
    expect(listing.items).toHaveLength(100);
    expect(listing.hasMore).toBe(true);
    expect(listing.items.some((item) => item.id === oldest)).toBe(false);
    expect(listing.selection).toMatchObject({ assetId: oldest, asset: { id: oldest, reviewStatus: "APPROVED" } });
    // Only the unapproved character revision blocks it; the reference is found and usable on its own.
    expect(listing.videoReadiness.blockers).toEqual(["CHARACTER_REVISION_NOT_APPROVED"]);
    // Another workspace cannot list this character at all.
    const stranger = await one("INSERT INTO workspace (name) VALUES ('stranger') RETURNING id", []);
    await expect(store.listForCharacter(stranger, characterId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
