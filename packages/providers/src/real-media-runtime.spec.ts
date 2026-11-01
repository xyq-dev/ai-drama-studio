import { describe, expect, it } from "vitest";
import { createRealMediaReceiptCipher, loadRealMediaEnvironment, ServerRealMediaRuntime } from "./real-media-runtime";
const workspaceId = "00000000-0000-4000-8000-000000000001";
const key = Buffer.alloc(32, 21).toString("base64"), previous = Buffer.alloc(32, 22).toString("base64");
const configured = { REAL_MEDIA_ENABLED: "true", REAL_MEDIA_RECEIPT_KEY: key,
  DASHSCOPE_MEDIA_API_KEY: "server-only-test-key", REAL_MEDIA_PRICE_VERSION: "operator-20261101",
  DASHSCOPE_MEDIA_PRICE_IMAGE: "0.18", DASHSCOPE_MEDIA_PRICE_VIDEO_SECOND: "0.15", DASHSCOPE_MEDIA_PRICE_TTS_CHARACTER: "0.00008" };
describe("real media configuration and encrypted receipts", () => {
  it("is disabled by default and ignores file-only production permission and secrets", async () => {
    const env = loadRealMediaEnvironment({}, configured);
    expect(env.REAL_MEDIA_RECEIPT_KEY).toBeUndefined();
    expect(env.DASHSCOPE_MEDIA_API_KEY).toBeUndefined();
    const runtime = new ServerRealMediaRuntime(workspaceId, env, false);
    expect(await runtime.configurationFor("image.generate")).toBeNull();
    expect(runtime.receiptCipher).toBeUndefined();
  });
  it("keeps explicit empty process values instead of taking a file secret or switch", () => {
    const env = loadRealMediaEnvironment({ REAL_MEDIA_ENABLED: "false", DASHSCOPE_MEDIA_API_KEY: "" }, configured);
    expect(env.REAL_MEDIA_ENABLED).toBe("false");
    expect(env.DASHSCOPE_MEDIA_API_KEY).toBe("");
  });
  it.each(["TRUE", "1", ""])("rejects invalid production flag %s", value => {
    expect(() => loadRealMediaEnvironment({ REAL_MEDIA_ALLOW_PRODUCTION: value })).toThrow("REAL_MEDIA_ALLOW_PRODUCTION");
  });
  it("does not expose rejected credentials in configuration errors", () => {
    const secret = "test-key with whitespace";
    const error = (() => { try { loadRealMediaEnvironment({ DASHSCOPE_MEDIA_API_KEY: secret }); } catch (e) { return e as Error; } })()!;
    expect(error.message).toContain("DASHSCOPE_MEDIA_API_KEY");
    expect(error.message).not.toContain(secret);
  });
  it("requires an operator price and key, never invents a current rate", async () => {
    const runtime = new ServerRealMediaRuntime(workspaceId, loadRealMediaEnvironment({ ...configured, DASHSCOPE_MEDIA_PRICE_IMAGE: "" }), true);
    expect(await runtime.configurationFor("image.generate")).toBeNull();
    expect(await runtime.configurationFor("audio.music")).toBeNull();
  });
  it("retains a stable database identity but freezes every configuration version", async () => {
    const first = await new ServerRealMediaRuntime(workspaceId, loadRealMediaEnvironment(configured), true).configurationFor("image.generate");
    const second = await new ServerRealMediaRuntime(workspaceId, loadRealMediaEnvironment({ ...configured, DASHSCOPE_MEDIA_PRICE_IMAGE: "0.20" }), true).configurationFor("image.generate");
    expect(first?.id).toBe(second?.id);
    expect(first?.version).not.toBe(second?.version);
    expect(JSON.stringify(first)).not.toContain("server-only-test-key");
  });
  it("disables new submission yet allows original-query credentials after rotation", async () => {
    const before = new ServerRealMediaRuntime(workspaceId, loadRealMediaEnvironment(configured), true);
    const frozen = (await before.configurationFor("image.generate"))!;
    const after = new ServerRealMediaRuntime(workspaceId, loadRealMediaEnvironment({ ...configured, REAL_MEDIA_ENABLED: "false",
      DASHSCOPE_MEDIA_API_KEY: "new-server-only-key", DASHSCOPE_MEDIA_CREDENTIAL_VERSION: "v2",
      DASHSCOPE_MEDIA_PREVIOUS_API_KEY: configured.DASHSCOPE_MEDIA_API_KEY, DASHSCOPE_MEDIA_PREVIOUS_CREDENTIAL_VERSION: "v1" }), false);
    expect((await after.adapterFor(frozen, "query")).providerKey).toBe("dashscope-media");
    await expect(after.adapterFor(frozen, "submit")).rejects.toThrow("REAL_MEDIA_CONFIGURATION_CHANGED");
    expect(JSON.stringify(after)).not.toContain("server-only");
  });
  it("fails closed if a frozen credential version is unavailable", async () => {
    const runtime = new ServerRealMediaRuntime(workspaceId, loadRealMediaEnvironment(configured), true);
    const frozen = (await runtime.configurationFor("image.generate"))!;
    await expect(runtime.adapterFor({ ...frozen, credentialVersion: "unknown" }, "query")).rejects.toThrow("REAL_MEDIA_CREDENTIAL_VERSION_UNAVAILABLE");
  });
  it("only advertises supported fixed-speed neutral preset voices", async () => {
    const catalog = await new ServerRealMediaRuntime(workspaceId, loadRealMediaEnvironment(configured), true).speechCatalog();
    expect(catalog.available).toBe(true);
    expect(catalog.voices.map(v => v.voiceId)).toEqual(["Cherry", "Ethan", "Serena"]);
    expect(catalog.voices.every(v => v.capabilities.speedMin === 1 && v.capabilities.speedMax === 1
      && v.capabilities.emotions.join() === "neutral")).toBe(true);
  });
  it("authenticates receipts, hides signed URLs, and supports a retained old sealing key", () => {
    const old = createRealMediaReceiptCipher({ REAL_MEDIA_RECEIPT_KEY: previous, REAL_MEDIA_RECEIPT_KEY_VERSION: "v1" })!;
    const current = createRealMediaReceiptCipher({ REAL_MEDIA_RECEIPT_KEY: key, REAL_MEDIA_RECEIPT_KEY_VERSION: "v2",
      REAL_MEDIA_PREVIOUS_RECEIPT_KEY: previous, REAL_MEDIA_PREVIOUS_RECEIPT_KEY_VERSION: "v1" })!;
    const value = { outputs: [{ uri: "https://private.example/file?signature=secret" }] };
    const sealed = old.seal(value);
    expect(sealed).not.toContain("signature");
    expect(current.open(sealed)).toEqual(value);
    const tampered = JSON.parse(sealed); tampered.keyVersion = "v2";
    expect(() => current.open(JSON.stringify(tampered))).toThrow("REAL_MEDIA_RECEIPT_UNAVAILABLE");
    expect(() => current.open(sealed.slice(0, -4))).toThrow("REAL_MEDIA_RECEIPT_UNAVAILABLE");
  });
});
