import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Every case runs the helper against a temporary copy of an APT configuration, never the real /etc/apt.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "apt-official-https.sh");

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

function run(root) {
  const result = spawnSync("bash", [SCRIPT, root.replaceAll("\\", "/")], { encoding: "utf8" });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

function snapshot(root, dir = root) {
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? Object.entries(snapshot(root, path)) : [[path.slice(root.length), readFileSync(path, "utf8")]];
  }));
}

test("the runner's mirror+file entry and its Azure list both move to the official HTTPS archive, signing kept", (t) => {
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
  assert.equal(sources, RUNNER_SOURCES.replace("mirror+file:/etc/apt/apt-mirrors.txt", "https://archive.ubuntu.com/ubuntu/"));
  assert.match(sources, /^Signed-By: \/usr\/share\/keyrings\/ubuntu-archive-keyring\.gpg$/m);
  assert.match(sources, /^Suites: noble noble-updates noble-backports noble-security$/m);
  const mirrors = readFileSync(join(root, "apt-mirrors.txt"), "utf8");
  assert.equal(mirrors.includes("http://"), false);
  assert.match(mirrors, /^https:\/\/archive\.ubuntu\.com\/ubuntu\/\tpriority:1$/m);
  assert.equal(readFileSync(join(root, "sources.list.d/microsoft-prod.list"), "utf8"), THIRD_PARTY);
  assert.equal(readFileSync(join(root, "apt.conf.d/99ci-download-limits"), "utf8"),
    'Acquire::Retries "3";\nAcquire::http::Timeout "20";\nAcquire::https::Timeout "20";\n');
  assert.match(first.out, /ubuntu\.sources: URIs: https:\/\/archive\.ubuntu\.com\/ubuntu\/$/m);
  assert.match(first.out, /APT download limits: Acquire::Retries "3";/);

  const before = snapshot(root);
  const second = run(root);
  assert.equal(second.status, 0, second.err);
  assert.deepEqual(snapshot(root), before);
});

test("direct HTTP archive and security URLs in one-line sources move to their official HTTPS hosts", (t) => {
  const root = aptRoot({
    "sources.list": [
      "deb http://azure.archive.ubuntu.com/ubuntu/ noble main restricted",
      "deb http://archive.ubuntu.com/ubuntu noble-updates main",
      "deb http://security.ubuntu.com/ubuntu noble-security main",
      "",
    ].join("\n"),
    "sources.list.d/runner.sources": "Types: deb\nURIs: http://azure.archive.ubuntu.com/ubuntu/\nSuites: noble\nComponents: main\n"
      + "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n",
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = run(root);
  assert.equal(result.status, 0, result.err);
  assert.equal(readFileSync(join(root, "sources.list"), "utf8"), [
    "deb https://archive.ubuntu.com/ubuntu/ noble main restricted",
    "deb https://archive.ubuntu.com/ubuntu noble-updates main",
    "deb https://security.ubuntu.com/ubuntu noble-security main",
    "",
  ].join("\n"));
  assert.match(readFileSync(join(root, "sources.list.d/runner.sources"), "utf8"), /^URIs: https:\/\/archive\.ubuntu\.com\/ubuntu\/$/m);
});

test("a mirror list naming no Ubuntu archive is left alone", (t) => {
  const other = "Types: deb\nURIs: mirror+file:/etc/apt/other-mirrors.txt\nSuites: stable\nComponents: main\n";
  const root = aptRoot({ "sources.list.d/other.sources": other, "other-mirrors.txt": "https://example.org/repo/\n" });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = run(root);
  assert.equal(result.status, 0, result.err);
  assert.equal(readFileSync(join(root, "sources.list.d/other.sources"), "utf8"), other);
});

test("an Ubuntu host still reached over HTTP after the rewrite fails the run instead of passing", (t) => {
  const root = aptRoot({ "sources.list": "deb http://archive.ubuntu.com:80/ubuntu noble main\n" });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.err, /still reaches an Ubuntu archive over HTTP/);
});
