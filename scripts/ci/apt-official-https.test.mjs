import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Every case uses a temporary APT root and a fake curl on PATH: no real /etc/apt and no network calls.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "apt-official-https.sh");
const AZURE = "https://azure.archive.ubuntu.com/ubuntu/";
const ARCHIVE = "https://archive.ubuntu.com/ubuntu/";
const SECURITY = "https://security.ubuntu.com/ubuntu/";
const KERNEL = "https://mirrors.kernel.org/ubuntu/";
const probeUrl = (endpoint) => `${endpoint}dists/noble/InRelease`;

/** The ubuntu-24.04 runner's own layout: the archive named through mirror+file, the list led by the Azure mirror. */
const RUNNER_SOURCES = [
  "Types: deb",
  "URIs: mirror+file:/etc/apt/apt-mirrors.txt",
  "Suites: noble noble-updates noble-backports noble-security",
  "Components: main universe restricted multiverse",
  "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg",
  "",
].join("\n");
const RUNNER_MIRRORS = [
  "http://azure.archive.ubuntu.com/ubuntu/\tpriority:1",
  "https://archive.ubuntu.com/ubuntu/\tpriority:2",
  "https://security.ubuntu.com/ubuntu/\tpriority:3",
  "",
].join("\n");
const THIRD_PARTY = "deb [arch=amd64,signed-by=/usr/share/keyrings/microsoft-prod.gpg] https://packages.microsoft.com/ubuntu/24.04/prod noble main\n";

