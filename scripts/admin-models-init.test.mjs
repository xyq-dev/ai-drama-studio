import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initializeAdmin } from "./admin-models-init.mjs";

test("provisions private credentials without overwriting or returning secrets", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "admin-bootstrap-"));
  await chmod(root, 0o700);
  try {
    const directory = join(root, "new");
    const result = await initializeAdmin({ directory, publicOrigin: "https://drama.example.test" });
    const env = await readFile(result.environmentFile, "utf8");
    const login = await readFile(result.loginFile, "utf8");
    const token = /MODEL_ADMIN_TOKEN=([^\n]+)/.exec(env)[1];
    assert.match(env, /MODEL_ADMIN_MASTER_KEY=[a-f0-9]{64}\n/);
    assert.ok(login.includes(token));
    assert.ok(!JSON.stringify(result).includes(token));
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    for (const file of [result.environmentFile, result.loginFile]) assert.equal((await stat(file)).mode & 0o777, 0o600);
    await assert.rejects(initializeAdmin({ directory, publicOrigin: "https://drama.example.test" }));
    assert.equal(await readFile(result.environmentFile, "utf8"), env);
    await assert.rejects(initializeAdmin({ directory: join(root, "bad"), publicOrigin: "https://user:secret@drama.example.test" }));
    await assert.rejects(initializeAdmin({ directory: "relative", publicOrigin: "https://drama.example.test" }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
