import assert from "node:assert/strict";
import test from "node:test";
import {
  LEDGER_TABLES,
  ledgerChanges,
  ledgerPublicSummary,
  ledgerSnapshotQuery,
  summarizeLedgerTable,
} from "./compose-preflight.mjs";

function snapshot(overrides = {}) {
  const ledger = {};
  for (const table of LEDGER_TABLES) {
    ledger[table] = summarizeLedgerTable(overrides[table] ?? []);
  }
  return ledger;
}

test("readonly snapshot hashes every persisted column of the seven business tables", () => {
  assert.deepEqual(LEDGER_TABLES, [
    "generation_job",
    "job_attempt",
    "workflow_run",
    "asset",
    "cost_ledger",
    "dispatch_outbox",
    "domain_event",
  ]);
  for (const table of LEDGER_TABLES) {
    const query = ledgerSnapshotQuery(table);
    assert.match(query, new RegExp(`FROM ${table} t`));
    assert.match(query, /md5\(row_to_json\(t\)::text\)/);
    assert.doesNotMatch(query, /SELECT id::text AS id FROM/);
  }
  assert.throws(() => ledgerSnapshotQuery("idempotency_record"), /unexpected ledger table/);
});

test("same ids with a changed persisted field fail the readonly judgment", () => {
  const before = snapshot({
    generation_job: [{ id: "job-1", fingerprint: "state=SUCCEEDED;row_version=4;input_snapshot={};updated_at=t1" }],
    asset: [{ id: "asset-1", fingerprint: "status=ACTIVE;review_status=DRAFT;row_version=2" }],
    cost_ledger: [{ id: "cost-1", fingerprint: "amount_decimal=1.00000000;occurred_at=t1" }],
    job_attempt: [{ id: "attempt-1", fingerprint: "response_snapshot={};finished_at=t1" }],
  });
  const after = snapshot({
    generation_job: [{ id: "job-1", fingerprint: "state=SUCCEEDED;row_version=5;input_snapshot={};updated_at=t2" }],
    asset: [{ id: "asset-1", fingerprint: "status=ACTIVE;review_status=DRAFT;row_version=2" }],
    cost_ledger: [{ id: "cost-1", fingerprint: "amount_decimal=1.00000000;occurred_at=t1" }],
    job_attempt: [{ id: "attempt-1", fingerprint: "response_snapshot={};finished_at=t1" }],
  });
  assert.deepEqual(before.generation_job.ids, after.generation_job.ids);
  assert.equal(before.generation_job.count, after.generation_job.count);
  assert.notEqual(before.generation_job.fingerprint, after.generation_job.fingerprint);
  assert.deepEqual(ledgerChanges(before, after), ["generation_job fingerprint"]);
  assert.deepEqual(ledgerChanges(before, before), []);
});

test("readonly evidence records counts and fingerprints without business rows", () => {
  const ledger = snapshot({
    domain_event: [{ id: "9", fingerprint: "payload_json={};occurred_at=t1" }],
  });
  const published = ledgerPublicSummary(ledger);
  assert.equal(published.length, LEDGER_TABLES.length);
  for (const item of published) {
    assert.deepEqual(Object.keys(item).sort(), ["count", "fingerprint", "table"]);
    assert.equal(typeof item.fingerprint, "string");
    assert.equal(item.fingerprint.length, 64);
  }
  assert.equal(published.find((item) => item.table === "domain_event")?.count, 1);
  assert.equal(JSON.stringify(published).includes("payload_json"), false);
});