function aptRoot(files) {
  const root = mkdtempSync(join(tmpdir(), "apt-root-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function run(root, healthy = [AZURE], { failCalls = 0, failureExit = 28, failureStatus = "000" } = {}) {
  const fake = mkdtempSync(join(tmpdir(), "apt-fake-curl-"));
  const log = join(fake, "calls.txt");
  writeFileSync(log, "");
  writeFileSync(join(fake, "curl"), [
    "#!/usr/bin/env bash",
    "printf '%s\\n' \"$*\" >> \"$FAKE_CURL_LOG\"",
    'url="${@: -1}"',
    'fail() { printf "%s" "$FAKE_CURL_FAILURE_STATUS"; printf "private proxy error must not be logged" >&2; exit "$FAKE_CURL_FAILURE_EXIT"; }',
    '[ "$(wc -l < "$FAKE_CURL_LOG")" -gt "$FAKE_CURL_FAIL_CALLS" ] || fail',
    'case ",${FAKE_CURL_HEALTHY}," in',
    '  *",$url,"*) printf 200; exit 0 ;;',
    '  *) fail ;;',
    'esac',
    "",
  ].join("\n"));
  chmodSync(join(fake, "curl"), 0o755);
  try {
    const result = spawnSync("bash", [SCRIPT, root.replaceAll("\\", "/")], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${fake}:${process.env.PATH ?? ""}`,
        FAKE_CURL_LOG: log, FAKE_CURL_HEALTHY: healthy.map(probeUrl).join(","),
        FAKE_CURL_FAIL_CALLS: String(failCalls), FAKE_CURL_FAILURE_EXIT: String(failureExit),
        FAKE_CURL_FAILURE_STATUS: failureStatus },
    });
    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
    return { status: result.status, out: result.stdout, err: result.stderr, calls };
  } finally {
    rmSync(fake, { recursive: true, force: true });
  }
}

function snapshot(root, dir = root) {
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? Object.entries(snapshot(root, path)) : [[path.slice(root.length), readFileSync(path, "utf8")]];
  }));
}

test("the runner selects healthy Azure HTTPS, keeping mirror+file, priorities and signing", (t) => {
  const root = aptRoot({
    "sources.list": "# Ubuntu sources have moved to /etc/apt/sources.list.d/ubuntu.sources\n",
    "sources.list.d/ubuntu.sources": RUNNER_SOURCES,
    "sources.list.d/microsoft-prod.list": THIRD_PARTY,
    "apt-mirrors.txt": RUNNER_MIRRORS,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const first = run(root);
  assert.equal(first.status, 0, first.err);
  const sources = readFileSync(join(root, "sources.list.d/ubuntu.sources"), "utf8");
  assert.equal(sources, RUNNER_SOURCES);
  assert.match(sources, /^Signed-By: \/usr\/share\/keyrings\/ubuntu-archive-keyring\.gpg$/m);
  assert.match(sources, /^Suites: noble noble-updates noble-backports noble-security$/m);
  const mirrors = readFileSync(join(root, "apt-mirrors.txt"), "utf8");
  assert.equal(mirrors, [1, 2, 3].map((priority) => `${AZURE}\tpriority:${priority}\n`).join(""));
  assert.equal(mirrors.includes("http://"), false);
  assert.equal(first.calls.length, 1);
  assert.match(first.calls[0], /--connect-timeout 10 --max-time 15/);
  assert.match(first.calls[0], /--proto =https --proto-redir =https/);
  assert.ok(first.calls[0].endsWith(probeUrl(AZURE)));
  assert.equal(first.calls[0].includes("--insecure"), false);
  assert.equal(readFileSync(join(root, "sources.list.d/microsoft-prod.list"), "utf8"), THIRD_PARTY);
  assert.equal(readFileSync(join(root, "apt.conf.d/99ci-download-limits"), "utf8"),
    'Acquire::Retries "3";\nAcquire::http::Timeout "20";\nAcquire::https::Timeout "20";\nAPT::Update::Error-Mode "any";\n');
  assert.match(first.out, /ubuntu\.sources: URIs: mirror\+file:\/etc\/apt\/apt-mirrors\.txt$/m);
  assert.match(first.out, /APT download limits: Acquire::Retries "3";/);

  const before = snapshot(root);
  const second = run(root);
  assert.equal(second.status, 0, second.err);
  assert.deepEqual(snapshot(root), before);
});

test("direct HTTP and HTTPS Ubuntu sources use only the selected healthy host", (t) => {
  const root = aptRoot({
    "sources.list": [
      "deb http://azure.archive.ubuntu.com/ubuntu/ noble main restricted",
      "deb http://archive.ubuntu.com/ubuntu noble-updates main",
      "deb https://security.ubuntu.com/ubuntu noble-security main",
      "",
    ].join("\n"),
    "sources.list.d/runner.sources": "Types: deb\nURIs: http://azure.archive.ubuntu.com/ubuntu/\nSuites: noble\nComponents: main\n"
      + "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n",
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = run(root);
  assert.equal(result.status, 0, result.err);
  assert.equal(readFileSync(join(root, "sources.list"), "utf8"), [
    `deb ${AZURE} noble main restricted`,
    `deb ${AZURE} noble-updates main`,
    `deb ${AZURE} noble-security main`,
    "",
  ].join("\n"));
  assert.match(readFileSync(join(root, "sources.list.d/runner.sources"), "utf8"), /^URIs: https:\/\/azure\.archive\.ubuntu\.com\/ubuntu\/$/m);
});

test("a mirror list naming no Ubuntu archive is left alone", (t) => {
  const other = "Types: deb\nURIs: mirror+file:/etc/apt/other-mirrors.txt\nSuites: stable\nComponents: main\n";
  const root = aptRoot({ "sources.list.d/other.sources": other, "other-mirrors.txt": "https://example.org/repo/\n" });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = run(root);
  assert.equal(result.status, 0, result.err);
  assert.deepEqual(result.calls, []);
  assert.equal(readFileSync(join(root, "sources.list.d/other.sources"), "utf8"), other);
});

test("an Ubuntu host still reached over HTTP after the rewrite fails the run instead of passing", (t) => {
  const root = aptRoot({ "sources.list": "deb http://archive.ubuntu.com:80/ubuntu noble main\n" });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.err, /still reaches an Ubuntu archive over HTTP/);
});

test("a referenced Ubuntu mirror list with remaining HTTP fails without removing its reference", (t) => {
  const root = aptRoot({
    "sources.list.d/ubuntu.sources": RUNNER_SOURCES,
    "apt-mirrors.txt": "http://archive.ubuntu.com:80/ubuntu/\tpriority:1\n",
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.err, /apt-mirrors\.txt still reaches an Ubuntu archive over HTTP/);
  assert.equal(readFileSync(join(root, "sources.list.d/ubuntu.sources"), "utf8"), RUNNER_SOURCES);
});

test("Ubuntu entries use the healthy endpoint while third-party entries in the same list remain unchanged", (t) => {
  const mixed = [
    "http://security.ubuntu.com/ubuntu/\tpriority:1",
    "https://archive.ubuntu.com/ubuntu/\tpriority:2",
    "http://mirror.example.org/custom/\tpriority:3",
    "",
  ].join("\n");
  const root = aptRoot({ "sources.list.d/ubuntu.sources": RUNNER_SOURCES, "apt-mirrors.txt": mixed });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = run(root);
  assert.equal(result.status, 0, result.err);
  assert.equal(readFileSync(join(root, "apt-mirrors.txt"), "utf8"), [
    `${AZURE}\tpriority:1`, `${AZURE}\tpriority:2`, "http://mirror.example.org/custom/\tpriority:3", "",
  ].join("\n"));
  assert.equal(readFileSync(join(root, "sources.list.d/ubuntu.sources"), "utf8"), RUNNER_SOURCES);
});

test("a failed Azure probe falls back to the first healthy Ubuntu endpoint without retaining failed hosts", (t) => {
  const root = aptRoot({ "sources.list.d/ubuntu.sources": RUNNER_SOURCES, "apt-mirrors.txt": RUNNER_MIRRORS });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = run(root, [ARCHIVE, SECURITY]);
  assert.equal(result.status, 0, result.err);
  assert.deepEqual(result.calls.map((call) => call.split(" ").at(-1)), [probeUrl(AZURE), probeUrl(ARCHIVE)]);
  assert.equal(readFileSync(join(root, "apt-mirrors.txt"), "utf8"),
    [1, 2, 3].map((priority) => `${ARCHIVE}\tpriority:${priority}\n`).join(""));
});

test("Linux Kernel Archives is a bounded HTTPS fallback and a later run can select Azure again", (t) => {
  const root = aptRoot({ "sources.list.d/ubuntu.sources": RUNNER_SOURCES, "apt-mirrors.txt": RUNNER_MIRRORS });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = run(root, [KERNEL]);
  assert.equal(result.status, 0, result.err);
  assert.deepEqual(result.calls.map((call) => call.split(" ").at(-1)), [AZURE, ARCHIVE, SECURITY, KERNEL].map(probeUrl));
  assert.equal(readFileSync(join(root, "apt-mirrors.txt"), "utf8"),
    [1, 2, 3].map((priority) => `${KERNEL}\tpriority:${priority}\n`).join(""));
  const repeated = snapshot(root);
  assert.equal(run(root, [KERNEL]).status, 0);
  assert.deepEqual(snapshot(root), repeated);
  assert.equal(run(root, [AZURE]).status, 0);
  assert.equal(readFileSync(join(root, "apt-mirrors.txt"), "utf8"),
    [1, 2, 3].map((priority) => `${AZURE}\tpriority:${priority}\n`).join(""));
});

test("all failed probes stop before any source or apt configuration is changed", (t) => {
  const root = aptRoot({ "sources.list.d/ubuntu.sources": RUNNER_SOURCES, "apt-mirrors.txt": RUNNER_MIRRORS });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = snapshot(root);

  const result = run(root, []);
  assert.equal(result.status, 1);
  assert.equal(result.calls.length, 8);
  assert.deepEqual(result.calls.map((call) => call.split(" ").at(-1)),
    [AZURE, ARCHIVE, SECURITY, KERNEL, AZURE, ARCHIVE, SECURITY, KERNEL].map(probeUrl));
  assert.match(result.out, /round=2 curl_exit=28 http=000/);
  assert.doesNotMatch(result.out + result.err, /private proxy/);
  assert.match(result.err, /No Ubuntu HTTPS archive passed/);
  assert.deepEqual(snapshot(root), before);
});

test("a transient first-round failure recovers on the second round without retaining failed hosts", (t) => {
  const root = aptRoot({ "sources.list.d/ubuntu.sources": RUNNER_SOURCES, "apt-mirrors.txt": RUNNER_MIRRORS });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = run(root, [AZURE], { failCalls: 4 });
  assert.equal(result.status, 0, result.err);
  assert.deepEqual(result.calls.map((call) => call.split(" ").at(-1)),
    [AZURE, ARCHIVE, SECURITY, KERNEL, AZURE].map(probeUrl));
  assert.match(result.out, /round=1 curl_exit=28 http=000/);
  assert.match(result.out, /round=2 curl_exit=0 http=200/);
  assert.doesNotMatch(result.out + result.err, /private proxy/);
  assert.equal(readFileSync(join(root, "apt-mirrors.txt"), "utf8"),
    [1, 2, 3].map((priority) => `${AZURE}\tpriority:${priority}\n`).join(""));
  assert.equal(readFileSync(join(root, "sources.list.d/ubuntu.sources"), "utf8"), RUNNER_SOURCES);
});

test("failed probes report numeric DNS/TLS/HTTP diagnostics without logging curl errors", (t) => {
  for (const [failureExit, failureStatus] of [[6, "000"], [60, "000"], [22, "503"], [28, "unexpected private output"]]) {
    const root = aptRoot({ "sources.list.d/ubuntu.sources": RUNNER_SOURCES, "apt-mirrors.txt": RUNNER_MIRRORS });
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const before = snapshot(root);

    const result = run(root, [], { failureExit, failureStatus });
    assert.equal(result.status, 1);
    assert.equal(result.calls.length, 8);
    assert.match(result.out, new RegExp(`curl_exit=${failureExit} http=${failureExit === 22 ? "503" : "000"}`));
    assert.doesNotMatch(result.out + result.err, /private/);
    assert.deepEqual(snapshot(root), before);
  }
});
