import assert from "node:assert/strict";
import test from "node:test";
import { LEDGER_TABLES } from "./compose-preflight.mjs";
import { EPISODE_FINGERPRINT_TABLES, episodeFingerprintChanges, episodeFingerprintQuery } from "./episode-compose-preflight.mjs";

test("episode readonly fingerprint covers the seven business tables and the three extra tables", () => {
  assert.deepEqual(LEDGER_TABLES, [
    "generation_job",
    "job_attempt",
    "workflow_run",
    "asset",
    "cost_ledger",
    "dispatch_outbox",
    "domain_event",
  ]);
  assert.deepEqual(EPISODE_FINGERPRINT_TABLES, [
    ...LEDGER_TABLES,
    "asset_dependency",
    "asset_revision_dependency",
    "idempotency_record",
  ]);
  for (const table of EPISODE_FINGERPRINT_TABLES) {
    const query = episodeFingerprintQuery(table);
    assert.match(query, new RegExp(`FROM ${table} t`));
    assert.match(query, /md5\(row_to_json\(t\)::text\)/);
  }
  assert.match(episodeFingerprintQuery("asset_dependency"), /dependent_asset_id/);
  const before = Object.fromEntries(EPISODE_FINGERPRINT_TABLES.map((table) => [table, { count: 1, ids: ["a"], fingerprint: "same" }]));
  const after = { ...before, asset: { count: 1, ids: ["a"], fingerprint: "changed" } };
  assert.deepEqual(episodeFingerprintChanges(before, after), ["asset fingerprint"]);
});
