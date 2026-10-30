import { open } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installOfflineGuard } from "./offline-guard.mjs";

// Local JSON -> stdout only. No API, provider credentials, cache or database entry point.
// Build the existing contracts/domain packages first; this command never installs dependencies.
const MAX_FIXTURE_BYTES = 1_048_576;
const guard = installOfflineGuard();
const blocked = (code) => ({
  schema: "ads.vimax-evaluation.report.v1",
  status: "blocked", writeAllowed: false, review: null, provenance: null,
  diagnostics: [{ code, path: "$" }], gaps: [],
});

async function readFixture(filename) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { error: "fixture_not_file" };
    if (stat.size > MAX_FIXTURE_BYTES) return { error: "fixture_too_large" };
    // Bound the actual read as well as stat, including a file growing after stat.
    const buffer = Buffer.alloc(MAX_FIXTURE_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_FIXTURE_BYTES) return { error: "fixture_too_large" };
    let data;
    try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total))); }
    catch { return { error: "invalid_fixture_json" }; }
    if (!data || typeof data !== "object" || Array.isArray(data)
      || Object.keys(data).sort().join(",") !== "candidate,fixtureKind,input,supplements"
      || !["synthetic", "redacted"].includes(data.fixtureKind)
      || data.input?.sourceKind !== data.fixtureKind) return { error: "invalid_fixture_envelope" };
    return { data };
  } finally {
    await handle.close();
  }
}

let report;
try {
  if (process.argv.length > 3 || process.argv[2]?.startsWith("--")) {
    report = blocked("invalid_arguments");
  } else {
    const filename = process.argv[2]
      ? path.resolve(process.argv[2])
      : fileURLToPath(new URL("./fixtures/single-scene.json", import.meta.url));
    const fixture = await readFixture(filename);
    if (fixture.error) report = blocked(fixture.error);
    else {
      const { evaluateVimaxPlan } = await import("../../packages/domain/dist/vimax-evaluation.js");
      report = evaluateVimaxPlan(fixture.data.input, fixture.data.candidate, fixture.data.supplements);
    }
  }
} catch (error) {
  report = blocked(error?.code === "OFFLINE_NETWORK_DISABLED" ? "offline_network_attempt"
    : error?.code === "ERR_MODULE_NOT_FOUND" || error?.code === "MODULE_NOT_FOUND" ? "evaluator_build_required"
    : error?.code === "ENOENT" ? "fixture_not_found" : "offline_evaluation_failed");
}
if (guard.attempts().length > 0) report = blocked("offline_network_attempt");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.status === "ready_for_review" ? 0 : 1;
