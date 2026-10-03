import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { summarizeLedgerTable, waitForCurrentSources } from "./compose-preflight.mjs";
import { EPISODE_FINGERPRINT_TABLES, episodeFingerprintChanges, episodeFingerprintQuery } from "./episode-compose-preflight.mjs";

const MARKER = "m4-project-cost-summary-test";
const AMOUNT = /^(0|[1-9]\d*)\.\d{8}$/;
const AMOUNT_MASK = "999999999999999999999999999999999990.00000000";
const MISSING_PROJECT = "12121212-1212-4212-8212-121212121212";
const BOUNDARY = "包含本项目历史调用；本地编码等成本尚未计量。";
const EMPTY_COPY = "没有已记录的账本行。没有记录不等于免费。";

const EXPECTED_CURRENCIES = [
  currency("CNY", "0.00000000", "3.25000000", 0, 1, 1),
  currency("EUR", "0.00000000", "8.00000000", 0, 1, 0),
  currency("USD", "1200000000010.00000001", "0.00000000", 7, 0, 0),
];

const EXPECTED_COVERAGE = {
  jobCount: 7,
  attemptCount: 6,
  jobsWithoutLedgerCount: 4,
  providerBoundAttemptsWithoutLedgerCount: 1,
  localComposeAttemptCount: 2,
  ledgerRowsWithoutAttemptCount: 1,
};

export async function projectCostSummary(ctx) {
  const world = await readSummary(ctx, ctx.apiOrigin, ctx.state.world.projectId);
  assertSameCurrencies(world.currencies, await oracleCurrencies(ctx, ctx.state.world.projectId), "world ledger");
  assertSameCoverage(world.coverage, await oracleCoverage(ctx, ctx.state.world.projectId), "world coverage");
  const worldText = await openCost(ctx, ctx.state.world.projectId, "project-cost-world-390.png");
  if (world.ledgerRowCount === 0) {
    if (!worldText.includes(EMPTY_COPY)) throw new Error("empty world ledger did not explain that missing rows are not free");
  } else {
    if (worldText.includes(EMPTY_COPY)) throw new Error("recorded world ledger was presented as empty");
    for (const row of world.currencies) {
      if (!worldText.includes(`已记录实际金额 ${row.actualAmount}`)) throw new Error(`world page missed ${row.currency} actual ${row.actualAmount}`);
      if (!worldText.includes(`实际 ${row.actualEntryCount} 笔`)) throw new Error(`world page missed ${row.currency} actual count`);
    }
  }
  const refresh = ctx.state.page.waitForResponse((response) => response.url().includes("/cost-summary") && response.request().method() === "GET", { timeout: 20_000 });
  await ctx.state.page.getByRole("button", { name: "刷新已记录成本" }).click();
  const refreshed = await refresh;
  if (!refreshed.ok()) throw new Error(`world cost refresh ${refreshed.status()}`);
  const refreshedText = await ctx.state.page.locator("body").innerText();
  if (!refreshedText.includes(BOUNDARY) || refreshedText.includes("刷新没有完成")) throw new Error("world cost refresh did not keep the recorded view");
  const created = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", "/projects", {
    body: { title: "M4 cost summary empty", premise: "no ledger rows" },
  }), 201).body;
  const empty = await readSummary(ctx, ctx.apiOrigin, created.id);
  if (empty.ledgerRowCount !== 0 || empty.currencies.length !== 0) throw new Error(`empty project ledger ${JSON.stringify(empty.currencies)}`);
  assertSameCoverage(empty.coverage, { ...EXPECTED_COVERAGE, jobCount: 0, attemptCount: 0, jobsWithoutLedgerCount: 0, providerBoundAttemptsWithoutLedgerCount: 0, localComposeAttemptCount: 0, ledgerRowsWithoutAttemptCount: 0 }, "empty coverage");
  const emptyText = await openCost(ctx, created.id, "project-cost-empty-390.png");
  if (!emptyText.includes(EMPTY_COPY) || emptyText.includes("整剧免费") || emptyText.includes("成本完整")) {
    throw new Error("empty project cost copy is wrong");
  }
  ctx.state.projectCost = { emptyProjectId: created.id };
  return {
    world: { ledgerRowCount: world.ledgerRowCount, currencies: world.currencies, coverage: world.coverage },
    emptyProjectId: created.id,
  };
}

