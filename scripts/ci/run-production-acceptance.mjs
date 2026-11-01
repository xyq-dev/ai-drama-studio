/** Runner-local PostgreSQL only. Importing this module never connects or executes SQL. */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SUITES = {
  speech: {
    prefix: "ads_speech_acceptance_", config: "vitest.speech-acceptance.config.ts",
    nameVariable: "SPEECH_ACCEPTANCE_DATABASE_NAME", urlVariable: "SPEECH_ACCEPTANCE_DATABASE_URL",
    authorization: { SPEECH_ACCEPTANCE_AUTHORIZED: "true", SPEECH_ACCEPTANCE_DRAFT_AUTHORIZED: "true" },
  },
  "real-media": {
    prefix: "ads_media_acceptance_", config: "vitest.real-media-acceptance.config.ts",
    nameVariable: "REAL_MEDIA_ACCEPTANCE_DATABASE_NAME", urlVariable: "REAL_MEDIA_ACCEPTANCE_DATABASE_URL",
    authorization: { REAL_MEDIA_ACCEPTANCE_AUTHORIZED: "true", REAL_MEDIA_ACCEPTANCE_DRAFT_AUTHORIZED: "true" },
  },
  "real-media-http": {
    prefix: "ads_media_acceptance_", databaseTag: "http_", packageFilter: "@ai-drama/api", config: "vitest.real-media-flow-acceptance.config.ts",
    nameVariable: "REAL_MEDIA_ACCEPTANCE_DATABASE_NAME", urlVariable: "REAL_MEDIA_ACCEPTANCE_DATABASE_URL",
    authorization: { REAL_MEDIA_ACCEPTANCE_AUTHORIZED: "true", REAL_MEDIA_ACCEPTANCE_DRAFT_AUTHORIZED: "true", REAL_MEDIA_HTTP_ACCEPTANCE_AUTHORIZED: "true" },
  },
  "vimax-planning": {
    prefix: "ads_title_acceptance_", config: "vitest.vimax-planning-acceptance.config.ts",
    nameVariable: "TITLE_WRITING_ACCEPTANCE_DATABASE_NAME", urlVariable: "TITLE_WRITING_ACCEPTANCE_DATABASE_URL",
    authorization: { TITLE_WRITING_ACCEPTANCE_AUTHORIZED: "true", VIMAX_CANDIDATE_ACCEPTANCE_DRAFT_AUTHORIZED: "true", VIMAX_PLANNING_ACCEPTANCE_DRAFT_AUTHORIZED: "true" },
  },
};

/** No supplied database URL/identifier is accepted. Every job gets a numeric-run-scoped database on its own service. */
export function productionAcceptancePlan(suite, environment, repo = REPO) {
  if (!Object.hasOwn(SUITES, suite)) throw new Error("Select speech, real-media, real-media-http or vimax-planning acceptance");
  if (environment.CI !== "true" || environment.GITHUB_ACTIONS !== "true") throw new Error("This entrypoint runs only in GitHub Actions");
  if (environment.DATABASE_URL !== undefined && environment.DATABASE_URL !== "") throw new Error("DATABASE_URL must not be exposed to isolated acceptance");
  if (!/^\d{1,20}$/.test(environment.GITHUB_RUN_ID ?? "") || !/^\d{1,6}$/.test(environment.GITHUB_RUN_ATTEMPT ?? "")) throw new Error("Invalid workflow run identity");
  if (!isAbsolute(environment.RUNNER_TEMP ?? "")) throw new Error("An absolute runner-owned temporary directory is required");
  const selected = SUITES[suite];
  const databaseName = `${selected.prefix}ci_${selected.databaseTag ?? ""}${environment.GITHUB_RUN_ID}_${environment.GITHUB_RUN_ATTEMPT}`;
  if (!new RegExp(`^${selected.prefix}[a-z0-9_]{6,40}$`).test(databaseName) || databaseName.length > 63) throw new Error("Invalid disposable database identity");
  const databaseUrl = `postgresql://postgres@127.0.0.1:5432/${databaseName}`;
  const evidenceDir = join(environment.RUNNER_TEMP, "production-acceptance", suite);
  const reportPath = join(evidenceDir, "vitest-results.json");
  return {
    suite, repo, databaseName, databaseUrl, evidenceDir, reportPath,
    environment: { ...selected.authorization, [selected.nameVariable]: databaseName, [selected.urlVariable]: databaseUrl, NODE_ENV: "test" },
    command: "pnpm",
    args: ["--filter", selected.packageFilter ?? "@ai-drama/database", "exec", "vitest", "run", "--config", selected.config,
      "--reporter=default", "--reporter=json", `--outputFile.json=${reportPath}`],
  };
}

