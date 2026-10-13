import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initializeAdmin } from "./admin-models-init.mjs";

test("provisions the private vault settings without a login token, never overwriting", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "admin-bootstrap-"));
  await chmod(root, 0o700);
  try {
    const directory = join(root, "new");
    const result = await initializeAdmin({ directory });
    const env = await readFile(result.environmentFile, "utf8");
    assert.match(env, /^MODEL_ADMIN_ENABLED=true\nMODEL_ADMIN_CONFIG_PATH=.*models\.enc\nMODEL_ADMIN_MASTER_KEY=[a-f0-9]{64}\n$/);
    assert.equal(/MODEL_ADMIN_TOKEN|MODEL_ADMIN_PUBLIC_ORIGIN/.test(env), false);
    assert.deepEqual(await readdir(directory), ["api-admin.env"]);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(result.environmentFile)).mode & 0o777, 0o600);
    await assert.rejects(initializeAdmin({ directory }));
    assert.equal(await readFile(result.environmentFile, "utf8"), env);
    await assert.rejects(initializeAdmin({ directory: "relative" }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
