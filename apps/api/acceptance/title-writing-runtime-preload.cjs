"use strict";
/**
 * Test-only preload for the title writing runtime acceptance. It is loaded with `node --require` into an API child
 * process that the acceptance itself starts (`node --require <this> dist/main.js`); no product code imports it, it is
 * not part of the build, and the API never loads it on its own.
 *
 * Deny by default: it ends the process before the API starts unless the acceptance authorization is present, the API's
 * DATABASE_URL names the one disposable acceptance database on a loopback host, and the control endpoint is loopback.
 *
 * What it does, and nothing else:
 * - Outbound boundary: a fetch to a model provider host is delivered to the acceptance's counting stub on loopback,
 *   unchanged in method, path, headers and body. Any other non-loopback fetch is refused. The product's provider
 *   endpoints and their allowlist are untouched; the request leaves the product exactly as it would in production.
 * - Pause point: before the statement that marks a reserved call as sent, it asks the controller whether to go on. The
 *   controller answers at once, or, for a call it was told to hold, never (the process is then killed by the test).
 * - Observation: it reports each start of the recovery query, so the test can count real recovery passes.
 * It prints nothing: no URL, key or token passes through stdout or stderr.
 */
const path = require("node:path");

function refuse(reason) {
  process.stderr.write(`title writing runtime acceptance preload refused: ${reason}\n`);
  process.exit(78);
}

const NAME_PATTERN = /^ads_title_acceptance_[a-z0-9_]{6,40}$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const PROVIDER_HOSTS = new Set(["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "api.openai.com", "api.deepseek.com"]);

if (process.env.TITLE_WRITING_DRAFT_SQL_AUTHORIZED !== "true") refuse("not authorized");
const expectedName = process.env.TITLE_WRITING_ACCEPTANCE_DATABASE_NAME ?? "";
if (!NAME_PATTERN.test(expectedName)) refuse("no acceptance database name");
let database;
try {
  database = new URL(process.env.DATABASE_URL ?? "");
} catch {
  refuse("DATABASE_URL is not a URL");
}
if (decodeURIComponent(database.pathname.replace(/^\//, "")) !== expectedName) refuse("DATABASE_URL is not the acceptance database");
if (!LOOPBACK.has(database.hostname)) refuse("the acceptance database is not on loopback");
let control;
try {
  control = new URL(process.env.TITLE_WRITING_RUNTIME_ACCEPTANCE_CONTROL ?? "");
} catch {
  refuse("no control endpoint");
}
if (control.protocol !== "http:" || !LOOPBACK.has(control.hostname)) refuse("the control endpoint is not loopback http");
const controlOrigin = control.origin;

// --- Outbound boundary --------------------------------------------------------------------------------------------
const realFetch = globalThis.fetch;
globalThis.fetch = async function acceptanceFetch(input, init) {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  if (LOOPBACK.has(url.hostname)) return realFetch(input, init);
  if (PROVIDER_HOSTS.has(url.hostname)) {
    return realFetch(`${controlOrigin}/model/${url.hostname}${url.pathname}`, { ...init, redirect: "manual" });
  }
  throw new TypeError("outbound network is blocked in the runtime acceptance");
};

// --- Pause point and observation in the API's own PostgreSQL client -------------------------------------------------
// The same pg module instance the API uses: resolved from @ai-drama/database (dist/index.js → package directory).
const databaseDir = path.dirname(path.dirname(require.resolve("@ai-drama/database", { paths: [path.join(__dirname, "..")] })));
const { Client } = require(require.resolve("pg", { paths: [databaseDir] }));
const SUBMIT = /^\s*UPDATE title_writing_call SET state = 'submitted' WHERE id = \$1/;
const RECOVER = /WHERE workspace_id = \$2 AND state = 'running' AND executor_id IS NOT NULL AND lease_until <= \$1/;

async function report(kind, body) {
  const response = await realFetch(`${controlOrigin}/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pid: process.pid, ...body }),
  });
  if (!response.ok) throw new Error(`control ${kind} answered ${String(response.status)}`);
}

const originalQuery = Client.prototype.query;
Client.prototype.query = function acceptanceQuery(config, values, callback) {
  const text = typeof config === "string" ? config : config && typeof config.text === "string" ? config.text : "";
  if (RECOVER.test(text)) void report("observe", { kind: "recover", at: new Date().toISOString() }).catch(() => undefined);
  if (!SUBMIT.test(text)) return originalQuery.apply(this, arguments);
  const args = arguments;
  const callId = Array.isArray(values) ? String(values[0]) : "";
  // The controller answers when this call may be marked as sent; for a held call it never does.
  const gate = report("barrier", { kind: "submit", callId });
  const proceed = () => originalQuery.apply(this, args);
  if (typeof callback === "function" || typeof values === "function") {
    gate.then(proceed, (error) => {
      const done = typeof callback === "function" ? callback : values;
      done(error);
    });
    return undefined;
  }
  return gate.then(proceed);
};
