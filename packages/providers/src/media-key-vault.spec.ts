import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MediaKeyVault,
  applyManagedMediaKeys,
  emptyManagedMediaKeys,
  mediaKeyPresent,
  mediaKeyVaultPath,
} from "./media-key-vault";

const SYNTHETIC = "synthetic-dashscope-media-key-never-live";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function vaultDir() {
  const directory = await mkdtemp(join(tmpdir(), "media-key-vault-"));
  await chmod(directory, 0o700);
  directories.push(directory);
  return directory;
}

describe.skipIf(process.platform === "win32")("media key vault", () => {
  it("stores a sibling path next to models.enc", () => {
    expect(mediaKeyVaultPath("/private/models/models.enc")).toBe("/private/models/media-keys.enc");
  });

  it("applies managed replace/clear without falling back to a stale env secret", () => {
    const env = { DASHSCOPE_MEDIA_API_KEY: "stale-env-media-key-value", OPENAI_MEDIA_API_KEY: "env-openai-media-key" };
    const managed = emptyManagedMediaKeys();
    managed.slots.DASHSCOPE_MEDIA_API_KEY = { managed: true, apiKey: SYNTHETIC };
    managed.slots.MINIMAX_API_KEY = { managed: true, apiKey: null };
    const effective = applyManagedMediaKeys(env, managed);
    expect(effective.DASHSCOPE_MEDIA_API_KEY).toBe(SYNTHETIC);
    expect(effective.OPENAI_MEDIA_API_KEY).toBe("env-openai-media-key");
    expect(effective.MINIMAX_API_KEY).toBeUndefined();
    expect(mediaKeyPresent(managed, "DASHSCOPE_MEDIA_API_KEY", env)).toBe(true);
    expect(mediaKeyPresent(managed, "MINIMAX_API_KEY", { MINIMAX_API_KEY: "stale-minimax-env-key" })).toBe(false);
    expect(mediaKeyPresent(managed, "OPENAI_MEDIA_API_KEY", env)).toBe(true);
  });

  it("keeps/replaces/clears with redaction and no env fallback after managed clear", async () => {
    const directory = await vaultDir();
    const path = join(directory, "media-keys.enc");
    const masterKey = randomBytes(32);
    const vault = await MediaKeyVault.open({ path, masterKey });
    const first = await vault.read();
    expect(first.saved.revision).toBe(0);
    expect(first.saved.slots.DASHSCOPE_MEDIA_API_KEY.managed).toBe(false);

    const replaced = await vault.updateSlot({
      expectedRevision: 0,
      slot: "DASHSCOPE_MEDIA_API_KEY",
      secretAction: "replace",
      apiKey: SYNTHETIC,
    });
    expect(replaced.saved.slots.DASHSCOPE_MEDIA_API_KEY).toEqual({ managed: true, apiKey: SYNTHETIC });
    expect(JSON.stringify(await vault.read())).toContain(SYNTHETIC);
    expect(await readFile(path, "utf8")).not.toContain(SYNTHETIC);

    const kept = await vault.updateSlot({ expectedRevision: 1, slot: "DASHSCOPE_MEDIA_API_KEY", secretAction: "keep" });
    expect(kept.saved.slots.DASHSCOPE_MEDIA_API_KEY.apiKey).toBe(SYNTHETIC);
    expect(kept.saved.revision).toBe(2);

    const cleared = await vault.updateSlot({ expectedRevision: 2, slot: "DASHSCOPE_MEDIA_API_KEY", secretAction: "clear" });
    expect(cleared.saved.slots.DASHSCOPE_MEDIA_API_KEY).toEqual({ managed: true, apiKey: null });
    const env = { DASHSCOPE_MEDIA_API_KEY: "stale-env-after-clear" };
    expect(applyManagedMediaKeys(env, cleared.saved).DASHSCOPE_MEDIA_API_KEY).toBeUndefined();
  });

  it("uses CAS revision conflicts without writing the rejected key", async () => {
    const directory = await vaultDir();
    const vault = await MediaKeyVault.open({ path: join(directory, "media-keys.enc"), masterKey: randomBytes(32) });
    await vault.updateSlot({ expectedRevision: 0, slot: "MINIMAX_API_KEY", secretAction: "replace", apiKey: "synthetic-minimax-key-01" });
    await expect(
      vault.updateSlot({ expectedRevision: 0, slot: "MINIMAX_API_KEY", secretAction: "replace", apiKey: "synthetic-minimax-key-02" }),
    ).rejects.toMatchObject({ status: 409, code: "ADMIN_CONFIG_CONFLICT" });
    expect((await vault.read()).saved.slots.MINIMAX_API_KEY.apiKey).toBe("synthetic-minimax-key-01");
  });
});
