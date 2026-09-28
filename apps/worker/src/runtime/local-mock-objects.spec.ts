import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { LocalMockObjects } from "./local-mock-objects";

it("retries a deterministic object write without changing bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "m3-mock-"));
  try {
    const bytes = Buffer.from("fixture");
    const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
    const key = `mock-images/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/${checksumSha256}.png`;
    const store = new LocalMockObjects(root);
    const input = { key, bytes, mimeType: "image/png" as const, checksumSha256 };
    await store.put(input);
    await store.put(input);
    expect(await readFile(join(root, key))).toEqual(bytes);
    await expect(store.put({ ...input, bytes: Buffer.from("different") })).rejects.toThrow(/checksum mismatch/i);
    await expect(store.put({ ...input, key: "../escape.png" })).rejects.toThrow(/Invalid Mock object key/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