/** The injected client is the fixed loopback admin connection, never a supplied business connection string. */
export async function createProductionAcceptanceDatabase(client, databaseName) {
  if (!/^ads_(speech|media|title)_acceptance_ci_(?:http_)?\d{1,20}_\d{1,6}$/.test(databaseName) || databaseName.length > 63) throw new Error("Invalid disposable database identity");
  const identity = await client.query("SELECT current_database() AS name");
  if (identity.rows[0]?.name !== "postgres") throw new Error("Disposable database creation requires the runner-local postgres administration database");
  const exists = await client.query("SELECT 1 FROM pg_catalog.pg_database WHERE datname=$1", [databaseName]);
  if (exists.rows.length) throw new Error("Acceptance database already exists; a new empty database is required");
  // Identifier is a bounded ASCII allowlist above. template0 prevents inherited user-schema objects.
  await client.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
}

export function validateProductionAcceptanceReport(report) {
  if (!report || report.success !== true || !Number.isSafeInteger(report.numTotalTests) || report.numTotalTests < 1
    || report.numPassedTests !== report.numTotalTests || report.numFailedTests !== 0 || report.numPendingTests !== 0
    || !Array.isArray(report.testResults) || report.testResults.length !== 1
    || report.testResults.some((entry) => entry.status !== "passed")) {
    throw new Error("The dedicated PostgreSQL acceptance must complete every collected test without skips");
  }
}

async function main() {
  if (process.argv.length !== 3) throw new Error("Usage: node scripts/ci/run-production-acceptance.mjs <speech|real-media|real-media-http|vimax-planning>");
  const plan = productionAcceptancePlan(process.argv[2], process.env);
  await mkdir(plan.evidenceDir, { recursive: true });
  const summaryPath = join(plan.evidenceDir, "acceptance-summary.json");
  const summary = { schema: "production.acceptance.ci.v1", suite: plan.suite, databaseName: plan.databaseName,
    databaseHost: "runner-local:127.0.0.1:5432", databaseTemplate: "template0", businessDatabaseUsed: false,
    providerRequestsMade: false, status: "starting" };
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  try {
    const requireDatabase = createRequire(join(plan.repo, "packages/database/package.json"));
    const { Pool } = requireDatabase("pg");
    const admin = new Pool({ host: "127.0.0.1", port: 5432, user: "postgres", password: "", database: "postgres",
      max: 1, connectionTimeoutMillis: 5000, statement_timeout: 15_000 });
    try { await createProductionAcceptanceDatabase(admin, plan.databaseName); }
    finally { await admin.end(); }
    const exitCode = await new Promise((resolveChild, rejectChild) => {
      const child = spawn(plan.command, plan.args, { cwd: plan.repo, env: { ...process.env, ...plan.environment }, stdio: "inherit", shell: false });
      child.once("error", rejectChild);
      child.once("exit", (code) => resolveChild(code ?? 1));
    });
    if (exitCode !== 0) throw new Error("Dedicated PostgreSQL acceptance failed");
    validateProductionAcceptanceReport(JSON.parse(await readFile(plan.reportPath, "utf8")));
    summary.status = "passed";
  } catch {
    summary.status = "failed";
    process.stderr.write(`Isolated ${plan.suite} acceptance failed; inspect its runner-local evidence.\n`);
    process.exitCode = 1;
  } finally {
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write("Isolated acceptance refused before database creation.\n"); process.exitCode = 1; });
}
