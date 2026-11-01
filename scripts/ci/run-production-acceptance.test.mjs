import assert from "node:assert/strict";
import { test } from "node:test";
import { createProductionAcceptanceDatabase, productionAcceptancePlan, validateProductionAcceptanceReport } from "./run-production-acceptance.mjs";

const environment = { CI: "true", GITHUB_ACTIONS: "true", GITHUB_RUN_ID: "123456789", GITHUB_RUN_ATTEMPT: "2", RUNNER_TEMP: "/tmp/runner-owned" };

test("all three suites get distinct fixed-loopback identities and only their explicit draft flags", () => {
  const plans = ["speech", "real-media", "vimax-planning"].map((suite) => productionAcceptancePlan(suite, environment, "/repo"));
  assert.equal(new Set(plans.map((plan) => plan.databaseName)).size, 3);
  for (const plan of plans) {
    assert.equal(new URL(plan.databaseUrl).hostname, "127.0.0.1");
    assert.equal(new URL(plan.databaseUrl).pathname, `/${plan.databaseName}`);
    assert.equal(Object.hasOwn(plan.environment, "DATABASE_URL"), false);
    assert.equal(plan.args.filter((part) => part.startsWith("vitest.")).length, 1);
    assert.equal(plan.args.includes("run"), true);
    assert.equal(plan.args.some((part) => part.includes("integration")), false);
  }
  assert.equal(plans[0].environment.SPEECH_ACCEPTANCE_DRAFT_AUTHORIZED, "true");
  assert.equal(plans[1].environment.REAL_MEDIA_ACCEPTANCE_DRAFT_AUTHORIZED, "true");
  assert.equal(plans[2].environment.VIMAX_CANDIDATE_ACCEPTANCE_DRAFT_AUTHORIZED, "true");
  assert.equal(plans[2].environment.VIMAX_PLANNING_ACCEPTANCE_DRAFT_AUTHORIZED, "true");
});

test("untrusted identifiers, business URLs and local invocations fail before a connection is constructed", () => {
  for (const invalid of ["other", "speech;DROP TABLE project", "speech/../../other"]) assert.throws(() => productionAcceptancePlan(invalid, environment));
  for (const changed of [{ CI: "false" }, { GITHUB_ACTIONS: "false" }, { GITHUB_RUN_ID: "1;--" }, { GITHUB_RUN_ATTEMPT: "x" },
    { RUNNER_TEMP: "relative" }, { DATABASE_URL: "postgresql://business/private" }]) {
    assert.throws(() => productionAcceptancePlan("speech", { ...environment, ...changed }));
  }
});

test("the new database uses template0 and can never reuse or drop an existing database (scripted client only)", async () => {
  const calls = [];
  const client = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: sql.includes("current_database") ? [{ name: "postgres" }] : [] }; } };
  const name = productionAcceptancePlan("speech", environment).databaseName;
  await createProductionAcceptanceDatabase(client, name);
  assert.equal(calls.at(-1).sql, `CREATE DATABASE "${name}" TEMPLATE template0`);
  assert.equal(calls.some(({ sql }) => /DROP|TRUNCATE|ALTER/.test(sql)), false);
  calls.length = 0;
  const existing = { query: async (sql) => ({ rows: sql.includes("current_database") ? [{ name: "postgres" }] : [{ exists: true }] }) };
  await assert.rejects(createProductionAcceptanceDatabase(existing, name), /already exists/);
  await assert.rejects(createProductionAcceptanceDatabase(client, 'ads_speech_acceptance_ci_1_1"; DROP DATABASE x'), /Invalid/);
});

test("acceptance reports cannot be empty, skipped, partial or from a different suite", () => {
  const valid = { success: true, numTotalTests: 9, numPassedTests: 9, numFailedTests: 0, numPendingTests: 0, testResults: [{ status: "passed" }] };
  validateProductionAcceptanceReport(valid);
  for (const changed of [{ success: false }, { numTotalTests: 0, numPassedTests: 0 }, { numPendingTests: 1 }, { numPassedTests: 8 },
    { numFailedTests: 1 }, { testResults: [] }, { testResults: [{ status: "passed" }, { status: "passed" }] }]) {
    assert.throws(() => validateProductionAcceptanceReport({ ...valid, ...changed }));
  }
});