export async function projectCostGates(ctx) {
  const created = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "POST", "/projects", {
    body: { title: "M4 cost summary test ledger", premise: "marked test ledger only" },
  }), 201).body;
  const inserted = await insertMarkedLedger(ctx, created.id);
  const summary = await readSummary(ctx, ctx.apiOrigin, created.id);
  if (summary.ledgerRowCount !== 10) throw new Error(`test ledger rows ${summary.ledgerRowCount}`);
  assertSameCurrencies(summary.currencies, EXPECTED_CURRENCIES, "test ledger literal");
  assertSameCurrencies(summary.currencies, await oracleCurrencies(ctx, created.id), "test ledger sql");
  assertSameCoverage(summary.coverage, EXPECTED_COVERAGE, "test coverage literal");
  assertSameCoverage(summary.coverage, await oracleCoverage(ctx, created.id), "test coverage sql");
  const marked = (await ctx.sql(
    "SELECT count(*)::int AS count FROM cost_ledger WHERE project_id = $1 AND model = $2 AND provider = $2",
    [created.id, MARKER],
  ))[0];
  if (marked.count !== 10) throw new Error(`marked test ledger rows ${marked.count}`);
  const sameAmount = (await ctx.sql(
    "SELECT count(*)::int AS count FROM cost_ledger WHERE project_id = $1 AND amount_decimal = 600000000000",
    [created.id],
  ))[0];
  if (sameAmount.count !== 2) throw new Error(`same-amount ledger rows ${sameAmount.count}`);
  const supersession = (await ctx.sql(
    `SELECT btrim(estimate.currency::text) AS estimate_currency, btrim(actual.currency::text) AS actual_currency, count(*)::int AS count
       FROM cost_ledger actual
       JOIN cost_ledger estimate ON estimate.id = actual.supersedes_cost_id
      WHERE actual.project_id = $1 AND actual.model = $2
      GROUP BY 1, 2`,
    [created.id, MARKER],
  ))[0];
  if (supersession?.estimate_currency !== "CNY" || supersession?.actual_currency !== "USD" || supersession?.count !== 2) {
    throw new Error(`cross-currency supersession ${JSON.stringify(supersession ?? null)}`);
  }
  const history = (await ctx.sql(
    `SELECT
       count(*) FILTER (WHERE job.state = 'FAILED')::int AS failed_rows,
       count(*) FILTER (WHERE job.state = 'CANCELED')::int AS canceled_rows,
       count(*) FILTER (WHERE ledger.job_attempt_id IS NULL)::int AS null_attempt_rows,
       count(*) FILTER (WHERE job.state = 'FAILED' AND attempt.attempt_no = 1)::int AS old_attempt_rows
     FROM cost_ledger ledger
     JOIN generation_job job ON job.id = ledger.generation_job_id
     LEFT JOIN job_attempt attempt ON attempt.id = ledger.job_attempt_id
    WHERE ledger.project_id = $1 AND ledger.model = $2`,
    [created.id, MARKER],
  ))[0];
  if (history.failed_rows !== 7 || history.canceled_rows !== 2 || history.null_attempt_rows !== 1 || history.old_attempt_rows !== 4) {
    throw new Error(`historical ledger rows ${JSON.stringify(history)}`);
  }
  const text = await openCost(ctx, created.id, "project-cost-test-390.png");
  if (!text.includes("已记录实际金额 1200000000010.00000001") || !text.includes("未结算估算 3.25000000") || !text.includes("未结算估算 8.00000000")) {
    throw new Error("test ledger page missed a recorded amount");
  }
  if (text.includes("整剧免费") || text.includes("成本完整")) throw new Error("test ledger was presented as free or complete");
  ctx.spawnApp("api-cost-other", ["pnpm", "--filter", "@ai-drama/api", "start"], ctx.appEnv({
    API_PORT: "3047",
    APP_WORKSPACE_ID: ctx.otherWorkspaceId,
    APP_WORKSPACE_NAME: "M4 project cost other",
  }));
  try {
    await ctx.waitHttp("http://127.0.0.1:3047/api/v1/health/ready", (status, body) => status === 200 && body?.dependencies?.postgres?.status === "ok", 60_000);
    const denied = ctx.expectStatus(await ctx.callApi("http://127.0.0.1:3047", "GET", `/projects/${created.id}/cost-summary`), 404, "NOT_FOUND");
    if (JSON.stringify(denied.body).includes("1200000000010")) throw new Error("other workspace returned the test ledger");
  } finally {
    await ctx.stopApp("api-cost-other");
  }
  const missing = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "GET", `/projects/${MISSING_PROJECT}/cost-summary`), 404, "NOT_FOUND");
  if (JSON.stringify(missing.body).includes("1200000000010")) throw new Error("missing project returned the test ledger");
  ctx.state.projectCost = { ...ctx.state.projectCost, testProjectId: created.id };
  return { testProjectId: created.id, inserted, currencies: summary.currencies, coverage: summary.coverage, history };
}

