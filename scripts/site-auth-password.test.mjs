import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { checkPassword, hashPassword, readPasswordFile } from "./site-auth-password.mjs";

const run = promisify(execFile);
const SCRIPT = new URL("./site-auth-password.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const PASSWORD = "test-only-site-password";

test("hashes with salted scrypt at N=2^17 and never repeats a hash", async () => {
  const first = await hashPassword(PASSWORD);
  assert.match(first, /^scrypt\$17\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  assert.notEqual(await hashPassword(PASSWORD), first);
  assert.equal(first.includes(PASSWORD), false);
});

test("accepts only bounded single-line passwords", () => {
  assert.throws(() => checkPassword("short"));
  assert.throws(() => checkPassword("line\nbreak-password"));
  assert.equal(checkPassword(PASSWORD), PASSWORD);
});

test("reads a private password file and writes a new private output without echoing the password", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "site-auth-"));
  try {
    const file = join(root, "password");
    await writeFile(file, `${PASSWORD}\n`, { mode: 0o600 });
    assert.equal(await readPasswordFile(file), PASSWORD);
    await chmod(file, 0o644);
    await assert.rejects(readPasswordFile(file));
    await chmod(file, 0o600);
    const output = join(root, "site-auth.env");
    const result = await run(process.execPath, [SCRIPT, "--password-file", file, "--output", output]);
    assert.equal(`${result.stdout}${result.stderr}`.includes(PASSWORD), false);
    const content = await readFile(output, "utf8");
    assert.match(content, /^SITE_AUTH_USERNAME=admin\nSITE_AUTH_PASSWORD_HASH=scrypt\$17\$/);
    assert.equal(content.includes(PASSWORD), false);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    await assert.rejects(run(process.execPath, [SCRIPT, "--password-file", file, "--output", output]));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refuses a password given as an argument and a prompt without a terminal", async () => {
  await assert.rejects(run(process.execPath, [SCRIPT, PASSWORD]));
  await assert.rejects(run(process.execPath, [SCRIPT], { input: `${PASSWORD}\n` }));
});
