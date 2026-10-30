import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { VIMAX_EVALUATION_CODES } from "../../packages/contracts/dist/vimax-evaluation.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const runner = path.join(root, "scripts/vimax-evaluation/run.mjs");
const fixture = path.join(root, "scripts/vimax-evaluation/fixtures/single-scene.json");
const guardUrl = pathToFileURL(path.join(root, "scripts/vimax-evaluation/offline-guard.mjs")).href;
const opts = { cwd: root, encoding: "utf8", timeout: 15_000, maxBuffer: 2_097_152 };

function run(filename, extra = []) {
  const result = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${root}`,
    ...(filename ? [`--allow-fs-read=${filename}`] : []), runner,
    ...(filename ? [filename] : []), ...extra], opts);
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "", result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.writeAllowed, false);
  assert.equal(report.schema, "ads.vimax-evaluation.report.v1");
  for (const issue of report.diagnostics) assert.ok(VIMAX_EVALUATION_CODES.includes(issue.code), issue.code);
  return { ...result, report };
}

function temporary(text, check) {
  const dir = mkdtempSync(path.join(tmpdir(), "vimax-e1-"));
  const filename = path.join(dir, "local fixture.json");
  writeFileSync(filename, text);
  try { check(filename, dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("synthetic sample is deterministic, review-only and leaves input files unchanged", () => {
  const text = readFileSync(fixture, "utf8");
  const first = run();
  const second = run();
  assert.equal(first.status, 0);
  assert.equal(first.report.status, "ready_for_review");
  assert.equal(first.stdout, second.stdout);
  assert.equal(readFileSync(fixture, "utf8"), text);
  assert.notEqual(first.report.schema, "ads.script-breakdown.output.v1");
  assert.deepEqual(first.report.review.candidate, JSON.parse(text).candidate);
  temporary(text, (filename, dir) => {
    assert.equal(run(filename).stdout, first.stdout);
    assert.deepEqual(readdirSync(dir), ["local fixture.json"]);
    assert.equal(readFileSync(filename, "utf8"), text);
  });
});

for (const [name, text, code] of [
  ["malformed JSON", '{"secret text":', "invalid_fixture_json"],
  ["wrong envelope", "{}", "invalid_fixture_envelope"],
  ["array envelope", "[]", "invalid_fixture_envelope"],
  ["oversize", " ".repeat(1_048_577), "fixture_too_large"],
]) {
  test(`CLI refuses ${name} without displaying input`, () => temporary(text, (filename) => {
    const result = run(filename);
    assert.equal(result.status, 1);
    assert.equal(result.report.status, "blocked");
    assert.equal(result.report.diagnostics[0].code, code);
    assert.equal(result.report.review, null);
    assert.equal(result.stdout.includes("secret text"), false);
  }));
}

test("unknown envelope field and mismatched sample declaration are refused", () => {
  for (const mutate of [
    (x) => { x.providerKey = "secret-key-must-not-appear"; },
    (x) => { x.fixtureKind = "production"; },
    (x) => { x.fixtureKind = "redacted"; },
  ]) {
    const data = JSON.parse(readFileSync(fixture, "utf8"));
    mutate(data);
    temporary(JSON.stringify(data), (filename) => {
      const result = run(filename);
      assert.equal(result.status, 1);
      assert.equal(result.report.diagnostics[0].code, "invalid_fixture_envelope");
      assert.equal(result.stdout.includes("secret-key"), false);
    });
  }
});

test("missing file, directory and surplus arguments stop without model fallback", () => {
  assert.equal(run(path.join(root, "nonexistent-vimax-fixture.json")).report.diagnostics[0].code, "fixture_not_found");
  assert.equal(run(root).report.diagnostics[0].code, "fixture_not_file");
  assert.equal(run(fixture, ["unexpected"]).report.diagnostics[0].code, "invalid_arguments");
});

test("missing manual duration remains a blocked report; nothing is fabricated", () => {
  const data = JSON.parse(readFileSync(fixture, "utf8"));
  delete data.supplements.shots[0].plannedSeconds;
  temporary(JSON.stringify(data), (filename) => {
    const result = run(filename);
    assert.equal(result.status, 1);
    assert.equal(result.report.status, "blocked");
    assert.equal(result.report.review, null);
    assert.ok(result.report.diagnostics.length > 0);
  });
});

for (const specifier of ["node:http", "https", "node:http2", "node:net", "node:tls", "dns/promises", "node:dgram", "undici", "node:child_process", "node:worker_threads"]) {
  test(`offline guard rejects import of ${specifier} before execution`, () => {
    const code = `import {installOfflineGuard} from ${JSON.stringify(guardUrl)};
const guard=installOfflineGuard();
try { await import(${JSON.stringify(specifier)}); process.exitCode=9; }
catch(e) { if(e.code!=="OFFLINE_NETWORK_DISABLED") throw e; }
console.log(JSON.stringify(guard.attempts()));`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], opts);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).length, 1);
  });
}

test("global network APIs and direct builtin access are blocked, including caught attempts", () => {
  const code = `import {installOfflineGuard} from ${JSON.stringify(guardUrl)};
const guard=installOfflineGuard();
for(const attempt of [()=>fetch("https://offline.invalid"),()=>new WebSocket("wss://offline.invalid"),
()=>new EventSource("https://offline.invalid"),()=>new XMLHttpRequest(),()=>process.getBuiltinModule("net")]) {
 try { attempt(); process.exitCode=9; } catch(e) { if(e.code!=="OFFLINE_NETWORK_DISABLED") throw e; }
}
console.log(JSON.stringify(guard.attempts()));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], opts);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).length, 5);
});

// No build/install fallback: a copy without packages/domain/dist stops locally.
test("missing evaluator build stops without creating cache or calling a provider", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vimax-e1-no-build-"));
  try {
    const scripts = path.join(dir, "scripts/vimax-evaluation");
    mkdirSync(scripts, { recursive: true });
    for (const file of ["run.mjs", "offline-guard.mjs"]) {
      writeFileSync(path.join(scripts, file), readFileSync(path.join(root, "scripts/vimax-evaluation", file)));
    }
    const input = path.join(dir, "fixture.json");
    writeFileSync(input, readFileSync(fixture));
    const before = readdirSync(dir, { recursive: true }).sort();
    const result = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${dir}`, path.join(scripts, "run.mjs"), input], opts);
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.writeAllowed, false);
    assert.equal(report.diagnostics[0].code, "evaluator_build_required");
    assert.ok(VIMAX_EVALUATION_CODES.includes(report.diagnostics[0].code));
    assert.deepEqual(readdirSync(dir, { recursive: true }).sort(), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