export async function projectCostReadonly(ctx) {
  const projectId = ctx.state.projectCost?.testProjectId;
  if (!projectId) throw new Error("project cost test ledger was not prepared");
  await waitCostIdle(ctx);
  const before = await costSnapshot(ctx);
  const first = await readSummary(ctx, ctx.apiOrigin, projectId);
  const second = await readSummary(ctx, ctx.apiOrigin, projectId);
  assertSameCurrencies(first.currencies, EXPECTED_CURRENCIES, "readonly ledger");
  assertSameCurrencies(second.currencies, first.currencies, "repeated ledger");
  assertSameCoverage(second.coverage, first.coverage, "repeated coverage");
  if (first.ledgerRowCount !== second.ledgerRowCount) throw new Error("repeated cost summary changed the row count");
  const missing = ctx.expectStatus(await ctx.callApi(ctx.apiOrigin, "GET", `/projects/${MISSING_PROJECT}/cost-summary`), 404, "NOT_FOUND");
  if (JSON.stringify(missing.body).includes(projectId)) throw new Error("missing project leaked the test project id");
  const after = await costSnapshot(ctx);
  const changes = episodeFingerprintChanges(before, after);
  if (changes.length > 0) throw new Error(`project cost read changed stored records: ${changes.join(", ")}`);
  return {
    unchanged: EPISODE_FINGERPRINT_TABLES.map((table) => ({ table, count: before[table].count, fingerprint: before[table].fingerprint })),
  };
}

async function insertMarkedLedger(ctx, projectId) {
  const require = createRequire(join(ctx.repo, "packages/database/package.json"));
  const { Client } = require("pg");
  const client = new Client({ connectionString: ctx.databaseUrl, statement_timeout: 10_000 });
  await client.connect();
  try {
    await client.query("BEGIN");
    const config = (await client.query(
      "SELECT id FROM provider_configuration WHERE workspace_id = $1 ORDER BY id LIMIT 1",
      [ctx.workspaceId],
    )).rows[0];
    if (!config) throw new Error("workspace has no provider configuration for the marked cost ledger");
    const failed = await insertJob(client, ctx, projectId, "FAILED", "m4-project-cost-summary-test", "1".repeat(64));
    const canceled = await insertJob(client, ctx, projectId, "CANCELED", "m4-project-cost-summary-test", "2".repeat(64));
    await insertJob(client, ctx, projectId, "SUCCEEDED", "m4-project-cost-summary-test", "3".repeat(64));
    const shot = await insertJob(client, ctx, projectId, "SUCCEEDED", "m4.shot.compose.v1", "4".repeat(64));
    const episode = await insertJob(client, ctx, projectId, "SUCCEEDED", "m4.episode.compose.v1", "5".repeat(64));
    const providerBound = await insertJob(client, ctx, projectId, "SUCCEEDED", "m4-project-cost-summary-test", "6".repeat(64));
    const unattempted = await insertJob(client, ctx, projectId, "SUCCEEDED", "m4-project-cost-summary-test", "7".repeat(64));
    const oldAttempt = await insertAttempt(client, ctx, failed, 1, null);
    const newAttempt = await insertAttempt(client, ctx, failed, 2, null);
    const canceledAttempt = await insertAttempt(client, ctx, canceled, 1, null);
    await insertAttempt(client, ctx, shot, 1, null);
    await insertAttempt(client, ctx, episode, 1, null);
    await insertAttempt(client, ctx, providerBound, 1, {
      configurationId: config.id,
      requestId: `${MARKER}-${randomUUID()}`,
    });
    await insertCost(client, ctx, projectId, failed, oldAttempt, "USD", "600000000000.00000000", "ACTUAL", null);
    await insertCost(client, ctx, projectId, failed, oldAttempt, "USD", "600000000000.00000000", "ACTUAL", null);
    await insertCost(client, ctx, projectId, failed, oldAttempt, "USD", "1.50000000", "ACTUAL", null);
    await insertCost(client, ctx, projectId, failed, oldAttempt, "EUR", "8.00000000", "ESTIMATED", null);
    const estimateId = await insertCost(client, ctx, projectId, failed, newAttempt, "CNY", "10.50000000", "ESTIMATED", null);
    await insertCost(client, ctx, projectId, failed, newAttempt, "USD", "4.25000000", "ACTUAL", estimateId);
    await insertCost(client, ctx, projectId, failed, newAttempt, "USD", "4.25000000", "ACTUAL", estimateId);
    await insertCost(client, ctx, projectId, canceled, canceledAttempt, "USD", "0.00000000", "ACTUAL", null);
    await insertCost(client, ctx, projectId, canceled, canceledAttempt, "CNY", "3.25000000", "ESTIMATED", null);
    await insertCost(client, ctx, projectId, unattempted, null, "USD", "0.00000001", "ACTUAL", null);
    await client.query("COMMIT");
    return { estimateId, providerConfigurationId: config.id };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function insertJob(client, ctx, projectId, state, schema, hash) {
  const snapshot = { schema, marker: MARKER };
  const run = (await client.query(
    `INSERT INTO workflow_run (workspace_id, project_id, type, requested_by, input_snapshot, status)
     VALUES ($1, $2, 'TEST_LEDGER', $3, $4::jsonb, 'SUCCEEDED') RETURNING id`,
    [ctx.workspaceId, projectId, MARKER, JSON.stringify(snapshot)],
  )).rows[0];
  const job = (await client.query(
    `INSERT INTO generation_job
      (workspace_id, project_id, workflow_run_id, kind, state, input_hash, input_snapshot, source_shot_revision_id, completed_at)
     VALUES ($1, $2, $3, 'TEST_LEDGER', $4, $5, $6::jsonb, NULL, clock_timestamp()) RETURNING id`,
    [ctx.workspaceId, projectId, run.id, state, hash, JSON.stringify(snapshot)],
  )).rows[0];
  return job.id;
}

async function insertAttempt(client, ctx, jobId, attemptNo, provider) {
  const row = (await client.query(
    `INSERT INTO job_attempt
      (workspace_id, generation_job_id, attempt_no, provider_configuration_id, provider_request_id,
       provider_client_request_key, request_snapshot, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, clock_timestamp()) RETURNING id`,
    [
      ctx.workspaceId,
      jobId,
      attemptNo,
      provider?.configurationId ?? null,
      provider?.requestId ?? null,
      `${MARKER}-${randomUUID()}`,
      JSON.stringify({ marker: MARKER }),
    ],
  )).rows[0];
  return row.id;
}

async function insertCost(client, ctx, projectId, jobId, attemptId, currency, amount, kind, supersedesCostId) {
  const row = (await client.query(
    `INSERT INTO cost_ledger
      (workspace_id, project_id, generation_job_id, job_attempt_id,
       currency, amount_decimal, kind, basis, provider, model, supersedes_cost_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'PROVIDER_REPORTED', $8, $8, $9)
     RETURNING id::text AS id`,
    [ctx.workspaceId, projectId, jobId, attemptId, currency, amount, kind, MARKER, supersedesCostId],
  )).rows[0];
  return row.id;
}

async function readSummary(ctx, base, projectId) {
  const body = ctx.expectStatus(await ctx.callApi(base, "GET", `/projects/${projectId}/cost-summary`), 200).body;
  if (body.schema !== "m4.project.cost-summary.v1" || body.projectId !== projectId) {
    throw new Error(`cost summary identity ${JSON.stringify({ schema: body.schema, projectId: body.projectId })}`);
  }
  if (Object.hasOwn(body, "workspaceId") || Object.hasOwn(body, "totalAmount")) throw new Error("cost summary returned a workspace or cross-currency total");
  if (body.boundary?.localEncodeCostMetered !== false || body.boundary?.totalProductionCostKnown !== false) {
    throw new Error(`cost summary boundary ${JSON.stringify(body.boundary)}`);
  }
  if (!Number.isFinite(Date.parse(body.snapshotAt))) throw new Error(`cost summary time ${body.snapshotAt}`);
  if (!Array.isArray(body.currencies)) throw new Error("cost summary currencies are missing");
  for (const row of body.currencies) {
    if (typeof row.actualAmount !== "string" || typeof row.outstandingEstimatedAmount !== "string" || !AMOUNT.test(row.actualAmount) || !AMOUNT.test(row.outstandingEstimatedAmount)) {
      throw new Error(`cost amount was not an 8-decimal string ${JSON.stringify(row)}`);
    }
  }
  return body;
}

async function oracleCurrencies(ctx, projectId) {
  const rows = await ctx.sql(
    `WITH ledger AS (
       SELECT id, btrim(currency::text) AS currency, amount_decimal, kind, supersedes_cost_id
         FROM cost_ledger
        WHERE workspace_id = $1 AND project_id = $2
     ),
     replaced AS (
       SELECT DISTINCT supersedes_cost_id AS id
         FROM ledger
        WHERE kind = 'ACTUAL' AND supersedes_cost_id IS NOT NULL
     )
     SELECT currency,
            btrim(to_char(COALESCE(sum(amount_decimal) FILTER (WHERE kind = 'ACTUAL'), 0), $3)) AS "actualAmount",
            btrim(to_char(COALESCE(sum(amount_decimal) FILTER (
              WHERE kind = 'ESTIMATED' AND NOT (id IN (SELECT id FROM replaced))
            ), 0), $3)) AS "outstandingEstimatedAmount",
            count(*) FILTER (WHERE kind = 'ACTUAL')::int AS "actualEntryCount",
            count(*) FILTER (WHERE kind = 'ESTIMATED' AND NOT (id IN (SELECT id FROM replaced)))::int AS "outstandingEstimatedEntryCount",
            count(*) FILTER (WHERE kind = 'ESTIMATED' AND id IN (SELECT id FROM replaced))::int AS "supersededEstimatedEntryCount"
       FROM ledger
      GROUP BY currency
      ORDER BY currency`,
    [ctx.workspaceId, projectId, AMOUNT_MASK],
  );
  return rows.map((row) => currency(
    row.currency,
    row.actualAmount,
    row.outstandingEstimatedAmount,
    row.actualEntryCount,
    row.outstandingEstimatedEntryCount,
    row.supersededEstimatedEntryCount,
  ));
}

async function oracleCoverage(ctx, projectId) {
  const [row] = await ctx.sql(
    `SELECT
       (SELECT count(*)::int FROM generation_job WHERE workspace_id = $1 AND project_id = $2) AS "jobCount",
       (SELECT count(*)::int FROM job_attempt attempt
          JOIN generation_job job ON job.id = attempt.generation_job_id AND job.workspace_id = attempt.workspace_id
         WHERE job.workspace_id = $1 AND job.project_id = $2) AS "attemptCount",
       (SELECT count(*)::int FROM generation_job job
         WHERE job.workspace_id = $1 AND job.project_id = $2
           AND NOT EXISTS (SELECT 1 FROM cost_ledger ledger WHERE ledger.generation_job_id = job.id AND ledger.workspace_id = job.workspace_id)) AS "jobsWithoutLedgerCount",
       (SELECT count(*)::int FROM job_attempt attempt
          JOIN generation_job job ON job.id = attempt.generation_job_id AND job.workspace_id = attempt.workspace_id
         WHERE job.workspace_id = $1 AND job.project_id = $2
           AND attempt.provider_request_id IS NOT NULL
           AND attempt.provider_configuration_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM cost_ledger ledger WHERE ledger.job_attempt_id = attempt.id)) AS "providerBoundAttemptsWithoutLedgerCount",
       (SELECT count(*)::int FROM job_attempt attempt
          JOIN generation_job job ON job.id = attempt.generation_job_id AND job.workspace_id = attempt.workspace_id
         WHERE job.workspace_id = $1 AND job.project_id = $2
           AND job.input_snapshot->>'schema' IN ('m4.shot.compose.v1', 'm4.episode.compose.v1')) AS "localComposeAttemptCount",
       (SELECT count(*)::int FROM cost_ledger WHERE workspace_id = $1 AND project_id = $2 AND job_attempt_id IS NULL) AS "ledgerRowsWithoutAttemptCount"`,
    [ctx.workspaceId, projectId],
  );
  return {
    jobCount: row.jobCount,
    attemptCount: row.attemptCount,
    jobsWithoutLedgerCount: row.jobsWithoutLedgerCount,
    providerBoundAttemptsWithoutLedgerCount: row.providerBoundAttemptsWithoutLedgerCount,
    localComposeAttemptCount: row.localComposeAttemptCount,
    ledgerRowsWithoutAttemptCount: row.ledgerRowsWithoutAttemptCount,
  };
}

async function openCost(ctx, projectId, screenshot) {
  const page = ctx.state.page;
  if (!page) throw new Error("project cost page was not prepared");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${ctx.webOrigin}/projects/${projectId}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const button = page.getByRole("button", { name: "已记录成本" });
  await button.waitFor({ timeout: 20_000 });
  const responsePromise = page.waitForResponse((response) => response.url().includes(`/projects/${projectId}/cost-summary`) && response.request().method() === "GET", { timeout: 20_000 });
  await button.click();
  const response = await responsePromise;
  if (!response.ok()) throw new Error(`cost summary page read ${response.status()}`);
  await page.getByText(BOUNDARY).waitFor({ timeout: 20_000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await page.screenshot({ path: join(ctx.outputDir, screenshot), fullPage: true });
  if (overflow > 1) throw new Error(`project cost overflow ${overflow}`);
  const text = await page.locator("body").innerText();
  if (text.includes("整剧免费") || text.includes("成本完整")) throw new Error("cost summary presented a complete or free total");
  await page.setViewportSize({ width: 1280, height: 900 });
  return text;
}

async function waitCostIdle(ctx) {
  await waitForCurrentSources(ctx);
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    const jobs = await ctx.sql(
      "SELECT count(*)::int AS count FROM generation_job WHERE project_id = $1 AND state IN ('QUEUED', 'RUNNING')",
      [ctx.state.world.projectId],
    );
    const pending = await ctx.sql(
      "SELECT count(*)::int AS count FROM stale_recalculation WHERE project_id = $1 AND status IN ('PENDING', 'RUNNING')",
      [ctx.state.world.projectId],
    );
    if (jobs[0].count === 0 && pending[0].count === 0) return;
    await ctx.sleep(500);
  }
  throw new Error("project cost jobs were still active");
}

async function costSnapshot(ctx) {
  const snapshot = {};
  for (const table of EPISODE_FINGERPRINT_TABLES) {
    snapshot[table] = summarizeLedgerTable(await ctx.sql(episodeFingerprintQuery(table)));
  }
  return snapshot;
}

function currency(name, actualAmount, outstandingEstimatedAmount, actualEntryCount, outstandingEstimatedEntryCount, supersededEstimatedEntryCount) {
  return { currency: name, actualAmount, outstandingEstimatedAmount, actualEntryCount, outstandingEstimatedEntryCount, supersededEstimatedEntryCount };
}

function assertSameCurrencies(actual, expected, label) {
  const left = actual.map(publicCurrency);
  const right = expected.map(publicCurrency);
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`${label} currencies ${JSON.stringify(left)} expected ${JSON.stringify(right)}`);
  }
}

function assertSameCoverage(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} ${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`);
  }
}

function publicCurrency(row) {
  return currency(row.currency, row.actualAmount, row.outstandingEstimatedAmount, row.actualEntryCount, row.outstandingEstimatedEntryCount, row.supersededEstimatedEntryCount);
}
